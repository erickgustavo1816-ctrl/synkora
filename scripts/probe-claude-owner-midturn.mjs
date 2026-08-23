// SONDA — a fala do dono alcança o modelo NO MEIO do turno de um pane claude
// SEM frota? (queixa do dono, 2026-08-23: "eu mando mensagem e ele lê 3 horas
// depois")
//
// O buraco conhecido (R22, 19/08): mensagem empurrada pro stdin do stream-json
// fica na fila INTERNA do CLI até o turno fechar; a carona da R22 só existe em
// resultado de tool do NOSSO servidor MCP — pane dev usando Read/Bash nativos
// nunca passa por lá. Esta sonda mede, no binário real (2.1.241), as DUAS
// saídas candidatas:
//
//   stdin-steer   o CLI de hoje já steera? (mensagem no stdin no meio de um
//                 turno com duas Bash `sleep 4` — o BANANA aparece ANTES do
//                 primeiro `result`?)  Se sim: a correção é só rotear o envio.
//   hook-context  hook PostToolUse (via --settings) devolvendo
//                 hookSpecificOutput.additionalContext — o texto alcança o
//                 modelo no MESMO turno, depois de uma tool NATIVA (Read)?
//                 Se sim: é a carona GERAL — qualquer tool, qualquer pane.
//                 Fallback automático: se additionalContext não chegar, tenta
//                 a forma decision:"block"+reason (hook-block).
//
// Capturas cruas em .tmp/probe-owner-midturn/*.jsonl; resumo em summary.json.
// Roda em --model haiku (barato). Não toca em arquivo de produto; usa o
// CLAUDE_CONFIG_DIR herdado — aponte um seat de teste pelo ambiente se quiser.
//
// Uso: node scripts/probe-claude-owner-midturn.mjs [--only stdin-steer,hook-context]
//      [--model haiku] [--timeout 120]

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(process.argv[1], '..', '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-owner-midturn')
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
const STEP_TIMEOUT_MS = Number(flagValue('timeout') || 150) * 1000
const ONLY = (flagValue('only') || '').split(',').map((s) => s.trim()).filter(Boolean)

mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'sample.txt'), 'the quick brown fox says hello\n')

const HOOK_RAN_LOG = join(OUT_DIR, 'hook-ran.log')
const HOOK_MAIL = join(OUT_DIR, 'hookmail.json')
const HOOK_PS1 = join(OUT_DIR, 'hook.ps1')
const SETTINGS_FILE = join(OUT_DIR, 'probe-settings.json')

const OWNER_LINE =
  '[synkora] MENSAGEM DO DONO (chegou agora, no meio do turno): reply including the single word BANANA in your very next text, then continue the task.'

function writeHookFixtures(shape) {
  rmSync(HOOK_RAN_LOG, { force: true })
  const payload =
    shape === 'additionalContext'
      ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: OWNER_LINE } }
      : { decision: 'block', reason: OWNER_LINE }
  writeFileSync(HOOK_MAIL, JSON.stringify(payload))
  // PowerShell aceita barra normal em -File; caminhos sem espaço de propósito.
  writeFileSync(
    HOOK_PS1,
    [
      `Add-Content -Path '${HOOK_RAN_LOG}' -Value 'ran'`,
      `Get-Content -Raw '${HOOK_MAIL}'`
    ].join('\n')
  )
  writeFileSync(
    SETTINGS_FILE,
    JSON.stringify({
      hooks: {
        PostToolUse: [
          {
            matcher: '.*',
            hooks: [
              {
                type: 'command',
                command: `powershell -NoProfile -ExecutionPolicy Bypass -File ${HOOK_PS1.replace(/\\/g, '/')}`,
                timeout: 15
              }
            ]
          }
        ]
      }
    })
  )
}

const clip = (v, n = 300) =>
  typeof v === 'string' ? (v.length > n ? `${v.slice(0, n)}…[+${v.length - n}]` : v) : v

// ---------------------------------------------------------------------------
// Um cenário = um processo claude dirigido como o maestroSession dirige.
// `plan` recebe hooks do fio e devolve o que fazer; o esqueleto cuida do resto.
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
    if (opts.settingsFile) args.push('--settings', opts.settingsFile)

    const out = {
      scenario: name,
      spawnArgs: args,
      frameTypes: {},
      timeline: [], // marcos na ORDEM real — é a ordem que decide o veredito
      assistantTexts: [],
      results: 0,
      bananaBeforeFirstResult: false,
      bananaEver: false,
      error: null
    }

    const child = spawn('claude', args, { cwd: WS, env, shell: process.platform === 'win32' })
    let buf = ''
    let finished = false
    let allowedTools = 0
    let injected = false

    const send = (obj) => {
      try {
        child.stdin.write(JSON.stringify(obj) + '\n')
      } catch (e) {
        out.error = `stdin: ${e.message}`
      }
    }
    const mark = (what) => out.timeline.push(`${Date.now() - t0}ms ${what}`)

    const finish = (reason) => {
      if (finished) return
      finished = true
      clearTimeout(killTimer)
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
      let evt
      try {
        evt = JSON.parse(line)
      } catch {
        return
      }
      const tag = evt.type === 'system' ? `system/${evt.subtype}` : evt.type
      out.frameTypes[tag] = (out.frameTypes[tag] || 0) + 1
      if (/hook/i.test(tag)) mark(`frame ${tag}`)

      if (evt.type === 'control_response' && evt.response?.request_id === 'init') {
        mark('handshake ok')
        send({ type: 'user', message: { role: 'user', content: opts.firstMessage } })
        mark('mensagem 1 enviada')
        return
      }

      if (evt.type === 'control_request' && evt.request?.subtype === 'can_use_tool') {
        allowedTools += 1
        mark(`can_use_tool #${allowedTools} (${evt.request.tool_name})`)
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
            out.assistantTexts.push(clip(block.text))
            const hasBanana = /banana/i.test(block.text)
            if (hasBanana) {
              out.bananaEver = true
              if (out.results === 0) out.bananaBeforeFirstResult = true
              mark(`BANANA no texto (results até aqui: ${out.results})`)
            } else {
              mark(`texto do assistente (${block.text.length} chars)`)
            }
          }
          if (block?.type === 'tool_use') {
            mark(`tool_use ${block.name}`)
            // O gatilho da injeção é o PRIMEIRO tool_use (a permissão pode nem
            // ser pedida — settings do dono auto-permitem Bash — e o gatilho por
            // can_use_tool deixou a sonda muda na 1ª rodada).
            if (opts.injectAfterFirstTool && !injected) {
              injected = true
              setTimeout(() => {
                send({ type: 'user', message: { role: 'user', content: opts.injectAfterFirstTool } })
                mark('mensagem 2 (mid-turn) empurrada no stdin')
              }, 1500)
            }
          }
        }
        return
      }

      if (evt.type === 'result') {
        out.results += 1
        mark(`result #${out.results} (${evt.subtype})`)
        // O 1º result fecha o turno-fortaleza; se o cenário espera fila, o 2º
        // turno (a mensagem 2 drenada) ainda vem — espere um pouco por ele.
        if (out.results >= (opts.expectedResults ?? 1)) finish('resultados esperados chegaram')
        else
          setTimeout(() => {
            if (!finished && out.results < (opts.expectedResults ?? 1)) finish('só veio 1 result')
          }, 45_000)
      }
    }

    const t0 = Date.now()
    send({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })
  })
}

// ---------------------------------------------------------------------------
;(async () => {
  const report = { probedAt: new Date().toISOString(), cliVersion: null, model: MODEL, runs: [] }
  try {
    report.cliVersion = (await import('node:child_process')).execSync('claude --version', { shell: true })
      .toString()
      .trim()
  } catch {}

  const wants = (n) => !ONLY.length || ONLY.includes(n)

  if (wants('stdin-steer')) {
    process.stderr.write('\n[sonda] stdin-steer — mensagem no stdin no meio do turno: steera ou fila?\n')
    const r = await runScenario('stdin-steer', {
      firstMessage:
        'Use the Bash tool to run exactly `sleep 4`. When it finishes, use the Bash tool again to run `sleep 4`. Then reply with exactly: DONE',
      injectAfterFirstTool:
        'MID-TURN CHECK: the moment you read this, include the single word BANANA in your very next reply text.',
      expectedResults: 2
    })
    report.runs.push(r)
  }

  if (wants('hook-context')) {
    process.stderr.write('\n[sonda] hook-context — PostToolUse additionalContext alcança o modelo mid-turn?\n')
    writeHookFixtures('additionalContext')
    const r = await runScenario('hook-context', {
      settingsFile: SETTINGS_FILE,
      firstMessage:
        'Use the Read tool to read the file sample.txt in the current directory, then answer with its contents.',
      expectedResults: 1
    })
    r.hookRan = existsSync(HOOK_RAN_LOG)
    report.runs.push(r)

    if (!r.bananaEver) {
      process.stderr.write('\n[sonda] hook-block — fallback: decision:"block"+reason chega?\n')
      writeHookFixtures('block')
      const r2 = await runScenario('hook-block', {
        settingsFile: SETTINGS_FILE,
        firstMessage:
          'Use the Read tool to read the file sample.txt in the current directory, then answer with its contents.',
        expectedResults: 1
      })
      r2.hookRan = existsSync(HOOK_RAN_LOG)
      report.runs.push(r2)
    }
  }

  const byName = (n) => report.runs.find((r) => r.scenario === n)
  const steer = byName('stdin-steer')
  const hook = byName('hook-context')
  const hookBlock = byName('hook-block')
  report.verdict = {
    stdinSteersMidTurn: steer ? steer.bananaBeforeFirstResult : null,
    stdinDeliversAtTurnClose: steer ? steer.bananaEver && !steer.bananaBeforeFirstResult : null,
    hookFired: hook?.hookRan ?? null,
    hookAdditionalContextReachesModelMidTurn: hook ? hook.bananaBeforeFirstResult : null,
    hookBlockReachesModel: hookBlock ? hookBlock.bananaEver : null
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
    for (const line of r.timeline) console.log('  ' + line)
    if (r.error) console.log('  ERRO: ' + r.error)
  }
  console.log(`\nresumo: ${SUMMARY}`)
  process.exit(0)
})()
