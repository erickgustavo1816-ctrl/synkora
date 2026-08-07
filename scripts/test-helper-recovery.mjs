import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HELPER_RECOVERY_VERSION,
  filterHelperRecoveryRecords,
  formatHelperRecoveryHeader,
  formatHelperRecoveryTranscript,
  parseHelperRecoveryHeader,
  parseHelperRecoveryTranscript,
  updateHelperRecoveryStatus
} from '../src/main/helperRecovery.ts'

const createdAt = '2026-08-01T12:00:00.000Z'

function record(overrides = {}) {
  return {
    version: HELPER_RECOVERY_VERSION,
    paneId: 'pane-helper-1',
    projectId: 'project-1',
    missionId: 'mission-1',
    taskId: 'task-1',
    delegatorPaneId: 'pane-dev-1',
    title: 'Auditar --> componente',
    seatId: 'seat-1',
    model: 'model-1',
    createdAt,
    status: 'running',
    statusAt: createdAt,
    ...overrides
  }
}

test('formata JSON versionado na primeira linha e faz round-trip seguro', () => {
  const source = record()
  const header = formatHelperRecoveryHeader(source)

  assert.equal(header.startsWith('<!-- synkora-helper {'), true)
  assert.equal(header.includes('Auditar --> componente'), false)
  assert.deepEqual(parseHelperRecoveryHeader(header), source)
})

test('transcript é semeado com metadata na primeira linha', () => {
  const transcript = formatHelperRecoveryTranscript(record(), 'linha 1\nlinha 2')

  assert.deepEqual(parseHelperRecoveryTranscript(transcript), record())
  assert.equal(transcript.split('\n').slice(1).join('\n'), 'linha 1\nlinha 2')
})

test('ignora cabeçalho malformado, versão futura e imitação no corpo', () => {
  const future = formatHelperRecoveryHeader(record()).replace('"version":1', '"version":2')

  assert.equal(parseHelperRecoveryHeader('<!-- synkora-helper {oops} -->'), undefined)
  assert.equal(parseHelperRecoveryHeader(future), undefined)
  assert.equal(
    parseHelperRecoveryTranscript(`saída comum\n${formatHelperRecoveryHeader(record())}`),
    undefined
  )
})

test('running vira interrupted preservando corpo e CRLF', () => {
  const original = formatHelperRecoveryTranscript(record(), 'primeira\r\nsegunda').replace('\n', '\r\n')
  const changedAt = '2026-08-01T12:05:00.000Z'
  const result = updateHelperRecoveryStatus(original, 'interrupted', changedAt)

  assert.equal(result.changed, true)
  assert.equal(result.record?.status, 'interrupted')
  assert.equal(result.record?.statusAt, changedAt)
  assert.equal(result.transcript.endsWith('\r\nprimeira\r\nsegunda'), true)
  assert.deepEqual(parseHelperRecoveryTranscript(result.transcript), result.record)
})

test('repetir a mesma interrupção é idempotente e não troca o timestamp', () => {
  const first = updateHelperRecoveryStatus(
    formatHelperRecoveryTranscript(record(), 'saída'),
    'interrupted',
    '2026-08-01T12:05:00.000Z'
  )
  const repeated = updateHelperRecoveryStatus(
    first.transcript,
    'interrupted',
    '2026-08-01T13:00:00.000Z'
  )

  assert.equal(repeated.changed, false)
  assert.equal(repeated.transcript, first.transcript)
  assert.equal(repeated.record?.statusAt, '2026-08-01T12:05:00.000Z')
})

test('done é terminal, mas report tardio pode promover interrupted para done', () => {
  const interrupted = updateHelperRecoveryStatus(
    formatHelperRecoveryTranscript(record()),
    'interrupted',
    '2026-08-01T12:05:00.000Z'
  )
  const done = updateHelperRecoveryStatus(
    interrupted.transcript,
    'done',
    '2026-08-01T12:06:00.000Z'
  )
  const refused = updateHelperRecoveryStatus(
    done.transcript,
    'interrupted',
    '2026-08-01T12:07:00.000Z'
  )

  assert.equal(done.changed, true)
  assert.equal(done.record?.status, 'done')
  assert.equal(refused.changed, false)
  assert.equal(refused.transcript, done.transcript)
})

test('transição para running e timestamp inválido não alteram o transcript', () => {
  const original = formatHelperRecoveryTranscript(record())

  assert.equal(updateHelperRecoveryStatus(original, 'running', createdAt).changed, false)
  assert.equal(updateHelperRecoveryStatus(original, 'done', 'agora').changed, false)
})

test('filtra por projeto, missão, tarefa, delegador e estado sem mudar a ordem', () => {
  const records = [
    record({ paneId: 'h1' }),
    record({ paneId: 'h2', taskId: 'task-2', delegatorPaneId: 'pane-dev-2' }),
    record({ paneId: 'h3', missionId: 'mission-2' }),
    record({ paneId: 'h4', projectId: 'project-2' }),
    record({ paneId: 'h5', status: 'done', statusAt: '2026-08-01T12:03:00.000Z' })
  ]

  assert.deepEqual(
    filterHelperRecoveryRecords(records, { projectId: 'project-1', missionId: 'mission-1' }).map(
      (item) => item.paneId
    ),
    ['h1', 'h2', 'h5']
  )
  assert.deepEqual(
    filterHelperRecoveryRecords(records, { taskId: 'task-1', delegatorPaneId: 'pane-dev-1' }).map(
      (item) => item.paneId
    ),
    ['h1', 'h3', 'h4', 'h5']
  )
  assert.deepEqual(
    filterHelperRecoveryRecords(records, { projectId: 'project-1', status: ['done'] }).map(
      (item) => item.paneId
    ),
    ['h5']
  )
})

test('update de transcript legado é no-op seguro', () => {
  const legacy = 'saída antiga sem metadata\ncontinuação'
  const result = updateHelperRecoveryStatus(legacy, 'interrupted', createdAt)

  assert.deepEqual(result, { transcript: legacy, record: undefined, changed: false })
})
