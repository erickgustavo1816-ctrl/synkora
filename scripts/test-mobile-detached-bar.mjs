// The detached phone window carries ONE strip: title (drag handle), home,
// refresh, a scale button whose menu holds fit / real / zoom steps /
// calibration, and a single close button that docks the phone back.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

const require = createRequire(import.meta.url)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const profileId = 'galaxy-s24-ultra'
const session = patch => ({ id: 'bar-session', missionId: 'bar-mission', platform: 'android', deviceId: 'qa-device',
  deviceName: 'Android de demonstração', displayProfileId: profileId, state: 'ready', inputAvailable: true, ...patch })
const screen = { showing: false, playing: false, source: null, frame: null, error: null, videoSize: { width: 0, height: 0 }, resize() {}, consumerId: 'synthetic-consumer' }

function loadUi(calibration) {
  const compiled = buildSync({ stdin: { contents: "export {default as Viewport} from './components/MobileViewport'; export {default as DetachedBar} from './components/MobileDetachedBar'; export {mobileScaleLabel} from './components/MobileScaleMenu'", resolveDir: 'src/renderer/src', loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' },
    external: ['react', 'react/jsx-runtime', 'react-dom', '../useMobileScreen', '../useMobilePointer', '../mobileCalibration'] }).outputFiles[0].text
  const module = { exports: {} }
  const testRequire = name => name.endsWith('/useMobileScreen') ? { useMobileScreen: () => screen }
    : name.endsWith('/useMobilePointer') ? { useMobilePointer: () => ({ available: false, error: null, cancel() {} }) }
      : name.endsWith('/mobileCalibration') ? { useMobileCalibration: () => calibration }
        : name === 'react-dom' ? { ...require(name), createPortal: children => children } : require(name)
  const window = { innerWidth: 380, innerHeight: 820, addEventListener() {}, removeEventListener() {} }
  const document = { body: {}, activeElement: null, addEventListener() {}, removeEventListener() {} }
  new Function('require', 'module', 'exports', 'window', 'document', compiled)(testRequire, module, module.exports, window, document)
  return module.exports
}
const node = { clientWidth: 380, clientHeight: 650, offsetWidth: 380, offsetHeight: 650, scrollTop: 0, scrollLeft: 0, style: {},
  getBoundingClientRect: () => ({ x: 0, y: 0, width: 120, height: 24, left: 0, top: 0, right: 120, bottom: 24 }),
  querySelector: () => null, querySelectorAll: () => [], contains: () => false, focus() {},
  ownerDocument: { body: {}, defaultView: { innerWidth: 380, addEventListener() {}, removeEventListener() {}, document: { addEventListener() {}, removeEventListener() {} }, getComputedStyle: () => ({ marginLeft: '6px', marginRight: '6px', marginTop: '0px', marginBottom: '6px', paddingLeft: '6px', paddingRight: '6px', paddingTop: '6px', paddingBottom: '6px' }) } } }
const measured = { key: 'synthetic-monitor', pixelsPerMm: 3.6, manualPixelsPerMm: null, source: 'edid-detailed', screen: { pixelRatio: 1, viewportScale: 1 }, confirm: () => true, reset: () => true }
const estimated = { ...measured, source: 'estimated' }

async function mount(ui, props) {
  let tree
  const base = { missionId: 'bar-mission', session: session({}), profileId, visible: true, busy: false, act: async () => true, expanded: false, onToggleExpanded() {},
    presentation: 'detached', initialScaleMode: 'physical', onContentSize() {} }
  await act(() => { tree = create(React.createElement(ui.Viewport, { ...base, ...props }), { createNodeMock: () => node }) })
  const buttons = () => tree.root.findAllByType('button').filter(button => button.props['aria-label'])
  const label = name => { const found = tree.root.findAll(el => el.type === 'button' && el.props['aria-label'] === name); assert.equal(found.length, 1, `one ${name} button`); return found[0] }
  const scale = () => label('Tamanho da visualização')
  const menu = () => tree.root.findAllByProps({ role: 'menu' })
  const item = text => tree.root.findAll(el => el.type === 'button' && ['menuitemradio', 'menuitem'].includes(el.props.role) && el.children.join('') === text)[0]
  const open = async () => { if (!menu().length) await act(() => scale().props.onClick()) }
  const choose = async text => { await open(); const target = item(text); assert.ok(target, `menu item ${text}`); await act(() => target.props.onClick()) }
  const mode = () => tree.root.findByProps({ 'data-frame-family': 'galaxy-ultra' }).props['data-size-mode']
  return { tree, buttons, label, scale, menu, item, open, choose, mode, update: props => act(() => tree.update(React.createElement(ui.Viewport, { ...base, ...props }))) }
}

test('the detached window shows one strip: title, home, refresh, scale menu and a single close button', async t => {
  const ui = loadUi(measured)
  let closed = 0
  const h = await mount(ui, { onCloseWindow: () => { closed++ }, closingWindow: false })
  t.after(() => act(() => h.tree.unmount()))
  const strip = h.tree.root.findByProps({ 'data-testid': 'mobile-phone-drag-bar' })
  assert.ok(strip.props.className.includes('mobile-detached-bar') && strip.props.className.includes('mobile-phone-window-bar'))
  assert.equal(h.tree.root.findByProps({ className: 'mobile-detached-title' }).findAllByType('span')[0].children.join(''), 'Galaxy S24 Ultra')
  assert.deepEqual(h.buttons().map(button => button.props['aria-label']),
    ['Início do dispositivo', 'Atualizar tela do dispositivo', 'Tamanho da visualização', 'Fechar janela do aparelho'])
  assert.equal(h.tree.root.findAllByProps({ className: 'mobile-view-toolbar' }).length, 0, 'the panel toolbar never renders in the detached window')
  for (const gone of ['Voltar ao painel Mobile', 'Ampliar tela do aparelho', 'Aumentar zoom do aparelho', 'Ajustar aparelho ao painel'])
    assert.equal(h.tree.root.findAllByProps({ 'aria-label': gone }).length, 0, `${gone} is gone`)
  await act(() => h.label('Fechar janela do aparelho').props.onClick())
  assert.equal(closed, 1)
  await h.update({ onCloseWindow: () => { closed++ }, closingWindow: true })
  assert.equal(h.label('Fechar janela do aparelho').props.disabled, true)
  await h.update({ session: session({ deviceName: 'iPhone 17', platform: 'ios', displayProfileId: undefined, deviceTypeIdentifier: 'com.apple.CoreSimulator.SimDeviceType.iPhone-17' }) })
  assert.equal(h.tree.root.findByProps({ className: 'mobile-detached-title' }).findAllByType('span')[0].children.join(''), 'iPhone 17', 'iOS titles use the simulator name')
})

test('a strip without a window host (fixtures) has no close button', async t => {
  const h = await mount(loadUi(measured), {})
  t.after(() => act(() => h.tree.unmount()))
  assert.deepEqual(h.buttons().map(button => button.props['aria-label']), ['Início do dispositivo', 'Atualizar tela do dispositivo', 'Tamanho da visualização'])
})

test('the scale button names the current mode and its menu drives fit, real size, zoom steps and calibration', async t => {
  const ui = loadUi(measured)
  const h = await mount(ui, { onCloseWindow() {} })
  t.after(() => act(() => h.tree.unmount()))
  const text = () => h.scale().children.filter(child => typeof child === 'string').join('')
  assert.equal(h.mode(), 'physical'); assert.equal(text(), 'Real')
  assert.equal(h.menu().length, 0, 'closed until asked')
  await h.open()
  assert.equal(h.scale().props['aria-expanded'], true)
  const checked = () => h.tree.root.findAll(el => el.type === 'button' && el.props.role === 'menuitemradio' && el.props['aria-checked'] === true).map(el => el.children.join(''))
  assert.deepEqual(checked(), ['Tamanho real', '100%'])
  assert.ok(h.item('Calibrar tamanho real…'), 'calibration is offered only while real size is active')
  assert.equal(h.item('75%').props.disabled, false, 'physical mode allows shrinking')
  await h.choose('125%')
  assert.equal(h.menu().length, 0, 'choosing closes the menu')
  assert.equal(text(), '125%'); assert.equal(h.mode(), 'physical')
  await h.choose('Ajustar à janela')
  assert.equal(text(), 'Ajustar'); assert.equal(h.mode(), 'fit')
  await h.open()
  assert.deepEqual(checked(), ['Ajustar à janela', '100%'])
  assert.equal(h.item('75%').props.disabled, true, 'fit never shrinks below the window')
  assert.equal(h.item('Calibrar tamanho real…'), undefined)
  await h.choose('200%')
  assert.equal(text(), '200%'); assert.equal(h.mode(), 'fit')
  await h.choose('Tamanho real')
  assert.equal(text(), 'Real'); assert.equal(h.mode(), 'physical')
  assert.equal(h.tree.root.findAllByProps({ 'aria-label': 'Calibrar tamanho físico' }).length, 0)
  await h.choose('Calibrar tamanho real…')
  assert.ok(h.tree.root.findByProps({ 'aria-label': 'Calibrar tamanho físico' }), 'the ruler dialog opens from the menu')
  assert.equal(h.label('Início do dispositivo').props.disabled, true, 'calibration pauses device input')
  await h.open()
  await act(() => h.tree.root.findByProps({ role: 'menu' }).props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }))
  assert.equal(h.menu().length, 0, 'Escape closes the menu')
})

test('real size without a known model stays disabled and estimated scales are marked once zoomed', async t => {
  const ui = loadUi(estimated)
  const h = await mount(ui, { session: session({ displayProfileId: 'native' }), profileId: undefined, initialScaleMode: 'fit' })
  t.after(() => act(() => h.tree.unmount()))
  await h.open()
  assert.equal(h.item('Tamanho real').props.disabled, true)
  assert.match(h.item('Tamanho real').props.title, /Escolha um modelo/)
  assert.equal(ui.mobileScaleLabel({ zoom: 1.5, physicalActive: true, estimated: true }), '≈150%')
  assert.equal(ui.mobileScaleLabel({ zoom: 1, physicalActive: true, estimated: true }), 'Real')
  assert.equal(ui.mobileScaleLabel({ zoom: 1.25, physicalActive: false, estimated: true }), '125%')
  assert.equal(ui.mobileScaleLabel({ zoom: 1, physicalActive: false, estimated: false }), 'Ajustar')
})
