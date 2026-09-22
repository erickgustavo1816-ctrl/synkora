import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GUI_PLAN_APPROVAL_CLAUDE_TOOL,
  GUI_PLAN_APPROVAL_DEFAULT_OPTIONS,
  GUI_PLAN_APPROVAL_DEFAULT_QUESTION,
  GUI_PLAN_APPROVAL_DESCRIPTION,
  GUI_PLAN_APPROVAL_PLAN_MAX_CHARS,
  GUI_PLAN_APPROVAL_RECEIPT,
  GUI_PLAN_APPROVAL_REQUEST_PREFIX,
  GUI_PLAN_APPROVAL_TOOL,
  guiPlanApprovalCard,
  isGuiPlanApprovalRequestId
} from '../src/main/guiPlanApproval.ts'

// O CARTÃO DE PLANO DO SYNKORA: o mini-plano viaja DENTRO do pedido. O caso
// que o motivou (2026-09-22): o Claude gravou o plano no canal de raciocínio,
// chamou AskUserQuestion, e o dono viu "aprova o plano?" sem plano nenhum.

test('o pedido mínimo vira um cartão de duas opções com o plano no corpo', () => {
  const plan = '1. Ler o motor\n2. Corrigir o cartão\n3. Testar'
  const card = guiPlanApprovalCard({ plan })
  assert.ok(!('error' in card))
  assert.equal(card.plan, plan)
  assert.equal(card.questions.length, 1)
  const [question] = card.questions
  assert.equal(question.id, 'plan', 'o id estável é o que a resposta assíncrona procura')
  assert.equal(question.question, GUI_PLAN_APPROVAL_DEFAULT_QUESTION)
  assert.equal(question.header, 'Plano')
  assert.equal(question.multiSelect, false)
  assert.equal(question.allowCustom, true, 'o dono sempre pode responder com texto próprio')
  assert.deepEqual(question.options, GUI_PLAN_APPROVAL_DEFAULT_OPTIONS)
  assert.deepEqual(question.options.map((option) => option.label), ['Aprovar', 'Não aprovar'])
})

test('pergunta, rótulo e opções próprias entram aparadas; o plano é aparado sem ser cortado', () => {
  const card = guiPlanApprovalCard({
    plan: '  - fazer X\n- fazer Y  ',
    question: '  Sigo por X? ',
    header: ' Direção ',
    options: [
      { label: ' X ', description: '  o caminho curto ' },
      { label: 'Y' },
      { label: 'Z', description: '' }
    ]
  })
  assert.ok(!('error' in card))
  assert.equal(card.plan, '- fazer X\n- fazer Y')
  const [question] = card.questions
  assert.equal(question.question, 'Sigo por X?')
  assert.equal(question.header, 'Direção')
  assert.deepEqual(question.options, [
    { label: 'X', description: 'o caminho curto' },
    { label: 'Y' },
    { label: 'Z' }
  ])
})

test('pedido torto devolve erro em PT-BR que nomeia o campo, nunca um cartão vazio', () => {
  const cases = [
    [undefined, /plan/u],
    [null, /plan/u],
    [{}, /plan/u],
    [{ plan: '   ' }, /plan/u],
    [{ plan: 'x'.repeat(GUI_PLAN_APPROVAL_PLAN_MAX_CHARS + 1) }, /plan/u],
    [{ plan: 'ok', question: '' }, /question/u],
    [{ plan: 'ok', question: 'q'.repeat(501) }, /question/u],
    [{ plan: 'ok', header: 'h'.repeat(61) }, /header/u],
    [{ plan: 'ok', options: [] }, /2 a 6 opções/u],
    [{ plan: 'ok', options: [{ label: 'só uma' }] }, /2 a 6 opções/u],
    [{ plan: 'ok', options: Array.from({ length: 7 }, (_, i) => ({ label: `o${i}` })) }, /2 a 6 opções/u],
    [{ plan: 'ok', options: [{ label: 'A' }, { label: 'A' }] }, /repetida/u],
    [{ plan: 'ok', options: [{ label: 'A' }, { label: '' }] }, /label/u],
    [{ plan: 'ok', options: [{ label: 'A' }, { label: 'B', description: 42 }] }, /description/u],
    [{ plan: 'ok', options: [{ label: 'A' }, 'B'] }, /label/u]
  ]
  for (const [input, expected] of cases) {
    const card = guiPlanApprovalCard(input)
    assert.ok('error' in card, `deveria recusar ${JSON.stringify(input)?.slice(0, 60)}`)
    assert.match(card.error, expected)
  }
})

test('o prefixo do requestId identifica o cartão de plano em qualquer CLI', () => {
  assert.equal(isGuiPlanApprovalRequestId(`${GUI_PLAN_APPROVAL_REQUEST_PREFIX}abc`), true)
  assert.equal(isGuiPlanApprovalRequestId('codex-async-1'), false)
  assert.equal(isGuiPlanApprovalRequestId('plan-proposal-1'), false)
  assert.equal(isGuiPlanApprovalRequestId(''), false)
})

test('nomes e textos: a tool é a mesma nos dois CLIs e o recibo manda encerrar o turno', () => {
  assert.equal(GUI_PLAN_APPROVAL_TOOL, 'plan_approval')
  assert.equal(GUI_PLAN_APPROVAL_CLAUDE_TOOL, `mcp__synkora__${GUI_PLAN_APPROVAL_TOOL}`)
  assert.match(GUI_PLAN_APPROVAL_DESCRIPTION, /ENCERRE O TURNO/u)
  assert.match(GUI_PLAN_APPROVAL_DESCRIPTION, /Aprovar \/ Não aprovar/u)
  assert.match(GUI_PLAN_APPROVAL_RECEIPT, /ENCERRE O TURNO AGORA/u)
  assert.match(GUI_PLAN_APPROVAL_RECEIPT, /mensagem nova/u)
})
