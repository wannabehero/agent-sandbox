FROM node:22-slim

RUN npm install -g opencode-ai

# Working directory opencode will use for coding tasks
WORKDIR /workspace

EXPOSE 4096

# opencode serve starts the HTTP API server (no TUI needed)
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
