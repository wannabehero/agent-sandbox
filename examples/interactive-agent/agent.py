#!/usr/bin/env python3
"""
Interactive agent that wraps SandboxClient with a Claude-powered agentic loop.

Usage:
    python agent.py --template my-sandbox-template

Requirements:
    pip install anthropic k8s-agent-sandbox-client
"""

import argparse
import json
import sys

import anthropic

sys.path.insert(0, "../../clients/python/agentic-sandbox-client")
from k8s_agent_sandbox import SandboxClient

# ── Tool definitions exposed to Claude ────────────────────────────────────────

TOOLS = [
    {
        "name": "run",
        "description": (
            "Execute a shell command in the sandbox and return its stdout, stderr, "
            "and exit code. Use this for any computation, installation, or file "
            "manipulation that requires running a process."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to run"},
                "timeout": {
                    "type": "integer",
                    "description": "Seconds to wait before timing out (default 60)",
                    "default": 60,
                },
            },
            "required": ["command"],
        },
    },
    {
        "name": "write_file",
        "description": "Write text or binary content to a file path inside the sandbox.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path inside sandbox"},
                "content": {"type": "string", "description": "File content to write"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "read_file",
        "description": "Read and return the text content of a file from the sandbox.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Absolute path inside sandbox"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "list_files",
        "description": "List the contents of a directory inside the sandbox.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path to list (default '/')",
                    "default": "/",
                },
            },
            "required": [],
        },
    },
]

SYSTEM = """\
You are an expert software engineer working inside a live, persistent Linux sandbox.
You have full shell access via the `run` tool, and you can read/write files.

Guidelines:
- Think step-by-step before executing commands.
- Always show the user what you are doing and why.
- If a command fails, diagnose the error and try a different approach.
- Keep responses concise but informative.
"""


# ── Tool dispatcher ────────────────────────────────────────────────────────────

def dispatch(tool_name: str, tool_input: dict, sandbox: SandboxClient) -> str:
    """Execute a tool call and return the result as a string."""
    if tool_name == "run":
        result = sandbox.run(
            tool_input["command"], timeout=tool_input.get("timeout", 60)
        )
        parts = []
        if result.stdout:
            parts.append(f"stdout:\n{result.stdout.rstrip()}")
        if result.stderr:
            parts.append(f"stderr:\n{result.stderr.rstrip()}")
        parts.append(f"exit_code: {result.exit_code}")
        return "\n".join(parts)

    elif tool_name == "write_file":
        sandbox.write(tool_input["path"], tool_input["content"])
        return f"Written to {tool_input['path']}"

    elif tool_name == "read_file":
        data = sandbox.read(tool_input["path"])
        return data.decode("utf-8", errors="replace")

    elif tool_name == "list_files":
        entries = sandbox.list(tool_input.get("path", "/"))
        lines = [f"{'d' if e.type == 'directory' else '-'}  {e.name}" for e in entries]
        return "\n".join(lines) if lines else "(empty)"

    else:
        return f"Unknown tool: {tool_name}"


# ── Streaming agentic loop ─────────────────────────────────────────────────────

def run_agent_turn(
    client: anthropic.Anthropic,
    messages: list,
    sandbox: SandboxClient,
) -> list:
    """
    Run one user-turn through the agentic loop.
    Streams Claude's text to stdout in real time.
    Returns updated messages list.
    """
    while True:
        # Stream the response
        tool_uses = []        # accumulate tool_use blocks
        text_buffer = ""      # accumulate text for the assistant message content
        current_tool_use = None

        with client.messages.stream(
            model="claude-opus-4-6",
            max_tokens=8192,
            system=SYSTEM,
            tools=TOOLS,
            messages=messages,
            thinking={"type": "adaptive"},
        ) as stream:
            for event in stream:
                # Stream text tokens directly to stdout
                if event.type == "content_block_start":
                    if event.content_block.type == "tool_use":
                        current_tool_use = {
                            "id": event.content_block.id,
                            "name": event.content_block.name,
                            "input_json": "",
                        }
                        print(
                            f"\n\033[33m[tool: {event.content_block.name}]\033[0m",
                            flush=True,
                        )

                elif event.type == "content_block_delta":
                    delta = event.delta
                    if delta.type == "text_delta":
                        print(delta.text, end="", flush=True)
                        text_buffer += delta.text
                    elif delta.type == "input_json_delta" and current_tool_use:
                        current_tool_use["input_json"] += delta.partial_json

                elif event.type == "content_block_stop":
                    if current_tool_use:
                        tool_uses.append(current_tool_use)
                        current_tool_use = None

            final = stream.get_final_message()

        # Append assistant message
        messages.append({"role": "assistant", "content": final.content})

        if final.stop_reason != "tool_use":
            print()  # trailing newline
            break

        # Execute all tool calls and collect results
        tool_results = []
        for tu in tool_uses:
            tool_input = json.loads(tu["input_json"] or "{}")
            print(f"\033[36m  input: {json.dumps(tool_input)}\033[0m", flush=True)

            result_text = dispatch(tu["name"], tool_input, sandbox)

            # Show a truncated preview
            preview = result_text[:300] + ("…" if len(result_text) > 300 else "")
            print(f"\033[32m  result: {preview}\033[0m\n", flush=True)

            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": tu["id"],
                    "content": result_text,
                }
            )

        messages.append({"role": "user", "content": tool_results})

    return messages


# ── REPL ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Interactive sandbox agent")
    parser.add_argument("--template", required=True, help="Sandbox template name")
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--gateway", default=None, help="Gateway name (production)")
    parser.add_argument("--api-url", default=None, help="Direct API URL (local)")
    args = parser.parse_args()

    anthropic_client = anthropic.Anthropic()  # reads ANTHROPIC_API_KEY from env

    sandbox_kwargs = dict(
        template_name=args.template,
        namespace=args.namespace,
    )
    if args.api_url:
        sandbox_kwargs["api_url"] = args.api_url
    elif args.gateway:
        sandbox_kwargs["gateway_name"] = args.gateway

    print("Starting sandbox…", flush=True)
    with SandboxClient(**sandbox_kwargs) as sandbox:
        print("Sandbox ready. Type your request (Ctrl-D or 'exit' to quit).\n")

        messages = []
        while True:
            try:
                user_input = input("\033[1mYou>\033[0m ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nGoodbye.")
                break

            if not user_input or user_input.lower() in ("exit", "quit"):
                print("Goodbye.")
                break

            messages.append({"role": "user", "content": user_input})
            print("\n\033[1mAgent>\033[0m ", end="", flush=True)

            try:
                messages = run_agent_turn(anthropic_client, messages, sandbox)
            except anthropic.APIError as e:
                print(f"\n[API error: {e}]")


if __name__ == "__main__":
    main()
