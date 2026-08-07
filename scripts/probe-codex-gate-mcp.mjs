#!/usr/bin/env node
// Sonda F-estabilização 02/08/2026 — por que o gate Codex read-only nasce sem
// as tools do MCP synkora? Sobe o SERVIDOR REAL (mcpServer.ts) com identity
// role 'review', monta os args com as FUNÇÕES REAIS do app e roda o binário
// `codex` do seat em variantes A/B. Saída: .tmp/probe-codex-gate-mcp.json.
//
// Requer Node 24+ (type stripping) e o codex do PATH logado no CODEX_HOME
// indicado. Cada variante `exec` gasta uma chamada curta de modelo barato.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, '.tmp', 'probe-codex-gate-mcp.json')
const CODEX_HOME = 'C:\\Users\\Erick\\AppData\\Roaming\\synkora\\seats\\756e8953-460c-47ea-8199-0a75d2315737'
const PROBE_CWD = resolve(ROOT, '.tmp', 'probe-codex-gate-cwd')
const MODEL = 'gpt-5.6-luna'
const EXEC_TIMEOUT_MS = 240_000

if (Number(process.versions.node.split('.')[0]) < 24) {
  throw new Error('Node 24+ required')
}

const { startMcpServer } = await import(new URL('../src/main/mcpServer.ts', import.meta.url))
const { panePermissionArgs, codexGateMcpDisableArgs } = await import(
  new URL('../src/main/panePermissions.ts', import.meta.url)
)
const { codexMcpArgs } = await import(new URL('../src/main/mcpServer.ts', import.meta.url))

// ——— servidor real com identity de reviewer ———
const identities = new Map()
const reportCalls = []
const boardCalls = []
const stub = () => 'probe-stub'
const asyncStub = async () => 'probe-stub'
const api = {
  hub: { identityByToken: (token) => identities.get(token) },
  boardStatus: (id) => {
    boardCalls.push({ at: new Date().toISOString(), paneId: id.paneId })
    return JSON.stringify({ probe: true, role: id.role })
  },
  codeQuery: async (id, query) => JSON.stringify({ probe: true, operation: query.operation }),
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
console.log(`[probe] servidor MCP real de pé na porta ${port}`)

mkdirSync(PROBE_CWD, { recursive: true })
writeFileSync(join(PROBE_CWD, 'probe.txt'), 'SONDA_CONTEUDO_9137\n', 'utf8')

const seatConfigFile = join(CODEX_HOME, 'config.toml')
const seatConfig = existsSync(seatConfigFile) ? readFileSync(seatConfigFile, 'utf8') : ''

function gatePermissionArgs() {
  return panePermissionArgs('codex', false, 'review-read-only')
}
function disableArgs() {
  try {
    return codexGateMcpDisableArgs(seatConfig)
  } catch (error) {
    return { error: String(error) }
  }
}
function mcpArgs() {
  // sem protocolArgs = era legacy, igual ao caminho quando o modo 2026 não ativa
  return codexMcpArgs(port)
}

function dropFlagPairs(args, flagValuePairsToDrop) {
  // remove ocorrências de ['--disable','X'] listadas
  const out = []
  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1]
    if (args[i] === '--disable' && flagValuePairsToDrop.includes(next)) {
      i += 1
      continue
    }
    out.push(args[i])
  }
  return out
}

const PROMPT_TOOLS =
  'Do not read files and do not run shell commands. Step 1: print the exact list of tool names available to you right now, one per line, between the markers BEGIN_TOOLS and END_TOOLS. Step 2: call the MCP tool "report" from the server "synkora" with arguments {"status":"aprovada"}. If that tool is not available to you, print exactly NO_SYNKORA_REPORT. Then stop. Do not ask questions.'
const PROMPT_READ =
  'Read the file "probe.txt" in the current directory and print its exact content between BEGIN_FILE and END_FILE. If you have no way to read files, print exactly NO_FILE_ACCESS. Then stop. Do not ask questions.'

function runCodex(args, prompt, label) {
  return new Promise((resolveRun) => {
    const started = Date.now()
    // shell:false: o Node escapa cada arg no padrão CommandLineToArgvW e o
    // codex recebe as aspas TOML internas intactas — igual ao PTY do app.
    const child = spawn('codex', [...args, 'exec', '--skip-git-repo-check', '-'], {
      cwd: PROBE_CWD,
      env: {
        ...process.env,
        CODEX_HOME,
        SYNKORA_TOKEN: currentToken,
        NO_COLOR: '1'
      },
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
        stdout: stdout.slice(-12_000),
        stderr: stderr.slice(-12_000)
      })
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

function runCodexMcpList(args, label) {
  return new Promise((resolveRun) => {
    const child = spawn('codex', [...args, 'mcp', 'list'], {
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
    }, 60_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({ label, args, exitCode: code, stdout: stdout.slice(-8_000), stderr: stderr.slice(-8_000) })
    })
  })
}

let currentToken = ''
function newReviewIdentity(label) {
  currentToken = randomUUID()
  identities.set(currentToken, {
    paneId: `probe-${label}`,
    projectId: 'probe-project',
    role: 'review',
    cwd: PROBE_CWD,
    seatId: 'probe-seat'
  })
  return currentToken
}

const results = { codexVersion: '', disableArgsComputed: disableArgs(), runs: [] }

// versão
results.codexVersion = await new Promise((res) => {
  const child = spawn('codex', ['--version'], { windowsHide: true })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  child.on('close', () => res(out.trim()))
})

const perm = gatePermissionArgs()
const disables = Array.isArray(results.disableArgsComputed) ? results.disableArgsComputed : []
const mcp = mcpArgs()

const variants = [
  // 0: parsing/estado sem gastar modelo
  { kind: 'mcp-list', label: 'V0-mcp-list-full-gate', args: [...perm, ...disables, ...mcp] },
  // 1: exatamente o que o app monta para um gate review codex (sem resume)
  { kind: 'exec', label: 'V1-full-gate', args: [...perm, ...disables, ...mcp], prompt: PROMPT_TOOLS },
  // 2: controle positivo — perfil write (sem sandbox/read-only, sem disables)
  { kind: 'exec', label: 'V2-write-profile', args: [...mcp], prompt: PROMPT_TOOLS },
  // 3: gate sem NENHUM --disable de feature (mantém sandbox+approval)
  {
    kind: 'exec',
    label: 'V3-gate-no-feature-disables',
    args: [...perm.slice(0, 4), ...disables, ...mcp],
    prompt: PROMPT_TOOLS
  },
  // 4: gate completo MENOS --disable code_mode_host
  {
    kind: 'exec',
    label: 'V4-keep-code-mode-host',
    args: [...dropFlagPairs(perm, ['code_mode_host']), ...disables, ...mcp],
    prompt: PROMPT_TOOLS
  },
  // 5: gate completo MENOS --disable plugins/remote_plugin
  {
    kind: 'exec',
    label: 'V5-keep-plugins',
    args: [...dropFlagPairs(perm, ['plugins', 'remote_plugin']), ...disables, ...mcp],
    prompt: PROMPT_TOOLS
  },
  // 6: leitura de arquivo com o gate completo (o reviewer precisa LER)
  { kind: 'exec', label: 'V6-full-gate-read-file', args: [...perm, ...disables, ...mcp], prompt: PROMPT_READ }
]

for (const variant of variants) {
  newReviewIdentity(variant.label)
  const before = { reports: reportCalls.length, boards: boardCalls.length }
  console.log(`[probe] rodando ${variant.label}…`)
  const run =
    variant.kind === 'mcp-list'
      ? await runCodexMcpList(variant.args, variant.label)
      : await runCodex(variant.args, variant.prompt, variant.label)
  run.serverSawReport = reportCalls.length > before.reports
  run.serverSawBoardStatus = boardCalls.length > before.boards
  run.reportCallsDelta = reportCalls.slice(before.reports)
  results.runs.push(run)
  console.log(
    `[probe] ${variant.label}: exit ${run.exitCode} · report chegou ao servidor: ${run.serverSawReport}`
  )
}

results.reportCalls = reportCalls
writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8')
console.log(`[probe] resultado completo em ${OUT}`)
await server.close?.()
process.exit(0)
