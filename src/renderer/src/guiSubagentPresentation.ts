import type { GuiItem } from './store'
import type { GuiToolItem } from './guiToolPresentation'

export interface GuiSubagentGroup {
  kind: 'subagent'
  id: string
  parent: GuiToolItem
  /** Filhos em ordem factual de chegada. Descendentes aninhados são achatados
   *  sob a raiz para nenhum card desaparecer sem uma árvore visual própria. */
  children: GuiToolItem[]
  at: number
}

export type GuiSubagentTranscriptItem = GuiItem | GuiSubagentGroup

/**
 * Projeção exclusivamente visual da linhagem explícita do Claude.
 *
 * - a lista crua e os objetos nela nunca são alterados;
 * - ids ausentes, órfãos, duplicados ou cíclicos não criam uma caixa;
 * - nomes de ferramentas não participam da decisão (Codex segue genérico);
 * - filhos de uma árvore válida são reunidos pela raiz, ainda que duas raízes
 *   tenham eventos intercalados no stream.
 */
export function nestGuiSubagentTools(
  items: readonly GuiItem[]
): GuiSubagentTranscriptItem[] {
  const byToolUseId = new Map<string, GuiToolItem | null>()
  const toolsByItemId = new Map<string, GuiToolItem>()

  for (const item of items) {
    if (item.kind !== 'tool') continue
    toolsByItemId.set(item.id, item)
    const toolUseId = item.toolUseId
    if (!toolUseId) continue
    byToolUseId.set(toolUseId, byToolUseId.has(toolUseId) ? null : item)
  }

  // Cada filho tem no máximo uma aresta. Um id de pai ambíguo é tratado como
  // inexistente: replay corrompido não pode sequestrar cards de outra tool.
  const parentByChildId = new Map<string, GuiToolItem>()
  for (const item of items) {
    if (item.kind !== 'tool' || !item.parentToolUseId) continue
    const parent = byToolUseId.get(item.parentToolUseId)
    if (!parent || parent.id === item.id) continue
    parentByChildId.set(item.id, parent)
  }

  const rootFor = (child: GuiToolItem): GuiToolItem | null => {
    const visited = new Set<string>()
    let cursor = child
    while (true) {
      if (visited.has(cursor.id)) return null
      visited.add(cursor.id)
      const parent = parentByChildId.get(cursor.id)
      if (!parent) {
        if (cursor.id === child.id || cursor.parentToolUseId) return null
        return cursor
      }
      cursor = parent
    }
  }

  const nestedChildIds = new Set<string>()
  const childrenByRootId = new Map<string, GuiToolItem[]>()
  for (const item of items) {
    if (item.kind !== 'tool' || !parentByChildId.has(item.id)) continue
    const root = rootFor(item)
    if (!root || !toolsByItemId.has(root.id)) continue
    nestedChildIds.add(item.id)
    const children = childrenByRootId.get(root.id) ?? []
    children.push(item)
    childrenByRootId.set(root.id, children)
  }

  const presented: GuiSubagentTranscriptItem[] = []
  for (const item of items) {
    if (item.kind === 'tool' && nestedChildIds.has(item.id)) continue
    if (item.kind === 'tool') {
      const children = childrenByRootId.get(item.id)
      if (children?.length) {
        presented.push({
          kind: 'subagent',
          id: `subagent:${item.id}`,
          parent: item,
          children,
          at: item.at
        })
        continue
      }
    }
    presented.push(item)
  }
  return presented
}
