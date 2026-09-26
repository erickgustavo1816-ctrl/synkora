import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

const continuation = 'Texto sintético posterior com palavras suficientes para observar a revelação. '.repeat(45)
const question = (requestId, extra = {}) => ({
  type: 'question', requestId, blocking: false, asynchronous: true,
  questions: [{ id: 'decision', question: 'Qual caminho seguir?', options: [
    { label: 'Primeiro' }, { label: 'Segundo' }
  ], allowCustom: true }], ...extra
})

async function inspectStability(win, run, scenario) {
  const emit = (...events) => run(`window.approvalFixture.emit(${JSON.stringify(events)})`)
  const waitFor = async (source, message) => {
    const deadline = Date.now() + 6000
    while (Date.now() < deadline) {
      if (await run(source)) return
      await pause(20)
    }
    assert.fail(message)
  }
  const click = async selector => {
    assert.ok(await run(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), selector)
    await run(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await pause(30)
  }
  const type = async (selector, value) => {
    await run(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.focus();
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await pause(30)
  }
  const waitForText = text => waitFor(
    `[...document.querySelectorAll('.gui-msg.dev .gui-msg-text')].at(-1)?.textContent.trim() === ${JSON.stringify(text.trim())}`,
    'o escritor não revelou o texto sintético'
  )
  const remember = (card, input) => run(`window.savedCard = document.querySelector(${JSON.stringify(card)});
    window.savedInput = document.querySelector(${JSON.stringify(input)});`)
  const assertPreserved = async (selector, value) => {
    assert.deepEqual(await run(`({
      connected: window.savedCard.isConnected,
      sameInput: window.savedInput === document.querySelector(${JSON.stringify(selector)}),
      value: window.savedInput.value,
      focused: document.activeElement === window.savedInput
    })`), { connected: true, sameInput: true, value, focused: true }, `${scenario}: card, rascunho e foco preservados`)
  }
  const observeCards = () => run(`(() => {
    window.cardMounts = [];
    window.cardObserver?.disconnect();
    window.cardObserver = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && node.matches('.gui-question, .gui-plan, .gui-proposal')) {
          window.cardMounts.push(node.className);
        }
      }
    });
    window.cardObserver.observe(document.getElementById('root'), { childList: true, subtree: true });
  })()`)

  if (scenario === 'presentation') {
    await observeCards()
    await emit({ type: 'delta', text: continuation }, question('first'), question('second'))
    await pause(100)
    assert.deepEqual(await run('window.cardMounts'), [], 'texto + card no mesmo lote não monta antes de onBusy')
    await waitForText(continuation)
    await waitFor('Boolean(document.querySelector(".gui-question"))', 'pergunta async deve aparecer na pausa do stream')
    assert.deepEqual(await run('window.approvalFixture.pendingIds()'), ['first', 'second'])
    await click('button[aria-label="Primeiro"]')
    await waitFor('window.approvalFixture.pendingIds()[0] === "second"', 'FIFO deve promover o segundo pedido')
    await waitFor('Boolean(document.querySelector(".gui-question"))', 'segundo pedido aparece após resolução do primeiro')
    assert.deepEqual(await run('window.approvalFixture.requests'), ['first'])
    await click('button[aria-expanded="false"]')
    await type('.gq-custom', 'rascunho do segundo')
    await observeCards()
    await emit({ type: 'delta', text: continuation }, { type: 'permission-cancel', requestId: 'second' }, question('third'))
    await pause(100)
    assert.deepEqual(await run('window.cardMounts'), [], 'ID novo aguarda novo delta do escritor já observado')
    await waitForText(continuation + continuation)
    await waitFor('Boolean(document.querySelector(".gui-question"))', 'pedido novo deve estrear ao alcançar o stream')
    assert.equal(await run('document.querySelector(".gq-custom")'), null, 'rascunho não atravessa requestId')
    assert.deepEqual(await run('window.approvalFixture.pendingIds()'), ['third'])
    console.log('PASS apresentação: lote texto+card, pausa viva, FIFO, cancelamento e novo ID após nova rajada.')
    return
  }

  if (scenario === 'previous-writer') {
    await emit({ type: 'text', text: continuation })
    await pause(100)
    await observeCards()
    await emit({ type: 'delta', text: 'Outro texto sintético posterior.' }, question('after-writers'))
    await pause(100)
    assert.deepEqual(await run('window.cardMounts'), [], 'card aguarda escritor anterior ainda pendente')
    await waitFor('Boolean(document.querySelector(".gui-question"))', 'pedido retido pelos dois escritores deve aparecer')
    assert.deepEqual(await run('[...document.querySelectorAll(".gui-msg.dev .gui-msg-text")].map(node => node.textContent.trim())'),
      [continuation.trim(), 'Outro texto sintético posterior.'])
    assert.equal(await run('window.cardMounts.length'), 1, 'pedido só monta uma vez após todo o texto anterior')
    console.log('PASS apresentação: escritor anterior pendente e segundo texto respeitados.')
    return
  }

  let selector = '.gui-question'
  let input = '.gq-custom'
  const draft = 'rascunho sintético preservado'
  if (scenario === 'plan-review') {
    selector = '.gui-plan'
    input = '.gui-plan-actions button'
    await emit({ type: 'plan-review', requestId: 'review', plan: '- Plano sintético' })
    await waitFor('Boolean(document.querySelector(".gui-plan"))', 'plano deve aparecer')
    await run('document.querySelector(".gui-plan-actions button").focus()')
  } else if (scenario === 'plan-proposal') {
    selector = '.gui-proposal'
    input = '.gpa-input'
    await emit({ type: 'delta', text: 'Introdução sintética.' },
      { type: 'plan-proposal', requestId: 'proposal', draft: { title: 'Plano sintético', items: [] } })
    await waitForText('Introdução sintética.')
    assert.equal(await run('document.querySelector(".gui-proposal")'), null, 'proposta nova espera encerrar o turno')
    await emit({ type: 'result', isError: false })
    await waitFor('Boolean(document.querySelector(".gui-proposal"))', 'proposta deve aparecer após o turno')
    await click('.gui-proposal-actions button:last-child')
    await type(input, draft)
  } else {
    const extra = scenario === 'mini-plan' ? { plan: '1. Estudar a tela\n2. Ajustar o card' }
      : scenario === 'questionnaire' ? { questions: [
        { id: 'first', question: 'Primeira pergunta', options: [{ label: 'Escolha inicial' }], allowCustom: true },
        { id: 'second', question: 'Segunda pergunta', options: [], allowCustom: true }
      ] } : {}
    await emit(question('stable', extra))
    await waitFor('Boolean(document.querySelector(".gui-question"))', 'pergunta deve aparecer')
    if (scenario === 'questionnaire') {
      await click('.gq-option[role="radio"]')
      await click('.gui-question-actions .primary')
      assert.equal(await run('document.querySelector(".gq-count").textContent'), '2/2')
    } else {
      await click('button[aria-expanded="false"]')
    }
    if (scenario === 'mini-plan') assert.ok(await run('document.querySelector("[data-question-plan]")?.textContent.includes("Ajustar o card")'))
    await type(input, draft)
  }
  await remember(selector, input)
  await emit({ type: 'delta', text: continuation })
  await pause(100)
  assert.ok(await run(`document.querySelector('.gui-msg.dev.stream .gui-msg-text')?.textContent.trim().length < ${continuation.trim().length}`), 'regressão deve observar texto ainda pendente')
  if (scenario === 'plan-review') {
    assert.ok(await run('window.savedCard.isConnected && document.activeElement === window.savedInput'), 'plano permanece montado e focado durante a escrita')
  } else {
    await assertPreserved(input, draft)
  }
  await waitForText(continuation)
  if (scenario !== 'plan-review') await assertPreserved(input, draft)
  if (scenario === 'questionnaire') assert.equal(await run('document.querySelector(".gq-count").textContent'), '2/2')
  if (scenario === 'plan-proposal') {
    await click('.gui-proposal-actions .primary')
    assert.deepEqual(await run('window.approvalFixture.decisions'), [{ requestId: 'proposal', approve: false, note: draft }])
    await emit({ type: 'result', isError: false }, { type: 'plan-proposal', requestId: 'proposal-new', draft: { title: 'Nova proposta', items: [] } })
    await waitFor('Boolean(document.querySelector(".gui-proposal"))', 'nova proposta aparece')
    assert.equal(await run('document.querySelector(".gpa-input")'), null, 'novo plano não herda ajuste')
  } else if (scenario === 'plan-review') {
    await click('.gui-plan-actions .primary')
    assert.deepEqual(await run('window.approvalFixture.decisions'), [{ requestId: 'review', approve: true }])
  } else {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
    await waitFor('window.approvalFixture.answers.length === 1', 'resposta preservada deve ser enviada uma vez')
    assert.deepEqual(await run('window.approvalFixture.answers'), [scenario === 'questionnaire'
      ? { first: 'Escolha inicial', second: draft } : { decision: draft }])
    assert.deepEqual(await run('window.approvalFixture.requests'), ['stable'])
  }
  assert.equal(await run('window.savedCard.isConnected'), false, 'resolução remove o pedido antigo')
  console.log(`PASS ${scenario}: mesmo card, estado e foco durante/depois da revelação; decisão única preservada.`)
}

async function inspect() {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({ width: 900, height: 680, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
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
    if (process.argv[3] !== 'actions') {
      await inspectStability(win, run, process.argv[3])
      return
    }
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
  for (const scenario of ['actions', 'quick-question', 'questionnaire', 'mini-plan', 'plan-review', 'plan-proposal', 'presentation', 'previous-writer']) {
  test(`GuiPane sintético: ${scenario}`, { timeout: 25000 }, async t => {
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
      const fixture = window.approvalFixture = { answers: [], requests: [], decisions: [], messages: [], defer: false, finish() {}, show() {}, showProse() {} }
      let sequence = 0
      const emit = (...events) => useStore.setState(s => ({ guiPanes: {
        ...s.guiPanes, [paneId]: events.reduce(applyGuiEvent, s.guiPanes[paneId] ?? { ...EMPTY_GUI_PANE })
      } }))
      fixture.emit = events => emit(...events)
      fixture.pendingIds = () => useStore.getState().guiPanes[paneId].interactionQueue.map(item => item.requestId)
      useStore.setState({ settings: { ...useStore.getState().settings, chatWritingWordsPerSecond: 20, chatWritingMaxLagMs: 1500 } })
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
        if (pane !== paneId || requestId !== fixture.pendingIds()[0]) throw new Error('wrong synthetic scope or FIFO')
        fixture.answers.push(answers)
        fixture.requests.push(requestId)
        const finish = () => {
          emit({ type: 'interaction-resolved', requestId,
            resolution: { kind: 'question', entries: Object.values(answers).map(answer => ({ question: 'Proposta sintética', answer })) } })
          return { ok: true }
        }
        if (fixture.defer) return new Promise(resolve => { fixture.finish = () => resolve(finish()) })
        return finish()
      }
      window.synkora.gui.answerPlan = async (pane, requestId, approve) => {
        if (pane !== paneId || requestId !== fixture.pendingIds()[0]) throw new Error('wrong synthetic plan scope')
        fixture.decisions.push({ requestId, approve })
        emit({ type: 'interaction-resolved', requestId, resolution: { kind: 'plan', approve } })
        return { ok: true }
      }
      window.synkora.gui.answerPlanProposal = async (pane, requestId, approve, note) => {
        if (pane !== paneId || requestId !== fixture.pendingIds()[0]) throw new Error('wrong synthetic proposal scope')
        fixture.decisions.push({ requestId, approve, note })
        emit({ type: 'interaction-resolved', requestId, resolution: { kind: 'plan-proposal', approve, note } })
        return { ok: true }
      }
      createRoot(document.getElementById('root')).render(<GuiPane paneId={paneId} projectId="synthetic"
        cli="codex" cwd="synthetic" showHeader={false} active />)
    `, resolveDir: resolve('src/renderer/src'), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Aprovação sintética</title><link rel="stylesheet" href="${pathToFileURL(resolve('src/renderer/src/global.css')).href}"><link rel="stylesheet" href="fixture.css"><div id="root" style="height:100vh;padding:16px"></div><script src="fixture.js"></script></html>`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory, scenario], {
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
}
