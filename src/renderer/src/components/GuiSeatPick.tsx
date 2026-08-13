import CliMark from './CliMark'
import type { SeatCli } from '../store'

// A CONTA DA CONVERSA (2.0 — ordem do dono: "gostaria que pudesse decidir o
// seat igual é no Claude GUI: aparece um card onde vai ficar o chat, e lá eu
// decido qual seat vou usar para aquela conversa").
//
// A missão nasce só com título; a conta é escolhida AQUI, no lugar exato onde
// a conversa vai acontecer. Nada de herdar o seat do Maestro em silêncio.
//
// Card PAPEL, ancorado: sem sombra e sem flutuar — elevação é a linguagem do
// mapa, não das telas.

export interface GuiSeatChoice {
  id: string
  name: string
  cli: SeatCli
  /** heurística de credencial do seat: 'logado' | 'expirado' | … */
  status?: string
}

export default function GuiSeatPick({
  seats,
  title,
  hint,
  busySeatId,
  error,
  onPick
}: {
  seats: GuiSeatChoice[]
  title: string
  hint: string
  /** conta clicada esperando o main — o card inteiro trava enquanto isso */
  busySeatId?: string | null
  error?: string
  onPick: (seatId: string) => void
}): React.JSX.Element {
  return (
    <div className="gui-seatpick">
      <div className="gui-seatpick-card">
        <span className="gsp-title">{title}</span>
        <span className="gsp-hint">{hint}</span>
        {error && (
          <span className="gsp-error" role="alert">
            {error}
          </span>
        )}
        <div className="gsp-list">
          {seats.length === 0 && (
            <span className="gsp-empty">
              nenhuma conta cadastrada — abra a Home e conecte um CLI primeiro
            </span>
          )}
          {seats.map((seat) => (
            <button
              key={seat.id}
              type="button"
              className={`gsp-seat${busySeatId === seat.id ? ' busy' : ''}`}
              disabled={Boolean(busySeatId)}
              onClick={() => onPick(seat.id)}
            >
              <CliMark cli={seat.cli} size={14} />
              <span className="gsp-name">{seat.name}</span>
              <span className="gsp-cli">{seat.cli}</span>
              {seat.status === 'expirado' && <span className="gsp-warn">login vencido</span>}
              <span className="gsp-go" aria-hidden="true">
                {busySeatId === seat.id ? '…' : '→'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
