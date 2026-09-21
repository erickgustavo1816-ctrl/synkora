import assert from 'node:assert/strict'
import test from 'node:test'
import * as spawnSkills from '../.tmp/skills-bundle-test/main/guiSpawnSkills.js'

function fixture(paneId) {
  const notes = []
  const events = []
  return {
    notes, events,
    ctx: { blackbox: { record: (event) => events.push(event) } },
    registry: { note: (id, text) => { notes.push({ id, text }); return { ok: true } } },
    spawn: { paneId, projectId: 'fixture-project' }
  }
}

function outcome(error = 'não está na biblioteca') {
  return {
    resolution: { chat: 'dev', reason: 'teste' },
    outcome: { ok: false, synced: [], removed: [], userModified: [], wrote: false, failures: [{ id: 'fixture-skill', error }] }
  }
}

test('identical failures are noted once per pane, changed text and another pane are noted again', () => {
  const f = fixture('gui-dev-dedupe')
  spawnSkills.noteSkillsSync(f.ctx, f.registry, f.spawn, outcome())
  spawnSkills.noteSkillsSync(f.ctx, f.registry, f.spawn, outcome())
  assert.equal(f.notes.length, 1, 'permission-mode respawn must not repeat the same failure note')
  assert.equal(f.events.length, 2, 'every sync remains observable')
  assert.equal(f.events[0].detail.noted, true)
  assert.equal(f.events[1].detail.noted, false)
  assert.equal(f.events[1].detail.deduped, true)
  spawnSkills.noteSkillsSync(f.ctx, f.registry, f.spawn, outcome('falha diferente'))
  assert.equal(f.notes.length, 2)
  assert.equal(f.events[2].detail.noted, true)
  spawnSkills.noteSkillsSync(f.ctx, f.registry, { ...f.spawn, paneId: 'gui-dev-other' }, outcome())
  assert.equal(f.notes.length, 3)
  assert.equal(f.events[3].detail.noted, true)
})

test('a rejected delivery can be retried and success does not erase the boot dedupe', () => {
  const f = fixture('gui-dev-retry')
  spawnSkills.noteSkillsSync(f.ctx, { note: () => ({ ok: false }) }, f.spawn, outcome())
  spawnSkills.noteSkillsSync(f.ctx, f.registry, f.spawn, outcome())
  const success = outcome()
  success.outcome.ok = true
  success.outcome.failures = []
  spawnSkills.noteSkillsSync(f.ctx, f.registry, f.spawn, success)
  spawnSkills.noteSkillsSync(f.ctx, f.registry, f.spawn, outcome())
  assert.equal(f.notes.length, 1)
  assert.equal(f.events[0].detail.noted, false)
  assert.equal(f.events[1].detail.noted, true)
  assert.equal(f.events[2].detail.noted, false)
  assert.equal(f.events[3].detail.deduped, true)
})

test('reset helper starts a fresh boot for the note cache', () => {
  const f = fixture('gui-dev-reset')
  spawnSkills.noteSkillsSync(f.ctx, f.registry, f.spawn, outcome())
  spawnSkills.resetSkillsSyncNotesForTests()
  spawnSkills.noteSkillsSync(f.ctx, f.registry, f.spawn, outcome())
  assert.equal(f.notes.length, 2)
})
