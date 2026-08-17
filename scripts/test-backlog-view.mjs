import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// A ABA VERSÕES — as duas superfícies que o `test-archived-chat` não cobria.
//
//  1. o RETRATO POR VERSÃO no topo: era uma faixa que empilhava UMA versão por
//     linha, por construção (grid de 4 trilhas × 4 células por versão);
//  2. a lista "missões desta versão" DENTRO do detalhe: o clique prometia
//     "abrir a aba da missão no board" para toda missão, e a ARQUIVADA levava
//     ao board, que desfazia a navegação no mesmo ciclo.
//
// `test-archived-chat` prende a CLASSIFICAÇÃO (o módulo puro) e a sub-aba
// missões; este arquivo prende a aba Versões. A regra é a mesma nas duas
// superfícies e vive num lugar só (`missionCardAccess.ts`) — o que se testa
// aqui é que esta tela CONSOME a regra em vez de reescrevê-la.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

/**
 * O recorte da lista "missões desta versão". O arquivo inteiro não serve: o
 * `MissionsPane` (sub-aba missões), no mesmo arquivo, já usa a regra — um
 * `assert.match` sobre o arquivo passaria com esta tela intocada. Marcador que
 * não resolve FALHA ALTO.
 */
const REGION_START = 'versionMissions.map('
const REGION_END = 'version.deliveries.length > 0'

function versionMissionsRegion(src) {
  const start = src.indexOf(REGION_START)
  assert.notEqual(start, -1, `marcador inicial sumiu de BacklogView.tsx: ${REGION_START}`)
  const end = src.indexOf(REGION_END, start)
  assert.notEqual(end, -1, `marcador final sumiu de BacklogView.tsx: ${REGION_END}`)
  return src.slice(start, end)
}

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

  // Eram TRÊS tiles (missões · em execução · concluídas). Os dois últimos
  // contavam CARDS, que morreram na purga F6 (2026-08-17) — sem card seriam
  // sempre zero, e número morto na tela é pior que número nenhum. Sobra o de
  // MISSÕES, que é a unidade da era 2.0.
  const tiles = view.match(/<div className="vs-stat-tiles">[\s\S]*?\n {16}<\/div>/u)
  assert.ok(tiles, 'o bloco de tiles do card não foi encontrado')
  assert.equal((tiles[0].match(/className="stat-tile/gu) ?? []).length, 1)
  assert.ok(tiles[0].includes('missões'), 'o tile de missões é o que sobrou')
  assert.doesNotMatch(view, /stat-label">em execução|stat-label">concluídas/u)
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

/* ---------- 2. o clique da lista "missões desta versão" ---------- */

test('o detalhe da versão classifica o clique em TRÊS destinos, como a sub-aba', async () => {
  const region = versionMissionsRegion(await source('src/renderer/src/components/BacklogView.tsx'))

  assert.match(region, /const access = missionCardAccess\(m\)/u)
  assert.match(region, /data-tip=\{MISSION_CARD_TIP\[access\]\}/u)
  assert.match(region, /className=\{`vs-mission\$\{access === 'inert' \? ' static' : ''\}`\}/u)
  // viva vai ao board; encerrada de 2.0 abre a fotografia; inerte NÃO é clique
  assert.match(region, /access === 'live'/u)
  assert.match(region, /setChatViewer\(m\)/u)
  assert.match(region, /:\s+undefined\s*\r?\n\s*\}/u, 'o braço inerte é `undefined`, não um clique morto')

  // A PROMESSA FIXA que mentia: ela dizia "abrir a aba da missão no board"
  // para TODA missão da lista, arquivada inclusive.
  assert.doesNotMatch(region, /data-tip="Abrir a aba da missão no board"/u)
})

test('a regra não foi copiada: as DUAS superfícies montam o mesmo viewer', async () => {
  const view = await source('src/renderer/src/components/BacklogView.tsx')

  // uma ocorrência por superfície (sub-aba missões + detalhe da versão). Contar
  // é o ponto: `assert.match` passaria com só uma delas presente.
  const mounts = view.match(
    /<ArchivedMissionChat mission=\{chatViewer\} onClose=\{closeChatViewer\} \/>/gu
  )
  assert.equal(mounts?.length, 2, 'cada superfície monta o viewer congelado, e as duas iguais')
  assert.equal((view.match(/const \[chatViewer, setChatViewer\]/gu) ?? []).length, 2)

  // nenhuma reimplementação da classificação nesta tela
  assert.doesNotMatch(view, /status !== 'arquivada' \?/u)
  assert.match(view, /import \{ MISSION_CARD_TIP, missionCardAccess \} from '\.\.\/missionCardAccess'/u)
})

test('a linha inerte para de se oferecer ao mouse', async () => {
  const css = await source('src/renderer/src/global.css')

  // precedente da casa: `.ms-main.static` na sub-aba missões
  assert.match(ruleBody(css, '.vs-mission.static'), /cursor:\s*default/u)
  assert.match(ruleBody(css, '.vs-mission.static:hover'), /background:\s*none/u)
  // e a linha VIVA continua respondendo
  assert.match(ruleBody(css, '.vs-mission:hover'), /background:\s*var\(--paper-2\)/u)
})
