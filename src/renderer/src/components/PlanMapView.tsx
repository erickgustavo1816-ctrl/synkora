import { useCallback, useEffect, useState } from 'react'
import type { ProjectPlanView, ProjectPlanItemView } from '../../../preload/index'
import { useStore } from '../store'

// Aba MAPA — o plano mestre visível (pedido do usuário, 2026-08-04: o roadmap
// de 15 missões vivia escondido em Arquivos → PROJECT_PLAN.md). Read-only: o
// mapa muda pelo Maestro (save_project_plan) e pelas integrações; esta tela só
// mostra. Não roda processo — monta/desmonta ao trocar de aba, com refetch em
// missions:changed enquanto visível.

const PLAN_STATUS_LABEL: Record<ProjectPlanView['status'], string> = {
  draft: 'rascunho em construção',
  approved: 'aprovado — pronto para abrir a primeira onda',
  in_progress: 'em execução por ondas',
  revision_pending: 'revisão pendente de aprovação',
  awaiting_release: 'aguardando a publicação final',
  done: 'concluído — projeto publicado'
}

interface ItemState {
  glyph: string
  label: string
  cls: string
}

function itemState(item: ProjectPlanItemView, plan: ProjectPlanView): ItemState {
  if (item.status === 'done') return { glyph: '✔', label: 'concluída', cls: 'done' }
  if (item.status === 'deferred') return { glyph: '⏸', label: 'adiada', cls: 'deferred' }
  if (item.status === 'active') return { glyph: '▶', label: 'em execução', cls: 'active' }
  if (plan.readyItemIds.includes(item.id))
    return { glyph: '●', label: 'pronta para abrir', cls: 'ready' }
  return { glyph: '○', label: 'futura', cls: 'future' }
}

/** Tooltip de missão é resumo, nunca o documento: o outcome do conclude_plan é
 *  markdown longo e cobria a tela inteira (bug real 2026-08-04) — 1ª linha
 *  útil, ≤110 chars, sem prefixo de heading. O texto completo vive no card do
 *  plano e em PROJECT_PLAN.md. */
function clipTip(text: string, max = 110): string {
  const line =
    text
      .split('\n')
      .map((part) => part.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

interface WaveGroup {
  id: string
  name?: string
  items: ProjectPlanItemView[]
}

/** Agrupa preservando a ordem do roadmap (a validação do plano garante que
 *  cada onda é um bloco contínuo). */
function groupWaves(plan: ProjectPlanView): WaveGroup[] {
  const groups: WaveGroup[] = []
  for (const item of plan.roadmap) {
    const last = groups[groups.length - 1]
    if (last && last.id === item.wave.id) {
      last.items.push(item)
      if (!last.name && item.wave.name) last.name = item.wave.name
    } else {
      groups.push({ id: item.wave.id, name: item.wave.name, items: [item] })
    }
  }
  return groups
}

export default function PlanMapView({ projectId }: { projectId: string }): React.JSX.Element {
  const [plan, setPlan] = useState<ProjectPlanView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const setUniverseTab = useStore((s) => s.setUniverseTab)

  const refresh = useCallback(async () => {
    if (!window.synkora.projectPlan) return
    const fresh = await window.synkora.projectPlan.get(projectId)
    setPlan(fresh)
    setLoaded(true)
  }, [projectId])

  useEffect(() => {
    void refresh()
    // o plano muda junto com as missões (abrir onda, integrar, publicar)
    const off = window.synkora.missions?.onChanged?.((pid: string) => {
      if (pid === projectId) void refresh()
    })
    return () => off?.()
  }, [projectId, refresh])

  if (!loaded) return <div className="planmap planmap-empty">carregando o mapa…</div>
  if (!plan)
    return (
      <div className="planmap planmap-empty">
        Este projeto não tem plano mestre — o mapa existe em projetos criados do zero
        (greenfield), onde o Maestro constrói o roadmap com você.
      </div>
    )

  const total = plan.roadmap.length
  const done = plan.roadmap.filter((item) => item.status === 'done').length
  const waves = groupWaves(plan)

  return (
    <div className="planmap">
      <header className="planmap-head">
        <div className="planmap-title-row">
          <h2 className="planmap-title">✦ {plan.projectName}</h2>
          <span className={`planmap-status ${plan.status}`}>{PLAN_STATUS_LABEL[plan.status]}</span>
        </div>
        <div className="planmap-meta">
          <span className="planmap-progress">
            <span className="planmap-progress-bar">
              <span
                className="planmap-progress-fill"
                style={{ width: total ? `${Math.round((done / total) * 100)}%` : '0%' }}
              />
            </span>
            {done}/{total} missões concluídas
          </span>
          {!plan.roadmapMeta.complete && (
            <span className="planmap-warn">roadmap ainda parcial (o Maestro segue mapeando)</span>
          )}
          <button
            className="btn ghost tiny"
            data-tip="O documento completo (norte, critérios, decisões) vive em .synkora/PROJECT_PLAN.md"
            onClick={() => setUniverseTab(projectId, 'arquivos')}
          >
            ver texto completo em Arquivos
          </button>
        </div>
        {plan.vision && <p className="planmap-vision">{plan.vision}</p>}
      </header>

      <div className="planmap-waves">
        {waves.map((wave) => {
          const waveDone = wave.items.filter((item) => item.status === 'done').length
          const isCurrent = plan.currentWaveId === wave.id
          const version = wave.items.find((item) => item.version?.name)?.version?.name
          return (
            <section key={wave.id} className={`planmap-wave${isCurrent ? ' current' : ''}`}>
              <header className="planmap-wave-head">
                <span className="planmap-wave-name">
                  {wave.id}
                  {wave.name ? ` — ${wave.name}` : ''}
                </span>
                {version && <span className="planmap-chip">◈ {version}</span>}
                {isCurrent && <span className="planmap-chip current">onda atual</span>}
                <span className="planmap-wave-count">
                  {waveDone}/{wave.items.length}
                </span>
              </header>
              <ul className="planmap-items">
                {wave.items.map((item) => {
                  const state = itemState(item, plan)
                  const tipParts = [
                    clipTip(item.objective),
                    item.dependsOn.length ? `depende de: ${item.dependsOn.join(', ')}` : '',
                    item.deferredReason ? `adiada: ${clipTip(item.deferredReason)}` : '',
                    item.outcome ? `resultado: ${clipTip(item.outcome)}` : ''
                  ].filter(Boolean)
                  return (
                    <li
                      key={item.id}
                      className={`planmap-item ${state.cls}`}
                      data-tip={tipParts.join('\n')}
                    >
                      <span className="planmap-item-glyph">{state.glyph}</span>
                      <span className="planmap-item-id">{item.id}</span>
                      <span className="planmap-item-title">{item.title}</span>
                      <span className="planmap-item-state">{state.label}</span>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}
