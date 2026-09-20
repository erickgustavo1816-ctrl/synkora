import { randomUUID } from 'node:crypto'
import type { MobileResult, MobileVideoPacket } from '../shared/mobileSimulator'
import type { H264AccessUnit } from './mobileH264'
import { mobileExecutor, type MobileExecutor } from './mobileProcess'
import type { MobileRuntimeVideoTarget } from './mobileRuntime'
import { createMobileAndroidVideo, type MobileAndroidVideoChannel } from './mobileScrcpyVideo'

export const MOBILE_VIDEO_LIMITS = Object.freeze({
  maxStreamEdge:2400, maxDisplayEdge:8192, maxDisplayPixels:16*1024*1024,
  maxInFlight:3, maxQueuedUnits:32, maxQueuedBytes:4*1024*1024, maxQueueAgeMs:500,
  pressureRetryDelayMs:50, maxVisibleStreams:8, maxRetries:3, retryDelayMs:500,
  ackTimeoutMs:2500, startupTimeoutMs:15_000
})

interface RegistryOptions {
  resolveTarget(missionId:string,sessionId:string):Promise<MobileResult<MobileRuntimeVideoTarget>>
  emit(packet:MobileVideoPacket):void
  serverPath?:string
  executor?:MobileExecutor
  createVideo?:typeof createMobileAndroidVideo
  /** Monotonic milliseconds. Injectable for deterministic lifecycle tests. */
  now?:()=>number
}
interface InFlight {streamId:string;timer:ReturnType<typeof setTimeout>}
interface QueuedUnit {unit:H264AccessUnit;timestampUs:number;queuedAt:number}
interface RunningVideo {
  channel?:MobileAndroidVideoChannel
  target:MobileRuntimeVideoTarget
  abort:AbortController
  unlink():void
  ready:boolean
  closed:boolean
  streamId:string
  hasSession:boolean
  waitingForKey:boolean
  originPts?:number
  originTimestamp?:number
  lastPts?:number
  queue:QueuedUnit[]
  queuedBytes:number
  paused:boolean
  draining:boolean
  queueTimer?:ReturnType<typeof setTimeout>
  startupTimer?:ReturnType<typeof setTimeout>
}
interface VisibleVideo {
  missionId:string
  sessionId:string
  abort:AbortController
  failures:number
  lastTimestampUs:number
  inFlight:Map<number,InFlight>
  running?:RunningVideo
  starting?:Promise<MobileResult>
  cleanup:Promise<void>
  retryTimer?:ReturnType<typeof setTimeout>
  unavailable:boolean
}
const success=():MobileResult=>({ok:true,value:undefined})
const unavailable=():MobileResult=>({ok:false,error:'Vídeo indisponível. Use a captura de tela ou reinicie a visualização no painel Mobile.'})
const cancelled=():MobileResult=>({ok:false,error:'A visualização de vídeo foi encerrada.'})
const keyFor=(missionId:string,sessionId:string):string=>JSON.stringify([missionId,sessionId])

/** Size estimate only. The framed producer's SESSION is authoritative and the
 * encoder may align edges to eight pixels. This never changes Android WM. */
export function mobileVideoSize(width:number,height:number):{width:number;height:number}|null {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width<=0 || height<=0 || width>MOBILE_VIDEO_LIMITS.maxDisplayEdge || height>MOBILE_VIDEO_LIMITS.maxDisplayEdge || width*height>MOBILE_VIDEO_LIMITS.maxDisplayPixels) return null
  const scale=Math.min(1,MOBILE_VIDEO_LIMITS.maxStreamEdge/Math.max(width,height))
  if (scale===1 || Math.min(width,height)*scale<2) return {width,height}
  return {width:Math.round(width*scale/2)*2,height:Math.round(height*scale/2)*2}
}

/** Exact ACK credits belong to the visible lease, across producer/SESSION
 * generations. Every native producer is retired before its replacement opens. */
export class MobileVideoRegistry {
  private readonly visible=new Map<string,VisibleVideo>()
  private readonly closing=new Map<string,{missionId:string;promise:Promise<void>}>()
  private readonly now:()=>number
  private disposed=false
  private disposing?:Promise<void>
  constructor(private readonly options:RegistryOptions) {this.now=options.now ?? (()=>performance.now())}

  async setVisible(missionId:string,sessionId:string,visible:boolean):Promise<MobileResult> {
    if (!visible) {await this.closeSession(missionId,sessionId); return success()}
    if (this.disposed) return cancelled()
    if (!missionId || !sessionId || missionId.length>200 || sessionId.length>200) return unavailable()
    const key=keyFor(missionId,sessionId), existing=this.visible.get(key)
    if (existing) return existing.starting ?? (existing.unavailable ? unavailable():success())
    const occupied=new Set([...this.visible.keys(),...this.closing.keys()])
    if (!occupied.has(key) && occupied.size>=MOBILE_VIDEO_LIMITS.maxVisibleStreams) return unavailable()
    const entry:VisibleVideo={missionId,sessionId,abort:new AbortController(),failures:0,lastTimestampUs:-1,inFlight:new Map(),cleanup:Promise.resolve(),unavailable:false}
    this.visible.set(key,entry)
    return this.begin(entry,this.closing.get(key)?.promise)
  }
  acknowledge(missionId:string,sessionId:string,streamId:string,timestampUs:number):void {
    const entry=this.visible.get(keyFor(missionId,sessionId)), pending=entry?.inFlight.get(timestampUs)
    if (!entry || !Number.isSafeInteger(timestampUs) || !pending || pending.streamId!==streamId) return
    clearTimeout(pending.timer); entry.inFlight.delete(timestampUs)
    if (entry.running) this.drain(entry,entry.running)
  }
  closeSession(missionId:string,sessionId:string):Promise<void> {
    const key=keyFor(missionId,sessionId), entry=this.visible.get(key), previous=this.closing.get(key)?.promise
    if (!entry) return previous ?? Promise.resolve()
    this.visible.delete(key)
    entry.abort.abort(); clearTimeout(entry.retryTimer)
    if (entry.running) this.detach(entry,entry.running)
    for (const pending of entry.inFlight.values()) clearTimeout(pending.timer)
    entry.inFlight.clear()
    const cleanup=(async()=>{
      await previous
      await entry.starting?.catch(()=>undefined)
      await entry.cleanup
    })()
    this.closing.set(key,{missionId,promise:cleanup})
    void cleanup.finally(()=>{if(this.closing.get(key)?.promise===cleanup) this.closing.delete(key)})
    return cleanup
  }
  async closeMission(missionId:string):Promise<void> {
    const pending=[...this.visible.values()].filter(entry=>entry.missionId===missionId).map(entry=>this.closeSession(missionId,entry.sessionId))
    pending.push(...[...this.closing.values()].filter(entry=>entry.missionId===missionId).map(entry=>entry.promise))
    await Promise.all(pending)
  }
  dispose():Promise<void> {
    if (this.disposing) return this.disposing
    this.disposed=true
    const pending=[...this.visible.values()].map(entry=>this.closeSession(entry.missionId,entry.sessionId))
    pending.push(...[...this.closing.values()].map(entry=>entry.promise))
    this.disposing=Promise.all(pending).then(()=>undefined)
    return this.disposing
  }
  private current(entry:VisibleVideo):boolean {
    return !this.disposed && !entry.abort.signal.aborted && this.visible.get(keyFor(entry.missionId,entry.sessionId))===entry
  }
  private begin(entry:VisibleVideo,barrier?:Promise<void>):Promise<MobileResult> {
    const pending=this.start(entry,barrier)
    entry.starting=pending
    void pending.finally(()=>{if(entry.starting===pending) entry.starting=undefined})
    return pending
  }
  private async start(entry:VisibleVideo,barrier?:Promise<void>):Promise<MobileResult> {
    await barrier
    if (!this.current(entry)) return cancelled()
    let target:MobileResult<MobileRuntimeVideoTarget>
    try {target=await this.options.resolveTarget(entry.missionId,entry.sessionId)} catch {target={ok:false,error:''}}
    if (!this.current(entry)) return cancelled()
    if (entry.unavailable) return unavailable()
    if (!target.ok || !this.options.serverPath || !/^emulator-\d{4,5}$/u.test(target.value.serial) || Number(target.value.serial.slice(9))<5554 || Number(target.value.serial.slice(9))>65534 || Number(target.value.serial.slice(9))%2 || !target.value.executable || /[\0\r\n]/u.test(target.value.executable) || !mobileVideoSize(target.value.width,target.value.height) || !target.value.signal || typeof target.value.assertCurrent!=='function' || typeof target.value.verifyTarget!=='function') {
      entry.unavailable=true; return unavailable()
    }
    const lease=target.value, abort=new AbortController()
    const running:RunningVideo={target:lease,abort,unlink:()=>{},ready:false,closed:false,streamId:'',hasSession:false,waitingForKey:true,queue:[],queuedBytes:0,paused:true,draining:false}
    entry.running=running
    const revoked=():void=>{entry.unavailable=true; clearTimeout(entry.retryTimer); this.detach(entry,running)}
    const hidden=():void=>abort.abort()
    lease.signal.addEventListener('abort',revoked,{once:true}); entry.abort.signal.addEventListener('abort',hidden,{once:true})
    running.unlink=()=>{lease.signal.removeEventListener('abort',revoked); entry.abort.signal.removeEventListener('abort',hidden)}
    const assertCurrent=():void=>{
      if (!this.current(entry) || entry.running!==running || abort.signal.aborted || lease.signal.aborted || entry.unavailable) throw new Error('Mobile video lease ended')
      lease.assertCurrent()
    }
    try {
      assertCurrent()
      const channel=await (this.options.createVideo ?? createMobileAndroidVideo)({
        executable:lease.executable,serial:lease.serial,serverPath:this.options.serverPath,executor:this.options.executor ?? mobileExecutor,
        signal:abort.signal,assertCurrent,verifyTarget:async()=>{assertCurrent(); await lease.verifyTarget(abort.signal); assertCurrent()},
        onSession:session=>{if(running.ready) this.session(entry,running,session.width,session.height)},
        onFrame:frame=>{if(running.ready) this.publish(entry,running,frame.unit,frame.ptsUs)},
        onClosed:()=>{running.closed=true; if(running.ready) this.finish(entry,running)}
      })
      running.channel=channel
      assertCurrent()
      if (running.closed || !channel.alive()) throw new Error('Mobile video channel ended')
      running.ready=true
      this.startupDeadline(entry,running)
      this.drain(entry,running)
      return entry.unavailable || entry.running!==running ? unavailable():success()
    } catch {
      const current=this.current(entry) && entry.running===running
      this.detach(entry,running)
      await entry.cleanup
      if (current && !entry.unavailable) this.retry(entry)
      return this.current(entry) ? unavailable():cancelled()
    }
  }
  private authorized(entry:VisibleVideo,running:RunningVideo):boolean {
    if (!this.current(entry) || entry.running!==running || running.abort.signal.aborted || entry.unavailable) return false
    try {running.target.assertCurrent(); if(running.target.signal.aborted) throw new Error(); return true}
    catch {entry.unavailable=true; clearTimeout(entry.retryTimer); this.detach(entry,running); return false}
  }
  private startupDeadline(entry:VisibleVideo,running:RunningVideo):void {
    clearTimeout(running.startupTimer)
    running.startupTimer=setTimeout(()=>this.finish(entry,running),MOBILE_VIDEO_LIMITS.startupTimeoutMs)
  }
  private session(entry:VisibleVideo,running:RunningVideo,width:number,height:number):void {
    if (!this.authorized(entry,running)) return
    if (![width,height].every(value=>Number.isInteger(value) && value>0 && value<=MOBILE_VIDEO_LIMITS.maxStreamEdge)) {this.finish(entry,running); return}
    running.streamId=randomUUID(); running.hasSession=true; running.waitingForKey=true
    running.originPts=undefined; running.originTimestamp=undefined; running.lastPts=undefined
    running.queue=[]; running.queuedBytes=0; clearTimeout(running.queueTimer); running.queueTimer=undefined
    this.startupDeadline(entry,running)
    this.drain(entry,running)
  }
  private publish(entry:VisibleVideo,running:RunningVideo,unit:H264AccessUnit,ptsUs:number):void {
    if (!this.authorized(entry,running)) return
    if (!running.hasSession || !Number.isSafeInteger(ptsUs) || ptsUs<0 || (running.lastPts!==undefined && ptsUs<running.lastPts) || !(unit.data instanceof Uint8Array) || unit.data.byteLength>2*1024*1024) {this.finish(entry,running); return}
    running.lastPts=ptsUs
    if (running.waitingForKey && !unit.key) return
    if (running.originPts===undefined) {running.originPts=ptsUs; running.originTimestamp=Math.max(entry.lastTimestampUs+1,Math.round(this.now()*1000))}
    const timestampUs=Math.max(entry.lastTimestampUs+1,running.originTimestamp!+(ptsUs-running.originPts))
    if (!Number.isSafeInteger(timestampUs) || timestampUs<0) {this.finish(entry,running); return}
    running.waitingForKey=false; clearTimeout(running.startupTimer); running.startupTimer=undefined
    if (running.queue.length>=MOBILE_VIDEO_LIMITS.maxQueuedUnits || running.queuedBytes+unit.data.byteLength>MOBILE_VIDEO_LIMITS.maxQueuedBytes) {this.recoverPressure(entry,running); return}
    entry.lastTimestampUs=timestampUs
    running.queue.push({unit,timestampUs,queuedAt:this.now()}); running.queuedBytes+=unit.data.byteLength
    this.drain(entry,running)
  }
  private drain(entry:VisibleVideo,running:RunningVideo):void {
    if (!running.ready || !this.authorized(entry,running) || running.draining) return
    running.draining=true
    try {
      while(running.queue.length && entry.inFlight.size<MOBILE_VIDEO_LIMITS.maxInFlight && entry.running===running) {
        const queued=running.queue.shift()!; running.queuedBytes-=queued.unit.data.byteLength
        if(this.now()-queued.queuedAt>MOBILE_VIDEO_LIMITS.maxQueueAgeMs) {this.recoverPressure(entry,running); return}
        this.send(entry,running,queued)
      }
      if(entry.running!==running) return
      clearTimeout(running.queueTimer); running.queueTimer=undefined
      const oldest=running.queue[0]
      if(oldest) running.queueTimer=setTimeout(()=>{if(entry.running===running && running.queue[0]===oldest) this.recoverPressure(entry,running)},Math.max(1,MOBILE_VIDEO_LIMITS.maxQueueAgeMs-(this.now()-oldest.queuedAt)))
    } finally {running.draining=false}
    if (!this.authorized(entry,running)) return
    const pause=running.queue.length>0 || entry.inFlight.size>=MOBILE_VIDEO_LIMITS.maxInFlight
    try {
      if(pause && !running.paused) {running.paused=true; running.channel!.pause()}
      else if(!pause && running.paused) {running.paused=false; running.channel!.resume()}
    } catch {this.finish(entry,running)}
  }
  private send(entry:VisibleVideo,running:RunningVideo,queued:QueuedUnit):void {
    if(!this.authorized(entry,running)) return
    const {unit,timestampUs}=queued
    const timer=setTimeout(()=>{
      if(!this.current(entry) || !entry.inFlight.has(timestampUs)) return
      entry.unavailable=true; clearTimeout(entry.retryTimer); entry.retryTimer=undefined
      if(entry.running) this.detach(entry,entry.running)
    },MOBILE_VIDEO_LIMITS.ackTimeoutMs)
    entry.inFlight.set(timestampUs,{streamId:running.streamId,timer})
    try {this.options.emit({missionId:entry.missionId,sessionId:entry.sessionId,streamId:running.streamId,codec:unit.codec,timestampUs,key:unit.key,data:unit.data})}
    catch {clearTimeout(timer); entry.inFlight.delete(timestampUs); this.finish(entry,running)}
  }
  private recoverPressure(entry:VisibleVideo,running:RunningVideo):void {this.finish(entry,running,MOBILE_VIDEO_LIMITS.pressureRetryDelayMs)}
  private detach(entry:VisibleVideo,running:RunningVideo):void {
    if(entry.running===running) entry.running=undefined
    running.ready=false; running.abort.abort(); running.unlink()
    clearTimeout(running.startupTimer); clearTimeout(running.queueTimer)
    running.queue=[]; running.queuedBytes=0
    const channel=running.channel; running.channel=undefined
    if(channel) {
      try {channel.pause()} catch { /* already closed */ }
      const previous=entry.cleanup
      let close:Promise<void>
      try {close=channel.close().catch(()=>undefined)} catch {close=Promise.resolve()}
      entry.cleanup=Promise.all([previous,close]).then(()=>undefined)
    }
  }
  private finish(entry:VisibleVideo,running:RunningVideo,retryDelay?:number):void {
    if(!this.authorized(entry,running)) return
    this.detach(entry,running)
    void entry.cleanup.then(()=>{if(this.current(entry) && !entry.unavailable) this.retry(entry,retryDelay)})
  }
  private retry(entry:VisibleVideo,retryDelay?:number):void {
    if(!this.current(entry) || entry.unavailable) return
    if(++entry.failures>MOBILE_VIDEO_LIMITS.maxRetries) {entry.unavailable=true; return}
    const delay=retryDelay ?? MOBILE_VIDEO_LIMITS.retryDelayMs*2**(entry.failures-1)
    entry.retryTimer=setTimeout(()=>{entry.retryTimer=undefined; if(this.current(entry) && !entry.unavailable) void this.begin(entry,entry.cleanup)},delay)
  }
}
