#!/usr/bin/env node
// Pure Node.js stdlib — no npm install required.
'use strict'

const http = require('http')
const { spawnSync } = require('child_process')
const fs   = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORT         = parseInt(process.env.PORT         || '3000',  10)
const NAMESPACE    = process.env.SANDBOX_NAMESPACE     || 'opencode'
const TEMPLATE     = process.env.SANDBOX_TEMPLATE      || 'opencode-template'
const SANDBOX_PORT = process.env.SANDBOX_PORT          || '4096'
const ROUTER_HOST  = process.env.ROUTER_HOST           || 'localhost'
const ROUTER_PORT  = parseInt(process.env.ROUTER_PORT  || '8080',  10)
const OC_MODEL     = process.env.OC_MODEL              || 'anthropic/claude-sonnet-4-6'
const OC_PROVIDER  = OC_MODEL.split('/')[0]

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'))

// claimName → { ocSessionId }
const sessions = new Map()

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

// ── opencode API helpers (via sandbox-router) ─────────────────────────────────

// Make a request through the sandbox-router to the opencode server running in
// the sandbox pod identified by `sandboxName`.
function routerRequest(sandboxName, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null
    const opts = {
      hostname: ROUTER_HOST,
      port:     ROUTER_PORT,
      path:     urlPath,
      method,
      headers: {
        'X-Sandbox-ID':        sandboxName,
        'X-Sandbox-Namespace': NAMESPACE,
        'X-Sandbox-Port':      SANDBOX_PORT,
        ...(bodyBuf ? {
          'Content-Type':   'application/json',
          'Content-Length': bodyBuf.length,
        } : {}),
      },
    }
    const req = http.request(opts, resolve)
    req.on('error', reject)
    if (bodyBuf) req.write(bodyBuf)
    req.end()
  })
}

async function readBody(res) {
  return new Promise((resolve, reject) => {
    let buf = ''
    res.on('data', d => { buf += d })
    res.on('end', () => resolve(buf))
    res.on('error', reject)
  })
}

// Create an opencode session in the sandbox pod; returns the opencode session ID.
async function createOcSession(claimName) {
  const res = await routerRequest(claimName, 'POST', '/session', {
    providerID: OC_PROVIDER,
    modelID:    OC_MODEL.split('/').slice(1).join('/'),
  })
  const body = await readBody(res)
  const data = JSON.parse(body)
  if (!data.id) throw new Error(`unexpected /session response: ${body}`)
  return data.id
}

// ── SSE transform ─────────────────────────────────────────────────────────────
// opencode SSE:  data: {"type":"message.part.updated","properties":{"delta":"hi",...}}
// client expects: data: {"delta":"hi"}  and data: [DONE] at the end
function transformOcSSE(rawChunk) {
  const lines = rawChunk.toString()
  const out   = []
  for (const line of lines.split('\n')) {
    if (!line.startsWith('data: ')) { out.push(line); continue }
    const payload = line.slice(6)
    if (payload === '[DONE]') { out.push(line); continue }
    try {
      const ev = JSON.parse(payload)
      if (ev.type === 'message.part.updated' && ev.properties?.delta) {
        out.push(`data: ${JSON.stringify({ delta: ev.properties.delta })}`)
      }
      // silently drop housekeeping events (session.updated, etc.)
    } catch { out.push(line) }
  }
  return out.join('\n')
}

function proxyStream(claimName, ocSessionId, msgBody, clientRes) {
  const body = {
    parts:      [{ type: 'text', text: msgBody.text }],
    providerID: OC_PROVIDER,
    modelID:    OC_MODEL.split('/').slice(1).join('/'),
  }
  const bodyBuf = Buffer.from(JSON.stringify(body))

  const opts = {
    hostname: ROUTER_HOST,
    port:     ROUTER_PORT,
    path:     `/session/${ocSessionId}/message`,
    method:   'POST',
    headers: {
      'Content-Type':        'application/json',
      'Content-Length':      bodyBuf.length,
      'X-Sandbox-ID':        claimName,
      'X-Sandbox-Namespace': NAMESPACE,
      'X-Sandbox-Port':      SANDBOX_PORT,
    },
  }

  const proxyReq = http.request(opts, proxyRes => {
    clientRes.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })
    proxyRes.on('data', chunk => {
      const transformed = transformOcSSE(chunk)
      if (transformed.trim()) clientRes.write(transformed + '\n')
    })
    proxyRes.on('end', () => {
      clientRes.write('data: [DONE]\n\n')
      clientRes.end()
    })
  })

  proxyReq.on('error', err => {
    if (!clientRes.headersSent) clientRes.writeHead(502)
    clientRes.end(`data: ${JSON.stringify({ error: err.message })}\n\ndata: [DONE]\n\n`)
  })

  proxyReq.write(bodyBuf)
  proxyReq.end()
}

// ── HTTP server ───────────────────────────────────────────────────────────────

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

  // POST /session → create SandboxClaim + opencode session, return id
  if (req.method === 'POST' && req.url === '/session') {
    const claim = 'oc-' + crypto.randomBytes(4).toString('hex')
    try {
      console.log(`[session] creating claim ${claim}`)
      applyYaml(claimYaml(claim))
      console.log(`[session] waiting for ${claim} to be Ready...`)
      await waitReady(claim)
      console.log(`[session] ${claim} Ready — creating opencode session`)
      const ocId = await createOcSession(claim)
      sessions.set(claim, { ocSessionId: ocId })
      console.log(`[session] opencode session ${ocId} created`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: claim }))
    } catch (e) {
      console.error(`[session] error:`, e.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
    return
  }

  // POST /session/:id/message → stream from opencode
  const msgMatch = req.url.match(/^\/session\/([^/]+)\/message$/)
  if (req.method === 'POST' && msgMatch) {
    const claim = msgMatch[1]
    const sess  = sessions.get(claim)
    if (!sess) { res.writeHead(404); res.end('session not found'); return }

    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => {
      let body
      try { body = JSON.parse(raw) } catch {
        res.writeHead(400); res.end('bad json'); return
      }
      console.log(`[message] → ${claim} (oc: ${sess.ocSessionId})`)
      proxyStream(claim, sess.ocSessionId, body, res)
    })
    return
  }

  // DELETE /session/:id → delete SandboxClaim + local state
  const delMatch = req.url.match(/^\/session\/([^/]+)$/)
  if (req.method === 'DELETE' && delMatch) {
    const claim = delMatch[1]
    try {
      kubectl('delete', 'sandboxclaim', claim, '-n', NAMESPACE, '--ignore-not-found')
      sessions.delete(claim)
      console.log(`[session] deleted ${claim}`)
    } catch (e) {
      console.error(`[session] delete error:`, e.message)
    }
    res.writeHead(204); res.end()
    return
  }

  res.writeHead(404); res.end('not found')
})

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`)
  console.log(`  NAMESPACE   = ${NAMESPACE}`)
  console.log(`  TEMPLATE    = ${TEMPLATE}`)
  console.log(`  ROUTER      = ${ROUTER_HOST}:${ROUTER_PORT}`)
  console.log(`  OC_MODEL    = ${OC_MODEL}`)
})
