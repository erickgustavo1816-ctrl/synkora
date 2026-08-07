#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_ROOT = join(ROOT, 'src', 'main')
const TEMP_PREFIX = 'synkora-mcp-protocol-test-'
const COMMAND_TIMEOUT_MS = 30_000

function assertTemporaryBuildDir(directory) {
  const tempRoot = resolve(tmpdir())
  const target = resolve(directory)
  const rel = relative(tempRoot, target)
  if (
    !rel ||
    rel.startsWith('..') ||
    resolve(tempRoot, rel) !== target ||
    !basename(target).startsWith(TEMP_PREFIX)
  ) {
    throw new Error('diretório temporário de teste inválido')
  }
}

function run(command, args, label) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
      windowsHide: true
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, COMMAND_TIMEOUT_MS)
    timer.unref?.()
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectRun(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        rejectRun(new Error(`${label} excedeu ${COMMAND_TIMEOUT_MS} ms`))
      } else if (code === 0) {
        resolveRun()
      } else {
        rejectRun(new Error(`${label} encerrou com ${String(code ?? signal)}`))
      }
    })
  })
}

const buildDir = await mkdtemp(join(tmpdir(), TEMP_PREFIX))
assertTemporaryBuildDir(buildDir)
try {
  const typescriptManifest = JSON.parse(
    await readFile(join(ROOT, 'node_modules', 'typescript', 'package.json'), 'utf8')
  )
  const compiler = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  await run(
    process.execPath,
    [
      compiler,
      '--pretty', 'false',
      '--target', 'ES2022',
      '--module', 'Node16',
      '--moduleResolution', 'Node16',
      '--strict',
      '--esModuleInterop',
      '--skipLibCheck',
      '--types', 'node',
      '--noEmitOnError',
      '--rootDir', SOURCE_ROOT,
      '--outDir', buildDir,
      join(SOURCE_ROOT, 'mcpProtocol.ts'),
      join(SOURCE_ROOT, 'mcpProtocol.test.ts'),
      join(SOURCE_ROOT, 'winPath.ts')
    ],
    'compilação dos testes MCP'
  )
  process.stdout.write(`TypeScript ${String(typescriptManifest.version ?? '?')} · MCP protocol\n`)
  await run(
    process.execPath,
    ['--test', join(buildDir, 'mcpProtocol.test.js')],
    'testes MCP protocol'
  )
} finally {
  assertTemporaryBuildDir(buildDir)
  await rm(buildDir, { recursive: true, force: true })
}
