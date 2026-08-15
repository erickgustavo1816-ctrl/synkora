// VISUALIZADOR DE COMMIT (2.0) — o parser PURO por trás das duas superfícies do
// histórico da missão.
//
// O trilho mostrava o patch CRU dentro de uma caixa de ~200px: linha quebrada no
// meio, nenhum arquivo separado do outro, nenhuma cor além de um paredão de
// texto. A queixa do dono ("expandi e não dá pra entender nada") não se resolve
// com CSS — o diff precisa VIRAR ESTRUTURA antes de virar pixel.
//
// Este módulo é o único lugar que entende o formato do git. Ele recebe o diff
// unificado que `missions:commitDiff` já devolve e produz um modelo por
// ARQUIVO (tipo de mudança, +N −M, hunks, linhas numeradas). Duas superfícies
// consomem o mesmo modelo, e por isso elas nunca discordam:
//
//   1. TRILHO (estreito): só o resumo — lista de arquivos com o placar.
//   2. VISUALIZADOR (largo): as linhas de verdade, por arquivo.
//
// SEM BIBLIOTECA DE DIFF: o formato é estável e o parser cabe aqui, testado com
// fixtures literais em scripts/test-right-rail.mjs. Nada aqui toca no DOM, no
// `window` ou no git — é função pura de string para dados.

/** Natureza da mudança do arquivo, no vocabulário do git. */
export type CommitFileKind = 'add' | 'delete' | 'modify' | 'rename' | 'copy' | 'mode'

export interface CommitDiffLine {
  /** `note` = recado do próprio git dentro do hunk ("\ No newline…"). */
  kind: 'add' | 'remove' | 'context' | 'note'
  text: string
  /** Numeração à esquerda/direita; `null` onde a linha não existe daquele lado. */
  oldNumber: number | null
  newNumber: number | null
}

export interface CommitDiffHunk {
  /** A linha `@@` crua, como o git escreveu. */
  header: string
  /** Só o `@@ -a,b +c,d @@` — a âncora que o leitor confere contra o arquivo. */
  range: string
  /** O que o git escreve DEPOIS do segundo `@@` (assinatura da função). */
  section: string
  lines: CommitDiffLine[]
}

export interface CommitDiffFile {
  /** Caminho de DESTINO (o nome novo, quando houve renomeação). */
  path: string
  /** Só em rename/copy: de onde o arquivo veio. */
  oldPath?: string
  kind: CommitFileKind
  /** Binário nunca vira linha na tela — nem o payload base85 do `--binary`. */
  binary: boolean
  insertions: number
  deletions: number
  hunks: CommitDiffHunk[]
  /** Soma das linhas dos hunks — o orçamento de render sai daqui. */
  lineCount: number
  /** Recado curto quando não há linhas para mostrar (modo, binário). */
  note?: string
}

export interface CommitDiffSummary {
  files: CommitDiffFile[]
  insertions: number
  deletions: number
  /** Arquivos que não couberam no teto de parse. */
  hiddenFiles: number
  /** O patch chegou cortado (teto do main) ou bateu no teto daqui. */
  truncated: boolean
  /** Veio texto, mas nenhum cabeçalho `diff --git` reconhecível. */
  unreadable: boolean
}

/** Tetos de PARSE. O main já corta o patch em 200KB; estes são o cinto para o
 *  caso de um commit patológico caber no corte e ainda assim ser enorme. */
const MAX_FILES = 200
const MAX_LINES = 20_000

/** Teto de RENDER por arquivo: acima disto entra o expansor "… +N linhas".
 *  400 linhas já é mais do que se lê de uma vez e mantém o DOM barato. */
export const COMMIT_DIFF_LINES_PER_FILE = 400

/** Orçamento de linhas abertas ao abrir o visualizador. Passou disto, o resto
 *  dos arquivos nasce recolhido — commit de 40 arquivos não congela a janela. */
export const COMMIT_DIFF_OPEN_BUDGET = 1_200

const KIND_VIEW: Record<CommitFileKind, { glyph: string; label: string; cls: string }> = {
  add: { glyph: '+', label: 'novo', cls: 'add' },
  delete: { glyph: '−', label: 'apagado', cls: 'del' },
  modify: { glyph: '~', label: 'alterado', cls: 'mod' },
  rename: { glyph: '→', label: 'renomeado', cls: 'mov' },
  copy: { glyph: '⧉', label: 'copiado', cls: 'mov' },
  mode: { glyph: '·', label: 'permissão', cls: 'mod' }
}

/** Glifo + rótulo PT-BR + classe de cor de um tipo de mudança. */
export function commitFileKindView(kind: CommitFileKind): {
  glyph: string
  label: string
  cls: string
} {
  return KIND_VIEW[kind] ?? KIND_VIEW.modify
}

/**
 * Encurta pelo MEIO preservando as duas pontas — num caminho, as pontas são o
 * que identifica (a raiz e o nome do arquivo); o miolo é o que se pode perder.
 * CSS só sabe cortar a ponta, por isso a conta mora aqui.
 */
export function ellipsizeMiddle(value: string, max = 44): string {
  const text = typeof value === 'string' ? value : ''
  if (max <= 1) return text ? '…' : ''
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(text.length - tail) : ''}`
}

/** Caminho de um arquivo renomeado escrito por extenso, para tooltip/leitura. */
export function commitFilePathLabel(file: Pick<CommitDiffFile, 'path' | 'oldPath'>): string {
  return file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path
}

/**
 * Corta as linhas de um arquivo no teto de render, sempre em hunks inteiros
 * enquanto der, e diz quantas ficaram de fora. O componente nunca fatia array
 * na mão: assim o "… +N linhas" e o que está na tela não podem divergir.
 */
export function takeCommitDiffLines(
  file: CommitDiffFile,
  limit: number
): { hunks: CommitDiffHunk[]; hidden: number } {
  if (limit <= 0 || file.lineCount <= limit) return { hunks: file.hunks, hidden: 0 }
  const hunks: CommitDiffHunk[] = []
  let used = 0
  for (const hunk of file.hunks) {
    const room = limit - used
    if (room <= 0) break
    if (hunk.lines.length <= room) {
      hunks.push(hunk)
      used += hunk.lines.length
      continue
    }
    hunks.push({ ...hunk, lines: hunk.lines.slice(0, room) })
    used += room
    break
  }
  return { hunks, hidden: file.lineCount - used }
}

/**
 * Quais arquivos nascem ABERTOS no visualizador. O primeiro sempre abre (uma
 * janela que abre vazia não responde à pergunta que o clique fez); os demais
 * abrem enquanto o orçamento de linhas aguentar.
 */
export function commitDiffInitialOpen(
  files: readonly CommitDiffFile[],
  budget = COMMIT_DIFF_OPEN_BUDGET,
  perFile = COMMIT_DIFF_LINES_PER_FILE
): boolean[] {
  let used = 0
  return files.map((file, index) => {
    const cost = Math.min(file.lineCount, perFile)
    if (index === 0) {
      used += cost
      return true
    }
    if (used + cost > budget) return false
    used += cost
    return true
  })
}

// ————— leitura do formato —————

const OCTAL = /^[0-7]{3}$/u

/** Desfaz a citação do git (`core.quotePath`): aspas + escapes C, com os
 *  escapes octais remontados como BYTES antes de virarem texto UTF-8. */
function unquoteGitPath(value: string): string {
  const text = value.trim()
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text
  const body = text.slice(1, -1)
  const out: string[] = []
  const bytes: number[] = []
  const flushBytes = (): void => {
    if (!bytes.length) return
    out.push(new TextDecoder().decode(Uint8Array.from(bytes)))
    bytes.length = 0
  }
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char !== '\\') {
      flushBytes()
      out.push(char)
      continue
    }
    const next = body[index + 1]
    if (next === undefined) break
    const octal = body.slice(index + 1, index + 4)
    if (OCTAL.test(octal)) {
      bytes.push(Number.parseInt(octal, 8))
      index += 3
      continue
    }
    flushBytes()
    index += 1
    if (next === 'n') out.push('\n')
    else if (next === 't') out.push('\t')
    else if (next === 'r') out.push('\r')
    else out.push(next)
  }
  flushBytes()
  return out.join('')
}

/** Tira o `a/`/`b/` que o git põe nos dois lados. `/dev/null` some: ele não é
 *  caminho, é a ausência de um lado. */
function stripSidePrefix(value: string, prefix: 'a' | 'b'): string | undefined {
  const path = unquoteGitPath(value)
  if (!path || path === '/dev/null') return undefined
  return path.startsWith(`${prefix}/`) ? path.slice(2) : path
}

/**
 * Separa os dois caminhos do `diff --git`. O formato é ambíguo por natureza
 * (espaço no nome), e é por isso que a ordem importa: citado primeiro, depois o
 * caso comum de caminho IDÊNTICO dos dois lados (o espaço do meio é o
 * separador), e só então a tentativa frouxa.
 */
function splitGitHeaderPaths(rest: string): { old?: string; next?: string } {
  const quoted = /^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*")$/u.exec(rest)
  if (quoted) return { old: quoted[1], next: quoted[2] }
  if (rest.length % 2 === 1) {
    const half = (rest.length - 1) / 2
    if (rest[half] === ' ' && rest.slice(0, half).slice(2) === rest.slice(half + 1).slice(2)) {
      return { old: rest.slice(0, half), next: rest.slice(half + 1) }
    }
  }
  const loose = /^(.+?)\s+(b\/.+)$/u.exec(rest)
  if (loose) return { old: loose[1], next: loose[2] }
  return { next: rest }
}

interface DraftFile extends CommitDiffFile {
  modeChanged: boolean
  /** O lado `+++` mandou; sem ele o caminho vem do cabeçalho `diff --git`. */
  pathFromBody: boolean
}

function draft(path: string, oldPath?: string): DraftFile {
  return {
    path,
    ...(oldPath && oldPath !== path ? { oldPath } : {}),
    kind: 'modify',
    binary: false,
    insertions: 0,
    deletions: 0,
    hunks: [],
    lineCount: 0,
    modeChanged: false,
    pathFromBody: false
  }
}

const HUNK = /^@@+\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@+(.*)$/u

/**
 * Lê o diff unificado inteiro. Nada de exceção: patch torto, formato de outra
 * era ou pedaço cortado no meio viram o melhor modelo possível + um recado
 * honesto (`truncated`/`unreadable`) — o visualizador nunca fica em branco sem
 * dizer por quê.
 */
export function parseCommitDiff(
  raw: unknown,
  options: { truncated?: boolean } = {}
): CommitDiffSummary {
  const text = typeof raw === 'string' ? raw : ''
  const summary: CommitDiffSummary = {
    files: [],
    insertions: 0,
    deletions: 0,
    hiddenFiles: 0,
    truncated: options.truncated === true,
    unreadable: false
  }
  if (!text.trim()) return summary

  const files: DraftFile[] = []
  let current: DraftFile | null = null
  let hunk: CommitDiffHunk | null = null
  let oldNumber = 0
  let newNumber = 0
  let skippingBinaryPayload = false
  let lines = 0
  let capped = false

  const closeFile = (): void => {
    if (!current) return
    if (!current.hunks.length && !current.binary) {
      if (current.modeChanged && current.kind === 'modify') current.kind = 'mode'
    }
    if (current.binary) current.note = 'arquivo binário — o git não descreve por linha'
    else if (current.kind === 'mode') current.note = 'só a permissão do arquivo mudou'
    else if (!current.hunks.length && current.kind === 'rename') current.note = 'renomeado sem mudar conteúdo'
    else if (!current.hunks.length && !current.note) current.note = 'sem linhas alteradas'
    files.push(current)
    current = null
    hunk = null
  }

  const rows = text.split(/\r?\n/)
  // O patch termina em quebra de linha: sem tirar o vazio final, a última linha
  // de contexto ganharia uma gêmea fantasma e a numeração sairia do lugar.
  if (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()

  for (const line of rows) {
    if (line.startsWith('diff --git ')) {
      closeFile()
      skippingBinaryPayload = false
      if (files.length >= MAX_FILES) {
        summary.hiddenFiles += 1
        continue
      }
      const paths = splitGitHeaderPaths(line.slice('diff --git '.length).trim())
      const next = paths.next ? stripSidePrefix(paths.next, 'b') : undefined
      const before = paths.old ? stripSidePrefix(paths.old, 'a') : undefined
      current = draft(next ?? before ?? '(caminho desconhecido)', before)
      continue
    }
    if (!current) continue
    if (skippingBinaryPayload) continue

    if (hunk) {
      if (lines >= MAX_LINES) {
        capped = true
        hunk = null
        continue
      }
      const marker = line.charAt(0)
      if (marker === '+') {
        hunk.lines.push({ kind: 'add', text: line.slice(1), oldNumber: null, newNumber })
        current.insertions += 1
        newNumber += 1
        lines += 1
        continue
      }
      if (marker === '-') {
        hunk.lines.push({ kind: 'remove', text: line.slice(1), oldNumber, newNumber: null })
        current.deletions += 1
        oldNumber += 1
        lines += 1
        continue
      }
      if (marker === ' ' || line === '') {
        hunk.lines.push({ kind: 'context', text: line.slice(1), oldNumber, newNumber })
        oldNumber += 1
        newNumber += 1
        lines += 1
        continue
      }
      if (marker === '\\') {
        // "\ No newline at end of file" — recado do git, não é linha do arquivo.
        hunk.lines.push({ kind: 'note', text: line.slice(2), oldNumber: null, newNumber: null })
        lines += 1
        continue
      }
      hunk = null
    }

    const header = HUNK.exec(line)
    if (header) {
      if (lines >= MAX_LINES) {
        capped = true
        continue
      }
      oldNumber = Number.parseInt(header[1], 10) || 0
      newNumber = Number.parseInt(header[3], 10) || 0
      const section = header[5]
      hunk = {
        header: line,
        range: line.slice(0, line.length - section.length).trimEnd(),
        section: section.trim(),
        lines: []
      }
      current.hunks.push(hunk)
      continue
    }

    if (line.startsWith('--- ')) {
      const path = stripSidePrefix(line.slice(4), 'a')
      if (path) {
        if (!current.pathFromBody && current.kind !== 'rename' && current.kind !== 'copy') {
          current.oldPath = path === current.path ? undefined : path
        }
      } else current.kind = 'add'
      continue
    }
    if (line.startsWith('+++ ')) {
      const path = stripSidePrefix(line.slice(4), 'b')
      if (path) {
        current.path = path
        current.pathFromBody = true
        if (current.oldPath === path) current.oldPath = undefined
      } else current.kind = 'delete'
      continue
    }
    if (line.startsWith('new file mode')) {
      current.kind = 'add'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      current.kind = 'delete'
      continue
    }
    if (line.startsWith('rename from ')) {
      current.kind = 'rename'
      current.oldPath = unquoteGitPath(line.slice('rename from '.length))
      continue
    }
    if (line.startsWith('rename to ')) {
      current.kind = 'rename'
      current.path = unquoteGitPath(line.slice('rename to '.length))
      current.pathFromBody = true
      continue
    }
    if (line.startsWith('copy from ')) {
      current.kind = 'copy'
      current.oldPath = unquoteGitPath(line.slice('copy from '.length))
      continue
    }
    if (line.startsWith('copy to ')) {
      current.kind = 'copy'
      current.path = unquoteGitPath(line.slice('copy to '.length))
      current.pathFromBody = true
      continue
    }
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) {
      current.modeChanged = true
      continue
    }
    if (line.startsWith('Binary files ') || line.startsWith('Binary file ')) {
      current.binary = true
      continue
    }
    if (line.startsWith('GIT binary patch')) {
      // O payload base85 do `--binary` NUNCA entra na tela: são quilobytes de
      // ruído que só existem para reaplicar o patch, e isto aqui é leitura.
      current.binary = true
      skippingBinaryPayload = true
      continue
    }
  }
  closeFile()

  const visible = files.slice(0, MAX_FILES)
  summary.hiddenFiles += files.length - visible.length
  // Constrói o público explicitamente: os dois campos de rascunho (`modeChanged`
  // e `pathFromBody`) são andaime da leitura e não atravessam a fronteira.
  summary.files = visible.map((file) => ({
    path: file.path,
    ...(file.oldPath && file.oldPath !== file.path ? { oldPath: file.oldPath } : {}),
    kind: file.kind,
    binary: file.binary,
    insertions: file.insertions,
    deletions: file.deletions,
    hunks: file.hunks,
    lineCount: file.hunks.reduce((total, item) => total + item.lines.length, 0),
    ...(file.note ? { note: file.note } : {})
  }))
  summary.insertions = summary.files.reduce((total, file) => total + file.insertions, 0)
  summary.deletions = summary.files.reduce((total, file) => total + file.deletions, 0)
  if (capped || summary.hiddenFiles > 0) summary.truncated = true
  summary.unreadable = summary.files.length === 0
  return summary
}
