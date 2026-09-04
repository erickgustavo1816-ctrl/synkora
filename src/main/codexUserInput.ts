import type { GuiQuestion } from './maestroSession'

/** Schema sondado no codex-cli 0.153.2, sem abrir uma conversa. */
interface PendingUserInput {
  rpcId: number | string
  blocking: boolean
  questions: GuiQuestion[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function text(value: unknown, cap: number): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value.length <= cap
}

/** IDs e opções nunca são truncados: o usuário responde ao que foi exibido. */
function parseQuestions(value: unknown): GuiQuestion[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null
  const seen = new Set<string>()
  const questions: GuiQuestion[] = []
  for (const raw of value) {
    const q = record(raw)
    if (!q || !text(q['id'], 256) || !text(q['question'], 2_000) ||
      !text(q['header'], 160) || seen.has(q['id']) || q['isSecret'] === true ||
      (q['isSecret'] !== undefined && typeof q['isSecret'] !== 'boolean') ||
      (q['isOther'] !== undefined && typeof q['isOther'] !== 'boolean')) return null
    seen.add(q['id'])
    const rawOptions = q['options'] ?? []
    if (!Array.isArray(rawOptions) || rawOptions.length > 12) return null
    const labels = new Set<string>()
    const options: GuiQuestion['options'] = []
    for (const rawOption of rawOptions) {
      const option = record(rawOption)
      if (!option || !text(option['label'], 240) || labels.has(option['label']) ||
        (option['description'] !== undefined &&
          (typeof option['description'] !== 'string' || option['description'].length > 1_000))) return null
      labels.add(option['label'])
      options.push({ label: option['label'],
        ...(typeof option['description'] === 'string' ? { description: option['description'] } : {}) })
    }
    questions.push({ id: q['id'], question: q['question'], header: q['header'],
      options, allowCustom: q['isOther'] === true || options.length === 0 })
  }
  return questions
}

/** Estado privado do motor. Nenhum pedido recebe seleção ou aceite automático. */
export class CodexUserInputRequests {
  private readonly pending = new Map<string, PendingUserInput>()

  add(rpcId: number | string, params: Record<string, unknown>): PendingUserInput | null {
    const questions = parseQuestions(params['questions'])
    if (!questions || (params['isBlocking'] !== undefined && typeof params['isBlocking'] !== 'boolean'))
      return null
    const requestId = `rpc-${String(rpcId)}`
    if (this.pending.has(requestId) || this.pending.size >= 8) return null
    const request = { rpcId, questions, blocking: params['isBlocking'] !== false }
    this.pending.set(requestId, request)
    return request
  }

  get blocking(): boolean {
    return [...this.pending.values()].some(request => request.blocking)
  }

  answer(requestId: string, input: Record<string, string>): {
    rpcId: number | string
    response: { answers: Record<string, { answers: string[] }> }
  } | null {
    const request = this.pending.get(requestId)
    if (!request || !input || typeof input !== 'object' || Array.isArray(input)) return null
    const entries: Array<[string, { answers: string[] }]> = []
    for (const [id, answer] of Object.entries(input)) {
      const question = request.questions.find(q => q.id === id)
      if (!question || typeof answer !== 'string' || answer.length > 4_000 ||
        (!question.allowCustom && !question.options.some(option => option.label === answer))) return null
      if (answer.trim()) entries.push([id, { answers: [answer] }])
    }
    this.pending.delete(requestId)
    return { rpcId: request.rpcId, response: { answers: Object.fromEntries(entries) } }
  }

  cancel(requestId: string): boolean {
    return this.pending.delete(requestId)
  }

  clear(): string[] {
    const ids = [...this.pending.keys()]
    this.pending.clear()
    return ids
  }
}
