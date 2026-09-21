import { useState } from 'react'
import { createPortal } from 'react-dom'
import CliMark from './CliMark'
import TerminalPane from './TerminalPane'
import GuiPanelErrorBoundary from './GuiPanelErrorBoundary'
import Select from './Select'
import { useStore, type Seat, type SeatCli } from '../store'
import { hueOf, initialsOf } from '../util'
import {
  TERMINAL_DEFAULT_FONT_FAMILY,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_DEFAULT_LINE_HEIGHT
} from '../terminalGeometry'

// ————————————————————————————————————————————————————————————————————————
// AS CONTAS (seats) — cadastro, login e estado. Só isso.
//
// LIMITES DE USO NÃO MORAM AQUI (decisão do usuário, 2026-07-28): já existem
// no `limites ▾` do titlebar, visível de qualquer tela. Mostrar de novo na
// Home era duplicar um readout que, além de tudo, SPAWNA PROCESSO a cada
// consulta (sessão claude efêmera com /usage; app-server do codex).
//
// Clique só faz coisa em conta sem login ou com login expirado — aí abre o
// terminal isolado do seat. Conta logada é informativa; abrir um CLI por
// clique acidental não é comportamento que se queira num card.
// ————————————————————————————————————————————————————————————————————————

const CLI_NAME: Record<SeatCli, string> = { claude: 'claude', codex: 'codex' }

interface Props {
  /** registra o card como âncora de gravidade do campo de partículas */
  anchor?: (key: string, el: HTMLElement | null) => void
  /** conta que o alerta do topo mandou logar (abre o overlay direto) */
  loginRequest?: Seat | null
  onLoginHandled?: () => void
}

export default function SeatDeck({
  anchor,
  loginRequest,
  onLoginHandled
}: Props): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const settings = useStore((s) => s.settings)
  const createSeat = useStore((s) => s.createSeat)
  const renameSeat = useStore((s) => s.renameSeat)
  const removeSeat = useStore((s) => s.removeSeat)
  const loadSeats = useStore((s) => s.loadSeats)

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [cli, setCli] = useState<SeatCli>('claude')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [login, setLogin] = useState<Seat | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)

  const openLogin = loginRequest ?? login

  // expirado primeiro: é o card que precisa de ação
  const ordered = [...seats].sort((a, b) => {
    const rank = (s: Seat): number => (s.status === 'expirado' ? 0 : s.status === 'pendente' ? 1 : 2)
    return rank(a) - rank(b)
  })

  function commitRename(): void {
    const id = renamingId
    setRenamingId(null)
    if (id && draft.trim()) void renameSeat(id, draft.trim())
  }

  async function submit(): Promise<void> {
    if (!name.trim() || creating) return
    setCreating(true)
    setCreateError(null)
    try {
      await createSeat(name.trim(), cli)
      setAdding(false)
      setName('')
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'não foi possível criar a conta')
    } finally {
      setCreating(false)
    }
  }

  async function confirmRemove(id: string): Promise<void> {
    if (removingId) return
    setRemovingId(id)
    setRemoveError(null)
    try {
      await removeSeat(id)
      setConfirmDel(null)
    } catch (error) {
      setRemoveError(error instanceof Error ? error.message : 'não foi possível remover a conta')
    } finally {
      setRemovingId(null)
    }
  }

  function closeLogin(): void {
    setLogin(null)
    onLoginHandled?.()
    void loadSeats()
  }

  const expiradas = seats.filter((s) => s.status === 'expirado').length
  const logadas = seats.filter((s) => s.status === 'logado').length

  const health =
    seats.length === 0
      ? 'nenhuma conta configurada'
      : expiradas > 0
        ? `${expiradas} ${expiradas === 1 ? 'conta requer atenção' : 'contas requerem atenção'}`
        : logadas === seats.length
          ? `${logadas} ${logadas === 1 ? 'conta pronta' : 'contas prontas'}`
          : `${logadas} de ${seats.length} prontas`

  return (
    <section className="seat-deck">
      <div className="deck-head">
        <div className="deck-heading">
          <span className="section-label plain">contas · {seats.length}</span>
          <span className="deck-caption">perfis usados para executar os agentes</span>
        </div>
        <span className={`deck-health${expiradas > 0 ? ' warn' : ''}`}>
          <i className={`meta-dot ${expiradas > 0 ? 'err' : logadas > 0 ? 'run' : 'idle'}`} />
          {health}
        </span>
        <button
          type="button"
          className="btn ghost tiny deck-add"
          disabled={adding}
          aria-expanded={adding}
          onClick={() => setAdding(true)}
        >
          <span aria-hidden="true">+</span>
          nova conta
        </button>
      </div>

      <div className="seat-grid">
        {ordered.map((seat, i) => {
          const precisaLogin = seat.status !== 'logado'
          return (
            <div
              key={seat.id}
              ref={(el) => anchor?.(`seat:${seat.id}`, el)}
              className={`seat-card ${seat.status}${precisaLogin ? ' clickable' : ''}${confirmDel === seat.id ? ' confirming' : ''}`}
              style={{
                ['--card-hue' as string]: hueOf(seat.name),
                animationDelay: `${Math.min(i * 60, 300)}ms`
              }}
              onClick={() => precisaLogin && setLogin(seat)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return
                if (precisaLogin && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  setLogin(seat)
                }
              }}
              role={precisaLogin ? 'button' : undefined}
              tabIndex={precisaLogin ? 0 : undefined}
              aria-label={precisaLogin ? `Entrar na conta ${seat.name}` : undefined}
              data-tip={
                seat.status === 'expirado'
                  ? 'O LOGIN EXPIROU — clique para refazer'
                  : seat.status === 'pendente'
                    ? 'Conta ainda sem login — clique para entrar'
                    : undefined
              }
            >
              {/* FICHA DE UMA LINHA: o app é denso e mono. Card alto com uma
                  palavra dentro ("logado") não tem a cara desta casa. */}
              <i className="sc-disc">{initialsOf(seat.name)}</i>
              {renamingId === seat.id ? (
                <input
                  className="uc-rename"
                  autoFocus
                  value={draft}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                />
              ) : (
                <span className="sc-name">{seat.name}</span>
              )}
              <span className="sc-cli">
                <CliMark cli={seat.cli} size={11} />
                {CLI_NAME[seat.cli]}
              </span>
              <span className={`sc-status ${seat.status}`}>
                <i
                  className={`meta-dot ${
                    seat.status === 'logado' ? 'run' : seat.status === 'expirado' ? 'err' : 'idle'
                  }`}
                />
                <span className="sc-state">
                  {seat.status === 'logado'
                    ? 'logado'
                    : seat.status === 'expirado'
                      ? 'expirado'
                      : 'sem login'}
                </span>
              </span>
              <span className="sc-acts" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="uc-act"
                  data-tip="Renomear conta"
                  aria-label={`Renomear conta ${seat.name}`}
                  onClick={() => {
                    setRenamingId(seat.id)
                    setDraft(seat.name)
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="uc-act danger"
                  data-tip="Remover da lista (o login fica preservado no disco)"
                  aria-label={`Remover conta ${seat.name}`}
                  onClick={() => {
                    setRemoveError(null)
                    setConfirmDel(seat.id)
                  }}
                >
                  ×
                </button>
              </span>

              {confirmDel === seat.id && (
                <div
                  className="uc-confirm"
                  role="group"
                  aria-label={`Confirmar remoção da conta ${seat.name}`}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && !removingId) setConfirmDel(null)
                  }}
                >
                  <span>
                    remover <strong>{seat.name}</strong> da lista? o login salvo fica preservado.
                  </span>
                  {removeError && <small className="uc-confirm-error">{removeError}</small>}
                  <button
                    type="button"
                    className="btn tiny danger"
                    disabled={removingId === seat.id}
                    onClick={() => void confirmRemove(seat.id)}
                  >
                    {removingId === seat.id ? 'removendo…' : 'remover'}
                  </button>
                  <button
                    type="button"
                    className="btn ghost tiny"
                    disabled={removingId === seat.id}
                    onClick={() => setConfirmDel(null)}
                  >
                    cancelar
                  </button>
                </div>
              )}
            </div>
          )
        })}

        {adding && (
          <div className="seat-card adding">
            <input
              autoFocus
              placeholder="Nome (ex.: Claude Pessoal)"
              aria-label="Nome da nova conta"
              value={name}
              disabled={creating}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
            <Select
              value={cli}
              onChange={(v) => setCli(v as SeatCli)}
              options={[
                { value: 'claude', label: 'Claude Code', cli: 'claude' },
                { value: 'codex', label: 'Codex (ChatGPT)', cli: 'codex' }
              ]}
              tip="CLI da nova conta"
            />
            <div className="sc-form-acts">
              <button
                type="button"
                className="btn"
                disabled={!name.trim() || creating}
                onClick={() => void submit()}
              >
                {creating ? 'criando…' : 'criar'}
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={creating}
                onClick={() => {
                  setAdding(false)
                  setCreateError(null)
                }}
              >
                cancelar
              </button>
            </div>
            {createError && <span className="seat-form-error">{createError}</span>}
          </div>
        )}
      </div>

      {openLogin &&
        // Portal no body: a seção anima na entrada, e um ancestral com
        // transform/contenção viraria o containing block do position:fixed.
        createPortal(
          <div className="overlay" onClick={closeLogin}>
            <div className="overlay-card term-window" onClick={(e) => e.stopPropagation()}>
              <div className="term-titlebar">
                <span className="dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="term-title">login — {openLogin.name.toLowerCase()}</span>
              </div>
              <div className="overlay-head">
                <div className="overlay-sub">
                  <span className="sc-cli">
                    <CliMark cli={openLogin.cli} size={11} />
                    {CLI_NAME[openLogin.cli]}
                  </span>{' '}
                  · terminal isolado no diretório deste seat — complete o login (ex.:{' '}
                  <code>/login</code>) e conclua.
                </div>
                <button className="term-btn" onClick={closeLogin}>
                  [ concluir ]
                </button>
              </div>
              <GuiPanelErrorBoundary
                paneId={`login-${openLogin.id}`}
                label={`o login de ${openLogin.name}`}
                onClose={closeLogin}
              >
              <TerminalPane
                paneId={`login-${openLogin.id}`}
                cwd=""
                kind={openLogin.cli}
                seatId={openLogin.id}
                fontFamily={settings?.uiFontFamily ?? TERMINAL_DEFAULT_FONT_FAMILY}
                voiceEnabled={false}
                startupMessage="preparando o ambiente de login…"
              />
              </GuiPanelErrorBoundary>
            </div>
          </div>,
          document.body
        )}
    </section>
  )
}
