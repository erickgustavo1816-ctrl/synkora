/**
 * BAIXAR SKILL DE PASTA PINADA (Skills 2.0 — ADR-0007; Skills 3.0 — ADR-0010).
 *
 * A biblioteca está CONGELADA: nada entra sozinho, nada atualiza no boot. O
 * dono instala colando a URL da PASTA de uma skill no GitHub, e este módulo é o
 * ÚNICO lugar do subsistema onde existe rede.
 *
 * DOIS CONSUMIDORES desde 2026-09-08 (ADR-0010, "ir lá, ler a skill, utilizar a
 * skill naquela missão e depois descartar"): o dono, por `installSkillFromUrl`
 * (a pasta pousa na BIBLIOTECA da máquina), e o agente, por `downloadSkillFolder`
 * (a pasta pousa num STAGING e quem chama a materializa no WORKTREE da missão,
 * onde ela morre com a missão). O miolo — pin, validação, tetos, download — é o
 * MESMO nos dois caminhos: uma segunda cópia dele seria uma segunda política de
 * defesa, e é justamente a defesa que não pode divergir.
 *
 * Receita ressuscitada do instalador F6 (`git show d43a3b4^:src/main/skillsLibrary.ts`),
 * adaptada — não copiada: só o miolo que importa.
 *   1. PIN: `commits?path=<pasta>` devolve o sha do ÚLTIMO COMMIT DA PASTA.
 *      A versão instalada é esse sha, não "o HEAD de hoje".
 *   2. `git/trees/<sha>?recursive=1` lista os blobs — download SEM git.
 *   3. `raw.githubusercontent.com/<repo>/<sha>/<arquivo>` baixa cada um
 *      (raw não consome a cota core; ponteiro LFS cai no media).
 *   4. VALIDAÇÃO: `name:` do frontmatter existe, é um id de pasta legal e
 *      BATE com o nome da pasta apontada (a spec dos dois CLIs exige
 *      pasta == name; divergência instalaria um menu mentiroso).
 *   5. GRAVA UTF-8 SEM BOM: o BOM quebra o parse de frontmatter do codex
 *      (sonda 2026-08-29; o claude de hoje tolera — basta um recusar para a
 *      regra valer) — quando o upstream vem com BOM, ele cai na escrita.
 *   6. PIN NO MANIFEST: `installed[id] = { sha, installedAt }`, preservando
 *      todo o resto do arquivo (o manifest do dono tem 404 entradas).
 *
 * A skill instalada NÃO entra em kit nenhum sozinha (ADR-0004: quem escolhe a
 * ocasião é o dono, na tela). Toda recusa NOMEIA a receita.
 */
import { mkdirSync, existsSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { isSkillId } from './skillsKit'
import {
  SKILLS_MANIFEST_UNREADABLE,
  parseSkillFrontmatter,
  readSkillsManifest,
  skillsBaseDir,
  skillsLibraryRoot,
  skillsManifestFile,
  writeSkillsManifest
} from './skillsLibraryScan'

export interface SkillFolderSource {
  /** owner/repo público no GitHub */
  repo: string
  /** subpasta da skill ('' = a skill mora na raiz do repo) */
  path: string
  /** branch/tag de referência (ausente = branch padrão do repo) */
  ref?: string
}

export type SkillInstallResult = { ok: true; id: string } | { ok: false; error: string }

export interface SkillInstallOptions {
  /** raiz de `skills/` (as suítes apontam para um temporário) */
  base?: string
  /** injeção para teste: sem isto, `globalThis.fetch` */
  fetch?: typeof globalThis.fetch
}

/** O pacote baixado, pousado num staging e ainda SEM destino final. */
export interface SkillDownload {
  /** `name:` do frontmatter — e o nome da pasta que o consumidor vai criar */
  id: string
  /** sha do último commit DA PASTA: é a versão baixada (ADR-0007) */
  sha: string
  /** o staging com a pasta já pronta — quem chama renomeia ou apaga */
  dir: string
  source: SkillFolderSource
  /** `description:` do frontmatter, quando existe (recibo e rastro) */
  description?: string
  files: number
  bytes: number
}

export interface SkillDownloadOptions {
  /** injeção para teste: sem isto, `globalThis.fetch` */
  fetch?: typeof globalThis.fetch
  /** pasta onde o pouso `.dl-<id>-<rand>` é criado (nunca o destino final) */
  staging: string
  /** id esperado (entrada do CATÁLOGO): substitui a checagem "pasta == name"
   *  por "name == expectId" — a curadoria F6 instala pelo NAME quando a pasta
   *  upstream difere (ex.: skills/soft-skill → high-end-visual-design). */
  expectId?: string
  /**
   * AVAL DO CHAMADOR entre resolver o id e gastar rede (retornar texto = recusa).
   * Existe porque a ORDEM é contrato na instalação do dono: "já está na
   * biblioteca" e "manifest ilegível" recusam ANTES da listagem de arquivos —
   * pin que não pode ser gravado é instalação sem procedência, e a suíte prende
   * que a tree nunca é chamada nesses casos. Quem baixa para o worktree
   * (skill_pull) simplesmente omite.
   */
  claimId?: (id: string, sha: string) => string | undefined
}

export type SkillDownloadResult =
  | { ok: true; download: SkillDownload }
  | { ok: false; error: string }

const FETCH_TIMEOUT_MS = 20_000
// Tetos do F6, mantidos: skill legítima grande EXISTE (o impeccable tem ~150
// arquivos de reference/), então o corte fica bem acima do normal.
const MAX_FILES = 200
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 30 * 1024 * 1024
const DOWNLOAD_WORKERS = 6
// Vídeo em pasta de skill é demo do autor — nenhum CLI consome vídeo: é
// PULADO, não é motivo de recusa (caso real do F6: um .mp4 de ~5MB).
const SKIP_MEDIA_RE = /\.(mp4|mov|webm|avi|mkv|m4v)$/i
// Onde um BOM à frente quebraria o consumidor (frontmatter, JSON, script).
const TEXT_FILE_RE = /\.(md|markdown|txt|json|ya?ml|mjs|cjs|js|ts|tsx|jsx|sh|ps1|py|toml|css|html?)$/i

const URL_RECIPE =
  'aponte a PASTA da skill no GitHub — https://github.com/<dono>/<repo>/tree/<branch>/<caminho>/<pasta-da-skill> (ou "dono/repo" quando o SKILL.md mora na raiz)'

/** "…/tree/<ref>/<pasta>", "https://github.com/o/r" ou "o/r" → fonte. */
export function parseSkillFolderUrl(input: string): SkillFolderSource | null {
  const trimmed = typeof input === 'string' ? input.trim().replace(/\/+$/, '') : ''
  if (!trimmed) return null
  let match = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/tree\/([^/\s]+)\/(.+)$/i
  )
  if (match) {
    return { repo: `${match[1]}/${match[2]}`, ref: match[3], path: match[4].replace(/\/+$/, '') }
  }
  match = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i)
  if (match) return { repo: `${match[1]}/${match[2]}`, path: '' }
  match = trimmed.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (match) return { repo: `${match[1]}/${match[2]}`, path: '' }
  return null
}

/** O último segmento da URL: é ele que precisa bater com o `name:`. */
export function folderNameOf(source: SkillFolderSource): string {
  if (!source.path) return ''
  const parts = source.path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

interface GhResult {
  status: number
  body?: unknown
  /** epoch (s) em que a cota anônima reseta — presente em 403/429 */
  rateReset?: number
}

function rateLimitMessage(result: GhResult): string {
  if (result.rateReset) {
    const at = new Date(result.rateReset * 1000)
    const hh = String(at.getHours()).padStart(2, '0')
    const mm = String(at.getMinutes()).padStart(2, '0')
    return `o GitHub recusou por limite de requisições — a cota anônima libera às ${hh}:${mm}; tente de novo depois desse horário`
  }
  return 'o GitHub recusou por limite de requisições — a cota anônima é de 60 chamadas por hora; tente de novo em alguns minutos'
}

type Fetcher = typeof globalThis.fetch

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function gh(fetcher: Fetcher, url: string): Promise<GhResult> {
  return withTimeout(async (signal) => {
    const response = await fetcher(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'synkora-skills' },
      signal
    })
    const out: GhResult = {
      status: response.status,
      body: await response.json().catch(() => undefined)
    }
    if (
      (response.status === 403 || response.status === 429) &&
      response.headers.get('x-ratelimit-remaining') === '0'
    ) {
      const reset = Number(response.headers.get('x-ratelimit-reset'))
      if (Number.isFinite(reset)) out.rateReset = reset
    }
    return out
  })
}

async function fetchRawFrom(
  fetcher: Fetcher,
  host: string,
  repo: string,
  sha: string,
  filePath: string
): Promise<Buffer> {
  return withTimeout(async (signal) => {
    const encoded = filePath.split('/').map(encodeURIComponent).join('/')
    const response = await fetcher(`https://${host}/${repo}/${sha}/${encoded}`, {
      headers: { 'user-agent': 'synkora-skills' },
      signal
    })
    if (!response.ok) throw new Error(`raw ${response.status} em ${filePath}`)
    return Buffer.from(await response.arrayBuffer())
  })
}

async function fetchRaw(
  fetcher: Fetcher,
  repo: string,
  sha: string,
  filePath: string
): Promise<Buffer> {
  const buffer = await fetchRawFrom(fetcher, 'raw.githubusercontent.com', repo, sha, filePath)
  // Git LFS: o raw entrega o PONTEIRO — o binário real mora no media.
  if (
    buffer.length < 512 &&
    buffer.toString('utf8').startsWith('version https://git-lfs.github.com/spec/')
  ) {
    return fetchRawFrom(fetcher, 'media.githubusercontent.com/media', repo, sha, filePath)
  }
  return buffer
}

/** sha do ÚLTIMO COMMIT DA PASTA — o pin do ADR-0007. */
async function pinFolderSha(
  fetcher: Fetcher,
  source: SkillFolderSource
): Promise<{ sha?: string; error?: string }> {
  const query = new URLSearchParams({ per_page: '1' })
  if (source.path) query.set('path', source.path)
  if (source.ref) query.set('sha', source.ref)
  const result = await gh(fetcher, `https://api.github.com/repos/${source.repo}/commits?${query}`)
  if (result.status === 403 || result.status === 429) return { error: rateLimitMessage(result) }
  if (result.status === 404) {
    return {
      error: `não achei ${source.repo}${source.path ? `/${source.path}` : ''} no GitHub — confira se o repositório é público e se o caminho existe (${URL_RECIPE})`
    }
  }
  const sha = Array.isArray(result.body)
    ? (result.body as { sha?: string }[])[0]?.sha
    : undefined
  if (typeof sha !== 'string' || !sha) {
    return {
      error: `o GitHub não devolveu commit para ${source.repo}${source.path ? `/${source.path}` : ''} (HTTP ${result.status}) — ${URL_RECIPE}`
    }
  }
  return { sha }
}

interface TreeBlob {
  path: string
  size?: number
}

async function repoTree(
  fetcher: Fetcher,
  repo: string,
  sha: string
): Promise<{ files?: TreeBlob[]; error?: string }> {
  const result = await gh(
    fetcher,
    `https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`
  )
  if (result.status === 403 || result.status === 429) return { error: rateLimitMessage(result) }
  const body = result.body as
    | {
        tree?: { path?: string; type?: string; size?: number; mode?: string }[]
        truncated?: boolean
      }
    | undefined
  if (result.status !== 200 || !body?.tree) {
    return { error: `a listagem de arquivos de ${repo} falhou (HTTP ${result.status})` }
  }
  // Tree truncada = o GitHub cortou a listagem no meio. Instalar assim
  // entregaria uma skill PELA METADE em silêncio; a recusa nomeia a saída.
  if (body.truncated === true) {
    return {
      error: `o repositório ${repo} é grande demais para listar de uma vez (o GitHub truncou a resposta) — instalar daqui entregaria a skill pela metade; peça ao autor uma pasta em repositório menor, ou copie a pasta da skill para a biblioteca à mão`
    }
  }
  // só arquivos normais: symlink (120000) e submódulo (160000) ficam de fora
  const files = body.tree
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        typeof entry.path === 'string' &&
        (entry.mode === '100644' || entry.mode === '100755' || entry.mode === undefined)
    )
    .map((entry) => ({ path: entry.path as string, size: entry.size }))
  return { files }
}

/** Destino seguro dentro do staging: caminho do tree é dado do GitHub, não
 *  autoridade — `..`, raiz e letra de unidade escapariam da pasta. */
function safeDestination(root: string, relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, '/')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split('/').some((part) => part === '..' || part === '')
  ) {
    return null
  }
  const destination = resolve(root, ...normalized.split('/'))
  const resolvedRoot = resolve(root)
  if (destination !== resolvedRoot && !destination.startsWith(resolvedRoot + sep)) return null
  return destination
}

/** UTF-8 SEM BOM em tudo que alguém vai PARSEAR. */
function withoutBom(buffer: Buffer, relativePath: string): Buffer {
  if (!TEXT_FILE_RE.test(relativePath)) return buffer
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3)
  }
  return buffer
}

/**
 * O MIOLO: baixa a pasta apontada, pinada no sha do último commit DELA, para
 * `<staging>/.dl-<id>-<rand>`. Nada aqui decide destino — quem chama renomeia
 * o pouso para o lugar (biblioteca ou worktree) ou o apaga.
 *
 * Nunca lança: erro de rede/disco volta como recusa escrita, e o pouso é
 * removido antes de a recusa sair.
 */
export async function downloadSkillFolder(
  source: SkillFolderSource,
  options: SkillDownloadOptions
): Promise<SkillDownloadResult> {
  const fetcher = options.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') {
    return { ok: false, error: 'este build não tem fetch disponível para falar com o GitHub' }
  }
  if (!source || typeof source.repo !== 'string' || !source.repo) {
    return { ok: false, error: `fonte de skill inválida — ${URL_RECIPE}` }
  }

  const pinned = await pinFolderSha(fetcher, source)
  if (!pinned.sha) return { ok: false, error: pinned.error ?? 'o GitHub não respondeu' }
  const sha = pinned.sha
  const prefix = source.path ? `${source.path}/` : ''

  // O SKILL.md vem PRIMEIRO: é ele que decide o id, e uma pasta que não é
  // skill se recusa antes de baixar 200 arquivos.
  let head: string
  try {
    head = (await fetchRaw(fetcher, source.repo, sha, `${prefix}SKILL.md`)).toString('utf8')
  } catch {
    return {
      ok: false,
      error: `não achei SKILL.md em ${source.repo}/${source.path || '(raiz)'} — ${URL_RECIPE}`
    }
  }
  const frontmatter = parseSkillFrontmatter(head)
  const id = frontmatter.name?.trim().toLowerCase()
  if (!id || !isSkillId(id)) {
    return {
      ok: false,
      error: `o SKILL.md não tem um "name:" válido no frontmatter (achei: "${frontmatter.name ?? '—'}") — o name é o id da skill: minúsculas, dígitos e hífen simples`
    }
  }
  // Com `expectId` (entrada do CATÁLOGO) a régua é o NAME: a curadoria F6
  // aponta pastas cujo nome upstream difere do id da skill. Sem ele, vale a
  // spec dos dois CLIs — pasta igual ao name.
  if (options.expectId) {
    if (id !== options.expectId) {
      return {
        ok: false,
        error: `o catálogo pede "${options.expectId}" e o SKILL.md dessa pasta diz name: "${id}" — a fonte mudou de conteúdo; puxe por URL se é essa skill que você quer, ou avise no fio`
      }
    }
  } else {
    const folder = folderNameOf(source)
    if (folder && folder.toLowerCase() !== id) {
      return {
        ok: false,
        error: `a pasta apontada chama "${folder}" e o frontmatter diz name: "${id}" — os dois CLIs exigem pasta igual ao name; aponte a pasta "${id}" no repositório (ou corrija o SKILL.md na origem)`
      }
    }
  }

  const claim = options.claimId?.(id, sha)
  if (claim) return { ok: false, error: claim }

  const tree = await repoTree(fetcher, source.repo, sha)
  if (!tree.files) return { ok: false, error: tree.error ?? 'a listagem de arquivos falhou' }
  const inFolder = tree.files.filter((file) => file.path.startsWith(prefix))
  const skillMd = inFolder.find((file) => file.path === `${prefix}SKILL.md`)
  if (!skillMd) {
    return {
      ok: false,
      error: `a pasta ${source.path || '(raiz)'} não tem SKILL.md no commit ${sha.slice(0, 7)} — ${URL_RECIPE}`
    }
  }
  const wanted = inFolder.filter(
    (file) =>
      file.path === `${prefix}SKILL.md` ||
      (!SKIP_MEDIA_RE.test(file.path) && (file.size ?? 0) <= MAX_FILE_BYTES)
  )
  if (wanted.length > MAX_FILES) {
    return {
      ok: false,
      error: `essa pasta tem ${wanted.length} arquivos (o teto é ${MAX_FILES}) — aponte a pasta da SKILL, não a raiz de uma coleção`
    }
  }
  const totalBytes = wanted.reduce((sum, file) => sum + (file.size ?? 0), 0)
  if (totalBytes > MAX_TOTAL_BYTES) {
    return {
      ok: false,
      error: `essa pasta pesa ${Math.round(totalBytes / 1024 / 1024)}MB (o teto é 30MB) — aponte a pasta da SKILL, não a raiz de uma coleção`
    }
  }

  // Pouso com sufixo ALEATÓRIO: duas frotas puxando a mesma skill no mesmo
  // staging não podem colidir num nome previsível.
  const landing = join(
    options.staging,
    `.dl-${id}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`
  )
  try {
    rmSync(landing, { recursive: true, force: true })
    mkdirSync(landing, { recursive: true })
    const queue = [...wanted]
    let written = 0
    let bytes = 0
    const workers = Array.from({ length: Math.min(DOWNLOAD_WORKERS, queue.length) }, async () => {
      for (;;) {
        const file = queue.shift()
        if (!file) return
        const relativePath = prefix ? file.path.slice(prefix.length) : file.path
        const target = safeDestination(landing, relativePath)
        if (!target) throw new Error(`caminho recusado no pacote: ${file.path}`)
        const buffer = await fetchRaw(fetcher, source.repo, sha, file.path)
        const clean = withoutBom(buffer, relativePath)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, clean)
        written += 1
        bytes += clean.length
      }
    })
    await Promise.all(workers)
    return {
      ok: true,
      download: {
        id,
        sha,
        dir: landing,
        source,
        ...(frontmatter.description ? { description: frontmatter.description } : {}),
        files: written,
        bytes
      }
    }
  } catch (error) {
    rmSync(landing, { recursive: true, force: true })
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: `o download falhou: ${detail} — confira a conexão e a fonte (${URL_RECIPE})`
    }
  }
}

/**
 * Baixa a pasta apontada e a promove para `lib/<name>`. A skill NÃO entra em
 * kit nenhum: é a tela que escolhe a ocasião depois.
 */
export async function installSkillFromUrl(
  url: string,
  options: SkillInstallOptions = {}
): Promise<SkillInstallResult> {
  const base = options.base ?? skillsBaseDir()
  const libRoot = skillsLibraryRoot(base)
  const manifestFile = skillsManifestFile(base)

  const source = parseSkillFolderUrl(url)
  if (!source) return { ok: false, error: `URL inválida — ${URL_RECIPE}` }

  try {
    // As duas recusas que precisam acontecer ANTES da rede de download: pasta
    // que já existe (a instalação nunca sobrescreve) e manifest ilegível (pin
    // que não pode ser gravado é instalação sem procedência).
    let manifestRead: ReturnType<typeof readSkillsManifest> | undefined
    const downloaded = await downloadSkillFolder(source, {
      ...(options.fetch ? { fetch: options.fetch } : {}),
      staging: base,
      claimId: (id) => {
        if (existsSync(join(libRoot, id))) {
          return `"${id}" já está na biblioteca — a instalação por URL nunca sobrescreve o que já existe; use a PODA (na tela de Skills) para tirar da biblioteca o que não está em kit nenhum e instale de novo`
        }
        manifestRead = readSkillsManifest(manifestFile)
        return manifestRead.ok ? undefined : SKILLS_MANIFEST_UNREADABLE
      }
    })
    if (!downloaded.ok) return { ok: false, error: downloaded.error }
    const { id, sha, dir } = downloaded.download
    if (!manifestRead) {
      // Só acontece se o aval não tiver rodado — nunca acontece hoje, e mesmo
      // assim a instalação não segue sem procedência.
      rmSync(dir, { recursive: true, force: true })
      return { ok: false, error: SKILLS_MANIFEST_UNREADABLE }
    }

    try {
      mkdirSync(libRoot, { recursive: true })
      renameSync(dir, join(libRoot, id))
    } catch (error) {
      rmSync(dir, { recursive: true, force: true })
      throw error
    }

    const manifest = manifestRead.manifest
    manifest.installed = { ...manifest.installed, [id]: { sha, installedAt: new Date().toISOString() } }
    if (manifest.updates && id in manifest.updates) {
      const updates = { ...manifest.updates }
      delete updates[id]
      manifest.updates = updates
    }
    writeSkillsManifest(manifest, manifestFile)
    return { ok: true, id }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      error: `a instalação falhou: ${detail} — confira a conexão e a URL (${URL_RECIPE})`
    }
  }
}
