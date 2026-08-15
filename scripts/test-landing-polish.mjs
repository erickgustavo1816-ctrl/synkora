import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// O ACABAMENTO DA LANDING — as invariantes que o polimento de 2026-08-15 pagou
// e que uma edição futura desfaz SEM QUE NADA QUEBRE na tela.
//
// `test-project-landing` e `test-archived-chat` já prendem a ESTRUTURA (qual
// tela aparece, o que cada linha diz, o que o viewer congelado pode chamar).
// Este arquivo prende o ACABAMENTO, e o item central dele não é string: é o
// PISO DE LEITURA. Antes deste polimento, TODO texto secundário destas telas
// estava entre 2,55:1 e 3,23:1 — e o selo "⇪ esta missão espera VOCÊ", que é a
// coisa mais importante do painel, era o pior de todos, a 1,91:1.
//
// Por isso o teste RESOLVE as cores de verdade (tokens do `:root` + `color-mix`
// em srgb) e calcula o contraste WCAG. Trocar `color-mix(--accent-deep 70%,
// --ink)` de volta por `var(--accent)` volta a passar em qualquer regex e
// reprova aqui, com o número na mensagem.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

/* ---------- resolvedor de cor: tokens do :root + color-mix(in srgb) ---------- */

const hex = (h) => {
  const v = h.replace('#', '')
  const n = v.length === 3 ? [...v].map((c) => c + c) : v.match(/../gu)
  return n.map((c) => parseInt(c, 16) / 255)
}

/** os tokens de cor do `:root` do tema, lidos do próprio arquivo */
function rootTokens(css) {
  const block = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
  const out = {}
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/gu))
    out[`--${name}`] = hex(value)
  return out
}

/** `rgba(r, g, b, a)` sobre um fundo já plano */
const over = (fg, alpha, bg) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha))

/**
 * Resolve `var(--x)`, `#hex`, `rgba(...)` e `color-mix(in srgb, A p%, B)`.
 * Só as formas que estas folhas usam — um resolvedor geral de CSS não é o
 * objetivo, e um que finge ser geral esconde o caso que não cobre.
 */
function resolveColor(expr, tokens, bg) {
  const value = expr.trim()

  const mix = value.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/u)
  if (mix) {
    const a = resolveColor(mix[1], tokens, bg)
    const pct = Number(mix[2]) / 100
    const b = resolveColor(mix[3], tokens, bg)
    return a.map((v, i) => v * pct + b[i] * (1 - pct))
  }

  const rgba = value.match(/^rgba?\(([^)]+)\)$/u)
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => Number(p.trim()))
    const rgb = parts.slice(0, 3).map((v) => v / 255)
    return parts.length > 3 ? over(rgb, parts[3], bg ?? [1, 1, 1]) : rgb
  }

  const varRef = value.match(/^var\((--[\w-]+)\)$/u)
  if (varRef) {
    const token = tokens[varRef[1]]
    assert.ok(token, `token desconhecido no teste: ${varRef[1]}`)
    return token
  }

  if (value.startsWith('#')) return hex(value)
  if (value === 'transparent') return bg ?? [1, 1, 1]
  if (value === 'white') return [1, 1, 1]
  throw new Error(`cor não resolvível pelo teste: ${expr}`)
}

const channel = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
const luminance = (rgb) => {
  const [r, g, b] = rgb.map(channel)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (fg, bg) => {
  const a = luminance(fg)
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** o corpo de uma regra CSS, pelo seletor EXATO (a regra tem de existir) */
function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const found = css.match(new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`, 'u'))
  assert.ok(found, `regra ausente: ${selector}`)
  return found[1]
}

/** o valor de uma propriedade dentro de um corpo de regra */
function prop(body, name) {
  const found = body.match(new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+)`, 'u'))
  return found ? found[1].trim() : null
}

/* ---------- o piso de leitura ---------- */

test('nenhum texto destas telas volta para baixo do piso de leitura', async () => {
  const css = await source('src/renderer/src/global.css')
  const tokens = rootTokens(css)

  const CARD = tokens['--card']
  const PAPER = tokens['--paper']
  // fundo da linha que espera o dono, e do tile de KPI (branco 60% sobre papel)
  const WAITING = resolveColor(prop(rule(css, '.pd-mission.waiting'), 'background'), tokens, CARD)
  const TILE = resolveColor(prop(rule(css, '.stat-tile'), 'background'), tokens, PAPER)

  // [seletor, fundo, piso]. 4,5:1 é o piso de texto pequeno; 3:1 vale só para
  // os NÚMEROS do KPI, que são 20px/700 (texto grande pela régua WCAG).
  const cases = [
    ['.pd-section-title', PAPER, 4.5],
    ['.pd-section-more', PAPER, 4.5],
    ['.pd-empty', PAPER, 4.5],
    ['.pd-meta', CARD, 4.5],
    ['.pd-status', CARD, 4.5],
    ['.pd-status.integrando', CARD, 4.5],
    ['.pd-status.concluida', CARD, 4.5],
    ['.pd-version', PAPER, 4.5],
    ['.pd-version.released', PAPER, 4.5],
    ['.pd-version-count', PAPER, 4.5],
    ['.pd-version-tag', CARD, 4.5],
    ['.pd-queue', CARD, 4.5],
    ['.pd-badge', CARD, 4.5],
    ['.pd-badge.err', CARD, 4.5],
    ['.pd-badge.busy', CARD, 4.5],
    // o selo do dono vive DENTRO da fileira âmbar — medir contra o cartão
    // esconderia exatamente o caso que estava a 1,91:1
    ['.pd-badge.ask', WAITING, 4.5],
    ['.pd-waiting', WAITING, 4.5],
    ['.pd-kpis .stat-label', TILE, 4.5],
    ['.pd-kpis .stat-tile.hot .stat-num', TILE, 3],
    ['.pd-kpis .stat-tile.ok .stat-num', TILE, 3],
    ['.arch-chat-sub', CARD, 4.5],
    ['.arch-chat-glyph', CARD, 4.5],
    ['.arch-chat-head .pane-close', CARD, 4.5],
    ['.arch-chat-empty', PAPER, 4.5]
  ]

  for (const [selector, background, floor] of cases) {
    const body = rule(css, selector)
    const declared = prop(body, 'color')
    assert.ok(declared, `${selector} precisa declarar uma cor de texto`)
    // um selo PREENCHIDO se mede contra o próprio preenchimento
    const fill = prop(body, 'background')
    const bg = fill ? resolveColor(fill, tokens, background) : background
    const ratio = contrast(resolveColor(declared, tokens, bg), bg)
    assert.ok(
      ratio >= floor,
      `${selector}: ${declared} dá ${ratio.toFixed(2)}:1 — o piso é ${floor}:1`
    )
  }
})

test('o selo de "espera você" é o mais forte do painel, não o mais fraco', async () => {
  const css = await source('src/renderer/src/global.css')
  const tokens = rootTokens(css)
  const waitingRow = resolveColor(prop(rule(css, '.pd-mission.waiting'), 'background'), tokens, tokens['--card'])

  // PREENCHIDO, não contornado: contorno âmbar sobre fileira âmbar foi
  // exatamente o 1,91:1 que este polimento matou.
  const ask = rule(css, '.pd-badge.ask')
  const fill = prop(ask, 'background')
  assert.ok(fill, '.pd-badge.ask precisa de preenchimento — só a borda o deixa ilegível')

  const askRatio = contrast(
    resolveColor(prop(ask, 'color'), tokens, waitingRow),
    resolveColor(fill, tokens, waitingRow)
  )
  const metaRatio = contrast(
    resolveColor(prop(rule(css, '.pd-meta'), 'color'), tokens, waitingRow),
    waitingRow
  )
  assert.ok(
    askRatio > metaRatio,
    `o selo (${askRatio.toFixed(2)}:1) tem de ler MAIS forte que os metadados (${metaRatio.toFixed(2)}:1)`
  )
})

/* ---------- o que o mouse e o teclado não podem desfazer ---------- */

test('passar o mouse na linha âmbar não apaga o âmbar', async () => {
  const css = await source('src/renderer/src/global.css')

  // `button.pd-mission:hover` (0,2,1) vence `.pd-mission.waiting` (0,2,0): sem
  // esta regra, o hover repintava de tinta+acento a ÚNICA linha que existe para
  // dizer "a decisão é sua".
  const hover = rule(css, 'button.pd-mission.waiting:hover')
  assert.match(prop(hover, 'border-color'), /--warn/u)
  assert.match(prop(hover, 'border-left-color'), /--warn/u)
  assert.match(prop(hover, 'background'), /--warn/u)
})

test('o anel de foco de papel é o da casa (2px) nas três alavancas', async () => {
  const css = await source('src/renderer/src/global.css')

  for (const selector of [
    'button.pd-mission:focus-visible',
    '.ws-avatar:focus-visible',
    '.arch-chat-head .pane-close:focus-visible'
  ]) {
    assert.match(
      prop(rule(css, selector), 'outline'),
      /^2px solid/u,
      `${selector}: o anel de papel da casa é 2px`
    )
  }

  // o avatar do titlebar vive no painel escuro e segue a regra do .tb-btn (1px
  // clareado) — o contrato do titlebar já exige o anel; aqui só se garante que
  // ele não virou o de papel por engano
  assert.match(prop(rule(css, '.tb-title-avatar:focus-visible'), 'outline'), /^1px solid color-mix/u)
})

test('os dois avatares são a MESMA alavanca: hover no acento, com transição', async () => {
  const css = await source('src/renderer/src/global.css')

  // hover no hue do universo não significa nada e some no caso da FOTO (borda
  // transparente); o acento é a fala de "isto responde ao clique" na casa
  assert.match(prop(rule(css, '.ws-avatar:hover'), 'border-color'), /var\(--accent\)/u)
  assert.match(prop(rule(css, '.tb-title-avatar:hover'), 'border-color'), /--accent/u)
  assert.doesNotMatch(prop(rule(css, '.ws-avatar:hover'), 'border-color'), /card-hue/u)
  assert.doesNotMatch(prop(rule(css, '.tb-title-avatar:hover'), 'border-color'), /card-hue/u)

  for (const selector of ['.ws-avatar', '.tb-title-avatar'])
    assert.match(prop(rule(css, selector), 'transition'), /border-color/u, `${selector} sem transição`)
})

/* ---------- o que a largura estreita não pode engolir ---------- */

test('a pergunta do agente QUEBRA em vez de virar reticências', async () => {
  const css = await source('src/renderer/src/global.css')
  const waiting = rule(css, '.pd-waiting')

  // `white-space: nowrap` cortava "❓ posso apagar a tabela anti…" exatamente
  // onde estava a pergunta que o dono precisa responder.
  assert.equal(prop(waiting, 'white-space'), null, '.pd-waiting não pode voltar a ser nowrap')
  assert.match(prop(waiting, '-webkit-line-clamp'), /^2$/u, 'quebra, mas com teto de 2 linhas')
})

/**
 * O corpo de um `@container`/`@media` achado por CONTEÚDO, com contagem de
 * chaves — âncora por texto vizinho (um comentário logo depois, por exemplo)
 * quebra na primeira reorganização do arquivo e reprova quem não errou.
 */
function atRuleContaining(css, prelude, needle) {
  let from = 0
  for (;;) {
    const start = css.indexOf(prelude, from)
    assert.notEqual(start, -1, `bloco ausente: ${prelude} contendo ${needle}`)
    const open = css.indexOf('{', start)
    let depth = 0
    let i = open
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) break
    }
    const body = css.slice(open + 1, i)
    if (body.includes(needle)) return body
    from = i
  }
}

test('na coluna estreita quem cede é a palavra de estado, nunca o nome da missão', async () => {
  const css = await source('src/renderer/src/global.css')
  const query = atRuleContaining(css, '@container boardcontent (max-width: 480px)', '.pd-kpis')

  // `.pd-status` é flex:none e segurava 74px fixos enquanto o título — a
  // identidade da linha — era cortado em TODAS as linhas a 330px.
  assert.match(query, /\.pd-status\.ativa\s*\{[^}]*display:\s*none/u)
  // só o estado PADRÃO some: "integrando agora" e "integrada" são notícia
  assert.doesNotMatch(query, /\.pd-status\s*\{[^}]*display:\s*none/u)
})

test('o cabeçalho da conversa congelada não gasta uma faixa só com o ×', async () => {
  const css = await source('src/renderer/src/global.css')

  // num flex que QUEBRA, a linha é calculada pelo tamanho hipotético do item:
  // com base `auto` o título reivindicava a largura inteira do próprio texto e
  // empurrava o × para uma linha só dele (132px de cabeçalho a 360px).
  assert.match(prop(rule(css, '.arch-chat-title'), 'flex'), /^1 1 0$/u)
  // legenda e papéis têm faixa própria, nesta ordem
  assert.equal(prop(rule(css, '.arch-chat-sub'), 'flex-basis'), '100%')
  assert.equal(prop(rule(css, '.arch-chat-sub'), 'order'), '1')
  assert.equal(prop(rule(css, '.arch-chat-head .stage-pills'), 'order'), '2')
})

test('o glifo ⊟ tem classe própria para recuar — o nome da missão lidera', async () => {
  const [chat, css] = await Promise.all([
    source('src/renderer/src/components/ArchivedMissionChat.tsx'),
    source('src/renderer/src/global.css')
  ])

  assert.match(chat, /className="arch-chat-glyph" aria-hidden="true"/u)
  assert.match(prop(rule(css, '.arch-chat-glyph'), 'color'), /--ink-2/u)
  // o título tem de continuar maior que a legenda, senão nada lidera
  const titleSize = Number.parseFloat(prop(rule(css, '.arch-chat-title'), 'font-size'))
  const subSize = Number.parseFloat(prop(rule(css, '.arch-chat-sub'), 'font-size'))
  assert.ok(titleSize - subSize >= 2, `título ${titleSize}px x legenda ${subSize}px: passo pequeno demais`)
})

/* ---------- a cadência do espaço ---------- */

test('o painel tem cadência de espaço, não um valor repetido', async () => {
  const css = await source('src/renderer/src/global.css')
  const gap = (selector) => Number.parseFloat(prop(rule(css, selector), 'gap'))

  const row = gap('.pd-mission') // dentro de uma linha
  const list = gap('.pd-list') // entre linhas irmãs
  const section = gap('.pd-section') // do título para a lista dele
  const block = gap('.project-dashboard') // entre blocos

  assert.ok(row < list, `dentro da linha (${row}) tem de ser mais apertado que entre linhas (${list})`)
  assert.ok(
    section >= list + 3,
    `o título de seção (${section}) precisa se destacar do intervalo entre linhas (${list})`
  )
  assert.ok(
    block >= section + 6,
    `blocos (${block}) têm de separar bem mais que título→lista (${section})`
  )
  // craft floor: mais espaço ACIMA de um título do que abaixo dele
  assert.ok(block > section, 'acima do título de seção tem de sobrar mais espaço que abaixo')
})

test('o convite separa a ação da fala em vez de espaçar tudo igual', async () => {
  const css = await source('src/renderer/src/global.css')
  const inner = Number.parseFloat(prop(rule(css, '.pg-start'), 'gap'))
  const toCta = inner + Number.parseFloat(prop(rule(css, '.pg-start-cta'), 'margin-top'))

  assert.ok(
    toCta >= inner * 2,
    `título/texto a ${inner}px e o botão a ${toCta}px: a ação precisa de um degrau próprio`
  )
})

test('os KPIs do painel falam com o acento da casa, não com o hue de uma função', async () => {
  const css = await source('src/renderer/src/global.css')

  // `.stat-tile` é compartilhado com a aba Versões, onde `hot` é pintado pelo
  // hue do DEPARTAMENTO. No ✦ geral não existe função nenhuma: o default 21
  // desenhava um laranja que não é o `--accent` — duas laranjas na mesma tela.
  const hot = rule(css, '.pd-kpis .stat-tile.hot')
  assert.match(prop(hot, 'border-color'), /var\(--accent\)/u)
  assert.doesNotMatch(prop(hot, 'background'), /dept-hue/u)

  // e o tile compartilhado continua intocado para quem o usa por função
  assert.match(prop(rule(css, '.stat-tile.hot'), 'border-color'), /dept-hue/u)
})
