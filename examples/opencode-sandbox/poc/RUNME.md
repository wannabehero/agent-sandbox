# opencode PoC — step by step

One-page coding agent: browser → Node.js backend → sandbox-router → sandbox pod
running **opencode** (`opencode serve`). Warm pool keeps pods pre-booted.

```
browser (index.html)
  POST /session              → backend creates SandboxClaim → warm pod adopted
                               → backend creates opencode session inside pod
  POST /session/:id/message  → backend proxies to opencode's /session/:ocId/message (SSE)
  DELETE /session/:id        → backend deletes SandboxClaim
```

opencode handles all AI calls, tool use, file editing — no Anthropic SDK in the PoC code.

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

> **Using your own existing kind cluster?** Skip `make deploy-kind` and run:
> ```bash
> ./dev/tools/push-images --image-prefix=kind.local/ --kind-cluster-name=<your-cluster>
> ./dev/tools/deploy-to-kube --image-prefix=kind.local/
> kubectl patch deployment agent-sandbox-controller -n agent-sandbox-system \
>   -p '{"spec":{"template":{"spec":{"containers":[{"name":"agent-sandbox-controller","args":["--extensions=true"]}]}}}}'
> ```

---

## Step 2 — Build and load the sandbox-router image

```bash
cd clients/python/agentic-sandbox-client/sandbox-router

docker build -t poc-sandbox-router:latest .

kind load docker-image poc-sandbox-router:latest --name agent-sandbox

cd -
```

---

## Step 3 — Build and load the sandbox (opencode) image

```bash
cd examples/opencode-sandbox/poc/sandbox

docker build -t poc-sandbox:latest .

kind load docker-image poc-sandbox:latest --name agent-sandbox

cd -
```

> The image is `node:22-slim` + `npm install -g opencode-ai`.
> It runs `opencode serve --hostname 0.0.0.0 --port 4096` — no custom code.

---

## Step 4 — Apply all manifests

```bash
# Namespace for all sandbox resources
kubectl apply -f examples/opencode-sandbox/poc/manifests/namespace.yaml

# Sandbox-router (default namespace)
kubectl apply -f examples/opencode-sandbox/poc/manifests/sandbox-router.yaml
kubectl rollout status deployment/sandbox-router -n default

# API key secret (replace with your real key)
kubectl create secret generic llm-keys \
  -n opencode \
  --from-literal=anthropic=sk-ant-YOUR_KEY_HERE

# SandboxTemplate (opencode pod spec) + WarmPool (2 pre-booted pods)
kubectl apply -f examples/opencode-sandbox/poc/manifests/sandbox-template.yaml
kubectl apply -f examples/opencode-sandbox/poc/manifests/warmpool.yaml
```

Check the warm pool filling (may take ~60–90s while opencode installs npm packages):

```bash
kubectl get sandboxwarmpool -n opencode -w
# NAME            REPLICAS   READY
# opencode-pool   2          2      ← wait for Ready=2
```

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

Optional env vars:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Backend HTTP port |
| `SANDBOX_NAMESPACE` | `opencode` | K8s namespace |
| `SANDBOX_TEMPLATE` | `opencode-template` | SandboxTemplate name |
| `SANDBOX_PORT` | `4096` | opencode server port in pod |
| `ROUTER_HOST` | `localhost` | sandbox-router host |
| `ROUTER_PORT` | `8080` | sandbox-router port |
| `OC_MODEL` | `anthropic/claude-sonnet-4-6` | opencode model string |

---

## Step 7 — Open the browser

```
http://localhost:3000
```

1. Type a message and press **Enter**
2. The backend creates a `SandboxClaim` and waits for it to be Ready
   - Warm pool available → **< 1 second**
   - Cold start → **~60–90s** while the opencode pod boots
3. Backend creates an opencode session inside the pod (`POST /session`)
4. Your message is forwarded to opencode (`POST /session/:id/message`)
5. opencode streams tokens back via SSE as it thinks and edits files
6. Follow up freely — the pod stays live and opencode maintains conversation history
7. Click **Close Session** to delete the claim and free the warm pool slot

---

## Architecture

```
browser (index.html)
│
│  POST /session
│  POST /session/:id/message  (SSE)
│  DELETE /session/:id
▼
backend/server.js  (node, local)
│  kubectl apply/delete SandboxClaim
│  polls claim status via kubectl
│  maps  claimName → opencode sessionId
│
│  HTTP → localhost:8080 (port-forward)
▼
sandbox-router  (Deployment, default ns)
│  routes by X-Sandbox-ID header:
│    {claimName}.opencode.svc.cluster.local:4096
▼
sandbox pod  (namespace: opencode)
  opencode serve --hostname 0.0.0.0 --port 4096
  POST /session         → create opencode session
  POST /session/:id/message → AI response stream (SSE)
  ANTHROPIC_API_KEY from K8s secret → llm-keys
  OPENCODE_CONFIG_CONTENT  → configures provider
```

opencode's SSE events (`message.part.updated`) are transformed by the backend
to `{"delta":"..."}` before forwarding to the browser.

---

## Troubleshooting

**Pod stuck in Pending / ImagePullBackOff**
```bash
kubectl get pods -n opencode
kubectl describe pod <name> -n opencode
```
Image not loaded into kind: `kind load docker-image poc-sandbox:latest --name agent-sandbox`

**Readiness probe failing (CrashLoopBackOff or not Ready)**
```bash
kubectl logs -n opencode <pod-name>
```
If `opencode serve` isn't starting, check that the npm install succeeded inside the image:
```bash
docker run --rm poc-sandbox:latest opencode --version
```

**`SandboxClaim not Ready after 120s`**
```bash
kubectl get sandboxclaim -n opencode
kubectl describe sandboxclaim <name> -n opencode
```

**`unexpected /session response`** (backend log)
opencode returned an error when creating the session. Check logs:
```bash
kubectl logs -n opencode <pod-name>
```
Usually: API key not set, or provider config wrong.

**Port-forward disconnects**
Restart it. The backend returns 502 until it reconnects.

**Check warm pool**
```bash
kubectl get sandboxwarmpool opencode-pool -n opencode
kubectl get pods -n opencode -L agents.x-k8s.io/pool
```
