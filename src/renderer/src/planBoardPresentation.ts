import type {
  PlanDraft,
  PlanItemDraft,
  PlanItemStatus,
  PlanItemTier,
  PlanKind,
  PlanStatus
} from './planContract'
import type { MissionChatSummary } from './guiMissionPanes'

// LEITURA das superfícies de plano (aba do MAPA + card de proposta no chat).
//
// Módulo PURO: entra dado, sai o que a tela mostra. Nada de React, nada de
// `window` — é o que deixa a régua de progresso, a ordem das abas e o pulso da
// missão serem PROVADOS por teste em vez de conferidos no olho.
//
// Regra que atravessa o arquivo: nada aqui inventa estado. Progresso vem dos
// itens, pulso vem da missão real e da conversa dela; item sem missão é item
// sem missão, e a tela diz isso.

// ————— rótulos —————

const TIER_LABEL: Record<PlanItemTier, string> = {
  pequeno: 'pequeno',
  medio: 'médio',
  grande: 'grande'
}

export function planTierLabel(tier: PlanItemTier | undefined): string {
  return tier ? TIER_LABEL[tier] : ''
}

export const PLAN_STATUS_LABEL: Record<PlanStatus, string> = {
  ativo: 'em andamento',
  concluido: 'concluído',
  arquivado: 'arquivado'
}

export interface PlanItemPresentation {
  glyph: string
  label: string
  cls: PlanItemStatus
}

const ITEM_PRESENTATION: Record<PlanItemStatus, PlanItemPresentation> = {
  planejada: { glyph: '○', label: 'planejada', cls: 'planejada' },
  em_andamento: { glyph: '▶', label: 'em andamento', cls: 'em_andamento' },
  concluida: { glyph: '✔', label: 'concluída', cls: 'concluida' },
  descartada: { glyph: '✕', label: 'descartada', cls: 'descartada' }
}

export function planItemPresentation(status: PlanItemStatus): PlanItemPresentation {
  return ITEM_PRESENTATION[status] ?? ITEM_PRESENTATION.planejada
}

/**
 * O verbo EXCLUIR do dono (2026-08-17), irmão do "começar" que já existia:
 * "ou eu excluo ou eu faço". Ele só existe onde ainda há trabalho a tirar do
 * plano — concluída não se descarta (o trabalho aconteceu, e apagá-lo do
 * progresso seria reescrever a história) e descartada já saiu.
 *
 * A régua vive aqui porque é a MESMA que a trava de release aplica do outro
 * lado (`src/main/planReleaseLock.ts`): o que a tela deixa excluir é
 * exatamente o que pode estar segurando uma publicação.
 */
export function planItemCanDiscard(status: PlanItemStatus): boolean {
  return status === 'planejada' || status === 'em_andamento'
}

/** Uma linha útil, sem heading nem cauda — a mesma régua do tooltip do plano
 *  mestre: prosa longa cobrindo a tela é ruído, não contexto. */
export function planClipLine(text: string, max = 110): string {
  const line =
    text
      .split('\n')
      .map((part) => part.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// ————— o grafo de dependências (rodada 8) —————
//
// O motor já guardava `dependsOn` (ids de itens do MESMO plano) desde o começo,
// e a tela nunca mostrou. A ordem do dono fechou o circuito: uma TAG por
// dependência no card, o CHECK quando a dependida termina, e o verbo "começar"
// travado até todas terem check — é assim que ele enxerga, de relance, o que
// pode rodar EM PARALELO.

/** A dependência já resolvida em nome, número e estado — o que a tag mostra. */
export interface PlanItemDependency {
  id: string
  title: string
  /** o NÚMERO da missão na lista do quadro (1-based) — é ele que a tag exibe
   *  (ajuste do dono, rodada 8: tag compacta; o título inteiro vive na dica) */
  order: number
  status: PlanItemStatus
  /** ela não segura mais nada */
  satisfied: boolean
}

/** O mínimo que a régua lê de cada item do plano (o resto é irrelevante aqui). */
export interface PlanDependencySource {
  title: string
  /** posição 1-based na MESMA ordenação que o quadro exibe (o `pb-order`) */
  order: number
  /** o EFETIVO, o mesmo que a ficha mostra (vem da missão vinculada) */
  status: PlanItemStatus
}

/**
 * SATISFEITA = concluída OU DESCARTADA. A segunda metade é a mesma filosofia da
 * trava de release (`src/main/planReleaseLock.ts`): o que o dono descartou sai
 * de todas as contas. Sem ela a trava viraria beco sem saída — o dono excluiria
 * a dependência do plano e a missão dependente ficaria presa para sempre,
 * esperando por trabalho que ele já decidiu não fazer.
 */
function dependencySatisfied(status: PlanItemStatus): boolean {
  return status === 'concluida' || status === 'descartada'
}

/**
 * As dependências deste item, NA ORDEM em que ele as declarou — uma entrada por
 * dependência, sempre (1, 2 ou 10 tags para 1, 2 ou 10 dependências: esconder
 * atrás de um "+3" seria esconder justamente o que segura a missão).
 *
 * Id repetido é a MESMA dependência e aparece uma vez só; id que não existe
 * mais no plano (item apagado antes de o motor passar a filtrar) é ignorado em
 * silêncio — tag fantasma seria pior que dependência nenhuma, porque travaria o
 * botão por um item que o dono não consegue mais nem ver.
 */
export function planItemDependencies(
  item: { dependsOn?: readonly string[] },
  itemsById: ReadonlyMap<string, PlanDependencySource>
): PlanItemDependency[] {
  const out: PlanItemDependency[] = []
  const seen = new Set<string>()
  for (const id of item.dependsOn ?? []) {
    if (seen.has(id)) continue
    const target = itemsById.get(id)
    if (!target) continue
    seen.add(id)
    out.push({
      id,
      title: target.title.trim() || 'missão sem título',
      order: target.order,
      status: target.status,
      satisfied: dependencySatisfied(target.status)
    })
  }
  return out
}

/**
 * O verbo COMEÇAR, com a MESMA régua do excluir: os dois só existem onde ainda
 * há trabalho. O caso real que fechou o furo (rodada 8, Painel de Gestão):
 * itens concluídos POR FORA do Synkora não têm missão vinculada, e o quadro só
 * escondia o botão quando havia missão ou descarte — "criar missão" sobre
 * trabalho já feito é um verbo sem sentido.
 */
export function planItemCanStart(status: PlanItemStatus): boolean {
  return status === 'planejada' || status === 'em_andamento'
}

/**
 * A TRAVA do "começar": `null` quando o item está livre; senão os TÍTULOS do que
 * ainda falta. A lista é a explicação da trava — botão travado que não nomeia o
 * que está esperando é beco sem saída, e beco sem saída é bug.
 */
export function planItemStartBlock(
  item: { dependsOn?: readonly string[] },
  itemsById: ReadonlyMap<string, PlanDependencySource>
): string[] | null {
  const pending = planItemDependencies(item, itemsById)
    .filter((dependency) => !dependency.satisfied)
    .map((dependency) => dependency.title)
  return pending.length ? pending : null
}

// ————— progresso —————

export interface PlanProgress {
  done: number
  /** só o que ainda é trabalho: item descartado sai da conta */
  total: number
  discarded: number
  running: number
  percent: number
  label: string
}

export function planProgress(
  items: readonly { status: PlanItemStatus }[]
): PlanProgress {
  let done = 0
  let discarded = 0
  let running = 0
  for (const item of items) {
    if (item.status === 'descartada') discarded += 1
    else if (item.status === 'concluida') done += 1
    else if (item.status === 'em_andamento') running += 1
  }
  const total = items.length - discarded
  const percent = total > 0 ? Math.round((done / total) * 100) : 0
  const label =
    total === 0
      ? discarded > 0
        ? 'todas as missões foram descartadas'
        : 'nenhuma missão neste plano'
      : `${done}/${total} ${total === 1 ? 'missão concluída' : 'missões concluídas'}${
          discarded > 0 ? ` · ${discarded} descartada${discarded === 1 ? '' : 's'}` : ''
        }`
  return { done, total, discarded, running, percent, label }
}

// ————— pulso da missão vinculada —————

export interface PlanLinkedMission {
  id: string
  title: string
  status: 'ativa' | 'integrando' | 'concluida' | 'arquivada'
  pendingIntegrationApproval?: boolean
}

export type PlanMissionDot = 'ok' | 'busy' | 'ask' | 'err' | 'done'

export interface PlanMissionPulse {
  dot: PlanMissionDot
  label: string
  /** true = alguém tem que agir; a ficha pulsa em âmbar */
  waiting: boolean
}

/**
 * Mesma régua do quadro de rotas (MissionRouteBoard): o que EXIGE o dono vence
 * o que está apenas andando. A conversa entra pelo `chat` porque é ela que
 * está viva na era 2.0 — a missão direta não tem pane de execução nenhum.
 */
export function planMissionPulse(
  mission: PlanLinkedMission,
  chat: MissionChatSummary
): PlanMissionPulse {
  if (mission.pendingIntegrationApproval)
    return { dot: 'ask', label: 'esperando seu ⇪', waiting: true }
  if (chat.attention) return { dot: 'ask', label: 'esperando você', waiting: true }
  if (mission.status === 'concluida') return { dot: 'done', label: 'integrada', waiting: false }
  if (mission.status === 'arquivada') return { dot: 'ok', label: 'arquivada', waiting: false }
  if (mission.status === 'integrando')
    return { dot: 'busy', label: 'mesclando agora', waiting: false }
  if (chat.running > 0)
    return {
      dot: 'busy',
      label: chat.running > 1 ? `${chat.running} trabalhando` : 'trabalhando',
      waiting: false
    }
  if (chat.live > 0) return { dot: 'ok', label: 'conversa aberta', waiting: false }
  return { dot: 'ok', label: 'missão aberta', waiting: false }
}

export type PlanItemLink =
  | { kind: 'none' }
  | { kind: 'linked'; mission: PlanLinkedMission; pulse: PlanMissionPulse }
  /** o item aponta para uma missão que não existe mais (excluída na mão): o
   *  main reconcilia na leitura seguinte, e até lá a tela não finge progresso. */
  | { kind: 'missing' }

export function planItemLink(
  item: { missionId?: string; mission?: PlanLinkedMission },
  missions: ReadonlyMap<string, PlanLinkedMission>,
  chatOf: (missionId: string) => MissionChatSummary
): PlanItemLink {
  if (!item.missionId) return { kind: 'none' }
  // A missão VIVA do store vence a fotografia da leitura: ela muda a cada
  // evento, e é dela que o pulso precisa.
  const mission = missions.get(item.missionId) ?? item.mission
  if (!mission) return { kind: 'missing' }
  return { kind: 'linked', mission, pulse: planMissionPulse(mission, chatOf(mission.id)) }
}

// ————— abas do mapa (D4.5) —————

export interface PlanTabSource {
  id: string
  title: string
  kind: PlanKind
  status: PlanStatus
  order: number
}

export type MapTabKind = 'rotas' | 'plano'

export interface MapTab {
  /** id estável usado na persistência por projeto */
  id: string
  kind: MapTabKind
  label: string
  tip: string
  planId?: string
}

export const MAP_TAB_ROTAS: MapTab = {
  id: 'rotas',
  kind: 'rotas',
  label: 'rotas',
  tip: 'O quadro de rotas: uma linha por versão, uma coluna por etapa da missão'
}

/** Rótulo curto para caber na fila de abas sem cortar no meio da palavra. */
export function planTabLabel(plan: PlanTabSource, max = 22): string {
  const title = plan.title.trim() || 'plano sem título'
  return title.length > max ? `${title.slice(0, max - 1)}…` : title
}

/**
 * A fila de abas do MAPA: `rotas` é fixa e primeira; cada plano vivo vira uma
 * aba, o mestre na frente. Plano arquivado NÃO tem aba (ele volta pela lista
 * de arquivados, nunca ocupando espaço permanente na fila).
 *
 * Uma DIMENSÃO A MENOS desde o expurgo F6 (2026-08-17): a aba do roadmap por
 * ondas da era anterior morreu, e com ela o `hasLegacyPlan`. Universo sem
 * plano nenhum mostra o quadro de rotas SEM fila de abas.
 */
export function mapTabs(input: { plans: readonly PlanTabSource[] }): MapTab[] {
  const tabs: MapTab[] = [MAP_TAB_ROTAS]
  const visible = input.plans
    .filter((plan) => plan.status !== 'arquivado')
    .slice()
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'mestre' ? -1 : 1
      if (a.order !== b.order) return a.order - b.order
      return a.title.localeCompare(b.title, 'pt-BR')
    })
  for (const plan of visible) {
    tabs.push({
      id: `plano:${plan.id}`,
      kind: 'plano',
      label: planTabLabel(plan),
      tip:
        plan.status === 'concluido'
          ? `${plan.title} — plano concluído`
          : plan.kind === 'mestre'
            ? `${plan.title} — o plano mestre deste projeto`
            : plan.title,
      planId: plan.id
    })
  }
  return tabs
}

/** Aba lembrada que deixou de existir (plano excluído, roadmap sumiu) nunca
 *  prende a tela numa visão vazia: cai em `rotas`, que sempre existe. */
export function resolveMapTab(tabs: readonly MapTab[], wanted: string | undefined): MapTab {
  return tabs.find((tab) => tab.id === wanted) ?? tabs[0] ?? MAP_TAB_ROTAS
}

// ————— proposta no chat (D4.4) —————

/** Quantas missões o dono está aprovando — a frase que abre a lista do card. */
export function planDraftItemCountLabel(count: number): string {
  if (count <= 0) return 'sem missões descritas'
  return count === 1 ? '1 missão neste plano' : `${count} missões neste plano`
}

/**
 * `dependsOn` chega como CHAVE do rascunho; o dono precisa do TÍTULO. O que não
 * resolver volta como veio (é melhor mostrar a chave crua do que esconder uma
 * dependência que existe).
 */
export function planDraftDependencyLabels(
  draft: Pick<PlanDraft, 'items'>,
  item: PlanItemDraft
): string[] {
  const byKey = new Map<string, string>()
  draft.items.forEach((entry, index) => {
    const title = entry.title.trim()
    if (entry.id) byKey.set(entry.id, title)
    byKey.set(String(index + 1), title)
  })
  const out: string[] = []
  for (const dependency of item.dependsOn ?? []) {
    const key = dependency.trim()
    if (!key) continue
    const label = byKey.get(key) ?? key
    if (!out.includes(label)) out.push(label)
  }
  return out
}

/** Prefixo de missão que o modal recebe pré-preenchido: o brief em prosa mora
 *  no repo (`docPath`), então o goal aponta para lá em vez de copiá-lo. */
export function planItemMissionGoal(item: {
  objective: string
  outOfScope?: string
  doneCriteria: readonly string[]
  docPath?: string
  context?: string
}): string {
  const parts: string[] = []
  if (item.objective.trim()) parts.push(item.objective.trim())
  if (item.context?.trim()) parts.push(`Contexto: ${item.context.trim()}`)
  if (item.outOfScope?.trim()) parts.push(`Fora do escopo: ${item.outOfScope.trim()}`)
  if (item.doneCriteria.length)
    parts.push(`Pronto quando:\n${item.doneCriteria.map((c) => `- ${c}`).join('\n')}`)
  if (item.docPath?.trim()) parts.push(`Brief completo: ${item.docPath.trim()}`)
  return parts.join('\n\n')
}
