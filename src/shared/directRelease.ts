// RELEASE DIRETA (ordem do dono, 2026-09-28) — "se eu quero arrumar algo
// rápido, tenho que criar uma missão e depois ir para release". A release
// passa a nascer DIRETO do modal de missão nova, sem missão antes, em dois
// destinos:
//
// - a versão ATUAL (a lançada mais recente, a que está na main). É a ÚNICA
//   coisa que pode nascer nela: missão nunca entra em versão lançada. A
//   correção vai direto na pasta do projeto, sem número novo (fase
//   after-release do release_save/release_push);
// - uma versão NÃO LANÇADA (aberta ou criada no mesmo gesto). A branch da
//   versão nasce na hora e a subida gera o número.
//
// Módulo PURO e compartilhado: o main (autoridade que cria) e o renderer
// (cardápio do modal) leem a MESMA régua — nunca uma cópia de cada lado.

export interface DirectReleaseVersion {
  id: string
  name: string
  status: 'aberta' | 'lancada'
  releasedAt?: string
  updatedAt?: string
}

/** Onde a release direta pode nascer. `current` = a versão na main. */
export type DirectReleaseTargetKind = 'current' | 'open'

export interface DirectReleaseTarget {
  kind: DirectReleaseTargetKind
  versionId: string
  name: string
}

/** O pedido do modal: título (o que corrigir) e UM destino — uma versão que já
 *  existe (`versionId`) ou uma nova criada no mesmo gesto (`newVersionName`). */
export type DirectReleaseInput =
  | { title: string; versionId: string; newVersionName?: never }
  | { title: string; newVersionName: string; versionId?: never }

export type DirectReleaseResult =
  | { ok: true; missionId: string; versionId: string; created: boolean }
  | { ok: false; error: string }

export const DIRECT_RELEASE_TITLE_MAX = 200

/**
 * A versão ATUAL na main: a lançada mais recente. Uma régua só para a tela e
 * para o main — `releasedAt` é o carimbo da subida; `updatedAt` só desempata
 * registro antigo que nasceu sem ele.
 */
export function currentReleasedVersion<T extends DirectReleaseVersion>(
  versions: readonly T[]
): T | undefined {
  const stamp = (version: T): string => version.releasedAt ?? version.updatedAt ?? ''
  return versions
    .filter((version) => version.status === 'lancada')
    .reduce<T | undefined>(
      (latest, version) => (!latest || stamp(version).localeCompare(stamp(latest)) > 0 ? version : latest),
      undefined
    )
}

/** O cardápio de destinos já existentes: a atual primeiro (a jogada), depois
 *  as abertas na ordem em que chegaram. Versão nova entra pelo modal. */
export function directReleaseTargets(
  versions: readonly DirectReleaseVersion[]
): DirectReleaseTarget[] {
  const current = currentReleasedVersion(versions)
  return [
    ...(current ? [{ kind: 'current' as const, versionId: current.id, name: current.name }] : []),
    ...versions
      .filter((version) => version.status === 'aberta')
      .map((version) => ({ kind: 'open' as const, versionId: version.id, name: version.name }))
  ]
}

/** Forma do pedido — a recusa diz o que corrigir. O main ainda confere a
 *  versão (existe, é deste projeto, é a atual ou está aberta). */
export function directReleaseInputError(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return 'pedido de release inválido'
  const raw = input as Record<string, unknown>
  if (typeof raw.title !== 'string' || !raw.title.trim())
    return 'escreva o que esta release vai corrigir'
  if (raw.title.length > DIRECT_RELEASE_TITLE_MAX)
    return `o título passa de ${DIRECT_RELEASE_TITLE_MAX} caracteres`
  const hasVersion = typeof raw.versionId === 'string' && raw.versionId.length > 0
  const hasNew = typeof raw.newVersionName === 'string' && raw.newVersionName.trim().length > 0
  if (hasVersion === hasNew)
    return 'escolha UM destino: a versão atual, uma versão aberta ou uma versão nova'
  return undefined
}
