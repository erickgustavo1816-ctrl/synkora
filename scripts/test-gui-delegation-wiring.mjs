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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

// Namespace de propósito: com destructure no topo, UM export faltando derruba o
// arquivo inteiro e a suíte deixa de discriminar. Assim, a ausência de uma peça
// reprova só o teste que depende dela — que é como o vermelho vira diagnóstico.
import * as cards from '../.tmp/gui-delegation-wiring-test/guiHelperCards.js'
import * as sessions from '../.tmp/gui-delegation-wiring-test/guiSessions.js'
import * as wiring from '../.tmp/gui-delegation-wiring-test/guiDelegationWiring.js'

const {
  GUI_HELPER_CARD_ACTIVITY_MAX,
  GUI_HELPER_CARD_ACTIVITY_MS,
  GUI_HELPER_CARD_PREFIX,
  GuiHelperCardCorrelator,
  guiHelperActivityEvent,
  guiHelperCardId,
  guiHelperCardInput,
  guiHelperSettledEvent,
  guiHelperSpawnedEvents,
  guiOrphanHelperCancellations,
  isGuiDelegateToolName
} = cards
const { GuiSessionRegistry, guiSpawnSuppressesNativeAgents, spawnFingerprint } = sessions
const {
  GuiHelperCatalogCache,
  buildGuiDelegationApi,
  claudeHelperArgs,
  codexHelperArgs,
  guiHelperEventFor,
  guiHelperSpawnText,
  guiHelperStatusText,
  resolveGuiHelperSeat
} = wiring

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
    get: (helperId) => (helperId === 'h-meu' ? { delegatorPaneId: 'p1' } : { delegatorPaneId: 'outro' }),
    result: async () => ({ ok: true, helperId: 'h-meu', state: 'done', pending: false, waitedMs: 0, result: 'x', snapshot: { helperId: 'h-meu', cli: 'claude', model: 'opus', seatId: 's', state: 'done', startedAt: 0, elapsedMs: 0, hasResult: true } }),
    send: () => ({ ok: true }),
    cancel: () => ({ ok: true })
  }
  const api = buildGuiDelegationApi({
    engine,
    delegator: (paneId) =>
      paneId === 'p1'
        ? { paneId: 'p1', projectId: 'proj', cwd: '/w', cli: 'claude', model: 'opus', seatId: 'seat-1' }
        : undefined,
    beginBatch: (paneId) => calls.begin.push(paneId),
    endBatch: (paneId) => calls.end.push(paneId),
    seats: () => [],
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
