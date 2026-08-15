// PROBE — contrato factual do stream-json do Claude Code para AGENTES EM SEGUNDO PLANO.
//
// Por que existe: o relatorio .synkora/reports/REGRESSAO_SUBAGENTES_CHAT_2026-08-14.md
// precisa saber, com FATO e nao com hipotese: qual envelope representa despacho
// assincrono, qual encerra de fato cada agente, se texto de filho sempre carrega
// linhagem, se ha ciclo raiz autonomo por conclusao e quantos `result` raiz aparecem.
//
// PRIVACIDADE (regra dura): o arquivo de captura recebe SOMENTE metadados
// estruturais — timestamp relativo, type/subtype, CAMINHOS de chave JSON (nunca
// valores), enums de protocolo de uma allowlist curta, comprimentos de string e
// hashes sha1-8 efemeros dos campos de identidade. Nenhum texto de mensagem,
// prompt, conta, e-mail ou caminho absoluto pode chegar ao disco.
//
// Uso:
//   node scripts/probe-claude-background-agents.mjs [--explicit-background] [--timeout 180]
//
// Nao toca em nenhum arquivo de produto. Escreve so em .tmp/probe-subagent-lifecycle/.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO = resolve(process.argv[1], '..', '..')
const OUT_DIR = join(REPO, '.tmp', 'probe-subagent-lifecycle')
const WS = join(OUT_DIR, 'ws')
const CAPTURE = join(OUT_DIR, 'capture-structural.jsonl')
const SUMMARY = join(OUT_DIR, 'summary.json')

const argv = process.argv.slice(2)
const EXPLICIT_BG = argv.includes('--explicit-background')
const TIMEOUT_S = Number(
  (argv.find((a) => a.startsWith('--timeout=')) || '').split('=')[1] ||
    (argv.includes('--timeout') ? argv[argv.indexOf('--timeout') + 1] : 0) ||
    180
)
// Silencio apos o primeiro result raiz que consideramos "assentou".
const QUIET_AFTER_RESULT_MS = Number(process.env.QUIET_MS || 30000)

mkdirSync(WS, { recursive: true })
// workspace descartavel: um arquivo bobo para o cwd nao ser vazio
writeFileSync(join(WS, 'README.md'), '# throwaway probe workspace\n')
try {
  rmSync(CAPTURE)
} catch {}

// ---------------------------------------------------------------------------
// Sanitizacao
// ---------------------------------------------------------------------------

const SALT = createHash('sha1').update(String(Date.now())).digest('hex').slice(0, 16)
const h8 = (v) =>
  v === null || v === undefined
    ? null
    : createHash('sha1').update(SALT + String(v)).digest('hex').slice(0, 8)

// Enums de PROTOCOLO: seguros (nao sao conteudo do usuario). Qualquer campo fora
// desta lista vira comprimento/hash, nunca valor.
const SAFE_ENUM_PATHS = new Set([
  'type',
  'subtype',
  'event.type',
  'event.delta.type',
  'event.content_block.type',
  'event.content_block.name',
  'message.role',
  'message.type',
  'message.stop_reason',
  'message.model',
  'message.content[].type',
  'message.content[].name',
  'is_error',
  'is_meta',
  'permission_denials[].tool_name',
  'status',
  'task.status',
  'tasks[].status',
  'agent.status',
  'agents[].status',
  'mode',
  'source',
  'reason',
  'level',
  'agentType',
  'agent_type',
  'workflowName',
  'workflow_name'
])

const IDENTITY_KEYS = new Set([
  'parent_tool_use_id',
  'parentToolUseId',
  'tool_use_id',
  'toolUseId',
  'task_id',
  'taskId',
  'agent_id',
  'agentId',
  'uuid',
  'session_id',
  'sessionId',
  'id',
  'leaf_uuid',
  'parent_uuid'
])

/** Caminho canonico: arrays viram `[]` para agrupar. */
function walk(node, path, acc) {
  if (node === null || typeof node !== 'object') {
    acc.paths.add(path || '$')
    return
  }
  if (Array.isArray(node)) {
    acc.arrayLens[path] = node.length
    for (const item of node) walk(item, `${path}[]`, acc)
    return
  }
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k
    if (v === null || v === undefined) {
      acc.paths.add(p)
      acc.nulls.add(p)
      continue
    }
    if (typeof v === 'object') {
      walk(v, p, acc)
      continue
    }
    acc.paths.add(p)
    if (IDENTITY_KEYS.has(k)) {
      acc.ids[p] = h8(v)
    } else if (SAFE_ENUM_PATHS.has(p) && typeof v === 'string' && v.length <= 64) {
      acc.enums[p] = v
    } else if (typeof v === 'string') {
      acc.lens[p] = v.length
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      // numeros/booleans de protocolo (usage, num_turns, duration) sao estruturais
      acc.scalars[p] = v
    }
  }
}

function structure(obj) {
  const acc = {
    paths: new Set(),
    nulls: new Set(),
    ids: {},
    enums: {},
    lens: {},
    scalars: {},
    arrayLens: {}
  }
  walk(obj, '', acc)
  return {
    paths: [...acc.paths].sort(),
    nullPaths: [...acc.nulls].sort(),
    ids: acc.ids,
    enums: acc.enums,
    strLens: acc.lens,
    scalars: acc.scalars,
    arrayLens: acc.arrayLens
  }
}

// ---------------------------------------------------------------------------
// Env limpo
// ---------------------------------------------------------------------------

const env = { ...process.env }
for (const k of Object.keys(env)) if (/^CLAUDE_CODE_/i.test(k)) delete env[k]
delete env['CLAUDECODE']
delete env['NO_COLOR']
delete env['FORCE_COLOR']
// CLAUDE_CONFIG_DIR fica FORA: usa a conta padrao ja logada do usuario.
delete env['CLAUDE_CONFIG_DIR']

const ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--permission-mode',
  'bypassPermissions',
  '--model',
  'haiku'
]

const PROMPT_DEFAULT =
  'Launch two agents in parallel using the Agent tool (subagent_type general-purpose, model haiku) with trivial prompts (each must just reply the single word ok). Then reply done.'
const PROMPT_EXPLICIT =
  'Launch two agents in parallel using the Agent tool with run_in_background set to true (subagent_type general-purpose, model haiku) with trivial prompts (each must just reply the single word ok). Then reply done.'
const PROMPT = EXPLICIT_BG ? PROMPT_EXPLICIT : PROMPT_DEFAULT

// ---------------------------------------------------------------------------
// Execucao
// ---------------------------------------------------------------------------

const t0 = Date.now()
let seq = 0
const typeCounts = new Map()
const rootResults = []
const timeline = []
let sawAnyAgentTool = false
let firstResultAt = null
let lastLineAt = Date.now()

console.log(`[probe] cwd=<ws>  model=haiku  explicitBackground=${EXPLICIT_BG}`)
console.log(`[probe] args: ${ARGS.join(' ')}`)

const child = spawn('claude', ARGS, {
  cwd: WS,
  env,
  shell: process.platform === 'win32'
})

let stdoutBuf = ''
child.stdout.on('data', (d) => {
  stdoutBuf += d.toString('utf8')
  let nl
  while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
    const line = stdoutBuf.slice(0, nl).trim()
    stdoutBuf = stdoutBuf.slice(nl + 1)
    if (line) onLine(line)
  }
})

let stderrLen = 0
child.stderr.on('data', (d) => {
  stderrLen += d.length
})

function onLine(line) {
  lastLineAt = Date.now()
  const t = Date.now() - t0
  seq += 1
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    // linha nao-JSON: registra so o fato e o tamanho
    appendFileSync(
      CAPTURE,
      JSON.stringify({ seq, t, parse: 'non-json', rawLen: line.length }) + '\n'
    )
    return
  }

  const st = structure(obj)
  const type = typeof obj.type === 'string' ? obj.type : '?'
  const subtype = typeof obj.subtype === 'string' ? obj.subtype : null
  const key = subtype ? `${type}/${subtype}` : type
  typeCounts.set(key, (typeCounts.get(key) || 0) + 1)

  // sinais de alto nivel usados para decidir quando parar
  const hasParentTop = Object.prototype.hasOwnProperty.call(obj, 'parent_tool_use_id')
  const parentVal = obj.parent_tool_use_id
  const parentNull = hasParentTop && (parentVal === null || parentVal === undefined)

  const toolNames = []
  const blockTypes = []
  const content = obj?.message?.content
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b && typeof b.type === 'string') blockTypes.push(b.type)
      if (b && b.type === 'tool_use' && typeof b.name === 'string') toolNames.push(b.name)
    }
  }
  if (toolNames.some((n) => n === 'Agent' || n === 'Task')) sawAnyAgentTool = true

  const rec = {
    seq,
    t,
    type,
    subtype,
    // linhagem: presenca no NIVEL TOPO e valor hasheado
    lineage: {
      topLevelKeyPresent: hasParentTop,
      topLevelNull: parentNull,
      topLevelHash: hasParentTop && !parentNull ? h8(parentVal) : null,
      anyPathWithParent: st.paths.filter((p) => /parent_tool_use_id|parentToolUseId/.test(p))
    },
    toolNames,
    blockTypes,
    ...st
  }
  timeline.push({ seq, t, key, toolNames, parent: rec.lineage.topLevelHash })
  appendFileSync(CAPTURE, JSON.stringify(rec) + '\n')

  const flag = hasParentTop ? (parentNull ? 'parent=null' : `parent=${h8(parentVal)}`) : 'no-parent-key'
  console.log(
    `[${String(t).padStart(6)}ms] #${String(seq).padStart(3)} ${key.padEnd(28)} ${flag}` +
      (toolNames.length ? `  tools=${toolNames.join(',')}` : '') +
      (blockTypes.length ? `  blocks=${blockTypes.join(',')}` : '')
  )

  if (type === 'result' && !parentVal) {
    rootResults.push({ seq, t, subtype })
    if (firstResultAt === null) firstResultAt = Date.now()
    console.log(`[probe] >>> ROOT RESULT #${rootResults.length} (subtype=${subtype}) at ${t}ms`)
  }
}

// envia UMA mensagem de usuario
const userMsg = {
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: PROMPT }] }
}
setTimeout(() => {
  child.stdin.write(JSON.stringify(userMsg) + '\n')
  console.log('[probe] prompt enviado; stdin fica ABERTO para observar assincronia')
}, 400)

// ---------------------------------------------------------------------------
// Parada: timeout duro OU silencio prolongado depois do 1o result raiz
// ---------------------------------------------------------------------------

let finished = false
function finish(why) {
  if (finished) return
  finished = true
  console.log(`[probe] encerrando: ${why}`)
  try {
    child.stdin.end()
  } catch {}
  setTimeout(() => {
    try {
      if (process.platform === 'win32')
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      else child.kill('SIGKILL')
    } catch {}
  }, 3000)
  setTimeout(() => report(why), 5000)
}

const watchdog = setInterval(() => {
  const elapsed = Date.now() - t0
  if (elapsed > TIMEOUT_S * 1000) return finish(`timeout ${TIMEOUT_S}s`)
  if (firstResultAt && Date.now() - lastLineAt > QUIET_AFTER_RESULT_MS)
    return finish(`silencio de ${QUIET_AFTER_RESULT_MS}ms apos result raiz`)
}, 1000)

child.on('exit', (code) => {
  console.log(`[probe] processo saiu code=${code}`)
  if (!finished) {
    finished = true
    setTimeout(() => report(`exit ${code}`), 500)
  }
})

let reported = false
function report(why) {
  if (reported) return
  reported = true
  clearInterval(watchdog)
  const summary = {
    cliVersionArgs: ARGS,
    explicitBackground: EXPLICIT_BG,
    stopReason: why,
    durationMs: Date.now() - t0,
    totalEnvelopes: seq,
    stderrBytes: stderrLen,
    sawAgentTool: sawAnyAgentTool,
    typeCounts: Object.fromEntries([...typeCounts.entries()].sort()),
    rootResults,
    timeline
  }
  writeFileSync(SUMMARY, JSON.stringify(summary, null, 2))
  console.log('\n================ RESUMO ESTRUTURAL ================')
  console.log(JSON.stringify({ ...summary, timeline: `<${timeline.length} entradas>` }, null, 2))
  console.log(`\ncaptura: ${CAPTURE}`)
  console.log(`resumo : ${SUMMARY}`)
  process.exit(0)
}
