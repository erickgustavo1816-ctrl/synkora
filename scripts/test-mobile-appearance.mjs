import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

const require = createRequire(import.meta.url)
const pause = ms => new Promise(done => setTimeout(done, ms))
const profileId = 'galaxy-s24-ultra'
const session = patch => ({ id: 'appearance-session', missionId: 'appearance-mission', platform: 'android', deviceId: 'qa-device',
  deviceName: 'Android de demonstração', displayProfileId: profileId, state: 'ready', inputAvailable: true, ...patch })
const calibration = { key: 'synthetic-monitor', pixelsPerMm: 3.6, manualPixelsPerMm: null, source: 'edid-detailed',
  screen: { pixelRatio: 1, viewportScale: 1 }, confirm: () => true, reset: () => true }
const screen = { showing: false, playing: false, source: null, frame: null, error: null, videoSize: { width: 0, height: 0 }, resize() {}, consumerId: 'synthetic-consumer' }

function loadUi() {
  const compiled = buildSync({ stdin: { contents: "export {default as Viewport} from './components/MobileViewport'; export {default as Picker} from './components/MobileDevicePicker'; export {default as DetachedBar} from './components/MobileDetachedBar'; export {default as ScaleMenu} from './components/MobileScaleMenu'; export {getMobileDeviceProfile} from '../../shared/mobileDeviceProfiles'; export {mobilePhysicalDevice,mobileFrameAppearance,mobileCalibratedPhoneLayout} from './mobileModel'", resolveDir: 'src/renderer/src', loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' },
    external: ['react', 'react/jsx-runtime', 'react-dom', '../useMobileScreen', '../useMobilePointer', '../mobileCalibration'] }).outputFiles[0].text
  const module = { exports: {} }
  const testRequire = name => name.endsWith('/useMobileScreen') ? { useMobileScreen: () => screen }
    : name.endsWith('/useMobilePointer') ? { useMobilePointer: () => ({ available: false, error: null, cancel() {} }) }
      : name.endsWith('/mobileCalibration') ? { useMobileCalibration: () => calibration } : require(name)
  new Function('require', 'module', 'exports', compiled)(testRequire, module, module.exports)
  return module.exports
}

const fixtureSource = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MobileViewport from './components/MobileViewport';
import MobileDevicePicker from './components/MobileDevicePicker';
import { getMobileDeviceProfile } from '../../shared/mobileDeviceProfiles';
import './components/DockMobile.css';
const ready = { id:'appearance-session', missionId:'appearance-mission', platform:'android', deviceId:'qa-device', deviceName:'Android de demonstração', displayProfileId:'galaxy-s24-ultra', state:'ready', inputAvailable:true };
const sizes = [];
function Fixture() {
  const [phase,setPhase] = useState('idle'), [detached,setDetached] = useState(false);
  window.appearanceFixture = { setPhase, setDetached, sizes };
  const session = phase === 'idle' ? null : { ...ready, state:phase, displayProfileId:phase === 'starting' ? undefined : ready.displayProfileId };
  return <section className='workspace-panel' data-workspace-panel='mobile'>
    <div className='dock-mobile'>
      {!detached && <><div className='appearance-heading'>MOBILE <span>AMBIENTE DE DEMONSTRAÇÃO</span></div><div className='mobile-device-row'>
        <MobileDevicePicker devices={[]} deviceId='qa-device' session={session} profile={getMobileDeviceProfile(session ? session.displayProfileId : ready.displayProfileId)} requestedProfile={getMobileDeviceProfile(ready.displayProfileId)} disabled={phase === 'starting'} visible applying={false} onDevice={()=>{}} onProfile={()=>{}} onOpenChange={()=>{}} />
        <button className='mobile-button'>{phase === 'idle' ? 'Iniciar' : 'Parar'}</button>
      </div></>}
      <MobileViewport key={String(detached)} missionId={ready.missionId} session={session} profileId={ready.displayProfileId} visible busy={phase === 'starting'} act={async()=>true} expanded={false} onToggleExpanded={()=>{}} presentation={detached ? 'detached':'panel'} initialScaleMode={detached ? 'physical':'fit'} onContentSize={size=>sizes.push(size)} />
    </div>
  </section>
}
createRoot(document.getElementById('root')).render(<Fixture/>);
`

const hookSource = `
import { useCallback, useLayoutEffect } from 'react';
import { mobileVideoSurface } from '${resolve('src/renderer/src/mobileVideoSurface.ts').replaceAll('\\', '/')}';
export function useMobileScreen(missionId,session,visible,canvas) {
  const playing = session?.state === 'ready';
  const resize = useCallback(() => {
    const el=canvas.current; if (!el || !playing) return;
    const parent=el.parentElement.getBoundingClientRect();
    const r=mobileVideoSurface(parent,{width:1440,height:3120},devicePixelRatio);
    if (!r) return;
    el.width=r.width; el.height=r.height;
    Object.assign(el.style,{left:r.left+'px',top:r.top+'px',width:r.cssWidth+'px',height:r.cssHeight+'px',right:'auto',bottom:'auto'});
    const c=el.getContext('2d'); c.fillStyle='#11151a'; c.fillRect(0,0,r.width,r.height);
    c.save(); c.translate(r.drawX,r.drawY); c.scale(r.drawWidth/1440,r.drawHeight/3120);
    c.fillStyle='#283139'; c.fillRect(0,0,1440,3120);
    c.fillStyle='#bec6cc'; c.font='42px monospace'; c.fillText('9:41',75,100); c.fillText('100%',1210,100);
    c.fillStyle='#b2bead'; c.fillRect(0,160,1440,940);
    c.fillStyle='#26362b'; c.font='bold 110px sans-serif'; c.fillText('Seu app',90,660); c.font='45px sans-serif'; c.fillText('no simulador Android',90,770);
    c.fillStyle='#e9ede8'; c.font='64px sans-serif'; c.fillText('Projeto de demonstração',90,1370);
    for(let i=0;i<3;i++){ c.fillStyle='#3b474e'; c.fillRect(90,1540+i*300,1260,220); c.fillStyle='#c6d0d5'; c.font='45px sans-serif'; c.fillText(['Visão geral','Atividade recente','Preferências'][i],145,1675+i*300); }
    c.fillStyle='#e8ebed'; c.fillRect(565,3030,310,12); c.restore();
  }, [canvas,playing]);
  useLayoutEffect(()=>{ resize(); const observer=new ResizeObserver(resize); if(canvas.current?.parentElement)observer.observe(canvas.current.parentElement);return()=>observer.disconnect(); },[resize]);
  return { showing:playing,playing,source:null,frame:null,error:null,videoSize:{width:playing?1440:0,height:playing?3120:0},resize,consumerId:'synthetic-consumer' };
}
export function useMobilePointer(){return {available:false,error:null,cancel(){}}}
export function useMobileCalibration(){return ${JSON.stringify(calibration)}}
`

async function electronInspection(directory) {
  const { app, BrowserWindow } = await import('electron')
  app.setPath('userData', join(directory, 'profile'))
  app.disableHardwareAcceleration()
  await app.whenReady()
  const win = new BrowserWindow({ width: 424, height: 795, useContentSize: true, show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  const run = text => win.webContents.executeJavaScript(text)
  const measure = () => run(`(() => {
    const shell=document.querySelector('.mobile-phone-shell'),display=document.querySelector('.mobile-phone-display'),canvas=display.querySelector('canvas');
    const toolbar=document.querySelector('.mobile-view-toolbar, .mobile-detached-bar'); const box=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
    return {family:shell.dataset.frameFamily,profile:shell.dataset.deviceProfile,mode:shell.dataset.sizeMode,radius:getComputedStyle(shell).borderRadius,shell:box(shell),display:box(display),canvas:box(canvas),background:getComputedStyle(display).backgroundColor,
      picker:document.querySelector('.mobile-model-name')?.textContent,toolbar:box(toolbar),buttons:[...toolbar.querySelectorAll('button')].map(el=>({label:el.getAttribute('aria-label'),...box(el)})),
      overflow:document.querySelector('.dock-mobile').scrollWidth-innerWidth,spinner:document.querySelector('.mobile-startup-indicator')?getComputedStyle(document.querySelector('.mobile-startup-indicator')).animationName:null,
      rows:new Set([...toolbar.querySelectorAll('button')].map(el=>Math.round(el.getBoundingClientRect().y))).size,strip:!!document.querySelector('.mobile-detached-bar'),sizes:window.appearanceFixture.sizes};})()`)
  const capture = async name => writeFile(resolve('.synkora/reports', `mobile-appearance-${name}-2026-09-20.png`), (await win.webContents.capturePage()).toPNG())
  try {
    await win.loadFile(join(directory, 'index.html')); await pause(180)
    const phases=[]
    for (const phase of ['idle','starting','ready']) {
      await run(`window.appearanceFixture.setPhase('${phase}')`); await pause(120)
      phases.push(await measure()); await capture(`424-${phase}`)
    }
    const [idle,starting,ready] = phases
    assert.deepEqual(phases.map(p=>p.family), ['galaxy-ultra','galaxy-ultra','galaxy-ultra'], 'selected Ultra silhouette must not become round while booting')
    assert.equal(idle.radius,starting.radius); assert.equal(starting.radius,ready.radius)
    assert.ok(Math.abs(idle.shell.width-ready.shell.width)<1 && Math.abs(starting.shell.height-ready.shell.height)<1, 'boot does not change phone geometry')
    assert.equal(starting.picker,'Galaxy S24 Ultra')
    assert.ok(starting.spinner && starting.spinner !== 'none', 'startup has an honest preparation animation')
    assert.equal(ready.spinner,null,'startup animation is removed from the live device')
    assert.equal(ready.background,'rgb(9, 12, 14)','fractional canvas edges have opaque dark hardware beneath them')
    assert.ok(Math.abs(ready.canvas.x-Math.round(ready.canvas.x))<.02, 'fixture uses production pixel-aligned surface')
    assert.ok(ready.display.x % 1 !== 0 || ready.display.width % 1 !== 0,'edge coverage is tested at fractional geometry')
    const rendered=await win.webContents.capturePage(),bitmap=rendered.toBitmap(),pixelWidth=rendered.getSize().width
    for(const x of [Math.floor(ready.display.x),Math.ceil(ready.display.right)-1]) for(const portion of [.4,.6,.8]) {
      const y=Math.floor(ready.display.y+ready.display.height*portion),offset=(y*pixelWidth+x)*4
      assert.ok((bitmap[offset]+bitmap[offset+1]+bitmap[offset+2])/3<110,'actual side pixels remain dark instead of exposing paper or a bright inner highlight')
    }
    for (const width of [424,360]) {
      win.setContentSize(width,795); await pause(120); const m=await measure(); await capture(`${width}-toolbar`)
      assert.ok(m.overflow<=0 && m.rows===1 && m.toolbar.height<=32, 'the panel toolbar is one strip without horizontal overflow')
      for(const b of m.buttons) assert.ok(b.x>=m.toolbar.x-.1 && b.right<=m.toolbar.right+.1 && b.height>=24,`${width}px: ${b.label} stays inside toolbar with usable height`)
      for(let i=0;i<m.buttons.length;i++) for(let j=i+1;j<m.buttons.length;j++) {
        const a=m.buttons[i],b=m.buttons[j]; assert.ok(a.right<=b.x+.1 || b.right<=a.x+.1 || a.bottom<=b.y+.1 || b.bottom<=a.y+.1,'button targets never overlap')
      }
    }
    await run("window.appearanceFixture.setPhase('starting')")
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]}); await pause(100)
    assert.equal((await measure()).spinner,'none','reduced motion retains static preparation indication')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]}); win.webContents.debugger.detach()
    await run("window.appearanceFixture.setPhase('ready'); window.appearanceFixture.setDetached(true)"); await pause(150)
    const detached=await measure()
    assert.equal(detached.mode,'physical'); assert.ok(!detached.buttons.some(b=>b.label==='Ampliar tela do aparelho'))
    assert.ok(detached.strip && detached.toolbar.height<=30,'the detached window carries the one-line strip, never the panel toolbar')
    assert.deepEqual(detached.buttons.map(b=>b.label),['Início do dispositivo','Atualizar tela do dispositivo','Tamanho da visualização'],'strip without a window host has no close button')
    assert.equal(await run("getComputedStyle(document.querySelector('.mobile-viewport')).backgroundImage"),'none')
    assert.ok(detached.sizes.length>0 && detached.sizes.at(-1).height>detached.shell.height && detached.sizes.at(-1).width>detached.shell.width)
    const count=detached.sizes.length,desired=detached.sizes.at(-1)
    win.setContentSize(desired.width,desired.height);await pause(100);await capture('detached-physical')
    for(const height of [desired.height,Math.min(540,desired.height),desired.height]) {
      win.setContentSize(desired.width,height);await pause(60)
      assert.equal((await measure()).sizes.length,count,'work-area clamp and repeated measurements never feed back into physical desired size')
    }
    win.setContentSize(248,desired.height);await pause(100)
    const narrow=await measure();await capture('detached-260-controls')
    assert.ok(Math.max(...narrow.buttons.map(button=>button.y))-Math.min(...narrow.buttons.map(button=>button.y))<1,'a 260px host with 12px outer padding keeps detached controls in one intentional row')
    for(const button of narrow.buttons) assert.ok(button.width>=24 && button.height>=24 && button.right<=narrow.toolbar.right+.1,'compact detached controls preserve 24px targets without clipping')
    await run("document.querySelector('[aria-label=\"Tamanho da visualização\"]').click()");await pause(40)
    assert.equal(await run("[...document.querySelectorAll('.mobile-scale-menu [role=menuitemradio]')].map(b=>b.textContent+(b.getAttribute('aria-checked')==='true'?'*':'')).join('|')"),'Ajustar à janela|Tamanho real*|75%|100%*|125%|150%|200%','the scale menu shows the current mode and scale')
    await run("[...document.querySelectorAll('.mobile-scale-menu button')].find(b=>b.textContent==='Ajustar à janela').click()");await pause(80)
    assert.equal(await run("document.querySelector('.mobile-scale-menu')"),null,'choosing an item closes the menu')
    assert.equal((await measure()).mode,'fit')
    for(const height of [560,600,560]) {win.setContentSize(330,height);await pause(60)}
    assert.equal((await measure()).sizes.length,count,'fit always preserves window bounds instead of growing from its own measurements')
    console.log('Appearance Electron PASS:',JSON.stringify({phases:phases.map(({family,radius,shell})=>({family,radius,shell})),detached:detached.sizes.at(-1)}))
  } finally { win.destroy() }
}

if (process.versions.electron) {
  electronInspection(process.argv[2]).then(async()=> (await import('electron')).app.exit(0))
    .catch(async error=>{console.error(error.stack);(await import('electron')).app.exit(1)})
} else {
  globalThis.IS_REACT_ACT_ENVIRONMENT=true
  const { Viewport, Picker, DetachedBar, ScaleMenu, getMobileDeviceProfile, mobilePhysicalDevice, mobileFrameAppearance, mobileCalibratedPhoneLayout }=loadUi()
  const props={ missionId:'appearance-mission', session:null, profileId, visible:true, busy:false, act:async()=>true, expanded:false, onToggleExpanded(){} }
  test('known iPhone 16/17 and Air use official display rectangles and canonical device types',()=>{
    const cases=[['iPhone-16',71.6,147.6,6.12,1179,2556],['iPhone-16-Plus',77.8,160.9,6.69,1290,2796],['iPhone-16-Pro-Max',77.6,163,6.86,1320,2868],
      ['iPhone-16e',71.5,146.7,6.06,1170,2532],['iPhone-17',71.5,149.6,6.27,1206,2622],['iPhone-17-Pro',71.9,150,6.27,1206,2622],
      ['iPhone-17-Pro-Max',78,163.4,6.86,1320,2868],['iPhone-Air',74.7,156.2,6.55,1260,2736],['iPhone-17e',71.5,146.7,6.06,1170,2532]]
    for(const [type,width,height,diagonal,x,y] of cases) {
      const device=mobilePhysicalDevice('ios','galaxy-s24-ultra',`com.apple.CoreSimulator.SimDeviceType.${type}`)
      assert.ok(device,`${type} has official physical metadata`)
      assert.equal(device.bodyWidthMm,width);assert.equal(device.bodyHeightMm,height)
      assert.ok(Math.abs(device.displayDiagonalMm-diagonal*25.4)<1e-9);assert.equal(device.aspectRatio,x/y)
      for(const ratio of [x/y,y/x]) {
        const size=mobileCalibratedPhoneLayout(device,ratio,3.6,1)
        assert.ok(Math.abs(Math.hypot(size.displayWidth,size.displayHeight)-diagonal*25.4*3.6)<1e-8)
        assert.equal(size.width-size.displayWidth,4,'decorative 2px hardware never changes official display scale')
      }
    }
    for(const type of ['iPhone 17','iPhone-17','com.apple.CoreSimulator.SimDeviceType.iPhone-17-Plus','com.apple.CoreSimulator.SimDeviceType.iPhone-99'])
      assert.equal(mobilePhysicalDevice('ios',undefined,type),null,'editable names and unknown canonical models never borrow dimensions')
  })
  test('new iPhone frames distinguish Dynamic Island and the e-series notch without model-name heuristics',()=>{
    for(const type of ['iPhone-17','iPhone-17-Pro','iPhone-17-Pro-Max','iPhone-Air'])
      assert.equal(mobileFrameAppearance('ios',undefined,`com.apple.CoreSimulator.SimDeviceType.${type}`).family,'iphone-island')
    assert.equal(mobileFrameAppearance('ios',undefined,'com.apple.CoreSimulator.SimDeviceType.iPhone-17e').family,'iphone-notch')
    assert.equal(mobileFrameAppearance('ios',undefined,'iPhone-17-Pro').family,'iphone')
    assert.equal(mobileFrameAppearance('ios',undefined,'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Plus').family,'iphone')
  })
  test('requested Ultra is a stable boot preview; ready uses only the confirmed profile',async()=>{
    let tree
    await act(()=>{tree=create(React.createElement(Viewport,props))})
    const family=()=>tree.root.findByProps({'data-testid':'mobile-viewport'}).parent.props['data-frame-family']
    assert.equal(family(),'galaxy-ultra')
    await act(()=>tree.update(React.createElement(Viewport,{...props,session:session({state:'starting',displayProfileId:undefined})})))
    assert.equal(family(),'galaxy-ultra')
    assert.equal(tree.root.findAllByProps({className:'mobile-startup-indicator'}).length,1)
    await act(()=>tree.update(React.createElement(Viewport,{...props,session:session({displayProfileId:undefined})})))
    assert.equal(family(),'pixel','failed/unconfirmed live profile is never presented as applied Ultra')
    await act(()=>tree.unmount())
  })
  test('picker previews the requested model during boot without claiming application',async()=>{
    let tree; const p={devices:[],deviceId:'qa-device',session:session({state:'starting',displayProfileId:'native'}),profile:getMobileDeviceProfile('native'),requestedProfile:getMobileDeviceProfile(profileId),disabled:true,visible:true,applying:false,onDevice(){},onProfile(){},onOpenChange(){}}
    await act(()=>{tree=create(React.createElement(Picker,p))})
    assert.equal(tree.root.findByProps({className:'mobile-model-name'}).children.join(''),'Galaxy S24 Ultra')
    assert.equal(tree.root.findByProps({className:'mobile-model-size'}).children.join(''),'Preparando…')
    assert.equal(tree.root.findByType('button').props['data-applied-profile'],'native')
    await act(()=>tree.update(React.createElement(Picker,{...p,session:session({displayProfileId:'native'})})))
    assert.equal(tree.root.findByProps({className:'mobile-model-name'}).children.join(''),'Android de demonstração')
    await act(()=>tree.unmount())
  })
  test('detached initial physical intention survives loading and reports stable desired size',async()=>{
    let tree;const sizes=[];const p={...props,profileId:undefined,presentation:'detached',initialScaleMode:'physical',onContentSize:size=>sizes.push(size)}
    const node={clientWidth:380,clientHeight:650,scrollTop:0,scrollLeft:0,style:{},getBoundingClientRect:()=>({width:380,height:36}),ownerDocument:{defaultView:{getComputedStyle:()=>({marginLeft:'6px',marginRight:'6px',marginTop:'0px',marginBottom:'6px',paddingLeft:'6px',paddingRight:'6px',paddingTop:'6px',paddingBottom:'6px'})}}}
    await act(()=>{tree=create(React.createElement(Viewport,p),{createNodeMock:()=>node})})
    await act(()=>tree.update(React.createElement(Viewport,{...p,profileId,session:session({})})))
    const shell=tree.root.findByProps({'data-frame-family':'galaxy-ultra'})
    assert.equal(shell.props['data-size-mode'],'physical')
    assert.equal(tree.root.findAllByProps({'aria-label':'Ampliar tela do aparelho'}).length,0)
    assert.ok(sizes.length>0);const last=sizes.at(-1)
    assert.ok(last.width>shell.props.style.width && last.height>shell.props.style.height)
    assert.equal(last.width,Math.ceil(last.width));assert.equal(last.height,Math.ceil(last.height))
    await act(()=>tree.update(React.createElement(Viewport,{...p,profileId,session:session({})})))
    assert.deepEqual(sizes.at(-1),last)
    const count=sizes.length
    await act(()=>tree.root.findByType(DetachedBar).props.scale.onFit())
    assert.equal(sizes.length,count,'fit must not report window-derived dimensions back to that window')
    await act(()=>tree.unmount())
  })
  test('detached content size waits for host visibility and re-emits after the handover barrier',async()=>{
    let tree;const sizes=[];const p={...props,session:session({}),presentation:'detached',initialScaleMode:'physical',visible:false,onContentSize:size=>sizes.push(size)}
    const node={clientWidth:300,clientHeight:620,style:{},getBoundingClientRect:()=>({width:300,height:40}),ownerDocument:{defaultView:{getComputedStyle:()=>({marginLeft:'6px',marginRight:'6px',marginTop:'0px',marginBottom:'6px',paddingLeft:'6px',paddingRight:'6px',paddingTop:'6px',paddingBottom:'6px'})}}}
    await act(()=>{tree=create(React.createElement(Viewport,p),{createNodeMock:()=>node})})
    assert.equal(sizes.length,0,'a hidden/transferring host must not consume the initial size request')
    await act(()=>tree.update(React.createElement(Viewport,{...p,visible:true})))
    assert.equal(sizes.length,1)
    await act(()=>tree.update(React.createElement(Viewport,p)))
    await act(()=>tree.update(React.createElement(Viewport,{...p,visible:true})))
    assert.equal(sizes.length,2,'the same intrinsic dimensions are requested once after a fresh host barrier')
    assert.deepEqual(sizes[1],sizes[0])
    await act(()=>tree.unmount())
  })
  test('fit zoom derives from stable stage bounds rather than scrollbar-dependent client size',async t=>{
    let tree;const callbacks=new Set(),oldObserver=globalThis.ResizeObserver
    globalThis.ResizeObserver=class {constructor(callback){this.callback=callback;callbacks.add(callback)}observe(){}disconnect(){callbacks.delete(this.callback)}}
    t.after(()=>{globalThis.ResizeObserver=oldObserver})
    const stage={clientWidth:400,clientHeight:650,offsetWidth:400,offsetHeight:650,scrollTop:0,scrollLeft:0}
    await act(()=>{tree=create(React.createElement(Viewport,props),{createNodeMock:element=>element.props.className==='mobile-viewport'?stage:null})})
    t.after(()=>act(()=>tree.unmount()))
    await act(()=>tree.root.findByType(ScaleMenu).props.scale.onZoom(1.25))
    const width=()=>tree.root.findByProps({'data-frame-family':'galaxy-ultra'}).props.style.width
    const before=width()
    await act(()=>{stage.clientWidth-=10;stage.clientHeight-=10;for(const callback of callbacks)callback()})
    assert.equal(width(),before,'scrollbar gutters cannot shrink an already requested zoom')
    await act(()=>{stage.offsetWidth=450;stage.offsetHeight=700;stage.clientWidth=440;stage.clientHeight=690;for(const callback of callbacks)callback()})
    assert.ok(width()>before,'real stage resizing still changes fit geometry')
  })
  test('real Chromium verifies startup silhouette, dark edge backing, responsive controls and detached size', {timeout:30000},async t=>{
    await mkdir(resolve('.tmp'),{recursive:true});await mkdir(resolve('.synkora/reports'),{recursive:true})
    const directory=await mkdtemp(resolve('.tmp/mobile-appearance-'))
    const stub=join(directory,'hooks.tsx');await writeFile(stub,hookSource)
    const browserEntry=join(directory,'entry.tsx')
    await writeFile(browserEntry,fixtureSource.replaceAll("'./components/",`'${resolve('src/renderer/src/components').replaceAll('\\','/')}/`).replaceAll("'../../shared/",`'${resolve('src/shared').replaceAll('\\','/')}/`))
    const {build}=await import('esbuild')
    await build({entryPoints:[browserEntry],bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:join(directory,'fixture.js'),plugins:[{name:'synthetic-only',setup(build){build.onResolve({filter:/\/(?:useMobileScreen|useMobilePointer|mobileCalibration)$/},()=>({path:stub}))}}]})
    await writeFile(join(directory,'index.html'),`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self';script-src 'self';style-src 'self' 'unsafe-inline';img-src 'self' data:"><title>Synthetic mobile appearance</title><link rel="stylesheet" href="fixture.css"><style>:root{--paper:#efe9dc;--paper-2:#e6dfd1;--card:#f7f2e7;--ink:#2c2924;--ink-2:#69645c;--ink-3:#928c80;--line:#cfc6b7;--line-strong:#b8af9f;--accent:#d96c3f;--accent-deep:#9b4323;--ok:#3e9b5f;--err:#b54036;--mono:Consolas,monospace}*{box-sizing:border-box}body{margin:0;background:var(--paper)}#root,.workspace-panel{height:100vh;width:100%;container:workspace-panel / inline-size}.workspace-panel{position:relative;left:.25px;width:calc(100% - .25px)}.appearance-heading{padding:9px 12px 5px;font-size:10px;letter-spacing:.08em}.appearance-heading span{float:right;font-size:8px;color:var(--ink-3)}</style><div id="root"></div><script src="fixture.js"></script></html>`)
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
    // Pixel probes compare CSS coordinates with bitmap pixels at unit scale.
    const child=spawn(require('electron'),[fileURLToPath(import.meta.url),directory,'--force-device-scale-factor=1'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    t.after(()=>{if(child.exitCode===null)child.kill()})
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk)
    const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done)})
    assert.equal(code,0,output);assert.match(output,/Appearance Electron PASS/);console.log(output.trim())
  })
}
