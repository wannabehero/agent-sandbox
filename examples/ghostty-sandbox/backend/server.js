#!/usr/bin/env node
// ghostty-sandbox backend
// Dependencies: ws (npm install ws)
'use strict'

const http   = require('http')
const { spawnSync } = require('child_process')
const crypto = require('crypto')
const WebSocket = require('ws')

const PORT         = parseInt(process.env.PORT          || '3001',  10)
const NAMESPACE    = process.env.SANDBOX_NAMESPACE      || 'opencode'
const TEMPLATE     = process.env.SANDBOX_TEMPLATE       || 'ghostty-template'
const SANDBOX_PORT = process.env.SANDBOX_PORT           || '4096'
const ROUTER_HOST  = process.env.ROUTER_HOST            || 'localhost'
const ROUTER_PORT  = parseInt(process.env.ROUTER_PORT   || '8080',  10)

// ── kubectl helpers ──────────────────────────────────────────────────────────

function kubectl(...args) {
  const r = spawnSync('kubectl', args, { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout)
  return r.stdout
}

function applyYaml(yaml) {
  const r = spawnSync('kubectl', ['apply', '-f', '-'], { input: yaml, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr || r.stdout)
}

function claimYaml(name) {
  return `\
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxClaim
metadata:
  name: ${name}
  namespace: ${NAMESPACE}
spec:
  sandboxTemplateRef:
    name: ${TEMPLATE}
`
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function waitReady(name, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const out = kubectl(
        'get', 'sandboxclaim', name, '-n', NAMESPACE,
        `-o=jsonpath={.status.conditions[?(@.type=="Ready")].status}`
      )
      if (out.trim() === 'True') return
    } catch (_) { /* not found yet */ }
    await sleep(2000)
  }
  throw new Error(`SandboxClaim ${name} not Ready after ${timeoutMs / 1000}s`)
}

// ── HTML page ─────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ghostty-web sandbox</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #1a1a1a; color: #eee; font-family: monospace; display: flex; flex-direction: column; height: 100vh; }
    #toolbar { padding: 8px 12px; background: #111; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
    #status { font-size: 13px; color: #aaa; }
    #close-btn { margin-left: auto; padding: 4px 12px; background: #c0392b; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
    #close-btn:disabled { opacity: 0.4; cursor: default; }
    #terminal { flex: 1; overflow: hidden; }
  </style>
</head>
<body>
  <div id="toolbar">
    <span id="status">Starting sandbox...</span>
    <button id="close-btn" disabled>Close Session</button>
  </div>
  <div id="terminal"></div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5/lib/xterm.js"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5/css/xterm.css">
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8/lib/xterm-addon-fit.js"></script>
  <script>
    const statusEl  = document.getElementById('status')
    const closeBtn  = document.getElementById('close-btn')
    const termEl    = document.getElementById('terminal')

    let sessionId = null
    let ws = null

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'monospace',
      fontSize: 14,
    })
    const fitAddon = new FitAddon.FitAddon()
    term.loadAddon(fitAddon)
    term.open(termEl)
    fitAddon.fit()

    window.addEventListener('resize', () => fitAddon.fit())

    async function start() {
      statusEl.textContent = 'Creating sandbox...'
      let data
      try {
        const res = await fetch('/session', { method: 'POST' })
        data = await res.json()
        if (!res.ok) throw new Error(data.error || res.statusText)
      } catch (e) {
        statusEl.textContent = 'Error: ' + e.message
        return
      }
      sessionId = data.id
      statusEl.textContent = 'Connected: ' + sessionId
      closeBtn.disabled = false

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const cols  = term.cols
      const rows  = term.rows
      ws = new WebSocket(\`\${proto}//\${location.host}/session/\${sessionId}/ws?cols=\${cols}&rows=\${rows}\`)
      ws.binaryType = 'arraybuffer'

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          term.write(new Uint8Array(e.data))
        } else {
          term.write(e.data)
        }
      }

      ws.onclose = () => {
        statusEl.textContent = 'Disconnected'
        closeBtn.disabled = true
      }

      ws.onerror = () => {
        statusEl.textContent = 'WebSocket error'
      }

      term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(data)
      })

      term.onResize(({ cols, rows }) => {
        // ghostty-web/demo supports resize via a separate message or new WS
        // For now, send as JSON resize command if supported
      })
    }

    closeBtn.addEventListener('click', async () => {
      if (!sessionId) return
      closeBtn.disabled = true
      if (ws) ws.close()
      await fetch('/session/' + sessionId, { method: 'DELETE' })
      statusEl.textContent = 'Session closed'
      sessionId = null
    })

    start()
  </script>
</body>
</html>
`

// ── HTTP + WebSocket server ────────────────────────────────────────────────────

const wss = new WebSocket.Server({ noServer: true })

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // GET / → web UI
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(HTML)
    return
  }

  // POST /session → create SandboxClaim, wait for Ready, return {id}
  if (req.method === 'POST' && req.url === '/session') {
    const claim = 'ghostty-' + crypto.randomBytes(4).toString('hex')
    try {
      console.log(`[session] creating claim ${claim}`)
      applyYaml(claimYaml(claim))
      console.log(`[session] waiting for ${claim} to be Ready...`)
      await waitReady(claim)
      console.log(`[session] ${claim} Ready`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: claim }))
    } catch (e) {
      console.error(`[session] error:`, e.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
    return
  }

  // DELETE /session/:id → delete SandboxClaim
  const delMatch = req.url.match(/^\/session\/([^/]+)$/)
  if (req.method === 'DELETE' && delMatch) {
    const claim = delMatch[1]
    try {
      kubectl('delete', 'sandboxclaim', claim, '-n', NAMESPACE, '--ignore-not-found')
      console.log(`[session] deleted ${claim}`)
    } catch (e) {
      console.error(`[session] delete error:`, e.message)
    }
    res.writeHead(204); res.end()
    return
  }

  res.writeHead(404); res.end('not found')
})

// WebSocket upgrade: /session/:id/ws?cols=N&rows=N
server.on('upgrade', (req, socket, head) => {
  const match = req.url.match(/^\/session\/([^/?]+)(\/ws)(\?.+)?$/)
  if (!match) { socket.destroy(); return }

  const claimName = match[1]
  const query     = match[3] || ''

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    const targetUrl = `ws://${ROUTER_HOST}:${ROUTER_PORT}/ws${query}`
    console.log(`[ws] ${claimName} -> ${targetUrl}`)

    const targetWs = new WebSocket(targetUrl, {
      headers: {
        'X-Sandbox-ID':        claimName,
        'X-Sandbox-Namespace': NAMESPACE,
        'X-Sandbox-Port':      SANDBOX_PORT,
      },
    })

    targetWs.on('open', () => {
      console.log(`[ws] ${claimName} target connected`)
    })

    targetWs.on('error', (err) => {
      console.error(`[ws] ${claimName} target error:`, err.message)
      clientWs.close()
    })

    clientWs.on('message', (data, isBinary) => {
      if (targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(data, { binary: isBinary })
      }
    })

    targetWs.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary })
      }
    })

    clientWs.on('close', () => {
      console.log(`[ws] ${claimName} client disconnected`)
      targetWs.close()
    })

    targetWs.on('close', () => {
      clientWs.close()
    })
  })
})

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`)
  console.log(`  NAMESPACE    = ${NAMESPACE}`)
  console.log(`  TEMPLATE     = ${TEMPLATE}`)
  console.log(`  ROUTER       = ${ROUTER_HOST}:${ROUTER_PORT}`)
  console.log(`  SANDBOX_PORT = ${SANDBOX_PORT}`)
})
