export type ResumablePaneKind = 'claude' | 'codex'

export const RESUME_PROBE_MAX_CHARS = 32_768

/** Recorta estritamente a janela inicial inspecionada pela autocura. */
export function takeResumeProbeChunk(
  data: string,
  consumed: number
): { chunk: string; consumed: number; reachedLimit: boolean } {
  const safeConsumed = Math.max(0, Math.min(RESUME_PROBE_MAX_CHARS, consumed))
  const chunk = data.slice(0, RESUME_PROBE_MAX_CHARS - safeConsumed)
  const next = safeConsumed + chunk.length
  return {
    chunk,
    consumed: next,
    reachedLimit: next >= RESUME_PROBE_MAX_CHARS
  }
}

/** Somente assinaturas fatais emitidas pelo próprio CLI durante o startup.
 * Texto genérico de uma conversa nunca deve apagar uma sessão válida. */
export function hasFatalResumeError(kind: ResumablePaneKind, output: string): boolean {
  return kind === 'claude'
    ? output.includes('No conversation found with session ID')
    : /(?:^|\n)\s*ERROR:\s*No\s+saved\s+session\s+found\s+with\s+ID\b/i.test(output)
}
