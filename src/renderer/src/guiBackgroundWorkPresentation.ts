import type { GuiPaneStatus } from './store'

/**
 * Ficha viva de subagente. É estruturalmente o que `normalizeGuiSubagentSidebar`
 * devolve: o indicador do fio NUNCA conta por conta própria — ele consome a
 * mesma normalização da lateral, senão as duas superfícies podem divergir.
 */
export interface GuiBackgroundWorker {
  toolUseId: string
}

export interface GuiBackgroundWorkPresentationInput {
  status: GuiPaneStatus
  liveSubagents: readonly GuiBackgroundWorker[]
}

export interface GuiBackgroundWorkPresentation {
  count: number
  label: string
}

/**
 * Indicador exclusivamente de apresentação: enquanto houver subagente vivo, o
 * fio não pode parecer terminado. Ele nasce no primeiro despacho factual e some
 * no instante em que o último agente assenta — sem timer, sem heurística de
 * texto e sem depender do backend (Claude e Codex chegam pela mesma projeção).
 */
export function guiBackgroundWorkPresentation({
  status,
  liveSubagents
}: GuiBackgroundWorkPresentationInput): GuiBackgroundWorkPresentation | null {
  // Sessão encerrada não tem trabalho de fundo: o reducer assenta os pais
  // lançados em `closed`/`fatal`, e sobra de replay nunca pode piscar vida.
  if (status === 'dead') return null
  const count = liveSubagents.length
  if (count === 0) return null
  const noun = count === 1 ? 'subagente trabalhando' : 'subagentes trabalhando'
  return { count, label: `${count} ${noun} em segundo plano` }
}
