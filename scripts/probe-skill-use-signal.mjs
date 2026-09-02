// SONDA — quando o modelo USA uma Agent Skill, o que atravessa a stream?
//
// Por que existe: Skills 2.0 entrega o kit como PASTA no worktree (a sonda
// irmã `probe-skills-cwd.mjs` decidiu QUAL pasta). Falta a outra metade do
// contrato: o dono quer VER no chat que o agente usou uma skill. Um chip de UI
// só é honesto se nascer de SINAL ESTRUTURAL do protocolo (nome de campo, tipo
// de evento) — nunca de heurística sobre o TEXTO da resposta, que é proibida
// nesta casa. Nunca ninguém mediu isso nos binários; este arquivo mede.
//
// O que ela responde:
//   P1  claude (stream-json, o formato que `guiProtocolLine.ts` já parseia):
//       um turno que USA a skill produz qual evento? bloco `tool_use` (com que
//       `name`?), evento de sistema, texto puro? O marcador carrega o NOME da
//       skill? Carregar (descobrir) difere de USAR?
//   P2  codex (app-server JSON-RPC, o protocolo de `codexSession.ts`): mesma
//       pergunta nas notificações `item/started` / `item/completed`.
//   P3  CONTROLE NEGATIVO: um turno que NÃO usa skill nenhuma, no MESMO cwd com
//       a MESMA skill instalada, não pode produzir o marcador. Sem isto, o
//       "marcador" poderia ser só o formato normal de um turno qualquer.
//   P4  superfícies vizinhas, quando não houver marcador direto: no claude, o
//       caminho SLASH (`/synkprobe-usemark`) emite algo diferente? no codex, a
//       entrada tipada `SkillUserInput` ({type:'skill',name,path}, que o schema
//       do próprio binário declara) volta ecoada no `userMessage`?
//   P5  DURABILIDADE: o marcador reaparece no SEGUNDO uso da MESMA skill, na
//       MESMA sessão/thread? Um contrato que só vale na estreia não é contrato
//       — e a resposta (nos DOIS CLIs: não reaparece) é o que decide se o chip
//       é por turno ou por conversa.
//
// COMO O MARCADOR É ACHADO — mecanicamente, não a olho: cada evento cru vira
// uma ASSINATURA DE FORMA (só nomes de tipo/campo, zero conteúdo). Ex.:
// `assistant.tool_use:Skill`, `notif:item/started[commandExecution]`. O
// marcador é o conjunto `formas(cenário que usa) \ formas(controle negativo)`.
// Diferença de forma é sinal estrutural por construção.
//
// COMO SE SABE QUE A SKILL FOI MESMO USADA: o corpo do SKILL.md manda responder
// um token que NÃO aparece em lugar nenhum do prompt (`SYNKPROBE-USED-9F2C41`).
// Se o token volta na resposta, o corpo foi lido — logo a skill rodou. Esse
// casamento de texto é a VERDADE DE CAMPO da sonda (o gabarito), jamais o
// contrato de detecção do app: o app só pode olhar a FORMA.
//
// O cwd descartável nasce em `os.tmpdir()` — NUNCA dentro do repo do Synkora,
// NUNCA em projeto do dono — e é apagado no fim (`--keep` preserva).
//
// CUSTO: turnos de verdade (o modelo precisa DECIDIR usar a skill). São curtos
// e em modelo barato: claude em `haiku`, codex no menor da `model/list`.
//
// MORTE DOS FILHOS: `taskkill /PID <pid> /T /F` — a árvore ENRAIZADA NO NOSSO
// PRÓPRIO PID. Nunca por nome de imagem (a máquina roda Electron e outros node
// que não são nossos — matar por imagem é fratricídio).
//
// Uso:
//   node scripts/probe-skill-use-signal.mjs
//   node scripts/probe-skill-use-signal.mjs --only claude
//   node scripts/probe-skill-use-signal.mjs --only codex
//   node scripts/probe-skill-use-signal.mjs --keep --timeout 240
//   node scripts/probe-skill-use-signal.mjs --claude-config-dir "<userData>/seats/<id>"
//   node scripts/probe-skill-use-signal.mjs --codex-home "<userData>/seats/<id>"
//
// Os dois últimos rodam a sonda em um SEAT do app (a conta com OAuth vivo) em
// vez do perfil padrão da máquina. A sonda só EXPORTA a variável de ambiente
// que o CLI já espera (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`); nunca lê, copia ou
// imprime credencial.

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = resolve(process.argv[1], '..', '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-skill-use')
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

// ---------------------------------------------------------------------------
// A skill-sonda. O token do corpo é o GABARITO: ele não existe em nenhum prompt,
// então só chega à resposta se o SKILL.md tiver sido lido de fato.
// ---------------------------------------------------------------------------
const SKILL_NAME = 'synkprobe-usemark'
const MARKER = 'SYNKPROBE-USED-9F2C41'
const SKILL_MD = `---
name: ${SKILL_NAME}
description: Synkora probe skill. Use this skill whenever the user asks to run the Synkora skill-use probe, or mentions ${SKILL_NAME} by name. It only prints one marker token and does nothing else.
---

# ${SKILL_NAME}

Sonda descartável do Synkora.

When this skill is invoked, reply with EXACTLY this single line and nothing else:

${MARKER}

Do not add any explanation, greeting or punctuation. Do not run any command.
`

// Pastas-alvo já decididas pela sonda irmã (PROBE_SKILLS_CWD_2026-08-29.md).
const SKILL_DIR = { claude: '.claude/skills', codex: '.agents/skills' }

const WS = join(tmpdir(), 'synkora-probe-skill-use')
const ROOTS = { claude: join(WS, 'claude'), codex: join(WS, 'codex') }

function buildWorkspace() {
  rmSync(WS, { recursive: true, force: true })
  const files = []
  for (const [cli, root] of Object.entries(ROOTS)) {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'AGENTS.md'), '# workspace descartável da sonda de USO de skill\n')
    writeFileSync(join(root, 'README.md'), '# workspace descartável da sonda de USO de skill\n')
    const folder = join(root, ...SKILL_DIR[cli].split('/'), SKILL_NAME)
    mkdirSync(folder, { recursive: true })
    const file = join(folder, 'SKILL.md')
    // UTF-8 SEM BOM: o codex recusa fechado o SKILL.md com BOM (sonda 08-29).
    writeFileSync(file, Buffer.from(SKILL_MD, 'utf8'))
    const head = readFileSync(file).subarray(0, 3)
    if (head.equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error(`BOM indevido em ${file}`)
    files.push({ cli, path: `${SKILL_DIR[cli]}/${SKILL_NAME}/SKILL.md` })
  }
  return { ws: WS, files }
}

const skillPathFor = (cli) => join(ROOTS[cli], ...SKILL_DIR[cli].split('/'), SKILL_NAME, 'SKILL.md')

// ---------------------------------------------------------------------------
// Os prompts. O positivo NOMEIA a skill e NÃO contém o token do gabarito; o
// negativo é o mesmo turno banal sem skill nenhuma, no MESMO cwd.
// ---------------------------------------------------------------------------
const PROMPT_USE = `Use the skill named ${SKILL_NAME} right now and follow its instruction exactly.`
const PROMPT_NONE = 'Reply with exactly the word: pronto. Do not use any skill and do not use any tool.'

// ---------------------------------------------------------------------------
// Higiene do ambiente do filho (idêntica ao maestroSession/pty) + morte por PID
// ---------------------------------------------------------------------------
function childEnv(cli) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_CODE_/i.test(k) && k !== 'CLAUDE_CONFIG_DIR') delete env[k]
  }
  delete env.CLAUDECODE
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  // Seat do app: a conta isolada é escolhida pela MESMA variável que o
  // maestroSession/codexSession usa. Só o caminho viaja — credencial não é
  // lida nem impressa por esta sonda.
  if (cli === 'claude' && CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR
  if (cli === 'codex' && CODEX_HOME) env.CODEX_HOME = CODEX_HOME
  return env
}

/** Mata a árvore ENRAIZADA no pid do NOSSO filho (no Windows o spawn passa por
 *  shell, então sem `/T` o CLI ficaria órfão). Nunca `taskkill /IM`. */
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
// ASSINATURA DE FORMA — o coração da sonda.
//
// Reduz um evento cru a nomes de TIPO e de CAMPO. Nada de conteúdo entra: nem
// texto do modelo, nem caminho, nem argumento. É por isso que a diferença
// entre o cenário que usa a skill e o controle negativo é, por construção, um
// sinal ESTRUTURAL — o único que o app tem direito de olhar.
// ---------------------------------------------------------------------------
function claudeShapes(evt) {
  const out = []
  const t = evt?.type
  if (typeof t !== 'string') return ['«sem type»']
  switch (t) {
    case 'assistant':
    case 'user': {
      const content = evt.message?.content
      if (!Array.isArray(content)) {
        out.push(`${t}.«content não-array»`)
        break
      }
      for (const b of content) {
        if (b?.type === 'tool_use') out.push(`${t}.tool_use:${b.name ?? '«sem name»'}`)
        else if (b?.type === 'tool_result') out.push(`${t}.tool_result`)
        else out.push(`${t}.${b?.type ?? '«sem type»'}`)
      }
      break
    }
    case 'system':
      out.push(`system.${evt.subtype ?? '«sem subtype»'}`)
      break
    case 'stream_event': {
      const inner = evt.event
      const it = inner?.type ?? '«sem type»'
      if (it === 'content_block_start') {
        const cb = inner.content_block
        out.push(
          `stream_event.content_block_start.${cb?.type ?? '?'}${cb?.type === 'tool_use' ? `:${cb?.name ?? '?'}` : ''}`
        )
      } else out.push(`stream_event.${it}`)
      break
    }
    case 'control_request':
      out.push(
        `control_request.${evt.request?.subtype ?? '?'}${
          evt.request?.tool_name ? `:${evt.request.tool_name}` : ''
        }`
      )
      break
    case 'control_response':
      out.push(`control_response.${evt.response?.subtype ?? '?'}`)
      break
    case 'result':
      out.push(`result.${evt.subtype ?? '?'}`)
      break
    default:
      out.push(t)
  }
  return out
}

function codexShapes(msg) {
  if (msg?.method && msg.id === undefined) {
    const p = msg.params ?? {}
    const item = p.item
    if (item && typeof item === 'object') {
      const extra = []
      // Campos que o schema do binário declara e que PODERIAM carregar origem
      // de skill: entram na FORMA (só o nome do campo, nunca o valor).
      for (const k of ['source', 'pluginId', 'scriptPath', 'namespace', 'name', 'tool'])
        if (item[k] !== undefined && item[k] !== null) extra.push(k)
      const content = Array.isArray(item.content) ? item.content : null
      if (content) for (const c of content) extra.push(`content:${c?.type ?? '?'}`)
      return [`notif:${msg.method}[${item.type ?? '?'}]${extra.length ? `{${extra.join(',')}}` : ''}`]
    }
    return [`notif:${msg.method}`]
  }
  if (msg?.method && msg.id !== undefined) return [`srvreq:${msg.method}`]
  return [] // respostas RPC do nosso próprio pedido não fazem parte do turno
}

/** Guarda até 3 linhas cruas por forma — o relatório precisa de excerto real. */
function makeCollector() {
  const shapes = new Map()
  return {
    shapes,
    note(shape, raw) {
      const cur = shapes.get(shape) ?? { count: 0, samples: [] }
      cur.count += 1
      if (cur.samples.length < 3) cur.samples.push(String(raw).slice(0, 1600))
      shapes.set(shape, cur)
    },
    toJSON() {
      return Object.fromEntries([...shapes.entries()].sort((a, b) => a[0].localeCompare(b[0])))
    }
  }
}

// ---------------------------------------------------------------------------
// P1/P3/P4 — claude: um processo `-p` por cenário (sessão limpa em cada um).
//
// `prompts` é uma LISTA de turnos na MESMA sessão. Com dois turnos iguais se
// mede DURABILIDADE: o marcador reaparece no segundo uso da mesma skill, ou
// vale só na primeira vez? Um contrato que só vale na estreia não é contrato.
// ---------------------------------------------------------------------------
function runClaude(label, prompts) {
  const queue = Array.isArray(prompts) ? prompts : [prompts]
  return new Promise((done) => {
    // Os MESMOS argumentos do app (maestroSession), menos o que não importa
    // aqui: é o formato do app que precisa ser medido, não outro.
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
    const out = {
      label,
      prompts: queue,
      spawnArgs: args,
      handshakeCommands: null,
      initTools: null,
      initSlashCount: null,
      permissionAsks: [],
      stderr: [],
      error: null,
      stopReason: null,
      turns: []
    }
    /** Turno vivo: cada um tem coletor de formas e lista de tool_use próprios. */
    let turn = null
    let collector = null
    const openTurn = () => {
      collector = makeCollector()
      turn = {
        index: out.turns.length,
        prompt: queue[out.turns.length],
        toolUses: [],
        answerText: null,
        markerInAnswer: null,
        isError: null,
        costUsd: null,
        shapes: null
      }
      out.turns.push(turn)
      send({ type: 'user', message: { role: 'user', content: turn.prompt } })
    }

    const child = spawn('claude', args, {
      cwd: ROOTS.claude,
      env: childEnv('claude'),
      shell: process.platform === 'win32'
    })

    let buf = ''
    let finished = false
    const REQ = `probe-skill-use-${label}`

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
      clearTimeout(timer)
      out.stopReason = reason
      if (turn && collector && !turn.shapes) turn.shapes = collector.toJSON()
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

    function handleLine(line) {
      appendFileSync(CAPTURE_CLAUDE, `${label} ${line}\n`)
      let evt
      try {
        evt = JSON.parse(line)
      } catch {
        return
      }

      // O handshake é local (0 token) e serve de sanidade: a skill-sonda tem
      // que estar no catálogo, senão o turno não teria como usá-la.
      if (evt.type === 'control_response' && evt.response?.request_id === REQ) {
        const commands = evt.response?.response?.commands ?? []
        out.handshakeCommands = {
          total: commands.length,
          probe: commands
            .filter((c) => String(c?.name ?? c).includes(SKILL_NAME))
            .map((c) => ({ name: c.name, description: String(c.description ?? '').slice(0, 240) }))
        }
        if (!turn) openTurn()
        return
      }

      // Só o que pertence ao TURNO entra na assinatura de forma (o handshake é
      // pedido nosso, não do modelo).
      if (turn) for (const s of claudeShapes(evt)) collector.note(s, line)

      // A sonda PERMITE toda ferramenta: negar mataria justamente o caminho
      // que se quer observar. Registra qual foi pedida.
      if (evt.type === 'control_request' && evt.request?.subtype === 'can_use_tool') {
        out.permissionAsks.push({
          tool: evt.request.tool_name ?? null,
          input: JSON.stringify(evt.request.input ?? {}).slice(0, 400)
        })
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

      if (evt.type === 'system' && evt.subtype === 'init') {
        const tools = evt.tools
        out.initTools = Array.isArray(tools) ? tools : null
        const cmds = evt.slash_commands ?? evt.slashCommands ?? []
        out.initSlashCount = Array.isArray(cmds) ? cmds.length : null
        return
      }

      // O corpo do card: nome + input COMPLETO de cada tool_use do turno. É
      // aqui que se vê se o nome da skill viaja no marcador.
      if (turn && evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        for (const b of evt.message.content) {
          if (b?.type === 'tool_use')
            turn.toolUses.push({
              name: b.name ?? null,
              id: b.id ?? null,
              input: JSON.stringify(b.input ?? {}).slice(0, 600)
            })
        }
      }

      if (turn && evt.type === 'result') {
        const text = typeof evt.result === 'string' ? evt.result : ''
        turn.answerText = text.slice(0, 400)
        turn.markerInAnswer = text.includes(MARKER)
        turn.isError = evt.is_error ?? null
        turn.costUsd = evt.total_cost_usd ?? null
        turn.shapes = collector.toJSON()
        if (out.turns.length < queue.length) return openTurn()
        return finish('roteiro concluído')
      }
    }

    send({ type: 'control_request', request_id: REQ, request: { subtype: 'initialize' } })
  })
}

// ---------------------------------------------------------------------------
// P2/P3/P4 — codex: um app-server, uma THREAD NOVA por cenário (thread reusada
// contaminaria: o modelo já teria a skill no contexto do turno anterior).
// ---------------------------------------------------------------------------
function runCodex() {
  return new Promise((done) => {
    const out = {
      models: null,
      chosenModel: null,
      skillsList: null,
      scenarios: {},
      stderr: [],
      error: null,
      stopReason: null
    }
    const child = spawn('codex', ['app-server'], {
      cwd: ROOTS.codex,
      env: childEnv('codex'),
      shell: process.platform === 'win32'
    })

    let buf = ''
    let nextId = 1
    let finished = false
    const pending = new Map()
    /** Cenário vivo: as notificações do servidor caem no coletor dele. */
    let live = null

    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n')
    const request = (method, params) =>
      new Promise((res) => {
        const id = nextId++
        pending.set(id, res)
        send({ jsonrpc: '2.0', id, method, params })
      })
    const notify = (method, params) => send({ jsonrpc: '2.0', method, params })

    const finish = (reason) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      out.stopReason = reason
      hardKill(child) // o app-server NUNCA morre sozinho
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
        appendFileSync(CAPTURE_CODEX, line + '\n')
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
        if (live) {
          for (const s of codexShapes(msg)) live.collector.note(s, line)
          live.absorb(msg)
        }
        // pedido do servidor (aprovação): a sonda APROVA — negar mataria o
        // caminho que se quer observar.
        if (msg.id !== undefined && msg.method)
          send({ jsonrpc: '2.0', id: msg.id, result: { decision: 'approved' } })
      }
    })
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8').replace(/\[[0-9;]*m/g, '').trim()
      if (s) out.stderr.push(s.slice(0, 400))
    })
    child.on('error', (e) => {
      out.error = `spawn falhou: ${e.message}`
      finish('erro de spawn')
    })

    /** Um cenário = uma thread NOVA + um turn/start + espera do turn/completed.
     *  `reuseThreadFrom` roda o turno na thread de um cenário anterior — é
     *  assim que se mede DURABILIDADE: o sinal se repete no segundo uso da
     *  MESMA skill, ou o modelo já tem o corpo no contexto e nada atravessa? */
    const scenario = async (label, input, { reuseThreadFrom = null } = {}) => {
      const collector = makeCollector()
      const rec = {
        label,
        input: JSON.stringify(input).slice(0, 400),
        reuseThreadFrom,
        threadId: null,
        items: [],
        answerText: null,
        markerInAnswer: null,
        turnStatus: null,
        error: null,
        shapes: null
      }
      out.scenarios[label] = rec

      let threadId = reuseThreadFrom ? out.scenarios[reuseThreadFrom]?.threadId : null
      if (!threadId) {
        const start = await request('thread/start', { cwd: ROOTS.codex })
        threadId = start?.result?.thread?.id
      }
      if (!threadId) {
        rec.error = 'sem thread para o turno'
        return
      }
      rec.threadId = threadId

      let settle
      const finished = new Promise((r) => (settle = r))
      live = {
        collector,
        absorb(msg) {
          const p = msg.params ?? {}
          if (p.threadId && p.threadId !== threadId) return
          const item = p.item
          if (item && msg.method === 'item/completed') {
            rec.items.push({
              type: item.type ?? null,
              // O que puder identificar ORIGEM entra inteiro: é candidato a
              // marcador. Texto do modelo é cortado (não é evidência de forma).
              name: item.name ?? null,
              tool: item.tool ?? null,
              namespace: item.namespace ?? null,
              source: item.source ?? null,
              pluginId: item.pluginId ?? null,
              scriptPath: item.scriptPath ?? null,
              command: typeof item.command === 'string' ? item.command.slice(0, 300) : null,
              content: Array.isArray(item.content)
                ? item.content.map((c) => ({ type: c?.type ?? null, name: c?.name ?? null }))
                : null,
              text: typeof item.text === 'string' ? item.text.slice(0, 300) : null
            })
            if (item.type === 'agentMessage' && typeof item.text === 'string') {
              rec.answerText = item.text.slice(0, 400)
              rec.markerInAnswer = item.text.includes(MARKER)
            }
          }
          if (msg.method === 'turn/completed' || msg.method === 'turn/failed') {
            rec.turnStatus = p.turn?.status ?? msg.method
            settle()
          }
        }
      }

      const params = { threadId, input }
      if (out.chosenModel) params.model = out.chosenModel.toLowerCase()
      params.approvalPolicy = 'never'
      const started = await request('turn/start', params)
      if (started?.error) {
        rec.error = `turn/start: ${JSON.stringify(started.error).slice(0, 300)}`
        settle()
      }
      await Promise.race([finished, new Promise((r) => setTimeout(r, TIMEOUT_MS / 3))])
      // respiro para o último item/completed atrasado entrar na coleta
      await new Promise((r) => setTimeout(r, 800))
      rec.shapes = collector.toJSON()
      live = null
    }

    ;(async () => {
      const init = await request('initialize', {
        clientInfo: { name: 'synkora-probe-skill-use', title: 'Synkora skill-use probe', version: '0.0.1' }
      })
      if (init?.error) {
        out.error = `initialize: ${JSON.stringify(init.error).slice(0, 300)}`
        return finish('initialize falhou')
      }
      notify('initialized', {})

      // O modelo mais barato disponível — a sonda não paga turno caro.
      const models = await request('model/list', {})
      const data = (models?.result?.data ?? []).filter((m) => m?.id && !m.hidden)
      out.models = data.map((m) => m.id)
      out.chosenModel =
        CODEX_MODEL ||
        data.find((m) => /mini|nano|small/i.test(m.id))?.id ||
        data[data.length - 1]?.id ||
        null

      // Sanidade: a skill-sonda TEM que estar visível do cwd.
      const list = await request('skills/list', { cwds: [ROOTS.codex], forceReload: true })
      const entry = (list?.result?.data ?? [])[0]
      out.skillsList = {
        probe: (entry?.skills ?? [])
          .filter((s) => s?.name === SKILL_NAME)
          .map((s) => ({ name: s.name, scope: s.scope, enabled: s.enabled })),
        totalOutsideProbe: (entry?.skills ?? []).filter((s) => s?.name !== SKILL_NAME).length,
        errors: (entry?.errors ?? []).length
      }

      await scenario('use', [{ type: 'text', text: PROMPT_USE }])
      // DURABILIDADE: segundo uso da MESMA skill, na MESMA thread. Se o sinal
      // não se repetir, ele vale UMA vez por thread — e um contrato que só vale
      // na primeira vez não é contrato.
      await scenario('reuse', [{ type: 'text', text: PROMPT_USE }], { reuseThreadFrom: 'use' })
      // P4 — a entrada TIPADA que o schema do binário declara (SkillUserInput).
      await scenario('explicit', [
        { type: 'skill', name: SKILL_NAME, path: skillPathFor('codex') },
        { type: 'text', text: 'Follow it exactly.' }
      ])
      await scenario('none', [{ type: 'text', text: PROMPT_NONE }])

      finish('concluído')
    })().catch((e) => {
      out.error = `fatal: ${e?.message}`
      finish('fatal')
    })
  })
}

// ---------------------------------------------------------------------------
// Veredito: formas que existem no cenário que USA e não existem no negativo.
// ---------------------------------------------------------------------------
function diffShapes(positive, negative) {
  const neg = new Set(Object.keys(negative ?? {}))
  return Object.keys(positive ?? {})
    .filter((s) => !neg.has(s))
    .sort()
}

;(async () => {
  mkdirSync(OUT_DIR, { recursive: true })
  if (wants('claude')) writeFileSync(CAPTURE_CLAUDE, '')
  if (wants('codex')) writeFileSync(CAPTURE_CODEX, '')

  const report = {
    probedAt: new Date().toISOString(),
    versions: {
      claude: spawnSync('claude', ['--version'], { shell: true, encoding: 'utf8' }).stdout?.trim(),
      codex: spawnSync('codex', ['--version'], { shell: true, encoding: 'utf8' }).stdout?.trim()
    },
    skill: { name: SKILL_NAME, marker: MARKER, dirs: SKILL_DIR },
    prompts: { use: PROMPT_USE, none: PROMPT_NONE },
    workspace: null,
    claude: null,
    codex: null,
    verdict: null
  }

  report.workspace = buildWorkspace()
  console.log(`workspace: ${WS}`)
  for (const f of report.workspace.files) console.log(`  ${f.cli}: ${f.path}`)

  if (wants('claude')) {
    console.log(`\n=== claude ${report.versions.claude} — turnos em ${CLAUDE_MODEL} ===`)
    // DOIS turnos iguais na MESMA sessão: o segundo mede durabilidade.
    const use = await runClaude('use', [PROMPT_USE, PROMPT_USE])
    // P4: o caminho SLASH. A skill também vira comando; se o marcador for
    // outro por aqui, o app precisa saber.
    const slash = await runClaude('slash', [`/${SKILL_NAME}`])
    const none = await runClaude('none', [PROMPT_NONE])
    report.claude = { use, slash, none }
    for (const run of [use, slash, none]) {
      console.log(`  [${run.label}] ${run.stopReason}`)
      console.log(`     catálogo: total=${run.handshakeCommands?.total ?? '?'} sonda=${run.handshakeCommands?.probe?.length ?? 0}`)
      for (const t of run.turns) {
        console.log(`     turno ${t.index} · erro=${t.isError} · custo=${t.costUsd} · gabarito na resposta=${t.markerInAnswer}`)
        console.log(`        resposta: ${String(t.answerText ?? '').replace(/\s+/g, ' ').slice(0, 140)}`)
        for (const u of t.toolUses) console.log(`        tool_use ${u.name} input=${u.input}`)
      }
      for (const s of run.stderr.slice(0, 3)) console.log(`     [stderr] ${s}`)
      if (run.error) console.log(`     ERRO: ${run.error}`)
    }
  }

  if (wants('codex')) {
    console.log(`\n=== codex ${report.versions.codex} — app-server ===`)
    report.codex = await runCodex()
    console.log(`  modelo escolhido: ${report.codex.chosenModel} (de ${report.codex.models?.length ?? 0})`)
    console.log(`  skills/list sonda: ${JSON.stringify(report.codex.skillsList?.probe ?? [])}`)
    for (const rec of Object.values(report.codex.scenarios)) {
      console.log(`  [${rec.label}] thread=${rec.threadId ? 'ok' : 'FALHOU'} status=${rec.turnStatus}`)
      console.log(`     marcador do gabarito na resposta: ${rec.markerInAnswer}`)
      console.log(`     resposta: ${String(rec.answerText ?? '').replace(/\s+/g, ' ').slice(0, 140)}`)
      for (const it of rec.items)
        console.log(
          `     item ${it.type}${it.tool ? ` tool=${it.tool}` : ''}${it.name ? ` name=${it.name}` : ''}` +
            `${it.source ? ` source=${it.source}` : ''}${it.command ? ` cmd=${it.command.slice(0, 90)}` : ''}` +
            `${it.content ? ` content=${JSON.stringify(it.content)}` : ''}`
        )
      if (rec.error) console.log(`     ERRO: ${rec.error}`)
    }
    for (const s of report.codex.stderr.slice(0, 3)) console.log(`  [stderr] ${s}`)
  }

  // Resumo CUMULATIVO: rodar só uma metade não apaga a evidência da outra.
  let previous = null
  try {
    previous = JSON.parse(readFileSync(SUMMARY, 'utf8'))
  } catch {}
  if (!report.claude && previous?.claude) report.claude = previous.claude
  if (!report.codex && previous?.codex) report.codex = previous.codex

  report.verdict = {
    claude: report.claude
      ? {
          skillReallyUsed: report.claude.use?.turns?.[0]?.markerInAnswer ?? null,
          reuseReallyUsed: report.claude.use?.turns?.[1]?.markerInAnswer ?? null,
          slashReallyUsed: report.claude.slash?.turns?.[0]?.markerInAnswer ?? null,
          negativeUsedSkill: report.claude.none?.turns?.[0]?.markerInAnswer ?? null,
          shapesOnlyInUse: diffShapes(
            report.claude.use?.turns?.[0]?.shapes,
            report.claude.none?.turns?.[0]?.shapes
          ),
          shapesOnlyInReuse: diffShapes(
            report.claude.use?.turns?.[1]?.shapes,
            report.claude.none?.turns?.[0]?.shapes
          ),
          shapesOnlyInSlash: diffShapes(
            report.claude.slash?.turns?.[0]?.shapes,
            report.claude.none?.turns?.[0]?.shapes
          ),
          toolUsesInUse: report.claude.use?.turns?.map((t) => t.toolUses) ?? [],
          toolUsesInSlash: report.claude.slash?.turns?.[0]?.toolUses ?? [],
          skillToolOffered: (report.claude.use?.initTools ?? []).filter((t) => /skill/i.test(String(t)))
        }
      : null,
    codex: report.codex
      ? {
          skillReallyUsed: report.codex.scenarios?.use?.markerInAnswer ?? null,
          reuseReallyUsed: report.codex.scenarios?.reuse?.markerInAnswer ?? null,
          explicitReallyUsed: report.codex.scenarios?.explicit?.markerInAnswer ?? null,
          negativeUsedSkill: report.codex.scenarios?.none?.markerInAnswer ?? null,
          shapesOnlyInUse: diffShapes(
            report.codex.scenarios?.use?.shapes,
            report.codex.scenarios?.none?.shapes
          ),
          shapesOnlyInReuse: diffShapes(
            report.codex.scenarios?.reuse?.shapes,
            report.codex.scenarios?.none?.shapes
          ),
          shapesOnlyInExplicit: diffShapes(
            report.codex.scenarios?.explicit?.shapes,
            report.codex.scenarios?.none?.shapes
          ),
          itemsInUse: report.codex.scenarios?.use?.items ?? [],
          itemsInExplicit: report.codex.scenarios?.explicit?.items ?? []
        }
      : null
  }

  writeFileSync(SUMMARY, JSON.stringify(report, null, 2))

  console.log('\n=== VEREDITO — formas presentes SÓ no cenário que usa a skill ===')
  if (report.verdict.claude) {
    console.log('  claude · use:')
    for (const s of report.verdict.claude.shapesOnlyInUse) console.log(`     ${s}`)
    if (!report.verdict.claude.shapesOnlyInUse.length) console.log('     (nenhuma — não há marcador estrutural)')
    console.log('  claude · reuse (2º uso na MESMA sessão):')
    for (const s of report.verdict.claude.shapesOnlyInReuse) console.log(`     ${s}`)
    if (!report.verdict.claude.shapesOnlyInReuse.length)
      console.log('     (nenhuma — o sinal NÃO se repete no segundo uso)')
    console.log('  claude · slash:')
    for (const s of report.verdict.claude.shapesOnlyInSlash) console.log(`     ${s}`)
    if (!report.verdict.claude.shapesOnlyInSlash.length) console.log('     (nenhuma)')
    console.log(`  claude · tool "Skill" no catálogo do request: ${JSON.stringify(report.verdict.claude.skillToolOffered)}`)
  }
  if (report.verdict.codex) {
    console.log('  codex · use:')
    for (const s of report.verdict.codex.shapesOnlyInUse) console.log(`     ${s}`)
    if (!report.verdict.codex.shapesOnlyInUse.length) console.log('     (nenhuma — não há marcador estrutural)')
    console.log('  codex · reuse (2º uso na MESMA thread):')
    for (const s of report.verdict.codex.shapesOnlyInReuse) console.log(`     ${s}`)
    if (!report.verdict.codex.shapesOnlyInReuse.length)
      console.log('     (nenhuma — o sinal NÃO se repete no segundo uso)')
    console.log('  codex · explicit (SkillUserInput):')
    for (const s of report.verdict.codex.shapesOnlyInExplicit) console.log(`     ${s}`)
    if (!report.verdict.codex.shapesOnlyInExplicit.length) console.log('     (nenhuma)')
  }
  console.log(`\nresumo: ${SUMMARY}`)
  console.log(`cru: ${CAPTURE_CLAUDE} · ${CAPTURE_CODEX}`)

  if (KEEP) console.log(`\nworkspace preservado (--keep): ${WS}`)
  else {
    rmSync(WS, { recursive: true, force: true })
    console.log(`\nworkspace descartável apagado: ${existsSync(WS) ? 'FALHOU' : 'ok'}`)
  }
  process.exit(0)
})()
