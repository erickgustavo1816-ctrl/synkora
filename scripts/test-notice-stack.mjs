import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NOTICE_STACK_LIMIT,
  dismissNotice,
  integrationNotice,
  normalizeNoticeAutoClose,
  normalizeNoticeCorner,
  noticeAutoCloseSeconds,
  noticePrefsOf,
  noticeRole,
  noticeSentence,
  pushNotice,
  shownNotices
} from '../src/renderer/src/noticeStack.ts'

const spec = (key, tone = 'info') => ({ key, tone, title: `título ${key}`, body: `corpo ${key}` })

test('o aviso novo entra no fim da pilha, colado no canto', () => {
  let stack = pushNotice([], spec('a'), 1)
  stack = pushNotice(stack, spec('b'), 2)
  assert.deepEqual(stack.map((n) => [n.key, n.id]), [['a', 1], ['b', 2]])
})

test('o MESMO aviso repetido substitui o anterior em vez de duplicar', () => {
  let stack = pushNotice([], spec('a'), 1)
  stack = pushNotice(stack, spec('b'), 2)
  stack = pushNotice(stack, { ...spec('a'), body: 'de novo' }, 3)
  assert.deepEqual(stack.map((n) => [n.key, n.id]), [['b', 2], ['a', 3]])
  assert.equal(stack[1].body, 'de novo')
})

test('fechar tira só o aviso pedido; id desconhecido não mexe na pilha', () => {
  const stack = pushNotice(pushNotice([], spec('a'), 1), spec('b'), 2)
  assert.deepEqual(dismissNotice(stack, 1).map((n) => n.key), ['b'])
  assert.deepEqual(dismissNotice(stack, 99).map((n) => n.key), ['a', 'b'])
})

test(`a pilha mostra no máximo ${NOTICE_STACK_LIMIT} e conta os mais antigos escondidos`, () => {
  let stack = []
  for (let i = 1; i <= 5; i++) stack = pushNotice(stack, spec(`k${i}`), i)
  const { shown, hiddenCount } = shownNotices(stack)
  assert.equal(NOTICE_STACK_LIMIT, 3)
  assert.deepEqual(shown.map((n) => n.key), ['k3', 'k4', 'k5'])
  assert.equal(hiddenCount, 2)
  assert.deepEqual(shownNotices(stack.slice(0, 2)), { shown: stack.slice(0, 2), hiddenCount: 0 })
})

test('recusa e erro interrompem o leitor de tela; fila e informação esperam a vez', () => {
  assert.equal(noticeRole('warn'), 'alert')
  assert.equal(noticeRole('error'), 'alert')
  assert.equal(noticeRole('queued'), 'status')
  assert.equal(noticeRole('info'), 'status')
})

test('o ajuste "fechar sozinho" só aceita os tempos oferecidos; o resto vira "nunca"', () => {
  for (const s of [0, 6, 10, 20]) assert.equal(normalizeNoticeAutoClose(s), s)
  for (const junk of [7, -6, '10', null, undefined, Number.NaN, 1e9]) assert.equal(normalizeNoticeAutoClose(junk), 0)
})

test('o canto dos avisos é inferior salvo pedido explícito de superior', () => {
  assert.equal(normalizeNoticeCorner('top'), 'top')
  assert.equal(normalizeNoticeCorner('bottom'), 'bottom')
  assert.equal(normalizeNoticeCorner('left'), 'bottom')
  assert.equal(normalizeNoticeCorner(undefined), 'bottom')
})

test('os ajustes dos avisos saem saneados mesmo antes do boot ou de versão antiga', () => {
  assert.deepEqual(noticePrefsOf(null), { autoCloseSeconds: 0, corner: 'bottom' })
  assert.deepEqual(noticePrefsOf({}), { autoCloseSeconds: 0, corner: 'bottom' })
  assert.deepEqual(noticePrefsOf({ noticeAutoCloseSeconds: 10, noticeCorner: 'top' }), {
    autoCloseSeconds: 10,
    corner: 'top'
  })
  assert.deepEqual(noticePrefsOf({ noticeAutoCloseSeconds: 11, noticeCorner: 'meio' }), {
    autoCloseSeconds: 0,
    corner: 'bottom'
  })
})

test('recusa e erro NUNCA fecham sozinhos, qualquer que seja o ajuste', () => {
  assert.equal(noticeAutoCloseSeconds('warn', 10), 0)
  assert.equal(noticeAutoCloseSeconds('error', 20), 0)
  assert.equal(noticeAutoCloseSeconds('info', 6), 6)
  assert.equal(noticeAutoCloseSeconds('queued', 10), 10)
  assert.equal(noticeAutoCloseSeconds('info', 0), 0)
})

test('o corpo começa com maiúscula e sem espaço sobrando — formatação, nunca reescrita', () => {
  assert.equal(noticeSentence('  a missão está ARQUIVADA — reative-a  '), 'A missão está ARQUIVADA — reative-a')
  assert.equal(noticeSentence('não deu'), 'Não deu')
  assert.equal(noticeSentence(''), '')
})

test('⇪ com ticket na fila: título, tom e posição saem do TICKET, não do texto do motor', () => {
  const notice = integrationNotice({
    missionId: 'm1',
    missionTitle: 'Bug de missões antigas',
    ticket: { state: 'queued', position: 2, total: 3 },
    message: 'o agente desta missão integra quando chegar a vez dela'
  })
  assert.deepEqual(notice, {
    key: 'integration:m1',
    tone: 'queued',
    title: 'Na fila de integração',
    chip: 'posição 2 de 3',
    body: 'O agente desta missão integra quando chegar a vez dela',
    context: 'Bug de missões antigas'
  })
})

test('⇪ sem ticket é RECUSA; fila pausada pede atenção; os demais estados têm nome próprio', () => {
  const base = { missionId: 'm1', missionTitle: 'X', message: 'a missão está ARQUIVADA' }
  const refused = integrationNotice(base)
  assert.equal(refused.tone, 'warn')
  assert.equal(refused.title, 'Integração não iniciada')
  assert.equal(refused.chip, undefined)
  assert.equal(refused.body, 'A missão está ARQUIVADA')

  const blocked = integrationNotice({ ...base, ticket: { state: 'blocked', position: 1, total: 1 } })
  assert.equal(blocked.tone, 'warn')
  assert.equal(blocked.title, 'Integração pausada')

  const sync = integrationNotice({ ...base, ticket: { state: 'sync_required', position: 1, total: 2 } })
  assert.equal(sync.tone, 'queued')
  assert.equal(sync.title, 'Sincronizando antes de integrar')

  const merging = integrationNotice({ ...base, ticket: { state: 'merging', position: 1, total: 1 } })
  assert.equal(merging.tone, 'queued')
  assert.equal(merging.title, 'Integrando agora')
})
