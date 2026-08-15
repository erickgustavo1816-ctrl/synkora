/**
 * RASCUNHO DE PLANO (Synkora 2.0, onda D — o MAPA vira menu de planejamento).
 *
 * A proposta que o agente de planejamento apresenta ao dono DENTRO do chat. Ela
 * atravessa o motor do pane (evento `plan-proposal`, anel, transcript
 * persistido) antes de existir como `Plan`, então precisa de duas coisas que o
 * store não pode dar:
 *
 * 1. ZERO dependência de Electron/fs — `guiSessions.ts` importa daqui e a suíte
 *    `test:gui-sessions` roda em node puro.
 * 2. Uma porteira TOTAL: o que sai de `normalizePlanDraft` tem toda `key`
 *    resolvida, toda dependência apontando para um item ANTERIOR e todo texto
 *    dentro do teto. O card do chat e a criação do plano consomem só esta
 *    forma — nunca o objeto cru que veio da tool.
 *
 * PROPOSTA NÃO É PLANO: nada aqui toca disco. O `Plan` nasce no clique de
 * aprovação do dono (plans.ts), e é lá que as `key`s viram ids de verdade.
 */
import { redactSensitiveStrings } from './securityRedaction'

// ————— tetos (o rascunho vem de um agente: nada entra sem régua) —————

export const PLAN_TITLE_MAX = 120
export const PLAN_DESCRIPTION_MAX = 4_000
export const PLAN_ITEM_MAX_COUNT = 24
export const PLAN_ITEM_TITLE_MAX = 120
export const PLAN_ITEM_OBJECTIVE_MAX = 2_000
export const PLAN_ITEM_TEXT_MAX = 2_000
export const PLAN_DONE_CRITERIA_MAX_COUNT = 10
export const PLAN_DONE_CRITERIA_MAX = 400
export const PLAN_ITEM_DEPENDS_MAX = 12
export const PLAN_ITEM_KEY_MAX = 60
export const PLAN_DOC_PATH_MAX = 240
/** O rascunho viaja num evento do chat (anel + transcript persistido). */
export const PLAN_DRAFT_MAX_BYTES = 64 * 1024

/** `mestre` = o plano de fundo do universo (no máximo UM ativo por projeto);
 *  `livre` = um recorte qualquer que atravessa versões. */
export type PlanKind = 'mestre' | 'livre'

export const PLAN_KINDS: readonly PlanKind[] = ['mestre', 'livre']

export type PlanItemTier = 'pequeno' | 'medio' | 'grande'

export const PLAN_ITEM_TIERS: readonly PlanItemTier[] = ['pequeno', 'medio', 'grande']

/**
 * Item de rascunho NORMALIZADO. `key` é o endereço do item ENQUANTO ele é só
 * proposta — os ids reais nascem na aprovação, então o `dependsOn` de um
 * rascunho aponta para `key`s de itens ANTERIORES da mesma lista.
 */
export interface PlanDraftItem {
  key: string
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
  /** `key`s de itens ANTERIORES desta mesma lista */
  dependsOn: string[]
  /** brief em prosa no repo do produto (ex.: 'plano/003-fila.md') */
  docPath?: string
}

export interface PlanDraft {
  title: string
  description?: string
  kind: PlanKind
  items: PlanDraftItem[]
}

export type PlanDraftResult = { ok: true; draft: PlanDraft } | { ok: false; error: string }

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function boundedText(value: unknown, cap: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, Math.max(0, cap - 1))}…`
}

/** `key` é endereço, não prosa: minúsculas, dígitos e hífen. */
export function planDraftKey(raw: string, fallbackIndex: number): string {
  const slug = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PLAN_ITEM_KEY_MAX)
  return slug || `item-${fallbackIndex + 1}`
}

/**
 * Caminho do brief no repo do produto. Relativo, POSIX, sem subir de pasta e
 * sem raiz — o app nunca abre nada a partir daqui, mas o valor VIAJA para a UI
 * e para o prompt, então travessia não pode nem chegar a ser gravada.
 */
export function planDocPathProblem(value: string): string | null {
  if (value.length > PLAN_DOC_PATH_MAX) return 'caminho do brief longo demais'
  if (value.includes('\\')) return 'caminho do brief usa barra invertida — use barras normais'
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    return 'caminho do brief precisa ser relativo à raiz do projeto'
  }
  if (value.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    return 'caminho do brief inválido'
  }
  return null
}

/**
 * PORTEIRA DO RASCUNHO. Erros em PT-BR porque a mesma frase serve ao agente
 * (resultado da tool) e ao dono (recusa na UI).
 */
export function normalizePlanDraft(value: unknown): PlanDraftResult {
  const raw = plainRecord(value)
  if (!raw) return { ok: false, error: 'plano em formato inválido' }
  const title = boundedText(raw['title'], PLAN_TITLE_MAX)
  if (!title) return { ok: false, error: 'o plano precisa de um título' }
  const description = boundedText(raw['description'], PLAN_DESCRIPTION_MAX)
  const kindRaw = raw['kind']
  if (kindRaw !== undefined && kindRaw !== 'mestre' && kindRaw !== 'livre') {
    return { ok: false, error: 'natureza do plano desconhecida (use mestre ou livre)' }
  }
  const kind: PlanKind = kindRaw === 'mestre' ? 'mestre' : 'livre'

  const rawItems = raw['items']
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, error: 'o plano precisa de pelo menos uma missão' }
  }
  if (rawItems.length > PLAN_ITEM_MAX_COUNT) {
    return {
      ok: false,
      error: `o plano tem missões demais (máximo ${PLAN_ITEM_MAX_COUNT}) — divida em dois planos`
    }
  }

  const items: PlanDraftItem[] = []
  const seenKeys = new Set<string>()
  for (const [index, entry] of rawItems.entries()) {
    const item = plainRecord(entry)
    if (!item) return { ok: false, error: `missão ${index + 1} em formato inválido` }
    const itemTitle = boundedText(item['title'], PLAN_ITEM_TITLE_MAX)
    if (!itemTitle) return { ok: false, error: `missão ${index + 1} sem título` }
    const objective = boundedText(item['objective'], PLAN_ITEM_OBJECTIVE_MAX)
    if (!objective) return { ok: false, error: `a missão "${itemTitle}" está sem objetivo` }

    const keySource = boundedText(item['key'], PLAN_ITEM_KEY_MAX) ?? itemTitle
    let key = planDraftKey(keySource, index)
    if (seenKeys.has(key)) {
      let suffix = 2
      while (seenKeys.has(`${key}-${suffix}`)) suffix += 1
      key = `${key}-${suffix}`
    }
    seenKeys.add(key)

    const rawCriteria = item['doneCriteria']
    const doneCriteria: string[] = []
    if (rawCriteria !== undefined) {
      if (!Array.isArray(rawCriteria)) {
        return {
          ok: false,
          error: `os critérios de pronto de "${itemTitle}" estão em formato inválido`
        }
      }
      for (const criterion of rawCriteria.slice(0, PLAN_DONE_CRITERIA_MAX_COUNT)) {
        const text = boundedText(criterion, PLAN_DONE_CRITERIA_MAX)
        if (text) doneCriteria.push(text)
      }
    }

    const tierRaw = item['tier']
    if (tierRaw !== undefined && !(PLAN_ITEM_TIERS as readonly unknown[]).includes(tierRaw)) {
      return { ok: false, error: `o tier de "${itemTitle}" precisa ser pequeno, medio ou grande` }
    }

    const docPath = boundedText(item['docPath'], PLAN_DOC_PATH_MAX)
    if (docPath) {
      const problem = planDocPathProblem(docPath)
      if (problem) return { ok: false, error: `${problem} (missão "${itemTitle}")` }
    }

    const rawDepends = item['dependsOn']
    const dependsOn: string[] = []
    if (rawDepends !== undefined) {
      if (!Array.isArray(rawDepends)) {
        return { ok: false, error: `as dependências de "${itemTitle}" estão em formato inválido` }
      }
      for (const dependency of rawDepends.slice(0, PLAN_ITEM_DEPENDS_MAX)) {
        const text = boundedText(dependency, PLAN_ITEM_KEY_MAX)
        if (!text) continue
        // Dependência só aponta para TRÁS: um grafo que enxerga apenas itens já
        // aceitos não tem como fechar ciclo, e a ordem da lista vira a ordem de
        // execução sem nenhuma ordenação topológica escondida.
        const target = items.find(
          (candidate) => candidate.key === text || candidate.title === text
        )
        if (!target) {
          return {
            ok: false,
            error: `"${itemTitle}" depende de "${text}", que não é uma missão anterior deste plano`
          }
        }
        if (!dependsOn.includes(target.key)) dependsOn.push(target.key)
      }
    }

    const outOfScope = boundedText(item['outOfScope'], PLAN_ITEM_TEXT_MAX)
    const context = boundedText(item['context'], PLAN_ITEM_TEXT_MAX)
    items.push({
      key,
      title: itemTitle,
      objective,
      ...(outOfScope ? { outOfScope } : {}),
      doneCriteria,
      ...(tierRaw !== undefined ? { tier: tierRaw as PlanItemTier } : {}),
      ...(context ? { context } : {}),
      dependsOn,
      ...(docPath ? { docPath } : {})
    })
  }

  const draft: PlanDraft = {
    title,
    ...(description ? { description } : {}),
    kind,
    items
  }
  if (planDraftByteSize(draft) > PLAN_DRAFT_MAX_BYTES) {
    return {
      ok: false,
      error: 'o plano é grande demais para caber numa proposta — resuma o contexto'
    }
  }
  return { ok: true, draft: redactSensitiveStrings(draft) }
}

/** Tamanho serializado — a mesma régua do anel, sem depender de Buffer. */
export function planDraftByteSize(draft: PlanDraft): number {
  const serialized = JSON.stringify(draft)
  return typeof serialized === 'string' ? new TextEncoder().encode(serialized).length : 0
}

/**
 * Validador do rascunho JÁ NORMALIZADO — é o que a hidratação do transcript
 * usa (o evento veio de JSON local, não do agente vivo). Aceita somente a forma
 * total que `normalizePlanDraft` produz: se um campo obrigatório sumiu no
 * disco, o card não renasce meio pronto.
 */
export function isPlanDraft(value: unknown): value is PlanDraft {
  const draft = plainRecord(value)
  if (!draft) return false
  if (typeof draft['title'] !== 'string' || !draft['title'].trim()) return false
  if (draft['title'].length > PLAN_TITLE_MAX) return false
  if (draft['description'] !== undefined) {
    if (typeof draft['description'] !== 'string') return false
    if (draft['description'].length > PLAN_DESCRIPTION_MAX) return false
  }
  if (!(PLAN_KINDS as readonly unknown[]).includes(draft['kind'])) return false
  const items = draft['items']
  if (!Array.isArray(items) || items.length === 0 || items.length > PLAN_ITEM_MAX_COUNT) {
    return false
  }
  const keys = new Set<string>()
  for (const entry of items) {
    const item = plainRecord(entry)
    if (!item) return false
    const key = item['key']
    if (typeof key !== 'string' || !key || key.length > PLAN_ITEM_KEY_MAX) return false
    if (keys.has(key)) return false
    if (typeof item['title'] !== 'string' || !item['title'].trim()) return false
    if (item['title'].length > PLAN_ITEM_TITLE_MAX) return false
    if (typeof item['objective'] !== 'string' || !item['objective'].trim()) return false
    if (item['objective'].length > PLAN_ITEM_OBJECTIVE_MAX) return false
    if (item['outOfScope'] !== undefined) {
      if (typeof item['outOfScope'] !== 'string') return false
      if (item['outOfScope'].length > PLAN_ITEM_TEXT_MAX) return false
    }
    if (item['context'] !== undefined) {
      if (typeof item['context'] !== 'string') return false
      if (item['context'].length > PLAN_ITEM_TEXT_MAX) return false
    }
    if (item['tier'] !== undefined && !(PLAN_ITEM_TIERS as readonly unknown[]).includes(item['tier'])) {
      return false
    }
    if (item['docPath'] !== undefined) {
      if (typeof item['docPath'] !== 'string') return false
      if (planDocPathProblem(item['docPath']) !== null) return false
    }
    const criteria = item['doneCriteria']
    if (!Array.isArray(criteria) || criteria.length > PLAN_DONE_CRITERIA_MAX_COUNT) return false
    if (
      !criteria.every(
        (criterion) => typeof criterion === 'string' && criterion.length <= PLAN_DONE_CRITERIA_MAX
      )
    )
      return false
    const dependsOn = item['dependsOn']
    if (!Array.isArray(dependsOn) || dependsOn.length > PLAN_ITEM_DEPENDS_MAX) return false
    // Dependência só aponta para trás: a mesma invariante da normalização, e é
    // ela que garante que o card renasça sem ciclo depois de um boot.
    if (!dependsOn.every((dependency) => typeof dependency === 'string' && keys.has(dependency)))
      return false
    keys.add(key)
  }
  return planDraftByteSize(draft as unknown as PlanDraft) <= PLAN_DRAFT_MAX_BYTES
}
