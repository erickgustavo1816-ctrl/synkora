import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore, type Seat, type SeatCli } from '../store'
import { hueOf } from '../util'
import TerminalPane from './TerminalPane'

const CLI_LABEL: Record<SeatCli, string> = { claude: '✦ Claude', codex: '⌁ Codex' }

export default function SeatRail(): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const createSeat = useStore((s) => s.createSeat)
  const removeSeat = useStore((s) => s.removeSeat)
  const loadSeats = useStore((s) => s.loadSeats)

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [cli, setCli] = useState<SeatCli>('claude')
  const [loginSeat, setLoginSeat] = useState<Seat | null>(null)

  async function submit(): Promise<void> {
    if (!name.trim()) return
    await createSeat(name.trim(), cli)
    setAdding(false)
    setName('')
  }

  function closeLogin(): void {
    setLoginSeat(null)
    void loadSeats()
  }

  return (
    <section className="seat-section">
      <div className="section-label">seats · suas contas</div>
      <div className="seat-rail">
        {seats.map((seat) => (
          <div
            key={seat.id}
            className="seat-chip"
            style={{ ['--card-hue' as string]: hueOf(seat.name) }}
            title={
              seat.status === 'logado'
                ? `${seat.name} — logado`
                : `${seat.name} — clique para fazer login`
            }
            onClick={() => setLoginSeat(seat)}
          >
            <span className="seat-swatch" />
            <span className="seat-name">{seat.name}</span>
            <span className="seat-cli">{CLI_LABEL[seat.cli]}</span>
            <span className={`meta-dot ${seat.status === 'logado' ? 'run' : 'idle'}`} />
            <button
              className="seat-remove"
              title="Remover seat (o login fica preservado no disco)"
              onClick={(e) => {
                e.stopPropagation()
                void removeSeat(seat.id)
              }}
            >
              ×
            </button>
          </div>
        ))}

        {adding ? (
          <div className="seat-chip seat-form">
            <input
              autoFocus
              placeholder="Nome (ex.: Claude Pessoal)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
            <select value={cli} onChange={(e) => setCli(e.target.value as SeatCli)}>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex (ChatGPT)</option>
            </select>
            <button className="btn" disabled={!name.trim()} onClick={() => void submit()}>
              Criar
            </button>
            <button className="btn ghost" onClick={() => setAdding(false)}>
              ×
            </button>
          </div>
        ) : (
          <button className="seat-chip seat-add" onClick={() => setAdding(true)}>
            + Seat
          </button>
        )}
      </div>

      {loginSeat &&
        // Portal no body: a seção tem transform (animação), que viraria o
        // containing block do position: fixed e quebraria o overlay.
        createPortal(
          <div className="overlay" onClick={closeLogin}>
          <div className="overlay-card term-window" onClick={(e) => e.stopPropagation()}>
            <div className="term-titlebar">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              <span className="term-title">login — {loginSeat.name.toLowerCase()}</span>
            </div>
            <div className="overlay-head">
              <div className="overlay-sub">
                <span className="seat-cli">{CLI_LABEL[loginSeat.cli]}</span> · terminal isolado
                no diretório deste seat — complete o login (ex.: <code>/login</code>) e conclua.
              </div>
              <button className="term-btn" onClick={closeLogin}>
                [ concluir ]
              </button>
            </div>
            <TerminalPane
              paneId={`login-${loginSeat.id}`}
              cwd=""
              kind={loginSeat.cli}
              seatId={loginSeat.id}
            />
          </div>
          </div>,
          document.body
        )}
    </section>
  )
}
