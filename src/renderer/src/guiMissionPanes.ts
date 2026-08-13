import type { GuiPaneState } from './store'

// CONVENÇÃO DE paneId DOS CHATS DE MISSÃO + leitura do pulso deles.
//
// Espelho do módulo puro `src/main/guiMissionContracts.ts` (onda B): o main é
// o dono da convenção, mas o renderer precisa dela para responder uma pergunta
// que só ele faz — "esta missão direta está trabalhando agora?". O mapa não
// tem pane TUI nenhum de missão direta: quem está vivo é a CONVERSA, e a
// conversa se endereça pelo paneId.
//
// Módulo PURO (nada de window/store): dá para ler o pulso a partir de qualquer
// fatia de `guiPanes`, no host ou na view de panes.

export type GuiMissionPaneRole = 'dev' | 'reviewer' | 'helper'

/** Os 8 primeiros chars do id — a mesma régua do branch mission/<id8>. */
export function missionShortId(missionId: string): string {
  return missionId.slice(0, 8)
}

/** `gui-<papel>-<id8>` (ajudante: `gui-helper-<id8>-<n>`, n ≥ 1). */
export function guiMissionPaneId(
  role: GuiMissionPaneRole,
  missionId: string,
  index?: number
): string {
  const base = `gui-${role}-${missionShortId(missionId)}`
  if (role !== 'helper') return base
  const n = Number.isFinite(index) && (index as number) >= 1 ? Math.floor(index as number) : 1
  return `${base}-${n}`
}

/** Todo pane GUI desta missão (dev, revisor e ajudantes). */
export function isGuiMissionPaneId(paneId: string, missionId: string): boolean {
  const short = missionShortId(missionId)
  return (
    paneId === `gui-dev-${short}` ||
    paneId === `gui-reviewer-${short}` ||
    paneId.startsWith(`gui-helper-${short}-`)
  )
}

/**
 * O que a missão direta está fazendo, em UMA palavra:
 * - `attention` — alguma conversa espera o dono (permissão pendente);
 * - `running`   — algum turno em curso (ou sessão nascendo);
 * - `calm`      — conversa viva, turno fechado;
 * - `dormant`   — nenhuma sessão viva nesta janela (nunca aberta, ou encerrada).
 *
 * `dormant` NUNCA significa "missão parada de vez": as sessões vivem no main e
 * a conversa é retomada ao abrir a missão. Significa só "não há nada vivo aqui
 * agora" — é por isso que o card fica calmo em vez de mentir um cometa.
 */
export type MissionChatPulse = 'dormant' | 'calm' | 'running' | 'attention'

export interface MissionChatSummary {
  pulse: MissionChatPulse
  /** conversas com turno em curso */
  running: number
  /** conversas esperando permissão do dono */
  attention: number
  /** conversas com sessão viva (qualquer estado que não seja `dead`) */
  live: number
}

export const NO_MISSION_CHAT: MissionChatSummary = {
  pulse: 'dormant',
  running: 0,
  attention: 0,
  live: 0
}

/** Só o que o pulso precisa — assim a leitura serve a qualquer fatia. */
type GuiPaneLike = Pick<GuiPaneState, 'status' | 'perm'>

export function missionChatSummary(
  missionId: string,
  guiPanes: Record<string, GuiPaneLike>
): MissionChatSummary {
  let running = 0
  let attention = 0
  let live = 0
  for (const [paneId, pane] of Object.entries(guiPanes)) {
    if (!isGuiMissionPaneId(paneId, missionId)) continue
    if (pane.status === 'dead') continue
    live += 1
    // permissão pendente vence tudo: é o único estado que EXIGE o dono
    if (pane.perm || pane.status === 'waiting-you') attention += 1
    else if (pane.status === 'working' || pane.status === 'starting') running += 1
  }
  const pulse: MissionChatPulse = attention
    ? 'attention'
    : running
      ? 'running'
      : live
        ? 'calm'
        : 'dormant'
  return { pulse, running, attention, live }
}

/** Frase curta do estado — cabe na linha do card do mapa. */
export function missionChatLabel(summary: MissionChatSummary): string {
  if (summary.attention) return 'esperando você'
  if (summary.running) return summary.running > 1 ? `${summary.running} trabalhando` : 'trabalhando'
  if (summary.live) return summary.live > 1 ? `${summary.live} conversas abertas` : 'conversa aberta'
  return 'conversa fechada'
}
