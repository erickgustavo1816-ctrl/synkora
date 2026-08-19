// SONDA — o FAST MODE do codex é dirigível pelo app-server (JSON-RPC)?
//
// Por que existe: o dono quer o mesmo toggle de "fast" nos dois CLIs. No codex
// a palavra "fast" quase não aparece na superfície — mas aparece onde importa:
//   · `codex features list` traz `fast_mode  stable  true` (flag LIGADA);
//   · o schema do app-server (`generate-json-schema`) tem `serviceTier` em
//     ThreadStartParams / ThreadResumeParams / ThreadForkParams / ThreadSettings
//     e, sobretudo, em **TurnStartParams**, descrito como
//     "Override the service tier for this turn and subsequent turns.";
//   · o catálogo (`model/list` -> Model) declara `serviceTiers[]`
//     ({id,name,description}) e `defaultServiceTier` POR MODELO
//     (`additionalSpeedTiers` é o campo velho, marcado "Deprecated: use
//     `serviceTiers` instead");
//   · o consumo volta quebrado por velocidade: `ThreadUsageBreakdownGroup.speed`.
// Ou seja: no codex "fast" não é um modo global, é um SERVICE TIER por modelo.
//
// Esta sonda pergunta ao binário REAL, com FATO:
//   1. quais `serviceTiers` cada modelo declara (ids/nome/descrição) e qual é o
//      `defaultServiceTier` — é daí que sai o menu do dono, nunca de chute;
//   2. `thread/start` aceita `serviceTier` e ECOA de volta (recibo)?
//   3. `turn/start` aceita o override por turno (o toggle do composer)?
//
// Uso:
//   node scripts/probe-fast-codex.mjs                    # catálogo + thread (0 turnos)
//   node scripts/probe-fast-codex.mjs --turn             # + 1 turno mínimo
//   node scripts/probe-fast-codex.mjs --tier priority    # força um id de tier
//   node scripts/probe-fast-codex.mjs --model gpt-5.1-codex
//
// Capturas CRUAS em .tmp/probe-fast/codex-frames.jsonl; resumo em
// .tmp/probe-fast/codex-summary.json. Não escreve nada de produto.
// Usa a conta padrão do CODEX_HOME herdado — nenhum seat do dono é tocado.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(process.argv[1], '..', '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-fast')
const WS = join(OUT_DIR, 'codex-ws')
const CAPTURE = join(OUT_DIR, 'codex-frames.jsonl')
const SUMMARY = join(OUT_DIR, 'codex-summary.json')

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const WANT_TURN = argv.includes('--turn')
const FORCED_TIER = flagValue('tier')
const MODEL = flagValue('model')
const TIMEOUT_MS = Number(flagValue('timeout') || 180) * 1000

mkdirSync(WS, { recursive: true })
writeFileSync(CAPTURE, '')

const env = { ...process.env }
for (const k of Object.keys(env)) if (/^CLAUDE_CODE_/i.test(k)) delete env[k]
delete env.CLAUDECODE
delete env.NO_COLOR
delete env.FORCE_COLOR

const child = spawn('codex', ['app-server'], {
  cwd: WS,
  env,
  shell: process.platform === 'win32'
})

const report = {
  probedAt: new Date().toISOString(),
  cli: 'codex',
  models: [],
  tierCatalog: [],
  threadStart: null,
  turnStart: null,
  usageSpeed: null,
  notes: [],
  verdict: null
}

let buf = ''
let nextId = 1
const pending = new Map()
let done = false

const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
const request = (method, params) =>
  new Promise((res) => {
    const id = nextId++
    pending.set(id, res)
    send({ jsonrpc: '2.0', id, method, params })
  })
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })

child.stdout.on('data', (d) => {
  buf += d.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    appendFileSync(CAPTURE, line + '\n')
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const res = pending.get(msg.id)
      if (res) {
        pending.delete(msg.id)
        res(msg)
      }
      continue
    }
    if (msg.id !== undefined && msg.method) {
      // pedido do servidor (aprovação): a sonda não roda tool nenhuma
      send({ jsonrpc: '2.0', id: msg.id, result: { decision: 'denied' } })
      continue
    }
    if (msg.method) handleNotification(msg)
  }
})
child.stderr.on('data', (d) => process.stderr.write(`[codex:stderr] ${d}`))
child.on('error', (e) => finish(`spawn falhou: ${e.message}`))

let turnDone = false
function handleNotification(msg) {
  // O consumo do turno traz a quebra POR VELOCIDADE — o recibo de que o tier
  // valeu de fato (ThreadUsageBreakdownGroup.speed).
  const p = msg.params ?? {}
  const groups = p.usage?.breakdown ?? p.breakdown ?? null
  if (Array.isArray(groups)) {
    const speeds = groups.map((g) => g?.speed).filter((s) => s !== undefined)
    if (speeds.length) report.usageSpeed = speeds
  }
  if (msg.method === 'turn/completed' || msg.method === 'turn/failed') turnDone = true
}

function finish(reason) {
  if (done) return
  done = true
  clearTimeout(timer)
  report.stopReason = reason
  writeFileSync(SUMMARY, JSON.stringify(report, null, 2))
  console.log('\n=== VEREDITO ===')
  console.log(JSON.stringify(report.verdict, null, 2))
  console.log(`\nresumo: ${SUMMARY}\nframes: ${CAPTURE}`)
  try {
    child.kill()
  } catch {}
  setTimeout(() => process.exit(0), 250)
}

const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS)

;(async () => {
  await request('initialize', {
    clientInfo: { name: 'synkora-probe-fast', title: 'Synkora fast probe', version: '0.0.1' }
  })
  notify('initialized', {})

  // ————— 1. catálogo: quem tem tier, e quais —————
  const list = await request('model/list', { includeHidden: true })
  const models = list.result?.data ?? []
  report.models = models.map((m) => ({
    id: m.id,
    model: m.model,
    displayName: m.displayName,
    isDefault: m.isDefault,
    hidden: m.hidden,
    defaultServiceTier: m.defaultServiceTier ?? null,
    serviceTiers: m.serviceTiers ?? [],
    additionalSpeedTiers: m.additionalSpeedTiers ?? [],
    supportedReasoningEfforts: (m.supportedReasoningEfforts ?? []).map((e) =>
      typeof e === 'string' ? e : (e?.effort ?? e?.id ?? JSON.stringify(e))
    )
  }))
  const seen = new Map()
  for (const m of report.models)
    for (const t of m.serviceTiers) if (!seen.has(t.id)) seen.set(t.id, t)
  report.tierCatalog = [...seen.values()]

  console.log('=== model/list ===')
  for (const m of report.models) {
    console.log(
      `  ${m.id}${m.isDefault ? ' (default)' : ''}${m.hidden ? ' (hidden)' : ''}` +
        `  tiers=[${m.serviceTiers.map((t) => t.id).join(', ') || '-'}]` +
        `  defaultTier=${m.defaultServiceTier}` +
        `  legacySpeedTiers=[${m.additionalSpeedTiers.join(', ') || '-'}]`
    )
  }
  console.log('\n=== catálogo de service tiers ===')
  for (const t of report.tierCatalog) console.log(`  ${t.id} · ${t.name} · ${t.description}`)

  // Alvo: o tier forçado, senão o primeiro que NÃO for o default do modelo.
  const target = report.models.find((m) => (MODEL ? m.id === MODEL || m.model === MODEL : m.isDefault)) ?? report.models[0]
  const tier =
    FORCED_TIER ??
    target?.serviceTiers?.map((t) => t.id).find((id) => id !== target.defaultServiceTier) ??
    target?.serviceTiers?.[0]?.id ??
    null
  report.notes.push(`modelo alvo: ${target?.id ?? '(nenhum)'} · tier alvo: ${tier ?? '(nenhum)'}`)
  console.log(`\nalvo: modelo=${target?.id} tier=${tier}`)

  if (!tier) {
    report.verdict = { tierSupported: false, why: 'nenhum service tier no catálogo desta conta' }
    return finish('sem tier no catálogo')
  }

  // ————— 2. thread/start aceita e ECOA o serviceTier? —————
  const started = await request('thread/start', {
    cwd: WS,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    ephemeral: true,
    ...(MODEL ? { model: MODEL } : {}),
    serviceTier: tier
  })
  report.threadStart = {
    ok: !started.error,
    error: started.error ?? null,
    echoedServiceTier: started.result?.serviceTier ?? null,
    threadServiceTier: started.result?.thread?.serviceTier ?? null,
    responseKeys: Object.keys(started.result ?? {})
  }
  console.log('\n=== thread/start ===')
  console.log(JSON.stringify(report.threadStart, null, 1))

  const threadId = started.result?.thread?.id ?? started.result?.threadId
  if (!threadId) {
    report.verdict = { tierSupported: false, why: 'thread/start não devolveu id' }
    return finish('thread/start sem id')
  }

  // ————— 3. turn/start aceita o override por turno? —————
  if (WANT_TURN) {
    const turn = await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'responda apenas: ok' }],
      approvalPolicy: 'never',
      serviceTier: tier
    })
    report.turnStart = {
      ok: !turn.error,
      error: turn.error ?? null,
      responseKeys: Object.keys(turn.result ?? {})
    }
    console.log('\n=== turn/start (com serviceTier) ===')
    console.log(JSON.stringify(report.turnStart, null, 1))
    const started = Date.now()
    while (!turnDone && Date.now() - started < TIMEOUT_MS - 10_000)
      await new Promise((r) => setTimeout(r, 250))
  } else {
    report.notes.push('turno não rodado (use --turn) — turn/start só foi lido do schema')
  }

  report.verdict = {
    featureFlag: 'fast_mode (codex features list) = stable/true',
    tierCatalog: report.tierCatalog.map((t) => t.id),
    threadStartAcceptsTier: report.threadStart?.ok === true,
    threadStartEchoesTier: report.threadStart?.echoedServiceTier ?? report.threadStart?.threadServiceTier,
    turnStartAcceptsTier: report.turnStart ? report.turnStart.ok : '(não testado — use --turn)',
    usageSpeed: report.usageSpeed,
    perTurnOverride: 'TurnStartParams.serviceTier — "Override the service tier for this turn and subsequent turns."'
  }
  finish('concluído')
})().catch((e) => {
  report.notes.push(`fatal: ${e?.message}`)
  finish('fatal')
})
