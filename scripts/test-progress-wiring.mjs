import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const main = read('src/main/index.ts')

test('streaming cannot postpone snapshot publication indefinitely', () => {
  const start = main.indexOf('function scheduleProgressSnapshot(): void {')
  const end = main.indexOf('\n}', start) + 2
  const timers = new Map()
  let clock = 0, id = 0, published = 0
  const context = vm.createContext({
    setTimeout: (fn, delay) => { timers.set(++id, { fn, at: clock + delay }); return id },
    clearTimeout: (timer) => timers.delete(timer),
    refreshProgressSnapshot: () => published++
  })
  vm.runInContext(stripTypeScriptTypes(`let progressSnapshotTimer = null; ${main.slice(start, end)}`), context)
  for (clock = 0; clock <= 2_100; clock += 50) {
    for (const [key, timer] of timers) {
      if (timer.at <= clock) { timers.delete(key); timer.fn() }
    }
    vm.runInContext('scheduleProgressSnapshot()', context)
  }
  assert.ok(published >= 3, `continuous stream published only ${published} snapshots`)
  assert.ok(published <= 4, 'stream publication should remain throttled')
})

test('runtime progress observes normalized GUI sessions and ignores terminal output', () => {
  const source = main.slice(main.indexOf('progressSnapshotSource = (revision)'), main.indexOf('const ensureProjectRuntimeWritable'))
  assert.match(source, /guiSessions: guiSessions\?\.progress\(\)/)
  assert.doesNotMatch(source, /coordinatorActivity|paneNotes|lastOutputAt/)
  assert.match(read('src/main/ipc/gui.ts'), /onProgressChange: ctx\.scheduleProgressSnapshot/)
  assert.doesNotMatch(read('src/main/ipc/pty.ts'), /scheduleProgressLiveSnapshot|refreshProgressLiveSnapshot/)
})

test('heartbeat and bounded project path cache keep snapshots fresh without per-token disk work', () => {
  assert.match(main, /progressHeartbeatTimer = setInterval\(refreshProgressSnapshot, 15_000\)/)
  assert.match(main, /checkedAt < 30_000/)
  assert.match(main, /clearInterval\(progressHeartbeatTimer\)/)
})
