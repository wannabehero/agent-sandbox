#!/usr/bin/env python3
"""
Interactive agent — reimplemented with the Claude Agent SDK.

Compared to agent.py (raw Anthropic SDK + manual tool loop):
  - No tool definitions or agentic loop to maintain
  - ClaudeSDKClient gives multi-turn sessions with streaming + interrupt
  - Sandbox tools are wired in via an in-process MCP server (sandbox_mcp.py)

Usage:
    python agent_sdk.py --template my-sandbox-template

Requirements:
    pip install claude-agent-sdk k8s-agent-sandbox-client
"""

import argparse
import asyncio
import sys

from claude_agent_sdk import (
    ClaudeAgentOptions,
    ClaudeSDKClient,
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)
from sandbox_mcp import make_sandbox_mcp_server

sys.path.insert(0, "../../clients/python/agentic-sandbox-client")
from k8s_agent_sandbox import SandboxClient


SYSTEM = """\
You are an expert software engineer working inside a live, persistent Linux sandbox.
You have full shell access via the `run` tool, and you can read/write files.

Guidelines:
- Think step-by-step before executing commands.
- Always show the user what you are doing and why.
- If a command fails, diagnose the error and try a different approach.
- Keep responses concise but informative.
"""

SANDBOX_TOOLS = ["run", "write_file", "read_file", "list_files"]


async def run_session(sandbox: SandboxClient) -> None:
    options = ClaudeAgentOptions(
        system_prompt=SYSTEM,
        allowed_tools=SANDBOX_TOOLS,
        mcp_servers={"sandbox": make_sandbox_mcp_server(sandbox)},
        permission_mode="acceptEdits",
    )

    async with ClaudeSDKClient(options=options) as client:
        print("Agent ready. Type your request (Ctrl-C or 'exit' to quit).\n")

        while True:
            # ── Read user input ────────────────────────────────────────────────
            try:
                user_input = input("\033[1mYou>\033[0m ").strip()
            except (EOFError, KeyboardInterrupt):
                print("\nGoodbye.")
                break

            if not user_input or user_input.lower() in ("exit", "quit"):
                print("Goodbye.")
                break

            # ── Send to Claude and stream the response ─────────────────────────
            print("\n\033[1mAgent>\033[0m ", end="", flush=True)

            try:
                await client.query(user_input)

                async for message in client.receive_response():
                    if isinstance(message, AssistantMessage):
                        for block in message.content:
                            if isinstance(block, TextBlock):
                                print(block.text, end="", flush=True)
                            elif isinstance(block, ToolUseBlock):
                                print(
                                    f"\n\033[33m[tool: {block.name}]\033[0m "
                                    f"\033[36m{block.input}\033[0m",
                                    flush=True,
                                )

                    elif isinstance(message, ResultMessage):
                        cost = (
                            f"  cost=${message.total_cost_usd:.4f}"
                            if message.total_cost_usd is not None
                            else ""
                        )
                        print(
                            f"\n\033[90m[{message.duration_ms}ms{cost}]\033[0m",
                            flush=True,
                        )

            except KeyboardInterrupt:
                await client.interrupt()
                print("\n[interrupted]")

            print()


def main() -> None:
    parser = argparse.ArgumentParser(description="Interactive sandbox agent (Agent SDK)")
    parser.add_argument("--template", required=True, help="Sandbox template name")
    parser.add_argument("--namespace", default="default")
    parser.add_argument("--gateway", default=None, help="Gateway name (production)")
    parser.add_argument("--api-url", default=None, help="Direct API URL (local)")
    args = parser.parse_args()

    sandbox_kwargs = dict(template_name=args.template, namespace=args.namespace)
    if args.api_url:
        sandbox_kwargs["api_url"] = args.api_url
    elif args.gateway:
        sandbox_kwargs["gateway_name"] = args.gateway

    print("Starting sandbox…", flush=True)
    with SandboxClient(**sandbox_kwargs) as sandbox:
        print("Sandbox ready.")
        asyncio.run(run_session(sandbox))


if __name__ == "__main__":
    main()
