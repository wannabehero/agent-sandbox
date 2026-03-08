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
    │  creates Sandbox CR  →  K8s Sandbox Controller  →  Pod + headless Service
    │
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
| **Sandbox CR + Pod** | Runs opencode server, has repo checked out | K8s (created per session) |
| **Session Store** | Stores opencode session JSON between sandbox lifetimes | Postgres / Redis / S3 |

---

## Full flow, step by step

### 1. User opens the Web UI

The frontend is a simple chat page. No sandbox exists yet.

```
GET /  →  HTML page with a text input
```

A `sessionId` (UUID) is generated on the client and stored in `localStorage`.
It is sent in every request.

---

### 2. User submits first prompt

```
POST /api/sessions/{sessionId}/messages
{ "text": "Refactor the auth module to use JWT" }
```

Backend checks: **does a sandbox exist for this sessionId?**

---

### 3. Backend creates (or reuses) a sandbox

#### First message — sandbox does not exist yet

Backend applies a `Sandbox` CR:

```yaml
apiVersion: agents.x-k8s.io/v1alpha1
kind: Sandbox
metadata:
  name: oc-{sessionId}      # ← this is sandboxName
  namespace: opencode
spec:
  podTemplate:
    metadata:
      labels:
        sandbox: oc-{sessionId}
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
  volumeClaimTemplates:
    - metadata:
        name: workspaces-pvc
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests:
            storage: 10Gi
```

`sandboxName = "oc-{sessionId}"` — derived directly from the sessionId.

The Sandbox controller automatically creates:
- The pod running opencode
- A headless K8s Service named `oc-{sessionId}` in namespace `opencode`
  → FQDN: `oc-{sessionId}.opencode.svc.cluster.local`

Backend polls `sandbox.status.conditions` until `Ready = True` (typically 20–40s
on first boot while envbuilder builds the image; near-instant on warm cache).

#### Subsequent messages — sandbox already running

Backend looks up sessionId → sandboxName in its own DB. No new CR needed.

#### Resuming after idle shutdown

Backend looks up sessionId → finds saved `sessionJson` in Session Store. It
creates a fresh sandbox CR (same pattern) and, once ready, calls:

```
POST /api/sessions/{sessionId}/restore
```

which imports the saved session JSON into opencode before sending the new message.

---

### 4. Backend forwards the prompt to opencode

All opencode HTTP calls go through **sandbox-router** using routing headers:

```
POST http://sandbox-router-svc.opencode.svc.cluster.local:8080/session
X-Sandbox-ID:        oc-{sessionId}
X-Sandbox-Namespace: opencode
X-Sandbox-Port:      4096
Content-Type:        application/json

{ "text": "Refactor the auth module to use JWT" }
```

sandbox-router resolves the pod at:
```
http://oc-{sessionId}.opencode.svc.cluster.local:4096/session
```

and streams the response back.

---

### 5. Streaming the response to the browser

Backend opens an SSE stream to the client and pipes opencode events through:

```
GET /api/sessions/{sessionId}/stream
```

Events forwarded as SSE:

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

The browser renders tokens as they arrive, shows tool calls inline (collapsible),
and re-enables the input box on `done`.

---

### 6. User follows up

User types another message. Same flow from step 4 — sandbox is already running,
session state is held inside opencode in the pod.

---

### 7. Idle timeout → session saved

Backend tracks `lastActivity` per sessionId. A background job runs every 60s:

```python
for session in active_sessions:
    if now - session.last_activity > timedelta(minutes=5):
        # 1. Export opencode session JSON
        json_blob = GET /export via sandbox-router

        # 2. Save to Session Store
        db.save(session_id=session.id, json=json_blob)

        # 3. Delete sandbox CR (frees pod + PVC)
        k8s.delete(Sandbox, name=f"oc-{session.id}")

        # 4. Mark session as hibernated
        session.status = "hibernated"
```

The pod and PVC are deleted to free cluster resources. The conversation lives
entirely in the exported JSON.

---

## Resuming a hibernated session

```
POST /api/sessions/{sessionId}/messages
{ "text": "Now also add refresh token support" }
```

Backend sees `session.status == "hibernated"`:

1. Create fresh sandbox CR (`oc-{sessionId}`)
2. Wait for pod ready
3. POST session JSON to opencode import endpoint
4. Send the new message
5. Mark session as `active`, update `lastActivity`

From the user's perspective: ~30s delay (pod boot) then the conversation
continues with full history.

---

## Pod image (opencode-sandbox)

The sandbox image needs:

```dockerfile
FROM ubuntu:24.04

# opencode binary
RUN curl -fsSL https://opencode.ai/install.sh | sh

# Dev tools (same as any coding agent would need)
RUN apt-get install -y git nodejs npm python3 ripgrep fd-find

# Entrypoint: start opencode server
ENTRYPOINT ["opencode", "serve", "--port", "4096", "--hostname", "0.0.0.0"]
```

Or use envbuilder + a devcontainer.json (same as vscode-sandbox) to get a
fully configured dev environment. In that case entrypoint.sh just runs
`opencode serve` instead of `code-server`.

---

## Session Store schema

```sql
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,    -- sessionId (UUID)
  sandbox_name TEXT,                -- "oc-{sessionId}"
  status       TEXT,                -- "active" | "hibernated" | "error"
  json_blob    JSONB,               -- opencode session export (null if active)
  created_at   TIMESTAMPTZ,
  last_activity TIMESTAMPTZ
);
```

---

## Backend pseudocode (Node/TypeScript)

```typescript
// POST /api/sessions/:sessionId/messages
async function sendMessage(sessionId: string, text: string, res: Response) {
  let session = await db.getSession(sessionId)

  if (!session) {
    // Brand new session
    const sandboxName = `oc-${sessionId}`
    await k8s.applySandbox(sandboxName, namespace)
    await k8s.waitReady(sandboxName, namespace)
    session = await db.createSession(sessionId, sandboxName)

  } else if (session.status === "hibernated") {
    // Resume from saved JSON
    await k8s.applySandbox(session.sandboxName, namespace)
    await k8s.waitReady(session.sandboxName, namespace)
    await opencodeClient(session.sandboxName).importSession(session.jsonBlob)
    await db.markActive(sessionId)

  }

  await db.updateLastActivity(sessionId)

  // Stream opencode response → SSE to browser
  res.setHeader("Content-Type", "text/event-stream")
  const stream = await opencodeClient(session.sandboxName).sendMessage(text)

  for await (const event of stream) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  res.write("event: done\ndata: {}\n\n")
  res.end()
}

// opencode client factory — routes through sandbox-router
function opencodeClient(sandboxName: string) {
  const baseHeaders = {
    "X-Sandbox-ID": sandboxName,
    "X-Sandbox-Namespace": "opencode",
    "X-Sandbox-Port": "4096",
  }
  const baseUrl = "http://sandbox-router-svc.opencode.svc.cluster.local:8080"

  return {
    sendMessage: (text: string) =>
      fetch(`${baseUrl}/session/message`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      }),

    importSession: (json: unknown) =>
      fetch(`${baseUrl}/session/import`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(json),
      }),

    exportSession: () =>
      fetch(`${baseUrl}/session/export`, { headers: baseHeaders })
        .then(r => r.json()),
  }
}
```

---

## Idle reaper (background job)

```typescript
setInterval(async () => {
  const stale = await db.getSessionsIdleSince(5 * 60 * 1000) // 5 min

  for (const session of stale) {
    try {
      const json = await opencodeClient(session.sandboxName).exportSession()
      await db.hibernateSession(session.id, json)
      await k8s.deleteSandbox(session.sandboxName, "opencode")
    } catch (err) {
      console.error(`Failed to hibernate ${session.id}:`, err)
    }
  }
}, 60_000)
```

---

## Where does `sandboxName` come from?

```
sandboxName = "oc-" + sessionId
```

- `sessionId` is a UUID the browser generates on first load and stores in
  `localStorage`.
- The backend uses it to name the K8s Sandbox CR.
- The Sandbox controller creates a headless Service with the same name.
- That Service name is what goes in `X-Sandbox-ID` — it's the DNS hostname
  the router uses to reach the pod.

The mapping is deterministic — you never need to look it up separately.

---

## Open questions / future work

| Topic | Note |
|---|---|
| **Pod boot latency** | ~30s cold, ~5s warm (cached image). Show a spinner + status ("Starting your environment…") |
| **PVC reuse on resume** | Deleting the PVC on hibernate saves cost but loses the working directory. Keep PVC if storage is cheap; speeds up resume significantly |
| **Auth** | Add user authentication before this goes anywhere near production |
| **Snapshot support** | Once agent-sandbox snapshot/restore lands, replace JSON export/import with native snapshot — faster resume, no opencode API dependency |
| **Multi-repo** | Inject `REPO_URL` env var at sandbox creation time so each session clones the right repo |
| **Tool approval** | Stream tool calls to browser before execution; gate destructive ones on user click |
