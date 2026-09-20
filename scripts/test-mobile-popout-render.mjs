import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { buildSync } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const require=createRequire(import.meta.url)
const code=buildSync({stdin:{contents:"export * from './mobileClient';export * from './mobilePhoneController'",resolveDir:resolve('src/renderer/src'),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,external:['react']}).outputFiles[0].text
const module={exports:{}};new Function('require','module','exports',code)(require,module,module.exports)
const {retainMobileView,currentMobileConsumer,createMobilePhoneClient,createMobilePhoneSizer,createMobilePhoneActionQueue}=module.exports
const tick=async()=>{for(let i=0;i<12;i++)await Promise.resolve()}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}}
const ok=value=>({ok:true,value})
const descriptor={windowId:'phone-one',missionId:'mission-one',projectId:'project-one',sessionId:'session-one',platform:'android',session:{id:'session-one',missionId:'mission-one',platform:'android',deviceId:'qa',deviceName:'Android sintético',state:'ready',inputAvailable:true}}

test('one client/session shares exactly one view claim across screen and input readers',async()=>{
 const calls=[],api={acquireView:async(...args)=>{calls.push(['acquire',...args]);return ok({consumerId:'token-one'})},releaseView:async(...args)=>{calls.push(['release',...args]);return ok()}},left=[],right=[]
 const releaseA=retainMobileView(api,'m','s',value=>left.push(value)),releaseB=retainMobileView(api,'m','s',value=>right.push(value));await tick()
 assert.equal(calls.filter(c=>c[0]==='acquire').length,1);assert.equal(currentMobileConsumer(api,'m','s'),'token-one');assert.equal(right.at(-1).consumerId,'token-one')
 releaseA();await tick();assert.equal(calls.filter(c=>c[0]==='release').length,0)
 releaseB();assert.equal(currentMobileConsumer(api,'m','s'),null);await tick();assert.deepEqual(calls.at(-1),['release','m','s','token-one'])
})
test('late acquisition is released before a new generation can claim the same session',async()=>{
 const first=deferred(),finishRelease=deferred(),calls=[];let starts=0
 const api={acquireView:async()=>{calls.push('acquire');return ++starts===1?first.promise:ok({consumerId:'new-token'})},releaseView:async(_m,_s,token)=>{calls.push(`release:${token}`);if(token==='old-token')await finishRelease.promise;return ok()}}
 const dispose=retainMobileView(api,'m','s',()=>{});await tick();dispose()
 const current=[];const cleanup=retainMobileView(api,'m','s',value=>current.push(value));await tick();assert.equal(starts,1)
 first.resolve(ok({consumerId:'old-token'}));await tick();assert.deepEqual(calls,['acquire','release:old-token']);assert.equal(currentMobileConsumer(api,'m','s'),null)
 finishRelease.resolve();await tick();assert.equal(currentMobileConsumer(api,'m','s'),'new-token');assert.equal(current.at(-1).consumerId,'new-token');cleanup();await tick()
})
test('failed acquisition exposes no consumer and cleans the scoped record',async()=>{
 const states=[],api={acquireView:async()=>({ok:false,error:'Sessão em outra janela.'}),releaseView:async()=>{throw Error('must not release nonexistent token')}}
 const dispose=retainMobileView(api,'m','s',value=>states.push(value));await tick();assert.equal(states.at(-1).consumerId,null);assert.equal(states.at(-1).error,'Sessão em outra janela.');dispose();await tick()
})
test('restricted adapter binds identity and never forwards management actions or foreign IDs',async()=>{
 const calls=[],bridge={acquireView:async()=>ok({consumerId:'phone-token'}),releaseView:async(...a)=>{calls.push(['release',...a]);return ok()},capture:async(...a)=>{calls.push(['capture',...a]);return ok()},act:async(...a)=>{calls.push(['act',...a]);return ok()},pointer:async(...a)=>{calls.push(['pointer',...a]);return ok()},setVideoVisible:async(...a)=>{calls.push(['video',...a]);return ok()},ackVideo:(...a)=>calls.push(['ack',...a]),monitorScale:async()=>ok(null),onVideo:()=>()=>{},onChanged:()=>()=>{}}
 const client=createMobilePhoneClient(bridge,descriptor)
 assert.equal((await client.capture('other','session-one','t')).ok,false)
 assert.equal((await client.act('mission-one','session-one',{type:'install',relativePath:'x.apk'},'t')).ok,false)
 assert.equal(calls.length,0)
 await client.pointer('mission-one','session-one',{phase:'down',gestureId:'one',x:.2,y:.4},'phone-token')
 await client.capture('mission-one','session-one','phone-token')
 client.ackVideo('mission-one','session-one','stream',7,'phone-token')
 assert.deepEqual(calls.map(c=>c[0]),['pointer','capture','ack']);assert.deepEqual(calls[1],['capture','phone-token']);assert.deepEqual(calls[2],['ack','stream',7,'phone-token'])
})

test('a rejected resize permits the same physical geometry on the next explicit request',async()=>{
 const calls=[],scheduled=[]
 const sizer=createMobilePhoneSizer(async size=>{calls.push(size);return calls.length===1?{ok:false,error:'Transferência em andamento.'}:ok({...size,clamped:false})},()=>{},callback=>{scheduled.push(callback);return()=>{const i=scheduled.indexOf(callback);if(i>=0)scheduled.splice(i,1)}})
 const size={width:320,height:700};sizer.request(size);scheduled.shift()();await tick()
 assert.equal(calls.length,1);assert.equal(scheduled.length,0,'no automatic retry loop')
 sizer.request(size);assert.equal(scheduled.length,1);scheduled.shift()();await tick()
 assert.equal(calls.length,2);sizer.request(size);assert.equal(scheduled.length,0,'successful geometry remains deduplicated');sizer.dispose()
})

test('window sizing holds one in-flight request and only the latest bounded geometry',async()=>{
 const first=deferred(),calls=[],states=[],scheduled=[]
 const sizer=createMobilePhoneSizer(async size=>{calls.push(size);return calls.length===1?first.promise:ok({...size,clamped:true})},value=>states.push(value),callback=>{scheduled.push(callback);return()=>{const i=scheduled.indexOf(callback);if(i>=0)scheduled.splice(i,1)}})
 sizer.request({width:120.2,height:300.1});scheduled.shift()();await tick()
 sizer.request({width:200,height:400});sizer.request({width:99999,height:1});assert.equal(calls.length,1);assert.equal(scheduled.length,0)
 first.resolve(ok({width:121,height:301,clamped:false}));await tick();assert.equal(scheduled.length,1);scheduled.shift()();await tick()
 assert.deepEqual(calls,[{width:121,height:301},{width:8192,height:100}]);assert.deepEqual(states,[false,true])
 sizer.request({width:NaN,height:500});assert.equal(scheduled.length,0)
 sizer.request({width:300,height:500});sizer.dispose();assert.equal(scheduled.length,0)
})

test('a queued phone button never crosses an ownership handover',async()=>{
 const first=deferred(),calls=[],errors=[];let serial=0
 const client={acquireView:async()=>ok({consumerId:`token-${++serial}`}),releaseView:async()=>ok(),act:async(...args)=>{calls.push(args);return first.promise}}
 const release=retainMobileView(client,descriptor.missionId,descriptor.sessionId,()=>{});await tick()
 const queue=createMobilePhoneActionQueue(client,descriptor,()=>true,value=>errors.push(value))
 const one=queue.send({type:'key',key:'home'}),two=queue.send({type:'key',key:'back'});await tick();assert.equal(calls.length,1)
 release();const cleanup=retainMobileView(client,descriptor.missionId,descriptor.sessionId,()=>{});await tick();assert.equal(currentMobileConsumer(client,descriptor.missionId,descriptor.sessionId),'token-2')
 first.resolve(ok());assert.deepEqual(await Promise.all([one,two]),[false,false]);assert.equal(calls.length,1);assert.equal(calls[0][3],'token-1');assert.deepEqual(errors,[])
 queue.dispose();cleanup();await tick()
})

function loadPhoneHooks(window) {
 const compiled=buildSync({stdin:{contents:"export * from './useMobilePhone';export * from './useMobileView'",resolveDir:resolve('src/renderer/src'),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,external:['react']}).outputFiles[0].text
 const loaded={exports:{}}
 new Function('require','module','exports','window','document',compiled)(require,loaded,loaded.exports,window,{visibilityState:'visible'})
 return loaded.exports
}

async function phoneHookHarness(t,{initial=descriptor,claim,dock}={}) {
 let currentDescriptor=structuredClone(initial),current,tree
 const calls=[],listeners=new Set()
 const bridge={describe:async()=>ok(currentDescriptor),acquireView:async()=>{calls.push(['acquire']);return claim?claim():ok({consumerId:'phone-token'})},
  releaseView:async token=>{calls.push(['release',token]);return ok()},capture:async()=>ok(),act:async()=>ok(),pointer:async()=>ok(),setVideoVisible:async()=>ok(),ackVideo(){},monitorScale:async()=>ok(null),resize:async size=>ok({...size,clamped:false}),
  dock:async()=>{calls.push(['dock']);return dock?dock():ok()},onVideo:()=>()=>{},onChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)}}
 const window={synkoraMobilePhone:bridge}
 Object.defineProperty(window,'synkora',{get(){throw Error('broad owner bridge must not be read')}})
 const hooks=loadPhoneHooks(window)
 function Probe(){const phone=hooks.useMobilePhone('phone-one');const lease=hooks.useMobileView(phone.client,phone.descriptor?.missionId??'',phone.descriptor?.sessionId,phone.enabled,0);current={...phone,lease};return null}
 await act(async()=>{tree=create(React.createElement(Probe));await tick()})
 t.after(async()=>{await act(async()=>{tree.unmount();await tick()})})
 return {calls,get current(){return current},async changed(next){await act(async()=>{currentDescriptor=structuredClone(next);for(const listener of listeners)listener();await tick()})},async unmount(){await act(async()=>{tree.unmount();await tick()})}}
}

test('the restricted phone waits for presentation transfer and never consults the broad owner bridge',async t=>{
 const pending={...descriptor,session:{...descriptor.session,presentation:{host:'detached',windowId:'phone-one',transitioning:true}}}
 const h=await phoneHookHarness(t,{initial:pending});assert.equal(h.current.enabled,false);assert.equal(h.calls.length,0)
 await h.changed({...pending,session:{...pending.session,presentation:{host:'detached',windowId:'phone-one'}}})
 assert.equal(h.current.enabled,true);assert.equal(h.current.lease.consumerId,'phone-token');assert.deepEqual(h.calls,[['acquire']])
 await h.changed(pending);assert.equal(h.current.lease.consumerId,null);assert.deepEqual(h.calls.at(-1),['release','phone-token'])
})

test('rapid return and close gestures share one docking request and immediately release the view',async t=>{
 const done=deferred(),h=await phoneHookHarness(t,{dock:()=>done.promise})
 await act(async()=>{void h.current.dock();void h.current.dock();await tick()})
 assert.equal(h.calls.filter(c=>c[0]==='dock').length,1);assert.equal(h.current.enabled,false);assert.deepEqual(h.calls.at(-1),['release','phone-token'])
 await act(async()=>{done.resolve({ok:false,error:'Tente novamente.'});await tick()})
 assert.equal(h.current.enabled,true);assert.equal(h.current.error,'Tente novamente.');assert.equal(h.calls.filter(c=>c[0]==='acquire').length,2)
})

async function dockHarness(t,{detached=true,missingDetach=false}={}) {
 const calls=[],listeners=new Set(),values=new Map()
 let snapshot={hostPlatform:'darwin',platforms:['android','ios'].map(platform=>({platform,title:platform,supported:true,available:true,inputAvailable:true,setupSteps:[],docsUrl:'https://example.test/docs'})),
  devices:['android','ios'].map(platform=>({id:platform,platform,name:`${platform} sintético`,state:'available'})),
  sessions:['android','ios'].map(platform=>({id:`session-${platform}`,missionId:'m',platform,deviceId:platform,deviceName:`${platform} sintético`,state:'ready',inputAvailable:true,presentation:{host:platform==='android'&&detached?'detached':'dock'}}))}
 const api={inspect:async()=>ok(snapshot),start:async()=>ok(),stop:async()=>{calls.push(['stop']);return ok()},capture:async()=>ok(),act:async()=>ok(),expoInspect:async()=>ok({project:{kind:'other',message:'Projeto sintético.',dependenciesInstalled:false,hasDevClient:false},status:'idle',addresses:[]}),
  acquireView:async(m,s)=>{calls.push(['acquire',m,s]);return ok({consumerId:`token:${s}`})},releaseView:async(m,s,token)=>{calls.push(['release',m,s,token]);return ok()},
  onChanged:callback=>{listeners.add(callback);return()=>listeners.delete(callback)},
  focusDetached:async(m,s)=>{calls.push(['focus',m,s]);return ok()},
  dock:async(m,s)=>{calls.push(['dock',m,s]);snapshot={...snapshot,sessions:snapshot.sessions.map(session=>session.id===s?{...session,presentation:{host:'dock'}}:session)};return ok()},
  detach:missingDetach?undefined:async(m,s)=>{calls.push(['detach',m,s]);snapshot={...snapshot,sessions:snapshot.sessions.map(session=>session.id===s?{...session,presentation:{host:'detached'}}:session)};return ok(descriptor)}}
 const window={synkora:{mobile:api},localStorage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)},addEventListener(){},removeEventListener(){}}
 const compiled=buildSync({stdin:{contents:"export {default as DockMobile} from './components/DockMobile';export {WorkspacePanelVisibility} from './workspace/WorkspacePanelContext';export {useMobileView} from './useMobileView'",resolveDir:resolve('src/renderer/src'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',write:false,loader:{'.css':'empty'},external:['react','react/jsx-runtime','react-dom','./MobileViewport']}).outputFiles[0].text
 const loaded={exports:{}}
 const customRequire=name=>name==='./MobileViewport'?{__esModule:true,default:props=>{const view=loaded.exports.useMobileView(api,props.missionId,props.session?.id,props.visible&&props.session?.state==='ready',0);return React.createElement('div',{'data-test-viewport':props.session?.id,'data-consumer':view.consumerId})},MobileControlIcon:()=>null}:require(name)
 new Function('require','module','exports','window','document',compiled)(customRequire,loaded,loaded.exports,window,{visibilityState:'visible',addEventListener(){},removeEventListener(){}})
 let tree
 await act(async()=>{tree=create(React.createElement(loaded.exports.WorkspacePanelVisibility.Provider,{value:true},React.createElement(loaded.exports.DockMobile,{missionId:'m',projectId:'p',visible:true})));await tick()})
 t.after(async()=>{await act(async()=>{tree.unmount();await tick()})})
 return {tree,calls,async click(label){await act(async()=>{const button=tree.root.findAllByType('button').find(button=>button.props['aria-label']===label||button.children.join('')===label);assert.ok(button,`button ${label}`);button.props.onClick();await tick()})}}
}

test('main panel suppresses a detached viewport, focuses/docks it and independently selects iOS',async t=>{
 const h=await dockHarness(t)
 assert.equal(h.tree.root.findAllByProps({'data-test-viewport':'session-android'}).length,0);assert.deepEqual(h.calls,[])
 await h.click('Mostrar janela');assert.deepEqual(h.calls,[['focus','m','session-android']])
 await h.click('Selecionar iOS');assert.equal(h.tree.root.findAllByProps({'data-test-viewport':'session-ios'}).length,1)
 assert.ok(h.calls.some(call=>call[0]==='acquire'&&call[2]==='session-ios'))
 await h.click('Selecionar Android');assert.equal(h.tree.root.findAllByProps({'data-test-viewport':'session-ios'}).length,0)
 await h.click('Trazer ao painel');assert.equal(h.tree.root.findAllByProps({'data-test-viewport':'session-android'}).length,1)
 await h.click('Destacar aparelho em janela');assert.equal(h.tree.root.findAllByProps({'data-test-viewport':'session-android'}).length,0)
 assert.equal(h.calls.filter(call=>call[0]==='acquire'&&call[2]==='session-android').length,1)
 assert.ok(h.calls.some(call=>call[0]==='release'&&call[2]==='session-android'));assert.ok(!h.calls.some(call=>call[0]==='stop'))
})

test('old preloads show the reopen recipe when detach has not been loaded',async t=>{
 const h=await dockHarness(t,{detached:false,missingDetach:true})
 await h.click('Destacar aparelho em janela')
 assert.ok(JSON.stringify(h.tree.toJSON()).includes('Reabra o Synkora para carregar as janelas do aparelho.'))
 assert.equal(h.tree.root.findAllByProps({'data-test-viewport':'session-android'}).length,1)
})
