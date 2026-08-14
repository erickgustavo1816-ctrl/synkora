import type { GuiItem } from './store'
import type { GuiToolItem } from './guiToolPresentation'

/**
 * Metadados que o protocolo pode trazer no input da ferramenta de delegação.
 * Eles são uma projeção limitada: o input cru nunca é guardado no renderer.
 */
export interface GuiSubagentMetadata {
  name?: string
  type?: string
  model?: string
  prompt?: string
  description?: string
}

export type GuiSubagentSidebarTone = 'running' | 'completed' | 'failed' | 'denied' | 'cancelled'

export interface GuiSubagentSidebarEntry {
  id: string
  /** Identidade opaca do tool call; útil para distinguir concorrentes. */
  toolUseId: string
  name: string
  type: string | null
  model: string
  task: string
  activity: string | null
  status: GuiSubagentSidebarTone
  statusLabel: string
  outcome: string | null
  parent: GuiToolItem
  children: GuiToolItem[]
  at: number
}

const MAX_FIELD = 240

/** Ferramenta de uma thread filha. O reducer usa esta fronteira para guardar
 *  o evento sem assentar/dividir o stream da resposta principal. */
export function isGuiSubagentToolEvent(value: { parentToolUseId?: unknown }): boolean {
  return typeof value.parentToolUseId === 'string' && value.parentToolUseId.length > 0
}

function clean(value: unknown, max = MAX_FIELD): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/gu, ' ').trim()
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function stringField(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = clean(input[key])
    if (value) return value
  }
  return undefined
}

/**
 * Extrai somente chaves conhecidas do input real de Task/Agent. Não transforma
 * o modelo do pai em modelo do filho: se o protocolo não informar `model`, a
 * UI mostra explicitamente "modelo não informado".
 */
export function guiSubagentMetadataForTool(
  toolName: string,
  input: Record<string, unknown> | undefined
): GuiSubagentMetadata | undefined {
  if (!input) return undefined
  const name = stringField(input, 'name', 'agent_name', 'agentName')
  const type = stringField(input, 'subagent_type', 'subagentType', 'agent_type', 'agentType')
  const model = stringField(input, 'model')
  const prompt = stringField(input, 'prompt')
  const description = stringField(input, 'description')

  // A relação parentToolUseId continua sendo a autoridade. Este teste só
  // permite mostrar a ficha enquanto o primeiro filho ainda não chegou.
  const looksLikeDelegation =
    /^(task|agent|delegate|subagent|spawn(?:_?agent)?)$/iu.test(toolName.trim()) ||
    Boolean(type)
  if (!looksLikeDelegation) return undefined
  return {
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
    ...(model ? { model } : {}),
    ...(prompt ? { prompt } : {}),
    ...(description ? { description } : {})
  }
}

function isPotentialParent(item: GuiToolItem): boolean {
  return Boolean(
    item.toolUseId &&
      (item.subagent || /^(task|agent|delegate|subagent|spawn(?:_?agent)?)$/iu.test(item.name.trim()))
  )
}

function terminalTone(item: GuiToolItem): Exclude<GuiSubagentSidebarTone, 'running'> | null {
  const result = item.result
  if (!result) return null
  if (result.status === 'denied') return 'denied'
  if (result.status === 'cancelled') return 'cancelled'
  if (result.status === 'failed' || result.isError) return 'failed'
  return 'completed'
}

function statusLabel(status: GuiSubagentSidebarTone): string {
  switch (status) {
    case 'completed':
      return 'concluído'
    case 'failed':
      return 'falhou'
    case 'denied':
      return 'negado'
    case 'cancelled':
      return 'cancelado'
    default:
      return 'trabalhando'
  }
}

function activityFor(children: readonly GuiToolItem[], parent: GuiToolItem): string | null {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index]
    if (child.result) continue
    const summary = clean(child.summary)
    return summary ? `${child.name} · ${summary}` : child.name
  }
  if (!parent.result) return children.length > 0 ? 'finalizando' : 'aguardando a primeira atividade'
  return null
}

function taskFor(parent: GuiToolItem): string {
  const metadata = parent.subagent
  return (
    metadata?.prompt ??
    metadata?.description ??
    clean(parent.summary) ??
    'tarefa não informada'
  )
}

function childrenFor(
  parent: GuiToolItem,
  tools: readonly GuiToolItem[]
): GuiToolItem[] {
  const rootId = parent.toolUseId
  if (!rootId) return []
  const byParent = new Map<string, GuiToolItem[]>()
  for (const item of tools) {
    if (!item.parentToolUseId) continue
    const list = byParent.get(item.parentToolUseId) ?? []
    list.push(item)
    byParent.set(item.parentToolUseId, list)
  }
  const result: GuiToolItem[] = []
  const queue = [...(byParent.get(rootId) ?? [])]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const item = queue.shift() as GuiToolItem
    if (item.id === parent.id || seen.has(item.id)) continue
    seen.add(item.id)
    result.push(item)
    if (item.toolUseId) queue.push(...(byParent.get(item.toolUseId) ?? []))
  }
  return result.sort((a, b) => a.at - b.at)
}

/**
 * Normaliza eventos crus em fichas independentes. A ordem é a ordem factual
 * do tool call, portanto dois subagentes concorrentes não se sobrescrevem.
 */
export function normalizeGuiSubagentSidebar(
  items: readonly GuiItem[]
): GuiSubagentSidebarEntry[] {
  const tools = items.filter((item): item is GuiToolItem => item.kind === 'tool')
  const childParentIds = new Set(
    tools.map((item) => item.parentToolUseId).filter((value): value is string => Boolean(value))
  )
  const parents = tools.filter(
    (item) =>
      Boolean(item.toolUseId) &&
      (childParentIds.has(item.toolUseId ?? '') || isPotentialParent(item))
  )
  const seenParentIds = new Set<string>()

  return parents.filter((parent) => {
    const toolUseId = parent.toolUseId as string
    if (seenParentIds.has(toolUseId) || terminalTone(parent) !== null) return false
    seenParentIds.add(toolUseId)
    return true
  }).map((parent) => {
    const children = childrenFor(parent, tools)
    const status: GuiSubagentSidebarTone = 'running'
    const metadata = parent.subagent
    const type = metadata?.type ?? null
    const name = metadata?.name ?? type ?? 'subagente'
    return {
      id: `subagent-sidebar:${parent.toolUseId}`,
      toolUseId: parent.toolUseId as string,
      name,
      type,
      model: metadata?.model ?? 'modelo não informado',
      task: taskFor(parent),
      activity: activityFor(children, parent),
      status,
      statusLabel: statusLabel(status),
      outcome: null,
      parent,
      children,
      at: parent.at
    }
  })
}
