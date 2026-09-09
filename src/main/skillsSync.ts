/**
 * SYNC DO KIT DE SKILLS NO SPAWN (Skills 2.0, fatia B —
 * .synkora/reports/DESIGN_SKILLS_2_0_BUILD_2026-08-29.md, §"Sync no spawn").
 *
 * O TRANSPORTE do cardápio (ADR-0002) é uma PASTA no worktree: os CLIs
 * descobrem Agent Skills sozinhos, e os ajudantes headless herdam de graça
 * porque moram no mesmo worktree. Este módulo materializa o kit do tipo de chat
 * na pasta que cada binário realmente lê — e só ele.
 *
 * AS PASTAS SAÍRAM DA SONDA, não de documentação
 * (.synkora/reports/PROBE_SKILLS_CWD_2026-08-29.md, binários reais claude
 * 2.1.250 e codex-cli 0.150.1). Escrever na pasta errada é um sync que não
 * entrega nada, EM SILÊNCIO.
 *
 * DUAS ORIGENS NO MESMO MANIFESTO (Skills 3.0 — ADR-0009/0010, 2026-09-08): o
 * kit do dono (`origin: 'kit'`, ausente no arquivo antigo) e o que o AGENTE
 * puxou para a missão (`origin: 'agent'`, escrito por skillsAgentSync.ts). A
 * consequência dura é a LEI 4 aqui embaixo. As operações do agente moram no
 * módulo irmão para este arquivo não cruzar as ~1000 linhas da casa; os helpers
 * de árvore/manifesto são exportados como INTERNOS para ele.
 *
 * AS QUATRO LEIS DESTE MÓDULO
 *
 * 1. O MANIFESTO É A ESCRITURA. `<alvo>/.synkora-kit.json` lista exatamente o
 *    que o Synkora escreveu ali, com uma impressão digital do conteúdo. Só
 *    pasta listada NELE pode ser apagada ou sobrescrita. Pasta que o DONO pôs
 *    à mão — ainda que com o mesmo id de uma skill da lib — NUNCA é tocada
 *    (regra da casa: arquivo local divergente jamais é podado). Manifesto
 *    ilegível degrada para "não gerencio nada": o sync re-materializa o que
 *    falta e volta a mandar, sem apagar nada pelo caminho.
 * 2. A TESTEMUNHA AUTORIZA PULAR TRABALHO; SÓ A IMPRESSÃO DIGITAL AUTORIZA
 *    DESTRUIR. O caminho quente (todo `gui:create`, inclusive a remontagem de
 *    aba) compara uma testemunha barata (nº de arquivos + bytes + mtime mais
 *    novo, puro `lstat`) e não lê byte nenhum quando nada mudou. Apagar ou
 *    sobrescrever, ao contrário, exige o sha256 do conteúdo bater com o do
 *    manifesto — sempre, sem atalho.
 * 3. LINK NÃO SE ATRAVESSA. Qualquer symlink/junção dentro da árvore (na lib
 *    ou no destino) faz a pasta virar "estranha": não é copiada, não é apagada,
 *    é relatada. É a armadilha permanente do Windows (nunca remover recursivo
 *    através de junção viva) fechada na origem, não no `rm`.
 * 4. O SYNC DO KIT NUNCA TIRA O QUE O AGENTE PUXOU. Entrada `origin: 'agent'`
 *    sobrevive a toda remontagem de aba e ao `chat: null` (release, pane sem
 *    tipo): ela é o harness DA MISSÃO (ADR-0009) e só sai por `skill_discard`,
 *    pela conclusão do planejamento ou com o worktree. O kit também não a
 *    re-materializa: a pasta é do agente enquanto ele a quiser.
 *
 * Idempotente e re-derivável: rodar duas vezes produz o mesmo estado, e o
 * estado não depende de nenhuma entrega única — a fotografia é o disco.
 *
 * Dependência de Electron: NENHUMA direta. As duas fontes (kit e biblioteca)
 * chegam por `options` nas suítes e só resolvem o padrão de produção quando o
 * chamador as omite — é o que deixa este módulo rodar em node puro.
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  isSkillId,
  kitForChat,
  skillsKitStore,
  type SkillChatType,
  type SkillsKitSlot
} from './skillsKit'
import { skillsLibraryRoot } from './skillsLibraryScan'

/**
 * As pastas que cada CLI REALMENTE lê a partir do cwd. Sondado em binário real
 * (2026-08-29): claude 2.1.250, codex-cli 0.150.1 — ver
 * .synkora/reports/PROBE_SKILLS_CWD_2026-08-29.md e re-sondar a cada update de
 * CLI com `node scripts/probe-skills-cwd.mjs`.
 *
 * O codex também lê `.codex/skills`, e ela está FORA daqui de propósito: criar
 * `.codex/` no worktree é criar a raiz de config-de-projeto dele, e o binário
 * passa a cuspir um ERROR de "projeto não confiável" a cada sessão (P6 da
 * sonda). `.agents/skills` entrega a MESMA descoberta com zero ruído.
 * `.codex/skills` fica registrada como a alternativa sancionada se um dia
 * `.agents/skills` deixar de ser lida.
 */
export const SKILL_SYNC_TARGETS = {
  claude: ['.claude/skills'],
  codex: ['.agents/skills']
} as const

export type SkillSyncCli = keyof typeof SKILL_SYNC_TARGETS

/**
 * TODA pasta-alvo, sempre. O MESMO worktree hospeda o chat claude da missão e
 * os ajudantes codex da frota: materializar só a do CLI do pane deixaria metade
 * da casa sem cardápio, e o sync roda uma vez por spawn.
 */
export const TARGET_DIRS: readonly string[] = Object.values(SKILL_SYNC_TARGETS).flat()

/** O manifesto do sync, dentro de cada pasta-alvo. */
export const SYNC_MANIFEST_FILE = '.synkora-kit.json'

/** Pouso da cópia antes do rename atômico. Fica FORA da pasta-alvo de
 *  propósito: uma sobra de `<alvo>/tmp-x/SKILL.md` viraria uma skill fantasma
 *  no cardápio do CLI. `.synkora/` já é git-invisível. */
const TMP_DIR = join('.synkora', 'skills-sync-tmp')

/** Tetos por skill. Uma skill é markdown com uns poucos anexos; passar disto é
 *  pasta errada no kit, e o dono precisa LER isso, não esperar uma cópia de
 *  node_modules. */
const MAX_FILES_PER_SKILL = 4_000
const MAX_BYTES_PER_SKILL = 64 * 1024 * 1024
const MAX_DEPTH = 16
/** Teto do manifesto lido do disco (ele mora no worktree do agente: é entrada
 *  não confiável, e uma lista infinita não pode virar trabalho infinito). */
const MAX_MANIFEST_ENTRIES = 512

// ————— contrato de saída —————

export interface SkillSyncFailure {
  id: string
  error: string
}

export interface SkillSyncOutcome {
  ok: boolean
  /** ids materializados (a pasta existe, é nossa e bate com a lib) */
  synced: string[]
  /** ids removidos (saíram do kit e a pasta que ESCREVEMOS foi apagada) */
  removed: string[]
  /** falhas por id, com o motivo — vira a nota no chat */
  failures: SkillSyncFailure[]
  /**
   * EXTENSÃO da fatia B (o design fecha em quatro campos; estes dois são
   * aditivos e nenhum chamador do contrato original precisa deles):
   *
   * ids cuja pasta no destino NÃO é nossa — o dono a criou à mão, ou editou a
   * que escrevemos. Nunca é escrita nem apagada; é RELATADA para o diário, que
   * é o único lugar onde "o cardápio deste worktree diverge do kit" pode ser
   * investigado depois.
   */
  userModified: string[]
  /** o sync TOCOU o disco nesta rodada (cópia, remoção ou manifesto). Falso na
   *  esmagadora maioria das chamadas — a remontagem de aba passa por aqui. */
  wrote: boolean
}

export interface SkillSyncOptions {
  /** slots já resolvidos. Produção omite (lê o store compartilhado do main);
   *  as suítes injetam para rodar sem `app.getPath`. */
  kit?: SkillsKitSlot[]
  /** raiz da biblioteca (`%APPDATA%\synkora\skills\lib` em produção). */
  libraryRoot?: string
}

// ————— manifesto —————

/** Testemunha barata de uma árvore: o que `lstat` sabe dizer sem ler bytes. */
export interface SkillSyncWitness {
  files: number
  bytes: number
  /** mtime mais novo da árvore, em ms */
  mtimeMs: number
}

/**
 * QUEM pôs a pasta ali: o kit do dono (`kit`, e é o valor de quem não diz nada
 * — todo manifesto gravado antes de 2026-09-08 é kit) ou o agente, puxando o
 * harness da missão (`agent`, ADR-0010).
 */
export type SkillSyncOrigin = 'kit' | 'agent'

export interface SkillSyncManifestEntry {
  id: string
  /** sha256 do conteúdo. A cópia é byte a byte, então a impressão digital da
   *  lib e a do destino são a MESMA no momento da escrita. */
  fingerprint: string
  /** testemunha do DESTINO no momento da escrita */
  dest: SkillSyncWitness
  /** testemunha da LIB no momento da escrita */
  source: SkillSyncWitness
  /** ausente = 'kit' (compatibilidade com o manifesto da era Skills 2.0) */
  origin?: SkillSyncOrigin
}

interface SkillSyncManifest {
  version: 1
  /** para quem abrir o arquivo no worktree e se perguntar de onde ele veio */
  writtenBy: string
  updatedAt: string
  entries: SkillSyncManifestEntry[]
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/

function isWitness(value: unknown): value is SkillSyncWitness {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SkillSyncWitness>
  return (
    typeof candidate.files === 'number' &&
    Number.isFinite(candidate.files) &&
    candidate.files >= 0 &&
    typeof candidate.bytes === 'number' &&
    Number.isFinite(candidate.bytes) &&
    candidate.bytes >= 0 &&
    typeof candidate.mtimeMs === 'number' &&
    Number.isFinite(candidate.mtimeMs)
  )
}

/**
 * O manifesto lido do disco é ENTRADA NÃO CONFIÁVEL: ele mora no worktree em
 * que um agente escreve o dia inteiro. Um id fora do padrão de pasta jamais
 * chega a virar caminho — é assim que `"../../.."` não vira um `rm`.
 */
function sanitizeManifest(value: unknown): SkillSyncManifestEntry[] {
  if (typeof value !== 'object' || value === null) return []
  const candidate = value as Partial<SkillSyncManifest>
  if (candidate.version !== 1 || !Array.isArray(candidate.entries)) return []
  const out: SkillSyncManifestEntry[] = []
  const seen = new Set<string>()
  for (const raw of candidate.entries.slice(0, MAX_MANIFEST_ENTRIES)) {
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Partial<SkillSyncManifestEntry>
    if (!isSkillId(entry.id) || seen.has(entry.id)) continue
    if (typeof entry.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(entry.fingerprint)) continue
    if (!isWitness(entry.dest) || !isWitness(entry.source)) continue
    seen.add(entry.id)
    out.push({
      id: entry.id,
      fingerprint: entry.fingerprint,
      dest: { files: entry.dest.files, bytes: entry.dest.bytes, mtimeMs: entry.dest.mtimeMs },
      source: {
        files: entry.source.files,
        bytes: entry.source.bytes,
        mtimeMs: entry.source.mtimeMs
      },
      // Origem PRESERVADA (nunca inventada): valor estranho degrada para kit,
      // que é o regime mais restrito — o kit gerencia, e gerenciar é o que
      // exige a impressão digital antes de qualquer destruição.
      ...(entry.origin === 'agent' ? { origin: 'agent' as const } : {})
    })
  }
  return out
}

export function readManifest(targetDir: string): Map<string, SkillSyncManifestEntry> {
  const managed = new Map<string, SkillSyncManifestEntry>()
  let text: string
  try {
    text = readFileSync(join(targetDir, SYNC_MANIFEST_FILE), 'utf8')
  } catch {
    // Ausente (primeiro sync) ou ilegível: nos dois casos não gerenciamos nada
    // ali, e a consequência é sempre a SEGURA — nada é apagado.
    return managed
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return managed
  }
  for (const entry of sanitizeManifest(parsed)) managed.set(entry.id, entry)
  return managed
}

/**
 * Escrita atômica SEM `.bak` (por isso não usa o jsonStore da casa): este
 * arquivo é re-derivável — perdê-lo custa uma re-cópia, e um `.bak` seria lixo
 * permanente dentro do worktree do dono.
 */
export function writeManifest(targetDir: string, entries: SkillSyncManifestEntry[]): void {
  const file = join(targetDir, SYNC_MANIFEST_FILE)
  if (entries.length === 0) {
    try {
      unlinkSync(file)
    } catch {
      // já não existia
    }
    // Pasta-alvo vazia depois da limpeza volta a não existir. `rmdirSync` NÃO é
    // recursivo de propósito: ele só tem sucesso se não sobrou nada do dono.
    try {
      rmdirSync(targetDir)
    } catch {
      // ainda há skills do dono ali — que continuem
    }
    return
  }
  const manifest: SkillSyncManifest = {
    version: 1,
    writtenBy: 'synkora',
    updatedAt: new Date().toISOString(),
    entries: [...entries].sort((left, right) => (left.id < right.id ? -1 : 1))
  }
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    renameSync(temporary, file)
  } catch {
    try {
      unlinkSync(temporary)
    } catch {
      // temporário nunca criado ou já promovido
    }
  }
}

// ————— fotografia de uma árvore —————

export interface TreeFile {
  /** caminho relativo com `/` — a impressão digital não pode depender do SO */
  rel: string
  size: number
}

export interface TreeSnapshot {
  dirs: string[]
  files: TreeFile[]
  bytes: number
  mtimeMs: number
}

export type TreeProbe =
  | { kind: 'absent' }
  /** existe, mas não é uma árvore que este módulo saiba reproduzir ou destruir
   *  com segurança: link/junção, arquivo no lugar da pasta, tipo exótico, ou
   *  grande demais. */
  | { kind: 'foreign'; reason: string }
  | { kind: 'tree'; snapshot: TreeSnapshot }

export function probeTree(root: string): TreeProbe {
  let rootStat: ReturnType<typeof lstatSync>
  try {
    rootStat = lstatSync(root)
  } catch {
    return { kind: 'absent' }
  }
  // Junção do Windows chega aqui como symlink — e é exatamente ela que nunca
  // pode ser atravessada por uma remoção recursiva.
  if (rootStat.isSymbolicLink()) return { kind: 'foreign', reason: 'a pasta é um link/junção' }
  if (!rootStat.isDirectory()) return { kind: 'foreign', reason: 'existe um arquivo com esse nome' }

  const snapshot: TreeSnapshot = { dirs: [], files: [], bytes: 0, mtimeMs: rootStat.mtimeMs }
  const stack: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: '', depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    if (current.depth > MAX_DEPTH) {
      return { kind: 'foreign', reason: `a árvore passa de ${MAX_DEPTH} níveis` }
    }
    let names: string[]
    try {
      names = readdirSync(current.abs)
    } catch {
      return { kind: 'foreign', reason: 'não consegui listar a pasta' }
    }
    for (const name of names) {
      const abs = join(current.abs, name)
      const rel = current.rel ? `${current.rel}/${name}` : name
      let stat: ReturnType<typeof lstatSync>
      try {
        stat = lstatSync(abs)
      } catch {
        return { kind: 'foreign', reason: 'não consegui ler uma entrada da pasta' }
      }
      if (stat.isSymbolicLink()) {
        return { kind: 'foreign', reason: `há link/junção em "${rel}"` }
      }
      if (stat.mtimeMs > snapshot.mtimeMs) snapshot.mtimeMs = stat.mtimeMs
      if (stat.isDirectory()) {
        snapshot.dirs.push(rel)
        stack.push({ abs, rel, depth: current.depth + 1 })
        continue
      }
      if (!stat.isFile()) {
        return { kind: 'foreign', reason: `"${rel}" não é arquivo nem pasta` }
      }
      snapshot.files.push({ rel, size: stat.size })
      snapshot.bytes += stat.size
      if (snapshot.files.length > MAX_FILES_PER_SKILL) {
        return { kind: 'foreign', reason: `passa de ${MAX_FILES_PER_SKILL} arquivos` }
      }
      if (snapshot.bytes > MAX_BYTES_PER_SKILL) {
        return { kind: 'foreign', reason: 'passa de 64 MB' }
      }
    }
  }
  return { kind: 'tree', snapshot }
}

export function witnessOf(snapshot: TreeSnapshot): SkillSyncWitness {
  return { files: snapshot.files.length, bytes: snapshot.bytes, mtimeMs: snapshot.mtimeMs }
}

export function sameWitness(left: SkillSyncWitness, right: SkillSyncWitness): boolean {
  return left.files === right.files && left.bytes === right.bytes && left.mtimeMs === right.mtimeMs
}

/**
 * sha256 canônico da árvore: pastas e arquivos ordenados por caminho, com
 * tamanho e BYTES CRUS de cada arquivo. Nada de texto, nada de encoding — é a
 * mesma leitura que prova que a cópia preservou byte a byte.
 */
export function fingerprintTree(root: string, snapshot: TreeSnapshot): string | null {
  const hash = createHash('sha256')
  for (const dir of [...snapshot.dirs].sort(compareText)) {
    hash.update(`d\0${dir}\n`)
  }
  for (const file of [...snapshot.files].sort((left, right) => compareText(left.rel, right.rel))) {
    let bytes: Buffer
    try {
      bytes = readFileSync(join(root, ...file.rel.split('/')))
    } catch {
      return null
    }
    hash.update(`f\0${file.rel}\0${bytes.length}\0`)
    hash.update(bytes)
    hash.update('\n')
  }
  return hash.digest('hex')
}

export function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

// ————— cópia —————

/**
 * Cópia byte a byte para um pouso temporário e UM rename para o lugar. Se o
 * processo morrer no meio, o que sobra é uma pasta em `.synkora/` (invisível
 * para os CLIs e para o git) — nunca uma skill pela metade no cardápio.
 */
export function materialize(
  cwd: string,
  sourceRoot: string,
  snapshot: TreeSnapshot,
  destination: string
): string | null {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const landing = join(cwd, TMP_DIR, unique)
  try {
    mkdirSync(landing, { recursive: true })
    for (const dir of [...snapshot.dirs].sort(compareText)) {
      mkdirSync(join(landing, ...dir.split('/')), { recursive: true })
    }
    for (const file of snapshot.files) {
      const parts = file.rel.split('/')
      const target = join(landing, ...parts)
      if (parts.length > 1) mkdirSync(join(landing, ...parts.slice(0, -1)), { recursive: true })
      copyFileSync(join(sourceRoot, ...parts), target)
    }
    mkdirSync(dirname(destination), { recursive: true })
    renameSync(landing, destination)
    return null
  } catch (error) {
    try {
      rmSync(landing, { recursive: true, force: true })
    } catch {
      // sobra inerte em .synkora/ — a varredura do próximo sync a remove
    }
    return error instanceof Error ? error.message : 'falha ao copiar a skill'
  }
}

/** Remoção de árvore PROVADAMENTE nossa. Só é chamada depois de a impressão
 *  digital bater — o que também prova que não há link lá dentro. */
export function removeManaged(destination: string): string | null {
  try {
    rmSync(destination, { recursive: true, force: true })
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'falha ao remover a skill'
  }
}

function sweepLanding(cwd: string): void {
  try {
    rmSync(join(cwd, TMP_DIR), { recursive: true, force: true })
  } catch {
    // sobra inerte; a próxima varredura tenta de novo
  }
}

// ————— o sync —————

type SkillStatus = 'synced' | 'user' | 'failed'

interface TargetPass {
  status: Map<string, SkillStatus>
  removed: Set<string>
  failures: Map<string, string>
  wrote: boolean
}

/**
 * Uma pasta-alvo. `desired` já vem filtrado (ids do kit legíveis na lib) e
 * `keep` são os ids que o kit AINDA quer mas a lib não pôde entregar nesta
 * rodada: eles não são materializados e também não são removidos — perder a
 * pasta da biblioteca não pode apagar o cardápio que já está no worktree.
 */
function syncTarget(
  cwd: string,
  targetDir: string,
  desired: Map<string, TreeSnapshot>,
  keep: Set<string>,
  libraryRoot: string
): TargetPass {
  const pass: TargetPass = {
    status: new Map(),
    removed: new Set(),
    failures: new Map(),
    wrote: false
  }
  const managed = readManifest(targetDir)
  // Nada desejado e nada gerenciado: não se cria pasta para não escrever nada
  // nela. (Criar `.claude/skills/` num worktree de release seria ruído puro.)
  if (desired.size === 0 && managed.size === 0) return pass

  const nextEntries = new Map<string, SkillSyncManifestEntry>()

  for (const [id, sourceSnapshot] of desired) {
    const destination = join(targetDir, id)
    const entry = managed.get(id)

    // LEI 4: o id que o AGENTE puxou também está no kit. A pasta existe e é
    // dele (pinada num sha que ele escolheu): o kit não a re-materializa, não a
    // apaga e não perde a entrada. O cardápio do CLI tem o id — que é o que o
    // sync existe para garantir.
    if (entry?.origin === 'agent') {
      nextEntries.set(id, entry)
      pass.status.set(id, 'synced')
      continue
    }

    const probe = probeTree(destination)

    if (probe.kind === 'foreign') {
      // Link, arquivo no lugar da pasta, árvore grande demais: não é nossa e
      // não vira nossa. A entrada some do manifesto — o que está ali é do dono.
      pass.status.set(id, 'user')
      continue
    }

    if (probe.kind === 'absent') {
      const error = materialize(cwd, join(libraryRoot, id), sourceSnapshot, destination)
      if (error) {
        pass.failures.set(id, error)
        pass.status.set(id, 'failed')
        // A entrada antiga (se havia) segue valendo: a pasta sumiu do disco,
        // mas o manifesto não é o lugar de esconder isso.
        if (entry) nextEntries.set(id, entry)
        continue
      }
      pass.wrote = true
      const written = probeTree(destination)
      const fingerprint = fingerprintTree(join(libraryRoot, id), sourceSnapshot)
      if (written.kind === 'tree' && fingerprint) {
        nextEntries.set(id, {
          id,
          fingerprint,
          dest: witnessOf(written.snapshot),
          source: witnessOf(sourceSnapshot)
        })
      }
      pass.status.set(id, 'synced')
      continue
    }

    // A pasta existe e é uma árvore comum.
    if (!entry) {
      // O DONO a pôs ali (ou uma instalação anterior sem manifesto). Não é
      // nossa: nunca sobrescrever, nunca apagar — só relatar.
      pass.status.set(id, 'user')
      continue
    }

    const destWitness = witnessOf(probe.snapshot)
    const sourceWitness = witnessOf(sourceSnapshot)
    if (sameWitness(destWitness, entry.dest) && sameWitness(sourceWitness, entry.source)) {
      // CAMINHO QUENTE: nada mudou dos dois lados e nenhum byte foi lido.
      pass.status.set(id, 'synced')
      nextEntries.set(id, entry)
      continue
    }

    const destFingerprint = fingerprintTree(destination, probe.snapshot)
    if (destFingerprint !== entry.fingerprint) {
      // Escrevemos essa pasta um dia, mas o conteúdo de hoje não é o nosso: o
      // dono (ou um agente) editou. Fica como está, e sai da nossa alçada.
      pass.status.set(id, 'user')
      continue
    }

    const sourceFingerprint = fingerprintTree(join(libraryRoot, id), sourceSnapshot)
    if (sourceFingerprint === destFingerprint) {
      // Só o mtime dançou (touch, cópia de pasta): re-carimba a testemunha para
      // o próximo spawn voltar ao caminho quente, sem tocar em arquivo nenhum.
      pass.status.set(id, 'synced')
      nextEntries.set(id, {
        id,
        fingerprint: entry.fingerprint,
        dest: destWitness,
        source: sourceWitness
      })
      continue
    }
    if (!sourceFingerprint) {
      pass.failures.set(id, 'não consegui ler a skill na biblioteca')
      pass.status.set(id, 'failed')
      nextEntries.set(id, entry)
      continue
    }

    // A LIB MUDOU e a pasta é comprovadamente nossa: troca inteira.
    const removal = removeManaged(destination)
    if (removal) {
      pass.failures.set(id, removal)
      pass.status.set(id, 'failed')
      nextEntries.set(id, entry)
      continue
    }
    pass.wrote = true
    const error = materialize(cwd, join(libraryRoot, id), sourceSnapshot, destination)
    if (error) {
      pass.failures.set(id, error)
      pass.status.set(id, 'failed')
      continue
    }
    const written = probeTree(destination)
    if (written.kind === 'tree') {
      nextEntries.set(id, {
        id,
        fingerprint: sourceFingerprint,
        dest: witnessOf(written.snapshot),
        source: sourceWitness
      })
    }
    pass.status.set(id, 'synced')
  }

  // O QUE SAIU DO KIT. Só o que o manifesto prova ser nosso é apagado, e a
  // prova é sempre a impressão digital (nunca a testemunha barata).
  for (const [id, entry] of managed) {
    if (desired.has(id)) continue
    // LEI 4: skill do AGENTE não sai por aqui — nem quando o kit esvazia, nem
    // com `chat: null`. Ela é o harness da missão e só o discard a alcança.
    if (entry.origin === 'agent') {
      nextEntries.set(id, entry)
      continue
    }
    if (keep.has(id)) {
      // O kit ainda o quer; foi a BIBLIOTECA que sumiu com ele. A pasta fica
      // (e a falha já está nomeada), então o cardápio do worktree sobrevive a
      // um acidente na lib.
      nextEntries.set(id, entry)
      continue
    }
    const destination = join(targetDir, id)
    const probe = probeTree(destination)
    if (probe.kind === 'absent') {
      pass.wrote = true
      continue
    }
    if (probe.kind === 'foreign') {
      pass.status.set(id, 'user')
      continue
    }
    const fingerprint = fingerprintTree(destination, probe.snapshot)
    if (fingerprint !== entry.fingerprint) {
      pass.status.set(id, 'user')
      continue
    }
    const removal = removeManaged(destination)
    if (removal) {
      pass.failures.set(id, removal)
      pass.status.set(id, 'failed')
      nextEntries.set(id, entry)
      continue
    }
    pass.wrote = true
    pass.removed.add(id)
  }

  const before = [...managed.values()]
  const after = [...nextEntries.values()]
  if (manifestChanged(before, after)) {
    writeManifest(targetDir, after)
    pass.wrote = true
  }
  return pass
}

function manifestChanged(
  before: SkillSyncManifestEntry[],
  after: SkillSyncManifestEntry[]
): boolean {
  if (before.length !== after.length) return true
  const index = new Map(before.map((entry) => [entry.id, entry]))
  for (const entry of after) {
    const previous = index.get(entry.id)
    if (!previous) return true
    if (previous.fingerprint !== entry.fingerprint) return true
    // A ORIGEM é escritura tanto quanto a impressão digital: kit → agent muda
    // quem manda naquela pasta, e isso tem de pousar no disco.
    if ((previous.origin ?? 'kit') !== (entry.origin ?? 'kit')) return true
    if (!sameWitness(previous.dest, entry.dest)) return true
    if (!sameWitness(previous.source, entry.source)) return true
  }
  return false
}

/**
 * MATERIALIZA O KIT DESTE TIPO DE CHAT NO WORKTREE.
 *
 * `chat: null` = kit VAZIO (release, e qualquer pane sem tipo resolvível): o
 * sync então só REMOVE o que o Synkora gerenciava ali.
 *
 * Nunca lança: qualquer erro de disco vira falha nomeada no resultado, porque
 * quem chama é o spawn de uma conversa e o spawn nunca pode morrer por causa
 * do cardápio.
 */
export function syncPaneSkills(
  cwd: string,
  chat: SkillChatType | null,
  options: SkillSyncOptions = {}
): SkillSyncOutcome {
  const synced: string[] = []
  const removed: string[] = []
  const userModified: string[] = []
  const failures: SkillSyncFailure[] = []
  let wrote = false

  if (!cwd) {
    failures.push({ id: 'skills', error: 'o pane veio sem pasta de trabalho' })
    return { ok: false, synced, removed, failures, userModified, wrote }
  }

  const libraryRoot = options.libraryRoot ?? skillsLibraryRoot()
  const slots = options.kit ?? (chat ? kitForChat(skillsKitStore().state(), chat) : [])
  // `chat: null` manda kit vazio mesmo que o chamador tenha passado slots: o
  // tipo do chat é a autoridade, e release não tem cardápio por contrato.
  const wanted = chat ? slots.filter((slot) => slot.enabled !== false && isSkillId(slot.id)) : []

  // A LIB PRIMEIRO: um id do kit que não existe no disco é falha — e é falha
  // NOMEADA, porque é ela que o dono lê na nota do chat.
  const desired = new Map<string, TreeSnapshot>()
  const status = new Map<string, SkillStatus>()
  const failureById = new Map<string, string>()
  for (const slot of wanted) {
    if (desired.has(slot.id) || failureById.has(slot.id)) continue
    const probe = probeTree(join(libraryRoot, slot.id))
    if (probe.kind === 'absent') {
      failureById.set(slot.id, 'não está na biblioteca desta máquina')
      status.set(slot.id, 'failed')
      continue
    }
    if (probe.kind === 'foreign') {
      failureById.set(slot.id, `a pasta na biblioteca não pôde ser copiada: ${probe.reason}`)
      status.set(slot.id, 'failed')
      continue
    }
    desired.set(slot.id, probe.snapshot)
  }

  const keep = new Set(failureById.keys())
  const removedIds = new Set<string>()
  for (const target of TARGET_DIRS) {
    const targetDir = join(cwd, target)
    let pass: TargetPass
    try {
      pass = syncTarget(cwd, targetDir, desired, keep, libraryRoot)
    } catch (error) {
      // Um alvo inteiro caiu (disco cheio, permissão): o outro segue, e a
      // PASTA vira o nome da falha para o diário não virar adivinhação.
      const message = error instanceof Error ? error.message : 'falha ao preparar a pasta'
      failureById.set(target, message)
      status.set(target, 'failed')
      continue
    }
    if (pass.wrote) wrote = true
    for (const id of pass.removed) removedIds.add(id)
    for (const [id, error] of pass.failures) {
      if (!failureById.has(id)) failureById.set(id, `${target}: ${error}`)
    }
    for (const [id, value] of pass.status) {
      const current = status.get(id)
      // Precedência: falha manda sobre "é do dono", que manda sobre "em dia" —
      // o pior estado é o que o dono precisa ver.
      if (current === 'failed') continue
      if (value === 'failed' || current === undefined || (value === 'user' && current === 'synced')) {
        status.set(id, value)
      }
    }
  }
  if (wrote) sweepLanding(cwd)

  for (const [id, value] of status) {
    if (value === 'synced') synced.push(id)
    else if (value === 'user') userModified.push(id)
  }
  for (const [id, error] of failureById) failures.push({ id, error })
  for (const id of removedIds) removed.push(id)

  synced.sort(compareText)
  removed.sort(compareText)
  userModified.sort(compareText)
  failures.sort((left, right) => compareText(left.id, right.id))

  return { ok: failures.length === 0, synced, removed, failures, userModified, wrote }
}

/**
 * A NOTA NO FIO quando o sync falhou (ADR-0002: falha de sync nunca é muda).
 * `null` = não há o que dizer ao dono.
 *
 * Ela nomeia os ids e diz a consequência REAL — o cardápio do CLI pode estar
 * incompleto —, e termina na receita (a tela que resolve). Pasta que o dono pôs
 * à mão NÃO entra aqui: aquilo é o sistema funcionando como projetado, e vira
 * linha de caixa-preta, não ruído no chat dele.
 */
export function skillsSyncNoteText(outcome: SkillSyncOutcome): string | null {
  if (outcome.failures.length === 0) return null
  const shown = outcome.failures.slice(0, 4).map((failure) => `"${failure.id}" (${failure.error})`)
  const rest = outcome.failures.length - shown.length
  const tail = rest > 0 ? ` e mais ${rest}` : ''
  return `⚠ não consegui preparar ${shown.join(', ')}${tail} — o cardápio de skills deste chat pode estar incompleto. Confira em Ajustes › Skills.`
}
