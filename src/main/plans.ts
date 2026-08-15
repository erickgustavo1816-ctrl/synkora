/**
 * PLANOS DO UNIVERSO (Synkora 2.0, onda D — o MAPA vira menu de planejamento).
 *
 * Terceiro — e ÚLTIMO — significado da palavra "plano" no repo, e o único com
 * nome próprio para não virar ambiguidade fatal:
 *
 * - `projectPlan.ts`  → PROJECT_PLAN.json, o roadmap por ondas da era F6.
 *   Mora no REPO do produto e só o PM TUI legado escreve. INTOCADO.
 * - `TaskPlan` (tasks.ts, `create_plan`) → o card de plano de uma missão
 *   legada, com lanes por departamento. INTOCADO.
 * - `Plan` (aqui)     → o plano do DONO na era 2.0: uma lista ordenada de
 *   missões futuras, nascida numa CONVERSA e aprovada por clique. Mora em
 *   `userData/plans.json` — fora do repo, então não suja worktree nenhum nem
 *   invalida veredito de gate legado.
 *
 * REGRAS QUE VALEM COMO CONTRATO:
 * - PROPOSTA NÃO ENTRA NO STORE. O rascunho (planDraft.ts) vive no card do
 *   chat; o Plan só nasce, já 'ativo', no clique de aprovação do dono.
 * - `kind` e `origin` são CARIMBO DE NASCIMENTO (padrão `Mission.direct`):
 *   fora de todo patch, então plano nenhum troca de natureza depois.
 * - PROGRESSO É DERIVADO, NUNCA PERSISTIDO: item vinculado a uma missão lê o
 *   estado da missão em `planView`. O que o disco guarda é a INTENÇÃO.
 * - `missionId` só entra por `linkMission` (gesto do dono no mapa). Nenhum
 *   patch — de agente ou de UI — o escreve.
 *
 * Módulo com uma única dependência de Electron (o caminho padrão do arquivo,
 * avaliado só quando o construtor é chamado sem argumento): é o que deixa a
 * suíte `test:plans` rodar em node puro, como a do backlog.
 */
import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { loadJsonStore, persistJsonStore } from './jsonStore'
import { redactSensitiveStrings } from './securityRedaction'
import {
  PLAN_DESCRIPTION_MAX,
  PLAN_DOC_PATH_MAX,
  PLAN_DONE_CRITERIA_MAX,
  PLAN_DONE_CRITERIA_MAX_COUNT,
  PLAN_ITEM_DEPENDS_MAX,
  PLAN_ITEM_MAX_COUNT,
  PLAN_ITEM_OBJECTIVE_MAX,
  PLAN_ITEM_TEXT_MAX,
  PLAN_ITEM_TIERS,
  PLAN_ITEM_TITLE_MAX,
  PLAN_TITLE_MAX,
  planDocPathProblem,
  type PlanDraft,
  type PlanDraftItem,
  type PlanItemTier,
  type PlanKind
} from './planDraft'

export type { PlanDraft, PlanDraftItem, PlanItemTier, PlanKind }

export type PlanStatus = 'ativo' | 'concluido' | 'arquivado'

export const PLAN_STATUSES: readonly PlanStatus[] = ['ativo', 'concluido', 'arquivado']

/** A INTENÇÃO gravada. O estado real de um item vinculado é derivado da
 *  missão em `planView` — ver PlanItemView.status. */
export type PlanItemStatus = 'planejada' | 'em_andamento' | 'concluida' | 'descartada'

export const PLAN_ITEM_STATUSES: readonly PlanItemStatus[] = [
  'planejada',
  'em_andamento',
  'concluida',
  'descartada'
]

/** O que o agente PODE escrever: 'concluida' é derivada da missão. */
export const PLAN_ITEM_AUTHORED_STATUSES: readonly PlanItemStatus[] = [
  'planejada',
  'em_andamento',
  'descartada'
]

export interface PlanItem {
  id: string
  title: string
  /** espelha a seção "Objetivo" do PLANNING_CONTRACT */
  objective: string
  /** espelha "Fora de escopo" */
  outOfScope?: string
  /** espelha "Critério de pronto" — binário e observável */
  doneCriteria: string[]
  /** espelha "Tier" */
  tier?: PlanItemTier
  /** espelha "Contexto" */
  context?: string
  /** ids de outros PlanItem DESTE plano */
  dependsOn: string[]
  order: number
  status: PlanItemStatus
  /** Missão real criada a partir deste item. Escrito SÓ por `linkMission`. */
  missionId?: string
  /** brief em prosa no repo do produto (ex.: 'plano/003-fila.md') */
  docPath?: string
  /** Anotação da autocura — some no primeiro toque humano/agente no item. */
  note?: string
  createdAt: string
  updatedAt: string
}

/** De onde o plano veio. Carimbo de nascimento: nunca muda. */
export type PlanOrigin =
  | { paneId: string; missionId?: string; proposedAt: string }
  | { manual: true }

export interface Plan {
  id: string
  projectId: string
  title: string
  description?: string
  kind: PlanKind
  status: PlanStatus
  origin: PlanOrigin
  items: PlanItem[]
  order: number
  createdAt: string
  updatedAt: string
  approvedAt?: string
  archivedAt?: string
}

// ————— patch (edição direta, sem passar pelo dono) —————

export interface PlanItemPatch {
  id: string
  title?: string
  objective?: string
  outOfScope?: string | null
  doneCriteria?: string[]
  tier?: PlanItemTier | null
  context?: string | null
  dependsOn?: string[]
  docPath?: string | null
  /** 'concluida' NÃO entra: é derivada da missão vinculada. */
  status?: 'planejada' | 'em_andamento' | 'descartada'
}

export interface PlanPatch {
  title?: string
  description?: string | null
  status?: PlanStatus
  order?: number
  /** merge por id — item desconhecido é recusado, nunca criado em silêncio */
  items?: PlanItemPatch[]
  /** entram no FIM da lista; `dependsOn` aceita `key` de item novo ou id de item existente */
  addItems?: PlanDraftItem[]
  /** item com missão vinculada nunca some: use status 'descartada' */
  removeItemIds?: string[]
}

// ————— visão (o que o renderer recebe: intenção + progresso derivado) —————

export type PlanMissionStatus = 'ativa' | 'integrando' | 'concluida' | 'arquivada'

export interface PlanMissionSnapshot {
  id: string
  title: string
  status: PlanMissionStatus
}

export interface PlanItemView extends PlanItem {
  /**
   * Estado EFETIVO: com missão viva vale a missão, e o disco continua guardando
   * só a intenção. 'descartada' vence tudo (o dono tirou o item do plano).
   */
  status: PlanItemStatus
  /** o que está gravado no disco — o card mostra o efetivo, o editor o autoral */
  authoredStatus: PlanItemStatus
  /** ausente = item sem missão OU missão que não existe mais (já reconciliado) */
  mission?: PlanMissionSnapshot
}

export interface PlanView extends Plan {
  items: PlanItemView[]
  /** derivado: itens 'descartada' não contam em lado nenhum da fração */
  progress: { done: number; total: number }
}

/**
 * Estado efetivo de um item. A missão é a fonte quando existe:
 * concluída ⇒ concluída; viva/integrando ⇒ em andamento; ARQUIVADA preserva o
 * estado autoral (missão engavetada não desfaz nem completa trabalho).
 */
export function effectivePlanItemStatus(
  item: PlanItem,
  mission: PlanMissionSnapshot | undefined
): PlanItemStatus {
  if (item.status === 'descartada') return 'descartada'
  if (!mission || mission.status === 'arquivada') return item.status
  if (mission.status === 'concluida') return 'concluida'
  return 'em_andamento'
}

export function planView(plan: Plan, missions: readonly PlanMissionSnapshot[]): PlanView {
  const byId = new Map(missions.map((mission) => [mission.id, mission]))
  const items = plan.items.map((item): PlanItemView => {
    const mission = item.missionId ? byId.get(item.missionId) : undefined
    return {
      ...item,
      status: effectivePlanItemStatus(item, mission),
      authoredStatus: item.status,
      ...(mission ? { mission } : {})
    }
  })
  const counted = items.filter((item) => item.status !== 'descartada')
  return {
    ...plan,
    items,
    progress: {
      done: counted.filter((item) => item.status === 'concluida').length,
      total: counted.length
    }
  }
}

// ————— autocura —————

export const PLAN_ITEM_DETACHED_NOTE =
  'a missão vinculada não existe mais — este item voltou para planejada'

export interface PlanReconciliation {
  changed: boolean
  detached: { planId: string; itemId: string; missionId: string }[]
}

// ————— erros de UI (texto único; o teste lê a MESMA string) —————

export const PLAN_STALE_ERROR =
  'o plano mudou enquanto estava aberto. Recarreguei a fotografia; revise a versão atual antes de salvar.'
export const PLAN_NOT_FOUND_ERROR = 'plano não encontrado'
export const PLAN_MASTER_TAKEN_ERROR =
  'este universo já tem um plano mestre ativo — conclua ou arquive o atual antes de criar outro'

export type PlanMutation = { ok: true; plan: Plan } | { ok: false; error: string }
export type PlanRemoval = { ok: true } | { ok: false; error: string }

/** Relógio ESTRITAMENTE monotônico do store. O CAS compara `updatedAt` por
 *  igualdade: duas mutações dentro do MESMO milissegundo deixariam a segunda
 *  invisível para a fotografia do chamador (o teste de CAS pegou isso ao
 *  vivo numa máquina quente). Empurrar 1ms além do último carimbo fecha o
 *  buraco sem mudar o formato. */
let lastStampMs = 0
function nowIso(): string {
  const ms = Math.max(Date.now(), lastStampMs + 1)
  lastStampMs = ms
  return new Date(ms).toISOString()
}

function boundedText(value: unknown, cap: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, Math.max(0, cap - 1))}…`
}

export class PlanStore {
  private readonly file: string
  private plans: Plan[] = []

  constructor(file = join(app.getPath('userData'), 'plans.json')) {
    this.file = file
    this.plans = loadJsonStore(
      this.file,
      () => [],
      (value): value is Plan[] =>
        Array.isArray(value) &&
        value.every((plan) => {
          const candidate = plan as Partial<Plan> | null
          return Boolean(
            candidate &&
              typeof candidate === 'object' &&
              typeof candidate.id === 'string' &&
              typeof candidate.projectId === 'string' &&
              typeof candidate.title === 'string' &&
              Array.isArray(candidate.items)
          )
        })
    )
  }

  /** O arquivo pousa antes de a fotografia viva mudar. */
  private commit(next: Plan[]): void {
    persistJsonStore(this.file, next)
    this.plans = next
  }

  /** Ordem de exibição: mestre primeiro, depois `order`, e o id desempata. */
  list(projectId: string): Plan[] {
    return this.plans
      .filter((plan) => plan.projectId === projectId)
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'mestre' ? -1 : 1
        if (a.order !== b.order) return a.order - b.order
        return a.id.localeCompare(b.id)
      })
  }

  get(id: string): Plan | undefined {
    return this.plans.find((plan) => plan.id === id)
  }

  create(projectId: string, draft: PlanDraft, origin: PlanOrigin): PlanMutation {
    if (draft.kind === 'mestre') {
      const taken = this.plans.some(
        (plan) => plan.projectId === projectId && plan.kind === 'mestre' && plan.status === 'ativo'
      )
      if (taken) return { ok: false, error: PLAN_MASTER_TAKEN_ERROR }
    }
    const now = nowIso()
    const highest = this.plans
      .filter((plan) => plan.projectId === projectId)
      .reduce((max, plan) => Math.max(max, plan.order), -1)
    const keyToId = new Map<string, string>()
    const items = draft.items.map((item, index): PlanItem => {
      const id = randomUUID()
      keyToId.set(item.key, id)
      return {
        id,
        title: item.title,
        objective: item.objective,
        ...(item.outOfScope ? { outOfScope: item.outOfScope } : {}),
        doneCriteria: [...item.doneCriteria],
        ...(item.tier ? { tier: item.tier } : {}),
        ...(item.context ? { context: item.context } : {}),
        // As `key`s do rascunho viram os ids reais aqui — e só aqui.
        dependsOn: item.dependsOn
          .map((key) => keyToId.get(key))
          .filter((value): value is string => typeof value === 'string'),
        order: index,
        status: 'planejada',
        ...(item.docPath ? { docPath: item.docPath } : {}),
        createdAt: now,
        updatedAt: now
      }
    })
    const plan: Plan = {
      id: randomUUID(),
      projectId,
      title: draft.title,
      ...(draft.description ? { description: draft.description } : {}),
      kind: draft.kind,
      status: 'ativo',
      origin,
      items,
      order: highest + 1,
      createdAt: now,
      updatedAt: now,
      // O plano só existe porque o dono clicou: o carimbo é o clique.
      approvedAt: now
    }
    this.commit([...this.plans, plan])
    return { ok: true, plan }
  }

  /**
   * CAS por `updatedAt` (padrão ipc/projectPlan.ts): a fotografia que o
   * chamador leu tem de ser a que ele grava por cima. `expectedUpdatedAt`
   * ausente = chamador sem fotografia (só o caminho interno do harness).
   */
  update(id: string, patch: PlanPatch, expectedUpdatedAt?: string): PlanMutation {
    return this.mutate(id, expectedUpdatedAt, (current) => applyPatch(current, patch))
  }

  archive(id: string, expectedUpdatedAt?: string): PlanMutation {
    return this.mutate(id, expectedUpdatedAt, (current) =>
      current.status === 'arquivado'
        ? { ok: true, plan: current }
        : { ok: true, plan: { ...current, status: 'arquivado', archivedAt: nowIso() } }
    )
  }

  /** Vínculo item → missão real. ÚNICO caminho que escreve `missionId`. */
  linkMission(
    id: string,
    itemId: string,
    missionId: string,
    expectedUpdatedAt?: string
  ): PlanMutation {
    return this.mutate(id, expectedUpdatedAt, (current) => {
      const index = current.items.findIndex((item) => item.id === itemId)
      if (index < 0) return { ok: false, error: 'este item não existe mais neste plano' }
      const taken = current.items.find(
        (item) => item.missionId === missionId && item.id !== itemId
      )
      if (taken) {
        return { ok: false, error: `esta missão já está vinculada a "${taken.title}"` }
      }
      const items = [...current.items]
      const item = items[index]
      items[index] = {
        ...item,
        missionId,
        // A missão em pé já conta o progresso; o estado autoral sai de
        // 'planejada' para o mapa não regredir se a missão for arquivada.
        status: item.status === 'planejada' ? 'em_andamento' : item.status,
        note: undefined,
        updatedAt: nowIso()
      }
      return { ok: true, plan: { ...current, items } }
    })
  }

  /** Exclusão DURA — só o gesto do dono no mapa chega aqui. */
  remove(id: string, expectedUpdatedAt?: string): PlanRemoval {
    const current = this.get(id)
    if (!current) return { ok: false, error: PLAN_NOT_FOUND_ERROR }
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
      return { ok: false, error: PLAN_STALE_ERROR }
    }
    this.commit(this.plans.filter((plan) => plan.id !== id))
    return { ok: true }
  }

  /** Projeto excluído leva os planos dele junto. */
  removeProject(projectId: string): void {
    const next = this.plans.filter((plan) => plan.projectId !== projectId)
    if (next.length !== this.plans.length) this.commit(next)
  }

  /**
   * AUTOCURA (padrão do fantasma da fila, b94fbf2): missão excluída não deixa
   * progresso fantasma no mapa. Roda na LEITURA — o mapa nunca mostra um
   * vínculo que o MissionStore já não reconhece.
   */
  reconcile(projectId: string, knownMissionIds: ReadonlySet<string>): PlanReconciliation {
    const detached: PlanReconciliation['detached'] = []
    const now = nowIso()
    let changed = false
    const next = this.plans.map((plan) => {
      if (plan.projectId !== projectId) return plan
      let planChanged = false
      const items = plan.items.map((item) => {
        if (!item.missionId || knownMissionIds.has(item.missionId)) return item
        detached.push({ planId: plan.id, itemId: item.id, missionId: item.missionId })
        planChanged = true
        return {
          ...item,
          missionId: undefined,
          status: 'planejada' as const,
          note: PLAN_ITEM_DETACHED_NOTE,
          updatedAt: now
        }
      })
      if (!planChanged) return plan
      changed = true
      return { ...plan, items, updatedAt: now }
    })
    if (changed) this.commit(next)
    return { changed, detached }
  }

  private mutate(
    id: string,
    expectedUpdatedAt: string | undefined,
    apply: (current: Plan) => PlanMutation
  ): PlanMutation {
    const index = this.plans.findIndex((plan) => plan.id === id)
    if (index < 0) return { ok: false, error: PLAN_NOT_FOUND_ERROR }
    const current = this.plans[index]
    if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
      return { ok: false, error: PLAN_STALE_ERROR }
    }
    const applied = apply(current)
    if (!applied.ok) return applied
    if (applied.plan === current) return { ok: true, plan: current }
    const plan: Plan = { ...applied.plan, updatedAt: nowIso() }
    const next = [...this.plans]
    next[index] = plan
    this.commit(next)
    return { ok: true, plan }
  }
}

// ————— aplicação de patch (pura: o store só decide onde ela pousa) —————

function applyPatch(current: Plan, rawPatch: PlanPatch): PlanMutation {
  const patch = redactSensitiveStrings(rawPatch)
  let items = [...current.items]

  if (patch.removeItemIds?.length) {
    for (const itemId of patch.removeItemIds) {
      const target = items.find((item) => item.id === itemId)
      if (!target) return { ok: false, error: 'este item não existe mais neste plano' }
      if (target.missionId) {
        return {
          ok: false,
          error: `"${target.title}" já virou missão — marque como descartada em vez de excluir`
        }
      }
    }
    const removed = new Set(patch.removeItemIds)
    items = items
      .filter((item) => !removed.has(item.id))
      .map((item) => ({
        ...item,
        dependsOn: item.dependsOn.filter((dependency) => !removed.has(dependency))
      }))
  }

  if (patch.items?.length) {
    const now = nowIso()
    for (const itemPatch of patch.items) {
      const index = items.findIndex((item) => item.id === itemPatch.id)
      if (index < 0) return { ok: false, error: 'este item não existe mais neste plano' }
      const applied = applyItemPatch(items[index], itemPatch, items, now)
      if (!applied.ok) return { ok: false, error: applied.error }
      items[index] = applied.item
    }
  }

  if (patch.addItems?.length) {
    if (items.length + patch.addItems.length > PLAN_ITEM_MAX_COUNT) {
      return {
        ok: false,
        error: `o plano ficaria com missões demais (máximo ${PLAN_ITEM_MAX_COUNT})`
      }
    }
    const now = nowIso()
    const keyToId = new Map<string, string>()
    let order = items.reduce((max, item) => Math.max(max, item.order), -1)
    for (const draftItem of patch.addItems) {
      const title = boundedText(draftItem.title, PLAN_ITEM_TITLE_MAX)
      const objective = boundedText(draftItem.objective, PLAN_ITEM_OBJECTIVE_MAX)
      if (!title || !objective) {
        return { ok: false, error: 'missão nova sem título ou sem objetivo' }
      }
      const docPath = boundedText(draftItem.docPath, PLAN_DOC_PATH_MAX)
      if (docPath) {
        const problem = planDocPathProblem(docPath)
        if (problem) return { ok: false, error: `${problem} (missão "${title}")` }
      }
      const id = randomUUID()
      keyToId.set(draftItem.key, id)
      order += 1
      const existing = items
      // Depende de item novo (pela key) OU de item que já estava no plano
      // (pelo id) — nada além disso vira aresta.
      const dependsOn = draftItem.dependsOn
        .slice(0, PLAN_ITEM_DEPENDS_MAX)
        .map((key) => keyToId.get(key) ?? existing.find((item) => item.id === key)?.id)
        .filter((value): value is string => typeof value === 'string')
      const outOfScope = boundedText(draftItem.outOfScope, PLAN_ITEM_TEXT_MAX)
      const context = boundedText(draftItem.context, PLAN_ITEM_TEXT_MAX)
      items = [
        ...items,
        {
          id,
          title,
          objective,
          ...(outOfScope ? { outOfScope } : {}),
          doneCriteria: draftItem.doneCriteria
            .slice(0, PLAN_DONE_CRITERIA_MAX_COUNT)
            .map((criterion) => criterion.slice(0, PLAN_DONE_CRITERIA_MAX)),
          ...(draftItem.tier && PLAN_ITEM_TIERS.includes(draftItem.tier)
            ? { tier: draftItem.tier }
            : {}),
          ...(context ? { context } : {}),
          dependsOn,
          order,
          status: 'planejada',
          ...(docPath ? { docPath } : {}),
          createdAt: now,
          updatedAt: now
        }
      ]
    }
  }

  const title = patch.title === undefined ? current.title : boundedText(patch.title, PLAN_TITLE_MAX)
  if (!title) return { ok: false, error: 'o plano precisa de um título' }
  if (patch.status !== undefined && !PLAN_STATUSES.includes(patch.status)) {
    return { ok: false, error: 'estado de plano desconhecido' }
  }
  const status = patch.status ?? current.status
  const description =
    patch.description === undefined
      ? current.description
      : patch.description === null
        ? undefined
        : boundedText(patch.description, PLAN_DESCRIPTION_MAX)

  return {
    ok: true,
    plan: {
      ...current,
      title,
      description,
      status,
      ...(patch.order !== undefined && Number.isSafeInteger(patch.order)
        ? { order: patch.order }
        : {}),
      items,
      // Arquivar por patch carimba a data; desarquivar a apaga.
      archivedAt: status === 'arquivado' ? (current.archivedAt ?? nowIso()) : undefined
    }
  }
}

type ItemPatchResult = { ok: true; item: PlanItem } | { ok: false; error: string }

function applyItemPatch(
  current: PlanItem,
  patch: PlanItemPatch,
  siblings: readonly PlanItem[],
  now: string
): ItemPatchResult {
  const title =
    patch.title === undefined ? current.title : boundedText(patch.title, PLAN_ITEM_TITLE_MAX)
  if (!title) return { ok: false, error: 'a missão do plano precisa de um título' }
  const objective =
    patch.objective === undefined
      ? current.objective
      : boundedText(patch.objective, PLAN_ITEM_OBJECTIVE_MAX)
  if (!objective) return { ok: false, error: `a missão "${title}" precisa de um objetivo` }

  if (patch.status !== undefined && !PLAN_ITEM_AUTHORED_STATUSES.includes(patch.status)) {
    return {
      ok: false,
      error: 'o estado "concluida" vem da missão vinculada — não se escreve à mão'
    }
  }
  if (patch.tier !== undefined && patch.tier !== null && !PLAN_ITEM_TIERS.includes(patch.tier)) {
    return { ok: false, error: `o tier de "${title}" precisa ser pequeno, medio ou grande` }
  }

  let docPath = current.docPath
  if (patch.docPath !== undefined) {
    if (patch.docPath === null) docPath = undefined
    else {
      const bounded = boundedText(patch.docPath, PLAN_DOC_PATH_MAX)
      if (bounded) {
        const problem = planDocPathProblem(bounded)
        if (problem) return { ok: false, error: `${problem} (missão "${title}")` }
      }
      docPath = bounded
    }
  }

  let dependsOn = current.dependsOn
  if (patch.dependsOn !== undefined) {
    dependsOn = []
    for (const dependency of patch.dependsOn.slice(0, PLAN_ITEM_DEPENDS_MAX)) {
      if (dependency === current.id) {
        return { ok: false, error: `"${title}" não pode depender de si mesma` }
      }
      if (!siblings.some((item) => item.id === dependency)) {
        return { ok: false, error: `"${title}" depende de um item que não está neste plano` }
      }
      if (!dependsOn.includes(dependency)) dependsOn.push(dependency)
    }
  }

  let doneCriteria = current.doneCriteria
  if (patch.doneCriteria !== undefined) {
    doneCriteria = []
    for (const criterion of patch.doneCriteria.slice(0, PLAN_DONE_CRITERIA_MAX_COUNT)) {
      const text = boundedText(criterion, PLAN_DONE_CRITERIA_MAX)
      if (text) doneCriteria.push(text)
    }
  }

  const outOfScope =
    patch.outOfScope === undefined
      ? current.outOfScope
      : patch.outOfScope === null
        ? undefined
        : boundedText(patch.outOfScope, PLAN_ITEM_TEXT_MAX)
  const context =
    patch.context === undefined
      ? current.context
      : patch.context === null
        ? undefined
        : boundedText(patch.context, PLAN_ITEM_TEXT_MAX)

  return {
    ok: true,
    item: {
      ...current,
      title,
      objective,
      outOfScope,
      doneCriteria,
      tier: patch.tier === null ? undefined : (patch.tier ?? current.tier),
      context,
      dependsOn,
      status: patch.status ?? current.status,
      docPath,
      // Toque humano/agente no item apaga a anotação da autocura.
      note: undefined,
      updatedAt: now
    }
  }
}
