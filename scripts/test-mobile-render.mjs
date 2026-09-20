import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'

const pause = ms => new Promise(done => setTimeout(done, ms))

async function inspect() {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({ width: 1520, height: 950, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  const run = source => win.webContents.executeJavaScript(source)
  const screenshot = async name => writeFile(resolve(`.synkora/reports/mobile-panel-${name}-2026-09-19.png`), (await win.webContents.capturePage()).toPNG())
  const panelScreenshot = async name => {
    const bounds = await run("(() => { const r = document.querySelector('[data-workspace-panel=\"mobile\"]').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()")
    await writeFile(resolve(`.synkora/reports/mobile-panel-${name}-2026-09-19.png`), (await win.webContents.capturePage(bounds)).toPNG())
  }
  const measure = () => run(`(() => {
    const root = document.querySelector('.dock-mobile'), panel = document.querySelector('[data-workspace-panel="mobile"]');
    const image = root.querySelector('img'), display = root.querySelector('.mobile-phone-display'), shell = root.querySelector('.mobile-phone-shell');
    const box = (display ?? root.querySelector('.mobile-viewport')).getBoundingClientRect();
    return { width: panel.getBoundingClientRect().width, overflow: root.scrollWidth - root.clientWidth,
      phone: !!display && !!shell, shellRadius: shell ? parseFloat(getComputedStyle(shell).borderRadius) : 0,
      profile: shell?.dataset.deviceProfile, family: shell?.dataset.frameFamily,
      applied: root.querySelector('[aria-label="Escolher modelo de tela"]')?.dataset.appliedProfile,
      padding: shell ? { top: parseFloat(getComputedStyle(shell).paddingTop), bottom: parseFloat(getComputedStyle(shell).paddingBottom), left: parseFloat(getComputedStyle(shell).paddingLeft) } : null,
      shell: shell ? (() => { const r = shell.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })() : null,
      imageReady: !!image?.complete && image.naturalWidth > 0, imageWidth: image?.naturalWidth, imageHeight: image?.naturalHeight,
      box: { left: box.left, top: box.top, width: box.width, height: box.height },
      iosDisabled: root.querySelector('[aria-label="Selecionar iOS"]').disabled,
      captures: window.mobileFixture.calls.filter(c => c[0] === 'capture').length,
      actions: window.mobileFixture.calls.filter(c => c[0] === 'act'), stopped: window.mobileFixture.calls.some(c => c[0] === 'stop') };
  })()`)
  const click = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    await pause(60)
  }
  const settle = 'await new Promise(resolve => setTimeout(resolve, 30));'
  const pick = text => `(async () => { const trigger = document.querySelector('[aria-label="Tamanho da visualização"]'); if (!document.querySelector('.mobile-scale-menu')) { trigger.click(); ${settle} } const item = [...document.querySelectorAll('.mobile-scale-menu button')].find(b => b.textContent === ${JSON.stringify(text)}); if (!item) throw new Error('menu item ' + ${JSON.stringify(text)}); item.click(); ${settle} })()`
  const readItem = text => `(async () => { const trigger = document.querySelector('[aria-label="Tamanho da visualização"]'); trigger.click(); ${settle} const item = [...document.querySelectorAll('.mobile-scale-menu button')].find(b => b.textContent === ${JSON.stringify(text)}); const value = item ? { disabled: item.disabled, title: item.title } : null; trigger.click(); ${settle} return value })()`
  const scaleLabel = "document.querySelector('[aria-label=\"Tamanho da visualização\"]').firstChild.textContent"
  try {
    await win.loadFile(join(directory, 'index.html'))
    await pause(600)
    win.setContentSize(1520, 831)
    await run("window.mobileFixture.workspace.setColumnWidth(424)")
    await pause(200)
    const ownerSize = await measure()
    console.log('424px fit display:', JSON.stringify(ownerSize.box))
    await screenshot('424-fit')
    await panelScreenshot('clean')
    assert.ok(ownerSize.box.width >= 300, 'the device must use the height freed by removing bottom controls at 424×795')
    assert.equal(await run("document.querySelector('.mobile-tools') === null && document.querySelector('.mobile-text-entry') === null && document.querySelector('.mobile-navigation') === null"), true)
    assert.equal(await run("getComputedStyle(document.querySelector('.mobile-phone-display')).cursor"), 'pointer')
    const realItem = await run(readItem('Tamanho real'))
    assert.equal(realItem.disabled, true, 'unknown hardware never substitutes a generic physical size')
    assert.match(realItem.title, /Escolha um modelo/)
    await run(pick('125%'))
    await pause(80)
    const enlarged = await measure()
    assert.ok(enlarged.box.width > ownerSize.box.width * 1.2, 'zoom makes the screen visibly larger')
    await pause(250)
    assert.ok(Math.abs((await measure()).box.width - enlarged.box.width) < .1, 'zoom and scrollbars converge without a resize loop')
    await click(enlarged.box.left + enlarged.box.width / 2, enlarged.box.top + enlarged.box.height / 3)
    const zoomTap = (await measure()).actions.at(-1)?.[3]
    assert.ok(Math.abs(zoomTap.x - .5) < .01 && Math.abs(zoomTap.y - 1 / 3) < .01, 'zoom preserves the exact screen coordinate mapping')
    await pause(150)
    await screenshot('424-zoom')
    await run(pick('Ajustar ao painel')); await run("document.querySelector('[aria-label=\"Ampliar tela do aparelho\"]').click()")
    await pause(80)
    const focused = await measure()
    assert.ok(focused.box.width > ownerSize.box.width + 25, 'phone-only view frees additional height')
    console.log('424px zoom / expanded display widths:', enlarged.box.width, focused.box.width)
    await screenshot('424-expanded')
    await panelScreenshot('clean-expanded')
    await run("document.querySelector('[aria-label=\"Restaurar controles do aparelho\"]').click()")
    await pause(30)
    await run("document.querySelector('[aria-label=\"Escolher modelo de tela\"]').click()")
    await pause(60)
    assert.equal(await run("document.querySelector('[aria-label=\"Início do dispositivo\"]').disabled"), true, 'opening the model picker pauses input beneath the popover')
    assert.equal(await run("(() => { const r = document.querySelector('.mobile-model-menu').getBoundingClientRect(); return document.elementFromPoint(r.left + 20, r.top + 20)?.closest('.mobile-model-menu') !== null && r.right <= innerWidth && r.bottom <= innerHeight; })()"), true, 'the picker is visible, above the device, and fits in the window')
    await panelScreenshot('model-picker')
    await run("document.querySelector('.mobile-model-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))")
    await pause(40)
    const profileViews = new Map()
    for (const [profileId, family, width, height] of [['pixel-7', 'pixel', 1080, 2400], ['galaxy-s24', 'galaxy', 1080, 2340], ['galaxy-s24-ultra', 'galaxy-ultra', 1440, 3120], ['galaxy-a54', 'galaxy', 1080, 2340]]) {
      const before = await measure()
      await run(`window.mobileFixture.setInputDelay(180); document.querySelector('[aria-label="Escolher modelo de tela"]').click()`)
      await pause(30)
      await run(`document.querySelector('[data-profile-option="${profileId}"]').click()`)
      await pause(30)
      assert.equal((await measure()).applied, before.applied, 'a pending change cannot pretend the new model is already applied')
      assert.equal(await run("document.querySelector('[aria-label=\"Início do dispositivo\"]').disabled"), true)
      for (let attempt = 0; attempt < 30; attempt++) {
        const next = await measure()
        if (next.applied === profileId && next.imageWidth === width) break
        await pause(60)
      }
      const next = await measure()
      assert.equal(next.applied, profileId)
      assert.equal(next.profile, profileId)
      assert.equal(next.family, family)
      assert.equal(next.imageWidth, width)
      assert.equal(next.imageHeight, height)
      assert.ok(Math.abs(next.box.width / next.box.height - width / height) < .001, 'the frame fits the confirmed real display aspect')
      assert.ok(next.overflow <= 1, 'model controls remain inside the narrow panel')
      await run('window.mobileFixture.setInputDelay(0)')
      await click(next.box.left + next.box.width / 2, next.box.top + next.box.height / 3)
      const mapped = (await measure()).actions.at(-1)?.[3]
      assert.ok(mapped.type === 'tap' && Math.abs(mapped.x - .5) < .01 && Math.abs(mapped.y - 1 / 3) < .01, 'each display profile preserves pointer normalization')
      const afterTouch = (await measure()).actions.length
      await click(next.shell.left + .5, next.shell.top + next.shell.height / 2)
      assert.equal((await measure()).actions.length, afterTouch, 'model-specific bezel never receives touches')
      await pause(150)
      await panelScreenshot(`model-${profileId}`)
      profileViews.set(profileId, next)
      if (profileId === 'pixel-7') {
        await run("window.mobilePhysicalCanvas = document.querySelector('.mobile-screen')"); await run(pick('Tamanho real'))
        await pause(40)
        assert.equal(await run("document.querySelector('[role=\"dialog\"]') === null && document.querySelector('.mobile-phone-shell').dataset.sizeMode === 'physical'"), true, 'monitor detection applies physical mode immediately without a ruler prompt')
        assert.ok(Math.abs(Math.hypot((await measure()).box.width, (await measure()).box.height) - 160.5 * 3.6) < .03, 'automatic monitor metadata controls the official display diagonal')
        assert.equal(await run(scaleLabel), 'Real')
        await run(pick('Calibrar tamanho real…'))
        await pause(60)
        assert.equal(await run("document.activeElement.getAttribute('aria-label')"), 'Ajustar régua de 5 cm')
        assert.equal(await run("document.querySelector('[aria-label=\"Início do dispositivo\"]').disabled"), true)
        await run("document.querySelector('[aria-label=\"Cancelar calibração\"]').focus(); document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))")
        assert.equal(await run("document.activeElement.getAttribute('aria-label')"), 'Salvar calibração', 'Shift+Tab stays within the modal')
        await run("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))")
        assert.equal(await run("document.activeElement.getAttribute('aria-label')"), 'Cancelar calibração')
        await run("document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))")
        await pause(40)
        assert.equal(await run("document.querySelector('[role=\"dialog\"]') === null && document.activeElement.getAttribute('aria-label') === 'Tamanho da visualização'"), true)
        assert.equal(await run("Object.keys(localStorage).some(key => key.includes('calibration'))"), false, 'Escape saves no unconfirmed calibration')
        await run(pick('Calibrar tamanho real…'))
        await pause(30)
        await run("(() => { const range = document.querySelector('[aria-label=\"Ajustar régua de 5 cm\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(range, '180'); range.dispatchEvent(new Event('input', { bubbles: true })); })()")
        await pause(40)
        assert.ok(Math.abs(await run("document.querySelector('.mobile-calibration-ruler').getBoundingClientRect().width") - 180) < .02, 'ruler is exactly180CSSpx with no hidden transform')
        await run("document.querySelector('[aria-label=\"Ajustar régua de 5 cm\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))")
        await pause(20)
        assert.ok(Math.abs(await run("document.querySelector('.mobile-calibration-ruler').getBoundingClientRect().width - 180 - 1 / devicePixelRatio") ) < .03, 'one keyboard step is one device pixel')
        await run("document.querySelector('[aria-label=\"Ajustar régua de 5 cm\"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))")
        await pause(30)
        const dialogRect = await run("(() => { const r = document.querySelector('.mobile-calibration-dialog').getBoundingClientRect(); return { x: Math.floor(r.x - 12), y: Math.floor(r.y - 12), width: Math.ceil(r.width + 24), height: Math.ceil(r.height + 24) }; })()")
        await writeFile(resolve('.synkora/reports/mobile-panel-physical-calibration-2026-09-19.png'), (await win.webContents.capturePage(dialogRect)).toPNG())
        await run("document.querySelector('[aria-label=\"Salvar calibração\"]').click()")
        await pause(80)
        const physicalPixel = await measure()
        assert.ok(Math.abs(physicalPixel.shell.width - physicalPixel.box.width - 4) < .03 && Math.abs(physicalPixel.shell.height - physicalPixel.box.height - 4) < .03, 'physical mode keeps the same2px decorative border as fit')
        assert.ok(Math.abs(Math.hypot(physicalPixel.box.width, physicalPixel.box.height) - 160.5 * 3.6) < .03)
        await panelScreenshot('calibrated-pixel-7')
        await run('window.mobileFixture.workspace.setColumnWidth(580)')
        win.setContentSize(1520, 680)
        await pause(100)
        let resized = await measure()
        assert.ok(Math.abs(resized.shell.width - physicalPixel.shell.width) < .02 && Math.abs(resized.shell.height - physicalPixel.shell.height) < .02, JSON.stringify({ before: physicalPixel.shell, after: resized.shell, state: await run("({ screen: [screen.width, screen.height, screen.availLeft, screen.availTop, devicePixelRatio, visualViewport.scale], mode: document.querySelector('.mobile-phone-shell').dataset.sizeMode, saved: Object.keys(localStorage).filter(key => key.includes('calibration')) })") }))
        await run('window.mobileFixture.workspace.setColumnWidth(360)')
        await pause(100)
        resized = await measure()
        assert.ok(Math.abs(resized.box.width - physicalPixel.box.width) < .02 && resized.overflow <= 1, 'panel resize never rescales calibrated hardware')
        await click(resized.box.left + resized.box.width / 2, resized.box.top + resized.box.height / 3)
        const mappedPhysical = (await measure()).actions.at(-1)?.[3]
        assert.ok(mappedPhysical.type === 'tap' && Math.abs(mappedPhysical.x - .5) < .01 && Math.abs(mappedPhysical.y - 1 / 3) < .01)
        win.setContentSize(1520, 831)
        await run("window.mobileFixture.workspace.setColumnWidth(424); document.querySelector('[aria-label=\"Ampliar tela do aparelho\"]').click()")
        await pause(80)
        assert.ok(Math.abs((await measure()).shell.width - physicalPixel.shell.width) < .02, 'focus also preserves real dimensions')
        await run("document.querySelector('[aria-label=\"Restaurar controles do aparelho\"]').click()"); await run(pick('Calibrar tamanho real…'))
        await pause(40)
        await run("(() => { const range = document.querySelector('[aria-label=\"Ajustar régua de 5 cm\"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(range, '600'); range.dispatchEvent(new Event('input', { bubbles: true })); })()")
        await pause(80)
        assert.equal(await run("(() => { const bar = document.querySelector('.mobile-calibration-ruler').getBoundingClientRect(); const area = document.querySelector('.mobile-calibration-ruler-area').getBoundingClientRect(); return Math.abs(bar.width - 600) < .02 && bar.left >= area.left && bar.right <= area.right && !document.querySelector('[aria-label=\"Salvar calibração\"]').disabled; })()"), true, 'high-DPI rulers grow the dialog and remain unscaled, uncropped and confirmable')
        await run("document.querySelector('[aria-label=\"Cancelar calibração\"]').click()")
        await pause(30)
        assert.ok(Math.abs((await measure()).shell.width - physicalPixel.shell.width) < .02, 'cancelled recalibration keeps the confirmed scale')
        await run(pick('Ajustar ao painel'))
        await pause(80)
        assert.ok(Math.abs((await measure()).box.width - next.box.width) < .02)
        assert.equal(await run("window.mobilePhysicalCanvas === document.querySelector('.mobile-screen')"), true, 'calibration, resize and fit preserve the native canvas')
      }
      if (profileId === 'galaxy-s24-ultra') {
        await run("document.querySelector('[aria-label=\"Ampliar tela do aparelho\"]').click()")
        await pause(80)
        assert.ok((await measure()).box.width > next.box.width + 20)
        await panelScreenshot('model-galaxy-s24-ultra-focused')
        await run("document.querySelector('[aria-label=\"Restaurar controles do aparelho\"]').click()")
        await pause(40)
        await run(pick('Tamanho real'))
        await pause(80)
        const physicalUltra = await measure()
        assert.ok(Math.abs(physicalUltra.shell.width - physicalUltra.box.width - 4) < .03 && Math.abs(physicalUltra.shell.height - physicalUltra.box.height - 4) < .03)
        assert.ok(Math.abs(Math.hypot(physicalUltra.box.width, physicalUltra.box.height) - 172.5 * 3.6) < .03, 'new model reuses the monitor scale with its own official display diagonal')
        await panelScreenshot('calibrated-galaxy-s24-ultra')
        await run(pick('125%'))
        await pause(80)
        const physicalZoom = await measure()
        assert.ok(Math.abs(physicalZoom.box.width / physicalUltra.box.width - 1.25) < .001)
        await click(physicalZoom.box.left + physicalZoom.box.width / 2, physicalZoom.box.top + physicalZoom.box.height / 3)
        const physicalZoomTap = (await measure()).actions.at(-1)?.[3]
        assert.ok(Math.abs(physicalZoomTap.x - .5) < .01 && Math.abs(physicalZoomTap.y - 1 / 3) < .01, 'physical zoom retains exact input coordinates')
        await pause(150)
        await panelScreenshot('calibrated-galaxy-s24-ultra-125')
        await run(pick('Ajustar ao painel'))
      }
    }
    assert.ok(profileViews.get('galaxy-s24-ultra').shellRadius < profileViews.get('galaxy-s24').shellRadius / 2, 'Ultra has its own flatter hardware corners')
    for (const [, view] of profileViews) {
      assert.equal(view.padding.left, 2); assert.equal(view.padding.top, 2); assert.equal(view.padding.bottom, 2)
    }
    console.log('424px model display widths:', JSON.stringify(Object.fromEntries([...profileViews].map(([id, view]) => [id, view.box.width]))))
    await run("document.querySelector('[aria-label=\"Escolher modelo de tela\"]').click()")
    await pause(20)
    await run("document.querySelector('[data-profile-option=\"native\"]').click()")
    await pause(250)
    await run("window.mobileFixture.workspace.setColumnWidth(360)")
    win.setContentSize(1520, 950)
    await pause(300)
    let view = await measure()
    assert.equal(view.width, 360)
    assert.ok(view.phone && view.shellRadius > 10, 'a rounded physical phone frame must surround the live display')
    assert.ok(view.imageReady, 'the real component must render a PNG through the bridge')
    assert.ok(view.overflow <= 1, 'controls fit the 360px panel')
    assert.equal(view.iosDisabled, true)
    await screenshot('360')

    const { box } = view
    assert.ok(Math.abs(view.shell.width - box.width - 4) < .03, 'the decorative hardware edge stays2px in fit mode')
    const beforeBezel = view.actions.length
    await click(view.shell.left + .5, view.shell.top + view.shell.height / 2)
    assert.equal((await measure()).actions.length, beforeBezel, 'the hardware bezel must not trigger device input')
    await click(box.left + box.width / 2, box.top + box.height / 2)
    view = await measure()
    const action = view.actions.at(-1)?.[3]
    assert.equal(action?.type, 'tap')
    assert.ok(Math.abs(action.x - .5) < .01 && Math.abs(action.y - .5) < .01, 'pointer pixels map to the native screen center')
    const scale = Math.min(box.width / 400, box.height / 800)
    const beforeLetterbox = view.actions.length
    if (box.width - 400 * scale > 4) await click(box.left + 1, box.top + box.height / 2)
    else if (box.height - 800 * scale > 4) await click(box.left + box.width / 2, box.top + 1)
    assert.equal((await measure()).actions.length, beforeLetterbox, 'letterboxing cannot trigger device input')

    await run("window.mobileFixture.setInputDelay(220)")
    const beforeRapid = (await measure()).actions.length
    await click(box.left + box.width / 2, box.top + box.height / 2)
    assert.equal(await run("document.querySelector('[aria-label=\"Início do dispositivo\"]').disabled"), false)
    assert.equal(await run("document.querySelector('.mobile-phone-display').classList.contains('is-interactive')"), true)
    await click(box.left + box.width / 2, box.top + box.height / 2)
    await click(box.left + box.width / 2, box.top + box.height / 2)
    await pause(650)
    assert.equal((await measure()).actions.length - beforeRapid, 3, 'three quick taps survive a slow bridge')
    assert.equal(await run("window.mobileFixture.inputConcurrency()"), 1, 'input stays serial')
    await run("window.mobileFixture.setInputDelay(0)")

    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), button: 'left', clickCount: 1 })
    await pause(600)
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), button: 'left', clickCount: 1 })
    await pause(70)
    const hold = (await measure()).actions.at(-1)?.[3]
    assert.ok(hold.type === 'swipe' && hold.durationMs >= 450 && hold.x === hold.endX && hold.y === hold.endY, 'holding intentionally sends a long press')
    await pause(150)
    assert.equal(await run("document.querySelector('.mobile-touch-feedback').hidden"), true, 'touch feedback fades without replacing the canvas')

    const beforeCancelled = (await measure()).actions.length
    await run("(() => { const display = document.querySelector('.mobile-phone-display'); window.mobileFixture.pointerEvents = []; for (const type of ['pointerdown','gotpointercapture','lostpointercapture','pointermove','pointerup']) display.addEventListener(type, event => { window.mobileFixture.pointerEvents.push([type,event.pointerId,event.buttons,display.hasPointerCapture(event.pointerId)]); if (type === 'pointerdown') window.mobileFixture.pointerId = event.pointerId; }); })()")
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(box.left + box.width / 2 + 1), y: Math.round(box.top + box.height / 2), modifiers: ['leftButtonDown'] })
    await pause(40)
    await run("document.querySelector('.mobile-phone-display').releasePointerCapture(window.mobileFixture.pointerId)")
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(box.left + box.width / 2 + 4), y: Math.round(box.top + box.height / 2), modifiers: ['leftButtonDown'] })
    await pause(40)
    assert.equal(await run("document.querySelector('.mobile-touch-feedback').hidden"), true, 'losing pointer capture clears an unfinished touch indication: ' + JSON.stringify(await run("window.mobileFixture.pointerEvents")))
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(box.left + box.width / 2 + 4), y: Math.round(box.top + box.height / 2), button: 'left', clickCount: 1 })
    await pause(40)
    assert.equal((await measure()).actions.length, beforeCancelled, 'an aborted pointer never reaches the device')

    const beforeWheel = (await measure()).actions.length
    await run("document.querySelector('.mobile-phone-display').dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }))")
    await pause(130)
    const wheel = (await measure()).actions.at(-1)?.[3]
    assert.equal((await measure()).actions.length, beforeWheel + 1)
    assert.ok(wheel.type === 'swipe' && wheel.y > wheel.endY)
    const beforeHiddenWheel = (await measure()).actions.length
    await run("document.querySelector('.mobile-phone-display').dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true })); window.mobileFixture.setVisible(false)")
    await pause(130)
    assert.equal((await measure()).actions.length, beforeHiddenWheel, 'hiding cancels a wheel gesture waiting to be dispatched')
    await run("window.mobileFixture.setVisible(true)")
    await pause(150)

    await run("window.mobileFixture.workspace.setColumnWidth(580)")
    await pause(300)
    view = await measure()
    assert.equal(view.width, 580)
    assert.ok(view.overflow <= 1)
    await screenshot('580')

    await run("window.mobileFixture.setPointerDelay(180); window.mobileFixture.enableLiveInput(true); document.querySelector('.mobile-phone-display').addEventListener('pointerdown', event => { window.mobileLivePointerId = event.pointerId })")
    await pause(100)
    const liveBox = (await measure()).box
    const livePackets = () => run("window.mobileFixture.calls.filter(call => call[0] === 'pointer').map(call => call[3])")
    const livePoint = (x, y) => ({ x: Math.round(liveBox.left + liveBox.width * x), y: Math.round(liveBox.top + liveBox.height * y) })
    const liveDown = (x, y) => win.webContents.sendInputEvent({ type: 'mouseDown', ...livePoint(x, y), button: 'left', clickCount: 1 })
    const liveMove = (x, y) => win.webContents.sendInputEvent({ type: 'mouseMove', ...livePoint(x, y), modifiers: ['leftButtonDown'] })
    const liveUp = (x, y) => win.webContents.sendInputEvent({ type: 'mouseUp', ...livePoint(x, y), button: 'left', clickCount: 1 })
    const beforeLiveActions = (await measure()).actions.length
    liveDown(.3, .4)
    await pause(30)
    assert.equal((await livePackets()).at(-1)?.phase, 'down', 'real mouse down reaches the bridge before release')
    liveMove(.6, .65)
    await pause(40)
    assert.equal((await livePackets()).at(-1)?.phase, 'move', 'real dragging reaches the bridge while held')
    assert.equal(await run("document.querySelector('[aria-label=\"Início do dispositivo\"]').disabled"), false)
    liveUp(.7, .75)
    await pause(25)
    assert.equal((await livePackets()).at(-1)?.phase, 'up', 'UP is submitted without awaiting initial DOWN preparation')
    await pause(180)
    assert.equal((await measure()).actions.length, beforeLiveActions, 'live input never synthesizes a discrete tap/swipe')

    const beforeRapidLive = (await livePackets()).length
    for (let index = 0; index < 3; index++) await click(livePoint(.5, .5).x, livePoint(.5, .5).y)
    await pause(600)
    const rapidLive = (await livePackets()).slice(beforeRapidLive)
    assert.deepEqual(rapidLive.map(packet => packet.phase), ['down', 'up', 'down', 'up', 'down', 'up'], 'three rapid real mouse clicks survive delayed terminal responses')

    const beforeFlood = (await livePackets()).length
    liveDown(.3, .4)
    await pause(20)
    await run("(() => { const display = document.querySelector('.mobile-phone-display'), r = display.getBoundingClientRect(); for (let index = 0; index < 200; index++) display.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: window.mobileLivePointerId, isPrimary: true, pointerType: 'mouse', buttons: 1, clientX: r.left + r.width * (.3 + index / 400), clientY: r.top + r.height * .7 })); })()")
    await pause(30)
    liveUp(.8, .7)
    await pause(220)
    const flooded = (await livePackets()).slice(beforeFlood)
    assert.ok(flooded.filter(packet => packet.phase === 'move').length <= 2, '200 move events are coalesced with a final position')
    assert.equal(flooded.at(-1).phase, 'up')
    assert.ok(Math.abs(flooded.at(-1).x - .8) < .01 && Math.abs(flooded.at(-1).y - .7) < .01)

    for (const abort of ['blur', 'hidden', 'lost']) {
      const before = (await livePackets()).length
      liveDown(.5, .5)
      liveMove(.51, .5)
      await pause(25)
      if (abort === 'blur') await run("window.dispatchEvent(new Event('blur'))")
      else if (abort === 'hidden') await run('window.mobileFixture.setVisible(false)')
      else { await run("document.querySelector('.mobile-phone-display').releasePointerCapture(window.mobileLivePointerId)"); liveMove(.52, .5) }
      await pause(40)
      assert.equal((await livePackets()).slice(before).at(-1)?.phase, 'cancel', `${abort} sends native cancel even while DOWN is pending`)
      assert.equal(await run("document.querySelector('.mobile-touch-feedback').hidden"), true)
      liveUp(.52, .5)
      await pause(200)
      assert.equal((await livePackets()).slice(before).at(-1)?.phase, 'cancel', 'release after cancellation does not replay the touch')
      if (abort === 'hidden') { await run('window.mobileFixture.setVisible(true)'); await pause(100) }
    }
    await run('window.mobileFixture.enableLiveInput(false)')
    await pause(100)

    await run("document.querySelector('[aria-label=\"Abrir Expo Go\"]').click()")
    await pause(150)
    assert.match(await run("document.querySelector('.mobile-expo').innerText"), /iPhone físico/)
    assert.equal(await run("(() => { const qr = document.querySelector('.mobile-expo-qr img'); return !!qr?.complete && qr.naturalWidth > 100 && qr.src.startsWith('data:image/png;base64,'); })()"), true, 'the physical iPhone view renders the locally generated QR')
    assert.equal(await run("document.querySelector('[aria-label=\"Selecionar iOS\"]').disabled"), true)
    assert.ok((await run("document.querySelector('.mobile-expo-intro > p').textContent")).length < 140, 'realistic long backend guidance stays out of the compact intro')
    assert.ok((await measure()).overflow <= 1)
    await screenshot('expo-580')
    await run("window.mobileFixture.workspace.setColumnWidth(360)")
    await pause(150)
    assert.ok(await run("document.querySelector('.mobile-expo').scrollWidth <= document.querySelector('.mobile-expo').clientWidth + 1"), 'Expo cards fit at 360px')
    await screenshot('expo-360')
    await run("document.querySelector('[aria-label=\"Abrir Expo Go no Android\"]').click()")
    await pause(150)
    assert.equal(await run("document.querySelector('[aria-label=\"Selecionar Android\"]').getAttribute('aria-pressed')"), 'true')
    assert.equal(await run("window.mobileFixture.calls.some(c => c[0] === 'expoOpenAndroid' && c[1] === 'mobile-fixture-mission' && c[2] === 'android-fixture')"), true)

    await run("window.mobileFixture.setLandscape(true); document.querySelector('[aria-label=\"Atualizar tela do dispositivo\"]').click()")
    await pause(150)
    view = await measure()
    assert.ok(view.box.width > view.box.height && view.shell.width > view.shell.height, 'the hardware and exact inner display follow landscape rotation')
    await click(view.box.left + view.box.width / 4, view.box.top + view.box.height / 2)
    const landscapeTap = (await measure()).actions.at(-1)?.[3]
    assert.ok(Math.abs(landscapeTap.x - .25) < .01 && Math.abs(landscapeTap.y - .5) < .01, 'landscape coordinates remain normalized to the device screen')
    await screenshot('landscape-360')
    await run("window.mobileFixture.setLandscape(false); document.querySelector('[aria-label=\"Atualizar tela do dispositivo\"]').click()")
    await pause(150)
    win.setContentSize(1520, 580)
    await pause(150)
    view = await measure()
    assert.ok(view.overflow <= 1 && view.box.height > 150, 'the phone remains usable in a short workspace')
    await screenshot('360-short')
    win.setContentSize(1520, 950)
    await run("window.mobileFixture.workspace.setColumnWidth(580)")
    await pause(150)

    await run("window.mobileFixture.workspace.closePanel('mobile')")
    await pause(350)
    const hidden = await measure()
    await pause(1050)
    const hiddenLater = await measure()
    assert.equal(hiddenLater.captures, hidden.captures, 'closing the panel suspends screenshot polling')
    assert.equal(hiddenLater.stopped, false, 'closing the panel never stops the device')
    assert.equal(await run("window.mobileFixture.calls.some(c => c[0] === 'video' && c[3] === false)"), true)
    await run("window.mobileFixture.workspace.openPanel('mobile')")
    await pause(400)

    await run(`(() => {
      const state = window.mobileFixture.snapshot();
      window.mobileFixture.change({ ...state, sessions: [], devices: [], platforms: state.platforms.map(p => p.platform === 'android'
        ? { ...p, available: false, inputAvailable: false, reason: 'Android SDK não encontrado.', setupSteps: ['Instale o Android Studio e o Android SDK.', 'No SDK Manager, instale Platform-Tools e Android Emulator.', 'No Device Manager, crie um dispositivo virtual.'] } : p) });
    })()`)
    await pause(150)
    assert.match(await run("document.querySelector('.dock-mobile').innerText"), /Android SDK não encontrado/)
    assert.ok((await measure()).overflow <= 1)
    await screenshot('setup')

    await run(`(() => {
      const state = window.mobileFixture.snapshot();
      window.mobileFixture.change({ ...state, hostPlatform: 'darwin', platforms: state.platforms.map(p => ({ ...p, supported: true, available: true, inputAvailable: p.platform === 'android', setupSteps: [], reason: p.platform === 'ios' ? 'Instale idb para controlar toques e texto.' : undefined })),
        devices: [{ id: 'iphone', name: 'iPhone de teste', runtime: 'iOS', platform: 'ios', state: 'available' }],
        sessions: [{ id: 'ios-fixture', missionId: 'mobile-fixture-mission', deviceId: 'iphone', deviceName: 'iPhone de teste', platform: 'ios', state: 'ready', inputAvailable: false }] });
    })()`)
    await pause(150)
    await run("document.querySelector('[aria-label=\"Selecionar iOS\"]').click()")
    await pause(150)
    assert.equal(await run("document.querySelector('[aria-label=\"Selecionar iOS\"]').disabled"), false)
    assert.equal(await run("document.querySelector('[aria-label=\"Início do dispositivo\"]').disabled"), true)
    assert.equal(await run("document.querySelector('[aria-label=\"Voltar no dispositivo\"]') === null"), true)
    assert.match(await run("document.querySelector('.mobile-input-status').textContent"), /somente visualização/)
    console.log('Mobile renderer passed: 360/580px, phone shell, portrait/landscape input, local Expo QR, mission-scoped Android opening, visibility cleanup, honest SDK and iOS capability states.')
  } finally { win.destroy() }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0))
    .catch(async error => { console.error(error.stack); (await import('electron')).app.exit(1) })
} else {
  test('Mobile panel renders and accepts scoped input in isolated Chromium with production CSS', { timeout: 30000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    await mkdir(resolve('.synkora/reports'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/mobile-render-'))
    const qr = await createRequire(import.meta.url)('qrcode').toDataURL('exp://192.0.2.10:8081', { width: 280, margin: 2 })
    buildSync({ entryPoints: ['scripts/harness/mobile.tsx'], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js'),
      define: { __MOBILE_FIXTURE_QR__: JSON.stringify(qr) } })
    const css = pathToFileURL(resolve('src/renderer/src/global.css')).href
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"><title>Mobile isolated fixture</title><link rel="stylesheet" href="${css}"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script></html>`)
    const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const code = await new Promise((done, reject) => { child.on('error', reject); child.on('close', done) })
    assert.equal(code, 0, output)
    assert.match(output, /Mobile renderer passed/)
    console.log(output.trim())
  })
}
