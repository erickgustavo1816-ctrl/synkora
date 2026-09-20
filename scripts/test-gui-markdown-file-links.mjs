import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
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
  const cases = JSON.parse(await readFile(join(directory, 'cases.json'), 'utf8'))
  await app.whenReady()
  const win = new BrowserWindow({ width: 920, height: 600, show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true } })
  const run = code => win.webContents.executeJavaScript(code)
  try {
    await win.loadFile(join(directory, 'index.html'))
    for (const fixture of cases) {
      await run(`window.fileLinkFixture.render(${JSON.stringify(fixture.markdown)})`)
      await pause(70)
      const result = await run(`(() => {
        const content = document.querySelector('.gui-md-content');
        const button = content.querySelector('button[data-gui-file-token]');
        return { text: content.textContent, token: button?.dataset.guiFileToken ?? null,
          label: button?.textContent ?? null, title: button?.title ?? null,
          buttons: content.querySelectorAll('button[data-gui-file-token]').length,
          anchors: [...content.querySelectorAll('a')].map(a => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel })),
          unsafe: content.querySelectorAll('script, iframe, [onclick], [onerror], a[href^="javascript:"], a[href^="file:"]').length,
          nestedControls: content.querySelectorAll('button button, button input').length,
          nestedLabel: Boolean(button?.querySelector('strong')) };
      })()`)
      assert.equal(result.unsafe, 0, fixture.name)
      assert.equal(result.nestedControls, 0, fixture.name)
      assert.equal(result.token, fixture.reference ?? null, fixture.name)
      if (fixture.reference) {
        assert.equal(result.buttons, 1, fixture.name)
        assert.equal(result.label, fixture.label, 'the download label must survive')
        if (fixture.strong) assert.equal(result.nestedLabel, true)
        assert.ok(result.title.includes(fixture.reference), 'the real destination stays inspectable')
        const before = await run('window.fileLinkFixture.calls.length')
        await run(`document.querySelector('.gui-md-content button[data-gui-file-token]').click()`)
        await pause(40)
        assert.deepEqual(await run('window.fileLinkFixture.calls.slice(-1)[0]'),
          { paneId: 'gui-synthetic-file-links', reference: fixture.reference, mode: 'auto' })
        assert.equal(await run('window.fileLinkFixture.calls.length'), before + 1)
      } else if (fixture.external) {
        assert.deepEqual(result.anchors, [{ href: fixture.external, target: '_blank', rel: 'noopener noreferrer' }])
      } else {
        assert.equal(result.buttons, 0, fixture.name)
        assert.equal(result.anchors.length, 0, fixture.name)
      }
    }

    // The same message grows during streaming, keeping the existing file control.
    const markdown = cases[0].markdown
    await run(`window.fileLinkFixture.render(${JSON.stringify(markdown)})`)
    await pause(70)
    await run(`window.originalFileLink = document.querySelector('.gui-md-content button'); window.originalFileLink.focus()`)
    await run(`window.fileLinkFixture.render(${JSON.stringify(markdown + '\n\nArquivo pronto para abrir.')})`)
    await pause(70)
    assert.equal(await run(`document.querySelector('.gui-md-content button') === window.originalFileLink`), true)
    assert.equal(await run(`document.activeElement === window.originalFileLink`), true)
    const beforeKey = await run('window.fileLinkFixture.calls.length')
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await pause(70)
    assert.equal(await run('window.fileLinkFixture.calls.length'), beforeKey + 1, 'Enter opens the file once')
    await run(`document.querySelector('.gui-md-content button').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 120, clientY: 90 }))`)
    await pause(70)
    assert.ok((await run('document.body.textContent')).includes('mostrar na pasta'), 'right click offers the existing file actions')
    const visual = '### Arquivo corrigido\n\n[Baixar o SPED corrigido](<entregas/SPED corrigido.txt>)\n\nArquivo sintético usado para conferir o link. O botão direito oferece a opção de mostrar na pasta.'
    await run(`window.fileLinkFixture.render(${JSON.stringify(visual)})`)
    await pause(100)
    if (process.argv.includes('--capture')) {
      await mkdir(resolve('.synkora/reports'), { recursive: true })
      await writeFile(resolve('.synkora/reports/markdown-file-links-2026-09-15.png'), (await win.webContents.capturePage()).toPNG())
    }
    await writeFile(join(directory, 'calls.json'), JSON.stringify(await run('window.fileLinkFixture.calls')))
    console.log(`PASS ${cases.length} real Markdown cases, exact file-open calls, keyboard, context menu and streaming.`)
  } finally {
    win.destroy()
  }
}

if (process.versions.electron) {
  inspect().then(async () => (await import('electron')).app.exit(0)).catch(async error => {
    console.error(error.stack); (await import('electron')).app.exit(1)
  })
} else {
  test('Markdown download labels open local files through the existing scoped bridge', { timeout: 30000 }, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const directory = await mkdtemp(resolve('.tmp/gui-markdown-links-'))
    const cwd = join(directory, 'worktree')
    await mkdir(join(cwd, 'entregas'), { recursive: true })
    const absolute = join(cwd, 'entregas', 'SPED corrigido.txt').replace(/\\/g, '/')
    await writeFile(absolute, 'SPED SINTÉTICO\n')
    const cases = [
      { name: 'relative Markdown download', markdown: '[Baixar o SPED corrigido](<entregas/SPED corrigido.txt>)', reference: 'entregas/SPED corrigido.txt', label: 'Baixar o SPED corrigido' },
      { name: 'Windows absolute drive', markdown: `[Baixar o SPED corrigido](<${absolute}>)`, reference: absolute, label: 'Baixar o SPED corrigido' },
      { name: 'Windows backslashes', markdown: `[Baixar](<${absolute.replace(/\//g, '\\\\')}>)`, reference: absolute.replace(/\//g, '\\'), label: 'Baixar' },
      { name: 'encoded path', markdown: '[Baixar](entregas/SPED%20corrigido.txt)', reference: 'entregas/SPED corrigido.txt', label: 'Baixar' },
      { name: 'file URL', markdown: `[Baixar](${pathToFileURL(absolute).href})`, reference: absolute, label: 'Baixar' },
      { name: 'formatted label', markdown: '[**Baixar o SPED corrigido**](<entregas/SPED corrigido.txt>)', reference: 'entregas/SPED corrigido.txt', label: 'Baixar o SPED corrigido', strong: true },
      { name: 'image label stays one file control', markdown: '[![Baixar o SPED corrigido](preview.png)](<entregas/SPED corrigido.txt>)', reference: 'entregas/SPED corrigido.txt', label: 'Baixar o SPED corrigido' },
      { name: 'reference-style Markdown', markdown: '[Baixar][arquivo]\n\n[arquivo]: <entregas/SPED corrigido.txt>', reference: 'entregas/SPED corrigido.txt', label: 'Baixar' },
      { name: 'short document name', markdown: '[Baixar planilha](planilha.xlsx)', reference: 'planilha.xlsx', label: 'Baixar planilha' },
      { name: 'archive', markdown: '[Baixar ZIP](entregas/pacote.zip)', reference: 'entregas/pacote.zip', label: 'Baixar ZIP' },
      { name: 'Unix absolute path', markdown: '[Baixar](/tmp/synthetic/report.txt)', reference: '/tmp/synthetic/report.txt', label: 'Baixar' },
      { name: 'HTTPS stays external', markdown: '[Documentação](https://example.invalid/manual)', external: 'https://example.invalid/manual' },
      { name: 'unsupported protocol', markdown: '[Não executar](javascript:alert%281%29)' },
      { name: 'encoded unsupported protocol', markdown: '[Não executar](javascript%3Aalert%281%29)' },
      { name: 'remote file URL', markdown: '[Não abrir](file://remote.invalid/share/file.txt)' },
      { name: 'network-relative URL', markdown: '[Não abrir](//remote.invalid/file.txt)' },
      { name: 'no mapped sandbox', markdown: '[Arquivo sem destino local](sandbox:/mnt/data/report.txt)' },
      { name: 'anchor', markdown: '[Seção](#resultado)' },
      { name: 'code stays literal', markdown: '```md\n[Baixar](entregas/pacote.zip)\n```' },
      { name: 'raw HTML sanitization', markdown: '<a href="entregas/SPED%20corrigido.txt" onclick="alert(1)"><strong>Baixar</strong></a><script>alert(1)</script>', reference: 'entregas/SPED corrigido.txt', label: 'Baixar', strong: true }
    ]
    await writeFile(join(directory, 'cases.json'), JSON.stringify(cases))
    buildSync({ stdin: { contents: `
      import { createRoot } from 'react-dom/client'
      import { flushSync } from 'react-dom'
      import GuiMarkdown from './components/GuiMarkdown'
      const calls = []
      window.synkora = { gui: { fileOpen: async (paneId, reference, selectedPath, mode) => {
        calls.push({ paneId, reference, mode })
        return { ok: true, action: 'reveal', message: 'Arquivo sintético localizado.' }
      }, fileOpenExternal: async () => ({ ok: true, action: 'reveal' }) } }
      const root = createRoot(document.getElementById('root'))
      window.fileLinkFixture = { calls, render: text => flushSync(() => root.render(
        <GuiMarkdown paneId="gui-synthetic-file-links" text={text} />
      )) }
    `, resolveDir: resolve('src/renderer/src'), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js') })
    const css = pathToFileURL(resolve('src/renderer/src/global.css')).href
    await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Synthetic file links</title><link rel="stylesheet" href="${css}"><style>body { margin: 0; padding: 40px; } #root { height: auto; }</style><div id="root"></div><script src="fixture.js"></script></html>`)
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url), directory, ...(process.argv.includes('--capture') ? ['--capture'] : [])],
      { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(() => { if (child.exitCode === null) child.kill() })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
    assert.equal(code, 0, output)
    console.log(output.trim())
    const { GuiFileResolver, prepareGuiFileOpen } = await import('../src/main/guiFileResolver.ts')
    const resolver = new GuiFileResolver()
    const calls = JSON.parse(await readFile(join(directory, 'calls.json'), 'utf8'))
    for (const { reference } of calls.filter(call => call.reference.includes('SPED'))) {
      const resolved = resolver.resolve(cwd, reference)
      assert.equal(resolved.ok, true, reference)
      assert.equal(prepareGuiFileOpen(resolved.file).preview.content, 'SPED SINTÉTICO\n')
    }
    for (const reference of ['../outside.txt', join(directory, 'outside.txt'), '.env', 'run.exe']) {
      assert.equal(resolver.resolve(cwd, reference).ok, false, 'existing main-process restrictions remain authoritative')
    }
  })
}
