import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { rewriteGuiInlineImages, guiInlineImageState, hydrateGuiInlineImages } from '../src/renderer/src/guiInlineImageHtml.ts'

test('imagem grande vira cartão compacto com ação explícita e nome acessível', () => {
  const html = rewriteGuiInlineImages('<p><img src="shots/tall.png" alt="Mapa da jornada"></p>')
  assert.match(html, /aria-haspopup="dialog"/u)
  assert.match(html, /aria-label="Ver imagem: Mapa da jornada"/u)
  assert.match(html, /gui-md-image-caption/u)
  assert.match(html, /Ver imagem/u)
  assert.match(html, /Carregando imagem/u)
  assert.doesNotMatch(html, /\ssrc=/u, 'somente o canal autorizado pode resolver caminho local')
})

test('legenda e referência são escapadas e a reescrita preserva os blocos vizinhos', () => {
  const html = '<p>antes</p><p><img src="shots/a&amp;b.png" alt="A &quot;B&quot; &lt;C&gt;"></p><p>depois</p>'
  const rewritten = rewriteGuiInlineImages(html)
  assert.equal(rewriteGuiInlineImages(html), rewritten)
  assert.equal(rewriteGuiInlineImages(rewritten), rewritten)
  assert.ok(rewritten.startsWith('<p>antes</p>'))
  assert.ok(rewritten.endsWith('<p>depois</p>'))
  assert.match(rewritten, /aria-label="Ver imagem: A &quot;B&quot; &lt;C&gt;"/u)
})

test('CSS restringe miniatura e cartão mesmo para imagens verticais enormes', () => {
  const css = readFileSync(new URL('../src/renderer/src/components/GuiInlineImagePreview.css', import.meta.url), 'utf8')
  assert.match(css, /\.gui-md \.gui-md-image-open\s*\{[^}]*width: min\(320px, 100%\)/su)
  assert.match(css, /\.gui-md \.gui-md-image\s*\{[^}]*height: 64px/su)
  assert.match(css, /object-fit: contain/u)
  assert.match(css, /focus-visible/u)
  assert.match(css, /--accent-deep, #a84b27/u)
  assert.match(css, /100dvh - clamp\(24px, 6vw, 72px\) - 72px/u,
    'ajuste à tela desconta padding externo, cabeçalho e bordas')
  assert.match(css, /\.gui-attachment-lightbox \.gui-attachment-lightbox-body \{ min-height: 0; \}/u)
})

const bitmap = 'data:image/png;base64,iVBORw0KGgo='
test('fonte local aguarda capacidade; remoto/SVG recusam e bitmap embutido fica limitado', () => {
  const cache = new Map()
  assert.equal(guiInlineImageState('shots/tall.png', cache), undefined)
  cache.set('shots/tall.png', { status: 'ready', dataUrl: bitmap })
  assert.equal(guiInlineImageState('shots/tall.png', cache).dataUrl, bitmap)
  for (const source of ['https://example.invalid/a.png', '//example.invalid/a.png', 'data:image/svg+xml;base64,AAAA']) {
    assert.equal(guiInlineImageState(source, cache).status, 'refused')
  }
  for (const source of ['https://example.invalid/a.png', 'file:///unrelated.png', 'data:image/svg+xml;base64,AAAA']) {
    cache.set('injected.png', { status: 'ready', dataUrl: source })
    assert.equal(guiInlineImageState('injected.png', cache).status, 'refused')
  }
  assert.equal(guiInlineImageState(bitmap, cache).status, 'ready')
  assert.equal(guiInlineImageState(`data:image/png;base64,${'A'.repeat(5_600_000)}`, cache).status, 'refused')
})

test('hidratação deduplica referências pendentes e não reatribui src já resolvido', () => {
  function image(reference) {
    const attrs = new Map([['data-gui-image', reference]])
    const writes = []
    const frame = { setAttribute() {}, querySelector: () => ({ remove() {} }) }
    return { writes, getAttribute: name => attrs.get(name),
      setAttribute(name, value) { attrs.set(name, value); writes.push(name) }, closest: () => frame }
  }
  const nodes = [image('same.png'), image('same.png'), image('other.png')]
  const container = { ownerDocument: {}, querySelectorAll: () => nodes }
  const cache = new Map()
  assert.deepEqual(hydrateGuiInlineImages(container, cache), ['same.png', 'other.png'])
  cache.set('same.png', { status: 'ready', dataUrl: bitmap })
  assert.deepEqual(hydrateGuiInlineImages(container, cache), ['other.png'])
  hydrateGuiInlineImages(container, cache)
  assert.equal(nodes[0].writes.filter(name => name === 'src').length, 1)
  assert.equal(nodes[1].writes.filter(name => name === 'src').length, 1)
})

// Exercise the real preview hook/lightbox, with only the portal and browser
// surfaces replaced. No Electron app, external navigation, real files or IPC.
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const listeners = new Map()
const documentMock = { activeElement: null, body: { style: { overflow: 'auto' } } }
class FocusTarget {
  isConnected = true
  focus() { documentMock.activeElement = this }
  closest() { return null }
}
const closeTarget = new FocusTarget()
const otherTarget = new FocusTarget()
const dialog = new FocusTarget()
dialog.querySelectorAll = () => [otherTarget, closeTarget]
dialog.contains = target => [dialog, otherTarget, closeTarget].includes(target)
const windowMock = {
  setTimeout, clearTimeout, requestAnimationFrame: callback => callback(),
  addEventListener: (type, listener) => listeners.set(type, listener),
  removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type) }
}
const compiled = buildSync({
  stdin: { contents: "export { useGuiInlineImagePreview } from './src/renderer/src/components/GuiInlineImagePreview'; export { default as Lightbox } from './src/renderer/src/components/GuiAttachmentLightbox'", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
  external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty' }
})
const loaded = { exports: {} }
const require = createRequire(import.meta.url)
new Function('require', 'module', 'exports', 'window', 'document', 'HTMLElement', compiled.outputFiles[0].text)(
  name => name === 'react-dom' ? { createPortal: children => children } : require(name),
  loaded, loaded.exports, windowMock, documentMock, FocusTarget
)

test('clique abre loading, atualiza sem nova abertura, amplia e fecha com foco após streaming', async () => {
  const cache = { current: new Map() }
  const frame = new FocusTarget()
  frame.getAttribute = () => 'tall.png'
  frame.querySelector = () => ({ textContent: 'Mapa sintético' })
  const replacement = new FocusTarget()
  replacement.getAttribute = frame.getAttribute
  const container = { current: { querySelectorAll: () => [replacement] } }
  let controller, renderer, cancelled = 0, stopped = 0
  function Harness() {
    controller = loaded.exports.useGuiInlineImagePreview(container, cache)
    return controller.preview
  }
  await act(async () => { renderer = create(React.createElement(Harness), { createNodeMock: () => dialog }) })
  frame.focus()
  await act(async () => { controller.open(frame, { preventDefault: () => cancelled++, stopPropagation: () => stopped++ }) })
  assert.equal(cancelled, 1, 'não pode navegar o link ancestral da imagem')
  assert.equal(stopped, 1)
  assert.equal(renderer.root.findByProps({ role: 'dialog' }).props['aria-busy'], true)
  assert.equal(documentMock.body.style.overflow, 'hidden')
  cache.current.set('tall.png', { status: 'ready', dataUrl: bitmap })
  await act(async () => controller.refresh())
  assert.equal(renderer.root.findByType('img').props.src, bitmap)
  assert.equal(renderer.root.findByProps({ role: 'dialog' }).props['aria-busy'], false)
  const zoom = renderer.root.findAllByType('button').find(button => button.children.includes('Tamanho real'))
  assert.ok(zoom)
  assert.equal(renderer.root.findAllByType('button').some(button => button.children.includes('Baixar')), false)
  await act(async () => zoom.props.onClick())
  assert.equal(renderer.root.findAllByType('button').some(button => button.children.includes('Ajustar à tela')), true)
  frame.isConnected = false
  await act(async () => renderer.root.findByProps({ 'aria-label': 'Fechar prévia' }).props.onClick())
  assert.equal(renderer.toJSON(), null)
  assert.equal(documentMock.activeElement, replacement)
  assert.equal(documentMock.body.style.overflow, 'auto')
  await act(async () => renderer.unmount())
})

test('Escape/Tab mantêm foco; recusa e falha de decodificação ficam explícitas', async () => {
  const cache = { current: new Map([['bad.png', { status: 'ready', dataUrl: bitmap }]]) }
  const frame = new FocusTarget()
  frame.getAttribute = () => 'bad.png'
  frame.querySelector = () => ({ textContent: 'Imagem inválida' })
  const container = { current: { querySelectorAll: () => [frame] } }
  let controller, renderer
  function Harness() { controller = loaded.exports.useGuiInlineImagePreview(container, cache); return controller.preview }
  await act(async () => { renderer = create(React.createElement(Harness), { createNodeMock: () => dialog }) })
  frame.focus()
  await act(async () => controller.open(frame, { preventDefault() {}, stopPropagation() {} }))
  let prevented = 0
  closeTarget.focus()
  listeners.get('keydown')({ key: 'Tab', shiftKey: false, preventDefault: () => prevented++ })
  assert.equal(documentMock.activeElement, otherTarget)
  assert.equal(prevented, 1)
  await act(async () => renderer.root.findByType('img').props.onError())
  assert.match(renderer.root.findByProps({ role: 'alert' }).children.join(''), /Não foi possível abrir esta imagem/u)
  assert.equal(renderer.root.findAllByType('img').length, 0)
  await act(async () => listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }))
  assert.equal(renderer.toJSON(), null)
  assert.equal(documentMock.activeElement, frame)
  cache.current.set('bad.png', { status: 'refused', error: 'Arquivo ausente. Peça o caminho correto.' })
  await act(async () => controller.open(frame, { preventDefault() {}, stopPropagation() {} }))
  assert.match(renderer.root.findByProps({ role: 'alert' }).children.join(''), /Arquivo ausente/u)
  container.current.querySelectorAll = () => []
  await act(async () => controller.refresh())
  assert.equal(renderer.toJSON(), null, 'mensagem substituída não conserva imagem da mensagem anterior')
  await act(async () => renderer.unmount())
  assert.equal(listeners.has('keydown'), false)
})

test('lightbox compartilhada preserva download autorizado dos anexos enviados', async () => {
  let downloads = 0, renderer
  const props = { name: 'Anexo sintético', src: bitmap, loading: false, error: null,
    feedback: null, downloading: false, onClose() {}, onDownload: () => downloads++ }
  await act(async () => { renderer = create(React.createElement(loaded.exports.Lightbox, props), { createNodeMock: () => dialog }) })
  await act(async () => renderer.root.findAllByType('button').find(button => button.children.includes('Baixar')).props.onClick())
  assert.equal(downloads, 1)
  await act(async () => renderer.update(React.createElement(loaded.exports.Lightbox, { ...props, downloading: true })))
  assert.equal(renderer.root.findAllByType('button').find(button => button.children.includes('Baixando…')).props.disabled, true)
  await act(async () => renderer.unmount())
})
