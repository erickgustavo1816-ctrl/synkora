import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'

// Exercise the real renderer store with an isolated, synthetic preload bridge.
const compiled = buildSync({
  stdin: {
    contents: `
      export { useStore } from './src/renderer/src/store';
      export { navigateFromCommandPalette } from './src/renderer/src/commandPaletteNavigation';
    `,
    resolveDir: process.cwd(),
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['react', 'zustand']
}).outputFiles[0].text

const missions = [
  { id: 'mission-a-01', projectId: 'project-a', status: 'ativa' },
  { id: 'mission-a-02', projectId: 'project-a', status: 'ativa' },
  { id: 'mission-b-03', projectId: 'project-b', status: 'ativa' }
]

function rendererHarness(list = async (id) => missions.filter((mission) => mission.projectId === id)) {
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', 'document', 'window', 'localStorage', compiled)(
    createRequire(import.meta.url), loaded, loaded.exports,
    { documentElement: { style: { setProperty() {} } } },
    { synkora: { missions: { list } } },
    { getItem: () => null }
  )
  return loaded.exports
}

function location(store) {
  const state = store.getState()
  return {
    projectId: state.openProjectId,
    tab: state.universeTabByProject[state.openProjectId] ?? 'board',
    missionId: state.missionTabByProject[state.openProjectId] ?? null
  }
}

test('first visits open the project overview and keep visited projects mounted', () => {
  const { useStore } = rendererHarness()
  const { openProject, setMissionTab } = useStore.getState()
  openProject('project-a')
  assert.deepEqual(location(useStore), { projectId: 'project-a', tab: 'board', missionId: null })
  setMissionTab('project-a', 'mission-a-01')
  openProject('project-b')
  assert.deepEqual(location(useStore), { projectId: 'project-b', tab: 'board', missionId: null })
  openProject('project-a')
  openProject(null)
  assert.deepEqual(useStore.getState().mountedProjects, ['project-a', 'project-b'])
})

test('A mission 01 and B mission 03 each return to their latest selection', () => {
  const { useStore } = rendererHarness()
  const { openProject, setMissionTab } = useStore.getState()
  openProject('project-a')
  setMissionTab('project-a', 'mission-a-01')
  openProject('project-b')
  setMissionTab('project-b', 'mission-b-03')

  for (const [projectId, missionId] of [
    ['project-a', 'mission-a-01'], ['project-b', 'mission-b-03'], ['project-a', 'mission-a-01']
  ]) {
    openProject(projectId)
    assert.deepEqual(location(useStore), { projectId, tab: 'board', missionId })
  }

  setMissionTab('project-a', 'mission-a-02')
  openProject('project-b')
  openProject('project-a')
  assert.equal(location(useStore).missionId, 'mission-a-02')
})

test('clicking the current project and returning through Home or Settings keep its mission', () => {
  const { useStore } = rendererHarness()
  const { openProject, setMissionTab, openSettings } = useStore.getState()
  openProject('project-a')
  setMissionTab('project-a', 'mission-a-01')
  for (const leave of [() => {}, () => openProject(null), () => openSettings()]) {
    leave()
    openProject('project-a')
    assert.equal(useStore.getState().appPage, 'workspace')
    assert.equal(location(useStore).missionId, 'mission-a-01')
  }
})

for (const tab of ['mapa', 'backlog', 'arquivos']) {
  test(`returning to a project restores its ${tab} tab without changing another project`, () => {
    const { useStore } = rendererHarness()
    const { openProject, setMissionTab, setUniverseTab, setMapTab } = useStore.getState()
    openProject('project-a')
    setMissionTab('project-a', 'mission-a-01')
    setUniverseTab('project-a', tab)
    setMapTab('project-a', 'plan-a')
    openProject('project-b')
    setMissionTab('project-b', 'mission-b-03')
    openProject('project-a')
    assert.deepEqual(location(useStore), { projectId: 'project-a', tab, missionId: 'mission-a-01' })
    assert.equal(useStore.getState().mapTabByProject['project-a'], 'plan-a')
    setUniverseTab('project-a', 'board')
    assert.equal(location(useStore).missionId, 'mission-a-01')
    openProject('project-b')
    assert.deepEqual(location(useStore), { projectId: 'project-b', tab: 'board', missionId: 'mission-b-03' })
  })
}

test('explicitly choosing the overview replaces the previously remembered mission', () => {
  const { useStore } = rendererHarness()
  const { openProject, setMissionTab } = useStore.getState()
  openProject('project-a')
  setMissionTab('project-a', 'mission-a-01')
  setMissionTab('project-a', null)
  openProject('project-b')
  setMissionTab('project-b', 'mission-b-03')
  openProject('project-a')
  assert.deepEqual(location(useStore), { projectId: 'project-a', tab: 'board', missionId: null })
  assert.equal(useStore.getState().missionTabByProject['project-b'], 'mission-b-03')
})

test('rapid project switches preserve the selection while ignoring late mission lists from another project', async () => {
  const pending = []
  const { useStore } = rendererHarness((id) => new Promise((resolve) => pending.push({ id, resolve })))
  const { openProject, setMissionTab } = useStore.getState()
  openProject('project-a')
  pending[0].resolve(missions.filter((mission) => mission.projectId === 'project-a'))
  await Promise.resolve()
  setMissionTab('project-a', 'mission-a-01')
  openProject('project-b')
  setMissionTab('project-b', 'mission-b-03')
  openProject('project-a')
  assert.deepEqual(pending.map((request) => request.id), ['project-a', 'project-b', 'project-a'])
  assert.equal(location(useStore).missionId, 'mission-a-01', 'keep the selection during loading')
  pending[2].resolve(missions.filter((mission) => mission.projectId === 'project-a'))
  await Promise.resolve()
  pending[1].resolve(missions.filter((mission) => mission.projectId === 'project-b'))
  await Promise.resolve()
  assert.deepEqual(useStore.getState().missions, missions.filter((mission) => mission.projectId === 'project-a'))
  assert.equal(location(useStore).missionId, 'mission-a-01')
  assert.equal(useStore.getState().missionTabByProject['project-b'], 'mission-b-03')
})

test('an explicit palette destination takes precedence and becomes the remembered location', async () => {
  const { useStore, navigateFromCommandPalette } = rendererHarness()
  const { openProject, setMissionTab, setUniverseTab } = useStore.getState()
  openProject('project-a')
  setMissionTab('project-a', 'mission-a-01')
  setUniverseTab('project-a', 'arquivos')
  openProject('project-b')
  await navigateFromCommandPalette({ kind: 'project', projectId: 'project-a', tab: 'board', missionId: 'mission-a-02' })
  assert.deepEqual(location(useStore), { projectId: 'project-a', tab: 'board', missionId: 'mission-a-02' })
  openProject('project-b')
  openProject('project-a')
  assert.equal(location(useStore).missionId, 'mission-a-02')
  await navigateFromCommandPalette({ kind: 'project', projectId: 'project-a', tab: 'board', missionId: null })
  assert.equal(location(useStore).missionId, null)
})

test('returning to a loaded project publishes its missions immediately and keeps both snapshots', async () => {
  const pending = []
  const { useStore } = rendererHarness(id => new Promise(resolve => pending.push({ id, resolve })))
  const { openProject, setMissionTab } = useStore.getState()
  const a = missions.filter(m => m.projectId === 'project-a')
  const b = missions.filter(m => m.projectId === 'project-b')
  openProject('project-a')
  pending[0].resolve(a)
  await Promise.resolve()
  setMissionTab('project-a', a[0].id)
  openProject('project-b')
  pending[1].resolve(b)
  await Promise.resolve()
  setMissionTab('project-b', b[0].id)
  const frames = []
  const off = useStore.subscribe(state => frames.push({ project: state.openProjectId, missions: state.missions }))
  openProject('project-a')
  assert.deepEqual(frames, [{ project: 'project-a', missions: a }], 'no render sees another project or an empty mission list')
  assert.equal(useStore.getState().missionsByProject['project-b'], b, 'hidden project retains its mounted mission data')
  pending[2].resolve([...a])
  await Promise.resolve()
  openProject('project-b')
  assert.equal(useStore.getState().missions, b, 'B restores synchronously too')
  assert.equal(useStore.getState().missionsByProject['project-a'].length, 2)
  off()
})

test('A to B to A ignores older reads of A and caches B without replacing the active list', async () => {
  const pending = []
  const { useStore } = rendererHarness(id => new Promise(resolve => pending.push({ id, resolve })))
  const { openProject } = useStore.getState()
  openProject('project-a')
  openProject('project-b')
  openProject('project-a')
  const current = missions.filter(m => m.projectId === 'project-a')
  pending[2].resolve(current)
  await Promise.resolve()
  pending[0].resolve([])
  await Promise.resolve()
  assert.equal(useStore.getState().missions, current, 'late first visit cannot erase the current mission')
  const b = missions.filter(m => m.projectId === 'project-b')
  pending[1].resolve(b)
  await Promise.resolve()
  assert.equal(useStore.getState().missions, current)
  assert.equal(useStore.getState().missionsByProject['project-b'], b)
  openProject('project-b')
  assert.equal(useStore.getState().missions, b)
})
