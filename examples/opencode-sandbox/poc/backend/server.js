#!/usr/bin/env node
// Pure Node.js stdlib — no npm install required.
'use strict'

const http = require('http')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PORT = parseInt(process.env.PORT || '3000', 10)
const NAMESPACE = process.env.SANDBOX_NAMESPACE || 'opencode'
const TEMPLATE  = process.env.SANDBOX_TEMPLATE  || 'opencode-template'
const SANDBOX_PORT = process.env.SANDBOX_PORT   || '4096'
const ROUTER_HOST  = process.env.ROUTER_HOST    || 'localhost'
const ROUTER_PORT  = parseInt(process.env.ROUTER_PORT || '8080', 10)

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'))

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

// ── sandbox-router proxy ─────────────────────────────────────────────────────

function proxyStream(sandboxName, body, clientRes) {
  const bodyBuf = Buffer.from(JSON.stringify(body))
  const opts = {
    hostname: ROUTER_HOST,
    port:     ROUTER_PORT,
    path:     '/message',
    method:   'POST',
    headers: {
      'Content-Type':        'application/json',
      'Content-Length':      bodyBuf.length,
      'X-Sandbox-ID':        sandboxName,
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
    proxyRes.pipe(clientRes)
  })

  proxyReq.on('error', err => {
    if (!clientRes.headersSent) clientRes.writeHead(502)
    clientRes.end(`data: ${JSON.stringify({ error: err.message })}\n\ndata: [DONE]\n\n`)
  })

  proxyReq.write(bodyBuf)
  proxyReq.end()
}

// ── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // GET / → web UI
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(HTML)
    return
  }

  // POST /session → create SandboxClaim, wait Ready, return id
  if (req.method === 'POST' && req.url === '/session') {
    const name = 'oc-' + crypto.randomBytes(4).toString('hex')
    try {
      console.log(`[session] creating claim ${name}`)
      applyYaml(claimYaml(name))
      console.log(`[session] waiting for ${name} to be Ready...`)
      await waitReady(name)
      console.log(`[session] ${name} is Ready`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: name }))
    } catch (e) {
      console.error(`[session] error:`, e.message)
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
    return
  }

  // POST /session/:id/message → stream from sandbox
  const msgMatch = req.url.match(/^\/session\/([^/]+)\/message$/)
  if (req.method === 'POST' && msgMatch) {
    const sandboxName = msgMatch[1]
    let raw = ''
    req.on('data', d => { raw += d })
    req.on('end', () => {
      let body
      try { body = JSON.parse(raw) } catch {
        res.writeHead(400); res.end('bad json'); return
      }
      console.log(`[message] → ${sandboxName}`)
      proxyStream(sandboxName, body, res)
    })
    return
  }

  // DELETE /session/:id → delete SandboxClaim
  const delMatch = req.url.match(/^\/session\/([^/]+)$/)
  if (req.method === 'DELETE' && delMatch) {
    const name = delMatch[1]
    try {
      kubectl('delete', 'sandboxclaim', name, '-n', NAMESPACE, '--ignore-not-found')
      console.log(`[session] deleted ${name}`)
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
  console.log(`  SANDBOX_PORT= ${SANDBOX_PORT}`)
})
