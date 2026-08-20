// O QUE ACONTECE AO CLICAR NO CARD DE UMA MISSÃO (aba Versões).
//
// Módulo PURO e sem imports de propósito: a classificação é a regra, e a regra
// se testa sozinha (matriz status × direct × kind), sem renderer nem store.
//
// Até 2026-08-15 a aba tinha UM booleano (`m.status !== 'concluida'`): missão
// ARQUIVADA escapava dele, o clique levava ao board, o board via que a missão
// não está viva e desfazia a navegação no mesmo ciclo. Clique que se
// auto-cancela é beco sem saída — a regra do projeto é que toda alavanca diz a
// verdade ou não existe.

/** Espelho estrutural de `MissionStatus`/`Mission` (store) — declarado aqui
 *  para o módulo não arrastar nada do renderer para dentro do teste. */
export interface MissionCardAccessInput {
  status: 'ativa' | 'integrando' | 'concluida' | 'arquivada'
  /** MISSÃO 2.0: a conversa GUI é a missão, e ela fica gravada no disco. */
  direct?: boolean
  /** ARMADILHA DE NOME: `kind: 'direta'` é o REGISTRO de trabalho de agente
   *  livre (nasce concluído, sem branch e sem conversa nenhuma) — não tem
   *  parentesco com `direct: true`, que é a missão 2.0. */
  kind?: 'direta'
}

/**
 * - `live`        — missão viva: o clique abre a aba dela no board (como sempre);
 * - `frozen-chat` — missão encerrada COM conversa 2.0 gravada: abre a fotografia
 *                   somente-leitura (arquivar/integrar mata o processo e guarda
 *                   o fio; só excluir apaga);
 * - `inert`       — não há o que abrir: o card não é clicável e diz por quê.
 */
export type MissionCardAccess = 'live' | 'frozen-chat' | 'inert'

/**
 * R27 — RELEASE É RELEASE (ordem do dono, 2026-08-20). O registro interno que
 * carrega a conversa da subida NUNCA é missão de superfície: não vira card,
 * não vira aba, não entra em retrato nem contagem. A superfície dele é a aba
 * Versões (o ⇪ abre/reabre o chat) e o trilho próprio de release no board.
 * A régua mora AQUI, no módulo puro, e as telas a consomem — nunca reescrevem.
 */
export function isReleaseMissionRecord(mission: { missionType?: string }): boolean {
  return mission.missionType === 'release'
}

export function missionCardAccess(mission: MissionCardAccessInput): MissionCardAccess {
  if (mission.status === 'ativa' || mission.status === 'integrando') return 'live'
  // 'concluida' entra junto com 'arquivada' por ter EXATAMENTE a mesma
  // fotografia no disco: integrar chama killMissionGuiPanes, nunca forgetWhere.
  const encerrada = mission.status === 'concluida' || mission.status === 'arquivada'
  if (encerrada && mission.direct === true && mission.kind !== 'direta') return 'frozen-chat'
  return 'inert'
}

/** A frase do tooltip — uma verdade diferente por classe, nunca a mesma. */
export const MISSION_CARD_TIP: Record<MissionCardAccess, string> = {
  live: 'Abrir a aba da missão no board',
  'frozen-chat': 'Ver a conversa desta missão (somente leitura)',
  inert: 'Missão encerrada — sem conversa guardada'
}
