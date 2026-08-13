import { useEffect, useState } from 'react'
import { useStore } from '../store'
import MissionRouteBoard from './MissionRouteBoard'
import PlanMapView from './PlanMapView'

// ————————————————————————————————————————————————————————————————————————
// ABA MAPA = PLANEJAMENTO (mockup aprovado, docs/MOCKUP_WORKSPACE.md).
//
// O mockup é explícito: "A aba MAPA mostra O PLANEJAMENTO — o quadro de rotas
// […] SEM constelação, SEM física (a constelação fica dormente no código)."
//
// A CONSTELAÇÃO ficou DORMENTE de propósito: `ConstellationMap.tsx` e o motor
// de partículas `paperField.ts` continuam no repo, intactos, mas SEM nenhum
// ponto de montagem — e é a ausência de montagem que garante a exigência de
// desempenho ("o rAF dela não pode rodar"): sem componente montado não há
// ResizeObserver, não há canvas e não há frame nenhum.
//
// O plano mestre (PlanMapView) sobrevive como visão SECUNDÁRIA, e só em
// projeto greenfield (onde existe roadmap) — ele já era um toggle barato aqui.
//
// Nada nesta aba roda processo: monta/desmonta com a aba, sem custo.
// ————————————————————————————————————————————————————————————————————————

type MapMode = 'rotas' | 'plano'

export default function UniverseMapView({
  projectId
}: {
  projectId: string
}): React.JSX.Element {
  const [mode, setMode] = useState<MapMode>('rotas')
  const [hasPlan, setHasPlan] = useState(false)
  // As posições arrastadas da constelação continuam no store (nada foi
  // apagado) — mas ninguém as reidrata aqui: a aba não tem mais mapa cósmico.
  const loadPanesUi = useStore((s) => s.loadPanesUi)

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
    if (!hasPlan && mode === 'plano') setMode('rotas')
  }, [hasPlan, mode])

  return (
    <div className="universe-map">
      {hasPlan && (
        <div className="universe-map-switch" role="tablist" aria-label="Visões do planejamento">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'rotas'}
            className={`universe-map-tab${mode === 'rotas' ? ' on' : ''}`}
            data-tip="O quadro de rotas: uma linha por versão, uma coluna por etapa da missão"
            onClick={() => setMode('rotas')}
          >
            rotas
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
          <MissionRouteBoard projectId={projectId} />
        )}
      </div>
    </div>
  )
}
