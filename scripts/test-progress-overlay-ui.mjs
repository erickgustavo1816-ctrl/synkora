import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  PROGRESS_OVERLAY_DEFAULT_HEIGHT,
  PROGRESS_OVERLAY_DEFAULT_WIDTH,
  PROGRESS_OVERLAY_MIN_HEIGHT,
  PROGRESS_OVERLAY_MIN_WIDTH,
  progressOverlayExpandedSize,
  progressOverlayMaximumSize
} from '../src/main/progressOverlayWindow.ts'
import {
  SYNVOICE_OVERLAY_HEIGHT,
  SYNVOICE_OVERLAY_WIDTH,
  synVoiceOverlaySize
} from '../src/main/synVoiceOverlayWindow.ts'
import { progressCompletionFeed } from '../src/renderer/src/progressHistory.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const main = readFileSync(root + '/src/main/index.ts', 'utf8')
// Fase 1 moveu os handlers progress:* para ipc/progress.ts — as âncoras do
// IPC autenticado moram lá agora (re-apontadas na Fase 3, mesma classe do
// re-aponte do bundled-skills).
const progressIpc = readFileSync(root + '/src/main/ipc/progress.ts', 'utf8')
const preload = readFileSync(root + '/src/preload/index.ts', 'utf8')
const overlay = readFileSync(root + '/src/renderer/src/components/ProgressOverlay.tsx', 'utf8')
const voiceOverlay = readFileSync(root + '/src/renderer/src/components/SynVoiceOverlay.tsx', 'utf8')
const rendererMain = readFileSync(root + '/src/renderer/src/main.tsx', 'utf8')
const css = readFileSync(root + '/src/renderer/src/global.css', 'utf8')
const overlayCss = readFileSync(root + '/src/renderer/src/components/progressOverlay.css', 'utf8')
const voiceWindow = main.slice(
  main.indexOf('function createSynVoiceOverlay'),
  main.indexOf('function toggleSynVoiceOverlay')
)
const voiceTooltip = main.slice(
  main.indexOf('async function showSynVoiceOverlayTooltip'),
  main.indexOf('function createSynVoiceNoticeWindow')
)

function mission(id, completedAt) {
  return {
    id,
    projectId: 'project-1',
    title: id,
    state: 'completed',
    tone: 'success',
    label: 'concluída',
    updatedAt: completedAt,
    completedAt
  }
}

function snapshot(completions) {
  return {
    revision: 1,
    generatedAt: '2026-08-03T12:10:00.000Z',
    totals: {
      projects: 1,
      activeProjects: 0,
      activeMissions: 0,
      activeCoordinators: 0,
      attentionMissions: 0,
      attentionProjects: 0,
      recentCompletions: completions.length
    },
    projects: [{
      id: 'project-1',
      name: 'Projeto',
      mode: 'existing',
      missing: false,
      state: 'idle',
      tone: 'idle',
      label: 'sem atividade',
      coordinators: [],
      activeMissions: [],
      recentCompletions: completions
    }]
  }
}

test('expanded size keeps custom bounds and clamps unsafe values', () => {
  assert.deepEqual(
    progressOverlayExpandedSize(undefined, undefined, 1920, 1080),
    { width: PROGRESS_OVERLAY_DEFAULT_WIDTH, height: PROGRESS_OVERLAY_DEFAULT_HEIGHT }
  )
  assert.deepEqual(
    progressOverlayExpandedSize(720, 810, 1920, 1080),
    { width: 720, height: 810 }
  )
  assert.deepEqual(
    progressOverlayExpandedSize(10, 20, 1920, 1080),
    { width: PROGRESS_OVERLAY_MIN_WIDTH, height: PROGRESS_OVERLAY_MIN_HEIGHT }
  )
  assert.deepEqual(
    progressOverlayExpandedSize(4000, 3000, 1280, 720),
    { width: 1244, height: 684 }
  )
  assert.deepEqual(
    progressOverlayMaximumSize(1280, 720),
    { width: 1244, height: 684 }
  )
})

test('SynVoice keeps the fixed compact size chosen by the user', () => {
  assert.deepEqual(
    synVoiceOverlaySize(),
    { width: SYNVOICE_OVERLAY_WIDTH, height: SYNVOICE_OVERLAY_HEIGHT }
  )
})

test('SynVoice restores its position and ignores legacy saved sizes', () => {
  assert.match(main, /interface SynVoiceOverlayPreferences\s*\{[\s\S]*?width\?: number[\s\S]*?height\?: number/)
  assert.match(main, /synvoice-overlay-position\.json/)
  assert.match(main, /loadJsonStore\([\s\S]*?synVoiceOverlayPreferencesFile/)
  assert.match(main, /persistJsonStore\(synVoiceOverlayPreferencesFile\(\), synVoiceOverlayPreferences\)/)
  assert.match(voiceWindow, /const preferences = loadSynVoiceOverlayPreferences\(\)/)
  assert.match(voiceWindow, /\.\.\.preferences/)
  assert.match(voiceWindow, /transparent:\s*true/)
  assert.match(voiceWindow, /thickFrame:\s*false/)
  assert.match(voiceWindow, /resizable:\s*false/)
  assert.match(voiceWindow, /win\.on\('move'/)
  assert.doesNotMatch(voiceWindow, /win\.on\('resize'/)
  assert.doesNotMatch(voiceWindow, /win\.on\('will-resize'/)
  assert.match(voiceWindow, /win\.on\('hide',[\s\S]*?persistBounds\(\)/)
  assert.match(voiceWindow, /win\.on\('close',[\s\S]*?persistBounds\(\)/)
  assert.match(main, /synVoiceOverlayBoundsFlush\?\.\(\)/)
  assert.match(main, /synVoiceOverlayWindow\.getContentBounds\(\)/)
  assert.match(voiceTooltip, /const contentBounds = overlay\.getContentBounds\(\)/)
  assert.match(voiceTooltip, /anchorCenterX = contentBounds\.x/)
  assert.match(voiceTooltip, /const place = belowY <= maxY \|\| aboveY < minY \? 'bottom' : 'top'/)
  assert.match(voiceTooltip, /anchorCenterX - x - 7, popupWidth - 10/)
  assert.doesNotMatch(voiceTooltip, /overlay\.setPosition/)
  assert.match(main, /#popup\[data-place="top"\]:before/)
})

test('both floating windows share one readable typographic scale', () => {
  assert.match(css, /--floating-overlay-title-size:\s*14px/)
  assert.match(css, /--floating-overlay-subtitle-size:\s*12px/)
  assert.match(css, /\.synvoice-overlay-copy strong\s*\{[\s\S]*?var\(--floating-overlay-title-size\)/)
  assert.match(css, /\.synvoice-overlay-copy small\s*\{[\s\S]*?var\(--floating-overlay-subtitle-size\)/)
  assert.match(overlayCss, /\.progress-overlay-heading strong\s*\{[\s\S]*?var\(--floating-overlay-title-size, 14px\)/)
  assert.match(overlayCss, /\.progress-overlay-heading small\s*\{[\s\S]*?var\(--floating-overlay-subtitle-size, 12px\)/)
  assert.doesNotMatch(css, /\.synvoice-overlay-copy small\s*\{[\s\S]{0,180}?font-size:\s*7\.5px/)
  assert.match(voiceOverlay, /SynkoraMark size=\{15\}/)
  assert.ok(voiceOverlay.includes('if (mouse) return `MOUSE ${mouse[1]}`'))
  assert.match(voiceOverlay, /\(isRecording \|\| subtitle\) &&/)
  assert.match(voiceOverlay, /data-tip=\{presentation\.actionLabel\}/)
  assert.match(rendererMain, /<SynVoiceOverlay \/>[\s\S]*?<TooltipLayer \/>/)
  assert.match(css, /\.synvoice-overlay-shell button:focus-visible[\s\S]*?outline:/)
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*?\.synvoice-overlay-shell button:focus-visible/)
})

test('Andamento keeps readable text at narrow and compact sizes', () => {
  const rule = (selector) => overlayCss.slice(overlayCss.indexOf(selector)).split('{')[1].split('}')[0]
  for (const size of overlayCss.matchAll(/font-size:\s*([\d.]+)px/g)) {
    assert.ok(Number(size[1]) >= 11, `text must never fall below 11px: ${size[0]}`)
  }
  assert.match(rule('.progress-mission-title {'), /font-size:\s*14px/)
  assert.match(rule('.progress-mission-detail {'), /font-size:\s*12px/)
  assert.match(rule('.progress-filters {'), /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)
  assert.match(rule('.progress-overlay-foot {'), /flex-wrap:\s*wrap/)
  assert.match(rule('.progress-compact-focus strong {'), /font-size:\s*14px/)
  assert.match(rule('.progress-compact-focus > span:first-child {'), /gap:\s*2px/)
  const shortWindow = overlayCss.slice(overlayCss.indexOf('@media (max-height: 340px)'))
  assert.match(shortWindow, /\.progress-filters\s*\{[^}]*grid-auto-flow:\s*column;[^}]*grid-auto-columns:\s*176px;[^}]*overflow-x:\s*auto/)
  assert.match(shortWindow, /\.progress-filter\s*\{[^}]*flex-direction:\s*row/)
})

test('completion feed stays bounded and reports hidden entries', () => {
  const feed = progressCompletionFeed(snapshot([
    mission('one', '2026-08-03T12:01:00.000Z'),
    mission('four', '2026-08-03T12:04:00.000Z'),
    mission('two', '2026-08-03T12:02:00.000Z'),
    mission('three', '2026-08-03T12:03:00.000Z')
  ]), null, 3)

  assert.deepEqual(feed.items.map(({ mission: item }) => item.id), ['four', 'three', 'two'])
  assert.equal(feed.hiddenCount, 1)
})

test('clearing is a visual watermark and later completions return', () => {
  const data = snapshot([
    mission('before', '2026-08-03T12:02:00.000Z'),
    mission('at-cutoff', '2026-08-03T12:05:00.000Z'),
    mission('after', '2026-08-03T12:06:00.000Z')
  ])
  const feed = progressCompletionFeed(data, '2026-08-03T12:05:00.000Z', 3)

  assert.deepEqual(feed.items.map(({ mission: item }) => item.id), ['after'])
  assert.equal(feed.hiddenCount, 0)
})

test('a completion created after the visible snapshot is never cleared unseen', () => {
  const visibleSnapshot = snapshot([
    mission('seen', '2026-08-03T12:08:00.000Z')
  ])
  const nextSnapshot = snapshot([
    mission('seen', '2026-08-03T12:08:00.000Z'),
    mission('arrived-during-click', '2026-08-03T12:10:01.000Z')
  ])
  const feed = progressCompletionFeed(
    nextSnapshot,
    visibleSnapshot.generatedAt,
    3
  )

  assert.deepEqual(
    feed.items.map(({ mission: item }) => item.id),
    ['arrived-during-click']
  )
})

test('main preserves expanded bounds and exposes only authenticated history IPC', () => {
  assert.match(main, /resizable:\s*!preferences\.compact/)
  assert.match(main, /transparent:\s*true/)
  assert.match(main, /thickFrame:\s*false/)
  assert.match(main, /maxWidth:\s*maximumSize\.width/)
  assert.match(main, /maxHeight:\s*maximumSize\.height/)
  assert.match(main, /win\.on\('resize', scheduleBoundsPersist\)/)
  assert.match(main, /win\.on\('will-resize',[\s\S]*?event\.preventDefault\(\)/)
  assert.match(main, /win\.on\('close',[\s\S]*?persistBounds\(\)/)
  assert.match(main, /progressOverlayBoundsFlush\?\.\(\)/)
  assert.match(main, /function hideProgressOverlay\(\): void \{\s*progressOverlayBoundsFlush\?\.\(\)/)
  assert.match(main, /!current\.compact \? \{ width, height \} : \{\}/)
  assert.match(progressIpc, /assertProgressOverlaySender\(event\)[\s\S]*?'clear-history'/)
  assert.match(progressIpc, /historyClearedAt:\s*clearedAt/)
  assert.match(progressIpc, /const clearedAt = state\.latestProgressSnapshot\.generatedAt/)
  assert.match(overlay, /setHistoryClearedAt\(snapshot\.generatedAt\)/)
  assert.match(
    overlay,
    /aria-label="Ocultar o histórico concluído desta janela — as missões não serão apagadas"/
  )
  assert.match(preload, /\| 'clear-history'/)
  assert.match(preload, /progress:overlay-history-changed/)
  assert.doesNotMatch(
    progressIpc,
    /input\.command === 'clear-history'[\s\S]{0,600}missions\.(remove|update)/
  )
})

test('empty and wide layouts adapt without manufacturing overflow', () => {
  assert.match(overlay, /progress-overlay-body.*is-empty/)
  assert.match(overlay, /className="progress-project-grid"/)
  assert.match(overlayCss, /\.progress-empty\s*\{[\s\S]*?min-height:\s*0;/)
  assert.match(
    overlayCss,
    /\.progress-overlay-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overflow-x:\s*hidden;/
  )
  assert.match(overlayCss, /@media \(min-width:\s*760px\)[\s\S]*?repeat\(auto-fit,/)
  assert.match(overlayCss, /\.progress-project-grid\s*\{[\s\S]*?align-items:\s*start;/)
  assert.match(overlayCss, /\.progress-overlay-shell button:focus-visible[\s\S]*?outline:/)
  assert.match(overlayCss, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(overlayCss, /\.progress-overlay-head\s*\{[^}]*-webkit-app-region: drag;/)
  assert.match(overlayCss, /radial-gradient\(circle at 11% 0%, rgba\(217, 108, 63, 0\.12\), transparent 34%\)/)
  assert.match(overlayCss, /rgba\(34, 32, 28, 0\.985\)/)
  assert.doesNotMatch(overlay, /CoordinatorActivity|QuestionLine|mission\.question|project\.question/)
  assert.match(overlay, /setHistoryNotice\('Histórico ocultado\. Nenhuma missão foi apagada\.'\)/)
  assert.match(overlay, /window\.requestAnimationFrame\(\(\) => openMainButtonRef\.current\?\.focus\(\)\)/)
  assert.match(overlay, /className="progress-overlay-live" role="status" aria-live="polite"/)
})
