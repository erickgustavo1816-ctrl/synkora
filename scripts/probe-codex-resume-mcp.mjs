#!/usr/bin/env node
// Sonda 2026-08-04 — duas perguntas numa sessão só:
// (1) `codex resume <threadId>` nasce COM cliente MCP? (fix #11 da F6.6 diz
//     que não — respawn de fase codex vai FRESCO até esta sonda provar o
//     contrário no binário atual)
// (2) captura de BYTES CRUS do TUI codex (boot, thinking shimmer, streaming)
//     para diagnosticar as "letras comidas" dos tails ("Working/orking/rking")
//     — regra da casa: nunca mexer no cleanPtyChunk sem bytes reais.
//
// Fidelidade ao app: PTY real (@lydell/node-pty), servidor MCP REAL
// (startMcpServer), flags codexMcpArgs reais, CODEX_HOME de seat logado.
// Requer Node 24+ (type stripping). Gasta 2 turnos curtos de gpt-5.6-luna.

import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TMP = resolve(ROOT, '.tmp')
const OUT = join(TMP, 'probe-codex-resume-mcp.json')
const BYTES_FRESH = join(TMP, 'probe-codex-bytes-fresh.bin')
const BYTES_RESUME = join(TMP, 'probe-codex-bytes-resume.bin')
const CHUNKS_FRESH = join(TMP, 'probe-codex-chunks-fresh.jsonl')
const CHUNKS_RESUME = join(TMP, 'probe-codex-chunks-resume.jsonl')
const CODEX_HOME =
  'C:\\Users\\Erick\\AppData\\Roaming\\synkora\\seats\\756e8953-460c-47ea-8199-0a75d2315737'
const CODEX_EXE = 'C:\\Users\\Erick\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'
const PROBE_CWD = join(TMP, 'probe-codex-resume-cwd')
const MODEL = 'gpt-5.6-luna'

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24+ required')

const pty = await import('@lydell/node-pty')
const { startMcpServer, codexMcpArgs } = await import(
  new URL('../src/main/mcpServer.ts', import.meta.url)
)

mkdirSync(PROBE_CWD, { recursive: true })
for (const f of [BYTES_FRESH, BYTES_RESUME, CHUNKS_FRESH, CHUNKS_RESUME])
  writeFileSync(f, '')

// ——— servidor MCP real; evidência de conexão = lookup autenticado por token ———
const identities = new Map()
const lookups = []
const stub = () => 'probe-stub'
const asyncStub = async () => 'probe-stub'
const api = {
  hub: {
    identityByToken: (token) => {
      const identity = identities.get(token)
      if (identity) lookups.push({ at: Date.now(), paneId: identity.paneId })
      return identity
    }
  },
  boardStatus: () => JSON.stringify({ probe: true }),
  codeQuery: async () => JSON.stringify({ probe: true }),
  codeReportGuard: async () => undefined,
  createTasks: stub,
  archiveMission: stub,
  updateTask: stub,
  report: stub,
  delegateMany: asyncStub,
  listSkills: stub,
  setDefaultSkills: stub,
  notifyMaestro: stub,
  notifyPane: asyncStub,
  listPanes: stub,
  generateImage: asyncStub,
  createMission: stub,
  saveProjectPlan: stub,
  recordPlanningSkillUse: stub,
  approveProjectPlan: stub,
  startProjectMission: stub,
  guideIntegrationResolution: stub,
  createPlan: asyncStub,
  concludePlan: stub,
  runTask: asyncStub,
  deleteTask: stub,
  integrateMission: stub,
  queueMissions: stub,
  releaseVersion: stub,
  removeBacklogItem: stub,
  registerDirectMission: stub,
  listSeats: asyncStub,
  listHelpers: stub,
  helperOutput: stub,
  helperSend: stub,
  helperClose: stub
}
const server = await startMcpServer(api)
console.log(`[probe] servidor MCP real na porta ${server.port}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function newIdentity(label) {
  const token = randomUUID()
  identities.set(token, {
    paneId: `probe-${label}`,
    projectId: 'probe-project',
    role: 'dev',
    cwd: PROBE_CWD,
    seatId: 'probe-seat'
  })
  return token
}

function lookupsFor(label) {
  return lookups.filter((entry) => entry.paneId === `probe-${label}`)
}

function spawnCodexTui(label, extraArgs, token, binFile, chunksFile) {
  const env = { ...process.env }
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  delete env.CLAUDECODE
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDE_CONFIG_DIR') delete env[key]
  }
  env.CODEX_HOME = CODEX_HOME
  env.SYNKORA_TOKEN = token
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  const args = ['--model', MODEL, ...codexMcpArgs(server.port), ...extraArgs]
  console.log(`[probe] spawn ${label}: codex ${args.join(' ')}`)
  const proc = pty.spawn(CODEX_EXE, args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: PROBE_CWD,
    env,
    useConptyDll: true
  })
  let bytes = 0
  proc.onData((data) => {
    const buf = Buffer.from(data, 'utf8')
    bytes += buf.length
    appendFileSync(binFile, buf)
    appendFileSync(
      chunksFile,
      JSON.stringify({ t: Date.now(), b64: buf.toString('base64') }) + '\n'
    )
  })
  return { proc, totalBytes: () => bytes }
}

const results = { model: MODEL, seat: CODEX_HOME, runs: {} }

// ——— fase 1: sessão FRESCA (baseline + captura de bytes) ———
const tokenFresh = newIdentity('fresh')
const fresh = spawnCodexTui('fresh', [], tokenFresh, BYTES_FRESH, CHUNKS_FRESH)
const freshSpawnAt = Date.now()
await sleep(12_000)
const freshConnectMs = lookupsFor('fresh')[0]
  ? lookupsFor('fresh')[0].at - freshSpawnAt
  : null
// prompt que força thinking + streaming (bytes de shimmer para a sonda 2)
fresh.proc.write(
  'Explique em um paragrafo curto, sem ler arquivos e sem rodar comandos, o que e um design token.'
)
await sleep(700)
fresh.proc.write('\r')
await sleep(45_000)
results.runs.fresh = {
  connected: lookupsFor('fresh').length > 0,
  firstLookupMs: freshConnectMs,
  lookupCount: lookupsFor('fresh').length,
  capturedBytes: fresh.totalBytes()
}
console.log(`[probe] fresh: connected=${results.runs.fresh.connected} lookups=${results.runs.fresh.lookupCount} bytes=${results.runs.fresh.capturedBytes}`)
try {
  fresh.proc.kill()
} catch {}
await sleep(2_500)

// ——— acha o rollout da sessão fresca (uuid do filename) ———
function newestRollout(dir) {
  let best = null
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/^rollout-.*\.jsonl$/.test(entry.name)) {
        const mtime = statSync(full).mtimeMs
        if (!best || mtime > best.mtime) best = { file: full, mtime }
      }
    }
  }
  walk(dir)
  return best
}
const rollout = newestRollout(join(CODEX_HOME, 'sessions'))
if (!rollout) throw new Error('nenhum rollout encontrado pós-sessão fresca')
const uuidMatch = rollout.file.match(
  /rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
)
if (!uuidMatch) throw new Error(`rollout sem uuid no nome: ${rollout.file}`)
const threadId = uuidMatch[1]
results.rollout = { file: rollout.file, threadId }
console.log(`[probe] rollout da fresca: ${threadId}`)

// ——— fase 2: RESUME do mesmo thread, token NOVO ———
const tokenResume = newIdentity('resume')
const resumed = spawnCodexTui('resume', ['resume', threadId], tokenResume, BYTES_RESUME, CHUNKS_RESUME)
const resumeSpawnAt = Date.now()
await sleep(20_000)
const bootLookups = lookupsFor('resume').length
// um turno de verdade: se o cliente MCP existir, tools chegam a qualquer momento
resumed.proc.write('Diga apenas PONG, sem ler arquivos e sem comandos.')
await sleep(700)
resumed.proc.write('\r')
await sleep(40_000)
results.runs.resume = {
  connectedAtBoot: bootLookups > 0,
  connected: lookupsFor('resume').length > 0,
  firstLookupMs: lookupsFor('resume')[0]
    ? lookupsFor('resume')[0].at - resumeSpawnAt
    : null,
  lookupCount: lookupsFor('resume').length,
  capturedBytes: resumed.totalBytes()
}
console.log(`[probe] resume: connected=${results.runs.resume.connected} (boot=${results.runs.resume.connectedAtBoot}) lookups=${results.runs.resume.lookupCount} bytes=${results.runs.resume.capturedBytes}`)
try {
  resumed.proc.kill()
} catch {}

results.verdict = results.runs.resume.connected
  ? 'RESUME NASCE COM MCP no binário atual — reavaliar reintrodução do resume em fase codex'
  : 'CONFIRMADO: resume segue SEM cliente MCP — manter respawn fresco em fase codex'
writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8')
console.log(`[probe] veredito: ${results.verdict}`)
console.log(`[probe] resultado em ${OUT}; bytes em ${BYTES_FRESH} / ${BYTES_RESUME}`)
await server.close?.()
process.exit(0)
