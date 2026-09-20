// Harness estático para OLHAR A TELA sem rodar o app do dono (regra da casa:
// entrega visual só se declara pronta depois de ver a tela com o CSS real).
// Serve scripts/harness/*.html e mapeia /global.css para o stylesheet real do
// renderer. Aba file:// não é dirigível pelas tools do Browser pane — por isso
// um servidor. Registrado em .claude/launch.json como "drop-harness"; PORT
// muda a porta (padrão 5199, longe do 5173 do electron-vite do dono).
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const harnessDir = join(here, 'harness')
const projectCss = resolve(here, '..', 'src', 'renderer', 'src', 'global.css')
// o CSS dos painéis do workspace (botões da barra do palco) mora fora do global
const workspaceCss = resolve(here, '..', 'src', 'renderer', 'src', 'workspace', 'workspacePanels.css')
const port = Number(process.env.PORT ?? 5199)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  try {
    if (path === '/') {
      const files = (await readdir(harnessDir)).filter((name) => name.endsWith('.html'))
      const list = files.map((name) => `<li><a href="/${name}">${name}</a></li>`).join('')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><meta charset="utf-8"><title>harness</title><ul>${list}</ul>`)
      return
    }
    const target =
      path === '/global.css'
        ? projectCss
        : path === '/workspacePanels.css'
          ? workspaceCss
          : join(harnessDir, normalize(path).replace(/^[/\\]+/, ''))
    if (target !== projectCss && target !== workspaceCss && !target.startsWith(harnessDir))
      throw new Error('fora do harness')
    // Harness em TSX (componentes REAIS, dados sintéticos): /nome.js empacota
    // scripts/harness/nome.tsx NA HORA com o esbuild — sem passo de build e
    // sem bundle commitado. O test-workspace-panel-layout faz o mesmo para o
    // Electron headless; aqui é para o olho, no Browser pane.
    if (target.endsWith('.js') && target.startsWith(harnessDir)) {
      const source = target.slice(0, -3) + '.tsx'
      if (existsSync(source)) {
        const { build } = await import('esbuild')
        const out = await build({
          entryPoints: [source], bundle: true, write: false,
          platform: 'browser', format: 'iife', jsx: 'automatic'
        })
        res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' })
        res.end(out.outputFiles[0].text)
        return
      }
    }
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': types[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store'
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('não achei: ' + path)
  }
}).listen(port, '127.0.0.1', () => console.log(`harness em http://127.0.0.1:${port}/`))
