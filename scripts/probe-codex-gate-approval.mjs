#!/usr/bin/env node
// Sonda 2 (02/08/2026) — a sonda 1 provou: gate codex com `--sandbox read-only
// --ask-for-approval never` LISTA as tools synkora mas TODA chamada morre em
// "user cancelled MCP tool call" (auto-negação da escalação), e `--disable
// shell_tool` remove qualquer leitura de arquivo. Esta sonda decide o fix:
// qual política de aprovação deixa a tool MCP completar sob sandbox read-only,
// e se o shell sob read-only lê sem conseguir escrever.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, '.tmp', 'probe-codex-gate-approval.json')
const CODEX_HOME = 'C:\\Users\\Erick\\AppData\\Roaming\\synkora\\seats\\756e8953-460c-47ea-8199-0a75d2315737'
const PROBE_CWD = resolve(ROOT, '.tmp', 'probe-codex-gate-cwd')
const EXEC_TIMEOUT_MS = 240_000

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24+ required')

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
  report: (id, content, summary) => {
    reportCalls.push({ at: new Date().toISOString(), paneId: id.paneId, content, summary })
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
console.log(`[probe2] servidor MCP real na porta ${port}`)

mkdirSync(PROBE_CWD, { recursive: true })
writeFileSync(join(PROBE_CWD, 'probe.txt'), 'SONDA_CONTEUDO_9137\n', 'utf8')

const mcp = codexMcpArgs(port)
let currentToken = ''
function newIdentity(label) {
  currentToken = randomUUID()
  identities.set(currentToken, {
    paneId: `probe2-${label}`,
    projectId: 'probe-project',
    role: 'review',
    cwd: PROBE_CWD,
    seatId: 'probe-seat'
  })
}

const PROMPT_REPORT =
  'Call the MCP tool "report" from the server "synkora" with arguments {"status":"aprovada"}. If the call fails or is cancelled, retry once. Print the exact result or error you received between BEGIN_RESULT and END_RESULT. Do not ask questions. Then stop.'
const PROMPT_READ_AND_WRITE =
  'Step 1: read the file "probe.txt" in the current directory (shell is fine) and print its exact content between BEGIN_FILE and END_FILE; if you cannot read it print NO_FILE_ACCESS. Step 2: try to create a file named "write-test.txt" with the content "x" and report between BEGIN_WRITE and END_WRITE whether the write succeeded or was blocked. Do not ask questions. Then stop.'

function runCodex(args, prompt, label) {
  return new Promise((resolveRun) => {
    const started = Date.now()
    const child = spawn('codex', [...args, 'exec', '--skip-git-repo-check', prompt], {
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
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolveRun({
        label,
        args,
        exitCode: code,
        signal,
        durationMs: Date.now() - started,
        stdout: stdout.slice(-10_000),
        stderr: stderr.slice(-10_000)
      })
    })
    // prompt vai como argumento; SEM fechar o stdin o codex exec espera EOF
    // para sempre (a causa dos 240s mudos da 1ª rodada desta sonda)
    child.stdin.end()
  })
}

const RO = ['--sandbox', 'read-only']
const variants = [
  // qual política deixa a chamada MCP completar sob sandbox read-only?
  // (on-failure NÃO existe no 0.146 — provado na 1ª rodada: clap exit 2)
  { label: 'W1-ro-on-request', args: [...RO, '--ask-for-approval', 'on-request', ...mcp], prompt: PROMPT_REPORT },
  { label: 'W3-ro-untrusted', args: [...RO, '--ask-for-approval', 'untrusted', ...mcp], prompt: PROMPT_REPORT },
  { label: 'W4-ro-default-approval', args: [...RO, ...mcp], prompt: PROMPT_REPORT },
  // isolar o gatilho: never SEM sandbox
  { label: 'W5-never-no-sandbox', args: ['--ask-for-approval', 'never', ...mcp], prompt: PROMPT_REPORT },
  // leitura E escrita com shell HABILITADO sob read-only + a política vencedora óbvia
  { label: 'W6-ro-never-shell-read-write', args: [...RO, '--ask-for-approval', 'never', ...mcp], prompt: PROMPT_READ_AND_WRITE }
]

const results = { port, runs: [] }
for (const variant of variants) {
  newIdentity(variant.label)
  const before = reportCalls.length
  console.log(`[probe2] rodando ${variant.label}…`)
  const run = await runCodex(variant.args, variant.prompt, variant.label)
  run.serverSawReport = reportCalls.length > before
  run.reportCallsDelta = reportCalls.slice(before)
  results.runs.push(run)
  console.log(`[probe2] ${variant.label}: exit ${run.exitCode} · report no servidor: ${run.serverSawReport}`)
}

results.reportCalls = reportCalls
writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8')
console.log(`[probe2] resultado em ${OUT}`)
await server.close?.()
process.exit(0)
