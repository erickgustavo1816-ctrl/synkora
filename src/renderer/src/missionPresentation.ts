import type { Mission } from './store'

// COMO UMA MISSÃO SE APRESENTA — a fonte ÚNICA do dot, do selo e da palavra de
// estado (2026-08-15).
//
// Estas três regras nasceram dentro do `MissionColumn`, e o retrato do ✦
// geral (`DockGeneral`) precisa exatamente delas: a mesma missão não pode ter
// dot verde numa coluna e âmbar na outra. Copiar seria garantir a divergência
// na primeira mudança, então elas saíram para cá.
//
// MÓDULO PURO: nada de React, `window` ou store — só tipos (que somem na
// compilação) entram por import, e é por isso que o teste consegue importá-lo
// direto, sem montar renderer nenhum.

/** O RECORTE que o dot/selo leem de uma missão. A coluna e o painel passam a
 *  `Mission` inteira (é atribuível); o teste passa só o que importa. */
export interface MissionSignal {
  mission: Pick<Mission, 'status' | 'integration' | 'pendingIntegrationApproval'>
  /** pergunta pendente do agente ao dono (ask_user, permissão, plano a aprovar) */
  pulse?: string
}

/** Selo curto à direita do título — o mesmo vocabulário das abas antigas. */
export interface MissionBadge {
  glyph: string
  kind: string
}

/** A palavra de estado da missão, igual no trilho de entrega e no painel. */
export const MISSION_STATUS_LABEL: Record<Mission['status'], string> = {
  ativa: 'em andamento',
  integrando: 'integrando agora',
  concluida: 'integrada',
  arquivada: 'arquivada'
}

/** Estado visual do ponto: o que exige o dono vence o que está só andando. */
export function dotClass(signal: MissionSignal): string {
  const { mission, pulse } = signal
  if (pulse || mission.pendingIntegrationApproval) return 'ask'
  if (mission.integration?.state === 'blocked') return 'err'
  if (mission.status === 'integrando' || mission.integration) return 'busy'
  return 'ok'
}

/** Selo curto à direita do título — null quando não há nada a dizer. */
export function badgeFor(signal: MissionSignal): MissionBadge | null {
  const { mission, pulse } = signal
  if (pulse) return { glyph: '❓', kind: 'ask' }
  if (mission.pendingIntegrationApproval) return { glyph: '⇪', kind: 'ask' }
  const integration = mission.integration
  if (!integration || integration.state === 'merging') return null
  if (integration.state === 'blocked')
    return {
      glyph: integration.owner === 'orchestrator' ? '! reparo' : '! decisão',
      kind: 'err'
    }
  if (integration.state === 'sync_required') return { glyph: '↻ sync', kind: 'busy' }
  return { glyph: `fila #${integration.position}`, kind: 'busy' }
}

/** A missão está PARADA esperando uma decisão do dono? (âmbar `--warn`) */
export function waitingOnOwner(signal: MissionSignal): boolean {
  return Boolean(signal.pulse || signal.mission.pendingIntegrationApproval)
}
