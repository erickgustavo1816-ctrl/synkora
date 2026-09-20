/** Bounded, explicit-baseline browser observations. State stays in this tab's
 * driver and is never persisted or inferred from what a model might remember. */
import { readFooter, type PageReadResult } from './browserPageScript'
import { sanitizeGuiArtifactPreviewText } from './guiFileBrowserUrl'

export const BROWSER_READ_DEFAULT_MAX_CHARS = 1_500
export const BROWSER_READ_FULL_MAX_CHARS = 8_000
export const BROWSER_READ_CEILING_CHARS = 32_000
export const BROWSER_RESPONSE_DEFAULT_MAX_CHARS = 2_000
const HISTORY_LIMIT = 8
const HISTORY_MAX_AGE_MS = 60_000

export interface BrowserReadOptions {
  filter?: 'interactive' | 'all'
  depth?: number
  scope?: string
  /** Body budget. An explicit value also expands the default response budget. */
  maxChars?: number
  detail?: 'compact' | 'full'
  /** Total text budget, including headers, receipts, errors and cut notices. */
  responseMaxChars?: number
  /** Only provide this when the corresponding observation is still available. */
  baselineId?: string
}

export interface BrowserObservationResult {
  ok: boolean
  text: string
  mode: 'fresh' | 'delta' | 'unchanged'
  observationId?: string
  baselineId?: string
  error?: string
}

export function browserBound(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value!), min), max) : fallback
}

export function browserResponseBudget(options: BrowserReadOptions = {}): number {
  const fallback = options.maxChars !== undefined
    ? browserBound(options.maxChars, BROWSER_READ_DEFAULT_MAX_CHARS, 500, BROWSER_READ_CEILING_CHARS) + 600
    : options.detail === 'full' ? 9_000 : BROWSER_RESPONSE_DEFAULT_MAX_CHARS
  // MCP's public minimum is 500; an action receipt reserves a smaller internal
  // remainder so its observation still fits the same *total* budget.
  return browserBound(options.responseMaxChars, Math.min(fallback, BROWSER_READ_CEILING_CHARS), 200, BROWSER_READ_CEILING_CHARS)
}

export function browserReadParams(options: BrowserReadOptions): {
  mode: 'read'; filter: 'interactive' | 'all'; depth: number; scope: string; maxChars: number
} {
  return {
    mode: 'read', filter: options.filter ?? 'all',
    depth: browserBound(options.depth, 20, 1, 40), scope: options.scope ?? '',
    maxChars: Math.min(
      browserBound(options.maxChars, options.detail === 'full' ? BROWSER_READ_FULL_MAX_CHARS : BROWSER_READ_DEFAULT_MAX_CHARS, 500, BROWSER_READ_CEILING_CHARS),
      browserResponseBudget(options)
    )
  }
}

export function boundBrowserText(text: string, budget: number, recipe = 'browser_read com scope ou detail:"full" e responseMaxChars maior'): string {
  text = sanitizeGuiArtifactPreviewText(text)
  if (text.length <= budget) return text
  const suffix = `\n[CORTADO — ${recipe}]`
  return text.slice(0, Math.max(0, budget - suffix.length)) + suffix.slice(0, budget)
}

/** Reserve the identifying footer and diagnostics before reducing page text. */
export function formatBrowserResponse(header: string, body: string, footer: string, budget: number): string {
  header = sanitizeGuiArtifactPreviewText(header)
  body = sanitizeGuiArtifactPreviewText(body)
  footer = sanitizeGuiArtifactPreviewText(footer)
  const all = `${header}\n\n${body}\n\n${footer}`
  if (all.length <= budget) return all
  const marker = '\n[CORTADO — browser_read com scope ou detail:"full" e responseMaxChars maior]'
  const headerCap = Math.min(240, Math.floor(budget / 4))
  const compactHeader = header.length > headerCap ? header.slice(0, headerCap - 1) + '…' : header
  const footerCap = Math.max(0, Math.min(500, Math.floor(budget / 2), budget - compactHeader.length - marker.length - 4))
  const compactFooter = footer.length > footerCap ? footer.slice(0, footerCap - 1) + '…' : footer
  const bodyCap = Math.max(0, budget - compactHeader.length - compactFooter.length - marker.length - 4)
  let compactBody = body.slice(0, bodyCap)
  if (body.length > bodyCap && compactBody.includes('\n')) compactBody = compactBody.slice(0, compactBody.lastIndexOf('\n'))
  return `${compactHeader}\n\n${compactBody}\n\n${compactFooter}${marker}`
}

interface ObservationSnapshot {
  id: string
  createdAt: number
  key: string
  page: PageReadResult
  consoleRevision: number
}

let nextSession = 0
export class BrowserObservationHistory {
  private readonly sessionId = ++nextSession
  private sequence = 0
  private snapshots: ObservationSnapshot[] = []

  describe(
    page: PageReadResult,
    options: BrowserReadOptions,
    consoleRevision: number,
    diagnostics: string
  ): BrowserObservationResult {
    // Keep the raw URL for identity compatibility only. The projected text is
    // also the text used by deltas, so a masked baseline is reconstructable.
    page = { ...page, text: sanitizeGuiArtifactPreviewText(page.text), title: sanitizeGuiArtifactPreviewText(page.title) }
    const params = browserReadParams(options)
    const budget = browserResponseBudget(options)
    const key = JSON.stringify({ filter: params.filter, depth: params.depth, scope: params.scope, detail: options.detail ?? 'compact' })
    const now = Date.now()
    this.snapshots = this.snapshots.filter(snapshot => now - snapshot.createdAt < HISTORY_MAX_AGE_MS)
    const baseline = options.baselineId ? this.snapshots.find(snapshot => snapshot.id === options.baselineId) : undefined
    const compatible = baseline && baseline.key === key && baseline.page.epoch === page.epoch &&
      baseline.page.url === page.url && baseline.page.title === page.title &&
      !page.truncated && !baseline.page.truncated && page.layout?.complete === true && baseline.page.layout?.complete === true &&
      page.layout.stable && baseline.page.layout.stable && page.layout.signature === baseline.page.layout.signature &&
      baseline.consoleRevision === consoleRevision
    const observationId = `obs-${this.sessionId}-${++this.sequence}`
    let mode: BrowserObservationResult['mode'] = 'fresh'
    let body = page.text || '(nenhum elemento visível casou com o filtro)'
    if (compatible) {
      if (page.text === baseline.page.text) {
        mode = 'unchanged'
        body = 'Sem mudanças no texto e na geometria/estilos medidos. Pixels e estética não foram comparados.'
      } else {
        const before = baseline.page.text.split('\n')
        const after = page.text.split('\n')
        let prefix = 0
        let suffix = 0
        while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
        while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
        const changed = after.slice(prefix, after.length - suffix).join('\n')
        const delta = `Substitua ${before.length - prefix - suffix} linha(s) a partir da linha ${prefix + 1} da observação anterior por:\n${changed || '(nenhuma linha — trecho removido)'}`
        if (delta.length < body.length) { mode = 'delta'; body = delta }
      }
    }
    const identity = `observação ${observationId}${mode !== 'fresh' ? ` · base ${baseline!.id} · ${mode}` : ' · nova'}`
    const header = mode === 'unchanged' ? identity : sanitizeGuiArtifactPreviewText(`${page.title || '(sem título)'} · ${page.url}`)
    const layout = page.layout ? `\nviewport ${page.layout.viewport.w}x${page.layout.viewport.h} · estado ${page.layout.readyState}${page.layout.stable ? '' : ' · ainda pode mudar'}` : ''
    const footer = mode === 'unchanged' ? `refs válidos no epoch ${page.epoch}`
      : `${identity}\n${readFooter(page, params.maxChars, BROWSER_READ_CEILING_CHARS)}${layout}`
    const text = formatBrowserResponse(header, `${diagnostics ? diagnostics + '\n' : ''}${body}`, footer, budget)
    // Never use a cut transport response as a baseline: the recipient could not
    // reconstruct that complete observation after a later delta.
    if (text === `${header}\n\n${diagnostics ? diagnostics + '\n' : ''}${body}\n\n${footer}`) {
      this.snapshots.push({ id: observationId, createdAt: now, key, page, consoleRevision })
      if (this.snapshots.length > HISTORY_LIMIT) this.snapshots.shift()
    }
    return { ok: true, text, mode, observationId, ...(mode !== 'fresh' ? { baselineId: baseline!.id } : {}) }
  }
}
