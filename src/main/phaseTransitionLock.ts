/**
 * PHASE TRANSITION LOCK — Fase 2 do nível 5 (docs/FASE2_PLANO.md §3).
 *
 * Serializa TRANSIÇÕES DE CARD por taskId: veredito de gate/done do dev,
 * `bloqueada`, finalize/merge, respawn de boot e troca de executor. Com o
 * `advancePhase` assíncrono, a atomicidade do veredito deixa de vir da
 * sincronicidade e passa a vir DESTE lock — "quem SEGURA O LOCK deleta o
 * watch" (a regra que substitui o re-check por referência do poller).
 *
 * Contratos (não relaxar):
 * - `acquire` é SÍNCRONO de propósito, como o `reserve` do PhaseLaunchGuard:
 *   a posse entra no Map antes de o chamador alcançar o primeiro `await` —
 *   dois entrantes no mesmo tick jamais seguram o mesmo card.
 * - Aquisição SÓ nos pontos de entrada (report, poller, boot, reseat) —
 *   NUNCA no grafo interno do engine (continuações herdam o token do
 *   entrante; re-aquisição seria deadlock na fila).
 * - `waitAndAcquire` é fila FIFO para quem deve ESPERAR (ordem do dono),
 *   nunca sumir; o release TRANSFERE a posse ao próximo no MESMO tick — não
 *   existe janela destravada entre um dono e o seguinte.
 * - Sem estado em disco e sem timeout: crash zera o lock junto com o registry
 *   e a reconciliação de boot continua a de hoje; o dono da transição SEMPRE
 *   solta no settle (try/finally no call site — timeout aqui mascararia bug).
 */

/** Token opaco de posse — a identidade do Symbol, não o texto, autoriza. */
export type PhaseTransitionToken = symbol

export interface PhaseTransitionMeta {
  /** Rótulo curto do entrante (ex.: 'report:review', 'poller:done'). */
  label: string
  /** Projeto do card — alimenta lockedCount (teto MAX_PARALLEL_RUNS). */
  projectId: string
}

/** Contenda observável: alguém quis o card enquanto outro o segurava. */
export interface PhaseTransitionContention {
  taskId: string
  projectId: string
  holderLabel: string
  waiterLabel: string
  /** true = try-acquire negado na hora; false = entrou na fila FIFO. */
  refused: boolean
}

interface HeldLock {
  token: PhaseTransitionToken
  label: string
  projectId: string
  waiters: Array<{
    label: string
    projectId: string
    grant: (token: PhaseTransitionToken) => void
  }>
}

export class PhaseTransitionLock {
  private readonly held = new Map<string, HeldLock>()
  private readonly onContention?: (info: PhaseTransitionContention) => void

  constructor(onContention?: (info: PhaseTransitionContention) => void) {
    this.onContention = onContention
  }

  /** Try-lock síncrono; `undefined` = card em transição (não re-tentar às
   *  cegas — a receita do call site diz o que fazer). */
  acquire(taskId: string, meta: PhaseTransitionMeta): PhaseTransitionToken | undefined {
    const key = this.key(taskId)
    if (!key) return undefined
    const current = this.held.get(key)
    if (current) {
      this.notifyContention(key, current, meta.label, true)
      return undefined
    }
    const token = Symbol(`phase-transition:${key}:${meta.label}`)
    this.held.set(key, {
      token,
      label: meta.label,
      projectId: meta.projectId,
      waiters: []
    })
    return token
  }

  /** Fila FIFO para entrantes que devem ESPERAR (nunca sumir). Card livre =
   *  resolve já adquirido no mesmo tick (a Promise só embrulha o token). */
  waitAndAcquire(taskId: string, meta: PhaseTransitionMeta): Promise<PhaseTransitionToken> {
    const key = this.key(taskId)
    if (!key) return Promise.reject(new Error('phase-transition: taskId vazio'))
    const current = this.held.get(key)
    if (!current) {
      const token = this.acquire(key, meta)
      if (token) return Promise.resolve(token)
      return this.waitAndAcquire(key, meta)
    }
    this.notifyContention(key, current, meta.label, false)
    return new Promise((grant) =>
      current.waiters.push({ label: meta.label, projectId: meta.projectId, grant })
    )
  }

  owns(taskId: string, token: PhaseTransitionToken): boolean {
    return this.held.get(this.key(taskId))?.token === token
  }

  /** O estado CONSULTÁVEL da transição — a ausência do watch deixou de
   *  significar "card livre"; quem pergunta "está livre?" pergunta AQUI. */
  isLocked(taskId: string): boolean {
    return this.held.has(this.key(taskId))
  }

  holderLabel(taskId: string): string | undefined {
    return this.held.get(this.key(taskId))?.label
  }

  /** Cards do projeto em transição — soma-se às contagens derivadas de
   *  phaseWatches (o card detached em voo não pode furar o teto). */
  lockedCount(projectId: string): number {
    let count = 0
    for (const lock of this.held.values()) {
      if (lock.projectId === projectId) count++
    }
    return count
  }

  /** Só o dono solta; token errado/velho é no-op (`false`). Com fila, a posse
   *  é TRANSFERIDA ao primeiro da fila no mesmo tick — `isLocked` nunca
   *  reporta uma janela destravada entre dois donos. */
  release(taskId: string, token: PhaseTransitionToken): boolean {
    const key = this.key(taskId)
    const current = this.held.get(key)
    if (!current || current.token !== token) return false
    const next = current.waiters.shift()
    if (!next) {
      this.held.delete(key)
      return true
    }
    const transferred = Symbol(`phase-transition:${key}:${next.label}`)
    this.held.set(key, {
      token: transferred,
      label: next.label,
      projectId: next.projectId,
      waiters: current.waiters
    })
    next.grant(transferred)
    return true
  }

  /** Retrato para caixa-preta/diagnóstico — nunca para decisão de fluxo. */
  snapshot(): Array<{ taskId: string; label: string; projectId: string; waiters: number }> {
    return [...this.held.entries()].map(([taskId, lock]) => ({
      taskId,
      label: lock.label,
      projectId: lock.projectId,
      waiters: lock.waiters.length
    }))
  }

  private notifyContention(
    taskId: string,
    current: HeldLock,
    waiterLabel: string,
    refused: boolean
  ): void {
    try {
      this.onContention?.({
        taskId,
        projectId: current.projectId,
        holderLabel: current.label,
        waiterLabel,
        refused
      })
    } catch {
      // observabilidade nunca derruba a transição
    }
  }

  private key(taskId: string): string {
    return taskId.trim()
  }
}
