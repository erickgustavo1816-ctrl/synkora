export interface GuiFileToken {
  start: number
  length: number
  value: string
}

const GUI_FILE_TOKEN_MAX_CHARS = 512
const GUI_FILE_TOKEN_MAX_RESULTS = 64

/** Extensões suficientemente específicas para transformar um nome SOLTO em
 * controle. Com barra/raiz explícita, qualquer sufixo alfabético é aceito.
 * Isso evita transformar versões, domínios e endereços de e-mail em arquivos.
 *
 * R36 (entrega visual no chat): a lista foi conferida contra o que o dev
 * ENTREGA para o dono ver — `html`/`htm` (a "versão HTML" que abre fora do app)
 * e as imagens (`png`, `jpg`, `jpeg`, `gif`, `webp`, `svg`, `avif`, `bmp`,
 * `ico`). Só `htm` faltava; o resto já estava aqui. Extensão de entrega que não
 * vira token é entrega que o dono não consegue abrir com um clique. */
const BARE_FILE_EXTENSIONS = new Set([
  'astro', 'avif', 'bmp', 'c', 'cc', 'conf', 'cpp', 'cs', 'css', 'csv', 'diff',
  'gif', 'go', 'gql', 'graphql', 'h', 'hpp', 'htm', 'html', 'ico', 'ini', 'java',
  'jpeg', 'jpg', 'json', 'jsonc', 'jsx', 'kt', 'kts', 'less', 'lock', 'log',
  'lua', 'md', 'mdx', 'mjs', 'mts', 'pdf', 'php', 'png', 'prisma', 'proto', 'py',
  'rb', 'rs', 'scss', 'sql', 'svelte', 'svg', 'swift', 'toml', 'ts', 'tsx',
  'txt', 'vue', 'webp', 'xml', 'yaml', 'yml'
])

const KNOWN_EXTENSIONLESS = new Set([
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  'changelog',
  'dockerfile',
  'gemfile',
  'license',
  'makefile',
  'notice',
  'procfile',
  'rakefile',
  'readme',
  'vagrantfile'
])

// O regex só encontra unidades sem espaços. Caminhos com espaços continuam
// suportados pelo resolver quando o markdown os entrega num `code` inline: o
// chamador testa o conteúdo inteiro desse nó antes deste scanner geral.
const RAW_TOKEN =
  /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)?(?:[\p{L}\p{N}_@+~().-]+[\\/])*[\p{L}\p{N}_@+~().-]+/gu

const URL_RANGE = /\b(?:https?|file):\/\/[^\s<>()]+/giu

function trimCandidate(raw: string): { value: string; offset: number } {
  let start = 0
  let end = raw.length
  while (start < end && /[([{]/u.test(raw[start] ?? '')) start += 1
  while (end > start && /[.,;:!?\])}]/u.test(raw[end - 1] ?? '')) end -= 1
  return { value: raw.slice(start, end), offset: start }
}

function extensionOf(value: string): string | null {
  const name = value.replace(/\\/g, '/').split('/').at(-1) ?? ''
  const match = /\.([A-Za-z][A-Za-z0-9_-]{0,15})$/u.exec(name)
  return match?.[1]?.toLocaleLowerCase('en-US') ?? null
}

function looksLikeFileReference(value: string): boolean {
  if (!value || value.length > GUI_FILE_TOKEN_MAX_CHARS || value.includes('\0')) return false
  if (/\s/u.test(value) || value.endsWith('/') || value.endsWith('\\')) return false
  const normalized = value.replace(/\\/g, '/')
  const name = normalized.split('/').at(-1)?.toLocaleLowerCase('en-US') ?? ''
  const hasPath =
    normalized.includes('/') || /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith('/')
  const extension = extensionOf(value)

  if (!hasPath) {
    if (value.includes('@')) return false
    return KNOWN_EXTENSIONLESS.has(name) || Boolean(extension && BARE_FILE_EXTENSIONS.has(extension))
  }
  return KNOWN_EXTENSIONLESS.has(name) || extension !== null
}

function overlaps(start: number, end: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => start < range.end && end > range.start)
}

/** Reconhece somente tokens com forma de arquivo. Existência, contenção,
 * links e extensão executável continuam sendo decisões exclusivas do main. */
export function findGuiFileTokens(text: string): GuiFileToken[] {
  if (!text) return []
  const source = text.slice(0, 64 * 1024)
  const urlRanges: Array<{ start: number; end: number }> = []
  let url: RegExpExecArray | null
  URL_RANGE.lastIndex = 0
  while ((url = URL_RANGE.exec(source))) {
    urlRanges.push({ start: url.index, end: url.index + url[0].length })
  }

  const tokens: GuiFileToken[] = []
  let match: RegExpExecArray | null
  RAW_TOKEN.lastIndex = 0
  while ((match = RAW_TOKEN.exec(source)) && tokens.length < GUI_FILE_TOKEN_MAX_RESULTS) {
    const trimmed = trimCandidate(match[0])
    if (!trimmed.value) continue
    const start = match.index + trimmed.offset
    const end = start + trimmed.value.length
    if (overlaps(start, end, urlRanges)) continue

    const before = source[start - 1]
    const after = source[end]
    if (before && /[\p{L}\p{N}_@]/u.test(before)) continue
    if (after && /[\p{L}\p{N}_@]/u.test(after)) continue
    if (!looksLikeFileReference(trimmed.value)) continue

    tokens.push({ start, length: trimmed.value.length, value: trimmed.value })
  }
  return tokens
}

/** Conteúdo de `code` inline já perdeu as crases. Aceitamos espaço somente se
 * o nó inteiro é um único caminho reconhecível; texto de código maior não vira
 * um botão acidental. */
export function guiInlineCodeFileToken(text: string): string | null {
  const value = text.trim()
  if (!value || value.length > GUI_FILE_TOKEN_MAX_CHARS || /[\r\n]/u.test(value)) return null
  if (!/\s/u.test(value)) {
    const found = findGuiFileTokens(value)
    return found.length === 1 && found[0].start === 0 && found[0].length === value.length
      ? value
      : null
  }
  const normalized = value.replace(/\\/g, '/')
  if (!normalized.includes('/') || !extensionOf(value)) return null
  if (/^(?:https?|file):\/\//iu.test(value)) return null
  return value
}
