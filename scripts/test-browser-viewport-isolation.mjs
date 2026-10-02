import assert from 'node:assert/strict'
import test from 'node:test'
import { applyViewportFit, viewportInputParams, viewportCaptureRect } from '../src/main/browserViewportFit.ts'

function pages() {
  let hostZoom = 1
  const create = () => ({
    emulation: null,
    getURL: () => 'https://synthetic.test/',
    getZoomFactor: () => hostZoom,
    setZoomFactor(factor) { hostZoom = factor },
    enableDeviceEmulation(parameters) { this.emulation = parameters },
    disableDeviceEmulation() { this.emulation = null },
    get innerWidth() { return (this.emulation?.viewSize.width ?? 400) / hostZoom }
  })
  return [create(), create()]
}

test('same-origin agent tabs retain independent effective widths', () => {
  const [dev, helper] = pages()
  applyViewportFit(dev, 1280, 400, 600)
  applyViewportFit(helper, 768, 400, 600)
  assert.equal(dev.innerWidth, 1280)
  assert.equal(helper.innerWidth, 768)
  applyViewportFit(helper, 375, 400, 600)
  assert.equal(dev.innerWidth, 1280)
  assert.equal(helper.emulation?.viewSize.width, 375)
})

test('AUTO on one tab preserves another tab viewport', () => {
  const [dev, helper] = pages()
  applyViewportFit(dev, 1280, 400, 600)
  applyViewportFit(helper, 'auto', 400, 600)
  assert.equal(dev.innerWidth, 1280)
  assert.equal(helper.innerWidth, 400)
  applyViewportFit(dev, 'auto', 400, 600)
  assert.equal(dev.emulation, null)
  assert.equal(dev.innerWidth, 400)
})

test('agent pointer and selector capture use the tab fitting scale', () => {
  const [dev, helper] = pages()
  applyViewportFit(dev, 1280, 400, 600)
  applyViewportFit(helper, 375, 400, 600)
  assert.deepEqual(viewportInputParams(dev, { type: 'mouseWheel', x: 960, y: 640, deltaX: 0, deltaY: 320 }),
    { type: 'mouseWheel', x: 300, y: 200, deltaX: 0, deltaY: 100 })
  assert.deepEqual(viewportCaptureRect(dev, { x: 896, y: 512, width: 160, height: 96 }),
    { x: 280, y: 160, width: 50, height: 30 })
  assert.deepEqual(viewportInputParams(helper, { x: 300, y: 200 }), { x: 300, y: 200 })
  assert.equal(viewportCaptureRect(dev), undefined)
})

test('AUTO on a new page does not disable a renderer that has not initialized', () => {
  const [page] = pages()
  let disabled = 0
  page.disableDeviceEmulation = () => { disabled++ }
  applyViewportFit(page, 'auto', 400, 600)
  assert.equal(disabled, 0)
})

test('a requested width waits for the first navigation before touching native emulation', () => {
  const [page] = pages()
  page.getURL = () => ''
  applyViewportFit(page, 1280, 400, 600)
  assert.equal(page.emulation, null)
  page.getURL = () => 'https://synthetic.test/'
  applyViewportFit(page, 1280, 400, 600)
  assert.equal(page.innerWidth, 1280)
})
