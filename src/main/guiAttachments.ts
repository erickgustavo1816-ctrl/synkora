/**
 * ANEXOS DO COMPOSER GUI (Synkora 2.0 — docs/GUI_PANE_CONTRACT.md).
 *
 * O composer do chat precisa aceitar print colado e arquivo solto, como a GUI
 * de referência. A casa é a MESMA do mundo dos panes TUI:
 * `<cwd>/.synkora/attachments` — só que o cwd aqui é o do PANE (worktree da
 * missão / raiz do projeto no planejamento), resolvido pelo registro de
 * sessões, nunca escolhido pelo renderer. O caminho absoluto existe somente
 * no main e entra no prompt depois de resolver uma capacidade opaca.
 *
 * Este módulo é PURO de propósito (nada de electron, nada de disco): são as
 * três decisões que precisam de teste — nome seguro, caminho único e o teto de
 * tamanho. A escrita em si mora no ipc/gui.ts, onde já existem clipboard e fs.
 */
import { basename, extname, join } from 'node:path'

/** Teto por anexo. Acima disso o composer recusa ANTES de alocar o buffer —
 *  base64 de 10MB já são ~13MB de string vindos pelo IPC. */
export const GUI_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
/** Uma mensagem do composer não pode virar uma árvore de arquivos disfarçada. */
export const GUI_ATTACHMENT_MAX_FILES = 20
export const GUI_ATTACHMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024
/** Limite bruto antes do clone/decoder. O pequeno extra cobre o cabeçalho de
 * data URL; caracteres inválidos não podem “sumir” da medição. */
export const GUI_ATTACHMENT_MAX_BASE64_CHARS = Math.ceil(GUI_ATTACHMENT_MAX_BYTES / 3) * 4
const GUI_ATTACHMENT_DATA_URL_PREFIX_MAX_CHARS = 256
/** Uma imagem comprimida pequena ainda pode explodir em centenas de MB ao
 * decodificar. A prévia só nasce para formatos com dimensões inspecionáveis e
 * dentro deste orçamento. */
export const GUI_ATTACHMENT_IMAGE_MAX_DIMENSION = 12_000
export const GUI_ATTACHMENT_IMAGE_MAX_PIXELS = 16_000_000
export const GUI_ATTACHMENT_PREVIEW_MAX_BYTES = 4 * 1024 * 1024
export const GUI_ATTACHMENT_PREVIEW_MAX_DATA_URL_CHARS =
  Math.ceil(GUI_ATTACHMENT_PREVIEW_MAX_BYTES / 3) * 4 + 64

/** O que o renderer manda: print da área de transferência (o main lê o
 *  clipboard nativo) ou arquivo escolhido/solto, já em base64. Pasta é
 *  escolhida pelo diálogo nativo do main e não carrega um caminho do renderer.
 */
export type GuiAttachPayload =
  | { kind: 'clipboard-image' }
  | { kind: 'file'; name: string; bytesBase64: string }
  | { kind: 'folder' }

export type GuiAttachmentKind = 'file' | 'image' | 'folder'

/** Metadados duráveis do anexo. `capability` é um identificador opaco emitido
 * pelo main; renderer/localStorage nunca recebem o caminho físico nem
 * autoridade de disco. */
export interface GuiAttachmentDescriptor {
  id: string
  capability: string
  kind: GuiAttachmentKind
  name: string
  /** MIME calculado pelo main a partir de assinatura/extensão controlada. */
  mime: string | null
  /** Arquivos carregam o tamanho real; pasta é apenas referência. */
  size: number | null
}

/** Forma exclusivamente interna, produzida depois de resolver a capacidade e
 * revalidar o alvo físico. Nunca atravessa preload, transcript ou renderer. */
export interface GuiResolvedAttachment extends GuiAttachmentDescriptor {
  path: string
  /** Fotografia já limitada e tipada pela revalidação. Nunca serializada. */
  bytes?: Uint8Array
}

/** Resposta do `gui:attach`; `error` é texto de UI PT-BR. */
export interface GuiAttachResult {
  ok: boolean
  attachment?: GuiAttachmentDescriptor
  /** O dono fechou o diálogo nativo sem escolher um alvo. */
  cancelled?: boolean
  error?: string
}

export type GuiAttachmentPreviewPurpose = 'thumbnail' | 'lightbox'

export type GuiAttachmentPreviewResult =
  | {
      ok: true
      /** Sempre PNG reserializado pelo main; nunca `file://`. */
      dataUrl: string
      mime: 'image/png'
      width: number
      height: number
    }
  | { ok: false; error: string }

export type GuiAttachmentAction = 'open' | 'download'

export type GuiAttachmentActionResult =
  | { ok: true }
  | { ok: false; cancelled?: boolean; error?: string }

const ATTACHMENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/u
export const GUI_ATTACHMENT_CAPABILITY_RE = /^gui-cap-v1-[A-Za-z0-9_-]{43}$/u
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,127}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/u
const SAFE_PREVIEW_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp'
])

export function guiAttachmentKindForName(name: string): 'file' | 'image' {
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase()) ? 'image' : 'file'
}

/** Só verifica formato; existência/containment/symlink ficam na camada que
 * conhece o cwd do pane. Não inclua o valor bruto no erro: ele pode ser path
 * local ou nome de pessoa. */
export function guiAttachmentDescriptorProblem(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'anexo em formato inválido'
  const candidate = value as Partial<GuiAttachmentDescriptor>
  const allowedKeys = new Set(['id', 'capability', 'kind', 'name', 'mime', 'size'])
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    return 'anexo com campos desconhecidos'
  }
  if (typeof candidate.id !== 'string' || !ATTACHMENT_ID_RE.test(candidate.id))
    return 'anexo sem identificador válido'
  if (
    typeof candidate.capability !== 'string' ||
    !GUI_ATTACHMENT_CAPABILITY_RE.test(candidate.capability)
  )
    return 'anexo sem autorização válida'
  if (candidate.kind !== 'file' && candidate.kind !== 'image' && candidate.kind !== 'folder')
    return 'tipo de anexo desconhecido'
  if (
    typeof candidate.name !== 'string' ||
    !candidate.name.trim() ||
    candidate.name.length > 120 ||
    candidate.name !== safeAttachmentName(candidate.name)
  )
    return 'anexo sem nome válido'
  if (candidate.kind === 'folder') {
    if (candidate.size !== null) return 'pasta com tamanho inválido'
    if (candidate.mime !== null) return 'pasta com MIME inválido'
    return undefined
  }
  if (typeof candidate.mime !== 'string' || !MIME_RE.test(candidate.mime)) {
    return 'anexo com MIME inválido'
  }
  if (candidate.kind === 'image' && !SAFE_PREVIEW_MIMES.has(candidate.mime)) {
    return 'imagem sem MIME seguro para prévia'
  }
  if (
    typeof candidate.size !== 'number' ||
    !Number.isSafeInteger(candidate.size) ||
    candidate.size < 0 ||
    candidate.size > GUI_ATTACHMENT_MAX_BYTES
  )
    return 'anexo com tamanho inválido'
  return undefined
}

export function isGuiAttachmentDescriptor(value: unknown): value is GuiAttachmentDescriptor {
  return guiAttachmentDescriptorProblem(value) === undefined
}

/** Cria o retrato que atravessa renderer, fila e transcript a partir do alvo
 * físico já validado pelo main. */
export function makeGuiAttachmentDescriptor(
  id: string,
  capability: string,
  kind: GuiAttachmentKind,
  path: string,
  size: number | null,
  mime: string | null
): GuiAttachmentDescriptor {
  return {
    id,
    capability,
    kind,
    name: kind === 'folder' && !basename(path) ? 'pasta' : safeAttachmentName(basename(path)),
    mime,
    size
  }
}

/** O CLI recebe referências inequívocas, mas a bolha do usuário conserva só o
 * texto humano e mostra seus chips a partir do evento estruturado. */
export function withGuiAttachmentReferences(
  text: string,
  attachments: readonly GuiResolvedAttachment[]
): string {
  if (attachments.length === 0) return text
  const references = attachments
    .map((attachment) => {
      const label = attachment.kind === 'folder' ? 'Pasta' : 'Arquivo'
      return `- ${label}: ${attachment.path}`
    })
    .join('\n')
  const separator = text.length > 0 && !text.endsWith('\n') ? '\n\n' : '\n'
  return `${text}${separator}[Anexos desta mensagem — use os caminhos físicos abaixo]\n${references}\n[/Anexos]`
}

export interface GuiSafeImageInfo {
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  width: number
  height: number
}

function byteAt(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? -1
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset < 0 || offset + value.length > bytes.length) return false
  for (let index = 0; index < value.length; index += 1) {
    if (byteAt(bytes, offset + index) !== value.charCodeAt(index)) return false
  }
  return true
}

function u16le(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8)
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (byteAt(bytes, offset) << 8) | byteAt(bytes, offset + 1)
}

function u24le(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8) | (byteAt(bytes, offset + 2) << 16)
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    byteAt(bytes, offset) * 0x1000000 +
    byteAt(bytes, offset + 1) * 0x10000 +
    byteAt(bytes, offset + 2) * 0x100 +
    byteAt(bytes, offset + 3)
  )
}

function boundedImageInfo(
  mime: GuiSafeImageInfo['mime'],
  width: number,
  height: number
): GuiSafeImageInfo | undefined {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > GUI_ATTACHMENT_IMAGE_MAX_DIMENSION ||
    height > GUI_ATTACHMENT_IMAGE_MAX_DIMENSION ||
    width * height > GUI_ATTACHMENT_IMAGE_MAX_PIXELS
  ) {
    return undefined
  }
  return { mime, width, height }
}

function jpegInfo(bytes: Uint8Array): GuiSafeImageInfo | undefined {
  if (bytes.length < 4 || byteAt(bytes, 0) !== 0xff || byteAt(bytes, 1) !== 0xd8) return undefined
  const startOfFrame = new Set([
    0xc0,
    0xc1,
    0xc2,
    0xc3,
    0xc5,
    0xc6,
    0xc7,
    0xc9,
    0xca,
    0xcb,
    0xcd,
    0xce,
    0xcf
  ])
  let offset = 2
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && byteAt(bytes, offset) !== 0xff) offset += 1
    while (offset < bytes.length && byteAt(bytes, offset) === 0xff) offset += 1
    if (offset >= bytes.length) return undefined
    const marker = byteAt(bytes, offset)
    offset += 1
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue
    if (offset + 1 >= bytes.length) return undefined
    const segmentLength = u16be(bytes, offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return undefined
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7) return undefined
      return boundedImageInfo('image/jpeg', u16be(bytes, offset + 5), u16be(bytes, offset + 3))
    }
    offset += segmentLength
  }
  return undefined
}

/** Reconhece somente bitmaps cujo tamanho pode ser provado antes do decoder.
 * SVG/HTML nunca entram aqui: a prévia é sempre um PNG reserializado. */
export function guiSafeImageInfo(bytes: Uint8Array): GuiSafeImageInfo | undefined {
  if (
    bytes.length >= 24 &&
    byteAt(bytes, 0) === 0x89 &&
    asciiAt(bytes, 1, 'PNG\r\n\u001a\n') &&
    asciiAt(bytes, 12, 'IHDR')
  ) {
    return boundedImageInfo('image/png', u32be(bytes, 16), u32be(bytes, 20))
  }
  if (bytes.length >= 10 && (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a'))) {
    return boundedImageInfo('image/gif', u16le(bytes, 6), u16le(bytes, 8))
  }
  const jpeg = jpegInfo(bytes)
  if (jpeg) return jpeg
  if (bytes.length >= 30 && asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) {
    if (asciiAt(bytes, 12, 'VP8X')) {
      return boundedImageInfo('image/webp', u24le(bytes, 24) + 1, u24le(bytes, 27) + 1)
    }
    if (asciiAt(bytes, 12, 'VP8 ') && asciiAt(bytes, 23, '\u009d\u0001*')) {
      return boundedImageInfo(
        'image/webp',
        u16le(bytes, 26) & 0x3fff,
        u16le(bytes, 28) & 0x3fff
      )
    }
    if (asciiAt(bytes, 12, 'VP8L') && byteAt(bytes, 20) === 0x2f) {
      const b1 = byteAt(bytes, 21)
      const b2 = byteAt(bytes, 22)
      const b3 = byteAt(bytes, 23)
      const b4 = byteAt(bytes, 24)
      return boundedImageInfo(
        'image/webp',
        1 + ((b1 | (b2 << 8)) & 0x3fff),
        1 + (((b2 >> 6) | (b3 << 2) | (b4 << 10)) & 0x3fff)
      )
    }
  }
  return undefined
}

const TEXT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.css': 'text/plain',
  '.csv': 'text/csv',
  '.go': 'text/plain',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.py': 'text/plain',
  '.rs': 'text/plain',
  '.rtf': 'application/rtf',
  '.toml': 'text/plain',
  '.ts': 'text/plain',
  '.tsx': 'text/plain',
  '.txt': 'text/plain',
  '.xml': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain'
}

const ZIP_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip'
}

const OLE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.doc': 'application/msword',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.xls': 'application/vnd.ms-excel',
}

function bytesStartWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => byteAt(bytes, index) === value)
}

function safeText(bytes: Uint8Array): boolean {
  if (bytes.some((value) => value === 0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

export function guiAttachmentMediaType(
  name: string,
  bytes: Uint8Array
): { kind: 'file' | 'image'; mime: string } {
  const image = guiSafeImageInfo(bytes)
  if (image) return { kind: 'image', mime: image.mime }
  const extension = extname(name).toLowerCase()
  const textMime = TEXT_MIME_BY_EXTENSION[extension]
  if (textMime && safeText(bytes)) return { kind: 'file', mime: textMime }
  if (extension === '.pdf' && asciiAt(bytes, 0, '%PDF-')) {
    return { kind: 'file', mime: 'application/pdf' }
  }
  const zipMime = ZIP_MIME_BY_EXTENSION[extension]
  if (
    zipMime &&
    (bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
      bytesStartWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
      bytesStartWith(bytes, [0x50, 0x4b, 0x07, 0x08]))
  ) {
    return { kind: 'file', mime: zipMime }
  }
  const oleMime = OLE_MIME_BY_EXTENSION[extension]
  if (oleMime && bytesStartWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return { kind: 'file', mime: oleMime }
  }
  return {
    kind: 'file',
    mime: 'application/octet-stream'
  }
}

const UNSAFE_OPEN_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.cpl',
  '.exe',
  '.hta',
  '.htm',
  '.html',
  '.jar',
  '.js',
  '.lnk',
  '.mjs',
  '.msi',
  '.ps1',
  '.reg',
  '.scr',
  '.svg',
  '.url',
  '.vbs'
])

/** Abrir usa o aplicativo associado do SO; binário, atalho e conteúdo ativo
 * ficam apenas com a ação explícita de baixar uma cópia. */
export function guiAttachmentOpenProblem(name: string, mime: string): string | undefined {
  if (UNSAFE_OPEN_EXTENSIONS.has(extname(name).toLowerCase()) || mime === 'application/octet-stream') {
    return 'este tipo de arquivo só pode ser baixado como cópia'
  }
  return undefined
}

/** Nomes que o Windows trata como DISPOSITIVO em qualquer pasta e com
 *  qualquer extensão — gravar em `nul.png` não cria arquivo nenhum. */
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** Caracteres proibidos em nome de arquivo no Windows (e separadores de path,
 *  que é como um nome vindo do renderer viraria travessia de diretório). Os de
 *  controle entram na classe de propósito: nome com quebra de linha rabiscaria
 *  log e path. */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g

/** Teto de nome: o path completo do Windows tem limite e o worktree já come
 *  boa parte dele. Corta o MIOLO, preservando a extensão. */
const MAX_NAME_LENGTH = 120

/**
 * Nome de arquivo seguro a partir do que o renderer mandou. Tira diretório
 * (`../` e `C:\…` viram só o último segmento), caracteres ilegais, pontos e
 * espaços de sobra nas pontas, e nunca devolve string vazia.
 */
export function safeAttachmentName(raw: string): string {
  const lastSeparator = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  const base = lastSeparator >= 0 ? raw.slice(lastSeparator + 1) : raw
  let name = base.replace(ILLEGAL_NAME_CHARS, '-').replace(/^[.\s]+|[.\s]+$/g, '')
  if (!name) return 'anexo'

  const ext = extname(name)
  let stem = ext ? name.slice(0, name.length - ext.length) : name
  if (!stem) {
    // arquivo que é SÓ extensão (".env"): o ponto vira parte do nome
    stem = ext.replace(/^\./, '')
    return stem ? stem.slice(0, MAX_NAME_LENGTH) : 'anexo'
  }
  if (RESERVED_WINDOWS_NAMES.test(stem)) stem = `${stem}-anexo`
  const room = Math.max(1, MAX_NAME_LENGTH - ext.length)
  return `${stem.slice(0, room)}${ext}`
}

/**
 * Caminho livre dentro de `dir`. Anexo NUNCA sobrescreve anexo: colisão de
 * nome ganha sufixo `-1`, `-2`… (diferente do drag&drop dos panes TUI, que
 * dedupa por tamanho — ali a origem é um arquivo existente, aqui os bytes
 * chegam do renderer e "mesmo nome" não prova "mesmo conteúdo").
 * `exists` é injetado: é o que mantém a função pura e testável.
 */
export function uniqueAttachmentPath(
  dir: string,
  rawName: string,
  exists: (path: string) => boolean
): string {
  const name = safeAttachmentName(rawName)
  const first = join(dir, name)
  if (!exists(first)) return first

  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 1; n <= 9999; n += 1) {
    const candidate = join(dir, `${stem}-${n}${ext}`)
    if (!exists(candidate)) return candidate
  }
  // 10 mil homônimos na mesma pasta: o carimbo de tempo encerra o assunto.
  return join(dir, `${stem}-${Date.now()}${ext}`)
}

/** Data URL (`data:image/png;base64,…`) é erro comum de quem monta o payload
 *  no renderer — o prefixo cai aqui em vez de virar bytes corrompidos. */
export function stripDataUrlPrefix(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.toLowerCase().startsWith('data:')) return trimmed
  const comma = trimmed.indexOf(',')
  if (comma < 0 || comma > GUI_ATTACHMENT_DATA_URL_PREFIX_MAX_CHARS) return trimmed
  return /;base64$/iu.test(trimmed.slice(0, comma)) ? trimmed.slice(comma + 1).trim() : trimmed
}

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u

/** Validação fechada antes de qualquer `Buffer.from`: limita a string crua e
 * recusa caracteres/padding que o decoder permissivo do Node ignoraria. */
export function attachmentBase64Problem(value: string): string | undefined {
  if (
    value.length >
    GUI_ATTACHMENT_MAX_BASE64_CHARS + GUI_ATTACHMENT_DATA_URL_PREFIX_MAX_CHARS
  ) {
    return `anexo codificado grande demais (o limite é ${formatBytes(
      GUI_ATTACHMENT_MAX_BYTES
    )} por arquivo)`
  }
  const body = stripDataUrlPrefix(value)
  if (!body) return 'anexo sem conteúdo'
  if (body.length > GUI_ATTACHMENT_MAX_BASE64_CHARS) {
    return `anexo codificado grande demais (o limite é ${formatBytes(
      GUI_ATTACHMENT_MAX_BYTES
    )} por arquivo)`
  }
  if (body.length % 4 !== 0 || !STRICT_BASE64.test(body)) {
    return 'anexo em formato base64 inválido'
  }
  const bytes = base64ByteLength(body)
  return bytes > GUI_ATTACHMENT_MAX_BYTES ? attachmentTooLargeError(bytes) : undefined
}

/**
 * Tamanho REAL do conteúdo de um base64, sem alocar o buffer — é o pré-cheque
 * que impede o teto de ser pago em memória antes de ser verificado.
 */
export function base64ByteLength(value: string): number {
  const clean = value.replace(/[^A-Za-z0-9+/=]/g, '')
  if (!clean) return 0
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

/** Tamanho legível em PT-BR (vírgula decimal), para a mensagem do teto. */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1).replace('.', ',')} MB`
  const kb = Math.max(1, Math.round(bytes / 1024))
  return `${kb} KB`
}

/** Recusa do teto, em texto de UI. */
export function attachmentTooLargeError(bytes: number): string {
  return `anexo grande demais: ${formatBytes(bytes)} (o limite é ${formatBytes(
    GUI_ATTACHMENT_MAX_BYTES
  )} por arquivo)`
}

/** O payload chegou íntegro? Guarda de borda do canal — o renderer é nosso,
 *  mas um payload torto nunca pode virar exceção dentro do handler. */
export function attachPayloadProblem(payload: GuiAttachPayload | undefined): string | undefined {
  if (!payload || typeof payload !== 'object') return 'anexo sem conteúdo'
  // Leitura ALARGADA de propósito: o tipo diz que só existem dois formatos, e
  // é exatamente por isso que a checagem precisa olhar o valor cru — do outro
  // lado do IPC não há tipo nenhum garantindo o que chegou.
  const { kind, name, bytesBase64, path } = payload as {
    kind?: unknown
    name?: unknown
    bytesBase64?: unknown
    path?: unknown
  }
  if (kind === 'clipboard-image') return undefined
  // A pasta é tratada por `gui:attachFolder`, que abre o diálogo nativo no
  // main. Um path recebido aqui seria autoridade indevida do renderer.
  if (kind === 'folder') return 'pasta deve ser escolhida pelo diálogo do sistema'
  if (kind !== 'file') return 'tipo de anexo desconhecido'
  if (typeof name !== 'string' || !name.trim()) return 'anexo sem nome'
  if (typeof bytesBase64 !== 'string' || !bytesBase64.trim()) return 'anexo sem conteúdo'
  return attachmentBase64Problem(bytesBase64)
}
