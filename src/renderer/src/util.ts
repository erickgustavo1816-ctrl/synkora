// Matiz estável por texto (mesmo nome → mesma cor), usada em avatares e seats.
export function hueOf(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360
  return h
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/)
  return ((words[0]?.[0] ?? '') + (words[1]?.[0] ?? '')).toUpperCase()
}

/** O nome da pasta (o fim do caminho) — é ele que o dono reconhece. */
export function folderName(path: string): string {
  return path.split(/[\\/]+/u).filter(Boolean).pop() ?? ''
}

/** A recusa do main sem o embrulho do Electron ("Error invoking remote
 *  method '<canal>': Error: <msg>") — a frase PT-BR é do main e é ela que o
 *  dono precisa ler. */
export function plainIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u, '').trim() || raw
}
