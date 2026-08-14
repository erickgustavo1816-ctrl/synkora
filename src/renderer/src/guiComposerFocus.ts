/**
 * Um clique no papel passivo não move o foco DOM sozinho. Esse gesto sai do
 * composer; qualquer alvo que ainda pertence à superfície preserva o foco.
 */
export function shouldBlurGuiComposerOnOutsidePointerDown(
  surface: ParentNode | null,
  activeElement: Element | null,
  target: EventTarget | null
): boolean {
  if (!surface || !activeElement || !surface.contains(activeElement)) return false
  if (typeof target === 'object' && target !== null && 'nodeType' in target) {
    return !surface.contains(target as Node)
  }
  return true
}
