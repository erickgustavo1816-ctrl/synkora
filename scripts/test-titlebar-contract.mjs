import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { cliStatusSummary } from '../src/renderer/src/cliState.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
const titleBar = readFileSync(`${root}/src/renderer/src/components/TitleBar.tsx`, 'utf8')
const voice = readFileSync(`${root}/src/renderer/src/components/SynVoice.tsx`, 'utf8')
const css = readFileSync(`${root}/src/renderer/src/global.css`, 'utf8')

test('central identity is anchored to the Windows-safe titlebar area', () => {
  const innerStart = titleBar.indexOf('<div className="titlebar-inner">')
  const titleStart = titleBar.indexOf('<span className="tb-title"')
  const trailingStart = titleBar.indexOf('<div className="tb-trailing">')

  assert.ok(innerStart >= 0)
  assert.ok(titleStart > innerStart)
  assert.ok(trailingStart > innerStart)
  assert.match(css, /\.titlebar-inner\s*{[\s\S]*?width:\s*env\(titlebar-area-width, 100%\);/)
  assert.match(css, /\.tb-title\s*{[\s\S]*?left:\s*50%;/)
  assert.match(css, /@media \(max-width:\s*700px\)\s*{[\s\S]*?\.tb-title\s*{[\s\S]*?display:\s*none;/)
})

test('settings stays beside back and every titlebar action keeps one hitbox', () => {
  const leadingStart = titleBar.indexOf('<div className="tb-leading">')
  const settingsStart = titleBar.indexOf('className={`tb-btn tb-icon-btn tb-global-settings')
  const trailingStart = titleBar.indexOf('<div className="tb-trailing">')

  assert.ok(leadingStart >= 0)
  assert.ok(settingsStart > leadingStart)
  assert.ok(settingsStart < trailingStart)
  assert.equal(titleBar.match(/tb-global-settings/g)?.length, 1)
  assert.match(css, /\.tb-btn\s*{[\s\S]*?width:\s*28px;[\s\S]*?height:\s*28px;/)
})

test('icon-only controls preserve names, menu state and exclusive popovers', () => {
  for (const label of [
    'Voltar para a Home',
    'Abrir configurações globais do Synkora',
    'Ver versões e detalhes',
    'Ver limites de uso das contas'
  ]) {
    assert.ok(titleBar.includes(label), `missing accessible label: ${label}`)
  }

  assert.match(titleBar, /if \(next\) setOpen\(false\)/)
  assert.match(titleBar, /if \(next\) setCliOpen\(false\)/)
  assert.match(titleBar, /event\.key !== 'Escape'/)
  assert.match(titleBar, /aria-current=\{inSettings \? 'page' : undefined\}/)
  assert.match(titleBar, /focusPopoverContent\(usageDialogRef\.current\)/)
  assert.match(titleBar, /focusPopoverContent\(cliDialogRef\.current\)/)
  assert.match(titleBar, /window\.requestAnimationFrame\(\(\) => trigger\?\.focus\(\)\)/)
  assert.match(titleBar, /ref=\{cliTriggerRef\}[\s\S]{0,180}tb-cli-trigger/)
  assert.match(titleBar, /ref=\{usageTriggerRef\}[\s\S]{0,180}tb-limits-trigger/)
  assert.equal(titleBar.match(/tabIndex=\{-1\}/g)?.length, 2)
})

test('o avatar central troca a foto e sobrevive à barra arrastável', () => {
  // 2026-08-15: o rodapé de identidade do ✦ geral morreu e a alavanca da foto
  // subiu para cá. O avatar era um `<i>` inerte.
  assert.match(titleBar, /<button\s+type="button"\s+className="tb-title-avatar"/u)
  assert.match(titleBar, /aria-label=\{`Trocar a foto do universo \$\{project\.name\}`\}/u)
  assert.match(titleBar, /data-tip="Trocar a foto do universo"/u)
  assert.match(titleBar, /onClick=\{\(\) => openProjectId && void setProjectPhoto\(openProjectId\)\}/u)
  assert.doesNotMatch(titleBar, /<i\s+className="tb-title-avatar"/u)

  // AS DUAS CERCAS QUE FALHAM EM SILÊNCIO: `.tb-title` é `pointer-events: none`
  // e `-webkit-app-region: drag`, então sem os dois opt-outs no próprio avatar
  // o botão nasce mudo (ou o Windows come o mousedown) — e nada na tela avisa.
  const avatar = css.match(/\n\.tb-title-avatar \{([\s\S]*?)\n\}/u)?.[1]
  assert.ok(avatar, 'a regra do avatar precisa existir')
  assert.match(avatar, /pointer-events:\s*auto;/u)
  assert.match(avatar, /-webkit-app-region:\s*no-drag;/u)
  assert.match(avatar, /padding:\s*0;/u)
  assert.match(avatar, /cursor:\s*pointer;/u)
  assert.match(css, /\.tb-title-avatar:focus-visible\s*\{[\s\S]*?outline:/u)
  // O PAI continua sendo a alça de arrasto — mover a barra não pode virar
  // refém de um botão de 18px.
  assert.match(css, /\.tb-title\s*\{[\s\S]*?pointer-events:\s*none;[\s\S]*?-webkit-app-region:\s*drag;/u)
})

test('SynVoice expands only while recording and keeps contextual tooltips', () => {
  assert.match(voice, /data-tip=\{triggerTip\}/)
  assert.match(voice, /data-tip="Abrir o mini SynVoice em uma janela separada"/)
  assert.match(voice, /data-tip="Configurar microfone, atalho e transcrição do SynVoice"/)
  assert.match(
    css,
    /\.synvoice-title-control\.recording \.synvoice-trigger\s*{[\s\S]*?width:\s*52px;/
  )
  assert.ok(!css.includes('@media (max-width: 1220px) {\n  .synvoice-detach-trigger'))
  assert.match(css, /\.tb-action-group-voice:has\(\.synvoice-title-control\.detached\)/)
})

test('CLI summary never calls unknown or broken installations healthy', () => {
  const status = (state) => ({ cli: 'codex', version: null, state, checkedAt: 0 })

  assert.deepEqual(cliStatusSummary([]), { label: 'Verificando CLIs', tone: 'checking' })
  assert.equal(cliStatusSummary([status('unknown')]).tone, 'checking')
  assert.equal(cliStatusSummary([status('current')]).tone, 'current')
  assert.equal(cliStatusSummary([status('updated')]).tone, 'fresh')
  assert.equal(cliStatusSummary([status('updating')]).tone, 'updating')
  assert.equal(
    cliStatusSummary([status('updating'), status('failed')]).tone,
    'trouble'
  )
  assert.match(titleBar, /const cliVisualClass =\s*\n?\s*cliSummary\.tone/)
  assert.match(titleBar, /const cliDotClassName =\s*\n?\s*cliSummary\.tone/)
  assert.match(titleBar, /tb-status-dot \$\{cliDotClassName\}/)
})
