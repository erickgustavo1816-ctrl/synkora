import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'
import { buildSync } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { guiMissionSystemPrompt, missionIntegrationStimulus } from '../src/main/guiMissionContracts.ts'

function loadComponent(entryPoint) {
  const compiled = buildSync({ entryPoints: [entryPoint], bundle: true,
    platform: 'node', format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' },
    external: ['react', 'react/jsx-runtime'] }).outputFiles[0].text
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), loaded, loaded.exports)
  return loaded.exports
}

const { buildMissionSummaries, MISSION_SUMMARY_MAX } = loadComponent('src/main/missionSummary.ts')
const identity = { role: 'gui-delegator', paneId: 'gui-dev-12345678', projectId: 'p1', missionId: '12345678-mission' }
const summary = 'A busca voltou a encontrar os itens pelo nome. Agora é possível localizar o que você precisa sem repetir a pesquisa.'

function fixture(patch = {}) {
  let mission = { id: identity.missionId, projectId: 'p1', title: 'Restore search', status: 'ativa', direct: true, ...patch }
  const writes = []
  const changed = []
  const audits = []
  const reconciled = []
  const deps = {
    missions: {
      get: id => id === mission.id ? mission : undefined,
      update: (id, patch) => {
        assert.equal(id, mission.id)
        writes.push(patch)
        mission = { ...mission, ...patch }
        return mission
      }
    },
    reconcile: value => { reconciled.push(value); return true },
    changed: projectId => changed.push(projectId),
    audit: value => audits.push(value.id)
  }
  return { deps, api: buildMissionSummaries(deps), get: () => mission, writes, changed, audits, reconciled }
}

test('the dev records its result before integration, reusing a durable summary on retry', () => {
  const f = fixture()
  assert.equal(f.api.prepareIntegration(identity).ok, false)
  assert.match(f.api.prepareIntegration(identity).text, /mission_summary.*integration_run/u)
  assert.equal(f.api.save(identity, `  ${summary}\n`).ok, true)
  assert.equal(f.get().summary, summary)
  assert.equal(f.get().status, 'ativa', 'saving notes cannot complete or enqueue a mission')
  assert.equal(f.api.prepareIntegration(identity).ok, true)
  assert.equal(f.writes.length, 1)
  assert.deepEqual(f.audits, [identity.missionId])
  assert.ok(f.changed.every(id => id === identity.projectId))
  assert.equal(f.reconciled.length, 0)
  const revised = 'A busca encontra os itens mesmo quando você digita apenas parte do nome. Os resultados aparecem sem repetir a pesquisa.'
  assert.equal(f.api.prepareIntegration(identity, revised).ok, true)
  assert.equal(f.get().summary, revised)
})

test('other chats, projects, mission types and archived missions cannot write these notes', () => {
  const f = fixture()
  for (const patch of [
    { role: 'ajudante' }, { role: 'gui-release' }, { role: 'gui-planner' },
    { paneId: 'gui-reviewer-12345678' }, { paneId: 'gui-helper-12345678-1' },
    { paneId: 'gui-dev-other-id' }, { projectId: 'other-project' },
    { missionId: 'another-mission' }, { missionId: undefined }
  ]) assert.equal(f.api.save({ ...identity, ...patch }, summary).ok, false)
  for (const patch of [{ missionType: 'release' }, { missionType: 'planejamento' }, { status: 'arquivada' }]) {
    assert.equal(fixture(patch).api.save(identity, summary).ok, false)
  }
  assert.equal(f.writes.length, 0)
  assert.equal(f.changed.length, 0)
})

test('empty, oversized or invalid input is refused and sensitive text is redacted before persistence', () => {
  const f = fixture()
  for (const invalid of [undefined, null, 10, {}, '', ' \r\n ', 'x'.repeat(MISSION_SUMMARY_MAX + 1)]) {
    assert.equal(f.api.save(identity, invalid).ok, false)
  }
  assert.equal(f.writes.length, 0)
  assert.equal(f.api.save(identity, 'Authorization: Bearer abcdefghijklmnop').ok, true)
  assert.doesNotMatch(f.get().summary, /abcdefghijklmnop/u)
  assert.match(f.get().summary, /redigido/u)
})

test('a failed write prevents integration preparation and never reports a saved summary', () => {
  const f = fixture()
  f.deps.missions.update = () => { throw new Error('synthetic unavailable store') }
  const result = f.api.prepareIntegration(identity, summary)
  assert.equal(result.ok, false)
  assert.match(result.text, /repita mission_summary/u)
  assert.equal(f.get().summary, undefined)
  assert.equal(f.changed.length, 0)
  assert.equal(f.audits.length, 0)
})

test('completed mission notes repair their version projection without rewriting completion', () => {
  const completedAt = '2026-09-11T12:00:00.000Z'
  const f = fixture({ status: 'concluida', completedAt, versionId: 'v1' })
  f.deps.reconcile = () => false
  assert.equal(f.api.save(identity, summary).ok, false)
  assert.equal(f.get().summary, summary, 'the mission remains the durable source')
  f.deps.reconcile = value => { f.reconciled.push(value); return true }
  assert.equal(f.api.save(identity, summary).ok, true)
  assert.equal(f.get().completedAt, completedAt)
  assert.equal(f.writes.length, 1)
  assert.equal(f.reconciled[0].summary, summary)
})

test('both new chats and reopened integration turns ask for plain-language patch notes', () => {
  const prompt = guiMissionSystemPrompt('dev')
  assert.match(prompt, /mission_summary/u)
  assert.match(prompt, /two or three short sentences in plain PT-BR/u)
  for (const reopened of [false, true]) {
    const stimulus = missionIntegrationStimulus({ missionTitle: 'Search', targetLabel: 'v1', position: 1, total: 1, isHead: true, reopened })
    assert.match(stimulus, /linguagem leiga/u)
    assert.match(stimulus, /integration_run \{ summary \}/u)
  }
})

const VersionMissionDeliveries = loadComponent('src/renderer/src/components/VersionMissionDeliveries.tsx').default

test('the version keeps each summary in a collapsed disclosure under its mission title', () => {
  const deliveries = [
    { id: 'd1', missionId: 'm1', title: 'Busca corrigida', at: '2026-09-11T12:00:00Z', summary },
    { id: 'd2', missionId: 'm2', title: 'Missão antiga', at: '2026-09-10T12:00:00Z' }
  ]
  const html = renderToStaticMarkup(React.createElement(VersionMissionDeliveries, { deliveries }))
  assert.ok(html.indexOf('Busca corrigida') < html.indexOf(summary))
  assert.ok(html.includes(summary))
  assert.equal((html.match(/Resumo ainda não registrado\./gu) ?? []).length, 1)
  assert.equal((html.match(/<details/gu) ?? []).length, 2)
  assert.equal((html.match(/<summary/gu) ?? []).length, 2)
  assert.doesNotMatch(html, /<details[^>]*\bopen(?:[ =>])/u, 'notes start collapsed')
  assert.match(html, /dateTime="2026-09-11T12:00:00Z"/u)
  const escaped = renderToStaticMarkup(React.createElement(VersionMissionDeliveries, {
    deliveries: [{ ...deliveries[0], summary: '<img src=x onerror=alert(1)>' }]
  }))
  assert.doesNotMatch(escaped, /<img/u)
  assert.match(escaped, /&lt;img/u)
})
