import type { GuiQuestion, SessionEvent } from './maestroSession'

type AsyncQuestionEvent = Extract<SessionEvent, { type: 'question' }>

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function text(value: unknown, cap: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= cap
}

/** codex-cli 0.153.4: request_user_input_async chega em agentMessage.questions,
 * não como request RPC. Só esse campo tipado cria cartão; prosa nunca é lida. */
export function codexAsyncQuestionEvent(item: unknown): AsyncQuestionEvent | null {
  const source = record(item)
  if (source?.['type'] !== 'agentMessage' || !text(source['id'], 200)) return null
  const raw = source['questions']
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) return null
  const questions: GuiQuestion[] = []
  for (const [index, candidate] of raw.entries()) {
    const question = record(candidate)
    if (!question || !text(question['title'], 2_000) ||
      Object.keys(question).some(key => key !== 'title' && key !== 'options')) return null
    const options = question['options'] ?? []
    if (!Array.isArray(options) || options.length > 12 ||
      !options.every(option => text(option, 2_000)) || new Set(options).size !== options.length) return null
    questions.push({ id: String(index), question: question['title'],
      options: options.map(label => ({ label })), allowCustom: true })
  }
  return { type: 'question', requestId: `codex-async-${source['id']}`,
    questions, blocking: false, asynchronous: true }
}

/** Resposta é uma mensagem NOVA do dono, conforme a descrição da tool local.
 * O pedido permanece no anel até o envio normal aceitar essa mensagem. */
export function codexAsyncQuestionAnswer(
  questions: readonly GuiQuestion[], answers: Record<string, string>
): { text: string; entries: { question: string; answer: string }[] } | null {
  if (!record(answers) || questions.length === 0) return null
  const entries: { question: string; answer: string }[] = []
  for (const [id, answer] of Object.entries(answers)) {
    const question = questions.find(candidate => candidate.id === id)
    if (!question || !text(answer, 4_000)) return null
    entries.push({ question: question.question, answer })
  }
  if (entries.length === 0) return {
    text: 'O dono pulou estas perguntas, sem escolher uma opção:\n\n' +
      questions.map((question, index) => `${index + 1}. ${question.question}`).join('\n'),
    entries
  }
  // Resposta parcial não descarta silenciosamente as outras perguntas do card.
  if (entries.length !== questions.length) return null
  return { text: 'Respostas às suas perguntas:\n\n' +
    entries.map((entry, index) => `${index + 1}. ${entry.question}\nResposta: ${entry.answer}`).join('\n\n'), entries }
}
