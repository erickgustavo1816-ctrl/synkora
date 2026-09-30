#!/usr/bin/env node
/**
 * CADA ERRO COM A SUA UI — a forma de cada recado do browser da missão (seção
 * "6 · Cada erro com a sua UI" de `docs/mockups/browser-chrome-2026-09-29.html`,
 * lei 8 do playbook da missão).
 *
 * O que se prende aqui é a metade PURA (`browserNoticePresentation.ts`): tom,
 * ícone e saída de cada linha da faixa, decididos pelo `kind` do motor — sinal
 * ESTRUTURAL, nunca o texto —, a cabeça em negrito, o "×N" da repetição, a
 * recusa do gesto que não duplica a nota do motor e o cartão da página travada.
 *
 * O import do módulo novo é DINÂMICO e só engole "módulo não existe", DE
 * PROPÓSITO: no código velho ele não existe, e cada teste precisa falhar na SUA
 * asserção (a prova vermelha) em vez de o arquivo inteiro morrer no link.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import * as model from '../src/renderer/src/dockBrowserModel.ts'

let notices = {}
try {
  notices = await import('../src/renderer/src/browserNoticePresentation.ts')
} catch (cause) {
  if (cause?.code !== 'ERR_MODULE_NOT_FOUND') throw cause
}

const tab = (over = {}) => ({
  tabId: 't1',
  title: 'Board · Synkora',
  url: 'http://localhost:5173/',
  active: true,
  loading: false,
  canBack: false,
  canForward: false,
  ...over
})
const painel = (tabs, over = {}) => model.normalizeBrowserPanel({ alive: true, tabs, ...over })
const semHost = { readError: null, gesture: null, viewport: null }
const linhas = (state, host = {}) => notices.browserNoticeRows(state, { ...semHost, ...host })
const comNota = (notice, tabs = [tab()]) => painel(tabs, { notice: { at: 't1', ...notice } })

test('FORMA: cada espécie do motor tem o SEU tom, o seu ícone e a sua saída', () => {
  const forma = (kind) => {
    const look = notices.browserNoticeLook(kind)
    return [look.tone, look.icon, look.action]
  }
  // Regra da casa NÃO é falha: cinza de política, nunca a cor de erro.
  assert.deepEqual(forma('permission-denied'), ['policy', 'lock', null])
  assert.deepEqual(forma('download-blocked'), ['policy', 'download', null])
  // Situação que passa sozinha: neutra.
  assert.deepEqual(forma('load-slow'), ['neutral', 'queue', 'reload'])
  assert.deepEqual(forma('tab-cap'), ['neutral', 'tabs', null])
  assert.deepEqual(forma('tab-lost'), ['error', 'gone', 'reopen'])
  assert.deepEqual(forma('reference-failed'), ['error', 'alert', null])
  for (const kind of ['load-failed', 'crashed', 'unresponsive']) {
    assert.deepEqual(forma(kind), ['error', 'alert', 'reload'], `${kind} na faixa traz RECARREGAR`)
  }
  // Espécie que o chrome não conhece: erro com alerta, nunca uma linha muda
  // — e "constructor" não pode achar a função do protótipo de um objeto.
  for (const kind of ['blocked-by-admin', 'constructor', 'toString', '']) {
    assert.deepEqual(forma(kind), ['error', 'alert', null], `espécie desconhecida "${kind}"`)
  }
})

test('FAIXA: a cabeça do motor vai em negrito, a frase completa, e a repetição vira ×N', () => {
  const camera = comNota({
    kind: 'permission-denied',
    title: 'a página pediu a câmera e o microfone',
    text: 'o browser da missão não libera dispositivos. Para testar isso, abra a página no seu browser.',
    count: 3
  })
  const [row] = linhas(camera)
  assert.equal(row.tone, 'policy')
  assert.equal(row.icon, 'lock')
  assert.equal(row.title, 'a página pediu a câmera e o microfone')
  assert.match(row.text, /^o browser da missão não libera dispositivos/u)
  assert.deepEqual(row.count, { label: '×3', title: 'a página pediu 3 vezes' })
  assert.equal(row.action, null, 'política não tem saída na linha')
  assert.equal(
    notices.browserNoticeSentence(camera.notice),
    'a página pediu a câmera e o microfone — o browser da missão não libera dispositivos. Para testar isso, abra a página no seu browser.'
  )

  // Sem cabeça (motor anterior): a linha é só a frase.
  const velho = comNota({ kind: 'download-blocked', text: 'download barrado: relatorio-q3.pdf' })
  assert.equal(linhas(velho)[0].title, null)
  assert.equal(notices.browserNoticeSentence(velho.notice), 'download barrado: relatorio-q3.pdf')
  assert.equal(linhas(velho)[0].count, null, 'sem contador, sem pílula')

  // Um recado só não conta; outra espécie repetida ganha a dica genérica.
  assert.equal(linhas(comNota({ kind: 'permission-denied', text: 'câmera', count: 1 }))[0].count, null)
  assert.deepEqual(linhas(comNota({ kind: 'tab-cap', text: 'teto', count: 2 }))[0].count, {
    label: '×2',
    title: 'o mesmo aviso chegou 2 vezes'
  })
})

test('FAIXA: a repetição coalescida mantém a IDENTIDADE — dispensada, fica dispensada', () => {
  const primeira = linhas(comNota({ kind: 'permission-denied', text: 'câmera', count: 2, at: 'c1' }))
  const quinta = linhas(comNota({ kind: 'permission-denied', text: 'câmera', count: 5, at: 'c1' }))
  assert.equal(primeira[0].key, quinta[0].key, 'o ×N subir não é recado novo')
  const dispensado = new Set([primeira[0].key])
  assert.equal(notices.liveNoticeDismissals(dispensado, quinta), dispensado)
})

test('FAIXA: a aba que morreu traz REABRIR com o endereço dela — e só com ele', () => {
  const morta = comNota({
    kind: 'tab-lost',
    title: 'a aba "Figma — tokens do tema" fechou sozinha',
    text: 'a página morreu sem volta.',
    url: 'https://www.figma.com/design/k3P9/tokens-papel'
  })
  const [row] = linhas(morta)
  assert.equal(row.tone, 'error')
  assert.equal(row.icon, 'gone')
  assert.deepEqual(row.action, { kind: 'reopen', url: 'https://www.figma.com/design/k3P9/tokens-papel' })
  // Sem endereço, REABRIR abriria uma aba em branco fingindo ser a que morreu.
  assert.equal(linhas(comNota({ kind: 'tab-lost', text: 'a aba fechou sozinha' }))[0].action, null)
  assert.deepEqual(notices.BROWSER_NOTICE_ACTION_WORDS.reopen, {
    label: 'reabrir',
    title: 'abrir de novo o mesmo endereço numa aba nova'
  })

  const lenta = linhas(comNota({ kind: 'load-slow', title: 'a página está demorando', text: 'mais de 20 s carregando' }))
  assert.deepEqual([lenta[0].tone, lenta[0].icon, lenta[0].action], ['neutral', 'queue', { kind: 'reload' }])
})

test('FAIXA: a recusa do gesto que REPETE a nota do motor vira uma linha só', () => {
  const teto = comNota({ kind: 'tab-cap', text: 'teto de 12 abas nesta missão — feche uma (×) para abrir outra' })
  assert.deepEqual(
    linhas(teto, { gesture: 'teto de 12 abas nesta missão — feche uma (×) para abrir outra' }).map((row) => row.source),
    ['engine'],
    'a mesma frase do motor e do gesto: uma linha'
  )
  const comCabeca = comNota({ kind: 'tab-cap', title: '12 abas é o teto desta missão', text: 'feche uma (×) para abrir outra.' })
  assert.deepEqual(
    linhas(comCabeca, { gesture: '12 abas é o teto desta missão — feche uma (×) para abrir outra.' }).map((row) => row.source),
    ['engine'],
    'o gesto que repete a FRASE INTEIRA (cabeça + complemento) também'
  )
  assert.deepEqual(
    linhas(teto, { gesture: 'abra uma página (+) antes de destacar' }).map((row) => [row.source, row.tone, row.icon]),
    [
      ['engine', 'neutral', 'tabs'],
      ['gesture', 'error', 'alert']
    ],
    'recusa diferente segue na faixa'
  )
  assert.deepEqual(
    linhas(painel([tab()]), { gesture: 'o browser recusou a ação' }).map((row) => row.source),
    ['gesture'],
    'sem nota do motor, o gesto fala sozinho'
  )
})

test('FAIXA: os recados do HOST mantêm tom e ícone — leitura cinza, gesto erro, largura neutra', () => {
  const state = painel([tab({ viewport: 1280 })], {
    viewport: 1280,
    viewportWidth: 1200,
    notice: { kind: 'load-failed', text: 'a prévia recusou a conexão', at: '2026-09-29T20:00:00.000Z' }
  })
  const rows = linhas(state, {
    readError: 'não deu para ler o browser: timeout',
    gesture: 'teto de 12 abas nesta missão',
    viewport: model.browserViewportShortfall(state)
  })
  assert.deepEqual(
    rows.map((row) => [row.source, row.tone, row.icon, row.action?.kind ?? null]),
    [
      ['engine', 'error', 'alert', 'reload'],
      ['read', 'muted', 'queue', null],
      ['gesture', 'error', 'alert', null],
      ['viewport', 'neutral', 'info', null]
    ]
  )
  assert.equal(rows[0].key, 'engine:2026-09-29T20:00:00.000Z', 'a nota do motor é identificada pelo CARIMBO')
  assert.match(rows[3].text, /estreito demais para 1280px/u)
  assert.equal(new Set(rows.map((row) => row.key)).size, rows.length, 'identidades nunca colidem entre fontes')
  assert.deepEqual(linhas(painel([tab()])), [], 'sem recado, sem faixa')
})

test('FAIXA: com a falha POR ABA, a nota da página falhada não se repete — travada inclusive', () => {
  for (const kind of ['load-failed', 'crashed', 'unresponsive']) {
    const comFalha = comNota({ kind, text: 'a página falhou', at: 't9' }, [
      tab(),
      tab({ tabId: 'b', active: false, failure: { kind, text: 'a página falhou' } })
    ])
    assert.deepEqual(linhas(comFalha), [], `${kind}: o cartão na página já diz`)
    // Motor ANTERIOR (sem `failure`): a faixa é o único lugar do recado.
    assert.equal(linhas(comNota({ kind, text: 'a página falhou' }))[0]?.action?.kind, 'reload')
  }
  // Recado que não é de página segue na faixa mesmo com aba em erro.
  const download = comNota({ kind: 'download-blocked', text: 'barrado' }, [
    tab({ failure: { kind: 'load-failed', text: 'recusou' } })
  ])
  assert.equal(linhas(download).length, 1)
})

test('FAIXA: dispensar vale enquanto o recado existe — o que some e volta é recado novo', () => {
  const rows = linhas(painel([tab()]), { readError: 'leitura falhou' })
  const vazio = new Set()
  assert.equal(notices.liveNoticeDismissals(vazio, rows), vazio, 'nada a podar devolve o MESMO conjunto')
  const dispensado = new Set([rows[0].key])
  assert.equal(notices.liveNoticeDismissals(dispensado, rows), dispensado, 'o recado vivo continua dispensado')
  assert.equal(notices.liveNoticeDismissals(dispensado, []).size, 0, 'o recado sumiu: a próxima vez que ele vier, aparece')
})

test('CARTÃO: a página TRAVADA ganha o ícone de congelada e ESPERAR; as outras, só RECARREGAR', () => {
  assert.deepEqual(notices.browserFailureLook({ kind: 'unresponsive', text: 'preso' }), { icon: 'frozen', canWait: true })
  for (const kind of ['load-failed', 'crashed', 'blocked']) {
    assert.deepEqual(notices.browserFailureLook({ kind, text: 'x' }), { icon: 'alert', canWait: false }, kind)
  }
})
