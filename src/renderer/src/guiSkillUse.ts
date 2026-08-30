/**
 * O CHIP DE SKILL — quando o chat usa uma skill, a UI mostra.
 *
 * Sonda de 2026-08-30 (`.synkora/reports/PROBE_SKILL_USE_2026-08-30.md`):
 *
 * - **claude** tem marcador estrutural de primeira classe: `Skill` está no
 *   `tools[]` do request e o uso vira um `tool_use` comum com o nome da skill
 *   dentro de `input.skill`. O app JÁ entrega isso aqui (o `tool_use` vira
 *   `SessionEvent {type:'tool'}` em `maestroSession`) — o chip é trabalho de
 *   renderer, e nada no main precisou mudar por causa do claude.
 * - **codex** não tem evento nenhum; o `codexSkillSignals` do main normaliza as
 *   duas superfícies tipadas dele para ESTA MESMA forma. Por isso existe um
 *   caminho de apresentação só, e ele não sabe de qual CLI veio.
 * - **o caminho slash do claude é MUDO** (P4 da sonda): `/nome` como mensagem
 *   de usuário roda a skill sem produzir `tool_use` algum — o CLI expande a
 *   skill do lado do cliente. Se um dia o chat oferecer skill por slash, o chip
 *   TEM que nascer no ENVIO, do lado do app; esperar a stream não traz nada.
 *
 * Semântica (veredito 3, medido nos dois CLIs): o marcador diz "esta skill
 * ENTROU nesta conversa", não "foi usada neste turno" — o segundo uso não emite
 * nada. Um chip por turno mentiria a partir da segunda vez.
 */

/**
 * ESPELHO DECLARADO do nome da tool. O par do main está em
 * `src/main/codexSkillSignals.ts` (que normaliza o codex para cá); o valor é o
 * que o claude publica no `tools[]` do próprio request.
 */
export const GUI_SKILL_TOOL_NAME = 'Skill'

/**
 * O nome da skill, do campo TIPADO e só dele.
 *
 * Comparação EXATA com `Skill`: tool de MCP nasce `mcp__servidor__tool`, então
 * não há colisão possível — e "parecido" nunca vira chip.
 *
 * `input.skill` ausente/vazio devolve `undefined` de propósito: um chip anônimo
 * esconderia uma mudança de protocolo. Sem nome, o evento segue no card
 * genérico de ferramenta, onde a regressão fica VISÍVEL.
 */
export function guiSkillNameForTool(
  name: string,
  input: Record<string, unknown> | undefined
): string | undefined {
  if (name !== GUI_SKILL_TOOL_NAME) return undefined
  const skill = input?.['skill']
  if (typeof skill !== 'string') return undefined
  const trimmed = skill.trim()
  return trimmed ? trimmed : undefined
}
