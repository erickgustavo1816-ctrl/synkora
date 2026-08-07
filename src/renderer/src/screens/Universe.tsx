import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import CliMark from '../components/CliMark'
import { useStore, type Seat } from '../store'
import { hueOf } from '../util'
import Board from '../components/Board'
import PanesView from '../components/PanesView'
import FilesView from '../components/FilesView'
import BacklogView from '../components/BacklogView'
import PlanMapView from '../components/PlanMapView'
import SeatGate from '../components/SeatGate'
import { ModelSelect } from '../components/ModelSelect'
import Select from '../components/Select'

interface Props {
  projectId: string
}

const NO_PANES: never[] = []

// Modal do AGENTE LIVRE (decisão do usuário): escolher MODELO e EFFORT antes
// de abrir — mesmo padrão do modal de missão (catálogo real do seat).
function FreeAgentModal({
  projectId,
  seat,
  onClose
}: {
  projectId: string
  seat: Seat
  onClose: () => void
}): React.JSX.Element {
  const addPane = useStore((s) => s.addPane)
  const setTab = useStore((s) => s.setUniverseTab)
  const loadCatalog = useStore((s) => s.loadCatalog)
  const catalog = useStore((s) => s.catalogByCli[`${seat.cli}:${seat.id}`])
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    void loadCatalog(seat.cli, seat.id)
  }, [seat.cli, seat.id, loadCatalog])
  const effortOpts = catalog?.models.find((m) => m.id === model)?.efforts ?? catalog?.efforts ?? []

  async function open(): Promise<void> {
    // agente livre nasce ARMADO (MCP + persona de base limpa nos 2 CLIs). Spec
    // nula = bridge velha ou pasta do projeto sumiu — abrir assim daria um CLI
    // CRU na branch base, sem persona e sem MCP, que é exatamente o que o agente
    // livre armado existe para impedir (ele pode commitar direto na base).
    if (!window.synkora.panes) {
      setErr('reinicie o app (npm run dev) para abrir o agente armado')
      return
    }
    const spec = await window.synkora.panes.freeSpec(projectId, seat.id, effort || undefined)
    if (!spec) {
      setErr('não foi possível armar o agente — a pasta do projeto existe? reloque na Home')
      return
    }
    onClose()
    setTab(projectId, 'panes')
    addPane(projectId, seat.cli, {
      seatId: seat.id,
      model: model || undefined,
      id: spec.paneId,
      cliArgs: spec.cliArgs.length ? spec.cliArgs : undefined,
      appendSystemPrompt: spec.appendSystemPrompt
    })
  }

  return createPortal(
    <div className="overlay">
      <div className="task-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-head">
          <span className="task-dept">✦ agente livre</span>
          <span className="task-origin">{seat.name}</span>
          <button className="pane-close dark-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="mission-exec-row">
          <label>
            modelo
            <ModelSelect
              cli={seat.cli}
              seatId={seat.id}
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
              value={effort}
              onChange={setEffort}
              options={[
                { value: '', label: 'padrão do modelo' },
                ...effortOpts.map((ef) => ({ value: ef, label: ef }))
              ]}
            />
          </label>
        </div>
        {err && <div className="mission-msg">{err}</div>}
        <div className="task-modal-actions">
          <button className="btn ghost" onClick={onClose}>
            cancelar
          </button>
          <span className="task-modal-meta" />
          <button className="btn accent" onClick={() => void open()}>
            ✦ abrir agente
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export default function Universe({ projectId }: Props): React.JSX.Element {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const seats = useStore((s) => s.seats)
  const paneCount = useStore(
    (s) => (s.panesByProject[projectId] ?? NO_PANES).length + Object.keys(s.taskRuns).length
  )

  const tab = useStore((s) => s.universeTabByProject[projectId] ?? 'board')
  const setTab = useStore((s) => s.setUniverseTab)
  // Atenção alcançável de QUALQUER aba (pedido do usuário, 2026-08-06): a aba
  // Board pulsa quando há pergunta do ask_user esperando e o usuário está em
  // outra aba; a aba Panes pulsa quando algum terminal pede permissão.
  const asking = useStore((s) =>
    Object.keys(s.askQuestions[projectId] ?? {}).length > 0
  )
  const panesNeedPerm = useStore((s) =>
    (s.panesByProject[projectId] ?? NO_PANES).some((p) => s.paneAttention[p.id])
  )
  const maestroSeatId = useStore((s) => s.maestroSeatId)
  const maestroStateLoaded = useStore((s) => s.maestroStateLoaded)
  const seatGateOpen = useStore((s) => s.seatGateOpen)
  // universos ficam montados em segundo plano — portais (gate) só no ativo
  const isActive = useStore(
    (s) => s.appPage === 'workspace' && s.openProjectId === projectId
  )
  const [menuOpen, setMenuOpen] = useState(false)
  // seat escolhido no menu → modal de modelo/effort do agente livre
  const [freeAgentSeat, setFreeAgentSeat] = useState<Seat | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const greenfieldLocked =
    project?.mode === 'greenfield' && project.planStatus !== 'done'

  useEffect(() => {
    if (!greenfieldLocked) return
    setMenuOpen(false)
    setFreeAgentSeat(null)
  }, [greenfieldLocked])

  useEffect(() => {
    if (!menuOpen) return
    function onDocClick(e: MouseEvent): void {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  if (!project) return <div className="bridge-warning">Projeto não encontrado.</div>

  return (
    <div className="workspace">
      {/* Voltar e nome do projeto moram na TitleBar (Discord-mode) — o header
          interno fica só com as abas e ações. */}
      <header className="ws-header">
        <nav className="tabs">
          <button
            className={`tab ${tab === 'board' ? 'active' : ''}${asking && tab !== 'board' ? ' tab-attn' : ''}`}
            onClick={() => setTab(projectId, 'board')}
            data-tip={asking && tab !== 'board' ? 'O Maestro/orquestrador fez uma pergunta — abra o board' : undefined}
          >
            Board {asking && tab !== 'board' && <span className="tab-attn-glyph">❓</span>}
          </button>
          {/* Mapa = plano mestre visível (só existe em projeto greenfield) */}
          {project.mode === 'greenfield' && (
            <button
              className={`tab ${tab === 'mapa' ? 'active' : ''}`}
              onClick={() => setTab(projectId, 'mapa')}
              data-tip="O plano mestre do projeto: ondas, missões e progresso"
            >
              Mapa
            </button>
          )}
          <button
            className={`tab ${tab === 'panes' ? 'active' : ''}${panesNeedPerm && tab !== 'panes' ? ' tab-attn tab-attn-perm' : ''}`}
            onClick={() => setTab(projectId, 'panes')}
            data-tip={panesNeedPerm && tab !== 'panes' ? 'Um terminal está esperando sua aprovação (Ctrl+Alt+P pula até ele)' : undefined}
          >
            Panes {paneCount > 0 && <span className="tab-badge">{paneCount}</span>}
          </button>
          <button
            className={`tab ${tab === 'backlog' ? 'active' : ''}`}
            onClick={() => setTab(projectId, 'backlog')}
          >
            Versões
          </button>
          <button
            className={`tab ${tab === 'arquivos' ? 'active' : ''}`}
            onClick={() => setTab(projectId, 'arquivos')}
          >
            Arquivos
          </button>
        </nav>

        <div className="ws-actions">
          {/* Onde este universo mora. Fica colado no botão de agente porque é a
              informação que importa na hora de abrir um: o agente nasce nesta
              pasta. É só leitura — trocar de pasta é na página ✦ geral. */}
          <span className="ws-path" data-tip={project.path}>
            <span className="ws-path-icon">▸</span>
            <span className="ws-path-text">{project.path}</span>
          </span>
          <div className="menu-anchor" ref={menuRef}>
            <button
              className="btn accent"
              disabled={greenfieldLocked}
              title={
                greenfieldLocked
                  ? 'Agentes livres ficam disponíveis depois que o plano mestre for concluído e publicado.'
                  : undefined
              }
              data-tip={
                greenfieldLocked
                  ? 'Projeto novo: siga as missões planejadas pelo Maestro. O agente livre aparece após a publicação final.'
                  : 'Abrir um agente livre neste projeto'
              }
              onClick={() => {
                if (!greenfieldLocked) setMenuOpen((v) => !v)
              }}
            >
              <span className="btn-icon">✦</span> Agente <span className="caret">▾</span>
            </button>
            {menuOpen && !greenfieldLocked && (
              <div className="menu">
                {seats.length === 0 && (
                  <div className="menu-note">
                    Nenhum seat cadastrado — adicione em Configurações › Minhas contas para
                    abrir agentes.
                  </div>
                )}
                {seats.map((seat) => (
                  <button
                    key={seat.id}
                    className="menu-item"
                    onClick={() => {
                      setMenuOpen(false)
                      setFreeAgentSeat(seat)
                    }}
                  >
                    <span
                      className="seat-swatch"
                      style={{ ['--card-hue' as string]: hueOf(seat.name) }}
                    />
                    <span className="menu-label">{seat.name}</span>
                    <span className="seat-cli">
                      <CliMark cli={seat.cli} size={12} />
                    </span>
                    <span className={`meta-dot ${seat.status === 'logado' ? 'run' : 'idle'}`} />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="workspace-stage">
        {/* Board e Panes permanecem na caixa real, sobrepostos. A aba inativa
            fica invisível e sem input, mas o FitAddon continua medindo todos
            os terminais — trocar de aba não causa boot/reflow provisório. */}
        <div
          className={`tab-content workspace-keepalive${tab === 'board' ? ' is-active' : ''}`}
          aria-hidden={tab === 'board' ? undefined : true}
          inert={tab === 'board' ? undefined : true}
        >
          <Board projectId={projectId} />
        </div>
        <div
          className={`tab-content workspace-keepalive${tab === 'panes' ? ' is-active' : ''}`}
          aria-hidden={tab === 'panes' ? undefined : true}
          inert={tab === 'panes' ? undefined : true}
        >
          <PanesView projectId={projectId} projectPath={project.path} />
        </div>
        {/* Backlog/Arquivos não rodam processo nenhum — podem montar/desmontar
            à vontade (montar só quando ativo recarrega a lista fresca). */}
        {tab === 'backlog' && (
          <div className="tab-content">
            <BacklogView projectId={projectId} />
          </div>
        )}
        {tab === 'arquivos' && (
          <div className="tab-content">
            <FilesView projectId={projectId} />
          </div>
        )}
        {tab === 'mapa' && (
          <div className="tab-content">
            <PlanMapView projectId={projectId} />
          </div>
        )}
      </div>

      {/* Gate de entrada: o seat do Maestro é escolhido ANTES de tudo —
          sem default silencioso (fluxo lógico, decisão do usuário). */}
      {isActive && ((maestroStateLoaded && !maestroSeatId) || seatGateOpen) && (
        <SeatGate projectId={projectId} canCancel={Boolean(maestroSeatId)} />
      )}

      {freeAgentSeat && !greenfieldLocked && (
        <FreeAgentModal
          projectId={projectId}
          seat={freeAgentSeat}
          onClose={() => setFreeAgentSeat(null)}
        />
      )}
    </div>
  )
}
