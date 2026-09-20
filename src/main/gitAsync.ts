import { MessageChannel, Worker } from 'node:worker_threads'
import { join } from 'path'
import type * as worktreeApi from './worktree'
import type * as contextGitApi from './projectContextGit'

// PONTE ASSÍNCRONA DO GIT (task #2, 2026-08-04): tira o git do main thread.
// `gitOff('fn', ...args)` executa a função exportada de worktree.ts
// DENTRO do gitWorker (tipada por Parameters/ReturnType — a
// assinatura é a mesma da função síncrona). O worker é único e processa em
// série; morte/erro do worker rejeita os pendentes e o próximo call respawna.
// FALLBACK: se o worker não subir (ex.: empacotamento sem o entry), a chamada
// roda SÍNCRONA no main — comportamento idêntico ao anterior, nunca pior.

type GitApi = typeof worktreeApi & typeof contextGitApi

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let workerBroken = false
let sequence = 0
const pending = new Map<number, PendingCall>()
let syncFallback: Promise<GitApi> | null = null

function loadSyncFallback(): Promise<GitApi> {
  if (!syncFallback) {
    syncFallback = Promise.all([import('./worktree'), import('./projectContextGit')])
      .then(([worktree, contextGit]) => ({ ...worktree, ...contextGit }))
  }
  return syncFallback
}

function rejectAll(error: Error): void {
  for (const call of pending.values()) call.reject(error)
  pending.clear()
}

function ensureWorker(): Worker | null {
  if (workerBroken) return null
  if (worker) return worker
  try {
    const spawned = new Worker(join(__dirname, 'gitWorker.js'))
    spawned.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: { message: string; stack?: string } }) => {
      const call = pending.get(msg.id)
      if (!call) return
      pending.delete(msg.id)
      if (msg.ok) call.resolve(msg.result)
      else {
        const error = new Error(msg.error?.message ?? 'git worker: erro desconhecido')
        if (msg.error?.stack) error.stack = msg.error.stack
        call.reject(error)
      }
    })
    spawned.on('error', (error) => {
      rejectAll(error instanceof Error ? error : new Error(String(error)))
      worker = null
    })
    spawned.on('exit', () => {
      rejectAll(new Error('git worker encerrou no meio de uma operação'))
      worker = null
    })
    worker = spawned
    return spawned
  } catch {
    // Worker indisponível (ex.: entry ausente no empacotamento): fallback
    // síncrono permanente nesta sessão — nunca pior que o comportamento velho.
    workerBroken = true
    return null
  }
}

export function gitOff<K extends keyof GitApi>(
  fn: K,
  ...args: GitApi[K] extends (...a: infer A) => unknown ? A : never
): Promise<GitApi[K] extends (...a: never[]) => infer R ? R : never> {
  const live = ensureWorker()
  if (!live) {
    return loadSyncFallback().then((api) => {
      const target = api[fn]
      return (target as (...a: unknown[]) => unknown)(...(args as unknown[]))
    }) as never
  }
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
    live.postMessage({ id, fn, args })
  }) as never
}

/** Marcador que o chamador coloca NO LUGAR de um callback de checkpoint
 *  (ex.: options.beforeTargetUpdate do mergeTaskWorktree) — o worker o troca
 *  pela ponte síncrona (Atomics) que invoca onCheckpoint AQUI no main. */
export const GIT_CHECKPOINT_MARKER = '__SYNKORA_GIT_CHECKPOINT__'

/** Variante do gitOff para funções com callback de checkpoint no meio da
 *  operação (persistência do recibo de integração — crash-safety do
 *  merge-repair): o worker BLOQUEIA no ponto do callback enquanto o main
 *  executa onCheckpoint e o libera; o main nunca bloqueia. */
export function gitOffWithCheckpoint<K extends keyof GitApi>(
  fn: K,
  args: GitApi[K] extends (...a: infer A) => unknown ? A : never,
  onCheckpoint: (payload: unknown) => unknown
): Promise<GitApi[K] extends (...a: never[]) => infer R ? R : never> {
  const substitute = (value: unknown): unknown => {
    if (value === GIT_CHECKPOINT_MARKER) return onCheckpoint
    if (Array.isArray(value)) return value.map(substitute)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = substitute(item)
      }
      return out
    }
    return value
  }
  const live = ensureWorker()
  if (!live) {
    return loadSyncFallback().then((api) => {
      const target = api[fn]
      return (target as (...a: unknown[]) => unknown)(
        ...(args as unknown[]).map(substitute)
      )
    }) as never
  }
  const { port1, port2 } = new MessageChannel()
  const sab = new SharedArrayBuffer(4)
  const flag = new Int32Array(sab)
  port1.on('message', (payload: unknown) => {
    let reply: { ok: boolean; value?: unknown; message?: string }
    try {
      reply = { ok: true, value: onCheckpoint(payload) }
    } catch (error) {
      // Falha ao persistir o checkpoint PRECISA abortar o merge no worker
      // (crash-safety do recibo) — viaja como erro e o bridge relança lá.
      reply = {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }
    }
    port1.postMessage(reply)
    Atomics.store(flag, 0, 1)
    Atomics.notify(flag, 0)
  })
  const id = ++sequence
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (value: unknown) => {
        port1.close()
        resolve(value as never)
      },
      reject: (error: Error) => {
        port1.close()
        reject(error)
      }
    })
    live.postMessage({ id, fn, args, checkpoint: { sab, port: port2 } }, [port2])
  }) as never
}
