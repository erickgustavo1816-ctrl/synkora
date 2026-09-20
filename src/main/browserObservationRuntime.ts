/** Structured outcomes for deterministic checks; callers never parse UI text. */
import { isPageFailure, type PageResult, type PageWaitResult } from './browserPageScript'
import { buildProbeExpression, formatProbeReport, type BrowserProbeParams, type BrowserProbeRaw, type ProbeRawOk } from './browserProbe'
import { boundBrowserText, browserBound } from './browserObservation'
import { sanitizeGuiArtifactPreviewText } from './guiFileBrowserUrl'

export interface BrowserWaitOptions {
  text?: string
  selector?: string
  networkIdle?: boolean
  ms?: number
  timeoutMs?: number
}
export interface BrowserWaitResult { ok: boolean; text: string; timedOut?: boolean; error?: string }
export type BrowserProbeResult = { ok: true; text: string; value: ProbeRawOk } | { ok: false; text: string; error: string }
export const BROWSER_WAIT_DEFAULT_MS = 5_000
export const BROWSER_WAIT_MAX_MS = 30_000

export async function browserProbeResult(
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  params: BrowserProbeParams,
  epoch: number,
  staleRecipe: string
): Promise<BrowserProbeResult> {
  try {
    const raw = await send('Runtime.evaluate', {
      expression: buildProbeExpression({ ...params, epoch }), returnByValue: true, awaitPromise: false
    }) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
    const value = raw.result?.value as BrowserProbeRaw | undefined
    if (raw.exceptionDetails || !value) {
      const error = raw.exceptionDetails?.text ?? 'a página não devolveu resultado'
      return { ok: false, error: sanitizeGuiArtifactPreviewText(error), text: sanitizeGuiArtifactPreviewText(`não consegui inspecionar: ${error}`) }
    }
    if (!value.ok) {
      const error = value.stale ? `${value.error} — ${staleRecipe}` : value.error
      return { ok: false, error: sanitizeGuiArtifactPreviewText(error), text: sanitizeGuiArtifactPreviewText(`não consegui inspecionar: ${error}`) }
    }
    return { ok: true, text: sanitizeGuiArtifactPreviewText(formatProbeReport(value)), value }
  } catch (failure) {
    const error = boundBrowserText(String(failure), 800)
    return { ok: false, error, text: `não consegui inspecionar: ${error}` }
  }
}

export interface BrowserWaitContext {
  runPage(params: Record<string, unknown>): Promise<PageResult<PageWaitResult>>
  networkAvailable(): boolean
  inFlight(): number
  lastNetworkActivity(): number
}

export async function browserWaitResult(ctx: BrowserWaitContext, options: BrowserWaitOptions): Promise<BrowserWaitResult> {
  const timeout = browserBound(options.timeoutMs, BROWSER_WAIT_DEFAULT_MS, 1, BROWSER_WAIT_MAX_MS)
  const started = Date.now()
  if (options.ms !== undefined) {
    const ms = browserBound(options.ms, 0, 0, BROWSER_WAIT_MAX_MS)
    await new Promise(resolve => setTimeout(resolve, ms))
    return { ok: true, text: `esperei ${ms}ms.` }
  }
  if (options.networkIdle && !ctx.networkAvailable()) {
    const error = 'não posso esperar a rede: o domínio Network do CDP não subiu nesta aba. Receita: espere por `selector` ou `text` (o que a página desenha quando a resposta chega).'
    return { ok: false, error, text: error }
  }
  try {
    // Probe at least once even for a tiny deadline; malformed selectors are
    // failures in their own right, not a fabricated successful wait/timeout.
    do {
      if (options.networkIdle) {
        if (ctx.inFlight() === 0 && Date.now() - ctx.lastNetworkActivity() > 500) {
          return { ok: true, text: `rede ociosa depois de ${Date.now() - started}ms (nenhuma requisição em voo há 500ms).` }
        }
      } else {
        const result = await ctx.runPage({ mode: 'wait', ...(options.selector ? { selector: options.selector } : {}), ...(options.text ? { text: options.text } : {}) })
        if (isPageFailure(result)) {
          return { ok: false, error: sanitizeGuiArtifactPreviewText(result.error), text: sanitizeGuiArtifactPreviewText(`não consegui verificar a espera: ${result.error}. Receita: confira o selector/text e chame browser_read.`) }
        }
        if (result.hit) return { ok: true, text: `apareceu depois de ${Date.now() - started}ms.` }
      }
      const remaining = timeout - (Date.now() - started)
      if (remaining <= 0) break
      await new Promise(resolve => setTimeout(resolve, Math.min(120, remaining)))
    } while (Date.now() - started < timeout)
  } catch (failure) {
    const error = boundBrowserText(String(failure), 800)
    return { ok: false, error, text: `não consegui verificar a espera: ${error}. Receita: chame browser_read e browser_console.` }
  }
  const what = options.networkIdle ? `a rede não ficou ociosa (${ctx.inFlight()} requisição(ões) em voo)`
    : options.selector ? `o seletor "${options.selector}" não apareceu` : `o texto "${options.text ?? ''}" não apareceu`
  const error = `ESPERA ESGOTADA em ${timeout}ms: ${what}. Receita: chame browser_read para ver o que a página REALMENTE mostra agora, browser_console para ver se ela quebrou, ou repita com timeoutMs maior (teto ${BROWSER_WAIT_MAX_MS}).`
  return { ok: false, text: sanitizeGuiArtifactPreviewText(error), error: sanitizeGuiArtifactPreviewText(error), timedOut: true }
}

export interface BrowserConsoleEntry { level: string; text: string; source?: string; ts: number; seq: number }
export interface BrowserConsoleResult { text: string; entries: number; errors: number; complete: boolean }
export function browserConsoleSince(
  entries: BrowserConsoleEntry[], revision: number, checkpoint: number, logAvailable: boolean,
  options: { onlyErrors?: boolean; maxChars?: number } = {}
): BrowserConsoleResult {
  const valid = Number.isInteger(checkpoint) && checkpoint >= 0 && checkpoint <= revision
  const complete = valid && (!entries.length || checkpoint >= entries[0]!.seq - 1) && logAvailable
  const recent = valid ? entries.filter(entry => entry.seq > checkpoint) : entries
  const errors = recent.filter(entry => /error|severe|warning/i.test(entry.level))
  const shown = options.onlyErrors ? errors : recent
  const gap = complete ? '' : 'Cobertura incompleta do console: cursor inválido, buffer antigo ou domínio Log indisponível. '
  const budget = browserBound(options.maxChars, 1_200, 300, 4_000)
  const selected: string[] = []
  let used = gap.length + 75
  // Keep the newest diagnostic, not an old prefix that hides the new failure.
  for (let i = shown.length - 1; i >= 0; i--) {
    const entry = shown[i]!
    const line = boundBrowserText(`[${entry.level}] ${entry.text}`, Math.max(100, budget - gap.length - 75), 'browser_console para detalhes')
    if (used + line.length + 1 > budget) break
    selected.unshift(line)
    used += line.length + 1
  }
  const cut = selected.length < shown.length ? `[CORTADO — últimas ${selected.length} de ${shown.length}; browser_console para detalhes]\n` : ''
  const body = shown.length ? cut + selected.join('\n') : 'Nenhuma mensagem nova no intervalo registrado.'
  return {
    text: boundBrowserText(gap + body, budget, 'browser_console para ampliar o diagnóstico'),
    entries: recent.length, errors: errors.length, complete
  }
}
