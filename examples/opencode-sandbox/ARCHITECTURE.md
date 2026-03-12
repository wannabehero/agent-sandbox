# opencode Sandbox Platform -- Architecture

A platform for running AI coding agents inside isolated Kubernetes sandbox pods.
Users (or systems) submit prompts, an opencode agent runs them inside a sandboxed
environment with full tool access (bash, file I/O, LSP, git), and streams
structured responses back. Conversation state persists across turns and can be
hibernated/resumed across pod lifetimes.

This document is the single source of truth for how the system works, what the
PoC covers, and what gaps remain for production deployment.

---

## Table of contents

1. [System overview](#system-overview)
2. [Core concepts](#core-concepts)
3. [Kubernetes resource model](#kubernetes-resource-model)
4. [opencode server API](#opencode-server-api)
5. [Data flow -- request lifecycle](#data-flow----request-lifecycle)
6. [Session lifecycle and state machine](#session-lifecycle-and-state-machine)
7. [Pre-warming and pool mechanics](#pre-warming-and-pool-mechanics)
8. [Sandbox routing](#sandbox-routing)
9. [LLM provider configuration](#llm-provider-configuration)
10. [Multi-entrypoint architecture](#multi-entrypoint-architecture)
11. [Session persistence and hibernation](#session-persistence-and-hibernation)
12. [Security model](#security-model)
13. [Observability](#observability)
14. [PoC scope and production gaps](#poc-scope-and-production-gaps)
15. [Latency budget](#latency-budget)
16. [Capacity planning](#capacity-planning)

---

## System overview

```
Entrypoints                     Control Plane                    Data Plane
-----------                     -------------                    ----------

Browser (Web UI)  ─┐
Slack bot         ─┤
GitHub webhook    ─┼──▶  Backend Service  ──kubectl──▶  K8s API Server
Jira webhook      ─┤        │                              │
CLI / API client  ─┘        │                              ▼
                            │                     agent-sandbox controller
                            │                        ├─ SandboxClaim controller
                            │                        ├─ SandboxWarmPool controller
                            │                        └─ Sandbox controller
                            │
                            │  HTTP (via sandbox-router)
                            │    headers: X-Sandbox-ID, X-Sandbox-Namespace, X-Sandbox-Port
                            ▼
                     sandbox-router  ──DNS──▶  sandbox pod (opencode serve :4096)
                                                  │
                                                  ├─ tool calls: bash, read, write,
                                                  │  edit, grep, glob, lsp, git ...
                                                  └─ LLM API call (provider configured
                                                     via OPENCODE_CONFIG_CONTENT)
```

**Key principle**: the backend never talks to LLMs directly. It creates a
sandbox, sends the user's text to opencode running inside it, and pipes the
response stream back to the caller. opencode owns the agentic loop -- tool
selection, multi-step reasoning, file edits, and all LLM calls.

---

## Core concepts

### Sandbox

A **Sandbox** is a single-replica, stateful, isolated pod managed by the
agent-sandbox controller. It behaves like a lightweight single-container VM:
one pod, one headless Service, deterministic DNS name. The Sandbox CR owns the
pod and Service; deleting the CR cascades to both.

Sandboxes are not created directly in normal operation. They are created by
the claim controller when a SandboxClaim is fulfilled.

### SandboxTemplate

A **SandboxTemplate** is a reusable blueprint for sandbox pods. It defines the
container image, ports, environment variables, probes, volumes, and optional
NetworkPolicy. Templates are deployed once per environment and shared across
all sessions.

### SandboxWarmPool

A **SandboxWarmPool** maintains N pre-booted pods matching a SandboxTemplate.
Each pod is fully initialized (image pulled, process started, readiness probe
passing) and waiting to be claimed. The pool controller continuously reconciles
to keep the pool at the desired replica count.

### SandboxClaim

A **SandboxClaim** is a per-session request for a sandbox. When created, the
claim controller:

1. Finds a Ready pod in the matching warm pool (by template hash)
2. Adopts it: strips pool labels, sets ownership to a new Sandbox CR
3. Creates a headless Service with the claim's name
4. Marks the claim Ready

If no warm pod is available, a cold pod is created from the template (slower).

The pool controller immediately starts a replacement pod to refill the pool.

### Session

A **session** is the application-level concept that ties together:
- A user/system identity (who initiated the work)
- A SandboxClaim (the K8s resource)
- An opencode session ID (the conversation state inside the pod)
- Optionally, a persisted session blob for hibernation/resume

The backend owns the session-to-claim mapping. The claim name is derived
deterministically from the session ID: `claimName = "oc-" + sessionId`.

### sandbox-router

A lightweight HTTP reverse proxy deployed as a K8s Deployment. It reads
routing headers from each request and forwards to the correct pod via K8s
DNS:

```
X-Sandbox-ID: oc-abc123          →  oc-abc123.opencode.svc.cluster.local
X-Sandbox-Namespace: opencode
X-Sandbox-Port: 4096             →  :4096
```

The router is stateless. It does not maintain connections or session affinity.

---

## Kubernetes resource model

### Cluster-scoped (deploy once)

```yaml
# CRDs (from agent-sandbox release)
#   - sandboxes.agents.x-k8s.io
#   - sandboxtemplates.extensions.agents.x-k8s.io
#   - sandboxclaims.extensions.agents.x-k8s.io
#   - sandboxwarmpools.extensions.agents.x-k8s.io

# Controller (StatefulSet in agent-sandbox-system namespace)
#   - agent-sandbox-controller (runs with --extensions flag)
```

### Namespace-scoped (deploy once per environment)

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: opencode
---
apiVersion: v1
kind: Secret
metadata:
  name: llm-keys
  namespace: opencode
stringData:
  zen: "sk-..."    # opencode Zen API key (or anthropic, openai, etc.)
---
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxTemplate
metadata:
  name: opencode-template
  namespace: opencode
spec:
  podTemplate:
    spec:
      containers:
        - name: sandbox
          image: poc-sandbox:latest
          ports:
            - containerPort: 4096
          env:
            - name: ZEN_API_KEY
              valueFrom:
                secretKeyRef:
                  name: llm-keys
                  key: zen
            - name: OPENCODE_CONFIG_CONTENT
              value: |
                {"model":"opencode/kimi-k2.5","provider":{"opencode":{"options":{"apiKey":"{env:ZEN_API_KEY}"}}}}
          readinessProbe:
            httpGet:
              path: /doc
              port: 4096
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 12
---
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxWarmPool
metadata:
  name: opencode-pool
  namespace: opencode
spec:
  replicas: 3
  sandboxTemplateRef:
    name: opencode-template
```

### Per-session (created/deleted by backend)

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxClaim
metadata:
  name: oc-{sessionId}
  namespace: opencode
spec:
  sandboxTemplateRef:
    name: opencode-template
  lifecycle:
    shutdownTime: "2024-12-01T00:00:00Z"   # optional hard expiry
    shutdownPolicy: Delete                   # Delete or Retain
```

---

## opencode server API

opencode runs inside each sandbox pod as `opencode serve --hostname 0.0.0.0 --port 4096`.
It exposes an HTTP API. The backend communicates with it exclusively through the
sandbox-router.

### Key endpoints used by the platform

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/doc` | OpenAPI spec (used as readiness probe) |
| `GET` | `/provider` | List available LLM providers and models |
| `POST` | `/session` | Create a new opencode session |
| `GET` | `/session` | List all sessions |
| `GET` | `/session/{id}` | Get session details (messages, metadata) |
| `DELETE` | `/session/{id}` | Delete a session |
| `POST` | `/session/{id}/message` | Send a message (returns JSON, fires SSE events) |
| `POST` | `/session/{id}/abort` | Abort an in-progress response |
| `POST` | `/session/{id}/fork` | Fork a session (branch conversation) |
| `GET` | `/global/event` | SSE stream of all events across all sessions |
| `GET` | `/event` | SSE stream scoped to a workspace/directory |

### SSE event model

The backend subscribes to `GET /global/event` to receive real-time events.
Events are JSON objects wrapped in SSE `data:` lines.

**Event envelope:**
```json
{
  "directory": "/workspace",
  "payload": {
    "type": "<event-type>",
    "properties": { ... }
  }
}
```

**Event types relevant to streaming:**

| Event type | Properties | Use |
|------------|------------|-----|
| `message.part.delta` | `sessionID`, `messageID`, `partID`, `field`, `delta` | Incremental text token (when `field === "text"`) |
| `message.part.updated` | `part` (full part object with `type`, `text`, `time`) | Part finalized |
| `session.status` | `sessionID`, `status.type` (`"busy"` or `"idle"`) | Session activity state |
| `session.idle` | `sessionID` | Response complete, safe to close stream |
| `message.updated` | `info` (message metadata: model, tokens, cost) | Message finalized with usage stats |

**Streaming pattern:**
1. Backend opens `GET /global/event` SSE connection
2. Backend posts `POST /session/{id}/message` with the user's text
3. Backend filters SSE events by `sessionID`
4. `message.part.delta` events with `field === "text"` carry the streamed tokens
5. `session.idle` signals the response is complete

### Message format

```json
// POST /session/{id}/message
{
  "parts": [{ "type": "text", "text": "user's prompt here" }],
  "providerID": "opencode",
  "modelID": "kimi-k2.5"
}
```

### Session creation

```json
// POST /session
{
  "providerID": "opencode",
  "modelID": "kimi-k2.5"
}

// Response
{
  "id": "ses_32dd25309ffeDZ1Q66dR5Zp51C",
  "slug": "brave-orchid",
  "directory": "/workspace",
  ...
}
```

---

## Data flow -- request lifecycle

### New session (warm pool available)

```mermaid
sequenceDiagram
    participant C as Client
    participant B as Backend
    participant K as K8s API
    participant Ctrl as Claim Controller
    participant R as sandbox-router
    participant OC as opencode (pod)

    C->>B: POST /session
    B->>K: kubectl apply SandboxClaim
    K->>Ctrl: reconcile
    Ctrl->>Ctrl: find Ready pod in pool (by template hash)
    Ctrl->>K: adopt pod, create Sandbox CR + Service
    Ctrl->>K: mark SandboxClaim Ready
    B->>K: poll .status.conditions[Ready]
    K-->>B: Ready=True (< 1s)
    B->>R: POST /session {providerID, modelID}
    R->>OC: POST /session
    OC-->>R: {id: "ses_..."}
    R-->>B: {id: "ses_..."}
    B-->>C: {id: "oc-abc123"}
```

### Send message (streaming)

```mermaid
sequenceDiagram
    participant C as Client
    participant B as Backend
    participant R as sandbox-router
    participant OC as opencode (pod)
    participant LLM as LLM API

    C->>B: POST /session/:id/message {text}
    B->>R: GET /global/event (SSE)
    R->>OC: GET /global/event (SSE)
    OC-->>R: data: {server.connected}
    B->>R: POST /session/:ocId/message
    R->>OC: POST /session/:ocId/message

    loop Agentic loop
        OC->>LLM: inference request
        LLM-->>OC: tokens
        OC-->>R: SSE: message.part.delta {delta}
        R-->>B: SSE: message.part.delta {delta}
        B-->>C: SSE: data: {"delta":"..."}
        opt Tool call needed
            OC->>OC: execute tool (bash, read, write, etc.)
        end
    end

    OC-->>R: SSE: session.idle
    R-->>B: SSE: session.idle
    B-->>C: SSE: data: [DONE]
    B->>B: destroy SSE connection
```

### Follow-up message

Same as "Send message" -- the sandbox pod is already running, the opencode
session maintains full conversation history in-memory. No K8s calls needed.

### Close session

```mermaid
sequenceDiagram
    participant C as Client
    participant B as Backend
    participant K as K8s API
    participant Ctrl as Sandbox Controller
    participant Pool as WarmPool Controller

    C->>B: DELETE /session/:id
    B->>K: kubectl delete SandboxClaim
    K->>Ctrl: reconcile
    Ctrl->>K: delete Sandbox CR (cascade: Pod + Service)
    K->>Pool: pool below desired replicas
    Pool->>K: create replacement pod
    B-->>C: 204 No Content
```

---

## Session lifecycle and state machine

```mermaid
stateDiagram-v2
    [*] --> Active : POST /session
    Active --> Active : follow-up message
    Active --> Hibernated : idle timeout (export session blob)
    Active --> Closed : DELETE /session
    Active --> Expired : shutdownTime reached
    Hibernated --> Active : resume (new pod + import blob)
    Hibernated --> Closed : DELETE /session
    Closed --> [*]
    Expired --> [*]
```

**States:**

| State | Pod exists | Session in DB | Description |
|-------|-----------|---------------|-------------|
| Active | Yes | Yes (status=active) | Pod running, conversation in opencode memory |
| Hibernated | No | Yes (status=hibernated, blob saved) | Pod deleted, conversation exportable/importable |
| Closed | No | Optional | User explicitly ended session |
| Expired | No | Optional | shutdownTime reached, auto-cleaned |

---

## Pre-warming and pool mechanics

The warm pool eliminates cold-start latency (30-90s) for new sessions.

### How adoption works

```
Before claim:
  SandboxWarmPool (replicas: 3)
    ├── pod-abc  [Ready]   ← template hash: 4f154e95
    ├── pod-def  [Ready]   ← template hash: 4f154e95
    └── pod-ghi  [Starting]

SandboxClaim "oc-user1" created, referencing opencode-template:

  1. Claim controller finds pod-abc (Ready, matching template hash)
  2. Removes pool label from pod-abc
  3. Creates Sandbox CR "oc-user1" owning pod-abc
  4. Creates headless Service "oc-user1"
  5. Marks SandboxClaim Ready

After claim:
  SandboxWarmPool (replicas: 3)
    ├── pod-def  [Ready]
    ├── pod-ghi  [Ready]        ← now ready
    └── pod-jkl  [Starting]    ← replacement, auto-created by pool controller

  Sandbox "oc-user1"
    └── pod-abc  [Running]     ← adopted, no longer in pool
```

**Claim resolution time: < 1 second** (label swap + Service creation).

### Pool sizing

`replicas` should be >= peak concurrent new-session arrival rate. If the pool
empties, new claims fall back to cold starts.

### Template updates

Changing a SandboxTemplate does NOT automatically rotate existing warm pool
pods. To roll out a new image or config:

1. Update the SandboxTemplate
2. Delete existing warm pool pods (`kubectl delete pods -n opencode -l agents.x-k8s.io/pool`)
3. Pool controller recreates pods from the new template

Active (adopted) sandboxes are unaffected -- they keep running on their original spec.

---

## Sandbox routing

The sandbox-router is a stateless HTTP reverse proxy (Python/FastAPI/uvicorn)
that translates routing headers into K8s DNS lookups.

### Request transformation

```
Incoming:
  POST http://sandbox-router-svc:8080/session/ses_abc/message
  X-Sandbox-ID:        oc-user1
  X-Sandbox-Namespace: opencode
  X-Sandbox-Port:      4096

Router resolves:
  POST http://oc-user1.opencode.svc.cluster.local:4096/session/ses_abc/message
```

### Why a router instead of direct pod access

- **Abstraction**: callers don't need to know pod IPs or Service FQDNs
- **Port-forward friendly**: local development only needs one port-forward
- **Extensibility**: can add auth, rate limiting, request logging at the router
- **SSE support**: the router streams responses (including SSE) transparently

### Production considerations

- Deploy multiple router replicas behind a K8s Service for HA
- The router uses `httpx.AsyncClient` with 180s timeout for long-running LLM responses
- Consider replacing with an Envoy/nginx sidecar or gateway for production traffic

---

## LLM provider configuration

opencode supports 75+ LLM providers. The provider and model are configured via
`OPENCODE_CONFIG_CONTENT` environment variable in the SandboxTemplate.

### opencode Zen (managed gateway)

```json
{
  "model": "opencode/kimi-k2.5",
  "provider": {
    "opencode": {
      "options": {
        "apiKey": "{env:ZEN_API_KEY}"
      }
    }
  }
}
```

The `{env:ZEN_API_KEY}` syntax tells opencode to read the value from the
environment variable, which is injected via K8s Secret.

### Direct provider (e.g. Anthropic)

```json
{
  "model": "anthropic/claude-sonnet-4-6",
  "provider": {
    "anthropic": {
      "options": {
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

### Model override per message

The backend can override the model per message by specifying `providerID` and
`modelID` in the POST body. This allows the same sandbox to use different models
for different tasks (e.g. cheap model for simple tasks, expensive model for
complex reasoning).

---

## Multi-entrypoint architecture

The PoC uses a browser as the sole entrypoint. In production, multiple systems
should be able to trigger sandbox sessions through the same backend.

### Entrypoint architecture

```mermaid
flowchart LR
    subgraph Entrypoints
        WEB[Web UI]
        SLACK[Slack Bot]
        GH[GitHub Webhook]
        JIRA[Jira Webhook]
        API[REST API]
    end

    subgraph Backend
        INGEST[Ingestion Layer]
        SM[Session Manager]
        PROXY[Sandbox Proxy]
    end

    subgraph K8s
        CLAIM[SandboxClaim]
        POOL[WarmPool]
        POD[Sandbox Pod]
        ROUTER[sandbox-router]
    end

    subgraph Storage
        DB[(Session Store)]
        S3[(Blob Storage)]
    end

    WEB -->|WorkRequest| INGEST
    SLACK -->|WorkRequest| INGEST
    GH -->|WorkRequest| INGEST
    JIRA -->|WorkRequest| INGEST
    API -->|WorkRequest| INGEST

    INGEST --> SM
    SM -->|create/resume| CLAIM
    CLAIM -->|adopt| POOL
    POOL -->|provision| POD
    SM --> PROXY
    PROXY --> ROUTER
    ROUTER --> POD

    SM <-->|persist/load| DB
    SM <-->|session blobs| S3

    POD -->|SSE events| ROUTER
    ROUTER -->|SSE events| PROXY
    PROXY -->|ResponseSink| INGEST
    INGEST -->|response| WEB
    INGEST -->|response| SLACK
    INGEST -->|response| GH
```

### Entrypoint abstraction

Every entrypoint produces a **work request**:

```typescript
interface WorkRequest {
  source: "web" | "slack" | "github" | "jira" | "api"
  sourceId: string          // e.g. Slack thread ID, GitHub issue number
  sessionId?: string        // resume existing session, or omit for new
  text: string              // the prompt / task description
  context?: {               // optional metadata injected into the prompt
    repo?: string
    branch?: string
    files?: string[]
    prNumber?: number
  }
  callback: ResponseSink    // where to send streaming output
}
```

### Entrypoint implementations

**Web UI (PoC)**
- User types prompt in browser
- Backend creates session, streams SSE back to browser
- Session persists in localStorage (client) and in-memory Map (server)

**Slack bot**
- Slack Events API delivers message to backend webhook
- Backend creates/resumes session keyed by `{channel}:{thread_ts}`
- Response chunks are posted back to Slack thread via `chat.postMessage`
- Tool calls and file diffs can be posted as threaded messages

**GitHub webhook**
- GitHub sends `issues.opened`, `issue_comment.created`, or `pull_request` events
- Backend creates session keyed by `{repo}:{issue_number}`
- opencode clones the repo inside the sandbox, works on the issue
- Response is posted as a GitHub comment; file changes as a PR

**Jira webhook**
- Jira sends issue creation/update events
- Backend creates session keyed by `{project}:{issue_key}`
- Response posted back as Jira comment

**Direct API**
- REST endpoint for programmatic access
- Returns session ID for subsequent polling or SSE streaming

### Response sink interface

Each entrypoint provides a callback that handles streaming output:

```typescript
interface ResponseSink {
  onDelta(text: string): void       // incremental token
  onToolCall(tool: string, args: any): void  // tool invocation (for UI display)
  onDone(summary: MessageSummary): void      // response complete
  onError(error: Error): void
}
```

For Slack/GitHub, `onDelta` buffers text and flushes periodically (e.g. every
2 seconds or 500 chars) to avoid API rate limits.

---

## Session persistence and hibernation

### Problem

opencode stores conversation state in an in-process SQLite database inside the
sandbox pod. When the pod is deleted (idle timeout, scale-down, node drain),
the conversation is lost.

### Solution: export/import cycle

opencode exposes session data via its HTTP API:

| Operation | API | Data |
|-----------|-----|------|
| **Export** (read state) | `GET /session/{id}` | Returns full session: messages, parts, metadata, tool results |
| **List messages** | `GET /session/{id}/message` | All messages with content |
| **Create session** | `POST /session` | Creates empty session in new pod |
| **Fork session** | `POST /session/{id}/fork` | Creates a copy of an existing session |

### Hibernation flow

```mermaid
sequenceDiagram
    participant Cron as Idle Timer
    participant B as Backend
    participant R as sandbox-router
    participant OC as opencode (pod)
    participant DB as Session Store
    participant K as K8s API

    Cron->>B: check sessions idle > 5 min
    B->>R: GET /session/{ocSessionId}
    R->>OC: GET /session/{ocSessionId}
    OC-->>B: full session JSON (messages, parts, metadata)
    B->>DB: store session blob, status=hibernated
    B->>K: kubectl delete SandboxClaim
    K->>K: cascade delete: Pod + Service removed
    Note over K: WarmPool controller refills pool
```

### Resume flow

```mermaid
sequenceDiagram
    participant C as Client
    participant B as Backend
    participant DB as Session Store
    participant K as K8s API
    participant R as sandbox-router
    participant OC as opencode (new pod)

    C->>B: POST /session/:id/message (hibernated session)
    B->>DB: load session blob
    B->>K: kubectl apply SandboxClaim
    K-->>B: Ready (warm pool adoption < 1s)
    B->>R: POST /session
    R->>OC: POST /session
    OC-->>B: new opencode session ID
    B->>R: replay context from blob
    R->>OC: inject conversation history
    B->>R: POST /session/:ocId/message (user's new message)
    B-->>C: SSE stream
    B->>DB: status=active
```

### Session store schema

```sql
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,       -- application session ID
  claim_name      TEXT NOT NULL,          -- "oc-{id}", K8s claim name
  oc_session_id   TEXT,                   -- opencode session ID inside pod
  source          TEXT NOT NULL,          -- "web" | "slack" | "github" | ...
  source_id       TEXT,                   -- external reference (thread, issue, etc.)
  user_id         TEXT,                   -- authenticated user
  status          TEXT NOT NULL,          -- "active" | "hibernated" | "closed" | "error"
  session_blob    JSONB,                  -- exported opencode session (null while active)
  model           TEXT,                   -- provider/model used
  total_cost      NUMERIC DEFAULT 0,      -- accumulated LLM cost
  total_tokens    JSONB,                  -- accumulated token counts
  created_at      TIMESTAMPTZ NOT NULL,
  last_activity   TIMESTAMPTZ NOT NULL,
  hibernated_at   TIMESTAMPTZ
);

CREATE INDEX idx_sessions_status ON sessions (status);
CREATE INDEX idx_sessions_source ON sessions (source, source_id);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_activity ON sessions (last_activity) WHERE status = 'active';
```

### What is NOT persisted

- **Filesystem state**: files created/modified by opencode inside `/workspace`
  are lost when the pod is deleted. For persistence, use a PVC that outlives
  the claim, or push changes to a git remote before hibernation.
- **opencode internal caches**: LSP indexes, file watchers, etc. These are
  rebuilt on resume (adds a few seconds).

---

## Security model

### Current state (PoC)

The PoC has **no authentication or authorization**. Anyone with network access
to the backend can create sessions and run arbitrary code inside sandbox pods.

### Production requirements

| Layer | Requirement | Implementation |
|-------|-------------|----------------|
| **Entrypoint auth** | Verify caller identity | OAuth2/OIDC at backend, Slack signature verification, GitHub webhook secret |
| **Session isolation** | User A cannot access User B's sandbox | Backend enforces session-to-user mapping; sandbox-router validates via backend |
| **Network isolation** | Sandbox pods cannot reach internal services | NetworkPolicy on SandboxTemplate (default deny, allow only LLM API egress) |
| **Runtime isolation** | Sandbox code cannot escape to host | gVisor (runsc) RuntimeClass on all sandbox pods |
| **Secret management** | LLM keys not exposed to users | K8s Secrets mounted as env vars; never exposed via opencode API |
| **Resource limits** | Prevent resource exhaustion | CPU/memory limits on pod spec; `shutdownTime` for hard expiry |
| **Audit logging** | Track who did what | Backend logs all session/message events with user ID and timestamp |

### gVisor integration

The SandboxTemplate can specify `runtimeClassName: gvisor` in the pod spec to
run all sandbox containers under gVisor's sandboxed kernel. This prevents
container escapes and restricts syscall surface.

```yaml
spec:
  podTemplate:
    spec:
      runtimeClassName: gvisor
      containers:
        - name: sandbox
          ...
```

---

## Observability

### Metrics to expose

| Metric | Type | Description |
|--------|------|-------------|
| `sandbox_sessions_active` | Gauge | Currently active sessions |
| `sandbox_warmpool_ready` | Gauge | Ready pods in warm pool |
| `sandbox_warmpool_total` | Gauge | Total pods in warm pool |
| `sandbox_claim_duration_seconds` | Histogram | Time from claim creation to Ready |
| `sandbox_message_duration_seconds` | Histogram | Time from message sent to session.idle |
| `sandbox_llm_cost_total` | Counter | Accumulated LLM cost (from opencode usage stats) |
| `sandbox_llm_tokens_total` | Counter | Accumulated tokens by type (input/output/cache) |
| `sandbox_errors_total` | Counter | Errors by type (claim_timeout, llm_error, pod_crash) |

### Logging

The backend should emit structured JSON logs with:
- `sessionId`, `claimName`, `userId`, `source` on every log line
- Message send/receive events with timing
- Claim lifecycle events (create, ready, delete)
- Error details with opencode pod logs on failure

### Tracing

The agent-sandbox controller supports OpenTelemetry tracing (added in v0.1.1).
The backend should propagate trace context through the sandbox-router to
opencode for end-to-end request tracing.

---

## PoC scope and production gaps

### Screenshots

| Web UI | Sandbox filesystem |
|--------|--------------------|
| ![Web UI](poc/web.png) | ![Sandbox shell](poc/shell.png) |

The web screenshot shows a multi-turn conversation with streaming responses and
tool use. The shell screenshot shows the sandbox pod filesystem after the agent
ran — `jokes.md` was created by opencode using the bash tool, confirming full
tool execution works inside the sandbox.

### What the PoC covers

| Capability | Status | Implementation |
|-----------|--------|----------------|
| Sandbox lifecycle (create/adopt/delete) | Working | SandboxClaim + WarmPool via agent-sandbox controller |
| Warm pool pre-booting | Working | SandboxWarmPool with configurable replicas |
| opencode session creation | Working | POST /session via sandbox-router |
| Streaming response (SSE) | Working | GET /global/event filtered by sessionID, delta forwarding |
| Follow-up messages (multi-turn) | Working | opencode maintains conversation in-memory |
| Web UI | Working | Minimal HTML/JS, SSE streaming, session management |
| LLM provider config | Working | OPENCODE_CONFIG_CONTENT with opencode Zen |
| gVisor runtime isolation | Working | RuntimeClass configured on cluster |

### Production gaps

| Gap | Priority | Description | Suggested approach |
|-----|----------|-------------|-------------------|
| **Authentication** | P0 | No user auth on any endpoint | Add OAuth2/OIDC middleware to backend; verify Slack/GitHub webhook signatures |
| **Session authorization** | P0 | Any client can access any session | Backend enforces user-to-session ownership; reject cross-user access |
| **Session persistence** | P0 | Sessions lost on pod delete | Export via `GET /session/{id}`, store in Postgres/S3, import on resume |
| **Backend as K8s Deployment** | P1 | Backend runs locally with kubectl | Deploy as Deployment with in-cluster ServiceAccount + RBAC; use K8s client library |
| **Slack entrypoint** | P1 | Only web UI exists | Slack Events API webhook handler; map thread to session |
| **GitHub entrypoint** | P1 | Only web UI exists | GitHub webhook handler; clone repo in sandbox; post results as comments/PRs |
| **Workspace persistence** | P1 | `/workspace` lost on pod delete | Attach PVC to SandboxTemplate; or git push before hibernation |
| **Cost tracking** | P1 | No cost visibility | Extract `cost` and `tokens` from `message.updated` events; aggregate per user/session |
| **Idle timeout** | P2 | Sessions never auto-hibernate | Background job polls `last_activity`; exports + deletes idle sessions |
| **Pool auto-scaling** | P2 | Fixed replica count | HPA or custom controller based on claim queue depth |
| **Rate limiting** | P2 | No limits on session creation or messages | Token bucket per user at backend level |
| **Tool approval** | P2 | opencode auto-executes all tools | Stream `message.part.updated` events with `type: "tool-call"` to client; gate on user approval before execution |
| **Multi-cluster** | P3 | Single cluster only | Federation or cluster-per-region with global session store |
| **Snapshot/restore** | P3 | Full pod snapshot for instant resume | Pending agent-sandbox feature; would replace JSON export/import |

---

## Per-session workspace initialisation

This section captures design decisions around injecting per-session context
(repository, branch, credentials) into a sandbox pod before the first opencode
message is sent.

### Why SandboxClaim cannot carry parameters today

`SandboxClaimSpec` currently has two fields: `sandboxTemplateRef` and
`lifecycle`. There is no mechanism to pass per-session values such as a git
repository URL, a branch name, or a user token.

More importantly, even if the API were extended with a `parameters` map, it
would only affect **cold-start** pods. Warm pool pods are already running when
a claim adopts them; their environment is frozen at container start and cannot
be changed without a restart.

### Preferred approach: `kubectl exec` after adoption, before session creation

After the SandboxClaim reaches `Ready` the adopted pod is running and
opencode is already serving on port 4096. At this point the backend can
`kubectl exec` arbitrary commands into the container to set up the workspace
before creating the opencode session.

The sequence in `backend/server.js`:

```
POST /session
  1. applyYaml(claimYaml(claim))
  2. waitReady(claim)           ← warm adoption < 1 s
  3. getPodName(claim)          ← reads agents.x-k8s.io/pod-name annotation
  4. kubectl exec … git clone   ← workspace init
  5. createOcSession(claim)     ← opencode session created on clean workspace
  6. return { id: claim }
```

The pod name is available from the `agents.x-k8s.io/pod-name` annotation on
the Sandbox object (written by the claim controller at adoption time,
`extensions/controllers/sandboxclaim_controller.go`). For cold-start pods the
annotation is absent; fall back to using the sandbox name directly as the pod
name.

```js
function getPodName(claimName) {
  return kubectl(
    'get', 'sandbox', claimName, '-n', NAMESPACE,
    `-o=jsonpath={.metadata.annotations.agents\\.x-k8s\\.io/pod-name}`
  ).trim() || claimName   // cold-start fallback
}
```

### Cloning a repository

```js
if (body.gitRepo) {
  const podName = getPodName(claim)
  execInPod(podName, 'git', 'clone', body.gitRepo, '/workspace/repo')
  if (body.gitBranch) {
    execInPod(podName, 'git', '-C', '/workspace/repo', 'checkout', body.gitBranch)
  }
}
```

**Sandbox image requirement**: `node:22-slim` does not ship `git`. Add it:

```dockerfile
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
```

### Injecting a per-user GitHub token

Each user brings their own `ghToken` (resolved server-side from the user's
authenticated session — never taken directly from the browser request).

```js
function injectGhToken(podName, token) {
  // Pipe via stdin to avoid shell interpolation of the token value.
  const r = spawnSync('kubectl', [
    'exec', podName, '-n', NAMESPACE, '--',
    'bash', '-c', 'gh auth login --with-token',
  ], { input: token, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
}
```

Git https clones also need credentials:

```js
execInPod(podName, 'git', 'config', '--global', 'credential.helper', 'store')
// Write credentials file — token passed via spawnSync input, not shell interpolation
spawnSync('kubectl', [
  'exec', podName, '-n', NAMESPACE, '--',
  'bash', '-c', 'cat >> ~/.git-credentials',
], { input: `https://x-access-token:${token}@github.com\n`, encoding: 'utf8' })
```

**Security properties of this approach**

| Property | Detail |
|----------|--------|
| Token scope | Lives only in the adopted pod; deleted with the pod when the claim is removed |
| No warm pool contamination | Warm pods never hold any user token; injection happens post-adoption |
| No CRD changes required | Plain `kubectl exec`; no new API surface |
| Shell injection prevention | Pass the token via `spawnSync`'s `input` (stdin), never interpolated into a shell string |
| Backend ownership | Token travels backend → pod only; the browser never sends a raw token to the backend |

**Sandbox image requirement**: `gh` CLI must be installed. Add to the Dockerfile:

```dockerfile
RUN apt-get update && apt-get install -y git curl && \
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] \
      https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y gh && \
    rm -rf /var/lib/apt/lists/*
```

### Alternatives considered and rejected

| Alternative | Why rejected |
|-------------|--------------|
| `env` field in `SandboxClaimSpec` | Only works for cold-start pods; warm pods ignore it without a restart |
| Per-claim ConfigMap mounted as `envFrom` | Same limitation: env vars are read at container start, not after adoption |
| Baking repo/branch into `SandboxTemplate` | Requires one template per repo; defeats the purpose of a shared warm pool |
| Sending token as first opencode message | Token appears in conversation history; harder to audit and revoke |

---

## Latency budget

| Scenario | Latency | Breakdown |
|----------|---------|-----------|
| Active session, follow-up | **~0ms** (network only) | Pod running, no K8s calls |
| New session, warm pool available | **< 1s** | Claim adoption (~200ms) + opencode session creation (~500ms) |
| New session, warm pool empty | **30-90s** | Image pull + container start + opencode init + readiness probe |
| Hibernated session resume | **< 2s** | Warm adoption + session create + context replay |
| First token (after message sent) | **1-5s** | LLM inference latency (model dependent) |

---

## Capacity planning

### Per-pod resource consumption

| Resource | Idle pod | Active pod (during LLM call) |
|----------|----------|------------------------------|
| CPU | ~10m | ~100m (opencode + tools) |
| Memory | ~150Mi | ~300Mi (opencode + LSP + file buffers) |
| Disk | ~200Mi (opencode + node_modules) | +varies (workspace files) |

### Sizing formula

```
warm_pool_replicas = ceil(peak_new_sessions_per_minute * avg_claim_time_minutes)
total_pods = warm_pool_replicas + active_sessions
node_count = ceil(total_pods * pod_memory / node_allocatable_memory)
```

### Example: 100 concurrent users

```
Active sessions:     100
Warm pool:           10  (handles burst of 10 new sessions/min)
Total pods:          110
Memory per pod:      300Mi
Total memory:        33Gi
Nodes (8Gi each):    5
```
