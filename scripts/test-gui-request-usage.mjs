import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginGuiUsageRound,
  createGuiRequestUsage,
  guiUsageMeters,
  recordGuiUsageSample,
  isGuiRequestUsageState,
  guiClaudeUsageSample,
  guiCodexUsageSample,
  GUI_USAGE_MAX_REQUESTS
} from '../src/main/guiRequestUsage.ts'

const parcels = (input = 100, output = 10) => ({
  inputTokens: input, cacheWriteTokens: 0, cacheReadTokens: 200, outputTokens: output
})
const request = (requestId, usage = parcels()) => ({ kind: 'request', scopeId: 'synthetic-thread', requestId, usage })
const total = (input, output, apiCalls = null) => ({ ...parcels(input, output), apiCalls })

test('round totals begin at an explicit boundary and preserve already consumed conversation history', () => {
  let state = createGuiRequestUsage({ ...parcels(5_000, 80), apiCalls: 20 })
  state = beginGuiUsageRound(state, 'owner-round-a')
  assert.equal(guiUsageMeters(state).round.usage, null, 'no measurement is not zero usage')
  state = recordGuiUsageSample(state, request('message-a'))
  assert.deepEqual(guiUsageMeters(state), {
    conversation: { inputTokens: 5_100, cacheWriteTokens: 0, cacheReadTokens: 400, outputTokens: 90, apiCalls: null },
    round: { id: 'owner-round-a', usage: { ...parcels(), apiCalls: 1 } }
  })
  state = beginGuiUsageRound(state, 'owner-round-b')
  state = recordGuiUsageSample(state, request('message-b', parcels(50, 5)))
  assert.equal(guiUsageMeters(state).conversation.inputTokens, 5_150)
  assert.equal(guiUsageMeters(state).round.usage.inputTokens, 50)
})

test('replayed request samples are idempotent and later output updates contribute once', () => {
  let state = beginGuiUsageRound(createGuiRequestUsage(), 'round-a')
  state = recordGuiUsageSample(state, request('message-a', parcels(100, 2)))
  assert.equal(recordGuiUsageSample(state, request('message-a', parcels(100, 2))), state)
  state = recordGuiUsageSample(state, request('message-a', parcels(100, 15)))
  state = recordGuiUsageSample(state, request('message-a', parcels(100, 8)))
  assert.deepEqual(guiUsageMeters(state).round.usage, { ...parcels(100, 15), apiCalls: 1 })
  const restored = JSON.parse(JSON.stringify(state))
  assert.equal(isGuiRequestUsageState(restored), true)
  assert.equal(recordGuiUsageSample(restored, request('message-a', parcels(100, 15))), restored)
})

test('a late correction belongs to the request original round, not the next owner edit', () => {
  let state = beginGuiUsageRound(createGuiRequestUsage(), 'round-a')
  state = recordGuiUsageSample(state, request('message-a', parcels(100, 2)))
  state = beginGuiUsageRound(state, 'round-b')
  state = recordGuiUsageSample(state, request('message-a', parcels(100, 25)))
  assert.equal(guiUsageMeters(state).conversation.outputTokens, 25)
  assert.equal(guiUsageMeters(state).round.usage, null)
  state = recordGuiUsageSample(state, request('message-b', parcels(20, 3)))
  assert.equal(guiUsageMeters(state).round.usage.outputTokens, 3)
})

test('missing parcel stays unavailable, then recovers when that same request supplies it', () => {
  let state = beginGuiUsageRound(createGuiRequestUsage(), 'round-a')
  state = recordGuiUsageSample(state, request('message-a', { ...parcels(), outputTokens: null }))
  assert.equal(guiUsageMeters(state).conversation.outputTokens, null)
  state = recordGuiUsageSample(state, request('message-a', parcels(100, 15)))
  assert.equal(guiUsageMeters(state).conversation.outputTokens, 15)
  state = recordGuiUsageSample(state, request('message-b', { ...parcels(), cacheWriteTokens: null }))
  assert.equal(guiUsageMeters(state).conversation.cacheWriteTokens, null)
})

test('cumulative protocol starts from a baseline and uses deltas without claiming API-call count', () => {
  const cumulative = usage => ({ kind: 'cumulative', scopeId: 'codex-thread', usage })
  let state = createGuiRequestUsage()
  state = recordGuiUsageSample(state, cumulative(total(1_000, 100)))
  assert.equal(guiUsageMeters(state).conversation, null, 'resume totals are not a new expenditure')
  state = beginGuiUsageRound(state, 'round-a')
  state = recordGuiUsageSample(state, cumulative(total(1_100, 130)))
  const measured = state
  assert.deepEqual(guiUsageMeters(state).round.usage, {
    inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 30, apiCalls: null
  })
  assert.equal(recordGuiUsageSample(state, cumulative(total(1_100, 130))), measured)
  assert.equal(recordGuiUsageSample(state, cumulative(total(900, 80))), measured)
  state = beginGuiUsageRound(state, 'round-b')
  state = recordGuiUsageSample(state, cumulative(total(1_150, 140)))
  assert.equal(guiUsageMeters(state).conversation.inputTokens, 150)
  assert.equal(guiUsageMeters(state).round.usage.inputTokens, 50)
})

test('new cumulative conversation can explicitly count its first sample and forbids mixed accounting', () => {
  let state = beginGuiUsageRound(createGuiRequestUsage(), 'round-a')
  state = recordGuiUsageSample(state, { kind: 'cumulative', scopeId: 'new-thread', initial: 'add', usage: total(100, 10, 1) })
  assert.equal(guiUsageMeters(state).conversation.inputTokens, 100)
  assert.equal(recordGuiUsageSample(state, { ...request('same-measurement'), scopeId: 'new-thread' }), state)
})

test('invalid samples, missing identities and overflow never invent measured expenditure', () => {
  const state = createGuiRequestUsage()
  assert.equal(recordGuiUsageSample(state, { ...request(''), usage: parcels() }), state)
  assert.equal(recordGuiUsageSample(state, request('bad', { ...parcels(), inputTokens: -1 })), state)
  assert.equal(recordGuiUsageSample(state, request('bad', { ...parcels(), outputTokens: NaN })), state)
  assert.equal(recordGuiUsageSample(state, request('bad', { ...parcels(), cacheReadTokens: undefined })), state)
  const full = createGuiRequestUsage({ ...parcels(Number.MAX_SAFE_INTEGER), apiCalls: 1 })
  assert.equal(recordGuiUsageSample(full, request('overflow')), full)
  assert.equal(isGuiRequestUsageState({ ...state, seed: { apiCalls: 0 } }), false)
})

test('engine adapters retain unknown counters and never guess request IDs or count Codex notifications', () => {
  const claude = guiClaudeUsageSample('thread-a', 'message-a', { input_tokens: 10, output_tokens: 5 })
  assert.equal(claude.usage.cacheWriteTokens, null)
  assert.equal(guiClaudeUsageSample('thread-a', undefined, { input_tokens: 10 }), null)
  assert.equal(guiClaudeUsageSample('thread-a', 'local', { input_tokens: 0, output_tokens: 0 }), null)
  const codex = guiCodexUsageSample('thread-a', { total: {
    inputTokens: 300, cachedInputTokens: 200, cacheWriteInputTokens: 0, outputTokens: 20
  } }, { newConversation: true, turnActive: true })
  assert.equal(codex.usage.apiCalls, null)
  assert.equal(codex.usage.inputTokens, 100)
  const missing = guiCodexUsageSample('thread-a', { total: {
    inputTokens: 300, cachedInputTokens: 200, outputTokens: 20
  } }, { newConversation: false, turnActive: false })
  assert.equal(missing.usage.inputTokens, null)
  assert.equal(missing.usage.cacheWriteTokens, null)
  assert.equal(missing.initial, 'baseline')
  assert.equal(missing.attribution, 'conversation')
})

test('usage observed outside an active Codex turn updates history without charging an owner round', () => {
  let state = beginGuiUsageRound(createGuiRequestUsage(), 'round-a')
  state = recordGuiUsageSample(state, { kind: 'cumulative', scopeId: 'thread', initial: 'add', usage: total(100, 10) })
  state = recordGuiUsageSample(state, { kind: 'cumulative', scopeId: 'thread', attribution: 'conversation', usage: total(150, 20) })
  assert.equal(guiUsageMeters(state).conversation.inputTokens, 150)
  assert.equal(guiUsageMeters(state).round.usage.inputTokens, 100)
})

test('bounded request history never drops deduplication silently or promotes legacy observation counts', () => {
  assert.equal(createGuiRequestUsage({ ...parcels(), apiCalls: 178 }).seed.apiCalls, null)
  let state = beginGuiUsageRound(createGuiRequestUsage(), 'round-a')
  for (let i = 0; i < GUI_USAGE_MAX_REQUESTS; i++) state = recordGuiUsageSample(state, request(`request-${i}`))
  state = recordGuiUsageSample(state, request('over-cap'))
  assert.equal(guiUsageMeters(state).partial, true)
  assert.equal(guiUsageMeters(state).round.partial, true)
  assert.equal(Object.keys(state.sources['synthetic-thread'].requests).length, GUI_USAGE_MAX_REQUESTS)
  assert.equal(recordGuiUsageSample(state, request('request-0')), state)
  const bytes = Buffer.byteLength(JSON.stringify(state))
  assert.ok(bytes < 400_000, `synthetic accounting stays bounded (${bytes} bytes)`)
  state = beginGuiUsageRound(state, 'round-b')
  assert.equal(guiUsageMeters(state).partial, true)
  assert.equal(guiUsageMeters(state).round.partial, undefined)
})
