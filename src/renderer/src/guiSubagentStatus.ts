import type { GuiToolItem } from './guiToolPresentation'

export type GuiSubagentTone = 'running' | 'ok' | 'err' | 'denied' | 'cancel'

export interface GuiSubagentOutcomeLike {
  tone: Exclude<GuiSubagentTone, 'running'>
  statusLabel: string
}

export interface GuiSubagentStatusView {
  prompt: string
  currentActivity: string | null
  label: string
  tone: GuiSubagentTone
  toolCount: number
}

function currentChildActivity(children: readonly GuiToolItem[]): string | null {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]
    if (child.result) continue
    const summary = child.summary.trim()
    return summary ? `${child.name} / ${summary}` : child.name
  }
  return null
}

function countedTools(count: number): string {
  return `${count} ${count === 1 ? 'ferramenta' : 'ferramentas'}`
}

/** Texto da caixa deriva apenas do pai e dos filhos realmente ligados. */
export function guiSubagentStatusView(
  parent: GuiToolItem,
  children: readonly GuiToolItem[],
  outcome: GuiSubagentOutcomeLike | null
): GuiSubagentStatusView {
  const prompt = parent.summary.trim() || 'sem prompt informado'
  const toolCount = children.length
  if (parent.result && outcome) {
    return {
      prompt,
      currentActivity: null,
      label: `${outcome.statusLabel} (${countedTools(toolCount)})`,
      tone: outcome.tone,
      toolCount
    }
  }
  const currentActivity = currentChildActivity(children)
  return {
    prompt,
    currentActivity,
    label: currentActivity ? `agora: ${currentActivity}` : 'em andamento',
    tone: 'running',
    toolCount
  }
}
