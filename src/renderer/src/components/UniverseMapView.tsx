import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { plansApi } from '../plansApi'
import type { PlanView } from '../planContract'
import { mapTabs, resolveMapTab } from '../planBoardPresentation'
import MissionRouteBoard from './MissionRouteBoard'
import PlanBoardView from './PlanBoardView'

// ————————————————————————————————————————————————————————————————————————
// ABA MAPA = MENU DE PLANEJAMENTO (D4.5 do desenho de 2026-08-15).
//
// A fila de abas é DERIVADA: `rotas` (sempre, e primeira) + UMA ABA POR PLANO
// vivo — que é como o dono descreveu o menu ("plano 1, plano 2, plano 3 de um
// app existente").
//
// EXPURGO F6 (2026-08-17): a segunda tela de plano — o roadmap por ondas da
// era anterior — morreu inteira. Ela abria sozinha em todo universo novo,
// mostrando zero, com outro visual. Agora existe UMA gramática de plano no
// app, e é a do PlanBoardView. A CONSTELAÇÃO segue dormente.
//
// Nada nesta aba roda processo: monta/desmonta com a aba, sem custo. Os planos
// se releem em `plans:changed` (o agente edita pela tool) e em
// `missions:changed` (o progresso de cada item VEM da missão vinculada).
// ————————————————————————————————————————————————————————————————————————

export default function UniverseMapView({
  projectId
}: {
  projectId: string
}): React.JSX.Element {
  const [plans, setPlans] = useState<PlanView[]>([])
  const [plansLoaded, setPlansLoaded] = useState(false)
  const activeTabId = useStore((s) => s.mapTabByProject[projectId])
  const setMapTab = useStore((s) => s.setMapTab)

  const refreshPlans = useCallback(async (): Promise<void> => {
    const list = await plansApi.list(projectId)
    setPlans(list)
    setPlansLoaded(true)
  }, [projectId])

  useEffect(() => {
    void refreshPlans()
    const offPlans = plansApi.onChanged((pid: string) => {
      if (pid === projectId) void refreshPlans()
    })
    // Item de plano vira missão: o progresso do plano é derivado dela, então a
    // mesma mudança que move o quadro de rotas move a aba do plano.
    const offMissions = window.synkora.missions?.onChanged?.((pid: string) => {
      if (pid === projectId) void refreshPlans()
    })
    return () => {
      offPlans()
      offMissions?.()
    }
  }, [projectId, refreshPlans])

  const tabs = useMemo(() => mapTabs({ plans }), [plans])
  // Aba lembrada que sumiu (plano excluído, ou a aba do roadmap F6 que deixou
  // de existir) nunca prende a tela numa visão vazia: cai em `rotas`.
  const active = useMemo(() => resolveMapTab(tabs, activeTabId), [tabs, activeTabId])
  const activePlan = active.planId ? plans.find((plan) => plan.id === active.planId) : undefined

  return (
    <div className="universe-map">
      {tabs.length > 1 && (
        <div className="universe-map-switch" role="tablist" aria-label="Visões do planejamento">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === active.id}
              className={`universe-map-tab${tab.id === active.id ? ' on' : ''}${
                tab.kind === 'plano' ? ' plano' : ''
              }`}
              data-tip={tab.tip}
              onClick={() => setMapTab(projectId, tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      <div className="universe-map-stage">
        {active.kind === 'plano' && activePlan ? (
          <PlanBoardView
            projectId={projectId}
            plan={activePlan}
            onChanged={() => void refreshPlans()}
          />
        ) : (
          <MissionRouteBoard projectId={projectId} />
        )}
      </div>

      {/* A ponte pode não existir (preview de browser, ou app em atualização):
          dizer isso vale mais que uma fila de abas silenciosamente curta. */}
      {plansLoaded && !plansApi.available() && (
        <span className="universe-map-note">
          os planos não estão disponíveis nesta janela — reabra o Synkora para vê-los
        </span>
      )}
    </div>
  )
}
