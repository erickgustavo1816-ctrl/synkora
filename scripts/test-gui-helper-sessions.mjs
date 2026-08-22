import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GUI_HELPER_LONGRUN_ADVISORY,
  GUI_HELPER_LONGRUN_NOTICE_MS,
  GUI_HELPER_PROMPT_MAX_CHARS,
  GUI_HELPER_RESULT_MAX_CHARS,
  GUI_HELPER_RESULT_TRUNCATION_NOTICE,
  GUI_HELPER_RETRY_DELAY_MS,
  GUI_HELPER_RETRY_STARTUP_WINDOW_MS,
  GUI_HELPER_RUNAWAY_BACKSTOP,
  GUI_HELPER_SETTLED_MEMORY,
  GUI_HELPER_SPAWN_INTERVAL_MS,
  GUI_HELPER_STORE_RETENTION_MS,
  GUI_HELPER_TERMINAL_STATES,
  GUI_HELPER_WAIT_DEFAULT_SECONDS,
  GUI_HELPER_WAIT_MAX_SECONDS,
  GuiHelperEngine,
  capGuiHelperResult,
  clampHelperWaitSeconds,
  fleetEffortWarning,
  helperEffortDecision,
  isGuiHelperResumable,
  isGuiHelperSettled,
  isGuiHelperStoreDoc,
  persistableGuiHelperRecord,
  resolveHelperCli,
  sanitizeGuiHelperRecord,
  transientHelperFailure
} from '../src/main/guiHelperSessions.ts'

// MOTOR DOS AJUDANTES SEM ABA (D1 do design vinculante
// .synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md).
//
// O motor é PURO por desenho: os dois CLIs entram por ADAPTADOR injetado, o
// relógio e o temporizador também. É o que deixa a máquina de estados, o
// backstop anti-runaway, o long-poll e o AVISO de longa duração serem provados
// em node puro, sem spawnar um único processo — nenhum destes fatos deveria
// depender de olhar a lateral com o app aberto.
//
// Os fatos mecânicos citados aqui vêm das sondas de 2026-08-18 (probe-helper-matrix
// §2.4/§2.6/§5, probe-claude-fence §4, probe-codex-fence §B.3), nunca de suposição.

const DELEGATOR = {
  paneId: 'gui-dev-7e31d314',
  projectId: 'c0dad302-9999-8888-7777-666655554444',
  cwd: 'C:/Users/Erick/AppData/Roaming/synkora/worktrees/mission-7e31d314',
  cli: 'claude',
  model: 'opus[1m]',
  effort: 'high',
  seatId: 'seat-claude-gmail'
}

/** Delegador de outro pane — usado para provar que o escopo é POR PANE. */
const OTHER_DELEGATOR = {
  ...DELEGATOR,
  paneId: 'gui-dev-aaaaaaaa',
  seatId: 'seat-claude-hotmail'
}

/**
 * Um `GuiHelperStore` de memória — a MESMA forma que o `jsonStore` do main
 * entrega, sem tocar em disco. Ele guarda o documento SERIALIZADO de propósito:
 * é o que prova que o registro atravessa JSON de verdade (nada de referência
 * compartilhada mentindo que o round-trip funcionou).
 */
function memoryStore(seed = []) {
  const store = {
    saves: 0,
    doc: JSON.stringify(seed),
    load: () => JSON.parse(store.doc),
    save: (records) => {
      store.saves += 1
      store.doc = JSON.stringify(records)
    }
  }
  return store
}

function harness(over = {}) {
  const clock = { t: 1_700_000_000_000 }
  const spawns = []
  const changes = []
  const logs = []
  const timers = []
  const seatQueries = []
  let ids = 0

  const adapter = (cli) => (request, emit) => {
    const entry = { cli, request, emit, sent: [], disposed: 0 }
    spawns.push(entry)
    const boom = over.spawnThrows
    if (boom) throw new Error(typeof boom === 'string' ? boom : 'o CLI não subiu')
    entry.process = {
      send: (text) => entry.sent.push(text),
      dispose: () => {
        entry.disposed += 1
      }
    }
    // Adaptador que entrega DENTRO do próprio spawn (turno síncrono): o motor
    // ainda não segurou o processo quando o desfecho já aconteceu.
    if (over.emitOnSpawn) emit(over.emitOnSpawn)
    return entry.process
  }

  const resolveSeat =
    over.resolveSeat ??
    ((query) => ({
      seatId: query.preferredSeatId ?? `primeiro-${query.cli}`,
      configDir: `C:/cfg/${query.cli}`,
      name: `Conta ${query.cli}`
    }))

  const engine = new GuiHelperEngine({
    spawnClaude: adapter('claude'),
    spawnCodex: adapter('codex'),
    resolveSeat: (query) => {
      seatQueries.push(query)
      return resolveSeat(query)
    },
    ...(over.modelSupportsEffort ? { modelSupportsEffort: over.modelSupportsEffort } : {}),
    ...(over.store ? { store: over.store } : {}),
    // O DISCO DA ENTREGA (R5) e o DESCARTE dela (R6.2) entram pela mesma porta
    // do `store`: o motor não conhece arquivo, então a bancada observa os dois
    // sem escrever um byte.
    ...(over.deliver ? { deliver: over.deliver } : {}),
    ...(over.discardDelivery ? { discardDelivery: over.discardDelivery } : {}),
    // ESCALONADOR DESLIGADO POR PADRÃO NESTA BANCADA. A cadência de partida
    // (~2s entre processos) tem bloco PRÓPRIO mais abaixo; aqui os testes falam
    // da máquina de estados, e fazê-los conviver com a fila só acrescentaria
    // ruído de relógio a asserções que nada têm a ver com ela.
    // `defaultSpawnInterval` OMITE a chave — é como se prova que o padrão do
    // motor é o do dono, e não um valor que só existe na bancada.
    ...(over.defaultSpawnInterval ? {} : { spawnIntervalMs: over.spawnIntervalMs ?? 0 }),
    ...(over.retryDelayMs === undefined ? {} : { retryDelayMs: over.retryDelayMs }),
    now: () => clock.t,
    newId: () => `helper-${++ids}`,
    setTimer: (ms, fn) => {
      const timer = { ms, fn, cancelled: false, fired: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    onChange: (change) => changes.push(change),
    log: (entry) => logs.push(entry)
  })

  /** Avança o relógio e dispara o próximo temporizador pendente (fila de
   *  partida, respiro de re-tentativa, gravação adiada). */
  const tick = () => {
    const timer = timers.find((entry) => !entry.cancelled && !entry.fired)
    if (!timer) return false
    timer.fired = true
    clock.t += timer.ms
    timer.fn()
    return true
  }
  const drain = (limit = 500) => {
    for (let guard = 0; guard < limit; guard += 1) if (!tick()) return
    throw new Error('os temporizadores não drenaram')
  }

  return { engine, clock, spawns, changes, logs, timers, seatQueries, tick, drain }
}

/** Um ajudante já aberto — o caminho feliz de quase todo teste. */
function oneHelper(over = {}) {
  const kit = harness(over.harness)
  const outcome = kit.engine.spawn(DELEGATOR, [{ prompt: over.prompt ?? 'leia o diff e resuma' }])
  assert.equal(outcome.receipts.length, 1)
  assert.ok(outcome.receipts[0].ok, `spawn recusado: ${outcome.receipts[0].error}`)
  return { ...kit, helperId: outcome.receipts[0].helperId, spawn: kit.spawns[0] }
}

/** Dispara o temporizador mais recente do long-poll (o teto do próprio motor). */
function fireLastTimer(timers) {
  const timer = timers.at(-1)
  assert.ok(timer, 'o long-poll não armou temporizador nenhum')
  assert.equal(timer.cancelled, false, 'o temporizador já havia sido cancelado')
  timer.fn()
}

/** Avança o relógio até a próxima partida da fila e a dispara. */
function fireSpawnTimer({ timers, clock }) {
  const timer = timers.find((entry) => !entry.cancelled && !entry.fired)
  assert.ok(timer, 'a fila de partida não agendou o próximo ajudante')
  timer.fired = true
  clock.t += timer.ms
  timer.fn()
}

/**
 * Long-poll que NUNCA resolve é FALHA, nunca suíte travada. O relógio do motor
 * é injetado, então estes 2s são de parede e só existem como rede: um motor que
 * ignora o desfecho e espera o teto inteiro morre aqui com mensagem, em vez de
 * pendurar o `node --test` para sempre.
 */
function settledWithin(promise, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label}: o long-poll não resolveu`)),
        2_000
      )
      timer.unref?.()
    })
  ])
}

// ————— máquina de estados —————

test('spawning → working → done: o resultado é o texto final do ajudante', async () => {
  const { engine, helperId, spawn, changes } = oneHelper()

  assert.equal(engine.get(helperId).state, 'spawning')
  assert.deepEqual(
    changes.map((change) => change.kind),
    ['spawned']
  )

  spawn.emit({ type: 'activity', summary: 'Read src/main/index.ts' })
  assert.equal(engine.get(helperId).state, 'working')
  assert.equal(engine.get(helperId).lastActivity.summary, 'Read src/main/index.ts')

  spawn.emit({ type: 'text', text: 'olhei o diff' })
  spawn.emit({ type: 'result', isError: false })

  const record = engine.get(helperId)
  assert.equal(record.state, 'done')
  assert.equal(record.result, 'olhei o diff')
  assert.equal(record.failure, undefined)
  assert.ok(record.settledAt >= record.startedAt)
  assert.deepEqual(
    changes.map((change) => change.kind),
    ['spawned', 'activity', 'settled']
  )
})

test('o result com texto próprio vence o acumulado (o `resultText` dos dois motores)', () => {
  const { engine, helperId, spawn } = oneHelper()
  spawn.emit({ type: 'text', text: 'rascunho parcial' })
  spawn.emit({ type: 'result', isError: false, text: 'ENTREGA FINAL' })

  assert.equal(engine.get(helperId).result, 'ENTREGA FINAL')
})

test('result com erro e `fatal` viram failed com o motivo, nunca done vazio', () => {
  const erro = oneHelper()
  erro.spawn.emit({ type: 'result', isError: true, errorText: 'limite da conta estourou' })
  assert.equal(erro.engine.get(erro.helperId).state, 'failed')
  assert.match(erro.engine.get(erro.helperId).failure, /limite da conta estourou/u)

  const fatal = oneHelper()
  fatal.spawn.emit({ type: 'fatal', text: 'o binário sumiu do PATH' })
  assert.equal(fatal.engine.get(fatal.helperId).state, 'failed')
  assert.match(fatal.engine.get(fatal.helperId).failure, /o binário sumiu do PATH/u)
})

test('PROCESSO ENCERRADO É DESFECHO: claude é fire-and-forget (sonda S4 §2.6)', () => {
  // O `claude -p` entrega o result e MORRE SOZINHO com exit 0. Quem esperar um
  // desligamento explícito deixa o card aberto para sempre.
  const entregou = oneHelper()
  entregou.spawn.emit({ type: 'text', text: 'HELPER_OK' })
  entregou.spawn.emit({ type: 'closed', code: 0 })
  assert.equal(entregou.engine.get(entregou.helperId).state, 'done')
  assert.equal(entregou.engine.get(entregou.helperId).result, 'HELPER_OK')

  // Morrer SEM ter entregue nada é falha — e a falha nomeia o código de saída.
  const morreu = oneHelper()
  morreu.spawn.emit({ type: 'closed', code: 1 })
  assert.equal(morreu.engine.get(morreu.helperId).state, 'failed')
  assert.match(morreu.engine.get(morreu.helperId).failure, /1/u)
})

test('TODO desfecho descarta o processo — é o kill que o codex exige (sonda S4 §6)', () => {
  // O app-server do codex NUNCA encerra sozinho ao fim do turno. Chamar dispose
  // em todo desfecho é o que impede a frota de virar processo órfão.
  for (const settle of [
    (spawn) => spawn.emit({ type: 'result', isError: false, text: 'ok' }),
    (spawn) => spawn.emit({ type: 'result', isError: true, errorText: 'x' }),
    (spawn) => spawn.emit({ type: 'fatal', text: 'x' })
  ]) {
    const { spawn } = oneHelper()
    settle(spawn)
    assert.equal(spawn.disposed, 1, 'o processo do ajudante ficou vivo depois do desfecho')
  }
})

test('desfecho é IDEMPOTENTE: evento atrasado não ressuscita nem reescreve', () => {
  const { engine, helperId, spawn, changes } = oneHelper()
  spawn.emit({ type: 'result', isError: false, text: 'primeiro' })
  const settledAt = engine.get(helperId).settledAt

  spawn.emit({ type: 'result', isError: false, text: 'segundo' })
  spawn.emit({ type: 'text', text: 'texto tardio' })
  spawn.emit({ type: 'activity', summary: 'ferramenta tardia' })
  spawn.emit({ type: 'closed', code: 0 })

  const record = engine.get(helperId)
  assert.equal(record.state, 'done')
  assert.equal(record.result, 'primeiro')
  assert.equal(record.settledAt, settledAt)
  assert.equal(spawn.disposed, 1, 'o processo foi descartado duas vezes')
  assert.equal(
    changes.filter((change) => change.kind === 'settled').length,
    1,
    'o card do ajudante fechou duas vezes na lateral'
  )
})

test('cancel encerra como cancelled com o motivo do chamador', () => {
  const { engine, helperId, spawn } = oneHelper()

  const outcome = engine.cancel(helperId, 'o dono fechou o chat')
  assert.deepEqual(outcome, { ok: true })
  assert.equal(engine.get(helperId).state, 'cancelled')
  assert.match(engine.get(helperId).failure, /o dono fechou o chat/u)
  assert.equal(spawn.disposed, 1)

  // Cancelar de novo NÃO mente dizendo que cancelou algo.
  const again = engine.cancel(helperId)
  assert.equal(again.ok, false)
  assert.match(again.error, /encerrou/u)
})

test('spawn que estoura no adaptador vira recibo recusado, nunca ajudante fantasma', () => {
  const { engine, changes } = harness({ spawnThrows: true })
  const outcome = engine.spawn(DELEGATOR, [{ prompt: 'faça algo' }])

  assert.equal(outcome.receipts[0].ok, false)
  assert.match(outcome.receipts[0].error, /o CLI não subiu/u)
  assert.equal(engine.liveCount(DELEGATOR.paneId), 0)
  // O registro fica como failed: sumir sem rastro esconderia a queda do dono.
  const [snapshot] = engine.status(DELEGATOR.paneId)
  assert.equal(snapshot.state, 'failed')
  // O card abre e FECHA — nunca fecha um card que nunca abriu.
  assert.deepEqual(
    changes.map((change) => change.kind),
    ['spawned', 'settled']
  )
})

test('adaptador que entrega DENTRO do spawn não deixa processo sem dono', () => {
  // O desfecho roda antes de o motor guardar o processo devolvido: sem a
  // recuperação, esse processo ficaria vivo para sempre — órfão do app-server
  // do codex é exatamente o que a sonda §6 manda evitar.
  const { engine, spawns } = harness({
    emitOnSpawn: { type: 'result', isError: false, text: 'instantâneo' }
  })
  const outcome = engine.spawn(DELEGATOR, [{ prompt: 'rápido' }])

  assert.equal(outcome.receipts[0].ok, true)
  assert.equal(engine.get(outcome.receipts[0].helperId).state, 'done')
  assert.equal(spawns[0].disposed, 1, 'o processo entregue depois do desfecho ficou órfão')
})

test('modelo/conta/apelido vazios são AUSÊNCIA, nunca valor', () => {
  const { engine, seatQueries } = harness()
  const outcome = engine.spawn(DELEGATOR, [
    { prompt: 'trabalhe', model: '   ', seatId: '  ', name: '  ' }
  ])

  assert.equal(outcome.receipts[0].model, DELEGATOR.model)
  assert.equal(outcome.receipts[0].name, undefined)
  assert.deepEqual(seatQueries, [{ cli: 'claude', preferredSeatId: DELEGATOR.seatId }])
})

// ————— backstop anti-runaway (NUNCA uma cota) —————

test('o backstop é de 100 vivos por pane e a recusa NOMEIA o bug em laço', () => {
  const { engine } = harness()
  const cheia = engine.spawn(
    DELEGATOR,
    Array.from({ length: GUI_HELPER_RUNAWAY_BACKSTOP }, (_, index) => ({
      prompt: `fatia ${index}`
    }))
  )
  assert.equal(cheia.receipts.filter((receipt) => receipt.ok).length, GUI_HELPER_RUNAWAY_BACKSTOP)
  assert.equal(engine.liveCount(DELEGATOR.paneId), GUI_HELPER_RUNAWAY_BACKSTOP)

  const estourou = engine.spawn(DELEGATOR, [{ prompt: 'o de número 101' }])
  assert.equal(estourou.receipts[0].ok, false)
  // Ordem do dono (18/08): "não precisa ter um teto — ele quiser delegar vinte,
  // trinta, o problema é dele". A recusa tem de LER como trava de bug.
  assert.match(estourou.receipts[0].error, /laço|loop|bug/iu)
  assert.ok(
    !/cota|quota|limite de uso/iu.test(estourou.receipts[0].error),
    'a recusa do backstop foi apresentada como quota'
  )
  assert.match(estourou.receipts[0].error, new RegExp(String(GUI_HELPER_RUNAWAY_BACKSTOP), 'u'))
})

test('o backstop conta dentro do PRÓPRIO lote e libera vaga no desfecho', () => {
  const { engine, spawns } = harness()
  const lote = engine.spawn(
    DELEGATOR,
    Array.from({ length: GUI_HELPER_RUNAWAY_BACKSTOP + 3 }, (_, index) => ({
      prompt: `fatia ${index}`
    }))
  )
  assert.equal(lote.receipts.filter((receipt) => receipt.ok).length, GUI_HELPER_RUNAWAY_BACKSTOP)
  assert.equal(lote.receipts.filter((receipt) => !receipt.ok).length, 3)

  spawns[0].emit({ type: 'result', isError: false, text: 'pronto' })
  const depois = engine.spawn(DELEGATOR, [{ prompt: 'agora cabe' }])
  assert.equal(depois.receipts[0].ok, true)
})

test('o backstop é POR PANE: um chat cheio não trava o vizinho', () => {
  const { engine } = harness()
  engine.spawn(
    DELEGATOR,
    Array.from({ length: GUI_HELPER_RUNAWAY_BACKSTOP }, () => ({ prompt: 'fatia' }))
  )
  const vizinho = engine.spawn(OTHER_DELEGATOR, [{ prompt: 'trabalho do outro chat' }])
  assert.equal(vizinho.receipts[0].ok, true)
})

// ————— long-poll: o teto é do SERVIDOR (sonda S3) —————

test('o long-poll resolve NA HORA em que o ajudante encerra', async () => {
  const { engine, helperId, spawn, timers } = oneHelper()

  const pending = engine.result(helperId, 200)
  assert.equal(timers.length, 1, 'o long-poll não armou o teto do motor')
  assert.equal(timers[0].ms, 200_000)

  spawn.emit({ type: 'result', isError: false, text: 'ENTREGA' })
  const outcome = await settledWithin(pending, 'desfecho durante a espera')

  assert.equal(outcome.ok, true)
  assert.equal(outcome.pending, false)
  assert.equal(outcome.state, 'done')
  assert.equal(outcome.result, 'ENTREGA')
  assert.equal(timers[0].cancelled, true, 'o temporizador do teto ficou pendurado')
})

test('estourar o teto é resposta HONESTA: "ainda trabalhando", nunca erro', async () => {
  const { engine, helperId, clock, timers, spawn } = oneHelper()
  spawn.emit({ type: 'activity', summary: 'Grep src/main' })

  const pending = engine.result(helperId, 45)
  clock.t += 45_000
  fireLastTimer(timers)
  const outcome = await settledWithin(pending, 'teto estourado')

  assert.equal(outcome.ok, true)
  assert.equal(outcome.pending, true)
  assert.equal(outcome.state, 'working')
  assert.equal(outcome.result, undefined)
  assert.equal(outcome.failure, undefined)
  assert.equal(outcome.waitedMs, 45_000)
  // O delegador re-chama: a fotografia tem de vir junto para ele decidir.
  assert.equal(outcome.snapshot.helperId, helperId)
})

test('O TETO É DO MOTOR: o pedido do cliente é grampeado nos 240s', async () => {
  const { engine, helperId, timers, spawn } = oneHelper()

  engine.result(helperId, 9_999)
  assert.equal(timers.at(-1).ms, GUI_HELPER_WAIT_MAX_SECONDS * 1000)
  spawn.emit({ type: 'result', isError: false, text: 'x' })

  assert.equal(clampHelperWaitSeconds(undefined), GUI_HELPER_WAIT_DEFAULT_SECONDS)
  assert.equal(clampHelperWaitSeconds(9_999), GUI_HELPER_WAIT_MAX_SECONDS)
  assert.equal(clampHelperWaitSeconds(-5), 0)
  assert.equal(clampHelperWaitSeconds('tanto faz'), GUI_HELPER_WAIT_DEFAULT_SECONDS)
  assert.equal(clampHelperWaitSeconds(30), 30)
  // Sonda D2/D3 do claude: a tool é cortada em EXATOS 60s por default, e o
  // MCP_TOOL_TIMEOUT levantado ainda não é motivo para confiar no cliente.
  assert.ok(GUI_HELPER_WAIT_DEFAULT_SECONDS <= 55)
})

test('esperar zero devolve a fotografia na hora, sem armar temporizador', async () => {
  const { engine, helperId, timers } = oneHelper()
  const outcome = await engine.result(helperId, 0)

  assert.equal(outcome.ok, true)
  assert.equal(outcome.pending, true)
  assert.equal(timers.length, 0)
})

// ————— R22.3: o long-poll também acorda quando o DONO fala —————
//
// Caso real (print de 19/08): o delegador num laço de `helper_result` esperando
// a frota, o dono manda mensagem com "enviar agora" e o agente não lê. A fala
// dele passa a ir para o pote (`guiOwnerMail`) e a viajar de carona no próximo
// resultado de tool — mas, sem um despertar por PANE, "o próximo resultado" só
// chegaria quando o teto de 240s estourasse. Este é o degrau que faz a carona
// sair em segundos.

test('R22.3 — o despertar por PANE resolve o long-poll na hora, sem mudar estado', async () => {
  const { engine, helperId, timers, spawn } = oneHelper()
  spawn.emit({ type: 'activity', summary: 'Grep src/main' })
  assert.equal(
    typeof engine.wakePane,
    'function',
    'o motor não tem o despertar por pane (R22.3) — a fala do dono esperaria o teto do long-poll'
  )

  const pending = engine.result(helperId, 240)
  assert.equal(timers.length, 1, 'o long-poll não armou o teto do motor')

  // Chegou fala do dono no pote deste pane: quem espera acorda AGORA.
  assert.equal(engine.wakePane(DELEGATOR.paneId), 1, 'nenhuma espera foi acordada')
  const outcome = await settledWithin(pending, 'despertar por mensagem do dono')

  assert.equal(outcome.ok, true)
  assert.equal(outcome.pending, true, 'acordar não pode inventar desfecho')
  assert.equal(outcome.state, 'working', 'o ajudante continua trabalhando')
  assert.equal(outcome.failure, undefined)
  assert.equal(timers[0].cancelled, true, 'o temporizador do teto ficou pendurado')
  // Idempotente e barato: sem ninguém esperando, o despertar não faz nada.
  assert.equal(engine.wakePane(DELEGATOR.paneId), 0)
})

test('R22.3 — o despertar é POR PANE: a espera do chat vizinho não é tocada', async () => {
  const { engine, spawns } = harness()
  const meu = engine.spawn(DELEGATOR, [{ prompt: 'fatia deste chat' }]).receipts[0]
  const vizinho = engine.spawn(OTHER_DELEGATOR, [{ prompt: 'fatia do outro chat' }]).receipts[0]
  assert.equal(meu.ok, true)
  assert.equal(vizinho.ok, true)

  const esperaVizinha = engine.result(vizinho.helperId, 240)
  assert.equal(engine.wakePane(DELEGATOR.paneId), 0, 'acordou a espera de outro chat')

  // A espera vizinha continua de pé: só o desfecho dela a resolve.
  spawns[1].emit({ type: 'result', isError: false, text: 'entrega do vizinho' })
  const outcome = await settledWithin(esperaVizinha, 'desfecho do vizinho')
  assert.equal(outcome.pending, false)
  assert.equal(outcome.state, 'done')
})

test('ajudante desconhecido recusa com o id na mensagem', async () => {
  const { engine } = harness()
  const outcome = await engine.result('helper-fantasma')

  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /helper-fantasma/u)
})

test('LEITURA IDEMPOTENTE: reler devolve exatamente o mesmo resultado', async () => {
  const { engine, helperId, spawn } = oneHelper()
  spawn.emit({ type: 'result', isError: false, text: 'a entrega inteira' })

  const first = await settledWithin(engine.result(helperId), 'primeira leitura')
  const second = await settledWithin(engine.result(helperId, 240), 'releitura')
  const third = await settledWithin(engine.result(helperId, 0), 'releitura sem espera')

  assert.equal(first.result, 'a entrega inteira')
  assert.equal(second.result, first.result)
  assert.equal(third.result, first.result)
  assert.equal(second.settledAt, first.settledAt)
  assert.equal(spawn.disposed, 1, 'reler o resultado descartou o processo de novo')
})

// ————— teto de 64KB —————

test('o resultado é cortado em 64KB COM aviso, e o aviso cabe dentro do teto', () => {
  const inteiro = capGuiHelperResult('x'.repeat(GUI_HELPER_RESULT_MAX_CHARS))
  assert.equal(inteiro.truncated, false)
  assert.equal(inteiro.text.length, GUI_HELPER_RESULT_MAX_CHARS)

  const cortado = capGuiHelperResult('y'.repeat(200_000))
  assert.equal(cortado.truncated, true)
  assert.equal(
    cortado.text.length,
    GUI_HELPER_RESULT_MAX_CHARS,
    'o aviso empurrou a entrega para fora do teto que ela deveria respeitar'
  )
  assert.ok(cortado.text.endsWith(GUI_HELPER_RESULT_TRUNCATION_NOTICE))
})

test('o motor aplica o teto no desfecho e carimba o corte no registro', async () => {
  const { engine, helperId, spawn } = oneHelper()
  spawn.emit({ type: 'result', isError: false, text: 'z'.repeat(200_000) })

  const record = engine.get(helperId)
  assert.equal(record.result.length, GUI_HELPER_RESULT_MAX_CHARS)
  assert.equal(record.resultTruncated, true)

  const outcome = await settledWithin(engine.result(helperId), 'leitura do resultado cortado')
  assert.equal(outcome.truncated, true)
  assert.ok(outcome.result.endsWith(GUI_HELPER_RESULT_TRUNCATION_NOTICE))
})

test('prompt vazio ou absurdo é RECUSADO, nunca truncado', () => {
  const { engine } = harness()
  const outcome = engine.spawn(DELEGATOR, [
    { prompt: '   ' },
    { prompt: 'a'.repeat(GUI_HELPER_PROMPT_MAX_CHARS + 1) }
  ])

  assert.equal(outcome.receipts[0].ok, false)
  assert.match(outcome.receipts[0].error, /vazi/iu)
  assert.equal(outcome.receipts[1].ok, false)
  assert.match(outcome.receipts[1].error, new RegExp(String(GUI_HELPER_PROMPT_MAX_CHARS), 'u'))
  assert.equal(engine.liveCount(), 0)
})

// ————— R19: o ajudante NÃO tem teto de tempo —————
//
// Ordem do dono (2026-08-19, com o print do caso real: o teto derrubou um
// ajudante no meio do trabalho): "o subagente pode ficar o tempo que for, não
// tem sentido derrubar depois de 30 minutos". Pela régua da casa é o caso de
// manual — guarda dura só protege autoridade/verificabilidade, e "deve ter
// travado" é JULGAMENTO, que vira advisory auditado.
//
// Os três testes do watchdog-que-matava MORRERAM com a feature (o teto de 30
// min, a vassoura que assentava e o long-poll que devolvia um morto). O que
// entrou no lugar prova o contrário deles: quem trabalha muito segue vivo, o
// aviso sai uma vez e é só aviso, e as SAÍDAS SANCIONADAS — que são a rede que
// fica — continuam idênticas depois dos 30 min.

test('aos 31 min o ajudante CONTINUA vivo e trabalhando — o teto de tempo morreu', () => {
  const { engine, helperId, clock, spawn, changes } = oneHelper()
  spawn.emit({ type: 'activity', summary: 'Read src/main/index.ts' })

  clock.t += GUI_HELPER_LONGRUN_NOTICE_MS + 60_000

  // TODA operação pública varre — e nenhuma delas pode assentar por relógio.
  assert.equal(engine.get(helperId).state, 'working')
  assert.equal(engine.status(DELEGATOR.paneId)[0].state, 'working')
  assert.equal(engine.liveCount(DELEGATOR.paneId), 1, 'o motor derrubou um ajudante por relógio')
  assert.equal(spawn.disposed, 0, 'o processo do ajudante foi morto pelo tempo')
  assert.deepEqual(
    changes.map((change) => change.kind),
    ['spawned', 'activity'],
    'o aviso de longa duração vazou como desfecho para a lateral'
  )

  // E ele ENTREGA depois disso, como qualquer outro: a hora extra não estragou
  // nada — é exatamente o ajudante que o dono viu morrer.
  spawn.emit({ type: 'result', isError: false, text: 'terminei, depois de uma hora' })
  const record = engine.get(helperId)
  assert.equal(record.state, 'done')
  assert.equal(record.result, 'terminei, depois de uma hora')
  assert.equal(record.failure, undefined)
})

test('o advisory de 30 min sai UMA vez, com o decorrido e as saídas na cara', () => {
  // Este ajudante NUNCA falou (nem um evento): é o "zumbi" do desenho antigo.
  // Ele continua vivo e VISÍVEL — o cronômetro cresce, e quem julga é o dono.
  const { engine, helperId, clock, logs } = oneHelper()

  clock.t += GUI_HELPER_LONGRUN_NOTICE_MS - 1
  assert.deepEqual(engine.sweep(), [], 'o aviso saiu antes da hora')

  clock.t += 1
  assert.deepEqual(
    engine.sweep().map((record) => record.helperId),
    [helperId],
    'a varredura devolve quem CRUZOU o aviso'
  )

  const avisos = logs.filter((entry) => entry.event === 'helper-longrun')
  assert.equal(avisos.length, 1)
  assert.equal(avisos[0].helperId, helperId)
  assert.equal(avisos[0].paneId, DELEGATOR.paneId)
  assert.equal(avisos[0].detail.elapsedMs, GUI_HELPER_LONGRUN_NOTICE_MS)
  // O texto NOMEIA A RECEITA (regra da casa): aviso sem saída é beco.
  assert.equal(avisos[0].detail.advisory, GUI_HELPER_LONGRUN_ADVISORY)
  assert.match(GUI_HELPER_LONGRUN_ADVISORY, /segue vivo/iu)
  assert.match(GUI_HELPER_LONGRUN_ADVISORY, /■/u)
  assert.match(GUI_HELPER_LONGRUN_ADVISORY, /helper_resume/u)
  assert.match(GUI_HELPER_LONGRUN_ADVISORY, /helper_cancel/u)

  // UMA vez por vida: varrer de novo, e mais meia hora depois, não repete.
  assert.deepEqual(engine.sweep(), [])
  clock.t += GUI_HELPER_LONGRUN_NOTICE_MS
  assert.deepEqual(engine.sweep(), [])
  assert.equal(logs.filter((entry) => entry.event === 'helper-longrun').length, 1)
  assert.equal(engine.get(helperId).state, 'spawning', 'o mudo de uma hora foi assentado')
})

test('o resume RE-ARMA o aviso: a segunda vida tem os seus trinta minutos', () => {
  const { engine, clock, logs, spawns } = harness()
  const helperId = engine.spawn(DELEGATOR, [{ prompt: 'trabalho longo' }]).receipts[0].helperId
  spawns[0].emit({ type: 'session', sessionId: 'sess-longa' })

  clock.t += GUI_HELPER_LONGRUN_NOTICE_MS
  assert.equal(engine.sweep().length, 1)
  assert.equal(engine.get(helperId).longRunNoticedAt, clock.t)

  // O ■ do dono e a volta: o carimbo sai junto com o cronômetro (o `startedAt`
  // já re-armava; o aviso anda com ele, senão a segunda vida nasceria avisada).
  engine.interruptPane(DELEGATOR.paneId, 'o dono apertou o ■')
  assert.deepEqual(engine.resume(helperId), { ok: true })
  assert.equal(engine.get(helperId).longRunNoticedAt, undefined, 'a segunda vida nasceu avisada')

  clock.t += GUI_HELPER_LONGRUN_NOTICE_MS - 1
  assert.deepEqual(engine.sweep(), [], 'o aviso da volta contou o tempo da vida anterior')
  clock.t += 1
  assert.equal(engine.sweep().length, 1)
  assert.equal(logs.filter((entry) => entry.event === 'helper-longrun').length, 2)
})

test('a espera longa não vira morte: o long-poll devolve "ainda trabalhando"', async () => {
  const { engine, helperId, clock, timers, logs } = oneHelper()

  const pending = engine.result(helperId, 240)
  clock.t += GUI_HELPER_LONGRUN_NOTICE_MS
  fireLastTimer(timers)
  const outcome = await settledWithin(pending, 'a espera atravessou os 30 min')

  assert.equal(outcome.ok, true)
  assert.equal(outcome.pending, true, 'o teto da espera encerrou um ajudante vivo')
  assert.equal(outcome.state, 'spawning')
  assert.equal(outcome.snapshot.elapsedMs, GUI_HELPER_LONGRUN_NOTICE_MS)
  // A varredura do fim da espera deixou a AUDITORIA em dia — e só isso.
  assert.equal(logs.filter((entry) => entry.event === 'helper-longrun').length, 1)
  assert.equal(engine.get(helperId).state, 'spawning')
})

test('as saídas sancionadas seguem inteiras DEPOIS do aviso (■, descarte, boot)', () => {
  // O ■ DO DONO: interrompe PRESERVANDO, e do interrompido se volta.
  const parado = oneHelper()
  parado.clock.t += GUI_HELPER_LONGRUN_NOTICE_MS + 5_000
  assert.equal(parado.engine.interruptPane(DELEGATOR.paneId, 'o dono apertou o ■'), 1)
  const interrompido = parado.engine.get(parado.helperId)
  assert.equal(interrompido.state, 'interrupted')
  assert.equal(isGuiHelperResumable(interrompido.state), true)
  assert.equal(parado.spawn.disposed, 1, 'o ■ deixou o processo vivo')

  // HELPER_CANCEL: descarte, mesmo depois de horas de trabalho.
  const descartado = oneHelper()
  descartado.clock.t += GUI_HELPER_LONGRUN_NOTICE_MS * 4
  assert.deepEqual(descartado.engine.cancel(descartado.helperId, 'não quero mais'), { ok: true })
  assert.equal(descartado.engine.get(descartado.helperId).state, 'cancelled')
  assert.equal(descartado.spawn.disposed, 1)

  // O APP FECHOU: o boot reencontra o de horas como INTERROMPIDO e retomável —
  // nunca como "falhou por tempo", que é o que o teto deixava no disco.
  const store = memoryStore()
  const primeiro = harness({ store })
  const vivo = primeiro.engine.spawn(DELEGATOR, [{ prompt: 'longo' }]).receipts[0].helperId
  primeiro.spawns[0].emit({ type: 'session', sessionId: 'sess-boot' })
  primeiro.clock.t += GUI_HELPER_LONGRUN_NOTICE_MS + 1
  primeiro.engine.sweep()
  assert.equal(primeiro.engine.interruptAll('o app foi fechado'), 1)

  const segundo = harness({ store })
  assert.equal(segundo.engine.get(vivo).state, 'interrupted')
  assert.deepEqual(segundo.engine.resume(vivo), { ok: true })
})

test('o carimbo do aviso atravessa o disco — a régua alvejada o reconstrói', () => {
  const store = memoryStore()
  const { engine, clock, drain } = harness({ store })
  const helperId = engine.spawn(DELEGATOR, [{ prompt: 'longo' }]).receipts[0].helperId

  clock.t += GUI_HELPER_LONGRUN_NOTICE_MS
  assert.equal(engine.sweep().length, 1)
  const vivo = engine.get(helperId)
  assert.equal(vivo.state, 'spawning', 'o aviso assentou o ajudante')
  const carimbo = vivo.longRunNoticedAt
  assert.equal(carimbo, vivo.startedAt + GUI_HELPER_LONGRUN_NOTICE_MS)

  // O carimbo espera a BATIDA (não é desfecho) e atravessa o JSON inteiro.
  drain()
  const noDisco = JSON.parse(store.doc).find((record) => record.helperId === helperId)
  assert.equal(noDisco.longRunNoticedAt, carimbo, 'o carimbo não chegou ao disco')
  assert.equal(
    sanitizeGuiHelperRecord(noDisco).longRunNoticedAt,
    carimbo,
    'a régua alvejada do boot comeu o carimbo na volta'
  )
})

// ————— fotografia do pane —————

test('status é POR PANE, em ordem de criação, e não despeja o resultado', () => {
  const { engine, spawns, clock } = harness()
  const outcome = engine.spawn(DELEGATOR, [
    { prompt: 'primeiro', name: 'diff' },
    { prompt: 'segundo', name: 'testes' }
  ])
  clock.t += 5_000
  engine.spawn(OTHER_DELEGATOR, [{ prompt: 'de outro chat' }])
  spawns[0].emit({ type: 'context', contextTokens: 12_345 })
  spawns[0].emit({ type: 'result', isError: false, text: 'entrega enorme' })

  const snapshots = engine.status(DELEGATOR.paneId)
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.helperId),
    outcome.receipts.map((receipt) => receipt.helperId)
  )
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.name),
    ['diff', 'testes']
  )
  assert.equal(snapshots[0].state, 'done')
  assert.equal(snapshots[0].contextTokens, 12_345)
  assert.equal(snapshots[0].hasResult, true)
  assert.equal(snapshots[0].result, undefined, 'a fotografia despejou a entrega inteira')
  assert.equal(snapshots[1].state, 'spawning')
  assert.equal(snapshots[1].elapsedMs, 5_000)
  assert.equal(engine.status(OTHER_DELEGATOR.paneId).length, 1)
})

test('a atividade é registrada sempre e ANUNCIADA com throttle', () => {
  const { engine, helperId, spawn, changes, clock } = oneHelper()

  spawn.emit({ type: 'activity', summary: 'Read a.ts' })
  clock.t += 500
  spawn.emit({ type: 'activity', summary: 'Read b.ts' })
  clock.t += 5_000
  spawn.emit({ type: 'activity', summary: 'Edit c.ts' })

  // O registro é sempre o ÚLTIMO: a lateral nunca mostra ferramenta velha.
  assert.equal(engine.get(helperId).lastActivity.summary, 'Edit c.ts')
  const anunciadas = changes
    .filter((change) => change.kind === 'activity')
    .map((change) => change.record.lastActivity.summary)
  assert.deepEqual(anunciadas, ['Read a.ts', 'Edit c.ts'])
})

// ————— ciclo de vida amarrado ao delegador —————

test('cancelPane mata os ajudantes daquele chat — e só deles', () => {
  const { engine, spawns } = harness()
  engine.spawn(DELEGATOR, [{ prompt: 'a' }, { prompt: 'b' }])
  engine.spawn(OTHER_DELEGATOR, [{ prompt: 'c' }])

  const killed = engine.cancelPane(DELEGATOR.paneId, 'o chat foi fechado')
  assert.equal(killed, 2)
  assert.equal(spawns[0].disposed, 1)
  assert.equal(spawns[1].disposed, 1)
  assert.equal(spawns[2].disposed, 0, 'o cancelamento vazou para o chat vizinho')
  assert.equal(engine.liveCount(OTHER_DELEGATOR.paneId), 1)

  for (const snapshot of engine.status(DELEGATOR.paneId)) {
    assert.equal(snapshot.state, 'cancelled')
    assert.match(snapshot.failure, /o chat foi fechado/u)
  }
  assert.equal(engine.cancelPane(DELEGATOR.paneId), 0)
})

test('forgetPane é o chat que sumiu de vez: cancela E esquece', () => {
  // Sem isto a memória de encerrados de um pane morto ficaria para sempre — o
  // cancelPane preserva os registros de propósito (a lateral ainda os mostra).
  const { engine, spawns } = harness()
  engine.spawn(DELEGATOR, [{ prompt: 'a' }, { prompt: 'b' }])
  engine.spawn(OTHER_DELEGATOR, [{ prompt: 'c' }])
  spawns[0].emit({ type: 'result', isError: false, text: 'entregue' })

  assert.equal(engine.forgetPane(DELEGATOR.paneId, 'o chat foi fechado'), 1)
  assert.equal(engine.status(DELEGATOR.paneId).length, 0)
  assert.equal(spawns[1].disposed, 1, 'o ajudante vivo do pane esquecido ficou solto')
  assert.equal(engine.status(OTHER_DELEGATOR.paneId).length, 1, 'o vizinho foi esquecido junto')
  assert.equal(engine.size, 1)
})

test('o QUIT interrompe, nunca descarta (R6.1) — e nenhum processo sobrevive', () => {
  // Ordem do dono (R6.1): "fechar o app" é INTERRUPÇÃO. O `will-quit` do índice
  // chama `interruptAll` — o processo morre, o registro fica retomável, e nada é
  // descartado por trás do dono. O apelido `cancelAll` da onda A MORREU junto
  // com a chamada antiga: dois nomes para o mesmo verbo é como a semântica de
  // descarte volta por distração.
  const { engine, spawns } = harness()
  engine.spawn(DELEGATOR, [{ prompt: 'a' }, { prompt: 'b' }])
  engine.spawn(OTHER_DELEGATOR, [{ prompt: 'c' }])

  assert.equal(typeof engine.cancelAll, 'undefined', 'o apelido de descarte continua vivo no motor')
  assert.equal(engine.interruptAll('o app foi fechado'), 3)
  assert.equal(engine.liveCount(), 0)
  for (const spawn of spawns) assert.equal(spawn.disposed, 1)
  for (const snapshot of engine.status(DELEGATOR.paneId)) {
    assert.equal(snapshot.state, 'interrupted', 'o quit descartou a frota do dono')
  }
  assert.equal(engine.interruptAll(), 0)
})

test('send dirige o ajudante VIVO e recusa o que já encerrou', () => {
  const { engine, helperId, spawn } = oneHelper()

  assert.deepEqual(engine.send(helperId, 'troca de rumo: mexe só no CSS'), { ok: true })
  assert.deepEqual(spawn.sent, ['troca de rumo: mexe só no CSS'])

  assert.equal(engine.send(helperId, '   ').ok, false)
  assert.equal(engine.send('helper-fantasma', 'oi').ok, false)

  spawn.emit({ type: 'result', isError: false, text: 'pronto' })
  const depois = engine.send(helperId, 'mais uma coisa')
  assert.equal(depois.ok, false)
  assert.match(depois.error, /encerrou/u)
  assert.equal(spawn.sent.length, 1)
})

// ————— resolução modelo → CLI → conta —————

test('resolveHelperCli: gpt-* é codex, todo o resto é claude', () => {
  for (const model of ['gpt-5.4-mini', 'GPT-5.6-Sol', '  gpt-5.2-codex ']) {
    assert.equal(resolveHelperCli(model), 'codex', model)
  }
  for (const model of ['opus', 'opus[1m]', 'claude-fable-5[1m]', 'sonnet', 'haiku', '']) {
    assert.equal(resolveHelperCli(model), 'claude', model)
  }
})

test('o ajudante CLONA o delegador quando o pedido não diz nada', () => {
  const { engine, spawns, seatQueries } = harness()
  const outcome = engine.spawn(DELEGATOR, [{ prompt: 'clone' }])

  assert.equal(outcome.receipts[0].cli, 'claude')
  assert.equal(outcome.receipts[0].model, DELEGATOR.model)
  assert.equal(outcome.receipts[0].effort, DELEGATOR.effort)
  assert.equal(spawns[0].cli, 'claude')
  assert.equal(spawns[0].request.model, DELEGATOR.model)
  assert.equal(spawns[0].request.cwd, DELEGATOR.cwd)
  // Mesmo CLI ⇒ mesma conta do delegador.
  assert.deepEqual(seatQueries, [{ cli: 'claude', preferredSeatId: DELEGATOR.seatId }])
  assert.equal(outcome.receipts[0].seatId, DELEGATOR.seatId)
})

test('CROSS-CLI é cidadão de primeira classe: a conta vem do resolvedor', () => {
  const { engine, spawns, seatQueries } = harness()
  const outcome = engine.spawn(DELEGATOR, [{ prompt: 'gpt no chat claude', model: 'gpt-5.6-sol' }])

  assert.equal(outcome.receipts[0].ok, true)
  assert.equal(outcome.receipts[0].cli, 'codex')
  assert.equal(spawns[0].cli, 'codex')
  // A conta do delegador é de OUTRO binário: pedi-la seria abrir na conta errada.
  assert.deepEqual(seatQueries, [{ cli: 'codex' }])
  assert.equal(outcome.receipts[0].seatId, 'primeiro-codex')
  assert.equal(spawns[0].request.seat.configDir, 'C:/cfg/codex')
})

test('a conta PEDIDA no item vence a do delegador', () => {
  const { engine, seatQueries } = harness()
  engine.spawn(DELEGATOR, [{ prompt: 'na outra conta', seatId: 'seat-claude-hotmail' }])

  assert.deepEqual(seatQueries, [{ cli: 'claude', preferredSeatId: 'seat-claude-hotmail' }])
})

test('sem conta logada daquele CLI a recusa é CLARA — nunca spawn na conta errada', () => {
  const { engine } = harness({ resolveSeat: () => undefined })
  const outcome = engine.spawn(DELEGATOR, [{ prompt: 'x', model: 'gpt-5.6-sol' }])

  assert.equal(outcome.receipts[0].ok, false)
  assert.match(outcome.receipts[0].error, /codex/u)
  assert.match(outcome.receipts[0].error, /logad/iu)
  assert.equal(outcome.receipts[0].name, undefined)
})

// ————— effort: as duas armadilhas medidas nas sondas —————

test('effort não viaja entre CLIs — as escalas são diferentes', () => {
  // claude: low..max; codex: minimal/low/medium/high. Herdar "max" para o codex
  // seria mandar um nível que o binário não conhece.
  const cruzado = helperEffortDecision({
    cli: 'codex',
    delegatorCli: 'claude',
    delegatorEffort: 'max',
    model: 'gpt-5.6-sol'
  })
  assert.equal(cruzado.send, undefined)
  assert.equal(cruzado.applied, undefined)
  assert.match(cruzado.dropped, /max/u)

  // Mas o pedido EXPLÍCITO do delegador manda, cross-CLI ou não.
  const explicito = helperEffortDecision({
    cli: 'codex',
    delegatorCli: 'claude',
    requested: 'low',
    delegatorEffort: 'max',
    model: 'gpt-5.6-sol'
  })
  assert.equal(explicito.send, 'low')
  assert.equal(explicito.applied, 'low')
  assert.equal(explicito.dropped, undefined)
})

test('claude: modelo SEM supportsEffort não recebe o flag (sonda S4 §2.4)', () => {
  // O haiku engole `--effort` sem aviso nenhum. Mandar não quebra — mas a UI
  // mentiria exibindo "haiku · low" como se o nível tivesse efeito.
  const engolido = helperEffortDecision({
    cli: 'claude',
    delegatorCli: 'claude',
    requested: 'low',
    model: 'haiku',
    supportsEffort: false
  })
  assert.equal(engolido.send, undefined)
  assert.equal(engolido.applied, undefined)
  assert.match(engolido.dropped, /haiku/u)

  const aceito = helperEffortDecision({
    cli: 'claude',
    delegatorCli: 'claude',
    requested: 'max',
    model: 'opus[1m]',
    supportsEffort: true
  })
  assert.deepEqual(aceito, { send: 'max', applied: 'max' })

  // Catálogo ainda não carregado (undefined) NÃO é "não suporta": derrubar o
  // effort de toda frota claude por falta de catálogo seria pior que o rótulo.
  const semCatalogo = helperEffortDecision({
    cli: 'claude',
    delegatorCli: 'claude',
    requested: 'high',
    model: 'opus[1m]'
  })
  assert.equal(semCatalogo.send, 'high')
})

test('o motor consulta o catálogo e carimba a queda no recibo', () => {
  const { engine, spawns } = harness({
    modelSupportsEffort: (query) => (query.model === 'haiku' ? false : true)
  })
  const outcome = engine.spawn(DELEGATOR, [{ prompt: 'barato', model: 'haiku', effort: 'low' }])

  assert.equal(outcome.receipts[0].effort, undefined)
  assert.match(outcome.receipts[0].effortDropped, /haiku/u)
  assert.equal(spawns[0].request.effort, undefined, 'o flag foi para o CLI que o engole')
})

test('fleetEffortWarning: só alarma onde o cache de fato quebra (sonda S4 §2.3)', () => {
  // Mesmo modelo claude com efforts diferentes = cache-miss cheio (medido: 3,7×).
  const misto = fleetEffortWarning([
    { cli: 'claude', model: 'opus[1m]', effort: 'low' },
    { cli: 'claude', model: 'opus[1m]', effort: 'max' }
  ])
  assert.ok(misto)
  assert.match(misto, /opus\[1m\]/u)
  assert.match(misto, /low/u)
  assert.match(misto, /max/u)

  // Frota uniforme: nada a dizer.
  assert.equal(
    fleetEffortWarning([
      { cli: 'claude', model: 'opus[1m]', effort: 'max' },
      { cli: 'claude', model: 'opus[1m]', effort: 'max' }
    ]),
    undefined
  )
  // MODELOS diferentes nunca compartilhariam cache — avisar aqui seria ruído.
  assert.equal(
    fleetEffortWarning([
      { cli: 'claude', model: 'opus[1m]', effort: 'low' },
      { cli: 'claude', model: 'sonnet', effort: 'max' }
    ]),
    undefined
  )
  // O aviso é do claude: o codex grava o effort literal e não tem esse custo.
  assert.equal(
    fleetEffortWarning([
      { cli: 'codex', model: 'gpt-5.6-sol', effort: 'low' },
      { cli: 'codex', model: 'gpt-5.6-sol', effort: 'high' }
    ]),
    undefined
  )
  assert.equal(fleetEffortWarning([]), undefined)
})

test('o aviso da frota volta no próprio spawn, para o chamador registrar', () => {
  const { engine, logs } = harness()
  const outcome = engine.spawn(DELEGATOR, [
    { prompt: 'a', effort: 'low' },
    { prompt: 'b', effort: 'max' }
  ])

  assert.ok(outcome.warning, 'a frota de efforts variados subiu sem aviso nenhum')
  assert.ok(logs.some((entry) => entry.event === 'helper-fleet-effort'))
})

// ————— SEM CADEIA: o ajudante não delega (cerca dura do D1) —————

test('SEM CADEIA: o pedido de spawn não carrega ferramenta nenhuma', () => {
  const { engine, spawns } = harness()
  engine.spawn(DELEGATOR, [{ prompt: 'trabalhe' }])

  const keys = Object.keys(spawns[0].request)
  for (const forbidden of ['mcp', 'tools', 'extraArgs', 'extraEnv']) {
    assert.ok(
      !keys.includes(forbidden),
      `o motor entregou "${forbidden}" ao ajudante — a cadeia de delegação reabriu`
    )
  }
  // O que ele PRECISA continua lá: sem isto o helper nasceria fora do worktree.
  for (const required of ['helperId', 'projectId', 'delegatorPaneId', 'cwd', 'cli', 'model', 'seat', 'prompt']) {
    assert.ok(keys.includes(required), `o pedido de spawn perdeu "${required}"`)
  }
})

// ————— memória dos encerrados —————

test('a lembrança dos encerrados é MAIOR que o backstop', () => {
  // Se coubessem menos encerrados do que ajudantes vivos, uma frota no teto
  // perderia o resultado dos primeiros antes de o delegador conseguir lê-los.
  assert.ok(
    GUI_HELPER_SETTLED_MEMORY > GUI_HELPER_RUNAWAY_BACKSTOP,
    'a memória de encerrados cabe menos que uma frota cheia'
  )

  const { engine, spawns } = harness()
  const outcome = engine.spawn(
    DELEGATOR,
    Array.from({ length: GUI_HELPER_RUNAWAY_BACKSTOP }, (_, index) => ({ prompt: `f${index}` }))
  )
  for (const [index, spawn] of spawns.entries()) {
    spawn.emit({ type: 'result', isError: false, text: `entrega ${index}` })
  }
  assert.equal(engine.get(outcome.receipts[0].helperId).result, 'entrega 0')
  assert.equal(engine.status(DELEGATOR.paneId).length, GUI_HELPER_RUNAWAY_BACKSTOP)
})

test('a poda escolhe pelo ENCERRAMENTO, nunca pelo nascimento', () => {
  // O caso que a ordem de NASCIMENTO come vivo: um ajudante aberto primeiro e
  // que entrega por último teria o resultado evictado no mesmo instante em que
  // ficou pronto — o delegador leria "não encontrado" logo depois do done.
  const { engine, spawns } = harness()
  const primeiro = engine.spawn(DELEGATOR, [{ prompt: 'o mais demorado' }]).receipts[0].helperId

  for (let index = 0; index < GUI_HELPER_SETTLED_MEMORY + 10; index += 1) {
    engine.spawn(DELEGATOR, [{ prompt: `rápido ${index}` }])
    spawns.at(-1).emit({ type: 'result', isError: false, text: `rápido ${index}` })
  }
  // Só AGORA o mais antigo entrega.
  spawns[0].emit({ type: 'result', isError: false, text: 'a entrega que demorou' })

  assert.equal(
    engine.get(primeiro)?.result,
    'a entrega que demorou',
    'a poda comeu justamente o resultado que acabou de ficar pronto'
  )
})

// ————— R6.1: `interrupted` entra na máquina —————
//
// O estado que faltava: parada PRESERVADORA. O processo morre, o registro fica
// e a conversa do CLI (que já vive no disco dele) continua retomável. É o único
// desfecho de onde se pode VOLTAR — `cancelled` é descarte, `failed` é queda.

test('interruptPane PRESERVA: processo morre, registro e entrega parcial ficam', () => {
  const { engine, spawns } = harness()
  engine.spawn(DELEGATOR, [{ prompt: 'a' }, { prompt: 'b' }])
  engine.spawn(OTHER_DELEGATOR, [{ prompt: 'c' }])
  spawns[0].emit({ type: 'session', sessionId: 'sess-abc' })
  spawns[0].emit({ type: 'text', text: 'metade do trabalho' })

  assert.equal(engine.interruptPane(DELEGATOR.paneId, 'o dono apertou o ■'), 2)
  const [primeiro, segundo] = engine.status(DELEGATOR.paneId)
  assert.equal(primeiro.state, 'interrupted')
  assert.equal(segundo.state, 'interrupted')
  assert.match(primeiro.failure, /■/u)
  assert.equal(spawns[0].disposed, 1)
  assert.equal(spawns[2].disposed, 0, 'a interrupção vazou para o chat vizinho')
  // O que ele conseguiu escrever continua com ele — é isso que "preservadora"
  // quer dizer, e é o material que o resume da onda B reencontra.
  const record = engine.get(primeiro.helperId)
  assert.equal(record.result, 'metade do trabalho')
  assert.equal(record.sessionId, 'sess-abc')
})

test('interrompido é ASSENTADO e RETOMÁVEL — e não ocupa vaga do backstop', () => {
  assert.equal(isGuiHelperSettled('interrupted'), true, 'interrompido não é ajudante vivo')
  assert.equal(isGuiHelperResumable('interrupted'), true)
  for (const state of ['spawning', 'working', 'done', 'failed', 'cancelled']) {
    assert.equal(isGuiHelperResumable(state), false, `${state} não se retoma`)
  }
  // `interrupted` NÃO é terminal: os três de sempre continuam sendo o fim da
  // linha, e é isso que separa "parou" de "acabou".
  assert.deepEqual([...GUI_HELPER_TERMINAL_STATES].sort(), ['cancelled', 'done', 'failed'])

  const { engine } = harness()
  engine.spawn(DELEGATOR, [{ prompt: 'a' }])
  engine.interruptPane(DELEGATOR.paneId)
  assert.equal(engine.liveCount(DELEGATOR.paneId), 0)
})

test('o long-poll acorda no interrompido e a leitura NÃO mente que encerrou', async () => {
  const { engine, helperId, spawn, timers } = oneHelper()
  spawn.emit({ type: 'text', text: 'até aqui eu fui' })

  const pending = engine.result(helperId, 240)
  engine.interruptPane(DELEGATOR.paneId, 'o dono apertou o ■')
  const outcome = await settledWithin(pending, 'interrupção durante a espera')

  assert.equal(outcome.ok, true)
  assert.equal(outcome.pending, false, 'quem espera ficaria pendurado num ajudante já parado')
  assert.equal(outcome.state, 'interrupted')
  assert.equal(outcome.result, 'até aqui eu fui')
  assert.equal(timers[0].cancelled, true)
})

test('dirigir um interrompido é recusado com o ESTADO na cara, nunca "encerrou"', () => {
  const { engine, helperId } = oneHelper()
  engine.interruptPane(DELEGATOR.paneId, 'o app foi fechado')

  const enviado = engine.send(helperId, 'muda o rumo')
  assert.equal(enviado.ok, false)
  assert.match(enviado.error, /interrompid/iu)
  assert.match(enviado.error, /retomar/iu, 'a recusa tem de dizer que dá para voltar')
  assert.ok(
    !/encerrou/iu.test(enviado.error),
    'interrompido não é encerrado — o texto apagaria a única saída que existe'
  )
})

// ————— R6.1: a persistência (userData/gui-helpers.json) —————

test('round-trip pelo store: o vivo volta INTERROMPIDO e o assentado volta inteiro', () => {
  const store = memoryStore()
  const primeiro = harness({ store })
  const outcome = primeiro.engine.spawn(DELEGATOR, [
    { prompt: 'o que entregou', name: 'diff' },
    { prompt: 'o que ficou no meio', name: 'testes' }
  ])
  const [entregue, cortado] = outcome.receipts.map((receipt) => receipt.helperId)
  primeiro.spawns[0].emit({ type: 'session', sessionId: 'sess-entregue' })
  primeiro.spawns[0].emit({ type: 'result', isError: false, text: 'a entrega' })
  primeiro.spawns[1].emit({ type: 'session', sessionId: 'codex-thread:uuid-1' })
  primeiro.drain()

  // O app fecha SEM passar pelo quit (crash): o disco é a única fotografia.
  const segundo = harness({ store })
  const volta = segundo.engine.status(DELEGATOR.paneId)
  assert.deepEqual(
    volta.map((snapshot) => snapshot.helperId),
    [entregue, cortado],
    'a ordem da lateral se perdeu no disco'
  )
  assert.equal(volta[0].state, 'done')
  assert.equal(volta[1].state, 'interrupted')
  assert.match(volta[1].failure, /app/iu, 'o motivo tem de dizer que foi o app que fechou')
  assert.equal(segundo.engine.get(cortado).sessionId, 'codex-thread:uuid-1')
  assert.equal(segundo.engine.get(cortado).model, DELEGATOR.model)
  assert.equal(segundo.engine.get(cortado).cwd, DELEGATOR.cwd)
  assert.equal(segundo.engine.get(cortado).name, 'testes')
  // Nada volta vivo: um processo de outro boot não existe mais.
  assert.equal(segundo.engine.liveCount(), 0)
})

test('o store NÃO carrega a entrega inline — o arquivo é que é a entrega', () => {
  const store = memoryStore()
  const { engine, spawns } = harness({ store })
  const receipt = engine.spawn(DELEGATOR, [{ prompt: 'x' }]).receipts[0]
  spawns[0].emit({ type: 'result', isError: false, text: 'z'.repeat(5_000) })

  const [saved] = JSON.parse(store.doc)
  assert.equal(saved.helperId, receipt.helperId)
  assert.equal(saved.result, undefined, 'o disco guardou 64KB de entrega que já está em arquivo')
  assert.equal(saved.prompt, 'x')
  assert.equal(saved.state, 'done')
  assert.equal(persistableGuiHelperRecord({ helperId: 'h', result: 'x' }).result, undefined)
})

test('o desfecho GRAVA NA HORA; o resto pode esperar a batida', () => {
  const store = memoryStore()
  const { engine, spawns, tick } = harness({ store })
  const saidasNoBoot = store.saves

  engine.spawn(DELEGATOR, [{ prompt: 'x' }])
  assert.equal(store.saves, saidasNoBoot, 'o spawn gravou de forma síncrona (rajada de 100 = 100 escritas)')
  tick()
  assert.equal(store.saves, saidasNoBoot + 1, 'a gravação adiada nunca aconteceu')

  const antes = store.saves
  spawns[0].emit({ type: 'result', isError: false, text: 'pronto' })
  assert.equal(store.saves, antes + 1, 'o desfecho não foi descarregado na hora')
  assert.equal(JSON.parse(store.doc)[0].state, 'done')
})

test('encerrar a frota INTEIRA grava UMA vez, não uma por ajudante', () => {
  // O ■ do dono e o quit derrubam tudo no mesmo instante. Uma gravação síncrona
  // por ajudante seria N reescritas do MESMO arquivo no main — a classe de
  // travada que esta casa já pagou caro para matar.
  const store = memoryStore()
  const { engine } = harness({ store })
  engine.spawn(
    DELEGATOR,
    Array.from({ length: 12 }, (_, index) => ({ prompt: `f${index}` }))
  )
  const antes = store.saves

  assert.equal(engine.interruptAll('o app foi fechado'), 12)
  assert.equal(store.saves - antes, 1, 'a frota inteira virou uma reescrita por ajudante')
  assert.equal(
    JSON.parse(store.doc).filter((record) => record.state === 'interrupted').length,
    12
  )
})

test('o boot re-grava a fotografia JÁ marcada — um segundo crash não perde nada', () => {
  const store = memoryStore([
    {
      helperId: 'h-vivo',
      delegatorPaneId: DELEGATOR.paneId,
      projectId: DELEGATOR.projectId,
      cwd: DELEGATOR.cwd,
      cli: 'claude',
      model: 'opus[1m]',
      seatId: 'seat-1',
      prompt: 'trabalho interrompido',
      state: 'working',
      startedAt: 1_699_999_000_000
    }
  ])
  const { engine, logs } = harness({ store })

  assert.equal(engine.get('h-vivo').state, 'interrupted')
  assert.equal(JSON.parse(store.doc)[0].state, 'interrupted')
  assert.ok(
    logs.some((entry) => entry.event === 'helper-restored' && entry.helperId === 'h-vivo'),
    'a marcação de boot não deixou rastro no diário'
  )
})

test('disco sujo NUNCA derruba o motor: registro inválido cai, o bom fica', () => {
  const bom = {
    helperId: 'h-bom',
    delegatorPaneId: DELEGATOR.paneId,
    projectId: DELEGATOR.projectId,
    cwd: DELEGATOR.cwd,
    cli: 'codex',
    model: 'gpt-5.6-sol',
    seatId: 'seat-1',
    prompt: 'ok',
    state: 'done',
    startedAt: 1_699_999_000_000,
    settledAt: 1_699_999_100_000
  }
  const store = memoryStore([
    null,
    'lixo',
    { helperId: 'sem-o-resto' },
    { ...bom, helperId: 'h-cli-torto', cli: 'gemini' },
    { ...bom, helperId: 'h-estado-torto', state: 'pensando' },
    bom
  ])
  const { engine } = harness({ store })

  assert.deepEqual(
    engine.status(DELEGATOR.paneId).map((snapshot) => snapshot.helperId),
    ['h-bom']
  )
  assert.equal(sanitizeGuiHelperRecord(bom).helperId, 'h-bom')
  assert.equal(sanitizeGuiHelperRecord({ ...bom, startedAt: 'ontem' }), undefined)
  assert.equal(isGuiHelperStoreDoc({ version: 1, helpers: [] }), true)
  assert.equal(isGuiHelperStoreDoc({ helpers: 'nenhum' }), false)
  assert.equal(isGuiHelperStoreDoc(null), false)
})

test('a retenção corta o que já é história — 7 dias, e nunca o que acabou de parar', () => {
  const agora = 1_700_000_000_000
  const velho = {
    helperId: 'h-velho',
    delegatorPaneId: DELEGATOR.paneId,
    projectId: DELEGATOR.projectId,
    cwd: DELEGATOR.cwd,
    cli: 'claude',
    model: 'opus',
    seatId: 'seat-1',
    prompt: 'de semanas atrás',
    state: 'done',
    startedAt: agora - GUI_HELPER_STORE_RETENTION_MS - 60_000,
    settledAt: agora - GUI_HELPER_STORE_RETENTION_MS - 1
  }
  const store = memoryStore([
    velho,
    { ...velho, helperId: 'h-de-ontem', settledAt: agora - 24 * 60 * 60 * 1000 }
  ])
  const { engine } = harness({ store })

  assert.deepEqual(
    engine.status(DELEGATOR.paneId).map((snapshot) => snapshot.helperId),
    ['h-de-ontem']
  )
})

// ————— R6.1: o sessionId, matéria-prima do resume —————

test('o motor carimba o sessionId no instante em que o CLI o anuncia', () => {
  const { engine, helperId, spawn } = oneHelper()
  assert.equal(engine.get(helperId).sessionId, undefined)

  spawn.emit({ type: 'session', sessionId: '  sess-1  ' })
  assert.equal(engine.get(helperId).sessionId, 'sess-1', 'o id chegou com espaço e foi guardado cru')
  // O claude reemite no `result` (resume/fork podem trocar o id): o ÚLTIMO vale.
  spawn.emit({ type: 'session', sessionId: 'sess-2' })
  assert.equal(engine.get(helperId).sessionId, 'sess-2')
  spawn.emit({ type: 'session', sessionId: '   ' })
  assert.equal(engine.get(helperId).sessionId, 'sess-2', 'id vazio apagou o resume que existia')

  // Sinal de vida como qualquer outro: o card sai de "abrindo".
  assert.equal(engine.get(helperId).state, 'working')
})

// ————— R6.4: o escalonador de partida (spec do dono: "abre um, espera 2s") —————

test('abre UM na hora e os outros de dois em dois segundos — o recibo volta inteiro', () => {
  const { engine, spawns, clock, timers } = harness({ spawnIntervalMs: GUI_HELPER_SPAWN_INTERVAL_MS })
  const t0 = clock.t
  const outcome = engine.spawn(DELEGATOR, [
    { prompt: 'a' },
    { prompt: 'b' },
    { prompt: 'c' }
  ])

  // A TOOL NÃO BLOQUEIA: os três recibos voltam na mesma chamada.
  assert.equal(outcome.receipts.filter((receipt) => receipt.ok).length, 3)
  assert.equal(spawns.length, 1, 'a frota partiu em rajada — é a classe de 529 que o dono viu')
  // E os que ainda não partiram já aparecem na ficha como "abrindo".
  assert.deepEqual(
    engine.status(DELEGATOR.paneId).map((snapshot) => snapshot.state),
    ['spawning', 'spawning', 'spawning']
  )
  assert.equal(timers.at(-1).ms, GUI_HELPER_SPAWN_INTERVAL_MS)

  const kit = { timers, clock }
  fireSpawnTimer(kit)
  assert.equal(spawns.length, 2)
  assert.equal(clock.t - t0, GUI_HELPER_SPAWN_INTERVAL_MS)
  fireSpawnTimer(kit)
  assert.equal(spawns.length, 3)
  assert.equal(clock.t - t0, 2 * GUI_HELPER_SPAWN_INTERVAL_MS)
  assert.deepEqual(
    spawns.map((spawn) => spawn.request.prompt),
    ['a', 'b', 'c'],
    'a fila é FIFO: o ajudante 3 furou a fila'
  )
})

test('o intervalo é GLOBAL: a segunda chamada de delegate respeita a primeira', () => {
  const { engine, spawns, clock, timers } = harness({ spawnIntervalMs: GUI_HELPER_SPAWN_INTERVAL_MS })
  engine.spawn(DELEGATOR, [{ prompt: 'a' }])
  assert.equal(spawns.length, 1)

  clock.t += 500
  engine.spawn(OTHER_DELEGATOR, [{ prompt: 'b' }])
  assert.equal(spawns.length, 1, 'dois chats delegando ao mesmo tempo voltam a fazer rajada')
  assert.equal(timers.at(-1).ms, GUI_HELPER_SPAWN_INTERVAL_MS - 500)

  fireSpawnTimer({ timers, clock })
  assert.equal(spawns.length, 2)

  // Passado o intervalo, o pedido seguinte parte na hora — sem espera à toa.
  clock.t += GUI_HELPER_SPAWN_INTERVAL_MS
  engine.spawn(DELEGATOR, [{ prompt: 'c' }])
  assert.equal(spawns.length, 3)
})

test('cancelado na FILA nunca vira processo', () => {
  const { engine, spawns, clock, timers } = harness({ spawnIntervalMs: GUI_HELPER_SPAWN_INTERVAL_MS })
  const outcome = engine.spawn(DELEGATOR, [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }])
  const naFila = outcome.receipts[1].helperId

  assert.deepEqual(engine.cancel(naFila, 'não precisa mais'), { ok: true })
  fireSpawnTimer({ timers, clock })

  assert.equal(spawns.length, 2)
  assert.deepEqual(
    spawns.map((spawn) => spawn.request.prompt),
    ['a', 'c'],
    'o motor abriu um ajudante que o delegador já tinha cancelado'
  )
  assert.equal(engine.get(naFila).state, 'cancelled')
})

test('o padrão do escalonador é o do dono: dois segundos', () => {
  assert.equal(GUI_HELPER_SPAWN_INTERVAL_MS, 2_000)
  // Sem override, o motor usa o padrão — a bancada é que desliga a cadência.
  const { engine, spawns, timers } = harness({ defaultSpawnInterval: true })
  engine.spawn(DELEGATOR, [{ prompt: 'a' }, { prompt: 'b' }])
  assert.equal(spawns.length, 1)
  assert.equal(timers.at(-1).ms, GUI_HELPER_SPAWN_INTERVAL_MS)
})

// ————— R6.4: a re-tentativa da falha transitória (os 529 ao vivo) —————

test('o matcher de falha transitória é CONSERVADOR', () => {
  assert.match(transientHelperFailure('API Error: 529 {"type":"overloaded_error"}'), /sobrecarga/u)
  assert.match(transientHelperFailure('Overloaded'), /sobrecarga/u)
  assert.match(transientHelperFailure('429 Too Many Requests'), /requisi/u)
  assert.match(transientHelperFailure('rate_limit_error'), /requisi/u)

  for (const definitivo of [
    'o processo do CLI encerrou (código 1) sem entregar resultado',
    'limite da conta estourou — troque de seat',
    // A queda por TEMPO saiu da lista porque saiu do motor (R19): nenhum
    // ajudante é derrubado por relógio, e esta assinatura nunca mais nasce.
    'o app fechou com o ajudante trabalhando — o processo morreu',
    'spawn ENOENT',
    'o ajudante parou pedindo permissão',
    'erro no arquivo 1529.ts',
    ''
  ]) {
    assert.equal(
      transientHelperFailure(definitivo),
      undefined,
      `"${definitivo}" foi tratado como passageiro — re-tentar isso é queimar conta à toa`
    )
  }
})

test('529 na partida = UMA re-tentativa com respiro, carimbada e visível', () => {
  const { engine, spawns, logs, changes, clock, timers } = harness({ retryDelayMs: 20_000 })
  const helperId = engine.spawn(DELEGATOR, [{ prompt: 'a' }]).receipts[0].helperId
  spawns[0].emit({ type: 'result', isError: true, errorText: 'API Error: 529 overloaded_error' })

  // NÃO encerrou: o motor segurou a queda e marcou o respiro.
  const record = engine.get(helperId)
  assert.equal(record.state, 'spawning')
  assert.equal(record.retriedAt, clock.t)
  assert.match(record.retryReason, /sobrecarga/u)
  assert.match(record.lastActivity.summary, /re-tentando/u)
  assert.equal(spawns[0].disposed, 1, 'o processo caído ficou vivo durante o respiro')
  assert.ok(
    changes.some((change) => change.kind === 'activity' && /re-tentando/u.test(change.record.lastActivity?.summary ?? '')),
    'a ficha do dono não mostrou a re-tentativa'
  )
  assert.ok(logs.some((entry) => entry.event === 'helper-retry'))

  // O respiro é de verdade, e a partida volta PELA FILA (nunca por fora dela).
  assert.equal(timers.at(-1).ms, 20_000)
  assert.equal(spawns.length, 1)
  timers.at(-1).fired = true
  clock.t += 20_000
  timers.at(-1).fn()
  assert.equal(spawns.length, 2, 'a re-tentativa não abriu processo nenhum')
  assert.equal(spawns[1].request.prompt, 'a')
  assert.equal(spawns[1].request.seat.seatId, spawns[0].request.seat.seatId)

  // A segunda queda é queda: o motor não fica tentando para sempre.
  spawns[1].emit({ type: 'result', isError: true, errorText: '529 overloaded' })
  assert.equal(engine.get(helperId).state, 'failed')
  assert.match(engine.get(helperId).failure, /529/u)
})

test('a re-tentativa é da PARTIDA: trabalho já feito nunca é jogado fora', () => {
  // Um ajudante que já mexeu no worktree e toma um 529 no meio NÃO recomeça: o
  // motor não sabe desfazer o que ele escreveu, e refazer por cima é pior que a
  // falha honesta.
  const comTrabalho = harness()
  comTrabalho.engine.spawn(DELEGATOR, [{ prompt: 'a' }])
  comTrabalho.spawns[0].emit({ type: 'activity', summary: 'Edit src/x.ts' })
  comTrabalho.spawns[0].emit({ type: 'result', isError: true, errorText: '529 overloaded' })
  assert.equal(comTrabalho.engine.status(DELEGATOR.paneId)[0].state, 'failed')

  const tarde = harness()
  tarde.engine.spawn(DELEGATOR, [{ prompt: 'a' }])
  tarde.clock.t += GUI_HELPER_RETRY_STARTUP_WINDOW_MS + 1
  tarde.spawns[0].emit({ type: 'result', isError: true, errorText: '529 overloaded' })
  assert.equal(tarde.engine.status(DELEGATOR.paneId)[0].state, 'failed')

  assert.equal(GUI_HELPER_RETRY_DELAY_MS, 20_000)
})

test('529 que estoura no próprio spawn também ganha o respiro, e o recibo não recusa', () => {
  const { engine, spawns } = harness({ spawnThrows: '529 overloaded_error' })
  const outcome = engine.spawn(DELEGATOR, [{ prompt: 'a' }])

  assert.equal(outcome.receipts[0].ok, true, 'o ajudante foi recusado quando ainda ia re-tentar')
  assert.equal(engine.get(outcome.receipts[0].helperId).state, 'spawning')
  assert.equal(spawns.length, 1)
})

test('a memória tem fim: encerrado antigo sai, vivo NUNCA sai', () => {
  const { engine, spawns } = harness()
  const ids = []
  for (let index = 0; index < GUI_HELPER_SETTLED_MEMORY + 2; index += 1) {
    const outcome = engine.spawn(DELEGATOR, [{ prompt: `f${index}` }])
    ids.push(outcome.receipts[0].helperId)
    spawns[index].emit({ type: 'result', isError: false, text: `entrega ${index}` })
  }
  const vivo = engine.spawn(DELEGATOR, [{ prompt: 'ainda trabalhando' }])

  assert.equal(engine.get(ids[0]), undefined, 'a memória de encerrados cresce sem fim')
  assert.equal(engine.get(ids[1]), undefined)
  assert.equal(engine.get(ids[2]).result, 'entrega 2')
  assert.equal(engine.get(ids.at(-1)).result, `entrega ${GUI_HELPER_SETTLED_MEMORY + 1}`)
  assert.equal(engine.get(vivo.receipts[0].helperId).state, 'spawning')
})

// ————— R6.2: os DOIS verbos da interrupção (retomar × descartar) —————
//
// O ciclo redondo do dono (18/08): "não faz só um remendo, faz um planejamento
// por trás". A parada preservadora da onda A só faz sentido com uma VOLTA — e a
// volta tem de nascer do REGISTRO, nunca de estado em memória: o registro que
// veio do disco depois de um boot é o único que existe nos dois casos.

/** Um ajudante interrompido, com endereço de conversa — o caso de todo resume. */
function interrupted(over = {}) {
  const kit = harness(over.harness)
  const outcome = kit.engine.spawn(DELEGATOR, [{ prompt: 'levante os arquivos', name: 'busca' }])
  const helperId = outcome.receipts[0].helperId
  kit.spawns[0].emit({ type: 'session', sessionId: over.sessionId ?? 'sess-abc' })
  kit.spawns[0].emit({ type: 'text', text: 'comecei a olhar' })
  kit.engine.interruptPane(DELEGATOR.paneId, 'o dono apertou o quadrado')
  return { ...kit, helperId }
}

test('helper_resume volta a MESMA conversa, com o pino do nascimento intacto', () => {
  const { engine, helperId, spawns, changes, logs, clock } = interrupted()
  const nascimento = engine.get(helperId)
  clock.t += 60_000

  assert.deepEqual(engine.resume(helperId), { ok: true })

  assert.equal(spawns.length, 2, 'o resume não abriu processo nenhum')
  const pedido = spawns[1].request
  assert.equal(pedido.resumeSessionId, 'sess-abc', 'sem o endereço da conversa isto é um recomeço')
  assert.equal(pedido.model, nascimento.model, 'o pino do nascimento vale')
  assert.equal(pedido.effort, nascimento.effort)
  assert.equal(pedido.seat.seatId, nascimento.seatId)
  assert.equal(pedido.cwd, nascimento.cwd)
  assert.equal(pedido.helperId, helperId, 'retomar é o MESMO ajudante, nunca um irmão')
  assert.ok(pedido.prompt.length < 400, `o nudge tem de ser curto (${pedido.prompt.length} chars)`)
  assert.match(pedido.prompt, /continue de onde parou/iu)

  const record = engine.get(helperId)
  assert.equal(record.state, 'spawning')
  assert.equal(record.settledAt, undefined, 'quem voltou a trabalhar não tem hora de encerramento')
  assert.equal(record.failure, undefined)
  assert.equal(record.resumedAt, clock.t, 'o cronômetro re-arma no instante da volta')
  assert.equal(record.startedAt, clock.t)

  spawns[1].emit({ type: 'result', isError: false, text: 'terminei o que faltava' })
  assert.equal(engine.get(helperId).state, 'done')
  assert.equal(engine.get(helperId).result, 'terminei o que faltava')
  assert.deepEqual(
    changes.map((change) => change.kind),
    ['spawned', 'settled', 'resumed', 'settled'],
    'a lateral precisa saber que o card voltou a viver'
  )
  assert.ok(logs.some((entry) => entry.event === 'helper-resumed' && entry.helperId === helperId))
})

test('resume DEPOIS DO BOOT: o pedido nasce do registro do disco, não da memória', () => {
  // O `spawnRequest` é solto no desfecho de propósito (onda A): um resume que
  // dependesse dele funcionaria na sessão e quebraria justamente no caso que o
  // dono pediu — fechar o app e voltar.
  const store = memoryStore()
  const primeiro = harness({ store })
  const helperId = primeiro.engine.spawn(DELEGATOR, [{ prompt: 'o trabalho', name: 'busca' }])
    .receipts[0].helperId
  primeiro.spawns[0].emit({ type: 'session', sessionId: 'codex-thread:uuid-9' })
  primeiro.drain()

  const segundo = harness({ store })
  assert.equal(segundo.engine.get(helperId).state, 'interrupted')
  assert.deepEqual(segundo.engine.resume(helperId), { ok: true })

  assert.equal(segundo.spawns.length, 1, 'o boot não reabre nada sozinho, mas o resume abre')
  const pedido = segundo.spawns[0].request
  assert.equal(pedido.resumeSessionId, 'codex-thread:uuid-9')
  assert.equal(pedido.model, DELEGATOR.model)
  assert.equal(pedido.cwd, DELEGATOR.cwd)
  // A CONTA se re-resolve pelo registro: o objeto de conta do boot anterior não
  // existe mais, e é o `resolveSeat` que sabe quais estão logadas AGORA.
  const query = segundo.seatQueries.at(-1)
  assert.equal(query.cli, 'claude')
  assert.equal(query.preferredSeatId, segundo.engine.get(helperId).seatId)
})

test('o modo de permissão do nascimento atravessa o disco e volta no resume', () => {
  // Sem isto o ajudante renasce em modo `default` num chat de bypass e morre no
  // primeiro pedido de permissão — beco sem ninguém do outro lado.
  const store = memoryStore()
  const primeiro = harness({ store })
  const helperId = primeiro.engine
    .spawn({ ...DELEGATOR, permissionMode: 'bypass' }, [{ prompt: 'escreva o arquivo' }])
    .receipts[0].helperId
  assert.equal(primeiro.spawns[0].request.permissionMode, 'bypass')
  primeiro.spawns[0].emit({ type: 'session', sessionId: 'sess-perm' })
  primeiro.drain()

  const segundo = harness({ store })
  assert.equal(segundo.engine.resume(helperId).ok, true)
  assert.equal(segundo.spawns[0].request.permissionMode, 'bypass')
})

test('resume só existe sobre o interrompido, e a recusa nomeia o verbo certo', () => {
  const vivo = oneHelper()
  const trabalhando = vivo.engine.resume(vivo.helperId)
  assert.equal(trabalhando.ok, false)
  assert.match(trabalhando.error, /trabalhando/iu)
  assert.match(trabalhando.error, /helper_send|helper_cancel/u, 'a recusa tem de dizer o que fazer')

  vivo.spawn.emit({ type: 'result', isError: false, text: 'entreguei' })
  const pronto = vivo.engine.resume(vivo.helperId)
  assert.equal(pronto.ok, false)
  assert.match(pronto.error, /helper_result/u, 'quem já entregou se lê, não se retoma')

  const descartado = oneHelper()
  descartado.engine.cancel(descartado.helperId, 'não quero mais')
  const morto = descartado.engine.resume(descartado.helperId)
  assert.equal(morto.ok, false)
  assert.match(morto.error, /delegate/u, 'descartado não volta: abre-se outro')

  assert.equal(vivo.engine.resume('helper-fantasma').ok, false)
})

test('sem endereço da conversa o resume RECUSA em vez de recomeçar do zero', () => {
  // O nudge é curto porque a CONVERSA carrega o briefing. Sem sessionId ele
  // chegaria a um ajudante em branco — "continue de onde parou" sem nenhum
  // "onde".
  const { engine, helperId } = interrupted({ sessionId: '   ' })
  const outcome = engine.resume(helperId)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /delegate/u, 'a saída honesta é abrir outro com o briefing')
  assert.equal(engine.get(helperId).state, 'interrupted', 'a recusa não pode mexer no registro')
})

test('o resume passa PELA FILA de partida — nunca dois processos no mesmo instante', () => {
  const kit = harness({ spawnIntervalMs: 2_000 })
  const outcome = kit.engine.spawn(DELEGATOR, [{ prompt: 'a' }, { prompt: 'b' }])
  const [primeiro, segundo] = outcome.receipts.map((receipt) => receipt.helperId)
  kit.spawns[0].emit({ type: 'session', sessionId: 'sess-1' })
  fireSpawnTimer(kit)
  kit.spawns[1].emit({ type: 'session', sessionId: 'sess-2' })
  assert.equal(kit.spawns.length, 2)

  kit.engine.interruptPane(DELEGATOR.paneId, 'o dono apertou o quadrado')
  assert.equal(kit.engine.resume(primeiro).ok, true)
  assert.equal(kit.engine.resume(segundo).ok, true)
  // "Volta com os subagentes" é uma frota inteira renascendo de uma vez — a
  // MESMA rajada que o escalonador existe para espaçar. Nenhum dos dois parte
  // antes de o intervalo da última partida vencer.
  assert.equal(kit.spawns.length, 2, 'os dois resumes partiram na mesma rajada')

  fireSpawnTimer(kit)
  assert.equal(kit.spawns.length, 3)
  fireSpawnTimer(kit)
  assert.equal(kit.spawns.length, 4, 'o segundo resume nunca chegou a subir')
  // Cada um voltou para a PRÓPRIA conversa: uma fila que embaralhasse os
  // pedidos daria a um ajudante o histórico do outro.
  assert.equal(kit.spawns[2].request.resumeSessionId, 'sess-1')
  assert.equal(kit.spawns[3].request.resumeSessionId, 'sess-2')
})

test('helper_cancel é DESCARTE: mata o que vive, apaga a entrega e vira terminal', () => {
  const discarded = []
  const { engine, helperId, spawns } = interrupted({
    harness: {
      discardDelivery: (record) => discarded.push(record.helperId),
      deliver: () => ({ ok: true, path: '.synkora/helpers/entrega.md' })
    }
  })
  assert.equal(spawns[0].disposed, 1)
  const parado = engine.get(helperId)
  assert.equal(parado.state, 'interrupted')
  assert.equal(parado.resultPath, '.synkora/helpers/entrega.md', 'a parada preservadora gravou')

  assert.deepEqual(engine.cancel(helperId, 'o dono não quer mais'), { ok: true })
  const registro = engine.get(helperId)
  assert.equal(registro.state, 'cancelled', 'descartar um parado tem de encerrá-lo de vez')
  assert.match(registro.failure, /não quer mais/u)
  assert.equal(registro.resultPath, undefined, 'o card continuaria apontando um arquivo apagado')
  assert.equal(registro.result, undefined)
  assert.deepEqual(discarded, [helperId], 'o arquivo canônico da entrega continua no worktree')

  assert.equal(engine.resume(helperId).ok, false, 'descartado não se retoma')
})

test('descartar o que JÁ entregou é recusado — a entrega dele é o produto', () => {
  const discarded = []
  const { engine, helperId, spawn } = oneHelper({
    harness: { discardDelivery: (record) => discarded.push(record.helperId) }
  })
  spawn.emit({ type: 'result', isError: false, text: 'a entrega' })

  const outcome = engine.cancel(helperId)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /entregou|encerrou/iu)
  assert.deepEqual(discarded, [], 'o descarte apagou a entrega de um ajudante que terminou')
  assert.equal(engine.get(helperId).state, 'done')
})

test('cancelar um ajudante VIVO não procura arquivo que nunca existiu', () => {
  const discarded = []
  const { engine, helperId } = oneHelper({
    harness: { discardDelivery: (record) => discarded.push(record.helperId) }
  })
  assert.equal(engine.cancel(helperId).ok, true)
  assert.equal(engine.get(helperId).state, 'cancelled')
  assert.deepEqual(discarded, [], 'nada foi gravado antes do descarte — não há o que apagar')
})

// ————— R27F3 — O ✕ DA FROTA, O GESTO DO DONO (2026-08-22) —————
//
// Ordem literal: "quando o subagente deu interrompido, eu quero algum X pra eu
// tirar dali, porque eu já entendi". Até aqui só o AGENTE descartava
// (helper_cancel via MCP); o ✕ do mockup aprovado vira o canal MECÂNICO do
// dono — e canal do dono nunca é uma segunda meia-implementação: ele entra pelo
// MESMO `cancel` que o agente usa, com a cerca a mais que o gesto pede.

test('R27F3 — o ✕ do dono descarta o INTERROMPIDO pelo caminho do helper_cancel', () => {
  const discarded = []
  const { engine, helperId, changes, logs } = interrupted({
    harness: {
      discardDelivery: (record) => discarded.push(record.helperId),
      deliver: () => ({ ok: true, path: '.synkora/helpers/parcial.md' })
    }
  })
  assert.equal(engine.get(helperId).resultPath, '.synkora/helpers/parcial.md')

  assert.deepEqual(engine.ownerDismiss(helperId), { ok: true, state: 'discarded' })

  const registro = engine.get(helperId)
  assert.equal(registro.state, 'cancelled', 'o ✕ é DESCARTE, não uma segunda pausa')
  // A entrega parcial vai junto — é o que a dica do botão promete ao dono.
  assert.deepEqual(discarded, [helperId])
  assert.equal(registro.resultPath, undefined)
  assert.equal(registro.result, undefined)
  // Quem descartou está no registro E no diário: o gesto do dono é auditável
  // como qualquer outro desfecho.
  assert.match(registro.failure, /dono/u)
  const descarte = logs.filter((entry) => entry.event === 'helper-discarded')
  assert.equal(descarte.length, 1)
  assert.match(String(descarte[0].detail.reason), /dono/u)
  // O aviso que a LATERAL consome é o mesmo de sempre (`settled`): é por ele
  // que a ficha sai do trilho, sem canal novo nenhum.
  const ultimo = changes.at(-1)
  assert.equal(ultimo.kind, 'settled')
  assert.equal(ultimo.record.helperId, helperId)
  assert.equal(ultimo.record.state, 'cancelled')

  // Descartado não se retoma — o ciclo fecha igual ao do agente.
  assert.equal(engine.resume(helperId).ok, false)
})

test('R27F3 — o ✕ do dono nunca joga fora trabalho VIVO nem entrega pronta', () => {
  const discarded = []
  const vivo = oneHelper({
    harness: { discardDelivery: (record) => discarded.push(record.helperId) }
  })
  vivo.spawn.emit({ type: 'text', text: 'comecei' })
  const recusaViva = vivo.engine.ownerDismiss(vivo.helperId)
  assert.equal(recusaViva.ok, false)
  // A recusa NOMEIA a receita: quem para a frota viva é o ■ da conversa.
  assert.match(recusaViva.error, /■|interromp/iu)
  assert.equal(vivo.engine.get(vivo.helperId).state, 'working')
  assert.deepEqual(discarded, [], 'ficha viva não pode perder trabalho por um clique')

  const pronto = oneHelper({
    harness: { discardDelivery: (record) => discarded.push(record.helperId) }
  })
  pronto.spawn.emit({ type: 'result', isError: false, text: 'a entrega' })
  const recusaPronta = pronto.engine.ownerDismiss(pronto.helperId)
  assert.equal(recusaPronta.ok, false)
  assert.match(recusaPronta.error, /entreg/iu)
  assert.equal(pronto.engine.get(pronto.helperId).state, 'done')
  assert.deepEqual(discarded, [], 'a entrega dele é o produto do trabalho')
})

test('R27F3 — ficha órfã: ajudante que o motor já não conhece sai sem erro', () => {
  const { engine } = oneHelper()
  // O caso real: o app reiniciou, o registro envelheceu (ou já foi descartado)
  // e o CARD continuou no anel. O dono clica no ✕ da ficha fantasma — e "não
  // existe" é exatamente a resposta que autoriza tirá-la da tela, nunca um erro
  // que deixaria o dono preso com uma linha que ele não tem como remover.
  assert.deepEqual(engine.ownerDismiss('helper-que-nunca-existiu'), { ok: true, state: 'gone' })
  assert.deepEqual(engine.ownerDismiss('   '), { ok: true, state: 'gone' })
})
