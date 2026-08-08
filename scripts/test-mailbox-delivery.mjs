// test-mailbox-delivery.mjs — FASE 5 F2 (2026-08-08): o hub entrega por
// CORREIO de verdade. Contratos guardados:
// (1) pane com identidade → payload vai para a mailbox IMEDIATAMENTE, sem as
//     guardas de teclado (composer/inFlight/gap), status 'mailboxed' e
//     onSettled(true) — nada é digitado pelo hub;
// (2) delivery-injected volta a significar SÓ digitação real (o desfecho de
//     correio reporta 'mailboxed', nunca 'injected' — o falso positivo do F1);
// (3) stillNeeded=false descarta ANTES de postar;
// (4) pane clássico (sem identidade) segue no caminho antigo intacto;
// (5) PaneMailbox coalesce por dedupKey (fato) e por texto (F1).
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { Hub } = await import(new URL('../.tmp/mailbox-delivery-test/hub.js', import.meta.url))
const { PaneMailbox } = await import(new URL('../.tmp/mailbox-delivery-test/mailbox.js', import.meta.url))

function makeHub(overrides = {}) {
  const log = {
    injects: [],
    mailbox: [],
    deliveries: []
  }
  const deps = {
    projectPathOf: () => undefined,
    ensureProjectRuntimeWritable: () => {},
    maestroPaneOf: () => 'maestro-pane',
    inject: (paneId, text, onSubmitted) => {
      log.injects.push({ paneId, text })
      onSubmitted(true)
      return true
    },
    composerBusy: () => false,
    alive: () => true,
    hasMailbox: () => true,
    deliverToMailbox: (paneId, line, meta) => {
      log.mailbox.push({ paneId, line, meta })
      return true
    },
    onEvent: () => {},
    onDelivery: (paneId, status, line, meta) => {
      log.deliveries.push({ paneId, status, line, meta })
    },
    ...overrides
  }
  const hub = new Hub(deps)
  return { hub, log }
}

test('pane com correio: notifyPaneNow entrega IMEDIATO como mailboxed, sem digitar', () => {
  const { hub, log } = makeHub()
  let settled
  const r = hub.notifyPaneNow('dev-1', 'feedback do gate', {
    onSettled: (ok) => (settled = ok),
    sourcePaneId: 'gate-1',
    kind: 'feedback',
    correlationId: 'c1'
  })
  hub.dispose()
  assert.equal(r, 'mailboxed')
  assert.equal(log.injects.length, 0)
  assert.equal(log.mailbox.length, 1)
  assert.equal(log.mailbox[0].line, 'feedback do gate')
  assert.equal(log.mailbox[0].meta.correlationId, 'c1')
  assert.equal(settled, true)
  assert.deepEqual(
    log.deliveries.map((d) => d.status),
    ['mailboxed']
  )
})

test('correio ignora composer ocupado e o gap entre injeções', () => {
  const { hub, log } = makeHub({ composerBusy: () => true })
  const r1 = hub.notifyPaneNow('dev-1', 'primeira')
  const r2 = hub.notifyPaneNow('dev-1', 'segunda imediatamente depois')
  hub.dispose()
  assert.equal(r1, 'mailboxed')
  assert.equal(r2, 'mailboxed')
  assert.equal(log.mailbox.length, 2)
  assert.equal(log.injects.length, 0)
})

test('stillNeeded=false descarta ANTES de postar no correio', () => {
  const { hub, log } = makeHub()
  let settled
  const r = hub.notifyPaneNow('dev-1', 'resultado já lido', {
    stillNeeded: () => false,
    onSettled: (ok) => (settled = ok)
  })
  hub.dispose()
  assert.equal(r, 'discarded')
  assert.equal(log.mailbox.length, 0)
  assert.equal(settled, false)
  assert.deepEqual(
    log.deliveries.map((d) => d.status),
    ['discarded']
  )
})

test('notifyPane (fila) com correio: mailboxed direto, sem esperar o drain', () => {
  const { hub, log } = makeHub()
  const r = hub.notifyPane('dev-1', 'aviso enfileirável')
  hub.dispose()
  assert.equal(r, 'mailboxed')
  assert.equal(log.mailbox.length, 1)
})

test('publish não-urgente para orquestrador com correio: mailboxed direto', () => {
  const { hub, log } = makeHub()
  hub.publish({ projectId: 'p1', kind: 'report', text: 'dev concluiu', actor: 'dev' })
  hub.dispose()
  assert.equal(log.mailbox.length, 1)
  assert.match(log.mailbox[0].line, /report: dev concluiu/)
})

test('pane clássico (sem identidade): caminho antigo intacto, injected com prefixo', () => {
  const { hub, log } = makeHub({ hasMailbox: () => false })
  let settled
  const r = hub.notifyPaneNow('shell-1', 'linha clássica', { onSettled: (ok) => (settled = ok) })
  hub.dispose()
  assert.equal(r, 'injected')
  assert.equal(log.mailbox.length, 0)
  assert.equal(log.injects.length, 1)
  assert.equal(log.injects[0].text, '[synkora] linha clássica')
  assert.equal(settled, undefined) // onSettled é contrato da fila/correio, não do inject direto
  assert.deepEqual(
    log.deliveries.map((d) => d.status),
    ['injected']
  )
})

test('corrida: hasMailbox true mas post falhou (identidade sumiu) → cai no teclado', () => {
  const { hub, log } = makeHub({ deliverToMailbox: () => false })
  const r = hub.notifyPaneNow('dev-1', 'mensagem')
  hub.dispose()
  assert.equal(r, 'injected')
  assert.equal(log.injects.length, 1)
})

test('pane morto: dead sem postar nada', () => {
  const { hub, log } = makeHub({ alive: () => false })
  const r = hub.notifyPaneNow('dead-1', 'mensagem')
  hub.dispose()
  assert.equal(r, 'dead')
  assert.equal(log.mailbox.length, 0)
  assert.deepEqual(
    log.deliveries.map((d) => d.status),
    ['dead']
  )
})

test('PaneMailbox: dedupKey colapsa no fato mais novo; texto idêntico coalesce; drain esvazia', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synkora-mailbox-test-'))
  const file = join(dir, 'mailboxes.json')
  try {
    const box = new PaneMailbox(file)
    assert.equal(box.post('task:t1:dev', { text: 'placar 1/4', at: '2026-08-08T10:00:00Z', dedupKey: 'score' }), 'posted')
    assert.equal(box.post('task:t1:dev', { text: 'placar 2/4', at: '2026-08-08T10:01:00Z', dedupKey: 'score' }), 'coalesced')
    assert.equal(box.post('task:t1:dev', { text: 'outra coisa', at: '2026-08-08T10:02:00Z' }), 'posted')
    assert.equal(box.post('task:t1:dev', { text: 'outra coisa', at: '2026-08-08T10:03:00Z' }), 'coalesced')
    const msgs = box.drain('task:t1:dev')
    assert.equal(msgs.length, 2)
    assert.equal(msgs[0].text, 'placar 2/4') // o fato NOVO substituiu o velho
    assert.equal(box.pending('task:t1:dev'), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
