import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { isAbsolute, resolve } from 'node:path'
import type { MobileAction, MobileActor, MobileFrame, MobilePlatform, MobilePointerInput, MobileResult, MobileSession, MobileStartRequest, MobileState } from '../shared/mobileSimulator'
import { getMobileDeviceProfile } from '../shared/mobileDeviceProfiles'
import { androidShellArgs, androidText, MobileCommandError, mobileError, mobilePixel, parseAndroidDisplayGeometry, resolveMobileInstallPath, validMobileId, validateMobileAction } from './mobileCommands'
import { discoverMobileRuntime, MOBILE_AVD_NAME, MOBILE_IOS_UDID, parseAndroidDevices, parseIosDevices, type MobileDiscoverySnapshot, type MobileTools } from './mobileDiscovery'
import { MOBILE_PNG_MAX_BYTES, readMobilePng } from './mobileImage'
import { mobileExecutor, MobileProcessError, type MobileCommand, type MobileExecutor, type MobileOwnedProcess } from './mobileProcess'
import { MobileAndroidDisplayProfiles, type MobileDisplayIo } from './mobileDisplayProfiles'
import { createMobileAndroidInput, type MobileAndroidInputChannel } from './mobileInput'

export interface MobileMissionScope { projectId: string; rootPath: string }
/** Main-only lease: never serialize these capabilities across IPC or MCP. */
export interface MobileRuntimeVideoTarget {
  executable:string
  serial:string
  width:number
  height:number
  signal:AbortSignal
  assertCurrent():void
  verifyTarget(signal?:AbortSignal):Promise<void>
}
export interface MobileRuntimeLog { event: string; missionId?: string; sessionId?: string; platform?: MobilePlatform; outcome?: 'ok' | 'failed' }
export interface MobileRuntimeDeps {
  resolveMission(missionId: string): MobileMissionScope | null
  onChanged?(missionId: string): void
  onSessionClosed?(missionId: string, sessionId: string): void
  log?(entry: MobileRuntimeLog): void
  executor?: MobileExecutor
  discover?(signal?: AbortSignal): Promise<MobileDiscoverySnapshot>
  /** Fixed main-managed download cache; never supplied by renderer/MCP calls. */
  managedApkRoot?: string
  /** Bundled, verified Android control server; never supplied by renderer/MCP. */
  inputServerPath?: string
  inputFactory?: typeof createMobileAndroidInput
  portAvailable?(port: number): Promise<boolean>
  bootTimeoutMs?: number
  pollMs?: number
}
interface Operation { actor: MobileActor; epoch: number; abort: AbortController; done: Promise<void> }
interface PointerGesture {
  id: string
  epoch: number
  channel: MobileAndroidInputChannel
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
  begin: Promise<void>
  started: boolean
  geometry?: {width:number;height:number}
  move?: MobilePointerInput
  up?: MobilePointerInput
}
interface Entry {
  session: MobileSession
  scope: MobileMissionScope
  abort: AbortController
  epoch: number
  retiring: boolean
  operations: Set<Operation>
  tail: Promise<unknown>
  boot: Promise<void>
  closing: boolean
  closePromise?: Promise<boolean>
  closeNotified: boolean
  tools?: MobileTools
  serial?: string
  port?: number
  child?: MobileOwnedProcess
  startedDevice: boolean
  uncertainBoot: boolean
  iosPoints?: {width: number; height: number}
  initialProfileId?:string
  androidDisplay?:MobileAndroidDisplayProfiles
  input?:MobileAndroidInputChannel
  inputClosing?:Promise<void>
  inputDraining?:Promise<void>
  gesture?:PointerGesture
}
const OWNER: MobileActor = {kind:'owner'}
const ok = <T>(value: T): MobileResult<T> => ({ok:true,value})
const failed = (error: string): MobileResult<never> => ({ok:false,error})
function safeError(error: unknown): string {
  if (error instanceof MobileCommandError) return error.message
  if (error instanceof MobileProcessError && error.reason === 'cancelled') return 'A operação mobile foi cancelada. Inicie novamente pelo painel Mobile quando quiser continuar.'
  if (error instanceof MobileProcessError && error.reason === 'timeout') return 'O simulador não respondeu a tempo. Verifique o dispositivo no Android Studio ou Xcode e tente novamente.'
  return 'Não foi possível concluir a operação do simulador. Verifique o SDK e o dispositivo e tente novamente pelo painel Mobile.'
}
function pathKey(path:string):string { const absolute=resolve(path); return process.platform === 'win32' ? absolute.toLowerCase() : absolute }
function scopeKey(scope: MobileMissionScope): string { return `${scope.projectId}\0${pathKey(scope.rootPath)}` }
function validatePointer(input:unknown):MobilePointerInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) mobileError('Gesto inválido. Use a tela do painel Mobile para interagir.')
  const event=input as Record<string,unknown>
  if (Object.keys(event).length !== 4 || !['phase','gestureId','x','y'].every(key=>Object.hasOwn(event,key)) ||
    typeof event.phase !== 'string' || !['down','move','up','cancel'].includes(event.phase) || typeof event.gestureId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(event.gestureId) ||
    ![event.x,event.y].every(value=>typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)) mobileError('Gesto inválido. Use a tela do painel Mobile para interagir.')
  return {phase:event.phase as MobilePointerInput['phase'],gestureId:event.gestureId,x:event.x as number,y:event.y as number}
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new MobileProcessError('cancelled')); return }
    const abort = (): void => { clearTimeout(timer); reject(new MobileProcessError('cancelled')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort',abort); resolve() },ms)
    signal?.addEventListener('abort',abort,{once:true})
  })
}
async function portAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error',()=>resolve(false))
    server.listen({host:'127.0.0.1',port,exclusive:true},()=>server.close(()=>resolve(true)))
  })
}

/** One device lease per mission/platform; all OS effects stay behind this manager. */
export class MobileRuntimeManager {
  private readonly entries = new Map<string,Entry>()
  private readonly slots = new Map<string,string>()
  private readonly leases = new Map<string,string>()
  private readonly ports = new Set<number>()
  private readonly executor: MobileExecutor
  private disposed = false
  constructor(private readonly deps: MobileRuntimeDeps) { this.executor = deps.executor ?? mobileExecutor }

  /** Main-only presentation snapshot. No SDK discovery or transferable authority. */
  sessionSnapshot(missionId: string, sessionId: string): MobileResult<MobileSession> {
    try {
      const entry = this.lookup(missionId, sessionId)
      this.assertScope(entry)
      if (!entry.closing && entry.session.state !== 'error') this.assertLive(entry)
      return ok({ ...entry.session })
    } catch (error) { return failed(safeError(error)) }
  }

  async inspect(missionId: string): Promise<MobileResult<MobileState>> {
    try {
      const scope = this.scope(missionId)
      const discovered = await this.discover()
      if (scopeKey(this.scope(missionId)) !== scopeKey(scope)) mobileError('A missão mudou de pasta. Atualize o painel Mobile.')
      const sessions = [...this.entries.values()].filter(e=>e.session.missionId === missionId).map(e=>({...e.session}))
      return ok({hostPlatform:discovered.hostPlatform,platforms:discovered.platforms.map(p=>({...p,setupSteps:[...p.setupSteps]})),
        devices:discovered.devices.map(device=>{
          const own = sessions.find(s=>s.platform === device.platform && s.deviceId === device.id)
          return {...device,...(own ? {sessionId:own.id,state:'running' as const}:{})}
        }),sessions})
    } catch (error) { return failed(safeError(error)) }
  }
  async start(missionId: string, request: MobileStartRequest, actor: MobileActor = OWNER): Promise<MobileResult<MobileSession>> {
    let entry: Entry | undefined
    try {
      const scope = this.scope(missionId); this.validActor(actor)
      if (!request || !['android','ios'].includes(request.platform) || !validMobileId(request.deviceId) ||
        !(request.platform === 'android' ? MOBILE_AVD_NAME : MOBILE_IOS_UDID).test(request.deviceId)) mobileError('Escolha um dispositivo virtual válido no painel Mobile.')
      if (request.displayProfileId !== undefined && (request.platform !== 'android' || !getMobileDeviceProfile(request.displayProfileId))) mobileError('Escolha um perfil de tela Android disponível no painel Mobile.')
      const slot = `${missionId}\0${request.platform}`, existingId = this.slots.get(slot)
      if (existingId) {
        const existing = this.entries.get(existingId)!
        this.assertLive(existing)
        if (existing.session.deviceId !== request.deviceId) mobileError('Esta missão já tem um dispositivo desta plataforma. Pare a sessão atual antes de escolher outro.')
        if (existing.session.state === 'error') mobileError('A sessão anterior precisa de limpeza. Pare o dispositivo pelo painel Mobile antes de iniciar novamente.')
        this.authorize(existing,actor,true)
        if (request.displayProfileId && request.displayProfileId !== existing.session.displayProfileId) {
          const applied=await this.act(missionId,existing.session.id,{type:'displayProfile',profileId:request.displayProfileId},actor)
          if (!applied.ok) mobileError(applied.error)
          this.assertLive(existing)
        }
        return ok({...existing.session})
      }
      const lease = `${request.platform}\0${request.deviceId}`
      if (this.leases.has(lease)) mobileError('Este dispositivo virtual está reservado por outra missão. Escolha outro dispositivo ou encerre a sessão anterior.')
      const session: MobileSession = {id:randomUUID(),missionId,platform:request.platform,deviceId:request.deviceId,deviceName:request.deviceId,state:'starting',inputAvailable:false,
        ...(actor.kind === 'agent' ? {controllerPaneId:actor.paneId}:{})}
      entry = {session,scope,abort:new AbortController(),epoch:0,retiring:false,operations:new Set(),tail:Promise.resolve(),boot:Promise.resolve(),closing:false,
        closeNotified:false,startedDevice:false,uncertainBoot:false,initialProfileId:request.displayProfileId}
      // All reservations precede discovery/port checks and every other await.
      this.entries.set(session.id,entry); this.slots.set(slot,session.id); this.leases.set(lease,session.id)
      this.changed(entry)
      entry.boot = this.boot(entry)
      await entry.boot
      this.assertLive(entry)
      entry.session.state = 'ready'; this.changed(entry); this.record(entry,'mobile-start','ok')
      return ok({...entry.session})
    } catch (error) {
      if (entry) { this.record(entry,'mobile-start','failed'); await this.closeEntry(entry) }
      return failed(safeError(error))
    }
  }
  async stop(missionId: string, sessionId: string, actor: MobileActor = OWNER): Promise<MobileResult> {
    try {
      const entry = this.lookup(missionId,sessionId)
      this.authorize(entry,actor)
      if (actor.kind === 'agent') this.assertScope(entry)
      return await this.closeEntry(entry) ? ok(undefined) : failed('O encerramento ainda não foi confirmado. Feche este dispositivo no Android Studio ou Xcode e clique em Parar novamente.')
    } catch (error) { return failed(safeError(error)) }
  }
  async capture(missionId: string, sessionId: string, actor: MobileActor = OWNER): Promise<MobileResult<MobileFrame>> {
    try {
      const entry = this.ready(missionId,sessionId,actor)
      return ok(await this.operation(entry,actor,signal=>this.captureFrame(entry,signal)))
    } catch (error) { return failed(safeError(error)) }
  }
  async act(missionId: string, sessionId: string, input: MobileAction, actor: MobileActor = OWNER, signal?: AbortSignal): Promise<MobileResult> {
    try {
      const entry = this.ready(missionId,sessionId,actor), action = validateMobileAction(input)
      if (entry.session.platform === 'android' && action.type === 'text') androidText(action.text)
      this.cancelPointer(entry)
      await this.queuedOperation(entry,actor,operationSignal=>this.perform(entry,action,operationSignal),signal)
      return ok(undefined)
    } catch (error) { return failed(safeError(error)) }
  }
  /** Owner IPC only. MCP keeps using bounded tap/swipe actions. */
  async pointer(missionId:string,sessionId:string,input:MobilePointerInput):Promise<MobileResult> {
    let entry:Entry|undefined, gesture:PointerGesture|undefined
    try {
      const event=validatePointer(input)
      entry=this.ready(missionId,sessionId,OWNER)
      const channel=entry.input
      if (entry.session.platform !== 'android' || !channel?.alive()) {
        if (channel) this.closeInput(entry)
        mobileError('O controle contínuo não está disponível. Use os controles do painel Mobile ou pare e inicie a sessão novamente.')
      }
      if (event.phase === 'down') {
        if (entry.gesture) mobileError('Há um gesto em andamento. Solte o botão antes de começar outro.')
        const current=entry
        gesture={id:event.gestureId,epoch:entry.epoch,channel,abort:new AbortController(),timer:undefined!,begin:Promise.resolve(),started:false}
        const reserved=gesture
        // The slot and deadline exist before the FIFO, identity or display awaits.
        entry.gesture=gesture
        gesture.timer=setTimeout(()=>{if (current.gesture === reserved) this.cancelPointer(current)},10_000)
        gesture.timer.unref?.()
        gesture.begin=this.queuedOperation(entry,OWNER,async signal=>{
          this.assertPointer(current,reserved)
          const metadata=await this.run(current,{executable:current.tools!.adb!,args:androidShellArgs(current.serial!,['cmd','display','get-displays']),timeoutMs:3000,maxBytes:64*1024},signal)
          const geometry=parseAndroidDisplayGeometry(metadata.toString('utf8'))
          reserved.geometry={width:geometry.width,height:geometry.height}
          this.sendPointer(current,reserved,event)
          reserved.started=true
          if (reserved.move) this.sendPointer(current,reserved,reserved.move)
          if (reserved.up) {this.sendPointer(current,reserved,reserved.up); await this.finishPointer(current,reserved)}
        },gesture.abort.signal)
        await gesture.begin
      } else {
        if (!entry.gesture || entry.gesture.id !== event.gestureId) mobileError('Este gesto já terminou. Comece um novo toque na tela do painel Mobile.')
        if (entry.gesture.up && event.phase !== 'cancel') mobileError('Este gesto está terminando. Aguarde a soltura antes de enviar outro movimento.')
        gesture=entry.gesture
        this.assertPointer(entry,gesture)
        if (event.phase === 'cancel') {this.cancelPointer(entry); return ok(undefined)}
        if (event.phase === 'move') {
          if (gesture.started) this.sendPointer(entry,gesture,event)
          else gesture.move=event
        } else {
          gesture.up=event
          if (gesture.started) {this.sendPointer(entry,gesture,event); await this.finishPointer(entry,gesture)}
          else await gesture.begin
        }
      }
      return ok(undefined)
    } catch (error) {
      if (entry && gesture && entry.gesture === gesture) this.cancelPointer(entry)
      return failed(safeError(error))
    }
  }
  /** Internal install path for verified downloads. Public installs remain worktree-only. */
  async installManagedApk(missionId:string,sessionId:string,relativeCachePath:string,actor:MobileActor=OWNER,signal?:AbortSignal,expectedRoot?:string):Promise<MobileResult> {
    try {
      const entry=this.ready(missionId,sessionId,actor), root=this.deps.managedApkRoot
      if (entry.session.platform !== 'android' || !root) mobileError('O instalador gerenciado Android não está disponível nesta sessão.')
      this.cancelPointer(entry)
      await this.queuedOperation(entry,actor,async operationSignal=>{
        // Recheck after the FIFO wait and use the physical path that was verified
        // by the downloader, so a changed ancestor alias cannot retarget install.
        const canonicalRoot=await realpath(root)
        if (expectedRoot !== undefined && (!isAbsolute(expectedRoot) || pathKey(canonicalRoot) !== pathKey(expectedRoot))) mobileError('A pasta do instalador mudou enquanto a operação aguardava. Tente instalar novamente pelo painel Mobile.')
        const path=await resolveMobileInstallPath(canonicalRoot,relativeCachePath,'android')
        await this.run(entry,{executable:entry.tools!.adb!,args:['-s',entry.serial!,'install','-r',path],timeoutMs:120_000},operationSignal)
        this.record(entry,'mobile-install-managed','ok')
      },signal)
      return ok(undefined)
    } catch (error) { return failed(safeError(error)) }
  }
  async videoTarget(missionId: string,sessionId: string): Promise<MobileResult<MobileRuntimeVideoTarget>> {
    try {
      const entry = this.ready(missionId,sessionId,OWNER)
      if (entry.session.platform !== 'android' || !entry.serial || !entry.tools?.adb) mobileError('Vídeo contínuo disponível para Android. Use a captura do simulador iOS.')
      const geometry=await this.operation(entry,OWNER,async signal=>{
        const data=await this.run(entry,{executable:entry.tools!.adb!,args:androidShellArgs(entry.serial!,['cmd','display','get-displays']),timeoutMs:3000,maxBytes:64*1024},signal)
        return parseAndroidDisplayGeometry(data.toString('utf8'))
      })
      const assertCurrent=():void=>{
        this.assertLive(entry)
        if (entry.session.state !== 'ready') throw new MobileProcessError('cancelled')
      }
      return ok({executable:entry.tools.adb,serial:entry.serial,width:geometry.width,height:geometry.height,
        signal:entry.abort.signal,assertCurrent,verifyTarget:async signal=>{
          assertCurrent()
          await this.operation(entry,OWNER,operationSignal=>this.verifyAndroidTarget(entry,operationSignal),false,signal)
          assertCurrent()
        }})
    } catch (error) { return failed(safeError(error)) }
  }
  releaseController(paneId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.session.controllerPaneId !== paneId) continue
      this.cancelPointer(entry)
      entry.epoch++; delete entry.session.controllerPaneId
      for (const operation of entry.operations) if (operation.actor.kind === 'agent' && operation.actor.paneId === paneId) operation.abort.abort()
      entry.retiring = [...entry.operations].some(op=>op.actor.kind === 'agent')
      this.changed(entry)
      if (entry.session.state === 'starting') void this.closeEntry(entry)
    }
  }
  async closeMission(missionId: string): Promise<void> {
    // map() starts every synchronous revocation before awaiting any cleanup.
    await Promise.all([...this.entries.values()].filter(e=>e.session.missionId === missionId).map(e=>this.closeEntry(e)))
  }
  async dispose(): Promise<void> {
    for (const entry of this.entries.values()) this.cancelPointer(entry)
    this.disposed = true
    await Promise.all([...this.entries.values()].map(e=>this.closeEntry(e)))
  }

  private discover(signal?:AbortSignal): Promise<MobileDiscoverySnapshot> { return this.deps.discover ? this.deps.discover(signal) : discoverMobileRuntime(this.executor,signal) }
  private scope(missionId: string): MobileMissionScope {
    if (this.disposed || !validMobileId(missionId)) mobileError('Abra uma missão de desenvolvimento ativa para usar o painel Mobile.')
    const scope = this.deps.resolveMission(missionId)
    if (!scope || !scope.projectId || !scope.rootPath) mobileError('Esta missão não tem um worktree ativo. Abra a missão de desenvolvimento antes de usar Mobile.')
    return {...scope}
  }
  private assertScope(entry: Entry): void {
    if (scopeKey(this.scope(entry.session.missionId)) !== scopeKey(entry.scope)) mobileError('A pasta desta missão mudou. Pare a sessão e abra novamente pelo painel Mobile.')
  }
  private assertLive(entry: Entry): void {
    if (entry.session.platform === 'android' && entry.startedDevice && !entry.child?.isAlive() && !entry.closing) this.ownedChildExited(entry)
    if (entry.closing || entry.abort.signal.aborted || this.entries.get(entry.session.id) !== entry) throw new MobileProcessError('cancelled')
    try {this.assertScope(entry)} catch (error) {this.cancelPointer(entry,false); this.closeInput(entry); throw error}
  }
  private lookup(missionId: string,sessionId: string): Entry {
    const entry = this.entries.get(sessionId)
    if (!entry || entry.session.missionId !== missionId) mobileError('Esta sessão mobile não pertence à missão. Use mobile_start ou Iniciar no painel Mobile.')
    return entry
  }
  private ready(missionId: string,sessionId: string,actor: MobileActor): Entry {
    const entry = this.lookup(missionId,sessionId)
    this.assertLive(entry); this.authorize(entry,actor)
    if (entry.session.state !== 'ready') mobileError('O dispositivo ainda não está pronto. Aguarde a inicialização no painel Mobile.')
    return entry
  }
  private validActor(actor: MobileActor): void {
    if (!actor || (actor.kind !== 'owner' && (actor.kind !== 'agent' || !validMobileId(actor.paneId)))) mobileError('Controlador mobile inválido. Reabra a conversa desta missão.')
  }
  private authorize(entry: Entry,actor: MobileActor,claim = false): void {
    this.validActor(actor)
    if (actor.kind === 'owner') return
    if (entry.retiring) mobileError('O controlador anterior está encerrando uma operação. Aguarde e use mobile_start novamente.')
    if (!entry.session.controllerPaneId && claim) { this.cancelPointer(entry); entry.session.controllerPaneId = actor.paneId; entry.epoch++; this.changed(entry) }
    if (entry.session.controllerPaneId !== actor.paneId) mobileError('A sessão é controlada por outro agente ou ainda não foi reservada por você. Use mobile_start nesta missão ou peça ao dono para liberar a sessão.')
  }
  private queuedOperation<T>(entry:Entry,actor:MobileActor,work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T> {
    return this.operation(entry,actor,async operationSignal=>{
      // Reserve FIFO position synchronously, before any identity query or filesystem await.
      const previous=entry.tail
      let done!:()=>void
      entry.tail=new Promise<void>(resolve=>{done=resolve})
      try {
        await previous; await entry.inputDraining; this.assertLive(entry)
        if (operationSignal.aborted) throw new MobileProcessError('cancelled')
        if (entry.session.platform === 'android') await this.verifyAndroidTarget(entry,operationSignal)
        return await work(operationSignal)
      } finally { done() }
    },false,signal)
  }
  private async operation<T>(entry: Entry,actor: MobileActor,work:(signal:AbortSignal)=>Promise<T>,verifyAndroid=true,signal?:AbortSignal): Promise<T> {
    if (entry.operations.size >= 8) mobileError('Há operações mobile em andamento. Aguarde antes de enviar outra.')
    if (signal?.aborted) throw new MobileProcessError('cancelled')
    let finish!: () => void
    const done = new Promise<void>(resolve=>{finish=resolve})
    const operation: Operation = {actor,epoch:entry.epoch,abort:new AbortController(),done}
    const abort = (): void => operation.abort.abort()
    entry.abort.signal.addEventListener('abort',abort,{once:true}); entry.operations.add(operation)
    signal?.addEventListener('abort',abort,{once:true})
    try {
      if (verifyAndroid && entry.session.platform === 'android') await this.verifyAndroidTarget(entry,operation.abort.signal)
      const value = await work(operation.abort.signal)
      this.assertLive(entry)
      if (operation.abort.signal.aborted || (actor.kind === 'agent' && operation.epoch !== entry.epoch)) throw new MobileProcessError('cancelled')
      this.authorize(entry,actor)
      return value
    } finally {
      entry.abort.signal.removeEventListener('abort',abort); signal?.removeEventListener('abort',abort); entry.operations.delete(operation); finish()
      if (entry.retiring && ![...entry.operations].some(op=>op.actor.kind === 'agent')) { entry.retiring = false; this.changed(entry) }
    }
  }
  private async run(entry: Entry,command: MobileCommand,signal = entry.abort.signal,onDispatched?:()=>void): Promise<Buffer> {
    this.assertLive(entry)
    if (signal.aborted) throw new MobileProcessError('cancelled')
    onDispatched?.()
    const result = await this.executor.run({...command,signal})
    this.assertLive(entry)
    if (signal.aborted) throw new MobileProcessError('cancelled')
    return result.stdout
  }
  private async reservePort(entry: Entry): Promise<number> {
    for (let port = 5554; port <= 5682; port += 2) {
      this.assertLive(entry)
      if (this.ports.has(port) || this.ports.has(port+1)) continue
      this.ports.add(port); this.ports.add(port+1)
      const available = this.deps.portAvailable ?? portAvailable
      let free = false
      try { free = await available(port) && await available(port+1) } finally {
        if (!free || entry.abort.signal.aborted) { this.ports.delete(port); this.ports.delete(port+1) }
      }
      if (free) entry.port = port
      this.assertLive(entry)
      if (free) return port
    }
    return mobileError('Não há um par de portas disponível para o Android Emulator. Feche um emulador e tente novamente.')
  }
  private async boot(entry: Entry): Promise<void> {
    const discovered = await this.discover(entry.abort.signal); this.assertLive(entry)
    const platform = entry.session.platform, capability = discovered.platforms.find(p=>p.platform === platform)
    if (platform === 'ios' && discovered.hostPlatform !== 'darwin') mobileError('O simulador iOS requer macOS com Xcode. Use Android nesta máquina.')
    if (!capability?.supported || !capability.available) mobileError(capability?.reason ?? 'Prepare o SDK pelo painel Mobile e clique em Atualizar.')
    const device = discovered.devices.find(d=>d.platform === platform && d.id === entry.session.deviceId)
    if (!device || device.state === 'unavailable') mobileError('Dispositivo virtual indisponível. Crie ou prepare o dispositivo no Android Studio/Xcode e atualize Mobile.')
    if (device.state === 'running') mobileError('Este dispositivo já está rodando fora do Synkora. Encerre-o no Android Studio/Xcode e use Iniciar no painel Mobile.')
    entry.tools = {...discovered.tools}; entry.session.deviceName = device.name
    if (device.deviceTypeIdentifier) entry.session.deviceTypeIdentifier=device.deviceTypeIdentifier
    if (platform === 'android') {
      if (!entry.tools.adb || !entry.tools.emulator || discovered.androidDiscoveryIncomplete) mobileError('A identidade dos emuladores Android não foi confirmada. Encerre os emuladores externos e atualize o painel Mobile.')
      const port = await this.reservePort(entry); this.assertLive(entry)
      entry.serial = `emulator-${port}`
      entry.child = await this.executor.launch({executable:entry.tools.emulator,args:['-avd',device.id,'-port',String(port),'-no-window','-no-snapshot-save','-no-boot-anim'],signal:entry.abort.signal})
      void entry.child.exited.then(()=>this.ownedChildExited(entry))
      entry.startedDevice = true; this.assertLive(entry)
      const deadline = Date.now() + (this.deps.bootTimeoutMs ?? 180_000)
      while (Date.now() < deadline) {
        this.assertLive(entry)
        if (!entry.child.isAlive()) mobileError('O Android Emulator encerrou durante a inicialização. Verifique a virtualização e o AVD no Android Studio.')
        try {
          const name = await this.run(entry,{executable:entry.tools.adb,args:['-s',entry.serial,'emu','avd','name'],timeoutMs:2000,maxBytes:4096})
          if (name.toString('utf8').split(/\r?\n/u)[0]?.trim() !== device.id) mobileError('A porta pertence a outro emulador. Pare a sessão e tente Iniciar novamente.')
          const completed = await this.run(entry,{executable:entry.tools.adb,args:androidShellArgs(entry.serial,['getprop','sys.boot_completed']),timeoutMs:3000,maxBytes:4096})
          if (completed.toString('utf8').trim() === '1') {
            entry.session.inputAvailable = true
            entry.androidDisplay=new MobileAndroidDisplayProfiles()
            try {
              await entry.androidDisplay.initialize(this.displayIo(entry,entry.abort.signal))
              if (entry.initialProfileId && entry.initialProfileId !== 'native') await entry.androidDisplay.apply(entry.initialProfileId,this.displayIo(entry,entry.abort.signal))
            } catch (error) {
              this.assertLive(entry)
              if (entry.initialProfileId) throw error
              this.record(entry,'mobile-display-unavailable','failed')
            }
            this.syncDisplayProfile(entry)
            await this.prepareInput(entry)
            return
          }
        } catch (error) { if (error instanceof MobileCommandError || entry.abort.signal.aborted || entry.androidDisplay) throw error }
        await wait(this.deps.pollMs ?? 500,entry.abort.signal)
      }
      throw new MobileProcessError('timeout')
    }
    if (!entry.tools.xcrun) mobileError('Instale e prepare o Xcode, depois atualize o painel Mobile.')
    // Do not interrupt this short boot request: its success is our ownership receipt.
    // A timed-out receipt remains uncertain and is never used to shut down an outsider.
    entry.uncertainBoot = true
    try {
      await this.executor.run({executable:entry.tools.xcrun,args:['simctl','boot',device.id],timeoutMs:15_000,maxBytes:4096})
      entry.startedDevice = true; entry.uncertainBoot = false
    } catch (error) {
      if (error instanceof MobileProcessError && ['failed','unavailable'].includes(error.reason)) entry.uncertainBoot = false
      throw error
    }
    this.assertLive(entry)
    await this.run(entry,{executable:entry.tools.xcrun,args:['simctl','bootstatus',device.id,'-b'],timeoutMs:this.deps.bootTimeoutMs ?? 180_000,maxBytes:128*1024})
    if (entry.tools.idb) {
      try {
        const data = await this.run(entry,{executable:entry.tools.idb,args:['describe','--udid',device.id,'--json'],timeoutMs:15_000,maxBytes:128*1024})
        const description = JSON.parse(data.toString('utf8')) as Record<string,unknown>
        const screen = description.screen_dimensions as Record<string,unknown> | undefined
        if (description.udid !== device.id || !screen) return
        const density = Number(screen.density), pixelWidth = Number(screen.width), pixelHeight = Number(screen.height)
        const width = Number(screen.width_points) || (density > 0 ? pixelWidth/density : 0)
        const height = Number(screen.height_points) || (density > 0 ? pixelHeight/density : 0)
        if ([width,height].every(v=>Number.isFinite(v) && v >= 1 && v <= 8192)) {
          entry.iosPoints = {width:Math.round(width),height:Math.round(height)}; entry.session.inputAvailable = true
        }
      } catch { this.assertLive(entry) /* capture/install remain usable without verified HID geometry */ }
    }
  }
  private async captureFrame(entry: Entry,signal:AbortSignal): Promise<MobileFrame> {
    const android = entry.session.platform === 'android'
    const data = await this.run(entry,{executable:android ? entry.tools!.adb! : entry.tools!.xcrun!,
      args:android ? ['-s',entry.serial!,'exec-out','screencap','-p'] : ['simctl','io',entry.session.deviceId,'screenshot','--type=png','-'],
      timeoutMs:15_000,maxBytes:MOBILE_PNG_MAX_BYTES},signal)
    const dimensions = readMobilePng(data)
    return {sessionId:entry.session.id,mimeType:'image/png',data:data.toString('base64'),...dimensions,capturedAt:Date.now()}
  }
  private async verifyAndroidTarget(entry: Entry,signal:AbortSignal):Promise<void> {
    const name = await this.run(entry,{executable:entry.tools!.adb!,args:['-s',entry.serial!,'emu','avd','name'],timeoutMs:3000,maxBytes:4096},signal)
    if (name.toString('utf8').split(/\r?\n/u)[0]?.trim() !== entry.session.deviceId) {
      this.ownedChildExited(entry)
      mobileError('A identidade do emulador mudou. Pare esta sessão Mobile e inicie um dispositivo novo.')
    }
  }
  private ownedChildExited(entry:Entry):void {
    if (entry.closing || this.entries.get(entry.session.id) !== entry || entry.abort.signal.aborted) return
    this.cancelPointer(entry,false); this.closeInput(entry)
    entry.epoch++; entry.abort.abort()
    for (const operation of entry.operations) operation.abort.abort()
    entry.session.state = 'error'; entry.session.inputAvailable = false
    entry.session.error = 'O emulador foi encerrado ou mudou de identidade. Pare esta sessão e use Iniciar para abrir novamente.'
    if (!entry.closeNotified) { entry.closeNotified = true; try { this.deps.onSessionClosed?.(entry.session.missionId,entry.session.id) } catch { /* observer only */ } }
    this.record(entry,'mobile-process-exit','failed'); this.changed(entry)
  }
  private async prepareInput(entry:Entry):Promise<void> {
    if (!this.deps.inputServerPath) return
    let channel:MobileAndroidInputChannel|undefined, closed=false
    entry.session.liveInputAvailable=false
    try {
      channel=await (this.deps.inputFactory ?? createMobileAndroidInput)({
        executable:entry.tools!.adb!,serial:entry.serial!,serverPath:this.deps.inputServerPath,executor:this.executor,
        signal:entry.abort.signal,assertCurrent:()=>this.assertLive(entry),verifyTarget:()=>this.verifyAndroidTarget(entry,entry.abort.signal),
        onClosed:()=>{closed=true; if (channel && entry.input === channel) this.closeInput(entry)}
      })
      this.assertLive(entry)
      if (closed || !channel.alive()) throw new MobileProcessError('unavailable')
      entry.input=channel; entry.session.liveInputAvailable=true; this.changed(entry)
      this.record(entry,'mobile-input-start','ok')
    } catch {
      if (channel) {try {await channel.close()} catch { /* optional control never blocks the visual session */ }}
      this.assertLive(entry)
      this.record(entry,'mobile-input-start','failed'); this.changed(entry)
    }
  }
  private assertPointer(entry:Entry,gesture:PointerGesture):void {
    this.assertLive(entry)
    if (entry.gesture !== gesture || gesture.abort.signal.aborted || gesture.epoch !== entry.epoch || entry.input !== gesture.channel) throw new MobileProcessError('cancelled')
    if (!gesture.channel.alive()) {this.closeInput(entry); mobileError('O controle contínuo foi desconectado. Use os controles do painel ou pare e inicie a sessão novamente.')}
  }
  private sendPointer(entry:Entry,gesture:PointerGesture,event:MobilePointerInput):void {
    this.assertPointer(entry,gesture)
    try {gesture.channel.touch({phase:event.phase,x:event.x,y:event.y},gesture.geometry!)}
    catch {this.closeInput(entry); mobileError('O controle contínuo foi interrompido. Use os controles do painel ou pare e inicie a sessão novamente.')}
  }
  private async finishPointer(entry:Entry,gesture:PointerGesture):Promise<void> {
    try {await gesture.channel.flush()} catch {this.closeInput(entry); throw new MobileProcessError('unavailable')}
    this.assertPointer(entry,gesture)
    clearTimeout(gesture.timer); entry.gesture=undefined
  }
  private cancelPointer(entry:Entry,inject=true):void {
    const gesture=entry.gesture
    if (!gesture) return
    entry.gesture=undefined; clearTimeout(gesture.timer)
    // Clear the reservation first, but release the native finger before revoking
    // scope/epoch/entry authority. A stale scope must never inject even CANCEL.
    if (inject && gesture.started && entry.input === gesture.channel) {
      try {
        this.assertLive(entry)
        if (gesture.channel.alive()) {
          gesture.channel.cancel()
          const draining=gesture.channel.flush().catch(()=>{if (entry.input === gesture.channel) this.closeInput(entry)})
          entry.inputDraining=draining
          void draining.finally(()=>{if (entry.inputDraining === draining) entry.inputDraining=undefined})
        }
      } catch {this.closeInput(entry)}
    }
    gesture.abort.abort()
  }
  private closeInput(entry:Entry):void {
    const channel=entry.input
    entry.input=undefined; this.cancelPointer(entry,false)
    if (entry.session.liveInputAvailable) {entry.session.liveInputAvailable=false; this.changed(entry)}
    if (channel) {
      const previous=entry.inputClosing
      // The channel has its own bounded teardown and owns only its socket,
      // server process and forward. No serial is reattached or reconnected.
      entry.inputClosing=(async()=>{await previous; try {await channel.close()} catch {this.record(entry,'mobile-input-close','failed')}})()
    }
  }
  private async perform(entry:Entry,action:MobileAction,signal:AbortSignal):Promise<void> {
    const android = entry.session.platform === 'android', tools = entry.tools!, id = entry.session.deviceId
    if (action.type === 'displayProfile') {
      if (!android || !entry.androidDisplay) mobileError('Perfis de tela estão disponíveis para o emulador Android desta missão.')
      try { await entry.androidDisplay.apply(action.profileId,this.displayIo(entry,signal)) }
      finally { this.syncDisplayProfile(entry) }
      this.record(entry,'mobile-display-profile','ok')
      return
    }
    let command: MobileCommand
    if (action.type === 'install') {
      const path = await resolveMobileInstallPath(entry.scope.rootPath,action.relativePath,entry.session.platform)
      this.assertLive(entry)
      command = android ? {executable:tools.adb!,args:['-s',entry.serial!,'install','-r',path],timeoutMs:120_000} : {executable:tools.xcrun!,args:['simctl','install',id,path],timeoutMs:120_000}
    } else if (action.type === 'openUrl') {
      command = android ? {executable:tools.adb!,args:androidShellArgs(entry.serial!,['am','start','-W','-a','android.intent.action.VIEW','-d',action.url])} : {executable:tools.xcrun!,args:['simctl','openurl',id,action.url]}
    } else if (action.type === 'launch') {
      command = android ? {executable:tools.adb!,args:androidShellArgs(entry.serial!,['monkey','-p',action.appId,'-c','android.intent.category.LAUNCHER','1'])} : {executable:tools.xcrun!,args:['simctl','launch',id,action.appId]}
    } else if (action.type === 'reverse') {
      if (!android) mobileError('No simulador iOS, use http://localhost:PORTA em Abrir link; reverse é exclusivo do Android.')
      command = {executable:tools.adb!,args:['-s',entry.serial!,'reverse',`tcp:${action.port}`,`tcp:${action.port}`]}
    } else {
      if (!entry.session.inputAvailable) mobileError('Toques e teclado iOS requerem idb com dimensões verificadas. Instale idb/idb_companion e reinicie esta sessão Mobile.')
      let dimensions: {width:number;height:number} | undefined
      if (action.type === 'tap' || action.type === 'swipe') {
        if (android) {
          // Query small structural metadata for every gesture instead of encoding a PNG.
          // Fresh logical bounds keep rotations/resolution overrides out of a stale cache.
          const display=await this.run(entry,{executable:tools.adb!,args:androidShellArgs(entry.serial!,['cmd','display','get-displays']),timeoutMs:3000,maxBytes:64*1024},signal)
          dimensions=parseAndroidDisplayGeometry(display.toString('utf8'))
        } else {
          const frame = await this.captureFrame(entry,signal)
          // idb HID uses the fixed mainScreenSize basis, not rotated PNG bounds.
          // Until rotation is verified natively, never infer a left/right transform.
          dimensions = entry.iosPoints!
          if (Math.abs(frame.width/frame.height - dimensions.width/dimensions.height) > 0.03) mobileError('Volte o simulador iOS ao modo retrato para usar toques e gestos. A captura continua disponível nesta orientação.')
        }
      }
      let args: string[]
      if (action.type === 'tap') args = ['tap',mobilePixel(action.x,dimensions!.width),mobilePixel(action.y,dimensions!.height)]
      else if (action.type === 'swipe') args = ['swipe',mobilePixel(action.x,dimensions!.width),mobilePixel(action.y,dimensions!.height),mobilePixel(action.endX,dimensions!.width),mobilePixel(action.endY,dimensions!.height),...(android ? [String(action.durationMs ?? 350)]:['--duration',String((action.durationMs ?? 350)/1000)])]
      else if (action.type === 'text') args = ['text',android ? androidText(action.text):action.text]
      else {
        const androidKey = {home:'3',back:'4',recents:'187',enter:'66',backspace:'67'}[action.key]
        if (android) args = ['keyevent',androidKey]
        else if (action.key === 'home') args = ['button','HOME']
        else if (action.key === 'enter' || action.key === 'backspace') args = ['key',action.key === 'enter' ? '40':'42']
        else return mobileError('Esta tecla é exclusiva do Android. No iOS, use o gesto ou a navegação do aplicativo.')
      }
      command = android ? {executable:tools.adb!,args:androidShellArgs(entry.serial!,['input',...args])} : {
        executable:tools.idb!,args:action.type === 'text' ? ['ui','text','--udid',id,'--',action.text] : ['ui',...args,'--udid',id]}
    }
    const reply = await this.run(entry,command,signal)
    if (android && action.type === 'openUrl' && !/^Status: ok\r?$/mu.test(reply.toString('utf8'))) mobileError('Nenhum aplicativo confirmou a abertura deste link. Instale o aplicativo correspondente ou use um endereço HTTP/HTTPS válido.')
    if (android && action.type === 'launch' && !/Events injected:\s*1\b/u.test(reply.toString('utf8'))) mobileError('O aplicativo não abriu. Confira o appId e instale um build com atividade de inicialização antes de usar Abrir app.')
    this.record(entry,`mobile-${action.type}`,'ok')
  }
  private syncDisplayProfile(entry:Entry):void {
    if (entry.androidDisplay?.profileId) entry.session.displayProfileId=entry.androidDisplay.profileId
    else delete entry.session.displayProfileId
    this.changed(entry)
  }
  private displayIo(entry:Entry,signal:AbortSignal,cleanup=false):MobileDisplayIo {
    const check=():void=>{
      if (signal.aborted) throw new MobileProcessError('cancelled')
      if (!cleanup) { this.assertLive(entry); return }
      const current=this.deps.resolveMission(entry.session.missionId)
      if (!current || scopeKey(current) !== scopeKey(entry.scope) || !entry.child?.isAlive() || this.entries.get(entry.session.id) !== entry) throw new MobileProcessError('cancelled')
    }
    return {
      authorized:()=>{try {check(); return true} catch {return false}},
      pause:()=>wait(100,signal),
      run:async(args,effect=false,onEffectDispatched)=>{
        check()
        if (cleanup) {
          const identity=await this.executor.run({executable:entry.tools!.adb!,args:['-s',entry.serial!,'emu','avd','name'],timeoutMs:2000,maxBytes:4096,signal})
          check()
          if (identity.stdout.toString('utf8').split(/\r?\n/u)[0]?.trim() !== entry.session.deviceId) throw new MobileProcessError('cancelled')
        } else if (effect) await this.verifyAndroidTarget(entry,signal)
        check()
        const command={executable:entry.tools!.adb!,args:androidShellArgs(entry.serial!,args),timeoutMs:2500,maxBytes:64*1024,signal}
        let data:Buffer
        if (cleanup) { if (effect) onEffectDispatched?.(); data=(await this.executor.run(command)).stdout }
        else data=await this.run(entry,command,signal,effect ? onEffectDispatched:undefined)
        check()
        return data
      }
    }
  }
  private closeEntry(entry:Entry):Promise<boolean> {
    if (this.entries.get(entry.session.id) !== entry) return Promise.resolve(true)
    if (entry.closePromise) return entry.closePromise
    this.cancelPointer(entry); this.closeInput(entry)
    entry.closing = true; entry.session.state = 'stopping'; entry.epoch++; entry.abort.abort()
    for (const operation of entry.operations) operation.abort.abort()
    if (!entry.closeNotified) { entry.closeNotified = true; try { this.deps.onSessionClosed?.(entry.session.missionId,entry.session.id) } catch { /* observer cannot retain a lease */ } }
    this.changed(entry)
    entry.closePromise = (async()=>{
      await entry.boot.catch(()=>undefined)
      await Promise.all([...entry.operations].map(operation=>operation.done))
      await entry.inputClosing
      let stopped = !entry.uncertainBoot
      if (entry.uncertainBoot) {
        // A boot without a success receipt never grants shutdown authority.
        // The owner may still resolve it manually; read-only proof releases it.
        try { stopped = await this.iosStopped(entry) } catch { stopped = false }
      }
      if (entry.startedDevice) {
        try { stopped = entry.session.platform === 'android' ? await this.stopAndroid(entry) : await this.stopIos(entry) }
        catch { stopped = false }
      }
      if (stopped) {
        this.entries.delete(entry.session.id)
        this.slots.delete(`${entry.session.missionId}\0${entry.session.platform}`)
        this.leases.delete(`${entry.session.platform}\0${entry.session.deviceId}`)
        if (entry.port !== undefined) { this.ports.delete(entry.port); this.ports.delete(entry.port+1) }
      } else {
        entry.session.state = 'error'; entry.session.error = 'Encerramento não confirmado. Feche este dispositivo no Android Studio/Xcode e clique em Parar novamente.'
      }
      this.record(entry,'mobile-stop',stopped ? 'ok':'failed'); this.changed(entry)
      return stopped
    })().finally(()=>{entry.closePromise=undefined})
    return entry.closePromise
  }
  private async stopAndroid(entry:Entry):Promise<boolean> {
    if (!entry.child || !entry.serial || !entry.tools?.adb) return false
    if (entry.androidDisplay && entry.child.isAlive()) {
      const controller=new AbortController(), deadline=setTimeout(()=>controller.abort(),10_000)
      try { await entry.androidDisplay.restoreForStop(this.displayIo(entry,controller.signal,true)) }
      catch { this.record(entry,'mobile-display-restore','failed') /* shutdown still owns the child */ }
      finally { clearTimeout(deadline) }
    }
    if (entry.child.isAlive()) {
      try {
        const name = await this.executor.run({executable:entry.tools.adb,args:['-s',entry.serial,'emu','avd','name'],timeoutMs:2000,maxBytes:4096})
        if (name.stdout.toString('utf8').split(/\r?\n/u)[0]?.trim() === entry.session.deviceId && entry.child.isAlive()) {
          await this.executor.run({executable:entry.tools.adb,args:['-s',entry.serial,'emu','kill'],timeoutMs:3000,maxBytes:4096})
        }
      } catch { /* own live child handle remains the fallback */ }
    }
    const processStopped = await entry.child.stop()
    const deadline = Date.now()+8000
    while (Date.now()<deadline) {
      const state = await this.executor.run({executable:entry.tools.adb,args:['devices'],timeoutMs:2000,maxBytes:64*1024})
      if (!parseAndroidDevices(state.stdout.toString('utf8')).includes(entry.serial)) return processStopped
      await wait(this.deps.pollMs ?? 250)
    }
    return false
  }
  private async stopIos(entry:Entry):Promise<boolean> {
    if (!entry.tools?.xcrun) return false
    const executable = entry.tools.xcrun, id = entry.session.deviceId
    if (await this.iosStopped(entry)) return true
    await this.executor.run({executable,args:['simctl','shutdown',id],timeoutMs:15_000,maxBytes:4096})
    return this.iosStopped(entry)
  }
  private async iosStopped(entry:Entry):Promise<boolean> {
    if (!entry.tools?.xcrun) return false
    const data = await this.executor.run({executable:entry.tools.xcrun,args:['simctl','list','devices','--json'],timeoutMs:5000,maxBytes:1024*1024})
    const current = parseIosDevices(data.stdout.toString('utf8')).find(device=>device.id === entry.session.deviceId)
    return !current || current.state === 'available'
  }
  private changed(entry:Entry):void { try { this.deps.onChanged?.(entry.session.missionId) } catch { /* observers are not authority */ } }
  private record(entry:Entry,event:string,outcome:'ok'|'failed'):void {
    try { this.deps.log?.({event,missionId:entry.session.missionId,sessionId:entry.session.id,platform:entry.session.platform,outcome}) } catch { /* log never blocks cleanup */ }
  }
}
