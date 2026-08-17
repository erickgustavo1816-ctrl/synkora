import { useCallback, useMemo, useState } from 'react'
import { useStore } from '../store'
import { plansApi } from '../plansApi'
import type { PlanItemView, PlanView } from '../planContract'
import {
  PLAN_STATUS_LABEL,
  planClipLine,
  planItemLink,
  planItemMissionGoal,
  planItemPresentation,
  planProgress,
  planTierLabel,
  type PlanLinkedMission
} from '../planBoardPresentation'
import { missionChatSummary } from '../guiMissionPanes'
import NewMissionModal from './NewMissionModal'

// A ABA DE UM PLANO (D4.5) — a ÚNICA tela de plano do app desde o expurgo F6
// (2026-08-17): não existe mais uma segunda gramática competindo com esta.
//
// O que esta tela responde: "o que este plano prometeu, o que dele já virou
// missão, e o que está acontecendo com essas missões AGORA". Por isso o
// progresso nunca é campo persistido — ele nasce dos itens, e o pulso de cada
// ficha nasce da missão viva mais a conversa dela (`missionChatSummary`), a
// mesma régua do quadro de rotas.
//
// O dono é a única porta de criação de missão: o agente escreve o plano, o
// clique daqui abre o modal PRÉ-PREENCHIDO e o item se amarra à missão criada.

export default function PlanBoardView({
  projectId,
  plan,
  onChanged
}: {
  projectId: string
  plan: PlanView
  /** o plano mudou por uma ação daqui — o menu do mapa relê a lista */
  onChanged: () => void
}): React.JSX.Element {
  const missions = useStore((s) => s.missions)
  const guiPanes = useStore((s) => s.guiPanes)
  const setUniverseTab = useStore((s) => s.setUniverseTab)
  const setMissionTab = useStore((s) => s.setMissionTab)

  const [creatingFor, setCreatingFor] = useState<PlanItemView | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [pending, setPending] = useState('')
  const [message, setMessage] = useState('')

  // Índice das missões do projeto. `guiPanes` entra só pelo pulso e a leitura
  // é memoizada: `gui:live` dispara a cada delta do turno, e re-derivar a
  // lista inteira por frame seria caro à toa (lição do MissionRouteBoard).
  const missionsById = useMemo(() => {
    const map = new Map<string, PlanLinkedMission>()
    for (const mission of missions) {
      if (mission.projectId !== projectId) continue
      map.set(mission.id, {
        id: mission.id,
        title: mission.title,
        status: mission.status,
        ...(mission.pendingIntegrationApproval ? { pendingIntegrationApproval: true } : {})
      })
    }
    return map
  }, [missions, projectId])

  const items = useMemo(
    () => plan.items.slice().sort((a, b) => a.order - b.order),
    [plan.items]
  )

  const links = useMemo(() => {
    const chats = new Map<string, ReturnType<typeof missionChatSummary>>()
    const chatOf = (missionId: string): ReturnType<typeof missionChatSummary> => {
      const cached = chats.get(missionId)
      if (cached) return cached
      const summary = missionChatSummary(missionId, guiPanes)
      chats.set(missionId, summary)
      return summary
    }
    return new Map(items.map((item) => [item.id, planItemLink(item, missionsById, chatOf)]))
  }, [items, missionsById, guiPanes])

  const progress = useMemo(() => planProgress(plan.items), [plan.items])

  const openMission = useCallback(
    (missionId: string, live: boolean): void => {
      setUniverseTab(projectId, 'board')
      // Missão encerrada não tem aba própria no board: o ✦ geral é o destino
      // honesto (mesma regra do quadro de rotas).
      setMissionTab(projectId, live ? missionId : null)
    },
    [projectId, setUniverseTab, setMissionTab]
  )

  const run = useCallback(
    async (key: string, action: () => Promise<{ ok: boolean; error?: string }>): Promise<void> => {
      if (pending) return
      setPending(key)
      setMessage('')
      try {
        const result = await action()
        if (!result.ok) setMessage(result.error ?? 'não deu para concluir esta ação')
        else onChanged()
      } finally {
        setPending('')
      }
    },
    [onChanged, pending]
  )

  const concluded = plan.status === 'concluido'

  return (
    <div className="planboard">
      <header className="planboard-head">
        <div className="planboard-title-row">
          <h2 className="planboard-title">{plan.title.trim() || 'plano sem título'}</h2>
          {plan.kind === 'mestre' && <span className="planboard-chip mestre">plano mestre</span>}
          <span className={`planboard-status ${plan.status}`}>{PLAN_STATUS_LABEL[plan.status]}</span>
        </div>

        {plan.description && <p className="planboard-desc">{plan.description}</p>}

        <div className="planboard-meta">
          <span className="planboard-progress">
            <span
              className="planboard-progress-bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent}
              aria-label="Missões concluídas neste plano"
            >
              <span
                className="planboard-progress-fill"
                style={{ width: `${progress.percent}%` }}
              />
            </span>
            {progress.label}
          </span>

          <span className="planboard-actions">
            {!concluded && (
              <button
                className="btn ghost tiny"
                disabled={Boolean(pending)}
                data-tip="Marca o plano como concluído. Ele continua legível na aba; nada é apagado."
                onClick={() =>
                  void run('concluir', () =>
                    plansApi.update(plan.id, { status: 'concluido' }, plan.updatedAt)
                  )
                }
              >
                {pending === 'concluir' ? 'concluindo…' : 'concluir plano'}
              </button>
            )}
            <button
              className="btn ghost tiny"
              disabled={Boolean(pending)}
              data-tip="Tira o plano da fila de abas sem perder nada — dá para trazer de volta"
              onClick={() => void run('arquivar', () => plansApi.archive(plan.id, plan.updatedAt))}
            >
              {pending === 'arquivar' ? 'arquivando…' : 'arquivar'}
            </button>
            <button
              className="btn ghost tiny"
              disabled={Boolean(pending)}
              data-tip="Apaga o plano de vez. As missões já criadas continuam existindo."
              onClick={() => setConfirmRemove(true)}
            >
              excluir
            </button>
          </span>
        </div>

        {message && (
          <p className="planboard-message" role="alert">
            {message}
          </p>
        )}
      </header>

      {items.length === 0 ? (
        <p className="planboard-empty">
          Este plano ainda não tem missões. Peça-as na conversa de planejamento: o agente escreve,
          você aprova, e elas aparecem aqui.
        </p>
      ) : (
        <ul className="planboard-items">
          {items.map((item, index) => {
            const state = planItemPresentation(item.status)
            const link = links.get(item.id) ?? { kind: 'none' as const }
            const tier = planTierLabel(item.tier)
            const dependencies = item.dependsOn
              .map((id) => plan.items.find((entry) => entry.id === id)?.title ?? id)
              .filter(Boolean)
            const tip = [
              planClipLine(item.objective),
              dependencies.length ? `depende de: ${dependencies.join(', ')}` : '',
              item.docPath ? `brief: ${item.docPath}` : ''
            ]
              .filter(Boolean)
              .join('\n')
            return (
              <li key={item.id} className={`planboard-item ${state.cls}`}>
                <span className="pb-glyph" aria-hidden="true">
                  {state.glyph}
                </span>
                <span className="pb-order">{index + 1}</span>
                <span className="pb-main" data-tip={tip || undefined}>
                  <span className="pb-title">{item.title}</span>
                  {item.objective && (
                    <span className="pb-objective">{planClipLine(item.objective, 140)}</span>
                  )}
                </span>
                {tier && <span className="pb-tier">{tier}</span>}

                {link.kind === 'linked' ? (
                  <button
                    className={`pb-mission${link.pulse.waiting ? ' asking' : ''}`}
                    data-tip={`${link.mission.title}\nclique para abrir a missão no Board`}
                    onClick={() =>
                      openMission(
                        link.mission.id,
                        link.mission.status === 'ativa' || link.mission.status === 'integrando'
                      )
                    }
                  >
                    <span className={`pb-dot ${link.pulse.dot}`} aria-hidden="true" />
                    <span className="pb-mission-label">{link.pulse.label}</span>
                  </button>
                ) : link.kind === 'missing' ? (
                  <span className="pb-note">missão removida</span>
                ) : item.status === 'descartada' ? (
                  <span className="pb-note">{state.label}</span>
                ) : (
                  <button
                    className="btn ghost tiny pb-create"
                    disabled={Boolean(pending)}
                    data-tip="Abre a nova missão com o título e o objetivo deste item já preenchidos"
                    onClick={() => setCreatingFor(item)}
                  >
                    criar missão
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {creatingFor && (
        <NewMissionModal
          projectId={projectId}
          initialTitle={creatingFor.title}
          initialGoal={planItemMissionGoal(creatingFor)}
          onClose={() => setCreatingFor(null)}
          onCreated={async (mission) => {
            const item = creatingFor
            setCreatingFor(null)
            if (!item) return
            // Uma escrita, no mesmo gesto: a missão nasceu, o item passa a
            // apontar para ela. CAS com o `updatedAt` que esta tela mostrou.
            const result = await plansApi.linkMission(
              plan.id,
              item.id,
              mission.id,
              plan.updatedAt
            )
            if (!result.ok) setMessage(result.error)
            onChanged()
          }}
        />
      )}

      {confirmRemove && (
        <div className="overlay" onClick={() => setConfirmRemove(false)}>
          <div className="task-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="task-modal-head">
              <span className="task-dept">excluir plano</span>
              <button className="pane-close dark-close" onClick={() => setConfirmRemove(false)}>
                ×
              </button>
            </div>
            <p className="confirm-text">
              Excluir o plano <b>{plan.title.trim() || 'sem título'}</b>?
            </p>
            <p className="confirm-sub">
              A aba dele some e os {plan.items.length} item(ns) do plano se perdem — não dá para
              desfazer. As missões já criadas continuam no Board. Para guardar o plano sem apagar,
              use arquivar.
            </p>
            <div className="task-modal-actions">
              <button className="btn ghost" onClick={() => setConfirmRemove(false)}>
                cancelar
              </button>
              <span className="task-modal-meta" />
              <button
                className="btn danger-solid"
                disabled={Boolean(pending)}
                onClick={() => {
                  setConfirmRemove(false)
                  void run('excluir', () => plansApi.remove(plan.id, plan.updatedAt))
                }}
              >
                excluir plano
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
