#!/usr/bin/env python3
"""
Interactive agent — reimplemented with the Claude Agent SDK.

Compared to agent.py (raw Anthropic SDK + manual tool loop):
  - No tool definitions or tool dispatcher needed — built-in Bash/Read/Write
  - No agentic loop to maintain — the SDK handles tool calls internally
  - ClaudeSDKClient gives multi-turn sessions with streaming + interrupt support

Usage:
    python agent_sdk.py [--cwd /path/to/workdir]

Requirements:
    pip install claude-agent-sdk
"""

import argparse
import asyncio
import sys

from claude_agent_sdk import (
    ClaudeCodeOptions,
    ClaudeSDKClient,
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)


SYSTEM = """\
You are an expert software engineer working inside a live, persistent Linux sandbox.
You have full shell access via the Bash tool, and you can read/write files.

Guidelines:
- Think step-by-step before executing commands.
- Always show the user what you are doing and why.
- If a command fails, diagnose the error and try a different approach.
- Keep responses concise but informative.
"""


async def run_session(cwd: str | None) -> None:
    options = ClaudeCodeOptions(
        system_prompt=SYSTEM,
        allowed_tools=["Bash", "Read", "Write", "LS"],
        # permission_mode="acceptEdits" lets the SDK auto-approve file writes
        permission_mode="acceptEdits",
        cwd=cwd,
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

                # receive_response() yields messages until the turn ends
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
                # Ctrl-C mid-response: interrupt the running turn
                await client.interrupt()
                print("\n[interrupted]")

            print()  # blank line between turns


def main() -> None:
    parser = argparse.ArgumentParser(description="Interactive Agent SDK demo")
    parser.add_argument(
        "--cwd",
        default=None,
        help="Working directory for the agent (default: current directory)",
    )
    args = parser.parse_args()

    asyncio.run(run_session(args.cwd))


if __name__ == "__main__":
    main()
