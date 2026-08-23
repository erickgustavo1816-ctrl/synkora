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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
// R14 (L3): o REGISTRO de identidade de verdade (nada de hub dublê — quem
// autentica o bearer do ajudante no servidor MCP é este) e a convenção de paneId
// de missão, que o endereço do ajudante não pode imitar.
import * as hubModule from '../.tmp/gui-delegation-wiring-test/hub.js'
import * as contracts from '../.tmp/gui-delegation-wiring-test/guiMissionContracts.js'
// O kit SÓ-LSP (módulo NOVO da R14) entra pela porta tolerante, no mesmo
// espírito do namespace acima e um passo além: import estático de arquivo
// AUSENTE derruba a suíte INTEIRA, e ela deixaria de discriminar. Sem o módulo,
// caem só os testes do kit.
const lspMcp = await import('../.tmp/gui-delegation-wiring-test/guiHelperLspMcp.js').catch(
  () => ({})
)
// O POTE DO DONO (módulo NOVO da R22) pela mesma porta tolerante: sem ele, caem
// só os testes da carona — e caem dizendo o que falta.
const ownerMailModule = await import('../.tmp/gui-delegation-wiring-test/guiOwnerMail.js').catch(
  () => ({})
)
// A DÍVIDA DE RESPOSTA (módulo NOVO da R32) pela mesma porta tolerante: sem
// ele, caem só os testes da cobrança — e caem dizendo o que falta.
const ownerReplyModule = await import(
  '../.tmp/gui-delegation-wiring-test/guiOwnerReplyDebt.js'
).catch(() => ({}))

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
  guiHelperWakeMessage,
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
  GUI_HELPER_LSP_PERSONA_LINE,
  GUI_HELPER_PERSONA,
  GUI_HELPER_RESULT_HEAD_CHARS,
  GuiHelperCatalogCache,
  armGuiHelperKit,
  buildGuiDelegationApi,
  claudeHelperArgs,
  claudeHelperSessionOptions,
  codexHelperArgs,
  codexHelperSessionOptions,
  codexHelperThreadId,
  createGuiHelperStore,
  discardGuiHelperDelivery,
  guiHelperDeliveryDocument,
  guiHelperDeliveryPath,
  guiHelperEventFor,
  guiHelperKitDisposer,
  guiHelperPersonaFor,
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

test('o helper codex nasce com a cerca DUPLA — e o kit dele nunca é o do DELEGADOR', () => {
  assert.deepEqual(codexHelperArgs(), ['-c', 'features.multi_agent=false'])
  const wiring = source('src/main/guiDelegationWiring.ts')
  assert.match(wiring, /suppressNativeAgents: true/u, 'falta o suspensório por thread')
  // R14 (L3): a cerca do D1 mudou de FORMA, não de tamanho. O ajudante passou a
  // receber um kit — e a metade que importa continua fechada: nenhum adaptador
  // monta o kit de DELEGAÇÃO nem pré-sanciona uma ferramenta de frota. Ele não
  // pode abrir ajudante nem que queira; até o catálogo do papel dele recusa.
  assert.doesNotMatch(
    wiring,
    /armGuiDelegateMcp|guiDelegateClaudeArgs|guiDelegateCodexArgs/u,
    'o adaptador do ajudante montou o kit do delegador — frota abrindo frota'
  )
  assert.doesNotMatch(wiring, /mcp__synkora__delegate/u, 'delegate pré-sancionado para o ajudante')
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
    cancel: () => ({ ok: true }),
    resume: (helperId) => overrides.resume?.(helperId) ?? { ok: true }
  }
  const overlap = overrides.duringResult
  const replyDebt =
    overrides.replyDebt ??
    (ownerReplyModule.GuiOwnerReplyDebt ? new ownerReplyModule.GuiOwnerReplyDebt() : undefined)
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
    // R22 — O POTE DO DONO entra pela MESMA porta do correio dos ajudantes: uma
    // instância por bancada, senão duas suítes do mesmo paneId dividiriam o pote
    // global do processo.
    ...(overrides.ownerMail ? { ownerMail: overrides.ownerMail } : {}),
    // R32 — dívida POR BANCADA, nunca o singleton: 'p1' é o paneId de todas as
    // bancadas desta suíte, e uma dívida armada num teste travaria o seguinte.
    ...(replyDebt ? { replyDebt } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
    now: () => 0
  })
  return { api, calls, replyDebt }
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
  // R10: o release COMPARTILHA o arm do delegador com papel próprio — continua
  // sendo um kit por chat (o papel do token decide o catálogo no servidor).
  assert.match(
    missions,
    /route\.missionType === 'planejamento'\s*\?\s*armGuiPlannerMcp\(mcpInput, guiPlannerMcpDeps\)\s*:\s*armGuiDelegateMcp\(/u,
    'um kit por chat, nunca os dois'
  )
  assert.match(
    missions,
    /route\.missionType === 'release' \? 'gui-release' : 'gui-delegator'/u,
    'o papel do token roteia o catálogo do release'
  )
  assert.match(missions, /delegateTools:/u, 'o diário tem de distinguir os dois kits')
})

test('a frota morre com o pane e PARA com o app — fechar nunca é descartar', () => {
  const ipc = source('src/main/ipc/gui.ts')
  assert.match(ipc, /extras\.helpers\?\.cancelPane\(paneId,/u, 'teardown do chat sem cancelar a frota')
  const index = source('src/main/index.ts')
  // R6.1, ordem do dono ("fechar o app e voltar os subagentes voltarem"): o
  // quit INTERROMPE. O processo headless do codex morre igual (ele nunca
  // encerra sozinho), mas o registro fica retomável no disco.
  assert.match(index, /guiHelperEngine\.interruptAll\(/u, 'o quit tem de matar os headless do codex')
  assert.equal(
    /guiHelperEngine\.cancelAll\(/u.test(index),
    false,
    'o quit voltou a DESCARTAR a frota do dono'
  )
  assert.match(index, /helpers: guiHelperEngine/u)
  assert.match(
    index,
    /guiSessionRegistry\.attachHelpers\(guiHelperEngine\)/u,
    'sem a aresta de volta o ■ do dono para só o turno'
  )
  assert.match(index, /delegateHelpers: \(id, helpers\)/u, 'as tools de delegação saíram do McpApi')
  assert.match(index, /helperResume: \(id, helperId\)/u, 'o verbo da retomada não chegou ao McpApi')
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
    // O ⚡ atravessa o respawn como os dois irmãos — e o próprio toggle de fast
    // do composer É um respawn: sem isto, ligar o fast da conversa apagaria o
    // pino da frota.
    assert.deepEqual(first.gui.setDelegationDefaults(devSpawn.paneId, { fast: true }), {
      ok: true,
      model: 'fable',
      effort: 'low',
      fast: true
    })
    assert.equal(first.gui.create({ ...devSpawn, permissionMode: 'bypass' }).ok, true)
    assert.equal(
      first.gui.delegationDefaults(devSpawn.paneId).fast,
      true,
      'o respawn não pode apagar o ⚡ que o dono carimbou'
    )
    // Limpar DEPOIS do respawn também funciona — e devolve o teste ao fio dos
    // dois irmãos, que segue abaixo exatamente como antes do ⚡.
    assert.deepEqual(first.gui.setDelegationDefaults(devSpawn.paneId, { fast: null }), {
      ok: true,
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
  assert.match(
    gui.setDelegationDefaults(devSpawn.paneId, {}).error ?? '',
    /modelo, o effort ou o fast/u
  )
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

// ————— R22.2: a FALA DO DONO pega a MESMA carona —————
//
// O print de 19/08: o delegador num laço de `helper_result` esperando três
// ajudantes; o dono manda mensagem com "enviar agora", a bolha VOCÊ aparece no
// fio — e o agente NÃO lê. Mensagem empurrada pro stdin no meio do turno fica na
// fila INTERNA do CLI até o turno fechar, e pós-R19 isso é potencialmente horas.
// O único canal que alcança o modelo DENTRO do turno é o resultado de tool — o
// mesmo em que o correio dos ajudantes já anda desde 18/08.

/** O pote do dono desta bancada. Sem o módulo, a falha nomeia o que falta. */
function ownerMailbox() {
  assert.ok(
    ownerMailModule.GuiOwnerMailbox,
    'o módulo do pote do dono (guiOwnerMail) não existe — sem ele a fala do dono não tem onde esperar (R22.1)'
  )
  return new ownerMailModule.GuiOwnerMailbox()
}

test('R22.2 — a mensagem do dono viaja no PRÓXIMO resultado de tool, uma vez só', async () => {
  const ownerMail = ownerMailbox()
  const logged = []
  const { api, replyDebt } = delegationApi({ ownerMail, log: (entry) => logged.push(entry) })
  ownerMail.post('p1', { messageId: 'msg-7', text: 'para tudo: o schema mudou', at: 0 })

  // O CENTRO DO PRINT: o delegador está dentro do turno, num `helper_result`, e
  // é ESSA resposta que carrega a fala do dono até o modelo.
  const text = await api.helperResult(delegatorId, 'h-meu', 45)
  assert.ok(
    text.includes(ownerMailModule.GUI_OWNER_MAIL_TAG),
    'a fala do dono não viajou no resultado da tool — o agente segue cego dentro do turno'
  )
  assert.match(text, /para tudo: o schema mudou/u, 'a mensagem não chegou verbatim')
  assert.match(text, /no meio do turno/u, 'o agente precisa saber que isto não é turno novo')
  assert.match(text, /AJUSTE O RUMO AGORA/u, 'sem o movimento, ele guarda a ordem para depois')
  // O SILÊNCIO ATÉ O FIM DA ESPERA (caso do dono, 2026-08-21): a caixa-preta
  // provou entrega em 0-25s, e o dono via o agente "parado" mesmo assim — o
  // modelo lia, ajustava e voltava a esperar SEM FALAR, e "responda na próxima
  // fala" só acontecia quando o ajudante acabava. O bloco agora exige a fala
  // ANTES de qualquer outra tool: pro dono, agente mudo = mensagem perdida.
  assert.match(
    text,
    /FALE COM ELE JÁ/u,
    'o bloco tem de exigir fala imediata — não "na próxima fala", que pode demorar minutos'
  )
  assert.match(
    text,
    /antes de qualquer outra tool/u,
    'a ordem nomeia o momento: falar vem ANTES de voltar a esperar'
  )

  // Drenar É a entrega, e a entrega tem RECIBO na caixa-preta.
  assert.equal(ownerMail.count('p1'), 0, 'a fala tem de sair do pote ao ser entregue')
  const receipt = logged.find((entry) => entry.event === 'owner-mail-ride')
  assert.ok(receipt, 'a carona não deixou recibo')
  assert.equal(receipt.paneId, 'p1')
  assert.equal(receipt.detail.messages, 1)
  assert.ok(receipt.detail.chars > 0, 'o recibo tem de dizer o tamanho que viajou')

  // Entregue uma vez, morre: repetir faria o agente achar que o dono falou de
  // novo. A dívida (R32) quita antes, como o pump quitaria — este teste mede o
  // POTE, e sem a quitação a recusa mascararia um pote que repete.
  replyDebt?.clear('p1')
  assert.equal(
    api.helpersStatus(delegatorId).includes(ownerMailModule.GUI_OWNER_MAIL_TAG),
    false,
    'a mesma fala não pode viajar duas vezes'
  )
})

test('R22.2 — a carona vale em TODA tool da delegação, e o dono vem por ÚLTIMO', async () => {
  const ownerMail = ownerMailbox()
  const inbox = new GuiHelperInbox()
  const { api, replyDebt } = delegationApi({ ownerMail, inbox, liveCount: 2 })

  ownerMail.post('p1', { messageId: 'm-1', text: 'inverte a ordem das fatias', at: 0 })
  const status = api.helpersStatus(delegatorId)
  assert.ok(status.includes(ownerMailModule.GUI_OWNER_MAIL_TAG))

  // Entre um verbo e outro o agente FALA (R32 cobraria o mudo): a quitação
  // aqui é o pump fazendo o papel dele, e o que este teste mede é a CARONA.
  replyDebt?.clear('p1')
  ownerMail.post('p1', { messageId: 'm-2', text: 'e usa a conta do hotmail', at: 0 })
  assert.ok(
    (await api.listSeats(delegatorId)).includes(ownerMailModule.GUI_OWNER_MAIL_TAG),
    'list_seats também é resultado de tool'
  )

  replyDebt?.clear('p1')
  ownerMail.post('p1', { messageId: 'm-3', text: 'segura o resto', at: 0 })
  assert.ok(api.helperSend(delegatorId, 'h-meu', 'oi').includes(ownerMailModule.GUI_OWNER_MAIL_TAG))

  // NOVIDADE DOS AJUDANTES + FALA DO DONO na mesma resposta: relatório primeiro,
  // ORDEM por último — é a última coisa que o modelo lê antes de decidir.
  replyDebt?.clear('p1')
  ownerMail.post('p1', { messageId: 'm-4', text: 'cancela o terceiro', at: 0 })
  inbox.post('p1', {
    helperId: 'h-9',
    model: 'opus',
    ok: true,
    resultPath: '.synkora/helpers/h-9.md'
  })
  const both = await api.delegateHelpers(delegatorId, [{ prompt: 'x' }])
  assert.ok(both.includes(GUI_HELPER_INBOX_TAG), 'o correio dos ajudantes sumiu')
  assert.ok(both.includes(ownerMailModule.GUI_OWNER_MAIL_TAG))
  assert.ok(
    both.indexOf(ownerMailModule.GUI_OWNER_MAIL_TAG) > both.indexOf(GUI_HELPER_INBOX_TAG),
    'a fala do dono tem de vir DEPOIS do relatório da frota'
  )
})

test('R22.2 — o pote do dono é POR PANE: um chat nunca lê a fala mandada ao outro', () => {
  const ownerMail = ownerMailbox()
  const { api } = delegationApi({ ownerMail })
  ownerMail.post('p2', { messageId: 'm-alheia', text: 'isto é do outro chat', at: 0 })
  assert.equal(api.helpersStatus(delegatorId).includes(ownerMailModule.GUI_OWNER_MAIL_TAG), false)
  assert.equal(ownerMail.count('p2'), 1, 'a fala do outro pane continua lá, intocada')
})

// ————— R32: a DÍVIDA DE RESPOSTA — mudo não anda —————
//
// O transcript de 23/08: a carona entregou "O que vc ta fazendo ai?" com "FALE
// COM ELE JÁ" no mesmo segundo (caixa-preta 15:54:16), o pane JÁ tinha a
// persona R31 no contrato — e o modelo chamou helper_result de novo, mudo,
// duas vezes. Persona é pedido; esta é a cobrança MECÂNICA: entregar arma a
// dívida, e nenhum verbo da delegação anda até o agente falar com o dono.

test('R32 — depois da carona, TODO verbo recusa até o agente falar com o dono', async () => {
  assert.ok(
    ownerReplyModule.GuiOwnerReplyDebt,
    'o módulo da dívida (guiOwnerReplyDebt) não existe — sem ele o mudo continua andando (R32)'
  )
  const ownerMail = ownerMailbox()
  const logged = []
  const { api, calls, replyDebt } = delegationApi({ ownerMail, log: (entry) => logged.push(entry) })
  ownerMail.post('p1', { messageId: 'm-1', text: 'O que vc ta fazendo ai?', at: 0 })
  // A carona entrega — e ARMA.
  await api.helperResult(delegatorId, 'h-meu', 45)
  // O caso real: voltar ao long-poll sem falar. Agora a casa recusa.
  const refused = await api.helperResult(delegatorId, 'h-meu', 45)
  assert.match(refused, /PARE: o DONO falou/u, 'o verbo andou com o dono sem resposta')
  assert.match(refused, /O que vc ta fazendo ai\?/u, 'a recusa re-cita a fala pendente')
  assert.match(refused, /uma ou duas linhas/u, 'a recusa nomeia a receita')
  assert.match(refused, /chame a tool de novo/u, 'a recusa nomeia a saída — beco sem saída é bug')
  // Os SETE verbos ficam atrás do mesmo portão, e a recusa não executa nada.
  assert.match(await api.delegateHelpers(delegatorId, [{ prompt: 'x' }]), /PARE: o DONO falou/u)
  assert.equal(calls.begin.length, 0, 'a recusa não pode abrir lote nenhum')
  assert.match(api.helperSend(delegatorId, 'h-meu', 'oi'), /PARE: o DONO falou/u)
  assert.match(api.helperCancel(delegatorId, 'h-meu'), /PARE: o DONO falou/u)
  assert.match(api.helpersStatus(delegatorId), /PARE: o DONO falou/u)
  const enforced = logged.filter((entry) => entry.event === 'owner-reply-enforced')
  assert.ok(enforced.length >= 5, 'cada cobrança deixa carimbo na caixa-preta')
  assert.equal(enforced[0].paneId, 'p1')
  // O agente FALOU (no app, o pump do guiSessions quita no evento de texto):
  // tudo volta a andar, sem resíduo.
  replyDebt.clear('p1')
  assert.match(await api.helperResult(delegatorId, 'h-meu', 45), /entrega do ajudante/u)
})

test('R32 — o pump do guiSessions QUITA: texto do agente ou fecho de turno paga a dívida', () => {
  const source = readFileSync(new URL('../src/main/guiSessions.ts', import.meta.url), 'utf8')
  assert.match(
    source,
    /visibleEvt\.type === 'text' && visibleEvt\.text\.trim\(\)\.length > 0/u,
    'o pump não quita no texto do agente — a recusa viraria beco'
  )
  assert.match(
    source,
    /this\.replyDebt\.clear\(spawn\.paneId\)/u,
    'a quitação não passa pela dívida compartilhada'
  )
})

test('R32 — o recibo do delegate manda avisar o dono do porquê da frota', async () => {
  const { api } = delegationApi()
  const receipt = await api.delegateHelpers(delegatorId, [{ prompt: 'x' }])
  assert.match(
    receipt,
    /AVISE O DONO no chat/u,
    'o recibo não empurra a fala — o dono vê os cards, nunca o plano ("abriu dois e não falou por quê")'
  )
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

// ————— 12. R6-B: OS DOIS VERBOS (retomar × descartar) —————
//
// R6.2 do design vinculante. A parada preservadora da onda A só fecha o ciclo
// com uma VOLTA; e o descarte, que antes era "encerra a sessão", passa a ser o
// verbo que joga fora de verdade — inclusive o arquivo da entrega.

test('helper_resume: a tool existe, chega ao motor e o texto ensina o par de verbos', async () => {
  const calls = []
  const { api } = delegationApi({
    resume: (helperId) => {
      calls.push(helperId)
      return { ok: true }
    }
  })
  const text = await api.helperResume(delegatorId, 'h-meu')
  assert.deepEqual(calls, ['h-meu'])
  assert.match(text, /retomad/iu)
  assert.match(text, /h-meu/u)
  assert.match(text, /helpers_status|helper_result/u, 'a resposta diz como acompanhar a volta')

  // Escopo por pane: o id opaco de outro chat não é autorização, aqui como nas
  // outras cinco.
  assert.match(api.helperResume(delegatorId, 'h-alheio'), /não é deste chat/u)
  assert.match(
    api.helperResume({ ...delegatorId, role: 'gui-planner' }, 'h-meu'),
    /não delega/u
  )
})

test('resume recusado devolve o motivo do MOTOR, sem inventar sucesso', async () => {
  const { api } = delegationApi({
    resume: () => ({ ok: false, error: 'o ajudante está trabalhando — dirija com helper_send' })
  })
  const text = await api.helperResume(delegatorId, 'h-meu')
  assert.match(text, /helper_send/u)
  assert.ok(!/retomado/iu.test(text), 'a recusa não pode soar como retomada')
})

test('helper_cancel DESCARTA: o arquivo canônico some do worktree', () => {
  const cwd = tmpWorktree()
  const record = deliveredRecord(cwd, { helperId: 'h-descartado', state: 'interrupted' })
  const written = writeGuiHelperDelivery({ record, text: 'metade do trabalho' })
  assert.equal(written.ok, true)
  const file = join(cwd, ...written.path.split('/'))
  assert.equal(readFileSync(file, 'utf8').includes('metade do trabalho'), true)

  discardGuiHelperDelivery({ ...record, resultPath: written.path })
  assert.equal(existsSync(file), false, 'descartar deixou a entrega no disco do dono')

  // Descartar de novo (ou sem arquivo nenhum) NUNCA é erro: o motor não pode
  // depender de disco para encerrar um registro.
  discardGuiHelperDelivery({ ...record, resultPath: written.path })
  discardGuiHelperDelivery({ ...record, resultPath: undefined })
  discardGuiHelperDelivery({ ...record, cwd: '' })
})

test('o descarte nunca escapa da pasta de ajudantes do worktree', () => {
  const cwd = tmpWorktree()
  const vitima = join(cwd, 'importante.md')
  writeFileSync(vitima, 'o trabalho do dono', 'utf8')
  discardGuiHelperDelivery(
    deliveredRecord(cwd, { helperId: '../../importante', resultPath: '../../importante.md' })
  )
  assert.equal(existsSync(vitima), true, 'um id hostil apagou arquivo fora da pasta de entregas')
})

test('o motor de produção nasce com o DESCARTE ligado, não só com a entrega', () => {
  const wiringSource = source('src/main/guiDelegationWiring.ts')
  assert.match(wiringSource, /discardDelivery:\s*\(record\)\s*=>\s*discardGuiHelperDelivery\(record\)/u)
})

test('o card do interrompido carrega o desfecho `interrupted` — o contrato da lateral', () => {
  // A lateral já lê `result.status === 'cancelled'`; `interrupted` é o irmão
  // novo. Fechar um interrompido como 'completed' (o que a onda A fazia) diria
  // ao dono que o trabalho terminou bem.
  const evt = guiHelperSettledEvent(
    helperRecord({
      state: 'interrupted',
      failure: 'o app fechou com o ajudante trabalhando',
      result: 'metade do caminho',
      resultPath: '.synkora/helpers/h-1.md'
    })
  )
  assert.equal(evt.outcome, 'interrupted')
  assert.equal(evt.isError, false, 'interromper não é falhar')
  assert.equal(evt.agentStatus, 'settled')
  assert.match(evt.text, /\.synkora\/helpers\/h-1\.md/u, 'o parcial dele tem endereço')

  const descartado = guiHelperSettledEvent(helperRecord({ state: 'cancelled', failure: 'descartado' }))
  assert.equal(descartado.outcome, 'cancelled')
  const feito = guiHelperSettledEvent(helperRecord({ state: 'done', result: 'entrega' }))
  assert.equal(feito.outcome, 'completed')
})

test('helper_result de um interrompido nomeia os DOIS verbos', () => {
  const text = guiHelperResultText({
    ok: true,
    helperId: 'h-1',
    state: 'interrupted',
    pending: false,
    waitedMs: 0,
    failure: 'o app fechou com o ajudante trabalhando',
    resultPath: '.synkora/helpers/h-1.md',
    snapshot: {
      helperId: 'h-1',
      cli: 'claude',
      model: 'opus',
      seatId: 's',
      state: 'interrupted',
      startedAt: 0,
      elapsedMs: 1_000,
      hasResult: true
    }
  })
  assert.match(text, /INTERROMPIDO/u)
  assert.match(text, /helper_resume/u)
  assert.match(text, /helper_cancel/u)
  assert.match(text, /\.synkora\/helpers\/h-1\.md/u)
})

test('a ficha do interrompido ensina o par de verbos uma vez só', () => {
  const status = guiHelperStatusText([
    {
      helperId: 'h-1',
      cli: 'claude',
      model: 'opus[1m]',
      seatId: 'seat-1',
      state: 'interrupted',
      startedAt: 0,
      elapsedMs: 12 * 60_000,
      hasResult: true,
      resultPath: '.synkora/helpers/h-1.md',
      failure: 'o app fechou com o ajudante trabalhando'
    },
    {
      helperId: 'h-2',
      cli: 'claude',
      model: 'opus[1m]',
      seatId: 'seat-1',
      state: 'interrupted',
      startedAt: 0,
      elapsedMs: 60_000,
      hasResult: false
    }
  ])
  assert.match(status, /interrompido/u)
  assert.match(status, /helper_resume/u)
  assert.match(status, /helper_cancel/u)
  assert.equal(status.match(/helper_resume/gu).length, 1, 'a receita se repetiu por ajudante')
})

test('a ficha do retomado diz que ele está na segunda vida', () => {
  const status = guiHelperStatusText([
    {
      helperId: 'h-1',
      cli: 'claude',
      model: 'opus[1m]',
      seatId: 'seat-1',
      state: 'working',
      startedAt: 0,
      elapsedMs: 5_000,
      hasResult: false,
      resumedAt: 1_000
    }
  ])
  assert.match(status, /retomado/iu)
})

test('o aviso de boot nomeia os interrompidos, o tempo parado e os dois verbos', () => {
  const text = guiHelperWakeMessage(
    [
      {
        helperId: 'h-1',
        name: 'busca',
        model: 'opus[1m]',
        ok: false,
        interrupted: true,
        elapsedMs: 12 * 60_000,
        resultPath: '.synkora/helpers/h-1.md'
      },
      { helperId: 'h-2', model: 'fable', ok: false, interrupted: true, elapsedMs: 30_000 }
    ],
    0
  )
  assert.ok(text.startsWith('[synkora]'))
  assert.match(text, /interrompid/iu)
  assert.match(text, /helper_resume/u)
  assert.match(text, /helper_cancel/u)
  assert.ok(text.includes('h-1') && text.includes('h-2'))
  assert.ok(text.includes('busca'))
  assert.match(text, /12min/u, 'quanto ele trabalhou antes de parar')
  assert.ok(!/concluíd/iu.test(text), 'nada de dizer que um interrompido concluiu')
  assert.ok(text.length < 900, `o aviso continua curto (${text.length} chars)`)
})

test('o correio mistura honestamente quem terminou e quem ficou parado', () => {
  const bloco = guiHelperInboxBlock(
    [
      { helperId: 'h-1', model: 'opus', ok: true, resultPath: '.synkora/helpers/h-1.md' },
      { helperId: 'h-2', model: 'opus', ok: false, interrupted: true, elapsedMs: 60_000 }
    ],
    { stillWorking: 1 }
  )
  assert.match(bloco, /1 concluído/u)
  assert.match(bloco, /1 interrompido/u, 'o placar não pode contar parado como falha')
  assert.match(bloco, /helper_resume/u)
})

// ————— R11: FAST do ajudante — pinado no nascimento, nunca herdado —————

test('fast explícito viaja do pedido ao processo — e ausente NUNCA se herda', () => {
  const [comFast, semFast] = planGuiHelperRequests(
    [
      { prompt: 'a', fast: true },
      { prompt: 'b' }
    ],
    undefined
  )
  assert.equal(comFast.request.fast, true)
  assert.equal(semFast.request.fast, undefined, 'fast acidental é caro (prompt-cache) — ausente = off')

  const base = {
    helperId: 'h-f',
    projectId: 'p',
    delegatorPaneId: 'gui-dev-1',
    cwd: 'C:/w',
    model: 'opus[1m]',
    seat: { seatId: 's1', configDir: 'C:/cfg' },
    prompt: 'trabalhe'
  }
  // claude: opt-in de spawn; codex: service tier — AMBOS só com o pedido.
  assert.equal(claudeHelperSessionOptions({ ...base, cli: 'claude', fast: true }).fastMode, true)
  assert.equal(claudeHelperSessionOptions({ ...base, cli: 'claude' }).fastMode, undefined)
  assert.equal(
    codexHelperSessionOptions({ ...base, cli: 'codex', fast: true }).serviceTier,
    'priority'
  )
  assert.equal(codexHelperSessionOptions({ ...base, cli: 'codex' }).serviceTier, undefined)
})

// ————— R12: o ⚡ VEM DO PAINEL (a queixa 2 do dono revoga "nunca do painel") —————
//
// Ordem de 19/08: "o fast não tá aparecendo quando eu tô escolhendo o padrão dos
// ajudantes… pra eu chamar sempre ajudantes no fast". O que a R11 dizia — fast
// só explícito na tool — vale para a HERANÇA (o ⚡ da conversa continua sem
// atravessar), nunca para o carimbo do dono.

test('R12 — o pino do fast carimba, limpa por `null` E por `false`, e volta do disco', () => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-fast-pin-'))
  try {
    const storeFile = join(root, 'gui-sessions.json')
    const first = registryWith(storeFile)
    assert.equal(first.gui.create(devSpawn).ok, true)
    assert.deepEqual(
      first.gui.setDelegationDefaults(devSpawn.paneId, { model: 'fable', effort: 'low' }),
      { ok: true, model: 'fable', effort: 'low' }
    )
    // Um patch SÓ de fast é escolha inteira: recusá-lo como vazio deixaria o
    // chip do painel sem efeito nenhum.
    assert.deepEqual(first.gui.setDelegationDefaults(devSpawn.paneId, { fast: true }), {
      ok: true,
      model: 'fable',
      effort: 'low',
      fast: true
    })

    const second = registryWith(storeFile)
    assert.deepEqual(second.gui.delegationDefaults(devSpawn.paneId), {
      model: 'fable',
      effort: 'low',
      fast: true
    })
    // Desligar é `false` (o chip "desligado") tanto quanto `null` (o "limpar"),
    // e nenhum dos dois encosta no modelo ou no effort.
    assert.deepEqual(second.gui.setDelegationDefaults(devSpawn.paneId, { fast: false }), {
      ok: true,
      model: 'fable',
      effort: 'low'
    })
    assert.deepEqual(second.gui.setDelegationDefaults(devSpawn.paneId, { fast: true }), {
      ok: true,
      model: 'fable',
      effort: 'low',
      fast: true
    })
    assert.deepEqual(second.gui.setDelegationDefaults(devSpawn.paneId, { fast: null }), {
      ok: true,
      model: 'fable',
      effort: 'low'
    })

    // O que não é boolean nem `null` é RECUSADO — e recusa não grava metade.
    assert.equal(second.gui.setDelegationDefaults(devSpawn.paneId, { fast: 'sim' }).ok, false)
    assert.match(
      second.gui.setDelegationDefaults(devSpawn.paneId, { fast: 1 }).error ?? '',
      /fast/u
    )
    assert.deepEqual(second.gui.delegationDefaults(devSpawn.paneId), {
      model: 'fable',
      effort: 'low'
    })
    // O patch vazio nomeia as TRÊS escolhas: recusa que esconde a receita é bug.
    assert.match(
      second.gui.setDelegationDefaults(devSpawn.paneId, {}).error ?? '',
      /modelo, o effort ou o fast/u
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('R12 — documento sujo não liga o ⚡ da frota inteira', () => {
  const record = (patch) => ({ cli: 'claude', projectId: 'p', updatedAt: 'x', ...patch })
  assert.deepEqual(guiDelegationDefaultsOf(record({ delegateFast: true })), { fast: true })
  assert.deepEqual(guiDelegationDefaultsOf(record({ delegateFast: false })), {})
  for (const sujo of ['sim', 'true', 1, {}, []]) {
    assert.deepEqual(
      guiDelegationDefaultsOf(record({ delegateFast: sujo })),
      {},
      `${JSON.stringify(sujo)} não pode virar um modo que gasta mais limite`
    )
  }
  // E o pino do fast convive com os irmãos sem contaminá-los.
  assert.deepEqual(
    guiDelegationDefaultsOf(record({ delegateModel: ' fable ', delegateFast: true })),
    { model: 'fable', fast: true }
  )
})

test('R12 — a cadeia do fast: explícito vence, depois o painel, senão desligado', () => {
  const [calado, negado, ligado] = planGuiHelperRequests(
    [
      { prompt: 'a' },
      { prompt: 'b', fast: false },
      { prompt: 'c', fast: true }
    ],
    { model: 'fable', fast: true }
  )
  assert.equal(calado.request.fast, true, 'pedido sem fast abre no padrão carimbado pelo dono')
  assert.equal(calado.origins.fast, 'painel')
  assert.equal(calado.request.model, 'fable', 'o fast não atrapalha a cadeia do modelo')
  assert.equal(calado.origins.model, 'painel')
  assert.equal(negado.request.fast, undefined, 'o `false` do agente desliga mesmo com o pino')
  assert.equal(negado.origins.fast, 'explicito', 'quem falou foi o agente — e isso se conta')
  assert.equal(ligado.request.fast, true)
  assert.equal(ligado.origins.fast, 'explicito')

  // Sem carimbo: só o pedido liga, e o silêncio continua DESLIGADO (a lição do
  // prompt-cache que a R11 pagou continua inteira).
  const semPino = planGuiHelperRequests(
    [{ prompt: 'a' }, { prompt: 'b', fast: true }, { prompt: 'c', fast: 'sim' }],
    { model: 'fable' }
  )
  assert.equal(semPino[0].request.fast, undefined)
  assert.equal(semPino[0].origins.fast, 'desligado')
  assert.equal(semPino[1].origins.fast, 'explicito')
  // Só boolean é palavra do agente: o resto devolve a decisão ao pino.
  assert.equal(semPino[2].request.fast, undefined)
  assert.equal(semPino[2].origins.fast, 'desligado')
})

test('R12 — o card do ajudante fast leva o ⚡ para a lateral', () => {
  assert.equal(
    guiHelperCardInput(helperRecord()).fast,
    undefined,
    'ajudante normal não ganha o campo (a ficha mostraria um ⚡ mentiroso)'
  )
  assert.equal(guiHelperCardInput(helperRecord({ fast: true })).fast, true)
  // O recibo de abertura já carimbava desde a R11 — os dois falam o mesmo.
  assert.match(cards.guiHelperLaunchReceipt(helperRecord({ fast: true })), /⚡ fast/u)
})

test('R12 — o schema do delegate conta a verdade nova do fast', () => {
  const mcp = source('src/main/mcpServer.ts')
  const bloco = mcp.slice(mcp.indexOf('fast: z'), mcp.indexOf('seat: z'))
  assert.ok(bloco.length > 200, 'o campo `fast` do delegate sumiu do schema')
  assert.match(bloco, /GASTA MAIS LIMITE/u, 'o preço tem de ser dito em voz alta')
  assert.match(bloco, /painel/u, 'o agente precisa saber que o ausente cai no painel do dono')
  assert.match(bloco, /`false`/u, 'sem isso o agente não sabe como desligar por cima do pino')
  assert.doesNotMatch(
    bloco,
    /ausente = desligado/u,
    'a frase da R11 virou mentira quando o painel passou a carimbar'
  )
})

// ————— R14 (L3): O KIT SÓ-LSP DO AJUDANTE —————
//
// Ordem do dono (19/08): "voltar com o LSP, tanto para agente quanto para
// sub-agente". O ajudante deixou de nascer mudo — e a cerca do D1 NÃO afrouxou:
// o `GuiHelperSpawnRequest` continua sem campo de ferramenta, o kit é DERIVADO
// do registro dentro do adaptador, e o bearer de cada ajudante morre com o
// processo dele.
//
// O que estes testes NÃO fazem: subir CLI. Os adaptadores reais instanciam
// MaestroSession/CodexSession, então o ciclo de vida do bearer é provado nas
// DUAS funções que eles usam (`armGuiHelperKit` e `guiHelperKitDisposer`),
// plugadas no MOTOR de verdade — é ele quem funila os desfechos no `dispose`.

/** Bancada do kit: hub REAL (é ele que autentica o bearer no servidor MCP),
 *  userData/mcp num diretório temporário e o diário como coletor. */
function lspBench(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'synkora-helper-mcp-'))
  const hub = new hubModule.Hub({
    projectPathOf: () => undefined,
    ensureProjectRuntimeWritable: () => undefined,
    onEvent: () => undefined
  })
  const journal = []
  const deps = {
    systemPromptFile: () => undefined,
    lsp: {
      hub,
      port: () => (options.port === undefined ? 41234 : options.port),
      configRoot: () => dir
    },
    journalLsp: (entry) => journal.push(entry)
  }
  return { dir, hub, deps, journal }
}

/** O pedido como o MOTOR o monta (nenhum campo aqui vem do chamador da tool). */
function spawnRequest(patch = {}) {
  return {
    helperId: 'h-1',
    projectId: 'proj-9',
    delegatorPaneId: 'gui-dev-abc12345',
    cwd: 'C:/work/mission',
    cli: 'claude',
    model: 'opus[1m]',
    seat: { seatId: 'seat-1', configDir: 'C:/cfg/claude', name: 'Claude A' },
    prompt: 'ache o erro exato',
    ...patch
  }
}

/** O delegador que abre a frota nos testes de ciclo de vida. */
const lspDelegator = {
  paneId: 'gui-dev-abc12345',
  projectId: 'proj-9',
  cwd: 'C:/work/mission',
  cli: 'claude',
  model: 'opus[1m]',
  seatId: 'seat-1'
}

test('R14 — o ajudante claude nasce com o kit SÓ-LSP derivado do REGISTRO dele', () => {
  const { hub, deps, journal } = lspBench({ port: 41234 })
  const request = spawnRequest()
  const kit = armGuiHelperKit(deps, request)
  assert.ok(kit, 'o kit não foi armado')

  // 1. A IDENTIDADE: papel do ajudante, raiz = o worktree DELE, delegador junto.
  const identity = hub.identityByToken(kit.token)
  assert.ok(identity, 'o bearer não autentica em lugar nenhum')
  assert.equal(identity.role, 'ajudante', 'o papel é o que decide o catálogo do servidor')
  assert.equal(identity.cwd, request.cwd, 'a raiz do LSP é o worktree do ajudante')
  assert.equal(identity.projectId, 'proj-9')
  assert.equal(identity.delegatorPaneId, request.delegatorPaneId)
  assert.equal(identity.seatId, 'seat-1')
  assert.equal(identity.paneId, lspMcp.guiHelperMcpPaneId('h-1'))
  assert.notEqual(
    identity.paneId,
    request.delegatorPaneId,
    'revogar o ajudante desarmaria o chat que o abriu'
  )

  // 2. AS FLAGS: config por arquivo, strict, e as QUATRO tools pré-sancionadas.
  assert.deepEqual(kit.args.slice(0, 3), ['--mcp-config', kit.mcpFile, '--strict-mcp-config'])
  const allowed = kit.args[kit.args.indexOf('--allowedTools') + 1].split(',')
  assert.deepEqual(allowed, [...lspMcp.GUI_HELPER_LSP_CLAUDE_ALLOWED_TOOLS])
  for (const tool of lspMcp.GUI_HELPER_LSP_TOOLS) {
    assert.ok(allowed.includes(`mcp__synkora__${tool}`), `${tool} fora da pré-sanção`)
  }
  assert.equal(
    allowed.some((name) => /delegate|helper_|plan|integration|release/u.test(name)),
    false,
    'frota que abre frota: o kit do ajudante vazou verbo de delegador'
  )

  // 3. O ARQUIVO que o claude lê no boot: porta certa e o bearer DESTE ajudante.
  const config = JSON.parse(readFileSync(kit.mcpFile, 'utf8'))
  assert.equal(config.mcpServers.synkora.url, 'http://127.0.0.1:41234/mcp')
  assert.equal(config.mcpServers.synkora.headers.Authorization, `Bearer ${kit.token}`)

  // 4. AS OPÇÕES DO SPAWN: a cerca primeiro, o kit depois, e nada de env.
  const opts = claudeHelperSessionOptions(request, 'C:/prompts/h-1.system.md', kit)
  assert.deepEqual(opts.extraArgs.slice(0, 2), claudeHelperArgs(), 'a cerca anti-nativo saiu')
  assert.deepEqual(opts.extraArgs.slice(2), kit.args)
  assert.equal('extraEnv' in opts, false, 'no claude o bearer mora no ARQUIVO, nunca no env')

  // 5. O DIÁRIO com os dois ids de correlação e a raiz.
  assert.deepEqual(journal.map((entry) => entry.event), ['helper-lsp-armed'])
  assert.equal(journal[0].paneId, request.delegatorPaneId)
  assert.equal(journal[0].helperId, 'h-1')
  assert.equal(journal[0].detail.root, request.cwd)
})

test('R14 — o ajudante codex recebe o mesmo servidor pelo `-c`, com o bearer no env', () => {
  const { hub, deps } = lspBench({ port: 5555 })
  const request = spawnRequest({
    helperId: 'h-2',
    cli: 'codex',
    model: 'gpt-5.6-sol',
    seat: { seatId: 'seat-codex', configDir: 'C:/cfg/codex' }
  })
  const kit = armGuiHelperKit(deps, request)
  assert.ok(kit)
  assert.equal(kit.mcpFile, undefined, 'o codex não escreve config em disco')
  assert.ok(kit.args.includes('mcp_servers.synkora.url=http://127.0.0.1:5555/mcp'))
  assert.ok(kit.args.includes('mcp_servers.synkora.bearer_token_env_var=SYNKORA_TOKEN'))
  // Valores CRUS: o `-c` viaja por `spawn(..., { shell: true })`, que não escapa
  // nada — uma aspa aqui é comida pelo cmd.exe e o app-server trava no init.
  for (const arg of kit.args) assert.equal(/["']/u.test(arg), false, arg)
  assert.deepEqual(kit.env, { SYNKORA_TOKEN: kit.token })
  assert.equal(hub.identityByToken(kit.token).role, 'ajudante')

  const opts = codexHelperSessionOptions(request, kit)
  assert.deepEqual(opts.extraArgs.slice(0, 2), codexHelperArgs(), 'o cinto do app-server saiu')
  assert.deepEqual(opts.extraArgs.slice(2), kit.args)
  assert.deepEqual(opts.extraEnv, { SYNKORA_TOKEN: kit.token })
  assert.equal(opts.suppressNativeAgents, true, 'o kit comeu o suspensório da cerca')
})

test('R14 — o kit vem do REGISTRO: o pedido de spawn continua sem campo de ferramenta', () => {
  // A CERCA É ESTRUTURAL, e é isto que a mantém verdadeira depois da R14: por
  // mais que o ajudante tenha ganhado tools, não existe argumento por onde o
  // chamador do `delegate` peça uma.
  const engineSrc = source('src/main/guiHelperSessions.ts')
  const start = engineSrc.indexOf('export interface GuiHelperSpawnRequest')
  assert.ok(start > 0, 'o pedido de spawn mudou de casa')
  const bloco = engineSrc.slice(start, engineSrc.indexOf('\n}', start))
  for (const proibido of ['mcp', 'mcpConfig', 'extraArgs', 'extraEnv', 'allowedTools', 'tools', 'token']) {
    assert.doesNotMatch(
      bloco,
      new RegExp(`^\\s*${proibido}\\??:`, 'mu'),
      `o pedido de spawn ganhou o campo ${proibido} — a cadeia reabriu`
    )
  }

  const wiringSrc = source('src/main/guiDelegationWiring.ts')
  const arm = wiringSrc.slice(
    wiringSrc.indexOf('export function armGuiHelperKit'),
    wiringSrc.indexOf('/** Revoga UMA vez')
  )
  for (const campo of ['helperId', 'projectId', 'delegatorPaneId', 'cwd', 'cli']) {
    assert.match(
      arm,
      new RegExp(`${campo}: request\\.${campo}`, 'u'),
      `${campo} do kit deixou de sair do registro do ajudante`
    )
  }

  // A ORDEM NO FIO: o kit é armado ANTES de o processo nascer (as flags entram
  // no argv, que é lido na partida) e o briefing sai DEPOIS.
  const claudeAdapter = wiringSrc.slice(
    wiringSrc.indexOf('export function createClaudeHelperAdapter'),
    wiringSrc.indexOf('export function createCodexHelperAdapter')
  )
  assert.ok(
    claudeAdapter.indexOf('armGuiHelperKit') < claudeAdapter.indexOf('new MaestroSession'),
    'o kit chegou depois do processo — as flags nunca entrariam no argv'
  )
  assert.ok(
    claudeAdapter.indexOf('new MaestroSession') < claudeAdapter.indexOf('session.send'),
    'o briefing saiu antes de o processo existir'
  )
  // A ARMADILHA DO CLAUDE.md ("o catálogo de tools é montado POR REQUEST e o
  // prompt de argv sai ANTES do handshake MCP") não morde aqui, e a razão é
  // estrutural: o ajudante recebe o briefing por STDIN em stream-json, não no
  // argv. No dia em que este spawn voltar a carregar prompt na linha de comando,
  // o primeiro turno nasceria sem tools — e este assert cai antes do dono ver.
  const maestro = source('src/main/maestroSession.ts')
  assert.match(
    maestro,
    /'-p',\s*\n\s*'--input-format',\s*\n\s*'stream-json'/u,
    'o claude deixou de receber o prompt por stdin: o kit MCP perderia o 1º turno'
  )
})

test('R14 — o endereço do ajudante no hub não se confunde com pane nenhum', () => {
  const paneId = lspMcp.guiHelperMcpPaneId('9f2c1d0e-uuid')
  assert.equal(/[:/\\]/u.test(paneId), false, 'o id vira NOME DE ARQUIVO da config do claude')
  assert.equal(
    contracts.guiMissionRoleOf(paneId),
    undefined,
    'o endereço do ajudante passou por pane de missão — o prefixo gui- é reservado'
  )
  assert.equal(paneId.startsWith(GUI_HELPER_CARD_PREFIX), false, 'colidiu com o id do CARD')

  // Dois ajudantes NUNCA compartilham endereço nem bearer.
  const { deps } = lspBench()
  const a = armGuiHelperKit(deps, spawnRequest({ helperId: 'h-a' }))
  const b = armGuiHelperKit(deps, spawnRequest({ helperId: 'h-b' }))
  assert.notEqual(a.paneId, b.paneId)
  assert.notEqual(a.token, b.token)
})

test('R14 — o bearer morre em TODO desfecho: entrega, descarte e interrupção', () => {
  const bench = lspBench()
  const emit = new Map()
  const kits = new Map()
  const killed = []
  let seq = 0
  const adapter = (request, publish) => {
    // A MESMA costura dos adaptadores reais: armar antes, revogar no dispose.
    const kit = armGuiHelperKit(bench.deps, request)
    kits.set(request.helperId, kit)
    emit.set(request.helperId, publish)
    return {
      send: () => undefined,
      dispose: guiHelperKitDisposer(bench.deps, request, kit, () => killed.push(request.helperId))
    }
  }
  const engine = new GuiHelperEngine({
    spawnClaude: adapter,
    spawnCodex: adapter,
    resolveSeat: () => ({ seatId: 'seat-1', configDir: 'C:/cfg/claude', name: 'Claude A' }),
    newId: () => `h-${(seq += 1)}`,
    spawnIntervalMs: 0
  })
  const outcome = engine.spawn(lspDelegator, [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }])
  for (const receipt of outcome.receipts) assert.equal(receipt.ok, true, receipt.error)

  // Os TRÊS nasceram armados, cada um com o seu.
  for (const id of ['h-1', 'h-2', 'h-3']) {
    const kit = kits.get(id)
    assert.ok(kit, `${id} nasceu sem kit`)
    assert.equal(bench.hub.identityByToken(kit.token).role, 'ajudante')
    assert.equal(existsSync(kit.mcpFile), true, `${id}: a config do claude não foi escrita`)
  }

  // 1. ENTREGA (o desfecho normal do claude, que morre sozinho depois do result).
  emit.get('h-1')({ type: 'result', isError: false, text: 'achei o erro' })
  assert.equal(engine.get('h-1').state, 'done')
  const feito = kits.get('h-1')
  assert.equal(bench.hub.identityByToken(feito.token), undefined, 'o bearer do entregue sobreviveu')
  assert.equal(bench.hub.identityByPane(feito.paneId), undefined)
  assert.equal(existsSync(feito.mcpFile), false, 'a config ficou no disco depois do desfecho')

  // 2. DESCARTE explícito do delegador.
  assert.equal(engine.cancel('h-2', 'descartado pelo chat que o abriu').ok, true)
  assert.equal(bench.hub.identityByToken(kits.get('h-2').token), undefined, 'cancelar não revogou')

  // 3. INTERRUPÇÃO preservadora (o ■ do dono / o app fechando).
  emit.get('h-3')({ type: 'session', sessionId: 'sess-3' })
  assert.equal(engine.interruptAll('o app fechou'), 1)
  assert.equal(engine.get('h-3').state, 'interrupted')
  const parado = kits.get('h-3')
  assert.equal(bench.hub.identityByToken(parado.token), undefined, 'interromper não revogou')
  assert.equal(existsSync(parado.mcpFile), false)

  assert.deepEqual([...killed].sort(), ['h-1', 'h-2', 'h-3'], 'algum processo não foi descartado')
  assert.deepEqual(
    bench.journal
      .filter((entry) => entry.event === 'helper-lsp-revoked')
      .map((entry) => entry.helperId)
      .sort(),
    ['h-1', 'h-2', 'h-3']
  )
})

test('R14 — helper_resume RE-ARMA: bearer novo na volta, e o antigo não abre mais nada', () => {
  const bench = lspBench()
  const emit = new Map()
  const vidas = []
  let seq = 0
  const adapter = (request, publish) => {
    const kit = armGuiHelperKit(bench.deps, request)
    vidas.push(kit)
    emit.set(request.helperId, publish)
    return {
      send: () => undefined,
      dispose: guiHelperKitDisposer(bench.deps, request, kit, () => undefined)
    }
  }
  const engine = new GuiHelperEngine({
    spawnClaude: adapter,
    spawnCodex: adapter,
    resolveSeat: () => ({ seatId: 'seat-1', configDir: 'C:/cfg/claude', name: 'Claude A' }),
    newId: () => `h-${(seq += 1)}`,
    spawnIntervalMs: 0
  })
  engine.spawn(lspDelegator, [{ prompt: 'a' }])
  emit.get('h-1')({ type: 'session', sessionId: 'sess-1' })
  engine.interruptAll('o app fechou')
  assert.equal(vidas.length, 1)
  assert.equal(bench.hub.identityByToken(vidas[0].token), undefined)

  assert.equal(engine.resume('h-1').ok, true)
  assert.equal(vidas.length, 2, 'a volta não passou pelo adaptador — nasceria sem ferramenta')
  const volta = vidas[1]
  assert.notEqual(volta.token, vidas[0].token, 'a segunda vida reusou o bearer da primeira')
  assert.equal(volta.paneId, vidas[0].paneId, 'o endereço do ajudante é estável entre as vidas')
  assert.equal(bench.hub.identityByToken(volta.token).role, 'ajudante')
  assert.equal(existsSync(volta.mcpFile), true)
  assert.equal(
    bench.hub.identityByToken(vidas[0].token),
    undefined,
    'o bearer da vida anterior voltou a valer'
  )
})

test('R14 — revogar é idempotente e acontece mesmo quando o kill estoura', () => {
  const bench = lspBench()
  const request = spawnRequest({ helperId: 'h-bomba' })
  const kit = armGuiHelperKit(bench.deps, request)
  let kills = 0
  const dispose = guiHelperKitDisposer(bench.deps, request, kit, () => {
    kills += 1
    throw new Error('o processo já tinha morrido')
  })
  assert.throws(dispose, /já tinha morrido/u)
  assert.equal(
    bench.hub.identityByToken(kit.token),
    undefined,
    'o kill estourou e o bearer sobreviveu ao processo'
  )
  assert.equal(existsSync(kit.mcpFile), false)

  // O motor descarta em mais de um caminho (settle, discard, re-tentativa): a
  // segunda passagem não pode revogar de novo nem duplicar o diário.
  assert.throws(dispose, /já tinha morrido/u)
  assert.equal(kills, 2, 'o kill é do processo e continua sendo pedido')
  assert.deepEqual(
    bench.journal.map((entry) => entry.event),
    ['helper-lsp-armed', 'helper-lsp-revoked']
  )
})

test('R14 — servidor fora do ar: o ajudante nasce SEM tools, e o diário diz por quê', () => {
  const bench = lspBench({ port: 0 })
  const request = spawnRequest({ helperId: 'h-cego' })
  const kit = armGuiHelperKit(bench.deps, request)
  assert.equal(kit, undefined, 'apontar para porta morta é pior que nascer sem ferramenta')
  assert.deepEqual(bench.journal.map((entry) => entry.event), ['helper-lsp-unavailable'])
  assert.match(bench.journal[0].detail.reason, /servidor/u)

  const opts = claudeHelperSessionOptions(request, 'C:/prompts/h.system.md', kit)
  assert.deepEqual(opts.extraArgs, claudeHelperArgs(), 'sem kit o spawn é o de antes da R14')
  assert.equal('extraEnv' in opts, false)
  assert.deepEqual(codexHelperSessionOptions(request, kit).extraArgs, codexHelperArgs())

  // E o descarte de um ajudante sem kit não inventa revogação nenhuma.
  guiHelperKitDisposer(bench.deps, request, kit, () => undefined)()
  assert.deepEqual(bench.journal.map((entry) => entry.event), ['helper-lsp-unavailable'])

  // Sem deps de LSP (o mundo pré-R14, e as suítes) nada acontece e nada se diz.
  assert.equal(armGuiHelperKit({ systemPromptFile: () => undefined }, request), undefined)
})

test('R14 — a linha do LSP entra UMA vez, e só no ajudante que tem as tools', () => {
  const armada = guiHelperPersonaFor(true)
  const muda = guiHelperPersonaFor(false)
  assert.equal(muda, GUI_HELPER_PERSONA, 'sem kit a persona é a de sempre, palavra por palavra')
  assert.doesNotMatch(muda, /lsp_/u, 'a persona prometeu ferramenta que este ajudante não tem')
  assert.ok(armada.startsWith(GUI_HELPER_PERSONA), 'a linha nova reescreveu a persona')
  assert.equal(
    armada.split('\n').filter((line) => line.includes('lsp_diagnostics')).length,
    1,
    'a linha do LSP entrou mais de uma vez'
  )
  for (const tool of lspMcp.GUI_HELPER_LSP_TOOLS) {
    assert.ok(armada.includes(tool), `${tool} não foi anunciado ao ajudante`)
  }
  // Ela diz PARA QUE serve — achar o lugar exato ANTES de mexer.
  assert.match(GUI_HELPER_LSP_PERSONA_LINE, /BEFORE you edit/u)

  // E os DOIS adaptadores usam a versão condicional: um deles com persona fixa
  // seria o ajudante daquele CLI prometendo tool que não recebeu.
  const wiringSrc = source('src/main/guiDelegationWiring.ts')
  assert.equal(
    (wiringSrc.match(/guiHelperPersonaFor\(kit !== undefined\)/gu) ?? []).length,
    2,
    'um dos CLIs ficou com a persona fixa'
  )
})
