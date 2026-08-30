/**
 * BROWSER EMBUTIDO — A LARGURA QUE A PÁGINA ENXERGA (2026-08-29).
 *
 * A reprovação do dono, ao vivo: *"ta meio limitado o quanto consigo deixar ele
 * maior, meio que sempre vou ver o site/app com modo tablet, ta um pouco
 * diferente de como e hoje no claude code."* O diagnóstico é geométrico: a
 * página renderiza na largura FÍSICA do trilho (~300-500px), então todo site
 * responsivo entrega o layout de celular. Com a moldura em 400px a sonda mediu
 * `innerWidth = 400`, media query **mobile** e o grid em **1 coluna**.
 *
 * ——— A RECEITA, medida em binário real ———
 * `.synkora/reports/PROBE_BROWSER_VIEWPORT_FIT_2026-08-29.md`:
 * **`webContents.setZoomFactor(molduraFísica / larguraLógica)`, SOZINHO.**
 * Numa moldura de 400px pedindo 1280: `innerWidth = 1280`, media query
 * **desktop**, grid em 4 colunas, e o retrato composto pelo SISTEMA OPERACIONAL
 * (desktopCapturer) mostra a borda DIREITA da página dentro da moldura — a
 * largura inteira cabe.
 *
 * As três razões de a escolha ser esta, e não `Emulation.setDeviceMetricsOverride`:
 *  1. **o driver do agente não muda uma linha** — sob zoom, o
 *     `Input.dispatchMouseEvent` continua falando em coordenada LÓGICA (a que sai
 *     do `getBoundingClientRect`), e o mouse do DONO continua falando em
 *     coordenada física da moldura. Sob `Emulation(scale)` o caminho do agente
 *     ERRA o alvo (medido);
 *  2. **a foto não muda de tamanho** — a emulação REDIMENSIONA a superfície da
 *     view, e `capturePage()` passa a devolver um bitmap de 1280px com a página
 *     ocupando 31% dele; sob zoom a captura devolve a moldura com a página
 *     inteira (e em 6-20ms contra 22-24ms);
 *  3. **o motor pode ser o dono da receita** — `setZoomFactor` é API de
 *     `webContents`; `Emulation.*` exigiria o debugger anexado, e o
 *     `browserPane.ts` é, por contrato declarado, um módulo que NÃO conhece CDP.
 *
 * ——— NUNCA COMBINAR OS DOIS (armadilha paga) ———
 * A largura de `setDeviceMetricsOverride` é PRÉ-zoom: override de 1280 mais zoom
 * de 0,3125 entrega **4096** CSS px para a página (medido, estável em 5
 * aplicações). Quem mexer aqui depois: ou zoom, ou emulação — nunca os dois.
 *
 * ——— fronteira ———
 * Módulo PURO: sem Electron, sem CDP, sem estado. Ele só sabe converter
 * (modo, largura da moldura) em número de zoom e em frases honestas. Quem tem
 * abas é o `./browserPane`; quem tem sessão CDP é o `./browserDriver` (que ficou
 * com o `colorScheme`, a única parte de `browser_viewport` que é emulação de
 * verdade). O gate roda este arquivo em node puro.
 */

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

/**
 * O PISO DO CHROMIUM, medido: `setZoomFactor` ACEITA 0,1 e `getZoomFactor`
 * devolve 0,1 — mas o motor renderiza com 0,25. Numa moldura de 300px pedindo
 * 1280, a página recebeu **1200** lógicos (300 ÷ 0,25), não 1280, e nada na API
 * denuncia. É por isso que a largura efetiva tem conta própria (abaixo): quem
 * conta a verdade ao dono precisa contar ESTA.
 */
export const BROWSER_ZOOM_FLOOR = 0.25

/** Teto de segurança. A sonda mediu ampliação EXATA até 3,73× (moldura de
 *  1400px pedindo 375); o preset máximo do Chromium é 500%. */
export const BROWSER_ZOOM_CEILING = 5

/** Zoom é float: comparar por igualdade repintaria a página a cada quadro de um
 *  arrasto. Um passo de 0,1% é bem menor que o menor gesto visível. */
const ZOOM_EPSILON = 0.001

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
 */
export function viewportFitZoom(mode: BrowserViewportMode, frameWidth: number): number {
  if (mode === 'auto') return 1
  if (!Number.isFinite(frameWidth) || frameWidth <= 0) return 1
  const raw = frameWidth / mode
  return Math.min(BROWSER_ZOOM_CEILING, Math.max(BROWSER_ZOOM_FLOOR, raw))
}

/**
 * A largura que a página REALMENTE vai enxergar — que não é a pedida quando o
 * piso de 0,25 morde (moldura mais estreita que `largura ÷ 4`). É esta que o
 * recibo do agente e a dica do dono contam.
 */
export function viewportEffectiveWidth(mode: BrowserViewportMode, frameWidth: number): number {
  const zoom = viewportFitZoom(mode, frameWidth)
  if (mode === 'auto' || !Number.isFinite(frameWidth) || frameWidth <= 0) {
    return Math.max(0, Math.round(frameWidth))
  }
  return Math.round(frameWidth / zoom)
}

/** O piso mordeu? (a moldura é estreita demais para a largura pedida) */
export function viewportIsClamped(mode: BrowserViewportMode, frameWidth: number): boolean {
  if (mode === 'auto' || !Number.isFinite(frameWidth) || frameWidth <= 0) return false
  return viewportEffectiveWidth(mode, frameWidth) !== mode
}

export function sameZoom(a: number, b: number): boolean {
  return Math.abs(a - b) < ZOOM_EPSILON
}

/** A fatia de `WebContents` que o fit usa — só estas duas. É o que deixa o gate
 *  exercitar a receita inteira com um `webContents` de mentira. */
export interface ViewportZoomTarget {
  getZoomFactor(): number
  setZoomFactor(factor: number): void
}

/**
 * Aplica a receita numa aba. Duas decisões que valem o comentário:
 *
 * - **Compara com o valor VIVO** (`getZoomFactor()`), não com uma lembrança
 *   nossa. É leitura barata do processo principal (o `HostZoomMap`, sem IPC), e
 *   é o que faz o fit se CURAR SOZINHO do vazamento por origem: a sonda mediu
 *   que `setZoomFactor` numa aba vaza para toda aba do mesmo host na mesma
 *   sessão (e PARA na fronteira da partition, que na casa é o projeto). Se um
 *   vizinho empurrar o zoom errado, o próximo relato de bounds desta missão o
 *   conserta — a ação é RE-DERIVÁVEL, não uma entrega única.
 * - **Só escreve quando muda.** O relato de geometria chega a cada quadro de um
 *   arrasto de largura; reescrever o mesmo zoom sessenta vezes por segundo é
 *   trabalho puro.
 */
export function applyViewportFit(
  target: ViewportZoomTarget,
  mode: BrowserViewportMode,
  frameWidth: number
): { zoom: number; changed: boolean } {
  const zoom = viewportFitZoom(mode, frameWidth)
  let current = 1
  try {
    current = target.getZoomFactor()
  } catch {
    // aba morrendo entre a decisão e a escrita — o `setZoomFactor` abaixo cai
    // no mesmo catch e o layout seguinte reaplica
    current = Number.NaN
  }
  if (Number.isFinite(current) && sameZoom(current, zoom)) return { zoom, changed: false }
  try {
    target.setZoomFactor(zoom)
  } catch {
    return { zoom, changed: false }
  }
  return { zoom, changed: true }
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
    linhas.push(
      `largura: ${mode}px lógicos — a página acredita ter ${efetiva}px e é ESCALADA (${zoom.toFixed(3)}×) para caber na moldura de ${Math.round(frameWidth)}px.`
    )
    if (viewportIsClamped(mode, frameWidth)) {
      linhas.push(
        `ATENÇÃO: a moldura é estreita demais para ${mode}px — o Chromium não desce de ${BROWSER_ZOOM_FLOOR}× de zoom, então a página recebeu ${efetiva}px, não ${mode}px. Receita: alargue o painel (a alça do dock) ou destaque o browser em janela própria (⧉) e repita.`
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
