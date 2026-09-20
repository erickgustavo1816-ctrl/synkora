// R27F2 ONDA 2 (2026-08-22) — O RELEASE COMO ENTIDADE NO DADO.
//
// Até esta rodada o release era (missão tipo 'release') + (version.status
// 'lancada') + mensagens efêmeras de hub — nenhum lugar respondia "o que
// subiu, quando, com push ok?, com caixa publicada?". A entidade nasce no
// SUCESSO do releaseVersionImpl (falha não cria entidade: recusa é conversa,
// com receita) e alimenta o bloco do release na aba Versões e a auditoria.
//
// Módulo PURO no padrão da casa (jsonStore atômico com .bak); provado em node
// puro por `test:releases-store`, sem app e sem electron.
import { randomUUID } from 'node:crypto'
// @ts-expect-error Node strip-types exige a extensão; o bundler também a aceita.
import { loadJsonStore, persistJsonStore } from './jsonStore.ts'
import type { ReleaseChangeRecord } from '../shared/releaseChanges'

/** O push da R28, como aconteceu de fato. `attempted:false` = projeto sem
 *  remoto (a linha nem existia no desfecho). */
export interface ReleaseRecordPush {
  attempted: boolean
  ok?: boolean
  error?: string
}

/** O alinhamento de versão da R29. Ausente = nome não-semver ou manifesto já
 *  em dia (nada a alinhar). */
export interface ReleaseRecordBump {
  version: string
  committed: boolean
}

export interface ReleaseRecord {
  id: string
  projectId: string
  versionId: string
  versionName: string
  /** o registro da conversa que operou a subida (reabre pela aba Versões). */
  missionId?: string
  at: string
  actor: string
  mergeDetail: string
  /** Principal observed by the release mechanics; legacy records may omit it. */
  branch?: string
  /** Joined from releaseChangesStore for the history surfaces. */
  changes?: ReleaseChangeRecord[]
  push: ReleaseRecordPush
  bump?: ReleaseRecordBump
  /** R29 — o produto declara pipeline de caixa (scripts.release)? */
  publishRequired: boolean
  /** o desfecho como o agente o leu — a frase inteira, com as receitas. */
  outcome: string
}

interface ReleasesDoc {
  version: number
  releases: ReleaseRecord[]
}

const STORE_VERSION = 1

function isReleasesDoc(value: unknown): value is ReleasesDoc {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const doc = value as Record<string, unknown>
  return typeof doc['version'] === 'number' && Array.isArray(doc['releases'])
}

function validRecord(value: unknown): value is ReleaseRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record['id'] === 'string' &&
    typeof record['projectId'] === 'string' &&
    typeof record['versionId'] === 'string' &&
    typeof record['versionName'] === 'string' &&
    typeof record['at'] === 'string' &&
    typeof record['outcome'] === 'string'
  )
}

export class ReleasesStore {
  // Campo explícito (nunca parameter property): o node --experimental-strip-types
  // das suítes não suporta a sintaxe — a lição está na própria skill `node`.
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  private load(): ReleaseRecord[] {
    try {
      return loadJsonStore<ReleasesDoc>(
        this.file,
        () => ({ version: STORE_VERSION, releases: [] }),
        isReleasesDoc
      ).releases.filter((record): record is ReleaseRecord => validRecord(record))
    } catch {
      // Disco ilegível é histórico vazio, nunca um app que não abre — o fato
      // (versão lançada) mora no backlog; isto aqui é o RETRATO da subida.
      return []
    }
  }

  private persist(releases: readonly ReleaseRecord[]): void {
    persistJsonStore(this.file, { version: STORE_VERSION, releases: [...releases] })
  }

  /** Uma linha por subida, no SUCESSO. A mais recente fica na frente — o
   *  painel lê o topo. */
  append(input: Omit<ReleaseRecord, 'id' | 'at'>): ReleaseRecord {
    const record: ReleaseRecord = {
      ...input,
      id: randomUUID(),
      at: new Date().toISOString()
    }
    this.persist([record, ...this.load()])
    return record
  }

  list(projectId: string): ReleaseRecord[] {
    return this.load().filter((record) => record.projectId === projectId)
  }

  listForVersion(versionId: string): ReleaseRecord[] {
    return this.load().filter((record) => record.versionId === versionId)
  }
}
