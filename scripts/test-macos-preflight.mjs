import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
const { checkMacInstallation } = await import('./check-macos.mjs').catch(() => ({}))
const { buildMac } = await import('./build-macos.mjs').catch(() => ({}))

function fixture(overrides = {}) {
  const files = new Map(), calls = []
  const root = '/repo', home = '/Users/test', sdk = `${home}/Library/Android/sdk`
  const put = (path, body = '{}') => files.set(path, Buffer.from(body))
  put(`${root}/node_modules/@lydell/node-pty-darwin-arm64/package.json`)
  put(`${root}/node_modules/@typescript/typescript-darwin-arm64/lib/tsc`, 'native')
  put(`${root}/node_modules/@typescript/typescript-darwin-arm64/lib/lib.d.ts`)
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(1024, 16); png.writeUInt32BE(1024, 20)
  files.set(`${root}/build/icon-mac.png`, png)
  const jar = Buffer.from('synthetic-server'); files.set(`${root}/build/vendor/scrcpy/scrcpy-server-v4.1.jar`, jar)
  for (const name of ['git', 'codex', 'idb', 'idb_companion']) put(`/opt/homebrew/bin/${name}`)
  for (const name of ['platform-tools/adb', 'emulator/emulator']) put(`${sdk}/${name}`)
  put(`${sdk}/system-images/android-36/google_apis_playstore/arm64-v8a/source.properties`, 'SystemImage.Abi=arm64-v8a\nAndroidVersion.ApiLevel=36\n')
  const readFile = path => { if (!files.has(path)) throw new Error('private-file-error'); return files.get(path) }
  const deps = { platform: 'darwin', arch: 'arm64', nodeVersion: '24.17.0', root, home, env: { PATH: '/usr/bin', PRIVATE_TEST_TOKEN: 'private' },
    expectedJarHash: createHash('sha256').update(jar).digest('hex'),
    stat: path => ({ isFile: () => files.has(path), size: files.get(path)?.length ?? 0 }), readFile,
    isExecutable: path => files.has(path), run: (executable, args, options) => {
      calls.push({ executable, args, options })
      if (executable === '/usr/bin/sw_vers') return { status: 0, stdout: '15.6.1\n' }
      if (executable === '/usr/bin/xcode-select') return { status: 0, stdout: '/Applications/Xcode.app/Contents/Developer\n' }
      if (executable === '/usr/bin/xcodebuild') return { status: 0, stdout: 'Xcode 26.0\nBuild version synthetic\n' }
      if (args.includes('--find')) return { status: 0, stdout: '/Applications/Xcode.app/Contents/Developer/usr/bin/simctl\n' }
      if (args.includes('simctl')) return { status: 0, stdout: JSON.stringify({ devices: { 'runtime': [{ isAvailable: true, state: 'Shutdown', udid: 'never-expose', name: 'never-expose' }] } }) }
      if (args.includes('-list-avds')) return { status: 0, stdout: 'Synthetic_AVD\n' }
      return { status: 0, stdout: '' }
    }, ...overrides }
  return { deps, files, calls, sdk }
}

test('preflight refuses non-Mac or Rosetta without touching files or native tools', () => {
  for (const patch of [{ platform: 'win32' }, { arch: 'x64' }]) {
    let effects = 0
    const f = fixture({ ...patch, stat: () => { effects++; throw new Error('unexpected') }, run: () => { effects++; throw new Error('unexpected') } })
    const result = checkMacInstallation(f.deps)
    assert.equal(result.requiredChecksPass, false); assert.equal(effects, 0)
  }
})

test('preflight reports prerequisites without claiming native validation or exposing device identities', () => {
  const f = fixture(), result = checkMacInstallation(f.deps)
  assert.equal(result.requiredChecksPass, true); assert.equal(result.mobilePrerequisitesPresent, true)
  assert.equal(result.nativeValidation, 'pending')
  assert.doesNotMatch(JSON.stringify(result), /never-expose|private|Users\/test|Synthetic_AVD/u)
  assert.ok(f.calls.every(call => call.options.shell === false && call.options.timeout <= 15000 && call.options.maxBuffer <= 524288))
  assert.ok(f.calls.every(call => !call.args.some(arg => ['boot', 'bootstatus', 'install', 'launch', 'openurl', 'devices', 'kill-server'].includes(arg) && arg !== 'devices')))
})

test('missing optional architecture package, invalid icon or wrong JAR digest blocks local packaging', () => {
  for (const path of ['/repo/node_modules/@lydell/node-pty-darwin-arm64/package.json', '/repo/node_modules/@typescript/typescript-darwin-arm64/lib/tsc', '/repo/build/icon-mac.png']) {
    const f = fixture(); f.files.delete(path)
    assert.equal(checkMacInstallation(f.deps).requiredChecksPass, false)
  }
  const f = fixture(); f.files.set('/repo/build/vendor/scrcpy/scrcpy-server-v4.1.jar', Buffer.from('changed'))
  assert.equal(checkMacInstallation(f.deps).requiredChecksPass, false)
})

test('Android x86 image and absent iOS companion do not falsely satisfy mobile prerequisites', () => {
  const f = fixture()
  f.files.delete('/opt/homebrew/bin/idb_companion')
  f.files.set(`${f.sdk}/system-images/android-36/google_apis_playstore/arm64-v8a/source.properties`, Buffer.from('SystemImage.Abi=x86_64\n'))
  const result = checkMacInstallation(f.deps)
  assert.equal(result.requiredChecksPass, true); assert.equal(result.mobilePrerequisitesPresent, false)
  assert.equal(result.checks.find(check => check.id === 'ios-input').ok, false)
  assert.equal(result.checks.find(check => check.id === 'android-arm64-image').ok, false)
})

test('bad native output and tool errors produce fixed sanitized failure descriptions', () => {
  const f = fixture({ run: () => { throw new Error('secret-like-private-error') } })
  const result = checkMacInstallation(f.deps)
  assert.equal(result.mobilePrerequisitesPresent, false)
  assert.doesNotMatch(JSON.stringify(result), /secret-like|private-error/u)
})

test('local build guard refuses foreign hosts, failed preflight and unexpected arguments before build', () => {
  for (const patch of [{ platform: 'win32' }, { arch: 'x64' }, { args: ['--publish', 'always'] }, { check: () => ({ requiredChecksPass: false }) }]) {
    let ran = 0
    assert.notEqual(buildMac({ platform: 'darwin', arch: 'arm64', args: [], root: '/repo', node: '/usr/bin/node',
      check: () => ({ requiredChecksPass: true }), run: () => { ran++; return { status: 0 } }, print() {}, ...patch }), 0)
    assert.equal(ran, 0)
  }
})

test('local build uses only installed tools and disables publishing even for default DMG', () => {
  for (const args of [[], ['--dir']]) {
    const calls = []
    assert.equal(buildMac({ platform: 'darwin', arch: 'arm64', args, root: '/repo', node: '/usr/bin/node',
      env: { PATH: '/usr/bin', CSC_LINK: 'synthetic-private', CSC_KEY_PASSWORD: 'synthetic-private', APPLE_ID: 'synthetic-private', APPLE_API_KEY: 'synthetic-private' },
      check: () => ({ requiredChecksPass: true }), run: (...request) => { calls.push(request); return { status: 0 } }, print() {} }), 0)
    assert.equal(calls.length, 2)
    assert.equal(calls[0][0], '/usr/bin/node'); assert.match(calls[0][1][0], /node_modules\/electron-vite\/bin\/electron-vite\.js$/u)
    assert.deepEqual(calls[1][1].slice(1), ['--mac', '--arm64', '--publish', 'never', ...args])
    assert.equal(calls[1][2].shell, false)
    assert.deepEqual(calls[1][2].env, { PATH: '/usr/bin', CSC_IDENTITY_AUTO_DISCOVERY: 'false' })
  }
})
