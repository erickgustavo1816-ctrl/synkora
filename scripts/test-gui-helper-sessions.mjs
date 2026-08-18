import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GUI_HELPER_PROMPT_MAX_CHARS,
  GUI_HELPER_RESULT_MAX_CHARS,
  GUI_HELPER_RESULT_TRUNCATION_NOTICE,
  GUI_HELPER_RUNAWAY_BACKSTOP,
  GUI_HELPER_SETTLED_MEMORY,
  GUI_HELPER_WAIT_DEFAULT_SECONDS,
  GUI_HELPER_WAIT_MAX_SECONDS,
  GUI_HELPER_WATCHDOG_MS,
  GuiHelperEngine,
  capGuiHelperResult,
  clampHelperWaitSeconds,
  fleetEffortWarning,
  helperEffortDecision,
  resolveHelperCli
} from '../src/main/guiHelperSessions.ts'

// MOTOR DOS AJUDANTES SEM ABA (D1 do design vinculante
// .synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md).
//
// O motor é PURO por desenho: os dois CLIs entram por ADAPTADOR injetado, o
// relógio e o temporizador também. É o que deixa a máquina de estados, o
// backstop anti-runaway, o long-poll e o watchdog serem provados em node puro,
// sem spawnar um único processo — nenhum destes fatos deveria depender de olhar
// a lateral com o app aberto.
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
    if (over.spawnThrows) throw new Error('o CLI não subiu')
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
    now: () => clock.t,
    newId: () => `helper-${++ids}`,
    setTimer: (ms, fn) => {
      const timer = { ms, fn, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    onChange: (change) => changes.push(change),
    log: (entry) => logs.push(entry)
  })

  return { engine, clock, spawns, changes, logs, timers, seatQueries }
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

// ————— watchdog de 30 min —————

test('o watchdog derruba o ajudante preso em 30 min, com motivo', () => {
  const { engine, helperId, clock, spawn, logs } = oneHelper()

  clock.t += GUI_HELPER_WATCHDOG_MS - 1
  assert.deepEqual(engine.sweep(), [])
  assert.equal(engine.get(helperId).state, 'spawning')

  clock.t += 1
  const reaped = engine.sweep()
  assert.deepEqual(
    reaped.map((record) => record.helperId),
    [helperId]
  )
  const record = engine.get(helperId)
  assert.equal(record.state, 'failed')
  assert.match(record.failure, /30 min/u)
  assert.equal(spawn.disposed, 1, 'o watchdog deixou o processo vivo')
  assert.ok(
    logs.some((entry) => entry.event === 'helper-watchdog'),
    'a queda por watchdog não deixou rastro no diário'
  )
})

test('toda operação pública passa a vassoura: status não mostra zumbi', () => {
  const { engine, helperId, clock } = oneHelper()
  clock.t += GUI_HELPER_WATCHDOG_MS

  const [snapshot] = engine.status(DELEGATOR.paneId)
  assert.equal(snapshot.state, 'failed')
  assert.equal(engine.liveCount(DELEGATOR.paneId), 0)
  assert.equal(engine.get(helperId).state, 'failed')
})

test('o long-poll não segura um ajudante já morto pelo watchdog', async () => {
  const { engine, helperId, clock, timers } = oneHelper()

  const pending = engine.result(helperId, 240)
  clock.t += GUI_HELPER_WATCHDOG_MS
  fireLastTimer(timers)
  const outcome = await settledWithin(pending, 'watchdog durante a espera')

  assert.equal(outcome.ok, true)
  assert.equal(outcome.state, 'failed')
  assert.equal(outcome.pending, false)
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

test('cancelAll é o quit: nenhum processo sobrevive', () => {
  const { engine, spawns } = harness()
  engine.spawn(DELEGATOR, [{ prompt: 'a' }, { prompt: 'b' }])
  engine.spawn(OTHER_DELEGATOR, [{ prompt: 'c' }])

  assert.equal(engine.cancelAll('o app fechou'), 3)
  assert.equal(engine.liveCount(), 0)
  for (const spawn of spawns) assert.equal(spawn.disposed, 1)
  assert.equal(engine.cancelAll(), 0)
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
