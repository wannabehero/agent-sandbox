# ghostty-sandbox -- Disposable Developer Shells

Browser terminal backed by an isolated Kubernetes pod. Each tab gets its own
shell with a full dev toolkit (Node, Bun, Python, Git, AI CLIs). Close the
tab, the pod is gone.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design document.

```
browser (xterm.js)
  WebSocket ws://localhost:3001/session/:id/ws
  |
backend/server.js  (Node.js, local)
  kubectl apply/delete SandboxClaim
  WebSocket relay with X-Sandbox-* headers
  |
sandbox-router  (Deployment, default ns)
  routes by header to {claimName}.opencode.svc.cluster.local:4096
  |
sandbox pod  (ghostty-web/demo, port 4096)
  /ws -> node-pty -> real bash shell
```

No LLM API key needed for the shell itself. AI CLIs (claude, codex, opencode)
are pre-installed; API keys are injected via K8s Secrets if configured.

---

## Prerequisites

| Tool | Purpose |
|------|---------|
| `colima` | VM + container runtime (macOS) |
| `kubectl` | Apply manifests, poll status |
| `node` 18+ | Run the backend locally |

---

## Step 1 -- Start Colima with Kubernetes

```bash
colima start --runtime containerd --kubernetes --cpu 4 --memory 8 --disk 60
kubectl get nodes   # should show 1 node Ready
```

---

## Step 2 -- Deploy the agent-sandbox operator

```bash
export VERSION="v0.1.1"
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/manifest.yaml
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/extensions.yaml
kubectl rollout status statefulset/agent-sandbox-controller -n agent-sandbox-system --timeout=120s
```

---

## Step 3 -- Build and load images

**sandbox-router** (if not already running from another example):

```bash
colima ssh -- sudo nerdctl -n k8s.io build \
  -t poc-sandbox-router:latest \
  $(pwd)/clients/python/agentic-sandbox-client/sandbox-router/
```

**ghostty sandbox** (takes a few minutes -- installs system packages,
AI CLIs, and compiles node-pty native bindings):

```bash
colima ssh -- sudo nerdctl -n k8s.io build \
  -t ghostty-sandbox:latest \
  $(pwd)/examples/ghostty-sandbox/sandbox/
```

---

## Step 4 -- Apply manifests

```bash
# Namespace (shared with other examples)
kubectl apply -f examples/opencode-sandbox/poc/manifests/namespace.yaml

# sandbox-router (skip if already deployed)
sed 's/imagePullPolicy: Never/imagePullPolicy: IfNotPresent/' \
  examples/opencode-sandbox/poc/manifests/sandbox-router.yaml | kubectl apply -f -
kubectl rollout status deployment/sandbox-router -n default

# (Optional) API key for AI CLIs inside the sandbox
kubectl create secret generic ghostty-keys -n opencode \
  --from-literal=anthropic=sk-ant-YOUR_KEY_HERE

# SandboxTemplate + WarmPool
kubectl apply -f examples/ghostty-sandbox/manifests/sandbox-template.yaml
kubectl apply -f examples/ghostty-sandbox/manifests/warmpool.yaml
```

Wait for the warm pool to fill:

```bash
kubectl get sandboxwarmpool ghostty-pool -n opencode -w
# NAME           READY   AGE
# ghostty-pool   2       30s    <- wait for READY=2
```

---

## Step 5 -- Port-forward the sandbox-router

In a **separate terminal** (keep it running):

```bash
kubectl port-forward svc/sandbox-router-svc 8080:8080 -n default
```

---

## Step 6 -- Start the backend

```bash
cd examples/ghostty-sandbox/backend
npm install ws
node server.js
# Listening on http://localhost:3001
```

Environment variables (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Backend HTTP port |
| `SANDBOX_NAMESPACE` | `opencode` | K8s namespace for sandbox resources |
| `SANDBOX_TEMPLATE` | `ghostty-template` | SandboxTemplate name |
| `SANDBOX_PORT` | `4096` | ghostty-web/demo port in pod |
| `ROUTER_HOST` | `localhost` | sandbox-router host |
| `ROUTER_PORT` | `8080` | sandbox-router port |

---

## Step 7 -- Open the browser

```
http://localhost:3001
```

1. Page loads and calls `POST /session`
2. Backend creates a SandboxClaim and waits for Ready (< 1s from warm pool)
3. WebSocket opens to `/session/:id/ws`
4. A real bash shell appears in the browser
5. Full dev toolkit available: `node`, `bun`, `git`, `vim`, `tmux`, `claude`, `codex`, etc.
6. Open multiple tabs -- each gets its own pod
7. Click **Close Session** to delete the claim and free the warm pool slot

---

## What's in the sandbox

| Category | Tools |
|----------|-------|
| Runtimes | Node 22, Bun, Python 3 |
| Package managers | npm, pnpm, bun |
| AI CLIs | claude (Claude Code), codex (OpenAI), opencode |
| Editors | vim, neovim |
| Shell tools | tmux, htop, procps, lsof |
| Search | ripgrep (rg), fd-find (fdfind), jq |
| Build | gcc, g++, make (build-essential) |
| Network | curl, wget, ssh |
| Other | git, unzip, zip, less, man |

---

## Troubleshooting

**Pod stuck in Pending / ImagePullBackOff**
```bash
kubectl get pods -n opencode
kubectl describe pod <name> -n opencode
colima ssh -- sudo nerdctl -n k8s.io images | grep ghostty
```

**WebSocket connection fails (shows "Disconnected" immediately)**
The sandbox-router must support WebSocket proxying. Verify the router image
includes the `websockets` Python package:
```bash
kubectl exec -n default deployment/sandbox-router -- pip list | grep websockets
```

**`SandboxClaim not Ready after 120s`**
```bash
kubectl get sandboxclaim -n opencode
kubectl describe sandboxclaim <name> -n opencode
kubectl get pods -n agent-sandbox-system
```

**Port-forward disconnects**
Restart it. The backend returns errors until it reconnects.

**Check warm pool status**
```bash
kubectl get sandboxwarmpool ghostty-pool -n opencode
kubectl get pods -n opencode -L agents.x-k8s.io/pool
```

**Update sandbox image without downtime**
```bash
# Rebuild
colima ssh -- sudo nerdctl -n k8s.io build -t ghostty-sandbox:latest \
  $(pwd)/examples/ghostty-sandbox/sandbox/

# Recycle warm pool (active sessions unaffected)
kubectl delete pods -n opencode -l agents.x-k8s.io/pool
```

**Clean up stranded claims**
```bash
kubectl get sandboxclaim -n opencode
kubectl delete sandboxclaim -n opencode --all
```
