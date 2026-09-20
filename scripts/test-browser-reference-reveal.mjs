import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const compiled = buildSync({ stdin: { contents: `
  export { createBrowserReferenceRevealer } from './src/main/browserReferenceReveal';
  export { GuiBrowserReferenceStore } from './src/main/guiBrowserReferences';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false })
const module = { exports: {} }
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { createBrowserReferenceRevealer, GuiBrowserReferenceStore } = module.exports
const snapshot = (token = '1'.repeat(32)) => ({ capturedAt: '2026-09-09T12:00:00.000Z',
  url: 'https://synthetic.test/', frameUrl: 'https://synthetic.test/', frameId: 'synthetic-frame', backendNodeId: 1,
  viewport: { width: 390, height: 700, devicePixelRatio: 1, scrollX: 0, scrollY: 0 }, targetToken: token,
  element: { tag: 'h1', selector: '#title', text: 'Título sintético', bounds: { x: 1, y: 2, width: 100, height: 30 } } })

function bench() {
  const store = new GuiBrowserReferenceStore(), calls = []
  const first = store.capture('pane', 'mission', 'tab', snapshot())
  const second = store.capture('pane', 'mission', 'tab', snapshot('2'.repeat(32)))
  const state = { projectId: 'project', host: 'dock', visible: true }
  const owner = { missionId: 'mission', projectId: 'project' }
  let lookup = true, present = true, found = true, show = true
  const frame = { async executeJavaScript(code) {
    if (code.startsWith('new Promise')) return true
    const args = JSON.parse('[' + code.slice(code.lastIndexOf('})(') + 3, -1) + ']')
    calls.push(args)
    if (args[3] === 'find') return typeof found === 'function' ? found(args[0]) : found
    return args[3] === 'show' ? show : true
  } }
  const page = { isDestroyed: () => false, mainFrame: { ...frame, framesInSubtree: [frame] } }
  const browser = {
    state: () => state,
    tabById: (mission, tab) => lookup && mission === 'mission' && tab === 'tab' ? { tabId: 'tab', webContents: page } : undefined,
    selectTab: (...args) => { calls.push(['select', ...args]); return true },
    popOut: () => { calls.push(['present']); return present ? { ok: true } : { ok: false, error: 'Janela indisponível' } }
  }
  return { first, second, store, state, owner, page, calls, frame,
    reveal: createBrowserReferenceRevealer({ references: store, identity: () => owner, browser }),
    setFound: value => { found = value }, setLookup: value => { lookup = value },
    setShow: value => { show = value }, setPresent: value => { present = value } }
}

test('canonical pane/mission/project ownership is checked before page effects', async () => {
  const b = bench()
  assert.equal((await b.reveal('other-pane', b.first.id)).ok, false)
  b.owner.missionId = 'other-mission'
  assert.equal((await b.reveal('pane', b.first.id)).ok, false)
  b.owner.missionId = 'mission'; b.owner.projectId = 'other-project'
  assert.equal((await b.reveal('pane', b.first.id)).ok, false)
  assert.deepEqual(b.calls, [])
})

test('locating references selects the canonical tab without consuming snapshots, including sent ones', async () => {
  const b = bench(), saved = b.store.list('pane')
  assert.deepEqual(await b.reveal('pane', { ...b.first, tabId: 'forged', targetToken: 'f'.repeat(32) }), { ok: true })
  assert.ok(b.calls.some(call => call[0] === 'select' && call[2] === 'tab'))
  assert.ok(b.calls.some(call => call[0] === b.first.targetToken && call[3] === 'show'))
  assert.deepEqual(b.store.list('pane'), saved)
  b.store.consume('pane', [b.first.id])
  assert.deepEqual(await b.reveal('pane', b.first.id), { ok: true })
})

test('hidden and detached browser surfaces are presented; failed presentation is visible', async () => {
  for (const host of ['dock', 'popout']) {
    const b = bench(); b.state.host = host; b.state.visible = false
    assert.deepEqual(await b.reveal('pane', b.first.id), { ok: true })
    assert.ok(b.calls.some(call => call[0] === 'present'))
    b.setPresent(false)
    assert.deepEqual(await b.reveal('pane', b.first.id), { ok: false, error: 'Janela indisponível' })
  }
})

test('closed tabs, old references and replaced or hidden elements give actionable errors', async () => {
  const b = bench(); b.setLookup(false)
  assert.match((await b.reveal('pane', b.first.id)).error, /aba.*fechada/)
  b.setLookup(true); b.setFound(false)
  assert.match((await b.reveal('pane', b.first.id)).error, /Selecione-o novamente/)
  b.setFound(true); b.setShow('hidden')
  assert.match((await b.reveal('pane', b.first.id)).error, /largura/)
  const old = snapshot(); delete old.targetToken
  const legacy = b.store.capture('pane', 'mission', 'tab', old)
  assert.match((await b.reveal('pane', legacy.id)).error, /Selecione-o novamente/)
})

test('a later reference wins while an earlier frame lookup is still pending', async () => {
  const b = bench()
  let release, started
  const beginning = new Promise(resolve => { started = resolve })
  b.setFound(token => token === b.first.targetToken ? new Promise(resolve => { release = resolve; started() }) : true)
  const first = b.reveal('pane', b.first.id)
  await beginning
  assert.deepEqual(await b.reveal('pane', b.second.id), { ok: true })
  release(true)
  assert.deepEqual(await first, { ok: true, cancelled: true })
  assert.deepEqual(b.calls.filter(call => call[3] === 'show').map(call => call[0]), [b.second.targetToken])
})
