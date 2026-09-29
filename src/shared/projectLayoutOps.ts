// ————————————————————————————————————————————————————————————————————————
// AS OPERAÇÕES DO LAYOUT DOS UNIVERSOS (grupos, 2026-09-29).
//
// Módulo PURO (sem Node/Electron): o main é quem chama `applyProjectLayoutOp`
// e persiste; o devMock usa as mesmas funções no preview de browser. Toda
// operação é IMUTÁVEL e TOTAL — entrada inválida ou id desconhecido devolve o
// layout igual (a mesma referência), nunca lança. Grupo vazio é podado ao fim
// de toda operação; grupo com um universo continua.
//
// Semântica portada do mockup aprovado (seção "OPERAÇÕES DO LAYOUT" de
// docs/mockups/grupos-universos-2026-09-29.html).
// ————————————————————————————————————————————————————————————————————————
import {
  PROJECT_GROUP_HUES,
  PROJECT_GROUP_NAME_MAX,
  type ProjectGroupHue,
  type ProjectLayout,
  type ProjectLayoutDropTarget,
  type ProjectLayoutEntry,
  type ProjectLayoutGroupEntry,
  type ProjectLayoutOp,
  type ProjectLayoutOpResult,
  type ProjectLayoutProjectEntry,
  type ProjectLayoutRef
} from './projectLayout'

export interface ProjectLayoutOpOptions {
  /** gerador do id de grupo novo (o main passa `randomUUID`) */
  newId?: () => string
}

export function emptyProjectLayout(): ProjectLayout {
  return { entries: [], lastOpenedAt: {} }
}

export function isProjectGroupHue(value: unknown): value is ProjectGroupHue {
  return (PROJECT_GROUP_HUES as readonly unknown[]).includes(value)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isStamp = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))

const loose = (projectId: string): ProjectLayoutProjectEntry => ({ kind: 'project', projectId })

/** aparado e cortado no teto (por code point: nunca parte um emoji);
 *  '' quando não sobra nada */
function cleanGroupName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return Array.from(raw.trim()).slice(0, PROJECT_GROUP_NAME_MAX).join('').trimEnd()
}

const fold = (text: string): string =>
  text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

const groupsIn = (entries: readonly ProjectLayoutEntry[]): ProjectLayoutGroupEntry[] =>
  entries.filter((e): e is ProjectLayoutGroupEntry => e.kind === 'group')

/** o primeiro "grupo N" livre, sem maiúsculas nem acentos ("Grúpo 1" ocupa o 1) */
function nextGroupName(entries: readonly ProjectLayoutEntry[]): string {
  const used = new Set(groupsIn(entries).map((g) => fold(g.name)))
  let n = 1
  while (used.has(`grupo ${n}`)) n++
  return `grupo ${n}`
}

/** grupo sem nome ganha o próximo "grupo N" livre, na ordem do rail */
function nameUnnamedGroups(entries: readonly ProjectLayoutEntry[]): void {
  for (const group of groupsIn(entries)) {
    if (!group.name) group.name = nextGroupName(entries)
  }
}

const sameLayout = (a: ProjectLayout, b: ProjectLayout): boolean => JSON.stringify(a) === JSON.stringify(b)

// ——— leitura tolerante ———

/** Lê qualquer coisa como layout, sem lançar: entrada malformada some,
 *  universo repetido fica só na primeira ocorrência, grupo sem id (ou com id
 *  repetido) solta os universos no mesmo lugar, grupo vazio some, nome/cor/
 *  aberto são saneados. Arquivo corrompido = layout vazio. */
export function sanitizeProjectLayout(raw: unknown): ProjectLayout {
  try {
    return readLayout(raw)
  } catch {
    return emptyProjectLayout()
  }
}

function readLayout(raw: unknown): ProjectLayout {
  if (!isRecord(raw) || !Array.isArray(raw.entries)) return emptyProjectLayout()
  const placed = new Set<string>()
  const groupIds = new Set<string>()
  const claim = (id: unknown): id is string => {
    if (!isId(id) || placed.has(id)) return false
    placed.add(id)
    return true
  }
  const entries: ProjectLayoutEntry[] = []
  for (const item of raw.entries) {
    if (!isRecord(item)) continue
    if (item.kind === 'project') {
      if (claim(item.projectId)) entries.push(loose(item.projectId))
      continue
    }
    if (item.kind !== 'group') continue
    const projectIds = Array.isArray(item.projectIds) ? item.projectIds.filter(claim) : []
    if (!isId(item.id) || groupIds.has(item.id)) {
      entries.push(...projectIds.map(loose))
      continue
    }
    if (projectIds.length === 0) continue
    groupIds.add(item.id)
    entries.push({
      kind: 'group',
      id: item.id,
      name: cleanGroupName(item.name),
      hue: isProjectGroupHue(item.hue) ? item.hue : null,
      open: item.open === true,
      projectIds
    })
  }
  nameUnnamedGroups(entries)
  const lastOpenedAt: Record<string, string> = {}
  if (isRecord(raw.lastOpenedAt)) {
    for (const [projectId, at] of Object.entries(raw.lastOpenedAt)) {
      if (isId(projectId) && isStamp(at)) lastOpenedAt[projectId] = at
    }
  }
  return { entries, lastOpenedAt }
}

/** O layout de verdade para a lista de universos atual: some quem não existe
 *  mais (entradas e `lastOpenedAt`), universo novo entra SOLTO no fim, na
 *  ordem de `projectIds`. Já reconciliado → devolve a MESMA referência (é
 *  assim que o store sabe que não precisa gravar). */
export function reconcileProjectLayout(layout: ProjectLayout, projectIds: readonly string[]): ProjectLayout {
  const clean = sanitizeProjectLayout(layout)
  const known = new Set(projectIds)
  const placed = new Set<string>()
  const entries: ProjectLayoutEntry[] = []
  for (const entry of clean.entries) {
    if (entry.kind === 'project') {
      if (!known.has(entry.projectId)) continue
      placed.add(entry.projectId)
      entries.push(entry)
      continue
    }
    const ids = entry.projectIds.filter((id) => known.has(id))
    if (ids.length === 0) continue
    for (const id of ids) placed.add(id)
    entries.push({ ...entry, projectIds: ids })
  }
  for (const id of projectIds) {
    if (!isId(id) || placed.has(id)) continue
    placed.add(id)
    entries.push(loose(id))
  }
  const lastOpenedAt: Record<string, string> = {}
  for (const [projectId, at] of Object.entries(clean.lastOpenedAt)) {
    if (known.has(projectId)) lastOpenedAt[projectId] = at
  }
  const next: ProjectLayout = { entries, lastOpenedAt }
  return sameLayout(next, layout) ? layout : next
}

// ——— operações ———

/** Aplica UMA operação. Nunca lança; operação sem efeito devolve o mesmo
 *  layout. `createdGroupId` sai quando nasceu um grupo (combine/createGroup). */
export function applyProjectLayoutOp(
  layout: ProjectLayout,
  op: ProjectLayoutOp,
  options: ProjectLayoutOpOptions = {}
): ProjectLayoutOpResult {
  try {
    const draft = cloneLayout(layout)
    const createdGroupId = runOp(draft, op, options.newId ?? defaultGroupId)
    draft.entries = draft.entries.filter((e) => e.kind !== 'group' || e.projectIds.length > 0)
    // o nome sai DEPOIS da poda: o nome do grupo que acabou de esvaziar fica livre
    if (createdGroupId) nameUnnamedGroups(draft.entries)
    if (sameLayout(draft, layout)) return { layout }
    return createdGroupId ? { layout: draft, createdGroupId } : { layout: draft }
  } catch {
    return { layout }
  }
}

function cloneLayout(layout: ProjectLayout): ProjectLayout {
  return {
    entries: layout.entries.map(
      (e): ProjectLayoutEntry =>
        e.kind === 'project'
          ? loose(e.projectId)
          : { kind: 'group', id: e.id, name: e.name, hue: e.hue, open: e.open, projectIds: [...e.projectIds] }
    ),
    lastOpenedAt: { ...layout.lastOpenedAt }
  }
}

function defaultGroupId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  return crypto?.randomUUID?.() ?? `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function runOp(draft: ProjectLayout, op: ProjectLayoutOp, mint: () => string): string | undefined {
  const entries = draft.entries
  switch (op.op) {
    case 'moveProject':
      return moveProject(entries, op.projectId, op.target, mint)
    case 'moveGroup':
      moveGroup(entries, op.groupId, op.target)
      return undefined
    case 'createGroup':
      return createGroup(entries, op.projectId, mint)
    case 'moveToGroup': {
      const group = findGroup(entries, op.groupId)
      if (!group || !locate(entries, op.projectId) || group.projectIds.includes(op.projectId)) return undefined
      detach(entries, op.projectId)
      group.projectIds.push(op.projectId)
      return undefined
    }
    case 'removeFromGroup': {
      const spot = locate(entries, op.projectId)
      if (!spot?.group) return undefined
      const host = entries.indexOf(spot.group)
      spot.group.projectIds.splice(spot.index, 1)
      entries.splice(host + 1, 0, loose(op.projectId))
      return undefined
    }
    case 'renameGroup': {
      const group = findGroup(entries, op.groupId)
      const name = cleanGroupName(op.name)
      if (group && name) group.name = name
      return undefined
    }
    case 'setGroupHue': {
      const group = findGroup(entries, op.groupId)
      if (group && (op.hue === null || isProjectGroupHue(op.hue))) group.hue = op.hue
      return undefined
    }
    case 'setGroupOpen': {
      const group = findGroup(entries, op.groupId)
      if (group && typeof op.open === 'boolean') group.open = op.open
      return undefined
    }
    case 'dissolveGroup': {
      const index = groupIndex(entries, op.groupId)
      const group = entries[index]
      if (group?.kind === 'group') entries.splice(index, 1, ...group.projectIds.map(loose))
      return undefined
    }
    case 'touchOpened':
      if (locate(entries, op.projectId) && isStamp(op.at)) draft.lastOpenedAt[op.projectId] = op.at
      return undefined
    default:
      return undefined
  }
}

type Spot = { group: null; index: number } | { group: ProjectLayoutGroupEntry; index: number }

/** onde o universo está: solto no nível de cima ou dentro de um grupo */
function locate(entries: readonly ProjectLayoutEntry[], projectId: string): Spot | null {
  const top = entries.findIndex((e) => e.kind === 'project' && e.projectId === projectId)
  if (top >= 0) return { group: null, index: top }
  for (const group of groupsIn(entries)) {
    const index = group.projectIds.indexOf(projectId)
    if (index >= 0) return { group, index }
  }
  return null
}

/** tira o universo de onde estiver SEM podar (quem poda é o fim da operação) */
function detach(entries: ProjectLayoutEntry[], projectId: string): void {
  const spot = locate(entries, projectId)
  if (!spot) return
  if (spot.group) spot.group.projectIds.splice(spot.index, 1)
  else entries.splice(spot.index, 1)
}

const groupIndex = (entries: readonly ProjectLayoutEntry[], groupId: string): number =>
  entries.findIndex((e) => e.kind === 'group' && e.id === groupId)

function findGroup(entries: readonly ProjectLayoutEntry[], groupId: string): ProjectLayoutGroupEntry | null {
  const entry = entries[groupIndex(entries, groupId)]
  return entry?.kind === 'group' ? entry : null
}

/** índice no nível de cima da referência — universo de dentro de grupo vale
 *  pelo grupo dele (grupo nunca entra em grupo) */
function topLevelIndex(entries: readonly ProjectLayoutEntry[], ref: ProjectLayoutRef): number {
  if (ref.kind === 'group') return groupIndex(entries, ref.groupId)
  const spot = locate(entries, ref.projectId)
  if (!spot) return -1
  return spot.group ? entries.indexOf(spot.group) : spot.index
}

/** grupo recém-nascido: fechado, neutro e sem nome até a poda (ver applyProjectLayoutOp) */
function newGroup(entries: readonly ProjectLayoutEntry[], mint: () => string, projectIds: string[]): ProjectLayoutGroupEntry {
  const taken = new Set(groupsIn(entries).map((g) => g.id))
  let id: string | undefined
  for (let attempt = 0; attempt < 8 && id === undefined; attempt++) {
    const candidate: unknown = mint()
    if (isId(candidate) && !taken.has(candidate)) id = candidate
  }
  if (id === undefined) {
    // gerador teimoso: um sufixo livre garante a unicidade assim mesmo
    let n = 1
    while (taken.has(`grupo-${n}`)) n++
    id = `grupo-${n}`
  }
  return { kind: 'group', id, name: '', hue: null, open: false, projectIds }
}

function moveProject(
  entries: ProjectLayoutEntry[],
  projectId: string,
  target: ProjectLayoutDropTarget,
  mint: () => string
): string | undefined {
  if (!locate(entries, projectId)) return undefined
  switch (target.type) {
    case 'combine': {
      if (target.projectId === projectId) return undefined
      if (locate(entries, target.projectId)?.group !== null) return undefined
      detach(entries, projectId)
      const index = entries.findIndex((e) => e.kind === 'project' && e.projectId === target.projectId)
      const group = newGroup(entries, mint, [target.projectId, projectId])
      entries.splice(index, 1, group)
      return group.id
    }
    case 'into': {
      const group = findGroup(entries, target.groupId)
      if (!group || group.projectIds.includes(projectId)) return undefined
      detach(entries, projectId)
      group.projectIds.push(projectId)
      return undefined
    }
    case 'first-in': {
      const group = findGroup(entries, target.groupId)
      if (!group) return undefined
      detach(entries, projectId)
      group.projectIds.unshift(projectId)
      return undefined
    }
    case 'before':
    case 'after': {
      const shift = target.type === 'after' ? 1 : 0
      const ref = target.ref
      if (ref.kind === 'project') {
        if (ref.projectId === projectId || !locate(entries, ref.projectId)) return undefined
        // tira ANTES de localizar a referência: o índice dela pode andar
        detach(entries, projectId)
        const spot = locate(entries, ref.projectId)
        if (!spot) return undefined
        if (spot.group) spot.group.projectIds.splice(spot.index + shift, 0, projectId)
        else entries.splice(spot.index + shift, 0, loose(projectId))
        return undefined
      }
      if (groupIndex(entries, ref.groupId) < 0) return undefined
      // se o grupo de referência esvaziar aqui, ele só some na poda do fim
      detach(entries, projectId)
      entries.splice(groupIndex(entries, ref.groupId) + shift, 0, loose(projectId))
      return undefined
    }
    default:
      return undefined
  }
}

function moveGroup(
  entries: ProjectLayoutEntry[],
  groupId: string,
  target: { type: 'before' | 'after'; ref: ProjectLayoutRef }
): void {
  if (target.type !== 'before' && target.type !== 'after') return
  const from = groupIndex(entries, groupId)
  const refAt = topLevelIndex(entries, target.ref)
  if (from < 0 || refAt < 0 || refAt === from) return
  const [group] = entries.splice(from, 1)
  entries.splice(topLevelIndex(entries, target.ref) + (target.type === 'after' ? 1 : 0), 0, group)
}

function createGroup(entries: ProjectLayoutEntry[], projectId: string, mint: () => string): string | undefined {
  const spot = locate(entries, projectId)
  if (!spot) return undefined
  const group = newGroup(entries, mint, [projectId])
  if (!spot.group) {
    entries.splice(spot.index, 1, group)
    return group.id
  }
  // de dentro de um grupo: o novo nasce logo depois do antigo
  const host = entries.indexOf(spot.group)
  spot.group.projectIds.splice(spot.index, 1)
  entries.splice(host + 1, 0, group)
  return group.id
}
