import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const baseline = process.argv.includes('--baseline')

async function inspect() {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({ width: 900, height: 760, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const measure = () => run(`(() => {
    const inner = document.querySelector('.gui-composer-inner');
    const rect = element => element.getBoundingClientRect().toJSON();
    const input = document.querySelector('.gui-input'), overlay = document.querySelector('.gui-mention-overlay');
    const error = document.querySelector('.gui-composer-notice');
    const errorRange = document.createRange();
    if (error) errorRange.selectNodeContents(error);
    const scrollbar = getComputedStyle(input, '::-webkit-scrollbar');
    const thumb = getComputedStyle(input, '::-webkit-scrollbar-thumb');
    return { fit: inner.dataset.fit, surface: rect(inner.parentElement), input: rect(input),
      inputScroll: input.scrollWidth, inputClient: input.clientWidth,
      inputScrollHeight: input.scrollHeight, inputClientHeight: input.clientHeight, inputScrollTop: input.scrollTop,
      scrollbar: { display: scrollbar.display, width: parseFloat(scrollbar.width), color: thumb.backgroundColor,
        nativeWidth: getComputedStyle(input).scrollbarWidth, hovered: input.matches(':hover') },
      overlay: overlay ? rect(overlay) : null,
      overlayClient: overlay?.clientWidth, overlayScrollHeight: overlay?.scrollHeight, overlayScrollTop: overlay?.scrollTop,
      attachmentError: error ? { box: rect(error), width: error.clientWidth, scrollWidth: error.scrollWidth,
        inComposer: inner.contains(error), text: error.textContent,
        lines: [...errorRange.getClientRects()].map(box => box.toJSON()) } : null,
      controls: [...inner.querySelectorAll('.gui-attach-btn, .gui-composer-mode > button, .gui-context-trigger, .mode-model, .mode-effort, .gui-fast-btn, .gui-send')].map(rect),
      labels: [...inner.querySelectorAll('button > span')].filter(node => getComputedStyle(node).visibility !== 'hidden').map(node => ({ box: rect(node), button: rect(node.parentElement) })) };
  })()`)
  const fits = state => {
    for (const box of [state.input, state.overlay, ...state.controls].filter(Boolean)) {
      assert.ok(box.left >= state.surface.left && box.right <= state.surface.right, JSON.stringify(state))
    }
    for (let i = 1; i < state.controls.length; i++) {
      assert.ok(state.controls[i].left >= state.controls[i - 1].right - 1, `overlapping controls: ${JSON.stringify(state)}`)
    }
    assert.ok(state.inputScroll <= state.inputClient + 1, 'typed text must wrap inside the editor')
    if (state.attachmentError) {
      const error = state.attachmentError
      assert.equal(error.inComposer, false, 'the transient notice lives in a portal, outside the composer grid')
      assert.ok(error.scrollWidth <= error.width + 1, 'long attachment errors must wrap without horizontal overflow')
      assert.ok(error.box.left >= state.surface.left && error.box.right <= state.surface.right,
        'the popup stays within the chat width')
      assert.ok(error.box.bottom <= state.surface.top - 1, 'the popup floats above the composer')
      assert.ok(error.box.top >= 0, 'the popup remains visible in the viewport')
      assert.ok(error.lines.length > 1, 'the notice keeps a readable heading and message')
    }
    if (state.overlay) {
      const alignment = JSON.stringify({ input: state.input, overlay: state.overlay })
      assert.equal(state.input.width, state.overlay.width, 'painted text must share the editor width')
      assert.equal(state.inputClient, state.overlayClient, 'scrollbar gutters must preserve identical text wrapping in both layers')
      assert.ok(Math.abs(state.input.top - state.overlay.top) <= 1, 'caret and painted text must stay aligned: ' + alignment)
      assert.ok(Math.abs(state.input.height - state.overlay.height) <= 1, 'editor and painted text must share their height: ' + alignment)
      assert.ok(Math.abs(state.inputScrollHeight - state.overlayScrollHeight) <= 1, 'painted text and caret must have the same scroll range')
      assert.ok(Math.abs(state.inputScrollTop - state.overlayScrollTop) <= 1, 'painted text must follow the caret scroll position')
    }
    for (const { box, button } of state.labels) {
      assert.ok(box.left >= button.left && box.right <= button.right, `label escapes its control: ${JSON.stringify(state)}`)
    }
  }
  const replaceDraft = async text => {
    await run(`(() => { const input = document.querySelector('.gui-input'); input.focus(); input.select(); })()`)
    await win.webContents.insertText(text)
    await pause(180)
  }
  const matchesNativeText = async () => {
    await run('document.activeElement?.blur()')
    const box = (await measure()).input
    const viewport = await run('({ width: innerWidth, height: innerHeight })')
    const painted = await win.webContents.capturePage()
    await run(`(() => {
      const input = document.querySelector('.gui-input');
      input.style.setProperty('color', 'var(--ink)', 'important');
      input.style.setProperty('-webkit-text-fill-color', 'var(--ink)', 'important');
      document.querySelector('.gui-mention-overlay').style.visibility = 'hidden';
    })()`)
    await pause(40)
    const native = await win.webContents.capturePage()
    await run(`(() => {
      const input = document.querySelector('.gui-input');
      input.style.removeProperty('color'); input.style.removeProperty('-webkit-text-fill-color');
      document.querySelector('.gui-mention-overlay').style.removeProperty('visibility');
    })()`)
    const size = painted.getSize(), a = painted.toBitmap(), b = native.toBitmap()
    assert.equal(a.length, size.width * size.height * 4)
    assert.equal(a.length, b.length)
    const left = Math.ceil(box.left * size.width / viewport.width)
    const right = Math.floor(box.right * size.width / viewport.width)
    const top = Math.ceil(box.top * size.height / viewport.height)
    const bottom = Math.floor(box.bottom * size.height / viewport.height)
    const ink = (pixels, x, y) => {
      const i = (y * size.width + x) * 4
      return pixels[i] < 140 && pixels[i + 1] < 140 && pixels[i + 2] < 140
    }
    let total = 0, displaced = 0
    for (const [from, to] of [[a, b], [b, a]]) {
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        if (!ink(from, x, y)) continue
        total++
        let found = false
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (ink(to, x + dx, y + dy)) found = true
        }
        if (!found) displaced++
      }
    }
    if (displaced > total * 0.02) {
      await writeFile(resolve('.synkora/reports/composer-caret-before.png'), painted.toPNG())
      await writeFile(resolve('.synkora/reports/composer-caret-native-reference.png'), native.toPNG())
    }
    assert.ok(total > 50, 'the fixture contains visible typed text')
    assert.ok(displaced <= total * 0.02,
      'painted text must match the native text that owns the caret: ' + JSON.stringify({ displaced, total, box, zoom: win.webContents.getZoomFactor() }))
  }
  const scrolls = async () => {
    let state = await measure()
    assert.ok(state.inputScrollHeight > state.inputClientHeight + 1, 'long drafts must overflow vertically')
    assert.notEqual(state.scrollbar.display, 'none', 'long drafts need a visible scrollbar')
    assert.notEqual(state.scrollbar.nativeWidth, 'none', 'the editor must not suppress the scrollbar')
    assert.ok(state.scrollbar.width >= 6 && state.scrollbar.width <= 12, 'the scrollbar must use a minimal usable track')
    assert.ok(state.input.width - state.inputClient >= state.scrollbar.width, 'the visible scrollbar needs a reserved gutter')
    assert.notEqual(state.scrollbar.color, 'rgba(0, 0, 0, 0)', 'the scrollbar thumb must be visible without hovering')
    assert.equal(state.scrollbar.hovered, false, 'visibility is checked without hovering over the input')
    for (const position of [0, 0.5, 1]) {
      await run(`(() => { const input = document.querySelector('.gui-input'); input.scrollTop = (input.scrollHeight - input.clientHeight) * ${position}; input.dispatchEvent(new Event('scroll', { bubbles: true })); })()`)
      await pause(60)
      state = await measure()
      fits(state)
      assert.ok(Math.abs(state.inputScrollTop - Math.round((state.inputScrollHeight - state.inputClientHeight) * position)) <= 1, 'the entire draft must remain reachable')
    }
  }
  try {
    await win.loadFile(join(directory, 'index.html'))
    await pause(350)
    for (const width of [420, 780]) {
      await run(`document.querySelector('.fixture-chat').style.width = '${width}px'`)
      for (const scenario of [
        { name: 'file', text: '', kinds: ['file'] },
        { name: 'folder', text: ' \n\t ', kinds: ['folder'] },
        { name: 'multiple', text: '', kinds: ['file', 'folder', 'file'] },
        { name: 'caption', text: 'Confira estes anexos.\nSegunda linha preservada.', kinds: ['file', 'folder'] },
        { name: 'text', text: 'Mensagem com texto.', kinds: [] },
        { name: 'queued', text: ' \n ', kinds: ['file', 'folder'], queued: true }
      ]) {
        await run(`window.composerFixture.message(${JSON.stringify(scenario)})`)
        await pause(200)
        const message = await run(`(() => {
          const owner = document.querySelector('.gui-msg.user');
          const rect = node => node.getBoundingClientRect().toJSON();
          const text = owner.querySelector('.gui-msg-text');
          return { box: rect(owner), tag: rect(owner.querySelector('.gui-msg-tag')),
            text: text?.textContent ?? null,
            chips: [...owner.querySelectorAll('.gui-attachment-chip')].map(rect),
            actions: [...owner.querySelectorAll('.gui-owner-force')].map(node => node.textContent.trim()),
            viewportWidth: document.querySelector('.fixture-chat').clientWidth };
        })()`)
        if (['file', 'folder', 'multiple', 'queued'].includes(scenario.name)) {
          await writeFile(resolve('.synkora/reports/attachment-only-' + scenario.name + '-' + width + '-' + (baseline ? 'before' : 'after') + '.png'),
            (await win.webContents.capturePage()).toPNG())
        }
        assert.equal(message.text, scenario.text.trim() ? scenario.text : null,
          `${scenario.name}: attachment-only messages must not draw an empty text bubble: ${JSON.stringify(message)}`)
        assert.equal(message.chips.length, scenario.kinds.length, 'all attachments remain visible')
        assert.ok(message.box.left >= 0 && message.box.right <= message.viewportWidth, 'the message stays within the chat')
        for (const chip of message.chips) {
          assert.ok(chip.left >= message.box.left - 1 && chip.right <= message.box.right + 1,
            `attachment escapes its message: ${JSON.stringify(message)}`)
          if (!message.chips.some(other => Math.abs(other.top - chip.top) < 1 && other.right > chip.right)) {
            assert.ok(Math.abs(chip.right - message.tag.right) <= 1,
              `each attachment row aligns with the owner label: ${JSON.stringify(message)}`)
          }
        }
        if (scenario.queued) assert.deepEqual(message.actions, ['ler agora', 'cancelar'], 'attachment-only queue keeps both delivery actions')
      }
    }
    await run("window.composerFixture.owner('read')")
    for (const width of [780, 420, 500]) {
      await run(`document.querySelector('.fixture-chat').style.width = '${width}px'`)
      await pause(180)
      fits(await measure())
    }
    await replaceDraft('Texto curto sintético.')
    let shortState = await measure()
    fits(shortState)
    assert.ok(shortState.inputScrollHeight <= shortState.inputClientHeight + 1, 'short drafts must not need a vertical scrollbar')
    const paragraphDraft = 'Texto sintético para conferir o alinhamento ao escrever uma mensagem.\n\nOutra linha sintética para continuar a edição.'
    for (const zoom of [1, 1.25]) {
      win.webContents.setZoomFactor(zoom)
      for (const width of [375, 420, 470, 500]) {
        await run(`document.querySelector('.fixture-chat').style.width = '${width}px'`)
        await replaceDraft(paragraphDraft)
        fits(await measure())
        await matchesNativeText()
      }
    }
    win.webContents.setZoomFactor(1)
    const columns = await run(`(() => {
      const input = document.querySelector('.gui-input'), style = getComputedStyle(input);
      const context = document.createElement('canvas').getContext('2d'); context.font = style.font;
      return Math.floor((input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) / context.measureText('m').width);
    })()`)
    for (const delta of [-1, 0, 1]) for (const spaces of [0, 1, 2, 4]) {
      await replaceDraft('Texto sintético.\n\n' + 'm'.repeat(columns + delta) + ' '.repeat(spaces))
      const edgeState = await measure()
      if (Math.abs(edgeState.input.top - edgeState.overlay.top) > 1) {
        console.log('Reproduced trailing-space displacement', { columns, delta, spaces })
        await writeFile(resolve('.synkora/reports/composer-caret-before.png'), (await win.webContents.capturePage()).toPNG())
      }
      fits(edgeState)
      if (!baseline && delta === -1 && spaces === 2) {
        const box = edgeState.surface
        await writeFile(resolve('.synkora/reports/composer-caret-after.png'), (await win.webContents.capturePage({
          x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height)
        })).toPNG())
      }
      await matchesNativeText()
    }
    for (const ending of ['\n', '\n\n', '\n ', '\n\t', '\n   ']) {
      await replaceDraft(paragraphDraft + ending)
      fits(await measure())
      await matchesNativeText()
    }
    const longDraft = ('Texto sintético para conferir a quebra de linhas no campo de mensagem. '.repeat(8) + '\n' + 'pasta_sintetica/'.repeat(15) + 'arquivo.png\n').repeat(6)
    await replaceDraft(longDraft)
    let state = await measure()
    await writeFile(resolve('.synkora/reports/composer-layout-' + (baseline ? 'before' : 'after') + '.png'), (await win.webContents.capturePage()).toPNG())
    fits(state)
    await scrolls()
    // A question temporarily removes the composer without unmounting GuiPane.
    await run('window.composerFixture.question(true)')
    await pause(120)
    await run('window.composerFixture.question(false)')
    await pause(180)
    for (const width of [420, 780, 420]) {
      await run(`document.querySelector('.fixture-chat').style.width = '${width}px'`)
      await pause(180)
      state = await measure()
      await writeFile(resolve('.synkora/reports/composer-layout-' + (baseline ? 'before' : 'after') + '.png'), (await win.webContents.capturePage()).toPNG())
      fits(state)
      await scrolls()
    }
    await writeFile(resolve('.synkora/reports/composer-scrollbar-' + (baseline ? 'before' : 'after') + '.png'), (await win.webContents.capturePage()).toPNG())
    await replaceDraft('O texto voltou a caber no campo.')
    shortState = await measure()
    fits(shortState)
    assert.ok(shortState.inputScrollHeight <= shortState.inputClientHeight + 1, 'the scrollbar must stop scrolling when the draft fits again')
    assert.equal(shortState.inputScrollTop, 0, 'shortening the draft restores the top of both layers')
    await run("window.composerFixture.owner('unread')")
    await pause(120)
    assert.equal(await run("document.querySelectorAll('.gui-msg.user .gui-owner-force').length"), 2, 'unread authoritative bubble keeps read-now and cancel')
    await writeFile(resolve('.synkora/reports/queued-message-actions-after.png'), (await win.webContents.capturePage()).toPNG())
    await run("document.querySelector('.gui-msg.user .gui-owner-cancel').click()")
    await pause(100)
    // Cancelar some com a bolha (ordem do dono, 2026-09-16): nem carimbo, nem mensagem.
    assert.equal(await run("document.querySelector('.gui-owner-state-cancelled')"), null)
    assert.equal(await run("document.querySelector('.gui-msg.user')"), null, 'a cancelled bubble leaves the thread')
    assert.equal(await run("document.querySelectorAll('.gui-msg.user .gui-owner-force').length"), 0)
    await run("window.composerFixture.owner('unread')")
    await pause(100)
    await run("document.querySelector('.gui-msg.user .gui-owner-force').click()")
    await pause(100)
    assert.equal(await run("document.querySelectorAll('.gui-msg.user .gui-owner-force').length"), 0, 'read receipt removes both pending actions')
    const heightBeforeError = (await measure()).surface.height
    await run(`(() => {
      const rejectedFile = new File([new Uint8Array(51 * 1024 * 1024)],
        'DOCUMENTO_SINTETICO_'.repeat(12) + '.txt', { type: 'text/plain' });
      window.composerFixture.rejectAttachment = () => {
        const transfer = new DataTransfer();
        transfer.items.add(rejectedFile);
        const picker = document.querySelector('input[type="file"]');
        picker.files = transfer.files;
        picker.dispatchEvent(new Event('change', { bubbles: true }));
      };
      window.composerFixture.rejectAttachment();
    })()`)
    await pause(180)
    for (const width of [420, 500, 780]) {
      await run(`document.querySelector('.fixture-chat').style.width = '${width}px'`)
      await pause(180)
      const state = await measure()
      assert.ok(state.attachmentError, 'the real upload failure must be displayed')
      assert.ok(state.attachmentError.text.includes('50 MB'))
      assert.ok(state.attachmentError.text.length < 180, 'the notice keeps a concise filename and error')
      assert.equal(state.surface.height, heightBeforeError, 'the error must not change the composer height')
      await writeFile(resolve('.synkora/reports/attachment-error-' + width + '-' + (baseline ? 'before' : 'after') + '.png'),
        (await win.webContents.capturePage()).toPNG())
      fits(state)
    }
    assert.equal(await run("document.querySelectorAll('.gui-composer-inner [role=alert]').length"), 0)
    assert.equal(await run("document.activeElement === document.querySelector('.gui-input')"), true,
      'the popup does not steal typing focus')
    await pause(3000)
    await run('window.composerFixture.rejectAttachment()')
    await pause(2200)
    assert.ok((await measure()).attachmentError, 'the same error restarts its visible time')
    await pause(3100)
    assert.equal((await measure()).attachmentError, null, 'the popup dismisses automatically')
    await run('window.composerFixture.rejectAttachment()')
    await pause(100)
    await run("document.querySelector('.gui-composer-notice button[aria-label=\"Fechar aviso\"]').click()")
    await pause(100)
    assert.equal((await measure()).attachmentError, null, 'the owner can dismiss it sooner')
    console.log('PASS real GuiPane: caret/text alignment at wrapping boundaries and trailing spaces/newlines, native text raster comparison at 100/125% zoom, attachment rows, scrolling, remounting, transient notices and preserved typing focus.')
  } finally { win.destroy() }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async error => {
    console.error(error.stack); (await import('electron')).app.exit(1)
  })
} else {
  test('composer text and actions fit at the minimum chat width after typing and remounting', { timeout: 45000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    await mkdir(resolve('.synkora/reports'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/composer-layout-'))
    buildSync({ stdin: { contents: `
      import { createRoot } from 'react-dom/client'
      import GuiPane from './components/GuiPane'
      import { installDevMock } from './devMock'
      import { useStore } from './store'
      installDevMock()
      const paneId = 'gui-synthetic-composer'
      const events = [
        { type: 'ready', caps: { models: [{ value: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', supportsFastMode: true, supportedEffortLevels: ['high'] }], commands: [] } },
        { type: 'context-usage', contextTokens: 32000, contextWindow: 100000 }
      ]
      window.synkora.gui.state = async () => ({ exists: true, alive: true, cursor: events.length, events: events.map((evt, i) => ({ seq: i + 1, evt })) })
      const owner = state => useStore.setState(s => ({ guiPanes: { ...s.guiPanes, [paneId]: {
        ...s.guiPanes[paneId], queued: null, status: 'idle', items: [{ id: 'owner-synthetic', kind: 'user', text: 'Mensagem sintética pendente de leitura.', delivery: { state, at: Date.now() } }]
      } } }))
      window.synkora.gui.cancelOwnerMessage = async () => { owner('cancelled'); return { ok: true } }
      window.synkora.gui.forceOwnerMessage = async () => { owner('read'); return { ok: true } }
      window.composerFixture = { owner, message({ text, kinds, queued = false }) {
        const message = { id: 'attachment-synthetic', text, at: Date.now(),
          options: { model: null, effort: null, permissionMode: 'default' },
          attachments: kinds.map((kind, i) => ({ id: 'synthetic-' + i, kind,
            capability: 'gui-cap-v1-' + 'A'.repeat(43),
            name: (kind === 'folder' ? 'PASTA_SINTETICA_' : 'DOCUMENTO_SINTETICO_').repeat(6) + i + (kind === 'file' ? '.txt' : ''),
            mime: kind === 'file' ? 'text/plain' : null, size: kind === 'file' ? 10 * 1024 * 1024 : null })) }
        useStore.setState(s => ({ guiPanes: { ...s.guiPanes, [paneId]: { ...s.guiPanes[paneId],
          status: queued ? 'working' : 'idle', queued: queued ? message : null,
          items: queued ? [] : [{ ...message, kind: 'user', delivery: { state: 'unread', at: Date.now() } }]
        } } }))
      }, question(open) {
        useStore.setState(s => ({ guiPanes: { ...s.guiPanes, [paneId]: { ...s.guiPanes[paneId],
          question: open ? { requestId: 'question-synthetic', questions: [{ question: 'Escolha de teste', options: [{ label: 'Continuar', description: 'Continuar o teste' }] }] } : null
        } } }))
      } }
      createRoot(document.getElementById('root')).render(<div className="fixture-chat" style={{ width: 780, height: '100%', display: 'flex' }}>
        <GuiPane paneId={paneId} projectId="synthetic" cli="codex" cwd="synthetic" model="gpt-5.6-sol" effort="high" permissionMode="bypass" showHeader={false} />
      </div>)
    `, resolveDir: resolve('src/renderer/src'), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
    const css = pathToFileURL(resolve('src/renderer/src/global.css')).href
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Composer fixture</title><link rel="stylesheet" href="${css}"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script></html>`)
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory, ...(baseline ? ['--baseline'] : [])], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.equal(code, 0, output)
    console.log(output.trim())
  })
}
