// test-mail-wait.mjs — F5-F3b (2026-08-08): endpoint GET /mail-wait do
// mcpServer — o WAITER de background do claude (R12). Contratos guardados:
// (1) auth por bearer igual ao /mcp (401 sem token/identidade);
// (2) resposta SEGURADA até waitForMail resolver — MAIL na chegada,
//     TIMEOUT no teto;
// (3) método diferente de GET = 405;
// (4) close() do servidor NÃO espera long-polls pendurados (drena com
//     TIMEOUT) — o quit do app nunca fica preso no teto de 10min.
import assert from 'node:assert/strict'
import test from 'node:test'
import { request as httpRequest } from 'node:http'

const { startMcpServer } = await import(new URL('../src/main/mcpServer.ts', import.meta.url))

const TOKEN = 'probe-mail-wait-token'
const identity = {
  paneId: 'pane-1',
  projectId: 'p1',
  role: 'review',
  cwd: 'C:/tmp'
}

function makeApi(waitForMail) {
  const stub = () => 'stub'
  return new Proxy(
    {
      hub: { identityByToken: (token) => (token === TOKEN ? identity : undefined) },
      drainInboxFor: () => '',
      noteCatalogServed: () => {},
      checkMessages: () => 'no mail (probe)',
      waitForMail
    },
    { get: (t, k) => (k in t ? t[k] : stub) }
  )
}

function get(port, { method = 'GET', auth = `Bearer ${TOKEN}` } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/mail-wait',
        method,
        headers: auth ? { authorization: auth } : {}
      },
      (res) => {
        let body = ''
        res.on('data', (d) => (body += d))
        res.on('end', () => resolve({ status: res.statusCode, body }))
      }
    )
    req.on('error', reject)
    req.end()
  })
}

test('mail-wait: 401 sem bearer, 405 fora de GET, MAIL na chegada, TIMEOUT no teto', async () => {
  const server = await startMcpServer(
    makeApi((_id, timeoutMs) => new Promise((r) => setTimeout(() => r(timeoutMs > 200), 80)))
  )
  try {
    // auth: null (undefined ativaria o DEFAULT do destructuring — bug real
    // da 1ª rodada desta suíte: o caso "sem bearer" testava com bearer)
    assert.equal((await get(server.port, { auth: null })).status, 401)
    assert.equal((await get(server.port, { auth: 'Bearer errado' })).status, 401)
    assert.equal((await get(server.port, { method: 'POST' })).status, 405)
    // waitForMail resolve true (timeout grande do endpoint > 200) após ~80ms
    const t0 = Date.now()
    const ok = await get(server.port)
    assert.equal(ok.status, 200)
    assert.match(ok.body, /MAIL/)
    assert.ok(Date.now() - t0 >= 60, 'a resposta foi segurada até a chegada')
  } finally {
    await server.close()
  }
})

test('mail-wait: close() drena long-poll pendurado — o quit nunca espera o teto', async () => {
  let held
  const server = await startMcpServer(
    makeApi(() => new Promise((r) => (held = r))) // nunca resolve sozinho
  )
  const pending = get(server.port)
  await new Promise((r) => setTimeout(r, 120)) // garante o hold armado
  const t0 = Date.now()
  await server.close()
  const res = await pending
  assert.equal(res.status, 200)
  assert.match(res.body, /TIMEOUT/)
  assert.ok(Date.now() - t0 < 5000, 'close não esperou o teto do long-poll')
  held?.(false) // higiene
})
