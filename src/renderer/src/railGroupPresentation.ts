import type { ProjectGroupHue, ProjectLayout, ProjectLayoutEntry } from '../../shared/projectLayout'
import type { ProjectMissionActivity } from './projectMissionActivity'

// ————————————————————————————————————————————————————————————————————————
// A APRESENTAÇÃO DO RAIL COM GRUPOS (missão "Nova features de Grupos",
// 2026-09-29; mockup aprovado: docs/mockups/grupos-universos-2026-09-29.html).
//
// Puro: nenhum store, nenhum DOM. O rail pergunta aqui O QUE desenhar (as
// entradas, as miniaturas da pasta, o sinal agregado, as dicas) e desenha;
// scripts/test-rail-groups.mjs prova cada regra.
// ————————————————————————————————————————————————————————————————————————

/** O estado de UM universo que conta para o sinal da pasta (o mesmo que o
 *  tile solto mostra: atenção, atividade de missão, pasta sumida). */
export interface RailMemberState {
  attention: boolean
  activity: ProjectMissionActivity
  missing: boolean
}

export type RailFolderSignal = 'attention' | 'running' | 'paused' | 'missing' | null

/** A pasta fechada: até 4 universos, todas as miniaturas; com mais, 3 e um
 *  `+N` (a geometria do Discord medida no recorte do dono). */
export function railFolderMinis(projectIds: readonly string[]): { ids: string[]; more: number } {
  if (projectIds.length <= 4) return { ids: [...projectIds], more: 0 }
  return { ids: projectIds.slice(0, 3), more: projectIds.length - 3 }
}

/** O sinal agregado da pasta: atenção > rodando > pausado > pasta sumida.
 *  Como no tile, um universo de pasta sumida não pulsa nem mostra atividade —
 *  só conta como "sumida". */
export function railFolderSignal(members: readonly RailMemberState[]): RailFolderSignal {
  let best: RailFolderSignal = null
  const rank = (signal: RailFolderSignal): number =>
    signal === 'attention' ? 4 : signal === 'running' ? 3 : signal === 'paused' ? 2 : signal === 'missing' ? 1 : 0
  for (const member of members) {
    const signal: RailFolderSignal = member.missing
      ? 'missing'
      : member.attention
        ? 'attention'
        : member.activity
    if (rank(signal) > rank(best)) best = signal
  }
  return best
}

/** Pasta FECHADA que guarda o universo aberto: ganha a pílula (e a miniatura
 *  dele, o anel). */
export function railFolderHoldsActive(projectIds: readonly string[], activeProjectId: string | null): boolean {
  return activeProjectId !== null && projectIds.includes(activeProjectId)
}

/**
 * O que o rail desenha. Sem layout (ainda não chegou do main) é a lista plana
 * de `projects`, como sempre foi. Com layout, o rail confia nele mas nunca
 * mostra fantasma nem esconde universo: id que o renderer não conhece sai,
 * repetido sai (vence o primeiro), grupo que fica sem ninguém some, e o
 * universo que ainda não entrou no layout (o broadcast vem logo depois) aparece
 * solto no fim. É uma VISTA — quem muda o layout continua sendo só o main.
 * Entrada intacta mantém a referência (o React não redesenha à toa).
 */
export function railEntries(layout: ProjectLayout | null, projectIds: readonly string[]): ProjectLayoutEntry[] {
  const known = new Set(projectIds)
  const placed = new Set<string>()
  const out: ProjectLayoutEntry[] = []
  for (const entry of layout ? layout.entries : []) {
    if (entry.kind === 'project') {
      if (!known.has(entry.projectId) || placed.has(entry.projectId)) continue
      placed.add(entry.projectId)
      out.push(entry)
      continue
    }
    const ids = entry.projectIds.filter((id) => known.has(id) && !placed.has(id))
    for (const id of ids) placed.add(id)
    if (ids.length === 0) continue
    out.push(ids.length === entry.projectIds.length ? entry : { ...entry, projectIds: ids })
  }
  for (const id of projectIds) {
    if (!placed.has(id)) out.push({ kind: 'project', projectId: id })
  }
  return out
}

/** Quantos nós a lista desenha (tiles, cabeçalhos, nomes sob a pasta) — é o
 *  que faz as bordas esmaecidas re-medirem quando o conteúdo cresce sem a
 *  caixa da lista mudar de tamanho. */
export function railRenderedCount(entries: readonly ProjectLayoutEntry[], showNames: boolean): number {
  let count = 0
  for (const entry of entries) {
    if (entry.kind === 'project') {
      count += 1
      continue
    }
    count += 1 + (showNames ? 1 : 0) + (entry.open ? entry.projectIds.length : 0)
  }
  return count
}

/** A dica do universo: nome e estado (a linha "clique direito: definir foto"
 *  saiu — o clique direito agora abre o menu, que se explica sozinho). */
export function railProjectTip(input: {
  name: string
  missing: boolean
  attention: boolean
  activityLabel: string
}): string {
  if (input.missing) return `${input.name}\npasta não encontrada — corrija na Home (📁 alterar pasta)`
  return `${input.name}\n${input.activityLabel}${input.attention ? '\n❓ um agente está esperando você aqui' : ''}`
}

/** A linha de membros da folha do grupo: "3 universos · A, B, C". */
export function railGroupMembersLine(names: readonly string[]): string {
  return `${names.length} ${names.length === 1 ? 'universo' : 'universos'} · ${names.join(', ')}`
}

const HUE_LABELS: Record<ProjectGroupHue, string> = {
  21: 'laranja',
  48: 'amarelo',
  145: 'verde',
  190: 'ciano',
  210: 'azul',
  285: 'violeta',
  315: 'magenta'
}

/** O nome falado de cada cor do grupo (o leitor de tela não lê um matiz). */
export function railGroupHueLabel(hue: ProjectGroupHue | null): string {
  return hue === null ? 'neutra' : HUE_LABELS[hue]
}
