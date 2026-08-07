// stallAttribution.ts — Fase 0 do nível 5 (plano em docs/PLANO_NIVEL_5.md):
// atribuição de CULPA dos stalls do event loop do MAIN. O watchdog do index
// sabe QUE o main travou (event-loop-stall); este módulo sabe O QUE estava
// rodando durante a janela travada — sem stacks e sem amostragem contínua:
// cada operação custa dois Date.now() e um Map.set/delete.
//
// Modelo: operação = intervalo [startedAt, endedAt] com rótulo curto. O
// tracker guarda as ABERTAS e um ring das RECÉM-FECHADAS relevantes (>=120ms;
// mais curtas não explicam stall de segundos). blame(lagMs) devolve as
// operações que intersectam a janela [now - lagMs - tickMs, now], ordenadas
// pela sobreposição. Módulo PURO (nunca importa electron/app) — a suíte
// test:stall-attribution roda em node cru.

export interface BlamedOp {
  kind: string
  detail?: string
  overlapMs: number
  durationMs: number
  open: boolean
}

interface OpenOp {
  kind: string
  detail?: string
  startedAt: number
}

interface FinishedOp extends OpenOp {
  endedAt: number
}

const RING_MAX = 64
const RING_MIN_DURATION_MS = 120
const BLAME_MAX = 8
const DETAIL_MAX = 120

export class StallAttribution {
  private nextId = 1
  private readonly open = new Map<number, OpenOp>()
  private readonly ring: FinishedOp[] = []
  private readonly now: () => number

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /** Início de operação; devolve o fechador (idempotente, nunca lança). */
  begin(kind: string, detail?: string): () => void {
    const id = this.nextId++
    this.open.set(id, {
      kind,
      detail: detail === undefined ? undefined : detail.slice(0, DETAIL_MAX),
      startedAt: this.now()
    })
    let closed = false
    return () => {
      if (closed) return
      closed = true
      const op = this.open.get(id)
      if (!op) return
      this.open.delete(id)
      const endedAt = this.now()
      if (endedAt - op.startedAt < RING_MIN_DURATION_MS) return
      this.ring.push({ ...op, endedAt })
      if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX)
    }
  }

  /** Envolve fn (sync OU async) com begin/fim — o fim acompanha o resultado:
   *  promise fecha no settle (sucesso ou rejeição), sync fecha na volta,
   *  exceção fecha e relança. */
  wrap<T>(kind: string, detail: string | undefined, fn: () => T): T {
    const end = this.begin(kind, detail)
    let result: T
    try {
      result = fn()
    } catch (err) {
      end()
      throw err
    }
    if (result instanceof Promise) {
      return result.finally(end) as T
    }
    end()
    return result
  }

  /** Operações que intersectam a janela do stall [now - lagMs - tickMs, now].
   *  tickMs é o período do watchdog (o lag é medido em cima dele). */
  blame(lagMs: number, tickMs = 1000): BlamedOp[] {
    const now = this.now()
    const windowStart = now - lagMs - tickMs
    const blamed: BlamedOp[] = []
    for (const op of this.open.values()) {
      const overlapMs = now - Math.max(op.startedAt, windowStart)
      if (overlapMs <= 0) continue
      blamed.push({
        kind: op.kind,
        detail: op.detail,
        overlapMs,
        durationMs: now - op.startedAt,
        open: true
      })
    }
    for (const op of this.ring) {
      if (op.endedAt <= windowStart) continue
      const overlapMs = Math.min(op.endedAt, now) - Math.max(op.startedAt, windowStart)
      if (overlapMs <= 0) continue
      blamed.push({
        kind: op.kind,
        detail: op.detail,
        overlapMs,
        durationMs: op.endedAt - op.startedAt,
        open: false
      })
    }
    blamed.sort((a, b) => b.overlapMs - a.overlapMs)
    return blamed.slice(0, BLAME_MAX)
  }

  /** Linhas compactas para a caixa-preta. */
  blameSummary(lagMs: number, tickMs = 1000): string[] {
    return this.blame(lagMs, tickMs).map(
      (op) =>
        `${op.kind}${op.detail ? `(${op.detail})` : ''} ~${Math.round(op.overlapMs)}ms na janela` +
        ` · total ${Math.round(op.durationMs)}ms${op.open ? ' · AINDA ABERTA' : ''}`
    )
  }

  /** Operações abertas agora (saúde/testes). */
  openCount(): number {
    return this.open.size
  }
}

/** Shape estrutural do ipcMain — evita importar electron aqui (a suíte roda
 *  em node cru). O ipcMain real satisfaz este contrato. `any[]` é interop
 *  inevitável: os listeners do electron são tipados com (event, ...any[]) e
 *  qualquer shape mais estreito quebra a atribuição contravariante. */
/* eslint-disable @typescript-eslint/no-explicit-any */
export interface IpcRegistrarLike {
  handle(channel: string, listener: (...args: any[]) => unknown): void
  on(channel: string, listener: (...args: any[]) => void): unknown
}

/** Monkey-patch de ipcMain.handle/on: TODO handler registrado DEPOIS desta
 *  chamada vira operação medida (`ipc:<canal>` / `ipc-on:<canal>`) — cobre os
 *  ~120 handlers do main sem tocar em cada um. Chamar UMA vez, ANTES de
 *  qualquer registro de handler. */
export function instrumentIpcMain(ipc: IpcRegistrarLike, tracker: StallAttribution): void {
  const origHandle = ipc.handle.bind(ipc)
  ipc.handle = (channel: string, listener: (...args: any[]) => unknown): void =>
    origHandle(channel, (...args: any[]) =>
      tracker.wrap(`ipc:${channel}`, undefined, () => listener(...args))
    )
  const origOn = ipc.on.bind(ipc)
  ipc.on = (channel: string, listener: (...args: any[]) => void): unknown =>
    origOn(channel, (...args: any[]) => {
      tracker.wrap(`ipc-on:${channel}`, undefined, () => listener(...args))
    })
}
/* eslint-enable @typescript-eslint/no-explicit-any */
