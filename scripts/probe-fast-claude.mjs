// SONDA — o FAST MODE do claude é dirigível HEADLESS (stream-json)?
//
// Por que existe: o dono quer um toggle de fast mode no composer do chat e um
// pino de fast por ajudante. A superfície MENTE: `claude --help` (2.1.235) não
// tem NENHUMA flag `--fast`, e o `/fast` do TUI é `local-jsx` (exige ink). Lei
// da casa: sondar o BINÁRIO REAL antes de afirmar protocolo. Esta sonda dirige
// o CLI exatamente como o `maestroSession.ts` dirige (mesmas flags, mesmo
// handshake) e pergunta, com FATO:
//
//   1. o handshake `initialize` diz QUAIS modelos suportam fast (`supportsFastMode`)?
//   2. `/fast on|off` como MENSAGEM DE USUÁRIO funciona em modo SDK?
//   3. a chave de settings `fastMode` (via `--settings <json>`) liga de verdade?
//   4. algum envelope ECOA o estado (recibo) — `fast_mode_state`?
//   5. o toggle AO VIVO (sem respawn) funciona depois do opt-in?
//
// ————— O QUE O BINÁRIO 2.1.235 DIZ (leitura estrutural do bundle) —————
//
// Existem DUAS fichas do comando `/fast` no bundle:
//   FWS = { type:'local-jsx', name:'fast', requires:{ink:true} }        <- TUI
//   Vil = { type:'local',     name:'fast', supportsNonInteractive:true,
//           argumentHint:'[on|off]', isEnabled:()=>Cn() }               <- HEADLESS
// e `Cn() = !isInteractive()`. Ou seja: a variante headless do /fast existe e
// só é habilitada FORA do TUI. O portão que a bloqueia não é o modo, é o
// opt-in: `mK()` devolve 'sdk_opt_in_required' quando
// `cn('flagSettings')?.fastMode !== true` — e `flagSettings` é, literalmente,
// a fonte de settings da LINHA DE COMANDO (`--settings <file-or-json>`).
//
// Esta sonda existe para PROVAR isso ao vivo (ou desmentir).
//
// Uso:
//   node scripts/probe-fast-claude.mjs                 # tudo (custa ~3 turnos mínimos)
//   node scripts/probe-fast-claude.mjs --only caps     # só o handshake (0 tokens)
//   node scripts/probe-fast-claude.mjs --only plain-slash,optin-turn
//   node scripts/probe-fast-claude.mjs --model opus --timeout 180
//
// Cenários:
//   caps          handshake `initialize` — 0 tokens. Quais modelos têm fast.
//   plain-slash   SEM opt-in: manda `/fast on`. Espera-se recusa nomeando o SDK.
//   optin-turn    COM `--settings {"fastMode":true}`: 1 turno mínimo, lê o recibo.
//   optin-toggle  COM opt-in: /fast off -> turno -> /fast on -> turno (ao vivo).
//
// Capturas CRUAS em .tmp/probe-fast/claude-<cenário>.jsonl (o .tmp é
// gitignorado); o resumo redigido em .tmp/probe-fast/claude-summary.json.
// PRIVACIDADE: o resumo redige e-mail/chave/caminho absoluto; os prompts são
// deste arquivo ("responda apenas: ok"), nada do dono trafega.
//
// NÃO toca em nenhum arquivo de produto. Não usa seat do dono: roda no
// CLAUDE_CONFIG_DIR herdado (padrão) — passe CLAUDE_CONFIG_DIR no ambiente
// para apontar a uma CÓPIA de seat, se quiser.

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(process.argv[1], '..', '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-fast')
const WS = join(OUT_DIR, 'ws')
const SUMMARY = join(OUT_DIR, 'claude-summary.json')

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const MODEL = flagValue('model')
const STEP_TIMEOUT_MS = Number(flagValue('timeout') || 180) * 1000
const ONLY = (flagValue('only') || '').split(',').map((s) => s.trim()).filter(Boolean)

mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'README.md'), '# workspace descartável da sonda de fast mode\n')

// ---------------------------------------------------------------------------
// Redação — identidade da conta e caminho absoluto nunca entram no RESUMO
// ---------------------------------------------------------------------------
const REDACT_KEYS =
  /^(email|apiKey|api_key|token|accessToken|refresh|cwd|homeDir|userID|userId|accountUuid|organizationUuid)$/i
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
const clip = (v, n = 400) =>
  typeof v === 'string' ? (v.length > n ? `${v.slice(0, n)}…[+${v.length - n}]` : v) : v

// ---------------------------------------------------------------------------
// O passo: ou um comando slash (local, não deveria custar token) ou um turno
// mínimo de verdade. Cada passo termina no `result` do CLI.
// ---------------------------------------------------------------------------
const slash = (text) => ({ kind: 'slash', text })
const turn = (text = 'responda apenas: ok') => ({ kind: 'turn', text })

const OPT_IN = JSON.stringify({ fastMode: true })

const SCENARIOS = [
  {
    name: 'caps',
    why: 'quais modelos o CLI declara com fast mode (0 tokens)',
    settings: null,
    steps: []
  },
  {
    name: 'plain-slash',
    why: 'SEM opt-in: /fast on é aceito ou recusado, e com qual receita',
    settings: null,
    steps: [slash('/fast on')]
  },
  {
    name: 'optin-turn',
    why: 'COM --settings {"fastMode":true}: o recibo fast_mode_state vira "on"?',
    settings: OPT_IN,
    steps: [turn()]
  },
  {
    name: 'optin-toggle',
    why: 'COM opt-in: /fast off e /fast on AO VIVO mudam o recibo sem respawn?',
    settings: OPT_IN,
    steps: [slash('/fast off'), turn(), slash('/fast on'), turn()]
  },
  {
    // O opt-in do SDK exige `flagSettings.fastMode === true` LITERAL. Com false
    // o portão continua fechado? (custo zero: só o slash local)
    name: 'optin-false',
    why: 'o portão do SDK aceita fastMode:false como opt-in? (esperado: não)',
    settings: JSON.stringify({ fastMode: false }),
    steps: [slash('/fast on')]
  },
  {
    // A PERGUNTA CARA: dá para ter o opt-in SEM nascer em fast (que custa
    // $10/$50 por Mtok)? `$qs()` do bundle devolve OFF quando
    // policySettings.fastModePerSessionOptIn === true, e a política entra pela
    // flag escondida `--managed-settings` ("SDK use only"). Custo zero.
    name: 'managed-optin',
    why: 'opt-in ligado mas sessão NASCE off (toggle sob demanda) — combo é possível?',
    settings: OPT_IN,
    managedSettings: JSON.stringify({ fastModePerSessionOptIn: true }),
    steps: [slash('/fast on')]
  },
  {
    // Segunda tentativa do combo barato: a POLÍTICA diz fastMode:false (a
    // sessão nasce off) enquanto a FLAG diz true (o portão do SDK abre, porque
    // `mK()` olha `cn('flagSettings')?.fastMode` e não o merge). Custo zero.
    name: 'managed-off',
    why: 'política false + flag true: nasce off mas o /fast on é aceito?',
    settings: OPT_IN,
    managedSettings: JSON.stringify({ fastMode: false }),
    steps: [slash('/fast on')]
  },
  {
    name: 'sonnet-optin',
    why: 'modelo SEM fast (sonnet) + opt-in: o /fast on TROCA o modelo por baixo?',
    settings: OPT_IN,
    model: 'sonnet',
    steps: [turn(), slash('/fast on'), turn()]
  }
]

// ---------------------------------------------------------------------------
// Uma execução = um processo claude, um handshake, N passos.
// ---------------------------------------------------------------------------
function runScenario(sc) {
  return new Promise((done) => {
    const capture = join(OUT_DIR, `claude-${sc.name}.jsonl`)
    writeFileSync(capture, '')

    const env = { ...process.env }
    // Mesma higiene do maestroSession/pty: marcador herdado faz o filho rodar
    // como "child session" e some com transcript/telemetria.
    for (const k of Object.keys(env)) if (/^CLAUDE_CODE_/i.test(k)) delete env[k]
    delete env.CLAUDECODE
    delete env.NO_COLOR
    delete env.FORCE_COLOR

    // Flags IDÊNTICAS às do maestroSession.ts (constructor).
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
    // O modelo do cenário manda: há cenário que EXISTE para testar um modelo
    // sem fast (sonnet). A flag global --model só cobre os demais.
    const model = sc.model ?? MODEL
    if (model) args.push('--model', model)
    if (sc.settings) {
      // No Windows o spawn vai por shell: o JSON precisa da camada extra de
      // aspas — exatamente o que o maestroSession.ts faz hoje.
      args.push('--settings', process.platform === 'win32' ? JSON.stringify(sc.settings) : sc.settings)
    }
    if (sc.managedSettings) {
      // `--managed-settings` é flag ESCONDIDA (hideHelp) do CLI: "Policy-tier
      // settings JSON from a spawning parent process (SDK use only)".
      args.push(
        '--managed-settings',
        process.platform === 'win32' ? JSON.stringify(sc.managedSettings) : sc.managedSettings
      )
    }

    const out = {
      scenario: sc.name,
      why: sc.why,
      settingsFlag: sc.settings,
      spawnArgs: args,
      caps: { received: false, models: [], fastCapable: [] },
      steps: [],
      frameTypes: {},
      error: null
    }

    const child = spawn('claude', args, { cwd: WS, env, shell: process.platform === 'win32' })

    let buf = ''
    let stepIndex = -1
    let current = null
    let finished = false
    const INIT_REQ = 'probe-fast-init'

    const send = (obj) => {
      try {
        child.stdin.write(JSON.stringify(obj) + '\n')
      } catch (e) {
        out.error = `stdin: ${e.message}`
      }
    }

    const finish = (reason) => {
      if (finished) return
      finished = true
      clearTimeout(stepTimer)
      out.stopReason = reason
      try {
        child.stdin.end()
      } catch {}
      try {
        child.kill()
      } catch {}
      setTimeout(() => done(out), 250)
    }

    let stepTimer = null
    const armStepTimer = () => {
      clearTimeout(stepTimer)
      stepTimer = setTimeout(() => {
        if (current) current.timedOut = true
        finish(`timeout no passo ${stepIndex}`)
      }, STEP_TIMEOUT_MS)
    }

    const nextStep = () => {
      stepIndex += 1
      if (stepIndex >= sc.steps.length) return finish('passos concluídos')
      const step = sc.steps[stepIndex]
      current = {
        index: stepIndex,
        kind: step.kind,
        sent: step.text,
        init: null,
        result: null,
        assistantText: [],
        timedOut: false
      }
      out.steps.push(current)
      process.stderr.write(`  [${sc.name}] passo ${stepIndex} (${step.kind}) -> ${step.text}\n`)
      send({ type: 'user', message: { role: 'user', content: step.text } })
      armStepTimer()
    }

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) handleLine(line)
      }
    })
    child.stderr.on('data', (d) => process.stderr.write(`  [claude:stderr] ${d}`))
    child.on('error', (e) => {
      out.error = `spawn falhou: ${e.message}`
      finish('erro de spawn')
    })
    child.on('close', (code) => finish(`o CLI encerrou (exit ${code})`))

    function handleLine(line) {
      appendFileSync(capture, line + '\n')
      let evt
      try {
        evt = JSON.parse(line)
      } catch {
        return
      }
      const tag = evt.type === 'system' ? `system/${evt.subtype}` : evt.type
      out.frameTypes[tag] = (out.frameTypes[tag] || 0) + 1

      // 1. handshake — capacidades reais por modelo
      if (evt.type === 'control_response' && evt.response?.request_id === INIT_REQ) {
        out.caps.received = true
        const payload = evt.response.response ?? {}
        out.caps.models = redact(payload.models ?? [])
        out.caps.fastCapable = (payload.models ?? [])
          .filter((m) => m?.supportsFastMode === true)
          .map((m) => m.value)
        out.caps.payloadKeys = Object.keys(payload)
        nextStep()
        return
      }

      // 2. o CLI pede permissão de tool — a sonda nega (nenhum passo usa tool)
      if (evt.type === 'control_request' && evt.request?.subtype === 'can_use_tool') {
        send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: evt.request_id,
            response: { behavior: 'deny', message: 'sonda: sem tools' }
          }
        })
        return
      }

      // 3. system/init — o recibo do INÍCIO do turno
      if (evt.type === 'system' && evt.subtype === 'init' && current && !current.init) {
        current.init = {
          model: evt.model,
          fast_mode_state: evt.fast_mode_state,
          fast_mode_disabled_reason: evt.fast_mode_disabled_reason,
          effort: evt.effort,
          hasFastKeys: 'fast_mode_state' in evt
        }
        return
      }

      // 4. texto do assistente (curto — só para ver a resposta do slash)
      if (evt.type === 'assistant' && current) {
        for (const block of evt.message?.content ?? []) {
          if (block?.type === 'text' && block.text) current.assistantText.push(clip(block.text, 300))
        }
        return
      }

      // 5. result — o recibo do FIM do turno; fecha o passo
      if (evt.type === 'result' && current) {
        current.result = {
          subtype: evt.subtype,
          is_error: evt.is_error,
          fast_mode_state: evt.fast_mode_state,
          fast_mode_disabled_reason: evt.fast_mode_disabled_reason,
          hasFastKeys: 'fast_mode_state' in evt,
          num_turns: evt.num_turns,
          total_cost_usd: evt.total_cost_usd,
          modelUsageKeys: evt.modelUsage ? Object.keys(evt.modelUsage) : [],
          text: clip(evt.result, 600)
        }
        clearTimeout(stepTimer)
        nextStep()
      }
    }

    // Handshake: mesmo envelope do maestroSession.ts.
    send({ type: 'control_request', request_id: INIT_REQ, request: { subtype: 'initialize' } })
    stepTimer = setTimeout(() => finish('timeout no handshake'), STEP_TIMEOUT_MS)
  })
}

// ---------------------------------------------------------------------------
;(async () => {
  const picked = SCENARIOS.filter((s) => !ONLY.length || ONLY.includes(s.name))
  // O resumo é CUMULATIVO: rodar `--only <um cenário>` não apaga a evidência
  // dos outros (a sonda é cara em turno; re-rodar tudo por bobagem é desperdício).
  let previous = []
  try {
    previous = JSON.parse(readFileSync(SUMMARY, 'utf8')).runs ?? []
  } catch {}
  const report = { probedAt: new Date().toISOString(), cli: 'claude', runs: [] }

  for (const sc of picked) {
    process.stderr.write(`\n[sonda] cenário "${sc.name}" — ${sc.why}\n`)
    const r = await runScenario(sc)
    report.runs.push(r)
    console.log(`\n=== ${sc.name} ===`)
    if (r.caps.received) console.log(`modelos com supportsFastMode: ${r.caps.fastCapable.join(', ') || '(nenhum)'}`)
    for (const st of r.steps) {
      console.log(`  passo ${st.index} [${st.kind}] "${st.sent}"`)
      if (st.init)
        console.log(
          `    init : model=${st.init.model} fast_mode_state=${st.init.fast_mode_state} reason=${st.init.fast_mode_disabled_reason}`
        )
      if (st.result)
        console.log(
          `    result: fast_mode_state=${st.result.fast_mode_state} reason=${st.result.fast_mode_disabled_reason} custo=${st.result.total_cost_usd}`
        )
      if (st.result?.text) console.log(`    texto : ${st.result.text}`)
      if (st.timedOut) console.log('    (TIMEOUT — nenhum result chegou)')
    }
    if (r.error) console.log(`  ERRO: ${r.error}`)
    console.log(`  fim: ${r.stopReason}`)
  }

  // Reaproveita o que não rodou agora (sem duplicar nome de cenário).
  const freshNames = new Set(report.runs.map((r) => r.scenario))
  report.runs = [...report.runs, ...previous.filter((r) => !freshNames.has(r.scenario))]

  // ————— veredito mecânico —————
  const optinTurn = report.runs.find((r) => r.scenario === 'optin-turn')
  const plain = report.runs.find((r) => r.scenario === 'plain-slash')
  const toggle = report.runs.find((r) => r.scenario === 'optin-toggle')
  const stateOf = (run, i) => run?.steps?.[i]?.result?.fast_mode_state ?? run?.steps?.[i]?.init?.fast_mode_state
  report.verdict = {
    handshakeDeclaresFast: report.runs.some((r) => r.caps.fastCapable?.length > 0),
    settingsKeyTurnsFastOn: stateOf(optinTurn, 0) === 'on',
    slashWithoutOptIn: plain?.steps?.[0]?.result?.text ?? null,
    liveToggleOff: stateOf(toggle, 1) ?? null,
    liveToggleOn: stateOf(toggle, 3) ?? null,
    receiptFields: ['fast_mode_state', 'fast_mode_disabled_reason']
  }
  report.verdict.liveToggleWorks =
    report.verdict.liveToggleOff === 'off' && report.verdict.liveToggleOn === 'on'

  writeFileSync(SUMMARY, JSON.stringify(report, null, 2))
  console.log('\n=== VEREDITO ===')
  console.log(JSON.stringify(report.verdict, null, 2))
  console.log(`\nresumo: ${SUMMARY}`)
  process.exit(0)
})()
