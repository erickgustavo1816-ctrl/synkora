// Driver E2E do Synkora (2026-08-05): conecta ao Chrome DevTools Protocol do
// app rodando com SYNKORA_E2E=1 e executa chamadas no window.synkora REAL do
// renderer — as MESMAS chamadas que os botões da UI fazem. É o harness com que
// o fluxo de missão é validado de ponta a ponta sem cliques humanos.
//
// Uso como módulo:   const d = await connect(); await d.synkora('projects.list()')
// Uso como CLI:      node scripts/e2e/driver.mjs eval "window.synkora.projects.list()"
import WebSocket from 'ws'

const PORT = Number(process.env.SYNKORA_E2E_PORT ?? 9222)

async function fetchJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`CDP ${url}: HTTP ${res.status}`)
  return res.json()
}

export async function connect({ port = PORT, timeoutMs = 30_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let targets
  for (;;) {
    try {
      targets = await fetchJson(`http://127.0.0.1:${port}/json`)
      // Fase 3: o alvo é o HOST (URL sem ?view=) — a WebContentsView de panes
      // e os overlays também são page targets e roubariam a sessão.
      const page = targets.find(
        (t) =>
          t.type === 'page' &&
          !/devtools/i.test(t.url ?? '') &&
          !/[?&]view=/.test(t.url ?? '')
      )
      if (page) return openSession(page)
    } catch {
      // app ainda subindo
    }
    if (Date.now() > deadline) {
      throw new Error(
        `CDP indisponível em 127.0.0.1:${port} após ${timeoutMs}ms — o app está rodando com SYNKORA_E2E=1?`
      )
    }
    await new Promise((r) => setTimeout(r, 500))
  }
}

function openSession(page) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
    let seq = 0
    const pending = new Map()
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(`CDP: ${msg.error.message}`))
        else res(msg.result)
      }
    })
    ws.on('error', reject)
    ws.on('open', async () => {
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const id = ++seq
          pending.set(id, { resolve: res, reject: rej })
          ws.send(JSON.stringify({ id, method, params }))
        })
      await send('Runtime.enable')

      /** Avalia uma expressão JS no renderer; Promises são aguardadas e o
       *  valor volta por JSON. Erros do renderer viram exceções aqui. */
      const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          timeout: 120_000
        })
        if (result.exceptionDetails) {
          const detail =
            result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text ??
            'erro desconhecido no renderer'
          throw new Error(`renderer: ${detail.slice(0, 800)}`)
        }
        return result.result?.value
      }

      resolve({
        page,
        ws,
        send,
        evaluate,
        /** Atalho: chamada sobre window.synkora (ex.: 'projects.list()'). */
        synkora: (call) => evaluate(`window.synkora.${call}`),
        close: () => ws.close()
      })
    })
  })
}

// ————— CLI —————
const [, , cmd, ...rest] = process.argv
if (cmd === 'eval') {
  const expr = rest.join(' ')
  try {
    const session = await connect()
    const value = await session.evaluate(expr)
    console.log(JSON.stringify(value, null, 2))
    session.close()
    process.exit(0)
  } catch (error) {
    console.error(String(error?.message ?? error))
    process.exit(1)
  }
} else if (cmd === 'targets') {
  console.log(JSON.stringify(await fetchJson(`http://127.0.0.1:${PORT}/json`), null, 2))
  process.exit(0)
}
