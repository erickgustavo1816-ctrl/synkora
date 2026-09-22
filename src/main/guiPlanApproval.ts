/**
 * O CARTÃO DE PLANO DO SYNKORA (2026-09-22) — o mini-plano viaja DENTRO do pedido.
 *
 * O CASO MEDIDO (missão 45abc1ea, claude 2.1.278, fable): o dev "mostrou o
 * plano" e chamou AskUserQuestion, mas a sessão gravou só um bloco de
 * RACIOCÍNIO com o plano e a chamada da tool — nenhum bloco de texto. O chat
 * esconde raciocínio por decisão do dono (P13), então ele viu um cartão
 * "aprova o plano?" sem plano nenhum. Foi a segunda vez em dois dias, e nenhuma
 * instrução ao modelo garante que ele não repita: texto escrito antes de um
 * cartão não é um lugar de confiança.
 *
 * A RESPOSTA (ordem do dono, 2026-09-22): "um sistema para mostrar o plano,
 * independente se é o Codex ou o Claude que está propondo". Esta tool recebe o
 * plano como ARGUMENTO e o harness sintetiza um cartão de pergunta que carrega
 * o plano no corpo — a mesma família das perguntas ASSÍNCRONAS do Codex
 * (`codexAsyncQuestions`): a tool devolve na hora, o agente encerra o turno, o
 * cartão sobrevive ao `result` e o clique do dono vira MENSAGEM NOVA para o
 * agente, nos dois CLIs. Nada aqui depende de o modelo falar antes do cartão.
 *
 * Este módulo é PURO: a forma do pedido, os textos e a régua. Quem publica o
 * evento é o registro de sessões (`guiSessions.planApproval`); quem registra a
 * tool é o servidor MCP.
 */

import type { GuiQuestion, GuiQuestionOption } from './maestroSession'

export const GUI_PLAN_APPROVAL_TOOL = 'plan_approval'
export const GUI_PLAN_APPROVAL_CLAUDE_TOOL = 'mcp__synkora__plan_approval'

/** O plano é um MINI-plano (≤5 linhas pela persona); 4k sobra para markdown. */
export const GUI_PLAN_APPROVAL_PLAN_MAX_CHARS = 4_000
export const GUI_PLAN_APPROVAL_QUESTION_MAX_CHARS = 500
export const GUI_PLAN_APPROVAL_HEADER_MAX_CHARS = 60
export const GUI_PLAN_APPROVAL_OPTION_LABEL_MAX_CHARS = 120
export const GUI_PLAN_APPROVAL_OPTION_DESCRIPTION_MAX_CHARS = 400
export const GUI_PLAN_APPROVAL_OPTION_MAX_COUNT = 6

/** Prefixo do requestId: é ele que diz ao caminho de resposta que o clique
 *  vira mensagem nova (e não control_response), em QUALQUER CLI. */
export const GUI_PLAN_APPROVAL_REQUEST_PREFIX = 'synkora-plan-'

export const GUI_PLAN_APPROVAL_DEFAULT_HEADER = 'Plano'
export const GUI_PLAN_APPROVAL_DEFAULT_QUESTION = 'Aprova este plano?'
export const GUI_PLAN_APPROVAL_DEFAULT_OPTIONS: readonly GuiQuestionOption[] = Object.freeze([
  { label: 'Aprovar', description: 'Pode seguir exatamente assim.' },
  { label: 'Não aprovar', description: 'Quero mudar algo; descrevo em "outra resposta".' }
])

export const GUI_PLAN_APPROVAL_DESCRIPTION =
  'Apresenta seu MINI-PLANO ao dono num cartão de aprovação dentro deste chat. ' +
  'O plano vai em `plan` (markdown, até 5 linhas): o cartão mostra o PRÓPRIO plano com os botões ' +
  'Aprovar / Não aprovar (e "outra resposta"). É o único caminho confiável para pedir aval de um plano — ' +
  'texto escrito antes de um cartão pode se perder. A tool devolve na hora: ENCERRE O TURNO e espere; ' +
  'a decisão do dono chega como mensagem nova. Não comece o trabalho antes dela. ' +
  'Opcional: `question` (pergunta curta), `header` (rótulo) e `options` (2 a 6 alternativas próprias).'

/** O recibo que o modelo lê: a receita do que fazer AGORA. */
export const GUI_PLAN_APPROVAL_RECEIPT =
  'Cartão com o plano publicado no chat. ENCERRE O TURNO AGORA e espere: ' +
  'a decisão do dono chega como mensagem nova. Não comece o trabalho antes dela.'

/** A receita da recusa: nunca um beco sem saída. */
export const GUI_PLAN_APPROVAL_UNAVAILABLE =
  'Canal indisponível. Escreva o plano como texto normal no chat e peça a aprovação com o cartão de pergunta.'

export interface GuiPlanApprovalCard {
  plan: string
  questions: GuiQuestion[]
}

export type GuiPlanApprovalDelivery =
  | { ok: true; requestId: string }
  | { ok: false; error: string }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function boundedText(value: unknown, cap: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 && text.length <= cap ? text : undefined
}

function parseOptions(value: unknown): GuiQuestionOption[] | { error: string } {
  if (value === undefined) return [...GUI_PLAN_APPROVAL_DEFAULT_OPTIONS]
  if (!Array.isArray(value) || value.length < 2 || value.length > GUI_PLAN_APPROVAL_OPTION_MAX_COUNT)
    return { error: `envie de 2 a ${GUI_PLAN_APPROVAL_OPTION_MAX_COUNT} opções, ou omita options` }
  const labels = new Set<string>()
  const options: GuiQuestionOption[] = []
  for (const candidate of value) {
    const option = record(candidate)
    const label = boundedText(option?.['label'], GUI_PLAN_APPROVAL_OPTION_LABEL_MAX_CHARS)
    if (!option || !label)
      return { error: `cada opção precisa de label com 1 a ${GUI_PLAN_APPROVAL_OPTION_LABEL_MAX_CHARS} caracteres` }
    if (labels.has(label)) return { error: `opção repetida: ${label}` }
    labels.add(label)
    const description = option['description']
    if (description !== undefined &&
      (typeof description !== 'string' || description.length > GUI_PLAN_APPROVAL_OPTION_DESCRIPTION_MAX_CHARS))
      return { error: `description de opção é texto de até ${GUI_PLAN_APPROVAL_OPTION_DESCRIPTION_MAX_CHARS} caracteres` }
    const trimmed = typeof description === 'string' ? description.trim() : ''
    options.push({ label, ...(trimmed ? { description: trimmed } : {}) })
  }
  return options
}

/**
 * Parse DEFENSIVO do pedido. O servidor MCP já valida a forma pelo schema; esta
 * função é a régua ÚNICA (o registro de sessões a aplica de novo) e devolve
 * o erro em PT-BR que nomeia o que corrigir.
 */
export function guiPlanApprovalCard(value: unknown): GuiPlanApprovalCard | { error: string } {
  const input = record(value)
  const plan = boundedText(input?.['plan'], GUI_PLAN_APPROVAL_PLAN_MAX_CHARS)
  if (!input || !plan)
    return { error: `envie o plano em plan (markdown, 1 a ${GUI_PLAN_APPROVAL_PLAN_MAX_CHARS} caracteres)` }
  if (input['question'] !== undefined && !boundedText(input['question'], GUI_PLAN_APPROVAL_QUESTION_MAX_CHARS))
    return { error: `question é texto de 1 a ${GUI_PLAN_APPROVAL_QUESTION_MAX_CHARS} caracteres, ou omita` }
  if (input['header'] !== undefined && !boundedText(input['header'], GUI_PLAN_APPROVAL_HEADER_MAX_CHARS))
    return { error: `header é texto de 1 a ${GUI_PLAN_APPROVAL_HEADER_MAX_CHARS} caracteres, ou omita` }
  const options = parseOptions(input['options'])
  if (!Array.isArray(options)) return options
  return {
    plan,
    questions: [{
      id: 'plan',
      question: boundedText(input['question'], GUI_PLAN_APPROVAL_QUESTION_MAX_CHARS) ?? GUI_PLAN_APPROVAL_DEFAULT_QUESTION,
      header: boundedText(input['header'], GUI_PLAN_APPROVAL_HEADER_MAX_CHARS) ?? GUI_PLAN_APPROVAL_DEFAULT_HEADER,
      multiSelect: false,
      options,
      allowCustom: true
    }]
  }
}

export function isGuiPlanApprovalRequestId(requestId: string): boolean {
  return requestId.startsWith(GUI_PLAN_APPROVAL_REQUEST_PREFIX)
}
