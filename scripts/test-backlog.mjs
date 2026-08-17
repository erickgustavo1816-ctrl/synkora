import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  BacklogStore,
  compareVersionNumbers,
  parseVersionName
} from '../.tmp/backlog-test/backlog.js'

test('release status and isolation metadata are persisted as one logical transition', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-backlog-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'backlog.json')
  const store = new BacklogStore(file)
  const version = store.createVersion('project-1', { name: 'V1.0' })
  store.setVersionBranch(
    version.id,
    'version/legacy-v1',
    join(root, 'worktrees', 'version-legacy-v1')
  )

  const released = store.markVersionReleased(version.id)
  assert.equal(released?.status, 'lancada')
  assert.equal(released?.branch, undefined)
  assert.equal(released?.worktree, undefined)
  assert.ok(released?.releasedAt)

  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  const persistedVersion = persisted.versions.find((candidate) => candidate.id === version.id)
  assert.equal(persistedVersion.status, 'lancada')
  assert.equal('branch' in persistedVersion, false)
  assert.equal('worktree' in persistedVersion, false)
  assert.equal(persistedVersion.releasedAt, released.releasedAt)

  const releasedAt = released.releasedAt
  const repeated = store.markVersionReleased(version.id)
  assert.equal(repeated?.releasedAt, releasedAt)

  const reopened = new BacklogStore(file).getVersion(version.id)
  assert.equal(reopened?.status, 'lancada')
  assert.equal(reopened?.branch, undefined)
  assert.equal(reopened?.worktree, undefined)
  assert.equal(reopened?.releasedAt, releasedAt)
})

test('rename validation never permits two versions with the same visible name', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-backlog-version-name-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BacklogStore(join(root, 'backlog.json'))
  const first = store.createVersion('project-1', { name: 'V1.0' })
  const second = store.createVersion('project-1', { name: 'V2.0' })

  assert.equal(store.validateVersionName('project-1', ' v1.0 ', second.id), 'a versão v1.0 já existe')
  assert.equal(store.validateVersionName('project-1', 'V2.0', second.id), null)
  assert.equal(store.validateVersionName('project-1', 'V1.0', first.id), null)
})

// ————————————————————————————————————————————————————————————————————————
// O NÚMERO DIGITADO À MÃO (ordem do dono, 2026-08-17: "posso colocar um projeto
// que já esteja na 1.20 e não tem como eu controlar isso").
//
// A tela passou a aceitar um nome digitado ao lado das sugestões calculadas.
// Isso muda de lugar quem produz o nome — antes só o app, agora também o dono —
// e é por isso que a régua tem de valer para QUALQUER forma que ele consiga
// escrever, e a recusa tem de dizer o que está errado. Um nome que o parser não
// entende não é recusado: "MVP" e "Beta" continuam sendo nomes legítimos.
// ————————————————————————————————————————————————————————————————————————

test('o parser entende o número inteiro: 1.20 é vinte, e o quarto segmento existe', () => {
  // "1.20" é o caso do dono. Ler o `20` como `2` faria 1.20 < 1.3 e a versão
  // dele nasceria abaixo da própria main.
  assert.deepEqual(parseVersionName('1.20'), [1, 20, 0])
  assert.ok(compareVersionNumbers(parseVersionName('1.20'), parseVersionName('1.3')) > 0)

  // Build de quatro segmentos: o parser antigo devolvia `null` — o nome PARECE
  // numérico, e o silêncio deixava a comparação de fora sem ninguém saber.
  assert.deepEqual(parseVersionName('1.2.0.4'), [1, 2, 0, 4])
  assert.ok(compareVersionNumbers(parseVersionName('1.2.0.4'), parseVersionName('1.2')) > 0)
  assert.ok(compareVersionNumbers(parseVersionName('1.2.0.4'), parseVersionName('1.2.1')) < 0)
  assert.equal(compareVersionNumbers(parseVersionName('v2.0'), parseVersionName('2.0.0')), 0)

  // Nome sem padrão numérico continua fora da ordenação (e, por isso, livre).
  assert.equal(parseVersionName('MVP'), null)
  assert.equal(parseVersionName('1.'), null)
  assert.equal(parseVersionName(''), null)
})

test('a recusa do nome digitado nomeia o problema — e separa igual de inferior', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-backlog-typed-name-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BacklogStore(join(root, 'backlog.json'))
  const shipped = store.createVersion('project-1', { name: 'V2.0' })
  store.markVersionReleased(shipped.id)

  // ABAIXO da main: a recusa diz contra o que está comparando e o que fazer.
  const lower = store.validateNewVersion('project-1', '1.20')
  assert.match(lower, /V2\.0/u)
  assert.match(lower, /1\.20/u)
  assert.match(lower, /abaixo/u)
  assert.match(lower, /acima/u, 'a recusa precisa dizer a saída, não só o problema')

  // MESMO número com outra grafia: dizer "seria uma versão inferior" aqui é
  // falso — `2.0` não é inferior a `V2.0`, é ela. A recusa continua nomeando as
  // duas pontas e a saída; o que ela não pode é mentir sobre a ordem.
  const same = store.validateNewVersion('project-1', '2.0')
  assert.doesNotMatch(same, /inferior|abaixo/u)
  assert.match(same, /V2\.0/u)
  assert.match(same, /acima/u)

  // Quatro segmentos abaixo da main: era o buraco silencioso do parser.
  assert.match(store.validateNewVersion('project-1', '1.2.0.4'), /abaixo/u)
  // ... e acima dela passa, como qualquer número maior.
  assert.equal(store.validateNewVersion('project-1', '2.0.0.1'), null)
  assert.equal(store.validateNewVersion('project-1', '2.1'), null)

  // Codinome segue livre: a régua ordena números, não vocabulário.
  assert.equal(store.validateNewVersion('project-1', 'Beta 2'), null)
  // E o vazio é recusado com uma frase, não com um rótulo de campo.
  assert.match(store.validateNewVersion('project-1', '   '), /vazio/u)
})

test('a versão digitada à mão vira a base do próximo número sugerido', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-backlog-typed-default-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BacklogStore(join(root, 'backlog.json'))
  // O projeto que "já está na 1.20": o dono digita, lança, e o app segue dali.
  const typed = store.createVersion('project-1', { name: '1.20' })
  store.markVersionReleased(typed.id)

  assert.equal(store.ensureDefaultVersion('project-1').name, '1.21')
})

test('default version advances from the highest numeric history without duplicating a legacy name', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-backlog-default-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BacklogStore(join(root, 'backlog.json'))
  const numeric = store.createVersion('project-1', { name: 'V1.0' })
  store.markVersionReleased(numeric.id)
  const legacy = store.createVersion('project-1', { name: 'Beta' })
  store.markVersionReleased(legacy.id)

  const next = store.ensureDefaultVersion('project-1')
  assert.equal(next.name, 'V1.1')
  assert.equal(
    store.listVersions('project-1').filter((version) => version.name === 'V1.0').length,
    1
  )
})

test('backlog items reject versions owned by another project', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-backlog-ownership-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BacklogStore(join(root, 'backlog.json'))
  const own = store.createVersion('project-1', { name: 'V1.0' })
  const foreign = store.createVersion('project-2', { name: 'V1.0' })

  assert.throws(
    () => store.createItem('project-1', { title: 'foreign', versionId: foreign.id }),
    /não pertence a este projeto/
  )
  const item = store.createItem('project-1', { title: 'owned', versionId: own.id })
  assert.equal(store.updateItem(item.id, { versionId: foreign.id }), undefined)
  assert.equal(store.getItem(item.id)?.versionId, own.id)
})

test('mission version choices expose only open versions and their current default', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-backlog-mission-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new BacklogStore(join(root, 'backlog.json'))
  const current = store.createVersion('project-1', { name: 'V1.2' })
  const next = store.createVersion('project-1', { name: 'V2.0' })
  const released = store.createVersion('project-1', { name: 'V1.1' })
  const foreign = store.createVersion('project-2', { name: 'V9.0' })
  store.markVersionReleased(released.id)

  const choices = store.missionVersionChoices('project-1')

  assert.equal(choices.defaultVersionId, current.id)
  assert.deepEqual(
    choices.versions.map((version) => version.id),
    [current.id, next.id]
  )
  assert.equal(choices.versions.some((version) => version.id === released.id), false)
  assert.equal(choices.versions.some((version) => version.id === foreign.id), false)
})
