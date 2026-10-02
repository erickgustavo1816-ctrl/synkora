/** Pure viewport geometry shared by the dock and per-tab native fitting. */

/** O que a página deve ACREDITAR que mede de largura. `'auto'` é a moldura de
 *  verdade (o comportamento de sempre); um número é largura lógica em CSS px.
 *  Espelho declarado do `BrowserViewportMode` do preload
 *  (`src/preload/index.ts` — o par). */
export type BrowserViewportMode = 'auto' | number

/** Os três botões do chrome. O agente pode pedir qualquer largura (o `width` do
 *  `browser_viewport`), e é por isso que o modo é `número`, não uma união de
 *  três literais: o dono precisa VER no seletor a largura que o agente pôs. */
export const BROWSER_VIEWPORT_PRESETS: readonly number[] = [375, 768, 1280]

/** Fora desta faixa não é largura de página, é engano de digitação. */
export const BROWSER_VIEWPORT_MIN_WIDTH = 320
export const BROWSER_VIEWPORT_MAX_WIDTH = 4000

/** Minimum fitting scale retained by the browser sizing contract. */
export const BROWSER_ZOOM_FLOOR = 0.25

/**
 * O TETO É 1 — NUNCA AMPLIAR (2026-08-29). Havia um teto de 5× aqui, e a sonda
 * mediu que a ampliação funcionava (moldura de 1400px pedindo 375 entregava 375
 * lógicos EXATOS a 3,73×). Ela funcionava e estava ERRADA: um site de celular
 * esticado 3,7× numa janela destacada não parece um celular, parece um site
 * quebrado — e era exatamente essa dúvida ("como vou saber se ta quebrando de
 * vdd ou é o app") que o dono mandou matar. Quando sobra moldura, quem cede é a
 * VIEW (ela fica menor e centralizada), nunca a escala.
 */
export const BROWSER_ZOOM_MAX = 1


/** Um retângulo, no mínimo que esta matemática precisa. Estruturalmente igual ao
 *  `BrowserPanelRect` de `./browserPane` — declarado aqui de propósito, para o
 *  módulo continuar PURO (aquele arquivo importa tipos do Electron). */
export interface ViewportRect {
  x: number
  y: number
  width: number
  height: number
}

/** Largura de moldura vinda de fora, em pixel inteiro e nunca negativa. */
function frameOf(frameWidth: number): number {
  if (!Number.isFinite(frameWidth) || frameWidth <= 0) return 0
  return Math.round(frameWidth)
}

/**
 * Lê o modo de FORA (IPC do dono, tool do agente, estado gravado). Devolve
 * `null` quando não dá para entender — o chamador recusa nomeando a receita, em
 * vez de aplicar um zoom inventado na tela de alguém.
 */
export function normalizeViewportMode(value: unknown): BrowserViewportMode | null {
  if (value === 'auto' || value === null || value === undefined) return 'auto'
  const width = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof width !== 'number' || !Number.isFinite(width)) return null
  const rounded = Math.round(width)
  if (rounded < BROWSER_VIEWPORT_MIN_WIDTH || rounded > BROWSER_VIEWPORT_MAX_WIDTH) return null
  return rounded
}

export function isAutoViewport(mode: BrowserViewportMode): boolean {
  return mode === 'auto'
}

/**
 * O NÚMERO que vai para o `setZoomFactor`. `auto` é 1 (sem escala nenhuma:
 * ligar e desligar o modo não recarrega a página — medido pelo nonce).
 * Moldura sem largura ainda não relatada (o painel fechado, o refúgio) também
 * é 1: escalar contra um retângulo que não existe seria inventar geometria.
 *
 * E **1 é o teto**: quando a largura pedida CABE na moldura, a página fica em
 * tamanho REAL e quem encolhe é a view (`viewportViewWidth`). Ampliar era o
 * defeito que o dono viu na janela destacada.
 */
export function viewportFitZoom(mode: BrowserViewportMode, frameWidth: number): number {
  if (mode === 'auto') return 1
  const frame = frameOf(frameWidth)
  if (frame <= 0) return 1
  const raw = frame / mode
  if (raw >= BROWSER_ZOOM_MAX) return BROWSER_ZOOM_MAX
  return Math.max(BROWSER_ZOOM_FLOOR, raw)
}

/**
 * A largura FÍSICA da view dentro da moldura. Ela é a moldura inteira em `auto`
 * e no ramo que encolhe; quando a largura pedida cabe, ela é EXATAMENTE a
 * pedida — e o que sobra da moldura vira faixa do app.
 */
export function viewportViewWidth(mode: BrowserViewportMode, frameWidth: number): number {
  const frame = frameOf(frameWidth)
  if (mode === 'auto' || frame <= 0) return frame
  return Math.min(frame, mode)
}

/**
 * A FAIXA DE UM LADO, em px. É o deslocamento em x que a view recebe — e o
 * único número honesto sobre "o retângulo da view difere do retângulo da
 * moldura", que é o que o estado leva ao chrome.
 *
 * O pixel ímpar vai para a faixa da DIREITA (`floor`): a decisão precisa existir
 * e precisa ser sempre a mesma, senão a página tremeria meio pixel para os lados
 * conforme a moldura passa de par para ímpar durante um arrasto.
 */
export function viewportBandWidth(mode: BrowserViewportMode, frameWidth: number): number {
  const frame = frameOf(frameWidth)
  const view = viewportViewWidth(mode, frameWidth)
  return Math.max(0, Math.floor((frame - view) / 2))
}

/**
 * O RETÂNGULO DA VIEW dentro da moldura relatada — a conta que os DOIS hosts
 * aplicam (o `applyLayout` do dock e o `applyPopoutLayout` da janela). A altura
 * é sempre a da moldura: o dono pediu faixas dos LADOS, e uma faixa em cima e
 * embaixo só encolheria a página sem responder pergunta nenhuma.
 */
export function viewportViewRect(mode: BrowserViewportMode, frame: ViewportRect): ViewportRect {
  const band = viewportBandWidth(mode, frame.width)
  if (band <= 0) return frame
  return {
    x: Math.round(frame.x) + band,
    y: frame.y,
    width: viewportViewWidth(mode, frame.width),
    height: frame.height
  }
}

/**
 * A largura que a página REALMENTE vai enxergar — que não é a pedida quando o
 * piso de 0,25 morde (moldura mais estreita que `largura ÷ 4`). É esta que o
 * recibo do agente e a dica do dono contam.
 *
 * A conta sai da VIEW, não da moldura: no ramo da moldura de dispositivo a view
 * é menor que a moldura e o zoom é 1, então a página enxerga exatamente a
 * largura pedida (medido: 375 cravados numa moldura de 1400).
 */
export function viewportEffectiveWidth(mode: BrowserViewportMode, frameWidth: number): number {
  const zoom = viewportFitZoom(mode, frameWidth)
  const view = viewportViewWidth(mode, frameWidth)
  return Math.round(view / zoom)
}

/** O piso mordeu? (a moldura é estreita demais para a largura pedida) */
export function viewportIsClamped(mode: BrowserViewportMode, frameWidth: number): boolean {
  if (mode === 'auto' || !Number.isFinite(frameWidth) || frameWidth <= 0) return false
  return viewportEffectiveWidth(mode, frameWidth) !== mode
}

/** Como o modo se escreve na tela e no recibo: `auto` tem nome, largura tem px. */
export function viewportModeLabel(mode: BrowserViewportMode): string {
  return mode === 'auto' ? 'AUTO' : String(mode)
}

/**
 * O RECIBO do `browser_viewport` para o agente — e a razão de ele ser tão
 * falante: sob esta receita a página NÃO está do tamanho da moldura, e um agente
 * que não soubesse disso reportaria ao dono uma medida de `browser_probe` em
 * pixels lógicos como se fosse pixel de tela.
 */
export function viewportReceipt(
  mode: BrowserViewportMode,
  frameWidth: number,
  extras: string[] = []
): string {
  const linhas: string[] = []
  if (mode === 'auto') {
    linhas.push(
      `largura: AUTO — a página volta a medir a moldura de verdade (${Math.round(frameWidth)}px). Nenhuma emulação ativa.`
    )
  } else {
    const efetiva = viewportEffectiveWidth(mode, frameWidth)
    const zoom = viewportFitZoom(mode, frameWidth)
    const band = viewportBandWidth(mode, frameWidth)
    if (band > 0) {
      // MOLDURA DE DISPOSITIVO: a largura pedida CABE, então nada é escalado — a
      // view fica menor que a moldura e o resto é o app. O agente precisa saber
      // disto por dois motivos concretos: `browser_shot` fotografa a PÁGINA (não
      // a moldura com as faixas), e um defeito visto aqui é do SITE, sem a
      // dúvida "será que foi a escala?".
      linhas.push(
        `largura: ${mode}px lógicos em TAMANHO REAL (zoom 1, sem escala nenhuma) — a página ocupa ${mode}px CENTRALIZADOS na moldura de ${Math.round(frameWidth)}px, com ${band}px de faixa do APP de cada lado.`,
        `As faixas são superfície do Synkora, não da página: browser_shot captura ${mode}px (a página), e o que estiver quebrado dentro deles é do SITE.`
      )
    } else {
      linhas.push(
        `largura: ${mode}px lógicos — a página acredita ter ${efetiva}px e é ESCALADA (${zoom.toFixed(3)}×) para caber na moldura de ${Math.round(frameWidth)}px.`
      )
    }
    if (viewportIsClamped(mode, frameWidth)) {
      linhas.push(
        `ATENÇÃO: a moldura é estreita demais para ${mode}px — o ajuste mantém a escala mínima de ${BROWSER_ZOOM_FLOOR}×, então a página recebeu ${efetiva}px, não ${mode}px. Receita: alargue o painel (a alça do dock) ou destaque o browser em janela própria (⧉) e repita.`
      )
    }
  }
  linhas.push(...extras)
  linhas.push(
    'As medidas de browser_probe e as coordenadas de browser_act continuam em pixels LÓGICOS (os que a página enxerga) — não converta nada.',
    'O DONO vê e muda este mesmo modo pelo seletor do chrome do browser (AUTO · 375 · 768 · 1280): é um estado só, compartilhado.'
  )
  return linhas.join('\n')
}
