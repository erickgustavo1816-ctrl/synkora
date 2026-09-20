/** Model-authored public speech, never a synthesized status or private thought. */
export const GUI_COMMENTARY_TOOL = 'commentary'
export const GUI_COMMENTARY_CLAUDE_TOOL = 'mcp__synkora__commentary'
export const GUI_COMMENTARY_MAX_CHARS = 2000

/** One recipe for owner mail and its reply guard; answering is not completion. */
export const GUI_OWNER_REPLY_PROGRESS =
  `Responda PRIMEIRO em uma ou duas linhas por ${GUI_COMMENTARY_CLAUDE_TOOL} (liberada); ` +
  'se indisponível, use texto normal. Diga o que entendeu. ' +
  'Depois retome o trabalho já autorizado nesta mesma rodada, sem pedir nova autorização. ' +
  'Respeite pedidos de parar ou pausar e aprovações pendentes. ' +
  'Encerre com resultado verificado ou impedimento concreto e pendências, nunca só prometendo aplicar.'

export const GUI_COMMENTARY_DESCRIPTION =
  'Envia sua atualização curta de andamento ao dono no chat, como uma mensagem sua. ' +
  'Use também para responder a uma mensagem que chegou durante o trabalho e dizer o próximo passo. Continue o trabalho já autorizado depois. ' +
  'Não pede aprovação, não encerra a rodada e não substitui a resposta final. ' +
  'Envie conclusões e ações em PT-BR, nunca raciocínio privado. Se indisponível, escreva como texto normal no chat.'

export interface GuiCommentaryIdentity {
  paneId: string
  projectId: string
}

export type GuiCommentaryDelivery = { ok: true } | { ok: false; error: string }

export function guiPublicCommentaryText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 && text.length <= GUI_COMMENTARY_MAX_CHARS ? text : undefined
}
