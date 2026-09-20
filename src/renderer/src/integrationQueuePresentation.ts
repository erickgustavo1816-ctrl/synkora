import type { Mission, MissionIntegrationQueueView } from './store'
import type { MissionBadge } from './missionPresentation'

// ————————————————————————————————————————————————————————————————————————
// A FILA DE INTEGRAÇÃO COMO ESTADO (rodada 9, 2026-08-19 — ordem do dono).
//
// Verbatim: "quando eu clico em subir, o certo é avisar o agente — 'tá pronto
// pra subir' — e o AGENTE sobe. (…) NÃO pode aparecer modal 'essa missão tá
// sendo integrada': eu preciso VER o que ele tá fazendo no chat."
//
// O ⇪ deixou de ser um comando que a máquina executa atrás de um véu: ele
// ESTIMULA o agente, e quem sobe a branch é ele, no fio da conversa. Sobra
// para a tela exatamente uma tarefa — dizer ONDE a missão está na fila e O QUE
// está acontecendo com ela agora — e nenhuma janela pode ficar na frente disso.
//
// A régua nova, que o vocabulário de sempre (`missionPresentation`) não tinha
// como saber: CABEÇA DE FILA COM ERRO não é máquina travada, é o AGENTE
// resolvendo o conflito no worktree da missão (o motor devolve o ticket para
// 'queued' com `lastError` justamente para o dono ver o agente trabalhando).
//
// MÓDULO PURO (mesma régua do `missionPresentation`): nada de React, `window`
// ou store — só TIPOS entram por import, e é por isso que a suíte o importa
// direto, sem montar renderer nenhum.
// ————————————————————————————————————————————————————————————————————————

/** O RECORTE do ticket que estas regras leem. A fotografia inteira
 *  (`MissionIntegrationQueueView`) é atribuível; o teste passa só o que
 *  importa. Espelho declarado de src/main/integrationQueue.ts, via preload. */
export type IntegrationTicketSignal = MissionIntegrationQueueView

/** The server additionally proves the saved intent and the merge before cleanup. */
export function canRetryIntegrationFinalization(ticket?: IntegrationTicketSignal): boolean {
  return ticket?.state === 'blocked' && ticket.owner === 'orchestrator'
}

/** O que o card/lista precisa saber de uma missão para achar o lugar dela. */
export interface IntegrationQueueMission {
  id: string
  title: string
  integration?: IntegrationTicketSignal
}

/** Uma linha da FILA DA <versão> — já ordenada, pronta para desenhar. */
export interface IntegrationQueueRow {
  missionId: string
  title: string
  position: number
  /** é a missão que o dono está olhando agora? */
  mine: boolean
  ticket: IntegrationTicketSignal
}

/** A bola está com o AGENTE deste ticket? É a cabeça da fila ainda 'queued':
 *  o app já o estimulou (backstage + nota no fio) e o próximo passo é dele.
 *  'merging' NÃO entra: ali quem trabalha é o git, e dura um piscar. */
export function agentHasTheBall(ticket: IntegrationTicketSignal): boolean {
  return ticket.state === 'queued' && ticket.position <= 1
}

/** O agente está com a mão num CONFLITO? O ticket volta para 'queued' na
 *  cabeça carregando `lastError` — nunca fica preso em 'blocked' esperando
 *  máquina —, e é isso que o dono precisa ler: não é uma fila travada. */
export function agentIsResolving(ticket: IntegrationTicketSignal): boolean {
  return agentHasTheBall(ticket) && Boolean(ticket.lastError)
}

/** Palavra CURTA do estado — cabe em selo de coluna e em linha de fila. Sem
 *  ordinal: quem desenha a lista já mostra o #N na própria coluna dele. */
export function integrationStateWord(ticket: IntegrationTicketSignal): string {
  if (ticket.state === 'merging') return 'integrando'
  if (ticket.state === 'blocked')
    return ticket.owner === 'orchestrator' ? '⚠ reparo' : '⚠ decisão'
  if (ticket.state === 'sync_required') return '↻ sync'
  if (agentIsResolving(ticket)) return '⚠ conflito'
  return agentHasTheBall(ticket) ? '⇪ com o agente' : 'na fila'
}

/** Linha curta COM a ordem, para superfícies que não desenham a posição
 *  separada (o quadro de rotas). A ordem só entra quando ela é a notícia. */
export function integrationShortLine(ticket: IntegrationTicketSignal): string {
  return ticket.state === 'queued' && !agentHasTheBall(ticket)
    ? `fila #${ticket.position}/${ticket.total}`
    : integrationStateWord(ticket)
}

/** A frase inteira — nota do ⇪ no trilho e dica de cada linha da fila. */
export function integrationQueueNote(ticket: IntegrationTicketSignal): string {
  if (ticket.state === 'merging') return 'integrando agora — o merge está em curso'
  if (ticket.state === 'blocked')
    return ticket.owner === 'orchestrator'
      ? 'finalização pendente — o agente pode retomar o reparo; acompanhe pelo chat'
      : 'fila pausada — decisão pendente'
  if (ticket.state === 'sync_required') return 'sincronizando antes de integrar'
  if (agentIsResolving(ticket))
    return 'conflito na subida — o agente está resolvendo no worktree da missão; acompanhe pelo chat'
  if (agentHasTheBall(ticket))
    return 'é a vez desta missão — o agente foi avisado e sobe a branch; acompanhe pelo chat'
  return `fila de integração #${ticket.position} de ${ticket.total}`
}

/** O selo da coluna que SÓ a fila sabe dizer — `null` quando o vocabulário de
 *  sempre (`missionPresentation.badgeFor`) já basta, e quem desenha compõe:
 *  `integrationQueueBadge(entry) ?? badgeFor(entry)`.
 *
 *  Quem espera o DONO (pergunta do agente, aval do ⇪) vence a fila: esse sinal
 *  não é dela, e devolver `null` aqui é o que devolve a vez ao `badgeFor`. */
export function integrationQueueBadge(signal: {
  mission: Pick<Mission, 'integration' | 'pendingIntegrationApproval'>
  pulse?: string
}): MissionBadge | null {
  const { mission, pulse } = signal
  if (pulse || mission.pendingIntegrationApproval) return null
  const ticket = mission.integration
  if (!ticket || !agentHasTheBall(ticket)) return null
  return agentIsResolving(ticket)
    ? { glyph: '⚠ conflito', kind: 'err' }
    : { glyph: '⇪ com o agente', kind: 'busy' }
}

/** A ORDEM REAL da fila do projeto, das missões que o renderer já tem em mão —
 *  cada uma carrega o próprio ticket, então não há canal novo nem leitura
 *  extra. Missão sem ticket não está na fila e não entra na lista.
 *
 *  Desempate por título: as posições saem FIFO do motor e são únicas por
 *  projeto, mas uma fotografia colhida no meio de uma mudança não pode fazer a
 *  lista dançar entre dois renders. */
export function integrationQueueRows(
  missions: readonly IntegrationQueueMission[],
  selectedMissionId?: string
): IntegrationQueueRow[] {
  return missions
    .flatMap((mission) =>
      mission.integration
        ? [
            {
              missionId: mission.id,
              title: mission.title,
              position: mission.integration.position,
              mine: mission.id === selectedMissionId,
              ticket: mission.integration
            }
          ]
        : []
    )
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title))
}
