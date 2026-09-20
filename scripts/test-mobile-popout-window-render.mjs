import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
test('two production phone routes render through restricted preloads in hidden isolated Chromium', { timeout: 30000 }, async t => {
  await mkdir(resolve('.tmp'), { recursive: true }); await mkdir(resolve('.synkora/reports'), { recursive: true })
  const directory = await mkdtemp(resolve('.tmp/mobile-phone-visual-'))
  buildSync({ entryPoints: ['src/renderer/src/main.tsx'], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(directory, 'fixture.js'),
    external: ['./mainApp'], define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' } })
  buildSync({ entryPoints: ['src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(directory, 'preload.cjs') })
  await writeFile(join(directory, 'before.js'), `
    window.__phoneFixtureErrors=[];
    window.addEventListener('error',event=>window.__phoneFixtureErrors.push(event.message));
    window.addEventListener('unhandledrejection',()=>window.__phoneFixtureErrors.push('unhandled promise'));
    for(const [key,value] of Object.entries({width:1920,height:1080,availLeft:0,availTop:0})) Object.defineProperty(screen,key,{get:()=>value,configurable:true});
    window.__paintSyntheticPhone=(platform,width,height)=>{
      const c=document.createElement('canvas');c.width=width;c.height=height;const p=c.getContext('2d');p.scale(width/400,height/880);
      p.fillStyle='#f4f6fb';p.fillRect(0,0,400,880);p.fillStyle='#13223a';p.font='bold 14px sans-serif';p.fillText('9:41',28,31);p.fillText('100%',335,31);
      p.font='bold 12px sans-serif';p.fillStyle='#6d7891';p.fillText('PRÉVIA SINTÉTICA · '+platform.toUpperCase(),25,88);
      p.fillStyle='#13223a';p.font='bold 31px sans-serif';p.fillText('Seu app, ao lado.',25,142);p.font='16px sans-serif';p.fillStyle='#6d7891';p.fillText('Uma janela para cada aparelho.',25,177);
      p.fillStyle=platform==='android'?'#dce9fc':'#e9ddf8';p.beginPath();p.roundRect(23,220,354,245,24);p.fill();
      p.fillStyle=platform==='android'?'#234b85':'#6c3c86';p.font='bold 24px sans-serif';p.fillText('Pronto para testar',45,275);p.font='16px sans-serif';p.fillText('Toque, arraste e compare.',45,312);
      p.beginPath();p.roundRect(45,362,175,57,14);p.fill();p.fillStyle='#fff';p.font='bold 17px sans-serif';p.fillText('Abrir projeto',73,398);
      for(let i=0;i<3;i++){const y=500+i*89;p.fillStyle='#fff';p.beginPath();p.roundRect(23,y,354,70,14);p.fill();p.fillStyle='#13223a';p.font='bold 17px sans-serif';p.fillText(['Atividade recente','Seu espaço','Preferências'][i],44,y+29);p.fillStyle='#8c96a7';p.font='13px sans-serif';p.fillText('Conteúdo de demonstração',44,y+50)}
      p.fillStyle='#13223a';p.beginPath();p.roundRect(151,853,98,5,3);p.fill();return{width,height,data:c.toDataURL('image/png').split(',')[1]};
    };
  `)
  await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:"><title>Synthetic detached phone</title><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="before.js"></script><script src="fixture.js"></script></html>`)
  await writeFile(join(directory, 'comparison.html'), '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><style>body{margin:0;padding:26px;background:#dfe5ec;color:#263047;font:14px Consolas,monospace}h1{font-size:17px;margin:0 0 7px}p{margin:0 0 23px;font-size:11px}section{display:flex;align-items:flex-start;gap:38px;justify-content:center}figure{margin:0}figcaption{font-size:11px;margin-bottom:12px}img{display:block;max-height:690px;width:auto}</style><h1>Janelas independentes do aparelho</h1><p>Capturas de duas janelas reais do Electron · Android e iOS sintéticos · nenhuma execução de simulador Mac</p><section><figure><figcaption>Android · Pixel 7</figcaption></figure><figure><figcaption>iOS · iPhone 17</figcaption></figure></section></html>')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [resolve('scripts/harness/mobilePhoneVisual.mjs'), directory], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let output = ''
  const collect = chunk => { output = (output + chunk).slice(-20000) }
  child.stdout.on('data', collect); child.stderr.on('data', collect)
  const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
  assert.equal(code, 0, output); assert.match(output, /Phone visual Electron PASS/)
  console.log(output.trim())
})
