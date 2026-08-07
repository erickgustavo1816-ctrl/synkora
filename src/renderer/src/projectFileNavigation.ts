import type { TerminalMarkdownTarget } from '../../preload/index'

const pending = new Map<string, TerminalMarkdownTarget>()
const listeners = new Map<string, Set<(target: TerminalMarkdownTarget) => void>>()

/** Guarda a navegação até a aba Arquivos montar. Isso é intencionalmente um
 * estado efêmero de interface: não deve sobreviver a reload nem ir ao disco. */
export function queueMarkdownOpen(projectId: string, target: TerminalMarkdownTarget): void {
  const group = listeners.get(projectId)
  if (group?.size) {
    pending.delete(projectId)
    for (const listener of group) listener(target)
    return
  }
  pending.set(projectId, target)
}

export function takeMarkdownOpen(projectId: string): TerminalMarkdownTarget | undefined {
  const target = pending.get(projectId)
  pending.delete(projectId)
  return target
}

export function onMarkdownOpen(
  projectId: string,
  listener: (target: TerminalMarkdownTarget) => void
): () => void {
  const group = listeners.get(projectId) ?? new Set()
  group.add(listener)
  listeners.set(projectId, group)
  return () => {
    group.delete(listener)
    if (!group.size) listeners.delete(projectId)
  }
}
