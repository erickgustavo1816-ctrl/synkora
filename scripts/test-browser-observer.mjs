import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import {
  BrowserObserverRegistry,
  BROWSER_OBSERVER_MAX_IMAGE_BYTES
} from '../src/main/browserObserver.ts'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const sandboxes = []

afterEach(() => {
  for (const path of sandboxes.splice(0)) rmSync(path, { recursive: true, force: true })
})

function syntheticWorkspace() {
  const sandbox = mkdtempSync(join(tmpdir(), 'synkora-browser-observer-'))
  sandboxes.push(sandbox)
  const cwd = join(sandbox, 'worktree')
  const screenshots = join(cwd, '.playwright-mcp')
  mkdirSync(screenshots, { recursive: true })
  mkdirSync(join(cwd, 'site'), { recursive: true })
  writeFileSync(join(cwd, 'site', 'index.html'), '<title>site sintético</title>', 'utf8')
  return { sandbox, cwd, screenshots }
}

function fakeRuntime() {
  const watchers = []
  const timers = new Map()
  let nextTimer = 0
  return {
    watchers,
    watchDirectory(path, onChange) {
      const watcher = {
        path,
        onChange,
        closed: false,
        close() {
          this.closed = true
        }
      }
      watchers.push(watcher)
      return watcher
    },
    setTimer(callback) {
      const token = { id: ++nextTimer }
      timers.set(token, callback)
      return token
    },
    clearTimer(token) {
      timers.delete(token)
    },
    flushTimers() {
      const pending = [...timers.entries()]
      timers.clear()
      for (const [, callback] of pending) callback()
    }
  }
}

test('aceita somente a imagem física válida mais recente das raízes do pane', () => {
  const { sandbox, cwd, screenshots } = syntheticWorkspace()
  const valid = join(screenshots, 'site-home.png')
  const malformed = join(screenshots, 'mais-novo.png')
  const mismatchedMime = join(screenshots, 'assinatura-errada.jpg')
  writeFileSync(valid, PNG_1X1)
  writeFileSync(malformed, 'isto não é imagem', 'utf8')
  writeFileSync(mismatchedMime, PNG_1X1)
  const now = Date.now()
  utimesSync(valid, new Date(now), new Date(now))
  utimesSync(malformed, new Date(now + 10_000), new Date(now + 10_000))
  utimesSync(mismatchedMime, new Date(now + 15_000), new Date(now + 15_000))

  // Uma raiz allowlisted que seja junction/symlink é descartada por inteiro;
  // o print externo mais novo nunca compete com o arquivo do site sintético.
  const external = join(sandbox, 'fora-do-worktree')
  const synkora = join(cwd, '.synkora')
  mkdirSync(external)
  mkdirSync(synkora)
  const externalPrint = join(external, 'externo.png')
  writeFileSync(externalPrint, PNG_1X1)
  utimesSync(externalPrint, new Date(now + 20_000), new Date(now + 20_000))
  let junctionAvailable = true
  try {
    symlinkSync(external, join(synkora, 'attachments'), 'junction')
  } catch {
    junctionAvailable = false
  }

  const runtime = fakeRuntime()
  const registry = new BrowserObserverRegistry({
    cwdOf: (paneId) => (paneId === 'pane-site' ? cwd : undefined),
    push: () => undefined,
    watchDirectory: runtime.watchDirectory,
    setTimer: runtime.setTimer,
    clearTimer: runtime.clearTimer,
    now: () => now + 30_000
  })

  const started = registry.start('pane-site')
  assert.equal(started.ok, true)
  assert.equal(started.snapshot.frame?.name, 'site-home.png')
  assert.equal(started.snapshot.frame?.mime, 'image/png')
  assert.equal(started.snapshot.frame?.width, 1)
  assert.equal(started.snapshot.frame?.height, 1)
  assert.ok(started.snapshot.frame.bytes <= BROWSER_OBSERVER_MAX_IMAGE_BYTES)
  if (junctionAvailable) assert.notEqual(started.snapshot.frame?.name, 'externo.png')

  const loaded = registry.frame('pane-site', started.snapshot.frame.id)
  assert.equal(loaded.ok, true)
  assert.deepEqual(Buffer.from(loaded.bytes), PNG_1X1)
  registry.closeAll()
})

test('atualiza com debounce e stop fecha todos os watchers do pane', () => {
  const { cwd, screenshots } = syntheticWorkspace()
  const first = join(screenshots, 'primeiro.png')
  writeFileSync(first, PNG_1X1)
  const runtime = fakeRuntime()
  const pushed = []
  const registry = new BrowserObserverRegistry({
    cwdOf: () => cwd,
    push: (snapshot) => pushed.push(snapshot),
    watchDirectory: runtime.watchDirectory,
    setTimer: runtime.setTimer,
    clearTimer: runtime.clearTimer
  })

  assert.equal(registry.start('pane-live').ok, true)
  const second = join(screenshots, 'segundo.png')
  writeFileSync(second, PNG_1X1)
  const later = new Date(Date.now() + 30_000)
  utimesSync(second, later, later)
  for (const watcher of runtime.watchers.filter((item) => !item.closed)) watcher.onChange()
  runtime.flushTimers()

  assert.equal(registry.state('pane-live').frame?.name, 'segundo.png')
  assert.equal(pushed.at(-1)?.frame?.name, 'segundo.png')
  const updatesBeforeStop = pushed.length

  const stopped = registry.stop('pane-live')
  assert.equal(stopped.ok, true)
  assert.equal(stopped.snapshot.status, 'stopped')
  assert.ok(runtime.watchers.length > 0)
  assert.ok(runtime.watchers.every((watcher) => watcher.closed))

  // Callback atrasado de watcher já fechado não reabre nem publica nada.
  for (const watcher of runtime.watchers) watcher.onChange()
  runtime.flushTimers()
  assert.equal(pushed.length, updatesBeforeStop + 1)
  assert.equal(registry.state('pane-live').status, 'stopped')
})

test('recusa pane sem sessão, arquivo malformado e token externo', () => {
  const { cwd, screenshots } = syntheticWorkspace()
  writeFileSync(join(screenshots, 'quebrado.png'), Buffer.from('PNG falso'))
  const runtime = fakeRuntime()
  const registry = new BrowserObserverRegistry({
    cwdOf: (paneId) => (paneId === 'pane-known' ? cwd : undefined),
    push: () => undefined,
    watchDirectory: runtime.watchDirectory,
    setTimer: runtime.setTimer,
    clearTimer: runtime.clearTimer
  })

  assert.deepEqual(registry.start('pane-unknown'), {
    ok: false,
    error: 'este pane não tem sessão aberta'
  })
  const known = registry.start('pane-known')
  assert.equal(known.ok, true)
  assert.equal(known.snapshot.frame, undefined)
  assert.deepEqual(registry.frame('pane-known', 'C:\\fora\\print.png'), {
    ok: false,
    error: 'esta imagem não está mais disponível'
  })
  registry.closeAll()
})

test('painel integra controles factuais e descarta a imagem efêmera', () => {
  const panel = readFileSync(
    new URL('../src/renderer/src/components/BrowserObserverPanel.tsx', import.meta.url),
    'utf8'
  )
  const pane = readFileSync(
    new URL('../src/renderer/src/components/GuiPane.tsx', import.meta.url),
    'utf8'
  )
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
  const rendererHtml = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8')

  assert.match(pane, /<BrowserObserverPanel paneId=\{paneId\} active=\{active\}/)
  assert.match(panel, /'começar'/)
  assert.match(panel, /'parar'/)
  assert.match(panel, /'expandir'/)
  assert.match(panel, /URL, título, clique e cursor não são fornecidos/)
  assert.match(panel, /URL\.createObjectURL/)
  assert.match(panel, /URL\.revokeObjectURL/)
  assert.match(preload, /browserObserverFrame:\s*\(\s*paneId: string,\s*frameId: string/)
  assert.match(rendererHtml, /img-src 'self' data: blob:/)
  assert.doesNotMatch(panel, /window\.open|navigator\.webdriver|chrome\.debugger/)
})
