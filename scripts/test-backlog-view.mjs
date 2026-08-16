import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// A ABA VERSÕES — as duas superfícies que o `test-archived-chat` não cobria.
//
//  1. o RETRATO POR VERSÃO no topo: era uma faixa que empilhava UMA versão por
//     linha, por construção (grid de 4 trilhas × 4 células por versão).

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

/** o corpo de uma regra CSS pelo seletor EXATO, ancorado em início de linha */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const found = css.match(new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`, 'u'))
  assert.ok(found, `regra ausente: ${selector}`)
  return found[1]
}

/* ---------- 1. o retrato por versão é uma GRADE de cards ---------- */

test('cada versão é um CARD — a faixa deixou de empilhar uma por linha', async () => {
  const view = await source('src/renderer/src/components/BacklogView.tsx')

  // O DEFEITO: `<Fragment>` com 4 células soltas dentro de um grid de 4
  // trilhas. 4 células ÷ 4 trilhas = uma versão por linha, sempre — medido em
  // 1600px e em 1280px, uma só.
  assert.match(view, /<div className="vs-stat-card" key=\{v\.name\}>/u)
  assert.match(view, /<div className="vs-stat-tiles">/u)
  assert.doesNotMatch(view, /<Fragment key=\{v\.name\}>/u)
  assert.doesNotMatch(
    view,
    /^import \{ Fragment[,}]/mu,
    'o Fragment saiu do import junto com o último uso'
  )

  // os três tiles continuam sendo os MESMOS (texto e tooltip intocados): a
  // mudança é de forma, não de conteúdo.
  const tiles = view.match(/<div className="vs-stat-tiles">[\s\S]*?\n {16}<\/div>/u)
  assert.ok(tiles, 'o bloco de tiles do card não foi encontrado')
  assert.equal((tiles[0].match(/className="stat-tile/gu) ?? []).length, 3)
  for (const label of ['missões', 'em execução', 'concluídas'])
    assert.ok(tiles[0].includes(label), `tile ausente do card: ${label}`)
})

test('a grade preenche a linha e o card interno divide as trilhas', async () => {
  const css = await source('src/renderer/src/global.css')
  const grid = ruleBody(css, '.vs-stats-grid')

  // auto-fill: quantas versões cabem por fileira é decidido pela LARGURA.
  // Medido depois do fix: 4 a 1600px, 3 na largura nativa (~1280px), 2 a
  // 900px, 1 abaixo de 700px — e zero overflow em todas.
  assert.match(grid, /--vs-card-min:\s*\d+px/u, 'o mínimo do card é um knob com nome')
  assert.match(
    grid,
    /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(var\(--vs-card-min\), 100%\), 1fr\)\)/u
  )
  // o `min(…, 100%)` não é enfeite: sem ele um card de 300px estoura a caixa
  // quando a coluna é menor que isso.
  assert.doesNotMatch(
    grid,
    /grid-template-columns:\s*auto repeat/u,
    'as 4 trilhas fixas voltaram — é elas que empilhavam uma versão por linha'
  )

  // O ALINHAMENTO ENTRE VERSÕES — que era o motivo do Fragment — passa a ser
  // estrutural: irmãos de `1fr` têm a mesma largura, logo as mesmas trilhas.
  assert.match(ruleBody(css, '.vs-stat-tiles'), /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/u)
  assert.match(ruleBody(css, '.vs-stat-card'), /flex-direction:\s*column/u)
  // o nome ocupa a linha inteira do card: ele não disputa mais trilha com os
  // tiles, então centrá-lo verticalmente deixou de fazer sentido.
  assert.doesNotMatch(ruleBody(css, '.vs-stat-name'), /align-self:/u)
})

test('no aperto quem cede é o CARD, não a grade — um @media, não dois', async () => {
  const css = await source('src/renderer/src/global.css')

  // Os dois @media antigos (760px e 520px) só redeclaravam as trilhas da faixa
  // — trilhas que não existem mais. Sobra UM, e ele age sobre o card.
  assert.doesNotMatch(css, /@media \(max-width: 760px\)\s*\{\s*\.vs-stats-grid/u)
  const narrow = css.match(/@media \(max-width: 520px\)\s*\{([\s\S]*?\n\})/u)
  assert.ok(narrow, 'o @media do aperto sumiu')
  assert.match(narrow[1], /\.vs-stats-grid\s*\{[^}]*--vs-card-min:\s*100%/u)
  assert.match(narrow[1], /\.vs-stat-tiles\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/u)
  assert.doesNotMatch(narrow[1], /\.vs-stat-name\s*\{[^}]*grid-column/u)
})
