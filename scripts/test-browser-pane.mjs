#!/usr/bin/env node
/**
 * O PANE DO BROWSER EMBUTIDO — as duas metades que o dono nunca vê quebrar
 * (fatias H1 e H3 do design `.synkora/reports/DESIGN_BROWSER_EMBUTIDO_2026-08-29.md`).
 *
 * A suíte tem duas metades porque o painel tem dois lados, e cada um pode
 * mentir sozinho:
 *
 *  A) O MODELO DO PAINEL (`src/renderer/src/dockBrowserModel.ts`, H3) — a
 *     metade PURA do chrome de papel: leitura defensiva do estado, o resumo da
 *     seção recolhida, e a GEOMETRIA. Ela mora aqui porque a página do browser
 *     NÃO é desenhada pelo renderer: a `WebContentsView` nativa compõe POR CIMA
 *     do DOM, no retângulo que este módulo calcula. Errar o recorte é pintar uma
 *     página de internet em cima do chat do dono — e nenhum teste de React
 *     pegaria isso, porque no DOM está tudo certo.
 *
 *  B) O MOTOR (`src/main/browserPane.ts`, H1) — o `BrowserManager` com host e
 *     `webContents` FALSOS (o Electron não é tocado). O que se prende aqui é a
 *     MECÂNICA: quem chama o quê, em que ordem, e — acima de tudo — a
 *     **PRIMEIRA LEI**.
 *
 * ——— A PRIMEIRA LEI, e por que ela ganhou um teste com armadilha ———
 * "A VIEW NUNCA SE DESANEXA enquanto o browser da missão viver." A sonda
 * `PROBE_BROWSER_CDP_2026-08-29.md` §P5 mediu em binário real: view anexada e
 * escondida continua com rAF vivo e `capturePage()` em 7-14 ms; view passada
 * por `removeChildView` PENDURA a captura por 5-8 s e mata o rAF. Ou seja: um
 * `detach` no caminho de esconder não quebra nada visível — ele transforma cada
 * `browser_shot` do agente numa rodada perdida, semanas depois, sem sintoma
 * local. Por isso o host falso desta suíte não só CONTA os detaches: ele
 * EXPLODE se um acontecer fora do teardown (`forbidDetach`). A regressão morre
 * no ponto do crime, não numa investigação de timing daqui a um mês.
 *
 * Nada de Electron, nada de janela, nada do app do dono: host e `webContents`
 * são dublês, e o único contato com o Electron real (`electronBrowserViewHost`)
 * fica fora do caminho porque o motor recebe `deps.host`.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

// A metade PURA do painel chega por type-stripping: o módulo não tem um
// `window` no corpo e só importa TIPOS do preload (apagados na compilação).
import {
  BROWSER_NO_API,
  BROWSER_PAGE_DEFAULT_FRACTION,
  BROWSER_PAGE_KEYBOARD_STEP,
  BROWSER_PAGE_MAX_FRACTION,
  BROWSER_PAGE_MIN_FRACTION,
  BROWSER_PAGE_MIN_HEIGHT,
  BROWSER_PAGE_RAIL_FLOOR,
  BROWSER_TAB_CAP as BROWSER_TAB_CAP_UI,
  BROWSER_VIEWPORT_CHOICES,
  EMPTY_BROWSER_PANEL,
  activeBrowserTab,
  browserIsPopout,
  browserViewportBand,
  browserViewportHint,
  browserViewportIsCustom,
  browserViewportLabel,
  browserViewportNote,
  browserViewportOf,
  browserPageBounds,
  browserPageFraction,
  browserPageHeight,
  browserPageRange,
  browserPageStorageKey,
  browserRect,
  browserSectionSummary,
  browserTabLabel,
  clampBrowserPageFraction,
  clipBrowserRect,
  intersectRects,
  isHostOverlayNode,
  normalizeBrowserPanel,
  overlayHidesPage,
  readBrowserAck,
  readBrowserPageFraction,
  rectHasArea,
  rectsOverlap,
  sameBrowserPanel,
  browserSiblingsToWatch,
  createBrowserBoundsGate,
  createBrowserBoundsPump,
  sameBrowserRect,
  stepBrowserPageFraction,
  tabCapNotice,
  trimUrlInput,
  urlHost,
  writeBrowserPageFraction
} from '../src/renderer/src/dockBrowserModel.ts'

// O motor é do MAIN e importa irmão sem extensão (`./blackbox`): o
// type-stripping do node não resolve isso, então ele chega compilado — o mesmo
// arranjo de `test:gui-delegation-defaults`.
import {
  BROWSER_AGENT_DRIVING_DECAY_MS,
  BROWSER_CHANGED_CHANNEL,
  BROWSER_TAB_CAP,
  browserPartitionFor,
  createBrowserManager,
  isBrowserPanelRect,
  normalizeBrowserUrl
} from '../.tmp/browser-pane-test/browserPane.js'

// A MATEMÁTICA da largura emulada (2026-08-29). Módulo puro, sem Electron: ele
// chega compilado de carona no import graph do motor, que é quem o consome.
import {
  BROWSER_VIEWPORT_MAX_WIDTH,
  BROWSER_VIEWPORT_MIN_WIDTH,
  BROWSER_ZOOM_FLOOR,
  applyViewportFit,
  normalizeViewportMode,
  viewportBandWidth,
  viewportEffectiveWidth,
  viewportFitZoom,
  viewportIsClamped,
  viewportViewRect,
  viewportViewWidth
} from '../.tmp/browser-pane-test/browserViewport.js'

// ————————————————————————————————————————————————————————————————
// A. O MODELO DO PAINEL (H3) — estado, palavras e geometria
// ————————————————————————————————————————————————————————————————

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

test('MODELO: a fotografia vazia é CONGELADA e de referência estável', () => {
  // Seletor zustand que devolvesse objeto novo a cada leitura repintaria a
  // árvore inteira a cada `browser:changed` — e o agente manda um por passo.
  assert.equal(Object.isFrozen(EMPTY_BROWSER_PANEL), true)
  assert.equal(normalizeBrowserPanel(undefined), EMPTY_BROWSER_PANEL)
  assert.equal(normalizeBrowserPanel('lixo'), EMPTY_BROWSER_PANEL)
  assert.equal(normalizeBrowserPanel(42), EMPTY_BROWSER_PANEL)
})

test('MODELO: leitura defensiva — aba sem id some, e "tem aba e nenhuma ativa" é CONSERTADO', () => {
  const state = normalizeBrowserPanel({
    alive: false,
    tabs: [
      { title: 'sem id' },
      { tabId: 'a', title: 'A', url: 'https://a.test/', active: false },
      { tabId: 'b', title: 'B', url: 'https://b.test/', active: false }
    ]
  })
  // Sem `tabId` não existe gesto possível sobre a aba: ela não pode aparecer.
  assert.deepEqual(
    state.tabs.map((entry) => entry.tabId),
    ['a', 'b']
  )
  // A verdade impossível: existir aba e nenhuma marcada ativa deixaria a barra
  // de URL falando de uma página e a tira de abas de outra. A primeira assume.
  assert.equal(state.tabs[0].active, true)
  assert.equal(state.tabs[1].active, false)
  assert.equal(activeBrowserTab(state)?.tabId, 'a')
  // Ter aba É estar vivo, mesmo com o motor mandando `alive:false`.
  assert.equal(state.alive, true)
})

test('MODELO: a NOTA do motor só entra na tela com texto — e o carimbo distingue dois avisos iguais', () => {
  const muda = normalizeBrowserPanel({ alive: true, tabs: [], notice: { kind: 'tab-cap', text: '  ' } })
  assert.equal(muda.notice, undefined, 'nota sem texto ocuparia uma linha dizendo nada')

  const base = normalizeBrowserPanel({
    alive: true,
    tabs: [{ tabId: 'a' }],
    notice: { kind: 'download-blocked', text: 'download bloqueado: x.zip', at: '2026-08-29T10:00:00.000Z' }
  })
  const gemea = normalizeBrowserPanel({
    alive: true,
    tabs: [{ tabId: 'a' }],
    notice: { kind: 'download-blocked', text: 'download bloqueado: x.zip', at: '2026-08-29T10:00:00.000Z' }
  })
  const segunda = normalizeBrowserPanel({
    alive: true,
    tabs: [{ tabId: 'a' }],
    notice: { kind: 'download-blocked', text: 'download bloqueado: x.zip', at: '2026-08-29T10:05:00.000Z' }
  })
  assert.equal(sameBrowserPanel(base, gemea), true, 'fotografia igual não repinta o dock')
  // Dois downloads barrados com o mesmo texto em momentos diferentes são DOIS
  // avisos, e o segundo precisa chegar à tela.
  assert.equal(sameBrowserPanel(base, segunda), false)
})

test('MODELO: o portão do store enxerga cada campo que muda a tela', () => {
  const a = normalizeBrowserPanel({ alive: true, tabs: [tab({ title: 'A' })] })
  assert.equal(sameBrowserPanel(a, normalizeBrowserPanel({ alive: true, tabs: [tab({ title: 'A' })] })), true)
  for (const change of [
    { agentDriving: true },
    { tabs: [tab({ title: 'B' })] },
    { tabs: [tab({ loading: true, title: 'A' })] },
    { tabs: [tab({ canBack: true, title: 'A' })] },
    { tabs: [tab({ title: 'A' }), tab({ tabId: 't2', active: false })] }
  ]) {
    const b = normalizeBrowserPanel({ alive: true, tabs: [tab({ title: 'A' })], ...change })
    assert.equal(sameBrowserPanel(a, b), false, `mudança ignorada: ${JSON.stringify(change)}`)
  }
})

test('MODELO: o ack do motor é frouxo na leitura e DURO na recusa', () => {
  // Motor antigo que não devolve nada vale como OK — só uma recusa EXPLÍCITA
  // vira recado na tela.
  assert.deepEqual(readBrowserAck(undefined), { ok: true, error: null })
  assert.deepEqual(readBrowserAck({ ok: true }), { ok: true, error: null })
  assert.deepEqual(readBrowserAck({ ok: false, error: 'teto de 8 abas' }), {
    ok: false,
    error: 'teto de 8 abas'
  })
  // Recusa sem texto nunca vira silêncio.
  assert.equal(readBrowserAck({ ok: false }).error, 'o browser recusou a ação')
})

test('MODELO: o RESUMO da seção é a única verdade que sobra com o painel recolhido', () => {
  const fechado = normalizeBrowserPanel({ alive: false, tabs: [] })
  assert.equal(browserSectionSummary(fechado), 'fechado')
  assert.equal(browserSectionSummary(fechado, 'missing'), 'motor velho')

  const carregando = normalizeBrowserPanel({
    alive: true,
    agentDriving: true,
    tabs: [tab({ loading: true, title: 'Board' }), tab({ tabId: 't2', active: false })]
  })
  // Quem está dirigindo, o que está carregando e quantas abas existem: é o que
  // decide se vale reabrir a seção.
  assert.equal(browserSectionSummary(carregando), '⚡ carregando… · 2 abas')

  const parado = normalizeBrowserPanel({ alive: true, tabs: [tab({ title: 'Board · Synkora' })] })
  assert.equal(browserSectionSummary(parado), 'Board · Synkora')
})

test('MODELO/POP-OUT: só `popout` é carregado — a AUSÊNCIA é dock, e o ⧉ REPINTA o dock', () => {
  const fora = { alive: true, tabs: [tab()], host: 'popout' }
  assert.equal(normalizeBrowserPanel(fora).host, 'popout')
  // Ausente = dock, e nada mais escreve o campo: o espelho do preload declara a
  // ausência como padrão, e um `'dock'` inventado aqui seria uma SEGUNDA grafia
  // da mesma coisa — duas fotografias iguais passariam a comparar diferente
  // entre um motor anterior ao ⧉ e o de hoje.
  assert.equal(normalizeBrowserPanel({ alive: true, tabs: [tab()] }).host, undefined)
  assert.equal(normalizeBrowserPanel({ alive: true, tabs: [tab()], host: 'dock' }).host, undefined)
  assert.equal(normalizeBrowserPanel({ alive: true, tabs: [tab()], host: 'lixo' }).host, undefined)
  // A pergunta é UMA só: `!== 'dock'` espalhado pela tela transformaria a
  // ausência (motor velho) em "destacado".
  assert.equal(browserIsPopout(normalizeBrowserPanel(fora)), true)
  assert.equal(browserIsPopout(EMPTY_BROWSER_PANEL), false)

  // O PORTÃO DO STORE: com TUDO o mais igual, mudar de host tem de repintar —
  // sem esta comparação o ⧉ do dono não trocaria o painel pelo recibo.
  const dentro = normalizeBrowserPanel({ alive: true, tabs: [tab()] })
  assert.equal(sameBrowserPanel(dentro, normalizeBrowserPanel(fora)), false)
  assert.equal(sameBrowserPanel(normalizeBrowserPanel(fora), normalizeBrowserPanel(fora)), true)
})

test('MODELO/POP-OUT: com a seção recolhida o resumo diz "destacado" ANTES de contar aba nenhuma', () => {
  const fora = normalizeBrowserPanel({
    alive: true,
    tabs: [tab({ title: 'Board' }), tab({ tabId: 't2', active: false }), tab({ tabId: 't3', active: false })],
    host: 'popout'
  })
  // "Board · 3 abas" mandaria o dono procurar no dock uma página que está em
  // OUTRA janela — o resumo é a única verdade que sobra com a seção fechada.
  assert.equal(browserSectionSummary(fora), 'destacado')
  // O ⚡ sobrevive ao destaque: o agente segue dirigindo a página de lá.
  const dirigindo = normalizeBrowserPanel({
    alive: true,
    agentDriving: true,
    tabs: [tab({ loading: true })],
    host: 'popout'
  })
  assert.equal(browserSectionSummary(dirigindo), '⚡ destacado')
  // Motor velho continua vencendo tudo: sem verbo no preload não há destaque
  // nenhum para contar.
  assert.equal(browserSectionSummary(fora, 'missing'), 'motor velho')
})

test('MODELO: o nome da aba degrada título → host → a verdade, nunca uma URL inteira', () => {
  assert.equal(browserTabLabel(tab({ title: '  Board  ' })), 'Board')
  assert.equal(browserTabLabel(tab({ url: 'http://localhost:5173/board?x=1' })), 'localhost:5173')
  assert.equal(browserTabLabel(tab({})), 'aba em branco')
  // O dono digitando pela metade: `new URL` recusa, e a URL crua serve.
  assert.equal(urlHost('local'), 'local')
  assert.equal(urlHost('about:blank'), 'about')
  assert.equal(trimUrlInput('  localhost:5173  '), 'localhost:5173')
})

test('MODELO: o teto de abas da TELA é o mesmo do MOTOR, e a recusa nomeia a saída', () => {
  // Espelho declarado entre H3 e H1: dois números que divergissem dariam um `+`
  // habilitado que o main recusa — botão que existe para ser negado.
  assert.equal(BROWSER_TAB_CAP_UI, BROWSER_TAB_CAP)
  assert.equal(tabCapNotice(BROWSER_TAB_CAP - 1), null)
  const cheio = tabCapNotice(BROWSER_TAB_CAP)
  assert.match(cheio, new RegExp(`teto de ${BROWSER_TAB_CAP} abas`, 'u'))
  assert.match(cheio, /feche uma \(×\)/u, 'toda guarda nomeia a saída')
  assert.match(BROWSER_NO_API, /reinicie o app/u, 'preload velho ensina a receita em vez de morrer calado')
})

test('MODELO/GEOMETRIA: o retângulo do motor é inteiro e nunca negativo', () => {
  // Meio pixel vira borda tremendo na view nativa; largura negativa o motor
  // aceitaria calado.
  assert.deepEqual(browserRect({ left: 10.4, top: 20.6, width: 300.5, height: 199.4 }), {
    x: 10,
    y: 21,
    width: 301,
    height: 199
  })
  // Lixo do DOM (medida durante um desmonte) vira zero, e largura/altura NUNCA
  // saem negativas. `y` negativo, ao contrário, é LEGÍTIMO: é o painel rolado
  // acima da viewport — quem resolve isso é o RECORTE, não um clamp cego, que
  // esticaria a página nativa para dentro do chat.
  assert.deepEqual(browserRect({ left: Number.NaN, top: -12.4, width: -50, height: 10 }), {
    x: 0,
    y: -12,
    width: 0,
    height: 10
  })
  assert.equal(rectHasArea(browserRect({ left: 0, top: -12, width: 0, height: 10 })), false)
  assert.equal(sameBrowserRect({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }), true)
  assert.equal(sameBrowserRect({ x: 1, y: 2, width: 3, height: 4 }, null), false)
})

test('MODELO/GEOMETRIA: rolar o dock RECORTA a página nativa — ela não conhece overflow nenhum', () => {
  const painel = { x: 0, y: 100, width: 200, height: 400 }
  const trilho = { x: 0, y: 200, width: 200, height: 600 }
  // O que sobra depois do recorte do ancestral que rola.
  assert.deepEqual(clipBrowserRect(painel, [trilho]), { x: 0, y: 200, width: 200, height: 300 })
  // Rolado até sair de vista: área ZERO (e não um retângulo de altura negativa,
  // que empurraria a página para cima do chat).
  const fora = clipBrowserRect(painel, [{ x: 0, y: 900, width: 200, height: 100 }])
  assert.equal(rectHasArea(fora), false)
  assert.deepEqual(fora, { x: 0, y: 0, width: 0, height: 0 })
  // Sem sobreposição a interseção também é área zero, nunca dimensão negativa.
  const vazio = intersectRects({ x: 0, y: 0, width: 10, height: 10 }, { x: 50, y: 50, width: 10, height: 10 })
  assert.equal(vazio.width, 0)
  assert.equal(vazio.height, 0)
})

test('MODELO/OVERLAY: só o portal que REALMENTE cruza a página a esconde', () => {
  // O padrão pago (`88c49d4^`) escondia a view com QUALQUER overlay aberto, por
  // um contador incrementado à mão. Aqui o fato é lido pela estrutura — e um
  // menu pequeno num canto distante não apaga mais a página inteira.
  const pagina = { x: 200, y: 100, width: 400, height: 300 }
  assert.equal(overlayHidesPage(pagina, [{ x: 0, y: 0, width: 100, height: 40 }]), false)
  assert.equal(overlayHidesPage(pagina, [{ x: 300, y: 200, width: 100, height: 40 }]), true)
  assert.equal(rectsOverlap(pagina, { x: 600, y: 100, width: 10, height: 10 }), false)
  // Página sem área nenhuma já está escondida por outro motivo.
  assert.equal(overlayHidesPage({ x: 0, y: 0, width: 0, height: 0 }, [pagina]), false)

  assert.equal(isHostOverlayNode({ id: 'root', role: null }), false, 'a árvore do app não é overlay')
  assert.equal(isHostOverlayNode({ id: '', role: 'tooltip' }), false, 'tooltip apagaria a página a cada hover')
  assert.equal(isHostOverlayNode({ id: '', role: 'dialog' }), true)
})

// ————————————————————————————————————————————————————————————————
// A.1b O CAMINHO QUENTE DA GEOMETRIA (H9, 2026-08-29)
// ————————————————————————————————————————————————————————————————
//
// REPROVAÇÃO DO DONO, no painel vivo: *"deixa ele mais dinamico tbm, igual
// funciona o claude code, melhorou mas ainda da pra ficar melhor, to achando
// ele meio travado hoje."*
//
// A sonda `.synkora/reports/h9/probe-h9-fluidity.mjs` mediu o caminho inteiro
// quadro a quadro, com janela de verdade e compositing ligado, e nomeou os dois
// culpados:
//
//  1. o salto de `requestAnimationFrame` na saída do `ResizeObserver` —
//     **2,01 quadros** de atraso no arrasto da alça e **2,03** no da largura,
//     contra **1,03/1,05** medindo dentro do observador (o piso físico);
//  2. a irmã que recolhe e EMPURRA a página sem mudar tamanho nenhum — só o
//     relógio de 400ms via, com **mediana de 300ms e p95 de 384ms** em 30
//     colapsos; com as irmãs observadas, **0,28ms**.
//
// Estas cercas prendem as três peças que curaram isso. Nenhuma delas existia no
// código velho (`TypeError` no import), e cada uma cai sob mutação do código
// NOVO — a lista das mutações está no relatório da rodada.

/** Um relógio de quadros de mentira: nada corre até `tick()`. É o que deixa
 *  perguntar "isto mediu AGORA ou esperou um quadro?" sem um browser. */
function fakeFrames() {
  const queued = new Map()
  let next = 1
  return {
    queued,
    requestFrame(run) {
      const handle = next++
      queued.set(handle, run)
      return handle
    },
    cancelFrame(handle) {
      queued.delete(handle)
    },
    /** roda o que está agendado (como o quadro seguinte faria) */
    tick() {
      const runs = [...queued.values()]
      queued.clear()
      for (const run of runs) run()
    }
  }
}

test('QUENTE: o observador de tamanho mede NO MESMO quadro — o salto de rAF custava um quadro inteiro', () => {
  const frames = fakeFrames()
  let medidas = 0
  const pump = createBrowserBoundsPump({
    measure: () => {
      medidas++
    },
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame
  })

  // O caminho FRIO: nada acontece até o quadro seguinte (é a coalescência que
  // protege `scroll`/mutação/relógio de disparar em rajada).
  pump.cold()
  assert.equal(medidas, 0, 'o frio NÃO pode medir na hora')
  assert.equal(pump.pending(), true)
  frames.tick()
  assert.equal(medidas, 1)
  assert.equal(pump.pending(), false)

  // O caminho QUENTE: mede AGORA. É esta linha que vale um quadro de página
  // colada no dedo do dono.
  pump.hot()
  assert.equal(medidas, 2, 'o quente mede no quadro de quem chamou')
  assert.equal(pump.pending(), false, 'e não deixa quadro nenhum agendado')
})

test('QUENTE: um quadro frio pendente é CANCELADO pelo quente — nunca um relato velho depois do novo', () => {
  const frames = fakeFrames()
  const medidas = []
  let geometria = 'A'
  const pump = createBrowserBoundsPump({
    measure: () => medidas.push(geometria),
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame
  })

  // Uma rolagem agenda o frio; no MESMO quadro o arrasto muda a caixa e o
  // observador de tamanho mede quente. Sem o cancelamento, o quadro seguinte
  // ainda cuspiria uma segunda medição — trabalho puro, e um relato a mais para
  // o motor no meio de um gesto.
  pump.cold()
  geometria = 'B'
  pump.hot()
  frames.tick()
  assert.deepEqual(medidas, ['B'], 'o quadro frio pendente tem de morrer com o quente')
})

test('QUENTE: a rajada fria coalesce em UM quadro, e a faxina não deixa quadro pendurado', () => {
  const frames = fakeFrames()
  let medidas = 0
  const pump = createBrowserBoundsPump({
    measure: () => {
      medidas++
    },
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame
  })

  // Montar um portal dispara uma rajada de mutações; cem chamadas viram UMA.
  for (let i = 0; i < 100; i++) pump.cold()
  assert.equal(frames.queued.size, 1, 'a rajada não pode virar cem quadros')
  frames.tick()
  assert.equal(medidas, 1)

  // Desmontar com quadro agendado: ele não pode acordar depois, medindo um nó
  // que já saiu da árvore.
  pump.cold()
  pump.stop()
  assert.equal(frames.queued.size, 0)
  frames.tick()
  assert.equal(medidas, 1, 'quadro pendurado após a faxina é medição em nó morto')
})

test('PORTÃO: repetido não viaja, mas a VISIBILIDADE conta tanto quanto a geometria', () => {
  const gate = createBrowserBoundsGate()
  const caixa = { x: 10, y: 20, width: 300, height: 200 }

  assert.equal(gate.accept(caixa, true), true, 'o primeiro relato sempre passa')
  assert.equal(gate.accept({ ...caixa }, true), false, 'o mesmo retângulo não vale um IPC')
  // A LEI 1 depende disto: a página que NÃO mudou de lugar mas saiu de vista
  // (overlay do host por cima, seção recolhida) precisa que o `false`
  // atravesse. Deduplicar só pela geometria pintaria uma página de internet por
  // cima do chat do dono.
  assert.equal(gate.accept({ ...caixa }, false), true, 'sair de vista é notícia')
  assert.equal(gate.accept({ ...caixa }, false), false)
  assert.equal(gate.accept({ ...caixa }, true), true, 'voltar à vista também')
  assert.deepEqual(gate.last(), { rect: caixa, visible: true })

  // Mexeu um pixel em QUALQUER ponta: passa.
  assert.equal(gate.accept({ ...caixa, height: 201 }, true), true)
  assert.equal(gate.accept({ ...caixa, x: 11, height: 201 }, true), true)
})

test('PORTÃO: a SOLTA do gesto zera o portão — o relato repetido volta a passar', () => {
  const gate = createBrowserBoundsGate()
  const caixa = { x: 0, y: 0, width: 320, height: 260 }
  assert.equal(gate.accept(caixa, true), true)
  assert.equal(gate.accept({ ...caixa }, true), false)

  // O caso real: o arrasto passou por 260px no meio do gesto; na SOLTA, o
  // render reclampa a fração contra a régua nova e reencontra 260px. Sem zerar,
  // o portão calaria — e a página nativa ficaria parada na altura do último
  // quadro do arrasto, que é outra. O mesmo zerar serve à view recém-nascida
  // (o motor não adivinha o retângulo) e ao painel que voltou à vista.
  gate.reset()
  assert.equal(gate.last(), null)
  assert.equal(gate.accept({ ...caixa }, true), true, 'depois do reset o repetido TEM de passar')
})

test('IRMÃS: quem observa é a vizinhança — a seção que CONTÉM a página fica de fora', () => {
  // Uma irmã que recolhe empurra a página sem mudar o tamanho de ninguém: nem
  // o retângulo, nem os ancestrais que recortam, nem o body. Era o único
  // movimento que dependia do relógio de 400ms (medido: mediana 300ms, p95 384ms).
  const entrega = { nome: 'entrega', dona: false }
  const trabalho = { nome: 'trabalho', dona: false }
  const browser = { nome: 'browser', dona: true }
  const release = { nome: 'release', dona: false }
  const irmas = browserSiblingsToWatch(
    [entrega, trabalho, browser, release],
    (secao) => secao.dona
  )
  assert.deepEqual(
    irmas.map((s) => s.nome),
    ['entrega', 'trabalho', 'release']
  )
  // A DONA fica de fora de propósito: ela muda de tamanho a cada quadro do
  // próprio arrasto da alça, e o observador do retângulo já conta isso. Na
  // sonda, observá-la triplicou os relatos deduplicados de um arrasto (105 →
  // 375) sem mover um milissegundo do atraso.
  assert.equal(
    irmas.some((s) => s.dona),
    false
  )
  // Trilho com uma seção só (a do browser) e trilho vazio: lista vazia, nunca
  // uma exceção no meio da montagem do painel.
  assert.deepEqual(browserSiblingsToWatch([browser], (s) => s.dona), [])
  assert.deepEqual(browserSiblingsToWatch([], (s) => s.dona), [])
})

// ————————————————————————————————————————————————————————————————
// A.2 A ALTURA DA PÁGINA — a fração do trilho
// ————————————————————————————————————————————————————————————————
//
// REPROVAÇÃO DO DONO (2026-08-29, painel vivo na tela): "não gostei do browser,
// ele não é adaptativo igual do claude code. Ele tem altura travada, fora que
// não vai se adaptando igual."
//
// A altura vinha de um `clamp(180px, 34vh, 460px)` do CSS: teto absoluto de
// 460px, nenhum gesto do dono, nenhuma adaptação de verdade. Estas cercas
// prendem o modelo que a substituiu — uma FRAÇÃO do trilho, com piso e teto em
// pixels e preferência por projeto. Contra o código velho elas nem chegam a
// falhar por valor: as funções não existiam (`TypeError`), que é a prova de que
// o teto morreu de fato, e não foi remendado.

/** Storage de mentira no formato do `window.localStorage` (só o que o modelo
 *  usa). `broken` simula o que o Chromium faz num contexto sem storage: LANÇA
 *  em vez de devolver `null`. */
function fakeStorage(seed = {}, { broken = false } = {}) {
  const bag = new Map(Object.entries(seed))
  return {
    bag,
    getItem(key) {
      if (broken) throw new DOMException('storage bloqueado', 'SecurityError')
      return bag.has(key) ? bag.get(key) : null
    },
    setItem(key, value) {
      if (broken) throw new DOMException('storage bloqueado', 'SecurityError')
      bag.set(key, value)
    }
  }
}

test('ALTURA: a página é uma FRAÇÃO do trilho — a MESMA preferência se adapta a cada tela', () => {
  // O "vai se adaptando" que o dono pediu: uma preferência só, alturas
  // diferentes conforme a coluna que existe. Nada disto é possível com pixels
  // guardados.
  assert.equal(browserPageHeight(0.55, 800), 440)
  assert.equal(browserPageHeight(0.55, 1200), 660)
  assert.equal(browserPageHeight(0.55, 500), 275)

  // E O TETO DE 460px ESTÁ MORTO. Era ele que travava a página numa tela
  // grande — o defeito que o dono viu.
  assert.ok(
    browserPageHeight(BROWSER_PAGE_DEFAULT_FRACTION, 1400) > 460,
    'numa tela alta a página tem que passar do antigo teto de 460px'
  )
  assert.equal(browserPageHeight(BROWSER_PAGE_DEFAULT_FRACTION, 1400), 770)
})

test('ALTURA: o PISO de 180px vence a fração, e o TETO respeita o palmo das irmãs', () => {
  // Fração pequena num trilho curto ainda entrega página legível: abaixo de
  // 180px não existe QA visual nenhum, só uma fresta escura.
  assert.equal(browserPageHeight(BROWSER_PAGE_MIN_FRACTION, 400), BROWSER_PAGE_MIN_HEIGHT)

  // Fração grande NÃO come o trilho inteiro: entrega, trabalho e histórico
  // continuam com um palmo de coluna à vista.
  assert.deepEqual(browserPageBounds(900), { min: 180, max: 900 - BROWSER_PAGE_RAIL_FLOOR })
  assert.equal(browserPageHeight(BROWSER_PAGE_MAX_FRACTION, 900), 740)
  assert.ok(browserPageHeight(1, 900) <= 900 - BROWSER_PAGE_RAIL_FLOOR)
})

test('ALTURA: o RESTO MEDIDO vence o chute — a alça nunca sai da viewport do trilho', () => {
  // BUG PAGO (dono na tela viva, 2026-08-29): "eu aumento o tamanho aí some e
  // não tem mais como diminuir". Com as irmãs colapsadas o resto real (~240px)
  // passa do floor de 160: a página crescia além do fold e a alça ficava atrás
  // da view nativa — que come o wheel, então não havia como rolar até ela.
  // Com o resto MEDIDO, o teto garante: página + resto ≤ viewport do trilho,
  // logo o pé do painel (a alça) está SEMPRE dentro do quadro.
  const rail = 900
  const rest = 240
  assert.deepEqual(browserPageBounds(rail, { railRest: rest }), { min: 180, max: 660 })
  assert.ok(
    browserPageHeight(BROWSER_PAGE_MAX_FRACTION, rail, { railRest: rest }) + rest <= rail,
    'a página no máximo ainda deixa o resto (e a alça) dentro da viewport'
  )
  // Resto pequeno (irmãs colapsadas E chrome enxuto) DÁ MAIS página que o
  // floor daria — o chute era conservador nos dois sentidos.
  assert.equal(browserPageBounds(rail, { railRest: 90 }).max, 810)
  // Sem medida (primeiro quadro, harness), o floor de sempre.
  assert.equal(browserPageBounds(rail).max, rail - BROWSER_PAGE_RAIL_FLOOR)
  // Lixo na medida não vira NaN nem teto negativo.
  assert.deepEqual(browserPageBounds(rail, { railRest: Number.NaN }), {
    min: 180,
    max: rail - BROWSER_PAGE_RAIL_FLOOR
  })
  assert.equal(browserPageBounds(200, { railRest: 500 }).max, 0)
})

test('ALTURA: trilho apertado faz o PISO ceder — a geometria nunca devolve min > max', () => {
  // Mesma escolha do `rightRailBounds`: com a coluna curta o piso cede, porque
  // um clamp com min > max passaria a mentir e estouraria o dock.
  const apertado = browserPageBounds(300)
  assert.equal(apertado.max, 140)
  assert.equal(apertado.min, 140, 'o piso cede em vez de estourar a coluna')
  assert.equal(browserPageHeight(0.55, 300), 140)

  // Trilho menor que o palmo das irmãs: zero, e não um número negativo que o
  // CSS aceitaria calado.
  assert.deepEqual(browserPageBounds(100), { min: 0, max: 0 })
  assert.equal(browserPageHeight(0.55, 100), 0)

  // Trilho AINDA NÃO MEDIDO (primeiro quadro) e lixo do DOM não viram NaN.
  assert.deepEqual(browserPageBounds(0), { min: 0, max: 0 })
  assert.equal(browserPageHeight(0.55, 0), 0)
  assert.equal(browserPageHeight(0.55, Number.NaN), 0)
  assert.equal(browserPageHeight(Number.NaN, 800), 440, 'fração torta cai no padrão')
})

test('ALTURA: as pontas que a ALÇA anuncia são as ALCANÇÁVEIS, não as teóricas', () => {
  // Num trilho alto a fração mínima chega ANTES do piso de 180px: prometer 180
  // no `aria-valuemin` seria oferecer ao teclado um valor que o gesto nunca
  // alcança.
  assert.equal(browserPageBounds(2000).min, BROWSER_PAGE_MIN_HEIGHT)
  assert.deepEqual(browserPageRange(2000), { min: 300, max: 1800 })
  // Num trilho médio quem manda são os pixels, e as duas contas coincidem.
  assert.deepEqual(browserPageRange(800), { min: 180, max: 640 })
  // Home/End nunca saem da faixa que a alça anunciou.
  const range = browserPageRange(1000)
  assert.equal(browserPageHeight(browserPageFraction(range.min, 1000), 1000), range.min)
  assert.equal(browserPageHeight(browserPageFraction(range.max, 1000), 1000), range.max)
})

test('ALTURA: a fração clampa nas DUAS pontas antes de virar conta ou preferência', () => {
  assert.equal(clampBrowserPageFraction(9), BROWSER_PAGE_MAX_FRACTION)
  assert.equal(clampBrowserPageFraction(-4), BROWSER_PAGE_MIN_FRACTION)
  assert.equal(clampBrowserPageFraction(Number.NaN), BROWSER_PAGE_DEFAULT_FRACTION)
  assert.equal(clampBrowserPageFraction(Number.POSITIVE_INFINITY), BROWSER_PAGE_DEFAULT_FRACTION)
  assert.equal(clampBrowserPageFraction(0.42), 0.42)
})

test('ALTURA: pixels → fração → pixels fecha o ciclo (o que o arrasto grava)', () => {
  assert.equal(browserPageFraction(440, 800), 0.55)
  assert.equal(browserPageHeight(browserPageFraction(440, 800), 800), 440)

  // Arrasto que passa do teto grava o TETO, não o exagero: soltar o ponteiro
  // não pode fazer a página pular de volta.
  const alem = browserPageFraction(5000, 800)
  assert.equal(browserPageHeight(alem, 800), 640)
  // Arrasto que passa do piso, idem.
  assert.equal(browserPageHeight(browserPageFraction(-99, 800), 800), 180)

  // Trilho sem medida NUNCA vira divisão por zero na preferência do dono.
  assert.equal(browserPageFraction(400, 0), BROWSER_PAGE_DEFAULT_FRACTION)
  assert.equal(Number.isFinite(browserPageFraction(400, 0)), true)
})

test('ALTURA: o passo do teclado é em PIXELS — a seta empurra igual em toda tela', () => {
  const cresceu = stepBrowserPageFraction(0.55, 'grow', 800)
  assert.equal(browserPageHeight(cresceu, 800), 440 + BROWSER_PAGE_KEYBOARD_STEP)
  const encolheu = stepBrowserPageFraction(0.55, 'shrink', 800)
  assert.equal(browserPageHeight(encolheu, 800), 440 - BROWSER_PAGE_KEYBOARD_STEP)
  // Shift dobra o passo (o mesmo gesto do `.right-rail-resizer`).
  assert.equal(
    browserPageHeight(stepBrowserPageFraction(0.55, 'grow', 800, BROWSER_PAGE_KEYBOARD_STEP * 2), 800),
    440 + BROWSER_PAGE_KEYBOARD_STEP * 2
  )
  // Nas pontas a seta PARA — nunca guarda um valor que a tela não desenha.
  const noTeto = browserPageFraction(browserPageRange(800).max, 800)
  assert.equal(browserPageHeight(stepBrowserPageFraction(noTeto, 'grow', 800), 800), 640)
  const noPiso = browserPageFraction(browserPageRange(800).min, 800)
  assert.equal(browserPageHeight(stepBrowserPageFraction(noPiso, 'shrink', 800), 800), 180)
  // Passo torto não derruba a conta.
  assert.equal(Number.isFinite(stepBrowserPageFraction(0.55, 'grow', 800, Number.NaN)), true)
})

test('ALTURA: a preferência é POR PROJETO, e gravar/ler fecha o ciclo', () => {
  // Chave no estilo das irmãs (`DockSection`, `rightRailSizing`), com o id do
  // projeto escapado: universo com `/` no nome não pode escrever noutra chave.
  assert.equal(browserPageStorageKey('u-1'), 'synkora.dockBrowser.page.v1:u-1')
  assert.equal(browserPageStorageKey('a/b'), 'synkora.dockBrowser.page.v1:a%2Fb')
  assert.equal(browserPageStorageKey('  '), 'synkora.dockBrowser.page.v1')
  assert.notEqual(browserPageStorageKey('u-1'), browserPageStorageKey('u-2'))

  const storage = fakeStorage()
  const key = browserPageStorageKey('u-1')
  // Sem nada guardado, o padrão.
  assert.equal(readBrowserPageFraction(storage, key), BROWSER_PAGE_DEFAULT_FRACTION)
  writeBrowserPageFraction(storage, key, 0.72)
  assert.equal(readBrowserPageFraction(storage, key), 0.72)
  // O universo vizinho continua com o padrão: a altura é de quem a escolheu.
  assert.equal(
    readBrowserPageFraction(storage, browserPageStorageKey('u-2')),
    BROWSER_PAGE_DEFAULT_FRACTION
  )
  // Dízima do arrasto entra ARREDONDADA (três casas) — 17 dígitos no storage do
  // dono não contam nada a mais.
  writeBrowserPageFraction(storage, key, 1 / 3)
  assert.equal(storage.bag.get(key), JSON.stringify({ fraction: 0.333 }))
  // E o que se grava já está clampado: fração absurda não fica no disco.
  writeBrowserPageFraction(storage, key, 40)
  assert.equal(readBrowserPageFraction(storage, key), BROWSER_PAGE_MAX_FRACTION)
})

test('ALTURA: storage quebrado ou torto degrada para o padrão — NUNCA uma exceção', () => {
  const key = browserPageStorageKey('u-1')
  // Storage que LANÇA na leitura e na escrita (contexto sem storage, cota
  // estourada): a altura vale por esta sessão, o dock abre igual.
  const quebrado = fakeStorage({}, { broken: true })
  assert.equal(readBrowserPageFraction(quebrado, key), BROWSER_PAGE_DEFAULT_FRACTION)
  assert.doesNotThrow(() => writeBrowserPageFraction(quebrado, key, 0.6))

  // Sem storage nenhum (o modelo roda fora do browser).
  assert.equal(readBrowserPageFraction(null, key), BROWSER_PAGE_DEFAULT_FRACTION)
  assert.doesNotThrow(() => writeBrowserPageFraction(null, key, 0.6))

  // JSON quebrado, formato de outra versão, campo de outro tipo e número
  // impossível: todos caem no padrão em silêncio.
  for (const sujeira of ['{', 'null', '"0.8"', '[]', '{"fraction":"0.8"}', '{"fraction":null}']) {
    assert.equal(
      readBrowserPageFraction(fakeStorage({ [key]: sujeira }), key),
      BROWSER_PAGE_DEFAULT_FRACTION,
      `preferência corrompida (${sujeira}) tem que degradar para o padrão`
    )
  }
  // Guardado fora da faixa (versão futura, edição à mão) volta para dentro.
  assert.equal(
    readBrowserPageFraction(fakeStorage({ [key]: '{"fraction":12}' }), key),
    BROWSER_PAGE_MAX_FRACTION
  )
  // E o fallback pedido também passa pelo clamp.
  assert.equal(readBrowserPageFraction(null, key, 99), BROWSER_PAGE_MAX_FRACTION)
})

// ————————————————————————————————————————————————————————————————
// B. O MOTOR (H1) — host e webContents FALSOS
// ————————————————————————————————————————————————————————————————

let nextWebContentsId = 1

/** O `WebContents` que o motor realmente usa: um EventEmitter com as consultas
 *  de navegação. É de propósito um emitter DE VERDADE — o motor assina eventos
 *  do Chromium (`did-navigate`, `destroyed`, `render-process-gone`) e a suíte
 *  precisa poder dispará-los. */
function fakeWebContents() {
  const wc = new EventEmitter()
  wc.id = nextWebContentsId++
  wc.url = ''
  wc.title = 'sem título'
  wc.destroyed = false
  wc.closed = false
  wc.loading = false
  wc.devtoolsOpen = false
  wc.isDestroyed = () => wc.destroyed
  wc.getURL = () => wc.url
  wc.getTitle = () => wc.title
  wc.isLoading = () => wc.loading
  wc.navigationHistory = {
    back: false,
    forward: false,
    canGoBack: () => wc.navigationHistory.back,
    canGoForward: () => wc.navigationHistory.forward,
    goBack: () => {
      wc.navigationHistory.wentBack = true
    },
    goForward: () => {
      wc.navigationHistory.wentForward = true
    }
  }
  wc.reload = () => {
    wc.reloaded = (wc.reloaded ?? 0) + 1
  }
  wc.loadURL = async (url) => {
    wc.url = url
    wc.loaded = (wc.loaded ?? 0) + 1
  }
  wc.close = () => {
    wc.closed = true
    wc.destroyed = true
  }
  wc.openDevTools = (options) => {
    wc.devtoolsOpen = true
    wc.devtoolsMode = options?.mode
  }
  wc.closeDevTools = () => {
    wc.devtoolsOpen = false
  }
  wc.isDevToolsOpened = () => wc.devtoolsOpen
  wc.setWindowOpenHandler = (handler) => {
    wc.windowOpenHandler = handler
  }
  // ——— O ZOOM DE AJUSTE (a largura que a página enxerga, 2026-08-29) ———
  //
  // O dublê é o `HostZoomMap` do Chromium visto de fora, e ele é COMPARTILHADO
  // POR ORIGEM de propósito: a sonda mediu que `setZoomFactor` numa aba VAZA
  // para toda aba do mesmo host na mesma sessão (a view irmã pulou de
  // `innerWidth 540` para 1728 sozinha; a de outra partition não se mexeu).
  //
  // Isso não é capricho de fidelidade: é o que faz a ORDEM de escrita importar.
  // Com duas abas da mesma missão no mesmo endereço e modos diferentes, quem
  // escrever por último vence — e tem de ser a aba que o dono está OLHANDO. Um
  // dublê com zoom por aba não prenderia essa regressão.
  wc.zooms = []
  wc.zoomKey = () => {
    try {
      return new URL(wc.url).host || `wc:${wc.id}`
    } catch {
      return `wc:${wc.id}`
    }
  }
  wc.getZoomFactor = () => HOST_ZOOM.get(wc.zoomKey()) ?? 1
  wc.setZoomFactor = (factor) => {
    HOST_ZOOM.set(wc.zoomKey(), factor)
    wc.zooms.push(factor)
  }
  // Escrever `wc.zoom` continua valendo (é como a suíte simula o vazamento de um
  // vizinho): ele é a mesma célula do mapa, vista pela aba.
  Object.defineProperty(wc, 'zoom', {
    get: () => wc.getZoomFactor(),
    set: (factor) => HOST_ZOOM.set(wc.zoomKey(), factor)
  })
  return wc
}

/** O mapa de zoom POR HOST da sessão — o dublê do `HostZoomMap` do Chromium.
 *  Zerado a cada aba nova para um teste não herdar o zoom do anterior. */
const HOST_ZOOM = new Map()

/**
 * O host falso. Ele é o CARCEREIRO DA PRIMEIRA LEI: com `forbidDetach` ligado,
 * qualquer `detach` fora do teardown lança na hora, com o nome da lei. Um
 * contador seria informação; isto é uma armadilha — e é o que faz a regressão
 * morrer no ponto do crime, em vez de virar uma pendura de 5-8 s no
 * `browser_shot` de alguém, semanas depois.
 */
function fakeHost(options = {}) {
  const log = []
  const views = []
  const host = {
    log,
    views,
    hardened: [],
    hooks: null,
    windowHooks: null,
    forbidDetach: false,
    visible: options.visible ?? true,
    size: options.size ?? { width: 1440, height: 900 },
    noWindow: options.noWindow ?? false,
    /** ONDE cada view está pendurada, do ponto de vista do Electron: `'app'`, a
     *  janela DESTACADA, ou `null` (ÓRFÃ — a janela morreu por baixo dela). É a
     *  contabilidade que o `viewWindow` abaixo consulta. */
    where: new Map(),
    create(partition) {
      if (host.noWindow) return null
      const wc = fakeWebContents()
      const view = {
        webContents: wc,
        bounds: null,
        visible: false,
        attached: false,
        setBounds(bounds) {
          view.bounds = bounds
          log.push({ kind: 'setBounds', wc: wc.id, bounds })
        },
        setVisible(value) {
          view.visible = value
          log.push({ kind: 'setVisible', wc: wc.id, value })
        },
        getVisible: () => view.visible
      }
      views.push(view)
      host.where.set(view, 'app')
      log.push({ kind: 'create', wc: wc.id, partition })
      return view
    },
    attach(view) {
      view.attached = true
      host.where.set(view, 'app')
      log.push({ kind: 'attach', wc: view.webContents.id })
    },
    detach(view) {
      if (host.forbidDetach) {
        throw new Error(
          `PRIMEIRA LEI VIOLADA: a view ${view.webContents.id} foi DESANEXADA fora do teardown — esconder é setVisible(false)`
        )
      }
      view.attached = false
      // Fora de toda árvore = ÓRFÃ, e é isto que `BrowserWindow.fromWebContents`
      // enxerga (`null`) enquanto `getVisible()`/`isDestroyed()` mentem.
      host.where.set(view, null)
      log.push({ kind: 'detach', wc: view.webContents.id })
    },
    hardenSession(partition, hooks) {
      host.hardened.push(partition)
      host.hooks = hooks
    },
    contentSize: () => host.size,
    windowVisible: () => host.visible,
    watchWindow(hooks) {
      host.windowHooks = hooks
      return () => {
        host.windowHooks = null
      }
    }
  }
  // `viewWindow` (a guarda de 296 ns: `BrowserWindow.fromWebContents`) é
  // OPCIONAL no contrato DE PROPÓSITO — o host que nasceu antes do pop-out não
  // o tem, e ali o motor cai na pergunta antiga (`windowVisible`). Por isso ele
  // só existe quando o teste PEDE: as cercas de cima continuam cobrindo a perna
  // do host sem `viewWindow`, que é a que roda hoje no gate.
  if (options.tracksWindows) {
    host.viewWindow = (view) => {
      const at = host.where.get(view) ?? null
      if (at === null) return null
      if (at === 'app') return { id: 1, visible: host.visible, minimized: !host.visible }
      return { id: at.id, visible: at.shown && !at.minimized, minimized: at.minimized }
    }
  }
  return host
}

function makeManager(options = {}) {
  // O mapa de zoom do Chromium é da SESSÃO: cada cenário começa limpo, senão um
  // teste herdaria o zoom que o anterior deixou no mesmo host.
  HOST_ZOOM.clear()
  const host = fakeHost(options)
  const records = []
  const pushes = []
  const manager = createBrowserManager({
    // O motor resolve o host lazy; com `host` injetado a janela nunca é tocada.
    window: () => null,
    host,
    record: (input) => records.push(input),
    push: (channel, ...args) => pushes.push({ channel, args })
  })
  const detaches = () => host.log.filter((entry) => entry.kind === 'detach').length
  return { manager, host, records, pushes, detaches }
}

const RECT = { x: 300, y: 120, width: 600, height: 400 }

// ————— URL do dono e partition —————

test('MOTOR: localhost sai em http, o resto em https, e `localhost:5173` não cai na armadilha do esquema', () => {
  // ARMADILHA PAGA: `localhost:5173` casa o regex de esquema (`localhost:` vira
  // protocolo) e o `new URL` ACEITA, devolvendo um endereço que não abre nada.
  // O discriminador é o dígito depois dos dois pontos.
  assert.equal(normalizeBrowserUrl('localhost:5173').url, 'http://localhost:5173/')
  assert.equal(normalizeBrowserUrl('127.0.0.1:8090/backlog').url, 'http://127.0.0.1:8090/backlog')
  assert.equal(normalizeBrowserUrl('localhost').url, 'http://localhost/')
  assert.equal(normalizeBrowserUrl('exemplo.com').url, 'https://exemplo.com/')
  assert.equal(normalizeBrowserUrl('http://exemplo.com/a').url, 'http://exemplo.com/a')
  assert.equal(normalizeBrowserUrl('about:blank').url, 'about:blank')
})

test('MOTOR: `javascript:` recusa NOMEANDO o canal certo, e texto solto não vira busca', () => {
  const js = normalizeBrowserUrl('javascript:alert(1)')
  assert.equal(js.ok, false)
  // Beco sem saída é bug: a recusa aponta a tool que roda código NA página.
  assert.match(js.error, /browser_eval/u)
  const texto = normalizeBrowserUrl('como fazer um dashboard')
  assert.equal(texto.ok, false)
  // Nenhum buscador foi decidido — o app não manda o que o dono digitou para um
  // terceiro por conta própria; a recusa ENSINA o formato.
  assert.match(texto.error, /localhost:5173/u)
  assert.equal(normalizeBrowserUrl('   ').ok, false)
})

test('MOTOR: a sessão é do PROJETO (`persist:browser:<projectId>`), endurecida uma vez por projeto', async () => {
  assert.equal(browserPartitionFor('universo-1'), 'persist:browser:universo-1')
  assert.equal(browserPartitionFor('../fora'), 'persist:browser:fora', 'a partition é sanitizada')
  assert.equal(browserPartitionFor(''), 'persist:browser:sem-projeto')

  const { manager, host } = makeManager()
  await manager.ensureTab('m1', 'proj-a', 'https://a.test/')
  await manager.newTab('m1', 'proj-a', 'https://b.test/')
  // Duas missões do MESMO projeto compartilham a sessão: o login do dono vale
  // para todas elas (D5.3).
  await manager.ensureTab('m2', 'proj-a', 'https://c.test/')
  await manager.ensureTab('m3', 'proj-b', 'https://d.test/')
  const partitions = host.log.filter((e) => e.kind === 'create').map((e) => e.partition)
  assert.deepEqual(partitions, [
    'persist:browser:proj-a',
    'persist:browser:proj-a',
    'persist:browser:proj-a',
    'persist:browser:proj-b'
  ])
  assert.deepEqual([...new Set(host.hardened)], ['persist:browser:proj-a', 'persist:browser:proj-b'])
})

// ————— ciclo de vida —————

test('MOTOR/CICLO: o nascimento é LAZY — retângulo do painel sozinho não cria browser nenhum', () => {
  // O painel MEDE desde que monta, e a maioria das missões nunca abre browser.
  // Se `applyBounds` criasse a view, toda missão pagaria um processo de renderer.
  const { manager, host } = makeManager()
  manager.applyBounds('m1', RECT, true)
  manager.applyBounds('m1', RECT, false)
  assert.equal(host.views.length, 0)
  assert.equal(manager.state('m1').alive, false)
  assert.equal(manager.hasMission('m1'), false)
})

test('MOTOR/CICLO: a aba nasce ANEXADA, INVISÍVEL e com bounds REAIS — mesmo com o dock fechado', async () => {
  const { manager, host, records } = makeManager()
  const opened = await manager.ensureTab('m1', 'proj-a', 'localhost:5173')
  assert.equal(host.views.length, 1)
  const view = host.views[0]
  assert.equal(view.attached, true)
  assert.equal(view.visible, false)
  // Sem bounds reais a superfície nasceria 0×0 e a captura devolveria imagem
  // vazia ("Cannot take screenshot with 0 width" do lado CDP, P7).
  assert.ok(view.bounds.width > 0 && view.bounds.height > 0, 'refúgio com tamanho de verdade')
  assert.equal(opened.webContents.getURL(), 'http://localhost:5173/')
  const born = records.find((entry) => entry.event === 'browser-tab-open')
  assert.ok(born, 'o nascimento entra na caixa-preta')
  assert.equal(born.ids.missionId, 'm1')
  assert.equal(born.ids.projectId, 'proj-a')
  assert.equal(born.detail.partition, 'persist:browser:proj-a')
})

test('MOTOR/CICLO: `ensureTab` é IDEMPOTENTE — reusa a aba morna e só navega quando o alvo é outro', async () => {
  const { manager, host } = makeManager()
  const first = await manager.ensureTab('m1', 'p', 'https://a.test/')
  const same = await manager.ensureTab('m1', 'p', 'https://a.test/')
  assert.equal(first.tabId, same.tabId)
  assert.equal(host.views.length, 1)
  assert.equal(same.webContents.loaded, 1, 'mesma URL não recarrega a página do dono debaixo dele')
  const moved = await manager.ensureTab('m1', 'p', 'https://b.test/')
  assert.equal(moved.tabId, first.tabId)
  assert.equal(moved.webContents.getURL(), 'https://b.test/')
  assert.equal(moved.webContents.loaded, 2)
})

test('MOTOR/CICLO: endereço inválido do agente RECUSA antes de nascer view nenhuma', async () => {
  const { manager, host } = makeManager()
  await assert.rejects(() => manager.ensureTab('m1', 'p', 'javascript:alert(1)'), /browser_eval/u)
  assert.equal(host.views.length, 0, 'recusa não deixa casca pendurada')
})

test('MOTOR/CICLO: fechar a ÚLTIMA aba encerra o browser da missão (e devolve o processo)', async () => {
  const { manager, host, records } = makeManager()
  const first = await manager.ensureTab('m1', 'p', 'https://a.test/')
  const second = await manager.newTab('m1', 'p', 'https://b.test/')
  assert.equal(manager.closeTab('m1', second.tabId), true)
  assert.equal(manager.hasMission('m1'), true, 'ainda sobra uma aba')
  assert.equal(manager.closeTab('m1', first.tabId), true)
  assert.equal(manager.hasMission('m1'), false)
  assert.equal(host.views.every((view) => view.attached === false), true)
  assert.equal(host.views.every((view) => view.webContents.closed), true)
  assert.ok(records.some((entry) => entry.event === 'browser-mission-closed'))
  assert.equal(manager.closeTab('m1', first.tabId), false, 'gesto sobre missão morta não explode')
})

test('MOTOR/CICLO: `closeMission` derruba tudo, registra e zera o state (a partition do projeto persiste)', async () => {
  const { manager, host, records } = makeManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  await manager.newTab('m1', 'p', 'https://b.test/')
  await manager.ensureTab('m2', 'p', 'https://c.test/')
  manager.closeMission('m1')

  // `host: 'dock'` entrou na fotografia com o POP-OUT (P1): missão zerada
  // volta ao dock por definição — não existe janela órfã de missão morta.
  // `viewport: 'auto'` entrou com a LARGURA EMULADA (2026-08-29): missão zerada
  // não emula nada, e o seletor do chrome desenha AUTO aceso.
  assert.deepEqual(manager.state('m1'), {
    alive: false,
    agentDriving: false,
    tabs: [],
    host: 'dock',
    viewport: 'auto'
  })
  assert.equal(manager.hasMission('m1'), false)
  assert.equal(manager.hasMission('m2'), true, 'a missão vizinha não é levada junto')
  assert.equal(host.views.filter((view) => view.attached).length, 1)
  const closed = records.filter((entry) => entry.event === 'browser-mission-closed')
  assert.equal(closed.length, 1)
  assert.equal(closed[0].detail.tabs, 2)
  // Idempotente: os pontos de kill/arquivar/integrar chamam sem perguntar.
  manager.closeMission('m1')
  assert.equal(records.filter((entry) => entry.event === 'browser-mission-closed').length, 1)
})

test('MOTOR/CICLO: a janela fechada encerra tudo — `win.hide()` mataria a captura de todas as views', async () => {
  const { manager, host } = makeManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  await manager.ensureTab('m2', 'p', 'https://b.test/')
  host.windowHooks.onClosed()
  assert.equal(manager.hasMission('m1'), false)
  assert.equal(manager.hasMission('m2'), false)
  assert.equal(host.views.every((view) => view.attached === false), true)
  // Depois do teardown o motor recusa nascer de novo, com receita.
  await assert.rejects(() => manager.ensureTab('m1', 'p'), /reabra o app/u)
})

// ————— A PRIMEIRA LEI —————

test('LEI 1: esconder é setVisible(false) — nenhum caminho do dia a dia DESANEXA', async () => {
  const { manager, host, detaches } = makeManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', RECT, true)
  assert.equal(host.views[0].visible, true)
  assert.deepEqual(host.views[0].bounds, RECT)

  // A ARMADILHA: daqui em diante, um `detach` lança com o nome da lei.
  host.forbidDetach = true

  // 1. seção do dock recolhida / trilho fora de vista
  manager.applyBounds('m1', RECT, false)
  assert.equal(host.views[0].visible, false)
  assert.equal(host.views[0].attached, true)

  // 2. retângulo sem área (rolou para fora, universo montado ao fundo)
  manager.applyBounds('m1', { x: 0, y: 0, width: 0, height: 0 }, true)
  assert.equal(host.views[0].visible, false)
  assert.equal(host.views[0].attached, true)
  // O REFÚGIO: retângulo zerado não vira superfície 0×0 — a view continua
  // capturável, que é o ponto inteiro da lei 1.
  assert.ok(host.views[0].bounds.width > 0 && host.views[0].bounds.height > 0)

  // 3. painel inteiro empurrado para fora depois de um encolhimento da janela
  host.size = { width: 400, height: 300 }
  manager.applyBounds('m1', { x: 900, y: 900, width: 600, height: 400 }, true)
  assert.equal(host.views[0].attached, true)
  assert.ok(host.views[0].bounds.width > 0 && host.views[0].bounds.height > 0)

  // 4. troca de aba dentro da missão
  host.size = { width: 1440, height: 900 }
  const second = await manager.newTab('m1', 'p', 'https://b.test/')
  manager.applyBounds('m1', RECT, true)
  assert.equal(manager.selectTab('m1', second.tabId), true)
  assert.equal(host.views[0].visible, false)
  assert.equal(host.views[0].attached, true)

  assert.equal(detaches(), 0, 'nenhum detach fora do teardown')
})

test('LEI 1: a aba de FUNDO fica anexada e com bounds REAIS — só o setVisible a distingue', async () => {
  const { manager, host, detaches } = makeManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  const second = await manager.newTab('m1', 'p', 'https://b.test/')
  host.forbidDetach = true
  manager.applyBounds('m1', RECT, true)

  // A captura da H2 depende de superfície COM TAMANHO, inclusive na aba oculta:
  // é o que permite `browser_shot` de uma aba de fundo sem tela em branco.
  assert.deepEqual(host.views[0].bounds, RECT)
  assert.deepEqual(host.views[1].bounds, RECT)
  assert.equal(host.views[0].visible, false)
  assert.equal(host.views[1].visible, true)
  assert.equal(host.views[0].attached, true)
  assert.equal(manager.listTabs('m1').find((entry) => entry.active).tabId, second.tabId)
  assert.equal(detaches(), 0)
})

test('LEI 1: só UMA missão ocupa o retângulo do dock, e a que sai NÃO é desanexada', async () => {
  const { manager, host, detaches } = makeManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  await manager.ensureTab('m2', 'p', 'https://b.test/')
  manager.applyBounds('m1', RECT, true)
  assert.equal(host.views[0].visible, true)

  host.forbidDetach = true
  // Trocar de missão sem o painel antigo reportar deixaria a view velha por
  // cima — esconder as outras é MECÂNICO, não depende de o renderer lembrar.
  manager.applyBounds('m2', RECT, true)
  assert.equal(host.views[0].visible, false)
  assert.equal(host.views[0].attached, true)
  assert.equal(host.views[1].visible, true)
  assert.equal(detaches(), 0)
})

test('LEI 1: o teardown é o ÚNICO detach — e ele acontece ANTES do close', async () => {
  const { manager, host } = makeManager()
  const opened = await manager.ensureTab('m1', 'p', 'https://a.test/')
  const wc = opened.webContents.id
  manager.closeMission('m1')
  const kinds = host.log.filter((entry) => entry.wc === wc).map((entry) => entry.kind)
  // Detach primeiro, close depois: o inverso deixaria uma view órfã no
  // contentView se o close falhasse no meio do teardown.
  assert.equal(kinds.at(-1), 'detach')
  assert.equal(kinds.filter((kind) => kind === 'detach').length, 1)
  assert.equal(host.views[0].webContents.closed, true)
})

test('LEI 1: aba que morre POR FORA sai do state sem desanexar quem continua vivo', async () => {
  const { manager, host } = makeManager()
  const first = await manager.ensureTab('m1', 'p', 'https://a.test/')
  await manager.newTab('m1', 'p', 'https://b.test/')
  first.webContents.destroyed = true
  first.webContents.emit('destroyed')
  assert.equal(manager.listTabs('m1').length, 1)
  assert.equal(host.views[1].attached, true, 'a irmã viva não paga pelo crash da outra')
})

// ————— teto de abas —————

test('MOTOR: o teto de 8 abas por missão RECUSA nomeando a receita (e vira nota + caixa-preta)', async () => {
  const { manager, records } = makeManager()
  await manager.ensureTab('m1', 'p')
  for (let n = 1; n < BROWSER_TAB_CAP; n += 1) {
    const opened = await manager.newTab('m1', 'p')
    assert.equal(opened.ok, true, `a aba ${n + 1} devia abrir`)
  }
  assert.equal(manager.listTabs('m1').length, BROWSER_TAB_CAP)

  const refused = await manager.newTab('m1', 'p')
  assert.equal(refused.ok, false)
  assert.match(refused.error, new RegExp(`teto de ${BROWSER_TAB_CAP} abas`, 'u'))
  assert.match(refused.error, /feche uma aba \(×\) antes de abrir outra/u)
  const logged = records.find((entry) => entry.event === 'browser-tab-cap-refused')
  assert.ok(logged, 'a recusa entra no diário')
  assert.equal(logged.detail.cap, BROWSER_TAB_CAP)
  // A recusa também vira NOTA durável: o agente pode ter batido no teto sem o
  // dono estar olhando o painel.
  assert.equal(manager.state('m1').notice.kind, 'tab-cap')
  assert.match(manager.state('m1').notice.text, /feche uma aba/u)

  // O teto é POR MISSÃO — a vizinha continua podendo abrir.
  assert.equal((await manager.newTab('m2', 'p')).ok, true)
})

test('MOTOR: no teto, `ensureTab` do agente NÃO recusa — ele reusa a aba morna', async () => {
  const { manager } = makeManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  for (let n = 1; n < BROWSER_TAB_CAP; n += 1) await manager.newTab('m1', 'p')
  // `browser_open` navega a aba ativa: o teto é do `+` do dono, não do agente.
  const reused = await manager.ensureTab('m1', 'p', 'https://z.test/')
  assert.equal(reused.webContents.getURL(), 'https://z.test/')
  assert.equal(manager.listTabs('m1').length, BROWSER_TAB_CAP)
})

test('MOTOR: pop-up e `target=_blank` viram ABA INTERNA — a janela nativa é sempre negada', async () => {
  const { manager, host } = makeManager()
  const opened = await manager.ensureTab('m1', 'p', 'https://a.test/')
  const decision = opened.webContents.windowOpenHandler({ url: 'https://pop.test/x' })
  assert.deepEqual(decision, { action: 'deny' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(host.views.length, 2, 'o pop-up abriu DENTRO do browser da missão')
  assert.equal(manager.listTabs('m1').length, 2)
  // Endereço que não normaliza não abre aba nenhuma (e continua negado).
  assert.deepEqual(opened.webContents.windowOpenHandler({ url: 'javascript:alert(1)' }), { action: 'deny' })
})

// ————— a superfície de NOTAS (o "evento legível") —————

test('NOTA: download barrado vira recado LEGÍVEL para o dono, além da caixa-preta', async () => {
  const { manager, host, records } = makeManager()
  const opened = await manager.ensureTab('m1', 'proj-a', 'https://a.test/')
  host.hooks.onDownloadBlocked('relatorio-final.zip', 'https://a.test/relatorio-final.zip', opened.webContents.id)

  const notice = manager.state('m1').notice
  assert.equal(notice.kind, 'download-blocked')
  assert.match(notice.text, /relatorio-final\.zip/u)
  // Beco sem saída é bug: a nota diz por onde o arquivo se consegue.
  assert.match(notice.text, /terminal da missão/u)
  assert.ok(Date.parse(notice.at) > 0, 'a nota tem carimbo — é ele que distingue dois avisos iguais')

  const logged = records.find((entry) => entry.event === 'browser-download-blocked')
  assert.equal(logged.ids.missionId, 'm1')
  assert.equal(logged.ids.projectId, 'proj-a')
  assert.equal(logged.detail.filename, 'relatorio-final.zip')
})

test('NOTA: permissão negada, página que não carrega e página que cai também falam', async () => {
  const { manager, host, records } = makeManager()
  const opened = await manager.ensureTab('m1', 'p', 'https://a.test/')

  host.hooks.onPermissionDenied('geolocation', opened.webContents.id)
  assert.equal(manager.state('m1').notice.kind, 'permission-denied')
  assert.match(manager.state('m1').notice.text, /geolocation/u)
  assert.ok(records.some((entry) => entry.event === 'browser-permission-denied'))

  opened.webContents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://nao.existe/', true)
  assert.equal(manager.state('m1').notice.kind, 'load-failed')
  assert.match(manager.state('m1').notice.text, /ERR_NAME_NOT_RESOLVED/u)

  // -3 é ERR_ABORTED: navegação interrompida por outra navegação NÃO é falha —
  // um recado ali viraria ruído em todo clique de link.
  const before = manager.state('m1').notice.at
  opened.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://a.test/', true)
  opened.webContents.emit('did-fail-load', {}, -105, 'iframe', 'https://x.test/', false)
  assert.equal(manager.state('m1').notice.at, before)

  opened.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
  assert.equal(manager.state('m1').notice.kind, 'crashed')
  assert.match(manager.state('m1').notice.text, /⟳/u, 'a nota do crash nomeia o gesto que reabre')
})

test('NOTA: a guarda que dispara sem dono conhecido vai ao diário e NÃO inventa missão', async () => {
  const { manager, host, records } = makeManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  // A session é do PROJETO: um webContents que o motor não conhece (aba de
  // outra missão já derrubada) não pode virar nota na missão errada.
  host.hooks.onDownloadBlocked('x.zip', 'https://a.test/x.zip', 9999)
  assert.equal(manager.state('m1').notice, undefined)
  assert.ok(records.some((entry) => entry.event === 'browser-download-blocked'))
})

// ————— captura, ⚡ e geometria da janela —————

test('GUARDA DE CAPTURA: sem browser e com a janela escondida, recusa NA HORA com a receita', async () => {
  const fechado = makeManager()
  const none = fechado.manager.captureReadiness('m1')
  assert.equal(none.ok, false)
  assert.match(none.error, /browser_open/u)

  // P5: com a janela minimizada/escondida as DUAS rotas de captura PENDURAM
  // (5-8 s) e o agente perde a rodada. Recusar em 1 ms é o comportamento certo.
  const escondida = makeManager({ visible: false })
  await escondida.manager.ensureTab('m1', 'p', 'https://a.test/')
  const refused = escondida.manager.captureReadiness('m1')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /minimizada\/escondida/u)
  assert.match(refused.error, /restaure a janela/u)

  const viva = makeManager()
  const opened = await viva.manager.ensureTab('m1', 'p', 'https://a.test/')
  const ready = viva.manager.captureReadiness('m1')
  assert.equal(ready.ok, true)
  assert.equal(ready.tab.tabId, opened.tabId)
})

test('⚡ DO AGENTE: acende na hora, NÃO pisca entre tools encadeadas e decai depois da última', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { manager, pushes } = makeManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')

  manager.setAgentDriving('m1', true)
  assert.equal(manager.state('m1').agentDriving, true)
  // Cada tool de ação chama `false` no fim; apagar ali faria o ⚡ piscar no meio
  // de um QA de vinte chamadas.
  manager.setAgentDriving('m1', false)
  t.mock.timers.tick(BROWSER_AGENT_DRIVING_DECAY_MS - 1)
  assert.equal(manager.state('m1').agentDriving, true)
  manager.setAgentDriving('m1', true)
  t.mock.timers.tick(BROWSER_AGENT_DRIVING_DECAY_MS - 1)
  assert.equal(manager.state('m1').agentDriving, true, 'a tool seguinte RE-ARMA o decaimento')
  t.mock.timers.tick(2)
  assert.equal(manager.state('m1').agentDriving, false)

  // O broadcast é coalescido: uma rajada de eventos vira UM repaint do dock.
  t.mock.timers.tick(100)
  const changed = pushes.filter((entry) => entry.channel === BROWSER_CHANGED_CHANNEL)
  assert.ok(changed.length > 0, 'o dock é avisado')
  assert.ok(
    changed.every((entry) => entry.args[0] === 'm1'),
    'o broadcast nomeia a missão'
  )
  // Missão sem browser nenhum não acende nada.
  manager.setAgentDriving('m-inexistente', true)
  assert.equal(manager.state('m-inexistente').agentDriving, false)
})

test('MOTOR: mexer na janela reaplica o layout CLAMPADO (o ResizeObserver do painel não acorda)', async () => {
  const { manager, host } = makeManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', { x: 900, y: 100, width: 500, height: 700 }, true)
  assert.deepEqual(host.views[0].bounds, { x: 900, y: 100, width: 500, height: 700 })

  // Arrastar a borda da janela move o retângulo sem mexer no CSS: sem este
  // gancho a view ficaria pendurada para fora do conteúdo.
  host.size = { width: 1000, height: 600 }
  host.windowHooks.onGeometry()
  assert.deepEqual(host.views[0].bounds, { x: 900, y: 100, width: 100, height: 500 })
})

test('MOTOR: o state reflete o `webContents` de verdade, e as alavancas recusam quando não há para onde ir', async () => {
  const { manager } = makeManager()
  const opened = await manager.ensureTab('m1', 'p', 'https://a.test/')
  opened.webContents.title = 'Board · Synkora'
  opened.webContents.loading = true
  opened.webContents.navigationHistory.back = true

  const state = manager.state('m1')
  assert.equal(state.alive, true)
  assert.equal(state.projectId, 'p')
  assert.deepEqual(state.tabs[0], {
    tabId: opened.tabId,
    title: 'Board · Synkora',
    url: 'https://a.test/',
    active: true,
    loading: true,
    canBack: true,
    canForward: false,
    // A largura é POR ABA e nasce em AUTO (2026-08-29).
    viewport: 'auto'
  })

  assert.equal(manager.goBack('m1'), true)
  assert.equal(opened.webContents.navigationHistory.wentBack, true)
  assert.equal(manager.goForward('m1'), false, 'não há para onde avançar')
  assert.equal(manager.reload('m1'), true)
  assert.equal(opened.webContents.reloaded, 1)
  assert.equal(manager.goBack('m-inexistente'), false)
  assert.equal(manager.selectTab('m1', 'aba-que-nao-existe'), false)
})

test('MOTOR: navegar sem browser aberto RECUSA nomeando o `+`, e com aba viva carrega', async () => {
  const { manager } = makeManager()
  const semBrowser = await manager.navigate('m1', 'https://a.test/')
  assert.equal(semBrowser.ok, false)
  assert.match(semBrowser.error, /abra uma aba \(\+\)/u)

  await manager.ensureTab('m1', 'p', 'https://a.test/')
  const bad = await manager.navigate('m1', 'javascript:alert(1)')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /browser_eval/u)

  const ok = await manager.navigate('m1', 'localhost:5173')
  assert.equal(ok.ok, true)
  assert.equal(manager.state('m1').tabs[0].url, 'http://localhost:5173/')
})

test('MOTOR: o devtools abre DESTACADO — acoplado mexeria na geometria de que a captura depende', async () => {
  const { manager } = makeManager()
  const opened = await manager.ensureTab('m1', 'p', 'https://a.test/')
  assert.equal(manager.toggleDevtools('m1'), true)
  assert.equal(opened.webContents.devtoolsMode, 'detach')
  assert.equal(opened.webContents.isDevToolsOpened(), true)
  assert.equal(manager.toggleDevtools('m1'), true)
  assert.equal(opened.webContents.isDevToolsOpened(), false)
  assert.equal(manager.toggleDevtools('m-inexistente'), false)
})

test('MOTOR: retângulo que não é retângulo é recusado na PORTA do IPC', () => {
  assert.equal(isBrowserPanelRect({ x: 0, y: 0, width: 10, height: 10 }), true)
  assert.equal(isBrowserPanelRect({ x: 0, y: 0, width: 10 }), false)
  assert.equal(isBrowserPanelRect({ x: '0', y: 0, width: 10, height: 10 }), false)
  assert.equal(isBrowserPanelRect(null), false)
})

test('MOTOR: sem janela pronta, abrir RECUSA com receita em vez de deixar casca pendurada', async () => {
  const { manager, host } = makeManager({ noWindow: true })
  await assert.rejects(() => manager.ensureTab('m1', 'p'), /janela do Synkora não está pronta/u)
  const gesture = await manager.newTab('m1', 'p')
  assert.equal(gesture.ok, false)
  assert.match(gesture.error, /abra o app e tente de novo/u)
  assert.equal(host.views.length, 0)
})

// ————————————————————————————————————————————————————————————————
// C. A MÁQUINA DE HOST (`src/main/browserPaneHosting.ts`) — o POP-OUT
// ————————————————————————————————————————————————————————————————
//
// O ⧉ do dono REPARENTA A MESMA `WebContentsView` para uma janela própria, em
// UM PASSO. A sonda `PROBE_BROWSER_POPOUT_2026-08-29.md` mediu o gesto em
// binário real (4 ms no main, um quadro de 17 ms) e provou que scroll,
// formulário digitado, timers, SSE, WebSocket e a sessão CDP do agente
// atravessam intactos — recriar a view perderia tudo isso.
//
// A mesma sonda pagou TRÊS armadilhas, e as três são cercas aqui porque nenhuma
// delas quebra nada visível quando é violada:
//
//  1. mover a view para uma janela ESCONDIDA pendura as duas rotas de captura
//     (a view nunca compôs um quadro ali). O pop-out falso é o CARCEREIRO:
//     `attach` numa janela não-mostrada JOGA, no ponto do crime.
//  2. geometria calculada de janela MINIMIZADA sai errada e a captura passa a
//     responder RÁPIDO e MENTINDO (356× seguidas na sonda). `contentSize()`
//     devolve `null` ali, e o `restore` REFAZ o `setBounds` — só isso curou.
//  3. `BrowserWindow.fromWebContents` (296 ns) é o ÚNICO predicado honesto de
//     view ÓRFÃ: `getVisible()` e `isDestroyed()` MENTEM nesse estado, e quem
//     confia neles captura e pendura 6 s.
//
// Tudo aqui é node puro: host, janelas e `webContents` são dublês.

/**
 * As janelas DESTACADAS, de mentira. Elas escrevem na MESMA linha do tempo do
 * host do app (`host.log`, com o prefixo `popout:`) — é isso que permite provar
 * ORDEM ENTRE OS DOIS HOSTS, que é exatamente onde as curas 1 e 3 moram.
 *
 * `userClose()`/`userMinimize()`/`userRestore()` são os gestos do dono com a
 * MESMA fiação do `src/main/index.ts` (espelho declarado: `onCloseRequested →
 * dockBack(…, 'window-close')` e `onRestored → relayout`).
 */
function fakePopouts(host) {
  const windows = new Map()
  const log = host.log
  const wiring = { onCloseRequested: () => undefined, onRestored: () => undefined }
  let nextId = 41

  /** Quem AINDA está pendurado nesta janela. Reparentar é de UM PASSO: o
   *  `addChildView` da outra janela já tira a view daqui, sem `removeChildView`. */
  const heldBy = (win) => host.views.filter((view) => host.where.get(view) === win)

  const destroy = (win, kind) => {
    win.destroyed = true
    // A janela morre e quem ainda estiver nela vira ÓRFÃO — vivo, invisível e
    // com a captura pendurando (§P6). Quem já foi reparentado não é tocado.
    for (const view of heldBy(win)) host.where.set(view, null)
    if (windows.get(win.missionId) === win) windows.delete(win.missionId)
    log.push({ kind: `popout:${kind}`, missionId: win.missionId })
  }

  const handleOf = (win) => ({
    missionId: win.missionId,
    attach(view) {
      if (win.destroyed) return
      if (!win.shown || win.minimized) {
        throw new Error(
          `CURA 1 VIOLADA: a view ${view.webContents.id} foi movida para uma janela do pop-out ESCONDIDA/MINIMIZADA — as duas rotas de captura penduram ali (sonda §P4)`
        )
      }
      host.where.set(view, win)
      log.push({ kind: 'popout:attach', missionId: win.missionId, wc: view.webContents.id })
    },
    detach(view) {
      if (win.destroyed) return
      host.where.set(view, null)
      log.push({ kind: 'popout:detach', missionId: win.missionId, wc: view.webContents.id })
    },
    // CURA 2: nenhum retângulo sai de janela minimizada — `getContentBounds()`
    // do Electron devolve `width:0` ali enquanto `getBounds()` mente.
    contentSize: () => (win.destroyed || win.minimized ? null : win.size),
    visible: () => !win.destroyed && win.shown && !win.minimized,
    focus() {
      win.minimized = false
      win.shown = true
      win.focused += 1
      log.push({ kind: 'popout:focus', missionId: win.missionId })
    },
    setTitle(pageTitle) {
      win.title = pageTitle
      log.push({ kind: 'popout:setTitle', missionId: win.missionId, title: pageTitle })
    }
  })

  const create = (missionId, projectId) => {
    const win = {
      missionId,
      projectId,
      id: nextId++,
      shown: false,
      minimized: false,
      destroyed: false,
      closing: false,
      focused: 0,
      title: '',
      size: { width: 1000, height: 700 },
      /** O X do dono: a janela avisa o MOTOR e só então morre (lei 3). */
      userClose() {
        win.closing = true
        log.push({ kind: 'popout:close-requested', missionId })
        wiring.onCloseRequested(missionId)
        destroy(win, 'closed')
      },
      userMinimize() {
        win.minimized = true
      },
      userRestore() {
        win.minimized = false
        wiring.onRestored(missionId)
      }
    }
    windows.set(missionId, win)
    log.push({ kind: 'popout:create', missionId })
    return win
  }

  const api = {
    windows,
    wiring,
    open(missionId, projectId) {
      const existing = windows.get(missionId)
      // Janela em pleno fechamento não se reusa: ela morre daqui a um tique e
      // levaria a view junto para o limbo.
      const alive = existing && !existing.destroyed && !existing.closing
      const win = alive ? existing : create(missionId, projectId)
      // CURA 1, em ORDEM OBRIGATÓRIA: o `open` real só volta depois de
      // `restore()` (se minimizada) + `showInactive()`. Quem dá o FOCO é o
      // motor, no fim do gesto — janela que rouba o foco antes de a página
      // chegar pisca vazia na cara do dono.
      if (win.minimized) {
        win.minimized = false
        log.push({ kind: 'popout:restore', missionId })
      }
      if (!win.shown) {
        win.shown = true
        log.push({ kind: 'popout:showInactive', missionId })
      }
      return handleOf(win)
    },
    get(missionId) {
      const win = windows.get(missionId)
      return win && !win.destroyed ? handleOf(win) : undefined
    },
    close(missionId) {
      const win = windows.get(missionId)
      if (!win) return
      // Re-entrada: quando o gesto NASCEU do X, o motor reencaixa e pede o
      // fechamento de volta — mas o fechamento já está acontecendo. Fechar de
      // novo aqui seria um segundo `close` no meio do primeiro.
      if (win.closing) {
        log.push({ kind: 'popout:close-noop', missionId })
        return
      }
      win.closing = true
      destroy(win, 'close')
    },
    closeAll() {
      for (const missionId of [...windows.keys()]) api.close(missionId)
    }
  }
  return api
}

function makeHostedManager(options = {}) {
  HOST_ZOOM.clear()
  const host = fakeHost({ tracksWindows: true, ...options })
  const popouts = fakePopouts(host)
  const records = []
  const pushes = []
  const manager = createBrowserManager({
    window: () => null,
    host,
    popouts,
    record: (input) => records.push(input),
    push: (channel, ...args) => pushes.push({ channel, args })
  })
  // ESPELHO DECLARADO da fiação de `src/main/index.ts` (o par): o X da janela
  // REENCAIXA, e o `restore` dela REFAZ a geometria (a cura 2).
  popouts.wiring.onCloseRequested = (missionId) => manager.dockBack(missionId, 'window-close')
  popouts.wiring.onRestored = (missionId) => manager.relayout(missionId)

  /** A linha do tempo dos DOIS hosts, filtrada — é o instrumento que prova
   *  ordem (e ausência) entre a janela do app e a janela destacada. */
  const timeline = (...kinds) => host.log.filter((entry) => kinds.includes(entry.kind)).map((entry) => entry.kind)
  const bounds = () => host.log.filter((entry) => entry.kind === 'setBounds')
  return { manager, host, popouts, records, pushes, timeline, bounds }
}

const POPOUT_RECT = { x: 0, y: 60, width: 1000, height: 640 }
const POPOUT_FULL = { x: 0, y: 0, width: 1000, height: 700 }

test('⧉ CURA 1: a janela fica VISÍVEL antes do reparent, e o gesto é de UM PASSO', async () => {
  const { manager, host, popouts, records, timeline, bounds } = makeHostedManager()
  const opened = await manager.ensureTab('m1', 'p', 'localhost:5173')
  opened.webContents.title = 'Board · Synkora'
  manager.applyBounds('m1', RECT, true, 'dock')
  assert.equal(manager.state('m1').host, 'dock')

  host.log.length = 0
  assert.deepEqual(manager.popOut('m1'), { ok: true })

  // A ORDEM É A CERCA: criar → MOSTRAR → só então mover a view. Mover para
  // janela escondida pendura as DUAS rotas de captura, e o carcereiro do
  // `attach` (acima) joga se alguém inverter isso.
  assert.deepEqual(
    timeline('popout:create', 'popout:showInactive', 'popout:attach', 'attach', 'detach', 'popout:detach'),
    ['popout:create', 'popout:showInactive', 'popout:attach'],
    'criar → mostrar → anexar, sem UM detach: o gesto é de um passo só'
  )
  // O FOCO é o ÚLTIMO passo: a janela aparece com a página dentro.
  assert.ok(
    host.log.findIndex((e) => e.kind === 'popout:focus') >
      host.log.findIndex((e) => e.kind === 'popout:attach')
  )

  assert.equal(manager.state('m1').host, 'popout')
  assert.equal(manager.hostOf('m1'), 'popout')
  // A view foi para o retângulo da JANELA, não para o do dock — e sem relato do
  // cromo ela ocupa a janela inteira (nunca uma faixa preta esperando renderer).
  assert.deepEqual(bounds().at(-1).bounds, POPOUT_FULL)
  // A barra da janela conta a mesma verdade que a aba.
  assert.equal(popouts.windows.get('m1').title, 'Board · Synkora')
  const born = records.find((entry) => entry.event === 'browser-popout-born')
  assert.equal(born.ids.missionId, 'm1')
  assert.equal(born.detail.tabs, 1)
})

test('⧉ IDEMPOTENTE: clicar de novo FOCA a janela que já existe, não abre uma segunda', async () => {
  const { manager, host, popouts } = makeHostedManager()
  await manager.ensureTab('m1', 'p')
  manager.popOut('m1')
  assert.deepEqual(manager.popOut('m1'), { ok: true }, 'gesto repetido é sucesso, não recado vermelho')
  assert.equal(host.log.filter((e) => e.kind === 'popout:create').length, 1, 'UM pop-out por missão')
  assert.equal(popouts.windows.get('m1').focused, 2, 'o segundo ⧉ é o "focar" do recibo do dock')
  // E o segundo gesto NÃO mexeu na página: nada de re-attach, nada de detach.
  assert.equal(host.log.filter((e) => e.kind === 'popout:attach').length, 1)
  assert.equal(host.log.filter((e) => e.kind === 'popout:detach').length, 0)
})

test('⇤ REENCAIXAR: a view volta ao dock ANTES de a janela fechar (nunca fica órfã)', async () => {
  const { manager, host, popouts, records, timeline, bounds } = makeHostedManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', RECT, true, 'dock')
  manager.popOut('m1')

  host.log.length = 0
  assert.deepEqual(manager.dockBack('m1'), { ok: true })

  // A ORDEM: `attach` na janela do app e SÓ ENTÃO o destroy da janela. O
  // Electron 43 não mata o `webContents` filho junto com ela (§P6) — fechar
  // primeiro deixaria uma view viva, invisível e com toda captura pendurando 6s.
  assert.deepEqual(timeline('attach', 'detach', 'popout:attach', 'popout:detach', 'popout:close'), [
    'attach',
    'popout:close'
  ])
  assert.equal(manager.state('m1').host, 'dock')
  assert.equal(popouts.windows.has('m1'), false)
  // A geometria do dock volta no MESMO quadro, sem esperar o ResizeObserver do
  // painel acordar — é para isso que os dois retângulos são guardados.
  assert.deepEqual(bounds().at(-1).bounds, RECT)
  assert.equal(records.find((entry) => entry.event === 'browser-docked-back').detail.trigger, 'gesture')
  // Gesto idempotente: o dono pode clicar duas vezes sem virar recusa.
  assert.deepEqual(manager.dockBack('m1'), { ok: true })
})

test('X DA JANELA = REENCAIXAR: a página volta ao dock e o `webContents` NUNCA morre junto', async () => {
  const { manager, host, popouts, records, timeline, bounds } = makeHostedManager()
  const opened = await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', RECT, true, 'dock')
  manager.popOut('m1')

  host.log.length = 0
  // O X do dono, com a fiação de verdade: a janela avisa o motor e só então
  // morre. O driver do agente NÃO VÊ o fechamento (§P6) — quem avisa é o app.
  popouts.windows.get('m1').userClose()

  assert.equal(manager.state('m1').host, 'dock')
  assert.equal(opened.webContents.isDestroyed(), false, 'fechar a janela nunca perde a página')
  assert.equal(opened.webContents.closed, false)
  assert.equal(manager.listTabs('m1').length, 1)
  // A ORDEM INTEIRA numa asserção: o aviso, o reparent de volta, o pedido de
  // fechamento virando NO-OP (a janela já estava fechando — fechar de novo
  // seria um segundo `close` no meio do primeiro) e só então o destroy.
  assert.deepEqual(
    timeline(
      'popout:close-requested',
      'attach',
      'detach',
      'popout:detach',
      'popout:close',
      'popout:close-noop',
      'popout:closed'
    ),
    ['popout:close-requested', 'attach', 'popout:close-noop', 'popout:closed']
  )
  assert.deepEqual(bounds().at(-1).bounds, RECT)
  assert.equal(records.find((entry) => entry.event === 'browser-docked-back').detail.trigger, 'window-close')
  // E o agente não perde a rodada: a view está numa janela viva de novo.
  assert.equal(manager.captureReadiness('m1').ok, true)
})

test('CURA 2: janela minimizada NÃO recalcula nada, e o restore REFAZ o `setBounds`', async () => {
  const { manager, popouts, bounds } = makeHostedManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.popOut('m1')
  manager.applyBounds('m1', POPOUT_RECT, true, 'popout')
  assert.deepEqual(bounds().at(-1).bounds, POPOUT_RECT)

  const win = popouts.windows.get('m1')
  win.userMinimize()
  const before = bounds().length
  manager.relayout('m1')
  // Nem o lixo que o cromo relata enquanto minimizado: `getContentBounds()`
  // devolve `width:0` ali e a captura passaria a responder rápido e ERRADA.
  manager.applyBounds('m1', { x: 0, y: 0, width: 0, height: 1 }, true, 'popout')
  assert.equal(bounds().length, before, 'nenhum retângulo sai de uma janela minimizada')

  // A CURA MEDIDA: `restore()` sozinho NÃO curou o pixel na sonda — só o
  // `setBounds` REFEITO curou. É o `onRestored` da janela que manda refazer.
  win.userRestore()
  assert.equal(bounds().length, before + 1, 'o restore REFAZ a geometria')
  // Bônus da mesma cerca: o relato degenerado (0×1) não vira superfície de um
  // pixel — cai na janela inteira, onde a página é capturável.
  assert.deepEqual(bounds().at(-1).bounds, POPOUT_FULL)
})

test('AUTORIDADE DE GEOMETRIA: o relato do host ERRADO é ignorado, com UM registro por transição', async () => {
  const { manager, records, bounds } = makeHostedManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', RECT, true, 'dock')
  manager.popOut('m1')

  const before = bounds().length
  // O painel do dock FALA depois do ⧉ (ele relata `visible:false` na faxina do
  // efeito) e o ResizeObserver dele relata a cada quadro. Obedecer isso poria a
  // view no retângulo de uma janela onde ela NEM ESTÁ.
  manager.applyBounds('m1', { x: 0, y: 0, width: 300, height: 200 }, false, 'dock')
  manager.applyBounds('m1', { x: 0, y: 0, width: 301, height: 200 }, true, 'dock')
  assert.equal(bounds().length, before, 'nada do host errado foi aplicado')
  const stale = records.filter((entry) => entry.event === 'browser-bounds-stale-host')
  assert.equal(stale.length, 1, 'UM registro por transição — um por quadro encheria o diário do dono')
  assert.equal(stale[0].detail.reporter, 'dock')
  assert.equal(stale[0].detail.host, 'popout')

  // O host CERTO manda: 60px de cromo no topo da janela destacada.
  manager.applyBounds('m1', POPOUT_RECT, true, 'popout')
  assert.deepEqual(bounds().at(-1).bounds, POPOUT_RECT)

  // E ao contrário: de volta no dock, quem fala fora de hora é a JANELA.
  manager.dockBack('m1')
  const afterBack = bounds().length
  manager.applyBounds('m1', POPOUT_FULL, true, 'popout')
  assert.equal(bounds().length, afterBack)
  assert.equal(
    records.filter((entry) => entry.event === 'browser-bounds-stale-host').length,
    2,
    'a transição de volta RE-ARMA o registro'
  )
  // O painel do dock não mudou de assinatura com o pop-out: sem `reporter`, o
  // relato é dele — quem identifica o host, no app, é o REMETENTE do IPC.
  manager.applyBounds('m1', RECT, true)
  assert.deepEqual(bounds().at(-1).bounds, RECT)
})

test('MISSÃO ENCERRADA leva a janela destacada junto — e o estado volta a `host: dock`', async () => {
  const { manager, host, popouts, records, timeline } = makeHostedManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  await manager.ensureTab('m2', 'p', 'https://b.test/')
  manager.popOut('m1')

  host.log.length = 0
  manager.closeMission('m1')

  // Uma janela órfã na taskbar mostrando uma missão que o dono acabou de
  // arquivar é pior do que qualquer view pendurada.
  assert.equal(popouts.windows.has('m1'), false)
  assert.deepEqual(manager.state('m1'), {
    alive: false,
    agentDriving: false,
    tabs: [],
    host: 'dock',
    viewport: 'auto'
  })
  // O teardown desanexa do HOST CERTO: a view era filha da janela destacada,
  // não da janela do app.
  assert.deepEqual(timeline('detach', 'popout:detach', 'popout:close'), ['popout:detach', 'popout:close'])
  assert.equal(manager.hasMission('m2'), true, 'a missão vizinha não é levada junto')
  assert.ok(records.some((entry) => entry.event === 'browser-mission-closed'))
})

test('QUIT: o teardown geral varre as janelas destacadas — nenhuma sobra na taskbar', async () => {
  const { manager, popouts } = makeHostedManager()
  await manager.ensureTab('m1', 'p')
  await manager.ensureTab('m2', 'p')
  manager.popOut('m1')
  manager.popOut('m2')
  assert.equal(popouts.windows.size, 2, 'missões diferentes podem ter janelas diferentes')
  // E a VARREDURA, que é a razão de o teardown ter uma segunda linha: uma janela
  // que sobrou de missão morta por fora não é alcançada pelo laço de
  // `closeMission`. Janela de trabalho nenhuma sobrevive ao app.
  popouts.open('m-fantasma', 'p')
  assert.equal(popouts.windows.size, 3)

  manager.destroy()
  assert.equal(popouts.windows.size, 0)
})

test('GUARDA DE CAPTURA: view SEM JANELA recusa NA HORA, nomeando a receita', async () => {
  const { manager, host, popouts, records } = makeHostedManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.popOut('m1')
  assert.equal(manager.captureReadiness('m1').ok, true)

  // A janela morreu POR BAIXO da view (o `closed` sem passar pelo `close`): ela
  // fica VIVA e órfã, e é aqui que os predicados ingênuos MENTEM.
  const view = host.views[0]
  popouts.windows.get('m1').destroyed = true
  popouts.windows.delete('m1')
  host.where.set(view, null)
  assert.equal(view.getVisible(), true, '`getVisible()` continua dizendo que está tudo bem')
  assert.equal(view.webContents.isDestroyed(), false, 'e `isDestroyed()` também mente')

  const refused = manager.captureReadiness('m1')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /SEM JANELA/u)
  // Beco sem saída é bug: a recusa nomeia as DUAS portas de volta.
  assert.match(refused.error, /reencaixe/u)
  assert.match(refused.error, /⧉/u)
  const logged = records.find((entry) => entry.event === 'browser-capture-orphan-refused')
  assert.equal(logged.detail.host, 'popout')
  assert.equal(logged.detail.wc, view.webContents.id)
})

test('GUARDA DE CAPTURA: pop-out MINIMIZADO segue capturável — a janela do APP escondida, não', async () => {
  const { manager, host, popouts } = makeHostedManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.popOut('m1')
  popouts.windows.get('m1').userMinimize()
  // A sonda mediu captura FRESCA em 19-81 ms com a janela minimizada/oculta/
  // atrás — desde que a view JÁ tenha composto ali, que é o que as curas 1 e 2
  // garantem. O dono minimiza a janela destacada e o agente SEGUE trabalhando.
  assert.equal(manager.captureReadiness('m1').ok, true)

  // No DOCK nada foi relaxado: ali a captura pendura 5-8 s e a recusa em 1 ms
  // é o comportamento certo.
  manager.dockBack('m1')
  host.visible = false
  const refused = manager.captureReadiness('m1')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /minimizada\/escondida/u)
  assert.match(refused.error, /restaure a janela/u)
})

test('ROTEAMENTO: aba nova de missão destacada nasce NA JANELA DESTACADA', async () => {
  const { manager, host, popouts, timeline } = makeHostedManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.popOut('m1')

  host.log.length = 0
  await manager.newTab('m1', 'p', 'https://b.test/')
  // Nascer na janela do app obrigaria a um SEGUNDO salto — e teria um instante
  // com a view na árvore da janela errada.
  assert.deepEqual(timeline('attach', 'popout:attach'), ['popout:attach'])
  assert.equal(manager.listTabs('m1').length, 2)
  assert.equal(host.where.get(host.views[1]), popouts.windows.get('m1'))
})

test('⇤ REENCAIXAR não rouba o painel de quem está no dock AGORA', async () => {
  const { manager } = makeHostedManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  await manager.ensureTab('m2', 'p', 'https://b.test/')
  manager.applyBounds('m1', RECT, true, 'dock')
  manager.popOut('m1')
  // Cena real: com a página da m1 fora, o dono trocou o painel para a m2 — e
  // clicou "reencaixar" na JANELA da m1, que não sabe disso.
  manager.applyBounds('m2', RECT, true, 'dock')
  manager.dockBack('m1')
  // Volta ANEXADA e invisível (lei 1: segue capturável); quem aparece no quadro
  // seguinte é decidido pelo relato do painel, não pelo `visible` lembrado.
  assert.equal(manager.state('m1').visible, false)
  assert.equal(manager.state('m2').visible, true)
  assert.equal(manager.captureReadiness('m1').ok, true, 'invisível continua capturável')
})

test('⧉ RECUSA COM RECEITA: sem aba aberta, e num app cujo main é anterior ao pop-out', async () => {
  const semAba = makeHostedManager()
  const refusedTab = semAba.manager.popOut('m1')
  assert.equal(refusedTab.ok, false)
  assert.match(refusedTab.error, /abra uma aba \(\+\)/u)

  // O app de ANTES do pop-out (main velho ainda de pé, ⧉ chegando por HMR): o
  // gesto recusa NOMEANDO o restart, em vez de estourar.
  const { manager } = makeManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  const refused = manager.popOut('m1')
  assert.equal(refused.ok, false)
  assert.match(refused.error, /reinicie o Synkora/u)
  assert.equal(manager.state('m1').host, 'dock', 'a recusa não deixa o estado mentindo')
  // Reencaixar quem nunca saiu é SUCESSO; sobre missão que não existe, recusa.
  assert.deepEqual(manager.dockBack('m1'), { ok: true })
  assert.equal(manager.dockBack('missao-que-nao-existe').ok, false)
})

// ————————————————————————————————————————————————————————————————
// D. A LARGURA QUE A PÁGINA ENXERGA (2026-08-29)
// ————————————————————————————————————————————————————————————————
//
// REPROVAÇÃO DO DONO, olhando o painel vivo: "ta meio limitado o quanto consigo
// deixar ele maior, meio que sempre vou ver o site/app com modo tablet, ta um
// pouco diferente de como e hoje no claude code."
//
// A causa é geométrica: a página renderiza na largura FÍSICA do trilho
// (~300-500px), então todo site responsivo entrega o layout de celular. A
// receita saiu de binário real (`PROBE_BROWSER_VIEWPORT_FIT_2026-08-29.md`):
// `setZoomFactor(moldura ÷ larguraLógica)`, SOZINHO — nunca combinado com
// `Emulation.setDeviceMetricsOverride`, que MULTIPLICA (override de 1280 mais
// zoom de 0,3125 entregou 4096 CSS px à página, medido e estável).
//
// O que estas cercas prendem: a MATEMÁTICA (incluindo o piso de 0,25× do
// Chromium, que a API NÃO denuncia) e o QUANDO — porque o zoom sai da moldura, e
// a moldura muda quando o dono arrasta a alça, troca de aba, destaca a janela ou
// navega.

test('LARGURA/PURO: o modo é lido com receita — e largura de engano NÃO vira zoom', () => {
  assert.equal(normalizeViewportMode('auto'), 'auto')
  assert.equal(normalizeViewportMode(undefined), 'auto', 'ausente é auto (motor antigo)')
  assert.equal(normalizeViewportMode(1280), 1280)
  assert.equal(normalizeViewportMode('768'), 768, 'o IPC pode entregar texto')
  assert.equal(normalizeViewportMode(1279.6), 1280, 'sub-pixel não existe em largura de viewport')
  assert.equal(normalizeViewportMode(BROWSER_VIEWPORT_MIN_WIDTH), BROWSER_VIEWPORT_MIN_WIDTH)
  assert.equal(normalizeViewportMode(BROWSER_VIEWPORT_MAX_WIDTH), BROWSER_VIEWPORT_MAX_WIDTH)
  // Fora da faixa e lixo NÃO viram largura: uma escala inventada aqui escalaria
  // a página na tela do dono por causa de um payload torto.
  assert.equal(normalizeViewportMode(BROWSER_VIEWPORT_MIN_WIDTH - 1), null)
  assert.equal(normalizeViewportMode(BROWSER_VIEWPORT_MAX_WIDTH + 1), null)
  assert.equal(normalizeViewportMode('desktop'), null)
  assert.equal(normalizeViewportMode(Number.NaN), null)
  assert.equal(normalizeViewportMode({}), null)
})

test('LARGURA/PURO: o zoom é a moldura dividida pela largura — e o PISO do Chromium morde', () => {
  // O caso do dono: trilho de 400px querendo desktop.
  assert.equal(viewportFitZoom(1280, 400), 0.3125)
  assert.equal(viewportEffectiveWidth(1280, 400), 1280)
  assert.equal(viewportIsClamped(1280, 400), false)

  // AUTO nunca escala nada (ligar/desligar não recarrega a página — medido).
  assert.equal(viewportFitZoom('auto', 400), 1)
  assert.equal(viewportEffectiveWidth('auto', 400), 400)

  // O PISO DE 0,25, medido em binário: `setZoomFactor(0.234)` é ACEITO,
  // `getZoomFactor()` devolve 0,234 — e o Chromium renderiza com 0,25, dando à
  // página 1200px em vez de 1280. Sem esta conta o chrome mostraria "1280"
  // aceso ao lado de uma página de 1200.
  assert.equal(viewportFitZoom(1280, 300), BROWSER_ZOOM_FLOOR)
  assert.equal(viewportEffectiveWidth(1280, 300), 1200)
  assert.equal(viewportIsClamped(1280, 300), true)

  // AMPLIAR MORREU (2026-08-29, ordem do dono). A sonda mediu que funcionava —
  // moldura de 1400 pedindo 375 entregava 375 lógicos EXATOS a 3,73× — e é
  // exatamente por isso que a cerca precisa existir: o defeito não era técnico,
  // era o dono não conseguir distinguir "o site quebrou" de "o app esticou".
  // Sobrando moldura, o zoom para em 1 e quem cede é a VIEW.
  assert.equal(viewportFitZoom(375, 1400), 1, 'nunca amplia')
  assert.equal(viewportFitZoom(768, 1400), 1)
  assert.equal(viewportEffectiveWidth(375, 1400), 375, 'e a página segue enxergando 375 EXATOS')

  // Moldura ainda não relatada (painel fechado, refúgio) não vira geometria
  // inventada.
  assert.equal(viewportFitZoom(1280, 0), 1)
  assert.equal(viewportFitZoom(1280, Number.NaN), 1)
})

test('LARGURA/PURO: o fit LÊ o valor vivo antes de escrever (e só escreve quando muda)', () => {
  const wc = {
    zoom: 1,
    writes: 0,
    getZoomFactor: () => wc.zoom,
    setZoomFactor: (z) => {
      wc.zoom = z
      wc.writes++
    }
  }

  assert.deepEqual(applyViewportFit(wc, 1280, 400), { zoom: 0.3125, changed: true })
  assert.equal(wc.writes, 1)
  // O relato de geometria chega a cada quadro de um arrasto: reescrever o mesmo
  // zoom sessenta vezes por segundo é trabalho puro.
  assert.deepEqual(applyViewportFit(wc, 1280, 400), { zoom: 0.3125, changed: false })
  assert.equal(wc.writes, 1)

  // A ROTA DE SAÍDA DO VAZAMENTO POR ORIGEM (medido: `setZoomFactor` numa aba
  // vaza para toda aba do mesmo host na mesma sessão, e PARA na fronteira da
  // partition). O motor não guarda uma lembrança do que aplicou: ele PERGUNTA.
  // Vizinho que empurrou zoom errado é corrigido no próximo layout.
  wc.zoom = 0.9
  assert.equal(applyViewportFit(wc, 1280, 400).changed, true)
  assert.equal(wc.zoom, 0.3125)

  // Aba morrendo entre a decisão e a escrita não derruba o layout de ninguém.
  const morto = {
    getZoomFactor: () => {
      throw new Error('webContents destruído')
    },
    setZoomFactor: () => {
      throw new Error('webContents destruído')
    }
  }
  assert.deepEqual(applyViewportFit(morto, 1280, 400), { zoom: 0.3125, changed: false })
})

test('LARGURA/MOTOR: o modo nasce AUTO, é POR ABA, e o inválido recusa com receita', async () => {
  const { manager, records } = makeManager()
  const primeira = await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', { x: 0, y: 0, width: 400, height: 600 }, true)

  assert.equal(manager.viewportOf('m1'), 'auto')
  assert.equal(manager.state('m1').viewport, 'auto')
  assert.equal(primeira.webContents.getZoomFactor(), 1, 'AUTO não escala nada')

  assert.deepEqual(manager.setViewportMode('m1', 1280), { ok: true, tabId: primeira.tabId })
  assert.equal(manager.state('m1').viewport, 1280)
  assert.equal(manager.state('m1').viewportWidth, 1280)
  assert.equal(primeira.webContents.getZoomFactor(), 0.3125)
  const diario = records.filter((entry) => entry.event === 'browser-viewport-mode')
  assert.equal(diario.length, 1)
  assert.equal(diario[0].actor, 'user', 'o gesto do dono é do dono')
  // E o do AGENTE é do agente: as duas mãos escrevem o MESMO estado, mas a
  // caixa-preta não pode creditar ao dono uma emulação que o agente ligou.
  manager.setViewportMode('m1', 768, 'agent')
  assert.equal(records.filter((entry) => entry.event === 'browser-viewport-mode').at(-1).actor, 'agent')
  manager.setViewportMode('m1', 1280)

  // ABA NOVA nasce em AUTO mesmo com a irmã emulada: herdar em silêncio faria o
  // `+` abrir uma página já escalada sem ninguém ter pedido.
  await manager.newTab('m1', 'p', 'https://b.test/')
  assert.equal(manager.viewportOf('m1'), 'auto', 'a nova é a ativa, e ela é AUTO')
  assert.deepEqual(
    manager.state('m1').tabs.map((tab) => tab.viewport),
    [1280, 'auto']
  )
  // Voltar para a primeira devolve o modo DELA — o estado é por aba.
  manager.selectTab('m1', primeira.tabId)
  assert.equal(manager.viewportOf('m1'), 1280)

  // Largura de engano recusa NOMEANDO a saída, e não mexe em nada.
  const recusa = manager.setViewportMode('m1', 42)
  assert.equal(recusa.ok, false)
  assert.match(recusa.error, /use AUTO ou um número/u)
  assert.equal(manager.viewportOf('m1'), 1280, 'a recusa não deixa o estado mentindo')

  // Missão sem aba: a recusa ensina o gesto que destrava.
  const semAba = makeManager()
  const vazio = semAba.manager.setViewportMode('m1', 1280)
  assert.equal(vazio.ok, false)
  assert.match(vazio.error, /abra uma aba \(\+\)/u)
})

test('LARGURA/MOTOR: AUTO devolve a moldura FÍSICA — a porta de volta é grátis', async () => {
  const { manager } = makeManager()
  const tab = await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', { x: 0, y: 0, width: 400, height: 600 }, true)

  manager.setViewportMode('m1', 1280)
  assert.equal(tab.webContents.getZoomFactor(), 0.3125)
  assert.deepEqual(manager.setViewportMode('m1', 'auto'), { ok: true, tabId: tab.tabId })
  assert.equal(tab.webContents.getZoomFactor(), 1, 'AUTO é zoom 1, não um zoom "quase 1"')
  assert.equal(manager.state('m1').viewport, 'auto')
  assert.equal(manager.state('m1').viewportWidth, 400, 'em AUTO a largura efetiva É a moldura')

  // Idempotente: clicar duas vezes no mesmo botão não é recusa — e REAPLICA, que
  // é a rota de saída quando o zoom de um vizinho do mesmo host vazou por cima.
  tab.webContents.zoom = 0.5
  assert.deepEqual(manager.setViewportMode('m1', 'auto'), { ok: true, tabId: tab.tabId })
  assert.equal(tab.webContents.getZoomFactor(), 1)
})

test('LARGURA/MOTOR: o fit é RECALCULADO a cada relato de bounds (o dono arrastando a alça)', async () => {
  const { manager } = makeManager()
  const tab = await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', { x: 0, y: 0, width: 400, height: 600 }, true)
  manager.setViewportMode('m1', 1280)
  assert.equal(tab.webContents.getZoomFactor(), 0.3125)

  // O dono alarga o painel. Sem recalcular, a página seguiria com zoom 0,3125 e
  // passaria a enxergar 2432px lógicos — deixaria de ser o modo que o botão
  // aceso promete (medido na sonda, P5).
  manager.applyBounds('m1', { x: 0, y: 0, width: 760, height: 600 }, true)
  assert.equal(tab.webContents.getZoomFactor(), 760 / 1280)
  assert.equal(manager.state('m1').viewportWidth, 1280)

  // E encolher também: o piso do Chromium entra em cena, e o state conta a
  // verdade (1200, não 1280) para o chrome poder avisar.
  manager.applyBounds('m1', { x: 0, y: 0, width: 300, height: 600 }, true)
  assert.equal(tab.webContents.getZoomFactor(), BROWSER_ZOOM_FLOOR)
  assert.equal(manager.state('m1').viewportWidth, 1200)

  // Gesto na JANELA (arrastar a borda) passa pelo mesmo caminho: o clamp muda a
  // moldura sem o ResizeObserver do painel acordar.
  const outro = makeManager()
  const alvo = await outro.manager.ensureTab('m1', 'p', 'https://a.test/')
  outro.manager.applyBounds('m1', { x: 0, y: 0, width: 800, height: 600 }, true)
  outro.manager.setViewportMode('m1', 1280)
  assert.equal(alvo.webContents.getZoomFactor(), 0.625)
  outro.host.size = { width: 500, height: 600 }
  outro.host.windowHooks.onGeometry()
  assert.equal(alvo.webContents.getZoomFactor(), 500 / 1280, 'a janela encolheu e o fit acompanhou')
})

test('LARGURA/MOTOR: a aba ATIVA escreve por ÚLTIMO (o zoom do Chromium é por origem)', async () => {
  const { manager } = makeManager()
  const primeira = await manager.ensureTab('m1', 'p', 'https://a.test/')
  await manager.newTab('m1', 'p', 'https://a.test/')
  const ativa = manager.activeTab('m1')
  manager.applyBounds('m1', { x: 0, y: 0, width: 400, height: 600 }, true)
  manager.setViewportMode('m1', 1280)

  // Duas abas no MESMO host: o Chromium compartilha o zoom por origem dentro da
  // sessão (medido — a view irmã pulou de innerWidth 540 para 1728 sozinha). A
  // aba de FUNDO está em AUTO; se ELA escrevesse por último, o dono ficaria
  // olhando a página dele com o zoom da aba que ele NÃO está vendo.
  assert.notEqual(ativa.tabId, primeira.tabId)
  assert.equal(manager.state('m1').tabs.find((tab) => !tab.active).viewport, 'auto')
  assert.equal(primeira.webContents.getZoomFactor(), 0.3125, 'as duas dividem a MESMA célula')
  assert.equal(ativa.webContents.getZoomFactor(), 0.3125)

  // Um relayout inteiro (o dono arrastando a alça) termina com a escrita da
  // ATIVA: o valor que sobra na célula compartilhada é o do modo DELA.
  manager.applyBounds('m1', { x: 0, y: 0, width: 640, height: 600 }, true)
  assert.equal(ativa.webContents.getZoomFactor(), 0.5, 'o último a escrever é o que o dono vê')
  assert.equal(ativa.webContents.zooms.at(-1), 0.5)
})

test('LARGURA/MOTOR: o modo SOBREVIVE à navegação (e o fit é re-aplicado), mas MORRE com a aba', async () => {
  const { manager } = makeManager()
  const tab = await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', { x: 0, y: 0, width: 400, height: 600 }, true)
  manager.setViewportMode('m1', 1280)

  await manager.navigate('m1', 'https://outra.test/')
  assert.equal(manager.viewportOf('m1'), 1280, 'navegar não desliga o modo do dono')

  // RE-DERIVÁVEL, não uma entrega única: o zoom do Chromium mora num mapa por
  // HOST, e uma origem nova pode chegar sem ele. O evento de navegação REFAZ o
  // fit — aqui, o mesmo evento que o Chromium emite.
  tab.webContents.zoom = 1
  tab.webContents.emit('did-navigate')
  assert.equal(tab.webContents.getZoomFactor(), 0.3125)
  tab.webContents.zoom = 1
  tab.webContents.emit('did-finish-load')
  assert.equal(tab.webContents.getZoomFactor(), 0.3125)

  // MORRE COM A ABA: fechar e abrir outra devolve AUTO. Nada disto é persistido
  // — uma página emulada que voltasse assim depois de um restart seria um estado
  // fantasma que o dono não pediu.
  await manager.newTab('m1', 'p', 'https://b.test/')
  manager.closeTab('m1', tab.tabId)
  assert.equal(manager.viewportOf('m1'), 'auto')
})

test('LARGURA/MOTOR: destacar (⧉) refaz o fit com a moldura da JANELA', async () => {
  const { manager, popouts } = makeHostedManager()
  const tab = await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', { x: 0, y: 0, width: 400, height: 600 }, true)
  manager.setViewportMode('m1', 1280)
  assert.equal(tab.webContents.getZoomFactor(), 0.3125)

  // A janela destacada é MUITO mais larga: o mesmo modo passa a quase não
  // escalar. Sem refazer o fit aqui, a página iria para a janela grande com o
  // zoom do trilho estreito — minúscula no meio dela.
  manager.popOut('m1')
  manager.applyBounds('m1', POPOUT_RECT, true, 'popout')
  assert.ok(popouts.get('m1'))
  assert.equal(tab.webContents.getZoomFactor(), POPOUT_RECT.width / 1280)
  assert.equal(manager.state('m1').viewportWidth, 1280)

  // E o reencaixe volta para a moldura do dock.
  manager.dockBack('m1')
  manager.applyBounds('m1', { x: 0, y: 0, width: 400, height: 600 }, true)
  assert.equal(tab.webContents.getZoomFactor(), 0.3125)
})

test('LARGURA/PAINEL: o seletor lê o estado do motor — inclusive o que o AGENTE pôs', () => {
  // O chrome é a única superfície onde o dono descobre que a página está
  // emulada. Se o normalizador comesse o campo, ele olharia uma página de 1280
  // lógicos com AUTO aceso e concluiria que o site quebrou.
  const emulado = normalizeBrowserPanel({
    alive: true,
    tabs: [{ tabId: 't1', active: true, viewport: 1280 }],
    viewport: 1280,
    viewportWidth: 1200
  })
  assert.equal(browserViewportOf(emulado), 1280)
  assert.equal(emulado.tabs[0].viewport, 1280)
  assert.equal(emulado.viewportWidth, 1200)
  assert.equal(browserViewportIsCustom(1280), false)

  // Ausente é AUTO (motor anterior ao seletor), e `'auto'` NÃO é gravado: uma
  // segunda grafia do mesmo estado faria `sameBrowserPanel` ver diferença onde
  // não há.
  const velho = normalizeBrowserPanel({ alive: true, tabs: [{ tabId: 't1', active: true }] })
  assert.equal(browserViewportOf(velho), 'auto')
  assert.equal('viewport' in velho, false)
  assert.equal(velho.tabs[0].viewport, 'auto')
  // Payload torto não vira escala na tela de ninguém.
  assert.equal(browserViewportOf(normalizeBrowserPanel({ viewport: 'grande' })), 'auto')
  assert.equal(browserViewportOf(normalizeBrowserPanel({ viewport: -20 })), 'auto')

  // LARGURA LIVRE do agente: nenhum botão acende, e a ficha mostra o número.
  assert.equal(browserViewportIsCustom(1440), true)
  assert.equal(browserViewportIsCustom('auto'), false)
  assert.equal(browserViewportLabel('auto'), 'AUTO')
  assert.equal(browserViewportLabel(768), '768')
  assert.deepEqual([...BROWSER_VIEWPORT_CHOICES], ['auto', 375, 768, 1280])
})

test('LARGURA/PAINEL: a fotografia REPINTA quando o modo muda, e o resumo o carrega', () => {
  const base = normalizeBrowserPanel({
    alive: true,
    tabs: [{ tabId: 't1', active: true, title: 'Board' }]
  })
  const emulado = normalizeBrowserPanel({
    alive: true,
    tabs: [{ tabId: 't1', active: true, title: 'Board', viewport: 1280 }],
    viewport: 1280
  })
  // Sem esta diferença, o modo posto pelo AGENTE não repintaria o chrome.
  assert.equal(sameBrowserPanel(base, base), true)
  assert.equal(sameBrowserPanel(base, emulado), false)

  // A largura EFETIVA também repinta: é ela que dispara o aviso do piso.
  const apertado = normalizeBrowserPanel({
    alive: true,
    tabs: [{ tabId: 't1', active: true, title: 'Board', viewport: 1280 }],
    viewport: 1280,
    viewportWidth: 1200
  })
  assert.equal(sameBrowserPanel(emulado, apertado), false)

  // O RESUMO da seção RECOLHIDA carrega a largura: uma página em 1280 lógicos
  // num painel de 400px é a diferença entre "o site quebrou" e "é o modo
  // desktop", e o dono não pode precisar reabrir a seção para descobrir isso.
  assert.equal(browserSectionSummary(base), 'Board')
  assert.equal(browserSectionSummary(emulado), 'Board · 1280')

  // O AVISO do piso do Chromium só aparece quando ele MORDE.
  assert.equal(browserViewportNote(base), null)
  assert.equal(browserViewportNote(emulado), null)
  assert.match(browserViewportNote(apertado), /a página está recebendo 1200px/u)
  assert.match(browserViewportNote(apertado), /alargue o painel|destaque em janela própria/u)

  // A frase de cada botão ensina o que o gesto faz — e o preço. Desde a moldura
  // de dispositivo ela promete o que a receita cumpre: NUNCA amplia.
  assert.match(browserViewportHint('auto'), /largura real do painel/u)
  assert.match(browserViewportHint(1280), /largura de desktop \(1280px\)/u)
  assert.match(browserViewportHint(1280), /nunca amplia/u)
  assert.match(browserViewportHint(768), /tablet/u)
  assert.match(browserViewportHint(375), /celular/u)
})

// ————— A MOLDURA DE DISPOSITIVO (2026-08-29) —————
//
// A ORDEM DO DONO, ao vivo, olhando a janela destacada com os modos novos:
// *"Quando estiver destacado e eu colocar opções menores, poderia colocar
// bordas brancas ou pretas do lado, para que não tenha scroll bar, se não, como
// vou saber se ta quebrando de vdd ou é o app."*
//
// A receita da H8 AMPLIAVA quando o preset era menor que a moldura (a sonda
// mediu 3,73× numa janela de 1400 pedindo 375): a página aparecia gigante e o
// dono não tinha como separar o defeito do site do defeito do app. A lei nova,
// medida em binário (§P10 de `PROBE_BROWSER_VIEWPORT_FIT_2026-08-29.md`):
//
//   zoom  = min(1, max(PISO, moldura ÷ lógica))   ← NUNCA amplia
//   viewW = min(moldura, lógica)                  ← a view pode ser menor
//   faixa = floor((moldura - viewW) / 2)          ← o pixel ímpar vai p/ a direita
//
// e o que sobra da moldura é o painel do app aparecendo dos dois lados. O que
// estas cercas prendem é a CONTA (os dois ramos, o encaixe exato, a sobra ímpar,
// a moldura menor que o preset) e o QUE O MOTOR FAZ COM ELA — porque o `zoom`
// certo com o `setBounds` errado é uma página esticada com um número bonito.

test('MOLDURA: a view fica com a largura PEDIDA e centralizada — e nunca mais larga que a moldura', () => {
  // O caso do dono: a janela destacada larga com o botão do celular. Antes,
  // ampliação de 3,73×; agora, 375px reais no meio de 1400 com 512 de faixa.
  assert.equal(viewportViewWidth(375, 1400), 375)
  assert.equal(viewportBandWidth(375, 1400), 512)
  assert.deepEqual(viewportViewRect(375, { x: 0, y: 40, width: 1400, height: 600 }), {
    x: 512,
    y: 40,
    width: 375,
    height: 600
  })
  // O x da MOLDURA entra na conta: no dock o painel não começa no zero da
  // janela, e uma centralização que ignorasse isso jogaria a página para cima do
  // chat do dono.
  assert.deepEqual(viewportViewRect(375, { x: 300, y: 40, width: 1400, height: 600 }), {
    x: 812,
    y: 40,
    width: 375,
    height: 600
  })

  // O RAMO QUE ENCOLHE não mudou uma linha: a view ocupa a moldura inteira e
  // quem cede é a escala. Faixa nenhuma.
  assert.equal(viewportViewWidth(1280, 400), 400)
  assert.equal(viewportBandWidth(1280, 400), 0)
  assert.deepEqual(viewportViewRect(1280, { x: 0, y: 0, width: 400, height: 600 }), {
    x: 0,
    y: 0,
    width: 400,
    height: 600
  })

  // ENCAIXE EXATO: a moldura tem a largura pedida — faixa zero, e nada de uma
  // listra de 1px aparecendo do nada.
  assert.equal(viewportViewWidth(375, 375), 375)
  assert.equal(viewportBandWidth(375, 375), 0)

  // SOBRA ÍMPAR: o pixel extra vai SEMPRE para a direita (`floor`). A decisão
  // precisa ser sempre a mesma, senão a página tremeria meio pixel para os lados
  // conforme a moldura passa de par para ímpar no meio de um arrasto.
  assert.equal(viewportBandWidth(375, 400), 12, '400-375=25 ⇒ 12 à esquerda, 13 à direita')
  assert.equal(viewportBandWidth(375, 401), 13, '401-375=26 ⇒ 13 e 13')
  assert.equal(viewportBandWidth(375, 376), 0, 'meio pixel não vira faixa')
  assert.equal(viewportBandWidth(375, 377), 1)

  // MOLDURA MENOR QUE O PRESET (e AUTO): não existe faixa nenhuma.
  assert.equal(viewportBandWidth(1280, 300), 0)
  assert.equal(viewportBandWidth('auto', 1400), 0)
  assert.equal(viewportViewWidth('auto', 1400), 1400)

  // Moldura ainda não relatada (painel fechado, refúgio): a conta não inventa
  // geometria — e não devolve retângulo negativo.
  assert.equal(viewportViewWidth(375, 0), 0)
  assert.equal(viewportBandWidth(375, 0), 0)
  assert.equal(viewportViewWidth(375, Number.NaN), 0)
})

test('MOLDURA/MOTOR: o preset que CABE vira bounds menores e centralizados, por ABA', async () => {
  const { manager, host } = makeManager()
  const primeira = await manager.ensureTab('m1', 'p', 'https://a.test/')
  // A janela destacada é larga: é o caso em que a H8 ampliava.
  manager.applyBounds('m1', { x: 40, y: 20, width: 1400, height: 600 }, true)
  manager.setViewportMode('m1', 375)

  const boundsOf = (wc) =>
    host.log.filter((entry) => entry.kind === 'setBounds' && entry.wc === wc).at(-1).bounds
  assert.deepEqual(boundsOf(primeira.webContents.id), {
    x: 40 + 512,
    y: 20,
    width: 375,
    height: 600
  })
  // ZOOM 1: nada foi esticado. É o ponto todo — o que o dono vir quebrado ali
  // dentro é do SITE.
  assert.equal(primeira.webContents.getZoomFactor(), 1)
  assert.equal(manager.state('m1').viewportWidth, 375)
  assert.equal(manager.state('m1').viewportBand, 512)

  // POR ABA. A irmã em AUTO ocupa a moldura INTEIRA no mesmo quadro: o modo é da
  // aba, e a de fundo continua sendo fotografada pelo agente na largura DELA.
  const segunda = await manager.newTab('m1', 'p', 'https://b.test/')
  const irma = manager.state('m1').tabs.find((entry) => entry.tabId !== primeira.tabId)
  assert.equal(irma.viewport, 'auto')
  const wcIrma = host.views.at(-1).webContents.id
  assert.equal(segunda.ok, true)
  assert.deepEqual(boundsOf(wcIrma), { x: 40, y: 20, width: 1400, height: 600 })
  assert.deepEqual(boundsOf(primeira.webContents.id), {
    x: 40 + 512,
    y: 20,
    width: 375,
    height: 600
  })
})

test('MOLDURA/MOTOR: o gesto do modo REPOSICIONA a view na hora (não espera o ResizeObserver)', async () => {
  const { manager, host } = makeManager()
  const tab = await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', { x: 0, y: 0, width: 900, height: 600 }, true)
  const boundsNow = () =>
    host.log.filter((entry) => entry.kind === 'setBounds' && entry.wc === tab.webContents.id).at(-1)
      .bounds

  assert.deepEqual(boundsNow(), { x: 0, y: 0, width: 900, height: 600 })
  // O clique do dono (ou a tool do agente) muda o modo — e a página tem de sair
  // do lugar NESTE passo. Reaplicar só o zoom deixaria a página esticada na
  // moldura toda até o painel relatar geometria de novo (e ele só relata quando
  // MUDA de tamanho — o que não acontece ao trocar de modo).
  manager.setViewportMode('m1', 768)
  assert.deepEqual(boundsNow(), { x: 66, y: 0, width: 768, height: 600 })
  assert.equal(tab.webContents.getZoomFactor(), 1)

  // A volta para AUTO devolve a moldura inteira, no mesmo passo.
  manager.setViewportMode('m1', 'auto')
  assert.deepEqual(boundsNow(), { x: 0, y: 0, width: 900, height: 600 })
  assert.equal(manager.state('m1').viewportBand, undefined, 'sem faixa, o campo nem viaja')
})

test('MOLDURA/MOTOR: arrastar a alça re-centraliza a faixa a cada relato (sem degrau)', async () => {
  const { manager, host } = makeManager()
  const tab = await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', { x: 0, y: 0, width: 400, height: 600 }, true)
  manager.setViewportMode('m1', 375)

  const xs = []
  // O arrasto do dono, quadro a quadro: a moldura cresce e a faixa acompanha.
  for (const width of [400, 460, 520, 700, 1000]) {
    manager.applyBounds('m1', { x: 0, y: 0, width, height: 600 }, true)
    const last = host.log
      .filter((entry) => entry.kind === 'setBounds' && entry.wc === tab.webContents.id)
      .at(-1).bounds
    xs.push([width, last.x, last.width])
  }
  assert.deepEqual(xs, [
    [400, 12, 375],
    [460, 42, 375],
    [520, 72, 375],
    [700, 162, 375],
    [1000, 312, 375]
  ])
  // A largura da view NUNCA muda no meio disso: é essa a promessa de "tamanho
  // real" — a página não se mexe, a faixa é que cresce.
  assert.equal(tab.webContents.getZoomFactor(), 1)

  // E encolher ABAIXO da largura pedida devolve o ramo que ENCOLHE: a faixa
  // morre, a view volta a ocupar a moldura e a escala volta a trabalhar.
  manager.applyBounds('m1', { x: 0, y: 0, width: 300, height: 600 }, true)
  const apertado = host.log
    .filter((entry) => entry.kind === 'setBounds' && entry.wc === tab.webContents.id)
    .at(-1).bounds
  assert.deepEqual(apertado, { x: 0, y: 0, width: 300, height: 600 })
  assert.equal(tab.webContents.getZoomFactor(), 300 / 375)
  assert.equal(manager.state('m1').viewportBand, undefined)
  assert.equal(manager.state('m1').viewportWidth, 375, 'e a página segue enxergando 375')
})

test('MOLDURA/MOTOR: o chrome acorda quando a NARRAÇÃO vira — e fica quieto no meio do arrasto', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { manager, pushes } = makeManager()
  await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', { x: 0, y: 0, width: 300, height: 600 }, true)
  manager.setViewportMode('m1', 375)
  t.mock.timers.tick(100)
  const contar = () => {
    t.mock.timers.tick(100)
    return pushes.filter((entry) => entry.channel === BROWSER_CHANGED_CHANNEL).length
  }
  const base = contar()

  // O ARRASTO, quadro a quadro, TODO dentro do ramo que encolhe: nada mudou de
  // estado, e o motor NÃO pode acordar o painel. Isto não é economia — é a
  // armadilha da H9: um repaint do React no meio do gesto reescreve
  // `--dock-browser-page-h` a partir da fração congelada, e a página pula para a
  // altura de antes do arrasto por um quadro.
  for (const width of [310, 320, 330, 340, 350, 360]) {
    manager.applyBounds('m1', { x: 0, y: 0, width, height: 600 }, true)
  }
  assert.equal(contar(), base, 'quadro de arrasto NÃO repinta o painel')

  // Cruzar a largura pedida FAZ a faixa nascer — e aí sim o chrome precisa
  // saber: é ele quem desenha a costura e escreve a frase que responde "isso é
  // o app ou o site quebrado?".
  manager.applyBounds('m1', { x: 0, y: 0, width: 500, height: 600 }, true)
  const nascida = contar()
  assert.equal(nascida, base + 1, 'a faixa NASCER acorda o painel uma vez')
  assert.equal(manager.state('m1').viewportBand, 62)

  // Mais quadros do MESMO estado: silêncio de novo.
  for (const width of [560, 620, 700]) {
    manager.applyBounds('m1', { x: 0, y: 0, width, height: 600 }, true)
  }
  assert.equal(contar(), nascida, 'faixa que só ENGORDA não repinta nada')

  // E voltar abaixo da largura pedida MATA a faixa — o painel precisa saber
  // disso também, senão fica com a costura desenhada sem faixa por baixo.
  manager.applyBounds('m1', { x: 0, y: 0, width: 300, height: 600 }, true)
  assert.equal(contar(), nascida + 1)
  assert.equal(manager.state('m1').viewportBand, undefined)

  // O MESMO vale para o piso do Chromium (buraco da H8: arrastar o painel até
  // ele morder mudava a largura efetiva e o aviso nunca aparecia na tela).
  manager.setViewportMode('m1', 1280)
  manager.applyBounds('m1', { x: 0, y: 0, width: 800, height: 600 }, true)
  const antesDoPiso = contar()
  // 340 ÷ 1280 = 0,266 — ainda acima do piso de 0,25: nada mudou de estado.
  manager.applyBounds('m1', { x: 0, y: 0, width: 340, height: 600 }, true)
  assert.equal(manager.state('m1').viewportWidth, 1280)
  assert.equal(contar(), antesDoPiso, 'quadro de arrasto que não cruza limite nenhum é silêncio')
  // 300 ÷ 1280 = 0,234 — o Chromium grampeia em 0,25 e a página passa a receber
  // 1200px. O aviso do chrome depende deste repaint.
  manager.applyBounds('m1', { x: 0, y: 0, width: 300, height: 600 }, true)
  assert.equal(contar(), antesDoPiso + 1, 'o piso MORDER acorda o painel')
  assert.equal(manager.state('m1').viewportWidth, 1200)
})

test('MOLDURA/MOTOR: a JANELA DESTACADA é onde a faixa mais vale (e o reencaixe a desfaz)', async () => {
  const { manager, host, popouts } = makeHostedManager()
  const tab = await manager.ensureTab('m1', 'p', 'https://a.test/')
  manager.applyBounds('m1', { x: 0, y: 0, width: 400, height: 600 }, true)
  manager.setViewportMode('m1', 375)
  const boundsNow = () =>
    host.log.filter((entry) => entry.kind === 'setBounds' && entry.wc === tab.webContents.id).at(-1)
      .bounds
  assert.deepEqual(boundsNow(), { x: 12, y: 0, width: 375, height: 600 })

  // ⧉: a mesma página numa janela larga. Sem a moldura de dispositivo, a receita
  // antiga a AMPLIARIA (medido: 3,73× numa janela de 1400).
  manager.popOut('m1')
  manager.applyBounds('m1', POPOUT_RECT, true, 'popout')
  assert.ok(popouts.get('m1'))
  const faixa = Math.floor((POPOUT_RECT.width - 375) / 2)
  assert.deepEqual(boundsNow(), {
    x: POPOUT_RECT.x + faixa,
    y: POPOUT_RECT.y,
    width: 375,
    height: POPOUT_RECT.height
  })
  assert.equal(tab.webContents.getZoomFactor(), 1, 'a janela larga NÃO amplia mais')
  assert.equal(manager.state('m1').viewportBand, faixa)

  // E o reencaixe volta para a moldura do dock — com a faixa recalculada ali.
  manager.dockBack('m1')
  manager.applyBounds('m1', { x: 0, y: 0, width: 400, height: 600 }, true)
  assert.deepEqual(boundsNow(), { x: 12, y: 0, width: 375, height: 600 })
  assert.equal(manager.state('m1').viewportBand, 12)
})

test('MOLDURA/PAINEL: a faixa nasce e morre na tela, e a nota conta de quem ela é', () => {
  const comFaixa = normalizeBrowserPanel({
    alive: true,
    tabs: [{ tabId: 't1', active: true, title: 'Board', viewport: 375 }],
    viewport: 375,
    viewportWidth: 375,
    viewportBand: 262
  })
  const semFaixa = normalizeBrowserPanel({
    alive: true,
    tabs: [{ tabId: 't1', active: true, title: 'Board', viewport: 375 }],
    viewport: 375,
    viewportWidth: 375
  })
  assert.equal(browserViewportBand(comFaixa), 262)
  assert.equal(browserViewportBand(semFaixa), 0)
  // `0` e lixo NUNCA viram faixa: uma listra desenhada por causa de um payload
  // torto seria o app se acusando de um defeito que não existe.
  assert.equal(browserViewportBand(normalizeBrowserPanel({ viewportBand: 0 })), 0)
  assert.equal(browserViewportBand(normalizeBrowserPanel({ viewportBand: -20 })), 0)
  assert.equal(browserViewportBand(normalizeBrowserPanel({ viewportBand: 'larga' })), 0)
  assert.equal(semFaixa.viewportBand, undefined, 'ausência tem UMA grafia só')

  // E a ausência tem UMA GRAFIA SÓ de verdade: o motor pode mandar `0`, pode não
  // mandar campo nenhum, e pode mandar lixo — as três são a MESMA fotografia.
  // Sem isso, o `browser:changed` (que chega a cada passo do agente) repintaria
  // o dock por nada, alternando entre `0` e ausente.
  const zero = normalizeBrowserPanel({
    alive: true,
    tabs: [{ tabId: 't1', active: true, title: 'Board', viewport: 375 }],
    viewport: 375,
    viewportWidth: 375,
    viewportBand: 0
  })
  const lixo = normalizeBrowserPanel({
    alive: true,
    tabs: [{ tabId: 't1', active: true, title: 'Board', viewport: 375 }],
    viewport: 375,
    viewportWidth: 375,
    viewportBand: 'larga'
  })
  assert.equal(sameBrowserPanel(semFaixa, zero), true, '`0` e ausente são a mesma coisa')
  assert.equal(sameBrowserPanel(semFaixa, lixo), true)

  // SEM ESTA LINHA a faixa não nasceria nem morreria: alargar o painel até a
  // largura pedida caber deixaria a página em tamanho real e a tela sem faixa
  // nenhuma desenhada.
  assert.equal(sameBrowserPanel(comFaixa, semFaixa), false)
  assert.equal(sameBrowserPanel(comFaixa, comFaixa), true)

  // A NOTA ESCRITA — porque uma faixa escura ao lado de um site escuro não se
  // explica sozinha, e a pergunta do dono era literalmente "como vou saber".
  const nota = browserViewportNote(comFaixa)
  assert.match(nota, /375px REAIS/u)
  assert.match(nota, /as faixas dos lados são o app, não o site/u)
  // SEM o número da faixa: ele muda a cada quadro de um arrasto e a fotografia
  // só atravessa o IPC quando a narração VIRA de estado — um "262px" congelado
  // na tela enquanto o dono arrasta seria pior do que não dizer.
  assert.doesNotMatch(nota, /262/u)
  assert.equal(browserViewportNote(semFaixa), null)

  // Os dois recados são de RAMOS DIFERENTES da receita e não podem se misturar:
  // com faixa não existe piso mordendo, e com piso mordendo não existe faixa.
  const apertado = normalizeBrowserPanel({
    alive: true,
    tabs: [{ tabId: 't1', active: true, viewport: 1280 }],
    viewport: 1280,
    viewportWidth: 1200
  })
  assert.match(browserViewportNote(apertado), /estreito demais/u)
  assert.doesNotMatch(browserViewportNote(apertado), /faixas/u)
})
