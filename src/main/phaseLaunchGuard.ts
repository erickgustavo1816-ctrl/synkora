/**
 * Token opaco que identifica o dono de uma reserva de lançamento.
 *
 * A identidade do Symbol, e não seu texto, é o que autoriza a liberação.
 */
export type PhaseLaunchToken = symbol

/**
 * Serializa o trecho assíncrono que prepara uma fase para a mesma task.
 *
 * `reserve` é intencionalmente síncrono: a reserva entra no Map antes que o
 * chamador alcance seu primeiro `await`, fechando a janela para dois panes.
 */
export class PhaseLaunchGuard {
  private readonly reservations = new Map<string, PhaseLaunchToken>()

  reserve(taskId: string): PhaseLaunchToken | undefined {
    const key = this.key(taskId)
    if (!key || this.reservations.has(key)) return undefined

    const token = Symbol(`phase-launch:${key}`)
    this.reservations.set(key, token)
    return token
  }

  isReserved(taskId: string): boolean {
    const key = this.key(taskId)
    return key ? this.reservations.has(key) : false
  }

  owns(taskId: string, token: PhaseLaunchToken): boolean {
    const key = this.key(taskId)
    return key ? this.reservations.get(key) === token : false
  }

  release(taskId: string, token: PhaseLaunchToken): boolean {
    const key = this.key(taskId)
    if (!key || this.reservations.get(key) !== token) return false

    this.reservations.delete(key)
    return true
  }

  private key(taskId: string): string {
    return taskId.trim()
  }
}

/** Reserva vagas de lançamento por projeto durante trechos assíncronos. O
 * contador de watches ativos sozinho não enxerga chamadas paradas em await. */
export class PhaseLaunchCapacityGuard {
  private readonly reservations = new Map<string, Set<PhaseLaunchToken>>()

  reserve(
    projectId: string,
    activeCount: number,
    limit: number
  ): PhaseLaunchToken | undefined {
    const key = projectId.trim()
    if (!key || limit < 1) return undefined
    const pending = this.reservations.get(key) ?? new Set<PhaseLaunchToken>()
    if (activeCount + pending.size >= limit) return undefined
    const token = Symbol(`phase-capacity:${key}`)
    pending.add(token)
    this.reservations.set(key, pending)
    return token
  }

  release(projectId: string, token: PhaseLaunchToken): boolean {
    const key = projectId.trim()
    const pending = this.reservations.get(key)
    if (!pending?.delete(token)) return false
    if (pending.size === 0) this.reservations.delete(key)
    return true
  }

  pending(projectId: string): number {
    return this.reservations.get(projectId.trim())?.size ?? 0
  }
}
