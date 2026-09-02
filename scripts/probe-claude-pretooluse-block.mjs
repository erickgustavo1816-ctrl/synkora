// SONDA — QUAL FORMA DE BLOQUEIO o claude honra num hook `PreToolUse`
// declarado por `--settings`, e EM QUAL SHELL ele roda o comando do hook (D4 do
// DESIGN_FALA_DO_DONO_PARA_O_TURNO_2026-09-02).
//
// POR QUE ELA EXISTE (medido em 01/09, missão 86a05c06): entregue a fala do
// dono, o modelo (fable xhigh) fez SEIS chamadas de tool que a dívida de
// resposta do MCP recusou — helper_send×3, delegate×2, helpers_status — antes
// de escrever a primeira linha de texto. Ele tratou cada recusa como "essa
// tool falhou, tento outra". E as tools NATIVAS (Bash/Read/Edit/
// AskUserQuestion) nem passam pelo nosso MCP: ali a guarda não existe. O hook
// `PreToolUse` é o único ponto onde a casa alcança TODA tool do claude.
//
// A casa já provou o CANAL (probe-claude-owner-midturn, cenário `hook-context`,
// 23/08: hook declarado por `--settings` dispara num pane `-p` stream-json).
// O que falta é a FORMA — e forma se sonda no binário, nunca no doc:
//
//   deny-json     stdout {"hookSpecificOutput":{"hookEventName":"PreToolUse",
//                 "permissionDecision":"deny","permissionDecisionReason":…}}
//   legacy-block  stdout {"decision":"block","reason":…}
//   exit2-stderr  exit code 2 + o motivo em stderr
//   cmd-shim      a MESMA forma deny-json, mas com o comando escrito em `cmd
//                 /c` — a suposição de partida do design, que esta sonda
//                 DERRUBOU (veja abaixo)
//   no-debt       o hook instalado com a bandeira AUSENTE: a tool tem que
//                 rodar normalmente (o caminho de 99% dos passos)
//   inline-args   a forma vencedora com o `--settings` INLINE e
//                 duplamente-aspeado do `maestroSession` (é ASSIM que a
//                 produção passa o hook; cmd.exe come JSON cru no caminho)
//
// A DESCOBERTA QUE MUDA O PRODUTO: o claude NÃO roda o comando do hook em
// cmd.exe no Windows — ele roda em `/usr/bin/bash` (o git-bash). O
// `--debug-file` do próprio binário entrega a prova ("Hook PreToolUse:Read
// (PreToolUse) error:\n/usr/bin/bash: line 1: …"). Um comando `cmd /c …` sob
// bash devolve o BANNER do cmd em vez do JSON e o claude o trata como texto
// puro — bloqueio nenhum. Por isso o comando de produto é POSIX
// (`if [ -f "…" ]; then cat "…"; fi`) com o caminho em barra normal.
//
// VEREDITO = a tool NÃO rodou (o conteúdo do arquivo não aparece) E o motivo
// ALCANÇOU o modelo (ele responde citando a fala do dono). Bloquear sem o
// motivo chegar seria pior que não bloquear: beco sem saída é bug nesta casa.
//
// Capturas cruas em .tmp/probe-pretooluse-block/*.jsonl, o diário de debug do
// próprio claude em *.debug.log, resumo em summary.json. Roda em --model haiku
// (barato) numa pasta TEMPORÁRIA — nunca no worktree de missão do dono. Usa o
// CLAUDE_CONFIG_DIR herdado; sem ele, o seat claude logado (só leitura — a
// sonda não escreve settings lá).
//
// Uso: node scripts/probe-claude-pretooluse-block.mjs
//        [--only deny-json,inline-args] [--model haiku] [--timeout 150]

import { spawn, spawnSync, execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(process.argv[1], '..', '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-pretooluse-block')
const WS = join(OUT_DIR, 'ws')
const SUMMARY = join(OUT_DIR, 'summary.json')

/** O seat claude LOGADO (só leitura). Só entra se o ambiente não trouxer um. */
const FALLBACK_CONFIG_DIR =
  'C:\\Users\\Erick\\AppData\\Roaming\\synkora\\seats\\37ee371a-3e49-4b82-bf74-947986d61a41'

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

// O sentinela do CONTEÚDO só aparece se a tool RODOU (bloqueio furado). O do
// MOTIVO é uma palavra que só existe na fala citada do dono — de propósito NÃO
// é uma ordem de eco: na 1ª rodada, "responda com a palavra X" fez o modelo
// levantar bandeira de PROMPT INJECTION contra a própria casa.
const FILE_SENTINEL = 'MANGOSTAO'
const OWNER_ECHO = 'CARAMBOLA'

const REFUSAL_TEXT =
  'PARE: o DONO falou no meio deste turno e ainda não ouviu resposta. TODAS as suas tools ' +
  '— nativas e do Synkora — estão bloqueadas até você escrever, como TEXTO no chat, uma ou ' +
  'duas linhas dizendo o que entendeu e o que muda. O que ele disse:\n' +
  `"para tudo, o projeto ${OWNER_ECHO} passa na frente"`

mkdirSync(WS, { recursive: true })
writeFileSync(join(WS, 'sample.txt'), `${FILE_SENTINEL} the quick brown fox\n`)

const FLAG_DIR = join(OUT_DIR, 'owner-debt')
mkdirSync(FLAG_DIR, { recursive: true })
const FLAG_PATH = join(FLAG_DIR, 'probe-pane.txt')
const SETTINGS_FILE = join(OUT_DIR, 'probe-settings.json')

// ---------------------------------------------------------------------------
// OS COMANDOS CANDIDATOS.
//
// `posix` é o que vira produto: nenhum metacaractere de cmd (`& < > ( ) @ ^ |
// %`) porque o mesmo texto ainda precisa atravessar o `--settings` inline sob
// `shell: true`, onde o cmd alterna o estado de aspas a CADA `"` — inclusive
// nas escapadas — e lê o conteúdo das strings do JSON como se estivesse FORA
// de aspas. Escrever na STDOUT e sair com 0 mata a necessidade de `1>&2` e de
// `&`; a decisão viaja no JSON do ARQUIVO.
const posixCommand = (flagPath) => {
  const p = flagPath.replace(/\\/g, '/')
  return `if [ -f "${p}" ]; then cat "${p}"; fi`
}
const posixExit2Command = (flagPath) => {
  const p = flagPath.replace(/\\/g, '/')
  return `if [ -f "${p}" ]; then cat "${p}" 1>&2; exit 2; fi`
}
/** A suposição de partida do design — medida para ficar registrado que FALHA. */
const cmdShimCommand = (flagPath) => `cmd /c if exist "${flagPath}" type "${flagPath}"`

/** O bloco `hooks` do settings — matcher `*` (TODA tool, nativa inclusive). */
const hookSettings = (command) => ({
  hooks: {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 10 }] }]
  }
})

/** O conteúdo da bandeira por forma. ASCII puro de propósito: o arquivo viaja
 *  por `cat` até o parser do claude, e `\uXXXX` é JSON válido imune a qualquer
 *  história de codepage. (O em-dash cru também passou na medição — o escape é
 *  cinto, não muleta.) */
function flagContent(shape) {
  if (shape === 'legacy-block') return asciiJson({ decision: 'block', reason: REFUSAL_TEXT })
  if (shape === 'exit2-stderr') return REFUSAL_TEXT // texto puro em stderr
  return asciiJson({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REFUSAL_TEXT
    }
  })
}

function asciiJson(value) {
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/gu,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

const armFlag = (shape) => writeFileSync(FLAG_PATH, flagContent(shape), 'utf8')
const clearFlag = () => rmSync(FLAG_PATH, { force: true })

const clip = (v, n = 400) =>
  typeof v === 'string' ? (v.length > n ? `${v.slice(0, n)}…[+${v.length - n}]` : v) : v

// ---------------------------------------------------------------------------
// Um cenário = um processo claude dirigido como o maestroSession dirige.
// ---------------------------------------------------------------------------
function runScenario(name, opts) {
  return new Promise((done) => {
    const capture = join(OUT_DIR, `${name}.jsonl`)
    const debugFile = join(OUT_DIR, `${name}.debug.log`)
    writeFileSync(capture, '')
    rmSync(debugFile, { force: true })

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
      MODEL,
      // O diário do PRÓPRIO binário é a testemunha: é ele que nomeia o shell do
      // hook e o `permissionBehavior` resultante.
      '--debug-file',
      debugFile
    ]
    // Duas maneiras de entregar o mesmo settings: por ARQUIVO (isola a forma do
    // bloqueio) ou INLINE duplamente-aspeado (a forma REAL do produto —
    // `maestroSession.ts`, o bloco do `--settings`).
    if (opts.settingsFile) args.push('--settings', opts.settingsFile)
    if (opts.settingsInline) {
      const json = JSON.stringify(opts.settingsInline)
      args.push('--settings', process.platform === 'win32' ? JSON.stringify(json) : json)
    }

    const out = {
      scenario: name,
      spawnArgs: args,
      frameTypes: {},
      timeline: [],
      assistantTexts: [],
      toolUses: [],
      results: 0,
      reasonReachedModel: false,
      toolActuallyRan: false,
      error: null
    }

    const child = spawn('claude', args, { cwd: WS, env, shell: process.platform === 'win32' })
    let buf = ''
    let finished = false

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
      out.wallMs = Date.now() - t0
      try {
        child.stdin.end()
      } catch {}
      try {
        child.kill()
      } catch {}
      setTimeout(() => {
        // As linhas de hook do diário do claude — a prova crua do veredito.
        const log = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : ''
        out.hookShell = /\/usr\/bin\/bash|\/bin\/sh|cmd\.exe/i.exec(log)?.[0] ?? null
        out.hookLog = log
          .split('\n')
          .filter((l) => /Hook (PreToolUse|result|output)|permissionBehavior|parsed and validated/i.test(l))
          .map((l) => clip(l.trim(), 320))
          .slice(0, 8)
        out.hookFired = out.hookLog.length > 0
        done(out)
      }, 400)
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

      if (evt.type === 'control_response' && evt.response?.request_id === 'init') {
        mark('handshake ok')
        send({ type: 'user', message: { role: 'user', content: opts.firstMessage } })
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

      if (evt.type === 'user') {
        // O resultado da tool volta como mensagem de usuário: é AQUI que se vê
        // se a leitura aconteceu (sentinela do arquivo) ou se o hook cortou.
        const raw = JSON.stringify(evt.message?.content ?? '')
        if (raw.includes(FILE_SENTINEL)) {
          out.toolActuallyRan = true
          mark('tool_result trouxe o CONTEUDO do arquivo (bloqueio NAO pegou)')
        }
        if (raw.includes(OWNER_ECHO)) mark('tool_result carrega o MOTIVO do hook')
        out.lastToolResult = clip(raw, 600)
        return
      }

      if (evt.type === 'assistant') {
        for (const block of evt.message?.content ?? []) {
          if (block?.type === 'text' && block.text) {
            out.assistantTexts.push(clip(block.text))
            if (block.text.includes(OWNER_ECHO)) {
              out.reasonReachedModel = true
              mark('o texto do assistente RESPONDE a fala do dono (o motivo chegou)')
            } else mark(`texto do assistente (${block.text.length} chars)`)
            if (block.text.includes(FILE_SENTINEL)) {
              out.toolActuallyRan = true
              mark('o texto ecoou o CONTEUDO do arquivo (bloqueio NAO pegou)')
            }
          }
          if (block?.type === 'tool_use') {
            out.toolUses.push(block.name)
            mark(`tool_use ${block.name}`)
          }
        }
        return
      }

      if (evt.type === 'result') {
        out.results += 1
        mark(`result #${out.results} (${evt.subtype})`)
        if (out.results >= (opts.expectedResults ?? 1)) finish('resultados esperados chegaram')
      }
    }

    const t0 = Date.now()
    send({ type: 'control_request', request_id: 'init', request: { subtype: 'initialize' } })
  })
}

const READ_TASK =
  'Use the Read tool to read the file sample.txt in the current directory. ' +
  'Then reply in one short line, quoting whatever the tool gave you back.'

/** O CUSTO do hook: ele roda antes de CADA tool, então o piso importa. Mede o
 *  comando cru no MESMO shell que o claude usa (bash), com bandeira presente e
 *  ausente. */
function measureHookOverhead(command, runs = 15) {
  const times = []
  for (let i = 0; i < runs; i += 1) {
    const t = process.hrtime.bigint()
    spawnSync('bash', ['-c', command], { windowsHide: true })
    times.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  times.sort((a, b) => a - b)
  return {
    runs,
    minMs: Number(times[0].toFixed(1)),
    medianMs: Number(times[Math.floor(runs / 2)].toFixed(1)),
    maxMs: Number(times[runs - 1].toFixed(1))
  }
}

// ---------------------------------------------------------------------------
;(async () => {
  const report = {
    probedAt: new Date().toISOString(),
    cliVersion: null,
    model: MODEL,
    platform: process.platform,
    configDir: process.env.CLAUDE_CONFIG_DIR || FALLBACK_CONFIG_DIR,
    commands: {
      posix: posixCommand(FLAG_PATH),
      posixExit2: posixExit2Command(FLAG_PATH),
      cmdShim: cmdShimCommand(FLAG_PATH)
    },
    runs: []
  }
  try {
    report.cliVersion = execSync('claude --version', { shell: true }).toString().trim()
  } catch {}

  const wants = (n) => !ONLY.length || ONLY.includes(n)

  // ---- as formas, medidas por ARQUIVO de settings (o cmd nunca toca no texto)
  const forms = [
    { name: 'deny-json', command: posixCommand(FLAG_PATH), flag: 'deny-json' },
    { name: 'legacy-block', command: posixCommand(FLAG_PATH), flag: 'legacy-block' },
    { name: 'exit2-stderr', command: posixExit2Command(FLAG_PATH), flag: 'exit2-stderr' },
    { name: 'cmd-shim', command: cmdShimCommand(FLAG_PATH), flag: 'deny-json' }
  ]
  for (const form of forms) {
    if (!wants(form.name)) continue
    process.stderr.write(`\n[sonda] ${form.name} — o claude honra esta forma?\n`)
    armFlag(form.flag)
    writeFileSync(SETTINGS_FILE, JSON.stringify(hookSettings(form.command), null, 2))
    const r = await runScenario(form.name, {
      settingsFile: SETTINGS_FILE,
      firstMessage: READ_TASK,
      expectedResults: 1
    })
    r.hookCommand = form.command
    r.flagContent = clip(flagContent(form.flag), 300)
    r.blocked = !r.toolActuallyRan
    r.honoured = r.blocked && r.reasonReachedModel
    report.runs.push(r)
  }

  // ---- o caminho de 99%: bandeira AUSENTE, a tool tem que rodar ----
  if (wants('no-debt')) {
    process.stderr.write('\n[sonda] no-debt — hook instalado, bandeira ausente: a tool passa?\n')
    clearFlag()
    writeFileSync(SETTINGS_FILE, JSON.stringify(hookSettings(posixCommand(FLAG_PATH)), null, 2))
    const r = await runScenario('no-debt', {
      settingsFile: SETTINGS_FILE,
      firstMessage: READ_TASK,
      expectedResults: 1
    })
    r.hookCommand = posixCommand(FLAG_PATH)
    r.blocked = !r.toolActuallyRan
    report.runs.push(r)
  }

  // ---- a forma escolhida pelo caminho REAL do produto (settings inline) ----
  if (wants('inline-args')) {
    process.stderr.write(
      '\n[sonda] inline-args — deny-json sobrevive ao --settings inline duplamente-aspeado?\n'
    )
    armFlag('deny-json')
    const r = await runScenario('inline-args', {
      settingsInline: hookSettings(posixCommand(FLAG_PATH)),
      firstMessage: READ_TASK,
      expectedResults: 1
    })
    r.hookCommand = posixCommand(FLAG_PATH)
    r.blocked = !r.toolActuallyRan
    r.honoured = r.blocked && r.reasonReachedModel
    report.runs.push(r)
  }

  // ---- o custo por chamada ----
  armFlag('deny-json')
  const overheadArmed = measureHookOverhead(posixCommand(FLAG_PATH))
  clearFlag()
  const overheadIdle = measureHookOverhead(posixCommand(FLAG_PATH))
  report.overheadMs = { armed: overheadArmed, idle: overheadIdle }

  const byName = (n) => report.runs.find((r) => r.scenario === n)
  report.verdict = {
    hookShell: report.runs.map((r) => r.hookShell).find(Boolean) ?? null,
    denyJsonHonoured: byName('deny-json')?.honoured ?? null,
    legacyBlockHonoured: byName('legacy-block')?.honoured ?? null,
    exit2StderrHonoured: byName('exit2-stderr')?.honoured ?? null,
    cmdShimHonoured: byName('cmd-shim')?.honoured ?? null,
    noDebtLetsToolRun: byName('no-debt') ? byName('no-debt').toolActuallyRan : null,
    inlineSettingsSurvivesCmd: byName('inline-args')?.honoured ?? null,
    hookOverheadIdleMedianMs: overheadIdle.medianMs
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
  console.log('\n=== CUSTO DO HOOK (comando cru, no shell do claude) ===')
  console.log(JSON.stringify(report.overheadMs, null, 2))
  for (const r of report.runs) {
    console.log(`\n=== ${r.scenario} (${r.stopReason ?? '?'}, ${r.wallMs ?? '?'}ms) ===`)
    console.log(`  comando: ${r.hookCommand ?? '—'}`)
    console.log(
      `  bloqueou: ${r.blocked} | motivo chegou: ${r.reasonReachedModel} | tool rodou: ${r.toolActuallyRan} | shell: ${r.hookShell ?? '—'}`
    )
    for (const line of r.timeline ?? []) console.log('  ' + line)
    for (const t of r.assistantTexts ?? []) console.log('  texto: ' + t)
    for (const l of r.hookLog ?? []) console.log('  claude: ' + l)
    if (r.error) console.log('  ERRO: ' + r.error)
  }
  console.log(`\nresumo: ${SUMMARY}`)
  process.exit(0)
})()
