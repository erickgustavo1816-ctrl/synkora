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
import { extname, join } from 'node:path'

/** Teto por anexo. Acima disso o composer recusa ANTES de alocar o buffer —
 *  base64 de 10MB já são ~13MB de string vindos pelo IPC. */
export const GUI_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

/** O que o renderer manda: print da área de transferência (o main lê o
 *  clipboard nativo) ou arquivo escolhido/solto, já em base64. */
export type GuiAttachPayload =
  | { kind: 'clipboard-image' }
  | { kind: 'file'; name: string; bytesBase64: string }

/** Resposta do `gui:attach`. `path` é ABSOLUTO; `error` é texto de UI PT-BR. */
export interface GuiAttachResult {
  ok: boolean
  path?: string
  error?: string
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
  const match = /^data:[^;,]*;base64,/i.exec(value)
  return (match ? value.slice(match[0].length) : value).trim()
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
  const { kind, name, bytesBase64 } = payload as {
    kind?: unknown
    name?: unknown
    bytesBase64?: unknown
  }
  if (kind === 'clipboard-image') return undefined
  if (kind !== 'file') return `tipo de anexo desconhecido: ${String(kind)}`
  if (typeof name !== 'string' || !name.trim()) return 'anexo sem nome'
  if (typeof bytesBase64 !== 'string' || !bytesBase64.trim()) return 'anexo sem conteúdo'
  return undefined
}
