/**
 * AS AÇÕES DO AGENTE NA PÁGINA — `browser_act` (fatia H2 do design
 * `.synkora/reports/DESIGN_BROWSER_EMBUTIDO_2026-08-29.md`).
 *
 * LEI 3 DO MOTOR: **ação já observa.** Uma chamada leva UMA ação ou uma LISTA
 * sequencial, para no primeiro erro e devolve SEMPRE a leitura pós-ação. O
 * número que justifica isso está medido no mercado (`playwright-mcp#1639`):
 * devolver o snapshot na própria ação cortou **40% das tool calls, 39% dos
 * snapshots explícitos e 26% do custo**, com o modelo encadeando até 13 ações
 * sem um passo de observação. Um formulário de dez campos é UMA ida.
 *
 * Módulo separado do `browserDriver` porque é outra pergunta: o driver sabe
 * FALAR CDP com uma aba; este sabe TRADUZIR intenção em evento de entrada —
 * ponteiro, teclado e as três ações que o DOM resolve melhor que o
 * `Input.dispatch*` (select/fill/clear, onde o valor precisa entrar pelo
 * setter nativo para que `input`/`change` subam e o React escute).
 *
 * Ele não conhece Electron nem CDP: recebe um contexto com quatro verbos, o
 * que deixa a suíte provar o lote inteiro (inclusive "para no primeiro erro")
 * sem subir janela nenhuma.
 */
import {
  describeTarget,
  type PageActKind,
  type PageResolveResult
} from './browserPageScript'
import { boundBrowserText, browserBound, BROWSER_RESPONSE_DEFAULT_MAX_CHARS } from './browserObservation'

export type BrowserActionKind =
  | 'click'
  | 'double_click'
  | 'right_click'
  | 'hover'
  | 'type'
  | 'press'
  | 'scroll'
  | 'select'
  | 'fill'
  | 'clear'

export interface BrowserAction {
  action: BrowserActionKind
  ref?: number
  selector?: string
  x?: number
  y?: number
  text?: string
  key?: string
  value?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  clear?: boolean
}

/** Teto de passos numa lista. É trava contra laço, não orçamento. */
export const BROWSER_ACT_MAX_STEPS = 24

/**
 * `Input.insertText` é o caminho rápido de digitação (é o que Puppeteer e
 * Playwright usam) mas NÃO foi sondado neste Electron. O estado vive na sessão
 * e é passado por referência: na primeira recusa caímos para tecla-a-tecla
 * pelo caminho que P6 provou, e nunca mais tentamos. A regra da casa é sondar
 * antes de afirmar — sem sonda, degrada-se em vez de quebrar.
 */
export interface BrowserInputCapabilities {
  insertText: boolean
}

export interface BrowserActionContext {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  /** ref/seletor → ponto na viewport, com a cerca do epoch já aplicada. */
  resolve(
    step: BrowserAction,
    act: PageActKind | undefined
  ): Promise<PageResolveResult | { error: string }>
  /** Dois quadros e um respiro, com teto curto (painel oculto estrangula rAF). */
  settle(): Promise<void>
  /** A leitura pós-ação — o produto final desta tool. */
  read(responseMaxChars?: number): Promise<string>
  capabilities: BrowserInputCapabilities
  log(entry: { event: string; err?: string }): void
}

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  shift: 8
}

const KEY_CODES: Record<string, { code: number; text?: string; key: string }> = {
  enter: { code: 13, text: '\r', key: 'Enter' },
  tab: { code: 9, key: 'Tab' },
  escape: { code: 27, key: 'Escape' },
  esc: { code: 27, key: 'Escape' },
  backspace: { code: 8, key: 'Backspace' },
  delete: { code: 46, key: 'Delete' },
  arrowup: { code: 38, key: 'ArrowUp' },
  arrowdown: { code: 40, key: 'ArrowDown' },
  arrowleft: { code: 37, key: 'ArrowLeft' },
  arrowright: { code: 39, key: 'ArrowRight' },
  home: { code: 36, key: 'Home' },
  end: { code: 35, key: 'End' },
  pageup: { code: 33, key: 'PageUp' },
  pagedown: { code: 34, key: 'PageDown' },
  space: { code: 32, text: ' ', key: ' ' }
}

export interface KeyChord {
  modifiers: number
  key: string
  code: number
  text?: string
}

/**
 * "Ctrl+Shift+Enter" → máscara de modificadores + a tecla final. Com qualquer
 * modificador que não seja Shift, o evento vai SEM texto: mandar texto junto
 * de Ctrl faria a página receber o caractere além do atalho.
 */
export function parseKeyChord(chord: string): KeyChord | null {
  const parts = chord.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  let modifiers = 0
  while (parts.length > 1) {
    const bit = MODIFIER_BITS[parts[0]!.toLowerCase()]
    if (bit === undefined) break
    modifiers |= bit
    parts.shift()
  }
  const last = parts.join('+')
  const known = KEY_CODES[last.toLowerCase()]
  if (known) {
    return {
      modifiers,
      key: known.key,
      code: known.code,
      ...(known.text !== undefined ? { text: known.text } : {})
    }
  }
  if (last.length === 1) {
    return {
      modifiers,
      key: last,
      code: last.toUpperCase().charCodeAt(0),
      ...(modifiers & ~8 ? {} : { text: last })
    }
  }
  return null
}

/** Digitação com plano B (ver `BrowserInputCapabilities`). */
async function typeText(ctx: BrowserActionContext, value: string): Promise<void> {
  if (!value) return
  if (ctx.capabilities.insertText) {
    try {
      await ctx.send('Input.insertText', { text: value })
      return
    } catch (error) {
      ctx.capabilities.insertText = false
      ctx.log({ event: 'browser-inserttext-off', err: String(error) })
    }
  }
  for (const char of value) {
    await ctx.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char })
    await ctx.send('Input.dispatchKeyEvent', { type: 'keyUp', key: char })
  }
}

async function pressKey(ctx: BrowserActionContext, chord: KeyChord): Promise<void> {
  const base = {
    modifiers: chord.modifiers,
    key: chord.key,
    windowsVirtualKeyCode: chord.code,
    nativeVirtualKeyCode: chord.code
  }
  await ctx.send('Input.dispatchKeyEvent', {
    ...base,
    type: chord.text ? 'keyDown' : 'rawKeyDown',
    ...(chord.text ? { text: chord.text } : {})
  })
  await ctx.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

/** Executa UM passo. Devolve o recibo (texto) ou a falha que para o lote. */
export async function runBrowserAction(
  ctx: BrowserActionContext,
  step: BrowserAction
): Promise<string | { error: string }> {
  const kind = step.action

  // As três que o DOM resolve melhor que o Input.dispatch*: o valor entra pelo
  // setter nativo e os eventos `input`/`change` sobem — é o que React escuta.
  if (kind === 'select' || kind === 'fill' || kind === 'clear') {
    const target = await ctx.resolve(step, kind)
    if ('error' in target) return target
    const suffix =
      kind === 'clear' ? '' : ` = "${String(step.value ?? step.text ?? '').slice(0, 60)}"`
    return `${kind} em ${describeTarget(target)}${suffix}`
  }

  if (kind === 'press') {
    const chord = parseKeyChord(step.key ?? '')
    if (!chord) {
      return {
        error: `tecla desconhecida: "${step.key ?? ''}". Receita: use nomes como Enter, Tab, Escape, ArrowDown, Ctrl+A, ou um único caractere.`
      }
    }
    if (step.ref !== undefined || step.selector) {
      const focus = await ctx.resolve(step, 'focus')
      if ('error' in focus) return focus
    }
    await pressKey(ctx, chord)
    return `press ${step.key}`
  }

  if (kind === 'type') {
    if (step.ref !== undefined || step.selector) {
      const target = await ctx.resolve(step, step.clear ? 'clear' : 'focus')
      if ('error' in target) return target
      await typeText(ctx, step.text ?? '')
      return `type "${String(step.text ?? '').slice(0, 40)}" em ${describeTarget(target)}`
    }
    await typeText(ctx, step.text ?? '')
    return `type "${String(step.text ?? '').slice(0, 40)}" no elemento com foco`
  }

  // As demais são de PONTEIRO: precisam de um ponto na viewport.
  let x = step.x
  let y = step.y
  let label = `(${x}, ${y})`
  let warning = ''
  if (step.ref !== undefined || step.selector) {
    const target = await ctx.resolve(step, undefined)
    if ('error' in target) return target
    x = target.x
    y = target.y
    label = describeTarget(target)
    // Nenhum dos dois RECUSA a ação: o dono clicando teria o mesmo desfecho, e
    // recusar aqui esconderia o fato. O recibo conta a verdade e segue.
    if (target.disabled) warning = ' — ATENÇÃO: o elemento está desabilitado'
    if (target.occluded) {
      warning = ` — ATENÇÃO: o ponto central está COBERTO por ${target.occluder}; o evento foi para quem está por cima (é o que aconteceria com o dono clicando)`
    }
  }
  if (x === undefined || y === undefined) {
    return { error: `${kind} sem alvo: informe \`ref\` (do browser_read) ou \`x\`/\`y\`.` }
  }

  if (kind === 'scroll') {
    const amount = step.amount ?? 400
    // Sem `direction`, rola PARA BAIXO — que é o que "role a página" significa
    // em 99% dos casos. Cair em zero seria uma ação que não faz nada e devolve
    // um recibo de sucesso: a pior combinação possível.
    const direction = step.direction ?? 'down'
    const horizontal = direction === 'left' || direction === 'right'
    const delta = direction === 'up' || direction === 'left' ? -amount : amount
    await ctx.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: horizontal ? delta : 0,
      deltaY: horizontal ? 0 : delta,
      pointerType: 'mouse'
    })
    return `scroll ${direction} ${amount}px em ${label}`
  }
  if (kind === 'hover') {
    await ctx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' })
    return `hover em ${label}${warning}`
  }

  const button = kind === 'right_click' ? 'right' : 'left'
  const clickCount = kind === 'double_click' ? 2 : 1
  await ctx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' })
  for (let n = 1; n <= clickCount; n++) {
    await ctx.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: button === 'right' ? 2 : 1,
      clickCount: n,
      pointerType: 'mouse'
    })
    await ctx.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: n,
      pointerType: 'mouse'
    })
  }
  return `${kind} em ${label}${warning}`
}

/**
 * The normal batch observes once after its last action. A deterministic
 * browser_check may defer successful observations; failures always observe.
 */
export interface BrowserActionsResult {
  ok: boolean
  text: string
  completed: number
  total: number
  /** One-based, present only when a particular action failed. */
  failedStep?: number
  error?: string
  observation?: string
}

export interface BrowserActionExecutionOptions {
  /** A deterministic check can observe once after several successful batches. */
  observe?: boolean
  responseMaxChars?: number
  /** Absolute local deadline. Checked before every input event and resolve. */
  deadlineAt?: number
}

export async function runBrowserActionsResult(
  ctx: BrowserActionContext,
  actions: BrowserAction[],
  options: BrowserActionExecutionOptions = {}
): Promise<BrowserActionsResult> {
  if (actions.length === 0) {
    const error = 'nenhuma ação pedida — informe pelo menos uma.'
    return { ok: false, text: error, error, completed: 0, total: 0 }
  }
  if (actions.length > BROWSER_ACT_MAX_STEPS) {
    const error = `lista de ${actions.length} passos acima do teto de ${BROWSER_ACT_MAX_STEPS}. Receita: quebre em duas chamadas de browser_act.`
    return { ok: false, text: error, error, completed: 0, total: actions.length }
  }
  const budget = browserBound(options.responseMaxChars, BROWSER_RESPONSE_DEFAULT_MAX_CHARS, 500, 32_000)
  const expired = (): boolean => Number.isFinite(options.deadlineAt) && Date.now() >= options.deadlineAt!
  const deadlineError = 'prazo da verificação atingido; nenhum novo evento será enviado. Receita: chame browser_read para verificar o estado atual antes de retomar.'
  const assertWithinDeadline = (): void => { if (expired()) throw new Error(deadlineError) }
  const boundedContext: BrowserActionContext = {
    ...ctx,
    send: (method, params) => { assertWithinDeadline(); return ctx.send(method, params) },
    resolve: (step, act) => { assertWithinDeadline(); return ctx.resolve(step, act) }
  }
  const done: string[] = []
  let failure: string | undefined
  for (let i = 0; i < actions.length; i++) {
    try {
      assertWithinDeadline()
      const receipt = await runBrowserAction(boundedContext, actions[i]!)
      if (typeof receipt === 'string') {
        done.push(`${i + 1}. ${receipt}`)
        continue
      }
      failure = receipt.error || 'a ação falhou sem detalhe. Receita: chame browser_read antes de retomar.'
    } catch (error) {
      failure = `falha em ${actions[i]!.action}: ${String(error)}. Receita: chame browser_read e confira browser_console antes de retomar.`
    }
    break
  }
  let settleFailure: string | undefined
  if (!expired()) {
    try { await ctx.settle() } catch (error) { settleFailure = String(error) }
  }
  if (expired() && !failure) settleFailure = deadlineError
  const head = boundBrowserText(failure
    ? `PAROU no passo ${done.length + 1} de ${actions.length} — os passos seguintes NÃO rodaram.\n${done.length + 1}. ${failure}`
    : `${actions.length} ação(ões) executada(s):`, Math.min(600, Math.floor(budget / 3)))
  const receiptBudget = Math.max(0, Math.min(450, Math.floor(budget / 5), budget - head.length - 240))
  const receipts = done.length ? boundBrowserText(done.join('\n'), receiptBudget, 'recibos resumidos; passos executados no total acima') : ''
  let text = `${head}${receipts ? '\n' + receipts : ''}`
  let observation: string | undefined
  let observationFailure = settleFailure
  if (options.observe !== false || failure || settleFailure) {
    const separator = '\n\n— a página DEPOIS da(s) ação(ões) —\n'
    const remaining = Math.max(100, budget - text.length - separator.length)
    if (expired()) {
      observationFailure = deadlineError
      observation = 'Leitura posterior não realizada: prazo da verificação atingido. Receita: chame browser_read para obter uma observação atual; este recibo não confirma o estado final da página.'
    } else {
      try { observation = await ctx.read(remaining) } catch (error) {
        observationFailure = String(error)
        observation = `não consegui ler a página depois das ações: ${observationFailure}. Receita: chame browser_read para verificar o estado atual.`
      }
    }
    // Compatibility contexts may ignore the budget; still bound their output.
    observation = boundBrowserText(observation, remaining)
    text += separator + observation
  }
  return {
    ok: !failure && !observationFailure, text, completed: done.length, total: actions.length,
    ...(failure ? { failedStep: done.length + 1, error: failure } : observationFailure ? { error: observationFailure } : {}),
    ...(observation !== undefined ? { observation } : {})
  }
}

/** Backward-compatible text entry point; the typed outcome drives checks. */
export async function runBrowserActions(ctx: BrowserActionContext, actions: BrowserAction[]): Promise<string> {
  return (await runBrowserActionsResult(ctx, actions)).text
}
