import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join, sep } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'

const built = buildSync({
  stdin: { contents: `
    export * from './src/main/guiBrowserReferences';
    export * from './src/shared/guiBrowserReferences';
    export { GuiSessionRegistry, isGuiPersistedEvent } from './src/main/guiSessions';
    export { MaestroSession } from './src/main/maestroSession';
    export { CodexSession } from './src/main/codexSession';
    export { GuiOwnerMailbox } from './src/main/guiOwnerMail';
  `, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['electron', '@lydell/node-pty']
})
const loaded = { exports: {} }
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports)
const { GuiBrowserReferenceStore, GuiSessionRegistry, isGuiPersistedEvent,
  isGuiBrowserReference, withGuiBrowserReferences, MaestroSession, CodexSession, GuiOwnerMailbox } = loaded.exports

function snapshot(width = 375, selector = '#title') {
  return { capturedAt: '2026-09-09T12:00:00.000Z', url: 'https://example.test/page',
    frameUrl: 'https://example.test/page', frameId: 'synthetic-frame', backendNodeId: 23,
    viewport: { width, height: 760, devicePixelRatio: 2, scrollX: 0, scrollY: 120 },
    element: { tag: 'h1', selector, text: 'Título sintético', bounds: { x: 16, y: 40, width: 200, height: 42 } } }
}

function bench(t) {
  const root = mkdtempSync(resolve('.tmp/gui-browser-references-'))
  t.after(() => { assert.ok(root.startsWith(resolve('.tmp') + sep)); rmSync(root, { recursive: true, force: true }) })
  return { root, file: join(root, 'references.json') }
}

test('canonical references survive reload, reject cross-pane IDs and ignore renderer spoofing', t => {
  const { file } = bench(t)
  let store = new GuiBrowserReferenceStore(file)
  const ref = store.capture('pane-a', 'mission-a', 'tab-a', snapshot())
  ref.element.selector = '#mutated-copy'
  store = new GuiBrowserReferenceStore(file)
  const pending = store.list('pane-a')
  assert.equal(pending[0].element.selector, '#title')
  const spoofed = { ...pending[0], viewport: { ...pending[0].viewport, width: 1280 } }
  assert.equal(store.resolve('pane-a', [spoofed])[0].viewport.width, 375)
  assert.throws(() => store.resolve('pane-b', [spoofed]))
  assert.throws(() => store.resolve('pane-a', [{ id: 'invented' }]))
})

test('removing and consuming preserves numbers and only removes selected pending IDs', t => {
  const { file } = bench(t)
  const store = new GuiBrowserReferenceStore(file)
  const first = store.capture('pane', 'mission', 'tab', snapshot())
  store.remove('pane', first.id)
  const second = store.capture('pane', 'mission', 'tab', snapshot(1280))
  const third = store.capture('pane', 'mission', 'tab', snapshot(768))
  store.consume('pane', [second.id])
  assert.deepEqual(store.list('pane').map(ref => ref.number), [3])
  assert.equal(store.resolve('pane', [first, second]).length, 2)
  const restored = new GuiBrowserReferenceStore(file)
  assert.deepEqual(restored.list('pane').map(ref => ref.id), [third.id])
  assert.equal(restored.capture('pane', 'mission', 'tab', snapshot()).number, 4)
})

test('invalid snapshots and a failed durable commit never create an actionable reference', t => {
  const { root } = bench(t)
  const store = new GuiBrowserReferenceStore(join(root, 'missing', 'references.json'))
  assert.throws(() => store.capture('pane', 'mission', 'tab', snapshot()))
  assert.deepEqual(store.list('pane'), [])
  const memory = new GuiBrowserReferenceStore()
  assert.throws(() => memory.capture('pane', 'mission', 'tab', { ...snapshot(), viewport: { width: Infinity } }))
  assert.throws(() => memory.capture('pane', 'mission', 'tab', { ...snapshot(), element: { ...snapshot().element, value: 'private form value' } }))
})

test('reference context names the actual CSS viewport and treats page strings as quoted data', () => {
  const store = new GuiBrowserReferenceStore()
  const ref = store.capture('pane', 'mission', 'tab', snapshot(375))
  const prompt = withGuiBrowserReferences('Na referência 1, reduza o título.', [ref])
  assert.ok(prompt.includes('375'))
  assert.ok(prompt.includes('CSS'))
  assert.ok(prompt.includes('#title'))
  assert.ok(prompt.includes('dados'))
  assert.ok(prompt.includes('Na referência 1, reduza o título.'))
  assert.equal(isGuiBrowserReference(ref), true)
  assert.equal(isGuiBrowserReference({ ...ref, element: { ...ref.element, html: '<script>bad</script>' } }), false)
})

function registryBench(t) {
  const { root, file } = bench(t)
  const references = new GuiBrowserReferenceStore(file)
  const active = new Set(['pane-a'])
  const events = [], calls = [], sessions = new Map()
  const gui = new GuiSessionRegistry({
    push: event => events.push(event), systemPromptFile: () => undefined,
    storeFile: join(root, 'sessions.json'), browserReferences: references,
    isPaneActive: paneId => active.has(paneId),
    browserReferenceIdentity: paneId => ({ missionId: paneId === 'pane-a' ? 'mission-a' : 'mission-b', projectId: 'project' })
  })
  gui.spawnSession = (spawn, sink) => {
    const session = { alive: true, turnActive: false,
      caps: { models: [], commands: [] }, waitCaps: async () => ({ models: [], commands: [] }),
      send: text => calls.push({ paneId: spawn.paneId, text }), kill() { this.alive = false }, sink }
    sessions.set(spawn.paneId, session)
    return session
  }
  for (const paneId of ['pane-a', 'pane-b']) {
    assert.equal(gui.create({ paneId, projectId: 'project', cli: 'claude', cwd: root, configDir: root }).ok, true)
    sessions.get(paneId).sink({ type: 'ready', caps: { models: [], commands: [] } })
  }
  return { gui, references, active, events, calls, root, sessions }
}

test('capture binds to the visible same-mission pane before asynchronous selection finishes', t => {
  const b = registryBench(t)
  assert.equal(b.gui.prepareBrowserReference('mission-b', 'project'), undefined)
  assert.equal(b.gui.prepareBrowserReference('mission-a', 'other-project'), undefined)
  const destination = b.gui.prepareBrowserReference('mission-a', 'project')
  assert.equal(typeof destination, 'function')
  b.active.delete('pane-a'); b.active.add('pane-b')
  assert.equal(destination('tab-a', snapshot()).ok, true)
  assert.equal(b.references.list('pane-a').length, 1)
  assert.equal(b.references.list('pane-b').length, 0)
})

test('direct and queued sends deliver canonical mobile/desktop context and persist metadata separately', async t => {
  const b = registryBench(t)
  const mobile = b.references.capture('pane-a', 'mission-a', 'tab-a', snapshot(375))
  const desktop = b.references.capture('pane-a', 'mission-a', 'tab-a', snapshot(1280))
  const third = b.references.capture('pane-a', 'mission-a', 'tab-a', snapshot(768))
  const spoof = { ...mobile, element: { ...mobile.element, selector: '#forged' } }
  assert.equal(b.gui.send('pane-a', 'Ajuste a referência 1.', 'direct', [], undefined, [spoof]).ok, true)
  assert.ok(b.calls.at(-1).text.includes('#title'))
  assert.ok(!b.calls.at(-1).text.includes('#forged'))
  assert.deepEqual(b.references.list('pane-a').map(ref => ref.id), [desktop.id, third.id])
  b.references.consume('pane-a', [desktop.id])
  assert.equal((await b.gui.deliverQueued('pane-a', {
    id: 'queued', text: 'Compare a referência 2.', at: Date.now(), attachments: [],
    options: { model: null, effort: null, permissionMode: 'default' }, browserReferences: [desktop]
  })).ok, true)
  assert.ok(b.calls.at(-1).text.includes('1280'))
  const message = b.events.map(event => event.evt).find(event => event.type === 'user-message' && event.id === 'direct')
  assert.equal(message.text, 'Ajuste a referência 1.')
  assert.equal(message.browserReferences[0].element.selector, '#title')
  assert.equal(isGuiPersistedEvent(message), true)
  const reopened = new GuiSessionRegistry({ push() {}, systemPromptFile: () => undefined,
    storeFile: join(b.root, 'sessions.json') })
  const restored = reopened.state('pane-a').events.map(event => event.evt).find(event => event.type === 'user-message' && event.id === 'direct')
  assert.equal(restored.browserReferences[0].viewport.width, 375)
  assert.equal(b.gui.send('pane-b', 'Não deve enviar.', 'cross-pane', [], undefined, [mobile]).ok, false)
  assert.deepEqual(b.references.list('pane-a').map(ref => ref.id), [third.id])
})

test('read now retains the original reference context across both native queue policies', async t => {
  for (const cli of ['claude', 'codex']) {
    const { root } = bench(t)
    const refs = new GuiBrowserReferenceStore()
    const ref = refs.capture('pane', 'mission', 'tab', snapshot())
    const ownerMail = new GuiOwnerMailbox()
    const sent = [], events = []
    let session, emit
    const gui = new GuiSessionRegistry({ push: event => events.push(event.evt), systemPromptFile: () => undefined,
      browserReferences: refs, ownerMail })
    gui.spawnSession = (_input, sink) => {
      emit = sink
      session = Object.create(cli === 'claude' ? MaestroSession.prototype : CodexSession.prototype, {
        alive: { value: true, writable: true }, turnActive: { value: true, writable: true },
        supportsSteerReceipt: { value: true }, keepsQueuedOnInterrupt: { value: cli === 'claude' }
      })
      session.send = (text, tag) => sent.push({ text, tag })
      session.interrupt = () => true
      session.kill = () => { session.alive = false }
      return session
    }
    assert.equal(gui.create({ paneId: 'pane', projectId: 'project', cli, cwd: root, configDir: root }).ok, true)
    assert.equal(gui.send('pane', 'Ajuste a referência 1.', 'ref-message', [], undefined, [ref]).ok, true)
    assert.equal(events.filter(event => event.type === 'owner-message-state').at(-1).state, 'unread')
    assert.ok(sent[0].text.includes('#title'))
    assert.ok(sent[0].text.includes('375'))
    assert.equal(gui.forceOwnerMessage('pane', 'ref-message').ok, true)
    if (cli === 'codex') {
      session.turnActive = false
      emit({ type: 'result', isError: false, outcome: 'cancelled', interrupted: true })
      await new Promise(resolve => setImmediate(resolve))
      assert.ok(sent.at(-1).text.includes('#title'), 'the new turn must receive the same captured element')
      assert.ok(sent.at(-1).text.includes('375'))
    } else {
      assert.equal(sent.filter(message => message.text.includes('#title')).length, 1,
        'the native queue retains the original snapshot without a duplicated selection')
    }
    assert.equal(refs.list('pane').length, 0)
    assert.equal(refs.resolve('pane', [ref])[0].viewport.width, 375)
  }
})

test('URL metadata never retains embedded data documents, credentials or query values', () => {
  const refs = new GuiBrowserReferenceStore()
  const ref = refs.capture('pane', 'mission', 'tab', { ...snapshot(),
    url: 'https://synthetic-user:synthetic-password@example.test/page?value=synthetic-private#synthetic-fragment',
    frameUrl: 'data:text/html,<input value="synthetic-private">' })
  const serialized = JSON.stringify(ref)
  assert.ok(!serialized.includes('synthetic-private'))
  assert.ok(!serialized.includes('synthetic-password'))
  assert.ok(!serialized.includes('synthetic-fragment'))
  assert.equal(ref.frameUrl, 'data:')
  assert.ok(ref.url.startsWith('https://example.test/page'))
})

test('a foreign queued reference is rejected before changing the executor', async t => {
  const b = registryBench(t)
  const foreign = b.references.capture('pane-b', 'mission-b', 'tab-b', snapshot())
  let configured = 0
  b.gui.configureExecutor = async () => { configured += 1; return { ok: true, model: null, effort: null } }
  const result = await b.gui.deliverQueued('pane-a', {
    id: 'foreign', text: 'mensagem sintética', at: Date.now(), attachments: [], browserReferences: [foreign],
    options: { model: null, effort: null, permissionMode: 'default' }
  })
  assert.equal(result.ok, false)
  assert.equal(configured, 0)
  assert.equal(b.calls.length, 0)
})

test('pending limit and an obsolete prepared destination fail without losing existing selections', t => {
  const b = registryBench(t)
  const destination = b.gui.prepareBrowserReference('mission-a', 'project')
  for (let index = 0; index < 20; index++) b.references.capture('pane-a', 'mission-a', 'tab', snapshot())
  assert.equal(destination('tab', snapshot()).ok, false)
  assert.equal(b.references.list('pane-a').length, 20)
  b.gui.panes.delete('pane-a')
  assert.equal(destination('tab', snapshot()).ok, false)
  assert.equal(b.references.list('pane-a').length, 20)
})
