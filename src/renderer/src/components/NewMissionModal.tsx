import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore, type Mission, type Version } from '../store'
import { ModelSelect } from './ModelSelect'
import Select from './Select'

// Modal 🚀 NOVA MISSÃO — COMPARTILHADO entre o board (+ missão), a aba
// Versões (criar missão a partir de itens: título/goal/versão chegam
// pré-preenchidos; a versão vem travada) e a CONFIRMAÇÃO de missão criada
// pelo PM (`confirmMission`: tudo read-only, só seat/modelo/effort editáveis —
// o orquestrador só nasce depois da escolha; decisão do usuário, 02/08).
export default function NewMissionModal({
  projectId,
  initialTitle,
  initialGoal,
  initialVersionId,
  lockVersion,
  confirmMission,
  reseatMission,
  onClose,
  onCreated
}: {
  projectId: string
  initialTitle?: string
  initialGoal?: string
  initialVersionId?: string
  /** true = a versão veio do contexto (aba Versões) e não pode ser trocada */
  lockVersion?: boolean
  /** missão JÁ criada pelo PM aguardando a escolha do orquestrador */
  confirmMission?: Mission
  /** troca de CONTA do orquestrador no meio da missão (limite estourou):
   *  mesmo CLI = a conversa é transplantada para o seat novo */
  reseatMission?: Mission
  onClose: () => void
  onCreated?: (mission: Mission) => void | Promise<void>
}): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const maestroSeatId = useStore((s) => s.maestroSeatId)
  const createMission = useStore((s) => s.createMission)
  const loadCatalog = useStore((s) => s.loadCatalog)

  const lockedMission = confirmMission ?? reseatMission
  const [title, setTitle] = useState(lockedMission?.title ?? initialTitle ?? '')
  const [goal, setGoal] = useState(lockedMission?.goal ?? initialGoal ?? '')
  const [scope, setScope] = useState(lockedMission?.scope ?? '')
  const [submitError, setSubmitError] = useState('')
  const [seatId, setSeatId] = useState(reseatMission?.seatId ?? '') // '' = herdar o seat do PM
  const [model, setModel] = useState(reseatMission?.model ?? '')
  const [effort, setEffort] = useState(reseatMission?.effort ?? '')
  const [versionId, setVersionId] = useState(lockedMission?.versionId ?? initialVersionId ?? '')
  const [versions, setVersions] = useState<Version[]>([])
  const confirmOnly = Boolean(confirmMission)
  const reseatOnly = Boolean(reseatMission)
  const locked = confirmOnly || reseatOnly

  useEffect(() => {
    if (window.synkora.backlog) void window.synkora.backlog.listVersions(projectId).then(setVersions)
  }, [projectId])

  // Catálogo REAL do CLI do seat escolhido (ou herdado do PM) — alimenta o
  // seletor de modelo e a lista de efforts.
  const seatObj = seats.find((x) => x.id === (seatId || (maestroSeatId ?? '')))
  const cli = seatObj?.cli ?? 'claude'
  const catalog = useStore((s) => s.catalogByCli[`${cli}:${seatObj?.id ?? ''}`])
  useEffect(() => {
    if (seatObj) void loadCatalog(cli, seatObj.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cli, seatObj?.id, loadCatalog])
  const effortOpts = catalog?.models.find((m) => m.id === model)?.efforts ?? catalog?.efforts ?? []
  const maestroSeat = seats.find((x) => x.id === maestroSeatId)

  async function submit(): Promise<void> {
    if (reseatMission) {
      if (!seatId) {
        setSubmitError('escolha a conta nova do orquestrador')
        return
      }
      setSubmitError('')
      const res = await window.synkora.missions.setOrchestratorSeat(projectId, reseatMission.id, {
        seatId,
        model: model.trim() || undefined,
        effort: effort || undefined
      })
      if (!res.ok) {
        setSubmitError(res.msg)
        return
      }
      onClose()
      return
    }
    if (confirmMission) {
      setSubmitError('')
      const ok = await window.synkora.missions.confirmOrchestrator(projectId, confirmMission.id, {
        seatId: seatId || undefined,
        model: model.trim() || undefined,
        effort: effort || undefined
      })
      if (!ok) {
        setSubmitError('não consegui gravar a escolha do orquestrador — tente de novo')
        return
      }
      // Orquestrador decidido = a missão é o próximo lugar do usuário: pousa
      // DIRETO na aba dela (pedido do usuário, 2026-08-06 — ficava no ✦ geral
      // e exigia um clique a mais justo no momento de maior interesse).
      useStore.getState().setMissionTab(projectId, confirmMission.id)
      onClose()
      return
    }
    if (!title.trim()) return
    setSubmitError('')
    const created = await createMission(projectId, {
      title: title.trim(),
      goal: goal.trim() || undefined,
      scope: scope.trim() || undefined,
      seatId: seatId || undefined,
      model: model.trim() || undefined,
      effort: effort || undefined,
      versionId: versionId || undefined
    })
    if (!created) {
      setSubmitError(
        'Esta missão não pode ser aberta por aqui agora. Se este projeto começou vazio, volte ao Maestro: ele mostra onde o plano parou e abre a próxima missão autorizada.'
      )
      return
    }
    onClose()
    await onCreated?.(created)
  }

  return createPortal(
    // clique no backdrop NÃO fecha (decisão do usuário): perder o formulário
    // de missão por um clique fora era fácil demais — só o × ou cancelar.
    <div className="overlay">
      <div className="task-modal mission-modal" onClick={(e) => e.stopPropagation()}>
        <div className="task-modal-head">
          <span className="task-dept">
            {reseatOnly
              ? '⇄ trocar a conta do orquestrador'
              : confirmOnly
                ? '🚀 orquestrador da missão do Maestro'
                : '🚀 nova missão'}
          </span>
          {(lockVersion || locked) && versionId && (
            <span className="task-origin" data-tip="Versão herdada da aba Versões">
              ◈ {versions.find((v) => v.id === versionId)?.name ?? 'versão'}
            </span>
          )}
          <button className="pane-close dark-close" onClick={onClose}>
            ×
          </button>
        </div>
        {submitError && (
          <div className="mission-modal-error" role="alert">
            {submitError}
          </div>
        )}
        <input
          className="task-modal-title"
          autoFocus={!locked}
          readOnly={locked}
          placeholder="título (ex.: Tela de checkout)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        <textarea
          className="task-modal-desc"
          rows={3}
          readOnly={locked}
          placeholder="objetivo em 1-3 frases (vira o contexto do orquestrador)"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
        {(!locked || scope) && (
          <input
            className="mission-scope-input"
            readOnly={locked}
            placeholder="escopo: áreas/paths que a missão vai tocar (ex.: src/renderer, tela de perfil)"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
        )}
        <div className="mission-exec-row">
          <label>
            orquestrador (seat)
            <Select
              value={seatId}
              onChange={(v) => {
                setSeatId(v)
                setModel('')
                setEffort('')
              }}
              options={[
                // na troca de conta a escolha é EXPLÍCITA — herdar não faz sentido
                ...(reseatOnly
                  ? []
                  : [
                      {
                        value: '',
                        label: `herdar do maestro${maestroSeat ? ` (${maestroSeat.name})` : ''}`
                      }
                    ]),
                ...seats.map((s) => ({ value: s.id, label: s.name, cli: s.cli }))
              ]}
            />
          </label>
          <label>
            modelo
            <ModelSelect
              cli={cli}
              seatId={seatObj?.id}
              value={model}
              disabled={!seatObj}
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
          <label>
            versão do app
            <Select
              value={versionId}
              disabled={Boolean(lockVersion) || locked}
              tip={
                locked
                  ? 'Versão escolhida pelo Maestro na criação da missão'
                  : lockVersion
                    ? 'Versão herdada da aba Versões'
                    : undefined
              }
              onChange={setVersionId}
              options={[
                { value: '', label: '— nenhuma (direto na main) —' },
                ...versions
                  .filter((v) => v.status === 'aberta' || v.id === versionId)
                  .map((v) => ({ value: v.id, label: `◈ ${v.name}` }))
              ]}
            />
          </label>
        </div>
        <div className="task-modal-actions">
          <span className="task-modal-meta">
            {reseatOnly
              ? 'mesma família de CLI = a CONVERSA vai junto para a conta nova (transplante de sessão); CLI diferente = o orquestrador se reergue pelo plano e board da missão'
              : confirmOnly
                ? 'o Maestro criou esta missão — escolha conta, modelo e effort do ORQUESTRADOR; ele só abre depois desta escolha'
                : versionId
                  ? 'a missão integra na BRANCH DA VERSÃO — a main só recebe quando você subir a versão'
                  : 'a missão nasce em branch/worktree próprios (sem git? o Synkora inicializa o repo)'}
          </span>
          <button className="btn ghost" onClick={onClose}>
            {locked ? 'depois' : 'cancelar'}
          </button>
          <button
            className="btn accent"
            disabled={reseatOnly ? !seatId : !title.trim()}
            onClick={() => void submit()}
          >
            {reseatOnly ? '⇄ trocar conta' : confirmOnly ? '▶ abrir orquestrador' : 'criar missão'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
