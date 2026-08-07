#!/usr/bin/env node
// Sonda 4 (02/08/2026) — valida o PERFIL FINAL do gate codex: bypass de
// aprovações (única via provada para tool MCP completar) + disables de
// superfície (mantendo shell = leitura) + servidor synkora real.
// Sucesso: report chega ao SERVIDOR e o modelo lê arquivo.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, '.tmp', 'probe-codex-gate-fix.json')
const CODEX_HOME = 'C:\\Users\\Erick\\AppData\\Roaming\\synkora\\seats\\756e8953-460c-47ea-8199-0a75d2315737'
const PROBE_CWD = resolve(ROOT, '.tmp', 'probe-codex-gate-cwd')

const { startMcpServer, codexMcpArgs } = await import(
  new URL('../src/main/mcpServer.ts', import.meta.url)
)

const identities = new Map()
const reportCalls = []
const stub = () => 'probe-stub'
const asyncStub = async () => 'probe-stub'
const api = {
  hub: { identityByToken: (token) => identities.get(token) },
  boardStatus: () => JSON.stringify({ probe: true }),
  codeQuery: async () => JSON.stringify({ probe: true }),
  codeReportGuard: async () => undefined,
  createTasks: stub,
  archiveMission: stub,
  updateTask: stub,
  report: (id, content) => {
    reportCalls.push({ at: new Date().toISOString(), paneId: id.paneId, content })
    return 'report registrado (sonda)'
  },
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
const port = server.port
console.log(`[probe4] servidor MCP real na porta ${port}`)
mkdirSync(PROBE_CWD, { recursive: true })
writeFileSync(join(PROBE_CWD, 'probe.txt'), 'SONDA_CONTEUDO_9137\n', 'utf8')

// o PERFIL FINAL proposto para gates codex (espelha panePermissionArgs novo)
const GATE_ARGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--disable',
  'multi_agent',
  '--disable',
  'apps',
  '--disable',
  'browser_use',
  '--disable',
  'browser_use_external',
  '--disable',
  'browser_use_full_cdp_access',
  '--disable',
  'in_app_browser',
  '--disable',
  'computer_use',
  '--disable',
  'image_generation',
  '--disable',
  'plugins',
  '--disable',
  'remote_plugin',
  '--disable',
  'hooks',
  ...codexMcpArgs(port)
]

const PROMPT =
  'Step 1: read the file "probe.txt" in the current directory and print its exact content between BEGIN_FILE and END_FILE. Step 2: call the MCP tool "report" from the server "synkora" with arguments {"status":"aprovada"}. Print the exact result between BEGIN_RESULT and END_RESULT. Do not ask questions. Then stop.'

const token = randomUUID()
identities.set(token, {
  paneId: 'probe4-final-gate',
  projectId: 'probe-project',
  role: 'review',
  cwd: PROBE_CWD,
  seatId: 'probe-seat'
})

const run = await new Promise((resolveRun) => {
  const started = Date.now()
  const child = spawn('codex', [...GATE_ARGS, 'exec', '--skip-git-repo-check', PROMPT], {
    cwd: PROBE_CWD,
    env: { ...process.env, CODEX_HOME, SYNKORA_TOKEN: token, NO_COLOR: '1' },
    windowsHide: true
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {}
  }, 180_000)
  child.on('close', (code) => {
    clearTimeout(timer)
    resolveRun({
      exitCode: code,
      durationMs: Date.now() - started,
      stdout: stdout.slice(-5_000),
      stderr: stderr.slice(-5_000)
    })
  })
  child.stdin.end()
})

run.serverSawReport = reportCalls.length > 0
run.reportCalls = reportCalls
writeFileSync(OUT, JSON.stringify(run, null, 2), 'utf8')
console.log(
  `[probe4] exit ${run.exitCode} · report no servidor: ${run.serverSawReport} · leu arquivo: ${run.stdout.includes('SONDA_CONTEUDO_9137')}`
)
console.log(`[probe4] resultado em ${OUT}`)
await server.close?.()
process.exit(0)
