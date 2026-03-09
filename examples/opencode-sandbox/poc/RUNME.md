# opencode PoC -- step by step

One-page coding agent: browser -> Node.js backend -> sandbox-router -> sandbox pod
running **opencode** (`opencode serve`). Warm pool keeps pods pre-booted.

## Screenshots

**Web UI** -- multi-turn conversation, streaming responses, tool use visible in the chat:

![Web UI](web.png)

**Sandbox shell** -- the actual pod filesystem after the agent ran; `jokes.md` was created by opencode using the bash tool:

![Sandbox shell](shell.png)

```
browser (index.html)
  POST /session              -> backend creates SandboxClaim -> warm pod adopted
                                -> backend creates opencode session inside pod
  POST /session/:id/message  -> backend opens SSE to /global/event, POSTs message,
                                streams deltas back to browser
  DELETE /session/:id        -> backend deletes SandboxClaim
```

opencode handles all AI calls, tool use, file editing -- no LLM SDK in the PoC code.

---

## Prerequisites

| Tool | Purpose |
|------|---------|
| `colima` | VM + container runtime (macOS) |
| `kubectl` | apply manifests, poll status |
| `node` 18+ | run the backend locally |

For kind-based setup, see the "Alternative: kind cluster" section at the end.

---

## Step 1 -- Start Colima with Kubernetes

```bash
colima start --runtime containerd --kubernetes --cpu 4 --memory 8 --disk 60
kubectl get nodes   # should show 1 node Ready
```

### Optional: enable gVisor

```bash
colima ssh -- sudo bash -s << 'SCRIPT'
set -e
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
ARCH=$(dpkg --print-architecture)
echo "deb [arch=$ARCH signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  | tee /etc/apt/sources.list.d/gvisor.list
apt-get update -qq && apt-get install -y runsc
cat >> /etc/containerd/config.toml << 'TOML'

[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
TOML
systemctl restart containerd
SCRIPT

kubectl apply -f - << 'EOF'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
EOF
```

---

## Step 2 -- Deploy the agent-sandbox operator

Use the prebuilt release images (no Go toolchain needed):

```bash
export VERSION="v0.1.1"

# Core controller + CRDs + extensions
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/manifest.yaml
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/extensions.yaml

# Wait for controller
kubectl rollout status statefulset/agent-sandbox-controller -n agent-sandbox-system --timeout=120s
```

---

## Step 3 -- Build and load images

Images must be in containerd's `k8s.io` namespace for k3s to find them.

**sandbox-router:**

```bash
colima ssh -- sudo nerdctl -n k8s.io build \
  -t poc-sandbox-router:latest \
  $(pwd)/clients/python/agentic-sandbox-client/sandbox-router/
```

**sandbox (opencode):**

```bash
colima ssh -- sudo nerdctl -n k8s.io build \
  -t poc-sandbox:latest \
  $(pwd)/examples/opencode-sandbox/poc/sandbox/
```

> The sandbox image is `node:22-slim` + `npm install -g opencode-ai`.
> It runs `opencode serve --hostname 0.0.0.0 --port 4096` -- no custom code.

---

## Step 4 -- Apply all manifests

```bash
# Namespace
kubectl apply -f examples/opencode-sandbox/poc/manifests/namespace.yaml

# Sandbox-router (default namespace) -- adjust imagePullPolicy for nerdctl
sed 's/imagePullPolicy: Never/imagePullPolicy: IfNotPresent/' \
  examples/opencode-sandbox/poc/manifests/sandbox-router.yaml | kubectl apply -f -
kubectl rollout status deployment/sandbox-router -n default

# LLM API key secret (opencode Zen example -- replace with your key)
kubectl create secret generic llm-keys \
  -n opencode \
  --from-literal=zen=sk-YOUR_ZEN_KEY_HERE

# SandboxTemplate + WarmPool
# For Zen: update the template to use the opencode provider
kubectl apply -f - << 'EOF'
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
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 4096
          env:
            - name: ZEN_API_KEY
              valueFrom:
                secretKeyRef:
                  name: llm-keys
                  key: zen
            - name: OPENCODE_CONFIG_CONTENT
              value: '{"model":"opencode/kimi-k2.5","provider":{"opencode":{"options":{"apiKey":"{env:ZEN_API_KEY}"}}}}'
          readinessProbe:
            httpGet:
              path: /doc
              port: 4096
            initialDelaySeconds: 10
            periodSeconds: 5
            failureThreshold: 12
EOF

kubectl apply -f examples/opencode-sandbox/poc/manifests/warmpool.yaml
```

Wait for the warm pool to fill:

```bash
kubectl get sandboxwarmpool -n opencode -w
# NAME            READY   AGE
# opencode-pool   2       30s    <- wait for READY=2
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
OC_MODEL=opencode/kimi-k2.5 node examples/opencode-sandbox/poc/backend/server.js
# Listening on http://localhost:3000
```

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Backend HTTP port |
| `SANDBOX_NAMESPACE` | `opencode` | K8s namespace for sandbox resources |
| `SANDBOX_TEMPLATE` | `opencode-template` | SandboxTemplate name |
| `SANDBOX_PORT` | `4096` | opencode server port in pod |
| `ROUTER_HOST` | `localhost` | sandbox-router host |
| `ROUTER_PORT` | `8080` | sandbox-router port |
| `OC_MODEL` | `opencode/kimi-k2.5` | `provider/model` string |

---

## Step 7 -- Open the browser

```
http://localhost:3000
```

1. Type a message and press **Enter**
2. The backend creates a `SandboxClaim` and waits for it to be Ready
   - Warm pool available: **< 1 second**
   - Cold start: **~30-60s** (image already cached)
3. Backend creates an opencode session inside the pod
4. Your message is forwarded to opencode
5. opencode streams tokens back via SSE as it thinks and edits files
6. Follow up freely -- the pod stays live and opencode maintains conversation history
7. Click **Close Session** to delete the claim and free the warm pool slot

---

## Architecture

```
browser (index.html)
|
|  POST /session
|  POST /session/:id/message  (SSE response)
|  DELETE /session/:id
v
backend/server.js  (node, local)
|  kubectl apply/delete SandboxClaim
|  polls claim .status.conditions via kubectl
|  maps  claimName -> opencode sessionId (in-memory Map)
|
|  HTTP via localhost:8080 (port-forward)
v
sandbox-router  (Deployment, default ns)
|  routes by X-Sandbox-ID header:
|    {claimName}.opencode.svc.cluster.local:4096
v
sandbox pod  (namespace: opencode)
  opencode serve --hostname 0.0.0.0 --port 4096

  Streaming pattern:
    1. Backend opens GET /global/event (SSE stream)
    2. Backend sends POST /session/{ocId}/message (fire-and-forget)
    3. Events flow back: message.part.delta -> {"delta":"..."}
    4. session.idle event -> [DONE]

  OPENCODE_CONFIG_CONTENT configures provider + model
  LLM API key from K8s Secret -> env var -> opencode config
```

---

## Using Anthropic directly (instead of Zen)

```bash
# Secret
kubectl create secret generic llm-keys -n opencode \
  --from-literal=anthropic=sk-ant-YOUR_KEY

# Template config
OPENCODE_CONFIG_CONTENT='{"model":"anthropic/claude-sonnet-4-6","provider":{"anthropic":{"options":{"apiKey":"{env:ANTHROPIC_API_KEY}"}}}}'

# Backend
OC_MODEL=anthropic/claude-sonnet-4-6 node examples/opencode-sandbox/poc/backend/server.js
```

Update the SandboxTemplate env to use `ANTHROPIC_API_KEY` from the secret key `anthropic`.

---

## Alternative: kind cluster

If using kind instead of Colima k3s:

```bash
# Step 1: deploy operator to kind
make EXTENSIONS=true deploy-kind
export KUBECONFIG=$(pwd)/bin/KUBECONFIG

# Step 3: build and load images via docker + kind
docker build -t poc-sandbox-router:latest clients/python/agentic-sandbox-client/sandbox-router/
docker build -t poc-sandbox:latest examples/opencode-sandbox/poc/sandbox/
kind load docker-image poc-sandbox-router:latest --name agent-sandbox
kind load docker-image poc-sandbox:latest --name agent-sandbox

# Step 4: use manifests as-is (imagePullPolicy: Never works with kind)
kubectl apply -f examples/opencode-sandbox/poc/manifests/sandbox-router.yaml
```

Everything else (steps 4-7) is the same.

---

## Troubleshooting

**Pod stuck in Pending / ImagePullBackOff**
```bash
kubectl get pods -n opencode
kubectl describe pod <name> -n opencode
```
For Colima: verify images are in the `k8s.io` namespace:
```bash
colima ssh -- sudo nerdctl -n k8s.io images | grep poc
```

**Readiness probe failing (CrashLoopBackOff or not Ready)**
```bash
kubectl logs -n opencode <pod-name>
```
Check `opencode serve` starts correctly. Common issues: npm install
failed during image build, or `OPENCODE_CONFIG_CONTENT` has invalid JSON.

**`SandboxClaim not Ready after 120s`**
```bash
kubectl get sandboxclaim -n opencode
kubectl describe sandboxclaim <name> -n opencode
```
Ensure the operator is running: `kubectl get pods -n agent-sandbox-system`

**Empty assistant response**
The opencode API uses a split pattern: `POST /message` is fire-and-forget,
streaming comes from `GET /global/event`. If you see empty responses, the
backend SSE connection to `/global/event` may not be connecting. Check:
```bash
curl -s http://localhost:8080/global/event \
  -H "X-Sandbox-ID: <claim-name>" \
  -H "X-Sandbox-Namespace: opencode" \
  -H "X-Sandbox-Port: 4096"
```
You should see `data: {"payload":{"type":"server.connected",...}}` immediately.

**Wrong model being used**
Verify `OPENCODE_CONFIG_CONTENT` includes the `"model"` field at the top level.
Check what the pod sees:
```bash
kubectl exec -n opencode <pod-name> -- printenv OPENCODE_CONFIG_CONTENT
```
After updating the SandboxTemplate, delete warm pool pods to recreate them:
```bash
kubectl delete pods -n opencode -l agents.x-k8s.io/pool
```

**Port-forward disconnects**
Restart it. The backend returns 502 until it reconnects.

**Check warm pool status**
```bash
kubectl get sandboxwarmpool opencode-pool -n opencode
kubectl get pods -n opencode -L agents.x-k8s.io/pool
```
