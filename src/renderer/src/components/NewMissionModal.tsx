import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore, type Mission, type MissionType, type Version } from '../store'
import { ModelSelect } from './ModelSelect'
import Select from './Select'

// Modal 🚀 NOVA MISSÃO — COMPARTILHADO entre o board (+ missão), a aba
// Versões (criar missão a partir de itens: título/goal/versão chegam
// pré-preenchidos; a versão vem travada) e a CONFIRMAÇÃO de missão criada
// pelo PM (`confirmMission`: tudo read-only, só seat/modelo/effort editáveis —
// o orquestrador só nasce depois da escolha; decisão do usuário, 02/08).
// CRIAÇÃO 2.0 (ordem do dono, 2026-08-13): criar missão pergunta SÓ o TÍTULO
// (+ a natureza missão/planejamento). Conta, modelo, effort e permissões se
// decidem DENTRO da missão, na primeira conversa — nada de "herdar do
// maestro". Goal/versão vindos por props (prefill do Board / aba Versões) são
// contexto que o dono já escolheu: viajam no payload SEM renderizar campo.
// Os modos travados (confirmMission/reseatMission — pipeline legado) mantêm
// os selects de seat/modelo/effort exatamente como sempre.
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
  // NATUREZA da missão (2.0): o planejamento deixou de aparecer sozinho no
  // ✦ geral e virou algo que o DONO cria, aqui, como qualquer missão. A
  // escolha vale só no NASCIMENTO — missão nenhuma troca de natureza depois,
  // por isso ela não existe nos modos travados (confirmar/trocar conta) nem
  // quando a missão nasce PRESA a uma versão (aba Versões): ali o contexto já
  // disse que é entrega de produto, e planejamento não pertence a versão.
  const [missionType, setMissionType] = useState<MissionType>('dev')
  const confirmOnly = Boolean(confirmMission)
  const reseatOnly = Boolean(reseatMission)
  const locked = confirmOnly || reseatOnly
  const typeChoosable = !locked && !lockVersion
  const planning = typeChoosable && missionType === 'planejamento'

  useEffect(() => {
    if (window.synkora.backlog) void window.synkora.backlog.listVersions(projectId).then(setVersions)
  }, [projectId])

  // Catálogo REAL do CLI do seat escolhido (ou herdado do PM) — alimenta o
  // seletor de modelo e a lista de efforts. SÓ nos modos travados: a criação
  // não tem mais selects, e o catálogo custa spawn de CLI.
  const seatObj = seats.find((x) => x.id === (seatId || (maestroSeatId ?? '')))
  const cli = seatObj?.cli ?? 'claude'
  const catalog = useStore((s) => s.catalogByCli[`${cli}:${seatObj?.id ?? ''}`])
  useEffect(() => {
    if (locked && seatObj) void loadCatalog(cli, seatObj.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked, cli, seatObj?.id, loadCatalog])
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
    // Criação enxuta: título + natureza, e só. Sem seat/model/effort — a
    // escolha mora dentro da missão (card de seat + composer do chat). A
    // missão de dev sem versionId cai na versão corrente pelo main
    // (ensureDefaultVersion).
    const created = await createMission(projectId, {
      title: title.trim(),
      // goal só existe aqui quando veio por props (prefill) — campo não
      // renderiza na criação.
      goal: goal.trim() || undefined,
      // Missão de planejamento não pertence a versão nenhuma: ela ESCREVE o
      // recorte da próxima versão em plano/, não entrega dentro de uma. Fora
      // isso, versionId só viaja quando veio travado da aba Versões.
      versionId: planning ? undefined : versionId || undefined,
      // MISSÃO 2.0 (onda B): TODA missão criada pelo usuário nasce DIRETA —
      // sem orquestrador e sem plano; abrir a aba abre o chat no worktree.
      // Missão legada (sem o campo) continua no fluxo antigo, intocada.
      direct: true,
      // NATUREZA (2.0): decidida aqui e só aqui. O main carimba 'planejamento'
      // e roteia o chat para a raiz do projeto (missions:guiSpec). Deriva de
      // `planning`, nunca do estado cru: sem escolha na tela, é 'dev'.
      missionType: planning ? 'planejamento' : 'dev'
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
                : planning
                  ? '✎ novo planejamento'
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
        {/* NATUREZA da missão — duas, decididas no nascimento. Fica no TOPO
            porque é ela que governa o resto do formulário (planejamento não
            tem versão nem escopo de paths). */}
        {typeChoosable && (
          <div className="mission-type-choice" role="radiogroup" aria-label="Tipo da missão">
            <button
              type="button"
              role="radio"
              aria-checked={!planning}
              className={`mtc-opt${planning ? '' : ' active'}`}
              data-tip="Trabalho de produto: branch e worktree próprios, o agente trabalha isolado e o ⇪ leva para a fila de integração"
              onClick={() => setMissionType('dev')}
            >
              🚀 missão
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={planning}
              className={`mtc-opt${planning ? ' active' : ''}`}
              data-tip="Uma conversa que entrevista você e escreve o roadmap em plano/ — quem cria as missões continua sendo você"
              onClick={() => setMissionType('planejamento')}
            >
              ✎ planejamento
            </button>
          </div>
        )}
        {planning && (
          <span className="mission-type-hint">
            roda na raiz do projeto e escreve o plano/ — não entra na fila
          </span>
        )}
        <input
          className="task-modal-title"
          autoFocus={!locked}
          readOnly={locked}
          placeholder={
            planning ? 'título (ex.: Plano da V1.1)' : 'título (ex.: Tela de checkout)'
          }
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        {/* Goal/escopo/executor SÓ nos modos travados (pipeline legado): a
            criação 2.0 pergunta apenas o título — o resto se decide dentro
            da missão, na primeira conversa. */}
        {locked && (
          <textarea
            className="task-modal-desc"
            rows={3}
            readOnly
            placeholder="objetivo em 1-3 frases (vira o contexto do agente)"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
        )}
        {locked && Boolean(scope) && (
          <input
            className="mission-scope-input"
            readOnly
            placeholder="escopo: áreas/paths que a missão vai tocar (ex.: src/renderer, tela de perfil)"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
        )}
        {locked && (
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
                disabled
                tip="Versão escolhida pelo Maestro na criação da missão"
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
        )}
        <div className="task-modal-actions">
          <span className="task-modal-meta">
            {reseatOnly
              ? 'mesma família de CLI = a CONVERSA vai junto para a conta nova (transplante de sessão); CLI diferente = o orquestrador se reergue pelo plano e board da missão'
              : confirmOnly
                ? 'o Maestro criou esta missão — escolha conta, modelo e effort do ORQUESTRADOR; ele só abre depois desta escolha'
                : planning
                  ? 'a conversa abre na RAIZ do projeto e entrega escrevendo plano/ — sem branch, sem worktree e fora da fila de integração'
                  : versionId
                    ? 'a missão nasce em branch/worktree próprios e integra na BRANCH DA VERSÃO — conta, modelo e permissões você escolhe dentro da missão, na primeira conversa'
                    : 'a missão nasce em branch/worktree próprios — conta, modelo e permissões você escolhe dentro da missão, na primeira conversa'}
          </span>
          <button className="btn ghost" onClick={onClose}>
            {locked ? 'depois' : 'cancelar'}
          </button>
          <button
            className="btn accent"
            disabled={reseatOnly ? !seatId : !title.trim()}
            onClick={() => void submit()}
          >
            {reseatOnly
              ? '⇄ trocar conta'
              : confirmOnly
                ? '▶ abrir orquestrador'
                : planning
                  ? 'criar planejamento'
                  : 'criar missão'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
