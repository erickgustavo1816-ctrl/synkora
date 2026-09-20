#!/usr/bin/env node
import assert from 'node:assert/strict'
import test from 'node:test'
const { BrowserDriverSession } = await import(new URL(
  process.env.SYNKORA_BROWSER_OBSERVATION_BUILD ?? '../.tmp/browser-observation-economy-test/browserDriver.js',
  import.meta.url
).href)

class Element {
  constructor(tag, text = '', id = '') {
    this.tagName = tag.toUpperCase()
    this.nodeType = 1
    this.id = id
    this.attrs = id ? { id } : {}
    this.children = []
    this.childNodes = text ? [{ nodeType: 3, nodeValue: text }] : []
    this.isConnected = true
    this.rect = { left: 0, top: 0, width: 200, height: 30 }
    this.styles = {}
    this.value = ''
  }
  add(child) { child.parentElement = this; this.children.push(child); this.childNodes.push(child); return child }
  getAttribute(name) { return this.attrs[name] ?? null }
  hasAttribute(name) { return name in this.attrs }
  get textContent() { return this.childNodes.map(n => n.nodeType === 3 ? n.nodeValue : n.textContent).join('') }
  get innerText() { return this.textContent }
  getBoundingClientRect() {
    return { ...this.rect, x: this.rect.left, y: this.rect.top, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }
  }
  get scrollWidth() { return this.rect.width }
  get scrollHeight() { return this.rect.height }
  get clientWidth() { return this.rect.width }
  get clientHeight() { return this.rect.height }
  scrollIntoView() {}
  focus() { this.doc.activeElement = this }
  dispatchEvent() { return true }
  contains(el) { return el === this || this.children.some(child => child.contains(el)) }
}

function fixture({ paragraphs = 3 } = {}) {
  const body = new Element('body')
  body.rect = { left: 0, top: 0, width: 1200, height: 800 }
  const hero = body.add(new Element('section', '', 'hero'))
  const title = hero.add(new Element('h1', 'Synthetic landing title', 'title'))
  const button = hero.add(new Element('button', 'Continue', 'continue'))
  const field = hero.add(new Element('input', '', 'field'))
  field.attrs.type = 'text'
  for (let i = 0; i < paragraphs; i++) body.add(new Element('p', `Paragraph ${i} ${'synthetic content '.repeat(9)}`))
  const all = root => [root, ...root.children.flatMap(all)]
  const document = {
    body, documentElement: body, title: 'Synthetic fixture', readyState: 'complete',
    fonts: { status: 'loaded' }, getAnimations: () => [],
    getElementById(id) { return all(body).find(el => el.id === id) ?? null },
    querySelector(selector) {
      if (selector === '[') throw new Error('invalid selector')
      return all(body).find(el => selector.startsWith('#') ? el.id === selector.slice(1) : el.tagName.toLowerCase() === selector) ?? null
    },
    elementFromPoint: () => button
  }
  const window = {
    document, innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0, devicePixelRatio: 1,
    getComputedStyle(el) {
      const values = { display: 'block', visibility: 'visible', opacity: '1', color: 'rgb(0, 0, 0)', backgroundColor: 'rgb(255, 255, 255)', fontSize: '16px', fontWeight: '400', ...el.styles }
      return { ...values, getPropertyValue(name) { return values[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? '' } }
    }
  }
  all(body).forEach(el => { el.doc = document })
  const location = { href: 'http://127.0.0.1:4567/synthetic' }
  const calls = []
  let listener
  let thrownRead
  let thrownInput
  let inputEffect
  const debugger_ = {
    attached: false,
    isAttached() { return this.attached }, attach() { this.attached = true }, detach() {},
    on(_event, fn) { listener = fn },
    async sendCommand(method, params) {
      calls.push({ method, params, startedAt: Date.now() })
      if (method.startsWith('Input.')) inputEffect?.(method)
      if (thrownInput && method.startsWith('Input.')) throw new Error(thrownInput)
      if (method !== 'Runtime.evaluate') return {}
      if (params.expression.startsWith('new Promise')) return { result: { value: 1 } }
      if (thrownRead && params.expression.includes('"mode":"read"')) throw new Error(thrownRead)
      const value = new Function('window', 'document', 'location', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', `return (${params.expression})`)(window, document, location, Element, Element, class {})
      return { result: { value } }
    }
  }
  const page = { id: 101, debugger: debugger_, isDestroyed: () => false, getURL: () => location.href, getTitle: () => document.title }
  const session = new BrowserDriverSession(page)
  return { session, window, document, title, hero, button, field, calls, location,
    emit: (method, params) => listener?.({}, method, params),
    failRead: message => { thrownRead = message }, failInput: message => { thrownInput = message },
    onInput: fn => { inputEffect = fn }
  }
}

test('compact default bounds the entire observation; full detail remains recoverable', async () => {
  const { session } = fixture({ paragraphs: 200 })
  const compact = await session.read()
  assert.ok(compact.length <= 2000, `default response used ${compact.length} chars, expected <= 2000`)
  assert.match(compact, /Synthetic landing title/u)
  assert.match(compact, /CORTADO/u)
  const full = await session.read({ detail: 'full' })
  assert.ok(full.length > compact.length * 2)
  assert.match(full, /Paragraph 25/u)
})

test('explicit response budget includes long title, URL and truncation recipe', async () => {
  const f = fixture({ paragraphs: 100 })
  f.document.title = 'Synthetic title '.repeat(100)
  f.location.href += `/${'path/'.repeat(400)}`
  const text = await f.session.read({ maxChars: 32000, responseMaxChars: 700 })
  assert.ok(text.length <= 700, `response budget leaked: ${text.length}`)
  assert.match(text, /CORTADO/u)
  assert.match(text, /browser_read/u)
  assert.match(text, /epoch/u)
})

test('a scoped leaf includes the requested element, without siblings', async () => {
  const { session } = fixture()
  const text = await session.read({ scope: '#title' })
  assert.match(text, /Synthetic landing title/u)
  assert.doesNotMatch(text, /Paragraph|Continue/u)
})

test('incremental reads require an explicit compatible observation ID', async () => {
  const { session } = fixture()
  assert.equal(typeof session.observe, 'function', 'driver needs structured observations')
  const first = await session.observe({ scope: '#hero' })
  assert.equal(first.ok, true)
  assert.equal(first.mode, 'fresh')
  assert.ok(first.observationId)
  const repeatedWithoutBaseline = await session.observe({ scope: '#hero' })
  assert.equal(repeatedWithoutBaseline.mode, 'fresh')
  const repeated = await session.observe({ scope: '#hero', baselineId: first.observationId })
  assert.equal(repeated.mode, 'unchanged')
  assert.equal(repeated.baselineId, first.observationId)
  assert.ok(repeated.text.length < first.text.length)
  assert.match(repeated.text, /pixel|visual|estética/u)
  for (const options of [{ baselineId: 'unknown' }, { scope: '#title', baselineId: first.observationId }, { scope: '#hero', detail: 'full', baselineId: first.observationId }]) {
    assert.equal((await session.observe(options)).mode, 'fresh')
  }
  const other = fixture().session
  assert.equal((await other.observe({ scope: '#hero', baselineId: first.observationId })).mode, 'fresh', 'IDs cannot cross tab sessions')
})

test('geometry, style, scroll, loading, navigation and console changes invalidate unchanged', async () => {
  const f = fixture()
  assert.equal(typeof f.session.observe, 'function')
  for (const mutate of [
    () => { f.title.rect.width += 30 },
    () => { f.title.styles.color = 'rgb(255, 0, 0)' },
    () => { f.window.scrollY += 20 },
    () => { f.window.innerWidth = 375 },
    () => { f.document.readyState = 'loading' },
    () => { f.document.readyState = 'complete'; f.document.fonts.status = 'loading' },
    () => { f.document.fonts.status = 'loaded'; f.session.bumpEpoch() },
    () => f.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'synthetic failure' } })
  ]) {
    const before = await f.session.observe({ scope: '#hero' })
    mutate()
    const after = await f.session.observe({ scope: '#hero', baselineId: before.observationId })
    assert.notEqual(after.mode, 'unchanged')
  }
  const afterError = await f.session.observe({ scope: '#hero' })
  assert.match(afterError.text, /synthetic failure/u)
})

test('partial, expired and evicted observations cannot silently become baselines', async () => {
  const f = fixture({ paragraphs: 200 })
  const partial = await f.session.observe()
  assert.equal((await f.session.observe({ baselineId: partial.observationId })).mode, 'fresh')
  const first = await f.session.observe({ scope: '#hero' })
  for (let i = 0; i < 9; i++) await f.session.observe({ scope: '#hero' })
  assert.equal((await f.session.observe({ scope: '#hero', baselineId: first.observationId })).mode, 'fresh')
  const recent = await f.session.observe({ scope: '#hero' })
  const now = Date.now
  try {
    Date.now = () => now() + 61_000
    assert.equal((await f.session.observe({ scope: '#hero', baselineId: recent.observationId })).mode, 'fresh')
  } finally { Date.now = now }
})

test('explicit delta can reconstruct a changed complete observation', async () => {
  const f = fixture({ paragraphs: 5 })
  const first = await f.session.observe()
  f.title.childNodes[0].nodeValue = 'Updated synthetic landing title'
  const changed = await f.session.observe({ baselineId: first.observationId })
  assert.equal(changed.mode, 'delta')
  assert.match(changed.text, /Substitua 1 linha\(s\) a partir da linha 1/u)
  assert.match(changed.text, /Updated synthetic landing title/u)
  assert.doesNotMatch(changed.text, /Paragraph 4/u)
})

test('first action failure stops the batch, preserves diagnostic read and structured status', async () => {
  const f = fixture()
  assert.equal(typeof f.session.actResult, 'function')
  const result = await f.session.actResult([
    { action: 'hover', selector: '#continue' },
    { action: 'click', selector: '#missing' },
    { action: 'click', selector: '#continue' }
  ], {}, { observe: false })
  assert.equal(result.ok, false)
  assert.equal(result.completed, 1)
  assert.equal(result.failedStep, 2)
  assert.match(result.error, /missing/u)
  assert.ok(result.observation)
  assert.match(result.text, /passos seguintes NÃO rodaram/u)
  assert.equal(f.calls.filter(c => c.method === 'Input.dispatchMouseEvent').length, 1)
})

test('successful action batch can skip redundant read, and failure survives a broken diagnostic read', async () => {
  const f = fixture()
  assert.equal(typeof f.session.actResult, 'function')
  const result = await f.session.actResult([{ action: 'hover', selector: '#continue' }], {}, { observe: false })
  assert.equal(result.ok, true)
  assert.equal(result.observation, undefined)
  assert.equal(f.calls.filter(c => c.params?.expression?.includes('"mode":"read"')).length, 0)
  f.failRead('synthetic observation failure')
  f.failInput('synthetic input failure')
  const failed = await f.session.actResult([{ action: 'click', selector: '#continue' }, { action: 'hover', selector: '#continue' }])
  assert.equal(failed.ok, false)
  assert.equal(failed.failedStep, 1)
  assert.match(failed.text, /synthetic input failure/u)
  assert.match(failed.text, /synthetic observation failure/u)
})

test('action text budget keeps the failure after many successful steps', async () => {
  const { session } = fixture()
  const actions = Array.from({ length: 23 }, () => ({ action: 'hover', selector: '#continue' }))
  actions.push({ action: 'click', selector: '#missing' })
  const result = await session.act(actions, { responseMaxChars: 900 })
  assert.ok(result.length <= 900, `action response used ${result.length} chars`)
  assert.match(result, /PAROU no passo 24/u)
  assert.match(result, /missing/u)
  assert.match(result, /CORTADO/u)
  const minimal = await session.act(actions, { responseMaxChars: 500 })
  assert.ok(minimal.length <= 500)
  assert.match(minimal, /PAROU no passo 24/u)
  assert.match(minimal, /missing/u)
})

test('typed probes preserve useful geometry and report a missing selector', async () => {
  const f = fixture()
  const found = await f.session.probeResult({ selector: '#continue' })
  assert.equal(found.ok, true)
  assert.equal(found.value.box.w, 200)
  assert.equal(found.value.viewport.w, 1200)
  const missing = await f.session.probeResult({ selector: '#missing' })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /missing/u)
})

test('viewport measurements expose applied dimensions before a check dispatches input', async () => {
  const f = fixture()
  assert.equal(typeof f.session.viewportSize, 'function')
  assert.deepEqual(await f.session.viewportSize(), { width: 1200, height: 800 })
  f.window.innerWidth = 375
  assert.deepEqual(await f.session.viewportSize(), { width: 375, height: 800 })
})

test('an expired local deadline stops the typing fallback before any further input', async () => {
  const f = fixture()
  const now = Date.now
  let clock = now()
  const deadlineAt = clock + 250
  f.onInput(method => {
    if (method === 'Input.insertText') throw new Error('synthetic unsupported fast input')
    clock += 100
  })
  try {
    Date.now = () => clock
    const result = await f.session.actResult([
      { action: 'type', text: 'abcdefghij' }, { action: 'click', selector: '#continue' }
    ], {}, { observe: false, deadlineAt })
    assert.equal(result.ok, false)
    assert.equal(result.failedStep, 1)
    assert.equal(result.completed, 0)
    assert.match(result.text, /prazo da verificação atingido/u)
    assert.match(result.observation, /Leitura posterior não realizada/u)
    const inputs = f.calls.filter(call => call.method.startsWith('Input.'))
    assert.ok(inputs.every(call => call.startedAt < deadlineAt))
    assert.equal(inputs.filter(call => call.method === 'Input.dispatchKeyEvent').length, 3)
    assert.equal(f.calls.filter(call => call.params?.expression?.includes('"mode":"read"')).length, 0)
  } finally { Date.now = now }
})

test('structured wait returns timeout and selector errors instead of hiding them as success', async () => {
  const { session } = fixture()
  assert.equal(typeof session.waitResult, 'function')
  const timeout = await session.waitResult({ selector: '#missing', timeoutMs: 1 })
  assert.equal(timeout.ok, false)
  assert.equal(timeout.timedOut, true)
  const invalid = await session.waitResult({ selector: '[', timeoutMs: 1 })
  assert.equal(invalid.ok, false)
  assert.match(invalid.error, /invalid selector/u)
  const found = await session.waitResult({ selector: '#continue' })
  assert.equal(found.ok, true)
})

test('new console errors have a checkpoint and disclose incomplete ring coverage', async () => {
  const f = fixture()
  assert.equal(typeof f.session.consoleCheckpoint, 'function')
  await f.session.ensureAttached()
  const checkpoint = f.session.consoleCheckpoint()
  f.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'synthetic error A' } })
  const first = f.session.consoleSince(checkpoint, { onlyErrors: true })
  assert.equal(first.errors, 1)
  assert.equal(first.complete, true)
  assert.match(first.text, /synthetic error A/u)
  const next = f.session.consoleCheckpoint()
  assert.equal(f.session.consoleSince(next, { onlyErrors: true }).errors, 0)
  for (let i = 0; i < 310; i++) f.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: `synthetic ring ${i}` }] })
  const overflowed = f.session.consoleSince(checkpoint, { onlyErrors: true })
  assert.equal(overflowed.complete, false)
  assert.ok(overflowed.text.length <= 1200)
  assert.match(overflowed.text, /synthetic ring 309/u, 'latest diagnostic must survive the text budget')
  f.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'new failure after the ring filled' } })
  assert.match((await f.session.observe({ scope: '#hero' })).text, /new failure after the ring filled/u)
})

test('artifact-preview capabilities do not enter observation or diagnostic text', async () => {
  const f = fixture()
  const capability = 'a'.repeat(48)
  f.location.href = `http://127.0.0.1:4567/__synkora_preview/${capability}/preview.html`
  f.field.value = `/__synkora_preview/${capability}/preview.html`
  f.button.attrs['aria-label'] = f.location.href
  const read = await f.session.read({ scope: '#hero' })
  assert.doesNotMatch(read, /__synkora_preview/u)
  assert.doesNotMatch(read, new RegExp(capability, 'u'))
  assert.match(read, /artifact-preview/u)
  f.emit('Runtime.exceptionThrown', { exceptionDetails: { text: `synthetic error at ${f.location.href}` } })
  f.emit('Network.requestWillBeSent', { requestId: 'preview-request', request: { url: f.location.href, method: 'GET' } })
  for (const text of [
    await f.session.find('synthetic'), await f.session.evaluate('location.href'),
    await f.session.probe({ selector: '#continue' }), await f.session.act([{ action: 'hover', selector: '#continue' }]),
    f.session.consoleText({}), f.session.networkText({}), await f.session.networkBody('preview-request')
  ]) {
    assert.doesNotMatch(text, /__synkora_preview/u)
    assert.doesNotMatch(text, new RegExp(capability, 'u'))
  }
})
