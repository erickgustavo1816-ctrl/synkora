// SONDA — recarga de skills COM O TURNO ABERTO (Skills 3.0, 2026-09-08).
//
// Por que existe: a tool `skill_pull` do Synkora roda DENTRO do turno do
// agente. Ela escreve a pasta da skill no worktree no meio do turno — e a
// sonda irmã (PROBE_SKILLS_CWD_2026-08-29.md) provou que o claude NÃO re-varre
// a pasta em vida: só `/reload-skills` como mensagem de usuário recarrega, e
// aquilo foi medido ENTRE turnos. Falta a pergunta que decide o desenho da
// recarga (design DESIGN_HARNESS_DO_MODELO_2026-09-08.md, §9):
//
//   P1  claude, TURNO ABERTO: o harness cria a pasta quando o modelo chama uma
//       tool, manda `/reload-skills` pelo stdin ANTES de o modelo continuar, e
//       o modelo tenta `Skill` com a skill nova NO MESMO TURNO. Funciona? O que
//       o `/reload-skills` produz na stream (evento, texto, `result` avulso)?
//   P2  claude, ENTRE turnos (controle positivo — a receita conhecida): pasta
//       criada no turno 1, `/reload-skills` depois do `result`, `Skill` no
//       turno 2.
//   P3  claude, SEM recarga (controle negativo): pasta criada no turno 1, nada
//       enviado, `Skill` no turno 2 — tem de FALHAR (sem watcher).
//   P4  codex, app-server: pasta criada no meio do turno 1 (quando o modelo
//       roda um comando); o modelo tenta usar a skill no turno 2 da MESMA
//       thread. `skills/list` já enxergava (sonda irmã) — a pergunta é se o
//       PROMPT do turno seguinte leva a skill nova.
//
// GABARITO: o corpo do SKILL.md manda responder um token que NÃO existe em
// prompt nenhum (`SYNKPROBE-RELOAD-7E1B`). Token na resposta = corpo lido =
// skill carregada de verdade. No claude, o `tool_result` do `Skill` também
// diz, em forma: "Launching skill: …" (sucesso) × erro de skill desconhecida.
//
// Higiene do filho igual ao maestroSession/pty; morte por `taskkill /PID /T`
// (nunca por imagem — a máquina roda Electron e node que não são nossos).
// cwd descartável em os.tmpdir(); custo: turnos curtos em haiku / mini.
//
// Uso:
//   node scripts/probe-skill-reload-midturn.mjs --claude-config-dir "<userData>/seats/<id>" --codex-home "<userData>/seats/<id>"
//   node scripts/probe-skill-reload-midturn.mjs --only claude | --only codex
//   node scripts/probe-skill-reload-midturn.mjs --keep --timeout 240

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = resolve(process.argv[1], '..', '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-skill-reload')
const CAPTURE_CLAUDE = join(OUT_DIR, 'claude-frames.jsonl')
const CAPTURE_CODEX = join(OUT_DIR, 'codex-frames.jsonl')
const SUMMARY = join(OUT_DIR, 'summary.json')

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`))
  if (eq) return eq.slice(name.length + 3)
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const ONLY = (flagValue('only') || '').split(',').map((s) => s.trim()).filter(Boolean)
const KEEP = argv.includes('--keep')
const TIMEOUT_MS = Number(flagValue('timeout') || 240) * 1000
const CLAUDE_MODEL = flagValue('model-claude') || 'haiku'
const CODEX_MODEL = flagValue('model-codex') || ''
const CLAUDE_CONFIG_DIR = flagValue('claude-config-dir') || ''
const CODEX_HOME = flagValue('codex-home') || ''
const wants = (cli) => !ONLY.length || ONLY.includes(cli)

const SKILL_NAME = 'synkprobe-late'
const MARKER = 'SYNKPROBE-RELOAD-7E1B'
const SKILL_MD = `---
name: ${SKILL_NAME}
description: Synkora reload probe skill. Use it whenever the user mentions ${SKILL_NAME} by name. It only prints one marker token.
---

# ${SKILL_NAME}

When this skill is invoked, reply with EXACTLY this single line and nothing else:

${MARKER}

Do not add any explanation. Do not run any command.
`
const SKILL_DIR = { claude: '.claude/skills', codex: '.agents/skills' }
const WS = join(tmpdir(), 'synkora-probe-skill-reload')

function freshRoot(name) {
  const root = join(WS, name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'AGENTS.md'), '# workspace descartável da sonda de RECARGA de skill\n')
  writeFileSync(join(root, 'README.md'), '# workspace descartável da sonda de RECARGA de skill\n')
  return root
}

/** A "pasta que o harness escreveu no meio do turno". */
function createSkill(root, cli) {
  const folder = join(root, ...SKILL_DIR[cli].split('/'), SKILL_NAME)
  mkdirSync(folder, { recursive: true })
  const file = join(folder, 'SKILL.md')
  writeFileSync(file, Buffer.from(SKILL_MD, 'utf8'))
  if (readFileSync(file).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('BOM')
  return file
}

function childEnv(cli) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^CLAUDE_CODE_/i.test(k) && k !== 'CLAUDE_CONFIG_DIR') delete env[k]
  delete env.CLAUDECODE
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  if (cli === 'claude' && CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR
  if (cli === 'codex' && CODEX_HOME) env.CODEX_HOME = CODEX_HOME
  return env
}

function hardKill(child) {
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {}
  }
  try {
    child.kill()
  } catch {}
}

// ---------------------------------------------------------------------------
// Os prompts. O "gatilho" é UMA tool inofensiva (Bash `echo pulling`): é ela
// que dá ao harness o momento de escrever a pasta — exatamente como o
// `skill_pull` real, que também é uma tool no meio do turno.
// ---------------------------------------------------------------------------
const PROMPT_TRIGGER_THEN_USE = `Do these two steps, in order, in this same turn. Step 1: call the Bash tool with exactly this command: echo pulling. Step 2: after the command returns, call the Skill tool with skill "${SKILL_NAME}" and reply with exactly the single line that skill tells you. If the Skill tool reports the skill does not exist, reply with exactly: SKILL-NOT-FOUND`
const PROMPT_TRIGGER_ONLY = 'Call the Bash tool with exactly this command: echo pulling. Then reply with exactly the word: pronto'
const PROMPT_USE_ONLY = `Call the Skill tool with skill "${SKILL_NAME}" and reply with exactly the single line that skill tells you. If the Skill tool reports the skill does not exist, reply with exactly: SKILL-NOT-FOUND`

/**
 * Um processo claude (stream-json, os MESMOS args do app) executando um
 * ROTEIRO de passos:
 *   { kind: 'turn', text, createOnToolUse?, reloadOnToolUse? }  — mensagem do usuário;
 *       createOnToolUse: cria a pasta no PRIMEIRO tool_use do turno;
 *       reloadOnToolUse: manda `/reload-skills` logo depois de permitir a tool
 *   { kind: 'reload' }  — `/reload-skills` ENTRE turnos (espera o que voltar)
 *   { kind: 'create' }  — cria a pasta entre turnos, sem falar com o CLI
 */
function runClaude(label, steps) {
  const root = freshRoot(`claude-${label}`)
  return new Promise((done) => {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-prompt-tool',
      'stdio',
      '--model',
      CLAUDE_MODEL
    ]
    const t0 = Date.now()
    const out = {
      label,
      root,
      steps: [],
      permissionAsks: [],
      timeline: [],
      stderr: [],
      error: null,
      stopReason: null
    }
    let cursor = -1
    let current = null
    let finished = false
    let buf = ''
    const REQ = `probe-reload-${label}`
    const child = spawn('claude', args, { cwd: root, env: childEnv('claude'), shell: process.platform === 'win32' })

    const send = (obj) => {
      try {
        child.stdin.write(JSON.stringify(obj) + '\n')
      } catch (e) {
        out.error = `stdin: ${e.message}`
      }
    }
    const mark = (what, extra = {}) => out.timeline.push({ ms: Date.now() - t0, step: cursor, what, ...extra })
    const finish = (reason) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      out.stopReason = reason
      try {
        child.stdin.end()
      } catch {}
      hardKill(child)
      setTimeout(() => done(out), 250)
    }
    const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS)

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) handleLine(line)
      }
    })
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8').trim()
      if (s) out.stderr.push(s.slice(0, 400))
    })
    child.on('error', (e) => {
      out.error = `spawn falhou: ${e.message}`
      finish('erro de spawn')
    })
    child.on('close', (code) => finish(`o CLI encerrou (exit ${code})`))

    function nextStep() {
      cursor += 1
      if (cursor >= steps.length) return finish('roteiro concluído')
      const step = steps[cursor]
      current = {
        index: cursor,
        kind: step.kind,
        text: step.text ?? null,
        createOnToolUse: step.createOnToolUse === true,
        /** 'tool_use' | 'tool_result' | null — QUANDO mandar o /reload-skills no meio do turno */
        reloadOnToolUse: step.reloadOnToolUse ?? null,
        created: false,
        reloadSent: false,
        toolUses: [],
        toolResults: [],
        initSlashHasProbe: null,
        answerText: null,
        markerInAnswer: null,
        isError: null,
        frames: []
      }
      out.steps.push(current)
      process.stderr.write(`  [claude/${label}] passo ${cursor} (${step.kind})\n`)
      if (step.kind === 'create') {
        createSkill(root, 'claude')
        current.created = true
        mark('created-between-turns')
        return setTimeout(nextStep, 1500)
      }
      if (step.kind === 'reload') {
        send({ type: 'user', message: { role: 'user', content: '/reload-skills' } })
        mark('reload-sent-between-turns')
        // o que vier de volta é registrado em `frames`; damos 6s e seguimos
        return setTimeout(nextStep, 6000)
      }
      send({ type: 'user', message: { role: 'user', content: step.text } })
      mark('turn-sent')
    }

    function handleLine(line) {
      appendFileSync(CAPTURE_CLAUDE, `${label} ${Date.now() - t0} ${line}\n`)
      let evt
      try {
        evt = JSON.parse(line)
      } catch {
        return
      }
      if (evt.type === 'control_response' && evt.response?.request_id === REQ) {
        mark('handshake-done', { commands: (evt.response?.response?.commands ?? []).length })
        return nextStep()
      }
      if (current) {
        const shape = `${evt.type}${evt.subtype ? '/' + evt.subtype : ''}${evt.event?.type ? ':' + evt.event.type : ''}`
        if (!shape.startsWith('stream_event')) current.frames.push({ ms: Date.now() - t0, shape })
      }

      if (evt.type === 'control_request' && evt.request?.subtype === 'can_use_tool') {
        out.permissionAsks.push({ step: cursor, tool: evt.request.tool_name ?? null })
        // O MOMENTO DO HARNESS: a pasta nasce enquanto a tool do modelo está
        // em voo — é o que o skill_pull real faz.
        if (current?.createOnToolUse && !current.created) {
          createSkill(root, 'claude')
          current.created = true
          mark('created-midturn')
        }
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

      if (evt.type === 'system' && evt.subtype === 'init' && current) {
        const cmds = evt.slash_commands ?? evt.slashCommands ?? []
        current.initSlashHasProbe = Array.isArray(cmds)
          ? cmds.some((c) => String(c?.name ?? c).includes(SKILL_NAME))
          : null
        mark('init', { slashHasProbe: current.initSlashHasProbe })
        return
      }

      if (current && evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        for (const b of evt.message.content) {
          if (b?.type === 'tool_use') {
            current.toolUses.push({ name: b.name ?? null, input: JSON.stringify(b.input ?? {}).slice(0, 200) })
            mark('tool_use', { name: b.name })
            // O GATILHO É O tool_use DO BASH (1ª rodada: o seat do app executa
            // Bash sem pedir permissão, então o can_use_tool nunca chegou e a
            // pasta nunca nasceu — created:false em todos os cenários). Aqui
            // o modelo JÁ decidiu chamar a tool e ela está em voo: é o instante
            // exato em que o skill_pull real escreve a pasta.
            if (b.name === 'Bash' && current.createOnToolUse && !current.created) {
              createSkill(root, 'claude')
              current.created = true
              mark('created-midturn')
              if (current.reloadOnToolUse === 'tool_use' && !current.reloadSent) {
                send({ type: 'user', message: { role: 'user', content: '/reload-skills' } })
                current.reloadSent = true
                mark('reload-sent-midturn-at-tool_use')
              }
            }
          }
        }
      }
      if (current && evt.type === 'user' && Array.isArray(evt.message?.content)) {
        for (const b of evt.message.content) {
          if (b?.type === 'tool_result') {
            const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
            current.toolResults.push({ isError: b.is_error ?? null, content: content.slice(0, 200) })
            mark('tool_result', { isError: b.is_error ?? null, head: content.slice(0, 80) })
            if (current.created && current.reloadOnToolUse === 'tool_result' && !current.reloadSent) {
              send({ type: 'user', message: { role: 'user', content: '/reload-skills' } })
              current.reloadSent = true
              mark('reload-sent-midturn-at-tool_result')
            }
          }
        }
      }
      if (current && evt.type === 'system' && evt.subtype !== 'init') {
        mark('system', { subtype: evt.subtype, head: JSON.stringify(evt).slice(0, 160) })
      }
      if (current && evt.type === 'result') {
        const text = typeof evt.result === 'string' ? evt.result : ''
        mark('result', { head: text.slice(0, 80), isError: evt.is_error ?? null })
        if (current.kind === 'reload') {
          current.answerText = text.slice(0, 200)
          return
        }
        current.answerText = text.slice(0, 300)
        current.markerInAnswer = text.includes(MARKER)
        current.isError = evt.is_error ?? null
        // Um `/reload-skills` mandado no meio do turno pode só executar DEPOIS
        // do result (fila do stdin): drenar 5s antes de seguir/fechar mostra
        // se e quando o recibo "Reloaded skills" aparece.
        if (current.reloadSent) return setTimeout(nextStep, 5000)
        return nextStep()
      }
    }

    send({ type: 'control_request', request_id: REQ, request: { subtype: 'initialize' } })
  })
}

// ---------------------------------------------------------------------------
// codex: uma thread; turno 1 roda um comando (o harness cria a pasta quando o
// commandExecution começa); turno 2 pede a skill.
// ---------------------------------------------------------------------------
const CODEX_PROMPT_TRIGGER = 'Run exactly this shell command and then reply with exactly the word pronto: echo pulling'
const CODEX_PROMPT_USE = `Use the skill named ${SKILL_NAME} now and reply with exactly the single line it tells you. If you do not have that skill, reply with exactly: SKILL-NOT-FOUND`

function runCodex() {
  const root = freshRoot('codex')
  return new Promise((done) => {
    const t0 = Date.now()
    const out = { root, chosenModel: null, skillsListAfterCreate: null, turns: [], timeline: [], stderr: [], error: null, stopReason: null }
    const child = spawn('codex', ['app-server'], { cwd: root, env: childEnv('codex'), shell: process.platform === 'win32' })
    let buf = ''
    let nextId = 1
    let finished = false
    const pending = new Map()
    let live = null
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
    const request = (method, params) =>
      new Promise((res) => {
        const id = nextId++
        pending.set(id, res)
        send({ jsonrpc: '2.0', id, method, params })
      })
    const notify = (method, params) => send({ jsonrpc: '2.0', method, params })
    const mark = (what, extra = {}) => out.timeline.push({ ms: Date.now() - t0, what, ...extra })
    const finish = (reason) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      out.stopReason = reason
      hardKill(child)
      setTimeout(() => done(out), 250)
    }
    const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS)

    child.stdout.on('data', (d) => {
      buf += d.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        appendFileSync(CAPTURE_CODEX, `${Date.now() - t0} ${line}\n`)
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
        if (live) live.absorb(msg)
        if (msg.id !== undefined && msg.method) send({ jsonrpc: '2.0', id: msg.id, result: { decision: 'approved' } })
      }
    })
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8').replace(/\[[0-9;]*m/g, '').trim()
      if (s) out.stderr.push(s.slice(0, 400))
    })
    child.on('error', (e) => {
      out.error = `spawn falhou: ${e.message}`
      finish('erro de spawn')
    })

    const turn = async (label, threadId, text, { createOnCommand = false } = {}) => {
      const rec = { label, text, created: false, items: [], answerText: null, markerInAnswer: null, turnStatus: null, error: null }
      out.turns.push(rec)
      let settle
      const finishedTurn = new Promise((r) => (settle = r))
      live = {
        absorb(msg) {
          const p = msg.params ?? {}
          if (p.threadId && p.threadId !== threadId) return
          const item = p.item
          if (item && msg.method === 'item/started' && item.type === 'commandExecution' && createOnCommand && !rec.created) {
            createSkill(root, 'codex')
            rec.created = true
            mark('created-midturn', { turn: label })
          }
          if (item && msg.method === 'item/completed') {
            rec.items.push({ type: item.type ?? null, command: typeof item.command === 'string' ? item.command.slice(0, 120) : null, text: typeof item.text === 'string' ? item.text.slice(0, 200) : null })
            if (item.type === 'agentMessage' && typeof item.text === 'string') {
              rec.answerText = item.text.slice(0, 300)
              rec.markerInAnswer = item.text.includes(MARKER)
            }
          }
          if (msg.method === 'turn/completed' || msg.method === 'turn/failed') {
            rec.turnStatus = p.turn?.status ?? msg.method
            settle()
          }
        }
      }
      const params = { threadId, input: [{ type: 'text', text }], approvalPolicy: 'never' }
      if (out.chosenModel) params.model = out.chosenModel.toLowerCase()
      mark('turn-start', { turn: label })
      const started = await request('turn/start', params)
      if (started?.error) {
        rec.error = `turn/start: ${JSON.stringify(started.error).slice(0, 300)}`
        settle()
      }
      await Promise.race([finishedTurn, new Promise((r) => setTimeout(r, TIMEOUT_MS / 3))])
      await new Promise((r) => setTimeout(r, 800))
      live = null
    }

    ;(async () => {
      const init = await request('initialize', { clientInfo: { name: 'synkora-probe-skill-reload', title: 'Synkora skill reload probe', version: '0.0.1' } })
      if (init?.error) {
        out.error = `initialize: ${JSON.stringify(init.error).slice(0, 300)}`
        return finish('initialize falhou')
      }
      notify('initialized', {})
      const models = await request('model/list', {})
      const data = (models?.result?.data ?? []).filter((m) => m?.id && !m.hidden)
      out.chosenModel = CODEX_MODEL || data.find((m) => /mini|nano|small/i.test(m.id))?.id || data[data.length - 1]?.id || null
      const start = await request('thread/start', { cwd: root })
      const threadId = start?.result?.thread?.id
      if (!threadId) {
        out.error = 'sem thread'
        return finish('thread/start falhou')
      }
      await turn('trigger', threadId, CODEX_PROMPT_TRIGGER, { createOnCommand: true })
      const list = await request('skills/list', { cwds: [root] })
      const entry = (list?.result?.data ?? [])[0]
      out.skillsListAfterCreate = {
        probe: (entry?.skills ?? []).filter((s) => s?.name === SKILL_NAME).map((s) => ({ name: s.name, scope: s.scope })),
        errors: (entry?.errors ?? []).length
      }
      await turn('use', threadId, CODEX_PROMPT_USE)
      finish('concluído')
    })().catch((e) => {
      out.error = `fatal: ${e?.message}`
      finish('fatal')
    })
  })
}

;(async () => {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  rmSync(WS, { recursive: true, force: true })
  const summary = { at: new Date().toISOString(), claudeModel: CLAUDE_MODEL, claude: {}, codex: null }

  if (wants('claude')) {
    // P1 — turno aberto: cria no tool_use, recarrega no meio, usa no mesmo turno.
    summary.claude.midturn = await runClaude('midturn', [
      { kind: 'turn', text: PROMPT_TRIGGER_THEN_USE, createOnToolUse: true, reloadOnToolUse: 'tool_use' }
    ])
    // P1' — a mesma pergunta, recarga mandada logo DEPOIS do tool_result do Bash.
    summary.claude.midturnAfterResult = await runClaude('midturn-after-result', [
      { kind: 'turn', text: PROMPT_TRIGGER_THEN_USE, createOnToolUse: true, reloadOnToolUse: 'tool_result' }
    ])
    // P2 — controle positivo: recarga ENTRE turnos.
    summary.claude.between = await runClaude('between', [
      { kind: 'turn', text: PROMPT_TRIGGER_ONLY, createOnToolUse: true },
      { kind: 'reload' },
      { kind: 'turn', text: PROMPT_USE_ONLY }
    ])
    // P3 — controle negativo: sem recarga nenhuma.
    summary.claude.noreload = await runClaude('noreload', [
      { kind: 'turn', text: PROMPT_TRIGGER_ONLY, createOnToolUse: true },
      { kind: 'turn', text: PROMPT_USE_ONLY }
    ])
    // P1b — sem recarga, mesmo turno: a pasta criada no meio é vista sem reload?
    summary.claude.midturnNoReload = await runClaude('midturn-noreload', [
      { kind: 'turn', text: PROMPT_TRIGGER_THEN_USE, createOnToolUse: true }
    ])
  }
  if (wants('codex')) summary.codex = await runCodex()

  const verdict = {}
  for (const [k, run] of Object.entries(summary.claude)) {
    const last = run.steps[run.steps.length - 1]
    verdict[k] = {
      created: run.steps.some((s) => s.created),
      reloadSent: run.steps.some((s) => s.reloadSent),
      skillToolUsed: run.steps.some((s) => s.toolUses.some((t) => t.name === 'Skill')),
      skillToolResults: run.steps.flatMap((s) => s.toolResults.filter((r) => /skill/i.test(r.content)).map((r) => r.content.slice(0, 120))),
      markerInAnswer: last?.markerInAnswer ?? null,
      answer: last?.answerText ?? null,
      timeline: run.timeline
        .filter((t) => !(t.what === 'system' && /thinking_tokens|^status$/.test(t.subtype ?? '')))
        .map((t) => `${t.ms}ms s${t.step} ${t.what}${t.name ? ':' + t.name : ''}${t.subtype ? '/' + t.subtype : ''}${t.head ? ' ' + String(t.head).slice(0, 70) : ''}${t.isError ? ' ERR' : ''}`),
      stopReason: run.stopReason,
      error: run.error
    }
  }
  if (summary.codex) {
    verdict.codex = {
      model: summary.codex.chosenModel,
      skillsListAfterCreate: summary.codex.skillsListAfterCreate,
      turns: summary.codex.turns.map((t) => ({ label: t.label, created: t.created, status: t.turnStatus, marker: t.markerInAnswer, answer: t.answerText, items: t.items.map((i) => i.type) })),
      error: summary.codex.error
    }
  }
  summary.verdict = verdict
  writeFileSync(SUMMARY, JSON.stringify(summary, null, 2))
  process.stdout.write(JSON.stringify(verdict, null, 2) + '\n')
  if (!KEEP) rmSync(WS, { recursive: true, force: true })
})()
