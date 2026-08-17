import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore, type Mission, type MissionType, type Version } from '../store'
import { ModelSelect } from './ModelSelect'
import Select from './Select'

type MissionVersionChoices = {
  versions: Version[]
  defaultVersionId?: string
}

// Modal 🚀 NOVA MISSÃO — COMPARTILHADO entre o board (+ missão), a aba
// Versões (criar missão a partir de itens: título/goal/versão chegam
// pré-preenchidos; a versão vem travada).
// CRIAÇÃO 2.0 (ordem do dono, 2026-08-13): criar missão pergunta SÓ o TÍTULO
// (+ a natureza missão/planejamento). Conta, modelo, effort e permissões se
// decidem DENTRO da missão, na primeira conversa — nada de "herdar do
// conversa anterior. Goal/versão vindos por props (prefill do Board / aba
// Versões) são contexto que o dono já escolheu: viajam no payload SEM
// renderizar campo. Os dois MODOS TRAVADOS — confirmação do orquestrador e
// troca de conta dele — saíram na purga F6 (2026-08-17) com o papel que
// descreviam.
export default function NewMissionModal({
  projectId,
  initialTitle,
  initialGoal,
  initialVersionId,
  lockVersion,
  onClose,
  onCreated
}: {
  projectId: string
  initialTitle?: string
  initialGoal?: string
  initialVersionId?: string
  /** true = a versão veio do contexto (aba Versões) e não pode ser trocada */
  lockVersion?: boolean
  onClose: () => void
  onCreated?: (mission: Mission) => void | Promise<void>
}): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const createMission = useStore((s) => s.createMission)
  const loadCatalog = useStore((s) => s.loadCatalog)

  const [title, setTitle] = useState(initialTitle ?? '')
  const [goal] = useState(initialGoal ?? '')
  const [submitError, setSubmitError] = useState('')
  const [versionId, setVersionId] = useState(initialVersionId ?? '')
  const [versions, setVersions] = useState<Version[]>([])
  const [versionChoices, setVersionChoices] = useState<MissionVersionChoices | null>(null)
  const [versionChoicesLoading, setVersionChoicesLoading] = useState(true)
  const [versionChoicesError, setVersionChoicesError] = useState('')
  // NATUREZA da missão (2.0): o planejamento deixou de aparecer sozinho no
  // ✦ geral e virou algo que o DONO cria, aqui, como qualquer missão. A
  // escolha vale só no NASCIMENTO — missão nenhuma troca de natureza depois,
  // por isso ela não existe nos modos travados (confirmar/trocar conta) nem
  // quando a missão nasce PRESA a uma versão (aba Versões): ali o contexto já
  // disse que é entrega de produto, e planejamento não pertence a versão.
  const [missionType, setMissionType] = useState<MissionType>('dev')
  const typeChoosable = !lockVersion
  const planning = typeChoosable && missionType === 'planejamento'
  const eligibleVersions = versionChoices?.versions ?? []
  const defaultVersion = eligibleVersions.find(
    (version) => version.id === versionChoices?.defaultVersionId
  )
  const versionLookupBlocksCreation =
    !lockVersion && !planning && (versionChoicesLoading || Boolean(versionChoicesError))
  const versionSelectorDisabled =
    planning || versionChoicesLoading || Boolean(versionChoicesError) || eligibleVersions.length === 0
  const versionSelectOptions = planning
    ? [{ value: '', label: '— planejamento n\u00e3o entra em vers\u00e3o —' }]
    : versionChoicesLoading
      ? [{ value: versionId, label: 'carregando vers\u00f5es eleg\u00edveis...' }]
      : versionChoicesError
        ? [{ value: versionId, label: 'vers\u00f5es indispon\u00edveis' }]
        : eligibleVersions.length === 0
          ? [{ value: '', label: 'nenhuma aberta — a pr\u00f3xima ser\u00e1 criada' }]
          : eligibleVersions.map((version) => ({
              value: version.id,
              label: `◈ ${version.name}${version.id === versionChoices?.defaultVersionId ? ' — padr\u00e3o' : ''}`,
              hint: version.theme
            }))
  const versionSelectNote = planning
    ? 'planejamento escreve plano/ e fica fora de vers\u00e3o'
    : versionChoicesLoading
      ? 'consultando os destinos que aceitam novas miss\u00f5es'
      : versionChoicesError
        ? versionChoicesError
        : eligibleVersions.length === 0
          ? 'ao criar, o Synkora abrir\u00e1 a pr\u00f3xima vers\u00e3o automaticamente'
          : defaultVersion
            ? `${defaultVersion.name} \u00e9 o destino corrente por padr\u00e3o`
            : ''

  useEffect(() => {
    if (window.synkora.backlog) void window.synkora.backlog.listVersions(projectId).then(setVersions)
  }, [projectId])

  useEffect(() => {
    let current = true
    setVersionChoicesLoading(true)
    setVersionChoicesError('')
    const readChoices = window.synkora.missions?.versionChoices
    if (!readChoices) {
      setVersionChoices(null)
      setVersionChoicesLoading(false)
      setVersionChoicesError('reinicie o Synkora para carregar as vers\u00f5es eleg\u00edveis')
      return () => {
        current = false
      }
    }
    void readChoices(projectId)
      .then((choices) => {
        if (!current) return
        setVersionChoices(choices)
        // O default vem do main, que aplica a mesma regra na criaÃ§Ã£o. O
        // seletor fica bloqueado enquanto esta leitura acontece, entÃ£o nunca
        // sobrescreve uma escolha manual do dono.
        if (!lockVersion && !initialVersionId) {
          setVersionId(choices.defaultVersionId ?? '')
        }
      })
      .catch(() => {
        if (!current) return
        setVersionChoices(null)
        setVersionChoicesError('n\u00e3o consegui carregar as vers\u00f5es eleg\u00edveis')
      })
      .finally(() => {
        if (current) setVersionChoicesLoading(false)
      })
    return () => {
      current = false
    }
  }, [initialVersionId, lockVersion, projectId])

  // O catálogo de MODELOS (spawn de CLI) saiu junto com os modos travados: a
  // criação 2.0 não tem selects de conta/modelo/effort — isso se decide
  // DENTRO da missão, na primeira conversa.

  async function submit(): Promise<void> {
    if (!title.trim()) return
    if (versionLookupBlocksCreation) {
      setSubmitError(versionChoicesError || 'aguarde o carregamento das versoes elegiveis')
      return
    }
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
            {planning ? '✎ novo planejamento' : '🚀 nova missão'}
          </span>
          {lockVersion && versionId && (
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
          autoFocus
          placeholder={
            planning ? 'título (ex.: Plano da V1.1)' : 'título (ex.: Tela de checkout)'
          }
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        {!lockVersion && (
          <label className="mission-version-choice">
            {'vers\u00e3o de destino'}
            <Select
              value={planning ? '' : versionId}
              disabled={versionSelectorDisabled}
              tip={'Vers\u00e3o que receber\u00e1 esta miss\u00e3o'}
              onChange={setVersionId}
              options={versionSelectOptions}
            />
            <span className="mission-version-note" aria-live="polite">
              {versionSelectNote}
            </span>
          </label>
        )}
        {/* Goal, escopo e executor eram campos read-only dos modos travados
            (pipeline legado) — saíram na purga F6 (2026-08-17). A criação 2.0
            pergunta apenas o título: conta, modelo e permissões se decidem
            dentro da missão, na primeira conversa. */}
        <div className="task-modal-actions">
          <span className="task-modal-meta">
            {planning
              ? 'a conversa abre na RAIZ do projeto e entrega escrevendo plano/ — sem branch, sem worktree e fora da fila de integração'
              : versionChoicesLoading
                ? 'consultando as versoes abertas antes de criar a missao'
                : versionChoicesError
                  ? versionChoicesError
                  : eligibleVersions.length === 0
                    ? 'não há versão aberta: ao criar, o Synkora abre a próxima versão e a missão integra nela'
                    : versionId
                      ? 'a missão nasce em branch/worktree próprios e integra na BRANCH DA VERSÃO — conta, modelo e permissões você escolhe dentro da missão, na primeira conversa'
                      : 'a missão nasce em branch/worktree próprios — conta, modelo e permissões você escolhe dentro da missão, na primeira conversa'}
          </span>
          <button className="btn ghost" onClick={onClose}>
            cancelar
          </button>
          <button
            className="btn accent"
            disabled={!title.trim() || versionLookupBlocksCreation}
            onClick={() => void submit()}
          >
            {planning ? 'criar planejamento' : 'criar missão'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
