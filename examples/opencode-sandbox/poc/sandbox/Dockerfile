FROM node:22-slim

RUN npm install -g opencode-ai

# Working directory opencode will use for coding tasks
WORKDIR /workspace

# Install the oc-events plugin so opencode auto-loads it on startup.
# opencode looks for plugins in <worktree>/.opencode/plugins/ automatically.
COPY plugins/ .opencode/plugins/

EXPOSE 4096

# opencode serve starts the HTTP API server (no TUI needed)
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
