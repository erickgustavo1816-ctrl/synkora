// AJUDANTES SEM ABA — A COSTURA COM O MAIN (onda 2 do design vinculante
// `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md`).
//
// O motor (`test:gui-helper-sessions`) já prova a máquina de estados. Esta suíte
// prova a FIAÇÃO: a correlação entre a chamada `delegate` que o CLI publica no
// anel e a frota que o motor abriu, a forma EXATA dos cards sintetizados (as
// mesmas strings que `guiSubagentSidebar.ts` lê), o ciclo launched→settled do
// envelope, o cancelamento dos órfãos no boot, as cercas nos args dos dois
// adaptadores e as regras de conta.
//
// Como rodar (o package.json não foi tocado — a linha para registrar está no
// relatório w2-wiring.md):
//   tsc --outDir .tmp/gui-delegation-wiring-test --target ES2022 --module Node16 \
//       --moduleResolution Node16 --esModuleInterop --skipLibCheck --types node \
//       src/main/guiHelperCards.ts src/main/guiSessions.ts src/main/guiDelegationWiring.ts \
//   && node --test scripts/test-gui-delegation-wiring.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Namespace de propósito: com destructure no topo, UM export faltando derruba o
// arquivo inteiro e a suíte deixa de discriminar. Assim, a ausência de uma peça
// reprova só o teste que depende dela — que é como o vermelho vira diagnóstico.
import * as cards from '../.tmp/gui-delegation-wiring-test/guiHelperCards.js'
import * as sessions from '../.tmp/gui-delegation-wiring-test/guiSessions.js'
import * as wiring from '../.tmp/gui-delegation-wiring-test/guiDelegationWiring.js'
import * as engineModule from '../.tmp/gui-delegation-wiring-test/guiHelperSessions.js'

const {
  GUI_HELPER_CARD_ACTIVITY_MAX,
  GUI_HELPER_CARD_ACTIVITY_MS,
  GUI_HELPER_CARD_PREFIX,
  GUI_HELPER_INBOX_TAG,
  GuiHelperCardCorrelator,
  GuiHelperInbox,
  guiHelperActivityEvent,
  guiHelperCardId,
  guiHelperCardInput,
  guiHelperInboxBlock,
  guiHelperSettledEvent,
  guiHelperSpawnedEvents,
  guiOrphanHelperCancellations,
  isGuiDelegateToolName
} = cards
const {
  GuiSessionRegistry,
  guiDelegationDefaultsOf,
  guiSpawnSuppressesNativeAgents,
  spawnFingerprint
} = sessions
const {
  GUI_HELPERS_STORE_FILE,
  GUI_HELPER_DELIVERY_DIR,
  GUI_HELPER_PERSONA,
  GUI_HELPER_RESULT_HEAD_CHARS,
  GuiHelperCatalogCache,
  buildGuiDelegationApi,
  claudeHelperArgs,
  claudeHelperSessionOptions,
  codexHelperArgs,
  codexHelperSessionOptions,
  codexHelperThreadId,
  createGuiHelperStore,
  guiHelperDeliveryDocument,
  guiHelperDeliveryPath,
  guiHelperEventFor,
  guiHelperResultText,
  guiHelperSpawnText,
  guiHelperStatusText,
  guiPinDeviationText,
  guiPinDeviations,
  planGuiHelperRequests,
  resolveGuiHelperSeat,
  writeGuiHelperDelivery
} = wiring
const { GuiHelperEngine } = engineModule

const source = (relative) =>
  readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

/** Registro de ajudante como o motor o publica (só o que os cards consomem). */
function helperRecord(patch = {}) {
  return {
    helperId: 'h-1',
    delegatorPaneId: 'gui-dev-abc12345',
    projectId: 'proj',
    cli: 'claude',
    model: 'opus',
    effort: 'high',
    seatId: 'seat-1',
    seatName: 'Claude - Gmail',
    prompt: 'reescreva o card de versão',
    state: 'working',
    startedAt: 1_000,
    ...patch
  }
}

// ————— 1. A FORMA DO CARD (o contrato que a lateral lê) —————

test('o card sintetizado carrega EXATAMENTE o contrato que a lateral promove', () => {
  const record = helperRecord()
  const [card, receipt] = guiHelperSpawnedEvents(record, 'toolu_delegate_1')

  assert.equal(card.type, 'tool')
  assert.equal(card.name, 'helper:h-1', 'o nome é o marcador que promove o card')
  assert.equal(card.toolUseId, 'helper:h-1', 'o toolUseId é o id ESTÁVEL do ajudante')
  assert.equal(card.parentToolUseId, 'toolu_delegate_1', 'sem envelope a lateral mostra N+1 fichas')
  assert.deepEqual(card.input, {
    helperId: 'h-1',
    model: 'opus',
    effort: 'high',
    seat: 'Claude - Gmail',
    cli: 'claude',
    prompt: 'reescreva o card de versão'
  })

  // O RECIBO é o que dá ao ajudante o ciclo de vida do Agent nativo no
  // renderer: `capGuiItems` não evicta card `launched`, `closePendingGuiTools`
  // o cancela quando a sessão morre e o respawn o assenta.
  assert.equal(receipt.type, 'tool-result')
  assert.equal(receipt.toolUseId, 'helper:h-1')
  assert.equal(receipt.agentStatus, 'launched')
  assert.equal(receipt.isError, false)

  // A ponte com o renderer é literal: os dois lados falam do MESMO prefixo.
  const sidebar = source('src/renderer/src/guiSubagentSidebar.ts')
  assert.match(sidebar, /helper:<helperId>/u, 'o contrato do card sumiu do renderer')
  assert.equal(GUI_HELPER_CARD_PREFIX, 'helper:')
  assert.equal(guiHelperCardId('x'), 'helper:x')
})

test('o card do ajudante nomeia a conta e corta o briefing no que a ficha mostra', () => {
  const input = guiHelperCardInput(
    helperRecord({ seatName: undefined, effort: undefined, name: 'revisor', prompt: 'a'.repeat(600) })
  )
  assert.equal(input.seat, 'seat-1', 'sem apelido da conta, o id é melhor que silêncio')
  assert.equal(input.effort, undefined, 'effort que não chegou ao CLI nunca é carimbado')
  assert.equal(input.name, 'revisor')
  assert.ok(String(input.prompt).length <= 240, 'briefing inteiro no anel é peso morto')
})

test('a chamada `delegate` é reconhecida nos dois CLIs e as irmãs NÃO são', () => {
  for (const name of ['delegate', 'mcp__synkora__delegate', 'synkora/delegate', 'Task']) {
    assert.equal(isGuiDelegateToolName(name), true, name)
  }
  for (const name of [
    'helpers_status',
    'helper_result',
    'helper_send',
    'helper_cancel',
    'list_seats',
    'TaskCreate',
    'mcp__synkora__list_seats'
  ]) {
    assert.equal(isGuiDelegateToolName(name), false, name)
  }
})

test('o card de ATIVIDADE nunca é promovido a ficha própria', () => {
  const evt = guiHelperActivityEvent(
    helperRecord({ lastActivity: { at: 2_000, summary: 'Read src/main/index.ts' } }),
    1
  )
  assert.equal(evt.parentToolUseId, 'helper:h-1')
  assert.equal(evt.name.startsWith(GUI_HELPER_CARD_PREFIX), false)
  assert.equal('helperId' in evt.input, false, 'helperId no input viraria um ajudante fantasma')
  assert.equal(evt.input.description, 'Read src/main/index.ts')
  assert.equal(guiHelperActivityEvent(helperRecord(), 1), null, 'sem atividade, sem card')
})

test('o desfecho do ajudante fecha o card com o veredito do motor', () => {
  const done = guiHelperSettledEvent(helperRecord({ state: 'done', result: 'pronto' }))
  assert.deepEqual(
    { outcome: done.outcome, isError: done.isError, agentStatus: done.agentStatus, text: done.text },
    { outcome: 'completed', isError: false, agentStatus: 'settled', text: 'pronto' }
  )
  const failed = guiHelperSettledEvent(helperRecord({ state: 'failed', failure: 'caiu' }))
  assert.equal(failed.outcome, 'failed')
  assert.equal(failed.isError, true)
  const cancelled = guiHelperSettledEvent(helperRecord({ state: 'cancelled', failure: 'parei' }))
  assert.equal(cancelled.outcome, 'cancelled')
  assert.equal(cancelled.isError, false, 'cancelar não é falhar')
  const huge = guiHelperSettledEvent(helperRecord({ state: 'done', result: 'x'.repeat(9_000) }))
  assert.equal(huge.truncated, true)
  assert.match(huge.text, /helper_result/u, 'o corte tem de dizer onde está o resto')
})

// ————— 2. OS ÓRFÃOS DO BOOT —————

test('ajudante aberto numa fotografia de outro processo é cancelado, e só ele', () => {
  const ring = [
    { type: 'tool', name: 'mcp__synkora__delegate', input: {}, toolUseId: 'env-1' },
    { type: 'tool-result', toolUseId: 'env-1', text: '', isError: false, agentStatus: 'launched' },
    { type: 'tool', name: 'helper:vivo', input: {}, toolUseId: 'helper:vivo', parentToolUseId: 'env-1' },
    { type: 'tool-result', toolUseId: 'helper:vivo', text: '', isError: false, agentStatus: 'launched' },
    { type: 'tool', name: 'helper:pronto', input: {}, toolUseId: 'helper:pronto', parentToolUseId: 'env-1' },
    { type: 'tool-result', toolUseId: 'helper:pronto', text: 'ok', isError: false, agentStatus: 'settled' },
    { type: 'tool', name: 'Read', input: {}, toolUseId: 'tool-comum' }
  ]
  const cancellations = guiOrphanHelperCancellations(ring, 'o app fechou')
  assert.deepEqual(
    cancellations.map((evt) => evt.toolUseId),
    ['helper:vivo', 'env-1'],
    'o ajudante fecha ANTES do envelope, e ferramenta comum não é ajudante'
  )
  for (const evt of cancellations) {
    assert.equal(evt.outcome, 'cancelled')
    assert.equal(evt.agentStatus, 'settled')
    assert.match(evt.text, /o app fechou/u)
  }
  assert.deepEqual(
    guiOrphanHelperCancellations(cancellations.concat(ring), 'de novo').length,
    0,
    'quem já fechou nunca fecha duas vezes'
  )
})

test('envelope SINTÉTICO não existe como card e nada tenta fechá-lo', () => {
  const ring = [
    {
      type: 'tool',
      name: 'helper:solto',
      input: {},
      toolUseId: 'helper:solto',
      parentToolUseId: 'helper:lote:xyz'
    }
  ]
  assert.deepEqual(
    guiOrphanHelperCancellations(ring, 'o app fechou').map((evt) => evt.toolUseId),
    ['helper:solto']
  )
})

// ————— 3. A COSTURA DE CORRELAÇÃO —————

function correlator(options = {}) {
  const emitted = []
  const clock = { now: options.now ?? 10_000 }
  const instance = new GuiHelperCardCorrelator({
    emit: (paneId, evt) => emitted.push({ paneId, evt }),
    turnActive: options.turnActive ?? (() => false),
    now: () => clock.now
  })
  return { instance, emitted, clock }
}

const toolEvent = (name, toolUseId) => ({ type: 'tool', name, input: {}, toolUseId })

test('o lote reclama o envelope que o CLI publicou ANTES da chamada MCP', () => {
  const { instance, emitted } = correlator()
  instance.observe('p1', toolEvent('mcp__synkora__delegate', 'toolu_1'))
  instance.begin('p1')
  instance.change({ kind: 'spawned', record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1' }) })
  instance.end('p1')

  const card = emitted.find(({ evt }) => evt.type === 'tool').evt
  assert.equal(card.parentToolUseId, 'toolu_1')
})

test('duas chamadas concorrentes recebem envelopes DIFERENTES, em ordem', () => {
  const { instance, emitted } = correlator()
  instance.observe('p1', toolEvent('mcp__synkora__delegate', 'toolu_1'))
  instance.observe('p1', toolEvent('mcp__synkora__delegate', 'toolu_2'))

  instance.begin('p1')
  instance.change({ kind: 'spawned', record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1' }) })
  instance.end('p1')
  instance.begin('p1')
  instance.change({ kind: 'spawned', record: helperRecord({ helperId: 'h-b', delegatorPaneId: 'p1' }) })
  instance.end('p1')

  const parents = emitted
    .filter(({ evt }) => evt.type === 'tool')
    .map(({ evt }) => [evt.toolUseId, evt.parentToolUseId])
  assert.deepEqual(parents, [
    ['helper:h-a', 'toolu_1'],
    ['helper:h-b', 'toolu_2']
  ])
})

test('sem envelope na fila o lote usa um id sintético — o ajudante nunca fica sem pai', () => {
  const { instance, emitted } = correlator()
  instance.begin('p1')
  instance.change({ kind: 'spawned', record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1' }) })
  instance.end('p1')
  const card = emitted.find(({ evt }) => evt.type === 'tool').evt
  assert.ok(card.parentToolUseId, 'card sem pai vira ficha órfã na lateral')
  assert.match(card.parentToolUseId, /^helper:lote:/u)
})

test('envelope resolvido pelo CLI e não reclamado SAI da fila', () => {
  const { instance, emitted } = correlator()
  instance.observe('p1', toolEvent('mcp__synkora__delegate', 'toolu_morto'))
  // O CLI devolveu o resultado e nenhum lote reclamou: parear um lote FUTURO
  // com esta chamada colaria ajudantes novos num card já encerrado.
  instance.observe('p1', {
    type: 'tool-result',
    toolUseId: 'toolu_morto',
    text: 'ok',
    isError: false
  })
  instance.observe('p1', toolEvent('mcp__synkora__delegate', 'toolu_vivo'))
  instance.begin('p1')
  instance.change({ kind: 'spawned', record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1' }) })
  instance.end('p1')
  assert.equal(emitted.find(({ evt }) => evt.type === 'tool').evt.parentToolUseId, 'toolu_vivo')
})

test('o envelope fica LAUNCHED enquanto a frota trabalha e só assenta com ela inteira', () => {
  const { instance, emitted } = correlator()
  instance.observe('p1', toolEvent('mcp__synkora__delegate', 'toolu_1'))
  instance.begin('p1')
  for (const helperId of ['h-a', 'h-b']) {
    instance.change({ kind: 'spawned', record: helperRecord({ helperId, delegatorPaneId: 'p1' }) })
  }
  instance.end('p1')

  const held = instance.observe('p1', {
    type: 'tool-result',
    toolUseId: 'toolu_1',
    text: '2 ajudantes abertos',
    isError: false
  })
  assert.equal(held.agentStatus, 'launched', 'o card do lote fecharia no mesmo segundo')

  emitted.length = 0
  instance.change({
    kind: 'settled',
    record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1', state: 'done', result: 'ok' })
  })
  assert.deepEqual(
    emitted.map(({ evt }) => evt.toolUseId),
    ['helper:h-a'],
    'o envelope não pode assentar com irmão vivo'
  )

  emitted.length = 0
  instance.change({
    kind: 'settled',
    record: helperRecord({ helperId: 'h-b', delegatorPaneId: 'p1', state: 'done', result: 'ok' })
  })
  assert.deepEqual(emitted.map(({ evt }) => evt.toolUseId ?? evt.type), [
    'helper:h-b',
    'toolu_1',
    'turn-continuation'
  ])
  const envelope = emitted[1].evt
  assert.equal(envelope.agentStatus, 'settled')
  assert.match(envelope.text, /2 ajudantes/u)
})

test('ajudante que morre no nascimento não fecha o lote antes dos irmãos nascerem', () => {
  const { instance, emitted } = correlator()
  instance.observe('p1', toolEvent('delegate', 'toolu_1'))
  instance.begin('p1')
  // O adaptador do primeiro explodiu: o motor publica spawned E settled ainda
  // DENTRO do engine.spawn, com os irmãos por abrir.
  instance.change({ kind: 'spawned', record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1' }) })
  instance.change({
    kind: 'settled',
    record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1', state: 'failed', failure: 'não subiu' })
  })
  assert.equal(
    emitted.some(({ evt }) => evt.toolUseId === 'toolu_1'),
    false,
    'o envelope fecharia com a frota ainda nascendo'
  )
  instance.change({ kind: 'spawned', record: helperRecord({ helperId: 'h-b', delegatorPaneId: 'p1' }) })
  instance.end('p1')
  assert.equal(
    emitted.some(({ evt }) => evt.toolUseId === 'toolu_1'),
    false,
    'o irmão vivo ainda segura o lote'
  )
  instance.change({
    kind: 'settled',
    record: helperRecord({ helperId: 'h-b', delegatorPaneId: 'p1', state: 'done', result: 'ok' })
  })
  assert.equal(emitted.some(({ evt }) => evt.toolUseId === 'toolu_1'), true)
})

test('lote em que TODOS falharam no nascimento fecha na barreira do end', () => {
  const { instance, emitted } = correlator()
  instance.observe('p1', toolEvent('delegate', 'toolu_1'))
  instance.begin('p1')
  instance.change({ kind: 'spawned', record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1' }) })
  instance.change({
    kind: 'settled',
    record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1', state: 'failed', failure: 'x' })
  })
  emitted.length = 0
  instance.end('p1')
  assert.deepEqual(
    emitted.map(({ evt }) => evt.toolUseId ?? evt.type),
    ['toolu_1', 'turn-continuation']
  )
})

test('o `result` do turno CONTINUA enquanto houver ajudante vivo', () => {
  const { instance } = correlator()
  instance.observe('p1', toolEvent('delegate', 'toolu_1'))
  instance.begin('p1')
  instance.change({ kind: 'spawned', record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1' }) })
  instance.end('p1')

  // Sem isto o fim de turno do delegador CANCELA no renderer todo card ainda
  // pendente — inclusive os `launched`. É o mesmo degrau que o próprio claude
  // usa para as tarefas de fundo dele (maestroSession: claudeTasks.size > 0).
  const held = instance.observe('p1', { type: 'result', isError: false })
  assert.equal(held.continues, true)

  instance.change({
    kind: 'settled',
    record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1', state: 'done', result: 'ok' })
  })
  const free = instance.observe('p1', { type: 'result', isError: false })
  assert.equal(free.continues, undefined, 'frota encerrada não segura mais o turno')
})

test('quando a frota acaba e o CLI está mudo, o pane volta a IDLE sozinho', () => {
  const active = { value: true }
  const { instance, emitted } = correlator({ turnActive: () => active.value })
  instance.observe('p1', toolEvent('delegate', 'toolu_1'))
  instance.begin('p1')
  instance.change({ kind: 'spawned', record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1' }) })
  instance.end('p1')

  emitted.length = 0
  instance.change({
    kind: 'settled',
    record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1', state: 'done', result: 'ok' })
  })
  assert.equal(
    emitted.some(({ evt }) => evt.type === 'turn-continuation'),
    false,
    'turno vivo fecha sozinho: quem manda ali é o result do CLI'
  )
})

test('a atividade do ajudante é amostrada — o anel do dono não é lixeira', () => {
  const { instance, emitted, clock } = correlator()
  instance.observe('p1', toolEvent('delegate', 'toolu_1'))
  instance.begin('p1')
  instance.change({ kind: 'spawned', record: helperRecord({ helperId: 'h-a', delegatorPaneId: 'p1' }) })
  instance.end('p1')
  emitted.length = 0

  const beat = (summary) =>
    instance.change({
      kind: 'activity',
      record: helperRecord({
        helperId: 'h-a',
        delegatorPaneId: 'p1',
        lastActivity: { at: clock.now, summary }
      })
    })

  beat('Read a')
  beat('Read b')
  assert.equal(emitted.length, 1, 'duas batidas no mesmo instante viram uma')
  clock.now += GUI_HELPER_CARD_ACTIVITY_MS
  beat('Read c')
  assert.equal(emitted.length, 2)
  for (let index = 0; index < GUI_HELPER_CARD_ACTIVITY_MAX + 5; index += 1) {
    clock.now += GUI_HELPER_CARD_ACTIVITY_MS
    beat(`Read ${index}`)
  }
  assert.equal(emitted.length, GUI_HELPER_CARD_ACTIVITY_MAX, 'o teto por ajudante é duro')
})

test('atividade de ajudante desconhecido não inventa card', () => {
  const { instance, emitted } = correlator()
  instance.change({
    kind: 'activity',
    record: helperRecord({ helperId: 'fantasma', delegatorPaneId: 'p1', lastActivity: { at: 1, summary: 'x' } })
  })
  assert.deepEqual(emitted, [])
})

// ————— 4. O REGISTRO DE SESSÕES —————

function stubSession(sink) {
  return {
    alive: true,
    turnActive: false,
    caps: { commands: [], models: [] },
    waitCaps: async () => ({ commands: [], models: [] }),
    setExecutor: async () => true,
    send: () => sink({ type: 'text', text: 'ok' }),
    interrupt: () => false,
    kill: () => undefined
  }
}

function registryWith(storeFile) {
  const pushed = []
  const gui = new GuiSessionRegistry({
    push: (payload) => pushed.push(payload),
    systemPromptFile: () => undefined,
    ...(storeFile ? { storeFile } : {})
  })
  gui.spawnSession = (_spawn, sink) => stubSession(sink)
  return { gui, pushed }
}

const devSpawn = {
  paneId: 'gui-dev-abc12345',
  projectId: 'proj',
  cli: 'claude',
  configDir: 'cfg',
  seatId: 'seat-1',
  cwd: '/w',
  model: 'opus',
  effort: 'high',
  permissionMode: 'bypass'
}

test('o delegador é lido da CONVERSA VIVA, não do nascimento da missão', () => {
  const { gui } = registryWith()
  assert.equal(gui.delegatorFor(devSpawn.paneId), undefined, 'pane sem sessão não delega')
  assert.equal(gui.create(devSpawn).ok, true)
  assert.deepEqual(gui.delegatorFor(devSpawn.paneId), {
    paneId: devSpawn.paneId,
    projectId: 'proj',
    cwd: '/w',
    cli: 'claude',
    model: 'opus',
    effort: 'high',
    seatId: 'seat-1',
    permissionMode: 'bypass'
  })
  assert.equal(gui.beginHelperBatch('pane-que-nao-existe'), undefined)
})

test('do delegate ao desfecho: os cards nascem e morrem no anel do delegador', () => {
  const { gui } = registryWith()
  assert.equal(gui.create(devSpawn).ok, true)
  const entry = gui.panes.get(devSpawn.paneId)

  entry.sink({ type: 'tool', name: 'mcp__synkora__delegate', input: {}, toolUseId: 'toolu_1' })
  assert.ok(gui.beginHelperBatch(devSpawn.paneId))
  gui.noteHelperChange({
    kind: 'spawned',
    record: helperRecord({ helperId: 'h-a', delegatorPaneId: devSpawn.paneId })
  })
  gui.endHelperBatch(devSpawn.paneId)

  const cards = entry.ring.snapshot().filter((evt) => evt.type === 'tool')
  const card = cards.find((evt) => evt.toolUseId === 'helper:h-a')
  assert.ok(card, 'o card do ajudante tem de estar no anel (é ele que remonta a lateral)')
  assert.equal(card.parentToolUseId, 'toolu_1')
  assert.equal(card.input.model, 'opus')

  gui.noteHelperChange({
    kind: 'settled',
    record: helperRecord({
      helperId: 'h-a',
      delegatorPaneId: devSpawn.paneId,
      state: 'done',
      result: 'entrega'
    })
  })
  const results = entry.ring.snapshot().filter((evt) => evt.type === 'tool-result')
  assert.deepEqual(
    results.map((evt) => [evt.toolUseId, evt.agentStatus]),
    [
      ['helper:h-a', 'launched'],
      ['helper:h-a', 'settled'],
      ['toolu_1', 'settled']
    ]
  )
})

test('a fotografia que volta do disco nunca mostra ajudante vivo de outro processo', () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-helper-boot-'))
  try {
    const storeFile = join(root, 'gui-sessions.json')
    const first = registryWith(storeFile)
    assert.equal(first.gui.create(devSpawn).ok, true)
    const entry = first.gui.panes.get(devSpawn.paneId)
    entry.sink({ type: 'tool', name: 'mcp__synkora__delegate', input: {}, toolUseId: 'toolu_1' })
    first.gui.beginHelperBatch(devSpawn.paneId)
    first.gui.noteHelperChange({
      kind: 'spawned',
      record: helperRecord({ helperId: 'h-a', delegatorPaneId: devSpawn.paneId })
    })
    first.gui.endHelperBatch(devSpawn.paneId)
    // Fecha o app com o ajudante vivo: o desfecho dele nunca chegou ao anel.
    first.gui.killAll()

    const second = registryWith(storeFile)
    assert.equal(second.gui.create(devSpawn).ok, true)
    const ring = second.gui.panes.get(devSpawn.paneId).ring.snapshot()
    const cancelled = ring.filter(
      (evt) => evt.type === 'tool-result' && evt.outcome === 'cancelled'
    )
    assert.deepEqual(cancelled.map((evt) => evt.toolUseId), ['helper:h-a', 'toolu_1'])
    assert.match(cancelled[0].text, /o app fechou/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reabrir a conversa fecha os cards com o motivo do reabrir, não o do boot', () => {
  const { gui } = registryWith()
  assert.equal(gui.create(devSpawn).ok, true)
  const entry = gui.panes.get(devSpawn.paneId)
  entry.sink({ type: 'tool', name: 'delegate', input: {}, toolUseId: 'toolu_1' })
  gui.beginHelperBatch(devSpawn.paneId)
  gui.noteHelperChange({
    kind: 'spawned',
    record: helperRecord({ helperId: 'h-a', delegatorPaneId: devSpawn.paneId })
  })
  gui.endHelperBatch(devSpawn.paneId)

  // Trocar o modo de permissão respawna o processo preservando o anel.
  assert.equal(gui.create({ ...devSpawn, permissionMode: 'plan' }).ok, true)
  const ring = gui.panes.get(devSpawn.paneId).ring.snapshot()
  const cancelled = ring.filter((evt) => evt.type === 'tool-result' && evt.outcome === 'cancelled')
  assert.deepEqual(cancelled.map((evt) => evt.toolUseId), ['helper:h-a', 'toolu_1'])
  assert.match(cancelled[0].text, /a conversa foi reaberta/u)
})

// ————— 5. A CERCA DO CODEX NO SPAWN —————

test('a cerca por THREAD acompanha o cinto dos args, e entra no fingerprint', () => {
  const fenced = {
    ...devSpawn,
    cli: 'codex',
    mcp: { args: ['-c', 'mcp_servers.synkora.url=http://x', '-c', 'features.multi_agent=false'] }
  }
  assert.equal(guiSpawnSuppressesNativeAgents(fenced), true)
  assert.equal(
    guiSpawnSuppressesNativeAgents({ ...fenced, cli: 'claude' }),
    false,
    'a chave é do codex — no claude a cerca é --disallowedTools'
  )
  assert.equal(
    guiSpawnSuppressesNativeAgents({ ...fenced, mcp: { args: ['-c', 'mcp_servers.synkora.url=http://x'] } }),
    false,
    'sem cinto não há suspensório: as duas camadas nascem e morrem juntas'
  )
  assert.equal(guiSpawnSuppressesNativeAgents({ ...fenced, mcp: undefined }), false)
  // Armar a cerca EXIGE processo novo — e exige porque o fingerprint muda.
  assert.notEqual(
    spawnFingerprint(fenced),
    spawnFingerprint({ ...fenced, mcp: { args: ['-c', 'mcp_servers.synkora.url=http://x'] } })
  )
  // E a costura real: o spawnSession do codex passa a cerca adiante.
  const guiSessionsSource = source('src/main/guiSessions.ts')
  assert.match(guiSessionsSource, /suppressNativeAgents: true/u)
})

// ————— 6. OS ADAPTADORES E AS CONTAS —————

test('o helper claude nasce com a cerca de 13 nomes, importada da fonte única', () => {
  const args = claudeHelperArgs()
  assert.equal(args[0], '--disallowedTools')
  const fence = args[1].split(',')
  for (const name of ['Task', 'Agent', 'Workflow', 'RemoteTrigger', 'ToolSearch']) {
    assert.ok(fence.includes(name), `${name} fora da cerca`)
  }
  for (const kept of ['Read', 'Write', 'Bash', 'Edit']) {
    assert.equal(fence.includes(kept), false, `${kept} NUNCA entra na cerca`)
  }
  const wiring = source('src/main/guiDelegationWiring.ts')
  assert.match(
    wiring,
    /import \{ CLAUDE_NATIVE_AGENT_FENCE \} from '\.\/guiDelegateMcp'/u,
    'a cerca tem de vir do módulo do MCP — duas listas divergem em silêncio'
  )
  assert.match(wiring, /CLAUDE_NATIVE_AGENT_FENCE\.join\(','\)/u)
})

test('o helper codex nasce com a cerca DUPLA e sem nenhuma ferramenta Synkora', () => {
  assert.deepEqual(codexHelperArgs(), ['-c', 'features.multi_agent=false'])
  const wiring = source('src/main/guiDelegationWiring.ts')
  assert.match(wiring, /suppressNativeAgents: true/u, 'falta o suspensório por thread')
  // SEM CADEIA: nenhum adaptador monta config de MCP para o ajudante.
  assert.doesNotMatch(wiring, /extraEnv:/u)
  assert.doesNotMatch(wiring, /mcp_servers\.synkora/u)
})

test('a conta: mesmo CLI clona o delegador, CLI cruzado cai na primeira LOGADA', () => {
  const seats = [
    { id: 's-claude-1', name: 'Claude A', cli: 'claude', status: 'pendente', configDir: 'a' },
    { id: 's-claude-2', name: 'Claude B', cli: 'claude', status: 'logado', configDir: 'b' },
    { id: 's-codex-1', name: 'Codex A', cli: 'codex', status: 'logado', configDir: 'c' }
  ]
  assert.equal(
    resolveGuiHelperSeat(seats, { cli: 'claude', preferredSeatId: 's-claude-1' })?.seatId,
    's-claude-1',
    'a conta do delegador vale mesmo com a heurística de login em dúvida'
  )
  assert.equal(resolveGuiHelperSeat(seats, { cli: 'claude' })?.seatId, 's-claude-2')
  assert.equal(
    resolveGuiHelperSeat(seats, { cli: 'codex', preferredSeatId: 's-claude-2' })?.seatId,
    's-codex-1',
    'o MODELO manda no binário: conta do outro CLI cai na regra do cruzado'
  )
  assert.equal(resolveGuiHelperSeat([], { cli: 'codex' }), undefined, 'sem conta, recusa clara')
  assert.equal(resolveGuiHelperSeat(seats, { cli: 'codex' })?.name, 'Codex A')
})

test('o evento do CLI vira o vocabulário do motor — e beco vira desfecho', () => {
  assert.deepEqual(guiHelperEventFor({ type: 'text', text: 'oi' }), { type: 'text', text: 'oi' })
  assert.deepEqual(guiHelperEventFor({ type: 'closed', code: 0 }), { type: 'closed', code: 0 })
  assert.equal(
    guiHelperEventFor({ type: 'result', isError: false, continues: true }),
    null,
    'turno que continua não encerra o ajudante'
  )
  assert.deepEqual(guiHelperEventFor({ type: 'result', isError: false, resultText: 'pronto' }), {
    type: 'result',
    isError: false,
    text: 'pronto'
  })
  const blocked = guiHelperEventFor({
    type: 'permission',
    requestId: 'r',
    toolName: 'Write',
    description: '',
    inputPretty: '',
    canAlways: false
  })
  assert.equal(blocked.type, 'fatal', 'ninguém responde permissão de sessão headless')
  assert.match(blocked.text, /edições\/bypass/u, 'a recusa tem de dizer o que fazer')
  const activity = guiHelperEventFor({
    type: 'tool',
    name: 'Read',
    input: { file_path: 'src/x.ts' }
  })
  assert.deepEqual(activity, { type: 'activity', summary: 'Read · src/x.ts' })
})

test('o catálogo frio NÃO é "não suporta effort"', () => {
  const cache = new GuiHelperCatalogCache(() => undefined)
  assert.equal(
    cache.supportsEffort({ cli: 'claude', model: 'opus' }),
    undefined,
    'derrubar o effort de toda frota por catálogo frio seria pior que um rótulo otimista'
  )
})

// ————— 7. AS TOOLS —————

function delegationApi(overrides = {}) {
  const calls = { begin: [], end: [], spawn: [] }
  const engine = {
    spawn: (delegator, helpers) => {
      calls.spawn.push({ delegator, helpers })
      if (overrides.spawnThrows) throw new Error('boom')
      return {
        receipts: helpers.map((helper, index) => ({
          ok: true,
          helperId: `h-${index}`,
          cli: 'claude',
          model: helper.model ?? 'opus',
          seatId: 'seat-1',
          seatName: 'Claude - Gmail'
        }))
      }
    },
    status: () => [],
    liveCount: () => overrides.liveCount ?? 0,
    get: (helperId) => (helperId === 'h-meu' ? { delegatorPaneId: 'p1' } : { delegatorPaneId: 'outro' }),
    result: async (helperId) => {
      // O irmão que encerra DURANTE a espera: o long-poll segue esperando o seu
      // (contrato intacto) e quem conta a novidade é o correio, na volta.
      overlap?.()
      return {
        ok: true,
        helperId,
        state: 'done',
        pending: false,
        waitedMs: 0,
        result: 'x',
        snapshot: { helperId, cli: 'claude', model: 'opus', seatId: 's', state: 'done', startedAt: 0, elapsedMs: 0, hasResult: true }
      }
    },
    send: () => ({ ok: true }),
    cancel: () => ({ ok: true })
  }
  const overlap = overrides.duringResult
  const api = buildGuiDelegationApi({
    engine,
    delegator: (paneId) =>
      paneId === 'p1'
        ? { paneId: 'p1', projectId: 'proj', cwd: '/w', cli: 'claude', model: 'opus', seatId: 'seat-1' }
        : undefined,
    beginBatch: (paneId) => calls.begin.push(paneId),
    endBatch: (paneId) => calls.end.push(paneId),
    seats: () => [],
    ...(overrides.inbox ? { inbox: overrides.inbox } : {}),
    now: () => 0
  })
  return { api, calls }
}

const delegatorId = { paneId: 'p1', role: 'gui-delegator', projectId: 'proj', cwd: '/w' }

test('só o chat de missão dev delega — e só sobre os PRÓPRIOS ajudantes', async () => {
  const { api } = delegationApi()
  const planner = { ...delegatorId, role: 'gui-planner' }
  assert.match(await api.delegateHelpers(planner, [{ prompt: 'x' }]), /não delega/u)
  assert.match(api.helpersStatus(planner), /não delega/u)

  assert.match(
    await api.helperResult(delegatorId, 'h-alheio'),
    /não é deste chat/u,
    'id opaco não é autorização'
  )
  assert.match(api.helperSend(delegatorId, 'h-alheio', 'oi'), /não é deste chat/u)
  assert.match(api.helperCancel(delegatorId, 'h-alheio'), /não é deste chat/u)
  assert.match(await api.helperResult(delegatorId, 'h-meu'), /entrega do ajudante/u)
})

test('a janela do lote SEMPRE fecha, inclusive quando o motor explode', async () => {
  const { api, calls } = delegationApi({ spawnThrows: true })
  await assert.rejects(() => api.delegateHelpers(delegatorId, [{ prompt: 'x' }]))
  assert.deepEqual(calls.begin, ['p1'])
  assert.deepEqual(calls.end, ['p1'], 'janela aberta faria o lote seguinte herdar estes ajudantes')
})

test('o recibo diz o que abriu, com modelo, effort e conta por ajudante', async () => {
  const { api, calls } = delegationApi()
  const text = await api.delegateHelpers(delegatorId, [
    { prompt: 'a', model: 'opus' },
    { prompt: 'b', model: 'gpt-5.6-sol' }
  ])
  assert.deepEqual(calls.begin, ['p1'])
  assert.deepEqual(calls.end, ['p1'])
  assert.match(text, /2 ajudantes abertos/u)
  assert.match(text, /helper_result/u, 'o recibo ensina como colher a entrega')
  assert.match(await api.delegateHelpers(delegatorId, []), /ao menos um ajudante/u)
  assert.match(
    await api.delegateHelpers({ ...delegatorId, paneId: 'morto' }, [{ prompt: 'x' }]),
    /não está aberto/u
  )
})

test('o aviso de custo da frota chega junto do recibo', () => {
  const text = guiHelperSpawnText(
    [{ ok: true, helperId: 'h-1', cli: 'claude', model: 'opus', seatId: 's' }],
    'frota claude com efforts diferentes'
  )
  assert.match(text, /⚠ frota claude com efforts diferentes/u)
  assert.match(guiHelperStatusText([]), /nenhum ajudante/u)
})

// ————— 8. CONTRATOS DE FONTE (o que só a costura do main prova) —————

test('chat de missão DEV arma o MCP de delegação; o planejador segue no kit de planos', () => {
  const missions = source('src/main/ipc/missions.ts')
  assert.match(missions, /import \{ armGuiDelegateMcp \} from '\.\.\/guiDelegateMcp'/u)
  assert.match(
    missions,
    /route\.missionType === 'planejamento'\s*\?\s*armGuiPlannerMcp\(mcpInput, guiPlannerMcpDeps\)\s*:\s*armGuiDelegateMcp\(mcpInput, guiPlannerMcpDeps\)/u,
    'um kit por chat, nunca os dois'
  )
  assert.match(missions, /delegateTools:/u, 'o diário tem de distinguir os dois kits')
})

test('a frota morre com o pane e com o app', () => {
  const ipc = source('src/main/ipc/gui.ts')
  assert.match(ipc, /extras\.helpers\?\.cancelPane\(paneId,/u, 'teardown do chat sem cancelar a frota')
  const index = source('src/main/index.ts')
  assert.match(index, /guiHelperEngine\.cancelAll\(/u, 'o quit tem de matar os headless do codex')
  assert.match(index, /helpers: guiHelperEngine/u)
  assert.match(index, /delegateHelpers: \(id, helpers\)/u, 'as tools de delegação saíram do McpApi')
})

// ————— 9. O PAINEL DE PADRÕES DO DONO (D8) —————
//
// "Como padrão vai vir eles; caso eu queira outros, aí eu falo" (dono, 18/08).
// A cadeia é: pedido EXPLÍCITO na tool > padrão do PAINEL > clone do delegador
// (a regra same-CLI da onda 1 continua valendo abaixo dela). O recibo carimba a
// ORIGEM de cada valor — sem isso o dono lê "opus · high" e não sabe se aquilo
// foi escolha do agente, pino dele ou herança da conversa.

const PANEL_SEATS = [
  { id: 'seat-claude', name: 'Claude A', cli: 'claude', status: 'logado', configDir: 'a' },
  { id: 'seat-codex', name: 'Codex A', cli: 'codex', status: 'logado', configDir: 'c' }
]

/** Motor REAL com adaptadores de mentira: a cadeia só se prova de ponta a ponta
 *  (o que o painel carimba tem de chegar ao `GuiHelperSpawnRequest`). */
function panelApi(options = {}) {
  const spawned = []
  const logged = []
  const adapter = (request) => {
    spawned.push(request)
    return { send: () => undefined, dispose: () => undefined }
  }
  let seq = 0
  const engine = new GuiHelperEngine({
    spawnClaude: adapter,
    spawnCodex: adapter,
    resolveSeat: (query) => resolveGuiHelperSeat(PANEL_SEATS, query),
    newId: () => `h-${(seq += 1)}`,
    // Cadência de partida DESLIGADA: estes testes leem o pedido que chega ao
    // adaptador, e com o escalonador real só o primeiro da frota teria partido.
    // A fila do R6.4 é provada na bancada do motor, com relógio próprio.
    spawnIntervalMs: 0,
    now: () => 0
  })
  const api = buildGuiDelegationApi({
    engine,
    delegator: () => ({
      paneId: 'p1',
      projectId: 'proj',
      cwd: '/w',
      cli: 'claude',
      model: 'opus',
      effort: 'high',
      seatId: 'seat-claude'
    }),
    beginBatch: () => undefined,
    endBatch: () => undefined,
    seats: () => PANEL_SEATS,
    ...(options.defaults ? { defaults: () => options.defaults } : {}),
    // O MESMO diário do motor (o index liga os dois à caixa-preta): aqui ele é
    // um coletor, para a suíte ler o desvio auditado sem subir processo nenhum.
    log: (entry) => logged.push(entry),
    now: () => 0
  })
  return { api, spawned, logged }
}

test('a cadeia do delegate: pedido explícito vence o painel, que vence o clone', async () => {
  const { api, spawned } = panelApi({ defaults: { model: 'fable', effort: 'low' } })
  const receipt = await api.delegateHelpers(delegatorId, [
    { prompt: 'a', model: 'sonnet', effort: 'max' },
    { prompt: 'b' }
  ])
  assert.deepEqual(
    spawned.map((request) => [request.model, request.effort]),
    [
      ['sonnet', 'max'],
      ['fable', 'low']
    ],
    'o painel só entra onde o pedido calou'
  )
  assert.match(receipt, /sonnet \(explícito\)/u)
  assert.match(receipt, /max \(explícito\)/u)
  assert.match(receipt, /fable \(painel\)/u)
  assert.match(receipt, /low \(painel\)/u)
})

test('sem painel o ajudante clona a conversa, e o recibo diz de onde veio', async () => {
  const { api, spawned } = panelApi()
  const receipt = await api.delegateHelpers(delegatorId, [{ prompt: 'a' }])
  assert.deepEqual(
    [spawned[0].model, spawned[0].effort],
    ['opus', 'high'],
    'a regra da onda 1 continua embaixo do painel'
  )
  assert.match(receipt, /opus \(herdado\)/u)
  assert.match(receipt, /high \(herdado\)/u)
})

test('o painel pode carimbar o modelo do OUTRO CLI — a conta segue o modelo', async () => {
  const { api, spawned } = panelApi({ defaults: { model: 'gpt-5.6-sol', effort: 'medium' } })
  const receipt = await api.delegateHelpers(delegatorId, [{ prompt: 'a' }])
  assert.equal(spawned[0].cli, 'codex', 'cross-CLI é cidadão de primeira classe')
  assert.equal(spawned[0].seat.seatId, 'seat-codex', 'a conta do delegador é de outro binário')
  // O effort do PAINEL é pedido explícito para o motor: ele nunca cai na regra
  // do cruzado (que só existe para a HERANÇA silenciosa da conversa).
  assert.equal(spawned[0].effort, 'medium')
  assert.match(receipt, /gpt-5\.6-sol \(painel\)/u)
  assert.match(receipt, /medium \(painel\)/u)
  assert.doesNotMatch(receipt, /não viaja para o codex/u)
})

test('modelo do painel sem effort cai na regra same-CLI da onda 1', async () => {
  const { api, spawned } = panelApi({ defaults: { model: 'gpt-5.6-sol' } })
  const receipt = await api.delegateHelpers(delegatorId, [{ prompt: 'a' }])
  assert.equal(spawned[0].effort, undefined, 'escala de um CLI nunca vira nível do outro')
  assert.match(receipt, /não viaja para o codex/u, 'a queda de effort nunca é silenciosa')
})

test('a conta pedida na tool chega ao motor (o campo se chama `seat` lá fora)', async () => {
  const { api, spawned } = panelApi()
  await api.delegateHelpers(delegatorId, [{ prompt: 'a', model: 'gpt-5.6-sol', seat: 'seat-codex' }])
  assert.equal(spawned[0].seat.seatId, 'seat-codex')
  const plans = planGuiHelperRequests([{ prompt: 'a', seat: 'seat-codex' }], undefined)
  assert.equal(plans[0].request.seatId, 'seat-codex', 'o motor lê seatId, a tool publica seat')
})

test('a origem é decidida por campo, e o plano preserva o pedido', () => {
  const plans = planGuiHelperRequests(
    [
      { prompt: 'a', model: 'sonnet' },
      { prompt: 'b', effort: 'max' },
      { prompt: 'c', name: 'revisor' }
    ],
    { model: 'fable', effort: 'low' }
  )
  assert.deepEqual(
    plans.map((plan) => [plan.origins.model, plan.origins.effort]),
    [
      ['explicito', 'painel'],
      ['painel', 'explicito'],
      ['painel', 'painel']
    ]
  )
  assert.equal(plans[2].request.name, 'revisor')
  assert.equal(plans[2].request.prompt, 'c')
  const inherited = planGuiHelperRequests([{ prompt: 'a' }], undefined)
  assert.deepEqual(
    [inherited[0].origins.model, inherited[0].origins.effort],
    ['herdado', 'herdado']
  )
  assert.equal(inherited[0].request.model, undefined, 'herdar é NÃO carimbar nada')
  // Campo vazio é AUSÊNCIA: um `model: ""` viraria modelo de verdade.
  const blank = planGuiHelperRequests([{ prompt: 'a', model: '  ', effort: '' }], {
    model: 'fable'
  })
  assert.equal(blank[0].request.model, 'fable')
  assert.equal(blank[0].origins.model, 'painel')
  assert.equal(blank[0].origins.effort, 'herdado')
})

test('o recibo só carimba origem do valor que existe', () => {
  const text = guiHelperSpawnText(
    [{ ok: true, helperId: 'h-1', cli: 'claude', model: 'opus', seatId: 'seat-claude' }],
    undefined,
    [{ model: 'painel', effort: 'painel' }]
  )
  assert.match(text, /opus \(painel\)/u)
  assert.doesNotMatch(text, /\(painel\) · \(painel\)/u, 'effort ausente não vira parêntese solto')
  // Chamada SEM origens continua válida e devolve a linha crua de sempre.
  assert.match(
    guiHelperSpawnText([{ ok: true, helperId: 'h-1', cli: 'claude', model: 'opus', seatId: 's' }]),
    /\n {4}opus · s · claude\n/u
  )
})

test('o padrão do painel persiste POR PANE e volta do disco', () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-panel-'))
  try {
    const storeFile = join(root, 'gui-sessions.json')
    const first = registryWith(storeFile)
    assert.equal(first.gui.create(devSpawn).ok, true)
    assert.deepEqual(first.gui.delegationDefaults(devSpawn.paneId), {})
    assert.deepEqual(
      first.gui.setDelegationDefaults(devSpawn.paneId, { model: 'fable', effort: 'low' }),
      { ok: true, model: 'fable', effort: 'low' }
    )
    // O create regrava o record inteiro: sem carregar o pino adiante, trocar o
    // modo de permissão apagaria a escolha do dono sem ninguém saber.
    assert.equal(first.gui.create({ ...devSpawn, permissionMode: 'plan' }).ok, true)
    assert.deepEqual(first.gui.delegationDefaults(devSpawn.paneId), {
      model: 'fable',
      effort: 'low'
    })

    const second = registryWith(storeFile)
    assert.deepEqual(second.gui.delegationDefaults(devSpawn.paneId), {
      model: 'fable',
      effort: 'low'
    })
    // Trocar a conta invalida modelo/effort DA CONVERSA; o pino dos ajudantes é
    // escolha portátil do dono (e pode ser de outro CLI de propósito).
    second.gui.forgetSessionIdentity(devSpawn.paneId)
    assert.deepEqual(second.gui.delegationDefaults(devSpawn.paneId), {
      model: 'fable',
      effort: 'low'
    })
    // `null` LIMPA campo a campo; ausente conserva.
    assert.deepEqual(second.gui.setDelegationDefaults(devSpawn.paneId, { effort: null }), {
      ok: true,
      model: 'fable'
    })
    assert.deepEqual(second.gui.setDelegationDefaults(devSpawn.paneId, { model: null }), {
      ok: true
    })
    assert.deepEqual(second.gui.delegationDefaults(devSpawn.paneId), {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('o painel recusa o que não é escolha, e o documento sujo não vira padrão', () => {
  const { gui } = registryWith()
  assert.equal(gui.create(devSpawn).ok, true)
  assert.equal(gui.setDelegationDefaults('pane-que-nao-existe', { model: 'fable' }).ok, false)
  assert.match(gui.setDelegationDefaults(devSpawn.paneId, {}).error ?? '', /modelo ou o effort/u)
  assert.equal(gui.setDelegationDefaults(devSpawn.paneId, { model: '   ' }).ok, false)
  assert.equal(gui.setDelegationDefaults(devSpawn.paneId, { model: 'x'.repeat(129) }).ok, false)
  assert.equal(gui.setDelegationDefaults(devSpawn.paneId, { effort: 7 }).ok, false)
  assert.deepEqual(gui.delegationDefaults(devSpawn.paneId), {}, 'recusa não grava metade')

  // Hidratação: documento escrito à mão (ou de uma versão futura) não passa.
  assert.deepEqual(guiDelegationDefaultsOf(undefined), {})
  assert.deepEqual(
    guiDelegationDefaultsOf({ cli: 'claude', projectId: 'p', updatedAt: 'x', delegateModel: 42 }),
    {}
  )
  assert.deepEqual(
    guiDelegationDefaultsOf({
      cli: 'claude',
      projectId: 'p',
      updatedAt: 'x',
      delegateModel: ' fable ',
      delegateEffort: ''
    }),
    { model: 'fable' },
    'valor com espaço é aparado; vazio é ausência'
  )
})

test('a costura do painel existe dos dois lados do IPC', () => {
  const ipc = source('src/main/ipc/gui.ts')
  assert.match(ipc, /ipcMain\.handle\(\s*'gui:delegationDefaults'/u)
  assert.match(ipc, /ipcMain\.handle\(\s*'gui:setDelegationDefaults'/u)
  const handlers = ipc.slice(ipc.indexOf("'gui:delegationDefaults'"))
  assert.match(handlers, /extras\.assertAppRendererSender\(e\)/u, 'canal sem cerca de remetente')
  const preload = source('src/preload/index.ts')
  assert.match(preload, /invoke\('gui:delegationDefaults', paneId\)/u)
  assert.match(preload, /invoke\('gui:setDelegationDefaults', paneId, patch\)/u)
  const mock = source('src/renderer/src/devMock.ts')
  assert.match(mock, /delegationDefaults: async/u, 'o preview do browser espelha o namespace')
  assert.match(mock, /setDelegationDefaults: async/u)
  const index = source('src/main/index.ts')
  assert.match(
    index,
    /defaults: \(paneId\) => guiSessions\?\.delegationDefaults\(paneId\)/u,
    'a tool `delegate` tem de ler o painel do dono'
  )
})

// ————— 10. O PINO É A PALAVRA DO DONO (2026-08-18, 2º teste ao vivo) —————
//
// Caso real, com print: o dono carimbou "opus[1m] · high" no painel e pediu
// "abre 5 subagentes", sem citar modelo. O chat leu list_seats, viu folga numa
// conta codex e abriu 4 opus + 1 gpt-5.6-luna por conta própria. Palavras dele:
// "eu não especifiquei que eu queria luna — ele teria que abrir os cinco do
// padrão que eu mandei. Ele não tem que abrir da cabeça dele."
//
// A cerca NÃO pode ser dura: "abre 2 lunas" é ordem legítima do dono e chega à
// tool exatamente como a invenção do agente (memória
// feedback-guardas-nao-capam-inteligencia). Então é ADVISORY AUDITADO — a
// entrega acontece, o desvio é nomeado no recibo com a receita de desfazer, e
// o diário registra. A metade dura mora na persona (test:gui-mission-contracts).

const PIN = Object.freeze({ model: 'opus[1m]', effort: 'high' })

test('pino carimbado × modelo escolhido pelo agente: o recibo nomeia os dois e ensina a desfazer', async () => {
  const { api, spawned } = panelApi({ defaults: PIN })
  const text = await api.delegateHelpers(delegatorId, [
    { prompt: 'a' },
    { prompt: 'b' },
    { prompt: 'c' },
    { prompt: 'd' },
    { prompt: 'e', model: 'gpt-5.6-luna', name: 'quinto' }
  ])

  // O que o dono mandou continua valendo para os quatro que não foram tocados.
  assert.deepEqual(
    spawned.slice(0, 4).map((request) => [request.model, request.effort]),
    [
      ['opus[1m]', 'high'],
      ['opus[1m]', 'high'],
      ['opus[1m]', 'high'],
      ['opus[1m]', 'high']
    ]
  )
  // O aviso nomeia o PINO e o ajudante que saiu dele — sem os dois, o agente
  // não tem como saber o que desfazer.
  assert.match(text, /opus\[1m\]/u, 'o aviso tem de citar o padrão do dono')
  assert.match(text, /high/u)
  assert.match(text, /quinto/u, 'o ajudante que desviou tem de ser nomeado')
  assert.match(text, /gpt-5\.6-luna/u)
  assert.match(text, /helper_cancel/u, 'aviso sem receita é reclamação')
  assert.match(text, /CARIMBOU/u)
  // ADVISORY, não recusa: os cinco abriram.
  assert.equal(spawned.length, 5)
  assert.match(text, /5 ajudantes abertos/u)
})

test('frota inteira no padrão do painel não recebe aviso nenhum', async () => {
  const { api, spawned } = panelApi({ defaults: PIN })
  const text = await api.delegateHelpers(delegatorId, [
    { prompt: 'a' },
    { prompt: 'b' },
    { prompt: 'c' }
  ])
  assert.equal(spawned.every((request) => request.model === 'opus[1m]'), true)
  assert.doesNotMatch(text, /CARIMBOU/u, 'frota obediente sendo repreendida é ruído puro')
})

test('pedido do dono IGUAL ao pino não é desvio (nem com outra grafia)', async () => {
  const { api } = panelApi({ defaults: PIN })
  const text = await api.delegateHelpers(delegatorId, [
    { prompt: 'a', model: ' OPUS[1M] ', effort: 'HIGH' }
  ])
  assert.doesNotMatch(text, /CARIMBOU/u, 'carimbar o próprio padrão do dono não é desviar dele')
  // e a origem continua sendo a que o agente escreveu — o recibo não mente
  assert.match(text, /explícito/u)
})

test('sem pino no painel não existe desvio — a herança da conversa é a regra da onda 1', async () => {
  const { api } = panelApi()
  const text = await api.delegateHelpers(delegatorId, [
    { prompt: 'a', model: 'gpt-5.6-luna' }
  ])
  assert.doesNotMatch(text, /CARIMBOU/u)
})

test('o desvio do pino entra no DIÁRIO com o padrão e os ajudantes', async () => {
  const { api, logged } = panelApi({ defaults: PIN })
  await api.delegateHelpers(delegatorId, [
    { prompt: 'a' },
    { prompt: 'b', model: 'gpt-5.6-luna', name: 'quinto' }
  ])
  const entry = logged.find((item) => item.detail?.kind === 'pin-deviation')
  assert.ok(entry, 'o desvio tem de ser auditável — o dono lê a caixa-preta, não o chat')
  assert.equal(entry.paneId, 'p1')
  assert.equal(entry.detail.pinnedModel, 'opus[1m]')
  assert.equal(entry.detail.pinnedEffort, 'high')
  assert.deepEqual(
    entry.detail.helpers.map((helper) => [helper.name, helper.model]),
    [['quinto', 'gpt-5.6-luna']],
    'só quem desviou entra no registro'
  )
  // Frota obediente não escreve linha nenhuma no diário.
  const clean = panelApi({ defaults: PIN })
  await clean.api.delegateHelpers(delegatorId, [{ prompt: 'a' }])
  assert.equal(clean.logged.some((item) => item.detail?.kind === 'pin-deviation'), false)
})

test('effort fora do pino conta como desvio DENTRO do mesmo CLI, e nunca entre CLIs', () => {
  const pin = { model: 'opus[1m]', effort: 'high' }
  const receipts = [
    { ok: true, helperId: 'h-1', cli: 'claude', model: 'opus[1m]', effort: 'low', seatId: 's' }
  ]
  const sameCli = guiPinDeviations(
    planGuiHelperRequests([{ prompt: 'a', effort: 'low' }], pin),
    receipts,
    pin,
    'claude'
  )
  assert.deepEqual(sameCli, [{ helperId: 'h-1', effort: 'low' }])
  assert.match(guiPinDeviationText(pin, sameCli) ?? '', /low/u)

  // CROSS-CLI: as escalas não se traduzem (claude vai a max, codex a xhigh), e
  // o motor já derruba o herdado por isso. Cobrar o nível do outro binário
  // contra o pino seria inventar uma comparação que não existe — o que desviou
  // ali foi o MODELO, e é só isso que o aviso diz.
  const crossed = guiPinDeviations(
    planGuiHelperRequests([{ prompt: 'a', model: 'gpt-5.6-sol', effort: 'xhigh' }], pin),
    [{ ok: true, helperId: 'h-2', cli: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', seatId: 's' }],
    pin,
    'claude'
  )
  assert.deepEqual(crossed, [{ helperId: 'h-2', model: 'gpt-5.6-sol' }])

  // Ajudante que nem abriu não vira desvio: não há o que cancelar.
  assert.deepEqual(
    guiPinDeviations(
      planGuiHelperRequests([{ prompt: 'a', model: 'gpt-5.6-luna' }], pin),
      [{ ok: false, error: 'sem conta logada' }],
      pin,
      'claude'
    ),
    []
  )
  assert.equal(guiPinDeviationText(pin, []), undefined, 'sem desvio, sem aviso')
})

test('o aviso do pino convive com o do custo da frota — os dois chegam marcados', () => {
  const text = guiHelperSpawnText(
    [{ ok: true, helperId: 'h-1', cli: 'claude', model: 'opus', seatId: 's' }],
    ['frota claude com efforts diferentes', 'o dono CARIMBOU: opus[1m]'],
    undefined
  )
  assert.match(text, /⚠ frota claude com efforts diferentes/u)
  assert.match(text, /⚠ o dono CARIMBOU: opus\[1m\]/u)
})

// ————— 10. A ENTREGA EM ARQUIVO (ordem do dono, 18/08 à noite) —————
//
// "todo ajudante sempre entrega em modelo de ARQUIVO" (dono, 5º teste ao vivo),
// e a memória feedback-agente-saida-em-arquivo diz o preço de não fazer isso: um
// payload inline gigante já queimou uma rodada de 35 minutos. A persona PEDE
// (cinto) e o HARNESS ESCREVE (suspensório) — nenhuma entrega pode depender de o
// ajudante ter obedecido.

function tmpWorktree() {
  return mkdtempSync(join(tmpdir(), 'synkora-helper-'))
}

/** Registro como o motor o publica no desfecho (agora com o cwd do worktree). */
function deliveredRecord(cwd, patch = {}) {
  return {
    helperId: 'h-1',
    delegatorPaneId: 'gui-dev-abc12345',
    projectId: 'proj',
    name: 'pesquisa',
    cwd,
    cli: 'claude',
    model: 'opus[1m]',
    effort: 'high',
    seatId: 'seat-1',
    seatName: 'Claude - Gmail',
    prompt: 'levante os arquivos que tocam a fila',
    state: 'done',
    startedAt: 1_700_000_000_000,
    settledAt: 1_700_000_120_000,
    ...patch
  }
}

test('a entrega pousa no arquivo canônico do worktree, com cabeçalho honesto', () => {
  const cwd = tmpWorktree()
  try {
    const record = deliveredRecord(cwd)
    const outcome = writeGuiHelperDelivery({ record, text: 'a fila mora em src/main/queue.ts' })

    assert.equal(outcome.ok, true, outcome.error)
    assert.equal(outcome.path, '.synkora/helpers/h-1.md', 'o caminho é RELATIVO ao worktree')
    assert.equal(GUI_HELPER_DELIVERY_DIR, '.synkora/helpers')

    const onDisk = readFileSync(join(cwd, '.synkora', 'helpers', 'h-1.md'), 'utf8')
    assert.match(onDisk, /pesquisa/u, 'sem o apelido o dono não sabe de quem é o arquivo')
    assert.match(onDisk, /opus\[1m\]/u)
    assert.match(onDisk, /Claude - Gmail/u)
    assert.match(onDisk, /h-1/u)
    assert.match(onDisk, /concluí/u, 'o desfecho tem de estar no cabeçalho')
    assert.match(onDisk, /2023-11-14T22:13:20\.000Z/u, 'quando começou')
    assert.match(onDisk, /2023-11-14T22:15:20\.000Z/u, 'quando encerrou')
    assert.match(onDisk, /a fila mora em src\/main\/queue\.ts/u, 'o corpo é a entrega inteira')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('id com caractere proibido nunca vira caminho quebrado', () => {
  assert.equal(guiHelperDeliveryPath('h-1'), '.synkora/helpers/h-1.md')
  // `:` e `/` são ilegais em nome de arquivo no Windows — a mesma régua do
  // writeClaudeMcpConfig (paneId vira nome de arquivo e o write derrubava o spawn).
  assert.equal(guiHelperDeliveryPath('a/b:c'), '.synkora/helpers/a_b_c.md')
  assert.equal(guiHelperDeliveryPath('../fora'), '.synkora/helpers/.._fora.md')
})

test('entrega GIGANTE vai inteira para o arquivo — o teto de 64KB é só do inline', () => {
  const cwd = tmpWorktree()
  try {
    const changes = []
    const engine = new GuiHelperEngine({
      spawnClaude: (_request, emit) => {
        emitter.emit = emit
        return { send: () => undefined, dispose: () => undefined }
      },
      spawnCodex: () => ({ send: () => undefined, dispose: () => undefined }),
      resolveSeat: () => ({ seatId: 'seat-1', configDir: 'c', name: 'Claude - Gmail' }),
      deliver: (delivery) => writeGuiHelperDelivery(delivery),
      newId: () => 'h-gigante',
      onChange: (change) => changes.push(change)
    })
    const emitter = {}
    const outcome = engine.spawn(
      { paneId: 'p1', projectId: 'proj', cwd, cli: 'claude', model: 'opus', seatId: 'seat-1' },
      [{ prompt: 'escreva muito' }]
    )
    assert.equal(outcome.receipts[0].ok, true, outcome.receipts[0].error)

    const enorme = 'x'.repeat(200_000)
    emitter.emit({ type: 'result', isError: false, text: enorme })

    const record = engine.get('h-gigante')
    assert.equal(record.state, 'done')
    assert.equal(record.resultTruncated, true, 'o inline continua cortado no teto')
    assert.equal(record.resultPath, '.synkora/helpers/h-gigante.md')
    assert.equal(record.deliveryError, undefined)

    const onDisk = readFileSync(join(cwd, '.synkora', 'helpers', 'h-gigante.md'), 'utf8')
    assert.ok(onDisk.includes(enorme), 'o arquivo é onde NADA se perde')

    // O card do anel e a fotografia citam o arquivo: o dono e o agente leem o
    // mesmo endereço, venha ele da lateral ou de uma tool.
    const settled = changes.find((change) => change.kind === 'settled')
    assert.match(guiHelperSettledEvent(settled.record).text, /\.synkora\/helpers\/h-gigante\.md/u)
    assert.match(guiHelperStatusText(engine.status('p1')), /\.synkora\/helpers\/h-gigante\.md/u)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('falha de disco NÃO engole a entrega: o texto volta inline com o motivo', () => {
  const dir = tmpWorktree()
  try {
    // cwd apontando para um ARQUIVO: o mkdir do .synkora não tem como existir.
    const arquivo = join(dir, 'nao-sou-pasta')
    writeFileSync(arquivo, 'x', 'utf8')
    const outcome = writeGuiHelperDelivery({
      record: deliveredRecord(arquivo),
      text: 'a entrega'
    })
    assert.equal(outcome.ok, false)
    assert.ok(outcome.error.length > 0, 'a degradação nomeia a causa, nunca cala')

    // E o motor carimba o erro no registro sem perder o texto.
    const engine = new GuiHelperEngine({
      spawnClaude: (_request, emit) => {
        emitter.emit = emit
        return { send: () => undefined, dispose: () => undefined }
      },
      spawnCodex: () => ({ send: () => undefined, dispose: () => undefined }),
      resolveSeat: () => ({ seatId: 'seat-1', configDir: 'c' }),
      deliver: () => {
        throw new Error('disco cheio')
      },
      newId: () => 'h-sem-disco'
    })
    const emitter = {}
    engine.spawn(
      { paneId: 'p1', projectId: 'proj', cwd: arquivo, cli: 'claude', model: 'opus', seatId: 'seat-1' },
      [{ prompt: 'trabalhe' }]
    )
    emitter.emit({ type: 'result', isError: false, text: 'ENTREGA VIVA' })
    const record = engine.get('h-sem-disco')
    assert.equal(record.result, 'ENTREGA VIVA', 'entrega nunca se perde por causa do disco')
    assert.equal(record.resultPath, undefined)
    assert.match(record.deliveryError, /disco cheio/u)

    const text = guiHelperResultText({
      ok: true,
      helperId: 'h-sem-disco',
      state: 'done',
      pending: false,
      waitedMs: 0,
      result: 'ENTREGA VIVA',
      deliveryError: record.deliveryError,
      snapshot: {
        helperId: 'h-sem-disco',
        cli: 'claude',
        model: 'opus',
        seatId: 'seat-1',
        state: 'done',
        startedAt: 0,
        elapsedMs: 0,
        hasResult: true
      }
    })
    assert.match(text, /ENTREGA VIVA/u, 'sem arquivo, o texto INTEIRO volta inline')
    assert.match(text, /disco cheio/u, 'e o motivo viaja junto — degradação honesta')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('o helper_result entrega o CAMINHO primeiro e só um começo do texto', () => {
  const enorme = 'y'.repeat(GUI_HELPER_RESULT_HEAD_CHARS * 3)
  const view = {
    ok: true,
    helperId: 'h-1',
    state: 'done',
    pending: false,
    waitedMs: 0,
    result: enorme,
    resultPath: '.synkora/helpers/h-1.md',
    snapshot: {
      helperId: 'h-1',
      cli: 'claude',
      model: 'opus',
      seatId: 'seat-1',
      state: 'done',
      startedAt: 0,
      elapsedMs: 0,
      hasResult: true
    }
  }
  const text = guiHelperResultText(view)
  const caminho = text.indexOf('.synkora/helpers/h-1.md')
  const corpo = text.indexOf('yyy')
  assert.ok(caminho >= 0, 'o caminho tem de estar na resposta')
  assert.ok(corpo > caminho, 'o CAMINHO vem primeiro — é ele que o agente abre')
  assert.ok(
    text.length < GUI_HELPER_RESULT_HEAD_CHARS + 800,
    `a resposta despejou a entrega inteira (${text.length} chars)`
  )
  assert.match(text, /arquivo/u, 'a resposta diz que o resto está no arquivo')

  // Entrega curta cabe inteira: o arquivo continua citado, sem prometer corte
  // que não houve.
  const curta = guiHelperResultText({ ...view, result: 'só isso' })
  assert.match(curta, /só isso/u)
  assert.match(curta, /\.synkora\/helpers\/h-1\.md/u)
})

test('ajudante que FALHOU também tem arquivo, e a resposta aponta para ele', () => {
  const cwd = tmpWorktree()
  try {
    const record = deliveredRecord(cwd, {
      helperId: 'h-2',
      state: 'failed',
      failure: 'limite da conta estourou',
      name: undefined
    })
    const outcome = writeGuiHelperDelivery({ record, text: 'consegui ler metade dos arquivos' })
    assert.equal(outcome.ok, true, outcome.error)
    const onDisk = readFileSync(join(cwd, '.synkora', 'helpers', 'h-2.md'), 'utf8')
    assert.match(onDisk, /limite da conta estourou/u, 'a causa da falha entra no arquivo')
    assert.match(onDisk, /metade dos arquivos/u, 'e o trabalho parcial não se perde')

    const text = guiHelperResultText({
      ok: true,
      helperId: 'h-2',
      state: 'failed',
      pending: false,
      waitedMs: 0,
      failure: 'limite da conta estourou',
      resultPath: '.synkora/helpers/h-2.md',
      snapshot: {
        helperId: 'h-2',
        cli: 'claude',
        model: 'opus',
        seatId: 'seat-1',
        state: 'failed',
        startedAt: 0,
        elapsedMs: 0,
        hasResult: false
      }
    })
    assert.match(text, /limite da conta estourou/u)
    assert.match(text, /\.synkora\/helpers\/h-2\.md/u)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('o documento da entrega é legível sozinho: cabeçalho + corpo, sem nada inventado', () => {
  const doc = guiHelperDeliveryDocument(deliveredRecord('/w'), 'corpo da entrega')
  assert.ok(doc.startsWith('#'), 'é markdown — a aba Arquivos e o dono leem isto')
  assert.match(doc, /corpo da entrega/u)
  // Ajudante que encerrou sem escrever nada não vira arquivo mentindo que houve
  // entrega: o documento diz, com todas as letras, que não veio texto.
  const vazio = guiHelperDeliveryDocument(deliveredRecord('/w', { state: 'failed', failure: 'caiu' }), '')
  assert.match(vazio, /caiu/u)
  assert.match(vazio, /sem texto/iu)
})

test('a PERSONA do ajudante manda entregar em ARQUIVO e resumir no final', () => {
  assert.match(GUI_HELPER_PERSONA, /FILE/u)
  assert.match(GUI_HELPER_PERSONA, /path/u)
  assert.match(GUI_HELPER_PERSONA, /short/iu, 'a mensagem final é resumo, não despejo')
  // O suspensório mecânico é citado na própria persona: o ajudante sabe que o
  // harness guarda a mensagem final dele, então texto gigante ali é desperdício.
  assert.match(GUI_HELPER_PERSONA, /\.synkora\/helpers\//u)
})

test('o motor de produção nasce COM a entrega em arquivo ligada', () => {
  const src = source('src/main/guiDelegationWiring.ts')
  assert.match(
    src,
    /deliver:\s*\(delivery\)\s*=>\s*writeGuiHelperDelivery\(delivery\)/u,
    'sem esta linha o suspensório só existe no teste'
  )
})

// ————— 11. O CORREIO DOS AJUDANTES (o encerramento que não espera turno) —————
//
// O BUG REAL (5º teste do dono, 18/08): dois ajudantes encerraram enquanto o
// delegador estava DENTRO do turno, esperando um terceiro no long-poll. O
// despertador segurou o aviso (nunca se interrompe um turno vivo) e o agente,
// cego, disse ao dono "nenhum terminou" com a lateral mostrando o contrário.
// Ordem dele: "cada ajudante que terminar, avisar o orquestrador que terminou e
// entregar via MCP, pra não poluir o chat". A entrega então PEGA CARONA no
// próximo resultado de tool — o mesmo padrão do correio F6 (CLAUDE.md F6.10).

test('o encerramento pega carona no PRÓXIMO resultado de tool, uma vez só', async () => {
  const inbox = new GuiHelperInbox()
  const { api } = delegationApi({ inbox, liveCount: 3 })
  inbox.post('p1', {
    helperId: 'h-9',
    name: 'schema',
    model: 'gpt-5.6-luna',
    ok: true,
    resultPath: '.synkora/helpers/h-9.md'
  })

  const first = api.helpersStatus(delegatorId)
  assert.ok(first.includes(GUI_HELPER_INBOX_TAG), 'o aviso não viajou no resultado da tool')
  assert.match(first, /schema/u)
  assert.match(first, /gpt-5\.6-luna/u)
  assert.match(first, /h-9/u)
  assert.match(first, /\.synkora\/helpers\/h-9\.md/u, 'o caminho é o que o agente abre')
  assert.match(first, /3/u, 'quantos continuam trabalhando')

  const second = api.helpersStatus(delegatorId)
  assert.equal(
    second.includes(GUI_HELPER_INBOX_TAG),
    false,
    'entregue uma vez, o aviso morre — repetir é poluir o contexto'
  )
})

test('o correio viaja em TODA tool do catálogo, menos no eco do próprio ajudante', async () => {
  const inbox = new GuiHelperInbox()
  const { api } = delegationApi({ inbox })
  const post = (helperId) =>
    inbox.post('p1', { helperId, model: 'opus', ok: true, resultPath: `.synkora/helpers/${helperId}.md` })

  post('h-a')
  assert.ok((await api.delegateHelpers(delegatorId, [{ prompt: 'x' }])).includes(GUI_HELPER_INBOX_TAG))
  post('h-b')
  assert.ok((await api.listSeats(delegatorId)).includes(GUI_HELPER_INBOX_TAG))
  post('h-c')
  assert.ok(api.helperSend(delegatorId, 'h-meu', 'oi').includes(GUI_HELPER_INBOX_TAG))
  post('h-d')
  assert.ok(api.helperCancel(delegatorId, 'h-meu').includes(GUI_HELPER_INBOX_TAG))

  // helper_result do PRÓPRIO ajudante não se anuncia a si mesmo (seria eco: o
  // corpo da resposta JÁ é a entrega dele) — mas o irmão continua sendo contado.
  post('h-meu')
  post('h-irmao')
  const text = await api.helperResult(delegatorId, 'h-meu')
  const bloco = text.slice(text.indexOf(GUI_HELPER_INBOX_TAG))
  assert.ok(text.includes(GUI_HELPER_INBOX_TAG), 'o irmão tem de ser anunciado')
  assert.match(bloco, /h-irmao/u)
  assert.equal(bloco.includes('h-meu'), false, 'o próprio ajudante lido nunca ecoa no correio')
  // E a pendência dele foi CONSUMIDA: a leitura é a entrega.
  assert.equal(api.helpersStatus(delegatorId).includes(GUI_HELPER_INBOX_TAG), false)
})

test('o irmão que encerrou DURANTE o long-poll aparece na volta', async () => {
  const inbox = new GuiHelperInbox()
  const { api } = delegationApi({
    inbox,
    duringResult: () =>
      inbox.post('p1', {
        helperId: 'h-irmao',
        model: 'opus',
        ok: true,
        resultPath: '.synkora/helpers/h-irmao.md'
      })
  })
  const text = await api.helperResult(delegatorId, 'h-meu', 45)
  assert.match(text, /entrega do ajudante/u, 'o contrato do long-poll não muda: ele esperou o SEU')
  assert.ok(text.includes(GUI_HELPER_INBOX_TAG), 'o agente ficaria cego de novo sem isto')
  assert.match(text, /h-irmao/u)
})

test('o correio é POR PANE: um chat nunca lê o do outro', () => {
  const inbox = new GuiHelperInbox()
  const { api } = delegationApi({ inbox })
  inbox.post('p2', { helperId: 'h-alheio', model: 'opus', ok: true })
  assert.equal(api.helpersStatus(delegatorId).includes(GUI_HELPER_INBOX_TAG), false)
  assert.equal(inbox.count('p2'), 1, 'a pendência do outro pane continua lá, intocada')
  // Sem pendência nenhuma, a resposta da tool não ganha uma linha sequer.
  assert.equal(api.helpersStatus(delegatorId), guiHelperStatusText([]))
})

test('correio e despertador são O MESMO pote: quem entrega primeiro consome', () => {
  const inbox = new GuiHelperInbox()
  const wakes = []
  const armed = []
  const correlator = new GuiHelperCardCorrelator({
    emit: () => undefined,
    turnActive: () => true,
    inbox,
    setTimer: (ms, fn) => {
      const slot = { ms, fn, cancelled: false }
      armed.push(slot)
      return () => {
        slot.cancelled = true
      }
    },
    wake: (paneId, wake) => {
      wakes.push({ paneId, wake })
      return true
    }
  })
  const { api } = delegationApi({ inbox })
  const record = helperRecord({ delegatorPaneId: 'p1', resultPath: '.synkora/helpers/h-1.md' })
  correlator.begin('p1')
  correlator.change({ kind: 'spawned', record })
  correlator.end('p1')
  correlator.change({ kind: 'settled', record: { ...record, state: 'done', result: 'pronto' } })

  // O turno está VIVO (o agente chamou uma tool): o despertador segura, e é o
  // correio que entrega — na hora, sem interromper ninguém.
  const text = api.helpersStatus(delegatorId)
  assert.ok(text.includes(GUI_HELPER_INBOX_TAG))
  assert.match(text, /h-1/u)

  // E agora o despertador não tem mais o que dizer: a novidade já foi entregue.
  for (const slot of armed.splice(0, armed.length)) if (!slot.cancelled) slot.fn()
  assert.equal(wakes.length, 0, 'o dono receberia o MESMO aviso duas vezes')
  assert.equal(armed.filter((slot) => !slot.cancelled).length, 0, 'e o relógio se apaga sozinho')
})

test('o bloco do correio é curto, nomeia cada ajudante e ensina o movimento', () => {
  const bloco = guiHelperInboxBlock(
    [
      { helperId: 'h-1', name: 'pesquisa', model: 'opus[1m]', ok: true, resultPath: '.synkora/helpers/h-1.md' },
      { helperId: 'h-2', model: 'fable', ok: false, resultPath: '.synkora/helpers/h-2.md' }
    ],
    { stillWorking: 2 }
  )
  assert.ok(bloco.startsWith(GUI_HELPER_INBOX_TAG), 'o dono e o agente sabem de quem é a voz')
  assert.match(bloco, /pesquisa/u)
  assert.match(bloco, /opus\[1m\]/u)
  assert.match(bloco, /h-1/u)
  assert.match(bloco, /h-2/u)
  assert.match(bloco, /falh/u, 'falha também se conta')
  assert.match(bloco, /\.synkora\/helpers\/h-1\.md/u)
  assert.match(bloco, /2/u, 'quantos ainda trabalham')
  assert.ok(bloco.length < 700, `o bloco viaja em TODA tool: ${bloco.length} chars é despejo`)
  assert.equal(guiHelperInboxBlock([], {}), '', 'sem pendência, sem bloco')
})

// ————— 12. O CICLO REDONDO (R6-A: fundação do motor) —————
//
// A rodada 6 do design fecha o ciclo do ajudante: interromper preservando,
// guardar o registro em disco, saber a conversa de cada um (sessionId) e espaçar
// a partida da frota. Aqui provamos a metade que mora na COSTURA — o motor tem
// bancada própria (`test:gui-helper-sessions`).

test('o session-id do CLI vira o carimbo do motor, nos dois binários', () => {
  // claude: o id sobe no `result` de cada turno; codex: no thread/start, com o
  // prefixo próprio da casa. O motor guarda os dois CRUS — quem tira o prefixo é
  // o adaptador, no instante do resume.
  assert.deepEqual(guiHelperEventFor({ type: 'session-id', sessionId: 'sess-1' }), {
    type: 'session',
    sessionId: 'sess-1'
  })
  assert.deepEqual(guiHelperEventFor({ type: 'session-id', sessionId: 'codex-thread:uuid-9' }), {
    type: 'session',
    sessionId: 'codex-thread:uuid-9'
  })
})

test('as opções do helper CLAUDE: cerca, worktree, conta — e nenhuma ferramenta', () => {
  const request = {
    helperId: 'h-1',
    projectId: 'p',
    delegatorPaneId: 'gui-dev-1',
    cwd: 'C:/work/mission',
    cli: 'claude',
    model: 'opus[1m]',
    effort: 'high',
    seat: { seatId: 's1', configDir: 'C:/cfg/claude', name: 'Claude A' },
    prompt: 'trabalhe',
    permissionMode: 'edits'
  }
  const opts = claudeHelperSessionOptions(request, 'C:/prompts/h-1.system.md')
  assert.equal(opts.cwd, request.cwd)
  assert.equal(opts.configDir, 'C:/cfg/claude')
  assert.equal(opts.model, 'opus[1m]')
  assert.equal(opts.effort, 'high')
  assert.equal(opts.systemPromptFile, 'C:/prompts/h-1.system.md')
  assert.deepEqual(opts.extraArgs, claudeHelperArgs())
  assert.equal(opts.resumeSessionId, undefined, 'ajudante novo nunca nasce retomando conversa alheia')
  // SEM CADEIA: o ajudante não recebe token nem config de ferramenta nenhuma.
  for (const forbidden of ['extraEnv', 'mcp']) {
    assert.ok(!(forbidden in opts), `o ajudante claude recebeu "${forbidden}"`)
  }
  // Effort ausente = flag ausente (o motor já decidiu; a costura não inventa).
  assert.equal(claudeHelperSessionOptions({ ...request, effort: undefined }).effort, undefined)
})

test('as opções do helper CODEX: cerca DUPLA e o thread sem o prefixo da casa', () => {
  const request = {
    helperId: 'h-2',
    projectId: 'p',
    delegatorPaneId: 'gui-dev-1',
    cwd: 'C:/work/mission',
    cli: 'codex',
    model: 'gpt-5.6-sol',
    seat: { seatId: 's2', configDir: 'C:/cfg/codex' },
    prompt: 'trabalhe'
  }
  const opts = codexHelperSessionOptions(request)
  assert.deepEqual(opts.extraArgs, codexHelperArgs(), 'o cinto do app-server')
  assert.equal(opts.suppressNativeAgents, true, 'o suspensório por thread')
  assert.equal(opts.resumeSessionId, undefined)

  // O RESUME (R6.2): a MESMA conversa volta, e o thread/resume quer o uuid cru.
  assert.equal(
    codexHelperSessionOptions({ ...request, resumeSessionId: 'codex-thread:uuid-9' }).resumeSessionId,
    'uuid-9'
  )
  assert.equal(codexHelperThreadId('codex-thread:uuid-9'), 'uuid-9')
  assert.equal(codexHelperThreadId('uuid-9'), 'uuid-9', 'id já cru passa intacto')
  assert.equal(codexHelperThreadId('   '), undefined)
  assert.equal(codexHelperThreadId(undefined), undefined)
})

test('o RESUME do claude é o --resume headless, e a cerca vai junto', () => {
  const opts = claudeHelperSessionOptions({
    helperId: 'h-3',
    projectId: 'p',
    delegatorPaneId: 'gui-dev-1',
    cwd: 'C:/work/mission',
    cli: 'claude',
    model: 'opus[1m]',
    seat: { seatId: 's1', configDir: 'C:/cfg/claude' },
    prompt: 'continue de onde parou',
    resumeSessionId: 'sess-abc'
  })
  assert.equal(opts.resumeSessionId, 'sess-abc')
  assert.deepEqual(opts.extraArgs, claudeHelperArgs(), 'retomar não pode abrir a porta do subagente nativo')

  // E os adaptadores REAIS consomem estas funções — sem isso o contrato do
  // resume existiria só no teste.
  const src = source('src/main/guiDelegationWiring.ts')
  assert.match(src, /new MaestroSession\(\s*claudeHelperSessionOptions\(/u)
  assert.match(src, /new CodexSession\(\s*codexHelperSessionOptions\(/u)
})

test('o store de produção é o jsonStore da casa: atômico, com backup e reparável', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synkora-helpers-store-'))
  try {
    const file = join(dir, GUI_HELPERS_STORE_FILE)
    const store = createGuiHelperStore(file)
    assert.deepEqual(store.load(), [], 'arquivo inexistente não é erro — é frota vazia')

    const record = {
      helperId: 'h-1',
      delegatorPaneId: 'gui-dev-1',
      projectId: 'p',
      cwd: 'C:/work/mission',
      cli: 'claude',
      model: 'opus[1m]',
      seatId: 's1',
      prompt: 'trabalhe',
      state: 'interrupted',
      startedAt: 1_000,
      settledAt: 2_000,
      sessionId: 'sess-abc'
    }
    store.save([record])
    assert.deepEqual(createGuiHelperStore(file).load(), [record])
    // O backup é a segunda fotografia da MESMA gravação (padrão jsonStore).
    assert.deepEqual(JSON.parse(readFileSync(`${file}.bak`, 'utf8')).helpers, [record])

    // Documento estragado à mão cai no backup, e nunca derruba o boot.
    writeFileSync(file, '{ não é json', 'utf8')
    assert.deepEqual(createGuiHelperStore(file).load(), [record])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('o motor de produção liga a persistência quando o índice passa o arquivo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synkora-helpers-engine-'))
  try {
    const file = join(dir, GUI_HELPERS_STORE_FILE)
    createGuiHelperStore(file).save([
      {
        helperId: 'h-vivo',
        delegatorPaneId: 'gui-dev-1',
        projectId: 'p',
        cwd: dir,
        cli: 'claude',
        model: 'opus[1m]',
        seatId: 's1',
        prompt: 'estava trabalhando quando o app fechou',
        state: 'working',
        startedAt: Date.now() - 60_000
      }
    ])
    const engine = wiring.createGuiHelperEngine({
      storeFile: file,
      seats: () => [],
      systemPromptFile: () => undefined,
      onChange: () => undefined,
      log: () => undefined
    })
    assert.equal(engine.get('h-vivo')?.state, 'interrupted', 'o ajudante do boot anterior sumiu')
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).helpers[0].state, 'interrupted')

    // Sem arquivo, nada persiste — é como as suítes rodam sem tocar em disco.
    const semStore = wiring.createGuiHelperEngine({
      seats: () => [],
      systemPromptFile: () => undefined,
      onChange: () => undefined,
      log: () => undefined
    })
    assert.equal(semStore.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('o texto do interrompido diz que dá para RETOMAR — e não que acabou', () => {
  const snapshot = {
    helperId: 'h-1',
    cli: 'claude',
    model: 'opus[1m]',
    seatId: 'seat-1',
    state: 'interrupted',
    startedAt: 0,
    elapsedMs: 90_000,
    settledAt: 90_000,
    hasResult: true,
    resultPath: '.synkora/helpers/h-1.md',
    failure: 'o app foi fechado'
  }
  const status = guiHelperStatusText([snapshot])
  assert.match(status, /interrompido/iu, 'a ficha do dono mostrou o estado em inglês')
  assert.match(status, /\.synkora\/helpers\/h-1\.md/u)

  const text = guiHelperResultText({
    ok: true,
    helperId: 'h-1',
    state: 'interrupted',
    pending: false,
    waitedMs: 0,
    result: 'metade do trabalho',
    resultPath: '.synkora/helpers/h-1.md',
    failure: 'o app foi fechado',
    snapshot
  })
  assert.match(text, /interrompid/iu)
  assert.match(text, /retomar/iu, 'a única saída que existe não pode ficar escondida')
  assert.match(text, /\.synkora\/helpers\/h-1\.md/u, 'o que ele chegou a escrever tem endereço')
  assert.ok(!/encerrou como/u.test(text), 'interrompido não é desfecho')
})

test('depois do boot a entrega vive só no ARQUIVO, e a resposta diz isso', () => {
  // O disco guarda o registro, nunca o texto — ele já está no arquivo canônico.
  // Uma resposta que fingisse ter a entrega em mãos devolveria vazio.
  const text = guiHelperResultText({
    ok: true,
    helperId: 'h-1',
    state: 'done',
    pending: false,
    waitedMs: 0,
    resultPath: '.synkora/helpers/h-1.md',
    snapshot: {
      helperId: 'h-1',
      cli: 'claude',
      model: 'opus[1m]',
      seatId: 'seat-1',
      state: 'done',
      startedAt: 0,
      elapsedMs: 0,
      hasResult: false,
      resultPath: '.synkora/helpers/h-1.md'
    }
  })
  assert.match(text, /\.synkora\/helpers\/h-1\.md/u)
  assert.match(text, /arquivo/u)
  assert.ok(
    !/a entrega, inteira/u.test(text),
    'a resposta anunciou a entrega inteira e não tinha uma linha dela em mãos'
  )
  assert.ok(text.length < 400, `resposta sem entrega em mãos virou parágrafo: ${text.length} chars`)
})

test('a ficha mostra a re-tentativa do provedor enquanto ela acontece', () => {
  const status = guiHelperStatusText([
    {
      helperId: 'h-1',
      cli: 'claude',
      model: 'opus[1m]',
      seatId: 'seat-1',
      state: 'spawning',
      startedAt: 0,
      elapsedMs: 21_000,
      hasResult: false,
      retriedAt: 1_000,
      retryReason: 'sobrecarga do provedor'
    }
  ])
  assert.match(status, /re-tentando/u)
  assert.match(status, /sobrecarga do provedor/u)
})
