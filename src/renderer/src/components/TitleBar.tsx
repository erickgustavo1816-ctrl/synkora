import { useEffect, useRef, useState } from 'react'
import { useStore, type CliStatus, type SeatCli } from '../store'
import { hueOf, initialsOf } from '../util'
import SynkoraMark from './SynkoraMark'
import CliMark from './CliMark'
import UsageMeters from './UsageMeters'
import { CLI_STATE, cliDotClass, cliStatusSummary } from '../cliState'
import type { SeatUsage } from '../../../preload/index'
import SynVoice from './SynVoice'
import ProgressRadarButton from './ProgressRadarButton'
import TitleBarIcon from './TitleBarIcon'

const CLI_NAME: Record<SeatCli, string> = { claude: 'claude', codex: 'codex' }

/** Nome do CLI com o logo do provedor na frente. */
function CliLabel({ cli }: { cli: SeatCli }): React.JSX.Element {
  return (
    <>
      <CliMark cli={cli} size={11} />
      {CLI_NAME[cli]}
    </>
  )
}

function focusPopoverContent(container: HTMLDivElement | null): void {
  const firstControl = container?.querySelector<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )
  const target = firstControl ?? container
  target?.focus()
}

// Titlebar custom (Discord-mode): a janela nasce sem moldura nativa
// (titleBarStyle hidden + overlay) — voltar à esquerda, nome do projeto
// centralizado e o dropdown de limites das contas antes dos controles.
export default function TitleBar(): React.JSX.Element {
  const openProjectId = useStore((s) => s.openProjectId)
  const appPage = useStore((s) => s.appPage)
  const projects = useStore((s) => s.projects)
  const seats = useStore((s) => s.seats)
  const openProject = useStore((s) => s.openProject)
  const openSettings = useStore((s) => s.openSettings)
  const closeSettings = useStore((s) => s.closeSettings)

  const clearCatalogs = useStore((s) => s.clearCatalogs)

  const [open, setOpen] = useState(false)
  const [usage, setUsage] = useState<Record<string, SeatUsage | null>>({})
  const [clis, setClis] = useState<CliStatus[]>([])
  const [diagBusy, setDiagBusy] = useState(false)
  const [diagMsg, setDiagMsg] = useState('')
  const [cliOpen, setCliOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const cliRef = useRef<HTMLDivElement>(null)
  const usageTriggerRef = useRef<HTMLButtonElement>(null)
  const cliTriggerRef = useRef<HTMLButtonElement>(null)
  const usageDialogRef = useRef<HTMLDivElement>(null)
  const cliDialogRef = useRef<HTMLDivElement>(null)

  const project = openProjectId ? projects.find((p) => p.id === openProjectId) : null
  const inSettings = appPage === 'settings'

  // Fase 3 (D6): popovers da titlebar descem sobre a área do canvas — com a
  // aba Panes ativa a WebContentsView comporia POR CIMA deles; overlay aberto
  // esconde a view.
  const bumpHostOverlay = useStore((s) => s.bumpHostOverlay)
  useEffect(() => {
    if (!open && !cliOpen) return
    bumpHostOverlay(1)
    return () => bumpHostOverlay(-1)
  }, [open, cliOpen, bumpHostOverlay])

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent): void {
      if (!anchorRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  useEffect(() => {
    if (!cliOpen) return
    function onDocClick(e: MouseEvent): void {
      if (!cliRef.current?.contains(e.target as Node)) setCliOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [cliOpen])

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => focusPopoverContent(usageDialogRef.current))
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    if (!cliOpen) return
    const frame = window.requestAnimationFrame(() => focusPopoverContent(cliDialogRef.current))
    return () => window.cancelAnimationFrame(frame)
  }, [cliOpen])

  useEffect(() => {
    if (!open && !cliOpen) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      const trigger = cliOpen ? cliTriggerRef.current : usageTriggerRef.current
      setOpen(false)
      setCliOpen(false)
      window.requestAnimationFrame(() => trigger?.focus())
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, cliOpen])

  // Versão dos CLIs: o main checa e atualiza sozinho no boot e empurra cada
  // mudança de estado. Catálogo de modelos é derrubado a cada versão nova —
  // é o binário que diz quais modelos existem.
  useEffect(() => {
    if (!window.synkora?.cli) return
    void window.synkora.cli.status().then(setClis)
    return window.synkora.cli.onStatus((all) => {
      setClis((prev) => {
        const before = prev.map((s) => s.version).join()
        if (before && before !== all.map((s) => s.version).join()) clearCatalogs()
        return all
      })
    })
  }, [clearCatalogs])

  const updating = clis.some((c) => c.state === 'updating')
  const justUpdated = clis.some((c) => c.state === 'updated')
  const cliSummary = cliStatusSummary(clis)
  const cliStatusLabel = cliSummary.label
  const cliVisualClass =
    cliSummary.tone === 'trouble' ? 'warn' : cliSummary.tone === 'fresh' ? 'fresh' : ''
  const cliDotClassName =
    cliSummary.tone === 'trouble'
      ? 'warn'
      : cliSummary.tone === 'updating'
        ? 'updating'
        : cliSummary.tone === 'fresh'
          ? 'fresh'
          : 'idle'

  function toggleUsage(): void {
    const next = !open
    setOpen(next)
    if (next) setCliOpen(false)
    if (!next) return
    // Busca a cada abertura — o main cacheia 5 min, então reabrir é barato.
    const pending: Record<string, SeatUsage | null> = {}
    for (const seat of seats) pending[seat.id] = null
    setUsage(pending)
    for (const seat of seats) {
      void window.synkora.seats.usage(seat.id).then((info) => {
        setUsage((u) => ({
          ...u,
          [seat.id]: info ?? { at: Date.now(), meters: [], lines: [] }
        }))
      })
    }
  }

  return (
    <div className="titlebar">
      <div className="titlebar-inner">
        <div className="tb-leading">
          <button
            type="button"
            className="tb-btn tb-icon-btn tb-back"
            data-tip={inSettings ? 'Voltar para onde você estava' : 'Voltar para a Home'}
            aria-label={inSettings ? 'Voltar para onde você estava' : 'Voltar para a Home'}
            disabled={!inSettings && openProjectId === null}
            onClick={() => (inSettings ? closeSettings() : openProject(null))}
          >
            <TitleBarIcon name="back" />
          </button>
          <button
            type="button"
            className={`tb-btn tb-icon-btn tb-global-settings${inSettings ? ' active' : ''}`}
            data-tip="Configurações globais do Synkora"
            aria-label="Abrir configurações globais do Synkora"
            aria-current={inSettings ? 'page' : undefined}
            onClick={() => openSettings()}
          >
            <TitleBarIcon name="settings" />
          </button>
        </div>

        <div className="tb-trailing">
          <div className="tb-action-group tb-action-group-voice">
            <SynVoice />
          </div>
          <span className="tb-action-separator" aria-hidden="true" />
          <div className="tb-action-group">
          <ProgressRadarButton />
          <div className="tb-action-anchor" ref={cliRef}>
          <button
            ref={cliTriggerRef}
            type="button"
            className={`tb-btn tb-icon-btn tb-cli-trigger ${cliOpen ? 'active' : ''} ${
              cliVisualClass
            }`}
            data-tip={`${cliStatusLabel}.\nVer versões dos CLIs que os panes executam.`}
            aria-label={`${cliStatusLabel}. Ver versões e detalhes`}
            aria-expanded={cliOpen}
            aria-controls="titlebar-cli-status"
            aria-haspopup="dialog"
            onClick={() => {
              const next = !cliOpen
              setCliOpen(next)
              if (next) setOpen(false)
              // re-consulta ao abrir: o estado empurrado pelo main pode ter
              // acontecido antes desta janela existir
              if (next) void window.synkora.cli.status().then(setClis)
            }}
          >
            <TitleBarIcon name="terminal" />
            <i className={`tb-status-dot ${cliDotClassName}`} aria-hidden="true" />
          </button>
          {cliOpen && (
            <div
              ref={cliDialogRef}
              id="titlebar-cli-status"
              className="tb-usage-menu term-window"
              role="dialog"
              tabIndex={-1}
              aria-label="Versões e estado dos CLIs"
            >
              <div className="tb-usage-seat">
                <div className="usage-line muted">
                  os panes rodam o CLI do PATH — o Synkora checa e atualiza no boot.
                </div>
              </div>
              {clis.map((c) => (
                <div key={c.cli} className="tb-usage-seat">
                  <div className="tb-usage-head">
                    <span className="tb-usage-name"><CliLabel cli={c.cli} /></span>
                    <span className="tb-usage-cli">{c.version ?? '—'}</span>
                    <span className={`meta-dot ${cliDotClass(c.state)}`} />
                  </div>
                  <div className="usage-line">
                    {c.from ? `${c.from} → ${c.version} · ` : ''}
                    {CLI_STATE[c.state]}
                  </div>
                  {c.detail && <div className="usage-line muted">{c.detail}</div>}
                </div>
              ))}
              <div className="tb-usage-seat">
                <button
                  className="btn ghost tiny"
                  disabled={updating}
                  onClick={() => {
                    void window.synkora.cli.update().then(setClis)
                  }}
                >
                  {updating ? 'atualizando…' : '⟳ checar agora'}
                </button>
                {justUpdated && (
                  <div className="usage-line muted">
                    panes já abertos seguem no binário antigo — reabra para pegar a versão nova.
                  </div>
                )}
              </div>
              <div className="tb-usage-seat">
                <button
                  className="btn ghost tiny"
                  disabled={diagBusy}
                  data-tip={'Reúne o diário da caixa-preta, o estado do board,\nversões e evidências Git num .zip para diagnóstico'}
                  onClick={() => {
                    setDiagBusy(true)
                    setDiagMsg('')
                    void window.synkora.blackbox
                      .exportDiagnostics()
                      .then((r) => setDiagMsg(r.msg))
                      .finally(() => setDiagBusy(false))
                  }}
                >
                  {diagBusy ? 'exportando…' : '◉ exportar diagnóstico'}
                </button>
                {diagMsg && <div className="usage-line muted">{diagMsg}</div>}
              </div>
            </div>
          )}
        </div>

          <div className="tb-action-anchor" ref={anchorRef}>
          <button
            ref={usageTriggerRef}
            type="button"
            className={`tb-btn tb-icon-btn tb-limits-trigger ${open ? 'active' : ''}`}
            data-tip="Limites de uso das suas contas"
            aria-label="Ver limites de uso das contas"
            aria-expanded={open}
            aria-controls="titlebar-account-limits"
            aria-haspopup="dialog"
            onClick={toggleUsage}
          >
            <TitleBarIcon name="gauge" />
          </button>
          {open && (
            <div
              ref={usageDialogRef}
              id="titlebar-account-limits"
              className="tb-usage-menu term-window"
              role="dialog"
              tabIndex={-1}
              aria-label="Limites de uso das contas"
            >
              {seats.length === 0 && (
                <div className="usage-line muted">
                  nenhum seat cadastrado — adicione em Configurações › Minhas contas.
                </div>
              )}
              {seats.map((seat, si) => {
                const info = usage[seat.id]
                return (
                  <div
                    key={seat.id}
                    className="tb-usage-seat"
                    style={{ animationDelay: `${Math.min(si * 60, 240)}ms` }}
                  >
                    <div className="tb-usage-head">
                      <span
                        className="seat-swatch"
                        style={{ ['--card-hue' as string]: hueOf(seat.name) }}
                      />
                      <span className="tb-usage-name">{seat.name}</span>
                      {info?.plan && <span className="usage-plan">{info.plan}</span>}
                      <span className="tb-usage-cli"><CliLabel cli={seat.cli} /></span>
                      <span
                        className={`meta-dot ${
                          seat.status === 'logado'
                            ? 'run'
                            : seat.status === 'expirado'
                              ? 'err'
                              : 'idle'
                        }`}
                      />
                    </div>
                    <UsageMeters info={info} />
                  </div>
                )
              })}
            </div>
          )}
          </div>
          </div>
        </div>

      <span className="tb-title" aria-label={inSettings ? 'Configurações' : project?.name ?? 'Synkora'}>
        {inSettings ? (
          <>
            <i className="tb-title-icon" aria-hidden="true">
              <TitleBarIcon name="settings" size={18} />
            </i>
            <span className="tb-title-label">Configurações</span>
          </>
        ) : project ? (
          <>
            <i
              className="tb-title-avatar"
              style={{ ['--card-hue' as string]: hueOf(project.name) }}
            >
              {project.photo ? (
                <img src={project.photo} alt="" draggable={false} />
              ) : (
                initialsOf(project.name)
              )}
            </i>
            <span className="tb-title-label">{project.name}</span>
          </>
        ) : (
          <>
            <i className="tb-title-icon tb-title-mark" aria-hidden="true">
              <SynkoraMark size={18} />
            </i>
            <span className="tb-title-label">Synkora</span>
          </>
        )}
      </span>
      </div>
    </div>
  )
}
