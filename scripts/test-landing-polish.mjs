import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// O ACABAMENTO do painel do projeto e da conversa congelada. O item central é
// o PISO DE LEITURA medido de verdade: o teste resolve os tokens (o `:root` do
// tema e os escopados no painel) e o `color-mix(in srgb)`, e calcula o
// contraste WCAG — um regex aceitaria qualquer cor.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const GLOBAL = 'src/renderer/src/global.css'
const PANEL = 'src/renderer/src/components/ProjectDashboard.css'

/* ---------- leitor de folha: regras com seus seletores e o at-rule que as envolve ---------- */

function parseSheet(css) {
  const rules = []
  const walk = (text, at) => {
    let from = 0
    for (;;) {
      const open = text.indexOf('{', from)
      if (open === -1) return
      let depth = 1
      let close = open + 1
      for (; depth > 0 && close < text.length; close++) {
        if (text[close] === '{') depth++
        else if (text[close] === '}') depth--
      }
      const prelude = text.slice(from, open).trim().replace(/\s+/gu, ' ')
      const body = text.slice(open + 1, close - 1)
      if (prelude.startsWith('@')) walk(body, prelude)
      else rules.push({ at, selectors: prelude.split(',').map((s) => s.trim()), body })
      from = close
    }
  }
  walk(css.replace(/\/\*[\s\S]*?\*\//gu, ''), null)
  return rules
}
const sheet = async (path) => parseSheet(await source(path))

function declarations(body) {
  const out = {}
  for (const declaration of body.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon > 0) out[declaration.slice(0, colon).trim()] = declaration.slice(colon + 1).trim()
  }
  return out
}

/** As declarações de um seletor exato, na ordem da cascata. A regra tem de existir. */
function rule(rules, selector, at = null) {
  const found = rules.filter((r) => r.at === at && r.selectors.includes(selector))
  assert.ok(found.length > 0, `regra ausente: ${at ? `${at} ` : ''}${selector}`)
  return Object.assign({}, ...found.map((r) => declarations(r.body)))
}

/* ---------- resolvedor de cor: tokens + color-mix(in srgb) ---------- */

const hex = (h) => {
  const v = h.replace('#', '')
  const n = v.length === 3 ? [...v].map((c) => c + c) : v.match(/../gu)
  return n.map((c) => parseInt(c, 16) / 255)
}

/** o `:root` do tema e os tokens que o painel escopa em `.project-dashboard` */
function themeTokens(global, panel) {
  const tokens = {}
  for (const [name, value] of Object.entries({ ...rule(global, ':root'), ...rule(panel, '.project-dashboard') }))
    if (name.startsWith('--') && /^#[0-9a-f]{3,8}$/iu.test(value)) tokens[name] = hex(value)
  return tokens
}

/** `rgba(r, g, b, a)` sobre um fundo já plano */
const over = (fg, alpha, bg) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha))

/** `none`/`transparent` são reset de <button>: eles não pintam, vale o fundo herdado */
const painted = (background) => Boolean(background) && !/^(none|transparent)$/u.test(background)

/** Só as formas que estas folhas usam: um resolvedor que finge ser geral esconde o caso que não cobre. */
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

/* ---------- o piso de leitura ---------- */

test('nenhum texto do painel e da conversa congelada fica abaixo do piso de leitura', async () => {
  const [global, panel] = await Promise.all([sheet(GLOBAL), sheet(PANEL)])
  const tokens = themeTokens(global, panel)
  const PAPER = tokens['--paper']
  const CARD = tokens['--card']
  const WAITING = resolveColor(rule(panel, '.pd-attn').background, tokens, CARD)
  const HOVER = resolveColor(rule(panel, '.pd-row-open:hover').background, tokens, CARD)

  // [folha, seletor, fundo onde o texto mora, piso]. 4,5:1 é o piso de texto
  // pequeno; o ✓ da linha integrada é ícone e segue o piso de gráfico (3:1).
  const cases = [
    ...[
      '.pd-sub',
      '.pd-sub b',
      '.pd-section-title',
      '.pd-link',
      '.pd-link:hover',
      '.pd-row.open .pd-row-tool',
      '.pd-drawer',
      '.pd-drawer-note.err',
      '.pd-drawer-stats',
      '.pd-ins',
      '.pd-del',
      '.pd-commit-subject',
      '.pd-released-count',
      '.pd-released-titles',
      '.pd-summary dt',
      '.pd-summary dd.zero',
      '.pd-summary .total',
      '.pd-tag',
      '.pd-plan-foot',
      '.pd-plan.done .pd-plan-foot'
    ].map((selector) => [panel, selector, PAPER, 4.5]),
    ...[
      '.pd-pill',
      '.pd-pill.ok',
      '.pd-pill.ask',
      '.pd-pill.err',
      '.pd-card-progress',
      '.pd-empty',
      '.pd-row-meta',
      '.pd-row-tool',
      '.pd-row-tool:hover',
      '.pd-row-done .pd-row-title',
      '.pd-row-when'
    ].map((selector) => [panel, selector, CARD, 4.5]),
    [panel, '.pd-row-meta', HOVER, 4.5],
    [panel, '.pd-row-done svg', CARD, 3],
    ...['.pd-attn-head', '.pd-attn-why', '.pd-attn .btn', '.pd-attn .btn:hover'].map((selector) => [
      panel,
      selector,
      WAITING,
      4.5
    ]),
    [global, '.arch-chat-sub', CARD, 4.5],
    [global, '.arch-chat-glyph', CARD, 4.5],
    [global, '.arch-chat-head .pane-close', CARD, 4.5],
    [global, '.arch-chat-empty', PAPER, 4.5]
  ]

  const below = []
  for (const [rules, selector, background, floor] of cases) {
    const { color, background: fill } = rule(rules, selector)
    assert.ok(color, `${selector} precisa declarar uma cor de texto`)
    const bg = painted(fill) ? resolveColor(fill, tokens, background) : background
    const ratio = contrast(resolveColor(color, tokens, bg), bg)
    if (ratio < floor) below.push(`${selector}: ${color} dá ${ratio.toFixed(2)}:1 — o piso é ${floor}:1`)
  }

  // cor de texto nova no painel não escapa da régua por esquecimento da lista
  const measured = new Set(cases.filter(([rules]) => rules === panel).map(([, selector]) => selector))
  const ornament = new Set(['.pd-sub > span + span::before']) // o "·" entre os fatos não é texto
  const unmeasured = panel
    .filter((r) => r.at === null && /^(var\(|#|color-mix\()/u.test(declarations(r.body).color ?? ''))
    .flatMap((r) => r.selectors)
    .filter((selector) => !measured.has(selector) && !ornament.has(selector))

  assert.deepEqual({ below, unmeasured }, { below: [], unmeasured: [] })
})

test('o selo "espera você" é o mais forte do painel e o único sinal que se mexe', async () => {
  const panel = await sheet(PANEL)
  const ask = rule(panel, '.pd-pill.ask')
  const neutral = rule(panel, '.pd-pill')
  const weight = (box) => Number(box['font-weight'] ?? 400)

  assert.ok(painted(ask.background) && !painted(neutral.background), 'preenchido, não só contornado')
  assert.ok(weight(ask) > weight(neutral), 'o selo do dono pesa mais que o selo neutro')

  const moving = panel
    .filter((r) => r.at === null && declarations(r.body).animation)
    .flatMap((r) => r.selectors)
  assert.deepEqual(moving, ['.pd-dot.ask'], 'movimento é sinal, não enfeite')
  assert.equal(rule(panel, '.pd-dot.ask', '@media (prefers-reduced-motion: reduce)').animation, 'none')
})

/* ---------- o que o mouse e o teclado não podem desfazer ---------- */

test('o botão da faixa âmbar continua âmbar no hover', async () => {
  const panel = await sheet(PANEL)

  // sem esta regra, o `.btn:hover` da casa pinta de tinta o único botão âmbar da tela
  assert.match(rule(panel, '.pd-attn .btn:hover').background, /--pd-warn-ink/u)
  assert.match(rule(panel, '.pd-attn .btn')['border-color'], /--pd-warn-ink/u)
})

test('o anel de foco de papel é o da casa (2px) nas alavancas do painel e dos avatares', async () => {
  const [global, panel] = await Promise.all([sheet(GLOBAL), sheet(PANEL)])

  for (const [rules, selector] of [
    [panel, '.pd-row-open:focus-visible'],
    [panel, '.pd-row-tool:focus-visible'],
    [panel, '.pd-link:focus-visible'],
    [global, '.ws-avatar:focus-visible'],
    [global, '.arch-chat-head .pane-close:focus-visible']
  ])
    assert.match(rule(rules, selector).outline, /^2px solid/u, `${selector}: o anel de papel da casa é 2px`)

  // o avatar do titlebar vive no painel escuro e segue a regra do .tb-btn (1px
  // clareado) — aqui só se garante que ele não virou o de papel por engano
  assert.match(rule(global, '.tb-title-avatar:focus-visible').outline, /^1px solid color-mix/u)
})

test('os dois avatares são a MESMA alavanca: hover no acento, com transição', async () => {
  const global = await sheet(GLOBAL)

  // hover no hue do universo não significa nada e some no caso da FOTO (borda
  // transparente); o acento é a fala de "isto responde ao clique" na casa
  assert.match(rule(global, '.ws-avatar:hover')['border-color'], /var\(--accent\)/u)
  assert.match(rule(global, '.tb-title-avatar:hover')['border-color'], /--accent/u)
  assert.doesNotMatch(rule(global, '.ws-avatar:hover')['border-color'], /card-hue/u)
  assert.doesNotMatch(rule(global, '.tb-title-avatar:hover')['border-color'], /card-hue/u)

  for (const selector of ['.ws-avatar', '.tb-title-avatar'])
    assert.match(rule(global, selector).transition, /border-color/u, `${selector} sem transição`)
})

/* ---------- a conversa congelada ---------- */

test('o cabeçalho da conversa congelada não gasta uma faixa só com o ×', async () => {
  const global = await sheet(GLOBAL)

  // num flex que QUEBRA, a linha é calculada pelo tamanho hipotético do item:
  // com base `auto` o título reivindicava a largura inteira do próprio texto e
  // empurrava o × para uma linha só dele (132px de cabeçalho a 360px).
  assert.match(rule(global, '.arch-chat-title').flex, /^1 1 0$/u)
  // legenda e papéis têm faixa própria, nesta ordem
  assert.equal(rule(global, '.arch-chat-sub')['flex-basis'], '100%')
  assert.equal(rule(global, '.arch-chat-sub').order, '1')
  assert.equal(rule(global, '.arch-chat-head .stage-pills').order, '2')
})

test('o glifo ⊟ tem classe própria para recuar — o nome da missão lidera', async () => {
  const [chat, global] = await Promise.all([
    source('src/renderer/src/components/ArchivedMissionChat.tsx'),
    sheet(GLOBAL)
  ])

  assert.match(chat, /className="arch-chat-glyph" aria-hidden="true"/u)
  assert.match(rule(global, '.arch-chat-glyph').color, /--ink-2/u)
  // o título tem de continuar maior que a legenda, senão nada lidera
  const titleSize = Number.parseFloat(rule(global, '.arch-chat-title')['font-size'])
  const subSize = Number.parseFloat(rule(global, '.arch-chat-sub')['font-size'])
  assert.ok(titleSize - subSize >= 2, `título ${titleSize}px x legenda ${subSize}px: passo pequeno demais`)
})

/* ---------- a cadência do espaço ---------- */

test('o painel tem cadência de espaço, não um valor repetido', async () => {
  const panel = await sheet(PANEL)
  const px = (value) => Number.parseFloat(value)
  const bottom = (margin) => {
    const sides = margin.split(/\s+/u)
    return sides[sides.length > 2 ? 2 : 0]
  }

  const inRow = px(rule(panel, '.pd-row-text').gap)
  const titleToList = px(bottom(rule(panel, '.pd-section-title').margin))
  const betweenBlocks = px(rule(panel, '.pd-main').gap)

  assert.ok(inRow < titleToList, `dentro da linha (${inRow}) tem de ser mais apertado que título→lista (${titleToList})`)
  assert.ok(
    betweenBlocks >= 2 * titleToList,
    `acima de um título de seção (${betweenBlocks}) tem de sobrar bem mais espaço que abaixo dele (${titleToList})`
  )
})

test('o convite separa a ação da fala em vez de espaçar tudo igual', async () => {
  const global = await sheet(GLOBAL)
  const inner = Number.parseFloat(rule(global, '.pg-start').gap)
  const toCta = inner + Number.parseFloat(rule(global, '.pg-start-cta')['margin-top'])

  assert.ok(
    toCta >= inner * 2,
    `título/texto a ${inner}px e o botão a ${toCta}px: a ação precisa de um degrau próprio`
  )
})

/* ---------- a largura: o trabalho enche a coluna, a lateral tem medida ---------- */

test('o painel não tem teto de largura: a coluna do trabalho estica, a lateral tem medida', async () => {
  const panel = await sheet(PANEL)

  assert.equal(rule(panel, '.project-dashboard')['max-width'], undefined)
  assert.match(rule(panel, '.pd-body')['grid-template-columns'], /^minmax\(0, 1fr\) \d+px$/u)
})

test('folha estreita empilha a lateral embaixo, na ordem de leitura', async () => {
  const panel = await sheet(PANEL)
  const stacked = panel.find(
    (r) => r.selectors.includes('.pd-body') && declarations(r.body)['grid-template-columns'] === 'minmax(0, 1fr)'
  )
  assert.ok(stacked?.at, 'a coluna única só vale dentro de um @container')

  // a cadeia do board é `janela − 32 − 240 − 12`: a janela de 1280 entrega
  // 996px ao container e tem de continuar em duas colunas
  const breakpoint = Number(stacked.at.match(/^@container boardcontent \(max-width: (\d+)px\)$/u)?.[1])
  assert.ok(breakpoint < 996, `a folha empilha abaixo de ${breakpoint}px`)
  const side = rule(panel, '.pd-side', stacked.at)
  assert.equal(side['border-left'], '0')
  assert.match(side['border-top'], /^1px solid/u)

  assert.ok(
    panel.every((r) => !r.selectors.includes('.pd-rows') || declarations(r.body).display !== 'grid'),
    'a lista de missões nunca vira grade de fileiras lado a lado'
  )
})

/* ---------- versão e faixa: a forma do mockup aprovado ---------- */

test('a versão é cartão de linha fina e a faixa âmbar não tem barra grossa', async () => {
  const panel = await sheet(PANEL)
  const card = rule(panel, '.pd-card')
  const waiting = rule(panel, '.pd-attn')

  assert.equal(card.border, '1px solid var(--line)')
  assert.equal(card['box-shadow'], undefined, 'o cartão não levita')
  assert.match(waiting.border, /^1px solid/u)
  for (const box of [card, waiting])
    assert.deepEqual(
      Object.keys(box).filter((name) => /^border-(left|width)/u.test(name)),
      []
    )
})

test('a barra da versão é instrumento: trilho medido, preenchida na tinta do sucesso', async () => {
  const panel = await sheet(PANEL)

  assert.match(rule(panel, '.pd-bar').width, /^\d+px$/u)
  assert.equal(rule(panel, '.pd-bar > span').background, 'var(--ok)')
})

test('a pergunta do agente QUEBRA em até duas linhas em vez de virar reticências', async () => {
  const why = rule(await sheet(PANEL), '.pd-attn-why > span')

  // nowrap cortava "posso apagar a tabela anti…" exatamente onde estava a pergunta
  assert.equal(why['white-space'], undefined)
  assert.equal(why['text-overflow'], undefined)
  assert.equal(why['-webkit-line-clamp'], '2')
})

test('no modo palco quem cede é o selo padrão, nunca o nome da missão', async () => {
  const panel = await sheet(PANEL)
  const at = '@container boardcontent (max-width: 480px)'

  assert.equal(rule(panel, '.pd-row-open', at)['grid-template-columns'], '16px minmax(0, 1fr)')
  assert.equal(rule(panel, '.pd-row-open .pd-pill', at)['grid-column'], '2')
  assert.equal(rule(panel, '.pd-row-open .pd-pill.quiet', at).display, 'none')
  assert.equal(rule(panel, '.pd-row-done .pd-row-when', at)['grid-column'], '2')

  // só o estado padrão ("em andamento", que o ponto já diz) é quieto: notícia fica
  const row = await source('src/renderer/src/components/MissionDashboardRow.tsx')
  assert.match(row, /ok: ' quiet'/u)
  assert.doesNotMatch(row, /(ask|err|busy): ' quiet'/u)
})
