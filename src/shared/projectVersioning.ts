// PROJETO SEM VERSIONAMENTO (ordem do dono, 2026-09-30) — "se eu quero fazer
// apenas um documento, o Synkora se torna burocrático". Um projeto nasce
// VERSIONADO (o de sempre: Git, versões, mapa, worktree por missão, fila ⇪ e
// release) ou SEM VERSIONAMENTO: a missão edita a pasta do projeto direto, sem
// commit, sem versão, sem mapa, sem fila — e por não existir isolamento, UMA
// missão aberta por vez. O máximo de cerimônia é o dono FINALIZAR a missão.
//
// A modalidade é a INTENÇÃO do dono gravada no nascimento (definitiva por
// enquanto). Nunca se infere do disco: um `.git` criado à mão depois não
// transforma o projeto, e nenhum probe de Git roda num projeto sem versão.
//
// Módulo PURO e compartilhado: o main (autoridade que recusa) e o renderer
// (o que a tela mostra) leem a MESMA régua. Design:
// docs/DESIGN_PROJETO_SEM_VERSAO_2026-09-30.md

export type ProjectVersioning = 'git' | 'none'

/** Ausência = 'git': todo projeto anterior a esta modalidade é versionado. */
export function projectVersioning(
  project: { versioning?: ProjectVersioning } | null | undefined
): ProjectVersioning {
  return project?.versioning === 'none' ? 'none' : 'git'
}

export function isUnversionedProject(
  project: { versioning?: ProjectVersioning } | null | undefined
): boolean {
  return projectVersioning(project) === 'none'
}

/** Status que OCUPA a pasta. Concluída é histórico; arquivada não roda. */
const OPEN_STATUSES: ReadonlySet<string> = new Set(['ativa', 'integrando'])

/** A regra de UMA missão por vez: a missão aberta do projeto, se houver. */
export function openSoloMission<M extends { projectId: string; status: string }>(
  missions: readonly M[],
  projectId: string
): M | undefined {
  return missions.find((m) => m.projectId === projectId && OPEN_STATUSES.has(m.status))
}

/** Fotografia da pasta escolhida no modal de criação (`projects:inspectFolder`).
 *  `hasGit` trava o interruptor em "versionado" (decisão do dono: sem
 *  versionamento só em pasta SEM Git). */
export interface ProjectFolderInspection {
  exists: boolean
  hasGit: boolean
  /** vazia para fins de clone (ignora metadados do SO e pastas internas) */
  empty: boolean
}

/** O que um projeto sem versionamento NÃO tem — cada recusa nomeia a saída. */
export type UnversionedCapability =
  | 'versions'
  | 'planning'
  | 'integration'
  | 'release'
  | 'history'
  | 'review'
  | 'second-mission'
  | 'reopen'
  | 'git-folder'
  | 'git-remote'

const REFUSALS: Record<UnversionedCapability, string> = {
  versions:
    'Este projeto não é versionado: não existem versões. O trabalho acontece na missão aberta, direto na pasta.',
  planning:
    'Este projeto não é versionado: não existe mapa nem planejamento. Descreva o trabalho na missão aberta.',
  integration:
    'Este projeto não é versionado: não existe fila ⇪ nem integração. As edições já estão na pasta; quando terminar, o dono finaliza a missão.',
  release:
    'Este projeto não é versionado: não existe release. As edições já estão na pasta do projeto.',
  history:
    'Este projeto não é versionado: não existem commits nem diff contra uma base. Os cartões de edição do chat mostram o que mudou.',
  review:
    'Este projeto não é versionado: não existe diff para revisar. Peça a revisão ao dev da missão, no próprio chat.',
  'second-mission':
    'Este projeto não é versionado e já tem uma missão aberta. Finalize a missão aberta para começar outra.',
  reopen:
    'Esta missão já foi finalizada: o chat fica só para leitura. Comece uma missão nova para continuar o trabalho.',
  'git-folder':
    'Esta pasta já tem Git. Crie o projeto como versionado, ou escolha uma pasta sem Git.',
  'git-remote':
    'Projeto sem versionamento não se conecta ao GitHub. Deixe o link em branco, ou crie o projeto como versionado.'
}

export function unversionedRefusal(capability: UnversionedCapability): string {
  return REFUSALS[capability]
}

/** Resultado de `missions:finish` — o FINALIZAR do projeto sem versionamento. */
export type MissionFinishResult = { ok: true } | { ok: false; error: string }
