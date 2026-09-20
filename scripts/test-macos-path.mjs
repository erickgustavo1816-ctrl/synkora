import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
function fixture({ output = '\0SYNKORA_PATH\0/opt/homebrew/bin:/Users/test/.local/bin:/usr/bin:/bin\0', error = false,
  platform = 'darwin', inherited = '/usr/bin:/bin', shell = '/bin/zsh', entry = 'src/main/winPath.ts' } = {}) {
  const calls = []
  const built = buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false })
  const loaded = { exports: {} }
  const localRequire = id => {
    if (id === 'node:os' || id === 'os') return { homedir: () => '/Users/test' }
    if (id === 'node:fs/promises') return { access: async () => { throw new Error('synthetic-absent') }, realpath: async path => path, stat: async () => ({ isFile: () => false }) }
    if (id === 'node:child_process' || id === 'child_process') return { execFileSync: (...args) => {
      calls.push(args)
      if (error) throw new Error('synthetic-private-profile-output')
      return output
    } }
    return require(id)
  }
  new Function('require', 'module', 'exports', 'process', built.outputFiles[0].text)(localRequire, loaded, loaded.exports,
    { platform, env: { PATH: inherited, SHELL: shell, PRIVATE_TEST_TOKEN: 'do-not-forward' } })
  return { ...loaded.exports, calls }
}

test('Finder launched macOS process recovers login PATH once and supports explicit reset', () => {
  const api = fixture()
  assert.ok(api.freshWindowsPath().split(':').includes('/opt/homebrew/bin'))
  assert.ok(api.freshWindowsPath().split(':').includes('/Users/test/.local/bin'))
  assert.equal(api.calls.length, 1)
  api.resetPathCache(); api.freshWindowsPath(); assert.equal(api.calls.length, 2)
})

test('login query is fixed bounded argv and returns no full environment or profile output', () => {
  const api = fixture({ output: 'private profile chatter\n\0SYNKORA_PATH\0/Users/test/tools:/usr/bin\0\nprivate tail' })
  const path = api.freshWindowsPath(), [executable, args, options] = api.calls[0] ?? []
  assert.ok(path.split(':').includes('/Users/test/tools'))
  assert.doesNotMatch(path, /private/u)
  assert.equal(executable, '/bin/zsh'); assert.equal(args[0], '-ilc')
  assert.match(args[1], /printf/u); assert.doesNotMatch(args[1], /printenv|(^|\s)env\s|cat |source /u)
  assert.equal(options.shell, false); assert.equal(options.timeout, 4000); assert.equal(options.maxBuffer, 65536)
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore'])
  assert.equal(options.cwd, '/Users/test'); assert.equal(options.env.PRIVATE_TEST_TOKEN, undefined)
})

test('timeout or malformed output uses cached known absolute locations without repeated shell attempts', () => {
  for (const settings of [{ error: true }, { output: '' }, { output: 'private-output' },
    { output: '\0SYNKORA_PATH\0relative:.:/usr/bin\0' }, { output: 'x'.repeat(65537) }]) {
    const api = fixture(settings), path = api.freshWindowsPath()
    for (const location of ['/opt/homebrew/bin', '/Users/test/.local/bin', '/usr/bin', '/bin']) assert.ok(path.split(':').includes(location))
    assert.ok(path.split(':').every(location => location.startsWith('/')))
    assert.doesNotMatch(path, /private|relative/u)
    api.freshWindowsPath(); assert.equal(api.calls.length, 1)
  }
})

test('PATH merging preserves absolute entries with spaces and excludes empty relative and control-bearing entries', () => {
  const api = fixture({ output: '\0SYNKORA_PATH\0/Users/test/My Tools:/usr/bin:/usr/bin:.:relative:/bad\npath\0', inherited: '/inherited/bin::relative:/usr/bin' })
  const entries = api.freshWindowsPath().split(':')
  assert.ok(entries.includes('/Users/test/My Tools')); assert.ok(entries.includes('/inherited/bin'))
  assert.equal(entries.filter(path => path === '/usr/bin').length, 1)
  assert.ok(entries.every(path => path.startsWith('/') && !/[\r\n\0]/u.test(path)))
})

test('shell identity is allowlisted and non-macOS behavior does not launch a login shell', () => {
  const bash = fixture({ shell: '/bin/bash' }); bash.freshWindowsPath(); assert.equal(bash.calls[0]?.[0], '/bin/bash')
  const injected = fixture({ shell: '/tmp/untrusted-shell --arg' }); injected.freshWindowsPath(); assert.equal(injected.calls[0]?.[0], '/bin/zsh')
  const linux = fixture({ platform: 'linux', inherited: '/usr/bin:/custom' })
  assert.equal(linux.freshWindowsPath(), '/usr/bin:/custom'); assert.equal(linux.calls.length, 0)
})

test('Darwin mobile child PATH includes Homebrew companion while retaining environment filtering', () => {
  const api = fixture({ entry: 'src/main/mobileProcess.ts' }), env = api.mobileProcessEnvironment()
  assert.ok(env.PATH.split(':').includes('/opt/homebrew/bin'))
  assert.equal(env.PRIVATE_TEST_TOKEN, undefined)
  assert.equal(api.calls.length, 1)
  const explicit = { PATH: '/synthetic-only', PRIVATE_TEST_TOKEN: 'private' }
  assert.deepEqual(api.mobileProcessEnvironment(explicit), { PATH: '/synthetic-only' })
  assert.equal(api.calls.length, 1, 'explicit synthetic environments cannot query the OS')
})

test('Darwin tool discovery recovers only ambient native host PATH, never platform simulations', async () => {
  const native = fixture({ entry: 'src/main/mobileDiscovery.ts' })
  await native.discoverMobileTools()
  assert.equal(native.calls.length, 1)
  const explicit = fixture({ entry: 'src/main/mobileDiscovery.ts' })
  await explicit.discoverMobileTools('darwin', { PATH: '/synthetic' })
  assert.equal(explicit.calls.length, 0)
  const windows = fixture({ entry: 'src/main/mobileDiscovery.ts', platform: 'win32' })
  await windows.discoverMobileTools('darwin')
  assert.equal(windows.calls.length, 0, 'a darwin platform override on Windows must not invoke a login shell')
})
