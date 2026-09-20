import type { IntegrationQueueTicketView } from './integrationQueue'

/** A repair keeps the original approval and must never reopen the merge lane. */
export function needsMissionFinalization(ticket?: IntegrationQueueTicketView): boolean {
  return ticket?.state === 'blocked' && ticket.block?.owner === 'orchestrator' &&
    ticket.block.code === 'target_repair_pending'
}

export const MISSION_FINALIZATION_RECIPE =
  'Consulte integration_status e chame integration_run para retomar SOMENTE a finalização já autorizada; ' +
  'o motor confere o registro, o destino e a origem antes de limpar. Não execute outro merge, não commite ' +
  'nem recrie a origem, não altere o ticket/journal e não force a remoção de arquivos. ' +
  'Pasta presa costuma ser um processo que VOCÊ iniciou (servidor de teste, comando em background): ' +
  'encerre-o pelo PID ou pela porta que você conhece e só então chame integration_run. ' +
  'Se a tentativa continuar pendente, investigue o impedimento com leituras locais e dados redigidos; ' +
  'não repita a mesma tentativa sem mudança de evidência. Preserve alterações novas. ' +
  'Peça ao dono somente uma decisão ou ação específica que exija sua participação, com o motivo e o alvo.'

/** O que o DONO lê no fio enquanto o agente solta a pasta — nunca a receita do agente
 *  (print de 2026-09-16: a receita inteira aparecia como nota). */
export const MISSION_FOLDER_HELD_NOTE =
  '↻ a pasta da missão ainda está presa — o agente foi acordado para destravar e concluir a finalização'

export const MISSION_FINALIZATION_DONE_NOTE = '⇪ finalização concluída; missão integrada e fila liberada'

export function missionFinalizationStimulus(ticket: IntegrationQueueTicketView): string {
  return [
    'FINALIZAÇÃO PENDENTE: o dono já autorizou esta integração. Você é responsável por concluir o reparo.',
    `Estado registrado: ${ticket.block?.detail ?? 'finalização interrompida'}`,
    ticket.isHead
      ? MISSION_FINALIZATION_RECIPE
      : 'Aguarde sua vez na fila; o app avisa neste chat quando você for a cabeça.',
    'A conversa de recuperação roda na raiz do projeto para liberar a pasta da missão. Use essa raiz apenas para diagnóstico; a finalização é feita por integration_run. Conte ao dono o andamento e o resultado em linguagem simples.'
  ].join('\n')
}
