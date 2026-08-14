export const GUI_COMPOSER_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const GUI_COMPOSER_ATTACHMENT_MAX_FILES = 20
export const GUI_COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024

export function guiAttachmentSizeProblem(
  name: string,
  size: number,
  maxBytes = GUI_COMPOSER_ATTACHMENT_MAX_BYTES
): string | null {
  if (!Number.isFinite(size) || size < 0) return `${name || 'arquivo'} tem tamanho inválido`
  if (size <= maxBytes) return null
  return `${name || 'arquivo'} excede o limite de 10 MB`
}

export function planGuiAttachmentBatch<T extends { name: string; size: number }>(
  files: readonly T[]
): { accepted: T[]; errors: string[] } {
  const accepted: T[] = []
  const errors: string[] = []
  let acceptedBytes = 0
  if (files.length > GUI_COMPOSER_ATTACHMENT_MAX_FILES) {
    errors.push(`selecione no máximo ${GUI_COMPOSER_ATTACHMENT_MAX_FILES} arquivos por vez`)
  }
  for (const file of files.slice(0, GUI_COMPOSER_ATTACHMENT_MAX_FILES)) {
    const sizeProblem = guiAttachmentSizeProblem(file.name, file.size)
    if (sizeProblem) {
      errors.push(sizeProblem)
      continue
    }
    if (acceptedBytes + file.size > GUI_COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES) {
      errors.push(`${file.name || 'arquivo'} ultrapassa o limite de 50 MB por seleção`)
      continue
    }
    accepted.push(file)
    acceptedBytes += file.size
  }
  return { accepted, errors }
}

export function base64FromDataUrl(value: string): string | null {
  const comma = value.indexOf(',')
  if (comma < 0 || !/;base64$/iu.test(value.slice(0, comma))) return null
  const bytes = value.slice(comma + 1).trim()
  return bytes || null
}

/** O anexo fica explícito no prompt, mas selecionar nunca dispara o turno. */
export function appendGuiAttachmentReferences(draft: string, paths: readonly string[]): string {
  const references = paths
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => `Anexo disponível em: ${path}`)
  if (references.length === 0) return draft
  const separator = draft.length > 0 && !draft.endsWith('\n') ? '\n' : ''
  return `${draft}${separator}${references.join('\n')}`
}
