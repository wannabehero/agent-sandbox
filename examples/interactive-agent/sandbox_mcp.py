"""
In-process MCP server that exposes a SandboxClient as Agent SDK tools.

Usage:
    from sandbox_mcp import make_sandbox_mcp_server
    config = make_sandbox_mcp_server(sandbox)
    # then pass config to ClaudeAgentOptions(mcp_servers={"sandbox": config})
"""

import sys

from claude_agent_sdk import create_sdk_mcp_server, tool

sys.path.insert(0, "../../clients/python/agentic-sandbox-client")
from k8s_agent_sandbox import SandboxClient


def make_sandbox_mcp_server(sandbox: SandboxClient):
    """Return an McpSdkServerConfig wiring sandbox operations to MCP tools."""

    @tool(
        "run",
        "Execute a shell command in the sandbox and return stdout, stderr, and exit code.",
        {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Shell command to run"},
                "timeout": {
                    "type": "integer",
                    "description": "Seconds before timing out (default 60)",
                    "default": 60,
                },
            },
            "required": ["command"],
        },
    )
    async def run(args: dict) -> dict:
        result = sandbox.run(args["command"], timeout=args.get("timeout", 60))
        parts = []
        if result.stdout:
            parts.append(f"stdout:\n{result.stdout.rstrip()}")
        if result.stderr:
            parts.append(f"stderr:\n{result.stderr.rstrip()}")
        parts.append(f"exit_code: {result.exit_code}")
        return {"content": [{"type": "text", "text": "\n".join(parts)}]}

    @tool(
        "write_file",
        "Write text content to an absolute path inside the sandbox.",
        {"path": str, "content": str},
    )
    async def write_file(args: dict) -> dict:
        sandbox.write(args["path"], args["content"])
        return {"content": [{"type": "text", "text": f"Written to {args['path']}"}]}

    @tool(
        "read_file",
        "Read and return the text content of a file from the sandbox.",
        {"path": str},
    )
    async def read_file(args: dict) -> dict:
        data = sandbox.read(args["path"])
        return {"content": [{"type": "text", "text": data.decode("utf-8", errors="replace")}]}

    @tool(
        "list_files",
        "List the contents of a directory inside the sandbox.",
        {
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
    )
    async def list_files(args: dict) -> dict:
        entries = sandbox.list(args.get("path", "/"))
        lines = [f"{'d' if e.type == 'directory' else '-'}  {e.name}" for e in entries]
        text = "\n".join(lines) if lines else "(empty)"
        return {"content": [{"type": "text", "text": text}]}

    return create_sdk_mcp_server(
        name="sandbox",
        tools=[run, write_file, read_file, list_files],
    )
