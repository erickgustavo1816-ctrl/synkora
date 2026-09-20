import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function inspect() {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({ width: 900, height: 680, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } })
  const run = source => win.webContents.executeJavaScript(source)
  const click = async selector => {
    const box = await run(`document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect().toJSON()`)
    assert.ok(box, selector)
    const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) }
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
    await pause(90)
  }
  try {
    await win.loadFile(join(directory, 'index.html'))
    await pause(350)
    await run('window.approvalFixture.show()')
    await pause(120)
    assert.equal(await run('window.approvalFixture.answers.length'), 0)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await pause(60)
    assert.equal(await run('window.approvalFixture.answers.length'), 0, 'Enter sem escolha não aprova')
    await writeFile(resolve('.synkora/reports/quick-approval-wide.png'), (await win.webContents.capturePage()).toPNG())
    await click('button[aria-label="Aprovar"]')
    assert.deepEqual(await run('window.approvalFixture.answers'), [{ decision: 'Aprovar' }])
    assert.equal(await run('document.querySelector("[data-quick-question]")'), null)

    await run('window.approvalFixture.show()')
    win.setContentSize(420, 680)
    await pause(180)
    const geometry = await run(`(() => {
      const card = document.querySelector('[data-quick-question]');
      const buttons = [...card.querySelectorAll('.gq-quick-option')];
      return { card: card.getBoundingClientRect().toJSON(), overflow: card.scrollWidth > card.clientWidth,
        buttons: buttons.map(button => button.getBoundingClientRect().toJSON()) };
    })()`)
    assert.ok(!geometry.overflow && geometry.card.left >= 0 && geometry.card.right <= 420)
    assert.ok(geometry.buttons.every(button => button.height >= 44 && button.left >= 0 && button.right <= 420))
    await writeFile(resolve('.synkora/reports/quick-approval-narrow.png'), (await win.webContents.capturePage()).toPNG())
    await run('window.approvalFixture.defer = true')
    await click('button[aria-label="Não aprovar"]')
    assert.equal(await run('window.approvalFixture.answers.length'), 2)
    assert.ok(await run('[...document.querySelectorAll("[data-quick-question] button")].every(button => button.disabled)'))
    await click('button[aria-label="Aprovar"]')
    assert.equal(await run('window.approvalFixture.answers.length'), 2, 'envio pendente bloqueia segundo clique')
    await run('window.approvalFixture.finish()')
    await pause(80)
    assert.deepEqual(await run('window.approvalFixture.answers[1]'), { decision: 'Não aprovar' })

    await run('window.approvalFixture.show()')
    await click('button[aria-expanded="false"]')
    assert.equal(await run('document.activeElement.getAttribute("aria-label")'), 'Sua resposta')
    await run(`(() => {
      const input = document.querySelector('.gq-custom');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Aprovo apenas a tela de projetos.');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await pause(100)
    assert.deepEqual(await run('window.approvalFixture.answers[2]'), { decision: 'Aprovo apenas a tela de projetos.' })
    await run('window.approvalFixture.show()')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await pause(100)
    assert.deepEqual(await run('window.approvalFixture.answers[3]'), {}, 'pular não envia aprovação')
    await run('window.approvalFixture.showProse()')
    await pause(700)
    assert.ok(await run('document.querySelector(".gui-ask")'), 'pedido legado de aceite mantém sua barra')
    await run(`document.querySelectorAll('.gui-ask button')[1].click()`)
    await pause(100)
    assert.deepEqual(await run('window.approvalFixture.messages'), [
      'Não aprovo a proposta que você acabou de apresentar. Não prossiga com ela.'
    ])
    console.log('PASS GuiPane: aprovação/recusa em um clique, resposta livre, sem aceite implícito, envio único e layout a 420/900 px.')
  } finally { win.destroy() }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async error => {
    console.error(error.stack); (await import('electron')).app.exit(1)
  })
} else {
  test('aprovação por botões no chat real com dados sintéticos', { timeout: 25000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    await mkdir(resolve('.synkora/reports'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/quick-approval-'))
    buildSync({ stdin: { contents: `
      import { createRoot } from 'react-dom/client'
      import GuiPane from './components/GuiPane'
      import { installDevMock } from './devMock'
      import { useStore, applyGuiEvent, EMPTY_GUI_PANE } from './store'
      installDevMock()
      const paneId = 'gui-synthetic-approval'
      window.synkora.gui.state = async () => ({ exists: true, alive: true, cursor: 0, events: [] })
      const fixture = window.approvalFixture = { answers: [], messages: [], defer: false, finish() {}, show() {}, showProse() {} }
      let sequence = 0
      const emit = evt => useStore.setState(s => ({ guiPanes: {
        ...s.guiPanes, [paneId]: applyGuiEvent(s.guiPanes[paneId] ?? { ...EMPTY_GUI_PANE }, evt)
      } }))
      fixture.show = () => {
        fixture.defer = false
        emit({ type: 'question', requestId: 'approval-' + (++sequence), blocking: false, asynchronous: true,
          questions: [{ id: 'decision', header: 'Aprovação', question: 'Aprova adicionar a busca por nome na tela de projetos?',
            options: [{ label: 'Aprovar', description: 'Implementar a busca proposta.' },
              { label: 'Não aprovar', description: 'Manter a tela como está.' }], allowCustom: true }] })
      }
      fixture.showProse = () => {
        emit({ type: 'ready', caps: { models: [], commands: [] } })
        emit({ type: 'text', text: 'Posso seguir?' })
        emit({ type: 'result', isError: false })
      }
      window.synkora.gui.send = async (pane, text) => {
        if (pane !== paneId) throw new Error('wrong synthetic scope')
        fixture.messages.push(text)
        return { ok: true }
      }
      window.synkora.gui.answerQuestion = async (pane, requestId, answers) => {
        if (pane !== paneId || requestId !== 'approval-' + sequence) throw new Error('wrong synthetic scope')
        fixture.answers.push(answers)
        const finish = () => {
          emit({ type: 'interaction-resolved', requestId,
            resolution: { kind: 'question', entries: Object.values(answers).map(answer => ({ question: 'Proposta sintética', answer })) } })
          return { ok: true }
        }
        if (fixture.defer) return new Promise(resolve => { fixture.finish = () => resolve(finish()) })
        return finish()
      }
      createRoot(document.getElementById('root')).render(<GuiPane paneId={paneId} projectId="synthetic"
        cli="codex" cwd="synthetic" showHeader={false} active />)
    `, resolveDir: resolve('src/renderer/src'), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Aprovação sintética</title><link rel="stylesheet" href="${pathToFileURL(resolve('src/renderer/src/global.css')).href}"><link rel="stylesheet" href="fixture.css"><div id="root" style="height:100vh;padding:16px"></div><script src="fixture.js"></script></html>`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory], {
      env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.equal(code, 0, output)
    console.log(output.trim())
  })
}
