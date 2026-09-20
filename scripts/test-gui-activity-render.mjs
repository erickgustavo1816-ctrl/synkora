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
  const win = new BrowserWindow({ width: 840, height: 700, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const push = async event => {
    await run(`window.activityFixture.event(${JSON.stringify(event)})`)
    await pause(80)
  }
  const patch = async state => {
    await run(`window.activityFixture.patch(${JSON.stringify(state)})`)
    await pause(80)
  }
  const expectActivity = async (label, backgroundCount = 0) => {
    const actual = await run(`(() => {
      const thread = document.querySelector('.gui-thread');
      const signal = thread.querySelector('.gui-pulse');
      const bounds = signal?.getBoundingClientRect();
      const viewport = thread.getBoundingClientRect();
      return {
        label: signal?.querySelector('.gui-pulse-verb')?.textContent.trim() ?? null,
        role: signal?.getAttribute('role') ?? null,
        visible: Boolean(bounds && bounds.height > 0 && bounds.width > 0 && bounds.top >= viewport.top && bounds.bottom <= viewport.bottom),
        backgroundCount: Number(thread.querySelector('.gui-background-work')?.dataset.subagentCount ?? 0),
        text: thread.textContent
      };
    })()`)
    assert.equal(actual.label, label)
    assert.equal(actual.backgroundCount, backgroundCount)
    assert.doesNotMatch(actual.text, /SYNTHETIC_PRIVATE_REASONING/)
    if (label !== null) {
      assert.equal(actual.role, 'status')
      assert.equal(actual.visible, true, 'activity must be visible in the pinned chat, not below the viewport')
    }
  }
  try {
    await win.loadFile(join(directory, 'index.html'))
    await pause(300)
    await expectActivity(null)
    await push({ type: 'turn-started' })
    await expectActivity('preparando a resposta')
    await push({ type: 'delta', text: 'Vou conferir o comportamento da conversa.' })
    await expectActivity('respondendo')
    await push({ type: 'thinking', text: 'SYNTHETIC_PRIVATE_REASONING' })
    await push({ type: 'command-output', text: 'Você está perto do limite do plano. Renovação prevista às 03:00.' })
    await pause(250)
    await writeFile(resolve('.synkora/reports/chat-activity-' + (baseline ? 'before' : 'after') + '.png'), (await win.webContents.capturePage()).toPNG())
    await expectActivity('pensando')
    // No new event is needed to keep the factual phase visible.
    await push({ type: 'context-compaction', active: true })
    await expectActivity('compactando contexto')
    await writeFile(resolve('.synkora/reports/chat-context-compaction.png'), (await win.webContents.capturePage()).toPNG())
    await run(`window.activityFixture.replay(false)`)
    await pause(80)
    await expectActivity('compactando contexto')
    await push({ type: 'context-compaction', active: false })
    await expectActivity('pensando')
    await pause(180)
    await expectActivity('pensando')
    await push({ type: 'tool', name: 'Read', toolUseId: 'synthetic-read', input: { file_path: 'synthetic.ts' } })
    await expectActivity('lendo')
    await patch({ publicSilenceSince: Date.now() - 125_000 })
    const progressText = () => run(`document.querySelector('.gui-pulse')?.textContent ?? ''`)
    assert.equal(await run(`getComputedStyle(document.querySelector('.gui-pulse')).display`), 'flex')
    assert.equal(await run(`document.querySelector('.gui-pulse').dataset.action`), 'reading')
    assert.match(await progressText(), /sem sinal há 2:0\d/u)
    assert.match(await progressText(), /lendo.*synthetic\.ts/u)
    await push({ type: 'tool-result', toolUseId: 'synthetic-read', text: 'conteúdo sintético', isError: false })
    await expectActivity('preparando a resposta')
    assert.equal(await run(`document.querySelector('.gui-pulse').dataset.action`), 'thinking')
    assert.match(await progressText(), /preparando a resposta.*leu synthetic\.ts/u)
    assert.match(await progressText(), /sem sinal há/u, 'tool results do not replace an explanation from the agent')
    await writeFile(resolve('.synkora/reports/chat-agent-pulse.png'), (await win.webContents.capturePage()).toPNG())
    await run(`(() => { document.querySelector('.fixture-chat').style.width = '400px' })()`)
    await pause(100)
    const progressBounds = await run(`(() => {
      const node = document.querySelector('.gui-pulse');
      const bounds = node.getBoundingClientRect();
      const viewport = document.querySelector('.gui-thread').getBoundingClientRect();
      return { x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.ceil(bounds.width), height: Math.ceil(bounds.height),
        fits: node.scrollWidth <= node.clientWidth && bounds.bottom <= viewport.bottom };
    })()`)
    assert.equal(progressBounds.fits, true, 'the activity and warning remain readable in a narrow pane')
    const { fits: _fits, ...clip } = progressBounds
    await writeFile(resolve('.synkora/reports/chat-agent-pulse-detail.png'), (await win.webContents.capturePage(clip)).toPNG())
    await run(`(() => { document.querySelector('.fixture-chat').style.width = '780px' })()`)
    // The quiet form must appear without another model/tool event.
    await patch({ publicSilenceSince: Date.now() - 59_000 })
    assert.doesNotMatch(await progressText(), /sem sinal/u)
    // The component clock ticks once a second: the patch can land between ticks.
    assert.match(await progressText(), /há 5[89] s/u, 'the clock ticks below the quiet threshold too')
    assert.equal(await run(`document.querySelector('.gui-pulse').classList.contains('quiet')`), false)
    await run(`(() => { window.originalClock = Date.now; Date.now = () => window.originalClock() + 4000 })()`)
    await pause(1100)
    assert.match(await progressText(), /sem sinal há 1:0\d/u)
    assert.equal(await run(`document.querySelector('.gui-pulse').classList.contains('quiet')`), true)
    assert.equal(await run(`getComputedStyle(document.querySelector('.gui-pulse')).borderTopStyle`), 'dashed',
      'silence changes the SHAPE of the line first')
    await run(`(() => { Date.now = window.originalClock })()`)
    await push({ type: 'delta', text: 'A verificação foi concluída.' })
    await expectActivity('respondendo')
    assert.doesNotMatch(await progressText(), /sem sinal/u)
    await push({ type: 'text', text: 'A verificação foi concluída.' })
    await expectActivity('preparando a resposta')
    await push({ type: 'result', isError: false, outcome: 'completed', turnActive: false })
    await expectActivity(null)
    assert.equal(await progressText(), '')

    // The parent and helper have independent, authoritative activity.
    await push({ type: 'context-compaction', active: true })
    await push({ type: 'command-completed', isError: false, continues: false })
    await expectActivity('compactando contexto')
    await push({ type: 'context-compaction', active: false })
    await expectActivity(null)
    await push({ type: 'context-compaction', active: true })
    await push({ type: 'result', isError: false, outcome: 'cancelled', turnActive: false })
    await expectActivity(null)
    await run(`window.activityFixture.replay(true)`)
    await pause(80)
    await expectActivity(null)
    await push({ type: 'turn-started' })
    await push({ type: 'tool', name: 'helper:synthetic-helper', toolUseId: 'helper:synthetic-helper',
      parentToolUseId: 'synthetic-delegate', input: { helperId: 'synthetic-helper', name: 'Ajudante sintético', model: 'gpt-5.6-sol', prompt: 'Verificação sintética.' } })
    await push({ type: 'thinking', text: 'SYNTHETIC_PRIVATE_REASONING' })
    await expectActivity('pensando', 1)
    await push({ type: 'turn-continuation', continues: true, turnActive: false, isError: false })
    await expectActivity(null, 1)
    await patch({ status: 'waiting-you', turnActive: false })
    await expectActivity(null, 1)
    await push({ type: 'closed', code: 0 })
    await expectActivity(null)

    // Human interaction remains a hard boundary even if old stream data remains.
    await patch({ status: 'working', turnActive: true, thinking: true, stream: 'texto anterior', activeAssistantId: 'synthetic-assistant',
      question: { requestId: 'synthetic-question', blocking: true, questions: [{ id: 'choice', question: 'Escolha sintética', options: [{ label: 'Continuar' }] }] } })
    await expectActivity(null)
    await patch({ question: null, status: 'idle' })
    await expectActivity(null)
    console.log('PASS real GuiPane: immediate activity, partial response, renewed thinking after text and notice, pending tool, terminal, independent helper activity and blocking interaction.')
  } finally { win.destroy() }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async error => {
    console.error(error.stack); (await import('electron')).app.exit(1)
  })
} else {
  test('real chat keeps factual activity visible through text, thinking and tool phases', { timeout: 30000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    await mkdir(resolve('.synkora/reports'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/chat-activity-'))
    buildSync({ stdin: { contents: `
      import { createRoot } from 'react-dom/client'
      import GuiPane from './components/GuiPane'
      import { installDevMock } from './devMock'
      import { useStore } from './store'
      installDevMock()
      const paneId = 'gui-synthetic-activity'
      const ready = { type: 'ready', caps: { models: [{ value: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', supportedEffortLevels: ['high'] }], commands: [] } }
      window.synkora.gui.state = async () => ({ exists: true, alive: true, cursor: 1, events: [{ seq: 1, evt: ready }] })
      window.activityFixture = {
        event: event => useStore.getState().handleGuiLive(paneId, event),
        replay: respawn => useStore.getState().replayGuiPane(paneId, [ready, { type: 'turn-started' },
          { type: 'thinking', text: 'SYNTHETIC_PRIVATE_REASONING' }, { type: 'context-compaction', active: true }], respawn),
        patch: patch => useStore.setState(s => ({ guiPanes: { ...s.guiPanes, [paneId]: { ...s.guiPanes[paneId], ...patch } } }))
      }
      createRoot(document.getElementById('root')).render(<div className="fixture-chat" style={{ width: 780, height: '100%', display: 'flex' }}>
        <GuiPane paneId={paneId} projectId="synthetic" cli="codex" cwd="synthetic" model="gpt-5.6-sol" effort="high" permissionMode="bypass" showHeader={false} />
      </div>)
    `, resolveDir: resolve('src/renderer/src'), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
    const css = pathToFileURL(resolve('src/renderer/src/global.css')).href
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Chat activity fixture</title><link rel="stylesheet" href="${css}"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script></html>`)
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
