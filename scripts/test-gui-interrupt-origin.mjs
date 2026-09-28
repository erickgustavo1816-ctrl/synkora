import assert from 'node:assert/strict'
import test from 'node:test'
import { GuiSessionRegistry } from '../.tmp/gui-sessions-test/main/guiSessions.js'
import * as escape from '../src/renderer/src/guiEscape.ts'
import { guiApi } from '../src/renderer/src/guiApi.ts'

function registry(t, interrupt = () => true) {
  const records = []
  const gui = new GuiSessionRegistry({
    push() {}, systemPromptFile: () => undefined,
    record: (event, ids, detail) => records.push({ event, ids, detail })
  })
  gui.spawnSession = () => ({
    alive: true, turnActive: true, keepsQueuedOnInterrupt: true,
    interrupt, kill() {}, send() {}, sendSteer() { return true }
  })
  assert.equal(gui.create({
    paneId: 'p-origin', projectId: 'project-test', cli: 'claude', configDir: 'c', cwd: process.cwd()
  }).ok, true)
  t.after(() => gui.kill('p-origin'))
  return { gui, records }
}

test('interrupção preserva a origem até o registro e descarta conteúdo extra', (t) => {
  const { gui, records } = registry(t)
  gui.interrupt('p-origin', {
    source: 'escape', eventType: 'keydown', isTrusted: false, repeat: true,
    target: 'textarea', focus: 'button', defaultPrevented: false,
    text: 'private synthetic text', value: 'private synthetic value', key: 'private key'
  })
  const audit = records.find(r => r.event === 'gui-interrupt-request')
  assert.ok(audit, 'cada tentativa deve registrar sua origem')
  assert.deepEqual(audit.ids, { paneId: 'p-origin', projectId: 'project-test' })
  assert.deepEqual(audit.detail, {
    origin: { source: 'escape', eventType: 'keydown', isTrusted: false, repeat: true,
      target: 'textarea', focus: 'button', defaultPrevented: false },
    outcome: 'accepted'
  })
  assert.ok(!JSON.stringify(audit).includes('private'))
})

test('origem ausente ou forjada não vira gesto do dono nem causa interna', (t) => {
  const { gui, records } = registry(t)
  for (const input of [undefined, null, 'private', { source: 'owner-message-force', target: 'private' },
    { source: 'stop-button', eventType: 'private', isTrusted: 'true', repeat: 1, focus: 'private' }]) {
    gui.interrupt('p-origin', input)
  }
  assert.deepEqual(records.filter(r => r.event === 'gui-interrupt-request').map(r => r.detail.origin), [
    { source: 'unknown' }, { source: 'unknown' }, { source: 'unknown' }, { source: 'unknown' },
    { source: 'stop-button' }
  ])
})

test('tentativa recusada e exceção também deixam rastro sem vazar o erro', (t) => {
  let fail = false
  const { gui, records } = registry(t, () => {
    if (fail) throw new Error('private exception')
    return false
  })
  gui.interrupt('p-origin', { source: 'stop-button' })
  fail = true
  assert.throws(() => gui.interrupt('p-origin', { source: 'escape' }), /private exception/)
  const attempts = records.filter(r => r.event === 'gui-interrupt-request')
  assert.deepEqual(attempts.map(r => r.detail.outcome), ['not-active', 'error'])
  assert.ok(!JSON.stringify(attempts).includes('private'))
})

test('ler agora identifica a interrupção interna e não inventa evento de teclado', (t) => {
  const { gui, records } = registry(t)
  gui.ownerSteer.noteSteered('p-origin', 'message-test', Date.now())
  assert.equal(gui.forceOwnerMessage('p-origin', 'message-test').ok, true)
  const attempt = records.find(r => r.event === 'gui-interrupt-request')
  assert.deepEqual(attempt?.detail, { origin: { source: 'owner-message-force' }, outcome: 'accepted' })
})

test('ponte do renderer mantém a origem do botão até a caixa-preta', async (t) => {
  const { gui, records } = registry(t)
  const previous = globalThis.window
  globalThis.window = { synkora: { gui: { interrupt: (...args) => gui.interrupt(...args) } } }
  t.after(() => { globalThis.window = previous })
  assert.equal((await guiApi.interrupt('p-origin', {
    source: 'stop-button', eventType: 'click', isTrusted: false, target: 'other', focus: 'button'
  })).ok, true)
  assert.deepEqual(records.find(r => r.event === 'gui-interrupt-request')?.detail.origin, {
    source: 'stop-button', eventType: 'click', isTrusted: false, target: 'other', focus: 'button'
  })
})

test('handoff identifica a rota interna que interrompe antes de entregar a mensagem', (t) => {
  const { gui, records } = registry(t)
  assert.equal(gui.routeOwnerSteer('p-origin', gui.panes.get('p-origin'), 'message-handoff',
    'Synthetic message', { route: 'stop-and-hand', reason: 'synthetic force' }), true)
  assert.deepEqual(records.find(r => r.event === 'gui-interrupt-request')?.detail, {
    origin: { source: 'owner-message-handoff' }, outcome: 'accepted'
  })
})

test('falha no registro diagnóstico não impede a parada do motor', (t) => {
  let stopped = false
  const { gui } = registry(t, () => { stopped = true; return true })
  const original = gui.deps.record
  gui.deps.record = (event, ...args) => {
    if (event === 'gui-interrupt-request') throw new Error('diagnostic sink unavailable')
    original(event, ...args)
  }
  assert.equal(gui.interrupt('p-origin', { source: 'stop-button' }).ok, true)
  assert.equal(stopped, true)
})

test('Esc captura metadados estruturais do evento sem coletar valores do DOM', (t) => {
  const previous = { window: globalThis.window, document: globalThis.document, Element: globalThis.Element }
  let listener, received
  class Element {
    tagName = 'TEXTAREA'
    isConnected = true
    dataset = { guiPaneId: 'p-origin' }
    value = 'private typed text'
    closest(selector) { return selector === '[data-gui-pane-id]' ? this : null }
    getClientRects() { return [{}] }
  }
  const target = new Element()
  globalThis.Element = Element
  globalThis.document = { activeElement: target, querySelectorAll: () => [] }
  globalThis.window = { addEventListener: (_name, cb) => { listener = cb }, removeEventListener() {} }
  const unregister = escape.registerGuiEscapeTarget('p-origin', target,
    () => ({ working: true, questionOpen: false, menuOpen: false }), origin => { received = origin }, () => {})
  const uninstall = escape.installGlobalGuiEscape()
  t.after(() => { uninstall(); unregister(); Object.assign(globalThis, previous) })
  listener({ key: 'Escape', type: 'keydown', target, isTrusted: false, repeat: true,
    defaultPrevented: false, preventDefault() {}, stopPropagation() {} })
  assert.deepEqual(received, { source: 'escape', eventType: 'keydown', isTrusted: false,
    repeat: true, defaultPrevented: false, target: 'textarea', focus: 'textarea' })
})
