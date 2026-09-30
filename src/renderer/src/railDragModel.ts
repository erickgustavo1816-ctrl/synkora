import {
  groupOfProject,
  layoutGroups,
  type ProjectLayout,
  type ProjectLayoutDropTarget,
  type ProjectLayoutOp,
  type ProjectLayoutRef
} from '../../shared/projectLayout'

// ————————————————————————————————————————————————————————————————————————
// ARRASTAR NO RAIL — o modelo puro (grupos, 2026-09-29).
//
// O hook (useRailDrag) MEDE a lista e passa aqui as fileiras + a altura do
// ponteiro + o que está sendo arrastado; daqui sai onde aquilo cai, o que
// pintar (linha de 3 px ou destaque) e a pílula "soltar: …". Os limiares são
// os do `computeTarget` do mockup aprovado
// (docs/mockups/grupos-universos-2026-09-29.html) — não afinar a olho.
// ————————————————————————————————————————————————————————————————————————

export type RailDragSource = { kind: 'project'; projectId: string } | { kind: 'group'; groupId: string }

/** Retângulo vertical em coordenadas de tela (clientY). */
export interface RailRect {
  top: number
  bottom: number
}

/** Uma entrada do nível de cima da lista, medida. */
export type RailSlotMeasure =
  | { kind: 'project'; projectId: string; rect: RailRect }
  /** pasta fechada — o retângulo do slot inteiro (pasta + nome sob ela) */
  | { kind: 'folder'; groupId: string; rect: RailRect }
  /** cápsula aberta: o retângulo inteiro, o cabeçalho e cada filho */
  | {
      kind: 'capsule'
      groupId: string
      rect: RailRect
      head: RailRect
      children: ReadonlyArray<{ projectId: string; rect: RailRect }>
    }

/** O que pintar: a linha (y de tela do CENTRO da linha; recuada dentro da
 *  cápsula) ou o destaque de combinar / entrar. */
export type RailDropFeedback =
  | { kind: 'line'; y: number; inset: boolean }
  | { kind: 'combine'; projectId: string }
  | { kind: 'into'; groupId: string }

export interface RailDrop {
  target: ProjectLayoutDropTarget
  feedback: RailDropFeedback
}

/** A pílula: `lead` + `em` (no acento) + `tail`. */
export interface RailDropHint {
  lead: string
  em: string
  tail: string
}

/** A linha fica no MEIO do vão de 10 px entre dois itens. */
const LINE_OFFSET = 5
/** Tolerância antes de um clique virar arraste. */
const DRAG_THRESHOLD = 5
/** Faixa das bordas da lista que rola sozinha durante o arraste. */
const AUTO_SCROLL_EDGE = 28
const AUTO_SCROLL_STEP = 8

type Row =
  | { t: 'self'; rect: RailRect }
  /** arrastando um GRUPO: cada entrada do nível de cima é uma fileira só */
  | { t: 'top'; rect: RailRect; ref: ProjectLayoutRef }
  | { t: 'tile'; rect: RailRect; projectId: string }
  | { t: 'folder'; rect: RailRect; groupId: string }
  | { t: 'head'; rect: RailRect; groupId: string; capsule: RailRect }
  | { t: 'child'; rect: RailRect; projectId: string }
  /** a sobra entre o último filho e o pé da cápsula: soltar ali tira do grupo */
  | { t: 'gend'; rect: RailRect; groupId: string; capsule: RailRect }

function rowsFor(slots: readonly RailSlotMeasure[], source: RailDragSource): Row[] {
  const rows: Row[] = []
  for (const slot of slots) {
    if (source.kind === 'group') {
      if (slot.kind !== 'project' && slot.groupId === source.groupId) {
        rows.push({ t: 'self', rect: slot.rect })
        continue
      }
      const ref: ProjectLayoutRef =
        slot.kind === 'project' ? { kind: 'project', projectId: slot.projectId } : { kind: 'group', groupId: slot.groupId }
      rows.push({ t: 'top', rect: slot.rect, ref })
      continue
    }
    if (slot.kind === 'project') {
      rows.push(
        slot.projectId === source.projectId
          ? { t: 'self', rect: slot.rect }
          : { t: 'tile', rect: slot.rect, projectId: slot.projectId }
      )
      continue
    }
    if (slot.kind === 'folder') {
      rows.push({ t: 'folder', rect: slot.rect, groupId: slot.groupId })
      continue
    }
    rows.push({ t: 'head', rect: slot.head, groupId: slot.groupId, capsule: slot.rect })
    for (const child of slot.children) {
      rows.push(
        child.projectId === source.projectId
          ? { t: 'self', rect: child.rect }
          : { t: 'child', rect: child.rect, projectId: child.projectId }
      )
    }
    const last = slot.children[slot.children.length - 1]
    const lastBottom = last ? last.rect.bottom : slot.head.bottom
    rows.push({ t: 'gend', rect: { top: lastBottom, bottom: slot.rect.bottom }, groupId: slot.groupId, capsule: slot.rect })
  }
  return rows
}

/** A fileira sob o ponteiro; no vão entre duas, a mais próxima. */
function pickRow(rows: readonly Row[], y: number): Row | null {
  let best: Row | null = null
  let bestDistance = Infinity
  for (const row of rows) {
    const d = y < row.rect.top ? row.rect.top - y : y > row.rect.bottom ? y - row.rect.bottom : 0
    if (d < bestDistance) {
      bestDistance = d
      best = row
    }
    if (d === 0) break
  }
  return best
}

const projectRef = (projectId: string): ProjectLayoutRef => ({ kind: 'project', projectId })
const groupRef = (groupId: string): ProjectLayoutRef => ({ kind: 'group', groupId })

function before(ref: ProjectLayoutRef, top: number, inset = false): RailDrop {
  return { target: { type: 'before', ref }, feedback: { kind: 'line', y: top - LINE_OFFSET, inset } }
}

function after(ref: ProjectLayoutRef, bottom: number, inset = false): RailDrop {
  return { target: { type: 'after', ref }, feedback: { kind: 'line', y: bottom + LINE_OFFSET, inset } }
}

/**
 * Onde o arrastado cai com o ponteiro na altura `y`. Limiares do mockup:
 * tile solto < 0.28 antes / > 0.72 depois / meio combina; pasta < 0.22 antes /
 * > 0.84 depois / meio entra; cabeçalho aberto < 0.3 antes do grupo, senão
 * primeiro de dentro; filho < 0.5 antes, senão depois; a sobra da cápsula tira
 * do grupo. Arrastando um grupo, só antes/depois no nível de cima. `null` =
 * sobre si mesmo (soltar não faz nada).
 */
export function railDropAt(slots: readonly RailSlotMeasure[], source: RailDragSource, y: number): RailDrop | null {
  const row = pickRow(rowsFor(slots, source), y)
  if (!row || row.t === 'self') return null
  const height = row.rect.bottom - row.rect.top || 1
  const rel = Math.min(1, Math.max(0, (y - row.rect.top) / height))
  switch (row.t) {
    case 'top':
      return rel < 0.5 ? before(row.ref, row.rect.top) : after(row.ref, row.rect.bottom)
    case 'tile':
      if (rel < 0.28) return before(projectRef(row.projectId), row.rect.top)
      if (rel > 0.72) return after(projectRef(row.projectId), row.rect.bottom)
      return {
        target: { type: 'combine', projectId: row.projectId },
        feedback: { kind: 'combine', projectId: row.projectId }
      }
    case 'folder':
      if (rel < 0.22) return before(groupRef(row.groupId), row.rect.top)
      if (rel > 0.84) return after(groupRef(row.groupId), row.rect.bottom)
      return { target: { type: 'into', groupId: row.groupId }, feedback: { kind: 'into', groupId: row.groupId } }
    case 'head':
      if (rel < 0.3) return before(groupRef(row.groupId), row.capsule.top)
      return {
        target: { type: 'first-in', groupId: row.groupId },
        feedback: { kind: 'line', y: row.rect.bottom + LINE_OFFSET, inset: true }
      }
    case 'child':
      return rel < 0.5
        ? before(projectRef(row.projectId), row.rect.top, true)
        : after(projectRef(row.projectId), row.rect.bottom, true)
    case 'gend':
      return after(groupRef(row.groupId), row.capsule.bottom)
  }
}

/** O alvo vira a operação que o main aplica. Grupo só se move no nível de
 *  cima: qualquer outro alvo para um grupo é `null`. */
export function railDropOp(source: RailDragSource, target: ProjectLayoutDropTarget): ProjectLayoutOp | null {
  if (source.kind === 'project') return { op: 'moveProject', projectId: source.projectId, target }
  if (target.type !== 'before' && target.type !== 'after') return null
  return { op: 'moveGroup', groupId: source.groupId, target }
}

/** A pílula "soltar: …" (a cópia do mockup). */
export function railDropHint(
  layout: ProjectLayout,
  nameOfProject: (projectId: string) => string,
  source: RailDragSource,
  target: ProjectLayoutDropTarget
): RailDropHint {
  const groupName = (groupId: string): string => layoutGroups(layout).find((g) => g.id === groupId)?.name ?? ''
  if (target.type === 'combine') return { lead: 'soltar: ', em: 'criar grupo', tail: ` com ${nameOfProject(target.projectId)}` }
  if (target.type === 'into' || target.type === 'first-in') {
    return { lead: 'soltar: entrar em ', em: groupName(target.groupId), tail: '' }
  }
  if (source.kind === 'project') {
    const from = groupOfProject(layout, source.projectId)
    const to = target.ref.kind === 'project' ? groupOfProject(layout, target.ref.projectId) : null
    if (from && !to) return { lead: 'soltar: ', em: `sair de ${from.name}`, tail: '' }
    if (to && to.id !== from?.id) return { lead: 'soltar: entrar em ', em: to.name, tail: '' }
  }
  const name = source.kind === 'project' ? nameOfProject(source.projectId) : groupName(source.groupId)
  return { lead: `soltar: mover ${name}`, em: '', tail: '' }
}

export function railDropHintText(hint: RailDropHint): string {
  return `${hint.lead}${hint.em}${hint.tail}`
}

/** Um clique só vira arraste depois de 5 px (senão todo clique tremido
 *  reordenaria o rail). */
export function railDragStarted(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > DRAG_THRESHOLD
}

/** Rolagem automática por quadro: o ponteiro a menos de 28 px da borda da
 *  lista (ou além dela) rola 8 px para aquele lado. */
export function railAutoScrollStep(y: number, listTop: number, listBottom: number): number {
  if (y < listTop + AUTO_SCROLL_EDGE) return -AUTO_SCROLL_STEP
  if (y > listBottom - AUTO_SCROLL_EDGE) return AUTO_SCROLL_STEP
  return 0
}
