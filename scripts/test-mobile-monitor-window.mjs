import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSync } from 'esbuild'

const built = buildSync({ entryPoints: ['src/main/mobileMonitorWindow.ts'], bundle: true, platform: 'node', format: 'cjs', write: false })
const loaded = { exports: {} }
new Function('module', 'exports', built.outputFiles[0].text)(loaded, loaded.exports)
const { createMobileMonitorReader } = loaded.exports
const display = () => ({ displayId: 7, displayBounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  scaleFactor: 1.5, centerPx: { x: 3840, y: 1080 } })
const row = () => ({ boundsPx: { x: 1920, y: 0, width: 3840, height: 2160 }, widthMm: 600, heightMm: 337.5,
  source: 'edid-detailed', confidence: 'reported' })

test('automatic scale binds exact physical monitor to owner display, preserving physical pixel units', async () => {
  const foreign = { ...row(), boundsPx: { x: 0, y: 0, width: 1920, height: 1080 }, widthMm: 500, heightMm: 281.25 }
  const read = createMobileMonitorReader({ current: display, read: async () => [foreign, row()] })
  assert.deepEqual(await read(), { physicalPixelsPerMm: 6.4, source: 'edid-detailed', displayId: 7,
    displayBounds: display().displayBounds, scaleFactor: 1.5 })
})

test('resolution without physical metadata, ambiguous mapping and inconsistent dimensions never imply inches', async () => {
  for (const rows of [[], [row(), row()], [{ ...row(), widthMm: 0 }], [{ ...row(), widthMm: NaN }],
    [{ ...row(), heightMm: 100 }], [{ ...row(), source: 'guessed' }],
    [{ ...row(), boundsPx: { ...row().boundsPx, width: 1920 } }]]) {
    assert.equal(await createMobileMonitorReader({ current: display, read: async () => rows })(), null)
  }
})

test('rotated physical monitor uses already oriented metadata and exposes only sanitized fields', async () => {
  const rotated = { ...row(), boundsPx: { x: -2160, y: 0, width: 2160, height: 3840 }, widthMm: 337.5, heightMm: 600, privateIdentity: 'do-not-expose' }
  const current = () => ({ displayId: 9, displayBounds: { x: -1440, y: 0, width: 1440, height: 2560 }, scaleFactor: 1.5, centerPx: { x: -1080, y: 1920 } })
  const result = await createMobileMonitorReader({ current, read: async () => [rotated] })()
  assert.equal(result.physicalPixelsPerMm, 6.4)
  assert.equal(JSON.stringify(result).includes('do-not-expose'), false)
})

test('window moving monitors during discovery discards the old result', async () => {
  let current = display(), finish
  const pending = createMobileMonitorReader({ current: () => current, read: () => new Promise(resolve => { finish = resolve }) })()
  current = { ...current, displayId: 12 }
  finish([row()])
  assert.equal(await pending, null)
})

test('missing window, lookup failure, and display removal degrade to optional estimate', async () => {
  let reads = 0
  assert.equal(await createMobileMonitorReader({ current: () => null, read: async () => { reads++; return [] } })(), null)
  assert.equal(reads, 0)
  assert.equal(await createMobileMonitorReader({ current: display, read: async () => { throw new Error('private-native-error') } })(), null)
  let count = 0
  assert.equal(await createMobileMonitorReader({ current: () => ++count === 1 ? display() : null, read: async () => [row()] })(), null)
})

test('centimetre EDID metadata retains estimated provenance', async () => {
  const result = await createMobileMonitorReader({ current: display, read: async () => [{ ...row(), source: 'edid-basic', confidence: 'estimated' }] })()
  assert.equal(result.source, 'edid-basic')
})
