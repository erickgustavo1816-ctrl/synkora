import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export const MANAGED_WORKSPACE_SKILL_MARKER = '.synkora-managed-skill.json'

function managedWorkspaceSkillMarker(
  destination: string
): { id: string; version?: string } | undefined {
  const marker = join(destination, MANAGED_WORKSPACE_SKILL_MARKER)
  if (!existsSync(marker)) return undefined
  try {
    const value = JSON.parse(readFileSync(marker, 'utf8')) as {
      managedBy?: unknown
      id?: unknown
      version?: unknown
    }
    if (value.managedBy !== 'synkora' || typeof value.id !== 'string') return undefined
    return {
      id: value.id,
      version: typeof value.version === 'string' ? value.version : undefined
    }
  } catch {
    return undefined
  }
}

function managedWorkspaceSkillId(destination: string): string | undefined {
  return managedWorkspaceSkillMarker(destination)?.id
}

/**
 * Uma pasta com marcador válido pertence ao Synkora. Cópias antigas, anteriores
 * ao marcador, só são consideradas gerenciadas quando ainda coincidem byte a
 * byte com a biblioteca; qualquer outra pasta é conteúdo local do projeto.
 */
export function isManagedWorkspaceSkillCopy(
  source: string,
  destination: string,
  id: string
): boolean {
  if (!existsSync(destination)) return false
  const marker = join(destination, MANAGED_WORKSPACE_SKILL_MARKER)
  const markedId = managedWorkspaceSkillId(destination)
  if (existsSync(marker)) return markedId === id
  return directoryTreesEqual(source, destination)
}

/**
 * Faz preflight de todos os runtimes antes de tocar no disco. Se Claude ou
 * Codex já tiver uma skill local com o mesmo id, preservamos ambos os destinos
 * e deixamos o chamador reportar a skill como ausente por colisão.
 */
export function syncManagedWorkspaceSkillCopies(
  source: string,
  destinations: string[],
  id: string,
  version?: string,
  verifyContents = false
): boolean {
  const collision = destinations.some(
    (destination) =>
      existsSync(destination) && !isManagedWorkspaceSkillCopy(source, destination, id)
  )
  if (collision) return false

  for (const destination of destinations) {
    // Curto-circuito incremental (stall de spawn medido em 2026-08-04: rm+cp
    // de dezenas de skills ×2 destinos em TODO spawn): cópia gerenciada com o
    // MESMO id e a MESMA versão instalada não é reescrita. Atualizar/
    // reinstalar muda o sha → marcador diverge → recópia normal.
    if (version) {
      const marker = managedWorkspaceSkillMarker(destination)
      if (
        marker?.id === id &&
        marker.version === version &&
        existsSync(join(destination, 'SKILL.md')) &&
        (!verifyContents || managedWorkspaceSkillContentsMatch(source, destination))
      ) {
        continue
      }
    }
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true })
    writeFileSync(
      join(destination, MANAGED_WORKSPACE_SKILL_MARKER),
      `${JSON.stringify({ managedBy: 'synkora', id, ...(version ? { version } : {}) })}\n`,
      'utf8'
    )
  }
  return true
}

/** Compara toda a árvore ignorando apenas o marcador gerenciado do destino. */
export function managedWorkspaceSkillContentsMatch(source: string, destination: string): boolean {
  return directoryTreesEqual(source, destination)
}

/**
 * Remove somente pastas que carregam um marcador Synkora válido, cujo id
 * coincide com o nome da pasta e que já não estão instaladas na biblioteca.
 * Pastas locais, symlinks e marcadores inválidos ficam intocados.
 */
export function pruneUninstalledManagedWorkspaceSkills(
  skillRoots: string[],
  installedIds: ReadonlySet<string>
): string[] {
  const removed = new Set<string>()
  for (const root of skillRoots) {
    let entries
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const destination = join(root, entry.name)
      const markedId = managedWorkspaceSkillId(destination)
      if (markedId !== entry.name || installedIds.has(markedId)) continue
      try {
        rmSync(destination, { recursive: true, force: true })
        removed.add(markedId)
      } catch {
        // Limpeza best-effort: nunca bloqueia a injeção pedida.
      }
    }
  }
  return [...removed]
}

export interface WorkspaceSkillLease {
  cwd: string
  workspaceKey: string
  ids: string[]
}

/** Registro síncrono das skills temporárias usadas por panes que compartilham
 *  um workspace. A união impede que uma sincronização pode a skill de outro
 *  pane ainda vivo; ao liberar o dono, o chamador ressincroniza o restante. */
export class WorkspaceSkillLeaseRegistry {
  private readonly leases = new Map<string, WorkspaceSkillLease>()

  acquire(ownerId: string, lease: WorkspaceSkillLease): void {
    this.leases.set(ownerId, {
      ...lease,
      ids: [...new Set(lease.ids)]
    })
  }

  release(ownerId: string): WorkspaceSkillLease | undefined {
    const released = this.leases.get(ownerId)
    if (released) this.leases.delete(ownerId)
    return released
  }

  activeIds(workspaceKey: string): string[] {
    return [
      ...new Set(
        [...this.leases.values()]
          .filter((lease) => lease.workspaceKey === workspaceKey)
          .flatMap((lease) => lease.ids)
      )
    ]
  }
}

function directoryTreesEqual(left: string, right: string): boolean {
  if (!existsSync(left) || !existsSync(right)) return false
  const leftStat = statSync(left)
  const rightStat = statSync(right)
  if (leftStat.isDirectory() !== rightStat.isDirectory()) return false
  if (!leftStat.isDirectory()) {
    if (leftStat.size !== rightStat.size) return false
    return readFileSync(left).equals(readFileSync(right))
  }
  const leftEntries = readdirSync(left).sort()
  const rightEntries = readdirSync(right)
    .filter((entry) => entry !== MANAGED_WORKSPACE_SKILL_MARKER)
    .sort()
  if (leftEntries.length !== rightEntries.length) return false
  for (let index = 0; index < leftEntries.length; index++) {
    if (leftEntries[index] !== rightEntries[index]) return false
    if (!directoryTreesEqual(join(left, leftEntries[index]), join(right, rightEntries[index]))) {
      return false
    }
  }
  return true
}
