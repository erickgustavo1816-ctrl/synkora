import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const portraitBaseline = process.argv.includes('--portrait-baseline')

async function inspect() {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({ width: 1100, height: 760, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const button = name => `.gui-composer-attachments button[aria-label="Ver imagem ${name}"]`
  const click = async selector => {
    const box = await run(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().toJSON()`)
    assert.ok(box, `clicável: ${selector}`)
    const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2)
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y })
    await pause(90)
  }
  const preview = () => run(`(() => {
    const panel = document.querySelector('.gui-composer-image-preview');
    return panel ? { box: panel.getBoundingClientRect().toJSON(), modal: panel.getAttribute('aria-modal'),
      image: panel.querySelector('img')?.alt, src: panel.querySelector('img')?.getAttribute('src'),
      error: panel.querySelector('[role="alert"]')?.textContent, busy: panel.getAttribute('aria-busy') } : null;
  })()`)
  const fittedImageFits = async () => assert.ok(await run(`(() => {
    const body = document.querySelector('.gui-composer-image-body');
    return body.scrollWidth <= body.clientWidth + 1 && body.scrollHeight <= body.clientHeight + 1;
  })()`), 'imagem ajustada cabe sem barras desnecessárias')
  const imageGeometry = () => run(`(() => {
    const body = document.querySelector('.gui-composer-image-body');
    const viewport = body.getBoundingClientRect();
    const image = body.querySelector('img').getBoundingClientRect();
    const centerX = viewport.left + body.clientLeft + body.clientWidth / 2;
    const centerY = viewport.top + body.clientTop + body.clientHeight / 2;
    return { image: image.toJSON(), viewport: viewport.toJSON(),
      centerX: (centerX - image.left) / image.width,
      centerY: (centerY - image.top) / image.height };
  })()`)
  try {
    await win.loadFile(join(directory, 'index.html'))
    await pause(450)
    const dots = await run(`(() => {
      const rail = document.querySelector('.project-rail').getBoundingClientRect();
      return [...document.querySelectorAll('.rail-mission-dot')].map(dot => ({
        activity: dot.dataset.activity, color: getComputedStyle(dot).backgroundColor,
        animation: getComputedStyle(dot).animationName,
        fits: dot.getBoundingClientRect().right <= rail.right && dot.getBoundingClientRect().left >= rail.left,
        size: dot.getBoundingClientRect().width
      }));
    })()`)
    assert.deepEqual(dots.map(dot => dot.activity), ['running', 'paused'])
    assert.notEqual(dots[0].color, dots[1].color, 'trabalhando e parado têm cores distintas')
    assert.notEqual(dots[0].animation, 'none', 'a bolinha verde pulsa durante o trabalho')
    assert.equal(dots[1].animation, 'none', 'a bolinha amarela permanece parada')
    assert.ok(dots.every(dot => dot.fits && dot.size >= 12), 'os indicadores ficam legíveis dentro da lateral')
    assert.ok(await run(`(() => {
      const dot = document.querySelector('.rail-mission-dot[data-activity="running"]');
      const animation = dot.getAnimations()[0];
      animation.pause(); animation.currentTime = 0;
      const start = getComputedStyle(dot).transform;
      animation.currentTime = 800;
      const middle = getComputedStyle(dot).transform;
      animation.play();
      return start !== middle;
    })()`), 'o pulso muda visualmente ao longo do ciclo')
    await run(`document.querySelector('.gui-input').focus()`)
    await win.webContents.insertText('Minha explicação: ')
    const originalOverflow = await run('document.body.style.overflow')
    await click(button('mapa.png'))
    let state = await preview()
    assert.ok(state, 'a imagem anexada deve abrir antes do envio')
    assert.equal(state.modal, 'false', 'a janela permite continuar usando o composer')
    assert.equal(state.image, 'mapa.png')
    assert.match(state.src, /^data:image\/png;base64,/)
    const anchor = await run("document.querySelector('.gui-composer-surface').getBoundingClientRect().toJSON()")
    assert.ok(Math.abs(state.box.bottom + 12 - anchor.top) <= 1, 'a prévia nasce logo acima do campo de mensagem')
    assert.ok(state.box.left >= anchor.left - 1 && state.box.right <= anchor.right + 1,
      'a abertura respeita a largura do chat, sem ocupar os painéis da direita')
    await fittedImageFits()
    assert.equal(await run('document.body.style.overflow'), originalOverflow)
    await win.webContents.insertText('o mapa mostra o primeiro passo.')
    assert.equal(await run("document.querySelector('.gui-input').value"), 'Minha explicação: o mapa mostra o primeiro passo.',
      'abrir a imagem não rouba o foco de quem estava escrevendo')
    await writeFile(resolve('.synkora/reports/composer-image-preview-initial.png'), (await win.webContents.capturePage()).toPNG())

    await run("document.querySelector('.gui-input').select()")
    await win.webContents.insertText('Explicação sintética\nOutro detalhe\nMais um ponto\nÚltima observação')
    await pause(90)
    const growingAnchor = await run("document.querySelector('.gui-composer-surface').getBoundingClientRect().toJSON()")
    assert.ok((await preview()).box.bottom <= growingAnchor.top - 10, 'a prévia acompanha o crescimento do input enquanto ainda está ancorada')
    await run("document.querySelector('.gui-input').select()")
    await win.webContents.insertText('Minha explicação: o mapa mostra o primeiro passo.')
    await pause(90)

    const start = state.box
    const handle = await run("document.querySelector('.gui-composer-image-move').getBoundingClientRect().toJSON()")
    const x = Math.round(handle.left + 30), y = Math.round(handle.top + handle.height / 2)
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y })
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: x + 150, y: y - 90 })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: x + 150, y: y - 90 })
    await pause(120)
    state = await preview()
    assert.ok(state.box.left > start.left + 100, 'arrastar o cabeçalho move a janela')
    assert.ok(state.box.top <= start.top - 40)
    await run("document.querySelector('.gui-composer-image-move').focus()")
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' })
    await pause(70)
    assert.ok((await preview()).box.left < state.box.left, 'teclado também move a janela')
    const zoomPercent = () => run("Number(document.querySelector('.gui-composer-image-zoom-percent').textContent.replace('%', ''))")
    const fittedPercent = await zoomPercent()
    for (let step = 0; step < 3; step++) {
      const before = await imageGeometry()
      await click('.gui-composer-image-controls button[aria-label="Aumentar zoom"]')
      const after = await imageGeometry()
      assert.ok(Math.abs(after.centerX - before.centerX) * after.image.width <= 2 &&
        Math.abs(after.centerY - before.centerY) * after.image.height <= 2,
        'zoom horizontal também preserva o ponto central')
    }
    assert.ok(await zoomPercent() > fittedPercent, 'os controles mostram a ampliação atual em porcentagem')
    assert.equal(await run("getComputedStyle(document.querySelector('.gui-composer-image-body')).overflowY"), 'auto')
    const scrollBeforePan = await run("({ left: document.querySelector('.gui-composer-image-body').scrollLeft, top: document.querySelector('.gui-composer-image-body').scrollTop })")
    const body = await run("document.querySelector('.gui-composer-image-body').getBoundingClientRect().toJSON()")
    const imageX = Math.round(body.left + 80), imageY = Math.round(body.top + 80)
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: imageX, y: imageY })
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: imageX - 60, y: imageY - 50 })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: imageX - 60, y: imageY - 50 })
    await pause(80)
    const scrollAfterPan = await run(`(() => { const body = document.querySelector('.gui-composer-image-body'); return { left: body.scrollLeft, top: body.scrollTop, width: body.clientWidth, height: body.clientHeight, totalWidth: body.scrollWidth, totalHeight: body.scrollHeight } })()`)
    assert.ok(scrollAfterPan.left >= scrollBeforePan.left + 50 && scrollAfterPan.top >= scrollBeforePan.top + 40,
      'arrastar a imagem ampliada revela as outras partes dela: ' + JSON.stringify({ scrollBeforePan, scrollAfterPan }))
    const enlargedPercent = await zoomPercent()
    await click('.gui-composer-image-controls button[aria-label="Diminuir zoom"]')
    assert.ok(await zoomPercent() < enlargedPercent)
    await click('.gui-composer-image-zoom-percent')
    const beforeResize = (await preview()).box
    const grip = await run("document.querySelector('.gui-composer-image-resize').getBoundingClientRect().toJSON()")
    const resizeX = Math.round(grip.left + grip.width / 2), resizeY = Math.round(grip.top + grip.height / 2)
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: resizeX, y: resizeY })
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: resizeX + 100, y: resizeY + 60 })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: resizeX + 100, y: resizeY + 60 })
    await pause(80)
    const resized = (await preview()).box
    assert.ok(resized.width >= beforeResize.width + 90 && resized.height >= beforeResize.height + 50,
      'arrastar o canto aumenta a largura e a altura da prévia')
    await fittedImageFits()
    await run("document.querySelector('.gui-composer-image-resize').focus()")
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Left' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Left' })
    await pause(60)
    assert.ok((await preview()).box.width < resized.width, 'a alça também redimensiona por teclado')
    await run("document.querySelector('.gui-input').focus()")
    await win.webContents.insertText(' E continuo escrevendo.')
    await writeFile(resolve('.synkora/reports/composer-image-preview.png'), (await win.webContents.capturePage()).toPNG())
    await writeFile(resolve('.synkora/reports/project-rail-activity.png'),
      (await win.webContents.capturePage({ x: 0, y: 0, width: 78, height: 300 })).toPNG())

    await click(button('detalhe.png'))
    assert.equal((await preview()).image, 'detalhe.png')
    assert.notEqual((await preview()).src, state.src, 'trocar a imagem troca também o bitmap')
    await fittedImageFits()
    assert.equal(await run("document.querySelectorAll('.gui-composer-image-preview').length"), 1)
    const portraitErrors = []
    for (let step = 0; step < 3; step++) {
      const before = await imageGeometry()
      await click('.gui-composer-image-controls button[aria-label="Aumentar zoom"]')
      const after = await imageGeometry()
      if (Math.abs(after.centerX - before.centerX) * after.image.width > 2 ||
          Math.abs(after.centerY - before.centerY) * after.image.height > 2) {
        portraitErrors.push(`zoom vertical deslocou o ponto central no passo ${step + 1}`)
      }
    }
    const portraitBeforePan = await imageGeometry()
    if (!portraitBaseline) await writeFile(resolve('.synkora/reports/composer-portrait-zoom-centered.png'),
      (await win.webContents.capturePage()).toPNG())
    assert.ok(portraitBeforePan.image.width < portraitBeforePan.viewport.width,
      'regressão cobre a imagem ampliada que só excede a altura da janela')
    const portraitX = Math.round(portraitBeforePan.image.left + portraitBeforePan.image.width / 2)
    const portraitY = Math.round(portraitBeforePan.viewport.top + portraitBeforePan.viewport.height / 2)
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: portraitX, y: portraitY })
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: portraitX + 90, y: portraitY - 50 })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: portraitX + 90, y: portraitY - 50 })
    await pause(80)
    const portraitAfterPan = await imageGeometry()
    if (Math.abs(portraitAfterPan.image.left - portraitBeforePan.image.left - 90) > 2 ||
        Math.abs(portraitAfterPan.image.top - portraitBeforePan.image.top + 50) > 2) {
      portraitErrors.push('arraste vertical não acompanhou o ponteiro nos dois eixos')
    }
    await writeFile(resolve('.synkora/reports/composer-portrait-pan-' + (portraitBaseline ? 'before' : 'after') + '.png'),
      (await win.webContents.capturePage()).toPNG())
    assert.deepEqual(portraitErrors, [], 'imagem vertical deve ampliar ao redor do centro e permitir arraste livre')
    for (const action of ['Diminuir zoom', 'Aumentar zoom']) {
      const before = await imageGeometry()
      await click('.gui-composer-image-controls button[aria-label="' + action + '"]')
      const after = await imageGeometry()
      assert.ok(Math.abs(after.centerX - before.centerX) * after.image.width <= 2 &&
        Math.abs(after.centerY - before.centerY) * after.image.height <= 2,
        'o detalhe deslocado por arraste permanece centralizado ao alterar o zoom')
    }
    await click('.gui-composer-image-zoom-percent')
    await fittedImageFits()
    const resetPortrait = await imageGeometry()
    assert.ok(Math.abs(resetPortrait.centerX - 0.5) < 0.01 && Math.abs(resetPortrait.centerY - 0.5) < 0.01)
    await click('.gui-composer-image-controls button[aria-label="Diminuir zoom"]')
    const smallerGrip = await run("document.querySelector('.gui-composer-image-resize').getBoundingClientRect().toJSON()")
    const smallerX = Math.round(smallerGrip.left + smallerGrip.width / 2), smallerY = Math.round(smallerGrip.top + smallerGrip.height / 2)
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: smallerX, y: smallerY })
    win.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', x: smallerX, y: smallerY - 180 })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: smallerX, y: smallerY - 180 })
    await pause(100)
    const smallerPortrait = await imageGeometry()
    assert.ok(Math.abs(smallerPortrait.centerX - 0.5) < 0.01 && Math.abs(smallerPortrait.centerY - 0.5) < 0.01,
      'reduzir a janela mantém o centro quando um zoom manual passa a exigir rolagem')
    await run('window.previewFixture.working()')
    await run("document.querySelector('.gui-input').focus()")
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await pause(90)
    assert.equal(await preview(), null)
    assert.equal(await run('window.previewFixture.interrupts'), 0, 'Escape fecha a prévia sem parar a missão')
    assert.equal(await run("document.activeElement === document.querySelector('.gui-input')"), true)

    await run("window.previewFixture.mode = 'deferred'")
    await click(button('mapa.png'))
    assert.equal((await preview()).busy, 'true')
    await click('.gui-composer-image-close')
    await run('window.previewFixture.resolvePending()')
    await pause(70)
    assert.equal(await preview(), null, 'resposta atrasada não reabre a janela')
    await run("window.previewFixture.mode = 'refused'")
    await click(button('mapa.png'))
    assert.ok((await preview()).error)
    assert.equal((await preview()).src, undefined)
    await click('.gui-composer-image-close')
    await run("window.previewFixture.mode = 'unsafe'")
    await click(button('mapa.png'))
    assert.ok((await preview()).error)
    assert.equal((await preview()).src, undefined, 'fonte remota nunca vira img')
    await click('.gui-composer-image-close')
    await run("window.previewFixture.mode = 'ready'")
    await click(button('mapa.png'))
    win.setContentSize(700, 540)
    await pause(180)
    state = await preview()
    assert.ok(state.box.left >= 0 && state.box.right <= 700 && state.box.top >= 0 && state.box.bottom <= 540,
      'a janela continua alcançável depois de reduzir a tela')
    await click('.gui-composer-attachments button[aria-label="Remover anexo mapa.png"]')
    assert.equal(await preview(), null, 'remover a imagem fecha sua prévia')
    assert.equal(await run("document.querySelectorAll('.gui-composer-attachments .gui-attachment-chip').length"), 1)
    await click(button('detalhe.png'))
    await run('window.previewFixture.hide()')
    await pause(90)
    assert.equal(await preview(), null, 'sair do chat remove o portal')
    assert.equal(await run('window.previewFixture.sends'), 0, 'consultar imagens nunca envia a mensagem')
    assert.ok(await run('window.previewFixture.requests.every(request => request.paneId === "gui-synthetic-preview" && request.purpose === "lightbox")'))
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    assert.equal(await run("getComputedStyle(document.querySelector('.rail-mission-dot[data-activity=running]')).animationName"), 'none')
    win.webContents.debugger.detach()
    console.log('PASS composer real: zoom centralizado horizontal/vertical, pan nos dois eixos mesmo sem overflow em um deles, zoom após pan, ajuste sem barras, janela móvel/redimensionável, foco, Escape e demais regressões. Indicadores verde pulsante/amarelo estático.')
  } finally { win.destroy() }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async error => {
    console.error(error.stack); (await import('electron')).app.exit(1)
  })
} else {
  test('prévia flutuante dos anexos mantém o composer utilizável', { timeout: 30000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    await mkdir(resolve('.synkora/reports'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/attachment-preview-'))
    buildSync({ stdin: { contents: `
      import { useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import GuiPane from './components/GuiPane'
      import ProjectRail from './components/ProjectRail'
      import { installDevMock } from './devMock'
      import { useStore } from './store'
      import { writeGuiComposerAttachments } from './guiComposerAttachmentStorage'
      import { installGlobalGuiEscape } from './guiEscape'
      installDevMock()
      installGlobalGuiEscape()
      const projects = [{ id: 'project-a', name: 'Planejamento' }, { id: 'project-b', name: 'Site' }, { id: 'project-c', name: 'Arquivo' }]
      const missions = [
        { id: 'aaaaaaaa-01', projectId: 'project-a', title: 'Release sintética', missionType: 'release', status: 'ativa', direct: true },
        { id: 'bbbbbbbb-01', projectId: 'project-b', title: 'Missão sintética', status: 'ativa', direct: true }
      ]
      window.synkora.missions = { list: async projectId => missions.filter(mission => mission.projectId === projectId), onChanged: () => () => {} }
      useStore.setState({ projects, guiPanes: { 'gui-dev-aaaaaaaa': { status: 'working', perm: null } } })
      const paneId = 'gui-synthetic-preview'
      const events = [{ type: 'ready', caps: { models: [], commands: [] } }]
      window.synkora.gui.state = async () => ({ exists: true, alive: true, cursor: 1, events: events.map(evt => ({ seq: 1, evt })) })
      const attachments = ['mapa.png', 'detalhe.png'].map((name, i) => ({ id: 'synthetic-' + i,
        capability: 'gui-cap-v1-' + String.fromCharCode(65 + i).repeat(43), kind: 'image', name, mime: 'image/png', size: 34000 }))
      writeGuiComposerAttachments(paneId, attachments)
      const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 500
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#efe9dc'; ctx.fillRect(0, 0, 800, 500)
      ctx.fillStyle = '#26241f'; ctx.font = '30px monospace'; ctx.fillText('MAPA DO PROJETO', 40, 70)
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = ['#c2d3b2', '#efc69e', '#b6ccd0'][i]; ctx.fillRect(40 + i * 250, 145, 215, 170)
        ctx.fillStyle = '#26241f'; ctx.fillText(['IDEIA', 'MISSÃO', 'ENTREGA'][i], 60 + i * 250, 230)
      }
      ctx.font = '20px monospace'; ctx.fillText('Imagem sintética para validar a prévia.', 40, 410)
      const result = { ok: true, dataUrl: canvas.toDataURL('image/png'), mime: 'image/png', width: 800, height: 500 }
      canvas.width = 480; canvas.height = 1200
      ctx.fillStyle = '#e7e0d3'; ctx.fillRect(0, 0, 480, 1200)
      ctx.fillStyle = '#26241f'; ctx.font = '24px monospace'; ctx.fillText('DETALHE VERTICAL', 35, 60)
      for (let i = 0; i < 6; i++) { ctx.fillStyle = i % 2 ? '#efc69e' : '#b6ccd0'; ctx.fillRect(35, 120 + i * 160, 410, 100) }
      const tallResult = { ok: true, dataUrl: canvas.toDataURL('image/png'), mime: 'image/png', width: 480, height: 1200 }
      const fixture = window.previewFixture = { mode: 'ready', sends: 0, interrupts: 0, requests: [], resolvePending() {}, hide() {},
        working() { useStore.setState(s => ({ guiPanes: { ...s.guiPanes, [paneId]: { ...s.guiPanes[paneId], status: 'working' } } })) } }
      window.synkora.gui.attachmentPreview = async (requestPane, attachment, purpose) => {
        if (requestPane !== paneId || !attachments.some(value => value.id === attachment.id && value.capability === attachment.capability)) throw new Error('wrong fixture scope')
        fixture.requests.push({ paneId: requestPane, purpose })
        if (fixture.mode === 'deferred') return new Promise(resolve => { fixture.resolvePending = () => resolve(result) })
        if (fixture.mode === 'refused') return { ok: false, error: 'A imagem não está mais disponível. Anexe novamente.' }
        if (fixture.mode === 'unsafe') return { ...result, dataUrl: 'https://example.invalid/image.png' }
        return attachment.name === 'detalhe.png' ? tallResult : result
      }
      window.synkora.gui.send = async () => { fixture.sends++; return { ok: true } }
      window.synkora.gui.interrupt = async () => { fixture.interrupts++; return { ok: true } }
      function Fixture() {
        const [active, setActive] = useState(true)
        fixture.hide = () => setActive(false)
        return <div style={{ height: '100%', display: 'flex' }}><ProjectRail /><div style={{ width: 'min(620px, 100%)', height: '100%', display: active ? 'flex' : 'none', padding: 12 }}>
          <GuiPane paneId={paneId} projectId="synthetic" cli="codex" cwd="synthetic" permissionMode="default" showHeader={false} active={active} />
        </div></div>
      }
      createRoot(document.getElementById('root')).render(<Fixture />)
    `, resolveDir: resolve('src/renderer/src'), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Prévia sintética</title><link rel="stylesheet" href="${pathToFileURL(resolve('src/renderer/src/global.css')).href}"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script></html>`)
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory, ...(portraitBaseline ? ['--portrait-baseline'] : [])], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.equal(code, 0, output)
    console.log(output.trim())
  })
}
