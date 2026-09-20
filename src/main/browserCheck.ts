/** Bounded local verification; no new JavaScript execution or model round trips. */
import type { BrowserAction, BrowserReadOptions, BrowserWaitOptions } from './browserDriver'
import type { BrowserProbeParams, BrowserProbeRaw, ProbeRawOk } from './browserProbe'
import type { BrowserShotResult } from './browserShot'
import type { BrowserToolShotInput } from './browserToolCapture'
import { BROWSER_VIEWPORT_MIN_WIDTH, BROWSER_VIEWPORT_MAX_WIDTH } from './browserViewport'

export const BROWSER_CHECK_MAX_SCENARIOS = 4
export const BROWSER_CHECK_MAX_TARGETS = 8
export const BROWSER_CHECK_MAX_ACTIONS = 24
export const BROWSER_CHECK_DEFAULT_MS = 20_000
export const BROWSER_CHECK_MAX_MS = 30_000
export const BROWSER_CHECK_DEFAULT_CHARS = 2_000
export const BROWSER_CHECK_MAX_CHARS = 8_000

export type BrowserCheckAssertion = 'visible' | 'inViewport' | 'noHorizontalOverflow' | 'unoccluded'
export interface BrowserCheckTarget {
  selector: string
  checks?: BrowserCheckAssertion[]
}
export interface BrowserCheckScenario {
  width?: number
  wait?: BrowserWaitOptions
  /** Repeated only when explicitly present in that scenario. */
  actions?: BrowserAction[]
}
export interface BrowserCheckInput {
  url?: string
  scenarios?: BrowserCheckScenario[]
  targets: BrowserCheckTarget[]
  capture?: Pick<BrowserToolShotInput, 'name' | 'selector' | 'purpose' | 'maxWidth'>
  timeoutMs?: number
  responseMaxChars?: number
}
export interface BrowserCheckResult {
  ok: boolean
  text: string
  localSteps: number
  completedScenarios: number
  images?: { data: string; mimeType: string }[]
}

export interface BrowserCheckDriver {
  readyState(): Promise<string>
  viewportSize(): Promise<{ width: number; height: number }>
  actResult(actions: BrowserAction[], read?: BrowserReadOptions, execution?: { observe?: boolean; deadlineAt?: number }): Promise<{
    ok: boolean; text: string; completed: number; total: number; failedStep?: number; error?: string
  }>
  waitResult(options: BrowserWaitOptions): Promise<{ ok: boolean; text: string; timedOut?: boolean; error?: string }>
  probeResult(params: BrowserProbeParams): Promise<{ ok: boolean; text: string; value?: BrowserProbeRaw; error?: string }>
  consoleCheckpoint(): number
  consoleSince(checkpoint: number, options?: { onlyErrors?: boolean }): { text: string; entries: number; errors: number; complete: boolean }
}
export interface BrowserCheckContext {
  driver: BrowserCheckDriver
  /** Called before AND after each step; ownership/owner viewport changes stop the recipe. */
  guard(): { ok: true } | { ok: false; error: string }
  viewport(width: number): { ok: true } | { ok: false; error: string }
  capture(input: BrowserToolShotInput): Promise<BrowserShotResult>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const ASSERTIONS: readonly BrowserCheckAssertion[] = ['visible', 'inViewport', 'noHorizontalOverflow', 'unoccluded']

/** Validate direct callers too; MCP schema validation is not the authority boundary. */
export function validateBrowserCheck(input: BrowserCheckInput): string | undefined {
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > BROWSER_CHECK_MAX_TARGETS) {
    return `informe de 1 a ${BROWSER_CHECK_MAX_TARGETS} alvos em targets`
  }
  if (input.targets.some((target) => !target || typeof target.selector !== 'string' || !target.selector.trim() || target.selector.length > 300 ||
    (target.checks !== undefined && (!Array.isArray(target.checks) || target.checks.length < 1 || target.checks.length > 4 || target.checks.some((check) => !ASSERTIONS.includes(check)))))) {
    return 'cada alvo exige selector CSS e checks válidos: visible, inViewport, noHorizontalOverflow, unoccluded'
  }
  const scenarios = input.scenarios ?? [{}]
  if (!Array.isArray(scenarios) || scenarios.length < 1 || scenarios.length > BROWSER_CHECK_MAX_SCENARIOS) {
    return `informe de 1 a ${BROWSER_CHECK_MAX_SCENARIOS} cenários`
  }
  if (scenarios.some((scenario) => !scenario || (scenario.width !== undefined && (!Number.isInteger(scenario.width) || scenario.width < BROWSER_VIEWPORT_MIN_WIDTH || scenario.width > BROWSER_VIEWPORT_MAX_WIDTH)))) {
    return `largura de cenário inválida; use width entre ${BROWSER_VIEWPORT_MIN_WIDTH} e ${BROWSER_VIEWPORT_MAX_WIDTH}`
  }
  if (scenarios.some((scenario) => scenario.actions !== undefined && !Array.isArray(scenario.actions)) ||
    scenarios.reduce((total, scenario) => total + (scenario.actions?.length ?? 0), 0) > BROWSER_CHECK_MAX_ACTIONS) {
    return `o roteiro inteiro aceita até ${BROWSER_CHECK_MAX_ACTIONS} ações`
  }
  for (const scenario of scenarios) {
    if (scenario.wait && !scenario.wait.selector && !scenario.wait.text && !scenario.wait.networkIdle && scenario.wait.ms === undefined) {
      return 'wait exige selector, text, networkIdle ou ms; prefira a condição do elemento esperado'
    }
    if (scenario.wait?.ms !== undefined && (!Number.isFinite(scenario.wait.ms) || scenario.wait.ms < 0 || scenario.wait.ms > BROWSER_CHECK_MAX_MS)) {
      return `wait.ms deve ficar entre 0 e ${BROWSER_CHECK_MAX_MS}`
    }
  }
  if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 200 || input.timeoutMs > BROWSER_CHECK_MAX_MS)) {
    return `timeoutMs deve ficar entre 200 e ${BROWSER_CHECK_MAX_MS}`
  }
  if (input.responseMaxChars !== undefined && (!Number.isFinite(input.responseMaxChars) || input.responseMaxChars < 500 || input.responseMaxChars > BROWSER_CHECK_MAX_CHARS)) {
    return `responseMaxChars deve ficar entre 500 e ${BROWSER_CHECK_MAX_CHARS}`
  }
  return undefined
}

function failedAssertions(raw: ProbeRawOk, checks: BrowserCheckAssertion[]): BrowserCheckAssertion[] {
  return checks.filter((check) => {
    switch (check) {
      case 'visible': return !raw.visible
      case 'inViewport': return !raw.inViewport
      case 'noHorizontalOverflow': return raw.overflowX || raw.scrollW > raw.clientW + 1
      case 'unoccluded': return raw.occluded
    }
  })
}

/** These are scoped numeric observations, never an aesthetic approval. */
export async function runBrowserCheck(context: BrowserCheckContext, input: BrowserCheckInput): Promise<BrowserCheckResult> {
  const invalid = validateBrowserCheck(input)
  if (invalid) return { ok: false, text: `browser_check recusado: ${invalid}. Receita: corrija o roteiro; NENHUM passo foi executado.`, localSteps: 0, completedScenarios: 0 }
  const now = context.now ?? Date.now
  const sleep = context.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + (input.timeoutMs ?? BROWSER_CHECK_DEFAULT_MS)
  const checkpoint = context.driver.consoleCheckpoint()
  const facts: string[] = []
  const evidence: string[] = []
  const images: { data: string; mimeType: string }[] = []
  let localSteps = 0
  let completedScenarios = 0
  let failure: string | undefined
  let stage = 'carregamento'
  const gate = (): boolean => {
    const guard = context.guard()
    if (!guard.ok) failure = guard.error
    else if (now() >= deadline) failure = 'o orçamento de tempo acabou; nenhum passo seguinte foi iniciado'
    else if (context.driver.consoleSince(checkpoint, { onlyErrors: true }).errors > 0) {
      failure = 'surgiu erro/aviso no console durante o roteiro. Receita: browser_console com onlyErrors:true antes de repetir; os passos seguintes foram suspensos.'
    }
    return failure === undefined
  }
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
    stage = name
    if (!gate()) return undefined
    localSteps += 1
    const value = await run()
    if (!gate()) return undefined
    return value
  }
  try {
    let loaded = false
    while (gate()) {
      const state = await step('carregamento', () => context.driver.readyState())
      if (state === 'complete' || state === 'interactive') { loaded = true; break }
      if (state !== 'loading' && state !== undefined) {
        failure = 'não consegui confirmar o carregamento; use browser_open e browser_read para recuperar a aba'
        break
      }
      if (!failure) await sleep(Math.min(120, Math.max(0, deadline - now())))
    }
    if (loaded) {
      const scenarios = input.scenarios ?? [{}]
      for (let index = 0; index < scenarios.length && !failure; index += 1) {
        const scenario = scenarios[index]!
        const label = `${index + 1}/${scenarios.length}${scenario.width ? ` ${scenario.width}px` : ' largura atual'}`
        if (scenario.width !== undefined) {
          const viewport = await step(`cenário ${label}: largura`, async () => context.viewport(scenario.width!))
          if (viewport && !viewport.ok) failure = viewport.error
          // Native resize is asynchronous. Confirm the CSS viewport before any
          // click; a short local poll avoids another model round trip or a blind sleep.
          const resizeDeadline = Math.min(deadline, now() + 1_500)
          while (!failure) {
            const measured = await step(`cenário ${label}: largura efetiva`, () => context.driver.viewportSize())
            if (!measured || Math.abs(measured.width - scenario.width) <= 2) break
            if (now() >= resizeDeadline) {
              failure = `largura solicitada ${scenario.width}px, medida ${measured.width}px; este cenário responsivo não foi confirmado. Receita: browser_viewport para conferir a moldura/escala; nenhuma ação deste cenário foi iniciada.`
              break
            }
            await sleep(Math.min(50, Math.max(0, resizeDeadline - now())))
          }
        }
        // Split locally to enforce the overall budget between input actions; no extra model calls.
        for (const [actionIndex, action] of (scenario.actions ?? []).entries()) {
          if (failure) break
          const result = await step(`cenário ${label}: ação ${actionIndex + 1}`, () =>
            context.driver.actResult([action], { detail: 'compact', responseMaxChars: 800 }, { observe: false, deadlineAt: deadline }))
          if (result && !result.ok) failure = result.text
        }
        if (!failure && scenario.wait) {
          const remaining = Math.max(0, deadline - now())
          const result = await step(`cenário ${label}: espera`, () => context.driver.waitResult({
            ...scenario.wait,
            ...(scenario.wait!.ms !== undefined ? { ms: Math.min(scenario.wait!.ms, remaining) } : {}),
            timeoutMs: Math.min(scenario.wait!.timeoutMs ?? 5_000, remaining)
          }))
          if (result && !result.ok) failure = result.text
        }
        for (const target of input.targets) {
          if (failure) break
          const result = await step(`cenário ${label}: ${target.selector}`, () => context.driver.probeResult({ selector: target.selector }))
          if (!result) break
          if (!result.ok || !result.value?.ok) { failure = result.text; break }
          const raw = result.value
          if (scenario.width !== undefined && Math.abs(raw.viewport.w - scenario.width) > 2) {
            failure = `largura solicitada ${scenario.width}px, medida ${raw.viewport.w}px; este cenário responsivo não foi confirmado. Receita: browser_viewport para conferir a moldura/escala e repetir na largura efetiva desejada.`
            break
          }
          const checks = target.checks ?? ['visible']
          const failed = failedAssertions(raw, checks)
          const box = raw.box
          facts.push(`${label} ${target.selector}: ${failed.length ? 'FALHOU ' + failed.join(',') : 'OK ' + checks.join(',')} · caixa ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)} · viewport ${raw.viewport.w}x${raw.viewport.h}`)
          if (failed.length) {
            failure = `${target.selector}: ${failed.join(', ')} não passou. Receita: browser_probe neste alvo para os detalhes; os passos seguintes foram suspensos.`
          }
        }
        if (!failure && input.capture) {
          const result = await step(`cenário ${label}: captura`, () => context.capture({
            ...input.capture,
            name: `${input.capture!.name ?? 'check'}-${scenario.width ?? index + 1}`
          }))
          if (result?.ok !== true || !result.artifact) {
            if (result) failure = result.text
          } else {
            const artifact = result.artifact
            evidence.push(`${artifact.path} — ${artifact.width}x${artifact.height}px · ${artifact.fresh ? 'quadro FRESCO' : 'AVISO: compositor sem pulso; imagem não confirma aparência'}`)
            if (result.image) images.push(result.image)
            else if (input.capture.purpose === 'vision') evidence.push('Abra a imagem pelo caminho com a ferramenta local de imagem para analisar a aparência.')
            if (!artifact.fresh) failure = 'a captura não confirmou frescor; use browser_shot após reabrir o painel BROWSER'
          }
        }
        if (!failure) completedScenarios += 1
      }
    }
  } catch {
    failure = 'o motor não concluiu o passo; use browser_read ou browser_console para recuperar a mesma aba'
  }
  const console = context.driver.consoleSince(checkpoint, { onlyErrors: true })
  if (console.errors > 0 && !failure) { stage = 'console'; failure = `${console.errors} erro(s)/aviso(s) novo(s). Receita: browser_console com onlyErrors:true para investigar.` }
  const summary = `${failure ? `FALHOU em ${stage}: ${failure}` : console.complete ? 'OK nos checks solicitados' : 'Checks dos alvos concluídos; console parcialmente verificado'}\n${completedScenarios}/${(input.scenarios ?? [{}]).length} cenário(s) concluído(s) · ${localSteps} passos locais · uma chamada. Geometria/estado dos alvos; estética e animação exigem análise visual.`
  const consoleLine = `Console: ${console.errors} erro(s)/aviso(s) novo(s) desde o início da verificação${console.complete ? '' : '; cobertura parcial — use browser_console/browser_network'}.`
  const lines = [summary, consoleLine, ...evidence, ...facts]
  const budget = input.responseMaxChars ?? BROWSER_CHECK_DEFAULT_CHARS
  const full = lines.join('\n')
  const suffix = '\n[CORTADO; detalhes: browser_probe nos alvos ou browser_read com detail:"full". Não repetir o roteiro sem mudança, falha ou dúvida concreta.]'
  // Failure recipe precedes optional details, so a small budget cannot erase the stop reason.
  const text = full.length <= budget ? full : full.slice(0, Math.max(0, budget - suffix.length)) + suffix
  return { ok: !failure, text, localSteps, completedScenarios, ...(images.length ? { images } : {}) }
}
