import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = buildSync({
  entryPoints: ['src/main/codexSession.ts'], bundle: true,
  platform: 'node', format: 'cjs', write: false
}).outputFiles[0].text
const drain = () => new Promise(resolve => setImmediate(resolve))

async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const events = [], writes = [], launches = []
  const child = new EventEmitter()
  Object.assign(child, {
    exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: { write: text => writes.push(JSON.parse(text)), end() {} },
    kill() {
      if (this.exitCode !== null) return true
      this.exitCode = 0
      this.emit('exit', 0, null)
      this.emit('close', 0, null)
      return true
    }
  })
  const localRequire = id => {
    if (id === 'child_process' || id === 'node:child_process') return {
      execFileSync: () => '',
      spawn(file) {
        assert.equal(file, 'codex', 'only the synthetic Codex transport may be launched')
        launches.push(file)
        return child
      }
    }
    return require(id)
  }
  const environment = Object.create(process)
  Object.defineProperties(environment, {
    platform: { value: 'linux' }, env: { value: { PATH: '/synthetic-bin' } }
  })
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', 'process', compiled)(
    localRequire, loaded, loaded.exports, environment
  )
  const session = new loaded.exports.CodexSession({
    cwd: '/synthetic-worktree', configDir: '/synthetic-seat', idleTimeoutMs: 0,
    model: 'synthetic-model', effort: 'high', serviceTier: 'priority'
  }, 'synthetic persona', event => events.push(event))
  t.after(() => session.kill())
  const frame = value => child.stdout.write(`${JSON.stringify(value)}\n`)
  const note = (method, params) => frame({ method, params })
  const reply = (method, result = {}) => {
    const request = writes.findLast(value => value.method === method)
    assert.ok(request, `expected synthetic ${method} request`)
    frame({ id: request.id, result })
  }
  await drain()
  reply('initialize')
  await drain()
  reply('model/list', { data: [] })
  reply('account/read', { account: null })
  await drain()
  session.send('synthetic instruction')
  await drain()
  reply('thread/start', { thread: { id: 'thread-root' } })
  await drain()
  reply('turn/start', { turn: { id: 'turn-a' } })
  note('turn/started', { threadId: 'thread-root', turn: { id: 'turn-a', status: 'inProgress' } })
  await drain()
  assert.equal(session.alive, true)
  assert.equal(writes.filter(value => value.method === 'turn/start').length, 1)
  events.length = 0
  return {
    session, events, writes, launches, frame, note, reply,
    error(params = {}) {
      note('error', { threadId: 'thread-root', turnId: 'turn-a',
        error: { message: 'falha sintética' }, willRetry: false, ...params })
    },
    finish(turn = {}) {
      note('turn/completed', { threadId: 'thread-root',
        turn: { id: 'turn-a', status: 'completed', items: [], ...turn } })
    },
    start(turnId) {
      note('turn/started', { threadId: 'thread-root', turn: { id: turnId, status: 'inProgress' } })
    }
  }
}

const definitiveErrors = events => events.filter(event =>
  event.type === 'limit' || event.type === 'fatal' || (event.type === 'result' && event.isError))

test('retry followed by success emits neutral progress and preserves completed tool receipts without resending', async t => {
  const f = await fixture(t)
  const before = f.writes.length
  f.note('item/started', { threadId: 'thread-root', turnId: 'turn-a',
    item: { type: 'commandExecution', id: 'tool-a', command: 'synthetic command' } })
  f.note('item/completed', { threadId: 'thread-root', turnId: 'turn-a',
    item: { type: 'commandExecution', id: 'tool-a', status: 'completed', exitCode: 0, aggregatedOutput: 'done' } })
  f.error({ willRetry: true })
  f.finish()
  await drain()
  assert.deepEqual(f.events.map(event => event.type), ['tool', 'tool-result', 'turn-retry', 'result'])
  assert.equal(f.events[1].toolUseId, 'tool-a')
  assert.equal(f.events[1].isError, false)
  assert.equal(f.events[2].turnId, 'turn-a')
  assert.ok(f.events[2].text.length > 0)
  assert.doesNotMatch(f.events[2].text, /falha sintética/u)
  assert.deepEqual(definitiveErrors(f.events), [])
  assert.equal(f.events.at(-1).turnId, 'turn-a')
  assert.equal(f.events.at(-1).outcome, 'completed')
  assert.equal(f.events.at(-1).continues, false)
  assert.equal(f.writes.length, before)
  assert.equal(f.launches.length, 1)
})

test('repeated top-level and nested retry notifications publish one note per turn', async t => {
  const f = await fixture(t)
  f.error({ willRetry: true })
  f.start('turn-a')
  f.error({ error: { message: 'outro detalhe', willRetry: true } })
  f.error({ willRetry: true })
  assert.deepEqual(f.events.map(event => event.type), ['turn-retry'])
  f.finish()
  await drain()
})

test('nonretry error plus failed terminal has one definitive error using the terminal message', async t => {
  const f = await fixture(t)
  f.error({ error: { message: 'Selected model is at capacity; retry later' } })
  assert.deepEqual(f.events, [], 'the notification waits for the authoritative terminal')
  f.finish({ status: 'failed', error: { message: 'erro terminal sintético' } })
  await drain()
  assert.equal(definitiveErrors(f.events).length, 1)
  assert.equal(f.events[0].type, 'result')
  assert.equal(f.events[0].turnId, 'turn-a')
  assert.equal(f.events[0].errorText, 'erro terminal sintético')
  assert.equal(f.events[0].outcome, 'failed')
})

test('failed terminal without a message uses the bounded sanitized notification fallback', async t => {
  const f = await fixture(t)
  f.error({ error: { message: `Authorization: Bearer synthetic-credential\n${'x'.repeat(900)}` } })
  f.finish({ status: 'failed', error: { message: '  ' } })
  await drain()
  assert.equal(definitiveErrors(f.events).length, 1)
  const result = f.events.at(-1)
  assert.equal(result.type, 'result')
  assert.equal(result.turnId, 'turn-a')
  assert.ok(result.errorText.length <= 501)
  assert.match(result.errorText, /\[redigido:/u)
  assert.doesNotMatch(result.errorText, /synthetic-credential/u)
})

test('error without textual details uses a generic fallback rather than serializing the payload', async t => {
  const f = await fixture(t)
  f.error({ error: { code: 'synthetic-code', token: 'synthetic-private-field' } })
  f.finish({ status: 'failed' })
  await drain()
  assert.equal(definitiveErrors(f.events).length, 1)
  assert.ok(f.events.at(-1).errorText.length > 0)
  assert.doesNotMatch(f.events.at(-1).errorText, /synthetic-private-field|synthetic-code/u)
})

test('terminal error messages are sanitized and bounded too', async t => {
  const f = await fixture(t)
  f.finish({ status: 'failed', error: { message: `Authorization: Bearer synthetic-credential\n${'x'.repeat(900)}` } })
  await drain()
  assert.ok(f.events.at(-1).errorText.length <= 501)
  assert.match(f.events.at(-1).errorText, /\[redigido:/u)
  assert.doesNotMatch(f.events.at(-1).errorText, /synthetic-credential/u)
})

test('distinct turns each publish retry progress and never inherit earlier fallback text', async t => {
  const f = await fixture(t)
  f.error({ willRetry: true, error: { message: 'erro do turno A' } })
  f.finish()
  await drain()
  f.start('turn-b')
  f.error({ turnId: 'turn-b', willRetry: true, error: { message: 'erro do turno B' } })
  f.finish({ id: 'turn-b', status: 'failed' })
  await drain()
  assert.deepEqual(f.events.filter(event => event.type === 'turn-retry').map(event => event.turnId), ['turn-a', 'turn-b'])
  assert.deepEqual(f.events.filter(event => event.type === 'result').map(event => event.turnId), ['turn-a', 'turn-b'])
  assert.equal(f.events.at(-1).errorText, 'erro do turno B')
  f.start('turn-c')
  f.finish({ id: 'turn-c', status: 'failed' })
  await drain()
  assert.doesNotMatch(f.events.at(-1).errorText ?? '', /erro do turno [AB]/u)
})

test('unknown and out-of-turn errors stay visible without entering the active turn episode', async t => {
  const f = await fixture(t)
  f.error({ turnId: 'turn-unrelated', willRetry: true, error: { message: 'unrelated' } })
  f.error({ turnId: undefined, error: { message: 'unknown identity' } })
  assert.deepEqual(f.events.map(event => event.type), ['limit', 'limit'])
  t.mock.timers.tick(10_000)
  assert.equal(f.session.alive, true, 'an unrelated error must not kill the active turn')
  f.finish({ status: 'failed' })
  await drain()
  assert.doesNotMatch(f.events.at(-1).errorText ?? '', /unrelated|unknown identity/u)
})

test('foreign errors and terminals cannot enter or close the root conversation', async t => {
  const f = await fixture(t)
  f.error({ threadId: 'thread-other', willRetry: true, error: { message: 'foreign error' } })
  f.note('turn/completed', { threadId: 'thread-other', turn: { id: 'turn-a', status: 'failed' } })
  await drain()
  assert.deepEqual(f.events, [])
  t.mock.timers.tick(10_000)
  assert.equal(f.session.alive, true)
  f.finish()
  await drain()
  assert.equal(f.events.at(-1).turnId, 'turn-a')
})

test('an error received while idle is immediately visible even with willRetry', async t => {
  const f = await fixture(t)
  f.finish()
  await drain()
  f.events.length = 0
  f.error({ willRetry: true })
  assert.deepEqual(f.events.map(event => event.type), ['limit'])
})

test('owner interruption wins over a failed terminal after a retry', async t => {
  const f = await fixture(t)
  f.error({ willRetry: true })
  assert.equal(f.session.interrupt(), true)
  f.reply('turn/interrupt')
  f.finish({ status: 'failed', error: { message: 'provider failure' } })
  await drain()
  assert.deepEqual(definitiveErrors(f.events), [])
  const result = f.events.at(-1)
  assert.equal(result.turnId, 'turn-a')
  assert.equal(result.interrupted, true)
  assert.equal(result.isError, false)
  assert.equal(result.outcome, 'cancelled')
  assert.equal(result.errorText, 'interrompido pelo dono')
})

test('owner stop replaces the earlier error guard while awaiting its own confirmation', async t => {
  const f = await fixture(t)
  f.error()
  t.mock.timers.tick(5_000)
  assert.equal(f.session.interrupt(), true)
  f.reply('turn/interrupt')
  t.mock.timers.tick(5_000)
  assert.equal(f.session.alive, true, 'the earlier error deadline must not preempt the owner interrupt guard')
  assert.deepEqual(f.events, [])
  f.finish({ status: 'failed' })
  await drain()
  assert.equal(f.events.at(-1).interrupted, true)
})

test('owner stop ignores further retry progress while awaiting its confirmation', async t => {
  const f = await fixture(t)
  f.error()
  t.mock.timers.tick(5_000)
  assert.equal(f.session.interrupt(), true)
  f.reply('turn/interrupt')
  f.error({ willRetry: true })
  t.mock.timers.tick(5_000)
  assert.equal(f.session.alive, true, 'the earlier error deadline must not preempt the owner interrupt guard')
  assert.deepEqual(f.events, [])
  f.finish({ status: 'failed' })
  await drain()
  assert.equal(f.events.at(-1).interrupted, true)
  assert.deepEqual(definitiveErrors(f.events), [])
})

test('a nonretry error without a terminal stays guarded for 10 seconds and emits one visible fatal', async t => {
  const f = await fixture(t)
  f.error()
  assert.deepEqual(f.events, [])
  t.mock.timers.tick(9_999)
  assert.deepEqual(f.events, [])
  assert.equal(f.session.alive, true)
  t.mock.timers.tick(1)
  await drain()
  assert.equal(definitiveErrors(f.events).length, 1)
  assert.equal(definitiveErrors(f.events)[0].type, 'fatal')
  assert.match(definitiveErrors(f.events)[0].text, /falha sintética/u)
  assert.equal(f.session.alive, false)
  assert.equal(f.events.filter(event => event.type === 'closed').length, 1)
})

test('server retry clears the earlier nonretry guard and never starts another turn', async t => {
  const f = await fixture(t)
  const before = f.writes.length
  f.error()
  t.mock.timers.tick(5_000)
  f.error({ willRetry: true })
  t.mock.timers.tick(10_000)
  assert.equal(f.session.alive, true)
  assert.deepEqual(definitiveErrors(f.events), [])
  assert.equal(f.writes.length, before)
  f.finish()
  await drain()
})

test('a new turn clears the old missing-terminal guard and ignores its stale terminal', async t => {
  const f = await fixture(t)
  f.error()
  f.start('turn-b')
  f.error({ turnId: 'turn-b', willRetry: true })
  f.finish({ id: 'turn-a', status: 'failed', error: { message: 'stale terminal' } })
  await drain()
  t.mock.timers.tick(10_000)
  assert.equal(f.session.alive, true)
  assert.deepEqual(f.events.map(event => event.type), ['turn-retry'])
  f.finish({ id: 'turn-b' })
  await drain()
  assert.equal(f.events.at(-1).turnId, 'turn-b')
})

test('confirmed failure preserves pending-send continuation while a steer RPC settles', async t => {
  const f = await fixture(t)
  f.session.send('second synthetic instruction', 'owner-message-b')
  await drain()
  f.error()
  f.finish({ status: 'failed' })
  await drain()
  assert.equal(definitiveErrors(f.events).length, 1)
  assert.equal(f.events.at(-1).turnId, 'turn-a')
  assert.equal(f.events.at(-1).continues, true)
  f.reply('turn/steer', { turnId: 'turn-a' })
  await drain()
  assert.deepEqual(f.events.at(-1), { type: 'turn-continuation', continues: false })
  assert.equal(f.writes.filter(value => value.method === 'turn/start').length, 1)
})

test('a rejected steer moving to a new turn cannot inherit the earlier turn error guard', async t => {
  const f = await fixture(t)
  f.error({ error: { message: 'erro antigo do turno A' } })
  t.mock.timers.tick(5_000)
  f.session.send('second synthetic instruction')
  await drain()
  const steer = f.writes.findLast(value => value.method === 'turn/steer')
  assert.ok(steer)
  f.frame({ id: steer.id, error: { message: 'synthetic steer rejection' } })
  await drain()
  f.reply('turn/start', { turn: { id: 'turn-b' } })
  await drain()
  t.mock.timers.tick(5_000)
  assert.equal(f.session.alive, true, 'the old error guard cannot terminate the next pending turn start')
  assert.deepEqual(f.events, [])
  f.start('turn-b')
  f.finish({ id: 'turn-b', status: 'failed' })
  await drain()
  assert.equal(f.events.at(-1).turnId, 'turn-b')
  assert.doesNotMatch(f.events.at(-1).errorText ?? '', /erro antigo do turno A/u)
})

test('a successful retry retains collab results until the factual child completion', async t => {
  const f = await fixture(t)
  f.note('item/started', { threadId: 'thread-root', turnId: 'turn-a', item: {
    type: 'subAgentActivity', id: 'activity-a', kind: 'started',
    agentThreadId: 'thread-child', agentPath: '/root/synthetic-child'
  } })
  f.error({ willRetry: true })
  f.finish()
  await drain()
  assert.equal(f.events.filter(event => event.type === 'result').length, 0)
  f.note('turn/completed', { threadId: 'thread-child',
    turn: { id: 'turn-child', status: 'completed', items: [] } })
  await drain()
  assert.deepEqual(f.events.map(event => event.type), ['tool', 'turn-retry', 'tool-result', 'result'])
  assert.equal(f.events.at(-1).turnId, 'turn-a')
  assert.equal(f.events.at(-1).isError, false)
})

test('kill clears a pending error guard without producing a delayed failure', async t => {
  const f = await fixture(t)
  f.error()
  f.session.kill()
  t.mock.timers.tick(10_000)
  await drain()
  assert.deepEqual(definitiveErrors(f.events), [])
  assert.equal(f.events.filter(event => event.type === 'closed').length, 1)
})
