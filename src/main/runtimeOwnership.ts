/**
 * Registro por identidade para processos substituíveis. Um callback atrasado
 * de uma geração antiga pode limpar os próprios recursos, mas nunca remove a
 * geração atual do mesmo escopo.
 */
export class RuntimeOwnershipRegistry<Entry> {
  private readonly currentByScope = new Map<string, Entry>()
  private generation = 0

  nextGuardName(namespace: string, scope: string): string {
    this.generation += 1
    const safeNamespace = namespace.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 24)
    const safeScope = scope.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 16)
    return `${safeNamespace}-${safeScope}-${process.pid.toString(36)}-${this.generation.toString(36)}`
  }

  set(scope: string, entry: Entry): void {
    this.currentByScope.set(scope, entry)
  }

  get(scope: string): Entry | undefined {
    return this.currentByScope.get(scope)
  }

  isCurrent(scope: string, entry: Entry): boolean {
    return this.currentByScope.get(scope) === entry
  }

  deleteIfCurrent(scope: string, entry: Entry): boolean {
    if (!this.isCurrent(scope, entry)) return false
    return this.currentByScope.delete(scope)
  }

  entries(): IterableIterator<[string, Entry]> {
    return this.currentByScope.entries()
  }

  keys(): IterableIterator<string> {
    return this.currentByScope.keys()
  }
}
