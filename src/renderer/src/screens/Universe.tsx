import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { hueOf, initialsOf } from '../util'
import Board from '../components/Board'
import FilesView from '../components/FilesView'
import BacklogView from '../components/BacklogView'
import UniverseMapView from '../components/UniverseMapView'
import GuiPanelErrorBoundary from '../components/GuiPanelErrorBoundary'

interface Props {
  projectId: string
}

export default function Universe({ projectId }: Props): React.JSX.Element {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))

  // A aba PANES morreu na onda D (o deck de terminais saiu do caminho) e o
  // valor 'panes' deixou de existir na purga F6 (2026-08-17): a aba do
  // universo vive só em memória, então não há estado antigo em disco para
  // migrar — quem nunca escolheu cai no board.
  const tab = useStore((s) => s.universeTabByProject[projectId] ?? 'board')
  const setTab = useStore((s) => s.setUniverseTab)
  // Atenção alcançável de QUALQUER aba (pedido do usuário, 2026-08-06): a aba
  // Board pulsa quando há pergunta do ask_user esperando e o dono está em
  // outra aba.
  const asking = useStore((s) =>
    Object.keys(s.askQuestions[projectId] ?? {}).length > 0
  )
  // IDENTIDADE NA BARRA DE CIMA (onda D): nome e pasta subiram da página
  // ✦ geral para cá — é a linha que já existe em toda tela do universo.
  const renameProject = useStore((s) => s.renameProject)
  const relocateProject = useStore((s) => s.relocateProject)
  const setProjectPhoto = useStore((s) => s.setProjectPhoto)
  const [relocError, setRelocError] = useState<string | null>(null)

  // OS NÚMEROS SOBEM (mockup 2026-08-14): "Os números do projeto (◈ versão,
  // contadores de missão, fila) são CHIPS NA TOPBAR — nunca um cartão ocupando
  // o centro." O centro é da conversa; aqui fica o placar, visível de QUALQUER
  // aba do universo.
  const missions = useStore((s) => s.missions)
  const stats = useStore((s) => s.homeStats[projectId])
  const loadHomeStats = useStore((s) => s.loadHomeStats)
  useEffect(() => {
    if (!stats) void loadHomeStats(projectId)
  }, [stats, loadHomeStats, projectId])

  if (!project) return <div className="bridge-warning">Projeto não encontrado.</div>

  const mine = missions.filter((m) => m.projectId === projectId)
  const vivas = mine.filter((m) => m.status === 'ativa' || m.status === 'integrando')
  const integradas = mine.filter((m) => m.status === 'concluida').length
  // Fila = tickets de integração + o que espera o ⇪ do dono (a porteira é
  // mecânica: pedido do agente NUNCA mergeia sozinho).
  const naFila = vivas.filter(
    (m) => m.integration || m.status === 'integrando' || m.pendingIntegrationApproval
  ).length
  const esperandoVoce = vivas.some((m) => m.pendingIntegrationApproval)
  // Versão de referência: a primeira ABERTA (é nela que tudo integra); sem
  // nenhuma aberta, a última lançada entra com ✓.
  const versao = stats?.versoes.find((v) => !v.lancada) ?? stats?.versoes[0]

  return (
    <div className="workspace">
      {/* ONDA D: a identidade do universo (avatar · nome · pasta) subiu para
          esta barra — a página ✦ geral ficou só com a foto e o retrato por
          versão. Nome edita no lugar; a pasta abre o seletor do main. */}
      <header className="ws-header">
        <div className="ws-identity">
          {/* A FOTO TROCA AQUI (2026-08-15): o rodapé de identidade do ✦ geral
              morreu. Este avatar e o do titlebar são a MESMA alavanca — este
              cobre o vão, porque o `.tb-title` some abaixo de 700px. */}
          <button
            type="button"
            className="ws-avatar"
            style={{ ['--card-hue' as string]: hueOf(project.name) }}
            aria-label={`Trocar a foto do universo ${project.name}`}
            data-tip="Trocar a foto do universo"
            onClick={() => void setProjectPhoto(projectId)}
          >
            {project.photo ? (
              <img src={project.photo} alt="" draggable={false} />
            ) : (
              initialsOf(project.name)
            )}
          </button>
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
          {/* CHIPS DO PROJETO — o placar que antes ocupava o centro do board. */}
          <span className="ws-chips">
            {versao && (
              <span
                className={`ws-chip${versao.lancada ? ' quiet' : ''}`}
                data-tip={
                  versao.lancada
                    ? `Última versão lançada — ${versao.name} já está na main`
                    : `Versão em construção: toda missão desta linha integra na branch da ${versao.name}`
                }
              >
                ◈ {versao.name}
                {versao.lancada && ' ✓'}
              </span>
            )}
            <span
              className="ws-chip"
              data-tip={`${vivas.length} ${vivas.length === 1 ? 'missão viva' : 'missões vivas'} · ${integradas} já ${integradas === 1 ? 'integrada' : 'integradas'}`}
            >
              ✦ {vivas.length}
              <span className="ws-chip-sep">·</span>✓ {integradas}
            </span>
            {naFila > 0 && (
              <span
                className={`ws-chip accent${esperandoVoce ? ' pulse' : ''}`}
                data-tip={
                  esperandoVoce
                    ? 'Uma missão pediu integração — o merge SÓ anda com o SEU clique no trilho de entrega'
                    : `${naFila} ${naFila === 1 ? 'missão' : 'missões'} na fila serial de integração`
                }
              >
                fila ⇪ {naFila}
              </span>
            )}
          </span>
        </div>
        <nav className="tabs">
          <button
            className={`tab ${tab === 'board' ? 'active' : ''}${asking && tab !== 'board' ? ' tab-attn' : ''}`}
            onClick={() => setTab(projectId, 'board')}
            data-tip={asking && tab !== 'board' ? 'O Maestro/orquestrador fez uma pergunta — abra o board' : undefined}
          >
            Board {asking && tab !== 'board' && <span className="tab-attn-glyph">❓</span>}
          </button>
          {/* MAPA = PLANEJAMENTO (mockup): o quadro de rotas — uma linha por
              versão, uma coluna por etapa. A constelação ficou dormente. */}
          <button
            className={`tab ${tab === 'mapa' ? 'active' : ''}`}
            onClick={() => setTab(projectId, 'mapa')}
            data-tip="O planejamento do projeto: cada versão é uma linha, cada missão anda de backlog → rodando → fila ⇪ → integrada"
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
          <GuiPanelErrorBoundary paneId={`view:${projectId}:board`} label="o board">
            <Board projectId={projectId} />
          </GuiPanelErrorBoundary>
        </div>
        {/* Backlog/Arquivos não rodam processo nenhum — podem montar/desmontar
            à vontade (montar só quando ativo recarrega a lista fresca). */}
        {tab === 'backlog' && (
          <div className="tab-content">
            <GuiPanelErrorBoundary paneId={`view:${projectId}:backlog`} label="o backlog">
              <BacklogView projectId={projectId} />
            </GuiPanelErrorBoundary>
          </div>
        )}
        {tab === 'arquivos' && (
          <div className="tab-content">
            <GuiPanelErrorBoundary paneId={`view:${projectId}:arquivos`} label="os arquivos">
              <FilesView projectId={projectId} />
            </GuiPanelErrorBoundary>
          </div>
        )}
        {/* MAPA = a CONSTELAÇÃO (2.0): ela perdeu a casa quando o deck de panes
            saiu e voltou aqui como conteúdo primário. Monta/desmonta com a aba
            de propósito — o mapa não roda processo, e caixa desmontada é o que
            pausa o rAF decorativo e o campo de partículas. */}
        {tab === 'mapa' && (
          <div className="tab-content">
            <GuiPanelErrorBoundary paneId={`view:${projectId}:mapa`} label="o mapa">
              <UniverseMapView projectId={projectId} />
            </GuiPanelErrorBoundary>
          </div>
        )}
      </div>

      {/* SEM GATE DE ENTRADA (ordem do dono, 2026-08-15): o overlay "quem é o
          Maestro deste projeto?" barrava a porta de um universo novo para
          escolher um papel que a era 2.0 não tem mais. Entrar num projeto não
          pergunta NADA. A conta virou decisão DENTRO da missão — o card
          GuiSeatPick aparece no lugar da conversa quando o `missions:guiSpec`
          responde `needsSeat`, e é lá que ela é escolhida e trocada. */}
    </div>
  )
}
