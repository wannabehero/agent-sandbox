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

// ── SSE streaming ─────────────────────────────────────────────────────────────
// opencode API:
//   POST /session/:id/message  → fire-and-forget (returns JSON immediately)
//   GET  /global/event         → SSE stream of all events; filter by sessionID
//
// Relevant event types:
//   message.part.delta   { field:"text", delta:"..." }    → text token
//   message.part.updated { part: { type:"tool-result" } } → tool output (plugin events)
//   session.idle         { sessionID:"..." }              → response complete
//
// Structured events from the oc-events plugin arrive as OC_EVENT markers
// appended to tool-result output.  Marker format:
//   OC_EVENT: {"type":"<event-type>", ...payload}
// These are forwarded as-is to the browser over the client SSE stream.

// Parse all OC_EVENT markers out of a tool-result output string.
function parseOcEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('OC_EVENT: ')) continue
    try { events.push(JSON.parse(line.slice(10))) } catch {}
  }
  return events
}

function proxyStream(claimName, ocSessionId, msgText, clientRes) {
  const msgBuf = Buffer.from(JSON.stringify({
    parts:      [{ type: 'text', text: msgText }],
    providerID: OC_PROVIDER,
    modelID:    OC_MODEL.split('/').slice(1).join('/'),
  }))

  // 1. Open SSE connection to /global/event
  const sseReq = http.request({
    hostname: ROUTER_HOST,
    port:     ROUTER_PORT,
    path:     '/global/event',
    method:   'GET',
    headers: {
      'X-Sandbox-ID':        claimName,
      'X-Sandbox-Namespace': NAMESPACE,
      'X-Sandbox-Port':      SANDBOX_PORT,
    },
  }, sseRes => {
    clientRes.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })

    let buf = '', finished = false

    function finish() {
      if (finished) return
      finished = true
      clientRes.write('data: [DONE]\n\n')
      clientRes.end()
      sseReq.destroy()
    }

    sseRes.on('data', chunk => {
      buf += chunk.toString()
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        let ev
        try { ev = JSON.parse(line.slice(6)) } catch { continue }
        const p = ev.payload
        if (!p) continue
        const props = p.properties || {}
        // filter to our session
        const sid = props.sessionID || props.info?.sessionID
        if (sid && sid !== ocSessionId) continue

        // Text token → forward delta to browser
        if (p.type === 'message.part.delta' && props.field === 'text' && props.delta) {
          clientRes.write(`data: ${JSON.stringify({ delta: props.delta })}\n\n`)
        }

        // Tool result → parse OC_EVENT markers injected by the oc-events plugin
        if (p.type === 'message.part.updated') {
          const part = props.part || props
          if (part.type === 'tool-result' || part.type === 'tool_result') {
            const output = part.output ?? part.content ?? ''
            for (const ocEv of parseOcEvents(String(output))) {
              clientRes.write(`data: ${JSON.stringify(ocEv)}\n\n`)
            }
          }
        }

        if (p.type === 'session.idle') finish()
      }
    })

    sseRes.on('end', finish)

    // 2. POST message after SSE is connected
    const msgReq = http.request({
      hostname: ROUTER_HOST,
      port:     ROUTER_PORT,
      path:     `/session/${ocSessionId}/message`,
      method:   'POST',
      headers: {
        'Content-Type':        'application/json',
        'Content-Length':      msgBuf.length,
        'X-Sandbox-ID':        claimName,
        'X-Sandbox-Namespace': NAMESPACE,
        'X-Sandbox-Port':      SANDBOX_PORT,
      },
    }, () => {})
    msgReq.on('error', err => {
      if (!clientRes.headersSent) clientRes.writeHead(502)
      clientRes.end(`data: ${JSON.stringify({ error: err.message })}\n\ndata: [DONE]\n\n`)
      sseReq.destroy()
    })
    msgReq.write(msgBuf)
    msgReq.end()
  })

  sseReq.on('error', err => {
    if (!clientRes.headersSent) clientRes.writeHead(502)
    clientRes.end(`data: ${JSON.stringify({ error: err.message })}\n\ndata: [DONE]\n\n`)
  })
  sseReq.end()
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
      proxyStream(claim, sess.ocSessionId, body.text, res)
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
