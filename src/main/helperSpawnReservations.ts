/**
 * Reserva síncrona do único slot de helper antes de qualquer await do spawn.
 * O processo principal do Electron é single-threaded: tryAcquire transforma
 * check + claim numa única seção crítica para chamadas MCP concorrentes.
 */
export class HelperSpawnReservationRegistry {
  private readonly active = new Set<string>()

  tryAcquire(key: string): boolean {
    if (!key || this.active.has(key)) return false
    this.active.add(key)
    return true
  }

  release(key: string): void {
    this.active.delete(key)
  }

  has(key: string): boolean {
    return this.active.has(key)
  }
}
