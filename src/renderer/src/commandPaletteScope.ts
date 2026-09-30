import type { ProjectVersioning } from '../../shared/projectVersioning'

// ————————————————————————————————————————————————————————————————————————
// O QUE A PALETA (Ctrl K) OFERECE PARA O UNIVERSO ABERTO. Num projeto sem
// versionamento não existem Mapa, Versões, commits nem branches
// (docs/DESIGN_PROJETO_SEM_VERSAO_2026-09-30.md §5): a paleta nem mostra, nem
// pede ao main o que ele recusaria. Puro: quem decide é a modalidade, lida por
// `projectVersioning()` no componente.
// ————————————————————————————————————————————————————————————————————————

export type PaletteSource = 'acoes' | 'arquivos' | 'sessoes' | 'commits' | 'branches'
export type PaletteProjectTab = 'board' | 'mapa' | 'backlog' | 'arquivos'

export interface PaletteProjectPage {
  tab: PaletteProjectTab
  title: string
  detail: string
}

const VERSIONED_PAGES: readonly PaletteProjectPage[] = [
  { tab: 'board', title: 'Board', detail: 'missões e conversas' },
  { tab: 'mapa', title: 'Mapa', detail: 'visão do universo' },
  { tab: 'backlog', title: 'Versões', detail: 'backlog e entregas' },
  { tab: 'arquivos', title: 'Arquivos', detail: 'documentos do projeto' }
]

/** As duas abas do universo sem versionamento: a missão (ou o Início, sem
 *  missão aberta) e os arquivos da pasta. */
const UNVERSIONED_PAGES: readonly PaletteProjectPage[] = [
  { tab: 'board', title: 'Missão', detail: 'a missão aberta ou o início' },
  { tab: 'arquivos', title: 'Arquivos', detail: 'documentos do projeto' }
]

const ALL_SOURCES: readonly PaletteSource[] = ['acoes', 'arquivos', 'sessoes', 'commits', 'branches']
const UNVERSIONED_SOURCES: readonly PaletteSource[] = ['acoes', 'arquivos', 'sessoes']

export interface PaletteScope {
  pages: readonly PaletteProjectPage[]
  sources: readonly PaletteSource[]
  placeholder: string
}

const VERSIONED_SCOPE: PaletteScope = {
  pages: VERSIONED_PAGES,
  sources: ALL_SOURCES,
  placeholder: 'Buscar ações, arquivos, sessões, commits e branches…'
}

const UNVERSIONED_SCOPE: PaletteScope = {
  pages: UNVERSIONED_PAGES,
  sources: UNVERSIONED_SOURCES,
  placeholder: 'Buscar ações, arquivos e sessões…'
}

/** Sem projeto aberto a paleta mostra o recorte completo, como sempre foi.
 *  Devolve sempre a MESMA referência por modalidade (entra em dependência de
 *  memo no componente). */
export function paletteScope(versioning: ProjectVersioning): PaletteScope {
  return versioning === 'none' ? UNVERSIONED_SCOPE : VERSIONED_SCOPE
}

/** Um destino para Mapa/Versões (ação registrada, alvo antigo) cai na aba da
 *  missão do universo sem versionamento em vez de abrir uma tela que não
 *  existe nele. */
export function paletteTabFor(versioning: ProjectVersioning, tab: PaletteProjectTab): PaletteProjectTab {
  return versioning === 'none' && (tab === 'mapa' || tab === 'backlog') ? 'board' : tab
}

/** A linha da missão na paleta. No modo sem versionamento o status sai na
 *  palavra da tela (aberta/finalizada); no versionado, como sempre foi. */
export function paletteMissionDetail(versioning: ProjectVersioning, status: string): string {
  if (versioning !== 'none') return `Missão · ${status}`
  return `Missão · ${status === 'concluida' ? 'finalizada' : 'aberta'}`
}
