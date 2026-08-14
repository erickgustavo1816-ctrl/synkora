import type { GuiItem } from './store'

export const GUI_DIFF_HISTORY_MAX_CHARS = 768 * 1024
export const GUI_DIFF_HISTORY_MAX_ITEMS = 12

function sourceSize(item: Extract<GuiItem, { kind: 'tool' }>): number {
  return (item.fileDiffs ?? []).reduce(
    (total, source) =>
      total +
      (source.format === 'unified'
        ? source.patch.length
        : (source.oldText?.length ?? 0) + source.newText.length),
    0
  )
}

/** Mantém os diffs recentes dentro de um orçamento POR PANE. Cards antigos
 * continuam no fio com nome/resumo/desfecho, apenas sem o payload expandível. */
export function pruneGuiDiffHistory(items: GuiItem[]): GuiItem[] {
  let chars = 0
  let diffItems = 0
  let changed = false
  const next = [...items]
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const item = next[index]
    if (item.kind !== 'tool' || !item.fileDiffs?.length) continue
    const size = sourceSize(item)
    const keep =
      diffItems < GUI_DIFF_HISTORY_MAX_ITEMS &&
      (chars + size <= GUI_DIFF_HISTORY_MAX_CHARS || diffItems === 0)
    if (keep) {
      chars += size
      diffItems += 1
      continue
    }
    changed = true
    const { fileDiffs: _discarded, ...summaryOnly } = item
    next[index] = summaryOnly
  }
  return changed ? next : items
}
