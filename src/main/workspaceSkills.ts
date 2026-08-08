import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const MANAGED_WORKSPACE_SKILL_MARKER = '.synkora-managed-skill.json'
export const MANAGED_WORKSPACE_AGENT_MARKER_SUFFIX = '.synkora-managed-agent.json'

const SAFE_RUNTIME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/

/** Materializa a árvore completa fora das roots autodetectadas pelos CLIs. */
export function materializePrivateSkillPackage(
  source: string,
  runtimeRootInput: string,
  paneId: string,
  phaseRun: string,
  id: string,
  adapterContent?: string
): string {
  if (
    !SAFE_RUNTIME_SEGMENT.test(paneId) ||
    !SAFE_RUNTIME_SEGMENT.test(phaseRun) ||
    !SAFE_RUNTIME_SEGMENT.test(id)
  ) {
    throw new Error('identidade inválida para pacote privado de skill')
  }
  if (!existsSync(source) || !statSync(source).isDirectory()) {
    throw new Error('fonte do pacote privado não existe')
  }
  const runtimeRoot = resolve(runtimeRootInput)
  const paneRoot = resolve(runtimeRoot, paneId)
  const generationRoot = resolve(paneRoot, phaseRun)
  const destination = resolve(generationRoot, id)
  if (
    !paneRoot.startsWith(runtimeRoot + sep) ||
    !generationRoot.startsWith(paneRoot + sep) ||
    !destination.startsWith(generationRoot + sep)
  ) {
    throw new Error('destino do pacote privado escapou da raiz')
  }
  const staging = resolve(generationRoot, `.staging-${id}`)
  mkdirSync(generationRoot, { recursive: true })
  rmSync(staging, { recursive: true, force: true })
  try {
    if (adapterContent !== undefined) {
      mkdirSync(staging, { recursive: true })
      writeFileSync(join(staging, 'SKILL.md'), adapterContent, 'utf8')
    } else {
      cpSync(source, staging, { recursive: true })
    }
    rmSync(destination, { recursive: true, force: true })
    renameSync(staging, destination)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  return destination.replace(/\\/g, '/')
}

function removeEmptyPrivateSkillParent(path: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) return
  if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true })
}

/** Remove uma skill, uma geração ou todo o pane, sem atingir vizinhos válidos. */
export function removePrivateSkillPlan(
  runtimeRootInput: string,
  paneId: string,
  phaseRun?: string,
  skillId?: string
): boolean {
  if (
    !SAFE_RUNTIME_SEGMENT.test(paneId) ||
    (phaseRun !== undefined && !SAFE_RUNTIME_SEGMENT.test(phaseRun)) ||
    (skillId !== undefined && !SAFE_RUNTIME_SEGMENT.test(skillId)) ||
    (skillId !== undefined && phaseRun === undefined)
  ) return false
  const runtimeRoot = resolve(runtimeRootInput)
  const paneRoot = resolve(runtimeRoot, paneId)
  if (!paneRoot.startsWith(runtimeRoot + sep)) return false
  if (phaseRun === undefined) {
    rmSync(paneRoot, { recursive: true, force: true })
    return true
  }
  const generationRoot = resolve(paneRoot, phaseRun)
  if (!generationRoot.startsWith(paneRoot + sep)) return false
  if (skillId === undefined) {
    rmSync(generationRoot, { recursive: true, force: true })
    removeEmptyPrivateSkillParent(paneRoot)
    return true
  }
  const skillRoot = resolve(generationRoot, skillId)
  if (!skillRoot.startsWith(generationRoot + sep)) return false
  rmSync(skillRoot, { recursive: true, force: true })
  rmSync(resolve(generationRoot, `.staging-${skillId}`), {
    recursive: true,
    force: true
  })
  removeEmptyPrivateSkillParent(generationRoot)
  removeEmptyPrivateSkillParent(paneRoot)
  return true
}

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
  return pruneUnrequestedManagedWorkspaceSkills(skillRoots, installedIds)
}

/**
 * Materializa o conjunto EXATO pedido pelos panes vivos. O nome antigo falava
 * apenas em desinstalacao, mas a fronteira correta e a lease ativa: uma skill
 * instalada e nao selecionada tambem nao deve permanecer visivel ao modelo.
 */
export function pruneUnrequestedManagedWorkspaceSkills(
  skillRoots: string[],
  activeIds: ReadonlySet<string>
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
      if (markedId !== entry.name || activeIds.has(markedId)) continue
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

function managedWorkspaceAgentMarkerPath(destination: string): string {
  return `${destination}${MANAGED_WORKSPACE_AGENT_MARKER_SUFFIX}`
}

function managedWorkspaceAgentMarker(
  destination: string
): { id: string; version?: string; contentSha?: string } | undefined {
  try {
    const value = JSON.parse(
      readFileSync(managedWorkspaceAgentMarkerPath(destination), 'utf8')
    ) as { managedBy?: unknown; id?: unknown; version?: unknown; contentSha?: unknown }
    if (value.managedBy !== 'synkora' || typeof value.id !== 'string') return undefined
    return {
      id: value.id,
      version: typeof value.version === 'string' ? value.version : undefined,
      contentSha: typeof value.contentSha === 'string' ? value.contentSha : undefined
    }
  } catch {
    return undefined
  }
}

function fileContentSha(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Preserva um agent local homonimo; copia antiga sem marcador so e adotada
 * quando ainda e byte a byte igual a biblioteca do Synkora. */
export function syncManagedWorkspaceAgentCopy(
  source: string,
  destination: string,
  id: string,
  version?: string
): boolean {
  if (!existsSync(source)) return false
  if (existsSync(destination)) {
    const markerPath = managedWorkspaceAgentMarkerPath(destination)
    const marker = managedWorkspaceAgentMarker(destination)
    if (existsSync(markerPath)) {
      if (marker?.id !== id) return false
      const destinationSha = fileContentSha(destination)
      // Marcador novo prova que o arquivo permaneceu intocado. Marcador
      // legado só é adotado se os bytes ainda coincidem com a fonte atual.
      if (
        marker.contentSha
          ? marker.contentSha !== destinationSha
          : !directoryTreesEqual(source, destination)
      ) {
        return false
      }
    } else if (!directoryTreesEqual(source, destination)) {
      return false
    }
    if (
      marker?.id === id &&
      marker.version === version &&
      directoryTreesEqual(source, destination)
    ) {
      return true
    }
  }
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination)
  writeFileSync(
    managedWorkspaceAgentMarkerPath(destination),
    `${JSON.stringify({
      managedBy: 'synkora',
      id,
      ...(version ? { version } : {}),
      contentSha: fileContentSha(destination)
    })}\n`,
    'utf8'
  )
  return true
}

/** Remove apenas agents com recibo de propriedade Synkora. Tambem reconhece
 * copias legadas quando uma fonte da biblioteca foi fornecida e os bytes ainda
 * coincidem; qualquer arquivo local divergente permanece intocado. */
export function pruneUnrequestedManagedWorkspaceAgents(
  agentRoot: string,
  activeIds: ReadonlySet<string>,
  librarySources: Readonly<Record<string, string>> = {}
): string[] {
  const removed: string[] = []
  let entries
  try {
    entries = readdirSync(agentRoot, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(MANAGED_WORKSPACE_AGENT_MARKER_SUFFIX)) continue
    const destinationName = entry.name.slice(0, -MANAGED_WORKSPACE_AGENT_MARKER_SUFFIX.length)
    const destination = join(agentRoot, destinationName)
    if (existsSync(destination)) continue
    const marker = managedWorkspaceAgentMarker(destination)
    const id = destinationName.endsWith('.md') ? destinationName.slice(0, -3) : ''
    if (id && marker?.id === id) {
      try {
        rmSync(join(agentRoot, entry.name), { force: true })
      } catch {
        // best effort
      }
    }
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const id = entry.name.slice(0, -3)
    if (!id || activeIds.has(id)) continue
    const destination = join(agentRoot, entry.name)
    const marker = managedWorkspaceAgentMarker(destination)
    const legacySource = librarySources[id]
    const destinationSha = fileContentSha(destination)
    const owned =
      (marker?.id === id &&
        (marker.contentSha
          ? marker.contentSha === destinationSha
          : Boolean(legacySource && directoryTreesEqual(legacySource, destination)))) ||
      Boolean(!marker && legacySource && directoryTreesEqual(legacySource, destination))
    if (!owned) continue
    try {
      rmSync(destination, { force: true })
      rmSync(managedWorkspaceAgentMarkerPath(destination), { force: true })
      removed.push(id)
    } catch {
      // best effort; o proximo sync tenta novamente
    }
  }
  return removed
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
