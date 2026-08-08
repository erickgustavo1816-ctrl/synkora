#!/usr/bin/env node
// probe-codex-mailbox-wait.mjs — FASE 5 (nível 5, 2026-08-08): sonda o
// equivalente CODEX das provas R12/R13 do claude (plano docs/PLANO_NIVEL_5.md,
// seção "Fase 5"): (a) LONG-POLL — o cliente MCP do codex aguenta uma tool
// call cuja resposta o servidor segura 45–75s? qual o teto? o knob
// `mcp_servers.<id>.tool_timeout_sec` muda o teto? (b) WAITER — o codex TUI
// tem exec em BACKGROUND (`--enable unified_exec`) que ACORDA o agente ao
// terminar, sem nenhuma digitação?
//
// Servidor: o mcpServer.ts REAL do app com api em Proxy (qualquer campo novo
// do contrato vira stub) — codeQuery é o ponto de long-poll (o handler de
// code_diagnostics já await'a a Promise; check_messages hoje é sync e por isso
// NÃO serve de veículo da sonda — torná-la async é trabalho da própria F5).
// Runs W1–W4 usam `codex exec` headless (tolerância de timeout é do core do
// cliente MCP); W5 usa TUI REAL via PowerShell -EncodedCommand, o caminho
// exato do pane do app (lição F6.7: resume/PTY divergem entre sonda e app).
//
// Uso: node scripts/probe-codex-mailbox-wait.mjs [W0,W1,...]   (default: todos)
// Saída: .tmp/probe-codex-mailbox-wait.json
// Custo: W1–W4 + W5a = 5 execs curtos de gpt-5.6-luna; W5 = 1 sessão TUI curta.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, '.tmp', 'probe-codex-mailbox-wait.json')
const CODEX_HOME =
  'C:\\Users\\Erick\\AppData\\Roaming\\synkora\\seats\\756e8953-460c-47ea-8199-0a75d2315737'
const PROBE_CWD = resolve(ROOT, '.tmp', 'probe-codex-wait-cwd')
const MODEL = 'gpt-5.6-luna'

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node 24+ required')

const only = (process.argv[2] || '').split(',').filter(Boolean)
const wants = (label) => only.length === 0 || only.some((o) => label.startsWith(o))

const { startMcpServer, codexMcpArgs } = await import(
  new URL('../src/main/mcpServer.ts', import.meta.url)
)
const { panePermissionArgs, codexGateMcpDisableArgs, codexGateMcpPolicyArgs } = await import(
  new URL('../src/main/panePermissions.ts', import.meta.url)
)

// ——— api do servidor real: Proxy anti-contrato-novo + codeQuery segurável ———
const identities = new Map()
const codeQueryCalls = []
let callDelayMs = 0
let callMarker = 'MAIL-SAYS-NONE'
let mailArrivesInMs = 0
let mailReady = false
const base = {
  hub: { identityByToken: (token) => identities.get(token) },
  // opcionais chamados com `?.` e checados por truthiness: o stub genérico do
  // Proxy (async) devolveria Promise truthy e corromperia o content da tool
  // (provado no W1: content[1].text virou Promise e o zod recusou).
  drainInboxFor: () => '',
  noteCatalogServed: () => {},
  // W6 — long-poll do check_messages: waitForMail segura até mailArrivesInMs
  // (0 = resolve vazio na hora) e o checkMessages devolve o marcador DEPOIS
  // da "chegada" — espelho fiel do contrato novo do F3a.
  waitForMail: (_id, timeoutMs) => {
    if (!mailArrivesInMs) return Promise.resolve(false)
    const wait = Math.min(mailArrivesInMs, timeoutMs)
    return new Promise((res) =>
      setTimeout(() => {
        mailReady = mailArrivesInMs <= timeoutMs
        res(mailReady)
      }, wait)
    )
  },
  checkMessages: () => (mailReady ? `[synkora inbox] 1. ${callMarker}` : 'no mail (probe)'),
  boardStatus: () => JSON.stringify({ probe: true }),
  report: () => 'report registrado (sonda)',
  codeQuery: (_id, query) => {
    const at = new Date().toISOString()
    codeQueryCalls.push({ at, operation: query?.operation, delayMs: callDelayMs })
    console.log(`[server] codeQuery recebida — segurando ${callDelayMs}ms`)
    return new Promise((res) =>
      setTimeout(() => res(JSON.stringify({ probe: true, marker: callMarker })), callDelayMs)
    )
  }
}
const api = new Proxy(base, {
  get: (t, k) => (k in t ? t[k] : async () => 'probe-stub')
})

const server = await startMcpServer(api)
const port = server.port
console.log(`[probe] servidor MCP real na porta ${port}`)
mkdirSync(PROBE_CWD, { recursive: true })
writeFileSync(join(PROBE_CWD, 'probe.txt'), 'PROBE_FASE5\n', 'utf8')

const seatConfigFile = join(CODEX_HOME, 'config.toml')
const seatConfig = existsSync(seatConfigFile) ? readFileSync(seatConfigFile, 'utf8') : ''
const gateArgs = () => {
  const disables = (() => {
    try {
      return codexGateMcpDisableArgs(seatConfig)
    } catch {
      return []
    }
  })()
  // codexGateMcpPolicyArgs é a peça que faz o gate codex REAL funcionar:
  // enabled_tools + default_tools_approval_mode="approve" + required=true.
  // Sem ela o codex AUTO-NEGA a tool ("user cancelled MCP tool call") —
  // re-provado aqui no W1 de 2026-08-08 (bypass true/false indiferente).
  return [
    ...panePermissionArgs('codex', true, 'review-read-only'),
    ...codexGateMcpPolicyArgs(),
    ...disables
  ]
}

let currentToken = ''
const newIdentity = (label, role = 'review') => {
  currentToken = randomUUID()
  identities.set(currentToken, {
    paneId: `probe-${label}`,
    projectId: 'probe-project',
    role,
    cwd: PROBE_CWD,
    seatId: 'probe-seat'
  })
}

const runExec = (args, prompt, label, timeoutMs) =>
  new Promise((resolveRun) => {
    const started = Date.now()
    const child = spawn('codex', [...args, 'exec', '--skip-git-repo-check', '-'], {
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
    }, timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolveRun({
        label,
        exitCode: code,
        signal,
        durationMs: Date.now() - started,
        stdout: stdout.slice(-8000),
        stderr: stderr.slice(-8000)
      })
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })

const LONGPOLL_PROMPT = (marker) =>
  `Do not read files and do not run shell commands. Call the MCP tool "code_diagnostics" from the server "synkora" with arguments {"path":"probe.txt"}. The result is JSON containing a field "marker". Print exactly the marker value you received between BEGIN and END. If the tool call fails, errors out or times out, print exactly TOOL-TIMEOUT and the error text. Then stop. Expected marker for reference: ${marker}`

const results = { when: new Date().toISOString(), model: MODEL, runs: [] }
results.codexVersion = await new Promise((res) => {
  const c = spawn('codex', ['--version'], { windowsHide: true })
  let o = ''
  c.stdout.on('data', (d) => (o += d))
  c.on('close', () => res(o.trim()))
})
console.log(`[probe] ${results.codexVersion}`)

const longpollRun = async (label, delayMs, extraArgs = []) => {
  if (!wants(label)) return
  newIdentity(label)
  callDelayMs = delayMs
  callMarker = `MAIL-SAYS-${label}`
  const before = codeQueryCalls.length
  console.log(`[probe] ${label}: delay ${delayMs}ms extra=${JSON.stringify(extraArgs)}`)
  const run = await runExec(
    [...gateArgs(), ...codexMcpArgs(port), ...extraArgs, '-m', MODEL],
    LONGPOLL_PROMPT(callMarker),
    label,
    delayMs + 180_000
  )
  run.serverSawCall = codeQueryCalls.length > before
  run.gotMarker = run.stdout.includes(callMarker)
  run.saidTimeout = run.stdout.includes('TOOL-TIMEOUT')
  run.verdict = run.gotMarker ? 'long-poll-ok' : run.saidTimeout ? 'client-timeout' : 'inconclusive'
  results.runs.push(run)
  console.log(`[probe] ${label}: ${run.verdict} (${run.durationMs}ms · call chegou: ${run.serverSawCall})`)
}

// W0 — parsing dos args (zero tokens)
if (wants('W0')) {
  newIdentity('W0')
  const run = await new Promise((resolveRun) => {
    const c = spawn('codex', [...gateArgs(), ...codexMcpArgs(port), 'mcp', 'list'], {
      cwd: PROBE_CWD,
      env: { ...process.env, CODEX_HOME, SYNKORA_TOKEN: currentToken, NO_COLOR: '1' },
      windowsHide: true
    })
    let o = ''
    let e = ''
    c.stdout.on('data', (d) => (o += d))
    c.stderr.on('data', (d) => (e += d))
    setTimeout(() => {
      try {
        c.kill('SIGKILL')
      } catch {}
    }, 60_000)
    c.on('close', (code) => resolveRun({ label: 'W0-mcp-list', exitCode: code, stdout: o.slice(-3000), stderr: e.slice(-3000) }))
  })
  results.runs.push(run)
  console.log(`[probe] W0: exit ${run.exitCode}`)
}

await longpollRun('W1-baseline', 0)
await longpollRun('W2-45s', 45_000)
await longpollRun('W3-75s', 75_000)
await longpollRun('W4-75s-timeout300', 75_000, ['-c', 'mcp_servers.synkora.tool_timeout_sec=300'])

// W6 — F3a de ponta a ponta com codex real: check_messages SEGURADA pelo
// servidor (mensagem "chega" 12s depois da chamada) — o modelo espera a tool
// e lê o correio que não existia quando chamou.
if (wants('W6')) {
  newIdentity('W6')
  mailArrivesInMs = 12_000
  mailReady = false
  callMarker = 'MAIL-SAYS-W6-LONGPOLL'
  const run = await runExec(
    [...gateArgs(), ...codexMcpArgs(port), '-m', MODEL],
    'Call the MCP tool "check_messages" from the server "synkora" exactly once. It may HOLD the response for a while — that is normal, wait for it. Print exactly the mail text you received between BEGIN and END. If it says no mail, print exactly NO-MAIL. Then stop.',
    'W6-check-messages-longpoll',
    240_000
  )
  run.gotMarker = run.stdout.includes('MAIL-SAYS-W6-LONGPOLL')
  run.verdict = run.gotMarker
    ? 'longpoll-mail-read'
    : run.stdout.includes('NO-MAIL')
      ? 'no-mail'
      : 'inconclusive'
  results.runs.push(run)
  console.log(`[probe] W6: ${run.verdict} (${run.durationMs}ms)`)
  mailArrivesInMs = 0
}

// W5a — catálogo com unified_exec ligado (headless, barato)
if (wants('W5a')) {
  newIdentity('W5a')
  const run = await runExec(
    ['--dangerously-bypass-approvals-and-sandbox', '--enable', 'unified_exec', '-m', MODEL],
    'Do not run anything. Print the exact list of tool names available to you right now, one per line, between BEGIN_TOOLS and END_TOOLS. Then stop.',
    'W5a-unified-exec-catalog',
    120_000
  )
  results.runs.push(run)
  console.log(`[probe] W5a: exit ${run.exitCode}`)
}

// ——— W5: waiter em TUI REAL (PTY PowerShell -EncodedCommand, caminho do app) ———
if (wants('W5') && !only.includes('W5a')) {
  const require2 = createRequire(join(ROOT, 'package.json'))
  const pty = require2('@lydell/node-pty')
  const quote = (s) => (/[ "']/.test(s) ? `'${s.replace(/'/g, "''")}'` : s)
  const cliArgs = [
    'codex',
    '--dangerously-bypass-approvals-and-sandbox',
    '--enable',
    'unified_exec',
    '-m',
    MODEL,
    '-c',
    'tui.keymap.editor.insert_newline="alt-enter"'
  ]
  const command = cliArgs.map(quote).join(' ')
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^CLAUDE_CODE_/i.test(k)) delete env[k]
  delete env.CLAUDECODE
  delete env.NO_COLOR
  delete env.FORCE_COLOR
  env.CODEX_HOME = CODEX_HOME
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  console.log(`[probe] W5 TUI: ${command}`)
  const proc = pty.spawn(
    'powershell.exe',
    ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { cols: 140, rows: 40, cwd: PROBE_CWD, env }
  )
  let raw = ''
  proc.onData((d) => (raw += d))
  let exited = false
  proc.onExit(() => (exited = true))
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const typeSlow = async (text) => {
    for (let i = 0; i < text.length; i += 160) {
      proc.write(text.slice(i, i + 160))
      await sleep(30)
    }
    await sleep(500)
    proc.write('\r')
  }
  const clean = () =>
    raw
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?<=>]*[A-Za-z]/g, '')
      .replace(/\x1b[=>78]|\x1b\([A-Z]/g, '')
  const W5_PROMPT =
    'You have a terminal tool that can run commands in BACKGROUND (async) mode. Step 1: start exactly this command as a background/async process: powershell -Command "Start-Sleep -Seconds 25; Write-Output MAIL-ARRIVED". Step 2: WITHOUT waiting for it, immediately end your turn replying exactly WAITING. Step 3: only when the background command completes and you are woken up by its completion, reply exactly WOKE-UP. Rules: if your terminal tool cannot run commands in background/async mode, reply exactly NO-BACKGROUND instead of WAITING. Never poll in a loop; never sleep in the foreground.'
  // A RESPOSTA vem do ROLLOUT (fonte estruturada) — a tela ECOA o prompt, e
  // os marcadores WAITING/NO-BACKGROUND do prompt davam falso positivo (a 1ª
  // rodada do W5 casou o eco e o /quit ABORTOU o turno real; mesmo bug do R7
  // da probe claude).
  const spawnAt = Date.now()
  const sessionsDir = join(CODEX_HOME, 'sessions')
  const newestRollout = () => {
    const days = []
    const walk = (dir, depth) => {
      let entries
      try {
        entries = readdirSync(dir)
      } catch {
        return
      }
      for (const e of entries) {
        const p = join(dir, e)
        let st
        try {
          st = statSync(p)
        } catch {
          continue
        }
        if (st.isDirectory() && depth < 3) walk(p, depth + 1)
        else if (e.startsWith('rollout-') && e.endsWith('.jsonl') && st.mtimeMs >= spawnAt - 5000)
          days.push({ p, m: st.mtimeMs })
      }
    }
    walk(sessionsDir, 0)
    days.sort((a, b) => b.m - a.m)
    return days[0]?.p
  }
  const agentTexts = () => {
    const file = newestRollout()
    if (!file) return []
    const out = []
    try {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue
        try {
          const j = JSON.parse(line)
          const p = j.payload ?? {}
          const item = p.item ?? {}
          if (p.type === 'item_completed' && item.type === 'AgentMessage') {
            for (const c of item.content ?? []) if (c.text) out.push(c.text)
          } else if (p.type === 'message' && p.role === 'assistant') {
            for (const c of p.content ?? []) if (c.text) out.push(c.text)
          } else if (p.type === 'agent_message' && typeof p.message === 'string') {
            out.push(p.message)
          }
        } catch {}
      }
    } catch {}
    return out
  }
  const t0 = Date.now()
  while (!raw && Date.now() - t0 < 30_000) await sleep(250)
  await sleep(6000) // TUI de pé
  await typeSlow(W5_PROMPT)
  let waitingAt = 0
  let wokeAt = 0
  let noBackground = false
  const budget = Date.now() + 180_000
  while (Date.now() < budget) {
    await sleep(2000)
    const texts = agentTexts()
    if (!waitingAt && texts.some((t) => /\bWAITING\b/.test(t))) {
      waitingAt = Date.now()
      console.log('[probe] W5: WAITING (do agente) — turno encerrado, aguardando acordar…')
    }
    if (texts.some((t) => /\bNO-BACKGROUND\b/.test(t))) {
      noBackground = true
      break
    }
    if (texts.some((t) => /\bWOKE-UP\b/.test(t))) {
      wokeAt = Date.now()
      break
    }
  }
  await typeSlow('/quit')
  const t1 = Date.now()
  while (!exited && Date.now() - t1 < 8000) await sleep(500)
  if (!exited) {
    try {
      proc.kill()
    } catch {}
  }
  const tail = clean()
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-50)
  results.runs.push({
    label: 'W5-tui-background-waiter',
    verdict: noBackground
      ? 'no-background'
      : wokeAt
        ? 'woke-up'
        : waitingAt
          ? 'waited-never-woke'
          : 'no-waiting-marker',
    waitingSeen: Boolean(waitingAt),
    wokeAfterMs: wokeAt && waitingAt ? wokeAt - waitingAt : null,
    rawTail: tail
  })
  console.log(`[probe] W5: ${results.runs.at(-1).verdict} (acordou após ${results.runs.at(-1).wokeAfterMs}ms)`)
}

results.codeQueryCalls = codeQueryCalls
writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8')
console.log(`[probe] resultado em ${OUT}`)
await server.close?.()
process.exit(0)
