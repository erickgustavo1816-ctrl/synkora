#!/usr/bin/env node
// Sonda 3 (02/08/2026) — o binário 0.146 expõe `default_tools_approval_mode`
// por servidor MCP ({on_request, on_request_auto_review, never,
// unless_trusted}). Esta sonda decide se algum desses valores deixa a tool
// synkora.report COMPLETAR sob `--sandbox read-only --ask-for-approval never`
// (o perfil do gate). Sinal de sucesso: serverSawReport=true.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, '.tmp', 'probe-codex-tools-approval.json')
const CODEX_HOME = 'C:\\Users\\Erick\\AppData\\Roaming\\synkora\\seats\\756e8953-460c-47ea-8199-0a75d2315737'
const PROBE_CWD = resolve(ROOT, '.tmp', 'probe-codex-gate-cwd')
const EXEC_TIMEOUT_MS = 180_000

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
console.log(`[probe3] servidor MCP real na porta ${port}`)
mkdirSync(PROBE_CWD, { recursive: true })

const mcp = codexMcpArgs(port)
const RO = ['--sandbox', 'read-only', '--ask-for-approval', 'never']
const PROMPT =
  'Call the MCP tool "report" from the server "synkora" with arguments {"status":"aprovada"}. Print the exact result or error between BEGIN_RESULT and END_RESULT. Do not ask questions. Then stop.'

let currentToken = ''
function newIdentity(label) {
  currentToken = randomUUID()
  identities.set(currentToken, {
    paneId: `probe3-${label}`,
    projectId: 'probe-project',
    role: 'review',
    cwd: PROBE_CWD,
    seatId: 'probe-seat'
  })
}

function runCodex(args, label) {
  return new Promise((resolveRun) => {
    const started = Date.now()
    const child = spawn('codex', [...args, 'exec', '--skip-git-repo-check', PROMPT], {
      cwd: PROBE_CWD,
      env: { ...process.env, CODEX_HOME, SYNKORA_TOKEN: currentToken, NO_COLOR: '1' },
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
    }, EXEC_TIMEOUT_MS)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({
        label,
        args,
        exitCode: code,
        durationMs: Date.now() - started,
        stdout: stdout.slice(-4_000),
        stderr: stderr.slice(-4_000)
      })
    })
    child.stdin.end()
  })
}

// enum REAL (denunciado pelo config loader na rodada anterior):
// auto | prompt | writes | approve
const variants = [
  {
    label: 'X4-tools-approval-auto',
    args: [...RO, ...mcp, '-c', 'mcp_servers.synkora.default_tools_approval_mode="auto"']
  },
  {
    label: 'X5-tools-approval-writes',
    args: [...RO, ...mcp, '-c', 'mcp_servers.synkora.default_tools_approval_mode="writes"']
  }
]

const results = { port, runs: [] }
for (const variant of variants) {
  newIdentity(variant.label)
  const before = reportCalls.length
  console.log(`[probe3] rodando ${variant.label}…`)
  const run = await runCodex(variant.args, variant.label)
  run.serverSawReport = reportCalls.length > before
  results.runs.push(run)
  console.log(`[probe3] ${variant.label}: exit ${run.exitCode} · report no servidor: ${run.serverSawReport}`)
  if (run.serverSawReport) break // achamos o modo — não gastar mais chamadas
}

results.reportCalls = reportCalls
writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8')
console.log(`[probe3] resultado em ${OUT}`)
await server.close?.()
process.exit(0)
