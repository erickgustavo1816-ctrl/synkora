import { useState } from 'react'
import { useStore } from '../store'
import { hueOf, initialsOf } from '../util'
import Board from '../components/Board'
import FilesView from '../components/FilesView'
import BacklogView from '../components/BacklogView'
import UniverseMapView from '../components/UniverseMapView'
import SeatGate from '../components/SeatGate'

interface Props {
  projectId: string
}

export default function Universe({ projectId }: Props): React.JSX.Element {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))

  // ONDA D: a aba PANES morreu (o deck de terminais saiu do caminho). Valor
  // antigo/legado cai no board em vez de deixar a área central em branco.
  const rawTab = useStore((s) => s.universeTabByProject[projectId] ?? 'board')
  const tab = rawTab === 'panes' ? 'board' : rawTab
  const setTab = useStore((s) => s.setUniverseTab)
  // Atenção alcançável de QUALQUER aba (pedido do usuário, 2026-08-06): a aba
  // Board pulsa quando há pergunta do ask_user esperando e o dono está em
  // outra aba.
  const asking = useStore((s) =>
    Object.keys(s.askQuestions[projectId] ?? {}).length > 0
  )
  const maestroSeatId = useStore((s) => s.maestroSeatId)
  const maestroStateLoaded = useStore((s) => s.maestroStateLoaded)
  const seatGateOpen = useStore((s) => s.seatGateOpen)
  // universos ficam montados em segundo plano — portais (gate) só no ativo
  const isActive = useStore(
    (s) => s.appPage === 'workspace' && s.openProjectId === projectId
  )
  // IDENTIDADE NA BARRA DE CIMA (onda D): nome e pasta subiram da página
  // ✦ geral para cá — é a linha que já existe em toda tela do universo.
  const renameProject = useStore((s) => s.renameProject)
  const relocateProject = useStore((s) => s.relocateProject)
  const [relocError, setRelocError] = useState<string | null>(null)

  if (!project) return <div className="bridge-warning">Projeto não encontrado.</div>

  return (
    <div className="workspace">
      {/* ONDA D: a identidade do universo (avatar · nome · pasta) subiu para
          esta barra — a página ✦ geral ficou só com a foto e o retrato por
          versão. Nome edita no lugar; a pasta abre o seletor do main. */}
      <header className="ws-header">
        <div className="ws-identity">
          <span
            className="ws-avatar"
            style={{ ['--card-hue' as string]: hueOf(project.name) }}
            aria-hidden="true"
          >
            {project.photo ? (
              <img src={project.photo} alt="" draggable={false} />
            ) : (
              initialsOf(project.name)
            )}
          </span>
          <input
            key={project.name}
            className="ws-name"
            defaultValue={project.name}
            data-tip="Nome do universo — Enter ou clique fora para salvar"
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v && v !== project.name) void renameProject(projectId, v)
            }}
          />
        </div>
        <nav className="tabs">
          <button
            className={`tab ${tab === 'board' ? 'active' : ''}${asking && tab !== 'board' ? ' tab-attn' : ''}`}
            onClick={() => setTab(projectId, 'board')}
            data-tip={asking && tab !== 'board' ? 'O Maestro/orquestrador fez uma pergunta — abra o board' : undefined}
          >
            Board {asking && tab !== 'board' && <span className="tab-attn-glyph">❓</span>}
          </button>
          {/* ONDA D: o mapa vale para TODO universo — ele lê as missões
              (inclusive as diretas), não só o roadmap de um greenfield. */}
          <button
            className={`tab ${tab === 'mapa' ? 'active' : ''}`}
            onClick={() => setTab(projectId, 'mapa')}
            data-tip="A constelação do projeto: cada missão viva é um card ligado ao núcleo (em projeto criado do zero, o plano mestre fica ao lado)"
          >
            Mapa
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
          {/* Onde este universo mora — e o botão que corrige quando a pasta
              foi renomeada/movida por fora do app. */}
          <span className="ws-path" data-tip={project.path}>
            <span className="ws-path-icon">▸</span>
            <span className="ws-path-text">{project.path}</span>
          </span>
          <button
            className="btn ghost tiny"
            data-tip="Alterar a pasta deste universo (renomeou/moveu fora do app?)"
            onClick={() => {
              setRelocError(null)
              void relocateProject(projectId).then(setRelocError)
            }}
          >
            📁 pasta
          </button>
        </div>
      </header>

      {relocError && <div className="ws-reloc-error">✗ {relocError}</div>}

      <div className="workspace-stage">
        {/* O Board permanece na caixa real mesmo fora da aba: ele hospeda as
            conversas e os terminais das missões (onda D) — desmontar mataria
            sessão viva. Aba inativa fica invisível e sem input. */}
        <div
          className={`tab-content workspace-keepalive${tab === 'board' ? ' is-active' : ''}`}
          aria-hidden={tab === 'board' ? undefined : true}
          inert={tab === 'board' ? undefined : true}
        >
          <Board projectId={projectId} />
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
        {/* MAPA = a CONSTELAÇÃO (2.0): ela perdeu a casa quando o deck de panes
            saiu e voltou aqui como conteúdo primário. Monta/desmonta com a aba
            de propósito — o mapa não roda processo, e caixa desmontada é o que
            pausa o rAF decorativo e o campo de partículas. O plano mestre fica
            no seletor interno, só em projeto greenfield. */}
        {tab === 'mapa' && (
          <div className="tab-content">
            <UniverseMapView projectId={projectId} />
          </div>
        )}
      </div>

      {/* Gate de entrada: o seat do Maestro é escolhido ANTES de tudo —
          sem default silencioso (fluxo lógico, decisão do usuário). */}
      {isActive && ((maestroStateLoaded && !maestroSeatId) || seatGateOpen) && (
        <SeatGate projectId={projectId} canCancel={Boolean(maestroSeatId)} />
      )}
    </div>
  )
}
