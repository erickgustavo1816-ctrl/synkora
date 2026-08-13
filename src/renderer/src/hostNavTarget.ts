// ALVO DE NAVEGAÇÃO DA VIEW DE PANES → HOST (Synkora 2.0, onda C).
//
// O canvas de panes vive numa WebContentsView própria (F6.11) e o board mora
// no HOST: o único caminho é o relay `panes-view:navigate`, que carrega
// `(projectId, tab)` — uma STRING opaca que o main só repassa.
//
// O mapa passou a abrir MISSÃO (clicar o card de uma missão direta leva à
// conversa dela, que mora no board), e isso não cabe num nome de aba. Em vez
// de um canal novo, o alvo viaja CODIFICADO na própria string e o host o
// decodifica aqui — as duas pontas usam este módulo, e ninguém mais precisa
// saber do formato.
//
// Módulo PURO: sem window, sem store. Emissor antigo (ou de fora) manda só
// "board" e o decodificador devolve exatamente isso.

export interface HostNavTarget {
  /** aba do universo ('board', 'panes', 'arquivos'…) */
  tab: string
  /** missão a selecionar no board; ausente = não mexe na seleção atual */
  missionId?: string
}

export function encodeHostNavTarget(tab: string, missionId?: string): string {
  return missionId ? `${tab}?mission=${encodeURIComponent(missionId)}` : tab
}

export function decodeHostNavTarget(raw: string): HostNavTarget {
  const at = raw.indexOf('?')
  if (at < 0) return { tab: raw }
  const tab = raw.slice(0, at)
  const params = new URLSearchParams(raw.slice(at + 1))
  const missionId = params.get('mission')
  return missionId ? { tab, missionId } : { tab }
}
