import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildSync } from 'esbuild'

// The pure layout operations (shared) and the main-process store, bundled
// together: the shared module imports runtime values without an extension.
const compiled = buildSync({
  stdin: {
    contents: `
      export * from './src/shared/projectLayoutOps';
      export { PROJECT_GROUP_NAME_MAX } from './src/shared/projectLayout';
      export { ProjectLayoutStore } from './src/main/projectLayoutStore';
    `,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false
}).outputFiles[0].text

const loaded = { exports: {} }
new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), loaded, loaded.exports)
const {
  emptyProjectLayout,
  sanitizeProjectLayout,
  reconcileProjectLayout,
  applyProjectLayoutOp,
  PROJECT_GROUP_NAME_MAX,
  ProjectLayoutStore
} = loaded.exports

// ——— builders ———
const p = (projectId) => ({ kind: 'project', projectId })
const g = (id, projectIds, extra = {}) => ({
  kind: 'group',
  id,
  name: extra.name ?? id,
  hue: extra.hue ?? null,
  open: extra.open ?? false,
  projectIds
})
const layoutOf = (entries, lastOpenedAt = {}) => ({ entries, lastOpenedAt })

/** 'a' for a loose project, 'g1[b,c]' for a group — readable asserts */
const shape = (layout) =>
  layout.entries.map((e) => (e.kind === 'project' ? e.projectId : `${e.id}[${e.projectIds.join(',')}]`))

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const seq = () => {
  let n = 0
  return () => `new-${++n}`
}
const run = (layout, op) => applyProjectLayoutOp(deepFreeze(layout), op, { newId: seq() })

// [a, g1[b,c], d, g2[e]]
const base = () => layoutOf([p('a'), g('g1', ['b', 'c']), p('d'), g('g2', ['e'])], { a: '2026-09-01T00:00:00.000Z' })

// ————————————————————————————————————————————————————————————————
// immutability and totality
// ————————————————————————————————————————————————————————————————

test('every op leaves a deep-frozen input untouched and never throws', () => {
  const ops = [
    { op: 'moveProject', projectId: 'a', target: { type: 'after', ref: { kind: 'project', projectId: 'd' } } },
    { op: 'moveProject', projectId: 'b', target: { type: 'before', ref: { kind: 'group', groupId: 'g1' } } },
    { op: 'moveProject', projectId: 'd', target: { type: 'combine', projectId: 'a' } },
    { op: 'moveProject', projectId: 'a', target: { type: 'into', groupId: 'g1' } },
    { op: 'moveProject', projectId: 'e', target: { type: 'first-in', groupId: 'g1' } },
    { op: 'moveGroup', groupId: 'g2', target: { type: 'before', ref: { kind: 'project', projectId: 'a' } } },
    { op: 'createGroup', projectId: 'c' },
    { op: 'moveToGroup', projectId: 'a', groupId: 'g2' },
    { op: 'removeFromGroup', projectId: 'b' },
    { op: 'renameGroup', groupId: 'g1', name: 'novo' },
    { op: 'setGroupHue', groupId: 'g1', hue: 21 },
    { op: 'setGroupOpen', groupId: 'g1', open: true },
    { op: 'dissolveGroup', groupId: 'g1' },
    { op: 'touchOpened', projectId: 'c', at: '2026-09-29T10:00:00.000Z' },
    // garbage from an untrusted caller
    null,
    undefined,
    42,
    {},
    { op: 'nope' },
    { op: 'moveProject', projectId: 'a' },
    { op: 'moveProject', projectId: 'a', target: null },
    { op: 'moveProject', projectId: 'a', target: { type: 'before' } },
    { op: 'moveGroup', groupId: 'g1', target: { type: 'after', ref: null } },
    { op: 'renameGroup', groupId: 'g1', name: 7 }
  ]
  for (const op of ops) {
    const input = deepFreeze(base())
    const snapshot = JSON.stringify(input)
    let result
    assert.doesNotThrow(() => {
      result = applyProjectLayoutOp(input, op, { newId: seq() })
    }, `op ${JSON.stringify(op)}`)
    assert.equal(JSON.stringify(input), snapshot, `op ${JSON.stringify(op)} mutated its input`)
    assert.ok(result && Array.isArray(result.layout.entries), `op ${JSON.stringify(op)} returned no layout`)
  }
})

test('an unknown project or group id returns the layout unchanged', () => {
  const ghostProject = { kind: 'project', projectId: 'zz' }
  const ghostGroup = { kind: 'group', groupId: 'gz' }
  const ops = [
    { op: 'moveProject', projectId: 'zz', target: { type: 'after', ref: { kind: 'project', projectId: 'a' } } },
    { op: 'moveProject', projectId: 'a', target: { type: 'after', ref: ghostProject } },
    { op: 'moveProject', projectId: 'a', target: { type: 'before', ref: ghostGroup } },
    { op: 'moveProject', projectId: 'a', target: { type: 'combine', projectId: 'zz' } },
    { op: 'moveProject', projectId: 'a', target: { type: 'into', groupId: 'gz' } },
    { op: 'moveProject', projectId: 'a', target: { type: 'first-in', groupId: 'gz' } },
    { op: 'moveGroup', groupId: 'gz', target: { type: 'after', ref: { kind: 'project', projectId: 'a' } } },
    { op: 'moveGroup', groupId: 'g1', target: { type: 'after', ref: ghostProject } },
    { op: 'createGroup', projectId: 'zz' },
    { op: 'moveToGroup', projectId: 'zz', groupId: 'g1' },
    { op: 'moveToGroup', projectId: 'a', groupId: 'gz' },
    { op: 'removeFromGroup', projectId: 'zz' },
    { op: 'removeFromGroup', projectId: 'a' },
    { op: 'renameGroup', groupId: 'gz', name: 'x' },
    { op: 'setGroupHue', groupId: 'gz', hue: 21 },
    { op: 'setGroupOpen', groupId: 'gz', open: true },
    { op: 'dissolveGroup', groupId: 'gz' },
    { op: 'touchOpened', projectId: 'zz', at: '2026-09-29T10:00:00.000Z' }
  ]
  for (const op of ops) {
    const input = base()
    const result = run(input, op)
    assert.deepEqual(result.layout, base(), `op ${JSON.stringify(op)}`)
    assert.equal(result.createdGroupId, undefined)
  }
})

// ————————————————————————————————————————————————————————————————
// pruning
// ————————————————————————————————————————————————————————————————

test('a group emptied by an op disappears while a one-project group survives', () => {
  const emptied = run(base(), {
    op: 'moveProject',
    projectId: 'e',
    target: { type: 'before', ref: { kind: 'project', projectId: 'a' } }
  })
  assert.deepEqual(shape(emptied.layout), ['e', 'a', 'g1[b,c]', 'd'])

  const leftWithOne = run(base(), {
    op: 'moveProject',
    projectId: 'b',
    target: { type: 'after', ref: { kind: 'project', projectId: 'd' } }
  })
  assert.deepEqual(shape(leftWithOne.layout), ['a', 'g1[c]', 'd', 'b', 'g2[e]'])
})

test('pruning runs after every op, even ones that do not move projects', () => {
  const withEmpty = layoutOf([p('a'), g('g0', []), g('g1', ['b'])])
  const result = run(withEmpty, { op: 'setGroupOpen', groupId: 'g1', open: true })
  assert.deepEqual(shape(result.layout), ['a', 'g1[b]'])
})

// ————————————————————————————————————————————————————————————————
// moveProject
// ————————————————————————————————————————————————————————————————

test('moveProject before/after a top-level project lands top-level', () => {
  const before = run(base(), {
    op: 'moveProject',
    projectId: 'd',
    target: { type: 'before', ref: { kind: 'project', projectId: 'a' } }
  })
  assert.deepEqual(shape(before.layout), ['d', 'a', 'g1[b,c]', 'g2[e]'])

  const after = run(base(), {
    op: 'moveProject',
    projectId: 'a',
    target: { type: 'after', ref: { kind: 'project', projectId: 'd' } }
  })
  assert.deepEqual(shape(after.layout), ['g1[b,c]', 'd', 'a', 'g2[e]'])
})

test('moveProject relative to a project inside a group lands in that group at that position', () => {
  const into = run(base(), {
    op: 'moveProject',
    projectId: 'a',
    target: { type: 'after', ref: { kind: 'project', projectId: 'b' } }
  })
  assert.deepEqual(shape(into.layout), ['g1[b,a,c]', 'd', 'g2[e]'])

  const reorder = run(base(), {
    op: 'moveProject',
    projectId: 'c',
    target: { type: 'before', ref: { kind: 'project', projectId: 'b' } }
  })
  assert.deepEqual(shape(reorder.layout), ['a', 'g1[c,b]', 'd', 'g2[e]'])
})

test('moveProject relative to a top-level group lands top-level beside it', () => {
  const before = run(base(), {
    op: 'moveProject',
    projectId: 'b',
    target: { type: 'before', ref: { kind: 'group', groupId: 'g2' } }
  })
  assert.deepEqual(shape(before.layout), ['a', 'g1[c]', 'd', 'b', 'g2[e]'])

  const after = run(base(), {
    op: 'moveProject',
    projectId: 'a',
    target: { type: 'after', ref: { kind: 'group', groupId: 'g1' } }
  })
  assert.deepEqual(shape(after.layout), ['g1[b,c]', 'a', 'd', 'g2[e]'])
})

test('moveProject relative to the group it just emptied inserts there and only then prunes', () => {
  for (const type of ['before', 'after']) {
    const result = run(base(), {
      op: 'moveProject',
      projectId: 'e',
      target: { type, ref: { kind: 'group', groupId: 'g2' } }
    })
    assert.deepEqual(shape(result.layout), ['a', 'g1[b,c]', 'd', 'e'], type)
  }
})

test('dragging a project onto itself is a no-op', () => {
  for (const type of ['before', 'after']) {
    for (const id of ['a', 'b']) {
      const result = run(base(), {
        op: 'moveProject',
        projectId: id,
        target: { type, ref: { kind: 'project', projectId: id } }
      })
      assert.deepEqual(result.layout, base(), `${type} ${id}`)
    }
  }
  const combineSelf = run(base(), { op: 'moveProject', projectId: 'a', target: { type: 'combine', projectId: 'a' } })
  assert.deepEqual(combineSelf.layout, base())
})

test('combine replaces a loose target in place with a new closed neutral group [target, dragged]', () => {
  const result = run(base(), { op: 'moveProject', projectId: 'd', target: { type: 'combine', projectId: 'a' } })
  assert.deepEqual(shape(result.layout), ['new-1[a,d]', 'g1[b,c]', 'g2[e]'])
  const created = result.layout.entries[0]
  assert.equal(result.createdGroupId, 'new-1')
  assert.equal(created.hue, null)
  assert.equal(created.open, false)
  assert.equal(created.name, 'grupo 1')
})

test('combine pulls a project out of its group and prunes the emptied group', () => {
  const result = run(base(), { op: 'moveProject', projectId: 'e', target: { type: 'combine', projectId: 'd' } })
  assert.deepEqual(shape(result.layout), ['a', 'g1[b,c]', 'new-1[d,e]'])
})

test('combine onto a project inside a group is refused', () => {
  const result = run(base(), { op: 'moveProject', projectId: 'a', target: { type: 'combine', projectId: 'b' } })
  assert.deepEqual(result.layout, base())
  assert.equal(result.createdGroupId, undefined)
})

test('a new group takes the first free "grupo N", case- and accent-insensitively', () => {
  const layout = layoutOf([
    p('a'),
    p('b'),
    g('g1', ['c'], { name: 'Grupo 1' }),
    g('g2', ['d'], { name: 'GRÚPO 2' }),
    g('g4', ['e'], { name: 'grupo 4' })
  ])
  const result = run(layout, { op: 'moveProject', projectId: 'b', target: { type: 'combine', projectId: 'a' } })
  assert.equal(result.layout.entries[0].name, 'grupo 3')
})

test('into appends to the group and is a no-op when the project is already there', () => {
  const into = run(base(), { op: 'moveProject', projectId: 'a', target: { type: 'into', groupId: 'g1' } })
  assert.deepEqual(shape(into.layout), ['g1[b,c,a]', 'd', 'g2[e]'])

  const already = run(base(), { op: 'moveProject', projectId: 'b', target: { type: 'into', groupId: 'g1' } })
  assert.deepEqual(already.layout, base())
})

test('first-in prepends to the group', () => {
  const fromOutside = run(base(), { op: 'moveProject', projectId: 'd', target: { type: 'first-in', groupId: 'g1' } })
  assert.deepEqual(shape(fromOutside.layout), ['a', 'g1[d,b,c]', 'g2[e]'])

  const fromInside = run(base(), { op: 'moveProject', projectId: 'c', target: { type: 'first-in', groupId: 'g1' } })
  assert.deepEqual(shape(fromInside.layout), ['a', 'g1[c,b]', 'd', 'g2[e]'])
})

// ————————————————————————————————————————————————————————————————
// moveGroup
// ————————————————————————————————————————————————————————————————

test('moveGroup reorders groups only at the top level', () => {
  const beforeProject = run(base(), {
    op: 'moveGroup',
    groupId: 'g2',
    target: { type: 'before', ref: { kind: 'project', projectId: 'a' } }
  })
  assert.deepEqual(shape(beforeProject.layout), ['g2[e]', 'a', 'g1[b,c]', 'd'])

  const afterGroup = run(base(), {
    op: 'moveGroup',
    groupId: 'g1',
    target: { type: 'after', ref: { kind: 'group', groupId: 'g2' } }
  })
  assert.deepEqual(shape(afterGroup.layout), ['a', 'd', 'g2[e]', 'g1[b,c]'])
})

test('moveGroup relative to a project inside another group treats it as that group (never nests)', () => {
  const result = run(base(), {
    op: 'moveGroup',
    groupId: 'g2',
    target: { type: 'before', ref: { kind: 'project', projectId: 'c' } }
  })
  assert.deepEqual(shape(result.layout), ['a', 'g2[e]', 'g1[b,c]', 'd'])
  for (const e of result.layout.entries) {
    if (e.kind === 'group') assert.ok(e.projectIds.every((id) => typeof id === 'string'))
  }
})

test('moveGroup relative to itself (or its own project) is a no-op', () => {
  const self = run(base(), { op: 'moveGroup', groupId: 'g1', target: { type: 'after', ref: { kind: 'group', groupId: 'g1' } } })
  assert.deepEqual(self.layout, base())
  const ownChild = run(base(), {
    op: 'moveGroup',
    groupId: 'g1',
    target: { type: 'before', ref: { kind: 'project', projectId: 'b' } }
  })
  assert.deepEqual(ownChild.layout, base())
})

// ————————————————————————————————————————————————————————————————
// menu ops
// ————————————————————————————————————————————————————————————————

test('createGroup wraps a loose project in place', () => {
  const result = run(base(), { op: 'createGroup', projectId: 'd' })
  assert.deepEqual(shape(result.layout), ['a', 'g1[b,c]', 'new-1[d]', 'g2[e]'])
  assert.equal(result.createdGroupId, 'new-1')
  assert.equal(result.layout.entries[2].name, 'grupo 1')
  assert.equal(result.layout.entries[2].open, false)
  assert.equal(result.layout.entries[2].hue, null)
})

test('createGroup from inside a group puts the new group right after the old one', () => {
  const result = run(base(), { op: 'createGroup', projectId: 'b' })
  assert.deepEqual(shape(result.layout), ['a', 'g1[c]', 'new-1[b]', 'd', 'g2[e]'])
  assert.equal(result.createdGroupId, 'new-1')

  const lastOne = run(base(), { op: 'createGroup', projectId: 'e' })
  assert.deepEqual(shape(lastOne.layout), ['a', 'g1[b,c]', 'd', 'new-1[e]'])
})

test('a created group id never collides with an existing group id', () => {
  const ids = ['g1', 'g2', 'fresh']
  const result = applyProjectLayoutOp(deepFreeze(base()), { op: 'createGroup', projectId: 'a' }, { newId: () => ids.shift() })
  assert.equal(result.createdGroupId, 'fresh')
  const groupIds = result.layout.entries.filter((e) => e.kind === 'group').map((e) => e.id)
  assert.equal(new Set(groupIds).size, groupIds.length)
})

test('without newId the op still mints a unique group id', () => {
  const result = applyProjectLayoutOp(deepFreeze(base()), { op: 'createGroup', projectId: 'a' })
  assert.equal(typeof result.createdGroupId, 'string')
  assert.ok(result.createdGroupId.length > 0)
  assert.ok(!['g1', 'g2'].includes(result.createdGroupId))
})

test('moveToGroup appends and removeFromGroup lands right after the old group', () => {
  const moved = run(base(), { op: 'moveToGroup', projectId: 'a', groupId: 'g2' })
  assert.deepEqual(shape(moved.layout), ['g1[b,c]', 'd', 'g2[e,a]'])

  const already = run(base(), { op: 'moveToGroup', projectId: 'b', groupId: 'g1' })
  assert.deepEqual(already.layout, base())

  const out = run(base(), { op: 'removeFromGroup', projectId: 'b' })
  assert.deepEqual(shape(out.layout), ['a', 'g1[c]', 'b', 'd', 'g2[e]'])

  const lastOut = run(base(), { op: 'removeFromGroup', projectId: 'e' })
  assert.deepEqual(shape(lastOut.layout), ['a', 'g1[b,c]', 'd', 'e'])
})

test('renameGroup trims, cuts to the max and keeps the previous name when empty', () => {
  const trimmed = run(base(), { op: 'renameGroup', groupId: 'g1', name: '  trabalho  ' })
  assert.equal(trimmed.layout.entries[1].name, 'trabalho')

  const long = 'x'.repeat(PROJECT_GROUP_NAME_MAX + 10)
  const cut = run(base(), { op: 'renameGroup', groupId: 'g1', name: long })
  assert.equal(cut.layout.entries[1].name, 'x'.repeat(PROJECT_GROUP_NAME_MAX))

  for (const blank of ['', '   ', '\n\t']) {
    const kept = run(base(), { op: 'renameGroup', groupId: 'g1', name: blank })
    assert.equal(kept.layout.entries[1].name, 'g1')
  }
})

test('setGroupHue accepts only the house hues or null', () => {
  const colored = run(base(), { op: 'setGroupHue', groupId: 'g1', hue: 145 })
  assert.equal(colored.layout.entries[1].hue, 145)

  const neutral = run(layoutOf([g('g1', ['a'], { hue: 21 })]), { op: 'setGroupHue', groupId: 'g1', hue: null })
  assert.equal(neutral.layout.entries[0].hue, null)

  for (const bad of [22, -1, '21', undefined]) {
    const kept = run(layoutOf([g('g1', ['a'], { hue: 21 })]), { op: 'setGroupHue', groupId: 'g1', hue: bad })
    assert.equal(kept.layout.entries[0].hue, 21, String(bad))
  }
})

test('setGroupOpen opens and closes a group', () => {
  const opened = run(base(), { op: 'setGroupOpen', groupId: 'g1', open: true })
  assert.equal(opened.layout.entries[1].open, true)
  const closed = run(opened.layout, { op: 'setGroupOpen', groupId: 'g1', open: false })
  assert.equal(closed.layout.entries[1].open, false)
})

test('dissolveGroup leaves its projects loose in the same place, in group order', () => {
  const result = run(base(), { op: 'dissolveGroup', groupId: 'g1' })
  assert.deepEqual(shape(result.layout), ['a', 'b', 'c', 'd', 'g2[e]'])
})

test('touchOpened stamps lastOpenedAt only for projects in the layout', () => {
  const at = '2026-09-29T10:00:00.000Z'
  const result = run(base(), { op: 'touchOpened', projectId: 'c', at })
  assert.deepEqual(result.layout.lastOpenedAt, { a: '2026-09-01T00:00:00.000Z', c: at })
  assert.deepEqual(result.layout.entries, base().entries)

  const again = run(result.layout, { op: 'touchOpened', projectId: 'a', at })
  assert.equal(again.layout.lastOpenedAt.a, at)
})

// ————————————————————————————————————————————————————————————————
// reconcile / sanitize
// ————————————————————————————————————————————————————————————————

test('reconcile drops unknown ids from entries and lastOpenedAt and prunes emptied groups', () => {
  const layout = layoutOf([p('a'), p('ghost'), g('g1', ['gone']), g('g2', ['b', 'gone2'])], {
    a: '2026-09-01T00:00:00.000Z',
    ghost: '2026-09-02T00:00:00.000Z'
  })
  const result = reconcileProjectLayout(deepFreeze(layout), ['a', 'b'])
  assert.deepEqual(shape(result), ['a', 'g2[b]'])
  assert.deepEqual(result.lastOpenedAt, { a: '2026-09-01T00:00:00.000Z' })
})

test('reconcile dedupes ids (first occurrence wins) and appends missing projects at the end in order', () => {
  const layout = layoutOf([g('g1', ['b', 'a', 'b']), p('a'), p('c'), g('g1', ['c'])])
  const result = reconcileProjectLayout(deepFreeze(layout), ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(shape(result), ['g1[b,a]', 'c', 'd', 'e'])
})

test('reconcile sanitizes names, hues and open', () => {
  const layout = layoutOf([
    { kind: 'group', id: 'g1', name: '   ', hue: 999, open: 'yes', projectIds: ['a'] },
    { kind: 'group', id: 'g2', name: `  ${'y'.repeat(40)}  `, hue: 285, open: true, projectIds: ['b'] },
    { kind: 'group', id: 'g3', name: 'grupo 1', hue: null, open: false, projectIds: ['c'] }
  ])
  const result = reconcileProjectLayout(deepFreeze(layout), ['a', 'b', 'c'])
  const [g1, g2, g3] = result.entries
  assert.equal(g1.name, 'grupo 2')
  assert.equal(g1.hue, null)
  assert.equal(g1.open, false)
  assert.equal(g2.name, 'y'.repeat(PROJECT_GROUP_NAME_MAX))
  assert.equal(g2.hue, 285)
  assert.equal(g2.open, true)
  assert.equal(g3.name, 'grupo 1')
})

test('reconcile of an already reconciled layout returns the same reference', () => {
  const layout = deepFreeze(base())
  assert.equal(reconcileProjectLayout(layout, ['a', 'b', 'c', 'd', 'e']), layout)
  assert.notEqual(reconcileProjectLayout(layout, ['a', 'b', 'c', 'd', 'e', 'f']), layout)
})

test('sanitize never throws and reads garbage as an empty layout', () => {
  for (const raw of [null, undefined, 42, 'x', [], { entries: 'no' }, { entries: null, lastOpenedAt: 3 }]) {
    let result
    assert.doesNotThrow(() => {
      result = sanitizeProjectLayout(raw)
    })
    assert.deepEqual(result, emptyProjectLayout(), JSON.stringify(raw))
  }
})

test('sanitize keeps valid entries and drops malformed ones', () => {
  const raw = {
    entries: [
      { kind: 'project', projectId: 'a' },
      { kind: 'project', projectId: 3 },
      { kind: 'weird' },
      null,
      { kind: 'group', id: 'g1', name: 'trabalho', hue: 21, open: true, projectIds: ['b', 7, 'c'] },
      { kind: 'group', id: 'g2', name: 'vazio', hue: null, open: false, projectIds: [] },
      { kind: 'group', name: 'sem id', projectIds: ['d'] }
    ],
    lastOpenedAt: { a: '2026-09-01T00:00:00.000Z', b: 5, c: 'not a date' }
  }
  const result = sanitizeProjectLayout(raw)
  assert.deepEqual(shape(result), ['a', 'g1[b,c]', 'd'])
  assert.deepEqual(result.entries[1], g('g1', ['b', 'c'], { name: 'trabalho', hue: 21, open: true }))
  assert.deepEqual(result.lastOpenedAt, { a: '2026-09-01T00:00:00.000Z' })
})

test('emptyProjectLayout returns a fresh object each time', () => {
  const one = emptyProjectLayout()
  one.entries.push(p('a'))
  assert.deepEqual(emptyProjectLayout(), { entries: [], lastOpenedAt: {} })
})

// ————————————————————————————————————————————————————————————————
// ProjectLayoutStore (main)
// ————————————————————————————————————————————————————————————————

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'synkora-layout-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('store persists ops and reloads them from disk', () => {
  withTempDir((dir) => {
    const file = join(dir, 'project-layout.json')
    const projectIds = ['a', 'b', 'c']
    const store = new ProjectLayoutStore({ file, listProjectIds: () => projectIds, newId: seq() })
    assert.deepEqual(shape(store.get()), ['a', 'b', 'c'])

    const result = store.apply({ op: 'moveProject', projectId: 'c', target: { type: 'combine', projectId: 'a' } })
    assert.equal(result.createdGroupId, 'new-1')
    store.apply({ op: 'renameGroup', groupId: 'new-1', name: 'trabalho' })
    store.apply({ op: 'touchOpened', projectId: 'b', at: '2026-09-29T10:00:00.000Z' })

    const reopened = new ProjectLayoutStore({ file, listProjectIds: () => projectIds })
    const layout = reopened.get()
    assert.deepEqual(shape(layout), ['new-1[a,c]', 'b'])
    assert.equal(layout.entries[0].name, 'trabalho')
    assert.deepEqual(layout.lastOpenedAt, { b: '2026-09-29T10:00:00.000Z' })
  })
})

test('store loads a corrupt file as a flat layout of the current projects', () => {
  withTempDir((dir) => {
    const file = join(dir, 'project-layout.json')
    writeFileSync(file, '{ not json', 'utf8')
    const store = new ProjectLayoutStore({ file, listProjectIds: () => ['x', 'y'] })
    assert.deepEqual(store.get(), { entries: [p('x'), p('y')], lastOpenedAt: {} })
  })
})

test('store get always reflects the current project list', () => {
  withTempDir((dir) => {
    const file = join(dir, 'project-layout.json')
    let projectIds = ['a', 'b']
    const store = new ProjectLayoutStore({ file, listProjectIds: () => projectIds, newId: seq() })
    store.apply({ op: 'createGroup', projectId: 'a' })
    projectIds = ['a', 'b', 'c']
    assert.deepEqual(shape(store.get()), ['new-1[a]', 'b', 'c'])
    projectIds = ['b', 'c']
    assert.deepEqual(shape(store.get()), ['b', 'c'])
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(shape(onDisk), ['b', 'c'])
  })
})

test('store reconcile reports and persists a change exactly once', () => {
  withTempDir((dir) => {
    const file = join(dir, 'project-layout.json')
    let projectIds = ['a']
    const store = new ProjectLayoutStore({ file, listProjectIds: () => projectIds })
    store.get()
    projectIds = ['a', 'b']
    const first = store.reconcile()
    assert.equal(first.changed, true)
    assert.deepEqual(shape(first.layout), ['a', 'b'])
    assert.deepEqual(shape(JSON.parse(readFileSync(file, 'utf8'))), ['a', 'b'])
    const second = store.reconcile()
    assert.equal(second.changed, false)
  })
})

test('store does not write when an op changes nothing', () => {
  withTempDir((dir) => {
    const file = join(dir, 'project-layout.json')
    const writes = []
    const store = new ProjectLayoutStore({
      file,
      listProjectIds: () => ['a', 'b'],
      persist: (target, layout) => writes.push([target, shape(layout)])
    })
    store.get()
    const before = writes.length
    store.apply({ op: 'dissolveGroup', groupId: 'nope' })
    assert.equal(writes.length, before)
    store.apply({ op: 'moveProject', projectId: 'b', target: { type: 'before', ref: { kind: 'project', projectId: 'a' } } })
    assert.deepEqual(writes.at(-1), [file, ['b', 'a']])
    assert.equal(existsSync(file), false, 'the injected persist replaces the disk write')
  })
})

test('store never persists an empty project list over a saved layout', () => {
  // projects.json that fails to read yields [] silently: serving the empty view
  // is fine, writing it would wipe groups, names and colors (main and .bak)
  withTempDir((dir) => {
    const file = join(dir, 'project-layout.json')
    let projectIds = ['a', 'b', 'c']
    const store = new ProjectLayoutStore({ file, listProjectIds: () => projectIds, newId: seq() })
    store.apply({ op: 'moveProject', projectId: 'b', target: { type: 'combine', projectId: 'a' } })
    const saved = readFileSync(file, 'utf8')
    projectIds = []
    assert.deepEqual(store.get(), { entries: [], lastOpenedAt: {} })
    assert.equal(store.reconcile().changed, false)
    assert.equal(readFileSync(file, 'utf8'), saved)
    projectIds = ['a', 'b', 'c']
    const reopened = new ProjectLayoutStore({ file, listProjectIds: () => projectIds })
    assert.equal(reopened.get().entries[0].kind, 'group')
  })
})
