import type { IntegrationTicketSignal } from './integrationQueuePresentation'

// ————————————————————————————————————————————————————————————————————————
// OS AVISOS DO BOARD (2026-09-26, mockup aprovado pelo dono:
// docs/mockups/avisos-2026-09-26.html).
//
// A faixa tracejada de largura inteira (`.mission-msg`) virou uma PILHA de
// avisos flutuantes no canto do Board, perto do ⇪ que os dispara. Não é modal:
// o chat continua visível e clicável atrás — a mesma ordem do dono que tirou o
// modal do ⇪ ("eu preciso VER o que ele tá fazendo no chat").
//
// O TOM é dito por quem CHAMA (a estrutura: tem ticket? caiu no catch?), nunca
// adivinhado lendo a frase — o corpo é o texto que já chegava, só com a
// primeira letra em maiúscula.
//
// MÓDULO PURO: nada de React, `window` ou store — só TIPOS entram por import,
// e é por isso que `scripts/test-notice-stack.mjs` o importa direto.
// ————————————————————————————————————————————————————————————————————————

/** O selo diz o tom pela FORMA antes da cor: quadrado = andamento (fila),
 *  losango = recusa, octógono = erro, círculo = informação. */
export type NoticeTone = 'queued' | 'warn' | 'error' | 'info'

export interface NoticeAction {
  label: string
  run: () => void
}

export interface NoticeSpec {
  /** o MESMO aviso repetido (mesma chave) substitui o anterior */
  key: string
  tone: NoticeTone
  title: string
  body: string
  /** selo curto ao lado do título — ex.: "posição 1 de 3" */
  chip?: string
  /** de quem o aviso fala: ele fica até o × e pode sobreviver à troca de aba */
  context?: string
  /** o que é o `context` — ausente = 'missão' */
  contextKind?: 'missão' | 'versão'
  action?: NoticeAction
}

export interface Notice extends NoticeSpec {
  id: number
}

/** Quantos avisos ficam à vista; os mais antigos viram "+N avisos". */
export const NOTICE_STACK_LIMIT = 3

/** Os tempos que o ajuste "fechar sozinho" oferece; 0 = nunca (o padrão). */
export const NOTICE_AUTO_CLOSE_SECONDS = [0, 6, 10, 20] as const
export type NoticeAutoCloseSeconds = (typeof NOTICE_AUTO_CLOSE_SECONDS)[number]

export type NoticeCorner = 'bottom' | 'top'

export function pushNotice(stack: readonly Notice[], spec: NoticeSpec, id: number): Notice[] {
  return [...stack.filter((n) => n.key !== spec.key), { ...spec, id }]
}

export function dismissNotice(stack: readonly Notice[], id: number): Notice[] {
  return stack.filter((n) => n.id !== id)
}

/** O mais novo é o último (colado no canto); os que passam do teto se escondem. */
export function shownNotices(
  stack: readonly Notice[],
  limit: number = NOTICE_STACK_LIMIT
): { shown: Notice[]; hiddenCount: number } {
  const hiddenCount = Math.max(0, stack.length - limit)
  return { shown: stack.slice(hiddenCount), hiddenCount }
}

/** Recusa e erro são anunciados na hora; fila e informação esperam a vez. */
export function noticeRole(tone: NoticeTone): 'alert' | 'status' {
  return tone === 'warn' || tone === 'error' ? 'alert' : 'status'
}

export function normalizeNoticeAutoClose(value: unknown): NoticeAutoCloseSeconds {
  return (NOTICE_AUTO_CLOSE_SECONDS as readonly unknown[]).includes(value)
    ? (value as NoticeAutoCloseSeconds)
    : 0
}

export function normalizeNoticeCorner(value: unknown): NoticeCorner {
  return value === 'top' ? 'top' : 'bottom'
}

/** Os dois ajustes dos avisos (tela Ajustes), já saneados. Espelho do
 *  `sanitizePreferences` de src/main/settingsCore.ts: `settings` pode ser
 *  `null` antes do boot e os campos faltam em quem veio de versão antiga. */
export function noticePrefsOf(
  settings: { noticeAutoCloseSeconds?: unknown; noticeCorner?: unknown } | null | undefined
): { autoCloseSeconds: NoticeAutoCloseSeconds; corner: NoticeCorner } {
  return {
    autoCloseSeconds: normalizeNoticeAutoClose(settings?.noticeAutoCloseSeconds),
    corner: normalizeNoticeCorner(settings?.noticeCorner)
  }
}

/** Recusa e erro ficam até o dono fechar no ×, qualquer que seja o ajuste. */
export function noticeAutoCloseSeconds(tone: NoticeTone, preference: number): number {
  return tone === 'warn' || tone === 'error' ? 0 : preference
}

/** Formatação, nunca reescrita: sem espaço sobrando e com a 1ª letra maiúscula. */
export function noticeSentence(text: string): string {
  const trimmed = text.trim()
  return trimmed ? trimmed[0].toLocaleUpperCase('pt-BR') + trimmed.slice(1) : ''
}

const TICKET_TITLE: Record<IntegrationTicketSignal['state'], string> = {
  queued: 'Na fila de integração',
  sync_required: 'Sincronizando antes de integrar',
  merging: 'Integrando agora',
  blocked: 'Integração pausada'
}

/** O aviso do ⇪. Com ticket, a missão ESTÁ na fila e o estado dele dá título,
 *  tom e posição; sem ticket, o motor recusou e a frase dele é o motivo. */
export function integrationNotice(input: {
  missionId: string
  missionTitle: string
  ticket?: IntegrationTicketSignal
  message: string
}): NoticeSpec {
  const { missionId, missionTitle, ticket, message } = input
  const common = { key: `integration:${missionId}`, body: noticeSentence(message), context: missionTitle }
  if (!ticket) return { ...common, tone: 'warn', title: 'Integração não iniciada' }
  return {
    key: common.key,
    tone: ticket.state === 'blocked' ? 'warn' : 'queued',
    title: TICKET_TITLE[ticket.state],
    chip: `posição ${ticket.position} de ${ticket.total}`,
    body: common.body,
    context: common.context
  }
}
