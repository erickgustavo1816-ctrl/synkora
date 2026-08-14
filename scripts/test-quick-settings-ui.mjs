import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')

test('quick settings is a portalized, accessible drawer with a real focus trap', () => {
  const panel = read('src/renderer/src/components/QuickSettingsPanel.tsx')

  assert.match(panel, /createPortal\(/u)
  assert.match(panel, /role="dialog"/u)
  assert.match(panel, /aria-modal="true"/u)
  assert.match(panel, /aria-labelledby="quick-settings-title"/u)
  assert.match(panel, /event\.key === 'Escape'/u)
  assert.match(panel, /event\.key !== 'Tab'/u)
  assert.match(panel, /event\.shiftKey && active === first/u)
  assert.match(panel, /!event\.shiftKey && active === last/u)
  assert.match(panel, /returnFocusRef/u)
  assert.match(panel, /target\.focus\(\)/u)
})

test('quick settings exposes only canonical chat notice preferences', () => {
  const panel = read('src/renderer/src/components/QuickSettingsPanel.tsx')
  const notices = read('src/renderer/src/components/ChatNoticeSettings.tsx')
  const canonical = [
    'chatNotifyNeedsYou',
    'chatNotifyFinished',
    'chatNotifyFailed',
    'chatSoundsEnabled'
  ]

  for (const key of canonical) assert.match(notices, new RegExp(key, 'u'))
  assert.match(panel, /WINDOWS_CHOICES/u)
  assert.match(panel, /CHAT_SOUND_CHOICE/u)
  assert.match(panel, /patchSettings\(/u)
  assert.doesNotMatch(panel, /\btheme\b/iu)
  assert.doesNotMatch(panel, /terminalFont/u)
  assert.doesNotMatch(panel, /AppearanceSettings/u)
})

test('the host owns the drawer overlay and Panes keeps the existing settings relay', () => {
  const titlebar = read('src/renderer/src/components/TitleBar.tsx')
  const app = read('src/renderer/src/App.tsx')
  const panesApp = read('src/renderer/src/PanesApp.tsx')

  assert.match(titlebar, /QuickSettingsPanel/u)
  assert.match(titlebar, /aria-controls="quick-settings-panel"/u)
  assert.match(titlebar, /if \(!open && !cliOpen && !quickOpen\) return/u)
  assert.match(titlebar, /bumpHostOverlay\(1\)/u)
  assert.match(app, /panesViewVisibleRect\(st\)/u)
  assert.match(app, /window\.synkora\.panesView\.layout\(\{ visible: false/u)
  assert.match(panesApp, /window\.synkora\.settings\.onChanged/u)
  assert.match(panesApp, /useStore\.getState\(\)\.loadSettings\(\)/u)
})

test('drawer remains bounded and usable in a narrow window', () => {
  const css = read('src/renderer/src/global.css')

  assert.match(css, /\.quick-settings-layer\s*\{[\s\S]*?position:\s*fixed/u)
  assert.match(css, /\.quick-settings-panel\s*\{[\s\S]*?width:\s*min\(360px/u)
  assert.match(css, /\.quick-settings-body\s*\{[\s\S]*?overflow-y:\s*auto/u)
  assert.match(css, /@media \(max-width: 390px\)[\s\S]*?\.quick-settings-panel/u)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.quick-settings-panel/u)
})
