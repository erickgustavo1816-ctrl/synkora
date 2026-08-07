#!/usr/bin/env node
// Sonda 5 (02/08/2026) — o gate CLAUDE da F6.3 (--setting-sources= + plan mode
// + --tools Read,Grep,Glob,Skill + --allowedTools mcp__synkora__*) nunca rodou
// em produção. Valida headless: o reviewer claude consegue LER arquivo e
// COMPLETAR mcp__synkora__report? Sucesso: serverSawReport=true.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, '.tmp', 'probe-claude-gate-mcp.json')
const CLAUDE_CONFIG_DIR = 'C:\\Users\\Erick\\AppData\\Roaming\\synkora\\seats\\3504dd7c-8a97-4a01-9536-e95bd896f23d'
const PROBE_CWD = resolve(ROOT, '.tmp', 'probe-claude-gate-cwd')

const { startMcpServer, writeClaudeMcpConfig, claudeMcpArgs } = await import(
  new URL('../src/main/mcpServer.ts', import.meta.url)
)
const { panePermissionArgs } = await import(
  new URL('../src/main/panePermissions.ts', import.meta.url)
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
console.log(`[probe5] servidor MCP real na porta ${port}`)
mkdirSync(PROBE_CWD, { recursive: true })
writeFileSync(join(PROBE_CWD, 'probe.txt'), 'SONDA_CLAUDE_5513\n', 'utf8')

const token = randomUUID()
identities.set(token, {
  paneId: 'probe5-claude-gate',
  projectId: 'probe-project',
  role: 'review',
  cwd: PROBE_CWD,
  seatId: 'probe-seat'
})

const mcpDir = join(ROOT, '.tmp', 'probe-claude-gate-mcp')
mkdirSync(mcpDir, { recursive: true })
const configFile = writeClaudeMcpConfig(mcpDir, 'probe5-claude-gate', port, token)
// PROBE_NO_PLAN=1: perfil SEM plan mode (a sonda anterior provou que o plan
// mode bloqueia a tool report — mesma classe do defeito codex)
const permissionArgs = panePermissionArgs('claude', false, 'review-read-only')
const filteredPermissionArgs = process.env.PROBE_NO_PLAN
  ? permissionArgs.filter((arg, i, all) => arg !== '--permission-mode' && all[i - 1] !== '--permission-mode')
  : permissionArgs
const gateArgs = [...filteredPermissionArgs, ...claudeMcpArgs(configFile, true)]

const PROMPT =
  'You are the automated REVIEW gate of the Synkora harness running a pipeline SELF-TEST: the reporting path itself is what is being verified, so calling the report tool here is the expected, correct and authorized action. Step 1: read the file "probe.txt" in the current directory and print its exact content between BEGIN_FILE and END_FILE. Step 2: call the MCP tool mcp__synkora__report with {"status":"aprovada"} to prove the reporting path works. Print the exact result between BEGIN_RESULT and END_RESULT. Then stop.'

const run = await new Promise((resolveRun) => {
  const started = Date.now()
  // shell:true concatena args sem escapar — o prompt (tem espaços) precisa de
  // aspas próprias; os demais args do gate não contêm espaço neste repo
  const quotedPrompt = `"${PROMPT.replace(/"/g, '\\"')}"`
  const child = spawn(
    'claude',
    [...gateArgs, '--model', 'haiku', '-p', quotedPrompt, '--output-format', 'text'],
    {
      cwd: PROBE_CWD,
      env: (() => {
        const env = { ...process.env, CLAUDE_CONFIG_DIR, NO_COLOR: '1' }
        for (const key of Object.keys(env)) {
          if (key === 'CLAUDE_CONFIG_DIR') continue
          if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE') delete env[key]
        }
        return env
      })(),
      windowsHide: true,
      shell: true // claude é shim .cmd no PATH
    }
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {}
  }, 240_000)
  child.on('close', (code) => {
    clearTimeout(timer)
    resolveRun({
      exitCode: code,
      durationMs: Date.now() - started,
      stdout: stdout.slice(-6_000),
      stderr: stderr.slice(-6_000)
    })
  })
  child.stdin.end()
})

run.serverSawReport = reportCalls.length > 0
run.reportCalls = reportCalls
writeFileSync(OUT, JSON.stringify(run, null, 2), 'utf8')
console.log(
  `[probe5] exit ${run.exitCode} · report no servidor: ${run.serverSawReport} · leu arquivo: ${run.stdout.includes('SONDA_CLAUDE_5513')}`
)
console.log(`[probe5] resultado em ${OUT}`)
await server.close?.()
process.exit(0)
