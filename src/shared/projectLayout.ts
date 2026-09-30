// ————————————————————————————————————————————————————————————————————————
// O LAYOUT DOS UNIVERSOS — contrato compartilhado entre main, preload e
// renderer (feature "grupos", mockup aprovado pelo dono em 2026-09-29:
// docs/mockups/grupos-universos-2026-09-29.html).
//
// O layout é a ORDEM do rail: cada entrada é um universo solto ou um GRUPO
// (pasta estilo Discord, com nome à la iPhone e cor opcional). Ele mora num
// arquivo próprio (`project-layout.json`) — `projects.json` não muda de
// formato (R-12 de main/projects.ts: aquele store não ganha validador).
//
// Quem MUDA o layout é só o main (`applyProjectLayoutOp` em
// ./projectLayoutOps): o renderer pede uma operação e recebe o layout novo
// por broadcast. Este arquivo é vocabulário + CONSULTAS puras (rail e Home
// leem o layout pelas mesmas funções) — nenhum import de runtime.
// ————————————————————————————————————————————————————————————————————————

/** Matizes fechadas da cor de grupo (mesma régua HSL do resto da casa).
 *  `null` = neutra, o padrão. Valor fora da lista cai em neutra na leitura. */
export const PROJECT_GROUP_HUES = [21, 48, 145, 190, 210, 285, 315] as const
export type ProjectGroupHue = (typeof PROJECT_GROUP_HUES)[number]

/** Teto do nome do grupo (cabe sob a pasta do rail com reticências). */
export const PROJECT_GROUP_NAME_MAX = 24

export interface ProjectLayoutProjectEntry {
  kind: 'project'
  projectId: string
}

export interface ProjectLayoutGroupEntry {
  kind: 'group'
  id: string
  name: string
  hue: ProjectGroupHue | null
  /** aberto no rail (cápsula) ou fechado (pasta 2×2) */
  open: boolean
  /** nunca vazio depois de uma operação — grupo vazio some (Discord/iPhone);
   *  grupo com UM universo continua existindo */
  projectIds: string[]
}

export type ProjectLayoutEntry = ProjectLayoutProjectEntry | ProjectLayoutGroupEntry

export interface ProjectLayout {
  entries: ProjectLayoutEntry[]
  /** ISO da última vez que o dono ABRIU cada universo — a ordem "abertos por
   *  último" da Home. É o único carimbo honesto de uso: `Mission.updatedAt` é
   *  mutação de store, nunca atividade. */
  lastOpenedAt: Record<string, string>
}

export type ProjectLayoutRef =
  | { kind: 'project'; projectId: string }
  | { kind: 'group'; groupId: string }

/** Onde um universo arrastado cai. `ref` pode ser um universo de dentro de um
 *  grupo (reordena lá dentro / entra naquele grupo) ou do nível de cima. */
export type ProjectLayoutDropTarget =
  | { type: 'before' | 'after'; ref: ProjectLayoutRef }
  /** soltar no CENTRO de um universo solto: nasce um grupo com os dois */
  | { type: 'combine'; projectId: string }
  /** soltar no centro de uma pasta fechada: entra no fim do grupo */
  | { type: 'into'; groupId: string }
  /** soltar logo abaixo do topo de uma cápsula aberta: entra no começo */
  | { type: 'first-in'; groupId: string }

export type ProjectLayoutOp =
  | { op: 'moveProject'; projectId: string; target: ProjectLayoutDropTarget }
  /** grupo só se move no nível de cima (sem grupo dentro de grupo) */
  | { op: 'moveGroup'; groupId: string; target: { type: 'before' | 'after'; ref: ProjectLayoutRef } }
  /** "+ novo grupo" do menu: grupo com UM universo, no lugar dele */
  | { op: 'createGroup'; projectId: string }
  | { op: 'moveToGroup'; projectId: string; groupId: string }
  /** sai do grupo e fica logo depois dele, no nível de cima */
  | { op: 'removeFromGroup'; projectId: string }
  | { op: 'renameGroup'; groupId: string; name: string }
  | { op: 'setGroupHue'; groupId: string; hue: ProjectGroupHue | null }
  | { op: 'setGroupOpen'; groupId: string; open: boolean }
  /** os universos ficam soltos NO MESMO LUGAR, na ordem do grupo */
  | { op: 'dissolveGroup'; groupId: string }
  | { op: 'touchOpened'; projectId: string; at: string }

export interface ProjectLayoutOpResult {
  layout: ProjectLayout
  /** preenchido quando a operação criou um grupo (combine / createGroup) —
   *  a UI abre a folha de nome já com o texto selecionado */
  createdGroupId?: string
}

/** Os grupos, na ordem do rail. */
export function layoutGroups(layout: ProjectLayout): ProjectLayoutGroupEntry[] {
  return layout.entries.filter((e): e is ProjectLayoutGroupEntry => e.kind === 'group')
}

/** A ordem do rail achatada: soltos e os de dentro dos grupos, de cima a baixo. */
export function projectLayoutOrder(layout: ProjectLayout): string[] {
  return layout.entries.flatMap((e) => (e.kind === 'project' ? [e.projectId] : e.projectIds))
}

/** O grupo que contém o universo, ou null quando ele está solto. */
export function groupOfProject(layout: ProjectLayout, projectId: string): ProjectLayoutGroupEntry | null {
  return layoutGroups(layout).find((g) => g.projectIds.includes(projectId)) ?? null
}
