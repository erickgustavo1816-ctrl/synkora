import { parentPort, receiveMessageOnPort, type MessagePort } from 'node:worker_threads'
import * as worktree from './worktree'

// WORKER DE GIT (task #2, 2026-08-04): as "travadas" do app eram o MAIN
// congelado em execFileSync de git (spawn 1-2s, transição 2-3,5s, merge
// ~5s medidos pelo watchdog). As funções síncronas de worktree.ts/
// worktree.ts rodam AQUI, intactas — o main só espera a mensagem. Um
// worker único = operações git naturalmente serializadas (nunca dois
// merges/worktrees concorrentes). Este arquivo NÃO pode importar 'electron'.
//
// CHECKPOINT SÍNCRONO: mergeTaskWorktree persiste o RECIBO de integração no
// meio do merge (beforeTargetUpdate — espinha do merge-repair). Função não
// viaja por postMessage; o chamador manda o marcador CHECKPOINT_MARKER no
// lugar e um {sab, port}: o worker posta o payload, BLOQUEIA em Atomics.wait
// (só o worker bloqueia — o main segue livre), o main persiste e notifica.

export const CHECKPOINT_MARKER = '__SYNKORA_GIT_CHECKPOINT__'

// DESPACHO POR STRING: cada export de worktree.ts é uma chave do contrato
// (gitOff('<nome>')). Antes de remover qualquer export de lá, grepe pelo NOME
// — o typecheck não enxerga este mapa.
const registry: Record<string, unknown> = {
  ...worktree
}

interface GitWorkerRequest {
  id: number
  fn: string
  args: unknown[]
  checkpoint?: { sab: SharedArrayBuffer; port: MessagePort }
}

function substituteCheckpoint(value: unknown, bridge: (payload: unknown) => unknown): unknown {
  if (value === CHECKPOINT_MARKER) return bridge
  if (Array.isArray(value)) return value.map((item) => substituteCheckpoint(item, bridge))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substituteCheckpoint(item, bridge)
    }
    return out
  }
  return value
}

parentPort?.on('message', (request: GitWorkerRequest) => {
  try {
    const fn = registry[request.fn]
    if (typeof fn !== 'function')
      throw new Error(`git worker: função desconhecida "${request.fn}"`)
    let args = request.args
    if (request.checkpoint) {
      const { sab, port } = request.checkpoint
      const flag = new Int32Array(sab)
      const bridge = (payload: unknown): unknown => {
        Atomics.store(flag, 0, 0)
        port.postMessage(payload)
        const woke = Atomics.wait(flag, 0, 0, 120_000)
        if (woke === 'timed-out')
          throw new Error('git worker: checkpoint sem resposta do main em 120s')
        const reply = receiveMessageOnPort(port)?.message as
          | { ok: boolean; value?: unknown; message?: string }
          | undefined
        if (!reply) throw new Error('git worker: checkpoint sem payload de resposta')
        if (!reply.ok) throw new Error(reply.message ?? 'checkpoint falhou no main')
        return reply.value
      }
      args = args.map((arg) => substituteCheckpoint(arg, bridge))
    }
    const result = (fn as (...a: unknown[]) => unknown)(...args)
    parentPort?.postMessage({ id: request.id, ok: true, result })
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error:
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : { message: String(error) }
    })
  }
})
