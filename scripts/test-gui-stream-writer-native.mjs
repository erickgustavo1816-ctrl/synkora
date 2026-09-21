// A ESCRITA DO CHAT, PROVADA EM ELECTRON (mockup aprovado em 2026-09-21).
//
// O componente REAL (`GuiStreamText` + `GuiMarkdown` + global.css) recebe o
// roteiro do vídeo do dono: um parágrafo chega inteiro (commentary) e, logo
// depois, outro começa a chegar em rajadas. O que se mede, no DOM vivo:
//   1. UM escritor por vez — enquanto o primeiro escreve, o segundo nem está
//      no fio; nunca dois carets ao mesmo tempo.
//   2. O NÓ é o mesmo do primeiro delta à mensagem parada — um marcador posto
//      no `.gui-msg` no meio da revelação continua lá no fim (nada remonta, o
//      `rise` não toca de novo).
//   3. Ao terminar: sem caret, sem spans de fade, classe `stream` fora, texto
//      completo dos dois parágrafos, na ordem.
// Capturas para o dono em .synkora/reports/chat-writer-{mid,end}-2026-09-21.png.
//
// Rode: node scripts/test-gui-stream-writer-native.mjs

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

const P1 = 'O diário em Roaming não tem nenhum evento desta missão — o app instalado deve gravar userData em outro lugar (provavelmente AppData/Local/Synkora, onde moram worktrees e seats). Vou conferir onde o main fixa o userData e ler o diário certo.'
const P2 = 'Procuro o **userData real** do app instalado e o diário com os eventos desta missão.'

async function inspect() {
  const { app, BrowserWindow } = await import('electron')
  const directory = process.argv[2]
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({ width: 720, height: 420, show: false, useContentSize: true,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      offscreen: true, backgroundThrottling: false } })
  const run = code => win.webContents.executeJavaScript(code)
  const sample = () => run(`(() => {
    const msgs = Array.from(document.querySelectorAll('.gui-msg'));
    return msgs.map(el => ({
      mark: el.dataset.mark ?? null,
      stream: el.classList.contains('stream'),
      carets: el.querySelectorAll('.gui-caret').length,
      fades: el.querySelectorAll('.gui-word-in').length,
      text: el.querySelector('.gui-msg-text').textContent
    }));
  })()`)
  try {
    await win.loadFile(join(directory, 'index.html'))
    await pause(150)
    // O roteiro do vídeo: P1 chega inteiro; 250 ms depois P2 começa em rajadas.
    await run(`window.writerFixture.arrive('a', ${JSON.stringify(P1)}, false)`)
    await pause(250)
    const chunks = [P2.slice(0, 30), P2.slice(30, 60), P2.slice(60)]
    await run(`window.writerFixture.arrive('b', ${JSON.stringify(chunks[0])}, true)`)
    let sawHold = false, sawTwo = false, marked = false, samples = 0
    const deadline = Date.now() + 6000
    let chunkIndex = 1
    let nextChunkAt = Date.now() + 200
    while (Date.now() < deadline) {
      if (chunkIndex < chunks.length && Date.now() >= nextChunkAt) {
        await run(`window.writerFixture.append('b', ${JSON.stringify(chunks[chunkIndex])})`)
        chunkIndex += 1
        nextChunkAt = Date.now() + 200
        if (chunkIndex === chunks.length) await run(`window.writerFixture.finalize('b')`)
      }
      const state = await sample()
      samples += 1
      const carets = state.reduce((sum, m) => sum + m.carets, 0)
      assert.ok(carets <= 1, `dois carets ao mesmo tempo: ${JSON.stringify(state)}`)
      if (state.length === 1 && state[0].carets === 1 && state[0].text.length < P1.length) {
        sawHold = true
        if (!marked) {
          await run(`document.querySelector('.gui-msg').dataset.mark = 'mesmo-no'`)
          marked = true
          await writeFile(resolve('.synkora/reports/chat-writer-mid-2026-09-21.png'),
            (await win.webContents.capturePage()).toPNG())
        }
      }
      if (state.length === 2) sawTwo = true
      const done = state.length === 2 && state.every(m => !m.stream && m.carets === 0 && m.fades === 0)
      if (done && chunkIndex === chunks.length) break
      await pause(40)
    }
    const final = await sample()
    assert.ok(sawHold, 'o primeiro parágrafo escreveu sozinho enquanto o segundo esperava')
    assert.ok(sawTwo, 'o segundo parágrafo entrou no fio depois')
    assert.equal(final.length, 2, JSON.stringify(final))
    assert.equal(final[0].mark, 'mesmo-no', 'o nó do primeiro parágrafo é o mesmo do início ao fim')
    for (const m of final) {
      assert.equal(m.stream, false)
      assert.equal(m.carets, 0)
      assert.equal(m.fades, 0)
    }
    // `marked` fecha cada bloco com "\n" — o texto do parágrafo é o que importa.
    assert.equal(final[0].text.trim(), P1)
    assert.equal(final[1].text.trim(), P2.replace(/\*\*/gu, ''))
    await writeFile(resolve('.synkora/reports/chat-writer-end-2026-09-21.png'),
      (await win.webContents.capturePage()).toPNG())
    console.log(JSON.stringify({ pass: true, samples, sawHold, sawTwo }))
  } finally { win.destroy() }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async error => {
    console.error(error.stack); (await import('electron')).app.exit(1)
  })
} else {
  test('native chat writer: one writer at a time, same node from first delta to final message', { timeout: 40000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    await mkdir(resolve('.synkora/reports'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/gui-stream-writer-'))
    buildSync({ stdin: { contents: `
      import { useCallback, useState } from 'react'
      import { createRoot } from 'react-dom/client'
      import GuiStreamText from './components/GuiStreamText'
      import { guiHeldItems } from './guiStreamReveal'
      // 40 palavras/s: rápido o bastante para o teste, lento o bastante para o
      // segundo parágrafo chegar com o primeiro ainda escrevendo.
      const pace = { wordsPerSecond: 40, maxLagMs: 1000, fade: true }
      function Fixture() {
        const [items, setItems] = useState([])
        const [busyId, setBusyId] = useState(null)
        window.writerFixture = {
          arrive: (id, text, live) => setItems(prev => [...prev, { id, kind: 'assistant', text, live, animateFrom: 0 }]),
          append: (id, text) => setItems(prev => prev.map(it => it.id === id ? { ...it, text: it.text + text } : it)),
          finalize: (id) => setItems(prev => prev.map(it => it.id === id ? { ...it, live: false } : it))
        }
        const finish = useCallback((id, length) => setItems(prev => prev.map(it => it.id === id ? { ...it, animateFrom: Math.max(it.animateFrom, length) } : it)), [])
        const onBusy = useCallback((id, busy) => setBusyId(cur => busy ? id : cur === id ? null : cur), [])
        const held = guiHeldItems(items, busyId !== null)
        return <main className="fixture-shell"><section className="gui-pane fixture-pane"><div className="gui-thread">
          {held.map(item => <GuiStreamText key={item.id} paneId="fixture" text={item.text} initialShown={item.animateFrom}
            complete={!item.live} pace={pace} onComplete={() => finish(item.id, item.text.length)}
            onBusy={(busy) => onBusy(item.id, busy)} />)}
        </div></section></main>
      }
      createRoot(document.getElementById('root')).render(<Fixture />)
    `, resolveDir: resolve('src/renderer/src'), loader: 'tsx' }, bundle: true, platform: 'browser',
      format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
    const css = pathToFileURL(resolve('src/renderer/src/global.css')).href
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Chat writer fixture</title>
      <link rel="stylesheet" href="${css}">
      <style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}.fixture-shell{height:100%;padding:16px;box-sizing:border-box;display:flex;justify-content:center;background:#efe9dc}.fixture-pane{position:relative;width:640px;height:100%;flex:none;border:1px solid #b6ac94;border-radius:8px;padding:14px;--gui-column:600px}</style>
      <div id="root"></div><script src="fixture.js"></script></html>`)
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory],
      { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.equal(code, 0, output)
    console.log(output.trim())
  })
}
