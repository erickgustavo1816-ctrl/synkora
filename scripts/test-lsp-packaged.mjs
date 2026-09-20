import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'

const built = buildSync({ entryPoints: ['src/main/lsp/lspManager.ts'], bundle: true, platform: 'node', format: 'cjs', write: false })
const loaded = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports)
const { tsServerLaunch } = loaded.exports

function fixture(t, { platform = 'darwin', arch = 'arm64', physical = true } = {}) {
  const workspace = resolve('.tmp'), root = mkdtempSync(join(workspace, 'lsp-packaged-'))
  t.after(() => {
    const target = resolve(root)
    assert.equal(dirname(target), workspace)
    rmSync(target, { recursive: true, force: true })
  })
  const resourcesPath = join(root, 'Synkora.app', 'Contents', 'Resources')
  const tsDir = join(resourcesPath, 'app.asar', 'node_modules', 'typescript')
  const platformName = `typescript-${platform}-${arch}`, name = platform === 'win32' ? 'tsc.exe' : 'tsc'
  const relative = join('node_modules', '@typescript', platformName, 'lib', name)
  const logical = join(resourcesPath, 'app.asar', relative), unpacked = join(resourcesPath, 'app.asar.unpacked', relative)
  const write = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body) }
  write(join(tsDir, 'package.json'), JSON.stringify({ name: 'typescript', version: '7.0.2', bin: { tsc: './bin/tsc' } }))
  write(join(dirname(dirname(logical)), 'package.json'), JSON.stringify({ name: `@typescript/${platformName}`, version: '7.0.2' }))
  write(logical, 'synthetic-logical-placeholder')
  if (physical) write(unpacked, 'synthetic-native-placeholder')
  const deps = { platform, arch, resourcesPath, workspaceTypescriptDir: () => null, appTypescriptDir: () => tsDir }
  return { root, resourcesPath, tsDir, logical, unpacked, deps, write }
}

test('bundled native TypeScript launches the real unpacked binary on Mac and Windows', t => {
  for (const target of [{ platform: 'darwin', arch: 'arm64' }, { platform: 'win32', arch: 'x64' }]) {
    const f = fixture(t, target), launch = tsServerLaunch(f.root, f.deps)
    const expected = target.platform === 'win32' && f.unpacked.length >= 248 ? `\\\\?\\${f.unpacked}` : f.unpacked
    assert.equal(launch.command, expected)
    assert.deepEqual(launch.args, ['--lsp', '--stdio'])
    assert.equal(launch.cwd, f.root)
  }
})

test('missing unpacked bundle binary refuses rather than returning a virtual executable', t => {
  const f = fixture(t, { physical: false })
  assert.throws(() => tsServerLaunch(f.root, f.deps), error => /npm install/u.test(error.message) && /na pasta do Synkora/u.test(error.message))
})

test('external workspace or development package paths containing app.asar are unchanged', t => {
  const f = fixture(t)
  assert.equal(tsServerLaunch(f.root, { ...f.deps, workspaceTypescriptDir: () => f.tsDir }).command, f.logical)
  assert.equal(tsServerLaunch(f.root, { ...f.deps, resourcesPath: join(f.root, 'other-resources') }).command, f.logical)
})

test('classic JavaScript TypeScript retains Electron run-as-node and its original module path', t => {
  const f = fixture(t), classic = join(f.tsDir, 'lib', 'tsserver.js'), languageServer = join(f.root, 'language-server')
  f.write(classic, 'synthetic-js')
  f.write(join(languageServer, 'package.json'), JSON.stringify({ bin: { 'typescript-language-server': './lib/cli.mjs' } }))
  const launch = tsServerLaunch(f.root, { ...f.deps, serverPackageDir: () => languageServer, execPath: '/Applications/Synkora.app/Contents/MacOS/Synkora' })
  assert.equal(launch.command, '/Applications/Synkora.app/Contents/MacOS/Synkora')
  assert.equal(launch.initializationOptions.tsserver.path, classic)
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1')
})
