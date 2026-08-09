import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import CliMark from './CliMark'
import { useStore } from '../store'
import { hueOf } from '../util'
import { ModelSelect } from './ModelSelect'
import Select from './Select'

interface Props {
  projectId: string
  /** já existe seat (troca explícita) — mostra "cancelar" */
  canCancel: boolean
}

/**
 * Gate de entrada do projeto: escolha o seat do MAESTRO antes de tudo — e,
 * junto, o MODELO e o EFFORT dele (persistidos por projeto; decisão do
 * usuário). Sem default silencioso — quem orquestra o universo é decisão sua.
 */
export default function SeatGate({ projectId, canCancel }: Props): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const maestroSeatId = useStore((s) => s.maestroSeatId)
  const maestroModel = useStore((s) => s.maestroModel)
  const maestroEffort = useStore((s) => s.maestroEffort)
  const setMaestroSeat = useStore((s) => s.setMaestroSeat)
  const setSeatGateOpen = useStore((s) => s.setSeatGateOpen)
  const openProject = useStore((s) => s.openProject)
  const openSettings = useStore((s) => s.openSettings)
  const loadCatalog = useStore((s) => s.loadCatalog)

  const [selectedId, setSelectedId] = useState(maestroSeatId ?? '')
  const [model, setModel] = useState(maestroModel ?? '')
  const [effort, setEffort] = useState(maestroEffort ?? '')

  // Fase 3 (D6): overlay full-screen do host — a WebContentsView de panes
  // comporia POR CIMA e o gate ficaria clicável só em volta dela.
  const bumpHostOverlay = useStore((s) => s.bumpHostOverlay)
  useEffect(() => {
    bumpHostOverlay(1)
    return () => bumpHostOverlay(-1)
  }, [bumpHostOverlay])

  const selected = seats.find((s) => s.id === selectedId)
  const cli = selected?.cli ?? 'claude'
  const catalog = useStore((s) => s.catalogByCli[`${cli}:${selected?.id ?? ''}`])
  useEffect(() => {
    if (selected) void loadCatalog(cli, selected.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cli, selected?.id, loadCatalog])
  const effortOpts = catalog?.models.find((m) => m.id === model)?.efforts ?? catalog?.efforts ?? []

  function pick(seatId: string): void {
    setSelectedId(seatId)
    if (seatId !== maestroSeatId) {
      setModel('')
      setEffort('')
    } else {
      setModel(maestroModel ?? '')
      setEffort(maestroEffort ?? '')
    }
  }

  return createPortal(
    <div className="overlay">
      <div className="overlay-card term-window seat-gate">
        <div className="term-titlebar">
          <span className="dots mac">
            <i />
            <i />
            <i />
          </span>
          <span className="term-title">quem é o Maestro deste projeto?</span>
        </div>
        <div className="seat-gate-body">
          <p className="seat-gate-hint">
            O seat define o CLI e a conta; modelo e effort ficam salvos no projeto. Trocar depois
            é explícito (botão ⇄ seat) e o Maestro renasce na mesma conversa.
          </p>
          {seats.length === 0 && (
            <p className="seat-gate-hint">
              Nenhum seat cadastrado — adicione uma conta em Configurações primeiro.
            </p>
          )}
          {seats.map((seat) => (
            <button
              key={seat.id}
              className={`seat-gate-item${seat.id === selectedId ? ' current' : ''}`}
              onClick={() => pick(seat.id)}
            >
              <span
                className="seat-swatch"
                style={{ ['--card-hue' as string]: hueOf(seat.name) }}
              />
              <span className="seat-gate-name">{seat.name}</span>
              <span className="seat-cli">
                <CliMark cli={seat.cli} size={11} />
                {seat.cli === 'claude' ? 'claude' : 'codex'}
              </span>
              <span
                className={`meta-dot ${seat.status === 'logado' ? 'run' : 'idle'}`}
                data-tip={seat.status === 'logado' ? 'logado' : 'login pendente'}
              />
              {seat.id === maestroSeatId && <span className="seat-gate-current">atual ✓</span>}
            </button>
          ))}
          {selected && (
            <div className="seat-gate-config">
              <label>
                modelo
                <ModelSelect
                  cli={cli}
                  seatId={selected.id}
                  value={model}
                  onChange={(m) => {
                    setModel(m)
                    setEffort('')
                  }}
                />
              </label>
              <label>
                effort
                <Select
                  className="dark"
                  value={effort}
                  onChange={setEffort}
                  options={[
                    { value: '', label: 'padrão do modelo' },
                    ...effortOpts.map((ef) => ({ value: ef, label: ef }))
                  ]}
                />
              </label>
            </div>
          )}
          <div className="seat-gate-actions">
            {seats.length === 0 ? (
              <button
                className="btn ghost"
                onClick={() => {
                  setSeatGateOpen(false)
                  openSettings('accounts')
                }}
              >
                abrir Configurações
              </button>
            ) : canCancel ? (
              <button className="btn ghost" onClick={() => setSeatGateOpen(false)}>
                cancelar
              </button>
            ) : (
              <button className="btn ghost" onClick={() => openProject(null)}>
                ‹ voltar à home
              </button>
            )}
            <button
              className="btn accent"
              disabled={!selected}
              onClick={() =>
                void setMaestroSeat(projectId, selectedId, model.trim() || undefined, effort || undefined)
              }
            >
              ✓ definir maestro
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
