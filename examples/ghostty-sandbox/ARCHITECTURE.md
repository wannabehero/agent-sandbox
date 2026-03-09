# Disposable Developer Shells -- Architecture

Give every engineer in your org a fresh, isolated, fully-loaded Linux shell
in < 1 second. Open a browser tab, get a PTY. Close the tab, the pod is gone.
No VPN, no SSH keys, no long-lived VMs.

This document covers the system design, data flow, operational model, and
production considerations.

---

## Table of contents

1. [Why](#why)
2. [System overview](#system-overview)
3. [Core concepts](#core-concepts)
4. [Data flow](#data-flow)
5. [Component details](#component-details)
6. [Sandbox image](#sandbox-image)
7. [Kubernetes resource model](#kubernetes-resource-model)
8. [WebSocket relay chain](#websocket-relay-chain)
9. [Session lifecycle](#session-lifecycle)
10. [Pre-warming and pool mechanics](#pre-warming-and-pool-mechanics)
11. [Security model](#security-model)
12. [Capacity planning](#capacity-planning)
13. [Production gaps](#production-gaps)

---

## Why

Developers need throwaway environments for:

- **Trying things out** -- install a dependency, run a build, test a script,
  without polluting their laptop.
- **AI-assisted coding** -- `claude`, `codex`, and `opencode` are
  pre-installed and API-key-injected. Open a shell, type `claude`, start
  prompting.
- **Onboarding** -- new hires get a standard environment without "works on my
  machine" friction.
- **Incident response** -- spin up a shell, clone the repo, inspect logs, run
  queries. Destroy it when done. Nothing persists that shouldn't.
- **Pair debugging** -- share a session URL (future) for real-time collaboration
  in a shared PTY.

The key properties are:

| Property | How it works |
|----------|-------------|
| **Instant** | Warm pool keeps pods pre-booted; claim adoption < 1 second |
| **Disposable** | Close the tab or click "Close Session" and the pod is deleted |
| **Isolated** | Each session gets its own pod, filesystem, process namespace |
| **Batteries included** | Node, Bun, Python, Git, Vim, tmux, ripgrep, AI CLIs |
| **Zero setup** | No SSH keys, no VPN, no local installs. Just a browser |

---

## System overview

```
                         Browser tabs (N concurrent engineers)
                         ┌──────────┐ ┌──────────┐ ┌──────────┐
                         │ xterm.js │ │ xterm.js │ │ xterm.js │
                         └────┬─────┘ └────┬─────┘ └────┬─────┘
                              │ws          │ws          │ws
                         ┌────┴────────────┴────────────┴────┐
                         │   Backend (Node.js, port 3001)    │
                         │                                    │
                         │   GET  /               HTML + JS   │
                         │   POST /session        create pod  │
                         │   DEL  /session/:id    delete pod  │
                         │   WS   /session/:id/ws relay PTY   │
                         └──────────┬─────────────────────────┘
                                    │ ws (with X-Sandbox-* headers)
                                    │
                         ┌──────────┴─────────────────────────┐
                         │   sandbox-router (Python/FastAPI)   │
                         │   Deployment, port 8080             │
                         │                                     │
                         │   Routes by header:                 │
                         │   X-Sandbox-ID → K8s DNS lookup     │
                         │   HTTP + WebSocket proxy            │
                         └──────────┬──────────────────────────┘
                                    │ ws
              ┌─────────────────────┼─────────────────────┐
              ▼                     ▼                     ▼
    ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
    │  sandbox pod  │    │  sandbox pod  │    │  sandbox pod  │
    │  ghostty-web  │    │  ghostty-web  │    │  ghostty-web  │
    │  :4096 /ws    │    │  :4096 /ws    │    │  :4096 /ws    │
    │               │    │               │    │               │
    │  node-pty     │    │  node-pty     │    │  node-pty     │
    │  ┌─────────┐  │    │  ┌─────────┐  │    │  ┌─────────┐  │
    │  │  bash   │  │    │  │  bash   │  │    │  │  bash   │  │
    │  └─────────┘  │    │  └─────────┘  │    │  └─────────┘  │
    └───────────────┘    └───────────────┘    └───────────────┘
```

**Key principle**: every engineer gets their own pod. Pods are pre-warmed.
The backend is a thin WebSocket relay. No state is stored server-side beyond
in-memory claim-to-session mapping.

---

## Core concepts

### ghostty-web/demo

An npm package (`@ghostty-web/demo`) that:
- Starts an HTTP server on a configurable port (`PORT` env)
- Serves a WASM-compiled Ghostty terminal UI at `/`
- Exposes `/ws?cols=N&rows=N` which spawns a real PTY via `node-pty`
- Each WebSocket connection gets its own shell process

No LLM, no auth, no database. Just a PTY server.

### SandboxTemplate

A Kubernetes CRD defining the pod blueprint: container image, ports,
environment variables (including API keys from Secrets), probes. Deployed once,
shared across all sessions.

### SandboxWarmPool

Maintains N pre-booted pods matching a SandboxTemplate. Pods are fully
initialized (image pulled, process started, readiness probe passing) and
waiting to be claimed. The pool controller continuously reconciles to keep
the count at the desired replica level.

### SandboxClaim

A per-session request for a sandbox pod. When created:

1. The claim controller finds a Ready pod in the warm pool
2. Adopts it (strips pool labels, creates a Sandbox CR + headless Service)
3. Marks the claim Ready

The pool controller immediately creates a replacement pod.

### sandbox-router

A stateless reverse proxy (Python/FastAPI/uvicorn). Reads routing headers from
each request (`X-Sandbox-ID`, `X-Sandbox-Namespace`, `X-Sandbox-Port`) and
forwards to the target pod via Kubernetes DNS:

```
X-Sandbox-ID: ghostty-a1b2c3d4
  → ghostty-a1b2c3d4.opencode.svc.cluster.local:4096
```

Supports both HTTP and WebSocket connections.

---

## Data flow

### Opening a new terminal session

```
 Browser                 Backend               K8s API             Warm Pool
    │                       │                     │                    │
    │  POST /session        │                     │                    │
    ├──────────────────────►│                     │                    │
    │                       │  kubectl apply      │                    │
    │                       │  SandboxClaim       │                    │
    │                       ├────────────────────►│                    │
    │                       │                     │  adopt pod         │
    │                       │                     ├───────────────────►│
    │                       │                     │  Ready (< 1s)      │
    │                       │  poll Ready=True    │                    │
    │                       │◄────────────────────┤                    │
    │  {"id":"ghostty-..."}│                     │                    │
    │◄──────────────────────┤                     │  create            │
    │                       │                     │  replacement pod   │
    │                       │                     │───────────────────►│
```

### WebSocket relay (terminal I/O)

```
 Browser              Backend              Router              Pod (ghostty-web)
    │                    │                    │                    │
    │ ws://host/session  │                    │                    │
    │ /:id/ws?cols&rows  │                    │                    │
    ├───────────────────►│                    │                    │
    │                    │ ws://router:8080   │                    │
    │                    │ /ws?cols&rows      │                    │
    │                    │ + X-Sandbox-*      │                    │
    │                    ├───────────────────►│                    │
    │                    │                    │ ws://pod:4096      │
    │                    │                    │ /ws?cols&rows      │
    │                    │                    ├───────────────────►│
    │                    │                    │                    │
    │                    │                    │  node-pty spawns   │
    │                    │                    │  bash process      │
    │                    │                    │                    │
    │  keystroke         │                    │                    │
    ├───────────────────►├───────────────────►├───────────────────►│
    │                    │                    │                    │  bash
    │                    │                    │                    │  processes
    │  terminal output   │                    │                    │  input
    │◄───────────────────┤◄───────────────────┤◄───────────────────┤
    │                    │                    │                    │
    │  ... bidirectional relay continues ...  │                    │
```

### Closing a session

```
 Browser              Backend              K8s API
    │                    │                    │
    │ DEL /session/:id   │                    │
    ├───────────────────►│                    │
    │                    │ kubectl delete     │
    │                    │ SandboxClaim       │
    │                    ├───────────────────►│
    │                    │                    │  cascade delete:
    │                    │                    │  Pod + Service
    │  204               │                    │
    │◄───────────────────┤                    │  WarmPool controller
    │                    │                    │  creates replacement
```

---

## Component details

### Backend (`backend/server.js`)

~280 lines of Node.js. Pure stdlib + `ws` package.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Serve embedded HTML page with xterm.js terminal |
| `/session` | POST | Create SandboxClaim, poll until Ready, return ID |
| `/session/:id` | DELETE | Delete SandboxClaim, free warm pool slot |
| `/session/:id/ws` | WebSocket | Bidirectional relay to sandbox pod via router |

The backend manages WebSocket relay by:
1. Accepting the browser WebSocket at `/session/:id/ws`
2. Opening a backend-to-router WebSocket at `ws://ROUTER_HOST:ROUTER_PORT/ws`
   with `X-Sandbox-*` headers (browsers cannot send custom headers on WS)
3. Piping frames bidirectionally (binary and text)
4. Closing both sides when either disconnects

| Env var | Default | Purpose |
|---------|---------|---------|
| `PORT` | 3001 | Backend listen port |
| `SANDBOX_NAMESPACE` | opencode | K8s namespace for claims |
| `SANDBOX_TEMPLATE` | ghostty-template | SandboxTemplate name |
| `SANDBOX_PORT` | 4096 | ghostty-web port inside pod |
| `ROUTER_HOST` | localhost | sandbox-router host |
| `ROUTER_PORT` | 8080 | sandbox-router port |

### sandbox-router (`sandbox_router.py`)

FastAPI app running under uvicorn. Two route handlers:

1. **WebSocket** `/{full_path:path}` -- accepts WS upgrade, reads routing
   headers, opens a second WS to the target pod, relays frames in both
   directions using `asyncio.wait(FIRST_COMPLETED)`.

2. **HTTP** `/{full_path:path}` -- proxies GET/POST/PUT/DELETE/PATCH via
   `httpx.AsyncClient` with streaming response.

Both resolve the pod address via:
```
{X-Sandbox-ID}.{X-Sandbox-Namespace}.svc.cluster.local:{X-Sandbox-Port}
```

### Sandbox pod (ghostty-web/demo)

The `ghostty-web-demo` process listens on port 4096. When a WebSocket connects
to `/ws?cols=80&rows=24`, it:
1. Spawns a new PTY with `node-pty` (allocates a real `/dev/pts/N`)
2. Starts `bash` (or `$SHELL`) inside the PTY
3. Relays stdin/stdout between the WebSocket and the PTY
4. Kills the PTY process when the WebSocket closes

Each WebSocket = one independent shell session.

---

## Sandbox image

The Dockerfile (`sandbox/Dockerfile`) builds a complete dev environment:

```
Base: node:22-slim (Debian Bookworm)

System packages:
  curl git wget vim neovim tmux htop procps lsof
  jq ripgrep fd-find build-essential python3
  ca-certificates ssh less man-db unzip zip

Package managers:
  npm (bundled with Node 22)
  pnpm
  bun

AI coding CLIs:
  claude     (@anthropic-ai/claude-code)
  codex      (@openai/codex)
  opencode   (opencode-ai)

Application:
  ghostty-web-demo  (@ghostty-web/demo@next)
```

API keys are injected via Kubernetes Secrets in the SandboxTemplate, not baked
into the image. The image is environment-agnostic.

### What engineers get out of the box

```
$ node --version         # v22.x
$ bun --version          # 1.x
$ pnpm --version         # 10.x
$ python3 --version      # 3.11.x
$ git --version          # 2.39.x
$ claude --version       # Claude Code CLI
$ codex --version        # OpenAI Codex CLI
$ opencode --version     # opencode CLI
$ vim / nvim / tmux      # editors and multiplexer
$ rg / fd / jq           # modern CLI tools
$ curl / wget / ssh      # network tools
$ gcc / g++ / make       # native compilation
```

---

## Kubernetes resource model

### Deployed once (cluster infrastructure)

```yaml
# CRDs (from agent-sandbox release)
#   sandboxes.agents.x-k8s.io
#   sandboxtemplates.extensions.agents.x-k8s.io
#   sandboxclaims.extensions.agents.x-k8s.io
#   sandboxwarmpools.extensions.agents.x-k8s.io

# Controller
#   StatefulSet: agent-sandbox-controller (namespace: agent-sandbox-system)

# Router
#   Deployment: sandbox-router (namespace: default)
#   Service:    sandbox-router-svc (port 8080)
```

### Deployed once per environment

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: opencode
---
# Optional: API keys for AI CLIs
apiVersion: v1
kind: Secret
metadata:
  name: ghostty-keys
  namespace: opencode
stringData:
  anthropic: "sk-ant-..."   # for claude CLI
---
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxTemplate
metadata:
  name: ghostty-template
  namespace: opencode
spec:
  podTemplate:
    spec:
      containers:
        - name: sandbox
          image: ghostty-sandbox:latest
          ports:
            - containerPort: 4096
          env:
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: ghostty-keys
                  key: anthropic
          readinessProbe:
            httpGet:
              path: /
              port: 4096
            initialDelaySeconds: 5
            periodSeconds: 3
            failureThreshold: 10
---
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxWarmPool
metadata:
  name: ghostty-pool
  namespace: opencode
spec:
  replicas: 2
  sandboxTemplateRef:
    name: ghostty-template
```

### Created per session (by backend, ephemeral)

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxClaim
metadata:
  name: ghostty-a1b2c3d4    # random, generated by backend
  namespace: opencode
spec:
  sandboxTemplateRef:
    name: ghostty-template
```

---

## WebSocket relay chain

Browsers cannot send custom HTTP headers on WebSocket connections. The
three-hop relay solves this:

```
Browser WebSocket
  │  ws://localhost:3001/session/ghostty-abc/ws?cols=80&rows=24
  │  (no custom headers -- browser limitation)
  ▼
Backend (Node.js)
  │  Extracts claim ID from URL path
  │  Opens new WebSocket to router:
  │  ws://localhost:8080/ws?cols=80&rows=24
  │  Headers:
  │    X-Sandbox-ID: ghostty-abc
  │    X-Sandbox-Namespace: opencode
  │    X-Sandbox-Port: 4096
  ▼
sandbox-router (FastAPI)
  │  Reads headers, resolves K8s DNS:
  │  ws://ghostty-abc.opencode.svc.cluster.local:4096/ws?cols=80&rows=24
  ▼
Pod (ghostty-web/demo)
  │  node-pty spawns bash in a real PTY
  │  Bidirectional stream: WebSocket <-> PTY fd
  ▼
bash (interactive shell)
```

Each hop is a full-duplex WebSocket. The backend and router relay frames
byte-for-byte without interpretation. Frame type (binary/text) is preserved.

---

## Session lifecycle

```
  ┌─────────────┐
  │  Page load   │
  └──────┬──────┘
         │ POST /session
         ▼
  ┌─────────────┐      claim Ready < 1s
  │  Creating    │──────────────────────────┐
  └─────────────┘                           │
                                            ▼
                                   ┌─────────────────┐
                                   │  Connected       │
                                   │  (WebSocket open,│
                                   │   PTY running)   │
                                   └────┬─────────┬───┘
                                        │         │
                                   tab close   "Close Session"
                                        │         │
                                        ▼         ▼
                               ┌──────────────────────┐
                               │  Disconnected         │
                               │  (WS closed, PTY      │
                               │   killed, claim        │
                               │   deleted, pod freed)  │
                               └──────────────────────┘
                                        │
                                        ▼
                               ┌──────────────────────┐
                               │  Pool refilled        │
                               │  (replacement pod     │
                               │   auto-created)       │
                               └──────────────────────┘
```

There is no hibernation or resume. Sessions are intentionally ephemeral.
When the WebSocket closes, the PTY process is killed. When the SandboxClaim
is deleted, the pod and its filesystem are destroyed.

---

## Pre-warming and pool mechanics

### Adoption flow

```
Before claim:
  SandboxWarmPool ghostty-pool (replicas: 2)
    ├── ghostty-pool-abc  [Ready]   ← template hash: 8f2a1b
    └── ghostty-pool-def  [Ready]   ← template hash: 8f2a1b

SandboxClaim "ghostty-a1b2c3d4" created:

  1. Claim controller finds ghostty-pool-abc (Ready, matching hash)
  2. Strips pool labels from ghostty-pool-abc
  3. Creates Sandbox CR "ghostty-a1b2c3d4" owning the pod
  4. Creates headless Service "ghostty-a1b2c3d4"
  5. Marks SandboxClaim Ready

After claim:
  SandboxWarmPool ghostty-pool (replicas: 2)
    ├── ghostty-pool-def  [Ready]
    └── ghostty-pool-ghi  [Starting]  ← auto-created replacement

  Sandbox "ghostty-a1b2c3d4"
    └── ghostty-pool-abc  [Running]   ← adopted, no longer in pool
```

**Adoption latency: < 1 second.**

### Pool sizing

Set `replicas` to match your peak burst of concurrent new sessions.
If the pool empties, new claims fall back to cold starts (30-90s for image
pull + process initialization).

For a team of 20 engineers, `replicas: 3-5` is usually sufficient since not
everyone opens a new shell at the exact same moment.

### Updating the image

Changing the SandboxTemplate does NOT auto-rotate existing warm pool pods.
To roll out a new image:

```bash
# 1. Update template
kubectl apply -f manifests/sandbox-template.yaml

# 2. Kill old warm pods (controller recreates from new template)
kubectl delete pods -n opencode -l agents.x-k8s.io/pool
```

Active sessions are unaffected -- they keep their original pod.

---

## Security model

### Current state (PoC)

| Layer | Status | Notes |
|-------|--------|-------|
| Authentication | None | Anyone with backend access can create sessions |
| Session isolation | Pod-level | Each session gets its own pod and filesystem |
| Network isolation | None | Pods can reach the internet and cluster services |
| Runtime isolation | Container | Standard container sandbox (runc) |
| API key injection | K8s Secret | Keys injected via env var, not baked into image |

### Production hardening

| Layer | Recommendation |
|-------|---------------|
| **Authentication** | Add OAuth2/OIDC to the backend; restrict to org members |
| **Network policy** | Default-deny NetworkPolicy on sandbox namespace; allow only required egress (LLM APIs, package registries) |
| **gVisor** | Add `runtimeClassName: gvisor` to SandboxTemplate for syscall-level isolation |
| **Resource limits** | Add CPU/memory limits to prevent resource exhaustion |
| **Session TTL** | Auto-delete claims after N minutes of inactivity |
| **Audit logging** | Log session create/delete with user identity and timestamps |
| **Secret rotation** | Use external-secrets-operator for automatic key rotation |

### gVisor example

```yaml
spec:
  podTemplate:
    spec:
      runtimeClassName: gvisor
      containers:
        - name: sandbox
          resources:
            limits:
              cpu: "2"
              memory: 2Gi
            requests:
              cpu: 250m
              memory: 512Mi
```

---

## Capacity planning

### Per-pod resource usage

| State | CPU | Memory | Disk |
|-------|-----|--------|------|
| Idle (warm pool, ghostty-web waiting) | ~5m | ~80Mi | ~500Mi |
| Active (user typing, shell running) | ~50m | ~150Mi | ~500Mi + workspace |
| Peak (compiling, AI CLI running) | ~500m+ | ~500Mi+ | varies |

### Sizing formula

```
warm_pool = ceil(peak_new_sessions_per_minute * startup_time_minutes)
           ≈ burst_rate  (since startup < 1s with warm pool)

total_pods = warm_pool + active_sessions
node_count = ceil(total_pods * memory_per_pod / node_allocatable)
```

### Example: 50-person engineering team

```
Typical concurrent sessions:  15  (30% of team at any time)
Warm pool:                     5  (handles bursts)
Total pods:                   20
Memory per pod (avg):        200Mi
Total memory:                  4Gi
Nodes (8Gi each):              1   (fits on a single node)
```

---

## Production gaps

| Gap | Priority | Description |
|-----|----------|-------------|
| **Authentication** | P0 | No auth on backend endpoints |
| **Session TTL** | P0 | Forgotten tabs leave pods running forever |
| **NetworkPolicy** | P1 | Pods have unrestricted network access |
| **gVisor isolation** | P1 | Containers use standard runc |
| **Resource limits** | P1 | No CPU/memory limits on pods |
| **Backend in-cluster** | P1 | Backend runs locally with kubectl; should be a Deployment with RBAC |
| **Multi-tab/share** | P2 | Each tab creates a new pod; could share pods across tabs |
| **Persistent workspace** | P2 | Filesystem lost on pod delete; add optional PVC |
| **Session recording** | P2 | No audit trail of terminal activity |
| **Pool auto-scaling** | P3 | Fixed warm pool size; could scale based on demand |
| **Multi-cluster** | P3 | Single cluster only |
