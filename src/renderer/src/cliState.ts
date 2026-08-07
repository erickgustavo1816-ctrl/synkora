import type { CliStatus } from './store'

// Estado da versão do CLI em PT-BR (o valor cru é identificador, em inglês).
//
// Mora fora dos componentes porque DOIS lugares mostram o mesmo readout — o
// dropdown `clis ▾` do titlebar e o painel de ajustes da Home. Foi uma tabela
// duplicada assim que deixou a versão do SeatRail para trás quando o formato
// de `UsageMeters` mudou; a lição é não ter a segunda cópia.
export const CLI_STATE: Record<CliStatus['state'], string> = {
  unknown: 'checando…',
  updating: 'atualizando…',
  current: 'em dia',
  updated: 'atualizado agora',
  missing: 'não encontrado no PATH',
  failed: 'falhou'
}

/** Cor do ponto de estado: erro, neutro (em trânsito) ou vivo. */
export function cliDotClass(state: CliStatus['state']): string {
  if (state === 'missing' || state === 'failed') return 'err'
  if (state === 'updating' || state === 'unknown') return 'idle'
  return 'run'
}

export interface CliStatusSummary {
  label: string
  tone: 'checking' | 'updating' | 'current' | 'fresh' | 'trouble'
}

/** Resumo acessível do conjunto: erro sempre vence estados transitórios. */
export function cliStatusSummary(statuses: CliStatus[]): CliStatusSummary {
  if (statuses.some((status) => status.state === 'missing' || status.state === 'failed')) {
    return { label: 'CLIs com problema', tone: 'trouble' }
  }
  if (statuses.some((status) => status.state === 'updating')) {
    return { label: 'CLIs atualizando', tone: 'updating' }
  }
  if (statuses.length === 0 || statuses.some((status) => status.state === 'unknown')) {
    return { label: 'Verificando CLIs', tone: 'checking' }
  }
  if (statuses.some((status) => status.state === 'updated')) {
    return { label: 'CLIs atualizados', tone: 'fresh' }
  }
  return { label: 'CLIs em dia', tone: 'current' }
}
