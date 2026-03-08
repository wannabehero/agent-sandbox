# opencode Web Coding Agent — Architecture

A Claude Code Web-like experience: user submits a prompt in a browser, an opencode
agent runs it inside a K8s sandbox pod, streams the response back, and the
conversation is persisted across sessions.

---

## Bird's-eye view

```
Browser (Web UI)
    │  WebSocket / SSE
    ▼
Backend Service  (Node/Python)
    │  creates SandboxClaim  →  K8s claim controller  →  adopts warm pod
    │                                                   → Pod + headless Service
    │  HTTP via sandbox-router
    │    headers: X-Sandbox-ID, X-Sandbox-Port
    ▼
opencode server  (inside sandbox pod, port 4096)
    │
    ├─ tool calls: bash, read, write, edit, grep, glob, lsp …
    └─ LLM: Anthropic API (key injected via K8s Secret → /tokens/anthropic)
```

---

## Component breakdown

| Component | What it does | Where it lives |
|---|---|---|
| **Web UI** | Chat interface (prompt input, streaming output) | Browser |
| **Backend** | Session management, sandbox lifecycle, proxy | K8s Deployment |
| **sandbox-router** | Reverse-proxies HTTP to pods by header | Existing deployment |
| **SandboxTemplate** | Blueprint for the opencode pod (image, ports, env) | K8s CR (one, shared) |
| **SandboxWarmPool** | Keeps N pre-booted pods ready to be claimed | K8s CR (one, shared) |
| **SandboxClaim** | Per-session claim; adopts a warm pod instantly | K8s CR (one per session) |
| **Session Store** | Stores opencode session JSON between sandbox lifetimes | Postgres / Redis / S3 |

---

## Pre-warming: the key insight

Rather than creating a brand-new pod on every user request (cold: ~30s), the
warm pool keeps pods pre-booted against the template image. When a claim arrives
the controller **adopts** an existing ready pod — stripping the pool labels and
re-owning it under the claim. The pool controller immediately starts a
replacement pod to refill the pool.

```
SandboxWarmPool (replicas: 3)
  ├── pod-abc  [Ready]   ← SandboxClaim "oc-user1" adopts this  →  ~instant
  ├── pod-def  [Ready]
  └── pod-ghi  [Starting]  ← replacement, started by pool controller

After adoption:
  SandboxWarmPool (replicas: 3)
    ├── pod-def  [Ready]
    ├── pod-ghi  [Ready]      ← pool stays full
    └── pod-jkl  [Starting]  ← new replacement
```

Warm claim resolution: **< 1 second** (just a label swap + Service creation).

---

## K8s resources to deploy once (cluster-level)

### 1. SandboxTemplate — the opencode pod spec

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxTemplate
metadata:
  name: opencode-template
  namespace: opencode
spec:
  podTemplate:
    spec:
      containers:
        - name: opencode
          image: ghcr.io/your-org/opencode-sandbox:latest
          ports:
            - containerPort: 4096
          env:
            - name: ANTHROPIC_API_KEY
              valueFrom:
                secretKeyRef:
                  name: llm-keys
                  key: anthropic
          volumeMounts:
            - mountPath: /workspaces
              name: workspaces-pvc
      volumes:
        - name: workspaces-pvc
          emptyDir: {}   # or a PVC if you need persistence across claims
```

### 2. SandboxWarmPool — keep N pods pre-booted

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxWarmPool
metadata:
  name: opencode-pool
  namespace: opencode
spec:
  replicas: 3               # tune based on expected concurrency
  sandboxTemplateRef:
    name: opencode-template
```

These two resources are deployed once. They don't change per user or per session.

---

## Per-session resource: SandboxClaim

When a new session needs a sandbox the backend creates:

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxClaim
metadata:
  name: oc-{sessionId}      # ← this becomes sandboxName
  namespace: opencode
spec:
  sandboxTemplateRef:
    name: opencode-template
  lifecycle:
    shutdownTime: "..."      # optional hard expiry
```

`sandboxName = "oc-{sessionId}"` — the claim name **is** the sandbox name.

The claim controller:
1. Finds a Ready pod in the warm pool whose `sandbox-template-ref-hash` matches
2. Adopts it (label swap, re-owner to the new Sandbox CR)
3. Creates a headless Service named `oc-{sessionId}` in namespace `opencode`
   → FQDN: `oc-{sessionId}.opencode.svc.cluster.local`
4. Marks the SandboxClaim Ready

The pool controller simultaneously starts a replacement pod.

---

## Full request flow, step by step

### 1. User opens the Web UI

A `sessionId` (UUID) is generated on the client and stored in `localStorage`.

### 2. User submits a prompt

```
POST /api/sessions/{sessionId}/messages
{ "text": "Refactor the auth module to use JWT" }
```

### 3. Backend resolves the sandbox

**New session** — no sandbox exists yet:

```typescript
// Create a SandboxClaim; warm pool adoption makes this near-instant
await k8s.createSandboxClaim(`oc-${sessionId}`, "opencode", "opencode-template")
await k8s.waitClaimReady(`oc-${sessionId}`, "opencode")  // polls .status.conditions
// sandboxName = `oc-${sessionId}`  ← that's it, no lookup needed
```

**Active session** — sandbox already running:

No K8s calls. Backend already has `sandboxName` in DB.

**Hibernated session** — idle timeout fired, pod was deleted, JSON was saved:

```typescript
// Create a fresh claim (may be warm or cold depending on pool state)
await k8s.createSandboxClaim(`oc-${sessionId}`, "opencode", "opencode-template")
await k8s.waitClaimReady(`oc-${sessionId}`, "opencode")
// Restore conversation history before sending message
await opencodeClient(sandboxName).importSession(session.jsonBlob)
```

### 4. Backend forwards the prompt to opencode

All opencode calls go through **sandbox-router** with routing headers:

```
POST http://sandbox-router-svc.opencode.svc.cluster.local:8080/session/message
X-Sandbox-ID:        oc-{sessionId}
X-Sandbox-Namespace: opencode
X-Sandbox-Port:      4096
Content-Type:        application/json

{ "text": "Refactor the auth module to use JWT" }
```

sandbox-router resolves:
```
http://oc-{sessionId}.opencode.svc.cluster.local:4096/session/message
```

### 5. Streaming the response to the browser

Backend opens an SSE stream and pipes opencode events:

```
event: token
data: {"delta": "I'll start by looking at"}

event: tool_call
data: {"tool": "read", "path": "src/auth/index.ts"}

event: tool_result
data: {"tool": "read", "content": "...file contents..."}

event: token
data: {"delta": " the existing implementation."}

event: done
data: {}
```

### 6. User follows up

Same flow from step 4 — sandbox still running, session state lives in the pod.

### 7. Idle timeout → hibernate

Backend background job (every 60s):

```typescript
for (const session of await db.getSessionsIdleSince(5 * 60 * 1000)) {
  const json = await opencodeClient(session.sandboxName).exportSession()
  await db.hibernateSession(session.id, json)
  await k8s.deleteSandboxClaim(session.sandboxName, "opencode")
  // Deleting the claim cascades: Sandbox CR → pod → Service are all removed
}
```

The conversation lives in the exported JSON. The pod slot returns to the cluster.
The warm pool refills automatically.

---

## Where does `sandboxName` come from?

```
sandboxName = "oc-" + sessionId
```

- `sessionId`: UUID generated by the browser, persisted in `localStorage`
- The backend names the `SandboxClaim` with this value
- The claim controller creates a `Sandbox` and headless `Service` with the same name
- That Service name is what `X-Sandbox-ID` carries — it's the DNS label the router uses

The mapping is **deterministic** — no separate lookup, no stored mapping needed
(though the DB row is useful for storing status and the JSON blob).

---

## Backend pseudocode (Node/TypeScript)

```typescript
// POST /api/sessions/:sessionId/messages
async function sendMessage(sessionId: string, text: string, res: Response) {
  let session = await db.getSession(sessionId)
  const sandboxName = `oc-${sessionId}`

  if (!session) {
    await k8s.createSandboxClaim(sandboxName, "opencode", "opencode-template")
    await k8s.waitClaimReady(sandboxName, "opencode")
    session = await db.createSession(sessionId, sandboxName)

  } else if (session.status === "hibernated") {
    await k8s.createSandboxClaim(sandboxName, "opencode", "opencode-template")
    await k8s.waitClaimReady(sandboxName, "opencode")
    await opencodeClient(sandboxName).importSession(session.jsonBlob)
    await db.markActive(sessionId)
  }

  await db.updateLastActivity(sessionId)

  res.setHeader("Content-Type", "text/event-stream")
  const stream = await opencodeClient(sandboxName).sendMessage(text)

  for await (const event of stream) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }
  res.write("event: done\ndata: {}\n\n")
  res.end()
}

// opencode client factory — all calls routed through sandbox-router
function opencodeClient(sandboxName: string) {
  const baseHeaders = {
    "X-Sandbox-ID": sandboxName,
    "X-Sandbox-Namespace": "opencode",
    "X-Sandbox-Port": "4096",
  }
  const baseUrl = "http://sandbox-router-svc.opencode.svc.cluster.local:8080"

  return {
    sendMessage:   (text: string) => fetch(`${baseUrl}/session/message`,
      { method: "POST", headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ text }) }),

    importSession: (json: unknown) => fetch(`${baseUrl}/session/import`,
      { method: "POST", headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(json) }),

    exportSession: () =>
      fetch(`${baseUrl}/session/export`, { headers: baseHeaders }).then(r => r.json()),
  }
}
```

---

## Session Store schema

```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,   -- sessionId (UUID from browser)
  sandbox_name  TEXT,               -- "oc-{sessionId}"
  status        TEXT,               -- "active" | "hibernated" | "error"
  json_blob     JSONB,              -- opencode session export (null while active)
  created_at    TIMESTAMPTZ,
  last_activity TIMESTAMPTZ
);
```

---

## Pod image (opencode-sandbox)

```dockerfile
FROM ubuntu:24.04

RUN curl -fsSL https://opencode.ai/install.sh | sh
RUN apt-get install -y git nodejs npm python3 ripgrep fd-find

ENTRYPOINT ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
```

Or use envbuilder + a `devcontainer.json` (same as vscode-sandbox). In that case
`entrypoint.sh` calls `opencode serve` instead of `code-server`.

---

## Latency summary

| Scenario | Latency | Reason |
|---|---|---|
| Active session, follow-up | ~0s | Pod already running |
| New session, warm pool has ready pod | **< 1s** | Label swap + Service creation |
| New session, warm pool empty | ~20–40s | Cold pod boot (image pull + init) |
| Hibernated session resume | **< 1s** + import time | Warm pod claim + JSON load |

Keep pool `replicas` ≥ expected concurrent new-session rate.

---

## Open questions / future work

| Topic | Note |
|---|---|
| **Pool sizing** | Auto-scale `SandboxWarmPool.spec.replicas` via HPA based on queue depth |
| **PVC reuse on resume** | Deleting the claim loses `/workspaces`. Keep PVC as a separate resource and re-attach on resume if working directory persistence matters |
| **Auth** | Add user authentication before production |
| **Snapshot support** | Once agent-sandbox snapshot/restore lands, replace JSON export/import with native snapshot for faster resume |
| **Multi-repo** | Inject `REPO_URL` env var at claim creation time or via a per-session init script |
| **Tool approval** | Stream tool calls to browser before execution; gate destructive ones on user click |
