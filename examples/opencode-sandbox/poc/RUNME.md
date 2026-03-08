# opencode PoC — step by step

One-page coding agent: browser → Node.js backend → sandbox-router → sandbox pod
running a Python/Anthropic server. Warm pool keeps pods pre-booted.

```
browser (index.html)
  POST /session            → backend creates SandboxClaim → warm pod adopted
  POST /session/:id/message → backend proxies SSE through sandbox-router → pod
  DELETE /session/:id      → backend deletes SandboxClaim
```

---

## Prerequisites

| Tool | Purpose |
|------|---------|
| `docker` | build images |
| `kind` | local K8s cluster |
| `kubectl` | apply manifests, poll status |
| `go` 1.21+ | build the operator |
| `node` 18+ | run the backend locally |

---

## Step 1 — Deploy the operator to a fresh kind cluster

From the **repo root**:

```bash
make EXTENSIONS=true deploy-kind
```

This will:
- Create a kind cluster named `agent-sandbox`
- Build and load the controller image
- Apply all CRDs and RBAC
- Start the controller with extensions enabled

Set the kubeconfig for subsequent commands:

```bash
export KUBECONFIG=$(pwd)/bin/KUBECONFIG
kubectl get nodes   # should show 1 node Ready
```

> If you want to use your own existing kind cluster instead, skip `make deploy-kind`
> and run the two scripts it calls directly, pointing at your cluster:
> ```bash
> ./dev/tools/push-images --image-prefix=kind.local/ --kind-cluster-name=<your-cluster>
> ./dev/tools/deploy-to-kube --image-prefix=kind.local/
> # then patch the controller to enable extensions:
> kubectl patch deployment agent-sandbox-controller -n agent-sandbox-system \
>   -p '{"spec":{"template":{"spec":{"containers":[{"name":"agent-sandbox-controller","args":["--extensions=true"]}]}}}}'
> ```

---

## Step 2 — Build and load the sandbox-router image

```bash
cd clients/python/agentic-sandbox-client/sandbox-router

docker build -t poc-sandbox-router:latest .

kind load docker-image poc-sandbox-router:latest --name agent-sandbox

cd -   # back to repo root
```

---

## Step 3 — Build and load the sandbox pod image

```bash
cd examples/opencode-sandbox/poc/sandbox

docker build -t poc-sandbox:latest .

kind load docker-image poc-sandbox:latest --name agent-sandbox

cd -
```

---

## Step 4 — Apply all manifests

```bash
# Namespace for all sandbox resources
kubectl apply -f examples/opencode-sandbox/poc/manifests/namespace.yaml

# Sandbox-router (runs in default namespace)
kubectl apply -f examples/opencode-sandbox/poc/manifests/sandbox-router.yaml

# Wait for router to be ready
kubectl rollout status deployment/sandbox-router -n default

# Store your Anthropic API key
kubectl create secret generic llm-keys \
  -n opencode \
  --from-literal=anthropic=sk-ant-YOUR_KEY_HERE

# SandboxTemplate and WarmPool
kubectl apply -f examples/opencode-sandbox/poc/manifests/sandbox-template.yaml
kubectl apply -f examples/opencode-sandbox/poc/manifests/warmpool.yaml
```

Check that the warm pool is filling up (may take 30–60s on first pull):

```bash
kubectl get sandboxwarmpool -n opencode -w
# NAME            REPLICAS   READY
# opencode-pool   2          2      ← wait for Ready=2
```

Once Ready > 0, new sessions will be claimed instantly from the pool.

---

## Step 5 — Port-forward the sandbox-router

In a **separate terminal** (keep it running):

```bash
export KUBECONFIG=<path-to-repo>/bin/KUBECONFIG
kubectl port-forward svc/sandbox-router-svc 8080:8080 -n default
```

---

## Step 6 — Start the backend

```bash
node examples/opencode-sandbox/poc/backend/server.js
# Listening on http://localhost:3000
```

Environment variables you can override (all optional):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Backend HTTP port |
| `SANDBOX_NAMESPACE` | `opencode` | K8s namespace for claims |
| `SANDBOX_TEMPLATE` | `opencode-template` | SandboxTemplate name |
| `SANDBOX_PORT` | `4096` | Port the sandbox pod listens on |
| `ROUTER_HOST` | `localhost` | sandbox-router host |
| `ROUTER_PORT` | `8080` | sandbox-router port |

---

## Step 7 — Open the browser

```
http://localhost:3000
```

1. Type a message and press **Enter** (or click **Send**)
2. The backend creates a `SandboxClaim` and waits for it to be Ready
   - Warm pool available → **< 1 second**
   - Cold start (pool empty) → **~30–60 seconds** while pod boots
3. Your message is forwarded to the pod; tokens stream back as they arrive
4. Follow up freely — the pod stays live between messages
5. Click **Close Session** to delete the claim and free the pod slot
   (the warm pool refills automatically)

---

## What each piece does

```
backend/server.js
  GET  /                    → serves index.html
  POST /session             → kubectl apply SandboxClaim, poll until Ready
  POST /session/:id/message → HTTP proxy to sandbox-router → pod /message (SSE)
  DELETE /session/:id       → kubectl delete SandboxClaim

sandbox/server.py (runs in pod on port 4096)
  POST /message  → Anthropic streaming API → SSE back to router → backend → browser
  GET  /healthz  → readiness probe

manifests/
  namespace.yaml         → opencode namespace
  sandbox-router.yaml    → reverse proxy (default namespace)
  sandbox-template.yaml  → pod spec: poc-sandbox image + ANTHROPIC_API_KEY
  warmpool.yaml          → keeps 2 pre-booted pods ready to claim
```

---

## Troubleshooting

**Pod stuck in Pending**
```bash
kubectl get pods -n opencode
kubectl describe pod <pod-name> -n opencode
```
Usually: image not loaded into kind (`kind load docker-image poc-sandbox:latest --name agent-sandbox`).

**"SandboxClaim not Ready after 120s"**
```bash
kubectl get sandboxclaim -n opencode
kubectl describe sandboxclaim <name> -n opencode
```

**502 from sandbox-router**
The pod isn't ready yet (readiness probe failing). Check:
```bash
kubectl logs -n opencode <pod-name>
```

**Port-forward disconnects**
Restart it in the terminal where it's running. The backend will return 502 until
it reconnects; refresh and try again.

**Check warm pool status**
```bash
kubectl get sandboxwarmpool opencode-pool -n opencode
kubectl get pods -n opencode --show-labels | grep agents.x-k8s.io/pool
```
