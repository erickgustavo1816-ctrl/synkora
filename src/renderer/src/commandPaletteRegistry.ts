import type { PaletteNavigationTarget } from '../../shared/commandPalette'

export interface CommandPaletteContext {
  projectId: string | null
}

export interface CommandPaletteAction {
  /** Namespace recomendado: `painel.comando`. */
  id: string
  title: string
  detail?: string
  keywords?: readonly string[]
  when?: (context: CommandPaletteContext) => boolean
  target?: PaletteNavigationTarget | ((context: CommandPaletteContext) => PaletteNavigationTarget)
  run?: (context: CommandPaletteContext) => void | Promise<void>
}

const ACTION_ID_RE = /^[a-z0-9][a-z0-9._:-]{1,127}$/u
const actions = new Map<string, CommandPaletteAction>()
const listeners = new Set<() => void>()
let snapshot: readonly CommandPaletteAction[] = []

function publish(): void {
  snapshot = [...actions.values()].sort((a, b) => a.title.localeCompare(b.title, 'pt-BR'))
  for (const listener of listeners) listener()
}

/**
 * Registro aberto para qualquer painel. O unsubscribe só remove a mesma
 * instância, então uma montagem antiga nunca apaga a ação mais nova do HMR.
 */
export function registerCommandPaletteAction(action: CommandPaletteAction): () => void {
  if (!ACTION_ID_RE.test(action.id) || !action.title.trim()) {
    throw new Error('ação da paleta sem id/título válido')
  }
  actions.set(action.id, action)
  publish()
  return () => {
    if (actions.get(action.id) !== action) return
    actions.delete(action.id)
    publish()
  }
}

export function commandPaletteActions(): readonly CommandPaletteAction[] {
  return snapshot
}

export function subscribeCommandPaletteActions(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
