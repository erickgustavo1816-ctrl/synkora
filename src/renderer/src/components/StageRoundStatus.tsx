import { useEffect, useState } from 'react'
import { formatGuiElapsed } from '../guiActivity'
import type { GuiPaneStatus } from '../store'

// O ESTADO DO TURNO na cabeça do palco (a cabeça em UMA fileira, 2026-09-08).
//
// Só NOTÍCIA vira palavra: parado não escreve nada — em repouso a fileira é
// pílulas, conta e botões. Veio do cabeçalho próprio do GuiPane, que morreu
// quando o dono mandou refazer o header ("muita informação, tudo repetido"),
// e trouxe o R11 junto: o relógio da rodada mora COLADO no estado
// ("trabalhando · 4:12" é a resposta de relance a "há quanto tempo?").
//
// A cor mora no PONTO (que pulsa só com trabalho vivo do outro lado); o texto
// fica em --ink-2, que passa o piso AA sobre papel — o acento não passa.

/** Só o que informa: parado não vira palavra na tela. */
export const STAGE_STATUS_TEXT: Record<GuiPaneStatus, string | null> = {
  starting: 'abrindo',
  working: 'trabalhando',
  'waiting-you': 'esperando você',
  idle: null,
  dead: 'encerrada'
}

export default function StageRoundStatus({
  status,
  startedAt
}: {
  status: GuiPaneStatus
  /** começo da rodada viva (o store PRESERVA esperando o dono: a espera é
   *  parte da rodada); null = relógio desarmado */
  startedAt: number | null
}): React.JSX.Element | null {
  // Tique de 1s só enquanto o relógio está armado; fora disso o intervalo nem
  // existe. O componente é pequeno de propósito: o tique re-renderiza só ele,
  // nunca o Board inteiro.
  const armed = startedAt !== null
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!armed) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [armed])

  const text = STAGE_STATUS_TEXT[status]
  if (!text) return null
  const elapsed = startedAt !== null ? formatGuiElapsed(Math.max(0, now - startedAt)) : null
  return (
    <span className={`stage-status ${status}`}>
      <i className="ss-dot" aria-hidden="true" />
      <span className="ss-text">{text}</span>
      {/* fora da árvore acessível pelo mesmo motivo do cronômetro da lateral:
          narrar o relógio a cada segundo é tortura */}
      {elapsed && (
        <span className="ss-clock" aria-hidden="true">
          {elapsed}
        </span>
      )}
    </span>
  )
}
