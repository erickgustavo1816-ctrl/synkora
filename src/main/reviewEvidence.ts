import { createHash } from 'crypto'
import { closeSync, openSync, readSync } from 'fs'
import type { PhaseWatch } from './phaseTypes'

export const REVIEW_EVIDENCE_CHUNK_BYTES = 32 * 1024

type ReviewArtifact = NonNullable<PhaseWatch['reviewArtifact']>

/** Cria uma sequencia de blocos autenticados sem cortar UTF-8 no meio. */
export function buildReviewEvidenceChunkManifest(
  path: string,
  bytes: number
): ReviewArtifact['chunks'] {
  const chunks: ReviewArtifact['chunks'] = []
  const fd = openSync(path, 'r')
  try {
    let offset = 0
    while (offset < bytes) {
      const capacity = Math.min(REVIEW_EVIDENCE_CHUNK_BYTES + 4, bytes - offset)
      const buffer = Buffer.allocUnsafe(capacity)
      const read = readSync(fd, buffer, 0, capacity, offset)
      if (read <= 0) throw new Error('fim inesperado ao criar manifesto do review')
      let end = Math.min(REVIEW_EVIDENCE_CHUNK_BYTES, read)
      while (end > 0 && offset + end < bytes && (buffer[end] & 0xc0) === 0x80) end -= 1
      if (end <= 0) throw new Error('fronteira UTF-8 invalida no patch do review')
      chunks.push({
        offset,
        bytes: end,
        sha256: createHash('sha256').update(buffer.subarray(0, end)).digest('hex')
      })
      offset += end
    }
    return chunks
  } finally {
    closeSync(fd)
  }
}

/** Le um bloco previsto no manifesto e so avanca o cursor depois de conferir
 * o hash. Retry do ultimo offset e idempotente; saltos sao recusados. */
export function readAuthenticatedReviewEvidenceChunk(
  artifact: ReviewArtifact,
  offset: number
): string {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > artifact.bytes) {
    return `offset inválido; use um valor entre 0 e ${artifact.bytes}`
  }
  const retryingLastChunk = artifact.lastServedOffset === offset
  if (!retryingLastChunk && offset !== artifact.servedUntil) {
    return `offset fora de sequência; use exatamente ${artifact.servedUntil}`
  }
  const chunk = artifact.chunks.find((candidate) => candidate.offset === offset)
  if (!chunk && offset !== artifact.bytes) {
    return `offset fora do manifesto autenticado; use exatamente ${artifact.servedUntil}`
  }

  const fd = openSync(artifact.privatePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(chunk?.bytes ?? 0)
    const read = buffer.byteLength ? readSync(fd, buffer, 0, buffer.byteLength, offset) : 0
    if (chunk && read !== chunk.bytes) return 'evidência privada recusada: bloco truncado'
    if (
      chunk &&
      createHash('sha256').update(buffer.subarray(0, read)).digest('hex') !== chunk.sha256
    ) {
      return 'evidência privada recusada: hash do bloco mudou'
    }

    const nextOffset = offset + read
    const eof = nextOffset >= artifact.bytes
    if (!retryingLastChunk) {
      artifact.lastServedOffset = offset
      artifact.lastServedNextOffset = nextOffset
      artifact.servedUntil = nextOffset
    }
    return [
      `REVIEW EVIDENCE · sha256 ${artifact.sha256} · bytes ${artifact.bytes} · offset ${offset} · nextOffset ${nextOffset} · eof ${eof}`,
      '<BEGIN_UNTRUSTED_REVIEW_EVIDENCE>',
      buffer.subarray(0, read).toString('utf8'),
      '<END_UNTRUSTED_REVIEW_EVIDENCE>'
    ].join('\n')
  } finally {
    closeSync(fd)
  }
}
