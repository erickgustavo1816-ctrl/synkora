// SONDA — O RECIBO DE LEITURA DA FALA DO DONO (R39.1, sondas 1 e 2 do design
// `.synkora/reports/DESIGN_FALA_DO_DONO_SEM_PARAR_R39_1_2026-09-02.md`).
//
// Decisão do dono (02/09): *"pode ser sem parar, puro. Aí minha mensagem vai
// ficar lá. Só que eu quero que tenha alguma coisa, tipo que ela não foi lida
// ainda… E se eu quiser eu posso forçar, aí forçando ele para o turno e lê o
// que eu quero falar, quando for algo urgente."*
//
// O produto precisa de DUAS verdades que só o binário dá:
//
//   receipt          Com o turno aberto (duas `Bash sleep 4`), empurrar uma
//                    mensagem no stdin: o CLI emite ALGUM frame quando ABSORVE
//                    a fala (um `user` com bloco `text`? um `system` com
//                    subtype? nada)? E quanto tempo separa a absorção da
//                    CITAÇÃO pelo modelo? Se o eco existir, ele é o RECIBO de
//                    D2' — hoje o `MaestroSession` ignora `user` sem
//                    `tool_result` (≈ linha 1600) e jogaria o recibo fora.
//   interrupt-queued Empurrar a mensagem e mandar `control_request interrupt`
//                    ANTES da fronteira: a fala enfileirada vira o turno
//                    seguinte sozinha, ou some? E o que o `result` interrompido
//                    carrega? É o que decide D4'.a (o harness manda só o
//                    envelope curto) contra D4'.b (o harness re-entrega a
//                    cópia do pote com o envelope inteiro).
//
// A DETECÇÃO DO ECO é estrutural, nunca heurística sobre conteúdo: a sonda
// procura o TEXTO EXATO que ela mesma empurrou dentro de cada linha crua da
// stdout, e reporta o tipo/subtype do frame que o contém. Nada de adivinhar
// intenção do modelo.
//
// Frames crus em `.tmp/probe-steer-receipt/*.jsonl`; resumo em `summary.json`.
// Roda em `--model haiku` (barato), numa pasta temporária — NUNCA num worktree
// de missão. Sem CLAUDE_CONFIG_DIR no ambiente, usa o seat logado (só leitura).
//
// Uso: node scripts/probe-claude-steer-receipt.mjs [--only receipt,interrupt-queued]
//      [--model haiku] [--timeout 180]

import { spawn, execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(process.argv[1], '..', '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-steer-receipt')
const WS = join(OUT_DIR, 'ws')
const SUMMARY = join(OUT_DIR, 'summary.json')

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const MODEL = flagValue('model') || 'haiku'
const STEP_TIMEOUT_MS = Number(flagValue('timeout') || 180) * 1000
const ONLY = (flagValue('only') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// O seat logado do dono, só leitura (o mesmo da sonda do PreToolUse).
const FALLBACK_CONFIG_DIR =
  'C:\\Users\\Erick\\AppData\\Roaming\\synkora\\seats\\37ee371a-3e49-4b82-bf74-947986d61a41'

mkdirSync(WS, { recursive: true })

/** A fala "do dono": ela CARREGA um marcador estrutural (`MID-TURN CHECK`) que a
 *  sonda procura byte a byte nas linhas cruas, e um sentinela (`BANANA`) que só
 *  aparece se o MODELO a leu. Os dois medem coisas diferentes: o primeiro é o
 *  ECO do CLI, o segundo é a LEITURA do modelo. */
const OWNER_MARKER = 'MID-TURN CHECK'
const OWNER_TEXT = `${OWNER_MARKER}: the moment you read this, include the single word BANANA in your very next reply text.`

const clip = (v, n = 300) =>
  typeof v === 'string' ? (v.length > n ? `${v.slice(0, n)}…[+${v.length - n}]` : v) : v

// ---------------------------------------------------------------------------
// Um cenário = um processo claude dirigido como o `maestroSession` dirige.
// ---------------------------------------------------------------------------
function runScenario(name, opts) {
  return new Promise((done) => {
    const capture = join(OUT_DIR, `${name}.jsonl`)
    writeFileSync(capture, '')

    const env = { ...process.env }
    for (const k of Object.keys(env)) if (/^CLAUDE_CODE_/i.test(k)) delete env[k]
    delete env.CLAUDECODE
    delete env.NO_COLOR
    delete env.FORCE_COLOR
    env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || FALLBACK_CONFIG_DIR

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      '--model',
      MODEL
    ]

    // A CHAVE DO RECIBO: o binário (2.1.258) declara `msg_lifecycle_v1` no
    // `system/init` e o schema dele diz, com todas as letras, que "comandos
    // enfileirados SEM uuid não emitem evento de ciclo de vida". Carimbar o
    // uuid do NOSSO messageId é o que liga o recibo.
    const firstUuid = randomUUID()
    const ownerUuid = randomUUID()

    const out = {
      scenario: name,
      spawnArgs: args,
      stampUuid: opts.stampUuid === true,
      firstUuid,
      ownerUuid,
      frameTypes: {},
      timeline: [],
      /** Todo frame cuja linha CRUA contém o marcador da fala — o candidato a recibo. */
      echoFrames: [],
      /** Os `command_lifecycle` (o recibo estruturado), na ordem. */
      lifecycle: [],
      /** O corpo da resposta do `control_request interrupt` (still_queued/cancelled). */
      interruptResponse: null,
      capabilities: null,
      assistantTexts: [],
      results: [],
      msPush: null,
      msFirstEcho: null,
      msCited: null,
      msInterruptSent: null,
      turnsAfterInterrupt: 0,
      error: null
    }

    const child = spawn('claude', args, { cwd: WS, env, shell: process.platform === 'win32' })
    let buf = ''
    let finished = false
    let injected = false
    let interruptSent = false
    let quietTimer = null

    const t0 = Date.now()
    const mark = (what) => out.timeline.push(`${Date.now() - t0}ms ${what}`)
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
      clearTimeout(killTimer)
      if (quietTimer) clearTimeout(quietTimer)
      out.stopReason = reason
      try {
        child.stdin.end()
      } catch {}
      try {
        child.kill()
      } catch {}
      setTimeout(() => done(out), 300)
    }
    const killTimer = setTimeout(() => finish('timeout global'), STEP_TIMEOUT_MS)

    /** A JANELA DE SILÊNCIO: depois do 1º `result` o cenário ainda espera, porque
     *  a pergunta é justamente se um TURNO NOVO nasce sozinho da fila do CLI. */
    const armQuiet = (ms, why) => {
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish(why), ms)
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
    child.stderr.on('data', (d) => process.stderr.write(`  [${name}:stderr] ${d}`))
    child.on('error', (e) => {
      out.error = `spawn falhou: ${e.message}`
      finish('erro de spawn')
    })
    child.on('close', (code) => finish(`o CLI encerrou (exit ${code})`))

    function handleLine(line) {
      appendFileSync(capture, line + '\n')
      const at = Date.now() - t0
      let evt
      try {
        evt = JSON.parse(line)
      } catch {
        return
      }
      const tag = evt.type === 'system' ? `system/${evt.subtype}` : evt.type
      out.frameTypes[tag] = (out.frameTypes[tag] || 0) + 1

      // O ECO: a linha CRUA traz o texto que a sonda empurrou. Sinal estrutural
      // (substring do que nós escrevemos), não leitura de intenção.
      if (injected && line.includes(OWNER_MARKER)) {
        out.echoFrames.push({
          at,
          tag,
          // O molde do frame importa tanto quanto o tipo: um `user` com bloco
          // `text` é recibo utilizável; um `user` com `tool_result` não é.
          contentShape: shapeOf(evt),
          raw: clip(line, 600)
        })
        if (out.msFirstEcho === null && !isEchoOfOurOwnWrite(evt)) {
          out.msFirstEcho = at
          mark(`ECO da fala em ${tag} (${shapeOf(evt)})`)
        }
      }

      if (evt.type === 'system' && evt.subtype === 'init' && out.capabilities === null) {
        out.capabilities = evt.capabilities ?? []
        mark(`capabilities: ${JSON.stringify(out.capabilities)}`)
      }

      if (evt.type === 'command_lifecycle') {
        const which =
          evt.command_uuid === ownerUuid
            ? 'FALA DO DONO'
            : evt.command_uuid === firstUuid
              ? 'mensagem 1'
              : 'desconhecida'
        out.lifecycle.push({ at, state: evt.state, command_uuid: evt.command_uuid, which })
        mark(`command_lifecycle ${evt.state} (${which})`)
        return
      }

      if (evt.type === 'control_response' && evt.response?.request_id === 'probe-interrupt') {
        out.interruptResponse = evt.response
        mark(`resposta do interrupt: ${clip(JSON.stringify(evt.response), 400)}`)
        return
      }

      if (evt.type === 'control_response' && evt.response?.request_id === 'init') {
        mark('handshake ok')
        send({
          type: 'user',
          message: { role: 'user', content: opts.firstMessage },
          // `ownerOnly`: o caminho DE PRODUTO — só a fala do dono é carimbada,
          // e é preciso provar que o ciclo de vida é POR COMANDO (a mensagem
          // sem uuid ao lado não pode calar o recibo da que tem).
          ...(opts.stampUuid && !opts.ownerOnly ? { uuid: firstUuid } : {})
        })
        mark('mensagem 1 enviada')
        return
      }

      if (evt.type === 'control_request' && evt.request?.subtype === 'can_use_tool') {
        mark(`can_use_tool (${evt.request.tool_name})`)
        send({
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: evt.request_id,
            response: { behavior: 'allow', updatedInput: evt.request.input }
          }
        })
        return
      }

      if (evt.type === 'assistant') {
        for (const block of evt.message?.content ?? []) {
          if (block?.type === 'text' && block.text) {
            out.assistantTexts.push({ at, text: clip(block.text) })
            if (/banana/i.test(block.text)) {
              if (out.msCited === null) out.msCited = at
              mark(`o modelo CITOU a fala (BANANA) — results até aqui: ${out.results.length}`)
            } else mark(`texto do assistente (${block.text.length} chars)`)
          }
          if (block?.type === 'tool_use') {
            mark(`tool_use ${block.name}`)
            if (opts.injectAfterFirstTool && !injected) {
              injected = true
              setTimeout(() => {
                send({
                  type: 'user',
                  message: { role: 'user', content: OWNER_TEXT },
                  ...(opts.stampUuid ? { uuid: ownerUuid } : {})
                })
                out.msPush = Date.now() - t0
                mark('fala do dono EMPURRADA no stdin')
                // Sonda 2: o corte vem logo atrás, ANTES de a fronteira da tool
                // chegar — é assim que o "ler agora" do dono vai acontecer.
                if (opts.interruptAfterPushMs !== undefined) {
                  setTimeout(() => {
                    interruptSent = true
                    out.msInterruptSent = Date.now() - t0
                    send({
                      type: 'control_request',
                      request_id: 'probe-interrupt',
                      request: { subtype: 'interrupt' }
                    })
                    mark('control_request interrupt enviado')
                  }, opts.interruptAfterPushMs)
                }
              }, opts.pushDelayMs ?? 1500)
            }
          }
        }
        return
      }

      if (evt.type === 'result') {
        out.results.push({
          at,
          subtype: evt.subtype,
          is_error: evt.is_error ?? null,
          num_turns: evt.num_turns ?? null,
          duration_ms: evt.duration_ms ?? null,
          result: clip(typeof evt.result === 'string' ? evt.result : JSON.stringify(evt.result ?? null), 400),
          keys: Object.keys(evt)
        })
        if (interruptSent && out.msInterruptSent !== null && at > out.msInterruptSent)
          out.turnsAfterInterrupt += 1
        mark(`result #${out.results.length} (${evt.subtype})`)
        // Sempre espera a janela de silêncio: a pergunta do cenário é se algo
        // NASCE depois — turno novo do CLI, ou nada.
        armQuiet(opts.quietMs ?? 25_000, 'janela de silêncio fechou')
      }
    }

    /** O molde do frame `user`: é ele que diz se o eco serve de recibo. */
    function shapeOf(evt) {
      if (evt.type !== 'user') return evt.type === 'system' ? `system/${evt.subtype}` : evt.type
      const content = evt.message?.content
      if (typeof content === 'string') return 'user/string'
      if (!Array.isArray(content)) return 'user/?'
      return `user/[${[...new Set(content.map((b) => b?.type ?? '?'))].join('+')}]`
    }

    /** O CLI ecoa de volta, na hora, o que a gente escreveu no stdin (o frame de
     *  ida). Esse não é recibo de ABSORÇÃO: ele sai antes da fronteira. Marcamos
     *  como eco "nosso" o que chega em menos de 250ms do push. */
    function isEchoOfOurOwnWrite(evt) {
      if (out.msPush === null) return false
      return evt.type === 'user' && Date.now() - t0 - out.msPush < 250
    }

    send({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })
  })
}

// ---------------------------------------------------------------------------
;(async () => {
  const report = { probedAt: new Date().toISOString(), cliVersion: null, model: MODEL, runs: [] }
  try {
    report.cliVersion = execSync('claude --version', { shell: true }).toString().trim()
  } catch {}
  report.configDir = process.env.CLAUDE_CONFIG_DIR || FALLBACK_CONFIG_DIR

  const wants = (n) => !ONLY.length || ONLY.includes(n)
  const TWO_SLEEPS =
    'Use the Bash tool to run exactly `sleep 4`. When it finishes, use the Bash tool again to run `sleep 4`. Then reply with exactly: DONE'

  if (wants('receipt')) {
    process.stderr.write('\n[sonda 1a] receipt — SEM uuid: o CLI emite algum frame ao absorver?\n')
    report.runs.push(
      await runScenario('receipt', { firstMessage: TWO_SLEEPS, injectAfterFirstTool: true })
    )
  }

  if (wants('receipt-uuid')) {
    process.stderr.write(
      '\n[sonda 1b] receipt-uuid — COM uuid carimbado: nascem os `command_lifecycle`?\n'
    )
    report.runs.push(
      await runScenario('receipt-uuid', {
        firstMessage: TWO_SLEEPS,
        injectAfterFirstTool: true,
        stampUuid: true
      })
    )
  }

  if (wants('receipt-owner-only')) {
    process.stderr.write(
      '\n[sonda 1c] receipt-owner-only — SÓ a fala do dono carimbada (o caminho de produto)\n'
    )
    report.runs.push(
      await runScenario('receipt-owner-only', {
        firstMessage: TWO_SLEEPS,
        injectAfterFirstTool: true,
        stampUuid: true,
        ownerOnly: true
      })
    )
  }

  if (wants('interrupt-queued')) {
    process.stderr.write(
      '\n[sonda 2] interrupt-queued — corte com fala na fila: ela vira turno novo ou some?\n'
    )
    report.runs.push(
      await runScenario('interrupt-queued', {
        firstMessage: TWO_SLEEPS,
        injectAfterFirstTool: true,
        stampUuid: true,
        interruptAfterPushMs: 400,
        quietMs: 30_000
      })
    )
  }

  const byName = (n) => report.runs.find((r) => r.scenario === n)
  const receipt = byName('receipt-uuid') ?? byName('receipt')
  const cut = byName('interrupt-queued')
  /** O recibo estruturado da fala do dono: o `started` do uuid dela. */
  const ownerStarted = (r) =>
    r ? (r.lifecycle.find((l) => l.which === 'FALA DO DONO' && l.state === 'started') ?? null) : null

  report.verdict = {
    capabilities: receipt?.capabilities ?? null,
    lifecycleWithoutUuid: byName('receipt') ? byName('receipt').lifecycle.length : null,
    lifecycleWithUuid: byName('receipt-uuid') ? byName('receipt-uuid').lifecycle : null,
    ownerStartedAt: ownerStarted(receipt)?.at ?? null,
    msPushToOwnerStarted:
      ownerStarted(receipt) && receipt.msPush !== null ? ownerStarted(receipt).at - receipt.msPush : null,
    msOwnerStartedToCitation:
      ownerStarted(receipt) && receipt.msCited !== null
        ? receipt.msCited - ownerStarted(receipt).at
        : null,
    // Existe eco de absorção (frame que carrega a fala, fora do eco imediato do
    // nosso próprio write)?
    absorptionEchoExists: receipt ? receipt.msFirstEcho !== null : null,
    absorptionEchoFrames: receipt ? receipt.echoFrames.map((e) => `${e.at}ms ${e.contentShape}`) : null,
    msPushToEcho:
      receipt && receipt.msFirstEcho !== null && receipt.msPush !== null
        ? receipt.msFirstEcho - receipt.msPush
        : null,
    msPushToCitation:
      receipt && receipt.msCited !== null && receipt.msPush !== null
        ? receipt.msCited - receipt.msPush
        : null,
    msEchoToCitation:
      receipt && receipt.msCited !== null && receipt.msFirstEcho !== null
        ? receipt.msCited - receipt.msFirstEcho
        : null,
    citedInsideSameTurn: receipt ? receipt.msCited !== null && receipt.results.length <= 1 : null,
    // Sonda 2 — o que decide D4'.a x D4'.b.
    interruptedResult: cut ? (cut.results[0] ?? null) : null,
    interruptResponse: cut?.interruptResponse ?? null,
    /** O contrato `interrupt_receipt_v1`: quem SOBREVIVE ao corte. */
    stillQueued: cut?.interruptResponse?.response?.still_queued ?? null,
    lifecycleAfterInterrupt: cut
      ? cut.lifecycle.filter((l) => cut.msInterruptSent !== null && l.at >= cut.msInterruptSent)
      : null,
    turnsAfterInterrupt: cut ? cut.turnsAfterInterrupt : null,
    queuedBecomesNextTurn: cut
      ? cut.lifecycle.some((l) => l.which === 'FALA DO DONO' && l.state === 'started') &&
        cut.turnsAfterInterrupt > 0
      : null,
    citedAfterInterrupt:
      cut && cut.msCited !== null && cut.msInterruptSent !== null
        ? cut.msCited > cut.msInterruptSent
        : null
  }

  let previous = []
  try {
    previous = JSON.parse(readFileSync(SUMMARY, 'utf8')).runs ?? []
  } catch {}
  const fresh = new Set(report.runs.map((r) => r.scenario))
  report.runs = [...report.runs, ...previous.filter((r) => !fresh.has(r.scenario))]
  writeFileSync(SUMMARY, JSON.stringify(report, null, 2))

  console.log('\n=== VEREDITO ===')
  console.log(JSON.stringify(report.verdict, null, 2))
  for (const r of report.runs) {
    console.log(`\n=== ${r.scenario} (${r.stopReason ?? '?'}) ===`)
    console.log('  frames: ' + JSON.stringify(r.frameTypes))
    for (const line of r.timeline) console.log('  ' + line)
    for (const l of r.lifecycle ?? [])
      console.log(`  LIFECYCLE ${l.at}ms ${l.state} (${l.which})`)
    for (const e of r.echoFrames ?? []) console.log(`  ECO ${e.at}ms ${e.contentShape}: ${e.raw}`)
    for (const t of r.assistantTexts ?? []) console.log(`  TEXTO ${t.at}ms: ${t.text}`)
    for (const res of r.results ?? []) console.log('  RESULT ' + JSON.stringify(res))
    if (r.error) console.log('  ERRO: ' + r.error)
  }
  console.log(`\nresumo: ${SUMMARY}`)
  process.exit(0)
})()
