import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RESUME_PROBE_MAX_CHARS,
  hasFatalResumeError,
  takeResumeProbeChunk
} from '../src/main/ptyRecovery.ts'

test('reconhece somente a assinatura fatal exata do Claude', () => {
  assert.equal(
    hasFatalResumeError('claude', 'No conversation found with session ID abc-123'),
    true
  )
  assert.equal(
    hasFatalResumeError('claude', 'O usuário disse: conversation/session not found'),
    false
  )
})

test('reconhece a assinatura fatal real do Codex', () => {
  assert.equal(
    hasFatalResumeError(
      'codex',
      'ERROR: No saved session found with ID 00000000-0000-0000-0000-000000000000.'
    ),
    true
  )
})

test('texto genérico de conversa nunca parece falha de retomada', () => {
  assert.equal(hasFatalResumeError('codex', 'I could not resume the missing thread'), false)
  assert.equal(hasFatalResumeError('codex', 'thread not found, então criei outro'), false)
})

test('primeiro chunk enorme é cortado exatamente no teto da sonda', () => {
  const fatalTail = '\nERROR: No saved session found with ID depois-do-teto'
  const probe = takeResumeProbeChunk('x'.repeat(RESUME_PROBE_MAX_CHARS) + fatalTail, 0)
  assert.equal(probe.chunk.length, RESUME_PROBE_MAX_CHARS)
  assert.equal(probe.consumed, RESUME_PROBE_MAX_CHARS)
  assert.equal(probe.reachedLimit, true)
  assert.equal(hasFatalResumeError('codex', probe.chunk), false)
})
