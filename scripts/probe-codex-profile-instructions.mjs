#!/usr/bin/env node
// probe-codex-profile-instructions.mjs — FASE 5 (2026-08-09): o profile file
// por pane do codex (`<nome>.config.toml` no CODEX_HOME, o mesmo mecanismo do
// skill isolation) carrega `developer_instructions`? Três provas:
//   P1: instrução CURTA no profile chega ao modelo (canal existe);
//   P2: instrução de ~40KB chega (acima do teto de 32.767 do argv — o canal
//       por ARQUIVO fura o limite que o -c inline tem);
//   P3: precedência quando -c developer_instructions TAMBÉM é passado
//       (documenta o cuidado: nunca misturar os dois canais no mesmo pane).
// Uso: node scripts/probe-codex-profile-instructions.mjs [P1,P2,P3]
// Saída: .tmp/probe-codex-profile-instructions.json

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, '.tmp', 'probe-codex-profile-instructions.json')
const CODEX_HOME =
  'C:\\Users\\Erick\\AppData\\Roaming\\synkora\\seats\\756e8953-460c-47ea-8199-0a75d2315737'
const PROBE_CWD = resolve(ROOT, '.tmp', 'probe-codex-profile-cwd')
const MODEL = 'gpt-5.6-luna'
const PROFILE = 'synkora-probe-instr'
const PROFILE_PATH = join(CODEX_HOME, `${PROFILE}.config.toml`)

const only = (process.argv[2] || '').split(',').filter(Boolean)
const wants = (label) => only.length === 0 || only.includes(label)

// mesma serialização do app (codexDeveloperInstructions): string TOML de uma linha
const tomlInstr = (value) =>
  `developer_instructions="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`

const runExec = (args, prompt, label) =>
  new Promise((resolveRun) => {
    const started = Date.now()
    const child = spawn(
      'codex',
      [...args, 'exec', '--skip-git-repo-check', '-'],
      {
        cwd: PROBE_CWD,
        env: { ...process.env, CODEX_HOME, NO_COLOR: '1' },
        windowsHide: true
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
    }, 180_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolveRun({
        label,
        exitCode: code,
        durationMs: Date.now() - started,
        stdout: stdout.slice(-3000),
        stderr: stderr.slice(-2000)
      })
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })

mkdirSync(PROBE_CWD, { recursive: true })
const results = { when: new Date().toISOString(), model: MODEL, runs: [] }
const PROMPT =
  'Do not run anything. What is the MAGIC WORD stated in your developer instructions? Reply with EXACTLY that word and nothing else. If your developer instructions contain no magic word, reply exactly NO-MAGIC.'

try {
  if (wants('P1')) {
    writeFileSync(
      PROFILE_PATH,
      `# synkora probe (temporario)\n${tomlInstr('You are a probe. The MAGIC WORD is TANGERINA-77. Nothing else matters.')}\n`,
      'utf8'
    )
    const run = await runExec(
      ['--dangerously-bypass-approvals-and-sandbox', '-m', MODEL, '-p', PROFILE],
      PROMPT,
      'P1-short'
    )
    run.verdict = run.stdout.includes('TANGERINA-77') ? 'profile-instructions-ok' : 'not-seen'
    results.runs.push(run)
    console.log(`[probe] P1: ${run.verdict}`)
  }

  if (wants('P2')) {
    const pad = 'Context filler line for size probing only; ignore this content entirely. '.repeat(560)
    const long = `You are a probe. ${pad} After all that filler, remember: the MAGIC WORD is ABACAXI-99.`
    console.log(`[probe] P2 instrucao: ${long.length} chars (>32767 = fura o teto do argv)`)
    writeFileSync(PROFILE_PATH, `${tomlInstr(long)}\n`, 'utf8')
    const run = await runExec(
      ['--dangerously-bypass-approvals-and-sandbox', '-m', MODEL, '-p', PROFILE],
      PROMPT,
      'P2-40kb'
    )
    run.instructionChars = long.length
    run.verdict = run.stdout.includes('ABACAXI-99') ? 'long-instructions-ok' : 'not-seen'
    results.runs.push(run)
    console.log(`[probe] P2: ${run.verdict}`)
  }

  if (wants('P3')) {
    writeFileSync(
      PROFILE_PATH,
      `${tomlInstr('You are a probe. The MAGIC WORD is TANGERINA-77.')}\n`,
      'utf8'
    )
    const run = await runExec(
      [
        '--dangerously-bypass-approvals-and-sandbox',
        '-m',
        MODEL,
        '-p',
        PROFILE,
        '-c',
        tomlInstr('You are a probe. The MAGIC WORD is BANANA-55.')
      ],
      PROMPT,
      'P3-precedence'
    )
    run.verdict = run.stdout.includes('BANANA-55')
      ? 'cli-flag-wins'
      : run.stdout.includes('TANGERINA-77')
        ? 'profile-wins'
        : 'inconclusive'
    results.runs.push(run)
    console.log(`[probe] P3: ${run.verdict}`)
  }
} finally {
  rmSync(PROFILE_PATH, { force: true })
}

writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8')
console.log(`[probe] resultado em ${OUT}`)
