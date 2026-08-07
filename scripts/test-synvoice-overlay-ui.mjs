import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  SYNVOICE_OVERLAY_HEIGHT,
  SYNVOICE_OVERLAY_HISTORY_HEIGHT,
  SYNVOICE_OVERLAY_WIDTH,
  synVoiceOverlayCompactPosition,
  synVoiceOverlayHistoryPlacement
} from '../src/main/synVoiceOverlayWindow.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const css = readFileSync(root + '/src/renderer/src/global.css', 'utf8')
const overlay = readFileSync(root + '/src/renderer/src/components/SynVoiceOverlay.tsx', 'utf8')
const titlebarVoice = readFileSync(root + '/src/renderer/src/components/SynVoice.tsx', 'utf8')
const devMock = readFileSync(root + '/src/renderer/src/devMock.ts', 'utf8')
const main = readFileSync(root + '/src/main/index.ts', 'utf8')

function cssRule(selector) {
  const start = css.indexOf(selector)
  assert.ok(start >= 0, `missing CSS selector: ${selector}`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  assert.ok(open >= 0 && close > open, `invalid CSS rule: ${selector}`)
  return css.slice(open + 1, close)
}

test('compact overlay reserves one bounded row for each of its three actions', () => {
  assert.equal(SYNVOICE_OVERLAY_WIDTH, 255)
  assert.equal(SYNVOICE_OVERLAY_HEIGHT, 72)
  assert.equal(
    overlay.match(/className="synvoice-overlay-action synvoice-overlay-no-drag/g)?.length,
    3
  )

  const shell = cssRule('.synvoice-overlay-shell {')
  const actions = cssRule('.synvoice-overlay-actions {')
  const action = cssRule('.synvoice-overlay-action {')
  assert.match(shell, /height:\s*68px/)
  assert.match(shell, /padding:\s*6px/)
  assert.match(actions, /height:\s*100%/)
  assert.match(actions, /grid-template-rows:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(actions, /overflow:\s*hidden/)
  assert.match(action, /width:\s*100%/)
  assert.match(action, /min-width:\s*0/)
  assert.match(action, /min-height:\s*0/)
  assert.match(overlay, /function SynVoiceHistoryIcon\(\)/)
  assert.doesNotMatch(overlay, />\s*↺\s*</)
})

test('recording preserves the compact optical grid instead of shifting content', () => {
  const baseMain = cssRule('.synvoice-overlay-main {')
  const recordingMain = cssRule('.synvoice-overlay-shell.recording .synvoice-overlay-main {')
  const recordingIcon = cssRule('.synvoice-overlay-shell.recording .synvoice-overlay-main-icon {')
  const level = cssRule('.synvoice-overlay-level {')

  assert.match(baseMain, /gap:\s*8px/)
  assert.match(baseMain, /padding:\s*4px 6px/)
  assert.match(recordingMain, /gap:\s*8px/)
  assert.match(recordingMain, /padding:\s*4px 6px/)
  assert.match(recordingIcon, /width:\s*34px/)
  assert.match(recordingIcon, /height:\s*34px/)
  assert.match(level, /min-width:\s*68px/)
  assert.match(level, /height:\s*34px/)
})

test('header and detached settings use the same tune icon', () => {
  assert.match(titlebarVoice, /<TitleBarIcon name="tune" size=\{15\} \/>/)
  assert.match(
    overlay,
    /<TitleBarIcon name="tune" size=\{14\} className="synvoice-overlay-action-icon" \/>/
  )
  assert.doesNotMatch(overlay, /SettingsIcon/)
})

test('history keeps fixed-height rows and truncates long speech without changing copied text', () => {
  const history = cssRule('.synvoice-overlay-history {')
  const item = cssRule('.synvoice-overlay-history .synvoice-history-item {')
  const text = cssRule('.synvoice-overlay-history .synvoice-history-item span {')

  assert.equal(SYNVOICE_OVERLAY_HISTORY_HEIGHT, 264)
  assert.match(history, /height:\s*calc\(100vh - 74px\)/)
  assert.match(history, /grid-auto-rows:\s*max-content/)
  assert.match(history, /overflow-y:\s*auto/)
  assert.match(history, /scrollbar-gutter:\s*stable/)
  assert.match(item, /grid-template-columns:\s*minmax\(0,\s*1fr\) auto/)
  assert.match(text, /overflow:\s*hidden/)
  assert.match(text, /text-overflow:\s*ellipsis/)
  assert.match(text, /white-space:\s*nowrap/)
  assert.match(overlay, /historyCopy\?\.\(index\)/)
  assert.match(overlay, /<span>\{entry\.text\}<\/span>/)
  assert.match(devMock, /voiceScenario === 'history'/)
  assert.match(devMock, /SynkoraSuperLongWordWithoutNaturalBreaksNeedsToStayInsideTheCardAtEveryWidth/)
})

test('history has complete loading, error, copied, keyboard and focus states', () => {
  assert.match(overlay, /aria-busy=\{historyLoading\}/)
  assert.match(overlay, /carregando falas…/)
  assert.match(overlay, /não foi possível carregar as falas/)
  assert.match(overlay, /aria-live="polite"/)
  assert.match(overlay, /event\.key !== 'Escape'/)
  assert.match(overlay, /historyTriggerRef\.current\?\.focus\(\)/)
  assert.match(overlay, /closeHistory\(\)[\s\S]{0,100}command\('open-settings'\)/)
  assert.match(css, /\.synvoice-overlay-history button:focus-visible/)
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*?\.synvoice-overlay-history button:focus-visible/)
})

test('history expansion restores the compact anchor after opening above the taskbar', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 }
  assert.deepEqual(
    synVoiceOverlayHistoryPlacement(1500, 120, area),
    { x: 1500, y: 120, offsetY: 0 }
  )

  const raised = synVoiceOverlayHistoryPlacement(1500, 970, area)
  assert.deepEqual(raised, { x: 1500, y: 776, offsetY: -194 })
  assert.deepEqual(
    synVoiceOverlayCompactPosition(raised.x, raised.y, raised.offsetY),
    { x: 1500, y: 970 }
  )
  assert.deepEqual(
    synVoiceOverlayCompactPosition(1460, raised.y - 30, raised.offsetY),
    { x: 1460, y: 940 }
  )

  assert.match(main, /setSynVoiceOverlayHistoryOpen\(false\)[\s\S]{0,180}voice:overlay-state-changed/)
  assert.match(main, /const compactPosition = synVoiceOverlayHistoryOpen[\s\S]{0,180}synVoiceOverlayCompactPosition/)
})
