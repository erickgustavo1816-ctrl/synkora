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

/** o corpo de uma regra CSS pelo seletor EXATO, ancorado em início de linha —
 *  sem os comentários, que separam declarações e confundem a leitura por
 *  propriedade (`prop` procura a partir do `;` anterior) */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const found = css.match(new RegExp(`\\n${escaped}\\s*\\{([^}]*)\\}`, 'u'))
  assert.ok(found, `regra ausente: ${selector}`)
  return found[1].replace(/\/\*[\s\S]*?\*\//gu, '')
}

/** o valor de uma propriedade dentro de um corpo de regra */
function prop(body, name) {
  const found = body.match(new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+)`, 'u'))
  return found ? found[1].trim() : null
}

/* ---------- contraste: os tokens do :root + color-mix(in srgb) ---------- */

const hex = (value) => {
  const raw = value.replace('#', '')
  const pairs = raw.length === 3 ? [...raw].map((c) => c + c) : raw.match(/../gu)
  return pairs.map((c) => parseInt(c, 16) / 255)
}

function rootTokens(css) {
  const block = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
  const out = {}
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/gu))
    out[`--${name}`] = hex(value)
  return out
}

function resolveColor(expr, tokens) {
  const value = expr.trim()
  const mix = value.match(/^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/u)
  if (mix) {
    const a = resolveColor(mix[1], tokens)
    const pct = Number(mix[2]) / 100
    const b = resolveColor(mix[3], tokens)
    return a.map((v, i) => v * pct + b[i] * (1 - pct))
  }
  const varRef = value.match(/^var\((--[\w-]+)\)$/u)
  if (varRef) {
    assert.ok(tokens[varRef[1]], `token desconhecido no teste: ${varRef[1]}`)
    return tokens[varRef[1]]
  }
  if (value.startsWith('#')) return hex(value)
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

/* ---------- 3. o número da versão que o DONO escreve ---------- */

// Ordem do dono (2026-08-17): "posso colocar um projeto que já esteja na 1.20 e
// não tem como eu controlar isso". As sugestões calculadas (patch/minor/major)
// são ótimas para um produto que nasceu aqui — e inúteis para um que chegou
// pronto, porque elas partem SEMPRE da maior versão que este app conhece.
//
// O que estes testes prendem não é "existe um input": é que a porta nova passa
// pela MESMA régua da antiga e que a recusa CHEGA NA TELA. O `createVersion`
// devolvia `null` para todo motivo — nome duplicado, número abaixo da main,
// campo vazio — e a tela tratava `null` como "não faz nada". Com o número
// digitado à mão isso deixa de ser teórico: o clique não produz versão nenhuma
// e não explica por quê.

test('a lateral aceita um número digitado ao lado das sugestões', async () => {
  const view = await source('src/renderer/src/components/BacklogView.tsx')

  // As sugestões FICAM: um clique continua sendo o caminho de quem começou o
  // produto aqui. O campo é a segunda porta, não a substituta.
  assert.match(view, /nextOptions\.map/u)
  assert.match(view, /className="bl-nv-own"/u)
  assert.match(view, /className="bl-nv-input"/u)

  // Rótulo PERSISTENTE, ligado ao campo: o placeholder é o exemplo ("1.20"),
  // nunca o rótulo — some no primeiro caractere digitado.
  assert.match(view, /htmlFor=\{typedVersionId\}/u)
  assert.match(view, /id=\{typedVersionId\}/u)
  assert.match(view, /placeholder="[^"]*1\.20[^"]*"/u)

  // Enter cria (padrão da casa) e existe um botão visível para quem procura o
  // gesto com o mouse.
  assert.match(view, /onKeyDown=\{\(e\) => e\.key === 'Enter'/u)
  assert.match(view, /disabled=\{!typedVersion\.trim\(\)\}/u)
})

test('o campo do número próprio só existe enquanto o projeto tem ZERO versões', async () => {
  const view = await source('src/renderer/src/components/BacklogView.tsx')

  // REFINAMENTO da ordem (2026-08-17): o campo livre resolve o produto que
  // CHEGA numerado — e só ele. Criada a primeira versão, o app passa a saber de
  // onde contar, e dali em diante o número escrito à mão só serviria para furar
  // a sequência. A régua vem do módulo compartilhado (o modal de missão nova
  // aplica a MESMA), nunca de uma comparação escrita aqui.
  assert.match(
    view,
    /import \{ allowsOwnVersionNumber, versionSuggestions \} from '\.\.\/versionChoice'/u
  )
  assert.match(view, /const nextOptions = versionSuggestions\(versions\)/u)
  assert.match(view, /\{allowsOwnVersionNumber\(versions\) && \(/u)

  // O gate cobre o CAMPO, nunca as sugestões: elas continuam sendo o caminho
  // normal de quem começou o produto aqui.
  const gateAt = view.indexOf('allowsOwnVersionNumber(versions) && (')
  const optionsAt = view.indexOf('nextOptions.map')
  const ownBlockAt = view.indexOf('className="bl-nv-own"')
  assert.ok(optionsAt !== -1 && optionsAt < gateAt, 'as sugestões ficam fora do gate')
  assert.ok(gateAt !== -1 && gateAt < ownBlockAt, 'o campo do número próprio fica dentro do gate')

  // a recusa do main segue FORA do gate: ela também explica um clique numa
  // sugestão recusada, e não pode sumir junto com o campo
  assert.ok(view.indexOf('className="bl-nv-error"') > ownBlockAt)
})

test('a recusa do main chega à tela — nenhuma criação falha em silêncio', async () => {
  const [ipc, view, preload, mock] = await Promise.all([
    source('src/main/ipc/backlog.ts'),
    source('src/renderer/src/components/BacklogView.tsx'),
    source('src/preload/index.ts'),
    source('src/renderer/src/devMock.ts')
  ])

  // MAIN: o handler devolve o motivo, não `null`. `validateNewVersion` continua
  // sendo a régua — a mudança é que a resposta dela viaja.
  assert.match(ipc, /export type CreateVersionResult/u)
  assert.match(ipc, /\{ ok: false; error: string \}/u)
  assert.match(ipc, /const refusal = backlog\.validateNewVersion\(projectId, name\)/u)
  assert.match(ipc, /if \(refusal\) return \{ ok: false, error: refusal \}/u)
  assert.match(ipc, /return \{ ok: true, version \}/u)

  // PONTE: o tipo atravessa o preload (e o preview do browser devolve a mesma
  // forma — um mock que devolvesse `null` quebraria a tela só no navegador).
  assert.match(preload, /createVersion:[\s\S]{0,200}Promise<CreateVersionResult>/u)
  assert.match(mock, /createVersion: async \(\) => \(\{ ok: false, error: /u)

  // TELA: uma porta só para os dois caminhos, e o motivo vira estado visível.
  assert.match(view, /const \[newVersionError, setNewVersionError\] = useState<string \| null>\(null\)/u)
  assert.match(view, /if \(!created\.ok\) \{\s*\r?\n\s*setNewVersionError\(created\.error\)/u)
  assert.match(view, /setSelVersion\(created\.version\.id\)/u)
  assert.match(view, /newVersionError && \(/u)
  assert.match(view, /className="bl-nv-error" role="alert"/u)
  // e o clique nas sugestões usa a MESMA função (nada de segunda criação)
  assert.equal((view.match(/backlog\.createVersion\(/gu) ?? []).length, 1)
})

test('a recusa se apaga quando o dono volta a escrever', async () => {
  const view = await source('src/renderer/src/components/BacklogView.tsx')
  const field = view.match(/className="bl-nv-input"[\s\S]*?\/>/u)
  assert.ok(field, 'o campo do número digitado sumiu')

  // Erro que fica na tela enquanto o texto muda vira ruído: ele descreve um
  // nome que já não está mais ali.
  assert.match(field[0], /setNewVersionError\(null\)/u)
})

test('o bloco de criar versão se lê inteiro — legenda, rótulo, exemplo e recusa', async () => {
  const css = await source('src/renderer/src/global.css')
  const tokens = rootTokens(css)
  // A lateral é `--paper-2`, e é contra ela que tudo aqui se mede.
  const background = tokens['--paper-2']

  // `var(--err)` cru mede 4,29:1 aqui e `--ink-3` mede 2,59:1 — os dois abaixo
  // do piso de 4,5:1 de texto pequeno. A lateral é o fundo mais escuro dos
  // claros: o token passa em `--paper` e no cartão, e só aqui precisa de tinta.
  // O segundo era a legenda do bloco desde sempre; ela deixou de ser decoração
  // no dia em que o bloco passou a ter um campo para preencher.
  for (const selector of ['.bl-nv-error', '.bl-nv-label', '.bl-nv-own-label', '.bl-nv-input::placeholder']) {
    const declared = prop(ruleBody(css, selector), 'color')
    assert.ok(declared, `${selector} precisa declarar a própria cor`)
    const ratio = contrast(resolveColor(declared, tokens), background)
    assert.ok(ratio >= 4.5, `${selector}: ${declared} dá ${ratio.toFixed(2)}:1 — o piso é 4,5:1`)
  }

  // ... e a recusa QUEBRA: "a main já está na V2.0…" não cabe em 280px de coluna
  assert.equal(prop(ruleBody(css, '.bl-nv-error'), 'white-space'), null)
})

test('a linha inerte para de se oferecer ao mouse', async () => {
  const css = await source('src/renderer/src/global.css')

  // precedente da casa: `.ms-main.static` na sub-aba missões
  assert.match(ruleBody(css, '.vs-mission.static'), /cursor:\s*default/u)
  assert.match(ruleBody(css, '.vs-mission.static:hover'), /background:\s*none/u)
  // e a linha VIVA continua respondendo
  assert.match(ruleBody(css, '.vs-mission:hover'), /background:\s*var\(--paper-2\)/u)
})
