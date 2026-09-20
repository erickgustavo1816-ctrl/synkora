import type { GuiUsageMeters, GuiUsageParcels, GuiUsageTotals } from '../shared/guiUsage'

/** Engine-to-registry transport only. Never persist provider payloads, text,
 * URLs or tool arguments. A cumulative source needs its resume baseline before
 * new work; `initial: add` is only for a confirmed new provider conversation. */
export type GuiUsageSample =
  | { kind: 'request'; scopeId: string; requestId: string; usage: GuiUsageParcels }
  | { kind: 'cumulative'; scopeId: string; usage: GuiUsageTotals; initial?: 'baseline' | 'add'; attribution?: 'conversation' }

interface RequestReading { usage: GuiUsageParcels; roundId: string | null }
type UsageSource =
  | { kind: 'request'; requests: Record<string, RequestReading> }
  | { kind: 'cumulative'; latest: GuiUsageTotals; usage: GuiUsageTotals | null; rounds: Record<string, GuiUsageTotals> }

/** Serializable accounting only; this never enters the model context. Keeping
 * request IDs preserves idempotence across restarts and permits later output
 * corrections. It also prevents old requests being charged to a new round. */
export interface GuiRequestUsageState {
  seed: GuiUsageTotals | null
  roundId: string | null
  sources: Record<string, UsageSource>
  partial?: true
  roundPartial?: true
}

/** Bounded local accounting; exceeding it keeps measured history and makes
 * its incompleteness explicit instead of silently losing deduplication IDs. */
export const GUI_USAGE_MAX_REQUESTS = 2_048
export const GUI_USAGE_MAX_SOURCES = 16

const parcelKeys = ['inputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'outputTokens'] as const
const totalKeys = [...parcelKeys, 'apiCalls'] as const
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
const identity = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f]/u.test(value)
const own = <T>(values: Record<string, T>, key: string): T | undefined =>
  Object.prototype.hasOwnProperty.call(values, key) ? values[key] : undefined

export function isGuiUsageParcels(value: unknown): value is GuiUsageParcels {
  return record(value) && parcelKeys.every(key => count(value[key]))
}

export function isGuiUsageTotals(value: unknown): value is GuiUsageTotals {
  return isGuiUsageParcels(value) && count((value as unknown as Record<string, unknown>)['apiCalls'])
}

export function isGuiUsageMeters(value: unknown): value is GuiUsageMeters {
  if (!record(value) || (value['partial'] !== undefined && value['partial'] !== true) ||
    (value['conversation'] !== null && !isGuiUsageTotals(value['conversation']))) return false
  const round = value['round']
  return round === null || (record(round) && identity(round['id']) &&
    (round['usage'] === null || isGuiUsageTotals(round['usage'])) &&
    (round['partial'] === undefined || round['partial'] === true))
}

export function isGuiRequestUsageState(value: unknown): value is GuiRequestUsageState {
  if (!record(value) || (value['seed'] !== null && !isGuiUsageTotals(value['seed'])) ||
    (value['roundId'] !== null && !identity(value['roundId'])) || !record(value['sources'])) return false
  if ((value['partial'] !== undefined && value['partial'] !== true) ||
    (value['roundPartial'] !== undefined && value['roundPartial'] !== true)) return false
  const sources = Object.entries(value['sources'])
  if (sources.length > GUI_USAGE_MAX_SOURCES) return false
  let requests = 0
  return sources.every(([key, source]) => {
    if (!identity(key) || !record(source)) return false
    if (source['kind'] === 'request') return record(source['requests']) &&
      (requests += Object.keys(source['requests']).length) <= GUI_USAGE_MAX_REQUESTS &&
      Object.entries(source['requests']).every(([id, reading]) => identity(id) && record(reading) &&
        isGuiUsageParcels(reading['usage']) && (reading['roundId'] === null || identity(reading['roundId'])))
    return source['kind'] === 'cumulative' && isGuiUsageTotals(source['latest']) &&
      (source['usage'] === null || isGuiUsageTotals(source['usage'])) && record(source['rounds']) &&
      Object.entries(source['rounds']).every(([id, usage]) => identity(id) && isGuiUsageTotals(usage))
  })
}

export function createGuiRequestUsage(seed?: unknown): GuiRequestUsageState {
  // Legacy apiCalls counted observations without IDs. Preserve the raw parcels
  // but never promote that historical count to verified distinct requests.
  return { seed: isGuiUsageTotals(seed) ? { ...seed, apiCalls: null } : null, roundId: null, sources: {} }
}

export function beginGuiUsageRound(state: GuiRequestUsageState, id: string): GuiRequestUsageState {
  if (!identity(id) || state.roundId === id) return state
  // Only the most recent round is shown. Old cumulative round subtotals can
  // go; the conversation aggregate and request dedupe identities remain.
  const sources = Object.fromEntries(Object.entries(state.sources).map(([key, source]) =>
    [key, source.kind === 'cumulative' ? { ...source, rounds: {} } : source]))
  const next = { ...state, roundId: id, sources }
  delete next.roundPartial
  return next
}

export function markGuiUsageUnattributed(state: GuiRequestUsageState, includeRound = true): GuiRequestUsageState {
  const roundPartial = includeRound && state.roundId !== null
  return state.partial && (!roundPartial || state.roundPartial) ? state
    : { ...state, partial: true, ...(roundPartial ? { roundPartial: true as const } : {}) }
}

function sum(a: GuiUsageTotals | null, b: GuiUsageTotals): GuiUsageTotals {
  if (!a) return { ...b }
  const result = { ...a }
  for (const key of totalKeys) {
    const left = a[key], right = b[key]
    result[key] = left === null || right === null ? null : left + right
  }
  return result
}

/** Snapshot only, never sum these again in the renderer or during replay. */
export function guiUsageMeters(state: GuiRequestUsageState): GuiUsageMeters {
  let conversation = state.seed, round: GuiUsageTotals | null = null
  for (const source of Object.values(state.sources)) {
    if (source.kind === 'request') {
      for (const reading of Object.values(source.requests)) {
        const usage = { ...reading.usage, apiCalls: 1 }
        conversation = sum(conversation, usage)
        if (state.roundId !== null && reading.roundId === state.roundId) round = sum(round, usage)
      }
    } else {
      if (source.usage) conversation = sum(conversation, source.usage)
      const usage = state.roundId === null ? undefined : own(source.rounds, state.roundId)
      if (usage) round = sum(round, usage)
    }
  }
  return { conversation, ...(state.partial ? { partial: true as const } : {}),
    round: state.roundId === null ? null : { id: state.roundId, usage: round,
      ...(state.roundPartial ? { partial: true as const } : {}) } }
}

function validSample(value: unknown): value is GuiUsageSample {
  if (!record(value) || !identity(value['scopeId'])) return false
  if (value['kind'] === 'request') return identity(value['requestId']) && isGuiUsageParcels(value['usage'])
  return value['kind'] === 'cumulative' && isGuiUsageTotals(value['usage']) &&
    (value['initial'] === undefined || value['initial'] === 'baseline' || value['initial'] === 'add') &&
    (value['attribution'] === undefined || value['attribution'] === 'conversation')
}

export function recordGuiUsageSample(state: GuiRequestUsageState, candidate: unknown): GuiRequestUsageState {
  if (!validSample(candidate)) return state
  const sample = candidate, previous = own(state.sources, sample.scopeId)
  if (previous && previous.kind !== sample.kind) return state
  if (!previous && Object.keys(state.sources).length >= GUI_USAGE_MAX_SOURCES)
    return markGuiUsageUnattributed(state)
  let source: UsageSource
  if (sample.kind === 'request') {
    const requests = previous?.kind === 'request' ? previous.requests : {}
    const prior = own(requests, sample.requestId)
    if (!prior && Object.values(state.sources).reduce((total, item) =>
      total + (item.kind === 'request' ? Object.keys(item.requests).length : 0), 0) >= GUI_USAGE_MAX_REQUESTS)
      return markGuiUsageUnattributed(state)
    const usage = { ...sample.usage }
    if (prior) {
      for (const key of parcelKeys) {
        const before = prior.usage[key], after = usage[key]
        usage[key] = before === null ? after : after === null ? before : Math.max(before, after)
      }
      if (parcelKeys.every(key => usage[key] === prior.usage[key])) return state
    }
    source = { kind: 'request', requests: { ...requests,
      [sample.requestId]: { usage, roundId: prior ? prior.roundId : state.roundId } } }
  } else {
    const prior = previous?.kind === 'cumulative' ? previous : undefined
    const latest = { ...sample.usage }
    let delta: GuiUsageTotals | null = null
    if (prior) {
      // Reordered or reset counters cannot be counted as a new expenditure.
      if (totalKeys.some(key => latest[key] !== null && prior.latest[key] !== null &&
        latest[key]! < prior.latest[key]!)) return state
      if (totalKeys.every(key => latest[key] === null || latest[key] === prior.latest[key])) return state
      delta = { ...latest }
      for (const key of totalKeys) {
        const before = prior.latest[key], after = latest[key]
        delta[key] = before === null || after === null ? null : after - before
        // An omitted field does not erase the baseline for future readings.
        if (after === null) latest[key] = before
      }
    } else if (sample.initial === 'add') delta = latest
    const rounds = { ...prior?.rounds }
    if (state.roundId !== null && delta && sample.attribution !== 'conversation')
      rounds[state.roundId] = sum(own(rounds, state.roundId) ?? null, delta)
    source = { kind: 'cumulative', latest, usage: delta ? sum(prior?.usage ?? null, delta) : prior?.usage ?? null, rounds }
  }
  const next = { ...state, sources: { ...state.sources, [sample.scopeId]: source } }
  // Reject overflow instead of manufacturing exact-looking, rounded counters.
  const meters = guiUsageMeters(next)
  return isGuiUsageMeters(meters) ? next : state
}

function reported(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Claude messages can arrive again with the same ID and a more complete
 * output count. Preserve the ID and missing fields for the registry to merge. */
export function guiClaudeUsageSample(scopeId: unknown, requestId: unknown, raw: unknown): GuiUsageSample | null {
  if (!identity(scopeId) || !identity(requestId) || !record(raw)) return null
  const usage: GuiUsageParcels = {
    inputTokens: reported(raw['input_tokens']),
    cacheWriteTokens: reported(raw['cache_creation_input_tokens']),
    cacheReadTokens: reported(raw['cache_read_input_tokens']),
    outputTokens: reported(raw['output_tokens'])
  }
  if ((usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.cacheReadTokens ?? 0) === 0) return null
  return { kind: 'request', scopeId: `claude:${scopeId}`, requestId, usage }
}

/** Codex supplies thread totals, not a request identifier. Use cumulative
 * deltas for tokens and leave API-call count unavailable. Context still comes
 * independently from `last` in codexTokenUsage.ts. No extra provider request. */
export function guiCodexUsageSample(scopeId: unknown, tokenUsage: unknown,
  options: { newConversation: boolean; turnActive: boolean }): GuiUsageSample | null {
  if (!identity(scopeId) || !record(tokenUsage) || !record(tokenUsage['total'])) return null
  const raw = tokenUsage['total'], input = reported(raw['inputTokens'])
  if (input === null) return null
  const read = reported(raw['cachedInputTokens']), written = reported(raw['cacheWriteInputTokens'])
  const validSplit = read !== null && written !== null && read + written <= input
  const usage: GuiUsageTotals = {
    inputTokens: validSplit ? input - read! - written! : null,
    cacheReadTokens: read,
    cacheWriteTokens: written,
    outputTokens: reported(raw['outputTokens']),
    apiCalls: null
  }
  return { kind: 'cumulative', scopeId: `codex:${scopeId}`, usage,
    initial: options.newConversation ? 'add' : 'baseline',
    ...(!options.turnActive ? { attribution: 'conversation' as const } : {}) }
}
