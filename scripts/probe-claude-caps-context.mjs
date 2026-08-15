// PROBE — o handshake `initialize` do Claude Code informa a JANELA DE CONTEXTO por modelo?
//
// Por que existe: o init handler do maestroSession.ts deduzia a janela por
// heuristica de string (`model.includes('[1m]') ? 1M : 200k`), o que esta
// errado para quase todo modelo atual (opus/sonnet/fable/mythos sao 1M sem
// carregar o sufixo no id resolvido). Lei do projeto: nunca cravar na mao o que
// o binario pode dizer. Esta sonda pergunta ao CLI REAL antes de qualquer
// decisao de implementacao.
//
// O que ela responde, com FATO:
//   1. o `control_response` do initialize traz alguma chave de janela/limite de
//      tokens POR MODELO (contextWindow, max_input_tokens, contextLength...)?
//   2. o envelope `system/init` do primeiro turno traz alguma?
//   3. o `result` do turno traz alguma (usage/limites)?
//
// ————— RESULTADO DA RODADA DE 2026-08-15 (claude 2.1.233) —————
//
// (1) HANDSHAKE: NAO. As entradas de modelo tem exatamente
//     value, resolvedModel, displayName, description, supportsEffort,
//     supportedEffortLevels, supportsAdaptiveThinking, supportsFastMode,
//     supportsAutoMode — ZERO campo numerico de janela.
//
// (2) system/init: NAO. E aqui mora a CAUSA RAIZ do bug do dono: o campo
//     `model` do init traz o modelo RESOLVIDO, e ele nem sempre carrega o
//     sufixo `[1m]`:
//        --model claude-fable-5[1m]  ->  init model = "claude-fable-5"   (sem [1m]!)
//        --model default             ->  init model = "claude-opus-5[1m]"
//     Logo a heuristica antiga `model.includes('[1m]') ? 1M : 200k` classificava
//     Fable 5 (que e 1M) como 200k. Exatamente o sintoma relatado.
//
// (3) result: SIM — e este e o achado que importa. O envelope `result` carrega
//     `modelUsage`, um mapa POR MODELO com a janela REAL informada pelo CLI:
//        modelUsage["claude-fable-5"].contextWindow            = 1000000
//        modelUsage["claude-opus-5[1m]"].contextWindow         = 1000000
//        modelUsage["claude-haiku-4-5-20251001"].contextWindow =  200000
//     A CHAVE do mapa bate LITERALMENTE com o `model` do system/init (com ou
//     sem `[1m]`) — verificado nas duas formas acima. O mapa tambem contem
//     modelos de tarefas auxiliares (haiku aparece sozinho), por isso a leitura
//     precisa ser indexada pelo modelo do init, nunca "o primeiro do mapa".
//
// DECISAO: janela autoritativa = modelUsage[model].contextWindow do `result`;
// tabela curada so cobre a janela do `init`, que acontece ANTES do primeiro
// result. Re-sondar a cada update de CLI.
//
// O handshake NAO custa token: `initialize` e `control_request`, resolvido pelo
// proprio CLI. O turno de sondagem (--turn) custa um prompt minusculo e so roda
// quando pedido explicitamente.
//
// PRIVACIDADE: o dump e de ESTRUTURA + valores de PROTOCOLO (ids de modelo,
// nomes de campo, numeros). Campos de identidade da conta (email, token,
// caminhos absolutos) sao redigidos antes de tocar o disco ou o stdout.
//
// Uso:
//   node scripts/probe-claude-caps-context.mjs             # so o handshake (0 tokens)
//   node scripts/probe-claude-caps-context.mjs --turn      # + 1 turno minimo
//   node scripts/probe-claude-caps-context.mjs --model opus
//
// Nao toca em nenhum arquivo de produto. Escreve so em .tmp/probe-caps-context/.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(process.argv[1], '..', '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-caps-context')
const WS = join(OUT_DIR, 'ws')
const DUMP = join(OUT_DIR, 'caps-dump.json')

const argv = process.argv.slice(2)
const WANT_TURN = argv.includes('--turn')
const flagValue = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.split('=')[1]
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const MODEL = flagValue('model')
const TIMEOUT_MS = Number(flagValue('timeout') || 60) * 1000

mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'README.md'), '# throwaway probe workspace\n')
try {
  rmSync(DUMP)
} catch {}

// ---------------------------------------------------------------------------
// Redacao — identidade da conta e caminhos nunca chegam ao disco
// ---------------------------------------------------------------------------

const REDACT_KEYS = /^(email|apiKey|api_key|token|accessToken|refresh|path|cwd|homeDir|userID|userId|accountUuid|organizationUuid)$/i
const looksSecret = (v) =>
  typeof v === 'string' &&
  (/@/.test(v) || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('/Users/') || v.startsWith('/home/'))

function redact(node) {
  if (Array.isArray(node)) return node.map(redact)
  if (node && typeof node === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(node)) {
      out[k] = REDACT_KEYS.test(k) || looksSecret(v) ? '«redigido»' : redact(v)
    }
    return out
  }
  return node
}

// ---------------------------------------------------------------------------
// Caca de campo de janela: qualquer chave numerica que possa ser um teto de
// tokens, em qualquer profundidade. Nomes NAO sao chutados — coletamos tudo
// que casa o padrao e mostramos o caminho + valor.
// ---------------------------------------------------------------------------

const WINDOW_KEY_RE =
  /(context|window|token|input|output|limit|length|max)/i

/** Um teto plausivel de janela: inteiro grande o bastante para ser tokens. */
const plausibleWindow = (v) => Number.isSafeInteger(v) && v >= 1000

function findWindowFields(node, path = '', hits = []) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => findWindowFields(item, `${path}[${i}]`, hits))
    return hits
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k
      if (typeof v === 'number' && WINDOW_KEY_RE.test(k)) {
        hits.push({ path: p, key: k, value: v, plausibleWindow: plausibleWindow(v) })
      }
      findWindowFields(v, p, hits)
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// Sessao
// ---------------------------------------------------------------------------

const env = { ...process.env }
for (const k of Object.keys(env)) if (/^CLAUDE_CODE_/i.test(k)) delete env[k]
delete env.CLAUDECODE
delete env.NO_COLOR
delete env.FORCE_COLOR

// Flags IDENTICAS as do maestroSession.ts (constructor).
const args = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--permission-prompt-tool',
  'stdio'
]
if (MODEL) args.push('--model', MODEL)

console.log(`[probe] claude ${args.join(' ')}`)
const child = spawn('claude', args, {
  cwd: WS,
  env,
  shell: process.platform === 'win32'
})

const result = {
  probedAt: new Date().toISOString(),
  cliVersion: null,
  spawnArgs: args,
  handshake: { received: false, models: [], rawResponseKeys: [], windowFields: [] },
  systemInit: { received: false, envelope: null, windowFields: [] },
  turnResult: { received: false, envelope: null, windowFields: [] },
  verdict: null
}

let buf = ''
let done = false

const INIT_REQ = 'probe-init-1'

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n')
}

child.stdout.on('data', (d) => {
  buf += d.toString()
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (line.trim()) handleLine(line)
  }
})

child.stderr.on('data', (d) => process.stderr.write(`[claude:stderr] ${d}`))
child.on('error', (e) => finish(`spawn falhou: ${e.message}`))
child.on('close', (code) => finish(`o CLI encerrou (exit ${code})`))

function handleLine(line) {
  let evt
  try {
    evt = JSON.parse(line)
  } catch {
    return
  }

  // ————— 1. resposta do handshake initialize —————
  if (evt.type === 'control_response' && evt.response?.request_id === INIT_REQ) {
    result.handshake.received = true
    const payload = evt.response.response ?? {}
    result.handshake.rawResponseKeys = Object.keys(payload)
    // Entradas de modelo COMPLETAS (todas as chaves), redigidas.
    result.handshake.models = redact(payload.models ?? [])
    result.handshake.windowFields = findWindowFields(redact(payload))
    // Chaves de nivel raiz que nao sao commands/models — pode haver limites lá.
    result.handshake.otherPayload = redact(
      Object.fromEntries(
        Object.entries(payload).filter(([k]) => k !== 'commands' && k !== 'models')
      )
    )

    console.log('\n=== HANDSHAKE initialize ===')
    console.log('chaves do payload:', result.handshake.rawResponseKeys.join(', ') || '(vazio)')
    const models = result.handshake.models
    console.log(`modelos: ${models.length}`)
    if (models.length) {
      const keys = new Set()
      for (const m of models) for (const k of Object.keys(m ?? {})) keys.add(k)
      console.log('chaves POR MODELO (união):', [...keys].join(', '))
      console.log('\nentradas COMPLETAS:')
      for (const m of models) console.log('  ' + JSON.stringify(m))
    }
    console.log('\ncampos numéricos candidatos a janela:')
    if (!result.handshake.windowFields.length) console.log('  (nenhum)')
    for (const f of result.handshake.windowFields)
      console.log(`  ${f.path} = ${f.value}${f.plausibleWindow ? '  <-- plausível' : ''}`)

    if (WANT_TURN) {
      send({
        type: 'user',
        message: { role: 'user', content: 'responda apenas: ok' }
      })
    } else {
      finish(null)
    }
    return
  }

  // ————— 2. envelope system/init do turno —————
  if (evt.type === 'system' && evt.subtype === 'init' && !result.systemInit.received) {
    result.systemInit.received = true
    result.systemInit.envelope = redact(evt)
    result.systemInit.windowFields = findWindowFields(redact(evt))
    console.log('\n=== system/init (envelope do turno) ===')
    console.log('chaves:', Object.keys(evt).join(', '))
    console.log('model:', evt.model)
    console.log('campos numéricos candidatos a janela:')
    if (!result.systemInit.windowFields.length) console.log('  (nenhum)')
    for (const f of result.systemInit.windowFields) console.log(`  ${f.path} = ${f.value}`)
    return
  }

  // ————— 3. result do turno —————
  if (evt.type === 'result') {
    result.turnResult.received = true
    result.turnResult.envelope = redact(evt)
    result.turnResult.windowFields = findWindowFields(redact(evt))
    console.log('\n=== result (fim do turno) ===')
    console.log('chaves:', Object.keys(evt).join(', '))
    console.log('usage:', JSON.stringify(evt.usage ?? null))
    console.log('campos numéricos candidatos a janela:')
    if (!result.turnResult.windowFields.length) console.log('  (nenhum)')
    for (const f of result.turnResult.windowFields) console.log(`  ${f.path} = ${f.value}`)
    finish(null)
  }
}

function finish(err) {
  if (done) return
  done = true
  clearTimeout(timer)

  const anyPerModelWindow = result.handshake.models.some((m) =>
    Object.entries(m ?? {}).some(
      ([k, v]) => typeof v === 'number' && WINDOW_KEY_RE.test(k) && plausibleWindow(v)
    )
  )
  // O achado que decide a implementação: `result.modelUsage[<model>].contextWindow`.
  const modelUsage = result.turnResult.envelope?.modelUsage ?? null
  const initModel = result.systemInit.envelope?.model ?? null
  const usageWindow =
    modelUsage && initModel && typeof modelUsage[initModel]?.contextWindow === 'number'
      ? modelUsage[initModel].contextWindow
      : null
  result.modelUsageWindow = { initModel, usageWindow, keys: modelUsage ? Object.keys(modelUsage) : [] }

  result.verdict = err
    ? `INCONCLUSIVO: ${err}`
    : anyPerModelWindow
      ? 'O CLI EXPÕE janela por modelo no HANDSHAKE — usar o mapa das caps.'
      : usageWindow !== null
        ? `O CLI EXPÕE a janela REAL no result: modelUsage["${initModel}"].contextWindow = ${usageWindow}. ` +
          'Usar essa medição como autoritativa; tabela curada só cobre o init.'
        : 'O CLI NÃO expõe janela por modelo no handshake — resolver por tabela curada. ' +
          '(rode com --turn para checar o `result`, onde mora o modelUsage)'

  console.log('\n=== VEREDITO ===')
  console.log(result.verdict)

  try {
    writeFileSync(DUMP, JSON.stringify(result, null, 2))
    console.log(`\ndump: ${DUMP}`)
  } catch (e) {
    console.error('falha ao gravar o dump:', e.message)
  }

  try {
    child.kill()
  } catch {}
  setTimeout(() => process.exit(0), 200)
}

const timer = setTimeout(() => finish('timeout esperando o CLI'), TIMEOUT_MS)

// Handshake: mesmo envelope que o maestroSession.ts escreve no construtor.
send({
  type: 'control_request',
  request_id: INIT_REQ,
  request: { subtype: 'initialize' }
})
