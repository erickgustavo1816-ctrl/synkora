// Live structural probe of the Codex app-server sub-agent (collab) protocol.
//
// Spawns `codex app-server`, opens a throwaway thread in .tmp/probe-codex-collab/ws
// and runs ONE turn whose prompt asks for two sub-agents. Every JSON-RPC frame the
// server sends is recorded STRUCTURALLY only: relative timestamp, method, key paths,
// enum values from a fixed whitelist, salted sha1-8 for ids, string LENGTHS for free
// text. No prompt/message text, no account data, no absolute paths leave this file.
//
//   node scripts/probe-codex-collab-agents.mjs [--enable <feature>]... [--timeout ms]
//
// Output: .tmp/probe-codex-collab/capture-structural.jsonl + summary.json
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

const ROOT = resolve(process.cwd())
const OUT_DIR = resolve(ROOT, '.tmp/probe-codex-collab')
const WS_DIR = resolve(OUT_DIR, 'ws')
const CAPTURE = resolve(OUT_DIR, 'capture-structural.jsonl')
const SUMMARY = resolve(OUT_DIR, 'summary.json')

const argv = process.argv.slice(2)
const enables = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--enable' && argv[i + 1]) enables.push(argv[++i])
}
const TIMEOUT_MS = Number(argv[argv.indexOf('--timeout') + 1]) || 240_000
const PROMPT_VARIANT = argv.includes('--slow') ? 2 : argv.includes('--retry') ? 1 : 0

// The prompt is deliberately explicit: we are testing the transport, not the model's
// judgement about whether delegation is worthwhile.
const PROMPTS = [
  'Use your agent collaboration tools to spawn TWO sub-agents right now. Give each one ' +
    'the single instruction: reply with the word ok and nothing else. Wait for both to ' +
    'finish, then close them and reply DONE. Do not read or write any file.',
  'You have multi-agent tools (spawn_agent / wait / close_agent). This is a transport ' +
    'test: call spawn_agent twice to create two sub-agents, each told only to answer ' +
    '"ok", then wait for both and close them. Reply DONE when finished. Touch no files.',
  // Slow variant: children must still be RUNNING when the parent waits, so the wait
  // tool call is observed with a non-trivial agentsStates snapshot.
  'Spawn TWO sub-agents at once with your agent collaboration tools. Instruct each to ' +
    'reason step by step, at length, about the number seven for a good while before ' +
    'answering with the single word ok. Immediately after spawning both, wait for them, ' +
    'then close both agents and reply DONE. Do not read or write any file.'
]

// ---------- structural redaction ----------
const SALT = randomBytes(16)
const idMap = new Map()
function sid(value) {
  if (typeof value !== 'string' || !value) return null
  let out = idMap.get(value)
  if (!out) {
    out = createHash('sha1').update(SALT).update(value).digest('hex').slice(0, 8)
    idMap.set(value, out)
  }
  return out
}
/** Keys whose values are protocol ENUMS or booleans — safe and load-bearing. */
const ENUM_KEYS = new Set([
  'type', 'status', 'tool', 'kind', 'phase', 'outcome', 'role', 'reasoningEffort',
  'effort', 'source', 'threadSource', 'modelProvider', 'ephemeral', 'stream',
  'sessionStartSource', 'method', 'success', 'isError', 'readOnlyHint'
])
/** Keys that identify an agent: kept because the sidebar would display them and the
 *  values come from this probe's own throwaway prompt. */
const IDENTITY_KEYS = new Set(['agentNickname', 'agentRole', 'agentPath', 'model', 'name'])
/** Keys that carry conversation content — length only, never the text. */
const TEXT_KEYS = new Set([
  'prompt', 'text', 'delta', 'message', 'summary', 'preview', 'content',
  'aggregatedOutput', 'command', 'errorText', 'instructions', 'developerInstructions',
  'baseInstructions', 'cwd', 'path', 'title', 'query', 'goal'
])
const ID_KEY_RE = /(^|[a-z])(id|ids)$/i

function shape(value, path, sink) {
  if (value === null) { sink.push(`${path}=null`); return null }
  if (Array.isArray(value)) {
    sink.push(`${path}[]:${value.length}`)
    return value.map((v, i) => shape(v, `${path}[]`, i === 0 ? sink : []))
  }
  if (typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) {
      out[k] = shape(value[k], path ? `${path}.${k}` : k, sink)
    }
    return out
  }
  const key = path.split(/[.[]/).filter(Boolean).pop() || ''
  if (typeof value === 'number') { sink.push(`${path}:num`); return value < 1e11 ? value : '<ts>' }
  if (typeof value === 'boolean') { sink.push(`${path}:bool`); return value }
  if (typeof value !== 'string') { sink.push(`${path}:${typeof value}`); return `<${typeof value}>` }
  if (ENUM_KEYS.has(key)) { sink.push(`${path}=${value}`); return value }
  if (IDENTITY_KEYS.has(key)) {
    // model/nickname/role are short identifiers; cwd-like paths are caught by TEXT_KEYS
    sink.push(`${path}~id`)
    return value.length > 64 ? `<len:${value.length}>` : value
  }
  if (ID_KEY_RE.test(key)) { sink.push(`${path}~sha`); return sid(value) }
  if (TEXT_KEYS.has(key)) { sink.push(`${path}~len`); return `<len:${value.length}>` }
  sink.push(`${path}~str`)
  return `<len:${value.length}>`
}

// ---------- run ----------
rmSync(WS_DIR, { recursive: true, force: true })
mkdirSync(WS_DIR, { recursive: true })
writeFileSync(CAPTURE, '')

const env = { ...process.env }
for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_')) delete env[k]
delete env.CLAUDECODE
delete env.NO_COLOR
delete env.FORCE_COLOR
delete env.CODEX_HOME // user's default logged-in account, on purpose

const args = []
for (const f of enables) args.push('--enable', f)
args.push('app-server')

const t0 = Date.now()
const child = spawn('codex', args, {
  cwd: WS_DIR,
  env,
  shell: process.platform === 'win32'
})

const records = []
const methodPaths = new Map()
const methodCount = new Map()
let buf = ''
let nextId = 1
const pending = new Map()
let threadId = null
let finished = false

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n')
}
function request(method, params) {
  const id = nextId++
  return new Promise((res) => {
    pending.set(id, res)
    send({ jsonrpc: '2.0', id, method, params })
  })
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params })
}

function record(kind, method, payload) {
  const paths = []
  const structure = shape(payload ?? null, '', paths)
  const rec = { t: Date.now() - t0, kind, method, structure }
  records.push(rec)
  appendFileSync(CAPTURE, JSON.stringify(rec) + '\n')
  const key = `${kind} ${method}`
  methodCount.set(key, (methodCount.get(key) || 0) + 1)
  const set = methodPaths.get(key) || new Set()
  for (const p of paths) set.add(p)
  methodPaths.set(key, set)
  const label = method === 'item/started' || method === 'item/completed'
    ? `${method} <${payload?.item?.type}${payload?.item?.tool ? '/' + payload.item.tool : ''}${payload?.item?.kind ? '/' + payload.item.kind : ''}${payload?.item?.status ? ' ' + payload.item.status : ''}>`
    : method
  process.stderr.write(`[${String(rec.t).padStart(6)}ms] ${kind} ${label}\n`)
}

child.stdout.on('data', (d) => {
  buf += d.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.id !== undefined && msg.method === undefined) {
      record('response', `#${msg.id}`, msg.result ?? { error: msg.error })
      const res = pending.get(msg.id)
      if (res) { pending.delete(msg.id); res(msg) }
      continue
    }
    if (msg.id !== undefined && msg.method) {
      // server -> client REQUEST (approvals). Auto-decline nothing: accept so the
      // turn can proceed; sub-agent spawn should not need it with approvalPolicy never.
      record('server-request', msg.method, msg.params)
      send({ jsonrpc: '2.0', id: msg.id, result: { decision: 'accept' } })
      continue
    }
    if (msg.method) {
      record('notification', msg.method, msg.params)
      // Sub-agent turns complete on THEIR OWN threadId on this same connection.
      // Only the ROOT thread's turn/completed ends the probe.
      if (msg.method === 'turn/completed' && msg.params?.threadId === threadId) finished = true
    }
  }
})
child.stderr.on('data', (d) => process.stderr.write(`[codex stderr] ${d}`))

function finish(reason) {
  const summary = {
    codexArgs: args,
    reason,
    durationMs: Date.now() - t0,
    frames: records.length,
    methods: Object.fromEntries([...methodCount.entries()].sort()),
    keyPaths: Object.fromEntries(
      [...methodPaths.entries()].sort().map(([k, v]) => [k, [...v].sort()])
    ),
    sequence: records.map((r) => ({
      t: r.t,
      m: r.method,
      item: r.structure?.item
        ? {
            type: r.structure.item.type,
            tool: r.structure.item.tool,
            kind: r.structure.item.kind,
            status: r.structure.item.status,
            id: r.structure.item.id,
            threadId: r.structure.threadId,
            senderThreadId: r.structure.item.senderThreadId,
            receiverThreadIds: r.structure.item.receiverThreadIds,
            agentsStates: r.structure.item.agentsStates,
            agentThreadId: r.structure.item.agentThreadId
          }
        : undefined,
      thread: r.structure?.thread
        ? {
            id: r.structure.thread.id,
            parentThreadId: r.structure.thread.parentThreadId,
            agentNickname: r.structure.thread.agentNickname,
            agentRole: r.structure.thread.agentRole,
            sessionId: r.structure.thread.sessionId
          }
        : undefined
    }))
  }
  writeFileSync(SUMMARY, JSON.stringify(summary, null, 1))
  process.stderr.write(`\n[probe] ${reason} · ${records.length} frames · ${SUMMARY}\n`)
  try { child.kill() } catch {}
  setTimeout(() => process.exit(0), 300)
}

const hardTimer = setTimeout(() => finish('timeout'), TIMEOUT_MS)

;(async () => {
  await request('initialize', {
    clientInfo: { name: 'synkora-probe', title: 'Synkora probe', version: '0.0.1' }
  })
  notify('initialized', {})
  const started = await request('thread/start', {
    cwd: WS_DIR,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    ephemeral: true
  })
  threadId = started.result?.thread?.id
  if (!threadId) return finish('thread/start failed')
  await request('turn/start', {
    threadId,
    input: [{ type: 'text', text: PROMPTS[PROMPT_VARIANT] }],
    approvalPolicy: 'never'
  })
  const poll = setInterval(() => {
    if (finished) {
      clearInterval(poll)
      clearTimeout(hardTimer)
      // Generous settle window: reconciliation frames trail the root terminal.
      setTimeout(() => finish('turn/completed (root)'), 6000)
    }
  }, 250)
})().catch((e) => {
  process.stderr.write(`[probe] fatal ${e?.message}\n`)
  finish('fatal')
})
