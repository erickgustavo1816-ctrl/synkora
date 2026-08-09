/*
 * SONDA — Fase 3 (multi-renderer): o que acontece DENTRO de uma
 * WebContentsView escondida?
 *
 * Pergunta que decide o desenho do keepalive da view de panes: os panes em
 * segundo plano dependem de layout VIVO (getClientRects().length > 0 — o
 * TerminalPane usa isso para medir e spawnar na geometria certa; ver
 * TerminalPane.tsx hasRealSize) e de rAF/ResizeObserver para fit. Se esconder
 * a view matar o layout, o esconderijo certo é outro (bounds fora da tela,
 * z-order, etc.).
 *
 * Cenários medidos (todos com backgroundThrottling: false, como no app):
 *   S1  view visível (baseline)
 *   S2  setVisible(false)
 *   S3  setVisible(true) + removeChildView
 *   S4  addChildView de volta + setBounds 0x0
 *
 * Métricas por cenário (medidas DENTRO do renderer da view):
 *   visibilityState · rAF ticks em 500ms (0 = pausado; medido com teto de
 *   1500ms do lado do main) · getClientRects().length e o rect de um div
 *   fixo 300x120 · ResizeObserver: notificações após o gatilho do cenário.
 *
 * Rodar (app fechado): npx electron scripts/probe-webcontentsview-hidden.cjs
 */
const { app, BrowserWindow, WebContentsView } = require('electron')

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><body style="margin:0">
<div id="probe" style="width:300px;height:120px;background:#345"></div>
<script>
  window.__roCount = 0;
  new ResizeObserver(() => { window.__roCount++ }).observe(document.documentElement);
<\/script>
</body></html>`)}`

function measure(wc) {
  const rafProbe = wc
    .executeJavaScript(
      `new Promise((resolve) => {
         let n = 0;
         const t0 = performance.now();
         const loop = () => {
           n++;
           if (performance.now() - t0 < 500) requestAnimationFrame(loop);
           else resolve(n);
         };
         requestAnimationFrame(loop);
       })`,
      true
    )
    .catch(() => 'err')
  const rafWithTimeout = Promise.race([
    rafProbe,
    new Promise((resolve) => setTimeout(() => resolve('stalled(>1500ms)'), 1500))
  ])
  const layoutProbe = wc
    .executeJavaScript(
      `(() => {
         const el = document.getElementById('probe');
         const rects = el.getClientRects();
         const r = el.getBoundingClientRect();
         return {
           visibility: document.visibilityState,
           rectCount: rects.length,
           rect: { w: r.width, h: r.height },
           roCount: window.__roCount,
           innerSize: { w: window.innerWidth, h: window.innerHeight }
         };
       })()`,
      true
    )
    .catch((e) => ({ error: String(e) }))
  return Promise.all([rafWithTimeout, layoutProbe]).then(([raf, layout]) => ({
    rafTicks500ms: raf,
    ...layout
  }))
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 900, height: 600, show: true })
  const view = new WebContentsView({
    webPreferences: { backgroundThrottling: false, sandbox: true }
  })
  win.contentView.addChildView(view)
  view.setBounds({ x: 100, y: 100, width: 600, height: 400 })
  await view.webContents.loadURL(PAGE)
  await wait(400)

  const out = { electron: process.versions.electron }

  out.S1_visible = await measure(view.webContents)

  view.setVisible(false)
  await wait(600)
  out.S2_setVisibleFalse = await measure(view.webContents)

  view.setVisible(true)
  win.contentView.removeChildView(view)
  await wait(600)
  out.S3_removedFromTree = await measure(view.webContents)

  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
  await wait(600)
  out.S4_boundsZero = await measure(view.webContents)

  console.log('PROBE_RESULT ' + JSON.stringify(out, null, 2))
  app.exit(0)
})
