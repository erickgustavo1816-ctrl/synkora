import { StringDecoder } from 'string_decoder'

export type GuiProtocolLine<T> =
  | { ok: true; value: T }
  | { ok: false }

export const GUI_PROTOCOL_LINE_MAX_CHARS = 16 * 1024 * 1024

export interface GuiProtocolChunk {
  lines: string[]
  overflow: boolean
}

/** Decodifica UTF-8 e acumula fragmentos sem recopiar uma linha crescente a
 * cada chunk. A linha longa é juntada uma única vez, quando termina. */
export class GuiProtocolStream {
  private readonly decoder = new StringDecoder('utf8')
  private readonly maxChars: number
  private parts: string[] = []
  private chars = 0

  constructor(maxChars = GUI_PROTOCOL_LINE_MAX_CHARS) {
    this.maxChars = maxChars
  }

  push(chunk: Buffer): GuiProtocolChunk {
    return this.consume(this.decoder.write(chunk), false)
  }

  end(): GuiProtocolChunk {
    return this.consume(this.decoder.end(), true)
  }

  private consume(decoded: string, flush: boolean): GuiProtocolChunk {
    const lines: string[] = []
    let cursor = 0
    const append = (part: string): boolean => {
      if (this.chars + part.length > this.maxChars) {
        this.parts = []
        this.chars = 0
        return false
      }
      if (part) this.parts.push(part)
      this.chars += part.length
      return true
    }

    while (cursor < decoded.length) {
      const newline = decoded.indexOf('\n', cursor)
      if (newline < 0) break
      if (!append(decoded.slice(cursor, newline))) return { lines, overflow: true }
      lines.push(this.parts.join(''))
      this.parts = []
      this.chars = 0
      cursor = newline + 1
    }
    if (!append(decoded.slice(cursor))) return { lines, overflow: true }
    if (flush && this.chars > 0) {
      lines.push(this.parts.join(''))
      this.parts = []
      this.chars = 0
    }
    return { lines, overflow: false }
  }
}

/** JSONL de CLI é uma fronteira de protocolo: linha não vazia e inválida não
 * pode ser ignorada, porque o renderer ficaria esperando um terminal eterno. */
export function parseGuiProtocolLine<T>(line: string): GuiProtocolLine<T> {
  if (line.length > GUI_PROTOCOL_LINE_MAX_CHARS) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(line) as T }
  } catch {
    return { ok: false }
  }
}

function guiProtocolRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function isGuiClaudeProtocolEnvelope(value: unknown): boolean {
  const record = guiProtocolRecord(value)
  return Boolean(record && typeof record['type'] === 'string' && record['type'])
}

export function isGuiCodexProtocolEnvelope(value: unknown): boolean {
  const record = guiProtocolRecord(value)
  if (!record) return false
  if (typeof record['method'] === 'string' && record['method']) return true
  return typeof record['id'] === 'number' || typeof record['id'] === 'string'
}
