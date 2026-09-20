import { useEffect, useLayoutEffect, useState } from 'react'
import type { GuiItem } from '../store'
import { formatGuiElapsed } from '../guiActivity'
import { guiAgentPulsePresentation, type GuiPulseAction, type GuiPulseClock } from '../guiAgentPulse'
import { guiThinkingPresentation, type GuiThinkingPresentationInput } from '../guiThinkingPresentation'
import './GuiAgentPulse.css'

/** Quantos traços cada gesto desenha (o resto é um glifo só). */
const GLYPH_PARTS: Partial<Record<GuiPulseAction, number>> = {
  thinking: 3,
  reading: 3,
  editing: 3,
  compacting: 2
}

/** "há 12 s" enquanto vivo; "sem sinal há 1:04" no silêncio. */
export function guiPulseClockText(clock: GuiPulseClock): string {
  return clock.kind === 'since'
    ? `há ${Math.floor(clock.ms / 1_000)} s`
    : `sem sinal há ${formatGuiElapsed(clock.ms)}`
}

/** A receita do alarme, com o ■ como tecla. */
function hintNodes(hint: string): React.ReactNode[] {
  return hint.split('■').flatMap((part, index) => (index === 0 ? [part] : [<kbd key={index}>■</kbd>, part]))
}

/**
 * O PULSO DO AGENTE — o rabo do fio enquanto o turno do pai está vivo. Não
 * entra no transcript: é apresentação pura sobre o estado canônico do pane
 * (`guiThinkingPresentation` dá a fase; `guiAgentPulse` veste gesto, verbo,
 * rastro e relógio). O tique de 1 s só existe com o turno trabalhando, e
 * re-renderiza só esta linha.
 */
export default function GuiAgentPulse({
  active,
  items,
  publicSilenceSince,
  onResize,
  ...phaseInput
}: GuiThinkingPresentationInput & {
  active: boolean
  items: readonly GuiItem[]
  publicSilenceSince?: number | null
  onResize(): void
}): React.JSX.Element | null {
  const ticking = active && phaseInput.status === 'working'
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!ticking) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [ticking])
  const pulse = active
    ? guiAgentPulsePresentation({
        phase: guiThinkingPresentation(phaseInput)?.phase ?? null,
        items,
        publicSilenceSince,
        now
      })
    : null
  // Linha que nasce, cresce (receita) ou some move o fim do fio: quem está
  // colado no fim continua colado.
  useLayoutEffect(() => {
    onResize()
  }, [pulse?.action, pulse?.tier, pulse?.hint, pulse?.trail, pulse?.target, onResize])
  if (!pulse) return null
  const parts = GLYPH_PARTS[pulse.action] ?? 1
  return (
    <div
      className={`gui-pulse${pulse.tier === 'live' ? '' : ` ${pulse.tier}`}`}
      role="status"
      aria-label="Andamento do agente"
      data-action={pulse.action}
    >
      <div className="gui-pulse-line">
        <span className="gui-pulse-glyph" data-action={pulse.action} aria-hidden="true">
          {Array.from({ length: parts }, (_, index) => (
            <i key={index} />
          ))}
        </span>
        <span className="gui-pulse-verb">{pulse.verb}</span>
        {pulse.target && (
          <>
            <span className="gui-pulse-sep" aria-hidden="true">
              ·
            </span>
            <span className="gui-pulse-target">{pulse.target}</span>
          </>
        )}
        {pulse.trail && <span className="gui-pulse-trail">{pulse.trail}</span>}
        {/* fora da árvore acessível pelo mesmo motivo do relógio da cabeça:
            narrar um contador a cada segundo é tortura */}
        {pulse.clock && (
          <span className="gui-pulse-clock" aria-hidden="true">
            {guiPulseClockText(pulse.clock)}
          </span>
        )}
      </div>
      {pulse.hint && <div className="gui-pulse-hint">{hintNodes(pulse.hint)}</div>}
    </div>
  )
}
