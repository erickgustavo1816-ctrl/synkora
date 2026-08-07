import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE_ROOT = join(ROOT, 'src', 'main', 'codeIntelligence')

function assertInside(parent, child) {
  const rel = relative(parent, child)
  if (!rel || rel.startsWith('..') || resolve(parent, rel) !== resolve(child)) {
    throw new Error('diretório temporário de compilação inválido')
  }
}

async function localTypeScriptVersion() {
  const manifest = JSON.parse(
    await readFile(join(ROOT, 'node_modules', 'typescript', 'package.json'), 'utf8')
  )
  const version = String(manifest.version ?? '')
  if (!/^7\./.test(version)) {
    throw new Error(`TypeScript 7 é obrigatório para esta validação; encontrado: ${version || '?'}`)
  }
  return version
}

export async function run(command, args, options = {}) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: options.stdio ?? 'inherit',
      windowsHide: true
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`${command} encerrou com ${String(code ?? signal)}`))
    })
  })
}

/** Compila os fontes reais com a semântica Node16; nunca usa npx/registry. */
export async function compileCodeIntelligence(outputDir, entryFiles) {
  assertInside(dirname(outputDir), outputDir)
  const version = await localTypeScriptVersion()
  const compiler = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  const entries = entryFiles.map((file) => join(SOURCE_ROOT, file))
  await run(process.execPath, [
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
    '--outDir', outputDir,
    ...entries
  ])
  return version
}
