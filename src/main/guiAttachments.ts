/**
 * ANEXOS DO COMPOSER GUI (Synkora 2.0 — docs/GUI_PANE_CONTRACT.md).
 *
 * O composer do chat precisa aceitar print colado e arquivo solto, como a GUI
 * de referência. A casa é a MESMA do mundo dos panes TUI:
 * `<cwd>/.synkora/attachments` — só que o cwd aqui é o do PANE (worktree da
 * missão / raiz do projeto no planejamento), resolvido pelo registro de
 * sessões, nunca escolhido pelo renderer. O que volta é o caminho ABSOLUTO,
 * porque quem lê a imagem é o agente, pelo caminho, dentro do prompt.
 *
 * Este módulo é PURO de propósito (nada de electron, nada de disco): são as
 * três decisões que precisam de teste — nome seguro, caminho único e o teto de
 * tamanho. A escrita em si mora no ipc/gui.ts, onde já existem clipboard e fs.
 */
import { basename, extname, isAbsolute, join } from 'node:path'

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

/** O que o renderer manda: print da área de transferência (o main lê o
 *  clipboard nativo) ou arquivo escolhido/solto, já em base64. Pasta é
 *  escolhida pelo diálogo nativo do main e não carrega um caminho do renderer.
 */
export type GuiAttachPayload =
  | { kind: 'clipboard-image' }
  | { kind: 'file'; name: string; bytesBase64: string }
  | { kind: 'folder' }

export type GuiAttachmentKind = 'file' | 'image' | 'folder'

/** Metadados duráveis do anexo. O `path` só vem do main e é revalidado no
 * momento do envio; renderer/localStorage jamais recebem autoridade de disco. */
export interface GuiAttachmentDescriptor {
  id: string
  kind: GuiAttachmentKind
  name: string
  path: string
  /** Arquivos carregam o tamanho real; pasta é apenas referência. */
  size: number | null
}

/** Resposta do `gui:attach`. `path` é ABSOLUTO; `error` é texto de UI PT-BR. */
export interface GuiAttachResult {
  ok: boolean
  attachment?: GuiAttachmentDescriptor
  /** Compatibilidade para renderers antigos enquanto o descritor é adotado. */
  path?: string
  /** O dono fechou o diálogo nativo sem escolher um alvo. */
  cancelled?: boolean
  error?: string
}

const ATTACHMENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/u
const IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
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
  if (typeof candidate.id !== 'string' || !ATTACHMENT_ID_RE.test(candidate.id))
    return 'anexo sem identificador válido'
  if (candidate.kind !== 'file' && candidate.kind !== 'image' && candidate.kind !== 'folder')
    return 'tipo de anexo desconhecido'
  if (
    typeof candidate.name !== 'string' ||
    !candidate.name.trim() ||
    candidate.name.length > 120 ||
    /[\u0000-\u001f\r\n]/u.test(candidate.name)
  )
    return 'anexo sem nome válido'
  if (
    typeof candidate.path !== 'string' ||
    !candidate.path ||
    candidate.path.length > 32_767 ||
    !isAbsolute(candidate.path)
  )
    return 'anexo sem caminho válido'
  if (candidate.kind === 'folder') {
    if (candidate.size !== null) return 'pasta com tamanho inválido'
    return undefined
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
  kind: GuiAttachmentKind,
  path: string,
  size: number | null
): GuiAttachmentDescriptor {
  return {
    id,
    kind,
    name: safeAttachmentName(basename(path)),
    path,
    size
  }
}

/** O CLI recebe referências inequívocas, mas a bolha do usuário conserva só o
 * texto humano e mostra seus chips a partir do evento estruturado. */
export function withGuiAttachmentReferences(
  text: string,
  attachments: readonly GuiAttachmentDescriptor[]
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
  if (kind !== 'file') return `tipo de anexo desconhecido: ${String(kind)}`
  if (typeof name !== 'string' || !name.trim()) return 'anexo sem nome'
  if (typeof bytesBase64 !== 'string' || !bytesBase64.trim()) return 'anexo sem conteúdo'
  return attachmentBase64Problem(bytesBase64)
}
