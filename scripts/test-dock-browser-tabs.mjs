#!/usr/bin/env node
/**
 * ABA POR IDENTIDADE — a metade do RENDERER (fatia C do design
 * `.synkora/reports/DESIGN_BROWSER_ABAS_POR_IDENTIDADE_2026-09-01.md`).
 *
 * ORDEM DO DONO (2026-09-01): *"queria que [os ajudantes] utilizassem o browser
 * caso quisessem, CADA UM NA SUA ABA, na sua porta"*.
 *
 * O PREÇO MEDIDO de não ter isto (missão 86a05c06, 01/09): o único ajudante que
 * dirigiu o browser dividiu a MESMA aba com o dev — a URL alternou entre a porta
 * dele e as do dev em minutos, TRÊS leituras do ajudante caíram na página do
 * dev, e o dev o cancelou aos 20 minutos. O motor (fatia A) passa a dar uma aba
 * por identidade; esta suíte prende a metade que o DONO vê: a tira de abas tem
 * de dizer DE QUEM é cada aba, e QUEM está dirigindo agora.
 *
 * Por que ela existe separada da `test:browser-pane`: aquela suíte tem a metade
 * MOTOR junto (ela compila `src/main/browserPane.ts` antes de rodar), e esta
 * fatia não toca no main. Aqui é node puro sobre o módulo puro do painel — sem
 * React, sem DOM, sem Electron.
 *
 * O import é por NAMESPACE, e não nomeado, DE PROPÓSITO: um import nomeado que
 * ainda não existe é erro de LINK — o arquivo inteiro morre antes do primeiro
 * teste, e a prova vermelha desta rodada
 * (`.synkora/reports/browser-tabs-agent-C-red-proof.txt`) não mostraria cada lei
 * falhando por conta própria. Assim cada teste falha na SUA asserção no código
 * velho, que é o que a regra da casa pede ("teste novo tem de FALHAR
 * comprovadamente no código velho").
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import * as model from '../src/renderer/src/dockBrowserModel.ts'

const {
  BROWSER_TAB_CAP,
  browserSectionSummary,
  browserTabOwnerPhrase,
  browserTabOwnerTag,
  normalizeBrowserPanel,
  sameBrowserPanel,
  tabCapNotice
} = model

/** Uma aba crua do motor, como ela chega no `browser:changed`. */
const tab = (over = {}) => ({
  tabId: 't1',
  title: '',
  url: '',
  active: true,
  loading: false,
  canBack: false,
  canForward: false,
  ...over
})

const dono = (over = {}) => tab({ title: 'Board · Synkora', ...over })
const doDev = (over = {}) =>
  tab({ tabId: 'dev', title: 'localhost:5173', owner: { kind: 'dev', label: 'dev', paneId: 'gui:dev' }, ...over })
const doAjudante = (name = 'inv-brand', over = {}) =>
  tab({
    tabId: `h-${name}`,
    title: 'QA visual',
    owner: { kind: 'helper', label: name, paneId: `helper-mcp-${name}` },
    ...over
  })

const painel = (tabs, over = {}) => normalizeBrowserPanel({ alive: true, tabs, ...over })

test('ABAS: o DONO da aba atravessa o espelho — presente, AUSENTE e TORTO', () => {
  const state = painel([
    dono(),
    doDev({ active: false }),
    doAjudante('inv-brand', { active: false }),
    // Payload TORTO: espécie que não existe no espelho. Ele não pode virar dono
    // inventado nem derrubar o painel — o motor é o dono do formato.
    tab({ tabId: 'x', active: false, owner: { kind: 'chefe', label: 'chefe' } }),
    // Espécie boa, rótulo lixo: a aba CONTINUA sendo de um agente. Deixá-la sem
    // dono a faria passar por aba do dono — exatamente o erro que esta rodada
    // existe para matar.
    tab({ tabId: 'y', active: false, owner: { kind: 'helper', label: '   ' } }),
    tab({ tabId: 'z', active: false, owner: 'lixo' })
  ])

  // AUSENTE = aba do dono. Nada é escrito, pela mesma lei do `host`/`viewport`:
  // uma segunda grafia do mesmo estado faria `sameBrowserPanel` achar diferença
  // entre um motor velho e o de hoje contando a MESMA verdade.
  assert.equal(state.tabs[0].owner, undefined)
  // `user` explícito do motor novo cai na MESMA grafia da ausência.
  assert.equal(painel([tab({ owner: { kind: 'user', label: 'dono' } })]).tabs[0].owner, undefined)

  assert.deepEqual(state.tabs[1].owner, { kind: 'dev', label: 'dev', paneId: 'gui:dev' })
  assert.deepEqual(state.tabs[2].owner, {
    kind: 'helper',
    label: 'inv-brand',
    paneId: 'helper-mcp-inv-brand'
  })
  assert.equal(state.tabs[3].owner, undefined, 'espécie desconhecida não vira dono inventado')
  assert.equal(state.tabs[4].owner?.kind, 'helper', 'rótulo lixo não apaga a identidade')
  assert.equal(state.tabs[4].owner?.label, 'ajudante', 'sem nome, a ESPÉCIE nomeia a ficha')
  assert.equal(state.tabs[5].owner, undefined, 'dono que não é objeto some')
  // Nenhuma aba se perdeu no caminho: leitura defensiva NUNCA come aba.
  assert.equal(state.tabs.length, 6)
})

test('ABAS: o ⚡ é POR ABA — e a ausência nunca vira "dirigindo"', () => {
  const state = painel([
    dono(),
    doAjudante('inv-brand', { active: false, driving: true }),
    doAjudante('revisao', { active: false, driving: 'sim' })
  ])
  assert.equal(state.tabs[0].driving, undefined, 'motor velho não manda o campo — ausência é NÃO dirigindo')
  assert.equal(state.tabs[1].driving, true)
  assert.equal(state.tabs[2].driving, undefined, 'só `true` é dirigindo; string parecida não conta')
})

test('ABAS: o portão do store repinta quando o DONO ou o ⚡ trocam de aba', () => {
  const base = painel([dono(), doAjudante('inv-brand', { active: false, driving: true })])
  assert.equal(
    sameBrowserPanel(base, painel([dono(), doAjudante('inv-brand', { active: false, driving: true })])),
    true,
    'fotografia igual não repinta o dock'
  )

  // O ⚡ MUDOU DE ABA: com tudo o mais igual, sem esta comparação o raio ficaria
  // pintado na aba de quem parou de dirigir.
  const mudou = painel([dono({ driving: true }), doAjudante('inv-brand', { active: false })])
  assert.equal(sameBrowserPanel(base, mudou), false)

  // O DONO da aba mudou de nome (o ajudante que assumiu a aba é outro): o TAG na
  // tira é outro, logo a tela é outra.
  const outroNome = painel([dono(), doAjudante('revisao', { tabId: 'h-inv-brand', active: false, driving: true })])
  assert.equal(sameBrowserPanel(base, outroNome), false)

  // A ESPÉCIE mudou com o mesmo rótulo: DEV e ajudante homônimos não são a mesma
  // ficha (o TAG do dev é fixo).
  const semDono = painel([dono(), tab({ tabId: 'h-inv-brand', active: false, driving: true })])
  assert.equal(sameBrowserPanel(base, semDono), false)

  // O paneId NÃO entra na conta: ele não aparece em pixel nenhum, e comparar o
  // que não se vê é repintar o dock por nada (o `browser:changed` chega a cada
  // passo do agente).
  const outroPane = painel([
    dono(),
    doAjudante('inv-brand', { active: false, driving: true, owner: { kind: 'helper', label: 'inv-brand', paneId: 'helper-mcp-outro' } })
  ])
  assert.equal(sameBrowserPanel(base, outroPane), true)
})

test('ABAS: o TAG é o que a tira mostra — nada do dono, DEV do dev, o NOME do ajudante', () => {
  const state = painel([dono(), doDev({ active: false }), doAjudante('inv-brand', { active: false })])
  // A aba do dono não ganha prefixo nenhum: a diferença é por FORMA, e a forma
  // do dono é a ausência de ficha (ele é a régua, não um caso).
  assert.equal(browserTabOwnerTag(state.tabs[0]), null)
  assert.equal(browserTabOwnerTag(state.tabs[1]), 'DEV')
  assert.equal(browserTabOwnerTag(state.tabs[2]), 'inv-brand')
  // `user` explícito também é null — a lei vale mesmo se o motor mandar a ficha.
  assert.equal(browserTabOwnerTag(tab({ owner: { kind: 'user', label: 'dono' } })), null)
  // Identidade de agente sem classificação: o rótulo é o PAPEL dele.
  assert.equal(browserTabOwnerTag(tab({ owner: { kind: 'agent', label: 'reviewer' } })), 'reviewer')
})

test('ABAS: a FRASE do dono é o que a barra de status e o leitor de tela leem', () => {
  const state = painel([dono(), doDev({ active: false }), doAjudante('inv-brand', { active: false })])
  assert.equal(browserTabOwnerPhrase(state.tabs[0]), null, 'a aba do dono continua com as palavras de hoje')
  // "aba DE x" para todo mundo de propósito: "aba do dev" leria melhor, mas
  // "aba do inv-brand" leria ERRADO — uma regra só que nunca sai da gramática.
  assert.equal(browserTabOwnerPhrase(state.tabs[1]), 'aba de dev')
  assert.equal(browserTabOwnerPhrase(state.tabs[2]), 'aba de inv-brand')
})

test('ABAS: o resumo da seção recolhida NOMEIA quem está dirigindo', () => {
  // Com a seção fechada o resumo é a ÚNICA verdade que sobra. "⚡ Board" contava
  // que ALGUÉM dirigia; com dono + dev + frota na mesma missão, QUEM é a metade
  // que decide se o dono precisa reabrir.
  const dirigindo = painel(
    [dono(), doDev({ active: false }), doAjudante('inv-brand', { active: false, driving: true })],
    { agentDriving: true }
  )
  assert.equal(browserSectionSummary(dirigindo), '⚡ inv-brand dirigindo · 3 abas')

  // A largura emulada continua colada no fim (ela sobrevive à seção recolhida).
  const comLargura = painel(
    [dono(), doAjudante('inv-brand', { active: false, driving: true })],
    { agentDriving: true, viewport: 1280 }
  )
  assert.equal(browserSectionSummary(comLargura), '⚡ inv-brand dirigindo · 2 abas · 1280')

  // NINGUÉM dirigindo: as palavras de hoje, intactas.
  const parado = painel([dono(), doDev({ active: false })])
  assert.equal(browserSectionSummary(parado), 'Board · Synkora · 2 abas')

  // O ⚡ da MISSÃO sem aba marcada (motor velho): as palavras de hoje também.
  const missaoDirigindo = painel([dono()], { agentDriving: true })
  assert.equal(browserSectionSummary(missaoDirigindo), '⚡ Board · Synkora')

  // Aba dirigindo SEM dono: não há quem nomear, e o raio não pode sumir.
  const anonimo = painel([dono({ driving: true })])
  assert.equal(browserSectionSummary(anonimo), '⚡ Board · Synkora')

  // Motor velho continua vencendo tudo.
  assert.equal(browserSectionSummary(dirigindo, 'missing'), 'motor velho')
})

test('ABAS: o teto subiu para 12 (dono + dev + frota) e a recusa segue nomeando a saída', () => {
  // D5 do design: 8 abas era o teto de uma missão com UM dev. Com uma aba por
  // identidade, uma frota de quatro ajudantes já batia no teto antes de o dono
  // abrir a dele.
  assert.equal(BROWSER_TAB_CAP, 12)
  assert.equal(tabCapNotice(11), null)
  const cheio = tabCapNotice(12)
  assert.match(cheio, /teto de 12 abas/u)
  assert.match(cheio, /feche uma \(×\)/u, 'toda guarda nomeia a saída')
})

// ————— O CHROME NOVO (2026-09-29, `docs/mockups/browser-chrome-2026-09-29.html`) —————
//
// Sem o pé de status, a dica de cada controle virou `title` nativo, os recados
// moram numa faixa DENTRO do corpo, e a falha de carga/queda passou a ser POR
// ABA: a página explica o erro (variante B). As palavras e as decisões moram no
// modelo puro — é aqui que elas se provam.

const falhou = (over = {}) => ({ kind: 'load-failed', text: 'a prévia na porta 5173 recusou a conexão', ...over })

test('FALHA: a falha POR ABA atravessa o espelho, e o portão repinta quando ela nasce ou some', () => {
  const state = painel([
    doDev({ failure: falhou() }),
    dono({ tabId: 'b', active: false, failure: { kind: 'crashed', text: '   ' } }),
    doAjudante('inv-brand', { active: false, failure: 'lixo' })
  ])
  assert.deepEqual(state.tabs[0].failure, falhou())
  assert.equal(state.tabs[1].failure, undefined, 'falha sem texto não ocupa a tela dizendo nada')
  assert.equal(state.tabs[2].failure, undefined, 'payload torto não vira falha inventada')

  const dePe = painel([doDev()])
  assert.equal(dePe.tabs[0].failure, undefined, 'motor velho não manda o campo — ausência é página de pé')
  assert.equal(sameBrowserPanel(dePe, painel([doDev({ failure: falhou() })])), false, 'a falha nasceu: o cartão acende')
  assert.equal(
    sameBrowserPanel(painel([doDev({ failure: falhou() })]), painel([doDev({ failure: falhou({ kind: 'crashed' }) })])),
    false,
    'a ESPÉCIE mudou: o título do cartão é outro'
  )
  assert.equal(sameBrowserPanel(painel([doDev({ failure: falhou() })]), painel([doDev({ failure: falhou() })])), true)
})

test('FALHA: só a aba À VISTA troca a página pelo cartão, e o título vem da ESPÉCIE', () => {
  const ativaFalhou = painel([doDev({ failure: falhou() }), dono({ tabId: 'b', active: false })])
  assert.deepEqual(model.activeBrowserTabFailure(ativaFalhou), falhou())
  const outraFalhou = painel([dono(), doDev({ active: false, failure: falhou() })])
  assert.equal(model.activeBrowserTabFailure(outraFalhou), null, 'aba de fundo com erro não esconde a página à vista')
  assert.equal(model.activeBrowserTabFailure(model.EMPTY_BROWSER_PANEL), null)

  assert.equal(model.browserTabFailureTitle(falhou()), 'a página não carregou')
  assert.equal(model.browserTabFailureTitle(falhou({ kind: 'crashed' })), 'a página caiu')
  // Heurística sobre conteúdo é proibida: espécie nova cai no genérico, mesmo
  // que o texto "pareça" uma queda.
  assert.equal(model.browserTabFailureTitle({ kind: 'blocked', text: 'a página caiu' }), 'a página falhou')
})

test('ABAS: a dica nativa da aba é a frase inteira e, embaixo, o endereço', () => {
  const state = painel([
    dono({ url: 'http://localhost:5173/' }),
    doDev({ active: false, driving: true, url: 'http://localhost:5173/#/board' }),
    doAjudante('inv-brand', { active: false, url: '', failure: falhou() })
  ])
  // A aba do dono diz só o nome: a frase curta É o texto visível, e o leitor de
  // tela continua lendo o próprio botão.
  assert.equal(model.browserTabSentence(state.tabs[0]), 'Board · Synkora')
  assert.equal(model.browserTabTitle(state.tabs[0]), 'Board · Synkora\nhttp://localhost:5173/')
  assert.equal(
    model.browserTabTitle(state.tabs[1]),
    'aba de dev · localhost:5173 · dirigindo agora\nhttp://localhost:5173/#/board'
  )
  // A marca de erro é desenho: a PALAVRA volta na frase (e sem URL, sem linha vazia).
  assert.equal(model.browserTabTitle(state.tabs[2]), 'aba de inv-brand · QA visual · a página não carregou')
})

test('FAIXA: cada recado tem o SEU tom, a sua identidade e, na carga/queda, RECARREGAR', () => {
  const state = painel([dono({ viewport: 1280 })], {
    viewport: 1280,
    viewportWidth: 1200,
    notice: { kind: 'load-failed', text: 'a prévia recusou a conexão', at: '2026-09-29T20:00:00.000Z' }
  })
  const rows = model.browserNoticeRows(state, 'não deu para ler o browser: timeout', 'teto de 12 abas nesta missão')
  assert.deepEqual(
    rows.map((row) => [row.source, row.tone, row.reload]),
    [
      ['engine', 'error', true],
      ['read', 'muted', false],
      ['gesture', 'error', false],
      ['viewport', 'neutral', false]
    ]
  )
  assert.equal(rows[0].key, 'engine:2026-09-29T20:00:00.000Z', 'a nota do motor é identificada pelo CARIMBO')
  assert.match(rows[3].text, /estreito demais para 1280px/u)
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length, 'identidades nunca colidem entre fontes')

  // Nota que não é de página (download barrado) não oferece RECARREGAR.
  const download = painel([dono()], { notice: { kind: 'download-blocked', text: 'download barrado', at: 't1' } })
  assert.deepEqual(model.browserNoticeRows(download, null, null).map((row) => row.reload), [false])
  assert.deepEqual(model.browserNoticeRows(painel([dono()]), null, null), [], 'sem recado, sem faixa')
})

test('FAIXA: com a falha POR ABA, a nota de carga/queda não se repete — o cartão já diz', () => {
  const nota = { kind: 'crashed', text: 'a página caiu', at: 't9' }
  const comFalha = painel([dono(), doDev({ active: false, failure: falhou({ kind: 'crashed' }) })], { notice: nota })
  assert.deepEqual(model.browserNoticeRows(comFalha, null, null), [])
  // Motor ANTERIOR (sem `failure`): a faixa é o único lugar do recado.
  const motorVelho = painel([dono()], { notice: nota })
  assert.equal(model.browserNoticeRows(motorVelho, null, null)[0]?.reload, true)
  // Recado que não é de página segue na faixa mesmo com aba em erro.
  const download = painel([doDev({ failure: falhou() })], { notice: { kind: 'download-blocked', text: 'barrado', at: 't2' } })
  assert.equal(model.browserNoticeRows(download, null, null).length, 1)
})

test('FAIXA: dispensar vale enquanto o recado existe — o que some e volta é recado novo', () => {
  const rows = model.browserNoticeRows(painel([dono()]), 'leitura falhou', null)
  const vazio = new Set()
  assert.equal(model.liveNoticeDismissals(vazio, rows), vazio, 'nada a podar devolve o MESMO conjunto')
  const dispensado = new Set([rows[0].key])
  assert.equal(model.liveNoticeDismissals(dispensado, rows), dispensado, 'o recado vivo continua dispensado')
  const sumiu = model.liveNoticeDismissals(dispensado, [])
  assert.equal(sumiu.size, 0, 'o recado sumiu: a próxima vez que ele vier, aparece')
})

test('LARGURA: a nota de moldura vira a dica do seletor e a do piso vira linha da faixa', () => {
  const auto = painel([dono()])
  const cabe = painel([dono({ viewport: 375 })], { viewport: 375, viewportWidth: 375, viewportBand: 262 })
  const apertado = painel([dono({ viewport: 1280 })], { viewport: 1280, viewportWidth: 1200 })
  const doAgente = painel([dono({ viewport: 900 })], { viewport: 900, viewportWidth: 900 })

  assert.equal(
    model.browserViewportFitNote(cabe),
    'a página está em 375px REAIS, centralizada — as faixas dos lados são o app, não o site'
  )
  assert.equal(model.browserViewportShortfall(cabe), null, 'com faixa não existe piso mordendo')
  assert.equal(model.browserViewportFitNote(apertado), null)
  assert.match(model.browserViewportShortfall(apertado), /recebendo 1200px/u)

  assert.match(model.browserViewportTitle(auto), /^largura que a página enxerga · largura real do painel/u)
  assert.match(model.browserViewportTitle(cabe), /375px REAIS/u)
  assert.match(model.browserViewportTitle(doAgente), /\no agente pediu 900px lógicos · AUTO devolve a largura do painel$/u)
  assert.match(model.browserViewportTitle(model.EMPTY_BROWSER_PANEL), /abra uma página \(\+\)/u, 'desabilitado nunca é beco')

  assert.deepEqual(model.browserViewportOptions(auto), ['auto', 375, 768, 1280])
  assert.deepEqual(model.browserViewportOptions(doAgente), ['auto', 375, 768, 1280, 900], 'a largura do agente vira opção')
  assert.deepEqual(
    model.browserViewportOptions(doAgente).map(model.browserViewportOptionLabel),
    ['AUTO · largura do painel', '375 · celular', '768 · tablet', '1280 · desktop', '900 · pedido do agente']
  )
  // A lista nativa devolve TEXTO: "auto" e lixo voltam a AUTO, número vira largura.
  assert.equal(model.readViewportMode(Number('768')), 768)
  assert.equal(model.readViewportMode(Number('auto')), 'auto')
})
