/**
 * Versão por missão para respostas assíncronas de guiSpec. Trocar o seat
 * invalida tudo que foi pedido com a conta anterior, mesmo que a Promise só
 * termine depois da troca.
 */
export class GuiRequestEpoch {
  private readonly versions = new Map<string, number>()

  capture(key: string): number {
    return this.versions.get(key) ?? 0
  }

  invalidate(key: string): number {
    const next = this.capture(key) + 1
    this.versions.set(key, next)
    return next
  }

  isCurrent(key: string, captured: number): boolean {
    return this.capture(key) === captured
  }
}

/**
 * Descarta os slots de uma missão e SEMPRE devolve uma referência nova. Isso
 * também acorda o efeito que abre a primeira conversa, quando ainda não havia
 * uma chave para remover do mapa.
 */
export function withoutMissionGuiSlots<T>(
  slots: Readonly<Record<string, T[]>>,
  missionId: string
): Record<string, T[]> {
  const next = { ...slots }
  delete next[missionId]
  return next
}
