import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useStore,
  type BacklogItem,
  type BacklogItemType,
  type Mission,
  type MissionStatus,
  type Version,
  type VersionReleaseRecord
} from '../store'
import ArchivedMissionChat from './ArchivedMissionChat'
import ReleaseChangeHistory from './ReleaseChangeHistory'
import VersionMissionDeliveries from './VersionMissionDeliveries'
import './BacklogView.css'
import NewMissionModal from './NewMissionModal'
import Select from './Select'
import { TestServerModal } from './TestServerModal'
import { NoticeStack, useNoticeStack } from './NoticeStack'
import { noticePrefsOf, noticeSentence, type NoticeSpec } from '../noticeStack'
import { MISSION_CARD_TIP, isReleaseMissionRecord, missionCardAccess } from '../missionCardAccess'
import { allowsOwnVersionNumber, manifestVersionNote, versionSuggestions } from '../versionChoice'

const MISSION_ICON: Record<MissionStatus, string> = {
  ativa: '🚀',
  integrando: '⇪',
  concluida: '✓',
  arquivada: '⊟'
}

// Sub-aba MISSÕES (decisão do usuário): o ecossistema completo de missões
// mora aqui — todas (ativas, concluídas, arquivadas), filtro por status e
// versão, ordenação por criação; o "histórico…" do board morreu.
function MissionsPane({ projectId, versions }: { projectId: string; versions: Version[] }): React.JSX.Element {
  const missions = useStore((s) => s.missions)
  const archiveMission = useStore((s) => s.archiveMission)
  const deleteMission = useStore((s) => s.deleteMission)
  const setMissionTab = useStore((s) => s.setMissionTab)
  const setUniverseTab = useStore((s) => s.setUniverseTab)
  const [fStatus, setFStatus] = useState<'todas' | MissionStatus>('todas')
  const [fVersion, setFVersion] = useState<string>('todas') // todas | sem | <id>
  const [sort, setSort] = useState<'recentes' | 'antigas'>('recentes')
  const [page, setPage] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState<Mission | null>(null)
  /** missão encerrada cuja conversa 2.0 o dono abriu para LER (fotografia) */
  const [chatViewer, setChatViewer] = useState<Mission | null>(null)
  const closeChatViewer = useCallback(() => setChatViewer(null), [])
  // Página ADAPTATIVA (decisão do usuário): cabem 10 na altura? mostra 10;
  // cabem 6? mostra 6 — a paginação só cobre o excedente.
  const listRef = useRef<HTMLDivElement>(null)
  const [pageSize, setPageSize] = useState(6)
  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const measure = (): void => {
      if (!el.clientHeight) return // aba escondida
      const row = el.querySelector<HTMLElement>('.ms-row')
      const rowH = (row?.offsetHeight ?? 56) + 6 // + gap da lista
      setPageSize(Math.max(1, Math.floor((el.clientHeight + 6) / rowH)))
    }
    measure()
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const vName = (vid?: string): string | undefined =>
    vid ? versions.find((v) => v.id === vid)?.name : undefined
  const fmtAt = (iso: string): string =>
    new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    })

  const all = missions
    .filter(
      (m) =>
        // R27 — o registro de release não é missão de superfície: a subida
        // aparece como estado da VERSÃO ("lançada em…"), nunca nesta lista.
        !isReleaseMissionRecord(m) &&
        (fStatus === 'todas' || m.status === fStatus) &&
        (fVersion === 'todas' ||
          (fVersion === 'sem' ? !m.versionId : m.versionId === fVersion))
    )
    .sort((a, b) =>
      sort === 'recentes'
        ? b.createdAt.localeCompare(a.createdAt)
        : a.createdAt.localeCompare(b.createdAt)
    )
  // paginação SEM rolagem de altura (decisão do usuário)
  const pages = Math.max(1, Math.ceil(all.length / pageSize))
  const curPage = Math.min(page, pages - 1)
  const shown = all.slice(curPage * pageSize, (curPage + 1) * pageSize)

  function open(m: Mission): void {
    setMissionTab(projectId, m.id)
    setUniverseTab(projectId, 'board')
  }

  return (
    <div className="ms-pane">
      <div className="ms-filters">
        <Select
          value={fStatus}
          onChange={(v) => {
            setFStatus(v as typeof fStatus)
            setPage(0)
          }}
          options={[
            { value: 'todas', label: 'todas as missões' },
            { value: 'ativa', label: '🚀 ativas' },
            { value: 'integrando', label: '⇪ integrando' },
            { value: 'concluida', label: '✓ concluídas' },
            { value: 'arquivada', label: '⊟ arquivadas' }
          ]}
        />
        <Select
          value={fVersion}
          onChange={(v) => {
            setFVersion(v)
            setPage(0)
          }}
          options={[
            { value: 'todas', label: 'todas as versões' },
            ...versions.map((v) => ({ value: v.id, label: `◈ ${v.name}` }))
          ]}
        />
        <Select
          value={sort}
          onChange={(v) => setSort(v as typeof sort)}
          options={[
            { value: 'recentes', label: 'mais recentes primeiro' },
            { value: 'antigas', label: 'mais antigas primeiro' }
          ]}
        />
        <span className="ms-count">{all.length} missão(ões)</span>
      </div>

      {all.length === 0 && <div className="files-empty">nenhuma missão nesse filtro</div>}

      <div className="ms-list" ref={listRef}>
        {shown.map((m) => {
          // A linha ▣ feitos/total de CARDS saiu na purga F6 (2026-08-17): a
          // missão 2.0 não cria card nenhum, e 0/0 não é informação.
          // TRÊS destinos, nunca um booleano só: missão viva abre no board;
          // missão encerrada de 2.0 abre a conversa gravada (somente leitura);
          // o resto não é clicável e diz por quê. Era aqui que a arquivada
          // escapava — ela abria o board, que desfazia a navegação sozinho.
          const access = missionCardAccess(m)
          return (
            <div key={m.id} className={`ms-row ${m.status}`}>
              <button
                className={`ms-main${access === 'inert' ? ' static' : ''}`}
                data-tip={MISSION_CARD_TIP[access]}
                onClick={
                  access === 'live'
                    ? () => open(m)
                    : access === 'frozen-chat'
                      ? () => setChatViewer(m)
                      : undefined
                }
              >
                <span className="ms-icon">{MISSION_ICON[m.status]}</span>
                <span className="ms-head-line">
                  <span className="ms-title">{m.title}</span>
                  {m.kind === 'direta' && (
                    <span
                      className="bl-chip mission"
                      data-tip="Trabalho de agente livre registrado direto na base — só história, sem cards"
                    >
                      ⚡ direta
                    </span>
                  )}
                  <span className={`vs-mission-status ${m.status}`}>{m.status}</span>
                  {vName(m.versionId) && (
                    <span className="bl-chip mission" data-tip="Versão do app">
                      ◈ {vName(m.versionId)}
                    </span>
                  )}
                  {m.branch && (
                    <span className="bl-chip" data-tip="Branch da missão">
                      ⎇ {m.branch}
                    </span>
                  )}
                </span>
                <span className="ms-meta-line">
                  <span>criada em {fmtAt(m.createdAt)}</span>
                  {m.status === 'concluida' && <span>· ✓ integrada em {fmtAt(m.updatedAt)}</span>}
                  {m.status === 'arquivada' && <span>· ⊟ arquivada em {fmtAt(m.updatedAt)}</span>}
                  {m.status === 'integrando' && <span>· ⇪ integrando desde {fmtAt(m.updatedAt)}</span>}
                </span>
              </button>
              {(m.status === 'ativa' || m.status === 'arquivada') && (
                <button
                  className="btn ghost tiny"
                  data-tip={m.status === 'ativa' ? 'Arquivar (branch preservada)' : 'Reativar a missão'}
                  onClick={() => void archiveMission(m.id, m.status === 'ativa')}
                >
                  {m.status === 'ativa' ? '⊟ arquivar' : '↩ reativar'}
                </button>
              )}
              {m.status === 'arquivada' && (
                <button
                  className="btn ghost tiny danger"
                  data-tip="Excluir de vez (tarefas e branch somem)"
                  onClick={() => setConfirmDelete(m)}
                >
                  🗑
                </button>
              )}
            </div>
          )
        })}
      </div>

      {pages > 1 && (
        <div className="ms-pager">
          <button className="btn ghost tiny" disabled={curPage === 0} onClick={() => setPage(curPage - 1)}>
            ‹ anterior
          </button>
          <span className="ms-pager-info">
            página {curPage + 1}/{pages}
          </span>
          <button
            className="btn ghost tiny"
            disabled={curPage >= pages - 1}
            onClick={() => setPage(curPage + 1)}
          >
            próxima ›
          </button>
        </div>
      )}

      {confirmDelete && (
        <div className="overlay" onClick={() => setConfirmDelete(null)}>
          <div className="task-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="task-modal-head">
              <span className="task-dept">🗑 excluir missão</span>
              <button className="pane-close dark-close" onClick={() => setConfirmDelete(null)}>
                ×
              </button>
            </div>
            <p className="confirm-text">
              Excluir <b>“{confirmDelete.title}”</b> de vez?
            </p>
            <p className="confirm-sub">
              As tarefas da missão{confirmDelete.branch ? ` e a branch ${confirmDelete.branch}` : ''}{' '}
              serão removidas. Não dá para desfazer.
            </p>
            {/* Arquivar guarda a conversa; EXCLUIR é o único apagador dela. O
                aviso só aparece para quem TEM conversa gravada — missão legada
                nunca teve, e prometer perda que não existe é ruído. */}
            {missionCardAccess(confirmDelete) === 'frozen-chat' && (
              <p className="confirm-sub">
                A conversa desta missão será apagada junto — arquivar guarda, excluir apaga.
              </p>
            )}
            <div className="task-modal-actions">
              <button className="btn ghost" onClick={() => setConfirmDelete(null)}>
                cancelar
              </button>
              <span className="task-modal-meta" />
              <button
                className="btn danger-solid"
                onClick={() => {
                  const m = confirmDelete
                  setConfirmDelete(null)
                  void deleteMission(m.id)
                }}
              >
                🗑 excluir de vez
              </button>
            </div>
          </div>
        </div>
      )}

      {chatViewer && <ArchivedMissionChat mission={chatViewer} onClose={closeChatViewer} />}
    </div>
  )
}

// Aba VERSÕES (F4.0): o versionamento do app. Cada versão tem BRANCH própria
// (version/<nome>): as missões da versão integram NELA — a main só recebe
// quando o usuário manda SUBIR a versão (aqui ou via release_version no PM).
// A versão lançada mais recente é a ATUAL na main. Entregas ("o que subiu")
// são registradas automaticamente quando cada missão integra. Itens continuam
// sendo o planejamento: selecionar → virar missão.

const TYPE_ICON: Record<BacklogItemType, string> = {
  feature: '✨',
  bug: '🐛',
  melhoria: '🔧'
}

interface Props {
  projectId: string
}

export default function BacklogView({ projectId }: Props): React.JSX.Element {
  const missions = useStore((s) => s.missions)
  const loadMissions = useStore((s) => s.loadMissions)
  const setMissionTab = useStore((s) => s.setMissionTab)
  const setUniverseTab = useStore((s) => s.setUniverseTab)
  const projPanes = useStore((s) => s.panesByProject[projectId])
  const closePane = useStore((s) => s.closePane)
  // Mesmo retrato do card da Home (recorte por versão): a Home fica montada
  // com o projeto aberto e os canais *:changed dela mantêm isto fresco; aqui
  // só garantimos a primeira leitura quando o dono entra direto na aba.
  const stats = useStore((s) => s.homeStats[projectId])
  const loadHomeStats = useStore((s) => s.loadHomeStats)
  // R27.3 — o endereço da PROD no cabeçalho da aba: a pasta do projeto é a
  // main, e ela só muda quando uma versão sobe. (`find` por id devolve a
  // referência do item — estável enquanto a lista não muda.)
  const projectPath = useStore((s) => s.projects.find((p) => p.id === projectId)?.path)

  const [versions, setVersions] = useState<Version[]>([])
  const [items, setItems] = useState<BacklogItem[]>([])
  // A VERSÃO QUE O PRODUTO JÁ TEM (2026-09-21): o `version` do package.json
  // da pasta do projeto. As sugestões contam a partir dela, e a linha "versão
  // atual na main" a mostra quando o Synkora ainda não lançou nada.
  const [manifestVersion, setManifestVersion] = useState<string | null>(null)
  // sempre uma versão selecionada — a caixa "sem versão" morreu (confundia)
  const [selVersion, setSelVersion] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmRemove, setConfirmRemove] = useState<Version | null>(null)
  // confirmação NOSSA para excluir itens selecionados (clique sem querer)
  const [confirmRemoveItems, setConfirmRemoveItems] = useState<BacklogItem[] | null>(null)
  const [confirmRelease, setConfirmRelease] = useState<Version | null>(null)
  // Avisos do ⇪ de release e da exclusão de versão: a mesma pilha flutuante do
  // board (NoticeStack). O tom sai do RAMO que chamou, nunca da frase.
  const notices = useNoticeStack()
  const noticePrefs = noticePrefsOf(useStore((s) => s.settings))
  const releaseNotice = (v: Version, tone: NoticeSpec['tone'], message: string): void =>
    notices.push({
      key: `release-chat:${v.id}`,
      tone,
      title: 'Chat de release não abriu',
      body: noticeSentence(message),
      context: v.name,
      contextKind: 'versão'
    })
  // NÚMERO DIGITADO PELO DONO (ordem de 2026-08-17) + a recusa do main quando
  // ele não serve. As duas coisas andam juntas: sem a recusa na tela, o campo
  // seria um botão que às vezes não faz nada.
  const [typedVersion, setTypedVersion] = useState('')
  const [newVersionError, setNewVersionError] = useState<string | null>(null)
  // servidor de teste do dono: sobe a branch da versão num pane shell
  const [testVersion, setTestVersion] = useState<Version | null>(null)
  /** missão encerrada cuja conversa 2.0 o dono abriu para LER (fotografia) —
   *  os MESMOS nomes do MissionsPane: o pino de teste descreve as duas
   *  superfícies com uma linha só, e regra duplicada é regra que diverge. */
  const [chatViewer, setChatViewer] = useState<Mission | null>(null)
  const closeChatViewer = useCallback(() => setChatViewer(null), [])
  // sub-abas da tela: versões (release) | missões (ecossistema completo)
  const [view, setView] = useState<'versoes' | 'missoes'>('versoes')
  // R27F2 — o retrato da subida da versão selecionada (entidade do main).
  const [versionReleases, setVersionReleases] = useState<VersionReleaseRecord[]>([])

  const bridgeOk = Boolean(window.synkora.backlog)

  /** Relê versões e itens; devolve as versões lidas (quem precisa confirmar
   *  um efeito — a exclusão de versão — olha a lista, nunca a frase). */
  const refresh = useCallback(async (): Promise<Version[] | undefined> => {
    if (!window.synkora.backlog) return undefined
    const [v, i, manifest] = await Promise.all([
      window.synkora.backlog.listVersions(projectId),
      window.synkora.backlog.listItems(projectId),
      // preload antigo (app sem reiniciar) não tem a leitura: segue sem ela
      window.synkora.backlog.manifestVersion?.(projectId).catch(() => null) ?? null
    ])
    setVersions(v)
    setItems(i)
    setManifestVersion(manifest)
    // seleção default = versão em desenvolvimento mais antiga (a corrente);
    // sem nenhuma aberta, a lançada mais recente (histórico)
    setSelVersion((cur) => {
      if (cur && v.some((x) => x.id === cur)) return cur
      const open = v
        .filter((x) => x.status === 'aberta')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      if (open[0]) return open[0].id
      const released = [...v]
        .filter((x) => x.status === 'lancada')
        .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''))
      return released[0]?.id ?? null
    })
    return v
  }, [projectId])

  useEffect(() => {
    void refresh()
    if (!window.synkora.backlog) return
    return window.synkora.backlog.onChanged((pid) => {
      if (pid === projectId) void refresh()
    })
  }, [projectId, refresh])

  useEffect(() => {
    if (!stats) void loadHomeStats(projectId)
  }, [stats, loadHomeStats, projectId])

  if (!bridgeOk) {
    return (
      <div className="ws-empty">
        <p className="empty-title">Backlog indisponível</p>
        <p className="hint">
          Reinicie o app (<code>npm run dev</code>) para carregar a API nova do backlog.
        </p>
      </div>
    )
  }

  const version = selVersion ? versions.find((v) => v.id === selVersion) : undefined

  // R27F2 — busca o retrato quando a versão selecionada é LANÇADA. O
  // `versions` nas deps re-dispara no backlog:changed do fecho do release —
  // a subida acabou de acontecer e o retrato aparece sem gesto novo.
  const versionId = version?.id
  const versionLaunched = version?.status === 'lancada'
  useEffect(() => {
    const reader = window.synkora.backlog?.versionReleases
    if (!versionId || !versionLaunched || !reader) {
      setVersionReleases([])
      return
    }
    let current = true
    reader(versionId)
      .then((list) => {
        if (current) setVersionReleases(list)
      })
      .catch(() => {
        if (current) setVersionReleases([])
      })
    return () => {
      current = false
    }
  }, [versionId, versionLaunched, versions])
  const shown = items.filter((i) => i.versionId === selVersion)
  const counts = (vid: string): { done: number; total: number } => {
    const list = items.filter((i) => i.versionId === vid)
    return { done: list.filter((i) => i.status === 'feito').length, total: list.length }
  }
  const selectable = shown.filter((i) => i.status === 'pendente')
  const picked = shown.filter((i) => selected.has(i.id) && i.status === 'pendente')

  // Sugestões de versão CALCULADAS da mais alta existente (patch/minor/major):
  // por construção nunca duplicam nem ficam abaixo da main, e resolvem com um
  // clique o produto que nasceu aqui. Elas não resolvem o produto que CHEGOU
  // pronto — daí o campo do número próprio logo abaixo. A régua mora no módulo
  // compartilhado: o modal de missão nova aplica a MESMA num projeto virgem.
  const typedVersionId = `bl-nv-${projectId}`
  const nextOptions = versionSuggestions(versions, manifestVersion)

  // Excluir = via SELEÇÃO (decisão do usuário): um ou vários de uma vez,
  // sempre com confirmação.
  async function removeItems(items: BacklogItem[]): Promise<void> {
    if (!window.synkora.backlog) return
    for (const item of items) await window.synkora.backlog.removeItem(projectId, item.id)
    setSelected(new Set())
    await refresh()
  }

  /**
   * A ÚNICA porta de criação de versão da tela: o clique numa sugestão e o
   * número digitado passam por aqui, então a régua (e a recusa) é a mesma para
   * os dois. O main devolve o motivo; guardá-lo em estado é o que transforma
   * "o botão não fez nada" em "1.20 ficaria abaixo da V2.0 — escolha um acima".
   */
  async function addVersionNamed(name: string): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || !window.synkora.backlog) return
    const created = await window.synkora.backlog.createVersion(projectId, { name: trimmed })
    if (!created.ok) {
      setNewVersionError(created.error)
      return
    }
    setNewVersionError(null)
    setTypedVersion('')
    setSelVersion(created.version.id)
    await refresh()
  }

  function togglePick(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Itens selecionados → MISSÃO: abre o MESMO modal do board (seat, modelo e
  // effort do orquestrador escolhidos lá; a VERSÃO vem setada e travada).
  // Guarda os itens do momento do clique — a criação vincula eles à missão.
  const [missionDraft, setMissionDraft] = useState<{
    title: string
    goal: string
    items: BacklogItem[]
  } | null>(null)

  function missionFromPicked(): void {
    if (picked.length === 0) return
    const title =
      picked.length === 1
        ? picked[0].title.slice(0, 60)
        : `${version?.name ?? 'Backlog'}: ${picked.length} itens`
    const goal =
      `Itens do backlog${version ? ` (versão ${version.name})` : ''} que esta missão deve entregar:\n` +
      picked.map((i) => `- [${i.type}] ${i.title}${i.notes ? ` — ${i.notes}` : ''}`).join('\n')
    setMissionDraft({ title, goal, items: picked })
  }

  // SUBIR a versão (R10): o clique deixou de rodar a máquina — ele abre (ou
  // reencontra) o CHAT DE RELEASE da versão e leva o dono direto para lá. O
  // chat nasce MUDO (o agente só fala depois da primeira mensagem dele, com
  // conta/modelo/effort já escolhidos) e quem sobe é o agente, pelas
  // ferramentas release_status/release_run — o clique é o mandato.
  async function releaseVersion(v: Version): Promise<void> {
    if (!window.synkora.backlog?.releaseChat) {
      // Beco sem saída é bug: ponte sem a rota fala a receita, nunca some.
      releaseNotice(v, 'warn', 'reinicie o Synkora (npm run dev) para abrir o chat de release')
      return
    }
    try {
      const result = await window.synkora.backlog.releaseChat(v.id)
      if (!result.ok) {
        // aviso fica até o × (decisão do usuário)
        releaseNotice(v, 'warn', result.error)
        return
      }
      // A missão de release acabou de NASCER no main. Sem recarregar a lista,
      // o Board não a conhece: setMissionTab apontaria para uma missão
      // desconhecida, selMission cairia em undefined e o board renderizaria
      // idêntico ao de antes — o "cliquei e não aconteceu nada" do incidente
      // de 2026-08-20. A missão primeiro; a navegação depois.
      await loadMissions(projectId)
      await refresh()
      setMissionTab(projectId, result.missionId)
      setUniverseTab(projectId, 'board')
    } catch {
      releaseNotice(v, 'error', 'não consegui abrir o chat de release agora — tente de novo')
    }
  }

  // versão ATUAL na main = a lançada mais recente
  const current = [...versions]
    .filter((v) => v.status === 'lancada')
    .sort((a, b) => (a.releasedAt ?? '').localeCompare(b.releasedAt ?? ''))
    .at(-1)
  const inDev = versions.filter((v) => v.status === 'aberta')
  const manifestNote = manifestVersionNote(versions, manifestVersion)
  // Missão CONCLUÍDA já aparece em "o que já subiu" (delivery) — repeti-la em
  // "missões desta versão" era a mesma informação duas vezes (feedback do
  // usuário). Aqui ficam só as vivas/arquivadas.
  // R30 — a entrega da PRÓPRIA subida não é "o que já subiu nesta versão": o
  // main parou de gravá-la (reconciliador, por TIPO) e o dado já gravado
  // degrada inerte aqui — o registro do release existe justamente para a
  // régua achar (lookup estrutural por missionId, nunca por título).
  const releaseMissionIds = new Set(
    missions.filter((m) => isReleaseMissionRecord(m)).map((m) => m.id)
  )
  const versionDeliveries = version
    ? version.deliveries.filter(
        (delivery) => !delivery.missionId || !releaseMissionIds.has(delivery.missionId)
      )
    : []
  const versionMissions = version
    ? missions.filter(
        (m) =>
          m.versionId === version.id &&
          m.status !== 'concluida' &&
          // R27 — a subida não é "missão desta versão": ela é a própria versão
          // subindo (o ⇪ reabre o chat dela).
          !isReleaseMissionRecord(m)
      )
    : []
  // Versão LANÇADA já está na main: histórico read-only — sem add, sem mover,
  // sem excluir, sem virar missão (decisão do usuário).
  const launched = version?.status === 'lancada'

  return (
    <div className="backlog-view">
      <div className="vs-tabs">
        <button
          className={`vs-tab ${view === 'versoes' ? 'active' : ''}`}
          onClick={() => setView('versoes')}
        >
          ◈ versões
        </button>
        <button
          className={`vs-tab ${view === 'missoes' ? 'active' : ''}`}
          onClick={() => setView('missoes')}
        >
          🚀 missões
        </button>
      </div>

      {view === 'missoes' && <MissionsPane projectId={projectId} versions={versions} />}

      {view === 'versoes' && (
      <>
      {/* versão ATUAL na main = a lançada mais recente */}
      <div className="vs-current">
        <span className="vs-current-label">◈ versão atual na main:</span>
        {current ? (
          <span className="vs-current-name">
            {current.name}
            {current.releasedAt &&
              ` · lançada em ${new Date(current.releasedAt).toLocaleDateString('pt-BR')}`}
          </span>
        ) : manifestNote ? (
          <span className="vs-current-name" title="O version do package.json da pasta do projeto">
            {manifestNote}
          </span>
        ) : (
          <span className="vs-current-none">nenhuma versão lançada ainda</span>
        )}
        {current && manifestNote && (
          <span className="vs-indev" title="O version do package.json da pasta do projeto">
            {manifestNote}
          </span>
        )}
        {inDev.length > 0 && (
          <span className="vs-indev">em desenvolvimento: {inDev.map((v) => v.name).join(' · ')}</span>
        )}
      </div>

      {/* R27.3 — o MAPA dev→prod na tela (a confusão que fez o dono rodar o
          build na pasta errada morre aqui): a pasta do projeto é a PROD. */}
      {projectPath && (
        <div className="vs-prod-line" title={projectPath}>
          prod: {projectPath} · branch main — só muda quando uma versão sobe
        </div>
      )}

      {/* RETRATO POR VERSÃO — mudou de casa (ordem do dono, 2026-08-15): ele
          ocupava a página ✦ geral inteira ("uma página inteira para aquilo não
          faz sentido") e agora mora aqui, colado nas versões que descreve. Os
          números são os MESMOS do card da Home (homeStats é global e os canais
          *:changed o mantêm fresco) — nada é recalculado nesta tela. */}
      {stats && stats.versoes.length > 0 && (
        <div className="vs-stats">
          <div className="vs-stats-grid">
            {stats.versoes.map((v) => (
              // UM CARD POR VERSÃO (ordem do dono, 2026-08-15b). Era um grid
              // único de 4 trilhas com um Fragment de 4 células por versão —
              // por construção, UMA versão por linha, faixa vazia à direita. O
              // Fragment existia para alinhar as colunas ENTRE versões; com
              // cards irmãos de `1fr` esse alinhamento passa a ser estrutural
              // (mesma largura de card ⇒ mesmas trilhas internas).
              <div className="vs-stat-card" key={v.name}>
                <span
                  className={`vs-stat-name${v.lancada ? ' released' : ''}`}
                  data-tip={
                    v.lancada
                      ? 'Já lançada — o que ela entregou (está na main)'
                      : 'Versão aberta em construção'
                  }
                >
                  ◈ {v.name}
                </span>
                <div className="vs-stat-tiles">
                  <div
                    className="stat-tile"
                    data-tip={`missões entregues na ${v.name} / total (entregues + vivas)`}
                  >
                    <span className="stat-num">
                      {v.missoesTotal > 0 ? `${v.missoesFeitas}/${v.missoesTotal}` : '0'}
                    </span>
                    <span className="stat-label">missões</span>
                  </div>
                  {/* Os dois tiles de TAREFA (em execução · concluídas) saíram
                      na purga F6 (2026-08-17): sem card, seriam sempre zero. */}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <NoticeStack
        notices={notices.notices}
        onDismiss={notices.dismiss}
        corner={noticePrefs.corner}
        autoCloseSeconds={noticePrefs.autoCloseSeconds}
      />

      <div className="vs-body">
      <aside className="bl-versions">
        <div className="bl-head">
          <span className="files-title">versões</span>
        </div>
        {/* criar versão EM CIMA: um clique nas sugestões (patch/minor/major
            calculados da mais alta) OU o número escrito à mão, para o produto
            que já vinha de outro lugar. A régua é a mesma nos dois caminhos —
            quem recusa é o main, e a recusa aparece aqui embaixo. */}
        <div className="bl-newversion top">
          <span className="bl-nv-label">+ nova versão</span>
          <div className="bl-nv-opts">
            {nextOptions.map((o) => (
              <button
                key={o.label}
                className="btn ghost tiny"
                data-tip={o.kind}
                onClick={() => void addVersionNamed(o.label)}
              >
                ◈ {o.label}
              </button>
            ))}
          </div>
          {/* O NÚMERO PRÓPRIO SÓ EXISTE NO PROJETO VIRGEM (refinamento do dono,
              2026-08-17): ele resolve o produto que CHEGA numerado. Criada a
              primeira versão, o app já sabe de onde contar e o número escrito à
              mão só serviria para furar a sequência — as sugestões acima
              passam a ser o caminho inteiro. */}
          {allowsOwnVersionNumber(versions) && (
            <div className="bl-nv-own">
              <label className="bl-nv-own-label" htmlFor={typedVersionId}>
                ou escreva o número
              </label>
              <div className="bl-nv-own-row">
                <input
                  id={typedVersionId}
                  className="bl-nv-input"
                  value={typedVersion}
                  /* exemplo, nunca rótulo: "1.20" sozinho dentro da caixa lê como
                     um valor já preenchido — o "ex.:" desfaz a confusão */
                  placeholder="ex.: 1.20"
                  spellCheck={false}
                  autoComplete="off"
                  data-tip="O número do jeito que o produto já é numerado — 1.20, 2.0.1, 1.2.0.4 ou um codinome"
                  onChange={(e) => {
                    setTypedVersion(e.target.value)
                    setNewVersionError(null)
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && void addVersionNamed(typedVersion)}
                />
                <button
                  className="btn ghost tiny"
                  disabled={!typedVersion.trim()}
                  data-tip="Criar a versão com este número"
                  onClick={() => void addVersionNamed(typedVersion)}
                >
                  ◈ criar
                </button>
              </div>
            </div>
          )}
          {newVersionError && (
            <span className="bl-nv-error" role="alert">
              {newVersionError}
            </span>
          )}
        </div>
        {/* abertas EM CIMA (é onde o trabalho acontece), sempre da mais
            recente para a mais antiga; lançadas embaixo, idem */}
        {[...versions]
          .sort((a, b) => {
            if (a.status !== b.status) return a.status === 'aberta' ? -1 : 1
            return a.status === 'aberta'
              ? b.createdAt.localeCompare(a.createdAt)
              : (b.releasedAt ?? '').localeCompare(a.releasedAt ?? '')
          })
          .map((v) => {
            const c = counts(v.id)
            // lançada: itens não dizem nada (0/0) — o que importa é quantas
            // MISSÕES ela entregou (enviadas/criadas; excluída some da conta)
            const sent = v.deliveries.length
            const created = Math.max(
              // R27 — o registro de release não é missão CRIADA da versão:
              // contá-lo fazia a lançada dizer "✓ 8/9" com 8 entregas reais
              // (o nono era a própria subida — o bug que o dono viu).
              missions.filter((m) => m.versionId === v.id && !isReleaseMissionRecord(m)).length,
              sent
            )
            return (
              <button
                key={v.id}
                className={`bl-version ${selVersion === v.id ? 'active' : ''}${v.status === 'lancada' ? ' launched' : ''}`}
                data-tip={
                  v.status === 'lancada'
                    ? `${v.goal ?? v.theme ?? v.name} — ${sent} missão(ões) enviada(s) de ${created} criada(s)`
                    : (v.goal ?? v.theme ?? v.name)
                }
                onClick={() => {
                  setSelVersion(v.id)
                  setSelected(new Set())
                }}
              >
                <span className="bl-vname">
                  ◈ {v.name}
                  {v.theme ? ` — ${v.theme}` : ''}
                </span>
                <span className="bl-vcount">
                  {v.status === 'lancada' ? `✓ ${sent}/${created}` : `${c.done}/${c.total}`}
                </span>
              </button>
            )
          })}
      </aside>

      <section className="bl-items">
        <div className="bl-head">
          <span className="files-title">
            {version ? `itens de ${version.name}` : 'crie uma versão ao lado'}
          </span>
          {version && (
            <div className="bl-vactions">
              {version.status === 'lancada' ? (
                <span className="bl-chip done">
                  ✓ lançada
                  {version.releasedAt
                    ? ` em ${new Date(version.releasedAt).toLocaleDateString('pt-BR')}`
                    : ''}
                </span>
              ) : (
                <>
                  {(() => {
                    const vPane = projPanes?.find(
                      (p) => p.testServer && p.versionId === version.id
                    )
                    return vPane ? (
                      <>
                        {/* ONDA D: o terminal do teste é um SLOT da coluna do
                            ✦ geral no Board (a aba Panes morreu) — o dono
                            precisa saber para onde olhar. */}
                        <button
                          className="btn ghost tiny"
                          data-tip="Ver o terminal deste teste (ele roda na coluna ✦ geral do Board)"
                          onClick={() => {
                            setMissionTab(projectId, null)
                            setUniverseTab(projectId, 'board')
                          }}
                        >
                          ▷ ver terminal
                        </button>
                        <button
                          className="btn ghost tiny danger"
                          data-tip="Derrubar o servidor de teste desta versão (fecha o terminal e a árvore de processos)."
                          onClick={() => window.synkora.panes.requestClose(projectId, vPane.id)}
                        >
                          ■ derrubar teste
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn ghost tiny"
                        disabled={!version.branch}
                        data-tip={
                          version.branch
                            ? 'Subir o servidor da branch DESTA versão (missões já integradas, unificadas) num terminal para você testar. Você escolhe a porta — o terminal abre na coluna ✦ geral do Board.'
                            : 'Ainda sem branch: nenhuma missão desta versão integrou'
                        }
                        onClick={() => setTestVersion(version)}
                      >
                        ▶ testar
                      </button>
                    )
                  })()}
                  <button
                    className="btn ghost tiny"
                    disabled={!version.branch}
                    data-tip={
                      version.branch
                        ? `Merge da ${version.branch} na main — o app passa a estar nesta versão. Missões em andamento bloqueiam.`
                        : 'Ainda sem branch: nenhuma missão desta versão integrou'
                    }
                    onClick={() => setConfirmRelease(version)}
                  >
                    ⇪ subir versão
                  </button>
                </>
              )}
              {!launched && (
                <button
                  className="btn ghost tiny danger"
                  data-tip="Excluir a versão (itens voltam para 'sem versão')"
                  onClick={() => setConfirmRemove(version)}
                >
                  🗑
                </button>
              )}
            </div>
          )}
        </div>

        <div className="bl-items-scroll" key={versionId ?? 'empty'} role="region"
          aria-label={`Conteúdo da versão ${version?.name ?? ''}`} tabIndex={0}>
        {/* raio-x da versão: branch, missões dela e o que já subiu */}
        {version && (version.branch || versionMissions.length > 0 || versionDeliveries.length > 0) && (
          <div className="vs-detail">
            {version.branch && (
              <span
                className="bl-chip mission"
                data-tip="Branch onde as missões desta versão acumulam até o release"
              >
                ⎇ {version.branch}
              </span>
            )}
            {/* R27.3 — onde o DEV desta versão mora de verdade no disco. */}
            {version.worktree && (
              <span className="vs-home-line" title={version.worktree}>
                mora em: {version.worktree}
              </span>
            )}
            {versionMissions.length > 0 && (
              <div className="vs-block">
                <span className="vs-block-title">missões desta versão</span>
                {versionMissions.map((m) => {
                  // TRÊS destinos, a MESMA regra da sub-aba missões
                  // (missionCardAccess.ts): viva abre no board; encerrada de
                  // 2.0 abre a conversa gravada; o resto não é clicável e diz
                  // por quê. Esta superfície tinha ficado de fora — o botão
                  // prometia "abrir a aba" para TODA missão da lista, e a
                  // ARQUIVADA levava ao board, que desfazia a navegação no
                  // mesmo ciclo (Board.tsx, efeito de missionTab).
                  const access = missionCardAccess(m)
                  return (
                    <button
                      key={m.id}
                      className={`vs-mission${access === 'inert' ? ' static' : ''}`}
                      data-tip={MISSION_CARD_TIP[access]}
                      onClick={
                        access === 'live'
                          ? () => {
                              setMissionTab(projectId, m.id)
                              setUniverseTab(projectId, 'board')
                            }
                          : access === 'frozen-chat'
                            ? () => setChatViewer(m)
                            : undefined
                      }
                    >
                      {m.status === 'concluida'
                        ? '✓'
                        : m.status === 'integrando'
                          ? '⇪'
                          : m.status === 'arquivada'
                            ? '⊟'
                            : '🚀'}{' '}
                      {m.title}
                      <span className={`vs-mission-status ${m.status}`}>{m.status}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {versionDeliveries.length > 0 && (
              <VersionMissionDeliveries deliveries={versionDeliveries} />
            )}
          </div>
        )}

        {/* R27F2 — O RETRATO DA SUBIDA (entidade releasesStore, via
            backlog:versionReleases): a versão lançada conta quando subiu, quem
            operou, merge, push e caixa — read-only; o ⇪ segue sendo o caminho
            de reabrir a conversa. Versão lançada ANTES da entidade existir não
            tem retrato: o bloco simplesmente não nasce (dado velho, inerte). */}
        {launched && versionReleases.length > 0 && (
          <div className="vs-block vs-release">
            <span className="vs-block-title">retrato da subida</span>
            {versionReleases.map((rec) => (
              <div key={rec.id} className="vs-release-line">
                ⇧ subiu em {new Date(rec.at).toLocaleString('pt-BR')} · por {rec.actor} ·{' '}
                {rec.mergeDetail}
                <span className="vs-release-detail">
                  {rec.push.attempted
                    ? rec.push.ok
                      ? 'push: GitHub atualizado'
                      : `push FALHOU: ${rec.push.error ?? 'motivo desconhecido'}`
                    : 'sem remoto configurado'}
                  {rec.bump &&
                    ` · version ${rec.bump.version}${rec.bump.committed ? '' : ' (alinhamento FALHOU)'}`}
                  {rec.publishRequired && ' · produto publica caixa (npm run release)'}
                </span>
                <ReleaseChangeHistory changes={rec.changes} />
              </div>
            ))}
          </div>
        )}

        {launched && (
          <div className="bl-launched-note">
            ✓ esta versão já está na main — histórico read-only; trabalho novo vai na próxima
            versão
          </div>
        )}

        {/* QUICK-ADD REMOVIDO (ordem do dono, 2026-08-15): "não faz sentido eu
            criar uma 'feature' aqui dentro do versionamento — se eu quero algo
            eu crio direto, ou pelo mapa (um planejador cria), ou pelo botão de
            nova missão". Item de backlog continua existindo e sendo gerenciado
            aqui (mover de versão, virar missão, excluir) — o que morreu foi a
            digitação avulsa nesta tela. Quem cria item agora é o planejador,
            pelo main (missionEngine). */}

        <div className="bl-list">
          {shown.map((item) => {
            const mission = item.missionId
              ? missions.find((m) => m.id === item.missionId)
              : undefined
            return (
              <div key={item.id} className={`bl-item ${item.status}`}>
                {item.status === 'pendente' && !launched ? (
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => togglePick(item.id)}
                    data-tip="Selecionar para virar missão"
                  />
                ) : (
                  <span className="bl-check">
                    {item.status === 'feito' ? '▣' : item.status === 'em-missao' ? '▶' : '▢'}
                  </span>
                )}
                <span className="bl-type">{TYPE_ICON[item.type]}</span>
                <span className="bl-title" data-tip={item.notes ?? item.title}>
                  {item.title}
                </span>
                {item.status === 'em-missao' && (
                  <span className="bl-chip mission" data-tip="Em missão">
                    🚀 {mission?.title.slice(0, 22) ?? 'missão'}
                  </span>
                )}
                {item.status === 'feito' && <span className="bl-chip done">✓ feito</span>}
                {item.status === 'pendente' && !launched && (
                  <Select
                    className="bl-move"
                    value={item.versionId ?? ''}
                    tip="Mover para outra versão"
                    onChange={(v) =>
                      v &&
                      void window.synkora.backlog
                        .updateItem(projectId, item.id, { versionId: v })
                        .then(() => refresh())
                    }
                    options={versions
                      .filter((v) => v.status === 'aberta' || v.id === item.versionId)
                      .map((v) => ({ value: v.id, label: v.name }))}
                  />
                )}
              </div>
            )
          })}
        </div>

        </div>

        {selectable.length > 0 && !launched && (
          <div className="bl-footer">
            <span className="bl-hint">
              {picked.length > 0
                ? `${picked.length} item(ns) selecionado(s)`
                : 'selecione itens para virarem missão — ou para excluir'}
            </span>
            <div className="bl-footer-actions">
              <button
                className="btn ghost danger"
                disabled={picked.length === 0}
                data-tip="Excluir os itens selecionados (pede confirmação)"
                onClick={() => setConfirmRemoveItems(picked)}
              >
                🗑 excluir {picked.length || '…'} item(ns)
              </button>
              <button
                className="btn accent"
                disabled={picked.length === 0}
                onClick={() => void missionFromPicked()}
              >
                🚀 criar missão com {picked.length || '…'} item(ns)
              </button>
            </div>
          </div>
        )}
      </section>
      </div>
      </>
      )}

      {/* MESMO modal de missão do board — versão herdada (travada quando há) */}
      {missionDraft && (
        <NewMissionModal
          projectId={projectId}
          initialTitle={missionDraft.title}
          initialGoal={missionDraft.goal}
          initialVersionId={version?.id}
          lockVersion={Boolean(version)}
          onClose={() => setMissionDraft(null)}
          onCreated={async (mission) => {
            for (const item of missionDraft.items) {
              // item acompanha a VERSÃO da missão que o assumiu — o trabalho
              // e o registro ficam sempre no mesmo lugar
              await window.synkora.backlog.updateItem(projectId, item.id, {
                status: 'em-missao',
                missionId: mission.id,
                ...(mission.versionId ? { versionId: mission.versionId } : {})
              })
            }
            setSelected(new Set())
            await refresh()
            setMissionTab(projectId, mission.id)
            setUniverseTab(projectId, 'board')
          }}
        />
      )}

      {confirmRemoveItems && (
        <div className="overlay" onClick={() => setConfirmRemoveItems(null)}>
          <div className="task-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="task-modal-head">
              <span className="task-dept">🗑 excluir item(ns)</span>
              <button className="pane-close dark-close" onClick={() => setConfirmRemoveItems(null)}>
                ×
              </button>
            </div>
            <p className="confirm-text">
              Excluir <b>{confirmRemoveItems.length}</b> item(ns) do backlog?
            </p>
            <p className="confirm-sub">
              {confirmRemoveItems
                .slice(0, 5)
                .map((i) => `“${i.title}”`)
                .join(', ')}
              {confirmRemoveItems.length > 5 ? ` … +${confirmRemoveItems.length - 5}` : ''} — não
              dá para desfazer.
            </p>
            <div className="task-modal-actions">
              <button className="btn ghost" onClick={() => setConfirmRemoveItems(null)}>
                cancelar
              </button>
              <span className="task-modal-meta" />
              <button
                className="btn danger-solid"
                onClick={() => {
                  const items = confirmRemoveItems
                  setConfirmRemoveItems(null)
                  void removeItems(items)
                }}
              >
                🗑 excluir
              </button>
            </div>
          </div>
        </div>
      )}

      {testVersion && (
        <TestServerModal
          projectId={projectId}
          target={{ versionId: testVersion.id }}
          label={`versão ${testVersion.name}`}
          onClose={() => setTestVersion(null)}
        />
      )}

      {chatViewer && <ArchivedMissionChat mission={chatViewer} onClose={closeChatViewer} />}

      {confirmRelease && (
        <div className="overlay" onClick={() => setConfirmRelease(null)}>
          <div className="task-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="task-modal-head">
              <span className="task-dept">⇪ subir versão</span>
              <button className="pane-close dark-close" onClick={() => setConfirmRelease(null)}>
                ×
              </button>
            </div>
            <p className="confirm-text">
              Subir a versão <b>{confirmRelease.name}</b> para a main?
            </p>
            <p className="confirm-sub">
              dev → prod: merge da branch {confirmRelease.branch ?? '—'} na main — a pasta do
              projeto passa a conter tudo que as missões desta versão entregaram. Ela vira a
              versão ATUAL.
            </p>
            <div className="task-modal-actions">
              <button className="btn ghost" onClick={() => setConfirmRelease(null)}>
                cancelar
              </button>
              <span className="task-modal-meta" />
              <button
                className="btn accent"
                onClick={() => {
                  const v = confirmRelease
                  setConfirmRelease(null)
                  void releaseVersion(v)
                }}
              >
                ⇪ subir agora
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmRemove && (
        <div className="overlay" onClick={() => setConfirmRemove(null)}>
          <div className="task-modal confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="task-modal-head">
              <span className="task-dept">🗑 excluir versão</span>
              <button className="pane-close dark-close" onClick={() => setConfirmRemove(null)}>
                ×
              </button>
            </div>
            <p className="confirm-text">
              Excluir a versão <b>“{confirmRemove.name}”</b>?
            </p>
            <p className="confirm-sub">Os itens abertos dela vão para a versão corrente.</p>
            <div className="task-modal-actions">
              <button className="btn ghost" onClick={() => setConfirmRemove(null)}>
                cancelar
              </button>
              <span className="task-modal-meta" />
              <button
                className="btn danger-solid"
                onClick={() => {
                  const v = confirmRemove
                  setConfirmRemove(null)
                  setSelVersion(null)
                  void window.synkora.backlog.removeVersion(projectId, v.id).then(async (message) => {
                    // A MESMA frase carrega o sucesso e as recusas: quem diz o
                    // tom é a lista depois do refresh — a versão sumiu ou não.
                    const gone = !(await refresh())?.some((x) => x.id === v.id)
                    notices.push({
                      key: `remove-version:${v.id}`,
                      tone: gone ? 'info' : 'warn',
                      title: gone ? 'Versão excluída' : 'Versão não excluída',
                      body: noticeSentence(message),
                      context: v.name,
                      contextKind: 'versão'
                    })
                  })
                }}
              >
                🗑 excluir
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
