import { readFileSync, realpathSync, statSync } from 'fs'
import { extname, isAbsolute, relative, resolve } from 'path'

export interface TerminalFileRoot {
  id: 'project' | 'pane'
  path: string
}

export interface ResolvedTerminalFile {
  absolutePath: string
  /** Caminho relativo, sempre com /, seguro para voltar pelo IPC. */
  relativePath: string
  root: TerminalFileRoot['id']
}

export interface TerminalFileLink extends ResolvedTerminalFile {
  /** Offset UTF-16 no texto enviado pelo renderer. */
  start: number
  length: number
  text: string
}

export interface ProjectMarkdownDocument {
  content: string
  mtime: number
}

const MAX_LINE = 16_384
const MAX_STARTS = 128
const MAX_ABSOLUTE_STARTS = 32
const MAX_EXTENSIONS_PER_START = 16
/** Teto global por linha: a saída do terminal não é confiável e uma linha
 * fabricada com milhares de falsas extensões não pode bloquear o main. */
const MAX_RESOLUTION_ATTEMPTS = 256
/** Somente formatos passivos conhecidos são entregues ao aplicativo associado.
 * Qualquer formato desconhecido/ativo continua clicável, mas apenas é revelado
 * no Explorer. Uma denylist seria frágil: associações como WScript, Python,
 * Java, AutoHotkey e ClickOnce executam vários sufixos diretamente. */
const SAFE_EXTERNAL_EXTENSIONS = new Set([
  '.aac',
  '.avif',
  '.bmp',
  '.csv',
  '.docx',
  '.flac',
  '.gif',
  '.heic',
  '.heif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.json',
  '.jsonc',
  '.log',
  '.m4a',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.odp',
  '.ods',
  '.odt',
  '.ogg',
  '.opus',
  '.pdf',
  '.png',
  '.pptx',
  '.tif',
  '.tiff',
  '.tsv',
  '.txt',
  '.wav',
  '.webm',
  '.webp',
  '.wmv',
  '.xlsx',
  '.yaml',
  '.yml'
])

export function terminalFileOpenKind(path: string): 'markdown' | 'external' | 'reveal' {
  const extension = extname(path).toLowerCase()
  if (extension === '.md') return 'markdown'
  return SAFE_EXTERNAL_EXTENSIONS.has(extension) ? 'external' : 'reveal'
}

function real(path: string): string | null {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

type PreparedTerminalFileRoot = TerminalFileRoot & { realPath: string }

function prepareRoots(roots: TerminalFileRoot[]): PreparedTerminalFileRoot[] {
  return roots
    .map((root) => ({ ...root, realPath: real(root.path) }))
    .filter((root): root is PreparedTerminalFileRoot => Boolean(root.realPath))
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function candidateStarts(text: string): number[] {
  const absolute: number[] = []
  const relative: number[] = []
  const opener = (char: string | undefined): boolean =>
    char === undefined || /[\s([{"'`=]/u.test(char)

  for (let i = 0; i < text.length; i++) {
    // Caminho Windows absoluto pode aparecer depois de texto corrido: "em C:\\...".
    const driveAbsolute =
      /[A-Za-z]/u.test(text[i] ?? '') &&
      text[i + 1] === ':' &&
      (text[i + 2] === '\\' || text[i + 2] === '/')
    const uncAbsolute =
      text[i] === '\\' &&
      text[i + 1] === '\\' &&
      Boolean(text[i + 2] && !/\s/u.test(text[i + 2]))
    if (absolute.length < MAX_ABSOLUTE_STARTS && (driveAbsolute || uncAbsolute)) {
      absolute.push(i)
      i += driveAbsolute ? 2 : 1
      continue
    }
    if (relative.length >= MAX_STARTS) continue
    if (!opener(text[i - 1])) continue
    const tail = text.slice(i)
    // Relativos usuais, inclusive nomes Unicode e arquivos convencionais sem
    // extensão. A existência real ainda é obrigatoriamente validada abaixo.
    if (
      /^(?:\.{1,2}[\\/]|\.?[\p{L}\p{N}_][\p{L}\p{N}_.-]*(?:[\\/]|\.[A-Za-z0-9])|\.[\p{L}\p{N}_-]+(?=$|[\s,;:)\]}])|(?:Makefile|Dockerfile|LICENSE|README|CHANGELOG|NOTICE|Procfile|Gemfile|Rakefile|Vagrantfile)(?=$|[\s,;:)\]}]))/iu.test(
        tail
      )
    ) {
      relative.push(i)
    }
  }
  return [...absolute, ...relative]
}

/** Resolve um texto de caminho contra raízes já autorizadas e confirma o alvo
 * real (após junction/symlink). Arquivo que escapa por link simbólico é negado. */
function resolvePreparedTerminalFile(
  rawCandidate: string,
  realRoots: PreparedTerminalFileRoot[]
): ResolvedTerminalFile | null {
  if (!rawCandidate || rawCandidate.length > 2_048 || rawCandidate.includes('\0')) return null
  const candidate = rawCandidate.trim()
  if (!candidate) return null

  if (!realRoots.length) return null

  // Caminho relativo pertence primeiro ao cwd do pane. A raiz do projeto é
  // fallback para mensagens do runtime; inverter isso abriria o README da base
  // quando um agente em worktree acabou de mencionar o README da própria branch.
  const lookupRoots = [...realRoots].sort((a, b) =>
    a.id === 'pane' ? -1 : b.id === 'pane' ? 1 : 0
  )
  const attempts = isAbsolute(candidate)
    ? [resolve(candidate)]
    : lookupRoots.map((root) => resolve(root.realPath, candidate))

  for (const attempt of attempts) {
    const target = real(attempt)
    if (!target) continue
    try {
      if (!statSync(target).isFile()) continue
    } catch {
      continue
    }
    // Prefere a raiz do projeto quando o arquivo pertence às duas raízes. Isso
    // mantém Markdown da base estável mesmo se o pane encerrar depois do clique.
    for (const root of [...realRoots].sort((a, b) => (a.id === 'project' ? -1 : b.id === 'project' ? 1 : 0))) {
      if (!isInside(root.realPath, target)) continue
      return {
        absolutePath: target,
        relativePath: relative(root.realPath, target).replace(/\\/g, '/'),
        root: root.id
      }
    }
  }
  return null
}

export function resolveTerminalFile(
  rawCandidate: string,
  roots: TerminalFileRoot[]
): ResolvedTerminalFile | null {
  return resolvePreparedTerminalFile(rawCandidate, prepareRoots(roots))
}

/** Leitura usada pela aba Arquivos. O caminho precisa ser relativo e o alvo
 * físico continua dentro do projeto depois de resolver symlink/junction. */
export function readProjectMarkdown(
  projectPath: string,
  relativePath: string
): ProjectMarkdownDocument | null {
  if (
    typeof projectPath !== 'string' ||
    typeof relativePath !== 'string' ||
    !relativePath ||
    relativePath.length > 2_048 ||
    relativePath.includes('\0') ||
    isAbsolute(relativePath) ||
    !/\.md$/i.test(relativePath)
  ) return null

  const file = resolveTerminalFile(relativePath, [{ id: 'project', path: projectPath }])
  if (!file || !/\.md$/i.test(file.absolutePath)) return null
  try {
    const stat = statSync(file.absolutePath)
    if (stat.size > 2 * 1024 * 1024) {
      return {
        content: '_arquivo grande demais para o viewer (>2MB)_',
        mtime: stat.mtimeMs
      }
    }
    return { content: readFileSync(file.absolutePath, 'utf-8'), mtime: stat.mtimeMs }
  } catch {
    return null
  }
}

/** Encontra candidatos pelo formato, mas só devolve links cujo arquivo existe
 * e passou pela contenção acima. Extensões e limites de palavra viram endpoints;
 * assim tanto "arquivo.png," quanto "Makefile)" excluem a pontuação do link. */
export function findTerminalFileLinks(
  rawText: string,
  roots: TerminalFileRoot[]
): TerminalFileLink[] {
  const text = rawText.slice(0, MAX_LINE)
  const found: TerminalFileLink[] = []
  const realRoots = prepareRoots(roots)
  if (!realRoots.length) return found
  let resolutionAttempts = 0
  const coveredRanges: Array<{ start: number; end: number }> = []

  const starts = candidateStarts(text).sort((a, b) => {
    const aAbsolute =
      /^[A-Za-z]:[\\/]/u.test(text.slice(a, a + 3)) || text.slice(a, a + 2) === '\\\\'
    const bAbsolute =
      /^[A-Za-z]:[\\/]/u.test(text.slice(b, b + 3)) || text.slice(b, b + 2) === '\\\\'
    return Number(bAbsolute) - Number(aAbsolute) || a - b
  })

  for (const start of starts) {
    // Um caminho absoluto com espaços também parece conter pequenos caminhos
    // relativos. Depois de validá-lo, não consulta o disco de novo no miolo.
    if (coveredRanges.some((range) => start >= range.start && start < range.end)) continue
    if (resolutionAttempts >= MAX_RESOLUTION_ATTEMPTS) break
    const tail = text.slice(start, start + 2_048)
    // Aspas, pipe e quebras não pertencem a nomes de arquivo no Windows. Espaço
    // permanece permitido para caminhos absolutos como "CALCULADORA - Copia".
    const hardStop = tail.search(/[\u0000-\u001f<>"|]/u)
    const searchable = hardStop >= 0 ? tail.slice(0, hardStop) : tail
    const extension = /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}/gu
    let match: RegExpExecArray | null
    const extensionEnds: number[] = []
    while ((match = extension.exec(searchable)) && extensionEnds.length < MAX_EXTENSIONS_PER_START) {
      extensionEnds.push(match.index + match[0].length)
    }
    const boundaryEnds: number[] = []
    for (let index = 1; index <= searchable.length && boundaryEnds.length < MAX_EXTENSIONS_PER_START; index++) {
      const char = searchable[index]
      const sentencePeriod =
        char === '.' &&
        (index + 1 === searchable.length || /[\s,;!?)\]}\u0027`]/u.test(searchable[index + 1] ?? ''))
      if (
        index === searchable.length ||
        sentencePeriod ||
        (char != null && /[\s,;!?)\]}\u0027`]/u.test(char))
      ) {
        boundaryEnds.push(index)
      }
    }
    const endpoints = [...new Set([...extensionEnds, ...boundaryEnds])]
      .slice(0, MAX_EXTENSIONS_PER_START)
    let best: TerminalFileLink | null = null

    for (const length of endpoints) {
      if (resolutionAttempts >= MAX_RESOLUTION_ATTEMPTS) break
      const candidate = searchable.slice(0, length)
      resolutionAttempts++
      const resolved = resolvePreparedTerminalFile(candidate, realRoots)
      if (!resolved) continue
      // Se houver nomes compostos (arquivo.test.ts), fica com o caminho válido
      // mais longo iniciado na mesma posição.
      if (!best || length > best.length) {
        best = { ...resolved, start, length, text: candidate }
      }
    }
    if (best) {
      found.push(best)
      coveredRanges.push({ start: best.start, end: best.start + best.length })
    }
  }

  // Um caminho absoluto pode conter um relativo também válido. Mantém apenas
  // o link externo/mais longo, sem duas áreas de clique sobrepostas.
  const accepted: TerminalFileLink[] = []
  for (const link of found.sort((a, b) => a.start - b.start || b.length - a.length)) {
    const end = link.start + link.length
    if (accepted.some((current) => link.start < current.start + current.length && end > current.start)) {
      continue
    }
    accepted.push(link)
  }
  return accepted
}
