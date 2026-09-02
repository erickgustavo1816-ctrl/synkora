// SONDA — O RECIBO DE LEITURA NO CODEX (R39.1, sonda 3 do design
// `.synkora/reports/DESIGN_FALA_DO_DONO_SEM_PARAR_R39_1_2026-09-02.md`).
//
// A pergunta é a MESMA da sonda do claude, no outro motor: quando o
// `turn/steer` é ABSORVIDO pelo turno em andamento, o app-server emite algum
// evento (um `item/started` de `userMessage`?) que sirva de RECIBO DE LEITURA?
// E a resposta do RPC é ACEITE (enfileirou) ou LEITURA (absorveu)?
//
// O schema do protocolo (`codex app-server generate-json-schema --experimental`)
// dá os dois ganchos que a sonda persegue:
//  - `TurnSteerParams.clientUserMessageId` — um id NOSSO viaja com a fala;
//  - `UserMessageThreadItem.clientId` — o item de mensagem do usuário carrega
//    um `clientId`, e `item/started` carrega um `ThreadItem`.
// Se o par existir no binário real, o recibo do codex é o `item/started` cujo
// `item.clientId` é o nosso — tão estrutural quanto o `command_lifecycle` do
// claude.
//
// O turno é LONGO de propósito e SEM TOOL (uma contagem narrada): a sonda mede
// a absorção do steer, não a política de sandbox/aprovação do codex — e um
// turno que não toca em disco nem em rede não pode sujar nada.
//
// Frames crus em `.tmp/probe-steer-receipt/codex-steer.jsonl`; resumo em
// `codex-summary.json`. Seat do dono só para LER a credencial.
//
// Uso: node scripts/probe-codex-steer-receipt.mjs [--timeout 180]

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(process.argv[1], '..', '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-steer-receipt')
const WS = join(OUT_DIR, 'ws-codex')
const CAPTURE = join(OUT_DIR, process.argv.includes('--interrupt') ? 'codex-steer-cut.jsonl' : 'codex-steer.jsonl')
const SUMMARY = join(OUT_DIR, process.argv.includes('--interrupt') ? 'codex-cut-summary.json' : 'codex-summary.json')

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const TIMEOUT_MS = Number(flagValue('timeout') || 180) * 1000
/** `--interrupt`: a sonda do "ler agora" — corta o turno com a fala recém-steerada. */
const CUT = argv.includes('--interrupt')

const FALLBACK_CODEX_HOME =
  'C:\\Users\\Erick\\AppData\\Roaming\\synkora\\seats\\5e00223f-00d6-4a46-8d79-f5fa94c0320c'

mkdirSync(WS, { recursive: true })
writeFileSync(CAPTURE, '')

const OWNER_MARKER = 'MID-TURN CHECK'
const OWNER_TEXT = `${OWNER_MARKER}: the moment you read this, include the single word BANANA in your very next reply text.`
const LONG_TASK =
  'Without using any tool, count from 1 to 90. Write one line per number, each line naming the number and one short fact about it. Take your time and write every line.'

const clip = (v, n = 300) =>
  typeof v === 'string' ? (v.length > n ? `${v.slice(0, n)}…[+${v.length - n}]` : v) : v

const out = {
  probedAt: new Date().toISOString(),
  cliVersion: null,
  codexHome: process.env.CODEX_HOME || FALLBACK_CODEX_HOME,
  turnUuid: randomUUID(),
  ownerUuid: randomUUID(),
  methods: {},
  timeline: [],
  /** Frames cuja linha CRUA carrega o marcador da fala — candidatos a recibo. */
  echoFrames: [],
  /** `item/started` cujo item é `userMessage` (o recibo candidato). */
  userMessageItems: [],
  steerResponse: null,
  cut: CUT,
  interruptResponse: null,
  msInterruptSent: null,
  msSteerSent: null,
  msSteerAck: null,
  msUserItem: null,
  msCited: null,
  error: null
}

const env = { ...process.env }
env.CODEX_HOME = out.codexHome
delete env.NO_COLOR
delete env.FORCE_COLOR

try {
  out.cliVersion = (await import('node:child_process')).execSync('codex --version', { shell: true })
    .toString()
    .trim()
} catch {}

const child = spawn('codex', ['app-server'], {
  cwd: WS,
  env,
  shell: process.platform === 'win32'
})

const t0 = Date.now()
const mark = (what) => {
  out.timeline.push(`${Date.now() - t0}ms ${what}`)
  process.stderr.write(`  ${Date.now() - t0}ms ${what}\n`)
}
let nextId = 0
const write = (obj) => {
  try {
    child.stdin.write(JSON.stringify(obj) + '\n')
  } catch (e) {
    out.error = `stdin: ${e.message}`
  }
}
const pending = new Map()
const request = (method, params) =>
  new Promise((done) => {
    const id = ++nextId
    out.methods[method] = (out.methods[method] || 0) + 1
    pending.set(id, done)
    write({ jsonrpc: '2.0', id, method, params })
  })

let finished = false
const finish = (reason) => {
  if (finished) return
  finished = true
  clearTimeout(killTimer)
  out.stopReason = reason
  try {
    child.kill()
  } catch {}
  setTimeout(() => {
    writeFileSync(SUMMARY, JSON.stringify(out, null, 2))
    console.log('\n=== VEREDITO (codex) ===')
    console.log(
      JSON.stringify(
        {
          steerAcceptedInMs:
            out.msSteerAck !== null && out.msSteerSent !== null
              ? out.msSteerAck - out.msSteerSent
              : null,
          steerResponse: out.steerResponse,
          userMessageItemForOwner: out.userMessageItems.filter(
            (i) => i.clientId === out.ownerUuid
          ),
          msSteerToUserItem:
            out.msUserItem !== null && out.msSteerSent !== null
              ? out.msUserItem - out.msSteerSent
              : null,
          msSteerToCitation:
            out.msCited !== null && out.msSteerSent !== null ? out.msCited - out.msSteerSent : null,
          echoFrames: out.echoFrames.map((e) => `${e.at}ms ${e.method}`)
        },
        null,
        1
      )
    )
    for (const l of out.timeline) console.log('  ' + l)
    console.log(`\nresumo: ${SUMMARY}`)
    process.exit(0)
  }, 300)
}
const killTimer = setTimeout(() => finish('timeout global'), TIMEOUT_MS)

let buf = ''
child.stdout.on('data', (d) => {
  buf += d.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (line.trim()) handleLine(line)
  }
})
child.stderr.on('data', (d) => process.stderr.write(`  [codex:stderr] ${d}`))
child.on('error', (e) => {
  out.error = `spawn falhou: ${e.message}`
  finish('erro de spawn')
})
child.on('close', (code) => finish(`o app-server encerrou (exit ${code})`))

let threadId = null
let turnId = null
let steerSent = false

function handleLine(line) {
  appendFileSync(CAPTURE, line + '\n')
  const at = Date.now() - t0
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (steerSent && line.includes(OWNER_MARKER)) {
    out.echoFrames.push({ at, method: msg.method ?? `resposta#${msg.id}`, raw: clip(line, 600) })
  }
  if (msg.id !== undefined && msg.method === undefined) {
    const waiter = pending.get(msg.id)
    if (waiter) {
      pending.delete(msg.id)
      waiter(msg)
    }
    return
  }
  const method = msg.method
  if (!method) return
  out.methods[method] = (out.methods[method] || 0) + 1

  // Aprovações: o turno da sonda não usa tool, mas se algo pedir, nega — a
  // sonda mede steering, não permissão.
  if (msg.id !== undefined && /Approval|approval|requestUserInput/.test(method)) {
    write({ jsonrpc: '2.0', id: msg.id, result: { decision: 'decline' } })
    mark(`pedido ${method} recusado (a sonda não usa tool)`)
    return
  }

  if (method === 'turn/started') {
    // O id do turno mora em `params.turn.id` (o `turnId` cru só aparece nos
    // eventos de item) — verificado nos frames crus da 1ª rodada.
    turnId = msg.params?.turn?.id ?? msg.params?.turnId ?? turnId
    mark(`turn/started turnId=${turnId}`)
    if (!steerSent) {
      steerSent = true
      setTimeout(async () => {
        out.msSteerSent = Date.now() - t0
        mark('turn/steer ENVIADO (a fala do dono)')
        const resp = await request('turn/steer', {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: 'text', text: OWNER_TEXT }],
          clientUserMessageId: out.ownerUuid
        })
        out.msSteerAck = Date.now() - t0
        out.steerResponse = resp.error ? { error: resp.error } : (resp.result ?? null)
        mark(`resposta do turn/steer: ${clip(JSON.stringify(out.steerResponse), 300)}`)
        // O "LER AGORA" do dono no codex: corta o turno LOGO depois do steer,
        // antes de a fala ser absorvida. Ela sobrevive (vira turno novo, como no
        // claude) ou some com o turno cortado? É o que decide se o force do
        // codex reenvia a cópia do pote ou só o envelope curto.
        if (CUT) {
          setTimeout(async () => {
            out.msInterruptSent = Date.now() - t0
            const cut = await request('turn/interrupt', { threadId, turnId })
            out.interruptResponse = cut.error ? { error: cut.error } : (cut.result ?? null)
            mark(`turn/interrupt → ${clip(JSON.stringify(out.interruptResponse), 200)}`)
          }, 400)
        }
      }, 4_000)
    }
    return
  }

  if (method === 'item/started' || method === 'item/completed') {
    const item = msg.params?.item
    if (item?.type === 'userMessage') {
      out.userMessageItems.push({
        at,
        method,
        id: item.id,
        clientId: item.clientId ?? null,
        text: clip(JSON.stringify(item.content), 200)
      })
      if (item.clientId === out.ownerUuid && out.msUserItem === null) out.msUserItem = at
      mark(`${method} userMessage clientId=${item.clientId ?? 'null'}`)
    }
    if (item?.type === 'agentMessage' && typeof item.text === 'string') {
      if (/banana/i.test(item.text) && out.msCited === null) {
        out.msCited = at
        mark('o modelo CITOU a fala (BANANA)')
      }
    }
    return
  }

  if (method === 'turn/completed' || method === 'turn/failed') {
    mark(`${method}`)
    setTimeout(() => finish(method), CUT ? 30_000 : 8_000)
    return
  }
}

// --- a partida -------------------------------------------------------------
const init = await request('initialize', {
  clientInfo: { name: 'synkora-probe', title: 'Synkora probe', version: '0.1.0' }
})
if (init.error) {
  out.error = `initialize: ${JSON.stringify(init.error)}`
  finish('handshake falhou')
} else {
  mark('handshake ok')
  write({ jsonrpc: '2.0', method: 'initialized', params: {} })
  const thread = await request('thread/start', { cwd: WS })
  threadId = thread.result?.thread?.id ?? null
  mark(`thread/start → ${threadId ?? JSON.stringify(thread.error)}`)
  if (!threadId) finish('sem thread')
  else {
    const started = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: LONG_TASK }],
      clientUserMessageId: out.turnUuid
    })
    mark(`turn/start → ${clip(JSON.stringify(started.result ?? started.error), 200)}`)
  }
}
