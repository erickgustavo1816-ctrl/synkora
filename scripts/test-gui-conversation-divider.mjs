// A FRONTEIRA DE CONVERSA NO FIO (2026-09-28).
//
// Pedido do dono, verbatim: "tem conversa que não consigo ver o histórico
// todo. Quero conseguir ver de todas as conversas". O /new zerava o fio no
// renderer (o redutor voltava ao pane vazio) e o leitor só alcançava a
// conversa atual. Esta suíte prende o lado do renderer da virada:
//
//  · o /new deixa a conversa antiga ACIMA de um divisor, e o replay (remontar,
//    fotografia arquivada) desenha exatamente o mesmo fio que o vivo;
//  · o transcript salvo ANTES da virada (que começa no marco) abre com o
//    divisor no topo;
//  · a linha do topo acende com poda OU com o divisor no topo, e o leitor
//    escolhe a conversa certa, pagina a conversa ABERTA e navega entre elas;
//  · as contas de "conversa atual" (lateral, barra de aceite, pulso) param no
//    último divisor.
//
// Rodar: node --test scripts/test-gui-conversation-divider.mjs
//
// PROVA DE VERMELHO: `GUI_DIVIDER_STORE=<arquivo>` troca o store.ts do bundle
// por outro (o resto do renderer continua o atual). Com o store do HEAD de
// antes da virada (`git show HEAD~N:src/renderer/src/store.ts > arquivo`), os
// testes do redutor falham — é assim que se prova que eles pegam o bug.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

const storeOverride = process.env.GUI_DIVIDER_STORE
const storeSwap = storeOverride
  ? [
      {
        name: 'store-under-test',
        setup(build) {
          // Sem a flag `u`: o filtro vira regex de Go dentro do esbuild.
          build.onLoad({ filter: /[\\/]src[\\/]renderer[\\/]src[\\/]store\.ts$/ }, () => ({
            contents: readFileSync(resolve(storeOverride), 'utf8'),
            loader: 'ts',
            resolveDir: resolve('src/renderer/src')
          }))
        }
      }
    ]
  : []

const compiled = await build({
  stdin: {
    contents: `
      export { useStore, EMPTY_GUI_PANE, applyGuiEvent } from './src/renderer/src/store';
      export * from './src/renderer/src/guiHistoryReader';
      export {
        GUI_CONVERSATION_DIVIDER_TEXT,
        guiCurrentConversationStart,
        sealGuiConversationItems
      } from './src/renderer/src/guiConversationDivider';
      export { guiSubagentSidebarEntries } from './src/renderer/src/guiSubagentSidebar';
      export { guiAwaitingGoDecision } from './src/renderer/src/guiAskForGo';
      export { guiAgentPulsePresentation } from './src/renderer/src/guiAgentPulse';
      export { useGuiConversationHistory } from './src/renderer/src/useGuiConversationHistory';
      export {
        GuiConversationDivider,
        GuiHistoryConversationNav,
        GuiThreadHistoryLine
      } from './src/renderer/src/components/GuiConversationHistory';
    `,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  write: false,
  loader: { '.css': 'empty' },
  external: ['react', 'react/jsx-runtime', 'zustand'],
  plugins: storeSwap
})

/** A ponte `window.synkora` que o hook enxerga — cada teste troca a dele. */
const windowStub = { setTimeout, clearTimeout, synkora: {} }
const loaded = { exports: {} }
new Function('require', 'module', 'exports', 'document', 'window', 'localStorage', compiled.outputFiles[0].text)(
  createRequire(import.meta.url),
  loaded,
  loaded.exports,
  { documentElement: { style: { setProperty() {} } }, visibilityState: 'visible' },
  windowStub,
  { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 }
)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const {
  useStore,
  EMPTY_GUI_PANE,
  applyGuiEvent,
  guiThreadTopLine,
  guiHistoryOpenPlan,
  guiHistoryConversationNav,
  guiHistoryConversationDate,
  guiPrunedNoticeText,
  GUI_EARLIER_CONVERSATION_TEXT,
  GUI_EARLIER_CONVERSATIONS_MISSING,
  GUI_RECOVERED_CONVERSATION_TAG,
  GUI_CONVERSATION_DIVIDER_TEXT,
  guiCurrentConversationStart,
  sealGuiConversationItems,
  guiSubagentSidebarEntries,
  guiAwaitingGoDecision,
  guiAgentPulsePresentation,
  useGuiConversationHistory,
  GuiConversationDivider,
  GuiHistoryConversationNav,
  GuiThreadHistoryLine
} = loaded.exports

// ————————————————————————— o redutor —————————————————————————

/** Uma conversa, o /new e o começo da seguinte — do jeito que o anel do main
 *  agora guarda (as falas antigas seguidas do marco persistido). */
const LIVE_EVENTS = [
  { type: 'ready', caps: null },
  { type: 'user-message', id: 'owner-1', text: 'primeira pergunta', at: 1_000 },
  { type: 'turn-started' },
  { type: 'text', text: 'primeira resposta' },
  { type: 'result', isError: false },
  { type: 'conversation-cleared' },
  { type: 'user-message', id: 'owner-2', text: 'começo da conversa nova', at: 2_000 }
]

/** O que a tela desenha, sem o que é do relógio/contador de processo: ids de
 *  item gerado, `at` e o ponto de revelação (o replay entra já revelado). */
function drawn(items) {
  return items.map((item) => {
    const { id, at, animateFrom, ...rest } = item
    return item.kind === 'user' ? { id, ...rest } : rest
  })
}

function livePane(paneId, events) {
  useStore.setState({
    guiPanes: { [paneId]: { ...EMPTY_GUI_PANE, spawned: true } }
  })
  for (const evt of events) useStore.getState().handleGuiLive(paneId, evt)
  return useStore.getState().guiPanes[paneId]
}

function replayedPane(paneId, events) {
  useStore.getState().replayGuiPane(paneId, events)
  return useStore.getState().guiPanes[paneId]
}

test('(a) o /new guarda a conversa antiga acima de um divisor — e o replay desenha o MESMO fio', () => {
  const live = livePane('pane-live', LIVE_EVENTS)
  const kinds = live.items.map((item) => item.kind).filter((kind) => kind !== 'note')
  assert.deepEqual(
    kinds,
    ['user', 'assistant', 'divider', 'user'],
    'a conversa antiga fica, o divisor marca a troca, a nova começa abaixo'
  )
  assert.equal(live.items[0].text, 'primeira pergunta')
  assert.equal(live.items[1].text, 'primeira resposta')
  assert.equal(live.items.at(-1).text, 'começo da conversa nova')

  const replay = replayedPane('pane-replay', LIVE_EVENTS)
  assert.deepEqual(drawn(replay.items), drawn(live.items), 'remontar/abrir arquivado = mesmo fio do vivo')
})

test('(a) o marco zera o estado do turno como sempre, mas conserva identidade e poda', () => {
  const before = [
    { type: 'history-pruned', evicted: 37 },
    { type: 'init', model: 'claude-x', sessionId: 'nova', permissionMode: 'default', toolCount: 0 },
    { type: 'ready', caps: null },
    { type: 'user-message', id: 'owner-1', text: 'pergunta', at: 1_000 },
    { type: 'turn-started' },
    { type: 'delta', text: 'fala pela metade' }
  ]
  let state = before.reduce(applyGuiEvent, { ...EMPTY_GUI_PANE })
  assert.equal(state.stream, 'fala pela metade')
  state = applyGuiEvent(state, { type: 'conversation-cleared' })
  assert.equal(state.prunedEvents, 37, 'o topo do fio continua o mesmo: a poda não some')
  assert.equal(state.sessionId, 'nova')
  assert.equal(state.ready, true)
  assert.equal(state.status, 'idle')
  assert.equal(state.stream, '')
  assert.equal(state.activeAssistantId, null)
  const spoken = state.items.find((item) => item.kind === 'assistant')
  assert.equal(spoken?.text, 'fala pela metade', 'a fala interrompida fica no fio antigo')
  assert.equal(spoken?.live, false, 'e fechada: o próximo delta não a continua')
  state = applyGuiEvent(state, { type: 'delta', text: 'outra' })
  const assistants = state.items.filter((item) => item.kind === 'assistant')
  assert.deepEqual(assistants.map((item) => item.text), ['fala pela metade', 'outra'])
})

test('(a) dois marcos seguidos são um divisor só; a bolha otimista do próprio /new sai', () => {
  let state = [
    { type: 'ready', caps: null },
    { type: 'user-message', id: 'owner-1', text: 'antes', at: 1_000 }
  ].reduce(applyGuiEvent, { ...EMPTY_GUI_PANE })
  // O composer desenhou o /new antes de o main responder: o id está no lote
  // em voo quando o marco chega (o main empurra o marco antes de responder).
  state = {
    ...state,
    items: [...state.items, { id: 'owner-new', kind: 'user', text: '/new', at: 1_500 }],
    sendBatch: { id: 'owner-new', requestIds: ['owner-new'], eventRevision: state.eventRevision, startedTurn: true, accepted: false }
  }
  state = applyGuiEvent(state, { type: 'conversation-cleared' })
  state = applyGuiEvent(state, { type: 'conversation-cleared' })
  assert.deepEqual(
    state.items.map((item) => item.kind),
    ['user', 'divider'],
    'a fala antiga fica; o /new (nunca ecoado no anel) não sobra; um divisor só'
  )
  assert.equal(state.items[0].id, 'owner-1')
  assert.equal(state.sendBatch, null)
})

test('(a) a conversa que acabou é SELADA: nada dela segue pendente na seguinte', () => {
  let state = [
    { type: 'ready', caps: null },
    { type: 'turn-started' },
    { type: 'tool', name: 'Bash', input: { command: 'npm test' }, toolUseId: 'bash-1' },
    { type: 'tool', name: 'Agent', input: { description: 'pesquisa' }, toolUseId: 'agent-1' },
    { type: 'tool-result', text: 'despachado', isError: false, toolUseId: 'agent-1', agentStatus: 'launched', agentTaskId: 't1' }
  ].reduce(applyGuiEvent, { ...EMPTY_GUI_PANE })
  state = applyGuiEvent(state, { type: 'conversation-cleared' })
  const tools = state.items.filter((item) => item.kind === 'tool')
  assert.equal(tools.length, 2, 'os cards da conversa antiga continuam no fio')
  assert.ok(tools.every((tool) => tool.result && tool.result.agentStatus !== 'launched'), 'nenhum card pendente/despachado')
  assert.ok(tools.every((tool) => tool.result.status === 'cancelled'), 'desfecho: cancelada, nunca falha')
  // O turno seguinte fecha sem inventar órfã da conversa antiga.
  state = [{ type: 'turn-started' }, { type: 'text', text: 'oi' }, { type: 'result', isError: false }]
    .reduce(applyGuiEvent, state)
  const after = state.items.slice(guiCurrentConversationStart(state.items))
  assert.ok(
    !after.some((item) => (item.kind === 'note' || item.kind === 'error') && /ferramenta/u.test(item.text)),
    'nenhum aviso de ferramenta órfã na conversa nova'
  )
})

test('(a) o selo apaga provisório e transitório — e devolve a MESMA lista quando nada pende', () => {
  const calm = [{ id: 'a', kind: 'assistant', text: 'ok', at: 1, live: false, animateFrom: 2 }]
  assert.equal(sealGuiConversationItems(calm), calm)
  const sealed = sealGuiConversationItems([
    { id: 't', kind: 'tool', name: 'Read', summary: '', at: 1, result: { text: '', isError: false, status: 'unconfirmed', provisional: true, lineCount: 1, truncated: false } },
    { id: 'n', kind: 'note', text: 'resultado não confirmado', at: 2, transient: true }
  ])
  assert.equal('provisional' in sealed[0].result, false)
  assert.equal('transient' in sealed[1], false)
})

test('(b) transcript salvo ANTES da virada abre com o divisor no topo (a nota antiga fica)', () => {
  const old = [
    { type: 'conversation-cleared' },
    {
      type: 'command-output',
      text: 'Conversa nova neste mesmo chat. Os arquivos continuam na missão; o contexto anterior não é carregado. Para consultar o histórico, use Ctrl+K e busque um trecho da conversa.'
    },
    { type: 'ready', caps: null },
    { type: 'user-message', id: 'owner-9', text: 'depois do /new', at: 9_000 }
  ]
  const pane = replayedPane('pane-old-transcript', old)
  assert.deepEqual(pane.items.map((item) => item.kind), ['divider', 'note', 'user'])
  assert.equal(guiThreadTopLine(pane.prunedEvents, pane.items)?.kind, 'earlier')
})

// ————————————————————— a linha do topo —————————————————————

const item = (kind, extra = {}) => ({ id: `${kind}-${Math.random()}`, kind, at: 1, ...extra })

test('(c) a linha do topo: poda, conversa anterior fora da tela, ou nada', () => {
  assert.equal(guiThreadTopLine(0, []), null)
  assert.equal(guiThreadTopLine(0, [item('user'), item('divider'), item('user')]), null, 'o antigo está NA tela')

  const pruned = guiThreadTopLine(12, [item('assistant')])
  assert.equal(pruned.kind, 'pruned')
  assert.equal(pruned.truth, guiPrunedNoticeText(12))
  assert.equal(pruned.action, 'ver conversa completa')
  assert.equal(pruned.dividers, 0)

  const earlier = guiThreadTopLine(0, [item('divider'), item('user')])
  assert.equal(earlier.kind, 'earlier')
  assert.equal(earlier.truth, 'a conversa anterior deste chat não está nesta tela')
  assert.equal(earlier.truth, GUI_EARLIER_CONVERSATION_TEXT)
  assert.equal(earlier.action, 'ver conversas anteriores')

  // Poda + divisor no topo: a conversa atual está inteira abaixo do divisor;
  // o que falta é de antes dele.
  assert.equal(guiThreadTopLine(40, [item('divider'), item('user')]).kind, 'earlier')
  assert.equal(guiThreadTopLine(40, [item('user'), item('divider'), item('user')]).dividers, 1)
})

// ———————————————— qual conversa abrir, e a navegação ————————————————

const conv = (sessionId, extra = {}) => ({ sessionId, provider: 'claude', current: false, source: 'chat', ...extra })
const listing = (conversations) => ({ ok: true, paneId: 'p', conversations })
const A = conv('A', { source: 'recovered', updatedAt: new Date(2026, 8, 20, 15, 40).toISOString() })
const B = conv('B', { updatedAt: new Date(2026, 8, 27, 10, 5).toISOString() })
const C = conv('C', { current: true })

test('(d) o plano de abertura escolhe a conversa a que o topo do fio pertence', () => {
  const line = (prunedEvents, kinds) => guiThreadTopLine(prunedEvents, kinds.map((kind) => item(kind)))
  // Poda sem divisor = a conversa atual, primeira página (R24.2 intacto).
  assert.deepEqual(guiHistoryOpenPlan(line(5, ['user']), listing([A, B, C])), { kind: 'current' })
  assert.deepEqual(guiHistoryOpenPlan(line(5, ['user']), null), { kind: 'current' })
  // Poda COM divisor: o topo é de uma conversa anterior.
  assert.deepEqual(guiHistoryOpenPlan(line(5, ['user', 'divider', 'user']), listing([A, B, C])), {
    kind: 'conversation',
    sessionId: 'B'
  })
  // Lista indisponível: a poda ainda abre a atual (nunca beco).
  assert.deepEqual(
    guiHistoryOpenPlan(line(5, ['user', 'divider', 'user']), { ok: false, paneId: 'p', conversations: [], error: 'x' }),
    { kind: 'current' }
  )
  // Divisor no topo = a mais nova das anteriores (um divisor), ou mais atrás.
  assert.deepEqual(guiHistoryOpenPlan(line(0, ['divider', 'user']), listing([A, B, C])), {
    kind: 'conversation',
    sessionId: 'B'
  })
  assert.deepEqual(guiHistoryOpenPlan(line(0, ['divider', 'user', 'divider', 'user']), listing([A, B, C])), {
    kind: 'conversation',
    sessionId: 'A'
  })
  assert.deepEqual(
    guiHistoryOpenPlan(line(0, ['divider', 'user', 'divider', 'user', 'divider']), listing([A, B, C])),
    { kind: 'conversation', sessionId: 'A' },
    'mais divisores que conversas: fica na mais antiga conhecida'
  )
  // Chat ainda sem id atual: todas as listadas são anteriores.
  assert.deepEqual(guiHistoryOpenPlan(line(0, ['divider']), listing([A, B])), { kind: 'conversation', sessionId: 'B' })
  // Só a atual: a recusa nomeia a receita que sempre existe.
  assert.deepEqual(guiHistoryOpenPlan(line(0, ['divider', 'user']), listing([C])), {
    kind: 'missing',
    error: 'não achei as conversas anteriores deste chat no disco — use Ctrl+K para buscar um trecho'
  })
  assert.equal(GUI_EARLIER_CONVERSATIONS_MISSING, 'não achei as conversas anteriores deste chat no disco — use Ctrl+K para buscar um trecho')
  // Recusa do main: o texto dele (PT-BR, com a receita) vai para a tela.
  assert.deepEqual(
    guiHistoryOpenPlan(line(0, ['divider']), { ok: false, paneId: 'p', conversations: [], error: 'reabra as conversas deste chat' }),
    { kind: 'missing', error: 'reabra as conversas deste chat' }
  )
  assert.deepEqual(guiHistoryOpenPlan(line(0, ['divider']), null), { kind: 'missing', error: GUI_EARLIER_CONVERSATIONS_MISSING })
})

test('(d) a navegação: K de N, pontas, etiqueta de recuperada e data pt-BR', () => {
  assert.equal(guiHistoryConversationDate(new Date(2026, 8, 28, 14, 5).toISOString()), '28/09/2026 14:05')
  assert.equal(guiHistoryConversationDate('não é data'), null)
  assert.equal(guiHistoryConversationDate(undefined), null)

  const first = guiHistoryConversationNav([A, B, C], 'A')
  assert.deepEqual(first, {
    position: 1,
    total: 3,
    label: 'conversa 1 de 3',
    previousSessionId: null,
    nextSessionId: 'B',
    recovered: true,
    when: 'última escrita em 20/09/2026 15:40'
  })
  const middle = guiHistoryConversationNav([A, B, C], 'B')
  assert.equal(middle.label, 'conversa 2 de 3')
  assert.equal(middle.previousSessionId, 'A')
  assert.equal(middle.nextSessionId, 'C')
  assert.equal(middle.recovered, false)
  assert.equal(middle.when, 'encerrada em 27/09/2026 10:05')
  const last = guiHistoryConversationNav([A, B, C], 'C')
  assert.equal(last.nextSessionId, null)
  assert.equal(last.when, 'conversa atual')

  assert.equal(guiHistoryConversationNav(undefined, 'A'), null, 'leitura da paleta: sem lista, sem navegação')
  assert.equal(guiHistoryConversationNav([C], 'C'), null, 'conversa única: nada a navegar')
  assert.equal(guiHistoryConversationNav([A, B, C], 'Z'), null, 'conversa fora da lista não ganha posição inventada')
})

// ————————————————— o hook do leitor, com ponte falsa —————————————————

function historyBridge(conversations) {
  const calls = []
  const page = (sessionId, messages, extra = {}) => ({
    ok: true,
    paneId: 'pane-h',
    provider: 'claude',
    sessionId,
    messages,
    targetMessageId: messages.at(-1)?.id,
    targetCursor: messages.at(-1)?.cursor,
    hasMoreBefore: true,
    hasMoreAfter: false,
    ...extra
  })
  windowStub.synkora = {
    history: {
      paneConversations: async (paneId) => {
        calls.push(['paneConversations', paneId])
        return conversations
      },
      loadForPane: async (paneId, request, sessionId) => {
        calls.push(['loadForPane', paneId, request, sessionId])
        if (request?.before !== undefined) {
          return page(sessionId, [{ id: `${sessionId}-older`, cursor: 10, role: 'user', text: 'mais antiga' }], { hasMoreBefore: false })
        }
        return page(sessionId ?? 'C', [{ id: `${sessionId ?? 'C'}-end`, cursor: 500, role: 'assistant', text: 'fim' }])
      }
    }
  }
  return calls
}

function renderHook(props) {
  const api = { current: null }
  function Probe(input) {
    const historyTarget = useStore((s) => (s.guiHistoryTarget?.paneId === input.paneId ? s.guiHistoryTarget : null))
    api.current = useGuiConversationHistory({ ...input, historyTarget, threadRef: { current: null } })
    return null
  }
  let renderer
  act(() => {
    renderer = create(React.createElement(Probe, props))
  })
  return { api, renderer }
}

test('(e) o leitor abre a conversa anterior, pagina a ABERTA e navega pela lista', async () => {
  useStore.setState({ guiHistoryTarget: null })
  const calls = historyBridge(listing([A, B, C]))
  const { api, renderer } = renderHook({
    paneId: 'pane-h',
    items: [item('divider'), item('user')],
    prunedEvents: 0
  })
  assert.equal(api.current.topLine.kind, 'earlier')

  await act(async () => {
    await api.current.open()
  })
  assert.deepEqual(calls.slice(0, 2), [
    ['paneConversations', 'pane-h'],
    ['loadForPane', 'pane-h', undefined, 'B']
  ])
  let target = useStore.getState().guiHistoryTarget
  assert.equal(target.sessionId, 'B')
  assert.deepEqual(target.conversations.map((entry) => entry.sessionId), ['A', 'B', 'C'])

  // A página seguinte pede a MESMA conversa aberta — nunca a atual.
  await act(async () => {
    await api.current.loadPage('before')
  })
  assert.deepEqual(calls[2], ['loadForPane', 'pane-h', { before: 500 }, 'B'])
  target = useStore.getState().guiHistoryTarget
  assert.deepEqual(target.messages.map((message) => message.id), ['B-older', 'B-end'])
  assert.equal(target.hasMoreBefore, false)

  await act(async () => {
    await api.current.navigate('A')
  })
  assert.deepEqual(calls[3], ['loadForPane', 'pane-h', undefined, 'A'])
  target = useStore.getState().guiHistoryTarget
  assert.equal(target.sessionId, 'A')
  assert.deepEqual(target.conversations.map((entry) => entry.sessionId), ['A', 'B', 'C'], 'a lista viaja junto')
  act(() => renderer.unmount())
})

test('(e) sem conversa anterior no disco, a linha diz a receita — e a poda segue abrindo a atual', async () => {
  useStore.setState({ guiHistoryTarget: null })
  let calls = historyBridge(listing([C]))
  let { api, renderer } = renderHook({ paneId: 'pane-h', items: [item('divider')], prunedEvents: 0 })
  await act(async () => {
    await api.current.open()
  })
  assert.equal(api.current.error, GUI_EARLIER_CONVERSATIONS_MISSING)
  assert.equal(useStore.getState().guiHistoryTarget, null)
  assert.equal(calls.some(([name]) => name === 'loadForPane'), false)
  act(() => renderer.unmount())

  calls = historyBridge({ ok: false, paneId: 'pane-h', conversations: [], error: 'falhou a lista' })
  ;({ api, renderer } = renderHook({ paneId: 'pane-h', items: [item('assistant')], prunedEvents: 9 }))
  await act(async () => {
    await api.current.open()
  })
  assert.deepEqual(calls[1], ['loadForPane', 'pane-h', undefined, undefined], 'R24.2: a atual, sem id')
  const target = useStore.getState().guiHistoryTarget
  assert.equal(target.sessionId, 'C')
  assert.equal('conversations' in target, false, 'sem lista, sem navegação')
  act(() => renderer.unmount())
})

test('(e) a página que chega de OUTRA conversa (navegação no meio da viagem) cai no vazio', () => {
  useStore.setState({
    guiHistoryTarget: {
      paneId: 'pane-h',
      sessionId: 'A',
      provider: 'claude',
      messages: [{ id: 'A-end', cursor: 500, role: 'assistant', text: 'fim' }],
      targetMessageId: 'A-end',
      targetCursor: 500,
      truncated: false,
      hasMoreBefore: true
    }
  })
  useStore.getState().appendGuiHistoryPage('pane-h', {
    direction: 'before',
    messages: [{ id: 'B-older', cursor: 10, role: 'user', text: 'de outra conversa' }],
    hasMore: false,
    sessionId: 'B'
  })
  assert.deepEqual(useStore.getState().guiHistoryTarget.messages.map((message) => message.id), ['A-end'])
})

// ————————————————————————— o desenho —————————————————————————

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

test('o divisor é régua com a frase — nem card, nem bolha', () => {
  let renderer
  act(() => {
    renderer = create(React.createElement(GuiConversationDivider))
  })
  const root = renderer.root.findByProps({ role: 'separator' })
  assert.equal(root.props.className, 'gui-conversation-divider')
  assert.equal(root.props['aria-label'], 'conversa nova — o agente não lembra do que está acima')
  assert.equal(GUI_CONVERSATION_DIVIDER_TEXT, 'conversa nova — o agente não lembra do que está acima')
  assert.match(textOf(renderer.toJSON()), /o agente não lembra do que está acima/u)
  const css = readFileSync(new URL('../src/renderer/src/components/GuiConversationHistory.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /--panel\b/u, 'o chat é PAPEL: nada de painel escuro')
})

test('a linha do topo e a navegação desenham a verdade e a receita', () => {
  let opened = 0
  let renderer
  act(() => {
    renderer = create(
      React.createElement(GuiThreadHistoryLine, {
        line: guiThreadTopLine(0, [item('divider')]),
        opening: false,
        disabled: false,
        error: GUI_EARLIER_CONVERSATIONS_MISSING,
        onOpen: () => {
          opened += 1
        }
      })
    )
  })
  const button = renderer.root.findByType('button')
  assert.equal(button.props['aria-label'], `${GUI_EARLIER_CONVERSATION_TEXT} — ver conversas anteriores`)
  act(() => button.props.onClick())
  assert.equal(opened, 1)
  assert.match(textOf(renderer.toJSON()), /Ctrl\+K/u, 'a recusa termina na receita')

  const navigated = []
  const target = {
    paneId: 'p',
    sessionId: 'A',
    provider: 'claude',
    messages: [],
    targetMessageId: '',
    targetCursor: 0,
    truncated: false,
    conversations: [A, B, C]
  }
  act(() => {
    renderer.update(
      React.createElement(GuiHistoryConversationNav, {
        target,
        navigating: false,
        onNavigate: (sessionId) => navigated.push(sessionId)
      })
    )
  })
  const [previous, next] = renderer.root.findAllByProps({ className: 'ghn-step' })
  assert.equal(previous.props.disabled, true, 'na mais antiga, "← anterior" desliga')
  assert.equal(next.props.disabled, false)
  act(() => next.props.onClick())
  assert.deepEqual(navigated, ['B'])
  const text = textOf(renderer.toJSON())
  assert.match(text, /conversa 1 de 3/u)
  assert.match(text, new RegExp(GUI_RECOVERED_CONVERSATION_TAG, 'u'))
  assert.match(text, /última escrita em 20\/09\/2026 15:40/u)

  act(() => {
    renderer.update(
      React.createElement(GuiHistoryConversationNav, {
        target: { ...target, conversations: undefined },
        navigating: false,
        onNavigate() {}
      })
    )
  })
  assert.equal(renderer.toJSON(), null, 'leitura avulsa da paleta não ganha navegação')
})

// ———————————— as contas de "conversa atual" param no divisor ————————————

test('a lateral mostra só a frota da conversa atual', () => {
  const helper = (toolUseId, extra = {}) => ({
    id: `item-${toolUseId}`,
    kind: 'tool',
    name: 'Agent',
    summary: '',
    toolUseId,
    subagent: { name: toolUseId },
    at: 1,
    ...extra
  })
  const items = [helper('antigo'), item('divider'), helper('novo')]
  assert.deepEqual(guiSubagentSidebarEntries(items).map((entry) => entry.toolUseId), ['novo'])
  assert.deepEqual(
    guiSubagentSidebarEntries([helper('antigo'), helper('novo')]).map((entry) => entry.toolUseId),
    ['antigo', 'novo'],
    'sem divisor, nada muda'
  )
})

test('a barra "aprovar" nunca responde a uma pergunta de outra conversa', () => {
  const asks = { kind: 'assistant', text: 'Terminei a parte 1. Posso seguir?', live: false, animateFrom: 34 }
  const gate = { status: 'idle' }
  assert.equal(guiAwaitingGoDecision([asks], gate), true)
  assert.equal(guiAwaitingGoDecision([asks, { kind: 'divider' }], gate), false)
})

test('o rastro do pulso não atravessa o divisor', () => {
  const read = {
    id: 'r',
    kind: 'tool',
    name: 'Read',
    summary: 'a.ts',
    progressTarget: 'src/a.ts',
    at: 1,
    result: { text: '', isError: false, status: 'completed', lineCount: 1, truncated: false }
  }
  const input = (items) => ({ phase: 'thinking', items, now: 0, publicSilenceSince: null })
  assert.ok(guiAgentPulsePresentation(input([read])).trail, 'mesma conversa: há rastro')
  assert.equal(guiAgentPulsePresentation(input([read, item('divider')])).trail, undefined)
})
