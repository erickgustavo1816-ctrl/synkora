import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const compiled = buildSync({ entryPoints: ['src/main/codexSession.ts'], bundle: true,
  platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
const drain = () => new Promise(resolve => setImmediate(resolve))
const sqliteError = 'Error: failed to initialize sqlite state runtime under <synthetic-home>: failed to initialize state runtime at <synthetic-home>'

function childProcess() {
  const child = new EventEmitter()
  Object.assign(child, { pid: 7000, exitCode: null, signalCode: null, writes: [], signals: [],
    stdout: new PassThrough(), stderr: new PassThrough(), unref() {},
    kill(signal) { this.signals.push(signal); return true },
    close(code = 0, signal = null) {
      if (this.didClose) return
      this.didClose = true
      this.exitCode = code
      this.signalCode = signal
      this.emit('exit', code, signal)
      this.emit('close', code, signal)
    }
  })
  child.stdin = { write: text => child.writes.push(JSON.parse(text)), end() {} }
  return child
}

function fixture(t) {
  const children = [], killers = [], sessions = [], events = []
  const localRequire = id => {
    if (id === 'child_process' || id === 'node:child_process') return {
      execFileSync: () => '',
      spawn(file, args, options) {
        const child = childProcess()
        child.launch = { file, args, options }
        if (file === 'codex') children.push(child)
        else if (file === 'taskkill.exe') killers.push(child)
        else throw new Error(`unexpected synthetic process: ${file}`)
        child.pid += children.length + killers.length
        return child
      }
    }
    return require(id)
  }
  const loaded = { exports: {} }
  const environment = Object.create(process)
  Object.defineProperties(environment, {
    platform: { value: 'win32' }, env: { value: { PATH: 'C:\\synthetic-bin' } }
  })
  new Function('require', 'module', 'exports', 'process', compiled)(localRequire, loaded, loaded.exports, environment)
  t.after(async () => {
    for (const session of sessions) session.kill()
    for (const child of children) child.close()
    for (const killer of killers) killer.close()
    await drain()
  })
  return {
    children, killers, events,
    session(opts = {}) {
      const stream = []
      const session = new loaded.exports.CodexSession({ cwd: process.cwd(), configDir: 'C:\\synthetic-home',
        idleTimeoutMs: 0, ...opts }, 'synthetic persona', event => { stream.push(event); events.push(event) })
      sessions.push(session)
      return { session, events: stream }
    }
  }
}

function request(child, method) {
  const frame = child.writes.findLast(frame => frame.method === method)
  assert.ok(frame, `expected ${method}`)
  return frame
}

function reply(child, method, result = {}) {
  child.stdout.write(`${JSON.stringify({ id: request(child, method).id, result })}\n`)
}

async function initialize(child) {
  reply(child, 'initialize')
  await drain()
  reply(child, 'model/list', { data: [] })
  reply(child, 'account/read', { account: null })
  await drain()
}

async function startLiveTurn(session, child) {
  session.send('synthetic instruction')
  await drain()
  reply(child, 'thread/start', { thread: { id: 'thread-live' } })
  await drain()
  reply(child, 'turn/start', { turn: { id: 'turn-live' } })
  await drain()
}

function failSqlite(child) {
  child.stderr.write(sqliteError)
  child.close(1)
}

test('recovers one exact SQLite failure before initialize without terminal events', async t => {
  const f = fixture(t)
  const s = f.session()
  const caps = s.session.waitCaps()
  await drain()
  failSqlite(f.children[0])
  await drain()
  assert.equal(f.children.length, 2, 'one new process after the failed startup closes')
  assert.equal(s.session.alive, true)
  assert.deepEqual(s.events, [])
  await initialize(f.children[1])
  assert.ok(await caps)
  assert.equal(s.events.filter(e => e.type === 'ready').length, 1)
  assert.equal(s.events.filter(e => e.type === 'fatal' || e.type === 'closed').length, 0)
  assert.equal(f.children[1].writes.some(frame => frame.method.startsWith('thread/')), false)
})

test('a second SQLite startup failure exhausts recovery and preserves its error', async t => {
  const f = fixture(t)
  const s = f.session()
  const caps = s.session.waitCaps()
  await drain()
  failSqlite(f.children[0])
  await drain()
  assert.equal(f.children.length, 2)
  failSqlite(f.children[1])
  await drain()
  assert.equal(f.children.length, 2)
  assert.equal(await caps, null)
  const fatals = s.events.filter(e => e.type === 'fatal')
  assert.equal(fatals.length, 1)
  assert.ok(fatals[0].text.includes(sqliteError))
  assert.equal(s.events.filter(e => e.type === 'closed').length, 1)
  assert.equal(s.session.alive, false)
})

for (const error of ['Error: invalid configuration', 'Error: authentication required', 'Error: sqlite database is unavailable']) {
  test(`unrelated startup error surfaces without retry: ${error}`, async t => {
    const f = fixture(t)
    const s = f.session()
    await drain()
    f.children[0].stderr.write(error)
    f.children[0].close(1)
    await drain()
    assert.equal(f.children.length, 1)
    assert.equal(s.events.filter(e => e.type === 'closed').length, 1)
    assert.ok(s.events.some(e => e.type === 'fatal' && e.text.includes(error)))
  })
}

test('SQLite error after initialize success never replays a process', async t => {
  const f = fixture(t)
  const s = f.session()
  await drain()
  reply(f.children[0], 'initialize')
  await drain()
  failSqlite(f.children[0])
  await drain()
  assert.equal(f.children.length, 1)
  assert.equal(s.session.alive, false)
  assert.ok(s.events.some(e => e.type === 'fatal' && e.text.includes(sqliteError)))
  assert.equal(s.events.some(e => e.type === 'ready'), false, 'failed capability RPCs cannot announce ready')
})

for (const firstReceipt of ['child', 'taskkill']) {
  test(`replacement waits for both receipts when ${firstReceipt} closes first`, async t => {
    const f = fixture(t)
    const a = f.session()
    await drain()
    await initialize(f.children[0])
    a.session.kill()
    const b = f.session()
    await drain()
    assert.equal(f.children.length, 1, 'replacement must wait for prior close')
    assert.equal(b.session.alive, true, 'waiting session remains usable by the synchronous registry')
    const receipts = firstReceipt === 'child' ? [f.children[0], f.killers[0]] : [f.killers[0], f.children[0]]
    receipts[0].close()
    await drain()
    assert.equal(f.children.length, 1)
    receipts[1].close()
    await drain()
    assert.equal(f.children.length, 2)
    await initialize(f.children[1])
    assert.equal(b.events.filter(e => e.type === 'ready').length, 1)
  })
}

test('killing a waiting replacement cannot spawn it or release an older retirement', async t => {
  const f = fixture(t)
  const a = f.session()
  await drain()
  await initialize(f.children[0])
  a.session.kill()
  const b = f.session()
  const caps = b.session.waitCaps()
  b.session.kill()
  const c = f.session()
  await drain()
  assert.equal(await caps, null)
  assert.equal(f.children.length, 1)
  f.children[0].close()
  f.killers[0].close()
  await drain()
  assert.equal(f.children.length, 2, 'only A and C ever spawn')
  await initialize(f.children[1])
  assert.equal(b.events.some(e => e.type === 'ready' || e.type === 'fatal'), false)
  assert.equal(c.events.filter(e => e.type === 'ready').length, 1)
})

test('retirement uses the effective home and leaves different homes independent', async t => {
  const f = fixture(t)
  const a = f.session({ configDir: 'C:\\unused-a', extraEnv: { CODEX_HOME: 'C:\\shared-home' } })
  await drain()
  await initialize(f.children[0])
  a.session.kill()
  f.session({ configDir: 'C:\\unused-b', extraEnv: { CODEX_HOME: 'C:\\shared-home' } })
  f.session({ configDir: 'C:\\different-home' })
  await drain()
  assert.equal(f.children.length, 2)
  assert.equal(f.children[1].launch.options.env.CODEX_HOME, 'C:\\different-home')
})

test('startup recovery retains options and delivers one queued turn after resuming', async t => {
  const f = fixture(t)
  const s = f.session({ resumeSessionId: 'same-thread', sandbox: 'danger-full-access', approvalPolicy: 'never',
    model: 'synthetic-model', effort: 'high', serviceTier: 'priority', extraArgs: ['-c', 'features.multi_agent=false'] })
  s.session.send('synthetic instruction')
  await drain()
  failSqlite(f.children[0])
  await drain()
  assert.equal(f.children.length, 2)
  const child = f.children[1]
  assert.deepEqual(child.launch, f.children[0].launch)
  await initialize(child)
  assert.equal(request(child, 'thread/resume').params.threadId, 'same-thread')
  assert.equal(request(child, 'thread/resume').params.sandbox, 'danger-full-access')
  assert.equal(child.writes.some(frame => frame.method === 'turn/start'), false)
  reply(child, 'thread/resume', { thread: { id: 'same-thread' } })
  await drain()
  const turn = request(child, 'turn/start')
  assert.equal(turn.params.model, 'synthetic-model')
  assert.equal(turn.params.effort, 'high')
  assert.equal(turn.params.serviceTier, 'priority')
  assert.equal(turn.params.approvalPolicy, 'never')
  assert.deepEqual(turn.params.input, [{ type: 'text', text: 'synthetic instruction' }])
  assert.equal(child.writes.filter(frame => frame.method === 'turn/start').length, 1)
  reply(child, 'turn/start', { turn: { id: 'synthetic-turn' } })
  await drain()
})

test('retirement timeout does not permit overlap and late close releases future starts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t)
  const a = f.session()
  await drain()
  await initialize(f.children[0])
  a.session.kill()
  const b = f.session()
  await drain()
  t.mock.timers.tick(5000)
  await drain()
  assert.equal(f.children.length, 1)
  assert.equal(b.session.alive, false)
  assert.equal(b.events.filter(e => e.type === 'fatal').length, 1)
  f.children[0].close()
  f.killers[0].close()
  await drain()
  f.session()
  await drain()
  assert.equal(f.children.length, 2)
})

test('SQLite recovery also waits for another process retiring in the same home', async t => {
  const f = fixture(t)
  f.session()
  const other = f.session()
  await drain()
  await initialize(f.children[1])
  other.session.kill()
  failSqlite(f.children[0])
  await drain()
  assert.equal(f.children.length, 2, 'recovery obeys the same retirement barrier as first startup')
  f.children[1].close()
  f.killers[0].close()
  await drain()
  assert.equal(f.children.length, 3)
  await initialize(f.children[2])
})

test('cancellation immediately before a SQLite failure prevents recovery', async t => {
  const f = fixture(t)
  const s = f.session()
  await drain()
  s.session.kill()
  failSqlite(f.children[0])
  f.killers[0].close()
  await drain()
  assert.equal(f.children.length, 1)
  assert.equal(s.events.filter(e => e.type === 'closed').length, 1)
  assert.equal(s.events.some(e => e.type === 'ready' || e.type === 'fatal'), false)
})

test('initialize success followed by close in the same tick never enables recovery', async t => {
  const f = fixture(t)
  const s = f.session()
  await drain()
  reply(f.children[0], 'initialize')
  failSqlite(f.children[0])
  await drain()
  assert.equal(f.children.length, 1)
  assert.ok(s.events.some(e => e.type === 'fatal' && e.text.includes(sqliteError)))
  assert.equal(s.events.some(e => e.type === 'ready'), false)
})

test('an initialize RPC refusal cannot trigger SQLite recovery', async t => {
  const f = fixture(t)
  const s = f.session()
  await drain()
  const child = f.children[0]
  child.stdout.write(`${JSON.stringify({ id: request(child, 'initialize').id, error: { message: sqliteError } })}\n`)
  await drain()
  child.close(1)
  f.killers[0].close()
  await drain()
  assert.equal(f.children.length, 1)
  assert.ok(s.events.some(e => e.type === 'fatal' && e.text.includes(sqliteError)))
})

test('stdout buffered after exit and before close still delivers the final text', async t => {
  const f = fixture(t)
  const s = f.session()
  await drain()
  const child = f.children[0]
  await initialize(child)
  await startLiveTurn(s.session, child)
  child.exitCode = 0
  child.emit('exit', 0, null)
  child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: {
    threadId: 'thread-live', turnId: 'turn-live', itemId: 'final-message', delta: 'final buffered text'
  } })}\n`)
  child.close()
  await drain()
  assert.ok(s.events.some(e => e.type === 'delta' && e.text === 'final buffered text'))
})

test('runtime close cancels native agent cards before the terminal fatal', async t => {
  const f = fixture(t)
  const s = f.session()
  await drain()
  const child = f.children[0]
  await initialize(child)
  await startLiveTurn(s.session, child)
  child.stdout.write(`${JSON.stringify({ method: 'item/started', params: {
    threadId: 'thread-live', turnId: 'turn-live', item: { type: 'subAgentActivity', id: 'activity-child',
      kind: 'started', agentThreadId: 'child-thread', agentPath: '/root/synthetic-child' }
  } })}\n`)
  assert.ok(s.events.some(e => e.type === 'tool'))
  s.events.length = 0
  child.close(1)
  await drain()
  const cancellation = s.events.findIndex(e => e.type === 'tool-result' && e.outcome === 'cancelled')
  const fatal = s.events.findIndex(e => e.type === 'fatal')
  assert.ok(cancellation >= 0 && fatal > cancellation, 'dependent cards settle before terminal events')
})
