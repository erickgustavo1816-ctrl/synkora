#!/usr/bin/env node
/** Deterministic runner regressions; synthetic data, no Electron/app/session. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { runBrowserCheck, validateBrowserCheck } from '../.tmp/browser-driver-test/main/browserCheck.js'
import { instrumentBrowserToolkit } from '../.tmp/browser-driver-test/main/browserToolMetrics.js'

function fixture(options = {}) {
  const events = []
  let clock = 0
  let scenario = 0
  let errors = 0
  const raw = {
    ok: true, tag: 'button', role: 'button', name: 'Comprar',
    box: { x: 10, y: 20, w: 120, h: 40, pageX: 10, pageY: 20 },
    viewport: { w: 375, h: 800 }, visible: true, inViewport: true,
    styles: {}, color: 'rgb(0,0,0)', backgrounds: ['rgb(255,255,255)'],
    fontSizePx: 16, fontWeight: 400, hasText: true,
    overflowX: false, overflowY: false, scrollW: 120, clientW: 120, scrollH: 40, clientH: 40,
    ellipsis: false, occluded: false, occluder: '', ...options.raw
  }
  const context = {
    now: () => clock,
    sleep: async (ms) => { clock += ms },
    guard: () => options.guard?.(events) ?? { ok: true },
    viewport: (width) => { events.push(['viewport', width]); scenario += 1; if (!options.viewportMismatch) raw.viewport.w = width; return options.viewport ?? { ok: true } },
    capture: async (input) => {
      events.push(['capture', input])
      return options.capture ?? {
        ok: true, text: 'arquivo gravado',
        artifact: { path: `.synkora/browser/synthetic/${scenario}.jpg`, width: 1200, height: 675, bytes: 20, fresh: true },
        ...(input.purpose === 'vision' ? { image: { data: 'AAAA', mimeType: 'image/jpeg' } } : {})
      }
    },
    driver: {
      readyState: async () => { events.push(['ready']); return options.loading ? 'loading' : 'complete' },
      viewportSize: async () => ({ width: raw.viewport.w, height: raw.viewport.h }),
      consoleCheckpoint: () => 10,
      consoleSince: (cursor) => {
        assert.equal(cursor, 10)
        return { text: 'synthetic console', entries: errors, errors, complete: options.consoleComplete ?? true }
      },
      actResult: async (actions, read, execution) => {
        events.push(['action', actions[0], read, execution])
        if (options.newErrorOnAction) errors += 1
        if (options.actionTime) clock += options.actionTime
        return options.action ?? { ok: true, text: 'erro é só um título da página', completed: 1, total: 1 }
      },
      waitResult: async (wait) => { events.push(['wait', wait]); return options.wait ?? { ok: true, text: 'condição encontrada' } },
      probeResult: async (params) => {
        events.push(['probe', params.selector])
        return options.probe ?? { ok: true, text: 'medições extensas omitidas no compacto', value: raw }
      }
    }
  }
  return { context, events, raw }
}

const basic = () => ({ targets: [{ selector: '#cta', checks: ['visible', 'noHorizontalOverflow'] }] })

test('CHECK: etapas conhecidas são locais; não duplica ações implicitamente entre larguras', async () => {
  const { context, events } = fixture()
  const result = await runBrowserCheck(context, {
    ...basic(), scenarios: [
      { width: 375, actions: [{ action: 'click', selector: '#cta' }], wait: { selector: '#ready' } },
      { width: 1280 }
    ], capture: { name: 'resultado' }
  })
  assert.equal(result.ok, true)
  assert.equal(result.completedScenarios, 2)
  assert.deepEqual(events.map((event) => event[0]), ['ready', 'viewport', 'action', 'wait', 'probe', 'capture', 'viewport', 'probe', 'capture'])
  const action = events.find((event) => event[0] === 'action')
  assert.equal(action[3].observe, false)
  assert.equal(action[3].deadlineAt, 20000)
  assert.equal(result.images, undefined)
  assert.match(result.text, /Geometria.*estética/u)
  assert.ok(result.text.length <= 2000)
})

test('CHECK: falha estruturada de ação para mesmo se a frase parece sucesso', async () => {
  const { context, events } = fixture({ action: { ok: false, text: 'status textual neutro', completed: 0, total: 1 } })
  const result = await runBrowserCheck(context, {
    ...basic(), scenarios: [{ actions: [{ action: 'click', selector: '#one' }, { action: 'click', selector: '#two' }], wait: { selector: '#ready' } }], capture: {}
  })
  assert.equal(result.ok, false)
  assert.deepEqual(events.map((event) => event[0]), ['ready', 'action'])
  assert.match(result.text, /status textual neutro/u)
})

test('CHECK: sucesso estruturado não é classificado pelo texto do elemento', async () => {
  const { context } = fixture()
  assert.equal((await runBrowserCheck(context, { ...basic(), scenarios: [{ actions: [{ action: 'click', selector: '#error-label' }] }] })).ok, true)
})

test('CHECK: espera expirada impede medidas, captura e próximo cenário', async () => {
  const { context, events } = fixture({ wait: { ok: false, timedOut: true, text: 'condição ausente; receita browser_read' } })
  const result = await runBrowserCheck(context, { ...basic(), scenarios: [{ wait: { selector: '#ready' } }, { width: 1280 }], capture: {} })
  assert.equal(result.ok, false)
  assert.deepEqual(events.map((event) => event[0]), ['ready', 'wait'])
})

test('CHECK: carregamento que não termina esgota o orçamento sem aprovar o esqueleto', async () => {
  const { context, events } = fixture({ loading: true })
  const result = await runBrowserCheck(context, { ...basic(), timeoutMs: 200 })
  assert.equal(result.ok, false)
  assert.equal(result.completedScenarios, 0)
  assert.ok(events.every((event) => event[0] === 'ready'))
  assert.match(result.text, /orçamento de tempo/u)
})

test('CHECK: deadline impede próxima ação e passa teto absoluto ao driver', async () => {
  const { context, events } = fixture({ actionTime: 600 })
  const result = await runBrowserCheck(context, { ...basic(), timeoutMs: 500, scenarios: [{ actions: [{ action: 'press', key: 'Tab' }, { action: 'press', key: 'Enter' }] }] })
  assert.equal(result.ok, false)
  assert.equal(events.filter((event) => event[0] === 'action').length, 1)
  assert.equal(events.find((event) => event[0] === 'action')[3].deadlineAt, 500)
  assert.match(result.text, /nenhum passo seguinte/u)
})

test('CHECK: mudança de controle pelo dono interrompe antes dos passos seguintes', async () => {
  const { context, events } = fixture({ guard: (events) => events.some((event) => event[0] === 'viewport') ? { ok: false, error: 'largura mudou pelo dono; use browser_read' } : { ok: true } })
  const result = await runBrowserCheck(context, { ...basic(), scenarios: [{ width: 375, actions: [{ action: 'click', selector: '#cta' }] }] })
  assert.equal(result.ok, false)
  assert.deepEqual(events.map((event) => event[0]), ['ready', 'viewport'])
  assert.match(result.text, /dono/u)
})

test('CHECK: falhas semeadas de transbordo e visibilidade param os passos dependentes', async () => {
  for (const raw of [{ overflowX: true, scrollW: 180 }, { visible: false }]) {
    const { context, events } = fixture({ raw })
    const result = await runBrowserCheck(context, { ...basic(), scenarios: [{ width: 375 }, { width: 1280 }], capture: {} })
    assert.equal(result.ok, false)
    assert.deepEqual(events.map((event) => event[0]), ['ready', 'viewport', 'probe'])
    assert.match(result.text, /browser_probe/u)
  }
})

test('CHECK: falha de probe não vira alvo ausente aprovado', async () => {
  const { context, events } = fixture({ probe: { ok: false, text: 'seletor ausente; use browser_read' } })
  const result = await runBrowserCheck(context, { ...basic(), capture: {} })
  assert.equal(result.ok, false)
  assert.deepEqual(events.map((event) => event[0]), ['ready', 'probe'])
})

test('CHECK: largura medida diferente da solicitada não confirma o cenário responsivo', async () => {
  const { context, events } = fixture({ viewportMismatch: true })
  const result = await runBrowserCheck(context, { ...basic(), scenarios: [{ width: 1280, actions: [{ action: 'click', selector: '#cta' }] }], capture: {} })
  assert.equal(result.ok, false)
  assert.match(result.text, /1280.*375/u)
  assert.deepEqual(events.map((event) => event[0]), ['ready', 'viewport'], 'não clica sob largura não confirmada')
})

test('CHECK: erro novo de console interrompe sem outra ida ao modelo', async () => {
  const { context, events } = fixture({ newErrorOnAction: true })
  const result = await runBrowserCheck(context, { ...basic(), scenarios: [{ actions: [{ action: 'click', selector: '#cta' }, { action: 'press', key: 'Enter' }] }] })
  assert.equal(result.ok, false)
  assert.deepEqual(events.map((event) => event[0]), ['ready', 'action'])
  assert.match(result.text, /browser_console/u)
})

test('CHECK: cobertura parcial do console é explícita sem aprovação geral', async () => {
  const { context } = fixture({ consoleComplete: false })
  const result = await runBrowserCheck(context, basic())
  assert.equal(result.ok, true, 'o resultado geométrico solicitado continua válido')
  assert.match(result.text, /console parcialmente verificado/u)
  assert.doesNotMatch(result.text, /^OK/u)
})

test('CHECK: imagem sem frescor não confirma aparência; visão explícita mantém o pixel', async () => {
  const stale = fixture({ capture: { ok: true, text: 'salva', artifact: { path: '.synkora/browser/synthetic/1.jpg', width: 500, height: 300, bytes: 10, fresh: false } } })
  const staleResult = await runBrowserCheck(stale.context, { ...basic(), capture: {} })
  assert.equal(staleResult.ok, false)
  assert.match(staleResult.text, /imagem não confirma aparência/u)
  const vision = fixture()
  const visibleResult = await runBrowserCheck(vision.context, { ...basic(), capture: { purpose: 'vision' } })
  assert.equal(visibleResult.images.length, 1)
})

test('CHECK: teto de resposta anuncia corte e preserva receita', async () => {
  const { context } = fixture()
  const result = await runBrowserCheck(context, {
    targets: Array.from({ length: 8 }, (_, index) => ({ selector: '#target-' + index + '-long-section'.repeat(10) })),
    scenarios: [{ width: 375 }, { width: 1280 }], responseMaxChars: 500
  })
  assert.ok(result.text.length <= 500)
  assert.match(result.text, /CORTADO.*browser_probe/u)
})

test('CHECK: input fora do teto é recusado antes de qualquer efeito', async () => {
  for (const input of [
    { targets: [] },
    { ...basic(), scenarios: Array.from({ length: 5 }, () => ({})) },
    { ...basic(), scenarios: [{ actions: Array.from({ length: 25 }, () => ({ action: 'press', key: 'Tab' })) }] },
    { ...basic(), scenarios: [{ width: 99 }] },
    { ...basic(), scenarios: [{ wait: {} }] },
    { ...basic(), responseMaxChars: 10 }
  ]) {
    const { context, events } = fixture()
    assert.ok(validateBrowserCheck(input))
    const result = await runBrowserCheck(context, input)
    assert.equal(result.ok, false)
    assert.equal(result.localSteps, 0)
    assert.deepEqual(events, [])
  }
})

test('MÉTRICAS: só metadados; serializa chamadas da mesma identidade sem intercalar', async () => {
  const events = []
  const logs = []
  let release
  const blocked = new Promise((resolve) => { release = resolve })
  const kit = instrumentBrowserToolkit({
    check: async () => { events.push('check:start'); await blocked; events.push('check:end'); return { ok: true, text: 'sensitive synthetic DOM', localSteps: 5, completedScenarios: 1 } },
    read: async () => { events.push('read'); return 'secret-looking synthetic body' }
  }, () => ({ missionId: 'm1', projectId: 'p1' }), (entry) => logs.push(entry))
  const id = { paneId: 'synthetic-pane' }
  const check = kit.check(id, { url: 'http://example.invalid/private-synthetic-token' })
  const read = kit.read(id, { scope: '#private-synthetic-value' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['check:start'])
  release()
  await Promise.all([check, read])
  assert.deepEqual(events, ['check:start', 'check:end', 'read'])
  assert.equal(logs.length, 2)
  assert.ok(logs.every((entry) => entry.event === 'browser-tool-result' && entry.detail.modelImages === 0 && entry.detail.resultCharacters > 0))
  assert.doesNotMatch(JSON.stringify(logs), /sensitive|private|secret-looking|http|DOM/u)
  assert.notEqual(logs[0].detail.callId, logs[1].detail.callId)
})

test('CHROMIUM: browser_check real aplica ação e duas larguras; captura e recusa alvo ausente', { timeout: 30000 }, async (t) => {
  await mkdir(resolve('.tmp'), { recursive: true })
  const directory = await mkdtemp(resolve('.tmp/browser-check-chromium-'))
  buildSync({
    entryPoints: [resolve('src/main/guiBrowserTools.ts')], bundle: true,
    platform: 'node', format: 'cjs', outfile: join(directory, 'kit.cjs'), external: ['electron']
  })
  const entry = join(directory, 'smoke.cjs')
  await writeFile(entry, String.raw`
    const assert = require('node:assert/strict');
    const { app, BrowserWindow } = require('electron');
    const { buildGuiBrowserTools } = require('./kit.cjs');
    const { join } = require('node:path');
    const { existsSync } = require('node:fs');
    app.setPath('userData', join(__dirname, 'isolated-profile'));
    app.disableHardwareAcceleration();
    app.whenReady().then(async () => {
      const page = new BrowserWindow({ width:800, height:640, show:false, useContentSize:true,
        webPreferences:{ sandbox:true, contextIsolation:true, offscreen:true, backgroundThrottling:false } });
      try {
        await page.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><title>Synthetic browser check</title><meta charset="utf-8"><style>body{margin:0;font:16px Arial;background:white;color:black}main{box-sizing:border-box;margin:16px;padding:16px;border:1px solid;max-width:850px}button{height:44px}#ready[hidden]{display:none}</style><main id="hero"><h1>Seção sintética</h1><button id="cta">Atualizar</button><p id="ready" hidden>Atualização confirmada</p></main><script>document.querySelector("#cta").onclick=()=>{document.querySelector("#ready").hidden=false;document.querySelector("#cta").textContent="Atualizado"}</script>'));
        const owner = { kind:'dev', label:'synthetic', paneId:'synthetic-pane' };
        const tab = { tabId:'synthetic-tab', webContents:page.webContents };
        let mode = 'auto';
        const writes = [];
        const kit = buildGuiBrowserTools({
          manager:{
            ensureTab:async (_m,_p,_u,actor)=>{ assert.equal(actor.paneId,owner.paneId);return tab },
            tabOf:(_m,paneId)=>paneId===owner.paneId?tab:undefined,
            activeTab:()=>{throw new Error('agent must never borrow active tab')},
            listTabs:()=>[],selectTab:()=>false,closeMission:()=>{},closeTabsOf:()=>0,setAgentDriving:()=>{},
            setViewportMode:(_m,width,actor,tabId)=>{ assert.equal(actor,'agent');assert.equal(tabId,tab.tabId);mode=width;writes.push(width);page.setContentSize(width,640);return {ok:true} },
            viewportOf:()=>mode,viewportFrameWidth:()=>page.getContentSize()[0],captureReadiness:()=>({ok:true,tab})
          },
          resolveTarget:()=>({missionId:'synthetic-mission',projectId:'synthetic-project',root:__dirname,owner}),
          cliOf:()=> 'claude'
        });
        const identity = {paneId:owner.paneId,projectId:'synthetic-project',role:'gui-delegator',missionId:'synthetic-mission',cwd:__dirname};
        const result = await kit.check(identity, {
          scenarios:[
            {width:375,actions:[{action:'click',selector:'#cta'}],wait:{selector:'#ready'}},
            {width:1280,wait:{selector:'#ready'}}
          ],
          targets:[{selector:'#hero',checks:['visible','noHorizontalOverflow']},{selector:'#ready',checks:['visible','inViewport']}],
          capture:{name:'synthetic-check'},responseMaxChars:2000
        });
        assert.equal(result.ok,true,result.text);
        assert.equal(result.completedScenarios,2);
        assert.deepEqual(writes,[375,1280]);
        assert.equal(result.images,undefined,'owner artifacts do not enter model context');
        const mobile = /1\/2 375px.*viewport (\d+)x/.exec(result.text);
        const desktop = /2\/2 1280px.*viewport (\d+)x/.exec(result.text);
        assert.ok(mobile && Math.abs(Number(mobile[1])-375)<=2,'CSS width must match request within native DPI rounding');
        assert.ok(desktop && Math.abs(Number(desktop[1])-1280)<=2,'both viewport scenarios must be measured independently');
        assert.match(result.text,/quadro FRESCO/);
        assert.equal(existsSync(join(__dirname,'.synkora/browser/synthetic-mission/001-synthetic-check-375.jpg')),true);
        assert.equal(existsSync(join(__dirname,'.synkora/browser/synthetic-mission/002-synthetic-check-1280.jpg')),true);
        const changed = await kit.read(identity,{scope:'#ready'});
        assert.match(changed,/Atualização confirmada/,'a fresh driver read verifies the mutation');
        const missing = await kit.check(identity,{targets:[{selector:'#does-not-exist'}],capture:{name:'must-not-capture'}});
        assert.equal(missing.ok,false);
        assert.equal(missing.completedScenarios,0);
        assert.match(missing.text,/does-not-exist/);
        assert.equal(existsSync(join(__dirname,'.synkora/browser/synthetic-mission/003-must-not-capture-1.jpg')),false);
        console.log('PASS isolated Chromium: real CDP input, widths 375/1280, fresh scoped read, two fresh owner captures, missing-target stop.');
      } finally { page.destroy() }
    }).then(()=>app.exit(0)).catch(error=>{console.error(error.stack);app.exit(1)});
  `, 'utf8')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(createRequire(import.meta.url)('electron'), [entry], {
    env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let output = ''
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-12000) })
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-12000) })
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  assert.equal(exit, 0, output)
  assert.match(output, /PASS isolated Chromium/)
  t.diagnostic(output.trim())
})
