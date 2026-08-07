import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { loadJsonStore, persistJsonStore } from './jsonStore'

// BACKLOG DE PRODUTO (F3.9 redesenhada): versões são CONTAINERS DE
// PLANEJAMENTO (v1.0 "MVP"…) e itens são as mudanças desejadas. O fluxo:
// despejar ideias → organizar em versões → selecionar itens → virar MISSÃO
// (goal nasce dos itens; integração marca os itens como feitos).

export type VersionStatus = 'aberta' | 'lancada'
export type BacklogItemType = 'feature' | 'bug' | 'melhoria'
export type BacklogItemStatus = 'pendente' | 'em-missao' | 'feito'

/** Entrega REGISTRADA AUTOMATICAMENTE: missão da versão integrou na base. */
export interface VersionDelivery {
  id: string
  missionId: string
  /** título da missão integrada */
  title: string
  at: string
}

export interface Version {
  id: string
  projectId: string
  /** nome curto (ex.: v1.0) */
  name: string
  /** tema da versão (ex.: MVP, Polimento) */
  theme?: string
  /** objetivo em poucas frases */
  goal?: string
  status: VersionStatus
  /** quando foi marcada como lançada (a mais recente = versão ATUAL na main) */
  releasedAt?: string
  /** o que JÁ SUBIU nesta versão (missões integradas — automático) */
  deliveries: VersionDelivery[]
  /** branch version/<nome> onde as missões da versão acumulam (até o release) */
  branch?: string
  /** worktree da branch da versão (alvo dos merges das missões) */
  worktree?: string
  createdAt: string
  updatedAt: string
}

export interface BacklogItem {
  id: string
  projectId: string
  /** versão dona — ausente = caixa "sem versão" (ideias soltas) */
  versionId?: string
  type: BacklogItemType
  title: string
  notes?: string
  status: BacklogItemStatus
  /** missão que assumiu este item (status em-missao/feito) */
  missionId?: string
  createdAt: string
  updatedAt: string
}

/** "V1.2.3" / "v1.2" / "1.3" → [major, minor, patch]; sem padrão → null. */
export function parseVersionName(name: string): [number, number, number] | null {
  const m = name.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/i)
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null
}

export function cmpVersionTriples(
  a: [number, number, number],
  b: [number, number, number]
): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export class BacklogStore {
  private readonly file: string
  private data: { versions: Version[]; items: BacklogItem[] } = { versions: [], items: [] }

  constructor(file = join(app.getPath('userData'), 'backlog.json')) {
    this.file = file
    this.data = loadJsonStore(
      this.file,
      () => ({ versions: [], items: [] }),
      (value): value is typeof this.data => {
        if (typeof value !== 'object' || value === null) return false
        const candidate = value as Partial<typeof this.data>
        return Array.isArray(candidate.versions) && Array.isArray(candidate.items)
      }
    )
    // migração leve: versões antigas não tinham deliveries
    for (const v of this.data.versions) v.deliveries = v.deliveries ?? []
    // migração: a caixa "SEM VERSÃO" MORREU (confundia — o mesmo trabalho
    // aparecia riscado em "sem versão" E como entrega na versão). Item
    // FEITO sem versão some (o registro real é a entrega da missão na
    // versão); item ABERTO sem versão (ou preso em versão já lançada)
    // vai para a versão corrente.
    this.data.items = this.data.items.filter((i) => !(i.status === 'feito' && !i.versionId))
    for (const i of this.data.items) {
      if (i.status === 'feito') continue
      const v = i.versionId
        ? this.data.versions.find((x) => x.id === i.versionId)
        : undefined
      if (!v || v.status === 'lancada') {
        i.versionId = this.ensureDefaultVersion(i.projectId).id
        i.updatedAt = new Date().toISOString()
      }
    }
  }

  private persist(): void {
    persistJsonStore(this.file, this.data)
  }

  listVersions(projectId: string): Version[] {
    return this.data.versions.filter((v) => v.projectId === projectId)
  }

  createVersion(projectId: string, input: { name: string; theme?: string; goal?: string }): Version {
    const now = new Date().toISOString()
    const version: Version = {
      id: randomUUID(),
      projectId,
      name: input.name,
      theme: input.theme,
      goal: input.goal,
      status: 'aberta',
      deliveries: [],
      createdAt: now,
      updatedAt: now
    }
    this.data.versions.push(version)
    this.persist()
    return version
  }

  updateVersion(
    id: string,
    patch: Partial<Pick<Version, 'name' | 'theme' | 'goal' | 'status'>>
  ): Version | undefined {
    const version = this.data.versions.find((v) => v.id === id)
    if (!version) return undefined
    // lançar carimba releasedAt — a lançada mais recente é a ATUAL na main
    if (patch.status === 'lancada' && version.status !== 'lancada') {
      version.releasedAt = new Date().toISOString()
    }
    Object.assign(version, patch, { updatedAt: new Date().toISOString() })
    this.persist()
    return version
  }

  getVersion(id: string): Version | undefined {
    return this.data.versions.find((v) => v.id === id)
  }

  /** null = pode criar; string = motivo da recusa. Regras (decisão do
   *  usuário): nome duplicado nunca; e se a main já está na X, criar uma
   *  versão numericamente INFERIOR ou igual a X não faz sentido. */
  validateVersionName(
    projectId: string,
    name: string,
    excludeVersionId?: string
  ): string | null {
    const trimmed = name.trim()
    if (!trimmed) return 'nome vazio'
    if (
      this.listVersions(projectId).some(
        (v) =>
          v.id !== excludeVersionId &&
          v.name.toLocaleLowerCase('pt-BR') === trimmed.toLocaleLowerCase('pt-BR')
      )
    )
      return `a versão ${trimmed} já existe`
    const p = parseVersionName(trimmed)
    const released = this.listVersions(projectId)
      .filter((v) => v.status === 'lancada')
      .map((v) => ({ v, p: parseVersionName(v.name) }))
      .filter((x): x is { v: Version; p: [number, number, number] } => x.p != null)
      .sort((a, b) => cmpVersionTriples(b.p, a.p))[0]
    if (p && released && cmpVersionTriples(p, released.p) <= 0)
      return `a main já está na ${released.v.name} — ${trimmed} seria uma versão inferior`
    return null
  }

  validateNewVersion(projectId: string, name: string): string | null {
    return this.validateVersionName(projectId, name)
  }

  /** Versão CORRENTE do projeto (decisão do usuário, 2026-07-23): sem versão
   *  explícita, toda missão cai na versão aberta mais antiga; sem nenhuma
   *  aberta, nasce a próxima automaticamente — "V1.0", ou o minor seguinte
   *  da última lançada ("V1.0" lançada → "V1.1"). */
  ensureDefaultVersion(projectId: string): Version {
    const open = this.listVersions(projectId)
      .filter((v) => v.status === 'aberta')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    if (open[0]) return open[0]
    const released = this.listVersions(projectId).filter((v) => v.status === 'lancada')
    const highestNumeric = released
      .map((version) => ({ version, parsed: parseVersionName(version.name) }))
      .filter(
        (entry): entry is { version: Version; parsed: [number, number, number] } =>
          entry.parsed !== null
      )
      .sort((left, right) => cmpVersionTriples(right.parsed, left.parsed))[0]

    // A versão automática segue a MAIOR versão numérica histórica, não apenas
    // a lançada mais recentemente (que pode ter nome legado ou ter sido
    // publicada fora de ordem). Assim este caminho nunca contorna as mesmas
    // regras de unicidade/monotonicidade aplicadas à UI e ao rename.
    const prefix = highestNumeric
      ? (highestNumeric.version.name.trim().match(/^v/i)?.[0] ?? '')
      : 'V'
    const major = highestNumeric?.parsed[0] ?? 1
    let minor = highestNumeric ? highestNumeric.parsed[1] + 1 : 0
    let name = `${prefix}${major}.${minor}`
    while (this.validateVersionName(projectId, name)) {
      minor += 1
      name = `${prefix}${major}.${minor}`
    }
    return this.createVersion(projectId, { name })
  }

  /** Registra (ou limpa, com undefined) a branch/worktree da versão. */
  setVersionBranch(id: string, branch?: string, worktree?: string): void {
    const version = this.data.versions.find((v) => v.id === id)
    if (!version) return
    version.branch = branch
    version.worktree = worktree
    version.updatedAt = new Date().toISOString()
    this.persist()
  }

  /**
   * Commit lógico único do release: nunca persiste o estado intermediário
   * "aberta, mas sem branch/worktree". Isso torna uma queda entre o cleanup
   * Git e a atualização do backlog inteiramente reconciliável pelo intent.
   */
  markVersionReleased(id: string): Version | undefined {
    const version = this.data.versions.find((v) => v.id === id)
    if (!version) return undefined
    const now = new Date().toISOString()
    if (version.status !== 'lancada') version.releasedAt = now
    version.status = 'lancada'
    version.branch = undefined
    version.worktree = undefined
    version.updatedAt = now
    this.persist()
    return version
  }

  /** Missão da versão INTEGROU na branch da versão → entrega registrada. */
  addDelivery(versionId: string, missionId: string, title: string): Version | undefined {
    const version = this.data.versions.find((v) => v.id === versionId)
    if (!version) return undefined
    // idempotente: reintegração da mesma missão não duplica a entrega
    if (version.deliveries.some((d) => d.missionId === missionId)) return version
    version.deliveries.push({
      id: randomUUID(),
      missionId,
      title,
      at: new Date().toISOString()
    })
    version.updatedAt = new Date().toISOString()
    this.persist()
    return version
  }

  /** Remove a versão; itens dela vão para a versão corrente (a caixa
   *  "sem versão" não existe mais). */
  removeVersion(id: string): void {
    const removed = this.data.versions.find((v) => v.id === id)
    this.data.versions = this.data.versions.filter((v) => v.id !== id)
    let fallback: string | undefined
    for (const item of this.data.items) {
      if (item.versionId !== id) continue
      fallback = fallback ?? (removed ? this.ensureDefaultVersion(removed.projectId).id : undefined)
      item.versionId = fallback
      item.updatedAt = new Date().toISOString()
    }
    this.persist()
  }

  listItems(projectId: string): BacklogItem[] {
    return this.data.items.filter((i) => i.projectId === projectId)
  }

  getItem(id: string): BacklogItem | undefined {
    return this.data.items.find((item) => item.id === id)
  }

  createItem(
    projectId: string,
    input: {
      title: string
      type?: BacklogItemType
      notes?: string
      versionId?: string
      status?: BacklogItemStatus
      missionId?: string
    }
  ): BacklogItem {
    if (input.versionId) {
      const version = this.getVersion(input.versionId)
      if (!version || version.projectId !== projectId) {
        throw new Error('a versão indicada não pertence a este projeto')
      }
    }
    const now = new Date().toISOString()
    const item: BacklogItem = {
      id: randomUUID(),
      projectId,
      // "sem versão" não existe mais: todo item nasce na versão corrente
      versionId: input.versionId ?? this.ensureDefaultVersion(projectId).id,
      type: input.type ?? 'feature',
      title: input.title,
      notes: input.notes,
      status: input.status ?? 'pendente',
      missionId: input.missionId,
      createdAt: now,
      updatedAt: now
    }
    this.data.items.push(item)
    this.persist()
    return item
  }

  updateItem(
    id: string,
    patch: Partial<Pick<BacklogItem, 'title' | 'notes' | 'type' | 'status' | 'versionId' | 'missionId'>>
  ): BacklogItem | undefined {
    const item = this.data.items.find((i) => i.id === id)
    if (!item) return undefined
    if (typeof patch.versionId === 'string') {
      const version = this.getVersion(patch.versionId)
      if (!version || version.projectId !== item.projectId) return undefined
    }
    Object.assign(item, patch, { updatedAt: new Date().toISOString() })
    this.persist()
    return item
  }

  removeItem(id: string): void {
    this.data.items = this.data.items.filter((i) => i.id !== id)
    this.persist()
  }

  /** Missão integrada → itens dela viram FEITO. Devolve quantos mudaram. */
  completeMissionItems(missionId: string): number {
    let n = 0
    for (const item of this.data.items) {
      if (item.missionId === missionId && item.status !== 'feito') {
        item.status = 'feito'
        item.updatedAt = new Date().toISOString()
        n++
      }
    }
    if (n > 0) this.persist()
    return n
  }

  /** Missão excluída → itens dela voltam a pendente (deslinkados). */
  releaseMissionItems(missionId: string): void {
    let dirty = false
    for (const item of this.data.items) {
      if (item.missionId === missionId && item.status !== 'feito') {
        item.missionId = undefined
        item.status = 'pendente'
        item.updatedAt = new Date().toISOString()
        dirty = true
      }
    }
    if (dirty) this.persist()
  }
}
