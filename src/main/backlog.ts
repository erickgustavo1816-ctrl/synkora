import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { loadJsonStore, persistJsonStore } from './jsonStore'
import { redactSensitiveText } from './securityRedaction'

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
  /** Agent-written result copied from Mission.summary; absent in old records.
   *  Mirror: renderer/src/store.ts VersionDelivery.summary. */
  summary?: string
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
  /** Explicit destination chosen for this release, independent of dev checkout. */
  releaseTargetBranch?: string
  createdAt: string
  updatedAt: string
}

/**
 * Recorte que uma missão nova pode efetivamente escolher. A regra Ã© de
 * domÃ­nio, nÃ£o de tela: somente versÃµes abertas do mesmo projeto aceitam
 * trabalho, e a mais antiga continua sendo a versÃ£o corrente por padrÃ£o.
 */
export interface MissionVersionChoices {
  versions: Version[]
  defaultVersionId?: string
}

function eligibleMissionVersions(versions: readonly Version[], projectId: string): Version[] {
  return versions
    .filter((version) => version.projectId === projectId && version.status === 'aberta')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
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

/**
 * "V1.2.3" / "v1.2" / "1.3" / "1.2.0.4" → os segmentos numéricos do nome;
 * nome sem padrão numérico ("MVP", "Beta") → null, e continua sendo um nome
 * legítimo — o que ele perde é lugar na ORDENAÇÃO, não o direito de existir.
 *
 * O resultado tem SEMPRE ao menos 3 posições (preenchidas com zero) para que
 * major/minor/patch possam ser lidos por índice, e preserva os segmentos
 * extras: um build "1.2.0.4" existe no mundo real, e o parser antigo, que
 * parava no terceiro ponto, devolvia `null` para ele. Nome que PARECE número e
 * some da comparação é pior que nome sem padrão nenhum: ele atravessava a
 * guarda da versão lançada em silêncio.
 */
export function parseVersionName(name: string): number[] | null {
  const trimmed = name.trim()
  if (!/^v?\d+(?:\.\d+)*$/i.test(trimmed)) return null
  const parts = trimmed.replace(/^v/i, '').split('.').map(Number)
  while (parts.length < 3) parts.push(0)
  return parts
}

/** Ordem entre dois nomes já convertidos em segmentos. Segmento ausente vale
 *  zero dos dois lados, então "1.2" e "1.2.0" empatam, como manda o semver. */
export function compareVersionNumbers(a: readonly number[], b: readonly number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

interface BacklogData {
  versions: Version[]
  items: BacklogItem[]
}

export class BacklogStore {
  private readonly file: string
  private data: BacklogData = { versions: [], items: [] }

  constructor(
    file = join(app.getPath('userData'), 'backlog.json'),
    /** The project owner supplies its capability refusal; legacy standalone
     * stores remain versioned. No project cache or filesystem inference. */
    private readonly versionRefusal: (projectId: string) => string | undefined = () => undefined
  ) {
    this.file = file
    const loaded = loadJsonStore(
      this.file,
      () => ({ versions: [], items: [] }),
      (value): value is BacklogData => {
        if (typeof value !== 'object' || value === null) return false
        const candidate = value as Partial<BacklogData>
        return Array.isArray(candidate.versions) && Array.isArray(candidate.items)
      }
    )
    // migração leve: versões antigas não tinham deliveries
    let migrated = loaded.versions.some((version) => !version.deliveries)
    let next: BacklogData = {
      versions: loaded.versions.map((version) =>
        version.deliveries ? version : { ...version, deliveries: [] }
      ),
      items: loaded.items.filter((item) => !(item.status === 'feito' && !item.versionId))
    }
    migrated ||= next.items.length !== loaded.items.length
    // migração: a caixa "SEM VERSÃO" MORREU (confundia — o mesmo trabalho
    // aparecia riscado em "sem versão" E como entrega na versão). Item
    // FEITO sem versão some (o registro real é a entrega da missão na
    // versão); item ABERTO sem versão (ou preso em versão já lançada)
    // vai para a versão corrente.
    for (let index = 0; index < next.items.length; index++) {
      const item = next.items[index]
      if (this.versionRefusal(item.projectId)) continue
      if (item.status === 'feito') continue
      const version = item.versionId
        ? next.versions.find((candidate) => candidate.id === item.versionId)
        : undefined
      if (!version || version.status === 'lancada') {
        const ensured = this.withDefaultVersion(next, item.projectId)
        const items = [...ensured.data.items]
        items[index] = {
          ...item,
          versionId: ensured.version.id,
          updatedAt: new Date().toISOString()
        }
        next = { ...ensured.data, items }
        migrated = true
      }
    }
    if (migrated) persistJsonStore(this.file, next)
    this.data = next
  }

  /** O arquivo pousa antes de a fotografia viva mudar. */
  private commit(next: BacklogData): void {
    persistJsonStore(this.file, next)
    this.data = next
  }

  listVersions(projectId: string): Version[] {
    if (this.versionRefusal(projectId)) return []
    return this.data.versions.filter((v) => v.projectId === projectId)
  }

  /** Fonte Ãºnica para o seletor e para a criaÃ§Ã£o de missÃµes. */
  missionVersionChoices(projectId: string): MissionVersionChoices {
    if (this.versionRefusal(projectId)) return { versions: [], defaultVersionId: undefined }
    const versions = eligibleMissionVersions(this.data.versions, projectId)
    return { versions, defaultVersionId: versions[0]?.id }
  }

  createVersion(projectId: string, input: { name: string; theme?: string; goal?: string }): Version {
    const refusal = this.versionRefusal(projectId)
    if (refusal) throw new Error(refusal)
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
    this.commit({ ...this.data, versions: [...this.data.versions, version] })
    return version
  }

  updateVersion(
    id: string,
    patch: Partial<Pick<Version, 'name' | 'theme' | 'goal' | 'status'>>
  ): Version | undefined {
    const index = this.data.versions.findIndex((version) => version.id === id)
    if (index < 0) return undefined
    const current = this.data.versions[index]
    const version = { ...current }
    // lançar carimba releasedAt — a lançada mais recente é a ATUAL na main
    if (patch.status === 'lancada' && current.status !== 'lancada') {
      version.releasedAt = new Date().toISOString()
    }
    Object.assign(version, patch, { updatedAt: new Date().toISOString() })
    const versions = [...this.data.versions]
    versions[index] = version
    this.commit({ ...this.data, versions })
    return version
  }

  getVersion(id: string): Version | undefined {
    return this.data.versions.find((v) => v.id === id)
  }

  /** null = pode criar; string = motivo da recusa, escrito para ser LIDO pelo
   *  dono (o número passou a ser digitável na lateral de Versões, 2026-08-17:
   *  "posso colocar um projeto que já esteja na 1.20"). Regras (decisão do
   *  usuário): nome duplicado nunca; e se a main já está na X, criar uma
   *  versão numericamente INFERIOR ou igual a X não faz sentido. */
  validateVersionName(
    projectId: string,
    name: string,
    excludeVersionId?: string
  ): string | null {
    const refusal = this.versionRefusal(projectId)
    if (refusal) return refusal
    const trimmed = name.trim()
    if (!trimmed) return 'o nome da versão não pode ficar vazio'
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
      .filter((x): x is { v: Version; p: number[] } => x.p != null)
      .sort((a, b) => compareVersionNumbers(b.p, a.p))[0]
    if (!p || !released) return null
    // "seria uma versão inferior" para 2.0 contra uma V2.0 lançada é falso: não
    // é inferior, é ELA com outra grafia. A recusa nomeia o que aconteceu e
    // como sair — quem digitou um número precisa saber qual digitar.
    const order = compareVersionNumbers(p, released.p)
    if (order === 0)
      return `a main já está na ${released.v.name}: ${trimmed} é o número dela — escolha um acima`
    if (order < 0)
      return `a main já está na ${released.v.name}: ${trimmed} ficaria abaixo dela — escolha um número acima`
    return null
  }

  validateNewVersion(projectId: string, name: string): string | null {
    return this.validateVersionName(projectId, name)
  }

  private withDefaultVersion(
    data: BacklogData,
    projectId: string
  ): { data: BacklogData; version: Version } {
    const refusal = this.versionRefusal(projectId)
    if (refusal) throw new Error(refusal)
    const open = eligibleMissionVersions(data.versions, projectId)
    if (open[0]) return { data, version: open[0] }

    const highestNumeric = data.versions
      .filter((version) => version.projectId === projectId && version.status === 'lancada')
      .map((version) => ({ version, parsed: parseVersionName(version.name) }))
      .filter(
        (entry): entry is { version: Version; parsed: number[] } => entry.parsed !== null
      )
      .sort((left, right) => compareVersionNumbers(right.parsed, left.parsed))[0]
    // Segue a maior versão numérica histórica, mesmo se a mais recente tiver nome legado.
    const prefix = highestNumeric
      ? (highestNumeric.version.name.trim().match(/^v/i)?.[0] ?? '')
      : 'V'
    const major = highestNumeric?.parsed[0] ?? 1
    let minor = highestNumeric ? highestNumeric.parsed[1] + 1 : 0
    let name = `${prefix}${major}.${minor}`
    while (
      data.versions.some(
        (version) =>
          version.projectId === projectId &&
          version.name.toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR')
      )
    ) {
      minor += 1
      name = `${prefix}${major}.${minor}`
    }
    const now = new Date().toISOString()
    const version: Version = {
      id: randomUUID(),
      projectId,
      name,
      status: 'aberta',
      deliveries: [],
      createdAt: now,
      updatedAt: now
    }
    return {
      data: { ...data, versions: [...data.versions, version] },
      version
    }
  }

  /** Versão CORRENTE do projeto (decisão do usuário, 2026-07-23): sem versão
   *  explícita, toda missão cai na versão aberta mais antiga; sem nenhuma
   *  aberta, nasce a próxima automaticamente — "V1.0", ou o minor seguinte
   *  da última lançada ("V1.0" lançada → "V1.1"). */
  ensureDefaultVersion(projectId: string): Version {
    const ensured = this.withDefaultVersion(this.data, projectId)
    if (ensured.data !== this.data) this.commit(ensured.data)
    return ensured.version
  }

  /** Registra (ou limpa, com undefined) a branch/worktree da versão. */
  setVersionBranch(id: string, branch?: string, worktree?: string): void {
    const index = this.data.versions.findIndex((version) => version.id === id)
    if (index < 0) return
    const version: Version = {
      ...this.data.versions[index],
      branch,
      worktree,
      updatedAt: new Date().toISOString()
    }
    const versions = [...this.data.versions]
    versions[index] = version
    this.commit({ ...this.data, versions })
  }

  setVersionReleaseTarget(id: string, branch: string): boolean {
    const index = this.data.versions.findIndex(version => version.id === id && version.status === 'aberta')
    if (index < 0) return false
    const versions = [...this.data.versions]
    versions[index] = { ...versions[index], releaseTargetBranch: branch, updatedAt: new Date().toISOString() }
    this.commit({ ...this.data, versions })
    return true
  }

  /**
   * Commit lógico único do release: nunca persiste o estado intermediário
   * "aberta, mas sem branch/worktree". Isso torna uma queda entre o cleanup
   * Git e a atualização do backlog inteiramente reconciliável pelo intent.
   */
  markVersionReleased(id: string): Version | undefined {
    const index = this.data.versions.findIndex((version) => version.id === id)
    if (index < 0) return undefined
    const now = new Date().toISOString()
    const current = this.data.versions[index]
    const version: Version = {
      ...current,
      status: 'lancada',
      branch: undefined,
      worktree: undefined,
      updatedAt: now
    }
    if (current.status !== 'lancada') version.releasedAt = now
    const versions = [...this.data.versions]
    versions[index] = version
    this.commit({ ...this.data, versions })
    return version
  }

  /** Missão da versão INTEGROU na branch da versão → entrega registrada. */
  addDelivery(versionId: string, missionId: string, title: string, summary?: string): Version | undefined {
    const index = this.data.versions.findIndex((version) => version.id === versionId)
    if (index < 0) return undefined
    const current = this.data.versions[index]
    const cleanSummary = summary?.trim() ? redactSensitiveText(summary.trim()) : undefined
    const existing = current.deliveries.find((delivery) => delivery.missionId === missionId)
    // Reconciliation can fill or refresh the summary without duplicating the
    // delivery or rewriting its original completion date.
    if (existing && (!cleanSummary || existing.summary === cleanSummary)) return current
    const version: Version = {
      ...current,
      deliveries: existing ? current.deliveries.map((delivery) =>
        delivery.missionId === missionId ? { ...delivery, summary: cleanSummary } : delivery
      ) : [
        ...current.deliveries,
        {
          id: randomUUID(),
          missionId,
          title,
          ...(cleanSummary ? { summary: cleanSummary } : {}),
          at: new Date().toISOString()
        }
      ],
      updatedAt: new Date().toISOString()
    }
    const versions = [...this.data.versions]
    versions[index] = version
    this.commit({ ...this.data, versions })
    return version
  }

  /** Remove a versão; itens dela vão para a versão corrente (a caixa
   *  "sem versão" não existe mais). */
  removeVersion(id: string): void {
    const removed = this.data.versions.find((version) => version.id === id)
    let next: BacklogData = {
      ...this.data,
      versions: this.data.versions.filter((version) => version.id !== id)
    }
    let fallback: string | undefined
    if (removed && next.items.some((item) => item.versionId === id)) {
      const ensured = this.withDefaultVersion(next, removed.projectId)
      next = ensured.data
      fallback = ensured.version.id
    }
    const items = next.items.map((item) =>
      item.versionId === id
        ? { ...item, versionId: fallback, updatedAt: new Date().toISOString() }
        : item
    )
    this.commit({ ...next, items })
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
    let next = this.data
    let versionId = input.versionId
    if (!versionId) {
      const ensured = this.withDefaultVersion(next, projectId)
      next = ensured.data
      versionId = ensured.version.id
    }
    const now = new Date().toISOString()
    const item: BacklogItem = {
      id: randomUUID(),
      projectId,
      // "sem versão" não existe mais: todo item nasce na versão corrente
      versionId,
      type: input.type ?? 'feature',
      title: input.title,
      notes: input.notes,
      status: input.status ?? 'pendente',
      missionId: input.missionId,
      createdAt: now,
      updatedAt: now
    }
    this.commit({ ...next, items: [...next.items, item] })
    return item
  }

  updateItem(
    id: string,
    patch: Partial<Pick<BacklogItem, 'title' | 'notes' | 'type' | 'status' | 'versionId' | 'missionId'>>
  ): BacklogItem | undefined {
    const index = this.data.items.findIndex((item) => item.id === id)
    if (index < 0) return undefined
    const current = this.data.items[index]
    if (typeof patch.versionId === 'string') {
      const version = this.getVersion(patch.versionId)
      if (!version || version.projectId !== current.projectId) return undefined
    }
    const item: BacklogItem = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString()
    }
    const items = [...this.data.items]
    items[index] = item
    this.commit({ ...this.data, items })
    return item
  }

  removeItem(id: string): void {
    this.commit({ ...this.data, items: this.data.items.filter((item) => item.id !== id) })
  }

  /** Missão integrada → itens dela viram FEITO. Devolve quantos mudaram. */
  completeMissionItems(missionId: string): number {
    let n = 0
    const items = this.data.items.map((item) => {
      if (item.missionId === missionId && item.status !== 'feito') {
        n++
        return { ...item, status: 'feito' as const, updatedAt: new Date().toISOString() }
      }
      return item
    })
    if (n > 0) this.commit({ ...this.data, items })
    return n
  }

  /** Missão excluída → itens dela voltam a pendente (deslinkados). */
  releaseMissionItems(missionId: string): void {
    let dirty = false
    const items = this.data.items.map((item) => {
      if (item.missionId === missionId && item.status !== 'feito') {
        dirty = true
        return {
          ...item,
          missionId: undefined,
          status: 'pendente' as const,
          updatedAt: new Date().toISOString()
        }
      }
      return item
    })
    if (dirty) this.commit({ ...this.data, items })
  }
}
