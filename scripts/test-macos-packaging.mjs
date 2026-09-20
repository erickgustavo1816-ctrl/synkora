import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { posix, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'
import { load } from 'js-yaml'

const rootRequire = createRequire(import.meta.url)
test('local mac target is explicit arm64, ad-hoc and never requests notarization', () => {
  const config = load(readFileSync('electron-builder.yml', 'utf8'))
  assert.deepEqual(config.mac?.target, [{ target: 'dmg', arch: ['arm64'] }, { target: 'zip', arch: ['arm64'] }])
  assert.equal(config.mac.identity, '-'); assert.equal(config.mac.notarize, false)
  assert.equal(config.mac.hardenedRuntime, true)
  assert.equal(config.mac.icon, 'build/icon-mac.png')
  assert.match(config.mac.extendInfo.NSMicrophoneUsageDescription, /SynVoice/u)
  assert.ok(config.asarUnpack.includes('**/node_modules/@lydell/node-pty*/**'))
  assert.ok(config.asarUnpack.includes('**/node_modules/@typescript/typescript-darwin-arm64/**'))
  assert.ok(config.extraResources.some(resource => resource.from === 'build/vendor/scrcpy' && resource.to === 'mobile/scrcpy'))
})

test('local mac entitlements contain only JIT, ad-hoc library loading and requested voice input', () => {
  const plist = readFileSync('build/entitlements.mac.plist', 'utf8')
  const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/gu)].map(match => match[1]).sort()
  assert.deepEqual(keys, ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.disable-library-validation', 'com.apple.security.device.audio-input'])
  assert.equal((plist.match(/<true\s*\/>/gu) ?? []).length, 3)
})

test('Mac icon renders original geometry at 1024 and writes only its new repository asset', () => {
  const filename = resolve('scripts/make-icon.mjs')
  const built = buildSync({ entryPoints: [filename], bundle: true, platform: 'node', format: 'cjs', write: false,
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(filename).href) } })
  const writes = [], dirs = [], stopped = Symbol('exit')
  const require = id => id === 'node:fs' ? {
    mkdirSync: (...args) => dirs.push(args), writeFileSync: (...args) => writes.push(args)
  } : rootRequire(id)
  try {
    new Function('require', 'process', 'console', built.outputFiles[0].text.replace(/^#![^\r\n]+/u, ''))(require,
      { argv: [process.execPath, filename, '--mac-only'], env: {}, exit: code => { assert.equal(code, 0); throw stopped } },
      { log() {} })
  } catch (error) { if (error !== stopped) throw error }
  assert.equal(writes.length, 1)
  assert.equal(resolve(writes[0][0]), resolve('build/icon-mac.png'))
  assert.equal(writes[0][1].readUInt32BE(16), 1024); assert.equal(writes[0][1].readUInt32BE(20), 1024)
  assert.ok(dirs.every(([path]) => resolve(path) === resolve('build')))
  const source = readFileSync(filename, 'utf8')
  assert.match(source, /renderIcon\(1024\)/u)
})

test('Mac dev and installed data are distinct on case-insensitive APFS before crash/instance initialization', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const start = source.indexOf('\nif (app.isPackaged) {')
  const end = source.indexOf('\n// O app NÃO', start)
  assert.ok(start > 0 && end > start)
  const block = source.slice(start, end)
  const run = (isPackaged, platform, env = {}) => {
    const paths = { appData: '/Library/Application Support', userData: '/Library/Application Support/synkora', sessionData: '/Library/Application Support/synkora' }
    const calls = [], made = new Set(), order = []
    const app = { isPackaged, getPath: key => paths[key], setPath: (key, value) => {
      assert.ok(made.has(value), 'fresh installation directory must exist before app.setPath')
      calls.push(key); order.push(`set:${key}`); paths[key] = value
    } }
    const mkdirSync = (path, options) => { assert.deepEqual(options, { recursive: true }); made.add(path); order.push('mkdir') }
    new Function('app', 'process', 'join', 'mkdirSync', block)(app, { platform, env }, posix.join, mkdirSync)
    return { paths, calls, order }
  }
  const dev = run(false, 'darwin'), installed = run(true, 'darwin')
  assert.equal(dev.paths.userData, '/Library/Application Support/Synkora-Dev')
  assert.equal(installed.paths.userData, '/Library/Application Support/Synkora')
  assert.notEqual(dev.paths.userData.toLowerCase(), installed.paths.userData.toLowerCase())
  assert.deepEqual(dev.calls, ['userData', 'sessionData']); assert.equal(dev.paths.sessionData, dev.paths.userData)
  assert.deepEqual(dev.order, ['mkdir', 'set:userData', 'set:sessionData'])
  assert.deepEqual(installed.order, ['mkdir', 'set:userData', 'set:sessionData'])
  assert.ok(end < source.indexOf('\ncrashReporter.start('))
  assert.ok(end < source.indexOf('app.requestSingleInstanceLock()'))
  assert.equal(run(false, 'win32').calls.length, 0)
  assert.equal(run(true, 'win32', { LOCALAPPDATA: '/Local' }).paths.userData, '/Local/Synkora')
  assert.doesNotMatch(block, /readFile|rename|copyFile|migrat|rmSync|unlink/u)
})
