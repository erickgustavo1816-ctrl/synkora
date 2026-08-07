import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
const {
  HelperCompletionTracker,
  formatHelperCompletionNote,
  formatHelperCompletionShortNotice,
  helperCompletionNotificationKey
} = await import(new URL('../.tmp/helper-completion-test/helperCompletion.js', import.meta.url))
const { Hub } = await import(new URL('../.tmp/helper-completion-test/hub.js', import.meta.url))

test('Hub checks the central runtime guard before creating .synkora', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'synkora-hub-guard-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let checks = 0
  const hub = new Hub({
    projectPathOf: () => root,
    ensureProjectRuntimeWritable: () => {
      checks += 1
      throw new Error('tracked runtime')
    },
    maestroPaneOf: () => undefined,
    inject: () => false,
    composerBusy: () => false,
    alive: () => false,
    onEvent: () => undefined
  })
  t.after(() => hub.dispose())

  hub.publish({ projectId: 'p1', kind: 'info', text: 'blocked write' })
  assert.equal(checks, 1)
  assert.equal(existsSync(join(root, '.synkora')), false)
})

test('Hub redige credenciais antes de UI, persistência ou injeção entre panes', (t) => {
  const injections = []
  const events = []
  const hub = new Hub({
    projectPathOf: () => undefined,
    ensureProjectRuntimeWritable: () => undefined,
    maestroPaneOf: () => undefined,
    inject: (paneId, text) => {
      injections.push({ paneId, text })
      return true
    },
    composerBusy: () => false,
    alive: () => true,
    onEvent: (event) => events.push(event)
  })
  t.after(() => hub.dispose())

  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456'
  hub.publish({
    projectId: 'p1',
    kind: 'info',
    text: `token observado: ${secret}`,
    quiet: true
  })
  hub.notifyPaneNow('pane-1', `Authorization: Bearer ${secret}`)

  assert.equal(events[0].text.includes(secret), false)
  assert.match(events[0].text, /\[redigido:/)
  assert.equal(injections[0].text.includes(secret), false)
  assert.match(injections[0].text, /\[redigido:/)
})

test('notifica quando o delegador ainda não consumiu o report', () => {
  const tracker = new HelperCompletionTracker()
  const id = tracker.report('helper-1', 'delegator-1', 'resultado final')

  assert.deepEqual(tracker.peek('helper-1', id), {
    id,
    text: 'resultado final',
    consumed: false
  })
  assert.equal(tracker.settle('helper-1', id), true)
})

test('helper_output após report consome a conclusão e evita a segunda entrega', () => {
  const tracker = new HelperCompletionTracker()
  const id = tracker.report('helper-1', 'delegator-1', 'resultado final')

  tracker.noteOutputRead('helper-1', 'delegator-1')
  assert.equal(tracker.consumeViaOutput('helper-1', 'delegator-1')?.text, 'resultado final')
  const delivery = tracker.peek('helper-1', id)
  assert.deepEqual(delivery, {
    id,
    text: 'resultado final',
    consumed: true
  })
  assert.equal(tracker.noticeMode('helper-1', id, 'delegator-1'), 'skip')
  assert.equal(tracker.wasConsumedBy('helper-1', id, 'delegator-1'), true)
})

test('leitura anterior ao report rebaixa o aviso para o sinal curto, sem payload', () => {
  const tracker = new HelperCompletionTracker()

  tracker.noteOutputRead('helper-1', 'delegator-1')
  assert.equal(tracker.consumeViaOutput('helper-1', 'delegator-1'), undefined)
  const id = tracker.report('helper-1', 'delegator-1', 'resultado completo')
  const delivery = tracker.peek('helper-1', id)
  assert.equal(delivery?.consumed, false)
  // o sinal de conclusão AINDA chega (short) — só o payload repetido morre
  assert.equal(tracker.noticeMode('helper-1', id, 'delegator-1'), 'short')
  assert.equal(tracker.noticeMode('helper-1', id, 'outro-pane'), 'full')
  const short = formatHelperCompletionShortNotice('helper-1-com-id-longo')
  assert.match(short, /concluiu/)
  assert.equal(short.includes('resultado completo'), false)
})

test('leitor não autorizado não consome a entrega', () => {
  const tracker = new HelperCompletionTracker()
  const id = tracker.report('helper-1', 'delegator-1', 'resultado final')

  assert.equal(tracker.consumeViaOutput('helper-1', 'outro-pane'), undefined)
  assert.equal(tracker.peek('helper-1', id)?.consumed, false)
})

test('maestro (não delegador) que leu após o report consome SÓ a própria entrega', () => {
  const tracker = new HelperCompletionTracker()
  const id = tracker.report('helper-1', 'delegator-1', 'resultado final')

  const delivery = tracker.consumeViaOutput('helper-1', 'orchestrator', true)
  assert.equal(delivery?.text, 'resultado final')
  assert.equal(tracker.noticeMode('helper-1', id, 'orchestrator'), 'skip')
  assert.equal(tracker.wasConsumedBy('helper-1', id, 'orchestrator'), true)
  // o delegador continua com a entrega completa pendente
  assert.equal(tracker.peek('helper-1', id)?.consumed, false)
  assert.equal(tracker.noticeMode('helper-1', id, 'delegator-1'), 'full')
})

test('um report novo invalida somente o timer antigo', () => {
  const tracker = new HelperCompletionTracker()
  const oldId = tracker.report('helper-1', 'delegator-1', 'resultado antigo')
  const newId = tracker.report('helper-1', 'delegator-1', 'resultado novo')

  assert.equal(tracker.peek('helper-1', oldId), undefined)
  assert.equal(tracker.peek('helper-1', newId)?.text, 'resultado novo')
})

test('nota de conclusão é limitada sem perder o marcador', () => {
  const note = formatHelperCompletionNote('x'.repeat(200), 80)

  assert.equal(note.startsWith('[conclusão reportada pelo ajudante: '), true)
  assert.equal(note.endsWith('…]'), true)
})

function testHub(maestroPaneId, injections) {
  let busy = true
  const alive = new Set(['delegator', 'orchestrator'])
  const hub = new Hub({
    projectPathOf: () => undefined,
    ensureProjectRuntimeWritable: () => undefined,
    maestroPaneOf: () => maestroPaneId,
    inject: (paneId, text) => {
      injections.push({ paneId, text })
      return true
    },
    composerBusy: () => busy,
    alive: (paneId) => alive.has(paneId),
    onEvent: () => undefined
  })
  return {
    hub,
    release: () => {
      busy = false
    }
  }
}

test('cancela a conclusão entre announce e drain sem injetar uma segunda mensagem', async (t) => {
  const injections = []
  const { hub, release } = testHub('delegator', injections)
  t.after(() => hub.dispose())
  const tracker = new HelperCompletionTracker()
  const id = tracker.report('helper-1', 'delegator', 'resultado final')
  const key = helperCompletionNotificationKey('helper-1', id)

  hub.publish(
    { projectId: 'project-1', kind: 'report', text: 'resultado final', actor: 'ajudante' },
    { notificationKey: key }
  )
  hub.notifyPane('delegator', 'resultado final', {
    key,
    onSettled: () => tracker.settle('helper-1', id)
  })
  assert.equal(tracker.consumeViaOutput('helper-1', 'delegator')?.text, 'resultado final')
  assert.equal(hub.cancelPaneNotification('delegator', key), 1)

  release()
  await delay(400)
  assert.deepEqual(injections, [])
})

test('conclusão não consumida chega uma única vez ao mesmo orquestrador/delegador', async (t) => {
  const injections = []
  const { hub, release } = testHub('delegator', injections)
  t.after(() => hub.dispose())
  const key = helperCompletionNotificationKey('helper-1', 1)
  let delivered = null

  hub.publish(
    { projectId: 'project-1', kind: 'report', text: 'resultado final', actor: 'ajudante' },
    { notificationKey: key }
  )
  hub.notifyPane('delegator', 'resultado final', {
    key,
    onSettled: (value) => {
      delivered = value
    }
  })

  release()
  await delay(400)
  assert.equal(injections.length, 1)
  assert.equal(injections[0].text, '[synkora] resultado final')
  assert.equal(delivered, true)
})

test('consumo tardio (entre announce e injeção) descarta pela guarda stillNeeded, sem cancel explícito', async (t) => {
  const injections = []
  const { hub, release } = testHub('delegator', injections)
  t.after(() => hub.dispose())
  const tracker = new HelperCompletionTracker()
  const id = tracker.report('helper-1', 'delegator', 'resultado final')
  const key = helperCompletionNotificationKey('helper-1', id)
  let settled = null

  hub.notifyPane('delegator', 'resultado final', {
    key,
    onSettled: (value) => {
      settled = value
    },
    stillNeeded: () => !tracker.wasConsumedBy('helper-1', id, 'delegator')
  })
  // a fila já tem a entrega; o consumo chega DEPOIS (composer ainda ocupado)
  assert.equal(tracker.consumeViaOutput('helper-1', 'delegator')?.consumed, true)

  release()
  await delay(400)
  assert.deepEqual(injections, [])
  assert.equal(settled, false)
})

test('maestro que consumiu pós-report não recebe o publish; um maestro que nunca leu recebe', async (t) => {
  const injections = []
  const { hub, release } = testHub('orchestrator', injections)
  t.after(() => hub.dispose())
  const tracker = new HelperCompletionTracker()
  const id = tracker.report('helper-1', 'delegator', 'resultado final')
  const key = helperCompletionNotificationKey('helper-1', id)

  // orquestrador leu via helper_output pós-report (consome a própria entrega)
  tracker.noteOutputRead('helper-1', 'orchestrator')
  assert.equal(tracker.consumeViaOutput('helper-1', 'orchestrator', true)?.consumed, true)

  hub.publish(
    { projectId: 'project-1', kind: 'report', text: 'resultado final', actor: 'ajudante' },
    { notificationKey: key, stillNeeded: () => !tracker.wasConsumedBy('helper-1', id, 'orchestrator') }
  )
  release()
  await delay(400)
  assert.deepEqual(injections, [])

  // segundo helper: maestro nunca leu → o publish chega normalmente
  const id2 = tracker.report('helper-2', 'delegator', 'outro resultado')
  hub.publish(
    { projectId: 'project-1', kind: 'report', text: 'outro resultado', actor: 'ajudante' },
    {
      notificationKey: helperCompletionNotificationKey('helper-2', id2),
      stillNeeded: () => !tracker.wasConsumedBy('helper-2', id2, 'orchestrator')
    }
  )
  await delay(2200)
  assert.equal(injections.length, 1)
  assert.equal(injections[0].paneId, 'orchestrator')
  assert.match(injections[0].text, /outro resultado/)
})

test('cancelar no delegador preserva o aviso de um orquestrador diferente', async (t) => {
  const injections = []
  const { hub, release } = testHub('orchestrator', injections)
  t.after(() => hub.dispose())
  const tracker = new HelperCompletionTracker()
  const id = tracker.report('helper-1', 'delegator', 'resultado final')
  const key = helperCompletionNotificationKey('helper-1', id)

  hub.publish(
    { projectId: 'project-1', kind: 'report', text: 'resultado final', actor: 'ajudante' },
    { notificationKey: key }
  )
  hub.notifyPane('delegator', 'resultado final', {
    key,
    onSettled: () => tracker.settle('helper-1', id)
  })
  assert.equal(tracker.consumeViaOutput('helper-1', 'delegator')?.consumed, true)
  assert.equal(hub.cancelPaneNotification('delegator', key), 1)

  release()
  await delay(400)
  assert.equal(injections.length, 1)
  assert.equal(injections[0].paneId, 'orchestrator')
})
