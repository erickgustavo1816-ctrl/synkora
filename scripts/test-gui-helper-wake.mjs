// DESPERTADOR DOS AJUDANTES (onda 4 do design vinculante
// `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md`).
//
// O BUG REAL (teste do dono, 18/08): um chat codex abriu cinco ajudantes pelo
// MCP, anunciou "cinco subagentes abertos e trabalhando" e ENCERROU O TURNO. Os
// cinco entregaram. O chat ficou mudo para sempre — o agente não tinha como
// saber que eles encerraram (nunca chamou `helper_result`), a lateral só mostra
// quem está vivo, e o dono ficou olhando uma conversa parada.
//
// O que esta suíte prova: quando um ajudante ENCERRA e a conversa do delegador
// está OCIOSA, o harness ENTREGA um aviso curto ao MODELO — pelos BASTIDORES
// (R7 A1: `turn-started` + `session.send`, o caminho do `announce`), porque o
// estímulo é do app e não pode nascer como bolha do dono no fio. Cancelamento
// não acorda ninguém, o mesmo ajudante nunca acorda duas vezes, e turno em
// andamento SEGURA o aviso até a conversa aquietar.
//
// Como rodar (o package.json não foi tocado — a linha para registrar está no
// relatório w4-wake.md):
//   tsc --outDir .tmp/gui-helper-wake-test --target ES2022 --module Node16 \
//       --moduleResolution Node16 --esModuleInterop --skipLibCheck --noCheck \
//       --types node src/main/guiSessions.ts src/main/guiHelperCards.ts \
//   && node --test scripts/test-gui-helper-wake.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

// Namespace de propósito (mesma disciplina da suíte irmã): com destructure no
// topo, UM export faltando derruba o arquivo inteiro e o vermelho deixa de
// discriminar qual peça falta.
import * as cards from '../.tmp/gui-helper-wake-test/guiHelperCards.js'
import * as sessions from '../.tmp/gui-helper-wake-test/guiSessions.js'

const { GuiHelperCardCorrelator, GuiHelperInbox, guiHelperWakeMessage } = cards
const { GuiSessionRegistry } = sessions

/** Relógio de bancada: nada de espera real numa janela de coalescência de 3s. */
function fakeTimers() {
  const armed = []
  return {
    setTimer(ms, fn) {
      const slot = { ms, fn, cancelled: false }
      armed.push(slot)
      return () => {
        slot.cancelled = true
      }
    },
    /** Dispara UM passo: o que for re-armado fica para o `tick` seguinte. */
    tick() {
      const due = armed.splice(0, armed.length)
      let fired = 0
      for (const slot of due) {
        if (slot.cancelled) continue
        fired += 1
        slot.fn()
      }
      return fired
    },
    get pending() {
      return armed.filter((slot) => !slot.cancelled).length
    },
    get windows() {
      return armed.map((slot) => slot.ms)
    }
  }
}

function helperRecord(patch = {}) {
  return {
    helperId: 'h-1',
    delegatorPaneId: 'gui-dev-abc12345',
    projectId: 'proj',
    name: 'pesquisa',
    cli: 'claude',
    model: 'opus[1m]',
    effort: 'high',
    seatId: 'seat-1',
    seatName: 'Claude - Gmail',
    prompt: 'levante os arquivos que tocam a fila',
    state: 'working',
    startedAt: 1_000,
    ...patch
  }
}

/** Correlacionador com relógio de bancada e espião de despertar.
 *
 *  O CORREIO entra INJETADO (e não o singleton de produção): o pote é
 *  compartilhado com as tools do MCP, e um pote global faria a pendência de um
 *  teste vazar para o vizinho de mesmo paneId. */
function harness(overrides = {}) {
  const emitted = []
  const wakes = []
  const timers = fakeTimers()
  const inbox = new GuiHelperInbox()
  const correlator = new GuiHelperCardCorrelator({
    emit: (paneId, evt) => emitted.push({ paneId, evt }),
    turnActive: () => false,
    setTimer: timers.setTimer,
    inbox,
    wake: (paneId, wake) => {
      wakes.push({ paneId, wake })
      return true
    },
    ...overrides
  })
  return { correlator, emitted, wakes, timers, inbox }
}

/** Abre um lote com N ajudantes e devolve os registros vivos. */
function openBatch(correlator, paneId, records) {
  correlator.begin(paneId)
  for (const record of records) correlator.change({ kind: 'spawned', record })
  correlator.end(paneId)
  return records
}

function settle(correlator, record, state, patch = {}) {
  correlator.change({ kind: 'settled', record: { ...record, state, ...patch } })
}

// ————— a mensagem (função pura) —————

test('o aviso nomeia cada ajudante, o placar e a instrução de colher', () => {
  const text = guiHelperWakeMessage(
    [
      { helperId: 'h-1', name: 'pesquisa', model: 'opus[1m]', ok: true },
      { helperId: 'h-2', name: 'schema', model: 'gpt-5.6', ok: true },
      { helperId: 'h-3', model: 'fable', ok: false }
    ],
    0
  )
  assert.ok(text.startsWith('[synkora]'), 'o aviso se identifica como fala do app')
  assert.match(text, /2 concluídos/u)
  assert.match(text, /1 falhou/u)
  for (const id of ['h-1', 'h-2', 'h-3']) {
    assert.ok(text.includes(id), `o id ${id} tem de estar no texto — é o argumento do helper_result`)
  }
  assert.ok(text.includes('pesquisa'), 'o apelido dado pelo delegador aparece')
  assert.ok(text.includes('opus[1m]'), 'o modelo aparece')
  assert.match(text, /helper_result/u)
  assert.ok(text.length < 900, `o aviso é curto (${text.length} chars)`)
})

test('um ajudante só fala no singular e um lote só de falhas ainda acorda', () => {
  const single = guiHelperWakeMessage([{ helperId: 'h-9', model: 'opus', ok: true }], 0)
  assert.ok(!/\b2 /u.test(single), 'nada de plural inventado para um ajudante')
  assert.match(single, /concluí/u)

  const failed = guiHelperWakeMessage(
    [
      { helperId: 'h-1', model: 'opus', ok: false },
      { helperId: 'h-2', model: 'opus', ok: false }
    ],
    0
  )
  assert.match(failed, /2 falharam/u)
  assert.match(failed, /helper_result/u, 'falha também se conta ao dono, com a causa')
})

test('o aviso avisa quando a frota ainda não acabou e corta lista gigante', () => {
  const partial = guiHelperWakeMessage([{ helperId: 'h-1', model: 'opus', ok: true }], 4)
  assert.match(partial, /4/u, 'quem continua trabalhando entra no texto')

  const many = Array.from({ length: cards.GUI_HELPER_WAKE_LIST_MAX + 5 }, (_unused, index) => ({
    helperId: `h-${index}`,
    model: 'opus',
    ok: true
  }))
  const lines = guiHelperWakeMessage(many, 0).split('\n').filter((line) => line.startsWith('·'))
  assert.ok(
    lines.length <= cards.GUI_HELPER_WAKE_LIST_MAX + 1,
    'trinta ajudantes não viram trinta linhas na conversa'
  )
})

// ————— o correlacionador —————

test('ajudante que encerra com a conversa ociosa acorda o delegador', () => {
  const { correlator, wakes, timers } = harness()
  const paneId = 'gui-dev-abc12345'
  const [record] = openBatch(correlator, paneId, [helperRecord()])
  settle(correlator, record, 'done', { result: 'pronto' })

  assert.equal(wakes.length, 0, 'o aviso NÃO sai no mesmo instante — a janela coalesce')
  assert.equal(timers.pending, 1)
  assert.equal(timers.windows[0], cards.GUI_HELPER_WAKE_COALESCE_MS)
  timers.tick()
  assert.equal(wakes.length, 1)
  assert.equal(wakes[0].paneId, paneId)
  assert.deepEqual(wakes[0].wake.helperIds, ['h-1'])
  assert.equal(wakes[0].wake.done, 1)
  assert.equal(wakes[0].wake.failed, 0)
  assert.match(wakes[0].wake.text, /helper_result/u)
})

test('lote que encerra junto vira UMA mensagem só', () => {
  const { correlator, wakes, timers } = harness()
  const paneId = 'gui-dev-abc12345'
  const fleet = openBatch(correlator, paneId, [
    helperRecord({ helperId: 'h-1', name: 'a' }),
    helperRecord({ helperId: 'h-2', name: 'b' }),
    helperRecord({ helperId: 'h-3', name: 'c' })
  ])
  settle(correlator, fleet[0], 'done')
  settle(correlator, fleet[1], 'failed', { failure: 'estourou o watchdog' })
  settle(correlator, fleet[2], 'done')
  assert.equal(timers.pending, 1, 'a janela é ÚNICA — cada encerramento não arma um relógio')
  timers.tick()

  assert.equal(wakes.length, 1)
  assert.deepEqual(wakes[0].wake.helperIds, ['h-1', 'h-2', 'h-3'])
  assert.equal(wakes[0].wake.done, 2)
  assert.equal(wakes[0].wake.failed, 1)
  assert.equal(wakes[0].wake.stillWorking, 0)
})

test('cancelamento NUNCA acorda ninguém', () => {
  const { correlator, wakes, timers } = harness()
  const paneId = 'gui-dev-abc12345'
  const [record] = openBatch(correlator, paneId, [helperRecord()])
  settle(correlator, record, 'cancelled', { failure: 'o app fechou' })
  assert.equal(timers.pending, 0, 'nem relógio se arma para um cancelamento')
  timers.tick()
  assert.equal(wakes.length, 0)
})

test('turno em andamento SEGURA o aviso e ele sai quando a conversa aquieta', () => {
  let turnActive = true
  const { correlator, wakes, timers } = harness({ turnActive: () => turnActive })
  const paneId = 'gui-dev-abc12345'
  const [record] = openBatch(correlator, paneId, [helperRecord()])
  settle(correlator, record, 'done')

  timers.tick()
  assert.equal(wakes.length, 0, 'ninguém interrompe um turno em andamento')
  assert.equal(timers.pending, 1, 'o aviso continua marcado para a próxima batida')

  timers.tick()
  assert.equal(wakes.length, 0, 'ainda em turno: continua esperando')

  turnActive = false
  timers.tick()
  assert.equal(wakes.length, 1, 'a conversa aquietou e o aviso saiu')
  assert.deepEqual(wakes[0].wake.helperIds, ['h-1'])
})

test('o mesmo ajudante nunca acorda duas vezes', () => {
  const { correlator, wakes, timers } = harness()
  const paneId = 'gui-dev-abc12345'
  const [record] = openBatch(correlator, paneId, [helperRecord()])
  settle(correlator, record, 'done')
  timers.tick()
  assert.equal(wakes.length, 1)

  // O turno que o aviso abriu termina; nada NOVO encerrou desde então.
  correlator.observe(paneId, { type: 'result', continues: false })
  timers.tick()
  timers.tick()
  assert.equal(wakes.length, 1, 'sem ajudante novo encerrado, ninguém é acordado de novo')

  // E um `settled` repetido do motor também não ressuscita o aviso.
  settle(correlator, record, 'done')
  timers.tick()
  assert.equal(wakes.length, 1)
})

test('dois lotes intercalados acordam com os ajudantes certos', () => {
  const { correlator, wakes, timers } = harness()
  const paneId = 'gui-dev-abc12345'
  const first = openBatch(correlator, paneId, [
    helperRecord({ helperId: 'a-1' }),
    helperRecord({ helperId: 'a-2' })
  ])
  const second = openBatch(correlator, paneId, [
    helperRecord({ helperId: 'b-1' }),
    helperRecord({ helperId: 'b-2' })
  ])

  settle(correlator, first[0], 'done')
  settle(correlator, second[0], 'done')
  timers.tick()
  assert.equal(wakes.length, 1)
  assert.deepEqual(wakes[0].wake.helperIds, ['a-1', 'b-1'])
  assert.equal(wakes[0].wake.stillWorking, 2, 'os dois que sobraram são contados')

  settle(correlator, first[1], 'done')
  settle(correlator, second[1], 'failed', { failure: 'quebrou' })
  timers.tick()
  assert.equal(wakes.length, 2)
  assert.deepEqual(
    wakes[1].wake.helperIds,
    ['a-2', 'b-2'],
    'o segundo aviso nomeia SÓ quem encerrou depois do primeiro'
  )
  assert.equal(wakes[1].wake.stillWorking, 0)
})

test('pane descartado com aviso pendente cai em silêncio', () => {
  const { correlator, wakes, timers } = harness({ turnActive: () => true })
  const paneId = 'gui-dev-abc12345'
  const [record] = openBatch(correlator, paneId, [helperRecord()])
  settle(correlator, record, 'done')
  assert.equal(timers.pending, 1)

  correlator.forgetPane(paneId)
  assert.equal(timers.pending, 0, 'o relógio morre com o pane')
  timers.tick()
  assert.equal(wakes.length, 0)
})

test('recusa transitória da entrega devolve o aviso para a batida seguinte', () => {
  let accept = false
  const wakes = []
  const timers = fakeTimers()
  const correlator = new GuiHelperCardCorrelator({
    emit: () => undefined,
    turnActive: () => false,
    setTimer: timers.setTimer,
    wake: (paneId, wake) => {
      wakes.push({ paneId, wake })
      return accept
    }
  })
  const paneId = 'gui-dev-abc12345'
  const [record] = openBatch(correlator, paneId, [helperRecord()])
  settle(correlator, record, 'done')
  timers.tick()
  assert.equal(wakes.length, 1, 'tentou entregar')
  assert.equal(timers.pending, 1, 'recusado, o aviso continua pendente')

  accept = true
  timers.tick()
  assert.equal(wakes.length, 2)
  assert.deepEqual(wakes[1].wake.helperIds, ['h-1'], 'o mesmo aviso, não um pedaço dele')
  timers.tick()
  assert.equal(wakes.length, 2, 'entregue, o aviso some')
})

// ————— a entrega de verdade, pelo registro de sessões —————

function registryHarness(patch = {}) {
  const timers = fakeTimers()
  const records = []
  const sent = []
  const inbox = new GuiHelperInbox()
  const state = { alive: true, turnActive: false }
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    helperWakeTimer: timers.setTimer,
    // Correio PRÓPRIO por harness: sem isto dois registros do mesmo paneId
    // dividiriam o pote de produção e a pendência de um teste apareceria no
    // aviso do outro.
    helperInbox: inbox,
    record: (event, ids, detail) => records.push({ event, ids, detail }),
    ...patch
  })
  gui.spawnSession = () => ({
    get alive() {
      return state.alive
    },
    get turnActive() {
      return state.turnActive
    },
    send: (text) => sent.push(text),
    // O ■ do dono (R6.3) atravessa o turno do CLI antes de tocar na frota.
    interrupt: () => true,
    kill: () => undefined
  })
  const paneId = 'gui-dev-abc12345'
  assert.equal(
    gui.create({
      paneId,
      projectId: 'proj',
      cli: 'claude',
      configDir: 'seat-1',
      cwd: '/tmp'
    }).ok,
    true
  )
  return { gui, paneId, timers, records, sent, state, inbox }
}

// R7 A1 — O WAKE É DO HARNESS, NUNCA DO DONO (achado 1 da validação ao vivo).
//
// O que o dono viu no print 1 (chat codex): o despertador entregava pelo `send`,
// então nascia uma bolha "VOCÊ" no fio com texto de máquina — o app aparecendo
// como se ELE tivesse digitado "[synkora] o ajudante que você abriu encerrou".
// Palavras dele: "avisar por trás dos panos, sem ser via chat".
//
// O caminho passou a ser o do `announce` (precedente exato: o recibo de decisão
// de plano): `turn-started` + `session.send`, sem `user-message` e sem
// messageId. O estímulo não precisa de bolha — a reação do agente é o que o dono
// vê, e a lateral já mostra os cards encerrando.

test('o aviso chega ao modelo pelos BASTIDORES: o turno abre e nada nasce no fio', () => {
  const { gui, paneId, timers, records, sent } = registryHarness()
  const record = helperRecord()
  gui.beginHelperBatch(paneId)
  gui.noteHelperChange({ kind: 'spawned', record })
  gui.endHelperBatch(paneId)
  gui.noteHelperChange({ kind: 'settled', record: { ...record, state: 'done', result: 'ok' } })
  timers.tick()

  assert.equal(sent.length, 1, 'o texto foi para o modelo — um turno de verdade começa')
  assert.match(sent[0], /helper_result/u)
  assert.ok(sent[0].includes('h-1'), 'o id é o argumento do helper_result')

  const events = gui.state(paneId).events.map(({ evt }) => evt)
  assert.equal(
    events.some((evt) => evt.type === 'user-message'),
    false,
    'o despertador voltou a nascer como bolha do dono no fio'
  )
  assert.ok(
    events.some((evt) => evt.type === 'turn-started'),
    'sem `turn-started` o composer fica ocioso enquanto o agente já está trabalhando'
  )
  const audit = records.find((entry) => entry.event === 'gui-helper-wake')
  assert.ok(audit, 'a caixa-preta registra o despertar pelo seam de sempre')
  assert.equal(
    audit.detail.silent,
    true,
    'o diário tem de dizer QUAL caminho de entrega rodou — sem a marca, um wake antigo ' +
      'e um novo ficam idênticos no histórico'
  )
})

test('turno vivo no chat segura a entrega; sessão morta a descarta', () => {
  const held = registryHarness()
  held.state.turnActive = true
  const record = helperRecord()
  held.gui.beginHelperBatch(held.paneId)
  held.gui.noteHelperChange({ kind: 'spawned', record })
  held.gui.endHelperBatch(held.paneId)
  held.gui.noteHelperChange({ kind: 'settled', record: { ...record, state: 'done' } })
  held.timers.tick()
  assert.equal(held.sent.length, 0, 'o chat está falando — o aviso espera')

  held.state.turnActive = false
  held.timers.tick()
  assert.equal(held.sent.length, 1, 'turno acabou, o aviso saiu')

  const dead = registryHarness()
  dead.state.turnActive = true
  dead.gui.beginHelperBatch(dead.paneId)
  dead.gui.noteHelperChange({ kind: 'spawned', record })
  dead.gui.endHelperBatch(dead.paneId)
  dead.gui.noteHelperChange({ kind: 'settled', record: { ...record, state: 'done' } })
  dead.timers.tick()
  assert.equal(dead.sent.length, 0)
  dead.state.alive = false
  dead.timers.tick()
  assert.equal(dead.sent.length, 0, 'ninguém para acordar')
  assert.equal(dead.timers.pending, 0, 'e o relógio para — nada de bater num pane morto para sempre')
})

// ————— o correio: o MESMO pote que o despertador (18/08, 5º teste do dono) —————
//
// Ordem dele: "cada ajudante que terminar, avisar o orquestrador que terminou e
// entregar via MCP, pra não poluir o chat". O aviso passou a ter DOIS caminhos —
// o despertador (conversa ociosa) e a carona no resultado da próxima tool
// (mesmo dentro do turno). Os dois bebem do MESMO pote, então o dono nunca lê a
// mesma novidade duas vezes nem fica sem ela.

test('o aviso cita o ARQUIVO de cada entrega, que é o que o agente abre', () => {
  const text = guiHelperWakeMessage(
    [
      {
        helperId: 'h-1',
        name: 'pesquisa',
        model: 'opus[1m]',
        ok: true,
        resultPath: '.synkora/helpers/h-1.md'
      },
      { helperId: 'h-2', model: 'fable', ok: false, resultPath: '.synkora/helpers/h-2.md' }
    ],
    0
  )
  assert.match(text, /\.synkora\/helpers\/h-1\.md/u)
  assert.match(text, /\.synkora\/helpers\/h-2\.md/u, 'a falha também tem registro em arquivo')
  assert.ok(text.length < 900, `o aviso continua curto (${text.length} chars)`)
})

test('o encerramento fica no correio até alguém entregar', () => {
  const { correlator, inbox, timers } = harness({ turnActive: () => true })
  const paneId = 'gui-dev-abc12345'
  const [record] = openBatch(correlator, paneId, [helperRecord()])
  settle(correlator, record, 'done', { result: 'pronto', resultPath: '.synkora/helpers/h-1.md' })

  assert.equal(inbox.count(paneId), 1, 'o pote é onde a novidade espera')
  const [entry] = inbox.drain(paneId)
  assert.equal(entry.helperId, 'h-1')
  assert.equal(entry.resultPath, '.synkora/helpers/h-1.md')
  assert.equal(entry.ok, true)

  // Colhido pelo correio, o despertador não repete: ele bate, vê o pote vazio e
  // se apaga.
  timers.tick()
  assert.equal(inbox.count(paneId), 0)
  assert.equal(timers.pending, 0, 'relógio de aviso que já foi entregue não se re-arma')
})

test('o que o despertador entregou não sobra no correio', () => {
  const { correlator, inbox, timers, wakes } = harness()
  const paneId = 'gui-dev-abc12345'
  const [record] = openBatch(correlator, paneId, [helperRecord()])
  settle(correlator, record, 'done')
  timers.tick()

  assert.equal(wakes.length, 1)
  assert.equal(inbox.count(paneId), 0, 'a mesma novidade viajaria de novo na próxima tool')
})

test('recusa transitória devolve a novidade AO POTE, na ordem certa', () => {
  const { correlator, inbox, timers } = harness({ wake: () => false })
  const paneId = 'gui-dev-abc12345'
  const fleet = openBatch(correlator, paneId, [
    helperRecord({ helperId: 'h-1' }),
    helperRecord({ helperId: 'h-2' })
  ])
  settle(correlator, fleet[0], 'done')
  timers.tick()
  assert.equal(inbox.count(paneId), 1, 'recusado, o aviso volta para o pote')

  settle(correlator, fleet[1], 'done')
  assert.deepEqual(
    inbox.drain(paneId).map((entry) => entry.helperId),
    ['h-1', 'h-2'],
    'o antigo volta NA FRENTE do que encerrou durante a tentativa'
  )
})

test('pane esquecido leva o correio junto', () => {
  const { correlator, inbox } = harness({ turnActive: () => true })
  const paneId = 'gui-dev-abc12345'
  const [record] = openBatch(correlator, paneId, [helperRecord()])
  settle(correlator, record, 'done')
  assert.equal(inbox.count(paneId), 1)

  correlator.forgetPane(paneId)
  assert.equal(inbox.count(paneId), 0, 'novidade de conversa desmontada é lixo, não memória')
})

test('fechar o chat com aviso pendente não entrega nada', () => {
  const { gui, paneId, timers, sent, state } = registryHarness()
  state.turnActive = true
  const record = helperRecord()
  gui.beginHelperBatch(paneId)
  gui.noteHelperChange({ kind: 'spawned', record })
  gui.endHelperBatch(paneId)
  gui.noteHelperChange({ kind: 'settled', record: { ...record, state: 'done' } })
  assert.equal(timers.pending, 1)

  gui.kill(paneId)
  assert.equal(timers.pending, 0)
  timers.tick()
  assert.equal(sent.length, 0)
})

// ————— R6.3: o ■ do dono é ATÔMICO —————
//
// Semântica do dono (R6.3): apertar ■ (1) interrompe o turno do CLI, (2) para a
// frota PRESERVANDO (interrupted, retomável — nunca descarte) e (3) DESCARTA as
// pendências de despertador do pane. O caso real que produziu o item 3: o
// despertador abriu um turno novo POR CIMA da interrupção que o dono acabara de
// fazer — o app falando justamente na conversa que ele mandou calar.

test('discardPending esvazia o pote e mata o relógio, sem esquecer os lotes', () => {
  const { correlator, inbox, timers, wakes } = harness({ turnActive: () => true })
  const paneId = 'gui-dev-abc12345'
  const fleet = openBatch(correlator, paneId, [
    helperRecord({ helperId: 'h-1' }),
    helperRecord({ helperId: 'h-2' })
  ])
  settle(correlator, fleet[0], 'done')
  assert.equal(inbox.count(paneId), 1)
  assert.equal(timers.pending, 1)

  assert.equal(correlator.discardPending(paneId), 1, 'o descarte devolve quantas novidades caíram')
  assert.equal(inbox.count(paneId), 0, 'o pote continuou cheio — o aviso sairia depois do ■')
  assert.equal(timers.pending, 0, 'o relógio do despertador sobreviveu ao ■')
  timers.tick()
  assert.equal(wakes.length, 0)

  // O LOTE continua de pé: o ajudante que sobrou ainda é deste pane, e o card
  // dele tem de fechar quando ele encerrar.
  settle(correlator, fleet[1], 'failed', { failure: 'quebrou' })
  assert.equal(inbox.count(paneId), 1, 'o pane esqueceu quem ainda estava vivo')
})

test('o ■ do dono para o turno, PRESERVA a frota e cala o despertador na mesma tacada', () => {
  const { gui, paneId, timers, sent, records } = registryHarness()
  const calls = []
  gui.attachHelpers({
    interruptPane: (id, reason) => {
      calls.push({ id, reason })
      return 2
    },
    status: () => []
  })

  const record = helperRecord()
  gui.beginHelperBatch(paneId)
  gui.noteHelperChange({ kind: 'spawned', record })
  gui.endHelperBatch(paneId)
  gui.noteHelperChange({ kind: 'settled', record: { ...record, state: 'done' } })
  assert.equal(timers.pending, 1, 'havia aviso marcado quando o dono apertou o quadrado')

  const outcome = gui.interrupt(paneId)
  assert.equal(outcome.ok, true)
  assert.equal(calls.length, 1, 'a frota do pane não foi interrompida junto com o turno')
  assert.equal(calls[0].id, paneId)
  assert.equal(timers.pending, 0, 'o despertador voltaria a falar na conversa que o dono calou')
  timers.tick()
  assert.equal(sent.length, 0)
  const audit = records.find((entry) => entry.event === 'gui-interrupt')
  assert.ok(audit, 'a caixa-preta não registrou o ■')
  assert.equal(audit.detail.helpers, 2, 'o diário tem de dizer quantos ajudantes pararam junto')
  assert.equal(audit.detail.wakes, 1, 'e quantos avisos foram descartados')
})

test('sem motor ligado o ■ continua interrompendo o turno', () => {
  // O registro nasce antes do motor no índice (a costura é circular). Um ■ que
  // dependesse do motor estar amarrado deixaria o dono sem o botão no boot.
  const { gui, paneId } = registryHarness()
  assert.equal(gui.interrupt(paneId).ok, true)
})

// ————— R6.1 (cauda): o DESPERTADOR DE BOOT com os dois verbos —————

test('conversa que reabre com ajudante interrompido recebe UM aviso com os dois verbos', () => {
  const timers = fakeTimers()
  const sent = []
  const inbox = new GuiHelperInbox()
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    helperWakeTimer: timers.setTimer,
    helperInbox: inbox,
    record: () => undefined
  })
  gui.spawnSession = () => ({
    alive: true,
    turnActive: false,
    send: (text) => sent.push(text),
    kill: () => undefined
  })
  gui.attachHelpers({
    interruptPane: () => 0,
    status: () => [
      {
        helperId: 'h-1',
        name: 'busca',
        cli: 'claude',
        model: 'opus[1m]',
        seatId: 'seat-1',
        state: 'interrupted',
        startedAt: 0,
        elapsedMs: 12 * 60_000,
        hasResult: true,
        resultPath: '.synkora/helpers/h-1.md'
      },
      {
        helperId: 'h-2',
        cli: 'claude',
        model: 'fable',
        seatId: 'seat-1',
        state: 'done',
        startedAt: 0,
        elapsedMs: 1_000,
        hasResult: true
      }
    ]
  })

  const paneId = 'gui-dev-abc12345'
  const spawn = { paneId, projectId: 'proj', cli: 'claude', configDir: 'seat-1', cwd: '/tmp' }
  assert.equal(gui.create(spawn).ok, true)
  assert.equal(sent.length, 0, 'o aviso de boot não pode sair antes da janela de coalescência')
  timers.tick()

  assert.equal(sent.length, 1)
  assert.match(sent[0], /interrompid/iu)
  assert.match(sent[0], /helper_resume/u, 'o dono tem de poder retomar')
  assert.match(sent[0], /helper_cancel/u, 'e tem de poder descartar')
  assert.ok(sent[0].includes('h-1'), 'o id é o argumento dos dois verbos')
  assert.ok(sent[0].includes('busca'), 'o apelido do card')
  assert.ok(!sent[0].includes('h-2'), 'quem ENTREGOU não entra no aviso de interrompidos')

  // R7 A1: o despertador de boot é O MESMO caminho de entrega do de settle —
  // dois verbos, um caminho só. Bastidores aqui também.
  const events = gui.state(paneId).events.map(({ evt }) => evt)
  assert.equal(
    events.some((evt) => evt.type === 'user-message'),
    false,
    'o aviso de boot nasceu como bolha do dono — o app falando na voz dele'
  )
  assert.ok(
    events.some((evt) => evt.type === 'turn-started'),
    'o aviso de boot tem de abrir turno como qualquer entrega ao modelo'
  )

  // Uma vez por boot: remontar a mesma conversa (aba, reload da view) não
  // repete o aviso.
  assert.equal(gui.create(spawn).ok, true)
  timers.tick()
  assert.equal(sent.length, 1, 'o aviso de boot saiu de novo numa remontagem')
})

test('o despertador não queima o briefing da missão — ele continua esperando o dono', () => {
  // Consequência DIRETA do caminho novo: `announce` não consome o
  // `pendingBriefing` (recibo não é a primeira mensagem do dono). Pelo `send`, o
  // aviso de boot saía com o briefing da missão colado na frente e o dono ficava
  // sem ele na primeira coisa que digitasse.
  const timers = fakeTimers()
  const sent = []
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    helperWakeTimer: timers.setTimer,
    helperInbox: new GuiHelperInbox(),
    record: () => undefined
  })
  gui.spawnSession = () => ({
    alive: true,
    turnActive: false,
    send: (text) => sent.push(text),
    kill: () => undefined
  })
  gui.attachHelpers({
    interruptPane: () => 0,
    status: () => [
      {
        helperId: 'h-1',
        cli: 'claude',
        model: 'opus[1m]',
        seatId: 'seat-1',
        state: 'interrupted',
        startedAt: 0,
        elapsedMs: 5_000,
        hasResult: false
      }
    ]
  })

  const paneId = 'gui-dev-abc12345'
  assert.equal(
    gui.create({
      paneId,
      projectId: 'proj',
      cli: 'claude',
      configDir: 'seat-1',
      cwd: '/tmp',
      firstPrompt: 'MISSAO: por o despertador nos bastidores'
    }).ok,
    true
  )
  timers.tick()
  assert.equal(sent.length, 1)
  assert.ok(
    !sent[0].includes('MISSAO:'),
    'o aviso do harness levou o briefing da missão embora com ele'
  )

  assert.equal(gui.send(paneId, 'e aí, como estamos?').ok, true)
  assert.ok(
    sent[1].includes('MISSAO:'),
    'o briefing tem de viajar colado na PRIMEIRA mensagem do dono, não no aviso do app'
  )
})

test('conversa sem ajudante parado abre calada', () => {
  const { gui, timers, sent } = registryHarness()
  timers.tick()
  assert.equal(sent.length, 0)
})

// ————— R6.2: o card do retomado —————

test('o retomado ganha um card NOVO e o desfecho seguinte chega ao anel', () => {
  // O card do interrompido já fechou, e no renderer um card fechado não aceita
  // outro resultado (`acceptsGuiToolResult`). Sem card novo, o ajudante que
  // voltou entregaria no vazio: a lateral ficaria "interrompida" para sempre e
  // o correio nunca receberia o encerramento.
  const { correlator, emitted, inbox, timers } = harness()
  const paneId = 'gui-dev-abc12345'
  const [record] = openBatch(correlator, paneId, [helperRecord()])
  settle(correlator, record, 'interrupted', { failure: 'o app fechou' })
  assert.equal(inbox.count(paneId), 0, 'interrompido NÃO é encerramento: ninguém acorda por ele')

  const primeiroCard = emitted.find((entry) => entry.evt.type === 'tool').evt.toolUseId
  emitted.length = 0
  correlator.change({ kind: 'resumed', record: { ...record, state: 'spawning' } })

  const aberto = emitted.filter((entry) => entry.evt.type === 'tool')
  assert.equal(aberto.length, 1, 'o retomado precisa de um card')
  assert.notEqual(
    aberto[0].evt.toolUseId,
    primeiroCard,
    'card com id repetido faz o renderer descartar TODO resultado dos dois'
  )
  assert.equal(aberto[0].evt.input.helperId, record.helperId, 'a lateral promove pelo helperId')

  emitted.length = 0
  settle(correlator, record, 'done', { result: 'terminei', resultPath: '.synkora/helpers/h-1.md' })
  const fechado = emitted.find((entry) => entry.evt.type === 'tool-result' && entry.evt.agentStatus === 'settled')
  assert.ok(fechado, 'o desfecho do retomado não chegou ao anel')
  assert.equal(fechado.evt.toolUseId, aberto[0].evt.toolUseId, 'o desfecho fechou o card errado')
  assert.equal(inbox.count(paneId), 1, 'o encerramento do retomado tem de chegar ao delegador')
  timers.tick()
})

test('retomar depois do boot funciona mesmo sem lote nenhum na memória', () => {
  // Depois do restart o correlacionador nasce vazio: o lote da chamada
  // `delegate` original morreu com o processo. O ajudante retomado ganha um
  // lote próprio, com envelope sintético (que não tem card para fechar).
  const { correlator, emitted, inbox } = harness()
  const paneId = 'gui-dev-abc12345'
  const record = helperRecord({ state: 'spawning' })

  correlator.change({ kind: 'resumed', record })
  const aberto = emitted.filter((entry) => entry.evt.type === 'tool')
  assert.equal(aberto.length, 1)
  assert.equal(aberto[0].evt.input.helperId, 'h-1')

  emitted.length = 0
  settle(correlator, record, 'done', { result: 'entreguei' })
  assert.ok(
    emitted.some((entry) => entry.evt.type === 'tool-result' && entry.evt.agentStatus === 'settled'),
    'o retomado sem lote entregou no vazio'
  )
  assert.equal(inbox.count(paneId), 1)
})

test('descartar um interrompido re-escreve o card, e não acorda ninguém', () => {
  const { correlator, emitted, inbox, timers } = harness()
  const paneId = 'gui-dev-abc12345'
  const [record] = openBatch(correlator, paneId, [helperRecord()])
  settle(correlator, record, 'interrupted', { failure: 'o dono apertou o quadrado' })
  emitted.length = 0

  settle(correlator, record, 'cancelled', { failure: 'descartado pelo chat que o abriu' })
  const fechado = emitted.find((entry) => entry.evt.type === 'tool-result')
  assert.ok(fechado, 'o card ficaria "interrompido" para sempre depois do descarte')
  assert.equal(fechado.evt.outcome, 'cancelled')
  assert.equal(inbox.count(paneId), 0, 'descarte nunca acorda o delegador')
  timers.tick()
})

// ————— RODADA 9 (2026-08-19): AS DUAS SUPERFÍCIES DO ⇪ —————
//
// O despertador da rodada 7 provou que estímulo do app NUNCA pode virar bolha do
// dono. A rodada 9 usa o mesmo caminho para o ⇪ — e acrescenta o par que faltava:
// uma NOTA, que é o contrário exato do estímulo. Ela aparece no fio (é o dono que
// lê) e não chega ao modelo; o `announce` chega ao modelo e não aparece. Um sem o
// outro seria ou um clique sem rastro na tela, ou o app falando na voz dele.

test('a NOTA aparece no fio e NÃO abre turno nem fala com o modelo', () => {
  const { gui, paneId, sent } = registryHarness()

  assert.equal(gui.note(paneId, '⇪ subir para version/v1.2 — entregue ao agente').ok, true)

  const events = gui.state(paneId).events.map(({ evt }) => evt)
  const note = events.find((evt) => evt.type === 'command-output')
  assert.ok(note, 'a nota precisa entrar no anel — senão some da remontagem')
  assert.equal(note.text, '⇪ subir para version/v1.2 — entregue ao agente')
  assert.equal(
    events.some((evt) => evt.type === 'user-message'),
    false,
    'nota do app não pode nascer como bolha do dono'
  )
  assert.equal(sent.length, 0, 'a nota é MUDA para o modelo — quem fala com ele é o announce')
  assert.equal(
    events.filter((evt) => evt.type === 'turn-started').length,
    0,
    'anotar um gesto não é começar um turno'
  )
})

test('a NOTA recusa com honestidade quando não há conversa viva', () => {
  const { gui, paneId, state } = registryHarness()
  assert.equal(gui.note('gui-dev-00000000', 'ninguém em casa').ok, false)
  state.alive = false
  const dead = gui.note(paneId, 'a sessão morreu')
  assert.equal(dead.ok, false)
  assert.match(dead.error, /encerrou/u)
})

test('a nota vazia é recusada antes de sujar o fio', () => {
  const { gui, paneId } = registryHarness()
  assert.equal(gui.note(paneId, '   ').ok, false)
  assert.equal(
    gui.state(paneId).events.some(({ evt }) => evt.type === 'command-output'),
    false
  )
})

// O ⇪ QUE FICOU ESPERANDO. O dono pode clicar com o chat fechado (ou o app
// reinicia depois do clique): nada se persiste a mais — o TICKET já é durável —,
// e abrir a conversa é o momento de re-executar o estímulo. Mesma porta e mesma
// disciplina do despertador de boot dos ajudantes: só em ABERTURA de verdade.

test('abrir a conversa avisa o motor de missões — uma vez, e nunca num respawn', () => {
  const opened = []
  const timers = fakeTimers()
  const state = { alive: true, turnActive: false }
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    helperWakeTimer: timers.setTimer,
    helperInbox: new GuiHelperInbox()
  })
  gui.spawnSession = () => ({
    get alive() {
      return state.alive
    },
    get turnActive() {
      return state.turnActive
    },
    send: () => undefined,
    interrupt: () => true,
    kill: () => undefined
  })
  gui.attachIntegration({
    paneOpened: (paneId, projectId) => opened.push({ paneId, projectId })
  })
  const spawn = {
    paneId: 'gui-dev-abc12345',
    projectId: 'proj',
    cli: 'claude',
    configDir: 'seat-1',
    cwd: '/tmp'
  }

  assert.equal(gui.create(spawn).ok, true)
  assert.deepEqual(opened, [{ paneId: 'gui-dev-abc12345', projectId: 'proj' }])

  // remontagem da MESMA conversa (troca de aba): nada a re-estimular
  assert.equal(gui.create(spawn).ok, true)
  assert.equal(opened.length, 1)

  // respawn por troca de modo: é a MESMA conversa, e repetir o aviso aqui seria
  // o app cutucando o dono a cada clique dele no painel
  assert.equal(gui.create({ ...spawn, permissionMode: 'plan' }).ok, true)
  assert.equal(opened.length, 1, 'respawn não é abertura')
})

test('motor de missões que explode nunca impede a conversa de abrir', () => {
  const timers = fakeTimers()
  const gui = new GuiSessionRegistry({
    push: () => undefined,
    systemPromptFile: () => undefined,
    helperWakeTimer: timers.setTimer,
    helperInbox: new GuiHelperInbox()
  })
  gui.spawnSession = () => ({
    alive: true,
    turnActive: false,
    send: () => undefined,
    interrupt: () => true,
    kill: () => undefined
  })
  gui.attachIntegration({
    paneOpened: () => {
      throw new Error('a fila caiu')
    }
  })
  assert.equal(
    gui.create({
      paneId: 'gui-dev-abc12345',
      projectId: 'proj',
      cli: 'claude',
      configDir: 'seat-1',
      cwd: '/tmp'
    }).ok,
    true
  )
})
