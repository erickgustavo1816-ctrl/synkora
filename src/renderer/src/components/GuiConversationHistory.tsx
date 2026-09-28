/**
 * AS CONVERSAS DO CHAT NA TELA (2026-09-28, pedido do dono: "quero conseguir
 * ver de todas as conversas").
 *
 * Três peças pequenas, todas PAPEL (docs/MOCKUP_WORKSPACE.md — o chat nunca é
 * painel escuro):
 *
 *  · o DIVISOR no fio, onde o /new trocou a conversa: régua de largura
 *    inteira com a frase no meio — nem card, nem bolha, porque não é fala;
 *  · a LINHA DO TOPO do fio, a verdade sobre o que está fora da tela com a
 *    receita ao lado (poda do anel ou conversa anterior);
 *  · a NAVEGAÇÃO do leitor ("conversa K de N", ← anterior / próxima →).
 *
 * Nenhuma decide nada: as réguas moram em `guiHistoryReader.ts` e os gestos
 * em `useGuiConversationHistory.ts`. Todas valem também na fotografia
 * congelada (GuiPane readOnly) — ler não ressuscita nada.
 */
import { useMemo } from 'react'
import type { GuiHistoryTarget } from '../store'
import { GUI_CONVERSATION_DIVIDER_TEXT } from '../guiConversationDivider'
import {
  GUI_RECOVERED_CONVERSATION_TAG,
  guiHistoryConversationNav,
  type GuiThreadTopLine
} from '../guiHistoryReader'
import './GuiConversationHistory.css'

export function GuiConversationDivider(): React.JSX.Element {
  return (
    <div className="gui-conversation-divider" role="separator" aria-label={GUI_CONVERSATION_DIVIDER_TEXT}>
      <span className="gcd-label" aria-hidden="true">
        {GUI_CONVERSATION_DIVIDER_TEXT}
      </span>
    </div>
  )
}

/** A linha do topo veste a mesma NOTA DE MARGEM da poda (R24.1): mesma forma
 *  para o mesmo fato — há conversa acima do que a tela mostra. */
export function GuiThreadHistoryLine({
  line,
  opening,
  disabled,
  error,
  onOpen
}: {
  line: GuiThreadTopLine
  opening: boolean
  disabled: boolean
  error: string | null
  onOpen: () => void
}): React.JSX.Element {
  return (
    <div className="gui-thread-pruned-slot" data-history-line={line.kind}>
      <button
        type="button"
        className="gui-thread-pruned"
        onClick={onOpen}
        disabled={disabled}
        aria-label={`${line.truth} — ${line.action}`}
      >
        <span className="gtp-truth">{line.truth}</span>
        <span className="gtp-action">{opening ? 'abrindo…' : line.action}</span>
      </button>
      {error && (
        <p className="gui-thread-pruned-error" role="status">
          {error}
        </p>
      )}
    </div>
  )
}

/** A régua do leitor quando o chat tem mais de uma conversa. Nas pontas a
 *  seta fica desligada; a leitura avulsa da paleta (sem lista) não a ganha. */
export function GuiHistoryConversationNav({
  target,
  navigating,
  onNavigate
}: {
  target: GuiHistoryTarget
  navigating: boolean
  onNavigate: (sessionId: string) => void
}): React.JSX.Element | null {
  const nav = useMemo(
    () => guiHistoryConversationNav(target.conversations, target.sessionId),
    [target.conversations, target.sessionId]
  )
  if (!nav) return null
  const previous = nav.previousSessionId
  const next = nav.nextSessionId
  return (
    <nav className="gui-history-nav" aria-label="Conversas deste chat" aria-busy={navigating}>
      <button
        type="button"
        className="ghn-step"
        disabled={!previous || navigating}
        onClick={() => previous && onNavigate(previous)}
        aria-label="Abrir a conversa anterior deste chat"
      >
        ← anterior
      </button>
      <span className="ghn-where">
        <b>{nav.label}</b>
        {nav.recovered && <span className="ghn-tag">{GUI_RECOVERED_CONVERSATION_TAG}</span>}
        {(navigating || nav.when) && <small>{navigating ? 'abrindo…' : nav.when}</small>}
      </span>
      <button
        type="button"
        className="ghn-step"
        disabled={!next || navigating}
        onClick={() => next && onNavigate(next)}
        aria-label="Abrir a próxima conversa deste chat"
      >
        próxima →
      </button>
    </nav>
  )
}
