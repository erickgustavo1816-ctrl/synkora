import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GuiIntegrationReply, INTEGRATION_REPLY_TIMEOUT_MS, pendingIntegrationTool } from '../.tmp/gui-sessions-test/main/guiIntegrationReply.js'
import { GuiSessionRegistry } from '../.tmp/gui-sessions-test/main/guiSessions.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))
const tool = { type: 'tool', name: 'mcp__synkora__integration_run', input: {}, toolUseId: 'integration-1' }
const receipt = { type: 'tool-result', text: 'INTEGRADA', isError: false, toolUseId: tool.toolUseId }

function replyHarness() {
  const timers = []
  const emitted = []
  let finishes = 0
  const reply = new GuiIntegrationReply((ms, fn) => {
    const timer = { ms, fn, cancelled: false }
    timers.push(timer)
    return () => { timer.cancelled = true }
  })
  const generation = {}
  reply.arm(generation, tool.toolUseId, 'INTEGRADA: merge comprovado',
    (event) => emitted.push(event), async () => { finishes++; return '⇪ finalizada' })
  return { reply, generation, timers, emitted, finishes: () => finishes }
}

test('recibo é correlacionado pelo ID da integration_run, sem ler prosa', () => {
  assert.equal(pendingIntegrationTool([tool]), tool.toolUseId)
  assert.equal(pendingIntegrationTool([tool, receipt]), undefined)
  assert.equal(pendingIntegrationTool([{ ...tool, name: 'integration_run', input: { server: 'synkora' } }]), tool.toolUseId)
  assert.equal(pendingIntegrationTool([{ ...tool, name: 'integration_run', input: { server: 'another-server' } }]), undefined)
  assert.equal(pendingIntegrationTool([{ ...tool, name: 'Bash', input: { command: 'integration_run' } }]), undefined)
})

test('resposta da ferramenta chega antes do fecho; uma resposta alheia não libera a origem', async () => {
  const h = replyHarness()
  h.reply.observe(h.generation, { ...receipt, toolUseId: 'another-tool' })
  await tick()
  assert.equal(h.finishes(), 0)
  h.reply.observe(h.generation, receipt)
  await tick()
  assert.equal(h.finishes(), 0, 'o dev ainda pode contar o desfecho')
  h.reply.observe(h.generation, { type: 'result', isError: false })
  await tick()
  assert.equal(h.finishes(), 1)
  assert.equal(h.emitted.some((event) => event.type === 'tool-result'), false, 'recibo real não é duplicado')
  assert.equal(h.timers[0].cancelled, true)
  h.timers[0].fn()
  h.reply.disposed(h.generation)
  await tick()
  assert.equal(h.finishes(), 1, 'timer e dispose tardios não repetem a limpeza')
})

test('CLI sem resposta tem prazo: resultado comprovado e terminal substituem o rodando eterno', async () => {
  const h = replyHarness()
  assert.equal(h.timers[0].ms, INTEGRATION_REPLY_TIMEOUT_MS)
  assert.ok(INTEGRATION_REPLY_TIMEOUT_MS <= 30_000)
  h.timers[0].fn()
  await tick()
  assert.equal(h.finishes(), 1)
  assert.deepEqual(h.emitted.slice(0, 2).map((event) => event.type), ['tool-result', 'result'])
  assert.equal(h.emitted[0].toolUseId, tool.toolUseId)
  assert.equal(h.emitted[0].isError, false)
  assert.equal(h.emitted[1].continues, true, 'o result sintético não fecha a rodada que o app ainda está finalizando')
  assert.match(h.emitted.filter((event) => event.type === 'command-output').at(-1).text, /finalizada/u)
  assert.deepEqual(h.emitted.at(-1), { type: 'turn-continuation', continues: false, turnActive: false })
})

test('o result do agente não fecha a rodada: continua enquanto o app finaliza e fecha depois da nota', async () => {
  const h = replyHarness()
  const published = h.reply.observe(h.generation, { type: 'result', isError: false, continues: false, turnActive: false })
  assert.equal(published.continues, true, 'a rodada do dono continua durante a finalização')
  assert.equal(published.turnActive, false, 'o turno do agente acabou de verdade')
  await tick()
  assert.equal(h.finishes(), 1)
  assert.match(h.emitted.filter((event) => event.type === 'command-output').at(-1).text, /finalizada/u)
  assert.deepEqual(h.emitted.at(-1), { type: 'turn-continuation', continues: false, turnActive: false })
  assert.equal(h.emitted.some((event) => event.type === 'result'), false, 'nenhum result sintético em cima do real')
})

test('fecho sem texto não vira nota vazia, mas ainda fecha a rodada', async () => {
  const emitted = []
  const reply = new GuiIntegrationReply(() => () => {})
  const generation = {}
  reply.arm(generation, tool.toolUseId, 'merge', (event) => emitted.push(event), async () => '')
  reply.observe(generation, { type: 'result', isError: false })
  await tick()
  assert.equal(emitted.filter((event) => event.type === 'command-output').length, 1, 'só a nota de abertura')
  assert.equal(emitted.at(-1).type, 'turn-continuation')
})

test('a geração retomada herda a rodada: o result do resume é absorvido, o do agente fecha', async () => {
  const emitted = []
  const reply = new GuiIntegrationReply(() => () => {})
  const generation = {}
  const resumed = {}
  reply.arm(generation, tool.toolUseId, 'merge', (event) => emitted.push(event), async () => '↻ pasta presa', () => resumed)
  reply.observe(generation, { type: 'result', isError: false })
  await tick()
  await tick()
  assert.equal(emitted.some((event) => event.type === 'turn-continuation'), false, 'quem fecha a rodada é o agente retomado')
  assert.equal(reply.observe(resumed, { type: 'session-id', sessionId: 'same' }).type, 'session-id')
  assert.equal(reply.observe(resumed, { type: 'result', isError: false, continues: false }).continues, true,
    'o CLI liquidando o resume não é o agente falando')
  reply.observe(resumed, { type: 'thinking', text: '' })
  assert.equal(reply.observe(resumed, { type: 'result', isError: false, continues: false }).continues, false)
  assert.equal(reply.observe(resumed, { type: 'result', isError: false, continues: false }).continues, false,
    'depois do fecho nada mais é reescrito')
})

test('retomada indisponível: nota de recuperação e a rodada fecha mesmo assim', async () => {
  const emitted = []
  const reply = new GuiIntegrationReply(() => () => {})
  const generation = {}
  reply.arm(generation, tool.toolUseId, 'merge', (event) => emitted.push(event), async () => '↻ pasta presa',
    () => { throw new Error('synthetic recovery failure') })
  reply.observe(generation, { type: 'result', isError: false })
  await tick()
  await tick()
  assert.ok(emitted.some((event) => event.type === 'command-output' && /reabra esta conversa/u.test(event.text)))
  assert.equal(emitted.some((event) => /synthetic/u.test(event.text ?? '')), false)
  assert.equal(emitted.at(-1).type, 'turn-continuation')
})

test('encerramento e eventos de outra geração não perdem nem duplicam o fecho', async () => {
  const h = replyHarness()
  h.reply.observe({}, { type: 'result', isError: false })
  await tick()
  assert.equal(h.finishes(), 0)
  h.reply.disposed(h.generation)
  await tick()
  assert.equal(h.finishes(), 1)
  h.reply.observe(h.generation, receipt)
  await tick()
  assert.equal(h.finishes(), 1)
})

test('a finalization-only receipt does not announce a merge before the saved proof is checked', async () => {
  const events = []
  const reply = new GuiIntegrationReply(() => () => {})
  const generation = {}
  reply.arm(generation, tool.toolUseId, 'checking finalization', event => events.push(event), async () => {
    throw new Error('synthetic invalid journal')
  }, undefined, 'finalization')
  reply.disposed(generation)
  await tick()
  assert.ok(events.some(event => event.text?.includes('conferindo o registro')))
  assert.ok(events.every(event => !event.text?.includes('merge confirmado')))
})

test('erro na limpeza é nota explícita, sem rejeição solta ou sucesso inventado', async () => {
  const events = []
  const reply = new GuiIntegrationReply(() => () => {})
  const generation = {}
  reply.arm(generation, tool.toolUseId, 'merge confirmado', (event) => events.push(event), async () => {
    throw new Error('synthetic cleanup failure')
  })
  reply.disposed(generation)
  await tick()
  const note = events.filter((event) => event.type === 'command-output').at(-1)
  assert.match(note.text, /finalização falhou/u)
  assert.doesNotMatch(note.text, /synthetic/u, 'exceção bruta não é transcrita')
  assert.equal(events.at(-1).type, 'turn-continuation', 'a rodada fecha mesmo com a limpeza falhando')
})

for (const action of ['stop', 'quit', 'new-generation', 'resolved']) {
  test(`finalization recovery respects ${action} after the source chat has closed`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'synkora-recovery-owner-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const spawns = []
    const gui = new GuiSessionRegistry({ push: () => {}, systemPromptFile: () => undefined })
    t.after(() => gui.killAll())
    gui.spawnSession = (spawn, sink) => {
      const backend = { alive: true, turnActive: false, kill() { this.alive = false } }
      spawns.push({ spawn, sink, backend })
      return backend
    }
    const paneId = 'gui-dev-owner-recovery'
    const spawn = { paneId, projectId: 'synthetic', cli: 'codex', cwd: join(root, 'source') }
    gui.create(spawn)
    let releaseFinish
    const finishing = new Promise(resolve => { releaseFinish = resolve })
    gui.afterIntegrationReply(paneId, 'merge recorded', async () => {
      gui.killWhere(id => id === paneId)
      await finishing
      return 'finish outcome'
    }, () => action === 'resolved' ? undefined : root)
    spawns[0].sink({ type: 'result', isError: false })
    await tick()
    if (action === 'stop') gui.kill(paneId)
    if (action === 'quit') gui.killAll()
    if (action === 'new-generation') gui.create({ ...spawn, cwd: root, model: 'owner-selection' })
    releaseFinish()
    await tick()
    await tick()
    assert.equal(spawns.length, action === 'new-generation' ? 2 : 1)
    if (action === 'new-generation') assert.equal(spawns[1].spawn.model, 'owner-selection')
  })
}

for (const cli of ['claude', 'codex']) {
  test(`${cli}: failed finalization resumes the same agent outside the source worktree`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'synkora-agent-recovery-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const pushed = []
    const spawns = []
    const wakes = []
    const gui = new GuiSessionRegistry({ push: event => pushed.push(event),
      systemPromptFile: () => undefined, storeFile: join(root, 'sessions.json') })
    t.after(() => gui.killAll())
    gui.spawnSession = (spawn, sink) => {
      const backend = { alive: true, turnActive: false, kill() { this.alive = false } }
      spawns.push({ spawn, sink, backend })
      return backend
    }
    gui.attachIntegration({ paneOpened: (paneId, projectId) => wakes.push({ paneId, projectId }) })
    const paneId = `gui-dev-recovery-${cli}`
    const original = { paneId, projectId: 'synthetic', cli, cwd: join(root, 'source'),
      seatId: 'chosen-seat', configDir: join(root, 'seat'), model: 'chosen-model', effort: 'high',
      permissionMode: 'bypass', firstPrompt: 'original task', systemPrompt: 'original contract' }
    assert.equal(gui.create(original).ok, true)
    spawns[0].sink({ type: 'session-id', sessionId: 'saved-conversation' })
    spawns[0].sink(tool)
    gui.afterIntegrationReply(paneId, 'merge recorded', async () => {
      gui.killWhere(id => id === paneId)
      return 'finalização pendente'
    }, () => root)
    spawns[0].sink(receipt)
    spawns[0].sink({ type: 'result', isError: false })
    await tick()
    await tick()
    assert.equal(spawns.length, 2, 'a command-output alone cannot wake the agent')
    assert.equal(spawns[1].spawn.cwd, root)
    assert.equal(spawns[1].spawn.resumeSessionId, 'saved-conversation')
    assert.equal(spawns[1].spawn.firstPrompt, undefined)
    for (const field of ['seatId', 'configDir', 'model', 'effort', 'permissionMode'])
      assert.equal(spawns[1].spawn[field], original[field], field)
    assert.equal(wakes.length, 2, 'the reopened pane re-derives its recovery prompt once')
    assert.ok(gui.state(paneId).events.some(({ evt }) => evt.text === 'finalização pendente'))
    assert.equal(pendingIntegrationTool(gui.state(paneId).events.map(({ evt }) => evt)), undefined)
    // A RODADA DO DONO NÃO FECHA no result do agente: o app ainda finaliza e a
    // geração retomada herda a rodada até o agente falar de verdade (o CLI
    // liquida o resume com um result próprio — transcript de 2026-09-16).
    assert.ok(pushed.some(({ evt }) => evt.type === 'result' && evt.continues === true),
      'o result do agente vira continuação enquanto o app finaliza')
    assert.equal(pushed.some(({ evt }) => evt.type === 'turn-continuation'), false,
      'com retomada, quem fecha a rodada é o agente retomado')
    spawns[1].sink({ type: 'result', isError: false })
    await tick()
    assert.equal(pushed.at(-1).evt.type, 'result')
    assert.equal(pushed.at(-1).evt.continues, true, 'o CLI liquidando o resume não é o agente falando')
    spawns[1].sink({ type: 'delta', text: 'vou destravar a pasta' })
    spawns[1].sink({ type: 'result', isError: false })
    await tick()
    assert.equal(pushed.at(-1).evt.type, 'result')
    assert.notEqual(pushed.at(-1).evt.continues, true, 'o result do agente retomado fecha a rodada')
  })

  test(`${cli}: registro real entrega, encerra, salva o desfecho após o kill e reabre sem tool pendurada`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'synkora-integration-reply-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const pushed = []
    const deps = { push: (payload) => pushed.push(payload), systemPromptFile: () => undefined,
      storeFile: join(root, 'sessions.json') }
    const gui = new GuiSessionRegistry(deps)
    const paneId = `gui-dev-reply-${cli}`
    let sink
    let alive = true
    gui.spawnSession = (_spawn, emit) => {
      sink = emit
      return { get alive() { return alive }, turnActive: true, kill: () => { alive = false } }
    }
    gui.create({ paneId, projectId: 'synthetic', cli, cwd: root })
    sink(cli === 'codex' ? { ...tool, name: 'integration_run', input: { server: 'synkora' } } : tool)
    let finished = false
    gui.afterIntegrationReply(paneId, 'INTEGRADA', async () => {
      gui.killWhere((id) => id === paneId)
      finished = true
      return '⇪ INTEGRADA; fila finalizada'
    })
    assert.equal(alive, true)
    assert.equal(finished, false)
    sink(receipt)
    sink({ type: 'result', isError: false })
    await tick()
    await tick()
    assert.equal(finished, true)
    assert.equal(alive, false)
    const replay = new GuiSessionRegistry(deps).state(paneId)
    assert.equal(pendingIntegrationTool(replay.events.map(({ evt }) => evt)), undefined)
    assert.match(replay.events.filter(({ evt }) => evt.type === 'command-output').at(-1).evt.text, /fila finalizada/u)
    assert.ok(replay.events.some(({ evt }) => evt.type === 'result' && evt.continues === true),
      'o result do agente foi gravado como continuação da rodada')
    assert.equal(replay.events.at(-1).evt.type, 'turn-continuation', 'sem retomada, o fecho fecha a rodada no transcript')
    assert.equal(replay.events.at(-1).evt.continues, false)
    assert.ok(pushed.every((item, i) => i === 0 || item.seq > pushed[i - 1].seq))
    gui.killAll()
  })
}
