import { app } from 'electron'
import AdmZip from 'adm-zip'
import { execFileSync } from 'child_process'
import { TextDecoder } from 'node:util'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, join, relative, resolve, sep } from 'path'
import { freshWindowsPath } from './winPath'
import type { Department } from './tasks'
import { bundledPackageSha } from './bundledSkillRevision'
import { buildSynkoraImpeccableActivation } from './impeccableAdapter'
import {
  selectInstalledIdsForDepartment,
  selectInstalledPlanningIds
} from './skillsRouting'
import {
  managedWorkspaceSkillContentsMatch,
  MANAGED_WORKSPACE_SKILL_MARKER,
  pruneUnrequestedManagedWorkspaceAgents,
  syncManagedWorkspaceAgentCopy
} from './workspaceSkills'
// A cópia pesada (syncManagedWorkspaceSkillCopies), a poda e o scan de
// supply-chain do caminho de EXECUÇÃO viajam pelo gitWorker via gitOff —
// main livre; fallback síncrono idêntico se o worker não subir.
import { gitOff } from './gitAsync'
import {
  assessSkillPackage,
  skillPackageBlockMessage,
  SKILL_PACKAGE_SECURITY_VERSION,
  type SkillPackageAssessment
} from './skillPackageSecurity'
import {
  createSkillArchiveIntegrity,
  createSkillArchiveDigest,
  decompressSkillArchiveEntry,
  MAX_SKILL_ARCHIVE_COMPRESSED_BYTES,
  MAX_SKILL_ARCHIVE_CONTROL_FILE_BYTES,
  MAX_SKILL_ARCHIVE_ENTRIES,
  MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES,
  SKILL_ARCHIVE_INTEGRITY_FILE,
  SKILL_ARCHIVE_MANIFEST_FILE,
  normalizedSkillArchivePath,
  validateImportedSkillArchiveManifest,
  validateSkillArchiveMetadata,
  verifySkillArchiveIntegrityDigests,
  type SkillArchiveEntry,
  type SkillArchiveMetadataEntry
} from './skillArchiveIntegrity'

// ————————————————————————————————————————————————————————————————————————
// BIBLIOTECA DE SKILLS (F4): catálogo CURADO por função + skills CUSTOM do
// usuário (URL do GitHub), instaladas da FONTE (sem git binário) para
// userData/skills/lib. Panes de execução recebem árvores PRIVADAS por receipt;
// as roots autodetectadas ficam restritas ao único método-base de planejamento
// do Maestro/orquestrador. AMBOS os CLIs rejeitam SKILL.md com BOM.
//
// ORÇAMENTO DE REDE (o rate limit anônimo do GitHub é 60 req/h e o usuário
// BATEU nele instalando a curadoria uma a uma — 2 requests POR SKILL):
//   · instalar = 1 HEAD + 1 tree POR REPO (installMany agrupa; cache de
//     rajada de 120s cobre cliques um-a-um na UI) + raws (não contam na
//     quota core). A versão instalada é o sha do HEAD do repo no momento.
//   · update-check = 1 request condicional de HEAD por repo; só repo com
//     HEAD novo paga 1 compare (base...head lista os ARQUIVOS mudados —
//     descobre quais skills do repo mudaram sem 1 request por skill).
//   · 403/429 devolvem mensagem com a HORA em que a cota libera.
// ————————————————————————————————————————————————————————————————————————

export interface SkillSource {
  /** owner/repo público no GitHub */
  repo: string
  /** subpasta da skill dentro do repo ('' = a skill mora na raiz do repo) */
  path: string
  /** branch de referência (ausente = branch padrão do repo) */
  ref?: string
}

export interface SkillDef {
  /** id canônico = nome da pasta INSTALADA = nome invocável (/id no claude,
   *  $id no codex). SEMPRE igual ao `name:` do frontmatter upstream — quando a
   *  pasta upstream difere do name (ex.: skills/soft-skill →
   *  high-end-visual-design), instalamos com o NAME: a spec exige pasta=name
   *  e o comando do claude vem do nome da pasta. */
  id: string
  /** 'agent' entra na rodada de subagentes — o mesmo motor instala os dois */
  kind: 'skill' | 'agent'
  /** funções que levam esta skill na curadoria */
  depts: Department[]
  /** grupo de OCASIÃO na biblioteca (PT-BR curto — agrupamento visual) */
  group: string
  source: SkillSource
  /** resumo PT-BR (UI) */
  summary: string
  /** 1 linha EN anexada ao prompt do executor: quando usar */
  hint: string
  /** skills-irmãs que esta invoca POR NOME (routers): instalar/injetar esta
   *  arrasta as dependências junto */
  requires?: string[]
  /** funções onde entra POR PADRÃO quando o card não carimba nada e a
   *  política não define (só vale instalada) */
  defaultFor?: Department[]
  /** skill de PLANEJAMENTO que o app injeta no workspace do PM/orquestrador
   *  no spawn do pane (decisão do usuário, rodada research 2026-07-29: "o
   *  orquestrador é um planejador — deve sempre ver uma dessas skills antes
   *  de planejar, não passar batido"). Só vale instalada. */
  orchestratorDefault?: boolean
  /** Disponível na biblioteca e por seleção explícita, mas não entra
   *  automaticamente em toda execução da função. Evita que workflows externos
   *  de git/review/merge disputem o pipeline gerenciado pelo Synkora. */
  manualOnly?: boolean
  /** Fases nas quais o pacote foi validado pelo Synkora. Ausente significa
   * apenas DEV/ajudante; gates read-only exigem declaracao explicita. */
  allowedPhases?: Array<'planning' | 'dev' | 'review' | 'qa' | 'helper'>
  /** Capacidades materiais exigidas pelo playbook, usadas para impedir que um
   * gate receba uma skill impossivel de executar. */
  requiresCapabilities?: Array<'read' | 'write' | 'shell' | 'browser' | 'subagents' | 'network'>
  /** Adaptacao auditada pelo produto para evitar workflows concorrentes. */
  adapter?: 'synkora-native' | 'impeccable-operation'
  /** SUBAGENTE EMBUTIDO do Synkora (criado in-house com a metodologia da
   *  skill de criação): o corpo do agent.md vive AQUI — instala sem rede,
   *  nunca tem update (a "fonte" é o próprio app). source é ignorado. */
  bundledBody?: string
  /** Recursos do pacote embutido, relativos a raiz. Mantem SKILL.md curto e
   *  permite disclosure progressivo sem depender de download externo. */
  bundledFiles?: Record<string, string>
}

export interface SkillState {
  id: string
  kind: 'skill' | 'agent'
  depts: Department[]
  group: string
  repo: string
  summary: string
  hint: string
  requires?: string[]
  defaultFor?: Department[]
  manualOnly?: boolean
  allowedPhases?: SkillDef['allowedPhases']
  requiresCapabilities?: SkillDef['requiresCapabilities']
  adapter?: SkillDef['adapter']
  /** skill adicionada pelo usuário (fora da curadoria) */
  custom?: boolean
  installed: boolean
  sha?: string
  installedAt?: string
  supplyChainDecision?: SkillPackageAssessment['decision']
  supplyChainFindings?: number
  licenseFiles?: string[]
  updateAvailable: boolean
}

export interface SkillActivationPackage {
  id: string
  operation: string
  version: string
  fingerprint: string
  sourceFingerprint: string
  content: string
  loadedReferences: string[]
}

export interface SkillActivationIdentity {
  id: string
  version: string
  fingerprint: string
}

interface InstalledInfo {
  /** sha do HEAD do repo no momento da instalação (o pin de download) */
  sha: string
  installedAt: string
  /** Resultado recalculado do conteúdo efetivamente promovido. */
  supplyChain?: SkillPackageAssessment
}

interface SkillsManifest {
  installed: Record<string, InstalledInfo>
  /** sha novo disponível visto no último check (id → sha) */
  updates: Record<string, string>
  /** HEAD conhecido por "repo@ref" — HEAD igual = nada mudou no repo */
  repoHeads?: Record<string, { sha: string; etag?: string }>
  /** skills adicionadas pelo usuário (persistem junto do estado) */
  custom?: SkillDef[]
  lastCheckAt?: string
}

function bundledPackageEntries(def: SkillDef): Array<[string, string]> {
  if (!def.bundledBody) return []
  const rootEntry = def.kind === 'agent' ? 'agent.md' : 'SKILL.md'
  return [[rootEntry, def.bundledBody], ...Object.entries(def.bundledFiles ?? {})]
}

function safeBundledDestination(root: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(`caminho invalido em pacote embutido: ${relativePath}`)
  }
  const destination = resolve(root, ...normalized.split('/'))
  const resolvedRoot = resolve(root)
  if (destination !== resolvedRoot && !destination.startsWith(resolvedRoot + sep)) {
    throw new Error(`caminho escapou do pacote embutido: ${relativePath}`)
  }
  return destination
}

function writeBundledPackage(root: string, def: SkillDef): void {
  const seen = new Set<string>()
  for (const [relativePath, content] of bundledPackageEntries(def)) {
    const key = relativePath.replace(/\\/g, '/').toLocaleLowerCase('en-US')
    if (seen.has(key)) throw new Error(`arquivo duplicado em pacote embutido: ${relativePath}`)
    seen.add(key)
    const destination = safeBundledDestination(root, relativePath)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content, 'utf-8')
  }
}

function listPackageFiles(root: string, current = root): string[] {
  const out: string[] = []
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name)
    if (entry.isDirectory()) out.push(...listPackageFiles(root, absolute))
    else if (entry.isFile()) out.push(relative(root, absolute).replace(/\\/g, '/'))
    else throw new Error(`entrada nao regular no pacote embutido: ${entry.name}`)
  }
  return out.sort()
}

const CHECK_TTL_MS = 24 * 60 * 60 * 1000
const BURST_CACHE_MS = 120_000
// Teto de tamanho: skill legítima grande EXISTE (impeccable = 128 arquivos de
// reference/ — o cap de 80 recusou uma skill real da curadoria). 200 arquivos
// + 30MB totais seguram um repo-raiz gigante em skill custom sem barrar as
// grandes de verdade.
const MAX_FILES = 200
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 30 * 1024 * 1024
// Vídeo em pasta de skill é demo do autor — nenhum CLI consome vídeo. É
// PULADO (não recusa a skill); o mesmo vale para qualquer arquivo acima do
// teto de 4MB. Caso real: ux-writing veio com um .mp4 de demo de ~5MB.
const SKIP_MEDIA_RE = /\.(mp4|mov|webm|avi|mkv|m4v)$/i
const FETCH_TIMEOUT_MS = 20_000

interface GhResult {
  status: number
  etag?: string
  body?: unknown
  /** epoch (s) em que a cota anônima reseta — presente em 403/429 */
  rateReset?: number
}

// TOKEN opcional do GitHub (settings.githubToken): sobe a cota core de 60/h
// (anônimo) para 5.000/h — é o que permite "⭳ instalar tudo" numa tacada.
// O index seta no boot e a cada settings:set.
let ghToken: string | undefined
export function setGithubToken(token?: string): void {
  ghToken = token?.trim() || undefined
}

function rateMsg(res: GhResult): string {
  const dica = ghToken ? '' : ' — o 🔑 token na biblioteca sobe a cota para 5.000/h'
  if (res.rateReset) {
    const t = new Date(res.rateReset * 1000)
    const hh = String(t.getHours()).padStart(2, '0')
    const mm = String(t.getMinutes()).padStart(2, '0')
    return `GitHub recusou (rate limit) — a cota libera às ${hh}:${mm}${dica}`
  }
  return `GitHub recusou (rate limit) — tente de novo em alguns minutos${dica}`
}

async function gh(url: string, etag?: string): Promise<GhResult> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'synkora-skills',
        ...(ghToken ? { authorization: `Bearer ${ghToken}` } : {}),
        ...(etag ? { 'if-none-match': etag } : {})
      },
      signal: ac.signal
    })
    if (res.status === 304) return { status: 304 }
    const out: GhResult = {
      status: res.status,
      etag: res.headers.get('etag') ?? undefined,
      body: await res.json().catch(() => undefined)
    }
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'))
      if (Number.isFinite(reset)) out.rateReset = reset
    }
    return out
  } finally {
    clearTimeout(timer)
  }
}

async function fetchRawFrom(host: string, repo: string, sha: string, filePath: string): Promise<Buffer> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(
      `https://${host}/${repo}/${sha}/${filePath.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { 'user-agent': 'synkora-skills' }, signal: ac.signal }
    )
    if (!res.ok) throw new Error(`raw ${res.status} em ${filePath}`)
    return Buffer.from(await res.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

async function fetchRaw(repo: string, sha: string, filePath: string): Promise<Buffer> {
  const buf = await fetchRawFrom('raw.githubusercontent.com', repo, sha, filePath)
  // Git LFS: o raw entrega o PONTEIRO — o binário real mora no media.
  if (buf.length < 512 && buf.toString('utf-8').startsWith('version https://git-lfs.github.com/spec/')) {
    return fetchRawFrom('media.githubusercontent.com/media', repo, sha, filePath)
  }
  return buf
}

interface TreeFile {
  path: string
  size?: number
}

/** URL de ARQUIVO .md (subagente): ".../blob/<ref>/<path>.md" ou raw
 *  (com ou sem o prefixo refs/heads/ que o raw usa hoje) → fonte de arquivo. */
export function parseAgentUrl(input: string): SkillSource | null {
  const s = input.trim().replace(/\/+$/, '')
  if (!s) return null
  let m = s.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/([^/\s]+)\/(.+\.md)$/i
  )
  if (m) return { repo: `${m[1]}/${m[2]}`, ref: m[3], path: m[4] }
  m = s.match(
    /^(?:https?:\/\/)?raw\.githubusercontent\.com\/([^/\s]+)\/([^/\s]+)\/(?:refs\/heads\/)?([^/\s]+)\/(.+\.md)$/i
  )
  if (m) return { repo: `${m[1]}/${m[2]}`, ref: m[3], path: m[4] }
  return null
}

/** "https://github.com/o/r", "o/r" ou ".../tree/<ref>/<subpasta>" → fonte. */
export function parseSkillUrl(input: string): SkillSource | null {
  const s = input.trim().replace(/\/+$/, '')
  if (!s) return null
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/tree\/([^/\s]+)\/(.+)$/)
  if (m) return { repo: `${m[1]}/${m[2]}`, ref: m[3], path: m[4].replace(/\/+$/, '') }
  m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)$/)
  if (m) return { repo: `${m[1]}/${m[2]}`, path: '' }
  m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (m) return { repo: `${m[1]}/${m[2]}`, path: '' }
  return null
}

function parseFrontmatter(md: string): { name?: string; description?: string } {
  const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return {}
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '')
  const description = fm[1]
    .match(/^description:\s*([\s\S]*?)(?=^\w[\w-]*:|\s*$)/m)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']|["']$/g, '')
  return { name, description }
}

const ARCHIVE_TEXT_DECODER = new TextDecoder('utf-8', { fatal: true })

interface ExportArchiveFile {
  archivePath: string
  absolutePath: string
  bytes: number
}

function zipEntryMetadata(entry: AdmZip.IZipEntry): SkillArchiveMetadataEntry {
  return {
    path: entry.entryName,
    isDirectory: entry.isDirectory,
    compressedBytes: entry.header.compressedSize,
    uncompressedBytes: entry.header.size,
    compressionMethod: entry.header.method,
    encrypted: Boolean(entry.header.flags & 1)
  }
}

/** O header já passou pelo preflight; a igualdade final cobre header forjado. */
function readZipEntryCapped(entry: AdmZip.IZipEntry, maxBytes: number): Buffer {
  if (
    entry.isDirectory ||
    !Number.isSafeInteger(entry.header.size) ||
    entry.header.size < 0 ||
    entry.header.size > maxBytes
  )
    throw new Error(`entrada excede o teto seguro: ${entry.entryName}`)
  return decompressSkillArchiveEntry(
    {
      ...zipEntryMetadata(entry),
      crc32: entry.header.crc,
      compressedData: entry.getCompressedData()
    },
    maxBytes
  )
}

function collectExportArchiveFiles(dir: string, id: string): ExportArchiveFile[] {
  const files: ExportArchiveFile[] = []
  const queue: Array<{ directory: string; relativePath: string }> = [
    { directory: dir, relativePath: '' }
  ]
  let totalBytes = 0
  while (queue.length) {
    const current = queue.shift()!
    const entries = readdirSync(current.directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name, 'en')
    )
    for (const entry of entries) {
      const relativePath = current.relativePath
        ? `${current.relativePath}/${entry.name}`
        : entry.name
      const absolutePath = join(current.directory, entry.name)
      if (entry.isSymbolicLink())
        throw new Error(`link simbólico não pode ser exportado em ${id}/${relativePath}`)
      if (entry.isDirectory()) {
        queue.push({ directory: absolutePath, relativePath })
        continue
      }
      if (!entry.isFile())
        throw new Error(`tipo de arquivo não suportado em ${id}/${relativePath}`)
      const archivePath = `lib/${id}/${relativePath.replace(/\\/g, '/')}`
      if (normalizedSkillArchivePath(archivePath) !== archivePath)
        throw new Error(`caminho não portável em ${id}/${relativePath}`)
      const stat = statSync(absolutePath)
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0)
        throw new Error(`arquivo inválido em ${id}/${relativePath}`)
      // Mantém a regra histórica do instalador: demos/mídia e arquivos acima
      // de 4MB não fazem parte do pacote portátil.
      if (SKIP_MEDIA_RE.test(relativePath) || stat.size > MAX_FILE_BYTES) continue
      files.push({ archivePath, absolutePath, bytes: stat.size })
      totalBytes += stat.size
      if (files.length > MAX_FILES)
        throw new Error(`skill ${id} excede o teto de ${MAX_FILES} arquivos`)
      if (totalBytes > MAX_TOTAL_BYTES)
        throw new Error(`skill ${id} excede o teto de 30MB`)
    }
  }
  if (
    !files.some(
      (file) => file.archivePath === `lib/${id}/SKILL.md` || file.archivePath === `lib/${id}/agent.md`
    )
  )
    throw new Error(`skill ${id} não contém SKILL.md nem agent.md exportável`)
  return files
}

export class SkillsLibrary {
  private baseDir = join(app.getPath('userData'), 'skills')
  private libDir = join(this.baseDir, 'lib')
  private file = join(this.baseDir, 'manifest.json')
  private data: SkillsManifest = { installed: {}, updates: {} }
  private defs: SkillDef[]
  private busy = new Set<string>()
  private checking: Promise<number> | null = null
  /** caches de RAJADA (cliques em sequência na UI): HEAD por repo@ref e tree
   *  por repo@sha — o 2º install do mesmo repo não paga request nenhum. */
  private headCache = new Map<string, { sha: string; at: number }>()
  private treeCache = new Map<string, { files: TreeFile[]; at: number }>()
  /** Pacotes já revalidados nesta execução. A leitura é adiada até o
   *  primeiro uso para não transformar a inicialização em uma varredura pesada. */
  private executionAssessmentCache = new Map<
    string,
    { assessment: SkillPackageAssessment; verifiedAt: number }
  >()
  /** syncToWorkspace era atômico por ser síncrono no main; agora que a cópia
   *  pesada viaja pelo worker, esta cadeia preserva a MESMA garantia — dois
   *  syncs nunca entrelaçam poda/cópia no mesmo processo. */
  private workspaceSyncChain: Promise<unknown> = Promise.resolve()
  onChanged?: () => void

  constructor(defs: SkillDef[]) {
    this.defs = [...defs]
    mkdirSync(this.libDir, { recursive: true })
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf-8')) as SkillsManifest
        this.data = {
          installed: parsed.installed ?? {},
          updates: parsed.updates ?? {},
          repoHeads: parsed.repoHeads,
          custom: parsed.custom,
          lastCheckAt: parsed.lastCheckAt
        }
      } catch {
        this.data = { installed: {}, updates: {} }
      }
    }
    // customs persistidos entram no catálogo vivo (sem colidir com a curadoria)
    for (const c of this.data.custom ?? []) {
      if (!this.defs.some((d) => d.id === c.id)) this.defs.push(c)
    }
    // manifest órfão (pasta apagada na mão) não pode mentir "instalada" —
    // skill tem SKILL.md; subagente tem agent.md (arquivo único).
    for (const id of Object.keys(this.data.installed)) {
      if (
        !existsSync(join(this.libDir, id, 'SKILL.md')) &&
        !existsSync(join(this.libDir, id, 'agent.md'))
      )
        delete this.data.installed[id]
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  private notify(): void {
    try {
      this.onChanged?.()
    } catch {
      // UI fechada
    }
  }

  byId(id: string): SkillDef | undefined {
    return this.defs.find((d) => d.id === id)
  }

  definitions(): SkillDef[] {
    return [...this.defs]
  }

  /** Prova os bytes e a árvore mínima do pacote app-owned, não só o manifest. */
  bundledPackageMatches(id: string): boolean {
    const def = this.byId(id)
    if (!def?.bundledBody) return false
    const directory = join(this.libDir, id)
    try {
      const expected = bundledPackageEntries(def)
        .map(([path]) => path.replace(/\\/g, '/'))
        .sort()
      const actual = listPackageFiles(directory)
      if (expected.length !== actual.length) return false
      for (let index = 0; index < expected.length; index++) {
        if (expected[index] !== actual[index]) return false
      }
      return bundledPackageEntries(def).every(
        ([path, content]) =>
          readFileSync(safeBundledDestination(directory, path), 'utf8') === content
      )
    } catch {
      return false
    }
  }

  private isCustom(id: string): boolean {
    return Boolean(this.data.custom?.some((c) => c.id === id))
  }

  /**
   * Um item continua aparecendo como instalado para que o usuário possa
   * removê-lo, mas um pacote bloqueado nunca entra em seleção automática.
   * Pacotes legados sem assessment são revalidados imediatamente antes do uso.
   */
  private isEligibleInstalled(id: string): boolean {
    const installed = this.data.installed[id]
    if (!installed) return false
    // ELEGÍVEL = não-bloqueada (decisão do usuário 2026-08-04: "todo pane tem
    // acesso às skills da função" é diferencial central). O gate duro é só
    // 'block' (achado CRÍTICO real: exfiltração, download-e-executa). 'review'
    // entra no menu — os achados ficam persistidos para auditoria/UI. Legada
    // SEM assessment também entra: o syncToWorkspace reavalia cada id pedido
    // (installedForExecution) antes de copiar, e o backfill de boot preenche o
    // campo em background. Exigir 'allow' estrito deixou 383 skills mudas.
    return installed.supplyChain?.decision !== 'block'
  }

  /** Recalcula a decisão sobre o conteúdo local efetivo antes de executá-lo.
   *  Passa tudo que não for 'block' (mesma régua do isEligibleInstalled);
   *  cache de 10 min — a avaliação é por conteúdo (fingerprint) e 5s fazia
   *  cada spawn re-escanear a biblioteca inteira. O scan em si (até 250
   *  arquivos/30MB) roda no gitWorker; o estado da classe muda AQUI no main. */
  private async installedForExecution(id: string, forceAssessment = false): Promise<InstalledInfo | undefined> {
    const installed = this.data.installed[id]
    if (!installed) return undefined
    const def = this.byId(id)
    // Conteúdo app-owned é identidade, não apenas um pacote sem achado crítico.
    if (def?.bundledBody && !this.bundledPackageMatches(id)) return undefined
    const cached = this.executionAssessmentCache.get(id)
    if (!forceAssessment && cached && Date.now() - cached.verifiedAt < 600_000) {
      return cached.assessment.decision !== 'block' ? installed : undefined
    }
    try {
      const assessment = await gitOff('assessSkillPackage', join(this.libDir, id))
      // Janela do await: se a skill foi removida/reinstalada durante o scan,
      // o registro atual é OUTRO objeto — nunca mutar/persistir o solto.
      if (this.data.installed[id] !== installed) return undefined
      this.executionAssessmentCache.set(id, { assessment, verifiedAt: Date.now() })
      if (
        !installed.supplyChain ||
        installed.supplyChain.version !== assessment.version ||
        installed.supplyChain.fingerprint !== assessment.fingerprint ||
        installed.supplyChain.decision !== assessment.decision
      ) {
        installed.supplyChain = assessment
        this.persist()
        this.notify()
      }
      return assessment.decision !== 'block' ? installed : undefined
    } catch {
      // Falha de leitura/validação é local ao pacote: não derruba o app e
      // não permite que conteúdo não verificado seja injetado.
      return undefined
    }
  }

  listState(): SkillState[] {
    return this.defs.map((d) => {
      const inst = this.data.installed[d.id]
      return {
        id: d.id,
        kind: d.kind,
        depts: d.depts,
        group: d.group,
        repo: d.source.repo,
        summary: d.summary,
        hint: d.hint,
        requires: d.requires,
        defaultFor: d.defaultFor,
        manualOnly: d.manualOnly,
        allowedPhases: d.allowedPhases,
        requiresCapabilities: d.requiresCapabilities,
        adapter: d.adapter,
        custom: this.isCustom(d.id) || undefined,
        installed: Boolean(inst),
        sha: inst?.sha,
        installedAt: inst?.installedAt,
        supplyChainDecision: inst?.supplyChain?.decision,
        supplyChainFindings: inst?.supplyChain?.findings.length,
        licenseFiles: inst?.supplyChain?.licenseFiles,
        updateAvailable: Boolean(inst && this.data.updates[d.id] && this.data.updates[d.id] !== inst.sha)
      }
    })
  }

  installedIds(): string[] {
    return this.defs.filter((d) => this.isSelectable(d.id)).map((d) => d.id)
  }

  /** Congela a identidade do pacote antes de emitir receipts. */
  async activationIdentity(id: string): Promise<SkillActivationIdentity | undefined> {
    const def = this.byId(id)
    if (!def || def.kind !== 'skill') return undefined
    const installed = await this.installedForExecution(id, true)
    if (!installed) return undefined
    return {
      id,
      version: installed.sha,
      fingerprint: installed.supplyChain?.fingerprint ?? installed.sha
    }
  }

  /** Copia a árvore integral para uma raiz privada do pane, fora da descoberta
   * automática de Claude/Codex. A identidade esperada fecha a janela de update. */
  async materializeActivationTree(
    id: string,
    runtimeRoot: string,
    paneId: string,
    phaseRun: string,
    expectedVersion: string,
    expectedFingerprint: string,
    adapterContent?: string
  ): Promise<string | undefined> {
    const identity = await this.activationIdentity(id)
    if (
      !identity ||
      identity.version !== expectedVersion ||
      identity.fingerprint !== expectedFingerprint
    ) {
      return undefined
    }
    try {
      const privateRoot = await gitOff(
        'materializePrivateSkillPackage',
        join(this.libDir, id),
        runtimeRoot,
        paneId,
        phaseRun,
        id,
        id === 'impeccable' ? adapterContent : undefined
      )
      if (id !== 'impeccable') {
        const snapshot = await gitOff('assessSkillPackage', privateRoot)
        if (snapshot.decision === 'block' || snapshot.fingerprint !== expectedFingerprint) {
          await gitOff('removePrivateSkillPlan', runtimeRoot, paneId, phaseRun, id)
          return undefined
        }
      }
      return privateRoot
    } catch {
      await gitOff('removePrivateSkillPlan', runtimeRoot, paneId, phaseRun, id).catch(
        () => undefined
      )
      return undefined
    }
  }

  /** Reavalia em lote pacotes instalados SEM assessment persistido (legado
   *  pré-supply-chain — caso real 2026-08-04: 382 de 383 sem o campo, todas
   *  fora dos menus). Devolve quantos ainda faltam; o chamador agenda o
   *  próximo lote fora do caminho quente. */
  async assessMissingBatch(limit = 8): Promise<number> {
    const pending = Object.keys(this.data.installed).filter(
      (id) => !this.data.installed[id]?.supplyChain
    )
    for (const id of pending.slice(0, Math.max(1, limit))) await this.installedForExecution(id)
    return Math.max(0, pending.length - limit)
  }

  isInstalled(id: string): boolean {
    return Boolean(this.data.installed[id])
  }

  /** Elegibilidade síncrona para menus/carimbos; a execução ainda revalida
   * os bytes assincronamente antes de emitir o receipt. */
  isSelectable(id: string): boolean {
    const def = this.byId(id)
    if (!def || !this.isEligibleInstalled(id)) return false
    return !def.bundledBody || this.bundledPackageMatches(id)
  }

  /** Total bruto de instaladas, SEM filtro de elegibilidade — para detectar
   *  divergência "biblioteca cheia × menu vazio" (auditoria 2026-08-04). */
  installedRawCount(): number {
    return Object.keys(this.data.installed).length
  }

  /** Padrão da função: itens marcados defaultFor E instalados. */
  defaultIdsFor(dept: Department, kind: 'skill' | 'agent' = 'skill'): string[] {
    return this.defs
      .filter((d) => d.kind === kind && d.defaultFor?.includes(dept) && this.isSelectable(d.id))
      .map((d) => d.id)
  }

  /** TODAS as elegíveis de uma função para UI/busca. O executor nunca recebe
   * este conjunto inteiro; skillsRouting escolhe um plano mínimo por fase. */
  installedIdsForDept(dept: Department, kind: 'skill' | 'agent' = 'skill'): string[] {
    return selectInstalledIdsForDepartment(
      this.defs,
      (id) => this.isSelectable(id),
      dept,
      kind
    )
  }

  /** Carrega a instrucao exata selecionada pelo roteador. O chamador fornece
   * somente id + operacao provenientes de um receipt; texto livre nunca vira
   * caminho. A resposta nao inclui paths locais nem metadados sensiveis. */
  async loadActivationPackage(
    id: string,
    operation: string
  ): Promise<SkillActivationPackage | undefined> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(operation)) return undefined
    const def = this.byId(id)
    if (!def || def.kind !== 'skill') return undefined
    const installed = await this.installedForExecution(id, true)
    if (!installed) return undefined
    const root = join(this.libDir, id)
    const rootFile = join(root, 'SKILL.md')
    if (!existsSync(rootFile)) return undefined

    const referenceNames: string[] = []
    if (id === 'impeccable') {
      referenceNames.push(`reference/${operation}.md`)
    } else if (id === 'synkora-frontend-standard') {
      referenceNames.push(
        ['adapt', 'harden'].includes(operation)
          ? 'references/responsive-content.md'
          : 'references/composition.md'
      )
      referenceNames.push('references/evidence.md')
    } else if (id === 'synkora-ui-qa') {
      referenceNames.push('references/visual-review.md', 'references/runtime-checks.md')
    } else if (id === 'synkora-design-system-standard') {
      referenceNames.push(
        'references/foundations.md',
        'references/components-patterns.md',
        'references/showcase.md',
        'references/governance.md',
        'references/evidence.md'
      )
    } else if (id === 'synkora-design-system-qa') {
      referenceNames.push(
        'references/system-integrity.md',
        'references/specimen-runtime.md',
        'references/governance-evidence.md'
      )
    } else if (id === 'synkora-backend-standard') {
      referenceNames.push(
        'references/contracts-boundaries.md',
        'references/data-concurrency.md',
        'references/failure-observability.md'
      )
    } else if (id === 'synkora-backend-qa') {
      referenceNames.push(
        'references/api-runtime.md',
        'references/data-failure.md',
        'references/evidence.md'
      )
    } else if (id === 'synkora-devops-standard') {
      referenceNames.push(
        'references/ci-artifacts.md',
        'references/infrastructure-containers.md',
        'references/rollout-recovery.md'
      )
    } else if (id === 'synkora-devops-qa') {
      referenceNames.push(
        'references/pipeline-infrastructure.md',
        'references/recovery-evidence.md'
      )
    } else if (id === 'synkora-cyber-standard') {
      referenceNames.push(
        'references/trust-boundaries.md',
        'references/secrets-supply-chain.md',
        'references/llm-mcp.md',
        'references/evidence-remediation.md'
      )
    } else if (id === 'synkora-cyber-qa') {
      referenceNames.push(
        'references/remediation-verification.md',
        'references/authorization-data.md',
        'references/agent-supply-chain.md',
        'references/evidence.md'
      )
    } else if (id === 'synkora-data-standard') {
      referenceNames.push(
        'references/source-context.md',
        'references/analysis-validity.md',
        'references/delivery-evidence.md'
      )
    } else if (id === 'synkora-data-qa') {
      referenceNames.push(
        'references/reconciliation.md',
        'references/method-evidence.md'
      )
    } else if (id === 'synkora-research-standard') {
      referenceNames.push(
        'references/question-source-plan.md',
        'references/claim-citation.md',
        'references/synthesis-uncertainty.md'
      )
    } else if (id === 'synkora-research-qa') {
      referenceNames.push(
        'references/source-audit.md',
        'references/synthesis-audit.md'
      )
    } else if (id === 'synkora-copy-standard') {
      referenceNames.push(
        'references/brief-voice-proof.md',
        'references/channel-structure.md',
        'references/clarity-consent.md'
      )
    } else if (id === 'synkora-copy-qa') {
      referenceNames.push(
        'references/claim-voice.md',
        'references/channel-completeness.md',
        'references/safety-accessibility.md'
      )
    } else if (id === 'synkora-qa-standard') {
      referenceNames.push(
        'references/test-strategy.md',
        'references/oracles-fixtures.md',
        'references/reliability-evidence.md'
      )
    } else if (id === 'synkora-qa-qa') {
      referenceNames.push(
        'references/independent-audit.md',
        'references/verdict-evidence.md'
      )
    }

    try {
      const chunks = id === 'impeccable' ? [] : [readFileSync(rootFile, 'utf8')]
      const loadedReferences: string[] = []
      for (const name of [...new Set(referenceNames)]) {
        const file = safeBundledDestination(root, name)
        if (!existsSync(file)) {
          if (id === 'impeccable') return undefined
          continue
        }
        const reference = readFileSync(file, 'utf8')
        if (id === 'impeccable') {
          const adapted = buildSynkoraImpeccableActivation(operation, reference)
          if (!adapted) return undefined
          chunks.push(adapted)
        } else {
          chunks.push(`\n\n--- selected reference: ${name} ---\n\n${reference}`)
        }
        loadedReferences.push(name)
      }
      const content = chunks.join('')
      if (Buffer.byteLength(content, 'utf8') > 768 * 1024) return undefined
      const sourceFingerprint = installed.supplyChain?.fingerprint ?? installed.sha
      const fingerprint = createHash('sha256')
        .update(sourceFingerprint)
        .update('\0')
        .update(operation)
        .update('\0')
        .update(content)
        .digest('hex')
      return {
        id,
        operation,
        version: installed.sha,
        fingerprint,
        sourceFingerprint,
        content,
        loadedReferences
      }
    } catch {
      return undefined
    }
  }

  /** Um método-base de PLANEJAMENTO instalado — injetado no workspace do PM e dos
   *  orquestradores no spawn do pane (a persona manda consultá-las antes de
   *  planejar). */
  orchestratorPlanningIds(): string[] {
    return selectInstalledPlanningIds(this.defs, (id) => this.isSelectable(id))
  }

  /** Corpo (sem frontmatter) de um SUBAGENTE instalado — vira o system
   *  prompt do ajudante em pane (--append-system-prompt / developer_instructions). */
  async agentBody(id: string): Promise<string | null> {
    const def = this.byId(id)
    if (!def || def.kind !== 'agent' || !(await this.installedForExecution(id))) return null
    try {
      const md = readFileSync(join(this.libDir, id, 'agent.md'), 'utf-8')
      const body = md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim()
      return body || null
    } catch {
      return null
    }
  }

  /** Fecho transitivo de requires (routers arrastam as irmãs). */
  private withRequires(ids: string[]): string[] {
    const out = new Set<string>()
    const walk = (id: string): void => {
      if (out.has(id)) return
      out.add(id)
      for (const dep of this.byId(id)?.requires ?? []) walk(dep)
    }
    for (const id of ids) walk(id)
    return [...out]
  }

  /** HEAD do repo (sha do commit do topo do ref) — com cache de rajada. */
  private async repoHead(src: SkillSource): Promise<{ sha?: string; err?: string }> {
    const key = `${src.repo}@${src.ref ?? ''}`
    const hit = this.headCache.get(key)
    if (hit && Date.now() - hit.at < BURST_CACHE_MS) return { sha: hit.sha }
    const q = `per_page=1${src.ref ? `&sha=${encodeURIComponent(src.ref)}` : ''}`
    const res = await gh(`https://api.github.com/repos/${src.repo}/commits?${q}`)
    if (res.status === 403 || res.status === 429) return { err: rateMsg(res) }
    const sha = Array.isArray(res.body) ? (res.body as { sha?: string }[])[0]?.sha : undefined
    if (!sha) return { err: `repo ${src.repo} não respondeu (HTTP ${res.status})` }
    this.headCache.set(key, { sha, at: Date.now() })
    // o HEAD visto agora também alimenta o estágio 1 do update-check
    ;(this.data.repoHeads ??= {})[key] = { sha, etag: res.etag ?? this.data.repoHeads?.[key]?.etag }
    return { sha }
  }

  /** Tree recursiva do sha — com cache de rajada. Só arquivos normais
   *  (symlink 120000 e submodule 160000 ficam de fora). */
  private async repoTree(repo: string, sha: string): Promise<{ files?: TreeFile[]; err?: string }> {
    const key = `${repo}@${sha}`
    const hit = this.treeCache.get(key)
    if (hit && Date.now() - hit.at < BURST_CACHE_MS * 5) return { files: hit.files }
    const res = await gh(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`)
    if (res.status === 403 || res.status === 429) return { err: rateMsg(res) }
    const body = res.body as
      | { tree?: { path?: string; type?: string; size?: number; mode?: string }[]; truncated?: boolean }
      | undefined
    if (res.status !== 200 || !body?.tree) return { err: `tree do repo falhou (HTTP ${res.status})` }
    const files = body.tree
      .filter(
        (t) =>
          t.type === 'blob' &&
          typeof t.path === 'string' &&
          (t.mode === '100644' || t.mode === '100755' || t.mode === undefined)
      )
      .map((t) => ({ path: t.path as string, size: t.size }))
    this.treeCache.set(key, { files, at: Date.now() })
    return { files }
  }

  /** Baixa UMA skill/subagente a partir de um tree já em mãos (0 requests
   *  core). Subagente = ARQUIVO ÚNICO .md (source.path aponta o arquivo);
   *  vira lib/<id>/agent.md; a persona só nasce por delegate.agent. */
  private async downloadOne(def: SkillDef, headSha: string, files: TreeFile[]): Promise<{ ok: boolean; msg: string }> {
    if (def.kind === 'agent') {
      const f = files.find((x) => x.path === def.source.path)
      if (!f) return { ok: false, msg: `arquivo ${def.source.path} não existe no repo (fonte mudou?)` }
      if ((f.size ?? 0) > MAX_FILE_BYTES) return { ok: false, msg: 'agente acima de 4MB' }
      const buf = await fetchRaw(def.source.repo, headSha, f.path)
      const fm = parseFrontmatter(buf.toString('utf-8'))
      // o name do frontmatter é o nome INVOCÁVEL — divergência do id
      // instalaria um agente com outro nome no menu (catálogo mentiroso)
      if (fm.name && fm.name.trim().toLowerCase() !== def.id)
        return { ok: false, msg: `frontmatter name "${fm.name}" difere do id "${def.id}" (fonte mudou?)` }
      const staging = join(this.baseDir, `.staging-${def.id}`)
      rmSync(staging, { recursive: true, force: true })
      mkdirSync(staging, { recursive: true })
      writeFileSync(join(staging, 'agent.md'), buf)
      const assessment = assessSkillPackage(staging)
      const blocked = skillPackageBlockMessage(assessment)
      if (blocked) {
        rmSync(staging, { recursive: true, force: true })
        return { ok: false, msg: blocked }
      }
      const dest = join(this.libDir, def.id)
      rmSync(dest, { recursive: true, force: true })
      renameSync(staging, dest)
      this.data.installed[def.id] = {
        sha: headSha,
        installedAt: new Date().toISOString(),
        supplyChain: assessment
      }
      this.executionAssessmentCache.set(def.id, { assessment, verifiedAt: Date.now() })
      delete this.data.updates[def.id]
      return {
        ok: true,
        msg: `${def.id} instalado (subagente)${assessment.decision === 'review' ? ` — ${assessment.findings.length} sinal(is) de supply chain para revisão` : ''}`
      }
    }
    const prefix = def.source.path ? `${def.source.path}/` : ''
    const inTree = files.filter((f) => f.path.startsWith(prefix))
    const skillMdPath = `${prefix}SKILL.md`
    const skillMd = inTree.find((f) => f.path === skillMdPath)
    if (!skillMd)
      return { ok: false, msg: `a pasta ${def.source.path || '(raiz)'} não tem SKILL.md (fonte mudou?)` }
    if ((skillMd.size ?? 0) > MAX_FILE_BYTES)
      return { ok: false, msg: 'SKILL.md acima de 4MB — a skill em si está quebrada' }
    const skipped: string[] = []
    const mine = inTree.filter((f) => {
      if (f.path === skillMdPath) return true
      if (SKIP_MEDIA_RE.test(f.path) || (f.size ?? 0) > MAX_FILE_BYTES) {
        skipped.push(f.path)
        return false
      }
      return true
    })
    if (mine.length > MAX_FILES) return { ok: false, msg: `skill grande demais (${mine.length} arquivos; teto ${MAX_FILES})` }
    const total = mine.reduce((n, f) => n + (f.size ?? 0), 0)
    if (total > MAX_TOTAL_BYTES)
      return { ok: false, msg: `skill grande demais (${Math.round(total / 1024 / 1024)}MB; teto 30MB)` }

    const staging = join(this.baseDir, `.staging-${def.id}`)
    rmSync(staging, { recursive: true, force: true })
    const queue = [...mine]
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      for (;;) {
        const f = queue.shift()
        if (!f) return
        const buf = await fetchRaw(def.source.repo, headSha, f.path)
        const dest = join(staging, prefix ? f.path.slice(prefix.length) : f.path)
        mkdirSync(dirname(dest), { recursive: true })
        writeFileSync(dest, buf)
      }
    })
    await Promise.all(workers)
    const assessment = assessSkillPackage(staging)
    const blocked = skillPackageBlockMessage(assessment)
    if (blocked) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, msg: blocked }
    }
    const dest = join(this.libDir, def.id)
    rmSync(dest, { recursive: true, force: true })
    renameSync(staging, dest)
    this.data.installed[def.id] = {
      sha: headSha,
      installedAt: new Date().toISOString(),
      supplyChain: assessment
    }
    this.executionAssessmentCache.set(def.id, { assessment, verifiedAt: Date.now() })
    delete this.data.updates[def.id]
    return {
      ok: true,
      msg: `${def.id} instalada (${mine.length} arquivo${mine.length > 1 ? 's' : ''})${assessment.decision === 'review' ? ` — ${assessment.findings.length} sinal(is) de supply chain para revisão` : ''}`
    }
  }

  /** Instala VÁRIAS skills numa rodada — 1 HEAD + 1 tree por repo, não por
   *  skill (o que estourava o rate limit). requires entram sozinhas.
   *  Itens EMBUTIDOS (bundledBody) instalam sem rede nenhuma. */
  async installMany(ids: string[]): Promise<{ ok: boolean; msg: string }> {
    const all = this.withRequires([...new Set(ids)]).filter((id) => !this.busy.has(id))
    const defs = all.map((id) => this.byId(id)).filter((d): d is SkillDef => Boolean(d))
    if (!defs.length) return { ok: false, msg: 'nenhuma skill válida para instalar' }
    for (const d of defs) this.busy.add(d.id)
    try {
      const okMsgs: string[] = []
      const failMsgs: string[] = []
      const remote: SkillDef[] = []
      for (const d of defs) {
        if (!d.bundledBody) {
          remote.push(d)
          continue
        }
        try {
          const staging = join(this.baseDir, `.staging-${d.id}`)
          rmSync(staging, { recursive: true, force: true })
          mkdirSync(staging, { recursive: true })
          // Skill embutida grava SKILL.md (spec: pasta=name + frontmatter);
          // subagente embutido segue em agent.md. UTF-8 SEM BOM sempre (o BOM
          // quebra o parse de frontmatter nos DOIS CLIs — lição F6.0).
          writeBundledPackage(staging, d)
          const assessment = assessSkillPackage(staging)
          const blocked = skillPackageBlockMessage(assessment)
          if (blocked) {
            rmSync(staging, { recursive: true, force: true })
            failMsgs.push(`${d.id}: ${blocked}`)
            continue
          }
          const dest = join(this.libDir, d.id)
          rmSync(dest, { recursive: true, force: true })
          renameSync(staging, dest)
          this.data.installed[d.id] = {
            sha: bundledPackageSha(
              d.bundledBody,
              d.bundledFiles,
              d.kind === 'agent' ? 'agent.md' : 'SKILL.md'
            ),
            installedAt: new Date().toISOString(),
            supplyChain: assessment
          }
          this.executionAssessmentCache.set(d.id, { assessment, verifiedAt: Date.now() })
          delete this.data.updates[d.id]
          okMsgs.push(
            `${d.id} instalado (${d.kind === 'agent' ? 'subagente' : 'skill'} do Synkora)`
          )
        } catch (e) {
          failMsgs.push(`${d.id}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      const groups = new Map<string, SkillDef[]>()
      for (const d of remote) {
        const key = `${d.source.repo}@${d.source.ref ?? ''}`
        groups.set(key, [...(groups.get(key) ?? []), d])
      }
      for (const group of groups.values()) {
        const src = group[0].source
        const head = await this.repoHead(src)
        if (!head.sha) {
          failMsgs.push(...group.map((d) => `${d.id}: ${head.err}`))
          continue
        }
        const tree = await this.repoTree(src.repo, head.sha)
        if (!tree.files) {
          failMsgs.push(...group.map((d) => `${d.id}: ${tree.err}`))
          continue
        }
        for (const d of group) {
          try {
            const r = await this.downloadOne(d, head.sha, tree.files)
            ;(r.ok ? okMsgs : failMsgs).push(r.ok ? r.msg : `${d.id}: ${r.msg}`)
          } catch (e) {
            failMsgs.push(`${d.id}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        // instalação em massa ("⭳ instalar tudo"): persistir e avisar a UI
        // POR GRUPO — os ✓ acendem ao vivo em vez de um spinner mudo de
        // minutos; e se a cota estourar no meio, o que baixou já está salvo.
        this.persist()
        this.notify()
      }
      this.persist()
      this.notify()
      const parts: string[] = []
      if (okMsgs.length)
        parts.push(okMsgs.length > 8 ? `${okMsgs.length} itens instalados` : okMsgs.join(' · '))
      if (failMsgs.length)
        parts.push(
          failMsgs.length > 6
            ? `FALHOU: ${failMsgs.length} itens — ex.: ${failMsgs.slice(0, 3).join(' · ')} … (o que instalou FICA; clique de novo mais tarde)`
            : `FALHOU: ${failMsgs.join(' · ')}`
        )
      return { ok: okMsgs.length > 0, msg: parts.join(' — ') || 'nada a fazer' }
    } finally {
      for (const d of defs) this.busy.delete(d.id)
    }
  }

  install(id: string): Promise<{ ok: boolean; msg: string }> {
    return this.installMany([id])
  }

  update(id: string): Promise<{ ok: boolean; msg: string }> {
    return this.installMany([id])
  }

  /** Skill CUSTOM do usuário: URL do GitHub (repo ou …/tree/<ref>/<pasta>).
   *  O id/descrição saem do SKILL.md real; a função é a escolhida na UI. */
  async addCustom(url: string, dept: Department): Promise<{ ok: boolean; msg: string }> {
    const source = parseSkillUrl(url)
    if (!source)
      return {
        ok: false,
        msg: parseAgentUrl(url)
          ? 'esse link é de um ARQUIVO .md — para subagente, use o "+ adicionar subagente" na seção de subagentes'
          : 'URL inválida — use "owner/repo" ou o link da pasta da skill (github.com/owner/repo/tree/main/skills/nome)'
      }
    const head = await this.repoHead(source)
    if (!head.sha) return { ok: false, msg: head.err ?? 'repo inacessível' }
    let md: string
    try {
      md = (await fetchRaw(source.repo, head.sha, source.path ? `${source.path}/SKILL.md` : 'SKILL.md')).toString('utf-8')
    } catch {
      return {
        ok: false,
        msg: `não achei SKILL.md em ${source.repo}${source.path ? `/${source.path}` : ''} — aponte a PASTA da skill (…/tree/main/skills/nome)`
      }
    }
    const fm = parseFrontmatter(md)
    const id = fm.name?.toLowerCase()
    if (!id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || id.includes('--'))
      return { ok: false, msg: `frontmatter sem "name:" válido no SKILL.md (achei: "${fm.name ?? '—'}")` }
    if (this.byId(id))
      return { ok: false, msg: `já existe uma skill "${id}" na biblioteca${this.isInstalled(id) ? ' (instalada)' : ''}` }
    const desc = (fm.description ?? '').slice(0, 220)
    const def: SkillDef = {
      id,
      kind: 'skill',
      depts: [dept],
      group: 'adicionadas por você',
      source,
      summary: desc || `Skill adicionada por você (${source.repo}).`,
      hint: desc || `Custom skill from ${source.repo}.`
    }
    this.defs.push(def)
    ;(this.data.custom ??= []).push(def)
    this.persist()
    const r = await this.installMany([id])
    return r.ok ? { ok: true, msg: `skill "${id}" adicionada e instalada (${source.repo})` } : r
  }

  /** SUBAGENTE custom: URL do ARQUIVO .md no GitHub (blob ou raw). O id sai
   *  do frontmatter `name:` real (validado de novo no download); entra na
   *  função escolhida na UI e persiste como custom igual às skills. */
  async addCustomAgent(url: string, dept: Department): Promise<{ ok: boolean; msg: string }> {
    const source = parseAgentUrl(url)
    if (!source)
      return {
        ok: false,
        msg: 'URL inválida — aponte o ARQUIVO .md do agente (github.com/owner/repo/blob/main/agents/nome.md)'
      }
    const head = await this.repoHead(source)
    if (!head.sha) return { ok: false, msg: head.err ?? 'repo inacessível' }
    let md: string
    try {
      md = (await fetchRaw(source.repo, head.sha, source.path)).toString('utf-8')
    } catch {
      return { ok: false, msg: `não achei ${source.path} em ${source.repo} — confira o link do arquivo` }
    }
    const fm = parseFrontmatter(md)
    const id = fm.name?.trim().toLowerCase()
    if (!id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || id.includes('--'))
      return { ok: false, msg: `frontmatter sem "name:" válido no .md (achei: "${fm.name ?? '—'}")` }
    if (this.byId(id))
      return {
        ok: false,
        msg: `já existe "${id}" na biblioteca${this.isInstalled(id) ? ' (instalado)' : ''} — ids são globais entre skills e subagentes`
      }
    const desc = (fm.description ?? '').slice(0, 220)
    const def: SkillDef = {
      id,
      kind: 'agent',
      depts: [dept],
      group: 'adicionados por você',
      source,
      summary: desc || `Subagente adicionado por você (${source.repo}).`,
      hint: desc || `Custom subagent from ${source.repo}.`
    }
    this.defs.push(def)
    ;(this.data.custom ??= []).push(def)
    this.persist()
    const r = await this.installMany([id])
    return r.ok ? { ok: true, msg: `subagente "${id}" adicionado e instalado (${source.repo})` } : r
  }

  remove(id: string): { ok: boolean; msg: string } {
    if (this.byId(id)?.bundledBody)
      return { ok: false, msg: `skill "${id}" faz parte do Synkora e não pode ser removida` }
    if (!this.data.installed[id] && !this.isCustom(id))
      return { ok: false, msg: `skill "${id}" não está instalada` }
    rmSync(join(this.libDir, id), { recursive: true, force: true })
    delete this.data.installed[id]
    delete this.data.updates[id]
    this.executionAssessmentCache.delete(id)
    if (this.isCustom(id)) {
      this.data.custom = (this.data.custom ?? []).filter((c) => c.id !== id)
      this.defs = this.defs.filter((d) => d.id !== id)
    }
    this.persist()
    this.notify()
    return { ok: true, msg: `skill "${id}" removida da biblioteca` }
  }

  /**
   * PORTABILIDADE (pedido do usuário, 2026-07-30): a biblioteca mora em
   * userData/skills — noutro PC seria re-baixar tudo, e a curadoria completa
   * não cabe na quota anônima do GitHub. Export = UM .zip com manifest.json
   * (installed/custom/updates/repoHeads+etags) + lib/ completa.
   */
  exportTo(zipPath: string): { ok: boolean; msg: string } {
    try {
      const zip = new AdmZip()
      if (!Object.keys(this.data.installed).length)
        return { ok: false, msg: 'nada instalado para exportar' }
      const manifestData = Buffer.from(JSON.stringify(this.data, null, 2), 'utf8')
      if (manifestData.byteLength > MAX_SKILL_ARCHIVE_CONTROL_FILE_BYTES)
        return { ok: false, msg: 'export falhou: manifest.json excede o teto seguro' }
      // Não propaga estado local corrompido para outro computador. Campos de
      // assessment seguem no JSON, mas o importador nunca confia neles.
      if (
        !validateImportedSkillArchiveManifest(
          JSON.parse(ARCHIVE_TEXT_DECODER.decode(manifestData)) as unknown
        )
      )
        return { ok: false, msg: 'export falhou: o manifesto local tem estrutura inválida' }

      const integrityEntries: SkillArchiveEntry[] = [
        { path: SKILL_ARCHIVE_MANIFEST_FILE, data: manifestData }
      ]
      zip.addFile(SKILL_ARCHIVE_MANIFEST_FILE, manifestData)
      let count = 0
      let totalBytes = manifestData.byteLength
      for (const id of Object.keys(this.data.installed).sort((left, right) =>
        left.localeCompare(right, 'en')
      )) {
        const dir = join(this.libDir, id)
        if (!existsSync(dir)) throw new Error(`pacote instalado não encontrado: ${id}`)
        for (const file of collectExportArchiveFiles(dir, id)) {
          if (integrityEntries.length + 2 > MAX_SKILL_ARCHIVE_ENTRIES)
            throw new Error(`arquivo excede o teto de ${MAX_SKILL_ARCHIVE_ENTRIES} entradas`)
          const data = readFileSync(file.absolutePath)
          if (data.byteLength !== file.bytes || data.byteLength > MAX_FILE_BYTES)
            throw new Error(`arquivo mudou durante o export: ${file.archivePath}`)
          totalBytes += data.byteLength
          if (totalBytes > MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES)
            throw new Error('biblioteca excede o teto de 512MB para exportação')
          zip.addFile(file.archivePath, data)
          integrityEntries.push({ path: file.archivePath, data })
        }
        count++
      }
      if (!count) return { ok: false, msg: 'nada instalado para exportar' }
      const integrityData = Buffer.from(
        JSON.stringify(createSkillArchiveIntegrity(integrityEntries), null, 2),
        'utf8'
      )
      if (integrityData.byteLength > MAX_SKILL_ARCHIVE_CONTROL_FILE_BYTES)
        throw new Error('integrity.json excede o teto seguro')
      if (totalBytes + integrityData.byteLength > MAX_SKILL_ARCHIVE_UNCOMPRESSED_BYTES)
        throw new Error('biblioteca excede o teto de 512MB para exportação')
      zip.addFile(SKILL_ARCHIVE_INTEGRITY_FILE, integrityData)

      const preflight = validateSkillArchiveMetadata(zip.getEntries().map(zipEntryMetadata))
      if (!preflight.ok)
        throw new Error(`ZIP gerado não passou na validação (${preflight.reason ?? 'estrutura inválida'})`)
      const archiveData = zip.toBuffer()
      if (archiveData.byteLength > MAX_SKILL_ARCHIVE_COMPRESSED_BYTES)
        throw new Error(
          `ZIP final excede o teto de ${MAX_SKILL_ARCHIVE_COMPRESSED_BYTES / 1024 / 1024}MB`
        )
      writeFileSync(zipPath, archiveData)
      return {
        ok: true,
        msg: `${count} ite${count === 1 ? 'm' : 'ns'} — a biblioteca INTEIRA (todas as funções) → ${zipPath}`
      }
    } catch (e) {
      return { ok: false, msg: `export falhou: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** Import do .zip exportado em outra máquina: skills/subagentes entram na
   *  lib SEM rede nenhuma; skills custom vêm junto (a def viaja no manifest)
   *  e os pins de sha/etag também — o 1º update-check na máquina nova não
   *  paga a quota do zero. Sobrescreve item já instalado (o zip é a fonte). */
  importFrom(zipPath: string): { ok: boolean; msg: string } {
    try {
      const archiveStat = statSync(zipPath)
      if (!archiveStat.isFile())
        return { ok: false, msg: 'import recusado: o caminho não é um arquivo' }
      if (
        !Number.isSafeInteger(archiveStat.size) ||
        archiveStat.size < 0 ||
        archiveStat.size > MAX_SKILL_ARCHIVE_COMPRESSED_BYTES
      )
        return {
          ok: false,
          msg: `import recusado: ZIP excede o teto de ${MAX_SKILL_ARCHIVE_COMPRESSED_BYTES / 1024 / 1024}MB`
        }
      const zip = new AdmZip(zipPath)
      const archiveEntries = zip.getEntries()
      const preflight = validateSkillArchiveMetadata(archiveEntries.map(zipEntryMetadata))
      if (!preflight.ok)
        return {
          ok: false,
          msg: `import recusado: estrutura do ZIP inválida (${preflight.reason ?? 'conteúdo inesperado'})`
        }

      // A unicidade foi provada antes de procurar por nome. Assim um alias ou
      // uma duplicata de integrity.json nunca transforma o ZIP em "legado".
      const integrityEntry = archiveEntries.find(
        (entry) => !entry.isDirectory && entry.entryName === SKILL_ARCHIVE_INTEGRITY_FILE
      )
      const legacyArchive = !integrityEntry
      if (integrityEntry) {
        const digests = []
        for (const entry of archiveEntries) {
          if (entry.isDirectory || entry === integrityEntry) continue
          const maxBytes =
            entry.entryName === SKILL_ARCHIVE_MANIFEST_FILE
              ? MAX_SKILL_ARCHIVE_CONTROL_FILE_BYTES
              : MAX_FILE_BYTES
          // O formato novo nunca usa a exceção histórica de payload grande:
          // cada conteúdo é descompactado com teto absoluto antes do hash.
          const data = readZipEntryCapped(entry, maxBytes)
          digests.push(createSkillArchiveDigest({ path: entry.entryName, data }))
        }
        const integrity = verifySkillArchiveIntegrityDigests(
          digests,
          readZipEntryCapped(integrityEntry, MAX_SKILL_ARCHIVE_CONTROL_FILE_BYTES)
        )
        if (!integrity.ok)
          return {
            ok: false,
            msg: `import recusado: integridade do arquivo falhou (${integrity.reason ?? 'conteúdo inesperado'})`
          }
      }
      const manEntry = archiveEntries.find(
        (entry) => !entry.isDirectory && entry.entryName === SKILL_ARCHIVE_MANIFEST_FILE
      )!
      let man: SkillsManifest
      try {
        const parsed = JSON.parse(
          ARCHIVE_TEXT_DECODER.decode(
            readZipEntryCapped(manEntry, MAX_SKILL_ARCHIVE_CONTROL_FILE_BYTES)
          )
        ) as unknown
        const validated = validateImportedSkillArchiveManifest(parsed)
        if (!validated)
          return { ok: false, msg: 'manifest.json do export tem estrutura inválida' }
        man = validated
      } catch {
        return { ok: false, msg: 'manifest.json do export está corrompido' }
      }
      // A metadata custom permanece em quarentena até o pacote correspondente
      // ser extraído e aprovado pela análise local.
      const customById = new Map((man.custom ?? []).map((custom) => [custom.id, custom]))
      const byId = new Map<string, AdmZip.IZipEntry[]>()
      for (const en of archiveEntries) {
        if (en.isDirectory || !en.entryName.startsWith('lib/')) continue
        const parts = en.entryName.split('/')
        const id = parts[1]
        if (!man.installed[id])
          return { ok: false, msg: `manifest.json não declara o pacote ${id}` }
        byId.set(id, [...(byId.get(id) ?? []), en])
      }
      for (const id of Object.keys(man.installed)) {
        if (!byId.has(id))
          return { ok: false, msg: `manifest.json declara ${id}, mas o pacote não existe no ZIP` }
      }

      // Exports legados podiam carregar demos e arquivos >4MB que já eram
      // ignorados na instalação. Eles continuam compatíveis, mas apenas o
      // conjunto efetivamente gravável entra nos limites por pacote.
      for (const [id, entries] of byId) {
        const selected = entries.filter((entry) => {
          const rel = entry.entryName.split('/').slice(2).join('/')
          return !SKIP_MEDIA_RE.test(rel) && entry.header.size <= MAX_FILE_BYTES
        })
        if (selected.length > MAX_FILES)
          return { ok: false, msg: `import recusado: ${id} excede ${MAX_FILES} arquivos` }
        const total = selected.reduce((sum, entry) => sum + entry.header.size, 0)
        if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES)
          return { ok: false, msg: `import recusado: ${id} excede o teto de 30MB` }
      }
      let imported = 0
      let blockedPackages = 0
      let protectedBundledPackages = 0
      for (const [id, entries] of byId) {
        const def = this.byId(id) ?? customById.get(id)
        // Uma versão antiga do app pode receber um export de curadoria mais
        // nova. O pacote desconhecido é validado, mas segue ignorado.
        if (!def) continue
        // Backup restaura itens do usuário; contratos do app ficam na versão atual.
        if (def.bundledBody) {
          protectedBundledPackages++
          continue
        }
        const staging = join(this.baseDir, `.staging-${id}`)
        rmSync(staging, { recursive: true, force: true })
        for (const en of entries) {
          const rel = en.entryName.split('/').slice(2).join('/')
          if (SKIP_MEDIA_RE.test(rel) || en.header.size > MAX_FILE_BYTES) continue
          const dest = join(staging, ...rel.split('/'))
          if (resolve(dest) !== resolve(staging) && !resolve(dest).startsWith(resolve(staging) + sep))
            throw new Error(`destino escapou da área temporária: ${en.entryName}`)
          mkdirSync(dirname(dest), { recursive: true })
          writeFileSync(dest, readZipEntryCapped(en, MAX_FILE_BYTES))
        }
        const requiredEntry = def.kind === 'agent' ? 'agent.md' : 'SKILL.md'
        if (!existsSync(join(staging, requiredEntry))) {
          rmSync(staging, { recursive: true, force: true })
          return { ok: false, msg: `pacote ${id} não contém ${requiredEntry}` }
        }
        const assessment = assessSkillPackage(staging)
        if (skillPackageBlockMessage(assessment)) {
          blockedPackages++
          rmSync(staging, { recursive: true, force: true })
          continue
        }
        const dest = join(this.libDir, id)
        rmSync(dest, { recursive: true, force: true })
        renameSync(staging, dest)
        const custom = customById.get(id)
        if (custom && !this.byId(id)) {
          this.defs.push(custom)
          ;(this.data.custom ??= []).push(custom)
        }
        const importedInfo = man.installed[id]
        this.data.installed[id] = {
          sha: importedInfo?.sha ?? 'imported',
          installedAt: importedInfo?.installedAt ?? new Date().toISOString(),
          // O conteúdo extraído é a fonte; um assessment declarado no ZIP
          // nunca é aceito sem ser recalculado localmente.
          supplyChain: assessment
        }
        this.executionAssessmentCache.set(id, { assessment, verifiedAt: Date.now() })
        delete this.data.updates[id]
        imported++
      }
      for (const [k, v] of Object.entries(man.repoHeads ?? {})) (this.data.repoHeads ??= {})[k] ??= v
      if (!imported && blockedPackages) {
        this.persist()
        this.notify()
        return {
          ok: false,
          msg: `${blockedPackages} pacote(s) bloqueado(s) pela análise local de supply chain`
        }
      }
      this.persist()
      this.notify()
      if (!imported && protectedBundledPackages)
        return {
          ok: true,
          msg: `${protectedBundledPackages} pacote(s) do Synkora preservado(s) na versão do aplicativo`
        }
      if (!imported) return { ok: false, msg: 'nada compatível para importar nesse arquivo' }
      return {
        ok: true,
        msg: `${imported} ite${imported === 1 ? 'm importado' : 'ns importados'} — biblioteca pronta, sem baixar nada${protectedBundledPackages ? `; ${protectedBundledPackages} pacote(s) do Synkora preservado(s)` : ''}${blockedPackages ? `; ${blockedPackages} pacote(s) inseguro(s) bloqueado(s)` : ''}${legacyArchive ? '; arquivo legado revalidado localmente' : ''}`
      }
    } catch (e) {
      return { ok: false, msg: `import falhou: ${e instanceof Error ? e.message : String(e)}` }
    }
  }

  /** Update-check em DOIS estágios: 1 request condicional de HEAD por repo;
   *  HEAD novo → 1 compare por base (arquivos mudados → quais skills). */
  checkUpdates(force = false): Promise<number> {
    if (this.checking) return this.checking
    if (!force && this.data.lastCheckAt) {
      const age = Date.now() - Date.parse(this.data.lastCheckAt)
      if (Number.isFinite(age) && age < CHECK_TTL_MS)
        return Promise.resolve(Object.keys(this.data.updates).length)
    }
    this.checking = (async () => {
      let found = 0
      const heads = (this.data.repoHeads ??= {})
      // repo@ref → skills instaladas dele
      const groups = new Map<string, { def: SkillDef; info: InstalledInfo }[]>()
      for (const [id, info] of Object.entries(this.data.installed)) {
        const def = this.byId(id)
        if (!def || def.bundledBody) continue // embutido nunca tem update
        const key = `${def.source.repo}@${def.source.ref ?? ''}`
        groups.set(key, [...(groups.get(key) ?? []), { def, info }])
      }
      for (const [key, group] of groups) {
        try {
          const src = group[0].def.source
          const q = `per_page=1${src.ref ? `&sha=${encodeURIComponent(src.ref)}` : ''}`
          const headRes = await gh(`https://api.github.com/repos/${src.repo}/commits?${q}`, heads[key]?.etag)
          if (headRes.status === 304) continue
          const headSha = Array.isArray(headRes.body)
            ? (headRes.body as { sha?: string }[])[0]?.sha
            : undefined
          if (!headSha) continue
          heads[key] = { sha: headSha, etag: headRes.etag }
          // skills cujo pin já é o HEAD atual estão em dia; as demais, um
          // compare POR BASE distinta diz quais pastas mudaram de verdade.
          const stale = group.filter(({ def, info }) => info.sha !== headSha && !this.data.updates[def.id])
          const byBase = new Map<string, SkillDef[]>()
          for (const { def, info } of stale)
            byBase.set(info.sha, [...(byBase.get(info.sha) ?? []), def])
          for (const [base, defs] of byBase) {
            const cmp = await gh(
              `https://api.github.com/repos/${src.repo}/compare/${base}...${headSha}`
            )
            const files = (cmp.body as { files?: { filename?: string }[] } | undefined)?.files
            if (cmp.status !== 200 || !files) continue
            const overflow = files.length >= 300 // compare capa em ~300 files
            for (const def of defs) {
              const prefix = def.source.path ? `${def.source.path}/` : ''
              const touched =
                overflow ||
                (def.kind === 'agent'
                  ? files.some((f) => f.filename === def.source.path)
                  : files.some((f) => f.filename?.startsWith(prefix)))
              if (touched) {
                this.data.updates[def.id] = headSha
                found++
              } else {
                // nada da pasta mudou — re-pina no HEAD novo sem re-baixar
                this.data.installed[def.id].sha = headSha
              }
            }
          }
        } catch {
          // offline/limite — fica para o próximo check
        }
      }
      this.data.lastCheckAt = new Date().toISOString()
      this.persist()
      this.notify()
      return found
    })()
    this.checking.finally(() => (this.checking = null))
    return this.checking
  }

  /**
   * Compatibilidade de workspace usada pelo método-base do Maestro. Panes de
   * execução passam ids=[] para podar cópias antigas e recebem conteúdo por
   * árvore privada/receipt. ASYNC (task skills-off-main, 2026-08-05):
   * o fast path continua síncrono (~0ms); a cópia real, a poda e o scan de
   * supply-chain rodam no gitWorker — o main não congela mais 1-4s no spawn.
   * A cadeia serializa chamadas concorrentes (mesma atomicidade de antes).
   */
  syncToWorkspace(cwd: string, ids: string[]): Promise<{ injected: SkillDef[]; missing: string[] }> {
    const run = this.workspaceSyncChain.then(() => this.syncToWorkspaceImpl(cwd, ids))
    this.workspaceSyncChain = run.catch(() => undefined)
    return run
  }

  private async syncToWorkspaceImpl(
    cwd: string,
    ids: string[]
  ): Promise<{ injected: SkillDef[]; missing: string[] }> {
    const injected: SkillDef[] = []
    const missing: string[] = []
    const expandedIds = this.withRequires([...new Set(ids)])
    const requested = new Set(expandedIds)
    const workspaceSkillRoots = [
      join(cwd, '.claude', 'skills'),
      join(cwd, '.agents', 'skills')
    ]

    // CURTO-CIRCUITO DE VERDADE (medição da caixa-preta 2026-08-05: workspace
    // JÁ idêntico custava 1,5-2,8s — o marcador pulava o rm+cp, mas o "no-op"
    // pagava reavaliação de supply chain com TTL vencido (varredura da lib
    // POR skill), 4 leituras de marcador por skill nos checks de colisão+pulo
    // e a poda relendo TODOS os marcadores dos dois destinos): skill com
    // decisão de supply chain PERSISTIDA não-block (a MESMA fonte que a poda
    // e os menus consultam), avaliador na versão atual, lib íntegra e
    // marcador id+sha idênticos nos DOIS destinos é aprovada aqui por UMA
    // leitura de marcador + um stat por destino. Nenhum byte novo entra no
    // workspace por este caminho — o conteúdo lá foi avaliado quando foi
    // copiado. QUALQUER divergência (marcador ausente/alheio, id/versão
    // diferente, legado sem assessment, decisão block, avaliador novo) cai
    // no caminho completo de sempre: reavaliação + recópia.
    const fastPath = new Set<string>()
    for (const id of requested) {
      const def = this.byId(id)
      if (!def || def.kind !== 'skill') continue
      const installed = this.data.installed[id]
      const sha = installed?.sha
      const supply = installed?.supplyChain
      if (def.bundledBody && !this.bundledPackageMatches(id)) continue
      if (
        !sha ||
        !supply ||
        supply.version !== SKILL_PACKAGE_SECURITY_VERSION ||
        supply.decision === 'block'
      )
        continue
      if (!existsSync(join(this.libDir, id, 'SKILL.md'))) continue
      const identical = workspaceSkillRoots.every((root) => {
        const dest = join(root, id)
        const marker = readManagedWorkspaceSkillMarker(dest)
        if (!marker || marker.id !== id || marker.version !== sha) return false
        if (!existsSync(join(dest, 'SKILL.md'))) return false
        return !def.bundledBody || managedWorkspaceSkillContentsMatch(join(this.libDir, id), dest)
      })
      if (identical) fastPath.add(id)
    }

    // Uma desinstalação também precisa sair dos workspaces já usados. O
    // marcador prova quais pastas são nossas; qualquer conteúdo local fica.
    // A decisão precisa existir antes da poda: um pacote legado que se revela
    // bloqueado não pode deixar uma cópia gerenciada antiga no workspace.
    // (Id do curto-circuito não reentra na varredura da lib: a decisão dele
    // já está persistida e é não-block por definição do check acima.)
    const executionReady = new Set(fastPath)
    for (const id of expandedIds) {
      if (fastPath.has(id)) continue
      if (await this.installedForExecution(id)) executionReady.add(id)
    }

    const activeSkillIds = new Set(
      [...executionReady].filter((id) => this.byId(id)?.kind === 'skill')
    )
    const activeAgentIds = new Set(
      [...executionReady].filter((id) => this.byId(id)?.kind === 'agent')
    )
    // A poda só REMOVE pasta cujo marcador Synkora tem id IGUAL ao próprio
    // nome e fora do conjunto elegível — pasta com nome de instalada elegível
    // nunca é removível, e pasta local (sem marcador nosso) nunca é tocada.
    // Reler os ~2×N marcadores em TODO sync era o custo do sync de 0 skills
    // (353ms medidos); o pré-filtro só chama a poda com candidato REAL.
    if (hasManagedPruneCandidate(workspaceSkillRoots, activeSkillIds)) {
      // Candidato REAL confirmado pelo pré-filtro barato: o rm recursivo
      // roda no worker (main livre).
      await gitOff(
        'pruneUnrequestedManagedWorkspaceSkills',
        workspaceSkillRoots,
        activeSkillIds
      )
    }

    // Uma escolha manual vale para aquela execução, não para todas as sessões
    // futuras no mesmo cwd. Retiramos somente cópias marcadas pelo Synkora (ou
    // cópias antigas ainda idênticas à biblioteca); conteúdo customizado fica.
    const libraryAgentSources = Object.fromEntries(
      this.defs
        .filter((def) => def.kind === 'agent')
        .map((def) => [def.id, join(this.libDir, def.id, 'agent.md')])
        .filter(([, source]) => existsSync(source))
    )
    await gitOff(
      'pruneUnrequestedManagedWorkspaceAgents',
      join(cwd, '.claude', 'agents'),
      activeAgentIds,
      libraryAgentSources
    )

    for (const id of expandedIds) {
      const def = this.byId(id)
      const src = join(this.libDir, id)
      if (!def) {
        missing.push(id)
        continue
      }
      // Idêntico + elegibilidade persistida, provados no curto-circuito:
      // nada a copiar, nada a re-varrer.
      if (fastPath.has(id)) {
        injected.push(def)
        continue
      }
      if (!(await this.installedForExecution(id))) {
        missing.push(id)
        continue
      }
      try {
        if (def.kind === 'agent') {
          // subagente = arquivo único em .claude/agents (codex não tem o
          // conceito — em pane codex a persona viaja no spawn, não aqui)
          const srcFile = join(src, 'agent.md')
          if (!existsSync(srcFile)) {
            missing.push(id)
            continue
          }
          const dest = join(cwd, '.claude', 'agents', `${id}.md`)
          if (
            !(await gitOff(
              'syncManagedWorkspaceAgentCopy',
              srcFile,
              dest,
              id,
              this.data.installed[id]?.sha
            ))
          ) {
            missing.push(id)
            continue
          }
          injected.push(def)
          continue
        }
        if (!existsSync(join(src, 'SKILL.md'))) {
          missing.push(id)
          continue
        }
        const destinations = [
          join(cwd, '.claude', 'skills', id),
          join(cwd, '.agents', 'skills', id)
        ]
        // sha instalado = versão da cópia: destino com marcador id+sha
        // idênticos é pulado (curto-circuito do stall de spawn). A cópia
        // real (rm+cp ×2 destinos) roda no gitWorker.
        if (
          !(await gitOff(
            'syncManagedWorkspaceSkillCopies',
            src,
            destinations,
            id,
            this.data.installed[id]?.sha,
            Boolean(def.bundledBody)
          ))
        ) {
          missing.push(id)
          continue
        }
        injected.push(def)
      } catch {
        missing.push(id)
      }
    }
    if (injected.length) ensureSkillsExcluded(cwd)
    return { injected, missing }
  }
}

/**
 * Leitura ÚNICA do marcador gerenciado de um destino (o leitor canônico vive
 * privado em workspaceSkills.ts; o curto-circuito do sync espelha a MESMA
 * semântica): managedBy 'synkora' + id string, senão undefined. Marcador
 * ausente/ilegível/de outro dono nunca conta como cópia gerenciada íntegra.
 */
function readManagedWorkspaceSkillMarker(
  destination: string
): { id: string; version?: string } | undefined {
  try {
    const value = JSON.parse(
      readFileSync(join(destination, MANAGED_WORKSPACE_SKILL_MARKER), 'utf-8')
    ) as { managedBy?: unknown; id?: unknown; version?: unknown }
    if (value.managedBy !== 'synkora' || typeof value.id !== 'string') return undefined
    return {
      id: value.id,
      version: typeof value.version === 'string' ? value.version : undefined
    }
  } catch {
    return undefined
  }
}

/**
 * true quando alguma pasta de skills do workspace é PODÁVEL de fato: marcador
 * Synkora válido com id igual ao nome da pasta E fora do conjunto instalado
 * elegível — exatamente a condição de remoção da poda (workspaceSkills.ts).
 * Só os nomes DESCONHECIDOS pagam a leitura do marcador; workspace 100%
 * coberto pela biblioteca custa apenas dois readdir.
 */
function hasManagedPruneCandidate(
  skillRoots: string[],
  eligibleInstalled: ReadonlySet<string>
): boolean {
  for (const root of skillRoots) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || eligibleInstalled.has(entry.name)) continue
        if (readManagedWorkspaceSkillMarker(join(root, entry.name))?.id === entry.name) return true
      }
    } catch {
      // raiz ainda não existe — nada a podar nela
    }
  }
  return false
}

/** cwds cujo info/exclude já foi garantido NESTE processo: o append é
 *  idempotente e o `git rev-parse` síncrono custava ~100ms em todo sync do
 *  mesmo workspace. Só SUCESSO entra no cache — projeto que ganha .git
 *  depois (git init tardio) tenta de novo no próximo sync. */
const skillsExcludeEnsured = new Set<string>()

/**
 * Garante que os diretórios de skills injetadas NUNCA entram num commit
 * (o dev roda `git add -A`): append em <common-gitdir>/info/exclude — vale
 * para a base e para TODOS os worktrees, sem sujar o .gitignore versionado.
 * Exclude só afeta untracked: .claude/skills versionado pelo usuário segue
 * intocado.
 */
export function ensureSkillsExcluded(cwd: string): void {
  if (skillsExcludeEnsured.has(cwd)) return
  try {
    const common = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        cwd,
        encoding: 'utf-8',
        env: { ...(process.env as Record<string, string>), PATH: freshWindowsPath() },
        timeout: 15_000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    ).trim()
    if (!common) return
    const exclude = join(common, 'info', 'exclude')
    const wanted = ['.claude/skills/', '.claude/agents/', '.agents/skills/', '.codex/skills/']
    let cur = ''
    try {
      cur = readFileSync(exclude, 'utf-8')
    } catch {
      // ainda não existe
    }
    const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()))
    const add = wanted.filter((w) => !have.has(w))
    if (!add.length) {
      skillsExcludeEnsured.add(cwd)
      return
    }
    mkdirSync(dirname(exclude), { recursive: true })
    writeFileSync(
      exclude,
      cur +
        (cur && !cur.endsWith('\n') ? '\n' : '') +
        '# synkora: skills injetadas por execução (nunca commitar)\n' +
        add.join('\n') +
        '\n',
      'utf-8'
    )
    skillsExcludeEnsured.add(cwd)
  } catch {
    // sem git no cwd — nada a excluir
  }
}
