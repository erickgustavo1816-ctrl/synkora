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
  EMPTY_BROWSER_PANEL,
  activeBrowserTab,
  browserIsPopout,
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
  return wc
}

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
  assert.deepEqual(manager.state('m1'), {
    alive: false,
    agentDriving: false,
    tabs: [],
    host: 'dock'
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
    canForward: false
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
  assert.deepEqual(manager.state('m1'), { alive: false, agentDriving: false, tabs: [], host: 'dock' })
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
