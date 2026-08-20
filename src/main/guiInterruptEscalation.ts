/**
 * R23.1 — O ■ DO DONO SEMPRE VENCE (design vinculante
 * `.synkora/reports/DESIGN_PARADA_QUE_MANDA_R23_2026-08-19.md`).
 *
 * O incidente (print + caixa-preta do dono, 2026-08-19 23:16): o CLI encravou
 * depois de um erro de API com o turno aberto, DOIS ■ saíram sem confirmação e
 * o dono ficou sem saída visível. A autoridade do dono é guarda DURA: um
 * processo travado não a veta. Estourado o timeout de confirmação QUE JÁ
 * EXISTIA (10s; nenhum relógio novo — doutrina R19), o processo cai pelo
 * caminho de kill de sempre e a nota no fio nomeia a RECEITA.
 *
 * As palavras moram aqui, fora dos dois motores, porque os DOIS falam com esta
 * voz — `maestroSession.ts` e `codexSession.ts` importam daqui e o contrato da
 * escalada é literalmente o MESMO nos dois CLIs.
 */

/** A saída sancionada de toda queda por interrupção (CLAUDE.md: "beco sem saída
 *  é bug" — toda recusa nomeia a ação que destrava). */
export const GUI_INTERRUPT_REVIVE_RECIPE = 'enviar reabre a MESMA conversa'

/** A nota do estouro do timeout de confirmação, palavra por palavra do design. */
export const GUI_INTERRUPT_ESCALATION_NOTE = `o CLI não confirmou a interrupção em 10s e foi derrubado — ${GUI_INTERRUPT_REVIVE_RECIPE}`

/**
 * Cola a receita em QUALQUER motivo de queda por interrupção. A escalada por
 * tempo não é o único caminho que derruba o processo: recusa do CLI e erro de
 * protocolo caem pelo mesmo `failInterrupt`, e sem isto ficariam mudos sobre
 * como voltar. Idempotente — a nota da escalada já traz a receita dentro.
 */
export function withGuiInterruptRecipe(message: string): string {
  const text = message.trim()
  if (!text) return GUI_INTERRUPT_ESCALATION_NOTE
  return text.includes(GUI_INTERRUPT_REVIVE_RECIPE)
    ? text
    : `${text} — ${GUI_INTERRUPT_REVIVE_RECIPE}`
}
