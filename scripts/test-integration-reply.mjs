import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GuiIntegrationReply, INTEGRATION_REPLY_TIMEOUT_MS, pendingIntegrationTool } from '../.tmp/gui-sessions-test/guiIntegrationReply.js'
import { GuiSessionRegistry } from '../.tmp/gui-sessions-test/guiSessions.js'

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
  assert.match(h.emitted.at(-1).text, /finalizada/u)
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

test('erro na limpeza é nota explícita, sem rejeição solta ou sucesso inventado', async () => {
  const events = []
  const reply = new GuiIntegrationReply(() => () => {})
  const generation = {}
  reply.arm(generation, tool.toolUseId, 'merge confirmado', (event) => events.push(event), async () => {
    throw new Error('synthetic cleanup failure')
  })
  reply.disposed(generation)
  await tick()
  assert.match(events.at(-1).text, /finalização falhou/u)
  assert.doesNotMatch(events.at(-1).text, /synthetic/u, 'exceção bruta não é transcrita')
})

for (const cli of ['claude', 'codex']) {
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
    assert.match(replay.events.at(-1).evt.text, /fila finalizada/u)
    assert.ok(pushed.every((item, i) => i === 0 || item.seq > pushed[i - 1].seq))
    gui.killAll()
  })
}
