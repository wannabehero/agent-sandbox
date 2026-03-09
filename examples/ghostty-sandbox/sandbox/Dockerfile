FROM node:22-slim

# System dev toolkit
# build-essential covers gcc/g++/make needed for node-pty native bindings
RUN apt-get update && apt-get install -y \
    curl git wget unzip zip \
    vim neovim \
    tmux htop procps lsof \
    jq ripgrep fd-find \
    build-essential python3 python3-pip \
    ca-certificates ssh less man-db \
    && rm -rf /var/lib/apt/lists/*

# pnpm
RUN npm install -g pnpm

# bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# AI CLIs
RUN npm install -g opencode-ai
RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g @openai/codex

# ghostty-web demo (last — smallest, changes most often)
RUN npm install -g @ghostty-web/demo@next

WORKDIR /root
EXPOSE 4096
ENV PORT=4096
CMD ["ghostty-web-demo"]
