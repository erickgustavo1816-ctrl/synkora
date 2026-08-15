import type { Mission } from './store'

// A LANDING DO UNIVERSO — as contas do ✦ geral, fora do React (2026-08-15).
//
// Duas telas dividem a mesma coluna: o CONVITE (universo sem nenhuma missão) e
// o PAINEL DO PROJETO (a partir da primeira). Quem decide qual delas aparece,
// quanto cada número vale e o que a data de uma linha diz mora aqui, puro e
// testável — no componente ficaria escondido atrás de JSX.
//
// REGRA DE HONESTIDADE (a que mais custou): número só entra na tela com fonte
// real. Missão 2.0 não cria card nenhum, então `▣ 0/0` seria uma mentira dita
// com confiança — por isso `showsTaskCount`. E `updatedAt` NUNCA é "última
// atividade": ele só se move em mutação de store (status, seat, branch), nunca
// numa mensagem do chat ou num commit. O que dá para dizer com verdade é
// quando a missão nasceu e quando ela integrou.

/** Qual das duas telas o ✦ geral mostra. */
export type ProjectLanding = 'invite' | 'dashboard'

/**
 * ZERO missões de QUALQUER status = convite; a partir da primeira, painel
 * (decisão do dono, 2026-08-15). O critério é "qualquer status" de propósito:
 * um universo cujas missões já integraram TEM história — devolvê-lo ao
 * "crie a primeira missão" apagaria o que ele já entregou.
 */
export function projectLanding(missions: readonly Mission[]): ProjectLanding {
  return missions.length === 0 ? 'invite' : 'dashboard'
}

export interface ProjectKpis {
  /** missões vivas: 'ativa' + 'integrando' */
  emAndamento: number
  /** missões que já entraram na linha de destino */
  integradas: number
  /** na fila serial ⇪ ou esperando o aval do dono para entrar nela */
  naFila: number
  arquivadas: number
}

/**
 * O placar do universo. `naFila` conta o mesmo que o chip da barra: ticket na
 * fila serial, merge em curso, ou o ⇪ parado esperando o clique do dono (a
 * porteira é mecânica — pedido de agente nunca mergeia sozinho).
 */
export function projectKpis(missions: readonly Mission[]): ProjectKpis {
  const vivas = missions.filter((m) => m.status === 'ativa' || m.status === 'integrando')
  return {
    emAndamento: vivas.length,
    integradas: missions.filter((m) => m.status === 'concluida').length,
    naFila: vivas.filter(
      (m) => Boolean(m.integration) || m.status === 'integrando' || Boolean(m.pendingIntegrationApproval)
    ).length,
    arquivadas: missions.filter((m) => m.status === 'arquivada').length
  }
}

/** Missões vivas, mais recente primeiro — as linhas do topo do painel. */
export function liveMissions(missions: readonly Mission[]): Mission[] {
  return missions
    .filter((m) => m.status === 'ativa' || m.status === 'integrando')
    .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt))
}

/** Teto padrão da seção "integradas": o painel resume, não vira histórico. */
export const RECENT_CONCLUDED_CAP = 5

/**
 * Integradas, mais recentes primeiro. Ordena por `completedAt` (o carimbo da
 * transição para 'concluida') e cai em `createdAt` quando a missão é antiga
 * demais para tê-lo — nunca em `updatedAt`, que mede outra coisa.
 */
export function recentConcluded(
  missions: readonly Mission[],
  cap: number = RECENT_CONCLUDED_CAP
): Mission[] {
  return missions
    .filter((m) => m.status === 'concluida')
    .sort((a, b) => concludedAt(b) - concludedAt(a))
    .slice(0, Math.max(0, cap))
}

function concludedAt(mission: Mission): number {
  return timeOf(mission.completedAt) || timeOf(mission.createdAt)
}

function timeOf(iso?: string): number {
  if (!iso) return 0
  const at = new Date(iso).getTime()
  return Number.isFinite(at) ? at : 0
}

/** dd/mm/aaaa, ou null quando a data não existe/não é legível. */
export function formatDay(iso?: string): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return null
  return at.toLocaleDateString('pt-BR')
}

/**
 * A data da linha, com o VERBO certo: integrada mostra quando integrou (e só
 * quando o carimbo existe); qualquer outra mostra quando nasceu. Sem data
 * legível a linha simplesmente não fala de tempo.
 */
export function missionDayLabel(mission: Mission): string | null {
  if (mission.status === 'concluida') {
    const done = formatDay(mission.completedAt)
    return done ? `integrada em ${done}` : null
  }
  const born = formatDay(mission.createdAt)
  return born ? `criada em ${born}` : null
}

/**
 * `▣ feitas/total` só aparece com total > 0. Missão 2.0 não cria card: o zero
 * ali não seria "nada feito", seria "esta conta não se aplica" — e número
 * morto na tela é pior que número nenhum.
 */
export function showsTaskCount(total: number): boolean {
  return Number.isFinite(total) && total > 0
}
