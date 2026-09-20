import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
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
  const win = new BrowserWindow({ width: 1100, height: 660, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } })
  const run = code => win.webContents.executeJavaScript(code)
  try {
    await win.loadFile(join(directory, 'index.html'))
    await pause(180)
    for (const [width, height] of [[1100, 660], [760, 540]]) {
      win.setContentSize(width, height)
      for (const open of [false, true]) {
        await run(`window.versionFixture.setOpen(${open})`)
        await pause(150)
        const start = await run(`(() => {
          const scroll = document.querySelector('.bl-items-scroll') ?? document.querySelector('.bl-items');
          const panel = document.querySelector('.bl-items');
          scroll.scrollTop = 0;
          return { overflow: getComputedStyle(scroll).overflowY, scrollHeight: scroll.scrollHeight,
            height: scroll.clientHeight, tabIndex: scroll.tabIndex,
            rightGap: panel.getBoundingClientRect().right - scroll.getBoundingClientRect().right - parseFloat(getComputedStyle(panel).borderRightWidth),
            headerTop: document.querySelector('.bl-items > .bl-head').getBoundingClientRect().top,
            pageOverflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth };
        })()`)
        assert.ok(['auto', 'scroll'].includes(start.overflow), 'mission history needs a visible vertical scrollbar instead of clipped overflow')
        assert.ok(start.scrollHeight > start.height, 'the long fixture must need scrolling')
        assert.ok(start.height > 120, 'the scroll area must keep usable space')
        assert.equal(start.pageOverflow, false, 'scrolling belongs inside the version panel')
        assert.equal(start.tabIndex, 0, 'keyboard users can focus the scroll region')
        assert.ok(Math.abs(start.rightGap) < 1, 'the scrollbar belongs at the panel right edge, without a spare outer gutter')
        const disclosure = () => run(`(() => {
          const entries = [...document.querySelectorAll('.vs-mission-delivery')];
          const first = entries[0];
          const header = first.querySelector('summary');
          const bounds = header.getBoundingClientRect();
          return { tag: first.tagName, open: first.open, othersClosed: entries.slice(1).every(entry => !entry.open),
            noteVisible: first.querySelector('.vs-mission-summary').checkVisibility(),
            x: Math.floor(bounds.left + 16), y: Math.floor(bounds.top + bounds.height / 2) };
        })()`)
        const closed = await disclosure()
        assert.equal(closed.tag, 'DETAILS')
        assert.equal(closed.open, false, 'mission summaries start collapsed')
        assert.equal(closed.noteVisible, false)
        for (const expectedOpen of [true, false]) {
          win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: closed.x, y: closed.y })
          win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: closed.x, y: closed.y })
          await pause(70)
          const clicked = await disclosure()
          assert.equal(clicked.open, expectedOpen, 'clicking a mission toggles only its summary')
          assert.equal(clicked.othersClosed, true)
          assert.equal(clicked.noteVisible, expectedOpen)
        }
        await run(`document.querySelector('.vs-mission-delivery > summary').focus()`)
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
        await pause(70)
        assert.equal((await disclosure()).open, true, 'keyboard users can open the mission summary')
        await run(`document.querySelector('.bl-items-scroll').focus()`)
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'End' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'End' })
        await pause(180)
        const end = await run(`(() => {
          const scroll = document.querySelector('.bl-items-scroll');
          const target = document.querySelector('${open ? '.bl-item:last-child' : '.bl-launched-note'}');
          const bounds = scroll.getBoundingClientRect();
          const row = target.getBoundingClientRect();
          return { top: scroll.scrollTop, lastVisible: row.top >= bounds.top && row.bottom <= bounds.bottom + 1,
            headerTop: document.querySelector('.bl-items > .bl-head').getBoundingClientRect().top,
            footerVisible: !${open} || document.querySelector('.bl-footer').getBoundingClientRect().bottom <= innerHeight };
        })()`)
        assert.ok(end.top > 0, 'End scrolls the focused version history')
        assert.equal(end.lastVisible, true, 'the last history or backlog row is reachable')
        assert.equal(end.headerTop, start.headerTop, 'the version header stays in place')
        assert.equal(end.footerVisible, true, 'backlog actions remain reachable')
        if (width === 1100 && !open) {
          await run(`document.querySelector('.bl-items-scroll').scrollTop = 0`)
          await pause(80)
          await writeFile(resolve('.synkora/reports/mission-summaries-scroll.png'), (await win.webContents.capturePage()).toPNG())
        }
        await run(`document.querySelectorAll('.vs-mission-delivery').forEach(entry => { entry.open = false })`)
      }
    }
    console.log('PASS: mission summaries toggle by click and keyboard; the scrollbar reaches the right edge and all version content stays reachable at two sizes.')
    win.destroy()
    app.exit(0)
  } catch (error) {
    console.error(error)
    win.destroy()
    app.exit(1)
  }
}

if (process.versions.electron) {
  inspect().catch(error => { console.error(error); process.exit(1) })
} else {
  test('version history scrolls through long mission summaries and keeps the last item reachable', { timeout: 30000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    await mkdir(resolve('.synkora/reports'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/version-summary-scroll-'))
    buildSync({ stdin: { contents: `
      import { createRoot } from 'react-dom/client'
      import BacklogView from './components/BacklogView'
      import { installDevMock } from './devMock'
      import { useStore } from './store'
      installDevMock()
      const projectId = 'synthetic-summary-project'
      const at = '2026-09-11T12:00:00Z'
      let open = false
      const listeners = new Set()
      const deliveries = Array.from({length: 24}, (_, i) => ({id: 'd' + i, missionId: 'm' + i,
        title: 'Missão de exemplo ' + (i + 1), at,
        summary: 'A busca voltou a encontrar os itens pelo nome. Agora você pode localizar o que precisa sem repetir a pesquisa.'}))
      window.synkora.backlog.listVersions = async () => [{id: 'v1', projectId, name: '0.1.4',
        status: open ? 'aberta' : 'lancada', createdAt: at, updatedAt: at, releasedAt: at, deliveries}]
      window.synkora.backlog.listItems = async () => open ? Array.from({length: 12}, (_, i) => ({id: 'i' + i,
        projectId, versionId: 'v1', title: 'Item pendente de exemplo ' + (i + 1), type: 'feature', status: 'pendente', createdAt: at, updatedAt: at})) : []
      window.synkora.backlog.versionReleases = async () => [{id: 'r1', projectId, versionId: 'v1',
        versionName: '0.1.4', at, actor: 'exemplo', mergeDetail: 'entrega de exemplo', push: {attempted: false}, publishRequired: false}]
      window.synkora.backlog.onChanged = listener => { listeners.add(listener); return () => listeners.delete(listener) }
      useStore.setState({ missions: [], projects: [], homeStats: {[projectId]: {versoes: []}} })
      window.versionFixture = {setOpen: value => { open = value; for(const listener of listeners) listener(projectId) }}
      createRoot(document.getElementById('root')).render(<BacklogView projectId={projectId} />)
    `, resolveDir: resolve('src/renderer/src'), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
    const css = pathToFileURL(resolve('src/renderer/src/global.css')).href
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Version scroll fixture</title>
      <link rel="stylesheet" href="${css}"><link rel="stylesheet" href="fixture.css">
      <style>html,body,#root{height:100%;margin:0;overflow:hidden}#root{display:flex;min-height:0}</style>
      <div id="root"></div><script src="fixture.js"></script></html>`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
    assert.equal(code, 0, output)
    console.log(output.trim())
  })
}
