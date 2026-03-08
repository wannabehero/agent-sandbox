# Interactive Sandbox Agent

A conversational agent that lets you talk to Claude while it executes commands
in your sandbox in real time.

## Features

- **Streaming** — Claude's text tokens print to your terminal as they are generated
- **Tool transparency** — every `run`, `read_file`, `write_file`, or `list_files`
  call is shown with its inputs and a result preview
- **Multi-turn conversation** — full message history is preserved so you can
  follow up naturally
- **Adaptive thinking** — Claude reasons internally before acting

## Setup

```bash
pip install anthropic k8s-agent-sandbox-client
export ANTHROPIC_API_KEY=sk-ant-…
```

## Usage

**Dev mode** (port-forward, default):
```bash
python agent.py --template python-sandbox-template
```

**Production** (gateway):
```bash
python agent.py --template python-sandbox-template --gateway sandbox-gateway
```

**Direct URL** (local testing):
```bash
python agent.py --template python-sandbox-template --api-url http://localhost:8888
```

## Example session

```
Sandbox ready. Type your request (Ctrl-D or 'exit' to quit).

You> Install requests and fetch the Anthropic homepage title
Agent> I'll install the requests library and then fetch the page.

[tool: run]
  input: {"command": "pip install requests -q"}
  result: exit_code: 0

[tool: run]
  input: {"command": "python3 -c \"import requests; from bs4 import BeautifulSoup; ...\""}
  result: stdout: Anthropic
         exit_code: 0

The title of the Anthropic homepage is **Anthropic**.

You> Now save that to a file called title.txt
Agent>
[tool: write_file]
  input: {"path": "/app/title.txt", "content": "Anthropic"}
  result: Written to /app/title.txt

Done — saved as `/app/title.txt`.
```

## Available Tools

| Tool | What it does |
|------|-------------|
| `run` | Execute a shell command; returns stdout, stderr, exit_code |
| `write_file` | Write content to a file path in the sandbox |
| `read_file` | Read a file from the sandbox |
| `list_files` | List a directory inside the sandbox |
