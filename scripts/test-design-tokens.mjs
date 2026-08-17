import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// OS TOKENS SEMÂNTICOS DE COR, medidos contra as superfícies em que são LIDOS.
//
// `--err` não é só paleta: ele é `color:` direto em ~60 regras da folha. Um
// token de texto que não alcança o piso de leitura reprova em toda tela de uma
// vez, e nenhuma suíte de tela pega isso — cada uma mede os próprios seletores
// e o token passa por baixo de todas. Este arquivo prende o CONTRATO do token.
//
// A régua: 4,5:1 (WCAG AA, texto pequeno). Toda superfície aqui carrega texto
// de 9,5-12px; nenhuma alcança a isenção de texto grande.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

const hex = (h) => {
  const v = h.replace('#', '')
  const parts = v.length === 3 ? [...v].map((c) => c + c) : v.match(/../gu)
  return parts.map((c) => parseInt(c, 16) / 255)
}

/** os tokens de cor do `:root` do tema, lidos do próprio arquivo */
function rootTokens(css) {
  const block = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
  const out = {}
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/gu))
    out[`--${name}`] = hex(value)
  return out
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

/** A com alfa `p` sobre um fundo já plano — a conta do `rgba`/`color-mix` */
const over = (fg, p, bg) => fg.map((v, i) => v * p + bg[i] * (1 - p))

const FLOOR = 4.5

test('--err se lê nas superfícies claras', async () => {
  const css = await source('src/renderer/src/global.css')
  const tokens = rootTokens(css)
  const err = tokens['--err']
  assert.ok(err, '--err sumiu do :root')

  // As duas superfícies em que o token é lido CRU: o fundo do app e o cartão.
  // `--paper-2` (a lateral) fica de fora de propósito: ali o vermelho puro dá
  // 4,29:1 e a casa já resolve com uma volta de tinta
  // (`color-mix(var(--err) 80%, var(--ink))`, em `.bl-nv-error` e
  // `.mh-patch-error`). Escurecer o token até passar na lateral também mudaria
  // a cor nas outras duas, onde ela já se lê — a lateral é o caso especial.
  for (const surface of ['--paper', '--card']) {
    const ratio = contrast(err, tokens[surface])
    assert.ok(
      ratio >= FLOOR,
      `--err sobre ${surface}: ${ratio.toFixed(2)}:1 — o piso é ${FLOOR}:1`
    )
  }
})

test('--err-on-dark se lê nos painéis escuros', async () => {
  const css = await source('src/renderer/src/global.css')
  const tokens = rootTokens(css)
  const onDark = tokens['--err-on-dark']
  assert.ok(
    onDark,
    '--err-on-dark sumiu do :root — sem ele o vermelho de papel volta para o painel escuro'
  )

  // `--panel-2` é o mais claro dos escuros: quem passa nele passa nos dois.
  for (const surface of ['--panel', '--panel-2']) {
    const ratio = contrast(onDark, tokens[surface])
    assert.ok(
      ratio >= FLOOR,
      `--err-on-dark sobre ${surface}: ${ratio.toFixed(2)}:1 — o piso é ${FLOOR}:1`
    )
  }

  // A fileira removida do visualizador de commit pinta o próprio fundo com
  // `--err` a 17% sobre `--panel`; o sinal "−" é lido CONTRA esse banho.
  const removeRow = over(tokens['--err'], 0.17, tokens['--panel'])
  const ratio = contrast(onDark, removeRow)
  assert.ok(
    ratio >= FLOOR,
    `--err-on-dark sobre a fileira removida: ${ratio.toFixed(2)}:1 — o piso é ${FLOOR}:1`
  )
})

test('o vermelho antigo não sobrevive em declaração nenhuma da folha', async () => {
  const css = await source('src/renderer/src/global.css')

  // Só DECLARAÇÃO conta. Comentário que nomeia o valor aposentado é a memória
  // da troca — apagá-lo obrigaria o próximo leitor a redescobrir o porquê.
  // Os comentários viram espaço para as linhas continuarem batendo.
  const code = css.replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))

  // Literal que repete um token é drift: ele não acompanha a troca do token e
  // reaparece como a cor velha no meio da paleta nova.
  const stale = []
  code.split(/\r?\n/).forEach((line, i) => {
    if (/#c4453a/iu.test(line) || /rgba\(\s*196\s*,\s*69\s*,\s*58/u.test(line))
      stale.push(`${i + 1}: ${line.trim()}`)
  })
  assert.deepEqual(stale, [], `literais do vermelho antigo continuam na folha:\n${stale.join('\n')}`)
})
