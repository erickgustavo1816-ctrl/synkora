import type { GuiItem } from './store'

export type GuiToolItem = Extract<GuiItem, { kind: 'tool' }>

export interface GuiToolGroup {
  kind: 'tool-group'
  id: string
  name: string
  items: GuiToolItem[]
  at: number
}

/** Marcador de apresentação para um item deliberadamente oculto. */
export interface GuiInvisibleItem {
  kind: 'invisible'
  id: string
}

export type GuiRenderItem = GuiItem | GuiToolGroup
export type GuiPresentationItem = GuiItem | GuiInvisibleItem

const INTERACTIVE_TOOLS = new Set(['askuserquestion', 'exitplanmode', 'exit_plan_mode'])

export function isGuiInteractiveTool(name: string): boolean {
  return INTERACTIVE_TOOLS.has(name.toLowerCase())
}

/** Família de comando por TOKEN, sem confundir `run` com pedaços de outro nome. */
export function isGuiShellTool(name: string): boolean {
  const words = name
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/u)
    .filter(Boolean)
  return words.some((word) => ['bash', 'shell', 'exec', 'command', 'run'].includes(word))
}

/** Contagem do output INTEIRO: newline terminal não inventa uma linha vazia. */
export function countGuiOutputLines(text: string): number {
  const clean = text.replace(/[\s\r\n]+$/u, '')
  return clean ? clean.split(/\r\n|\r|\n/u).length : 0
}

export function guiToolActivityText(name: string, rawSummary: string): string {
  const summary = rawSummary.trim()
  return summary ? `${name} · ${summary}` : name
}

/** Último trabalho ainda sem desfecho; resultados fora de ordem não apagam
 *  o status factual de outra ferramenta concorrente. */
export function lastPendingGuiToolActivity(items: readonly GuiItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind === 'tool' && !item.result) return guiToolActivityText(item.name, item.summary)
  }
  return null
}

/**
 * Pareamento autoritativo por id. O fallback só existe para replays antigos,
 * anteriores ao campo toolUseId; um id desconhecido nunca fecha outro card.
 */
export function guiToolResultTargetIndex(
  items: readonly GuiItem[],
  toolUseId?: string
): number {
  if (!toolUseId) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index]
      if (
        item.kind === 'tool' &&
        (!item.result || item.result.provisional === true)
      )
        return index
    }
    return -1
  }

  let exact = -1
  let seen = false
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== 'tool' || item.toolUseId !== toolUseId) continue
    // Um id opaco deveria ser único. Replay corrompido/hostil não escolhe um
    // alvo arbitrário: sem unicidade, nenhum card recebe o resultado.
    if (seen) return -1
    seen = true
    // Um `result` terminal pode ter fechado o card antes do `tool-result`
    // correspondente (principalmente em ferramentas filhas). Esse desfecho
    // provisório ainda não é autoritativo e pode ser substituído pelo ID.
    if (!item.result || item.result.provisional === true) exact = index
  }
  return exact
}

/** A permissão não carrega toolUseId em todos os CLIs. Como só o pedido mais
 * recente está visível no card, negar fecha a última tool ainda pendente. */
function permissionMatchesTool(toolName: string, requestedName: string): boolean {
  const tool = toolName.trim().toLowerCase()
  const requested = requestedName.trim().toLowerCase()
  if (!requested) return true
  if (tool === requested || requested.includes(tool) || tool.includes(requested)) return true
  if (/(comando|command|shell|bash)/u.test(requested)) return isGuiShellTool(toolName)
  if (/(arquivo|file|edit|patch|write)/u.test(requested))
    return ['edit', 'write', 'applypatch', 'patch'].includes(tool)
  return false
}

export function denyLatestPendingGuiTool(
  items: GuiItem[],
  requestedName = '',
  toolUseId?: string
): GuiItem[] {
  if (toolUseId) {
    const exact = guiToolResultTargetIndex(items, toolUseId)
    if (exact < 0) return items
    const item = items[exact]
    if (item.kind !== 'tool' || item.result) return items
    const next = [...items]
    next[exact] = {
      ...item,
      result: {
        text: '',
        isError: false,
        status: 'denied',
        lineCount: 0,
        truncated: false
      }
    }
    return next
  }
  let fallback = -1
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== 'tool' || item.result) continue
    if (fallback < 0) fallback = index
    if (!permissionMatchesTool(item.name, requestedName)) continue
    fallback = index
    break
  }
  if (fallback >= 0) {
    const item = items[fallback]
    if (item.kind !== 'tool' || item.result) return items
    const next = [...items]
    next[fallback] = {
      ...item,
      result: {
        text: '',
        isError: false,
        status: 'denied',
        lineCount: 0,
        truncated: false
      }
    }
    return next
  }
  return items
}

/**
 * Agrupamento SOMENTE de apresentação. A lista crua não é tocada; qualquer
 * item visível que não seja a mesma ferramenta encerra a sequência.
 */
export function groupConsecutiveGuiTools(items: readonly GuiPresentationItem[]): GuiRenderItem[] {
  const rendered: GuiRenderItem[] = []
  let pending: GuiToolItem[] = []

  const flush = (): void => {
    if (pending.length === 1) rendered.push(pending[0])
    else if (pending.length > 1) {
      rendered.push({
        kind: 'tool-group',
        id: `tool-group:${pending[0].id}:${pending[pending.length - 1].id}`,
        name: pending[0].name,
        items: pending,
        at: pending[0].at
      })
    }
    pending = []
  }

  for (const item of items) {
    // Raciocínio oculto não é uma interrupção visual da sequência.
    if (item.kind === 'invisible') continue
    const canGroup = item.kind === 'tool' && !isGuiInteractiveTool(item.name)
    const continues =
      canGroup &&
      (pending.length === 0 || pending[0].name.toLowerCase() === item.name.toLowerCase())
    if (continues && item.kind === 'tool') {
      pending.push(item)
      continue
    }
    flush()
    if (canGroup && item.kind === 'tool') pending.push(item)
    else rendered.push(item)
  }
  flush()

  return rendered
}

function compactToolPreview(item: GuiToolItem): string {
  const summary = item.summary.trim()
  if (!summary || !/(read|write|edit|patch|file|notebook)/iu.test(item.name)) return summary
  const path = summary.split(/[\\/]+/u).filter(Boolean)
  return path[path.length - 1] ?? summary
}

export function guiToolGroupPreview(group: GuiToolGroup): string {
  const previews = group.items
    .map(compactToolPreview)
    .filter(Boolean)
    .slice(0, 2)
  const extra = group.items.length - previews.length
  const prefix = previews.join(', ')
  if (!prefix) return extra > 0 ? `+${extra}` : ''
  return extra > 0 ? `${prefix}, +${extra}` : prefix
}
