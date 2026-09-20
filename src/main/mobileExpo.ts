import type { MobileExpoProject, MobileExpoStartRequest, MobileExpoState } from '../shared/mobileExpo'
import type { MobileAction, MobileActor, MobileResult, MobileState } from '../shared/mobileSimulator'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import QRCode from 'qrcode'
import { MobileCommandError, mobileError, validMobileId } from './mobileCommands'
import { MobileProcessError, type MobileOwnedProcess } from './mobileProcess'
import { downloadExpoGo, expoTransport, probeExpoServer, type MobileExpoTransport } from './mobileExpoNetwork'
import { expoInside, expoProcessEnvironment, expoRealRoot, inspectExpoProject, privateExpoAddress, privateExpoAddresses } from './mobileExpoProject'
import { launchExpoProcess, reserveExpoPort, type MobileExpoLauncher, type MobileExpoPortReservation } from './mobileExpoProcess'

interface MissionScope { projectId: string; rootPath: string }
export interface MobileExpoRuntimeLike {
  inspect(missionId: string): Promise<MobileResult<MobileState>>
  act(missionId: string, sessionId: string, action: MobileAction, actor?: MobileActor, signal?: AbortSignal): Promise<MobileResult>
  installManagedApk(missionId: string, sessionId: string, relativeCachePath: string, actor?: MobileActor, signal?: AbortSignal, expectedRoot?: string): Promise<MobileResult>
}
export interface MobileExpoDeps {
  resolveMission(missionId: string): MissionScope | null
  runtime: MobileExpoRuntimeLike
  cacheRoot: string
  onChanged?(missionId: string): void
  nodeExecutable?: string
  /** Test seams are main-process dependencies, never IPC options. */
  launch?: MobileExpoLauncher
  transport?: MobileExpoTransport
  addresses?(): string[]
  reservePort?(signal: AbortSignal): Promise<MobileExpoPortReservation>
  startTimeoutMs?: number
  pollMs?: number
}
interface Operation { actor: MobileActor; epoch: number; abort: AbortController; done: Promise<void> }
interface Entry {
  missionId: string
  scope: MissionScope
  rootPath?: string
  state: MobileExpoState
  controllerPaneId?: string
  abort: AbortController
  epoch: number
  retiring: boolean
  operations: Set<Operation>
  boot: Promise<void>
  child?: MobileOwnedProcess
  reservation?: MobileExpoPortReservation
  closing: boolean
  closePromise?: Promise<boolean>
}
const OWNER: MobileActor = { kind: 'owner' }
const ok = <T>(value: T): MobileResult<T> => ({ ok: true, value })
const failed = (error: string): MobileResult<never> => ({ ok: false, error })
function safeError(error: unknown): string {
  if (error instanceof MobileCommandError) return error.message
  if (error instanceof MobileProcessError && error.reason === 'cancelled') return 'A operação Expo foi cancelada. Use Iniciar Expo no painel Mobile para retomar.'
  if (error instanceof MobileProcessError && error.reason === 'timeout') return 'O Expo não respondeu a tempo. Verifique as dependências e a conta Expo no terminal da missão e tente novamente.'
  return 'Não foi possível concluir a operação Expo. Confira o SDK, as dependências e a rede no terminal da missão e tente novamente pelo painel Mobile.'
}
function scopeKey(scope: MissionScope): string {
  const path = resolve(scope.rootPath)
  return `${scope.projectId}\0${process.platform === 'win32' ? path.toLowerCase() : path}`
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new MobileProcessError('cancelled')); return }
    const abort = (): void => { clearTimeout(timer); reject(new MobileProcessError('cancelled')) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
const emptyProject = (): MobileExpoProject => ({ kind: 'other', dependenciesInstalled: false, hasDevClient: false, message: 'Verificando o package.json desta missão.' })

/** Owns only explicitly launched local Expo processes. Physical phones are never adopted or controlled. */
export class MobileExpoManager {
  private readonly entries = new Map<string, Entry>()
  private readonly ports = new Map<number, Entry>()
  private readonly errors = new Map<string, string>()
  private disposed = false
  constructor(private readonly deps: MobileExpoDeps) {}

  async inspect(missionId: string, actor: MobileActor = OWNER): Promise<MobileResult<MobileExpoState>> {
    try {
      this.validActor(actor)
      const scope = this.scope(missionId), discovered = await inspectExpoProject(scope.rootPath)
      if (scopeKey(this.scope(missionId)) !== scopeKey(scope) || await expoRealRoot(scope.rootPath) !== discovered.rootPath) mobileError('A pasta desta missão mudou. Atualize o painel Mobile antes de continuar.')
      const entry = this.entries.get(missionId)
      if (entry) {
        if (!entry.closing) await this.assertLive(entry)
        return ok(this.snapshot(entry))
      }
      const error = this.errors.get(missionId)
      return ok({ project: discovered.project, status: error ? 'error' : 'idle', addresses: this.addresses(), ...(error ? { error } : {}) })
    } catch (error) { return failed(safeError(error)) }
  }

  async start(missionId: string, request: MobileExpoStartRequest = {}, actor: MobileActor = OWNER): Promise<MobileResult<MobileExpoState>> {
    let created: Entry | undefined
    try {
      this.validActor(actor); const scope = this.scope(missionId)
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(key => key !== 'address') ||
        (request.address !== undefined && !privateExpoAddress(request.address))) mobileError('Escolha uma das redes IPv4 disponíveis no painel Expo.')
      const existing = this.entries.get(missionId)
      if (existing) {
        this.assertCurrent(existing); this.authorize(existing, actor, true)
        if (request.address && request.address !== existing.state.selectedAddress) mobileError('Pare Expo antes de escolher outro endereço da rede local.')
        await existing.boot; await this.assertLive(existing)
        if (existing.state.status !== 'running') mobileError('Expo ainda não está pronto. Aguarde ou use Parar Expo para reiniciar.')
        return ok(this.snapshot(existing))
      }
      const addresses = this.addresses(), selectedAddress = request.address ?? addresses[0]
      if (!selectedAddress || !addresses.includes(selectedAddress)) mobileError('Conecte este computador a uma rede privada e escolha seu IPv4 no painel Expo. O iPhone físico precisa estar na mesma rede.')
      created = { missionId, scope, state: { project: emptyProject(), status: 'starting', addresses, selectedAddress },
        abort: new AbortController(), epoch: 0, retiring: false, operations: new Set(), boot: Promise.resolve(), closing: false,
        ...(actor.kind === 'agent' ? { controllerPaneId: actor.paneId } : {}) }
      // Reserve mission ownership synchronously before filesystem, socket or process awaits.
      this.entries.set(missionId, created); this.errors.delete(missionId); this.changed(created)
      created.boot = this.boot(created)
      await created.boot; await this.assertLive(created)
      return ok(this.snapshot(created))
    } catch (error) {
      if (created) {
        if (!(error instanceof MobileProcessError && error.reason === 'cancelled')) this.errors.set(missionId, safeError(error))
        await this.closeEntry(created)
      }
      return failed(safeError(error))
    }
  }

  async stop(missionId: string, actor: MobileActor = OWNER): Promise<MobileResult> {
    try {
      this.validActor(actor)
      const entry = this.entries.get(missionId)
      if (!entry) { this.scope(missionId); this.errors.delete(missionId); this.deps.onChanged?.(missionId); return ok(undefined) }
      this.authorize(entry, actor)
      if (actor.kind === 'agent') {
        // A controller may retry uncertain cleanup after liveness was deliberately revoked.
        if (scopeKey(this.scope(missionId)) !== scopeKey(entry.scope) ||
          (entry.rootPath && await expoRealRoot(entry.scope.rootPath) !== entry.rootPath)) mobileError('A pasta desta missão mudou. Peça ao dono para encerrar o Expo anterior pelo painel Mobile.')
        this.authorize(entry, actor)
      }
      const closed = await this.closeEntry(entry)
      if (!closed) return failed('O encerramento do Expo ainda não foi confirmado. Use Parar Expo novamente antes de fechar a missão.')
      this.errors.delete(missionId); return ok(undefined)
    } catch (error) { return failed(safeError(error)) }
  }

  async openAndroid(missionId: string, sessionId: string, actor: MobileActor = OWNER): Promise<MobileResult> {
    try {
      const entry = this.ready(missionId, actor)
      await this.operation(entry, actor, async signal => {
        await this.androidTarget(entry, sessionId, actor, signal)
        await this.requireServer(entry, actor, signal)
        const reverse = await this.deps.runtime.act(missionId, sessionId, { type: 'reverse', port: entry.state.port! }, actor, signal)
        if (!reverse.ok) mobileError(reverse.error)
        await this.requireServer(entry, actor, signal)
        const result = await this.deps.runtime.act(missionId, sessionId, { type: 'openUrl', url: entry.state.androidUrl! }, actor, signal)
        if (!result.ok) mobileError(result.error)
      })
      return ok(undefined)
    } catch (error) { return failed(safeError(error)) }
  }

  async installGo(missionId: string, sessionId: string, actor: MobileActor = OWNER): Promise<MobileResult> {
    try {
      const entry = this.ready(missionId, actor)
      await this.operation(entry, actor, async signal => {
        await this.androidTarget(entry, sessionId, actor, signal)
        const sdk = entry.state.project.sdkVersion
        if (!sdk) mobileError('O SDK Expo não foi identificado. Instale as dependências do projeto e use Iniciar Expo novamente.')
        const logicalCache = resolve(this.deps.cacheRoot)
        if (logicalCache === entry.rootPath || expoInside(entry.rootPath!, logicalCache)) mobileError('O cache do Expo Go precisa ficar nos dados privados do Synkora, fora do worktree. Reabra o painel Mobile após ajustar a configuração.')
        await mkdir(this.deps.cacheRoot, { recursive: true, mode: 0o700 })
        const initialCache = await expoRealRoot(this.deps.cacheRoot)
        if (initialCache === entry.rootPath || expoInside(entry.rootPath!, initialCache)) mobileError('O cache do Expo Go não pode apontar para o worktree. Ajuste o cache privado do aplicativo e tente novamente.')
        await this.assertOperation(entry, actor, signal)
        const relativeCachePath = await downloadExpoGo(sdk, initialCache, { signal, transport: this.deps.transport })
        await this.assertOperation(entry, actor, signal)
        const actualCache = await expoRealRoot(this.deps.cacheRoot)
        if (actualCache !== initialCache || actualCache === entry.rootPath || expoInside(entry.rootPath!, actualCache)) mobileError('O destino do cache do Expo Go mudou durante o download. Reabra o painel Mobile e use Instalar Expo Go novamente.')
        const result = await this.deps.runtime.installManagedApk(missionId, sessionId, relativeCachePath, actor, signal, initialCache)
        if (!result.ok) mobileError(result.error)
      })
      return ok(undefined)
    } catch (error) { return failed(safeError(error)) }
  }

  releaseController(paneId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.controllerPaneId !== paneId) continue
      entry.epoch++; delete entry.controllerPaneId
      for (const operation of entry.operations) if (operation.actor.kind === 'agent' && operation.actor.paneId === paneId) operation.abort.abort()
      entry.retiring = [...entry.operations].some(operation => operation.actor.kind === 'agent')
      this.changed(entry)
      if (entry.state.status === 'starting') void this.closeEntry(entry)
    }
  }
  async closeMission(missionId: string): Promise<void> {
    const entry = this.entries.get(missionId)
    // closeEntry aborts synchronously; callers may safely await all cleanup before releasing a worktree.
    if (entry && !await this.closeEntry(entry)) mobileError('O processo Expo ainda mantém a missão aberta. Use Parar Expo e tente fechar a missão novamente.')
    this.errors.delete(missionId)
  }
  async dispose(): Promise<void> {
    this.disposed = true
    const results = await Promise.all([...this.entries.values()].map(entry => this.closeEntry(entry)))
    this.errors.clear()
    if (results.some(result => !result)) mobileError('Não foi possível confirmar o encerramento de todos os processos Expo.')
  }

  private scope(missionId: string): MissionScope {
    if (this.disposed || !validMobileId(missionId)) mobileError('Abra uma missão de desenvolvimento ativa para usar Expo no painel Mobile.')
    const scope = this.deps.resolveMission(missionId)
    if (!scope?.projectId || !scope.rootPath) mobileError('Esta missão não tem worktree ativo. Abra uma missão de desenvolvimento para usar Expo.')
    return { ...scope }
  }
  private addresses(): string[] { return [...new Set((this.deps.addresses?.() ?? privateExpoAddresses()).filter(privateExpoAddress))] }
  private validActor(actor: MobileActor): void {
    if (!actor || (actor.kind !== 'owner' && (actor.kind !== 'agent' || !validMobileId(actor.paneId)))) mobileError('Controlador Expo inválido. Reabra a conversa desta missão e use mobile_expo com action start.')
  }
  private authorize(entry: Entry, actor: MobileActor, claim = false): void {
    this.validActor(actor)
    if (actor.kind === 'owner') return
    if (entry.retiring) mobileError('Uma operação do controlador anterior está encerrando. Aguarde e use mobile_expo com action start novamente.')
    if (!entry.controllerPaneId && claim) { entry.controllerPaneId = actor.paneId; entry.epoch++; this.changed(entry) }
    if (entry.controllerPaneId !== actor.paneId) mobileError('Este Expo pertence a outro controlador ou ainda não foi reservado por você. Use mobile_expo com action start nesta missão ou peça ao dono para liberar a sessão.')
  }
  private assertCurrent(entry: Entry): void {
    if (entry.closing || entry.abort.signal.aborted || this.entries.get(entry.missionId) !== entry) throw new MobileProcessError('cancelled')
    if (scopeKey(this.scope(entry.missionId)) !== scopeKey(entry.scope)) mobileError('A pasta desta missão mudou. Use Parar Expo e inicie novamente no worktree atual.')
    if (entry.child && !entry.child.isAlive()) mobileError('O CLI Expo encerrou. Confira o projeto no terminal da missão e use Iniciar Expo novamente.')
  }
  private async assertLive(entry: Entry): Promise<void> {
    this.assertCurrent(entry)
    if (entry.rootPath && await expoRealRoot(entry.scope.rootPath) !== entry.rootPath) mobileError('O destino físico do worktree mudou. Use Parar Expo antes de continuar.')
    this.assertCurrent(entry)
  }
  private ready(missionId: string, actor: MobileActor): Entry {
    this.validActor(actor)
    const entry = this.entries.get(missionId)
    if (!entry) mobileError('Inicie Expo nesta missão pelo painel Mobile ou use mobile_expo com action start.')
    this.assertCurrent(entry); this.authorize(entry, actor)
    if (entry.state.status !== 'running' || !entry.state.port || !entry.state.androidUrl) mobileError('Aguarde Expo ficar pronto ou use Iniciar Expo no painel Mobile.')
    return entry
  }
  private async assertOperation(entry: Entry, actor: MobileActor, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new MobileProcessError('cancelled')
    await this.assertLive(entry)
    if (signal.aborted) throw new MobileProcessError('cancelled')
    this.authorize(entry, actor)
  }
  private async requireServer(entry: Entry, actor: MobileActor, signal: AbortSignal): Promise<void> {
    let failure: string | undefined
    try {
      if (!await probeExpoServer(entry.state.port!, entry.state.selectedAddress!, signal, this.deps.transport ?? expoTransport)) {
        failure = 'O servidor Expo desta missão não está respondendo. Use Parar Expo e Iniciar Expo novamente antes de abrir no Android.'
      }
    } catch (error) {
      if (signal.aborted) throw new MobileProcessError('cancelled')
      failure = safeError(error)
    }
    await this.assertOperation(entry, actor, signal)
    if (failure) {
      entry.state.status = 'error'; entry.state.error = failure
      delete entry.state.lanUrl; delete entry.state.androidUrl; delete entry.state.qrDataUrl
      this.changed(entry); mobileError(failure)
    }
  }
  private async operation<T>(entry: Entry, actor: MobileActor, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (entry.operations.size >= 4) mobileError('Há operações Expo em andamento. Aguarde antes de enviar outra ação.')
    let finish!: () => void
    const operation: Operation = { actor, epoch: entry.epoch, abort: new AbortController(), done: new Promise<void>(resolve => { finish = resolve }) }
    const abort = (): void => operation.abort.abort()
    entry.abort.signal.addEventListener('abort', abort, { once: true }); entry.operations.add(operation)
    try {
      await this.assertOperation(entry, actor, operation.abort.signal)
      const value = await work(operation.abort.signal)
      await this.assertOperation(entry, actor, operation.abort.signal)
      if (actor.kind === 'agent' && operation.epoch !== entry.epoch) throw new MobileProcessError('cancelled')
      return value
    } finally {
      entry.abort.signal.removeEventListener('abort', abort); entry.operations.delete(operation); finish()
      if (entry.retiring && ![...entry.operations].some(current => current.actor.kind === 'agent')) { entry.retiring = false; this.changed(entry) }
    }
  }
  private async androidTarget(entry: Entry, sessionId: string, actor: MobileActor, signal: AbortSignal): Promise<void> {
    if (!validMobileId(sessionId)) mobileError('Escolha a sessão Android desta missão no painel Mobile.')
    const result = await this.deps.runtime.inspect(entry.missionId)
    await this.assertOperation(entry, actor, signal)
    if (!result.ok) mobileError(result.error)
    const session = result.value.sessions.find(candidate => candidate.id === sessionId && candidate.missionId === entry.missionId)
    if (!session || session.platform !== 'android' || session.state !== 'ready') mobileError('Inicie o emulador Android desta missão pelo painel Mobile ou por mobile_start antes de abrir Expo Go.')
    if (actor.kind === 'agent' && session.controllerPaneId !== actor.paneId) mobileError('O Android desta missão pertence a outro controlador. Use mobile_start para reservar sua sessão antes de abrir ou instalar Expo Go.')
  }

  private async boot(entry: Entry): Promise<void> {
    const discovered = await inspectExpoProject(entry.scope.rootPath)
    entry.rootPath = discovered.rootPath; entry.state.project = discovered.project
    await this.assertLive(entry)
    if (discovered.project.kind !== 'expo') mobileError(discovered.project.message)
    if (!discovered.project.dependenciesInstalled || !discovered.cliPath) mobileError(discovered.project.message)
    if (!this.addresses().includes(entry.state.selectedAddress!)) mobileError('O endereço selecionado não está mais nesta máquina. Atualize Expo e escolha a rede atual.')
    const reservation = await (this.deps.reservePort ?? reserveExpoPort)(entry.abort.signal)
    entry.reservation = reservation
    try {
      await this.assertLive(entry)
      if (!Number.isInteger(reservation.port) || reservation.port < 1024 || reservation.port > 65535 || this.ports.has(reservation.port)) mobileError('A porta do Expo já está reservada por outra missão. Use Iniciar Expo novamente.')
      this.ports.set(reservation.port, entry); entry.state.port = reservation.port
      await reservation.release(); delete entry.reservation
      await this.assertLive(entry)
      entry.child = await (this.deps.launch ?? launchExpoProcess)({ executable: this.deps.nodeExecutable ?? process.execPath,
        args: [discovered.cliPath, 'start', '--go', '--lan', '--port', String(reservation.port), '--max-workers', '2'],
        cwd: discovered.rootPath, env: expoProcessEnvironment(entry.state.selectedAddress!), signal: entry.abort.signal })
      void entry.child.exited.then(() => {
        if (entry.closing) return
        this.errors.set(entry.missionId, 'O CLI Expo encerrou. Confira o projeto no terminal da missão e use Iniciar Expo novamente.')
        void this.closeEntry(entry)
      })
      await this.assertLive(entry)
      const deadline = Date.now() + (this.deps.startTimeoutMs ?? 60_000)
      while (Date.now() < deadline) {
        await this.assertLive(entry)
        if (await probeExpoServer(reservation.port, entry.state.selectedAddress!, entry.abort.signal, this.deps.transport ?? expoTransport)) {
          await this.assertLive(entry)
          const lanUrl = `exp://${entry.state.selectedAddress}:${reservation.port}`
          const qrDataUrl = await QRCode.toDataURL(lanUrl, { type: 'image/png', errorCorrectionLevel: 'M', margin: 2, width: 280 })
          await this.assertLive(entry)
          entry.state = { ...entry.state, status: 'running', lanUrl, androidUrl: `exp://127.0.0.1:${reservation.port}`, qrDataUrl }
          this.changed(entry); return
        }
        await wait(this.deps.pollMs ?? 400, entry.abort.signal)
      }
      throw new MobileProcessError('timeout')
    } finally { await entry.reservation?.release(); delete entry.reservation }
  }
  private closeEntry(entry: Entry): Promise<boolean> {
    if (entry.closePromise) return entry.closePromise
    // Revoke URLs and every authority synchronously before waiting for child or network cleanup.
    entry.closing = true; entry.epoch++; entry.abort.abort(); entry.state.status = 'stopping'
    delete entry.state.lanUrl; delete entry.state.androidUrl; delete entry.state.qrDataUrl
    this.changed(entry)
    entry.closePromise = (async () => {
      await entry.boot.catch(() => {})
      await Promise.all([...entry.operations].map(operation => operation.done))
      await entry.reservation?.release(); delete entry.reservation
      const stopped = !entry.child || await entry.child.stop().catch(() => false)
      if (!stopped) {
        entry.state.status = 'error'; entry.state.error = 'O encerramento do CLI Expo ainda não foi confirmado. Use Parar Expo novamente antes de fechar a missão.'
        entry.closePromise = undefined; this.changed(entry); return false
      }
      if (entry.state.port && this.ports.get(entry.state.port) === entry) this.ports.delete(entry.state.port)
      if (this.entries.get(entry.missionId) === entry) this.entries.delete(entry.missionId)
      this.changed(entry); return true
    })()
    return entry.closePromise
  }
  private snapshot(entry: Entry): MobileExpoState { return { ...entry.state, project: { ...entry.state.project }, addresses: [...entry.state.addresses] } }
  private changed(entry: Entry): void { this.deps.onChanged?.(entry.missionId) }
}
