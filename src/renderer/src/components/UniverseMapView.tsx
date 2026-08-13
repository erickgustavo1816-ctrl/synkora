import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type Pane } from '../store'
import ConstellationMap from './ConstellationMap'
import PlanMapView from './PlanMapView'
import { buildNodes, missionOfPane } from '../panesNodes'
import { missionChatSummary, type MissionChatSummary } from '../guiMissionPanes'

// ————————————————————————————————————————————————————————————————————————
// ABA MAPA — a casa da CONSTELAÇÃO (Synkora 2.0).
//
// O mapa cósmico morava dentro da aba PANES; com a demolição do deck (onda D)
// ele ficou inalcançável. Aqui ele volta como conteúdo PRIMÁRIO da aba Mapa,
// em modo SÓ-MAPA: nenhum palco, nenhum TerminalPane, nenhum PTY montado — o
// clique num card NAVEGA até onde o trabalho de fato mora (a conversa/coluna
// da missão no Board), em vez de trazer terminal para cá.
//
// O plano mestre (PlanMapView), que ocupava esta aba sozinho, continua a um
// clique de distância — mas só existe em projeto greenfield, então o seletor
// só aparece quando há plano. Constelação é sempre o padrão.
//
// MONTA/DESMONTA COM A ABA, de propósito: o mapa não roda processo nenhum, e
// desmontar é o jeito mais barato de honrar a invariante do ConstellationMap
// (o rAF decorativo e o campo de partículas SÓ rodam com a caixa visível — o
// ResizeObserver entrega 0x0 para caixa escondida e pausa tudo). As posições
// que o dono arrastou vivem no store (`mapLayoutByProject`), então remontar
// não perde arranjo nenhum.
// ————————————————————————————————————————————————————————————————————————

/** Referência estável: `?? []` inline num seletor zustand = loop de render. */
const NO_PANES: Pane[] = []

type MapMode = 'constelacao' | 'plano'

export default function UniverseMapView({
  projectId
}: {
  projectId: string
}): React.JSX.Element {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const panes = useStore((s) => s.panesByProject[projectId] ?? NO_PANES)
  const tasks = useStore((s) => s.tasks)
  const missions = useStore((s) => s.missions)
  const paneActivity = useStore((s) => s.paneActivity)
  const paneAttention = useStore((s) => s.paneAttention)
  // conversa dos panes GUI (2.0): é ela que diz se uma missão direta está
  // trabalhando — missão direta não tem pane TUI nenhum.
  const guiPanes = useStore((s) => s.guiPanes)
  const setUniverseTab = useStore((s) => s.setUniverseTab)
  const setMissionTab = useStore((s) => s.setMissionTab)
  const loadPanesUi = useStore((s) => s.loadPanesUi)

  const [mode, setMode] = useState<MapMode>('constelacao')
  const [hasPlan, setHasPlan] = useState(false)

  // AS POSIÇÕES ARRASTADAS SÃO DO DONO: `mapLayoutByProject` só é reidratado do
  // localStorage por este loader, que era chamado pelo PanesView (agora
  // dormente e fora do host). Sem esta linha o mapa renasceria com o anel de
  // fábrica a cada boot, apagando o arranjo dele — o `panesUiByProject` que vem
  // de carona não tem leitor nenhum aqui, é inerte.
  useEffect(() => {
    loadPanesUi(projectId)
  }, [projectId, loadPanesUi])

  // Plano mestre existe? Só greenfield tem. A sondagem é barata (leitura de
  // store no main) e acompanha as missões: abrir onda/integrar muda o plano.
  useEffect(() => {
    if (!window.synkora.projectPlan) return
    let alive = true
    const probe = async (): Promise<void> => {
      const plan = await window.synkora.projectPlan.get(projectId)
      if (alive) setHasPlan(Boolean(plan))
    }
    void probe()
    const off = window.synkora.missions?.onChanged?.((pid: string) => {
      if (pid === projectId) void probe()
    })
    return () => {
      alive = false
      off?.()
    }
  }, [projectId])

  // Projeto sem plano nunca fica preso numa visão que não existe.
  useEffect(() => {
    if (!hasPlan && mode === 'plano') setMode('constelacao')
  }, [hasPlan, mode])

  // Resumo destilado por missão direta. Entra nos nós por ASSINATURA: `gui:live`
  // dispara a cada delta do turno, e pendurar `nodes` no objeto cru faria a
  // geometria do mapa recalcular dezenas de vezes por segundo.
  const missionChat = useMemo(() => {
    const out: Record<string, MissionChatSummary> = {}
    for (const mission of missions) {
      if (!mission.direct || mission.projectId !== projectId) continue
      out[mission.id] = missionChatSummary(mission.id, guiPanes)
    }
    return out
  }, [missions, projectId, guiPanes])
  const missionChatSig = Object.entries(missionChat)
    .map(([id, chat]) => `${id}:${chat.pulse}:${chat.running}:${chat.attention}:${chat.live}`)
    .join('|')
  const missionChatRef = useRef(missionChat)
  missionChatRef.current = missionChat

  const nodes = useMemo(
    () =>
      buildNodes({
        panes,
        tasks,
        missions: missions.filter((m) => m.projectId === projectId),
        paneActivity,
        paneAttention,
        missionChat: missionChatRef.current
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [panes, tasks, missions, projectId, paneActivity, paneAttention, missionChatSig]
  )

  // NAVEGAÇÃO DIRETA (2.0): mapa e board moram no MESMO renderer agora — não há
  // relay pelo main (aquilo era a costura da WebContentsView de panes, que
  // continua intacta para o deck dormente).
  const openBoard = useCallback(
    (missionId: string | null): void => {
      setUniverseTab(projectId, 'board')
      setMissionTab(projectId, missionId)
    },
    [projectId, setUniverseTab, setMissionTab]
  )

  const openMission = useCallback(
    (missionId: string): void => openBoard(missionId),
    [openBoard]
  )

  // Card de nó: missão leva à aba dela; "Geral"/"Órfãos"/"Teste" levam ao
  // ✦ geral, que é onde esses terminais aparecem hoje.
  const openNode = useCallback(
    (nodeId: string): void => {
      openBoard(nodeId.startsWith('mission:') ? nodeId.slice('mission:'.length) : null)
    },
    [openBoard]
  )

  // Card-satélite (dev/gate/ajudante): o terminal dele é um slot da coluna da
  // missão no Board — levar o dono até lá é o equivalente honesto do antigo
  // "abre o palco com este pane em foco".
  const openPane = useCallback(
    (_nodeId: string, paneId: string): void => {
      const pane = panes.find((p) => p.id === paneId)
      openBoard(pane ? missionOfPane(pane, tasks, missions) : null)
    },
    [panes, tasks, missions, openBoard]
  )

  const missionsAtivas = missions.filter(
    (m) => m.projectId === projectId && (m.status === 'ativa' || m.status === 'integrando')
  ).length

  return (
    <div className="universe-map">
      {hasPlan && (
        <div className="universe-map-switch" role="tablist" aria-label="Visões do mapa">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'constelacao'}
            className={`universe-map-tab${mode === 'constelacao' ? ' on' : ''}`}
            data-tip="A constelação viva: cada missão é um card ligado ao núcleo do projeto"
            onClick={() => setMode('constelacao')}
          >
            constelação
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'plano'}
            className={`universe-map-tab${mode === 'plano' ? ' on' : ''}`}
            data-tip="O roadmap do projeto por ondas (só existe em projeto criado do zero)"
            onClick={() => setMode('plano')}
          >
            plano mestre
          </button>
        </div>
      )}

      <div className="universe-map-stage">
        {mode === 'plano' && hasPlan ? (
          <PlanMapView projectId={projectId} />
        ) : (
          <ConstellationMap
            projectId={projectId}
            projectName={project?.name ?? 'projeto'}
            projectPhoto={project?.photo}
            nodes={nodes}
            // SÓ-MAPA: não existe palco nesta aba, então nada fica ancorado nem
            // aberto — o clique navega em vez de montar terminal.
            anchored={null}
            openedPaneId={null}
            itemActivity={paneActivity}
            itemAttention={paneAttention}
            onAnchor={openNode}
            onOpenMission={openMission}
            onOpenPane={openPane}
            onOpenBoard={() => openBoard(null)}
            missionsAtivas={missionsAtivas}
            panesAtivos={panes.length}
          />
        )}
      </div>
    </div>
  )
}
