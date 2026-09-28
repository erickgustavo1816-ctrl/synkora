import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const require = createRequire(import.meta.url)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const frame = (sessionId = 'session-one') => ({ sessionId, mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', width: 400, height: 800, capturedAt: 1 })
const session = (missionId = 'one', id = 'session-one') => ({ id, missionId, platform: 'android', deviceId: 'pixel', deviceName: 'Pixel de teste', state: 'ready', inputAvailable: true })
const state = (missionId = 'one') => ({ hostPlatform: 'win32', platforms: [
  { platform: 'android', supported: true, available: true, inputAvailable: true, title: 'Android', setupSteps: [], docsUrl: 'https://developer.android.com/studio/run/managing-avds' },
  { platform: 'ios', supported: false, available: false, inputAvailable: false, title: 'iOS', reason: 'O simulador iOS requer macOS e Xcode.', setupSteps: [], docsUrl: 'https://developer.apple.com/documentation/xcode' }
], devices: [{ id: 'pixel', platform: 'android', name: 'Pixel de teste', state: 'available' }], sessions: [session(missionId, `session-${missionId}`)] })
const expoState = (patch = {}) => ({ project: { kind: 'expo', expoVersion: '~54.0.0', dependenciesInstalled: true, hasDevClient: false, message: 'Projeto Expo reconhecido.' },
  status: 'running', addresses: ['192.0.2.10'], selectedAddress: '192.0.2.10', lanUrl: 'exp://192.0.2.10:8081',
  qrDataUrl: `data:image/png;base64,${frame().data}`, ...patch })

function load(entry, window = {}, document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }, stubScreen = false) {
  const compiled = buildSync({ stdin: { contents: entry, resolveDir: 'src/renderer/src', loader: 'tsx' }, bundle: true,
    platform: 'node', format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' },
    external: ['react', 'react/jsx-runtime', 'react-dom', ...(stubScreen ? ['../useMobileScreen', './useMobileScreen'] : [])] }).outputFiles[0].text
  const module = { exports: {} }
  const testRequire = name => stubScreen && name.endsWith('/useMobileScreen') ? { useMobileScreen: (missionId, session, visible, _canvas, retry, client) => {
    const lease = module.exports.useMobileView(client ?? window.synkora?.mobile, missionId, session?.id, visible && session?.state === 'ready', retry)
    return { ...window.__mobileTestScreen, consumerId: lease.consumerId }
  } }
    : name === 'react-dom' ? { ...require(name), createPortal: children => children } : require(name)
  new Function('require', 'module', 'exports', 'window', 'document', compiled)(testRequire, module, module.exports, window, document)
  return module.exports
}

test('Mobile is scoped to live dev and release missions and participates in saved panel layouts', () => {
  const m = load("export * from './workspacePanels'")
  assert.ok(m.availableWorkspacePanels('dev', true).includes('mobile'))
  // Direct release (2026-09-28): the release chat wears the mission's panels.
  assert.ok(m.availableWorkspacePanels('release', true).includes('mobile'))
  for (const [kind, live] of [['dev', false], ['planejamento', true], ['release', false]]) {
    assert.ok(!m.availableWorkspacePanels(kind, live).includes('mobile'))
  }
  assert.deepEqual(m.normalizeWorkspacePreference({ panels: ['mobile', 'browser', 'mobile'] }).panels, ['mobile', 'browser'])
})

test('touch coordinates use the painted image, reject letterboxing and handle landscape', () => {
  const { mobileViewportPoint } = load("export * from './mobileModel'")
  const box = { left: 10, top: 20, width: 300, height: 500 }
  assert.deepEqual(mobileViewportPoint(box, 400, 800, 160, 270), { x: .5, y: .5 })
  assert.equal(mobileViewportPoint(box, 400, 800, 20, 270), null, 'left letterbox is not a device tap')
  assert.deepEqual(mobileViewportPoint(box, 400, 800, 35, 20), { x: 0, y: 0 })
  assert.deepEqual(mobileViewportPoint(box, 800, 400, 160, 270), { x: .5, y: .5 })
  assert.equal(mobileViewportPoint(box, 800, 400, 160, 50), null, 'top letterbox is not a device tap')
  assert.equal(mobileViewportPoint(box, 0, 400, 160, 270), null)
  assert.equal(mobileViewportPoint(box, 400, 800, NaN, 270), null)
})

test('platform preferences isolate missions and iOS cannot be enabled off macOS', () => {
  const m = load("export * from './mobileModel'")
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null }
  const one = m.mobileSelectionKey('project', 'one'), two = m.mobileSelectionKey('project', 'two')
  assert.notEqual(one, two)
  values.set(one, JSON.stringify({ platform: 'ios', devices: { ios: 'iphone' } }))
  assert.equal(m.readMobileSelection(storage, one).platform, 'ios')
  assert.equal(m.readMobileSelection(storage, two).platform, 'android')
  assert.equal(m.mobilePlatformEnabled({ ...state(), platforms: state().platforms.map(p => ({ ...p, supported: true })) }, 'ios'), false)
  assert.equal(m.mobilePlatformEnabled({ ...state(), hostPlatform: 'darwin', platforms: state().platforms.map(p => ({ ...p, supported: true })) }, 'ios'), true)
})

test('only bounded PNG frames from the selected session become visible', () => {
  const { mobileFrameSource, activeMobileSession } = load("export * from './mobileModel'")
  assert.equal(mobileFrameSource(frame(), 'session-one'), `data:image/png;base64,${frame().data}`)
  for (const bad of [{ ...frame(), sessionId: 'other' }, { ...frame(), width: 0 }, { ...frame(), height: Infinity },
    { ...frame(), mimeType: 'image/svg+xml' }, { ...frame(), data: 'https://example.test/image.png' }]) {
    assert.equal(mobileFrameSource(bad, 'session-one'), null)
  }
  assert.equal(activeMobileSession(state('other'), 'one', 'android'), null)
})

test('fallback capture has one request at a time and drops completion after disposal', async () => {
  const { startMobileCapture } = load("export * from './mobileCapture'")
  const first = deferred(), delivered = [], queued = []
  let calls = 0
  const stop = startMobileCapture({ capture: () => { calls++; return first.promise }, onFrame: f => delivered.push(f), onError: e => delivered.push(e),
    isVideoPlaying: () => false }, { schedule: run => { queued.push(run); return queued.length }, cancel() {} })
  assert.equal(calls, 1)
  assert.equal(queued.length, 0, 'no timer is queued while capture is pending')
  stop()
  first.resolve({ ok: true, value: frame() })
  await first.promise; await Promise.resolve()
  assert.deepEqual(delivered, [])
  assert.equal(queued.length, 0)
})

test('fallback yields to video and resumes when decoding falls back', async () => {
  const { startMobileCapture } = load("export * from './mobileCapture'")
  const queue = []; let playing = true, calls = 0
  const stop = startMobileCapture({ capture: async () => { calls++; return { ok: true, value: frame() } }, onFrame() {}, onError() {},
    isVideoPlaying: () => playing }, { schedule: run => { queue.push(run); return queue.length }, cancel() {} })
  assert.equal(calls, 0)
  playing = false; queue.shift()(); await Promise.resolve(); await Promise.resolve()
  assert.equal(calls, 1)
  stop()
})

/** Drives the shared scale menu (button "Tamanho da visualização" + menu items) in a mounted panel. */
const scaleMenu = h => {
  const trigger = () => h.tree.root.findAll(el => el.type === 'button' && el.props['aria-label'] === 'Tamanho da visualização')[0]
  const menu = () => h.tree.root.findAllByProps({ role: 'menu' })
  const item = text => h.tree.root.findAll(el => el.type === 'button' && ['menuitemradio', 'menuitem'].includes(el.props.role) && el.children.join('') === text)[0]
  const open = async () => { if (!menu().length) await act(() => trigger().props.onClick()) }
  const close = async () => { if (menu().length) await act(() => trigger().props.onClick()) }
  const choose = async text => { await open(); const target = item(text); assert.ok(target, `menu item ${text}`); await act(() => target.props.onClick()) }
  const read = async text => { await open(); const target = item(text); assert.ok(target, `menu item ${text}`); const props = { ...target.props }; await close(); return props }
  const label = () => trigger().children.filter(child => typeof child === 'string').join('')
  return { trigger, open, close, item, choose, read, label }
}

async function harness(t, options = {}) {
  const values = new Map(options.saved ?? []), calls = [], listeners = new Set()
  const windowEvents = new Map(), documentEvents = new Map(), intervals = new Map()
  let timerSequence = 0
  const subscribe = (map, type, callback) => { if (!map.has(type)) map.set(type, new Set()); map.get(type).add(callback) }
  let snapshot = options.state ?? state()
  const api = {
    acquireView: async (id, sid) => ({ ok: true, value: { consumerId: `ui-consumer:${id}:${sid}` } }),
    releaseView: async () => ({ ok: true, value: undefined }),
    monitorScale: options.monitorScale ?? (async () => ({ ok: true, value: options.automaticScale ?? null })),
    // The shared app record (main-owned). Absent = an older bridge, which falls back to window storage.
    ...(options.calibration ? {
      calibrationRead: async key => ({ ok: true, value: options.calibration.get(key) ?? null }),
      calibrationWrite: async (key, value) => { if (value === null) options.calibration.delete(key); else options.calibration.set(key, value); for (const listener of options.calibrationListeners ?? []) listener(); return { ok: true, value: true } },
      onCalibrationChanged: listener => { options.calibrationListeners?.add(listener); return () => options.calibrationListeners?.delete(listener) }
    } : {}),
    expoInspect: options.expoInspect ?? (async () => ({ ok: true, value: options.expo ?? expoState({ project: { kind: 'other', dependenciesInstalled: false, hasDevClient: false, message: 'Nenhum projeto Expo detectado.' }, status: 'idle', qrDataUrl: undefined }) })),
    expoStart: async (id, request) => { calls.push(['expoStart', id, request]); return { ok: true, value: expoState() } },
    expoStop: async id => { calls.push(['expoStop', id]); return { ok: true, value: undefined } },
    expoOpenAndroid: async (id, sid) => { calls.push(['expoOpenAndroid', id, sid]); return { ok: true, value: undefined } },
    expoInstallGo: async (id, sid) => { calls.push(['expoInstallGo', id, sid]); return { ok: true, value: undefined } },
    inspect: async id => ({ ok: true, value: { ...snapshot, sessions: snapshot.sessions.map(s => ({ ...s, missionId: id, id: `session-${id}` })) } }),
    start: async (id, request) => { calls.push(['start', id, request]); return { ok: true, value: session(id) } },
    stop: async (id, sid) => { calls.push(['stop', id, sid]); return { ok: true, value: undefined } },
    capture: options.capture ?? (async (id, sid) => { calls.push(['capture', id, sid]); const profile = m.getMobileDeviceProfile(snapshot.sessions[0]?.displayProfileId)
      return { ok: true, value: { ...frame(sid), ...(profile?.width ? { width: profile.width, height: profile.height } : {}) } } }),
    act: async (id, sid, action) => { calls.push(['act', id, sid, action]); return { ok: true, value: undefined } },
    ...(options.pointer ? { pointer: async (id, sid, event) => { calls.push(['pointer', id, sid, event]); return options.pointer(id, sid, event) } } : {}),
    setVideoVisible: async (id, sid, visible) => { calls.push(['video', id, sid, visible]); return { ok: true, value: undefined } },
    onVideo: () => () => {}, onChanged: cb => { listeners.add(cb); return () => listeners.delete(cb) }
  }
  const window = { innerWidth: 1400, innerHeight: 950, addEventListener: (type, callback) => subscribe(windowEvents, type, callback), removeEventListener: (type, callback) => windowEvents.get(type)?.delete(callback),
    screen: { width: 1920, height: 1080, availLeft: 0, availTop: 0, ...options.monitor?.screen }, devicePixelRatio: options.monitor?.devicePixelRatio ?? 1,
    setInterval: callback => { const id = ++timerSequence; intervals.set(id, callback); return id }, clearInterval: id => intervals.delete(id),
    requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
    __mobileTestScreen: options.screen,
    synkora: options.missing ? {} : { mobile: api }, localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) } }
  const document = { visibilityState: 'visible', body: {}, addEventListener: (type, callback) => subscribe(documentEvents, type, callback), removeEventListener: (type, callback) => documentEvents.get(type)?.delete(callback) }
  const m = load("export { default as DockMobile } from './components/DockMobile'; export { WorkspacePanelVisibility } from './workspace/WorkspacePanelContext'; export { getMobileDeviceProfile } from '../../shared/mobileDeviceProfiles'; export {useMobileView} from './useMobileView'", window, document, !!options.screen)
  let props = { missionId: 'one', projectId: 'project', visible: true }
  let visible = true, tree
  const node = () => React.createElement(m.WorkspacePanelVisibility.Provider, { value: visible }, React.createElement(m.DockMobile, props))
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
  await act(async () => { tree = create(node(), { createNodeMock: el => el.type === 'canvas' ? options.canvas ?? { width: 0, height: 0, getContext: () => null }
    : el.props['data-testid'] === 'mobile-viewport' ? { getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 400 }), addEventListener() {}, removeEventListener() {} }
    : el.props['aria-label'] === 'Escolher modelo de tela' ? { getBoundingClientRect: () => ({ top: 40, bottom: 70, left: 500, right: 820, width: 320 }), focus() {}, contains() { return false } } : null }); await flush() })
  t.after(() => act(() => tree.unmount()))
  return { tree, calls, api, values, update: patch => act(async () => { props = { ...props, ...patch }; tree.update(node()); await flush() }),
    emitWindow: type => act(async () => { for (const callback of windowEvents.get(type) ?? []) callback(); await flush() }),
    pollMonitor: (count = 5) => act(async () => { for (let index = 0; index < count; index++) { for (const callback of intervals.values()) callback(); await flush() } }),
    changeMonitor: patch => act(async () => { if (patch.devicePixelRatio !== undefined) window.devicePixelRatio = patch.devicePixelRatio; Object.assign(window.screen, patch.screen ?? {}); for (const callback of windowEvents.get('resize') ?? []) callback(); await flush() }),
    emitDocument: (type, visibilityState) => act(async () => { document.visibilityState = visibilityState; for (const callback of documentEvents.get(type) ?? []) callback(); await flush() }),
    unmount: () => act(() => tree.unmount()),
    visibility: next => act(async () => { visible = next; tree.update(node()); await flush() }),
    snapshot: next => act(async () => { snapshot = next; for (const listener of listeners) listener(props.missionId); await flush() }) }
}

test('real controls gate iOS, route navigation to the selected mission and do not stop on hide', async t => {
  const h = await harness(t)
  const buttons = () => h.tree.root.findAllByType('button')
  assert.equal(buttons().find(b => b.props['aria-label'] === 'Selecionar iOS').props.disabled, true)
  await act(async () => buttons().find(b => b.props['aria-label'] === 'Início do dispositivo').props.onClick())
  assert.deepEqual(h.calls.find(c => c[0] === 'act'), ['act', 'one', 'session-one', { type: 'key', key: 'home' }])
  await h.visibility(false)
  assert.equal(h.calls.filter(c => c[0] === 'stop').length, 0)
  assert.ok(h.calls.some(c => c[0] === 'video' && c[3] === false))
  assert.equal(buttons().find(b => b.props['aria-label'] === 'Início do dispositivo').props.disabled, true)
})

test('late frames cannot cross a mission switch and hidden panels never start capture', async t => {
  const old = deferred(); const requests = []
  const h = await harness(t, { capture: (id, sid) => { requests.push([id, sid]); return id === 'one' ? old.promise : Promise.resolve({ ok: true, value: frame(sid) }) } })
  await h.update({ missionId: 'two' })
  await act(async () => { old.resolve({ ok: true, value: frame('session-one') }); await old.promise })
  const image = h.tree.root.findAllByType('img')[0]
  assert.equal(image.props['data-session-id'], 'session-two')
  await h.visibility(false)
  const count = requests.length
  await h.update({ missionId: 'three' })
  assert.equal(requests.length, count)
})

test('returning to a visible session waits for its previous capture before requesting another', async t => {
  const old = deferred(); let calls = 0
  const h = await harness(t, { capture: async (_id, sid) => { calls++; return calls === 1 ? old.promise : { ok: true, value: frame(sid) } } })
  assert.equal(calls, 1)
  await h.visibility(false)
  await h.visibility(true)
  assert.equal(calls, 1, 'a visibility toggle must not overlap capture requests')
  await act(async () => { old.resolve({ ok: true, value: frame() }); await old.promise; await Promise.resolve() })
  assert.equal(calls, 2, 'the restored view obtains a fresh frame after the previous request settles')
})

test('the owner can stop a boot in progress and its late start result cannot erase the stop', async t => {
  const h = await harness(t, { state: { ...state(), sessions: [] } })
  const boot = deferred(), stop = deferred()
  h.api.start = () => boot.promise
  h.api.stop = () => stop.promise
  const byText = label => h.tree.root.findAllByType('button').find(button => button.children.join('') === label)
  await act(() => byText('Iniciar').props.onClick())
  await h.snapshot({ ...state(), sessions: [{ ...session(), state: 'starting' }] })
  assert.equal(byText('Parar').props.disabled, false)
  await act(() => byText('Parar').props.onClick())
  assert.equal(byText('Parando…').props.disabled, true)
  await act(async () => { boot.resolve({ ok: false, error: 'OLD_START_RESULT' }); await boot.promise })
  assert.ok(byText('Parando…'), 'the old boot completion must not clear the newer Stop operation')
  assert.doesNotMatch(JSON.stringify(h.tree.toJSON()), /OLD_START_RESULT/)
  await act(async () => { stop.resolve({ ok: true, value: undefined }); await stop.promise })
})

test('missing preload names the restart recipe and the Board mounts Mobile from the panel menu', async t => {
  const h = await harness(t, { missing: true })
  assert.match(JSON.stringify(h.tree.toJSON()), /reinicie o app/iu)
  const board = readFileSync(new URL('../src/renderer/src/components/Board.tsx', import.meta.url), 'utf8')
  // The panel menu (availableWorkspacePanels) decides — dev and release, never a repeated type check.
  assert.match(board, /panelsEnabled && selMission && panelOptions\.includes\('mobile'\) && \([\s\S]{0,350}<DockMobile/u)
  assert.doesNotMatch(board, /selMissionType === 'dev'[\s\S]{0,350}<DockMobile/u)
})

test('Expo is recognized without starting anything and Windows offers a physical iPhone QR', async t => {
  const h = await harness(t, { expo: expoState() })
  assert.match(JSON.stringify(h.tree.toJSON()), /Expo detectado/)
  assert.equal(h.calls.some(call => call[0] === 'expoStart' || call[0] === 'expoInstallGo'), false)
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go' }).props.onClick())
  assert.match(JSON.stringify(h.tree.toJSON()), /iPhone físico/)
  assert.equal(h.tree.root.findByProps({ alt: 'QR para abrir o projeto no Expo Go' }).props.src, expoState().qrDataUrl)
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Selecionar iOS' }).props.disabled, true, 'a physical phone does not enable the iOS simulator on Windows')
  assert.equal(h.calls.filter(call => call[0] === 'stop').length, 0)
})

test('Expo Android open and install are explicit actions scoped to the current ready session', async t => {
  const h = await harness(t, { expo: expoState() })
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go' }).props.onClick())
  await act(async () => h.tree.root.findByProps({ 'aria-label': 'Instalar Expo Go no Android' }).props.onClick())
  assert.deepEqual(h.calls.find(call => call[0] === 'expoInstallGo'), ['expoInstallGo', 'one', 'session-one'])
  await act(async () => h.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go no Android' }).props.onClick())
  assert.deepEqual(h.calls.find(call => call[0] === 'expoOpenAndroid'), ['expoOpenAndroid', 'one', 'session-one'])
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Selecionar Android' }).props['aria-pressed'], true)
})

test('bare React Native and remote QR sources never claim Expo Go compatibility', async t => {
  const h = await harness(t, { expo: expoState({ project: { kind: 'react-native', dependenciesInstalled: true, hasDevClient: false, message: 'Este projeto React Native precisa configurar Expo ou usar uma build própria.' }, status: 'idle', qrDataUrl: 'https://example.test/qr.png' }) })
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go' }).props.onClick())
  assert.match(JSON.stringify(h.tree.toJSON()), /build própria/)
  assert.equal(h.tree.root.findAllByProps({ 'aria-label': 'Iniciar Expo Go' }).length, 0)
  assert.equal(h.tree.root.findAllByProps({ alt: 'QR para abrir o projeto no Expo Go' }).length, 0)
})

test('Expo does not offer Android installation until started and iPhone setup follows the detected SDK', async t => {
  const h = await harness(t, { expo: expoState({ status: 'idle', project: { ...expoState().project, expoVersion: '^55.0.0' } }) })
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go' }).props.onClick())
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Instalar Expo Go no Android' }).props.disabled, true)
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Iniciar Expo Go' }).props.disabled, false)
  assert.match(JSON.stringify(h.tree.toJSON()), /TestFlight/)
  assert.match(JSON.stringify(h.tree.toJSON()), /Apple Developer/)
  assert.match(JSON.stringify(h.tree.toJSON()), /mesma conta Expo/)
  await act(async () => h.tree.root.findByProps({ 'aria-label': 'Iniciar Expo Go' }).props.onClick())
  assert.deepEqual(h.calls.find(call => call[0] === 'expoStart'), ['expoStart', 'one', { address: '192.0.2.10' }])
})

test('switching to Expo suspends native capture without abandoning an in-flight request', async t => {
  const pending = deferred(); let requests = 0
  const h = await harness(t, { expo: expoState(), capture: async (_id, sid) => { requests++; return requests === 1 ? pending.promise : { ok: true, value: frame(sid) } } })
  assert.equal(requests, 1)
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go' }).props.onClick())
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Selecionar Android' }).props.onClick())
  assert.equal(requests, 1)
  await act(async () => { pending.resolve({ ok: true, value: frame() }); await pending.promise; await Promise.resolve() })
  assert.equal(requests, 2)
  assert.equal(h.calls.some(call => call[0] === 'stop'), false)
})

test('an unsupported old iPhone SDK and a remote QR never become a scannable iPhone route', async t => {
  const h = await harness(t, { expo: expoState({ project: { ...expoState().project, sdkVersion: '53.0.0' } }) })
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go' }).props.onClick())
  assert.match(JSON.stringify(h.tree.toJSON()), /não funciona com o Expo Go/)
  assert.equal(h.tree.root.findAllByProps({ alt: 'QR para abrir o projeto no Expo Go' }).length, 0)
  const remote = await harness(t, { expo: expoState({ qrDataUrl: 'https://example.test/qr.png' }) })
  await act(() => remote.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go' }).props.onClick())
  assert.equal(remote.tree.root.findAllByProps({ alt: 'QR para abrir o projeto no Expo Go' }).length, 0)
})

test('Expo discovery drops old mission results and never carries a QR into a new mission', async t => {
  const old = deferred()
  const h = await harness(t, { expoInspect: missionId => missionId === 'one' ? old.promise
    : Promise.resolve({ ok: true, value: expoState() }) })
  await h.update({ missionId: 'two' })
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go' }).props.onClick())
  await act(async () => { old.resolve({ ok: true, value: expoState({ project: { ...expoState().project, sdkVersion: '53.0.0', message: 'OLD_EXPO_PROJECT' } }) }); await old.promise })
  assert.equal(h.tree.root.findAllByProps({ alt: 'QR para abrir o projeto no Expo Go' }).length, 1)
  assert.doesNotMatch(JSON.stringify(h.tree.toJSON()), /OLD_EXPO_PROJECT/)
})

test('Expo startup can be cancelled and its late completion cannot clear the stop operation', async t => {
  const h = await harness(t, { expo: expoState({ status: 'idle' }) })
  const boot = deferred(), stop = deferred()
  h.api.expoStart = () => boot.promise
  h.api.expoStop = () => stop.promise
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go' }).props.onClick())
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Iniciar Expo Go' }).props.onClick())
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Parar Expo Go' }).props.disabled, false)
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Parar Expo Go' }).props.onClick())
  await act(async () => { boot.resolve({ ok: false, error: 'OLD_EXPO_START' }); await boot.promise })
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Parar Expo Go' }).props.disabled, true)
  assert.doesNotMatch(JSON.stringify(h.tree.toJSON()), /OLD_EXPO_START/)
  await act(async () => { stop.resolve({ ok: true, value: undefined }); await stop.promise })
})

test('Expo presents concise structural guidance instead of duplicating long backend setup paragraphs', async t => {
  const h = await harness(t, { expo: expoState({ project: { ...expoState().project, message: 'BACKEND_LONG_GUIDANCE ' + 'Prepare o ambiente, a conta Expo e a versão compatível do aplicativo. '.repeat(12) } }) })
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go' }).props.onClick())
  assert.doesNotMatch(JSON.stringify(h.tree.toJSON()), /BACKEND_LONG_GUIDANCE/)
  const intro = h.tree.root.findByProps({ className: 'mobile-expo-intro' }).findAllByType('p')[0]
  assert.ok(intro.children.join('').length < 140)
  const missing = await harness(t, { expo: expoState({ status: 'idle', project: { ...expoState().project, dependenciesInstalled: false } }) })
  await act(() => missing.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go' }).props.onClick())
  assert.match(JSON.stringify(missing.tree.toJSON()), /Instale as dependências/)
  assert.equal(missing.tree.root.findByProps({ 'aria-label': 'Iniciar Expo Go' }).props.disabled, true)
})

test('Expo errors offer idempotent cleanup before another start, including a retained process', async t => {
  const h = await harness(t, { expo: expoState({ status: 'error', port: 8081, error: 'Não foi possível confirmar o encerramento do servidor.' }) })
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Abrir Expo Go' }).props.onClick())
  assert.equal(h.tree.root.findAllByProps({ 'aria-label': 'Iniciar Expo Go' }).length, 0)
  const stop = h.tree.root.findByProps({ 'aria-label': 'Parar Expo Go' })
  assert.equal(stop.props.disabled, false)
  assert.match(stop.children.join(''), /Encerrar e tentar novamente/)
  await act(async () => stop.props.onClick())
  assert.deepEqual(h.calls.find(call => call[0] === 'expoStop'), ['expoStop', 'one'])
})

test('device input is serialized without disabling the viewport or Home while a command is pending', async t => {
  const h = await harness(t), first = deferred(), commands = []
  h.api.act = async (id, sid, action) => { commands.push([id, sid, action]); return commands.length === 1 ? first.promise : { ok: true, value: undefined } }
  const home = () => h.tree.root.findByProps({ 'aria-label': 'Início do dispositivo' })
  await act(() => home().props.onClick())
  assert.equal(home().props.disabled, false, 'normal input must not become a global busy operation')
  assert.match(h.tree.root.findByProps({ 'data-testid': 'mobile-viewport' }).props.className, /is-interactive/)
  await act(() => { home().props.onClick(); home().props.onClick() })
  assert.equal(commands.length, 1, 'input commands stay serial at the bridge')
  await act(async () => { first.resolve({ ok: true, value: undefined }); await first.promise; await Promise.resolve(); await Promise.resolve() })
  assert.equal(commands.length, 3, 'queued intentional clicks are preserved')
})

test('hiding the panel drops input still queued behind an earlier command', async t => {
  const h = await harness(t), first = deferred(), commands = []
  h.api.act = async (...args) => { commands.push(args); return first.promise }
  const home = () => h.tree.root.findByProps({ 'aria-label': 'Início do dispositivo' })
  await act(() => { home().props.onClick(); home().props.onClick() })
  await h.visibility(false)
  await act(async () => { first.resolve({ ok: true, value: undefined }); await first.promise; await Promise.resolve() })
  assert.equal(commands.length, 1)
})

test('native panel keeps Home at the top and removes the entire bottom action area', async t => {
  const h = await harness(t)
  assert.equal(h.tree.root.findAllByProps({ 'aria-label': 'Voltar no dispositivo' }).length, 0)
  assert.equal(h.tree.root.findAllByProps({ 'aria-label': 'Apps recentes do dispositivo' }).length, 0)
  assert.equal(h.tree.root.findAllByProps({ 'aria-label': 'Texto para o dispositivo' }).length, 0)
  assert.equal(h.tree.root.findAllByProps({ className: 'mobile-tools' }).length, 0)
  assert.equal(h.tree.root.findAllByProps({ className: 'mobile-screen-foot' }).length, 0)
  assert.ok(h.tree.root.findByProps({ 'aria-label': 'Início do dispositivo' }))
  assert.ok(scaleMenu(h).trigger())
  assert.ok(h.tree.root.findByProps({ 'aria-label': 'Ampliar tela do aparelho' }))
})

test('phone layout, intentional hold and bounded wheel gestures preserve the real screen coordinates', () => {
  const { mobilePhoneLayout, mobilePointerAction, mobileWheelSwipe } = load("export * from './mobileModel'")
  const fitted = mobilePhoneLayout(424, 650, .5, 1), enlarged = mobilePhoneLayout(424, 650, .5, 1.5)
  assert.ok(fitted.width > 300 && fitted.height <= 650)
  assert.ok(enlarged.width > fitted.width * 1.4)
  assert.deepEqual(mobilePointerAction({ x: .3, y: .4 }, { x: .3, y: .4 }, 0, 120), { type: 'tap', x: .3, y: .4 })
  assert.deepEqual(mobilePointerAction({ x: .3, y: .4 }, { x: .3, y: .4 }, 0, 800), { type: 'swipe', x: .3, y: .4, endX: .3, endY: .4, durationMs: 800 })
  const wheel = mobileWheelSwipe(0, 4000, 300, 600)
  assert.equal(wheel.type, 'swipe')
  assert.ok(wheel.y > wheel.endY && wheel.y <= .85 && wheel.endY >= .15)
  assert.equal(mobileWheelSwipe(0, NaN, 300, 600), null)
})

test('display profile preferences are validated and the next Android start receives the chosen model', async t => {
  const h = await harness(t, { state: { ...state(), sessions: [] } })
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Escolher modelo de tela' }).props.onClick())
  await act(() => h.tree.root.findByProps({ 'data-profile-option': 'galaxy-s24-ultra' }).props.onClick())
  const saved = [...h.values.values()].map(value => JSON.parse(value)).find(value => value.displayProfileId)
  assert.equal(saved.displayProfileId, 'galaxy-s24-ultra')
  assert.equal(h.calls.some(call => call[0] === 'act'), false)
  await act(async () => h.tree.root.findAllByType('button').find(button => button.children.join('') === 'Iniciar').props.onClick())
  assert.equal(h.calls.find(call => call[0] === 'start')[2].displayProfileId, 'galaxy-s24-ultra')
  const model = load("export * from './mobileModel'")
  assert.equal(model.readMobileSelection({ getItem: () => JSON.stringify({ displayProfileId: 'not-allowed' }) }, 'x').displayProfileId, undefined)
})

test('a running display profile is confirmed by the runtime; failed changes keep the previous frame', async t => {
  const initial = { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] }
  const h = await harness(t, { state: initial }), pending = deferred()
  h.api.act = async (id, sid, action) => { h.calls.push(['act', id, sid, action]); return pending.promise }
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Escolher modelo de tela' }).props.onClick())
  await act(() => h.tree.root.findByProps({ 'data-profile-option': 'galaxy-s24' }).props.onClick())
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Início do dispositivo' }).props.disabled, true)
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Escolher modelo de tela' }).props['data-applied-profile'], 'pixel-7')
  await act(async () => { pending.resolve({ ok: false, error: 'PROFILE_REJECTED' }); await pending.promise; await Promise.resolve() })
  assert.match(JSON.stringify(h.tree.toJSON()), /PROFILE_REJECTED/)
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Escolher modelo de tela' }).props['data-applied-profile'], 'pixel-7')
  assert.deepEqual(h.calls.find(call => call[0] === 'act'), ['act', 'one', 'session-one', { type: 'displayProfile', profileId: 'galaxy-s24' }])
})

test('frame families follow applied Android profiles or structural iOS device types, never a renamed device', () => {
  const { mobileFrameAppearance } = load("export * from './mobileModel'")
  assert.equal(mobileFrameAppearance('android', 'pixel-7').family, 'pixel')
  assert.equal(mobileFrameAppearance('android', 'galaxy-s24').family, 'galaxy')
  assert.equal(mobileFrameAppearance('android', 'galaxy-s24-ultra').family, 'galaxy-ultra')
  assert.equal(mobileFrameAppearance('ios', 'galaxy-s24', 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation').family, 'iphone-home')
  assert.equal(mobileFrameAppearance('ios', undefined, 'com.apple.CoreSimulator.SimDeviceType.iPhone-14-Pro').family, 'iphone-island')
  assert.equal(mobileFrameAppearance('ios', undefined, 'com.apple.CoreSimulator.SimDeviceType.iPhone-13').family, 'iphone-notch')
  assert.equal(mobileFrameAppearance('ios', undefined, 'Renamed iPhone 14 Pro').family, 'iphone')
  for (const id of ['native', 'pixel-7', 'pixel-9', 'galaxy-s24', 'galaxy-s24-ultra', 'galaxy-a54']) {
    assert.equal(mobileFrameAppearance('android', id).bezel, 2, 'the selected model never restores a broad border')
    assert.equal(mobileFrameAppearance('android', id).chin, 0)
  }
})

test('a profile changed by another controller invalidates input waiting behind an earlier command', async t => {
  const h = await harness(t, { state: { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] } }), first = deferred(), commands = []
  h.api.act = async (...args) => { commands.push(args); return first.promise }
  const home = () => h.tree.root.findByProps({ 'aria-label': 'Início do dispositivo' })
  await act(() => { home().props.onClick(); home().props.onClick() })
  await h.snapshot({ ...state(), sessions: [{ ...session(), displayProfileId: 'galaxy-s24' }] })
  await act(async () => { first.resolve({ ok: true, value: undefined }); await first.promise; await Promise.resolve() })
  assert.equal(commands.length, 1, 'queued input from the old screen geometry must be discarded')
})

test('successful display profiles persist per mission while an unverified runtime profile is never presented as original', async t => {
  const h = await harness(t, { state: { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] } })
  h.api.act = async () => { h.api.inspect = async () => ({ ok: true, value: { ...state(), sessions: [{ ...session(), displayProfileId: 'galaxy-s24' }] } }); return { ok: true, value: undefined } }
  const picker = () => h.tree.root.findByProps({ 'aria-label': 'Escolher modelo de tela' })
  await act(() => picker().props.onClick())
  await act(async () => { h.tree.root.findByProps({ 'data-profile-option': 'galaxy-s24' }).props.onClick(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
  assert.equal(picker().props['data-applied-profile'], 'galaxy-s24')
  const model = load("export * from './mobileModel'")
  assert.equal(JSON.parse(h.values.get(model.mobileSelectionKey('project', 'one'))).displayProfileId, 'galaxy-s24')
  assert.equal(h.values.has(model.mobileSelectionKey('project', 'two')), false)
  h.api.inspect = async () => ({ ok: true, value: state() })
  await act(async () => h.tree.root.findByProps({ 'aria-label': 'Verificar simuladores novamente' }).props.onClick())
  assert.equal(picker().props['data-applied-profile'], undefined)
  assert.match(picker().props.title, /perfil não confirmado/)
})

test('iOS uses the real Xcode device, with no Android profiles in its picker or start request', async t => {
  const h = await harness(t, { state: { ...state(), hostPlatform: 'darwin', sessions: [],
    devices: [{ id: 'iphone-real', platform: 'ios', name: 'Meu telefone', deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation', state: 'available' }],
    platforms: state().platforms.map(value => ({ ...value, supported: true, available: true, inputAvailable: true })) } })
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Escolher modelo de tela' }).props.onClick())
  await act(() => h.tree.root.findByProps({ 'data-profile-option': 'galaxy-s24-ultra' }).props.onClick())
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Selecionar iOS' }).props.onClick())
  assert.equal(h.tree.root.findAllByProps({ 'aria-label': 'Escolher modelo de tela' }).length, 0)
  assert.equal(h.tree.root.findByProps({ 'data-frame-family': 'iphone-home' }).props['data-frame-family'], 'iphone-home')
  await act(async () => h.tree.root.findAllByType('button').find(button => button.children.join('') === 'Iniciar').props.onClick())
  assert.deepEqual(h.calls.find(call => call[0] === 'start')[2], { platform: 'ios', deviceId: 'iphone-real' })
})

for (const [scopeName, patch] of [['mission', { missionId: 'two' }], ['project', { projectId: 'other-project' }]]) {
  test(`a late display profile result cannot refresh or overwrite a different ${scopeName}`, async t => {
    const h = await harness(t, { state: { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] } })
    const pending = deferred(), inspections = [], inspect = h.api.inspect
    h.api.inspect = async id => { inspections.push(id); return inspect(id) }
    h.api.act = () => pending.promise
    await act(() => h.tree.root.findByProps({ 'aria-label': 'Escolher modelo de tela' }).props.onClick())
    await act(() => h.tree.root.findByProps({ 'data-profile-option': 'galaxy-s24' }).props.onClick())
    await h.update(patch)
    const expectedSession = patch.missionId === 'two' ? 'session-two' : 'session-one'
    assert.equal(h.tree.root.findByProps({ 'aria-label': 'Início do dispositivo' }).props.disabled, false, 'the new scope is immediately interactive')
    assert.ok(h.tree.root.findAllByType('img').some(image => image.props['data-session-id'] === expectedSession))
    const before = [...inspections]
    await act(async () => { pending.resolve({ ok: true, value: undefined }); await pending.promise; await Promise.resolve(); await Promise.resolve() })
    assert.deepEqual(inspections, before, 'the old completion never invokes its old refresh closure')
    assert.equal(h.tree.root.findByProps({ 'aria-label': 'Início do dispositivo' }).props.disabled, false)
    assert.ok(h.tree.root.findAllByType('img').some(image => image.props['data-session-id'] === expectedSession), 'the new session stays visible')
    assert.equal([...h.values.values()].some(value => JSON.parse(value).displayProfileId === 'galaxy-s24'), false, 'the old result cannot persist a preference into either scope')
  })
}

test('physical sizing follows the official display millimetres with the same thin decorative frame as fit mode', () => {
  const { mobilePhysicalDevice, mobileCalibratedPhoneLayout } = load("export * from './mobileModel'")
  const ultra = mobilePhysicalDevice('android', 'galaxy-s24-ultra')
  assert.equal(ultra.bodyWidthMm, 79); assert.equal(ultra.bodyHeightMm, 162.3); assert.equal(ultra.displayDiagonalMm, 172.5)
  assert.equal(mobilePhysicalDevice('android', 'native'), null)
  assert.equal(mobilePhysicalDevice('ios', undefined, 'My renamed iPhone SE'), null)
  assert.equal(mobilePhysicalDevice('ios', undefined, 'com.apple.CoreSimulator.SimDeviceType.iPhone-14-Pro').displayDiagonalMm, 155.448)
  assert.equal(mobilePhysicalDevice('ios', undefined, 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro').displayDiagonalMm, 159.258)
  const phone = mobileCalibratedPhoneLayout(ultra, 1440 / 3120, 3.6, 1)
  assert.equal(phone.width, phone.displayWidth + 4); assert.equal(phone.height, phone.displayHeight + 4)
  assert.ok(Math.abs(Math.hypot(phone.displayWidth, phone.displayHeight) - 172.5 * 3.6) < 1e-7)
  assert.ok(Math.abs(phone.displayWidth / phone.displayHeight - 1440 / 3120) < 1e-7)
  assert.ok(Math.abs(phone.displayWidth + 2 * phone.paddingX - phone.width) < 1e-7)
  assert.ok(Math.abs(phone.displayHeight + 2 * phone.paddingY - phone.height) < 1e-7)
  assert.equal(phone.paddingX, 2); assert.equal(phone.paddingY, 2)
  const landscape = mobileCalibratedPhoneLayout(ultra, 3120 / 1440, 3.6, 1)
  assert.equal(landscape.width, phone.height); assert.equal(landscape.height, phone.width)
  const enlarged = mobileCalibratedPhoneLayout(ultra, 1440 / 3120, 3.6, 1.25)
  assert.ok(Math.abs(enlarged.displayWidth / phone.displayWidth - 1.25) < 1e-7)
  assert.equal(enlarged.paddingX, 2, 'zoom enlarges the screen, never the decorative border')
  const roundedStream = mobileCalibratedPhoneLayout(ultra, 738 / 1600, 3.6, 1)
  assert.deepEqual(roundedStream, phone, 'the encoded video rounding never changes official hardware dimensions')
  assert.equal(mobileCalibratedPhoneLayout(ultra, 1, 3.6, 1), null, 'an incompatible aspect is never stretched to fit the hardware')
})

test('the panel toolbar is one strip: home, scale menu, expand and refresh, never the old zoom stepper', async t => {
  const h = await harness(t, { state: { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] } })
  const s = scaleMenu(h)
  const toolbar = h.tree.root.findByProps({ className: 'mobile-view-toolbar' })
  assert.deepEqual(toolbar.findAll(el => el.type === 'button').map(el => el.props['aria-label']),
    ['Início do dispositivo', 'Tamanho da visualização', 'Ampliar tela do aparelho', 'Atualizar tela do dispositivo'])
  assert.equal(h.tree.root.findAllByProps({ className: 'mobile-zoom-controls' }).length, 0)
  assert.equal(h.tree.root.findAllByType('output').length, 0)
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Ampliar tela do aparelho' }).findAllByType('span').length, 0, 'expand is icon-only at every width')
  assert.equal(s.label(), 'Ajustar')
  const width = () => h.tree.root.findByProps({ className: 'mobile-phone-shell frame-pixel' }).props.style.width
  const fit = width()
  await s.choose('125%')
  assert.equal(s.label(), '125%'); assert.ok(width() > fit)
  assert.equal((await s.read('75%')).disabled, true, 'fit never shrinks below the panel')
  await s.choose('Ajustar ao painel')
  assert.equal(s.label(), 'Ajustar'); assert.equal(width(), fit)
})

test('physical mode requires a known model, labels estimated scale and offers manual correction without blocking first use', async t => {
  const unknown = await harness(t)
  assert.equal((await scaleMenu(unknown).read('Tamanho real')).disabled, true)
  const h = await harness(t, { state: { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] } })
  const button = label => h.tree.root.findByProps({ 'aria-label': label })
  const s = scaleMenu(h)
  await s.choose('Tamanho real')
  assert.equal(s.label(), 'Real')
  assert.equal(h.tree.root.findAllByProps({ role: 'dialog' }).length, 0)
  assert.match(s.trigger().props.title, /estimado/)
  await s.choose('Calibrar tamanho real…')
  assert.ok(h.tree.root.findByProps({ 'aria-label': 'Calibrar tamanho físico' }))
  assert.equal(button('Início do dispositivo').props.disabled, true)
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Ajustar régua de 5 cm' }).props.onChange({ target: { value: '180' } }))
  await act(() => button('Salvar calibração').props.onClick())
  assert.equal(s.label(), 'Real')
  assert.equal((await s.read('Ajustar ao painel'))['aria-checked'], false)
  await s.choose('125%')
  assert.equal(s.label(), '125%')
  await s.choose('Ajustar ao painel')
  assert.equal(s.label(), 'Ajustar')
  assert.equal((await s.read('Ajustar ao painel'))['aria-checked'], true)
  assert.equal((await s.read('Tamanho real'))['aria-checked'], false)
})

test('calibration persistence rejects corrupt data and isolates monitor geometry, origin and pixel ratio', () => {
  const { mobileCalibrationKey, readMobileCalibration, writeMobileCalibration } = load("export * from './mobileCalibration'")
  const monitor = { width: 1920, height: 1080, left: 0, top: 0, pixelRatio: 1, viewportScale: 1 }
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  assert.equal(readMobileCalibration(storage, monitor), null)
  assert.equal(writeMobileCalibration(storage, monitor, 3.6), true)
  assert.equal(readMobileCalibration(storage, monitor), 3.6)
  for (const patch of [{ width: 2560 }, { height: 1440 }, { left: 1920 }, { top: -1080 }, { pixelRatio: 1.5 }, { viewportScale: 1.25 }]) {
    assert.notEqual(mobileCalibrationKey(monitor), mobileCalibrationKey({ ...monitor, ...patch }))
    assert.equal(readMobileCalibration(storage, { ...monitor, ...patch }), null)
  }
  for (const bad of ['invalid', 'null', '{}', '{"version":2,"pixelsPerMm":-1}', '{"version":2,"pixelsPerMm":500}', '{"version":1,"pixelsPerMm":4}']) {
    values.set(mobileCalibrationKey(monitor), bad)
    assert.equal(readMobileCalibration(storage, monitor), null)
  }
})

test('the 5 cm calibration is one app record: a fresh window (or a restart) reads it and live changes reach every window', async t => {
  const shared = new Map(), listeners = new Set()
  const props = { state: { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] }, calibration: shared, calibrationListeners: listeners }
  const settle = () => act(async () => { for (let index = 0; index < 8; index++) await Promise.resolve() })
  const displayWidthAt = scale => 160.5 * scale * 1080 / Math.hypot(1080, 2400) + 4
  const width = h => h.tree.root.findByProps({ className: 'mobile-phone-shell frame-pixel' }).props.style.width
  const h = await harness(t, props)
  const s = scaleMenu(h)
  await s.choose('Tamanho real')
  await s.choose('Calibrar tamanho real…')
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Ajustar régua de 5 cm' }).props.onChange({ target: { value: '180' } }))
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Salvar calibração' }).props.onClick())
  await settle()
  assert.deepEqual([...shared.values()], [3.6], 'the confirmed ruler lands in the app record')
  assert.equal([...h.values.keys()].some(key => key.includes('calibration')), false, 'window-local storage is not the source of truth any more')
  assert.ok(Math.abs(width(h) - displayWidthAt(3.6)) < 1e-7)
  // A detached phone window or the app after a restart: empty window storage, same app record.
  const fresh = await harness(t, { ...props, saved: new Map() })
  await scaleMenu(fresh).choose('Tamanho real')
  await settle()
  assert.equal(fresh.tree.root.findAllByProps({ role: 'dialog' }).length, 0, 'no ruler prompt: the record is already known')
  assert.ok(Math.abs(width(fresh) - displayWidthAt(3.6)) < 1e-7, 'the same 5 cm in the other window')
  // A correction made in one window reaches the other without remounting.
  await act(async () => { shared.set([...shared.keys()][0], 4); for (const listener of listeners) listener() })
  await settle()
  assert.ok(Math.abs(width(h) - displayWidthAt(4)) < 1e-7)
  assert.ok(Math.abs(width(fresh) - displayWidthAt(4)) < 1e-7)
})

test('cancelling calibration saves nothing; a monitor change replaces the manual override with an honest estimate', async t => {
  const h = await harness(t, { state: { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] } })
  const s = scaleMenu(h)
  await s.choose('Tamanho real')
  await s.choose('Calibrar tamanho real…')
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Cancelar calibração' }).props.onClick())
  assert.equal([...h.values.keys()].some(key => key.includes('calibration')), false)
  await s.choose('Calibrar tamanho real…')
  await act(() => h.tree.root.findByProps({ 'aria-label': 'Salvar calibração' }).props.onClick())
  assert.equal(s.label(), 'Real')
  await h.changeMonitor({ devicePixelRatio: 1.5 })
  assert.equal(s.label(), 'Real')
  assert.match(s.trigger().props.title, /estimado/)
  await s.choose('Calibrar tamanho real…')
  assert.ok(h.tree.root.findByProps({ 'aria-label': 'Calibrar tamanho físico' }))
})

test('manual corrections stay bound to their exact monitor context and can be reused when that screen returns', async t => {
  const { writeMobileCalibration } = load("export * from './mobileCalibration'")
  const first = { width: 1920, height: 1080, left: 0, top: 0, pixelRatio: 1, viewportScale: 1 }
  const second = { ...first, left: 1920 }
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  writeMobileCalibration(storage, second, 6)
  writeMobileCalibration(storage, first, 4)
  const props = { state: { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] } }
  const h = await harness(t, { ...props, saved: values })
  await scaleMenu(h).choose('Tamanho real')
  assert.equal(h.tree.root.findAllByProps({ role: 'dialog' }).length, 0, 'the same confirmed screen can reuse its measured scale')
  await h.changeMonitor({ screen: { availLeft: 1920 } })
  const secondMount = await harness(t, { ...props, saved: h.values, monitor: { screen: { availLeft: 1920 } } })
  await scaleMenu(secondMount).choose('Tamanho real')
  assert.equal(secondMount.tree.root.findAllByProps({ role: 'dialog' }).length, 0, 'an override for this exact second screen is reusable')
  assert.ok(Math.abs(secondMount.tree.root.findByProps({ className: 'mobile-phone-shell frame-pixel' }).props.style.width - (160.5 * 6 * 1080 / Math.hypot(1080, 2400) + 4)) < 1e-7)
  await h.changeMonitor({ screen: { availLeft: 0 } })
  const firstAgain = await harness(t, { ...props, saved: h.values })
  await scaleMenu(firstAgain).choose('Tamanho real')
  assert.equal(firstAgain.tree.root.findAllByProps({ role: 'dialog' }).length, 0)
  assert.ok(Math.abs(firstAgain.tree.root.findByProps({ className: 'mobile-phone-shell frame-pixel' }).props.style.width - (160.5 * 4 * 1080 / Math.hypot(1080, 2400) + 4)) < 1e-7)
})

test('a stale calibration confirmation cannot write the old ruler scale into a newly selected monitor', async t => {
  const h = await harness(t, { state: { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] } })
  const s = scaleMenu(h)
  await s.choose('Tamanho real')
  await s.choose('Calibrar tamanho real…')
  const confirm = h.tree.root.findByProps({ 'aria-label': 'Salvar calibração' }).props.onClick
  await h.changeMonitor({ screen: { availLeft: 1920 } })
  await act(() => confirm())
  assert.equal(s.label(), 'Real'); assert.match(s.trigger().props.title, /estimado/)
  assert.equal([...h.values.values()].some(value => { try { return JSON.parse(value).pixelsPerMm > 0 } catch { return false } }), false)
})

const detectedScale = (physicalPixelsPerMm, source = 'edid-detailed') => ({ physicalPixelsPerMm, source, displayId: 1,
  displayBounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 })

test('automatic monitor scale accounts for device pixels, manual overrides win and can be reset without leaving the panel', async t => {
  const h = await harness(t, { state: { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] },
    monitor: { devicePixelRatio: 2 }, automaticScale: detectedScale(8) })
  const button = label => h.tree.root.findByProps({ 'aria-label': label })
  const s = scaleMenu(h)
  await s.choose('Tamanho real')
  assert.equal(h.tree.root.findAllByProps({ role: 'dialog' }).length, 0)
  assert.ok(Math.abs(h.tree.root.findByProps({ className: 'mobile-phone-shell frame-pixel' }).props.style.width - (160.5 * 4 * 1080 / Math.hypot(1080, 2400) + 4)) < 1e-7)
  assert.equal(s.label(), 'Real')
  assert.match(s.trigger().props.title, /Medidas informadas pelo monitor/)
  await s.choose('Calibrar tamanho real…')
  await act(() => button('Ajustar régua de 5 cm').props.onChange({ target: { value: '180' } }))
  await act(() => button('Salvar calibração').props.onClick())
  assert.ok(Math.abs(h.tree.root.findByProps({ className: 'mobile-phone-shell frame-pixel' }).props.style.width - (160.5 * 3.6 * 1080 / Math.hypot(1080, 2400) + 4)) < 1e-7)
  await s.choose('Calibrar tamanho real…')
  await act(() => button('Usar detecção automática').props.onClick())
  assert.ok(Math.abs(h.tree.root.findByProps({ className: 'mobile-phone-shell frame-pixel' }).props.style.width - (160.5 * 4 * 1080 / Math.hypot(1080, 2400) + 4)) < 1e-7)
})

test('automatic scale drops late monitor results and basic EDID stays visibly approximate', async t => {
  const pending = deferred(); let reads = 0
  const h = await harness(t, { state: { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] },
    monitorScale: () => ++reads === 1 ? pending.promise : Promise.resolve({ ok: true, value: detectedScale(6, 'edid-basic') }) })
  await h.emitWindow('resize')
  assert.equal(reads, 1, 'normal panel resize must not reprobe the monitor')
  await h.changeMonitor({ screen: { availLeft: 1920 } })
  await act(() => pending.resolve({ ok: true, value: detectedScale(4) }))
  const s = scaleMenu(h)
  await s.choose('Tamanho real')
  assert.ok(Math.abs(h.tree.root.findByProps({ className: 'mobile-phone-shell frame-pixel' }).props.style.width - (160.5 * 6 * 1080 / Math.hypot(1080, 2400) + 4)) < 1e-7)
  assert.equal(s.label(), 'Real'); assert.match(s.trigger().props.title, /estimado/)
  await h.emitWindow('focus')
  assert.equal(reads, 4, 'physical mode activation and focus each revalidate active-monitor metadata')
})

test('manual scale belongs to the native monitor identity even when resolution, origin and DPR are identical', async t => {
  let monitor = detectedScale(4)
  const props = { state: { ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7' }] }, monitorScale: async () => ({ ok: true, value: monitor }) }
  const h = await harness(t, props)
  const button = label => h.tree.root.findByProps({ 'aria-label': label })
  const displayWidthAt = scale => 160.5 * scale * 1080 / Math.hypot(1080, 2400)
  const width = () => h.tree.root.findByProps({ className: 'mobile-phone-shell frame-pixel' }).props.style.width - 4
  const s = scaleMenu(h)
  await s.choose('Tamanho real')
  await s.choose('Calibrar tamanho real…')
  await act(() => button('Ajustar régua de 5 cm').props.onChange({ target: { value: '190' } }))
  await act(() => button('Salvar calibração').props.onClick())
  assert.ok(Math.abs(width() - displayWidthAt(3.8)) < 1e-7)
  await s.choose('Calibrar tamanho real…')
  const staleConfirm = button('Salvar calibração').props.onClick
  monitor = { ...detectedScale(6), displayId: 2 }
  await h.emitWindow('focus')
  assert.ok(Math.abs(width() - displayWidthAt(6)) < 1e-7, 'a replacement monitor must use its own automatic scale, not the old manual override')
  assert.equal(h.tree.root.findAllByProps({ role: 'dialog' }).length, 0, 'the open correction closes when physical identity changes')
  await act(() => staleConfirm())
  assert.ok(Math.abs(width() - displayWidthAt(6)) < 1e-7, 'a stale dialog cannot bind the old ruler to the replacement monitor')
  const remounted = await harness(t, { ...props, saved: h.values })
  await scaleMenu(remounted).choose('Tamanho real')
  assert.ok(Math.abs(remounted.tree.root.findByProps({ className: 'mobile-phone-shell frame-pixel' }).props.style.width - 4 - displayWidthAt(6)) < 1e-7)
  monitor = detectedScale(4)
  await h.emitWindow('focus')
  assert.ok(Math.abs(width() - displayWidthAt(3.8)) < 1e-7, 'the original monitor may reuse its own correction when it returns')
})

test('identified monitors never inherit geometry-only calibration and native context keys reject malformed identity', () => {
  const { mobileCalibrationKey, readMobileCalibration, writeMobileCalibration, mobileMonitorPixelsPerMm } = load("export * from './mobileCalibration'")
  const screen = { width: 1920, height: 1080, left: 0, top: 0, pixelRatio: 1, viewportScale: 1 }
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const first = detectedScale(4), second = { ...detectedScale(6), displayId: 2 }
  writeMobileCalibration(storage, screen, 3.8, first)
  assert.equal(readMobileCalibration(storage, screen, first), 3.8)
  assert.equal(readMobileCalibration(storage, screen, second), null)
  assert.equal(readMobileCalibration(storage, screen), null)
  assert.notEqual(mobileCalibrationKey(screen, first), mobileCalibrationKey(screen, second))
  assert.notEqual(mobileCalibrationKey(screen, first), mobileCalibrationKey(screen, { ...first, scaleFactor: 2 }))
  writeMobileCalibration(storage, screen, 3.2)
  assert.equal(readMobileCalibration(storage, screen, second), null, 'unknown identity is a separate fallback, never an identified display')
  for (const invalid of [{ ...first, displayId: NaN }, { ...first, scaleFactor: 0 }, { ...first, displayBounds: { ...first.displayBounds, width: -1 } }]) {
    assert.equal(mobileMonitorPixelsPerMm(invalid, screen), null)
    assert.equal(writeMobileCalibration(storage, screen, 4, invalid), false)
  }
})

test('periodic native identity checks run only for visible physical mode and unchanged metadata never cancels a drag', async t => {
  let reads = 0, monitor = detectedScale(4)
  const h = await harness(t, { state: liveState(), pointer: async () => ({ ok: true, value: undefined }),
    monitorScale: async () => { reads++; return { ok: true, value: monitor } } })
  await h.pollMonitor(10)
  assert.equal(reads, 1, 'fit mode performs no recurring native lookup')
  await scaleMenu(h).choose('Tamanho real')
  assert.equal(reads, 2, 'entering physical mode revalidates cached metadata once')
  await act(() => h.tree.root.findByProps({ 'data-testid': 'mobile-viewport' }).props.onPointerDown(pointerEvent()))
  await h.pollMonitor(5)
  assert.equal(reads, 3)
  assert.deepEqual(h.calls.filter(call => call[0] === 'pointer').map(call => call[3].phase), ['down'], 'identical native results do not reset the active gesture')
  monitor = { ...detectedScale(6), displayId: 2 }
  await h.pollMonitor(5)
  assert.deepEqual(h.calls.filter(call => call[0] === 'pointer').map(call => call[3].phase), ['down', 'cancel'], 'a same-geometry replacement is detected without blur or focus')
  const beforeHide = reads
  await h.visibility(false)
  await h.pollMonitor(10)
  assert.equal(reads, beforeHide, 'hidden physical panels do not perform recurring native queries')
})

function livePointerHarness(t, transport = async () => ({ ok: true, value: undefined })) {
  const { createMobilePointerController } = load("export { createMobilePointerController } from './useMobilePointer'")
  const calls = [], errors = [], frames = new Map(), timers = new Map()
  let clock = 0, sequence = 0
  const pointer = createMobilePointerController({
    send: event => { calls.push(event); return transport(event) }, onError: error => errors.push(error), onCancel() {},
    now: () => clock, requestFrame: callback => { const id = ++sequence; frames.set(id, callback); return id }, cancelFrame: id => frames.delete(id),
    scheduleTimeout: (callback, delay) => { const id = ++sequence; timers.set(id, { callback, due: clock + delay }); return () => timers.delete(id) }
  })
  t.after(() => pointer.dispose())
  return { pointer, calls, errors, frame: () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()) },
    advance: ms => { clock += ms; for (const [id, timer] of timers) if (timer.due <= clock) { timers.delete(id); timer.callback() } } }
}

test('live pointer sends DOWN before release and coalesces200moves while preserving final MOVE and UP without waiting for ACK', t => {
  const acknowledgement = deferred(), h = livePointerHarness(t, () => acknowledgement.promise)
  assert.equal(h.pointer.down({ x: .1, y: .2 }), true)
  assert.deepEqual(h.calls.map(call => call.phase), ['down'])
  for (let index = 0; index < 200; index++) h.pointer.move({ x: index / 200, y: .4 })
  assert.equal(h.calls.length, 1)
  h.frame()
  assert.deepEqual(h.calls.map(call => call.phase), ['down', 'move'])
  for (let index = 0; index < 200; index++) { h.pointer.move({ x: .6, y: index / 200 }); h.frame() }
  assert.equal(h.calls.length, 2, 'only one MOVE may await the bridge at a time')
  h.pointer.up({ x: .7, y: .8 })
  assert.deepEqual(h.calls.map(call => call.phase), ['down', 'move', 'move', 'up'])
  assert.equal(h.calls[2].x, .7); assert.equal(h.calls[2].y, .8)
  assert.equal(h.calls[3].gestureId, h.calls[0].gestureId)
  assert.match(h.calls[0].gestureId, /^[A-Za-z0-9_-]{1,64}$/)
})

test('live pointer preserves three rapid taps but sends the next DOWN only after the previous UP is confirmed', async t => {
  const terminal = deferred(); let first = true
  const h = livePointerHarness(t, event => event.phase === 'up' && first ? (first = false, terminal.promise) : Promise.resolve({ ok: true, value: undefined }))
  for (let index = 0; index < 3; index++) { h.pointer.down({ x: .2, y: .3 }); h.pointer.up({ x: .2, y: .3 }) }
  assert.deepEqual(h.calls.map(call => call.phase), ['down', 'up'])
  terminal.resolve({ ok: true, value: undefined })
  for (let index = 0; index < 15; index++) await Promise.resolve()
  assert.deepEqual(h.calls.map(call => call.phase), ['down', 'up', 'down', 'up', 'down', 'up'])
  assert.equal(new Set(h.calls.filter(call => call.phase === 'down').map(call => call.gestureId)).size, 3)
})

test('live cancellation clears pending gestures before a delayed DOWN/UP can complete', async t => {
  const acknowledgement = deferred(), h = livePointerHarness(t, () => acknowledgement.promise)
  h.pointer.down({ x: .1, y: .2 }); h.pointer.up({ x: .1, y: .2 })
  h.pointer.down({ x: .6, y: .7 }); h.pointer.move({ x: .8, y: .9 }); h.pointer.up({ x: .8, y: .9 })
  h.pointer.cancel()
  assert.deepEqual(h.calls.map(call => call.phase), ['down', 'up', 'cancel'])
  acknowledgement.resolve({ ok: true, value: undefined })
  for (let index = 0; index < 10; index++) await Promise.resolve()
  h.frame()
  assert.deepEqual(h.calls.map(call => call.phase), ['down', 'up', 'cancel'], 'cancelled callbacks never replay queued input')
})

test('live input queue is bounded to4gestures and expires after1second without replay', async t => {
  const acknowledgement = deferred(), h = livePointerHarness(t, () => acknowledgement.promise)
  for (let index = 0; index < 4; index++) { assert.equal(h.pointer.down({ x: .2, y: .3 }), true); h.pointer.up({ x: .2, y: .3 }) }
  assert.equal(h.pointer.down({ x: .2, y: .3 }), false)
  assert.equal(h.calls.length, 2)
  h.advance(1001)
  assert.equal(h.calls.at(-1).phase, 'cancel')
  acknowledgement.resolve({ ok: true, value: undefined })
  for (let index = 0; index < 10; index++) await Promise.resolve()
  assert.equal(h.calls.length, 3)
  assert.ok(h.errors.length > 0)
})

test('live transport failure cancels its gesture and permits a fresh click without replay or legacy input', async t => {
  const failed = deferred(); let first = true
  const h = livePointerHarness(t, event => event.phase === 'down' && first ? (first = false, failed.promise) : Promise.resolve({ ok: true, value: undefined }))
  h.pointer.down({ x: .2, y: .3 }); h.pointer.move({ x: .5, y: .6 })
  failed.resolve({ ok: false, error: 'CANAL_INTERROMPIDO' })
  for (let index = 0; index < 10; index++) await Promise.resolve()
  h.frame()
  assert.deepEqual(h.calls.map(call => call.phase), ['down', 'cancel'])
  assert.match(h.errors[0], /CANAL_INTERROMPIDO/)
  assert.equal(h.pointer.down({ x: .3, y: .4 }), true)
  h.pointer.up({ x: .3, y: .4 })
  assert.deepEqual(h.calls.map(call => call.phase), ['down', 'cancel', 'down', 'up'])
})

const liveState = () => ({ ...state(), sessions: [{ ...session(), displayProfileId: 'pixel-7', liveInputAvailable: true }] })
const pointerEvent = (clientX = 100, clientY = 200) => ({ clientX, clientY, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, preventDefault() {},
  currentTarget: { setPointerCapture() {}, hasPointerCapture: () => false, releasePointerCapture() {} } })

test('video pointer normalization uses source aspect and the aligned painted surface, never output backing or shell geometry', async t => {
  const surface = { left: 26.4, top: 40, width: 294.4, height: 653.6 }, source = { width: 1080, height: 2400 }
  const h = await harness(t, { screen: { playing: true, showing: true, source: null, frame: null, error: null, videoSize: source, resize() {} },
    canvas: { width: 368, height: 817, getBoundingClientRect: () => surface } })
  const display = () => h.tree.root.findByProps({ 'data-testid': 'mobile-viewport' })
  const scale = Math.min(surface.width / source.width, surface.height / source.height)
  const left = surface.left + (surface.width - source.width * scale) / 2
  const event = pointerEvent(left + source.width * scale * .25, surface.top + source.height * scale * .75)
  await act(() => display().props.onPointerDown(event)); await act(() => display().props.onPointerUp(event))
  const action = h.calls.find(call => call[0] === 'act')?.[3]
  assert.ok(action, 'the visible point is interactive'); assert.equal(action.type, 'tap')
  assert.ok(Math.abs(action.x - .25) < 1e-9); assert.ok(Math.abs(action.y - .75) < 1e-9)
  const shell = h.tree.root.find(node => node.props.className?.includes('mobile-phone-shell'))
  assert.equal(shell.props.style['--mobile-screen-ratio'], 1080 / 2400)
})

test('the real viewport routes live DOWN and MOVE before UP, keeps Home usable and never synthesizes a tap', async t => {
  const ack = deferred(), h = await harness(t, { state: liveState(), pointer: () => ack.promise })
  const display = () => h.tree.root.findByProps({ 'data-testid': 'mobile-viewport' })
  await act(() => display().props.onPointerDown(pointerEvent()))
  assert.equal(h.calls.filter(call => call[0] === 'pointer')[0][3].phase, 'down')
  await act(async () => { display().props.onPointerMove(pointerEvent(140, 240)); await new Promise(resolve => setTimeout(resolve, 10)) })
  assert.deepEqual(h.calls.filter(call => call[0] === 'pointer').map(call => call[3].phase), ['down', 'move'])
  assert.equal(h.tree.root.findByProps({ 'aria-label': 'Início do dispositivo' }).props.disabled, false)
  await act(() => display().props.onPointerUp(pointerEvent(160, 280)))
  assert.deepEqual(h.calls.filter(call => call[0] === 'pointer').map(call => call[3].phase), ['down', 'move', 'move', 'up'])
  assert.equal(h.calls.some(call => call[0] === 'act'), false)
  await act(async () => { ack.resolve({ ok: true, value: undefined }); await ack.promise })
})

for (const [cause, change] of [
  ['panel hidden', h => h.visibility(false)],
  ['board hidden', h => h.update({ visible: false })],
  ['document hidden', h => h.emitDocument('visibilitychange', 'hidden')],
  ['window blur', h => h.emitWindow('blur')],
  ['mission switch', h => h.update({ missionId: 'two' })],
  ['project switch', h => h.update({ projectId: 'other' })],
  ['profile switch', h => h.snapshot({ ...liveState(), sessions: [{ ...liveState().sessions[0], displayProfileId: 'galaxy-s24' }] })],
  ['session switch', async h => { h.api.inspect = async () => ({ ok: true, value: { ...liveState(), sessions: [{ ...liveState().sessions[0], id: 'replacement' }] } }); await h.snapshot(liveState()) }],
  ['screen rotation', async h => { h.api.capture = async (_id, sid) => ({ ok: true, value: { ...frame(sid), width: 800, height: 400 } }); await act(async () => h.tree.root.findByProps({ 'aria-label': 'Atualizar tela do dispositivo' }).props.onClick()) }],
  ['operation busy', h => { h.api.stop = () => new Promise(() => {}); return act(() => h.tree.root.findAllByType('button').find(button => button.children.join('') === 'Parar').props.onClick()) }],
  ['zoom switch', h => scaleMenu(h).choose('125%')],
  ['physical size switch', h => scaleMenu(h).choose('Tamanho real')],
  ['focus switch', h => act(() => h.tree.root.findByProps({ 'aria-label': 'Ampliar tela do aparelho' }).props.onClick())],
  ['pointercancel', h => act(() => h.tree.root.findByProps({ 'data-testid': 'mobile-viewport' }).props.onPointerCancel(pointerEvent()))],
  ['lost capture', h => act(() => h.tree.root.findByProps({ 'data-testid': 'mobile-viewport' }).props.onLostPointerCapture(pointerEvent()))],
  ['unmount', h => h.unmount()]
]) {
  test(`live pointer cancels on ${cause}, even with DOWN still pending`, async t => {
    const ack = deferred(), h = await harness(t, { state: liveState(), pointer: () => ack.promise })
    await act(() => h.tree.root.findByProps({ 'data-testid': 'mobile-viewport' }).props.onPointerDown(pointerEvent()))
    await change(h)
    const packets = () => h.calls.filter(call => call[0] === 'pointer')
    assert.deepEqual(packets().map(call => call[3].phase), ['down', 'cancel'])
    assert.deepEqual(packets()[1].slice(1, 3), ['one', 'session-one'], 'cancellation retains its originating mission and session')
    assert.equal(packets()[1][3].gestureId, packets()[0][3].gestureId)
    await act(async () => { ack.resolve({ ok: true, value: undefined }); await ack.promise; await Promise.resolve() })
    assert.equal(packets().length, 2)
    assert.equal(h.calls.some(call => call[0] === 'act'), false, 'no discrete input is replayed after cancellation')
  })
}

test('old bridges without pointer gracefully retain discrete tap input even when the session advertises live support', async t => {
  const h = await harness(t, { state: liveState() })
  const display = () => h.tree.root.findByProps({ 'data-testid': 'mobile-viewport' })
  await act(() => display().props.onPointerDown(pointerEvent()))
  assert.equal(h.calls.some(call => call[0] === 'act'), false)
  await act(async () => display().props.onPointerUp(pointerEvent()))
  assert.equal(h.calls.find(call => call[0] === 'act')[3].type, 'tap')
})

test('optional scale correction cancels live input while keeping the device connected', async t => {
  const ack = deferred(), h = await harness(t, { state: liveState(), pointer: () => ack.promise })
  const s = scaleMenu(h)
  await s.choose('Tamanho real')
  await act(() => h.tree.root.findByProps({ 'data-testid': 'mobile-viewport' }).props.onPointerDown(pointerEvent()))
  await s.choose('Calibrar tamanho real…')
  assert.equal(h.tree.root.findAllByProps({ role: 'dialog' }).length, 1)
  assert.deepEqual(h.calls.filter(call => call[0] === 'pointer').map(call => call[3].phase), ['down', 'cancel'])
  assert.equal(h.calls.some(call => call[0] === 'stop'), false)
  await act(() => ack.resolve({ ok: true, value: undefined }))
})

test('a delayed lostpointercapture event cannot cancel the new gesture that recaptured the same pointer', async t => {
  const ack = deferred(), h = await harness(t, { state: liveState(), pointer: () => ack.promise })
  const display = () => h.tree.root.findByProps({ 'data-testid': 'mobile-viewport' })
  await act(() => { display().props.onPointerDown(pointerEvent()); display().props.onPointerUp(pointerEvent()); display().props.onPointerDown(pointerEvent()) })
  const late = pointerEvent(); late.currentTarget.hasPointerCapture = () => true
  await act(() => display().props.onLostPointerCapture(late))
  assert.deepEqual(h.calls.filter(call => call[0] === 'pointer').map(call => call[3].phase), ['down', 'up'])
  await act(async () => { ack.resolve({ ok: true, value: undefined }); await ack.promise; await Promise.resolve() })
  await act(() => display().props.onPointerUp(pointerEvent()))
  assert.deepEqual(h.calls.filter(call => call[0] === 'pointer').map(call => call[3].phase), ['down', 'up', 'down', 'up'])
})

test('a secondary pointer UP or CANCEL cannot end the primary live gesture', async t => {
  const h = await harness(t, { state: liveState(), pointer: async () => ({ ok: true, value: undefined }) })
  const display = () => h.tree.root.findByProps({ 'data-testid': 'mobile-viewport' })
  const secondary = { ...pointerEvent(), pointerId: 2, isPrimary: false, pointerType: 'touch' }
  await act(() => display().props.onPointerDown(pointerEvent()))
  await act(() => { display().props.onPointerDown(secondary); display().props.onPointerUp(secondary); display().props.onPointerCancel(secondary) })
  assert.deepEqual(h.calls.filter(call => call[0] === 'pointer').map(call => call[3].phase), ['down'])
  await act(async () => display().props.onPointerUp(pointerEvent()))
  assert.deepEqual(h.calls.filter(call => call[0] === 'pointer').map(call => call[3].phase), ['down', 'up'])
})
