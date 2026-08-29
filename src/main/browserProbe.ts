/**
 * `browser_probe` — A TOOL QUE MATA O QA VISUAL DE 40-50 MIN (H2 do design
 * `.synkora/reports/DESIGN_BROWSER_EMBUTIDO_2026-08-29.md`).
 *
 * O fato que manda neste módulo: **o codex DESCARTA imagem vinda de MCP**
 * (`openai/codex#10334`, aberta; discussão #2085 — pesquisa de mercado §0.2).
 * Um kit de QA screenshot-first quebra metade da frota do dono. Logo, o
 * VEREDITO visual tem de ser FATO EM TEXTO: caixa, contraste calculado,
 * transbordo, corte e oclusão — números que os DOIS CLIs leem igual.
 *
 * A DIVISÃO DE TRABALHO É DELIBERADA e é o que torna esta tool testável sem
 * browser nenhum:
 *
 *   · a PÁGINA só COLETA fatos crus (retângulos, strings de cor computada, a
 *     cadeia de fundos dos ancestrais, quem está no ponto central). Ela não
 *     calcula contraste, não emite veredito e não sabe o que é WCAG;
 *   · o MAIN CALCULA (composição alfa, luminância relativa, razão de
 *     contraste, AA/AAA) e ESCREVE o texto.
 *
 * Isso paga três coisas de uma vez: a matemática roda uma vez só e do lado que
 * a casa controla; a suíte prova o cálculo com fixture sintética (sem subir
 * janela); e um erro de conta nunca vira "a página disse".
 *
 * As fórmulas são as da WCAG 2.x (sRGB → luminância relativa → (L1+0.05) /
 * (L2+0.05)); TEXTO GRANDE é ≥ 24px, ou ≥ 18.66px quando o peso é ≥ 700.
 */

// ———————————————————————————— contrato do módulo ————————————————————————————

export interface BrowserProbeParams {
  ref?: number
  selector?: string
  /** Propriedades computadas extras que o agente quer ver, além do conjunto
   *  base. Nome CSS mesmo (`border-radius`, `z-index`…). */
  styles?: string[]
  /** Injetado pelo driver: a régua do ref velho. */
  epoch?: number
}

export interface ProbeBox {
  x: number
  y: number
  w: number
  h: number
  pageX: number
  pageY: number
}

export interface ProbeClip {
  ancestor: string
  cutTop: number
  cutRight: number
  cutBottom: number
  cutLeft: number
}

export interface ProbeRawOk {
  ok: true
  tag: string
  role: string
  name: string
  box: ProbeBox
  viewport: { w: number; h: number }
  visible: boolean
  inViewport: boolean
  styles: Record<string, string>
  /** cor do TEXTO, como o computed style a entrega */
  color: string
  /** cadeia de `background-color` do elemento para cima, até a primeira
   *  opaca (a última da lista). O main compõe alfa sobre alfa. */
  backgrounds: string[]
  fontSizePx: number
  fontWeight: number
  hasText: boolean
  overflowX: boolean
  overflowY: boolean
  scrollW: number
  clientW: number
  scrollH: number
  clientH: number
  ellipsis: boolean
  clip?: ProbeClip
  occluded: boolean
  occluder: string
}

export interface ProbeRawFail {
  ok: false
  error: string
  stale?: boolean
}

export type BrowserProbeRaw = ProbeRawOk | ProbeRawFail

/** O conjunto BASE de estilos: o que quase toda pergunta de QA precisa. Pedir
 *  mais é `styles`; pedir menos não vale a pena (uma ida do CDP custa o mesmo). */
export const PROBE_BASE_STYLES: readonly string[] = [
  'display',
  'position',
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'line-height',
  'padding',
  'margin',
  'border',
  'border-radius',
  'opacity',
  'z-index',
  'overflow'
]

export const PROBE_MAX_EXTRA_STYLES = 20

// ————————————————————————————— matemática de cor —————————————————————————————

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/**
 * Lê o que o `getComputedStyle` devolve de verdade: `rgb(r, g, b)`,
 * `rgba(r, g, b, a)`, `#rgb`/`#rrggbb` e `transparent`. Chromium normaliza
 * quase tudo para as duas primeiras formas — as outras entram porque o agente
 * pode passar uma cor à mão numa checagem.
 */
export function parseCssColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase()
  if (!value || value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const fn = /^rgba?\(([^)]+)\)$/.exec(value)
  if (fn) {
    const parts = fn[1]!.split(/[,/\s]+/).filter(Boolean).map((p) => Number.parseFloat(p))
    if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts.length > 3 ? parts[3]! : 1 }
  }
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)
  if (hex) {
    const digits = hex[1]!
    const expand = (s: string): number => Number.parseInt(s.length === 1 ? s + s : s, 16)
    if (digits.length === 3 || digits.length === 4) {
      return {
        r: expand(digits[0]!),
        g: expand(digits[1]!),
        b: expand(digits[2]!),
        a: digits.length === 4 ? expand(digits[3]!) / 255 : 1
      }
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: expand(digits.slice(0, 2)),
        g: expand(digits.slice(2, 4)),
        b: expand(digits.slice(4, 6)),
        a: digits.length === 8 ? expand(digits.slice(6, 8)) / 255 : 1
      }
    }
  }
  return null
}

/** Composição "source over": a cor de cima sobre a de baixo. */
export function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mix = (t: number, b: number): number =>
    Math.round((t * top.a + b * bottom.a * (1 - top.a)) / a)
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a }
}

/**
 * A cadeia de fundos vira UMA cor. A lista chega da página de baixo para
 * cima… não: ela chega DO ELEMENTO PARA CIMA, então compomos de trás para
 * frente (o ancestral mais distante é o papel; o mais próximo é a tinta).
 * Fundo que nunca fica opaco cai em BRANCO — é o que o Chromium pinta atrás
 * de uma página sem `background` declarado.
 */
export function effectiveBackground(chain: readonly string[]): Rgba {
  let base: Rgba = { r: 255, g: 255, b: 255, a: 1 }
  for (let i = chain.length - 1; i >= 0; i--) {
    const layer = parseCssColor(chain[i] ?? '')
    if (!layer || layer.a === 0) continue
    base = compositeOver(layer, base)
  }
  return base
}

/** Luminância relativa da WCAG 2.x (sRGB linearizado). */
export function relativeLuminance(color: Rgba): number {
  const channel = (raw: number): number => {
    const c = raw / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
}

/** Razão de contraste (1 a 21), arredondada em duas casas pelo chamador. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const front = foreground.a < 1 ? compositeOver(foreground, background) : foreground
  const l1 = relativeLuminance(front)
  const l2 = relativeLuminance(background)
  const light = Math.max(l1, l2)
  const dark = Math.min(l1, l2)
  return (light + 0.05) / (dark + 0.05)
}

export interface WcagVerdict {
  ratio: number
  large: boolean
  aa: boolean
  aaa: boolean
  /** o piso que ESTE texto tinha de vencer para passar em AA */
  aaFloor: number
}

/** TEXTO GRANDE (WCAG): ≥ 24px, ou ≥ 18.66px com peso ≥ 700. */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700)
}

export function wcagVerdict(ratio: number, fontSizePx: number, fontWeight: number): WcagVerdict {
  const large = isLargeText(fontSizePx, fontWeight)
  return {
    ratio,
    large,
    aa: ratio >= (large ? 3 : 4.5),
    aaa: ratio >= (large ? 4.5 : 7),
    aaFloor: large ? 3 : 4.5
  }
}

// ————————————————————— o coletor que roda NA PÁGINA —————————————————————
//
// Só COLETA. Sem template literal e sem `${` (ele viaja dentro de um), e sem
// nenhuma conta: o veredito é do main.

const PROBE_SCRIPT = `function (p) {
  try {
    var KEY = '__SYNKORA_BROWSER__'
    var store = window[KEY]
    var el = null
    if (p.selector) el = document.querySelector(p.selector)
    else if (p.ref) {
      if (!store || store.epoch !== p.epoch) {
        return { ok: false, stale: true, error: 'os refs desta pagina sao de outra leitura (epoch ' + (store ? store.epoch : 'nenhum') + ')' }
      }
      var found = store.byRef.get(p.ref)
      if (found && found.isConnected) el = found
      else return { ok: false, stale: true, error: 'ref ' + p.ref + ' nao existe mais nesta pagina' }
    }
    if (!el) return { ok: false, error: p.selector ? 'seletor sem correspondencia: ' + p.selector : 'informe ref (do browser_read) ou selector' }

    var cs = window.getComputedStyle(el)
    var r = el.getBoundingClientRect()
    var box = {
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      pageX: Math.round(r.left + window.scrollX), pageY: Math.round(r.top + window.scrollY)
    }
    var styles = {}
    for (var i = 0; i < p.styles.length; i++) {
      var prop = p.styles[i]
      styles[prop] = String(cs.getPropertyValue(prop) || '').trim()
    }

    // cadeia de fundos: do elemento para cima, ate a primeira OPACA
    var backgrounds = []
    var node = el
    while (node && node.nodeType === 1) {
      var bg = window.getComputedStyle(node).backgroundColor
      backgrounds.push(String(bg || ''))
      if (bg && bg.indexOf('rgba(') !== 0) break
      var m = /rgba\\(([^)]+)\\)/.exec(bg || '')
      if (m) {
        var alpha = parseFloat(m[1].split(',')[3])
        if (!isNaN(alpha) && alpha >= 1) break
      }
      node = node.parentElement
    }

    // corte por ancestral com overflow
    var clip = null
    var anc = el.parentElement
    while (anc && anc.nodeType === 1) {
      var acs = window.getComputedStyle(anc)
      if (/hidden|clip|auto|scroll/.test(acs.overflow + ' ' + acs.overflowX + ' ' + acs.overflowY)) {
        var ar = anc.getBoundingClientRect()
        var cutTop = Math.round(Math.max(0, ar.top - r.top))
        var cutLeft = Math.round(Math.max(0, ar.left - r.left))
        var cutBottom = Math.round(Math.max(0, r.bottom - ar.bottom))
        var cutRight = Math.round(Math.max(0, r.right - ar.right))
        if (cutTop || cutLeft || cutBottom || cutRight) {
          clip = {
            ancestor: String(anc.tagName || '').toLowerCase() + (anc.id ? '#' + anc.id : ''),
            cutTop: cutTop, cutRight: cutRight, cutBottom: cutBottom, cutLeft: cutLeft
          }
          break
        }
      }
      anc = anc.parentElement
    }

    var cx = box.x + Math.floor(box.w / 2)
    var cy = box.y + Math.floor(box.h / 2)
    var top = document.elementFromPoint(cx, cy)
    var occluded = false
    var occluder = ''
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      occluded = true
      occluder = String(top.tagName || '').toLowerCase() +
        (top.id ? '#' + top.id : '') +
        (top.className && typeof top.className === 'string'
          ? '.' + top.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')
    }

    var own = ''
    for (var k = 0; k < el.childNodes.length; k++) {
      if (el.childNodes[k].nodeType === 3) own += el.childNodes[k].nodeValue
    }
    own = own.replace(/\\s+/g, ' ').trim()

    var tag = String(el.tagName || '').toLowerCase()
    var role = el.getAttribute('role') || tag
    // O nome existe para o agente RECONHECER o elemento no recibo. Campo de
    // formulario nao tem texto: sem placeholder/name aqui, o cabecalho sairia
    // como 'input <input>' e nao identificaria nada.
    var name = el.getAttribute('aria-label') || el.getAttribute('title') || own ||
      el.getAttribute('placeholder') || el.getAttribute('name') ||
      String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)

    return {
      ok: true,
      tag: tag,
      role: role,
      name: String(name || '').slice(0, 80),
      box: box,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      visible: cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0 && (r.width > 0 || r.height > 0),
      inViewport: r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
      styles: styles,
      color: String(cs.color || ''),
      backgrounds: backgrounds,
      fontSizePx: parseFloat(cs.fontSize) || 0,
      fontWeight: parseInt(cs.fontWeight, 10) || (cs.fontWeight === 'bold' ? 700 : 400),
      hasText: own.length > 0,
      overflowX: el.scrollWidth > el.clientWidth + 1,
      overflowY: el.scrollHeight > el.clientHeight + 1,
      scrollW: el.scrollWidth, clientW: el.clientWidth,
      scrollH: el.scrollHeight, clientH: el.clientHeight,
      ellipsis: cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1,
      clip: clip,
      occluded: occluded,
      occluder: occluder
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}`

/** Monta a expressão que o driver manda para o `Runtime.evaluate`. */
export function buildProbeExpression(params: BrowserProbeParams): string {
  const extra = (params.styles ?? []).slice(0, PROBE_MAX_EXTRA_STYLES)
  const styles = [...new Set([...PROBE_BASE_STYLES, ...extra])]
  const payload = {
    ...(params.ref !== undefined ? { ref: params.ref } : {}),
    ...(params.selector ? { selector: params.selector } : {}),
    epoch: params.epoch ?? 0,
    styles
  }
  return `(${PROBE_SCRIPT})(${JSON.stringify(payload)})`
}

// ————————————————————————————— o recibo em TEXTO —————————————————————————————

function round(value: number, places = 2): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function describeColor(color: Rgba): string {
  return color.a >= 1
    ? `rgb(${color.r}, ${color.g}, ${color.b})`
    : `rgba(${color.r}, ${color.g}, ${color.b}, ${round(color.a)})`
}

/**
 * O VEREDITO EM TEXTO. Cada linha é um fato que o agente pode citar ao dono
 * sem ver pixel nenhum — e é assim que o QA visual deixa de custar meia hora.
 */
export function formatProbeReport(raw: ProbeRawOk): string {
  const lines: string[] = []
  const shape = raw.role && raw.role !== raw.tag ? `${raw.role} <${raw.tag}>` : `<${raw.tag}>`
  lines.push(`${shape}${raw.name ? ` "${raw.name}"` : ''}`)
  lines.push(
    `caixa: x=${raw.box.x} y=${raw.box.y} ${raw.box.w}x${raw.box.h} (na página: ${raw.box.pageX},${raw.box.pageY}) · viewport ${raw.viewport.w}x${raw.viewport.h}`
  )
  lines.push(
    `visível: ${raw.visible ? 'sim' : 'NÃO'} · dentro da viewport: ${raw.inViewport ? 'sim' : 'não (precisa rolar)'}`
  )

  if (raw.hasText) {
    const fg = parseCssColor(raw.color)
    const bg = effectiveBackground(raw.backgrounds)
    if (fg) {
      const verdict = wcagVerdict(contrastRatio(fg, bg), raw.fontSizePx, raw.fontWeight)
      const badge = verdict.aaa ? 'AAA' : verdict.aa ? 'AA' : 'REPROVA em AA'
      lines.push(
        `contraste: ${round(verdict.ratio)}:1 — ${badge} (texto ${
          verdict.large ? 'grande' : 'normal'
        }: ${raw.fontSizePx}px peso ${raw.fontWeight}, piso AA ${verdict.aaFloor}:1)`
      )
      lines.push(`  texto ${describeColor(fg)} sobre fundo efetivo ${describeColor(bg)}`)
      if (raw.backgrounds.length > 1) {
        lines.push(
          `  (o fundo é composto: ${raw.backgrounds.join(' → ')} — o elemento não pinta o próprio fundo)`
        )
      }
      if (!verdict.aa) {
        lines.push(
          `  RECEITA: para passar em AA este par precisa de ${verdict.aaFloor}:1 — escureça o texto, clareie o fundo, ou suba o tamanho/peso da fonte.`
        )
      }
    } else {
      lines.push(`contraste: não calculado — a cor computada veio como "${raw.color}"`)
    }
  }

  if (raw.overflowX || raw.overflowY) {
    const parts: string[] = []
    if (raw.overflowX) parts.push(`horizontal (conteúdo ${raw.scrollW}px em ${raw.clientW}px de caixa)`)
    if (raw.overflowY) parts.push(`vertical (conteúdo ${raw.scrollH}px em ${raw.clientH}px de caixa)`)
    lines.push(`TRANSBORDA: ${parts.join(' e ')}${raw.ellipsis ? ' — e o texto está cortado com reticências' : ''}`)
  } else {
    lines.push('transbordo: nenhum (o conteúdo cabe na caixa)')
  }

  if (raw.clip) {
    const cuts = [
      raw.clip.cutTop ? `${raw.clip.cutTop}px em cima` : '',
      raw.clip.cutRight ? `${raw.clip.cutRight}px à direita` : '',
      raw.clip.cutBottom ? `${raw.clip.cutBottom}px embaixo` : '',
      raw.clip.cutLeft ? `${raw.clip.cutLeft}px à esquerda` : ''
    ].filter(Boolean)
    lines.push(`CORTADO por <${raw.clip.ancestor}> (overflow): ${cuts.join(', ')}`)
  }

  if (raw.occluded) {
    lines.push(
      `COBERTO: no ponto central quem recebe o clique é ${raw.occluder}, não este elemento. Clique daqui vai para o de cima.`
    )
  } else {
    lines.push('oclusão: nenhuma (o ponto central pertence a este elemento)')
  }

  const styleLines = Object.entries(raw.styles)
    .filter(([, value]) => value !== '')
    .map(([prop, value]) => `  ${prop}: ${value}`)
  if (styleLines.length > 0) {
    lines.push('estilos computados:')
    lines.push(...styleLines)
  }
  return lines.join('\n')
}
