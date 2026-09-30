import {
  groupOfProject,
  layoutGroups,
  projectLayoutOrder,
  type ProjectLayout,
  type ProjectLayoutGroupEntry
} from '../../shared/projectLayout'

// ————————————————————————————————————————————————————————————————————————
// O ÍNDICE DA HOME — busca, FILTRAR (estado + criação), ORDEM, visão e as
// abas de grupo (mockup aprovado em 2026-09-29:
// docs/mockups/grupos-universos-2026-09-29.html, seção "HOME — o índice").
//
// PURO de propósito: a Home entrega os fatos de cada universo já lidos do
// store e recebe de volta tudo o que desenha (abas com contagem, seções,
// etiquetas, a grade ordenada). Nada aqui lê store, DOM ou relógio — `now`
// entra como argumento, então a suíte `scripts/test-home-index.mjs` fixa o dia.
// ————————————————————————————————————————————————————————————————————————

export type HomeStateFilter = 'running' | 'attention' | 'active' | 'missing'
export type HomePeriod = 'any' | '7' | '30' | '90' | 'year'
export type HomeSort = 'rail' | 'opened' | 'newest' | 'oldest' | 'name'
/** 'all' = TODOS · 'none' = SEM GRUPO · qualquer outro valor = id de grupo */
export type HomeTabKey = string
/** qual data o card mostra na linha de meta (null = nenhuma) */
export type HomeDateMode = 'created' | 'opened' | null

/** O que a Home LEMBRA entre sessões. A busca fica de fora de propósito. */
export interface HomeView {
  group: HomeTabKey
  states: HomeStateFilter[]
  period: HomePeriod
  sort: HomeSort
  grouped: boolean
}

/** Os fatos de um universo que o índice precisa — a Home os monta do store. */
export interface HomeIndexProject {
  id: string
  name: string
  path: string
  createdAt: string
  /** algum painel vivo com atividade 'run' */
  running: boolean
  /** algum painel vivo pedindo o dono (`paneAttention`) */
  attention: boolean
  /** `homeStats[id].missoesAtivas` (0 enquanto não foi lido) */
  activeMissions: number
  missing: boolean
}

export const HOME_VIEW_STORAGE_KEY = 'synkora.home.view.v1'

export const HOME_VIEW_DEFAULT: Readonly<HomeView> = Object.freeze({
  group: 'all',
  states: [],
  period: 'any',
  sort: 'rail',
  grouped: true
})

export const HOME_STATE_OPTIONS: ReadonlyArray<{
  id: HomeStateFilter
  label: string
  /** classe do ponto de cor (verde, acento, tinta, erro) */
  dot: 'run' | 'attn' | 'active' | 'miss'
}> = [
  { id: 'running', label: 'rodando agora', dot: 'run' },
  { id: 'attention', label: 'precisa de você', dot: 'attn' },
  { id: 'active', label: 'com missão ativa', dot: 'active' },
  { id: 'missing', label: 'pasta sumida', dot: 'miss' }
]

export const HOME_PERIODS: readonly HomePeriod[] = ['any', '7', '30', '90', 'year']

/** "abertos por último" substitui a "atividade recente" do mockup: o único
 *  carimbo honesto de uso é `layout.lastOpenedAt` (Mission.updatedAt é
 *  mutação de store, nunca atividade). */
export const HOME_SORT_OPTIONS: ReadonlyArray<{ id: HomeSort; label: string; short: string }> = [
  { id: 'rail', label: 'a do rail', short: 'do rail' },
  { id: 'opened', label: 'abertos por último', short: 'últimos abertos' },
  { id: 'newest', label: 'mais novos primeiro', short: 'mais novos' },
  { id: 'oldest', label: 'mais antigos primeiro', short: 'mais antigos' },
  { id: 'name', label: 'nome (A–Z)', short: 'a–z' }
]

const STATE_IDS = HOME_STATE_OPTIONS.map((s) => s.id)
const SORT_IDS = HOME_SORT_OPTIONS.map((s) => s.id)
const DAY_MS = 86_400_000
const GROUP_KEY_MAX = 128
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

export function periodLabel(period: HomePeriod, now: Date): string {
  switch (period) {
    case 'any':
      return 'em qualquer data'
    case 'year':
      return `em ${now.getFullYear()}`
    default:
      return `nos últimos ${period} dias`
  }
}

// ---- busca ---------------------------------------------------------------

/** Minúsculas sem acento, um code point por vez. */
export function foldText(text: string): string {
  return foldWithMap(text).folded
}

/** Dobra guardando, para cada caractere dobrado, o trecho do original que o
 *  gerou — é o que deixa o `<mark>` cair sobre "sação" quando a busca é
 *  "sacao". */
function foldWithMap(text: string): { folded: string; starts: number[]; ends: number[] } {
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  let at = 0
  for (const cp of text) {
    const piece = cp.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    folded += piece
    // uma entrada por UNIDADE UTF-16 dobrada: é nessa régua que o indexOf mede
    for (let k = 0; k < piece.length; k++) {
      starts.push(at)
      ends.push(at + cp.length)
    }
    at += cp.length
  }
  return { folded, starts, ends }
}

export interface HighlightParts {
  before: string
  match: string
  after: string
}

/** A primeira ocorrência da busca no texto, já no texto ORIGINAL. */
export function highlightMatch(text: string, query: string): HighlightParts | null {
  const needle = foldText(query.trim())
  if (!needle) return null
  const { folded, starts, ends } = foldWithMap(text)
  const i = folded.indexOf(needle)
  if (i < 0) return null
  const from = starts[i]
  const to = ends[i + needle.length - 1]
  return { before: text.slice(0, from), match: text.slice(from, to), after: text.slice(to) }
}

/** Nome, pasta ou nome do grupo — cada campo por si (a busca não atravessa
 *  a fronteira entre dois campos). */
export function matchesSearch(p: HomeIndexProject, groupName: string | null, query: string): boolean {
  const needle = foldText(query.trim())
  if (!needle) return true
  return [p.name, p.path, groupName ?? ''].some((field) => foldText(field).includes(needle))
}

// ---- estado e período ----------------------------------------------------

export function hasState(p: HomeIndexProject, state: HomeStateFilter): boolean {
  switch (state) {
    case 'running':
      return p.running
    case 'attention':
      return p.attention
    case 'active':
      return p.activeMissions > 0
    case 'missing':
      return p.missing
  }
}

/** Estados somam (OU); nenhum marcado = todos passam. */
export function matchesStates(p: HomeIndexProject, states: readonly HomeStateFilter[]): boolean {
  return states.length === 0 || states.some((s) => hasState(p, s))
}

export function matchesPeriod(createdAt: string, period: HomePeriod, now: Date): boolean {
  if (period === 'any') return true
  const created = new Date(createdAt)
  if (Number.isNaN(created.getTime())) return false
  if (period === 'year') return created.getFullYear() === now.getFullYear()
  return (now.getTime() - created.getTime()) / DAY_MS <= Number(period)
}

// ---- ordem ---------------------------------------------------------------

function timeOf(iso: string | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** Mais recente primeiro; sem data vai para o fim. */
function byTimeDesc(a: number | null, b: number | null): number {
  if (a === b) return 0
  if (a === null) return 1
  if (b === null) return -1
  return b - a
}

function sortItems(
  items: HomeIndexProject[],
  sort: HomeSort,
  rank: ReadonlyMap<string, number>,
  lastOpenedAt: Readonly<Record<string, string>>
): HomeIndexProject[] {
  const byRail = (a: HomeIndexProject, b: HomeIndexProject): number =>
    (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)
  const primary = (a: HomeIndexProject, b: HomeIndexProject): number => {
    switch (sort) {
      case 'rail':
        return 0
      case 'opened':
        return byTimeDesc(timeOf(lastOpenedAt[a.id]), timeOf(lastOpenedAt[b.id]))
      case 'newest':
        return byTimeDesc(timeOf(a.createdAt), timeOf(b.createdAt))
      case 'oldest': {
        const ta = timeOf(a.createdAt)
        const tb = timeOf(b.createdAt)
        if (ta === tb) return 0
        if (ta === null) return 1
        if (tb === null) return -1
        return ta - tb
      }
      case 'name':
        return a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base', numeric: true })
    }
  }
  return [...items].sort((a, b) => primary(a, b) || byRail(a, b))
}

// ---- o índice inteiro ----------------------------------------------------

export interface HomeTab {
  key: HomeTabKey
  label: string
  count: number
  group: ProjectLayoutGroupEntry | null
}

export interface HomeSection {
  /** id do grupo, ou 'none' para os soltos */
  key: HomeTabKey
  group: ProjectLayoutGroupEntry | null
  items: HomeIndexProject[]
  /** quantos universos a seção tem sem filtro ("n de m") */
  total: number
}

export type HomeToken =
  | { kind: 'query'; id: 'query'; label: string }
  | { kind: 'state'; id: HomeStateFilter; label: string; dot: string }
  | { kind: 'period'; id: HomePeriod; label: string }

export interface HomeIndex {
  /** a aba EFETIVA: grupo desfeito ou SEM GRUPO vazio caem em TODOS */
  tab: HomeTabKey
  /** passa em tudo menos na aba — é daqui que saem as contagens das abas */
  base: HomeIndexProject[]
  /** o que a Home desenha, já ordenado */
  shown: HomeIndexProject[]
  tabs: HomeTab[]
  /** seções da visão "por grupo" com TODOS; null = uma grade só */
  sections: HomeSection[] | null
  tokens: HomeToken[]
  total: number
  /** o número do selo de FILTRAR (estados + período) */
  filterCount: number
  /** contagem de cada estado sobre TODOS os universos (a do popover) */
  stateCounts: Record<HomeStateFilter, number>
  showGroupTag: boolean
  dateMode: HomeDateMode
}

export interface HomeIndexInput {
  /** na ordem de `projects` do store */
  projects: readonly HomeIndexProject[]
  layout: ProjectLayout | null
  view: HomeView
  query: string
  now: Date
}

export function effectiveTab(tab: HomeTabKey, layout: ProjectLayout | null): HomeTabKey {
  if (!layout || tab === 'all') return 'all'
  if (tab === 'none') return layout.entries.some((e) => e.kind === 'project') ? 'none' : 'all'
  return layoutGroups(layout).some((g) => g.id === tab) ? tab : 'all'
}

export function computeHomeIndex(input: HomeIndexInput): HomeIndex {
  const { projects, layout, view, now } = input
  const query = input.query.trim()
  const groups = layout ? layoutGroups(layout) : []
  const groupOf = (id: string): ProjectLayoutGroupEntry | null => (layout ? groupOfProject(layout, id) : null)

  const order = layout ? projectLayoutOrder(layout) : projects.map((p) => p.id)
  const rank = new Map<string, number>()
  order.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i)
  })
  projects.forEach((p, i) => {
    if (!rank.has(p.id)) rank.set(p.id, order.length + i)
  })

  const base = projects.filter(
    (p) =>
      matchesSearch(p, groupOf(p.id)?.name ?? null, query) &&
      matchesStates(p, view.states) &&
      matchesPeriod(p.createdAt, view.period, now)
  )

  const tab = effectiveTab(view.group, layout)
  const inTab = (p: HomeIndexProject): boolean => {
    if (tab === 'all') return true
    const g = groupOf(p.id)
    return tab === 'none' ? g === null : g?.id === tab
  }
  const shown = sortItems(base.filter(inTab), view.sort, rank, layout?.lastOpenedAt ?? {})

  const tabs: HomeTab[] = [{ key: 'all', label: 'todos', count: base.length, group: null }]
  for (const g of groups) {
    tabs.push({ key: g.id, label: g.name, count: base.filter((p) => g.projectIds.includes(p.id)).length, group: g })
  }
  if (layout?.entries.some((e) => e.kind === 'project')) {
    tabs.push({ key: 'none', label: 'sem grupo', count: base.filter((p) => groupOf(p.id) === null).length, group: null })
  }

  let sections: HomeSection[] | null = null
  if (layout && view.grouped && tab === 'all') {
    sections = []
    for (const g of groups) {
      const items = shown.filter((p) => g.projectIds.includes(p.id))
      if (items.length > 0) sections.push({ key: g.id, group: g, items, total: g.projectIds.length })
    }
    const loose = shown.filter((p) => groupOf(p.id) === null)
    if (loose.length > 0) {
      const total = projects.filter((p) => groupOf(p.id) === null).length
      sections.push({ key: 'none', group: null, items: loose, total })
    }
  }

  const tokens: HomeToken[] = []
  if (query) tokens.push({ kind: 'query', id: 'query', label: `busca “${query}”` })
  for (const s of HOME_STATE_OPTIONS) {
    if (view.states.includes(s.id)) tokens.push({ kind: 'state', id: s.id, label: s.label, dot: s.dot })
  }
  if (view.period !== 'any') {
    tokens.push({ kind: 'period', id: view.period, label: `criados ${periodLabel(view.period, now)}` })
  }

  const stateCounts = Object.fromEntries(
    STATE_IDS.map((id) => [id, projects.filter((p) => hasState(p, id)).length])
  ) as Record<HomeStateFilter, number>

  return {
    tab,
    base,
    shown,
    tabs,
    sections,
    tokens,
    total: projects.length,
    filterCount: view.states.length + (view.period !== 'any' ? 1 : 0),
    stateCounts,
    showGroupTag: layout !== null && !view.grouped && tab === 'all',
    dateMode:
      view.sort === 'newest' || view.sort === 'oldest' || view.period !== 'any'
        ? 'created'
        : view.sort === 'opened'
          ? 'opened'
          : null
  }
}

// ---- mudanças de visão ---------------------------------------------------

export function toggleState(view: HomeView, state: HomeStateFilter): HomeView {
  const on = view.states.includes(state)
  return { ...view, states: STATE_IDS.filter((id) => (id === state ? !on : view.states.includes(id))) }
}

/** O × de uma etiqueta de estado ou de período (a da busca é da Home). */
export function removeToken(view: HomeView, token: HomeToken): HomeView {
  if (token.kind === 'state') return { ...view, states: view.states.filter((s) => s !== token.id) }
  if (token.kind === 'period') return { ...view, period: 'any' }
  return view
}

/** "limpar tudo" / "limpar filtros": aba, estados e período (ordem e visão ficam). */
export function clearFilters(view: HomeView): HomeView {
  return { ...view, group: 'all', states: [], period: 'any' }
}

// ---- datas do card -------------------------------------------------------

/** "24 set 2026" — dia do calendário local. */
export function formatCreatedDate(iso: string): string | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** "há 30 min" · "há 2 h" · "ontem" · "há 12 dias" · "há 3 meses" · "há 1 ano" */
export function formatOpenedAgo(iso: string, now: Date): string | null {
  const t = timeOf(iso)
  if (t === null) return null
  const mins = Math.round((now.getTime() - t) / 60_000)
  if (mins < 60) return `há ${Math.max(1, mins)} min`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `há ${hours} h`
  const days = Math.round(hours / 24)
  if (days === 1) return 'ontem'
  if (days < 45) return `há ${days} dias`
  const months = Math.round(days / 30)
  if (months < 12) return `há ${months} ${months === 1 ? 'mês' : 'meses'}`
  const years = Math.max(1, Math.round(days / 365))
  return `há ${years} ${years === 1 ? 'ano' : 'anos'}`
}

export function cardDateLabel(
  mode: HomeDateMode,
  project: Pick<HomeIndexProject, 'createdAt'>,
  lastOpenedAt: string | null,
  now: Date
): string | null {
  if (mode === 'created') {
    const date = formatCreatedDate(project.createdAt)
    return date ? `criado ${date}` : null
  }
  if (mode === 'opened') {
    const ago = lastOpenedAt ? formatOpenedAgo(lastOpenedAt, now) : null
    return ago ? `aberto ${ago}` : 'nunca aberto'
  }
  return null
}

// ---- o que fica lembrado (localStorage) ----------------------------------

function defaultView(): HomeView {
  return { ...HOME_VIEW_DEFAULT, states: [] }
}

/** Tolerante: JSON quebrado ou valor desconhecido cai no padrão, campo a campo. */
export function parseHomeView(raw: string | null | undefined): HomeView {
  if (!raw) return defaultView()
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return defaultView()
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return defaultView()
  const o = data as Record<string, unknown>
  const states = Array.isArray(o.states) ? o.states : []
  return {
    group:
      typeof o.group === 'string' && o.group.length > 0 && o.group.length <= GROUP_KEY_MAX
        ? o.group
        : HOME_VIEW_DEFAULT.group,
    states: STATE_IDS.filter((id) => states.includes(id)),
    period: HOME_PERIODS.find((p) => p === o.period) ?? HOME_VIEW_DEFAULT.period,
    sort: SORT_IDS.find((s) => s === o.sort) ?? HOME_VIEW_DEFAULT.sort,
    grouped: typeof o.grouped === 'boolean' ? o.grouped : HOME_VIEW_DEFAULT.grouped
  }
}

/** Só os cinco campos — o texto da busca nunca vai para o disco. */
export function serializeHomeView(view: HomeView): string {
  const { group, states, period, sort, grouped } = view
  return JSON.stringify({ group, states, period, sort, grouped })
}
