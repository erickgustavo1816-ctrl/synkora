import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useStore,
  type BacklogItem,
  type BacklogItemType,
  type Mission,
  type MissionStatus,
  type Version
} from '../store'
import NewMissionModal from './NewMissionModal'
import Select from './Select'
import { TestServerModal } from './TestServerModal'

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
  const tasks = useStore((s) => s.tasks)
  const archiveMission = useStore((s) => s.archiveMission)
  const deleteMission = useStore((s) => s.deleteMission)
  const setMissionTab = useStore((s) => s.setMissionTab)
  const setUniverseTab = useStore((s) => s.setUniverseTab)
  const [fStatus, setFStatus] = useState<'todas' | MissionStatus>('todas')
  const [fVersion, setFVersion] = useState<string>('todas') // todas | sem | <id>
  const [sort, setSort] = useState<'recentes' | 'antigas'>('recentes')
  const [page, setPage] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState<Mission | null>(null)
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
          const mTasks = tasks.filter((t) => t.missionId === m.id && t.kind !== 'plan')
          const done = mTasks.filter((t) => t.status === 'done').length
          const taskTip =
            mTasks.length > 0
              ? mTasks
                  .slice(0, 8)
                  .map((t) => `${t.status === 'done' ? '▣' : '▢'} ${t.title}`)
                  .join('\n') + (mTasks.length > 8 ? `\n… +${mTasks.length - 8}` : '')
              : 'sem tarefas'
          // missão concluída não tem mais pane — clicar abria "o nada"
          const clickable = m.status !== 'concluida'
          return (
            <div key={m.id} className={`ms-row ${m.status}`}>
              <button
                className={`ms-main${clickable ? '' : ' static'}`}
                data-tip={clickable ? 'Abrir a aba da missão no board' : 'Missão integrada — só histórico (orquestrador aposentado)'}
                onClick={clickable ? () => open(m) : undefined}
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
                  <span data-tip={taskTip}>
                    ▣ {done}/{mTasks.length} tarefa(s) concluída(s)
                  </span>
                  <span>· criada em {fmtAt(m.createdAt)}</span>
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

// "V1.2.3" / "v1.2" / "1.3" → [major, minor, patch] (espelho do backlog.ts).
function parseVer(name: string): [number, number, number] | null {
  const m = name.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/i)
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null
}

function cmpVer(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

interface Props {
  projectId: string
}

export default function BacklogView({ projectId }: Props): React.JSX.Element {
  const missions = useStore((s) => s.missions)
  const setMissionTab = useStore((s) => s.setMissionTab)
  const setUniverseTab = useStore((s) => s.setUniverseTab)
  const projPanes = useStore((s) => s.panesByProject[projectId])
  const closePane = useStore((s) => s.closePane)

  const [versions, setVersions] = useState<Version[]>([])
  const [items, setItems] = useState<BacklogItem[]>([])
  // sempre uma versão selecionada — a caixa "sem versão" morreu (confundia)
  const [selVersion, setSelVersion] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [niTitle, setNiTitle] = useState('')
  const [niType, setNiType] = useState<BacklogItemType>('feature')
  const [confirmRemove, setConfirmRemove] = useState<Version | null>(null)
  // confirmação NOSSA para excluir itens selecionados (clique sem querer)
  const [confirmRemoveItems, setConfirmRemoveItems] = useState<BacklogItem[] | null>(null)
  const [confirmRelease, setConfirmRelease] = useState<Version | null>(null)
  const [releaseMsg, setReleaseMsg] = useState<string | null>(null)
  // servidor de teste do dono: sobe a branch da versão num pane shell
  const [testVersion, setTestVersion] = useState<Version | null>(null)
  // sub-abas da tela: versões (release) | missões (ecossistema completo)
  const [view, setView] = useState<'versoes' | 'missoes'>('versoes')

  const bridgeOk = Boolean(window.synkora.backlog)

  const refresh = useCallback(async () => {
    if (!window.synkora.backlog) return
    const [v, i] = await Promise.all([
      window.synkora.backlog.listVersions(projectId),
      window.synkora.backlog.listItems(projectId)
    ])
    setVersions(v)
    setItems(i)
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
  }, [projectId])

  useEffect(() => {
    void refresh()
    if (!window.synkora.backlog) return
    return window.synkora.backlog.onChanged((pid) => {
      if (pid === projectId) void refresh()
    })
  }, [projectId, refresh])

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
  const shown = items.filter((i) => i.versionId === selVersion)
  const counts = (vid: string): { done: number; total: number } => {
    const list = items.filter((i) => i.versionId === vid)
    return { done: list.filter((i) => i.status === 'feito').length, total: list.length }
  }
  const selectable = shown.filter((i) => i.status === 'pendente')
  const picked = shown.filter((i) => selected.has(i.id) && i.status === 'pendente')

  // Criação AUTOMÁTICA de versão (decisão do usuário): nada de digitar
  // número — as opções são calculadas da versão mais alta (patch/minor/major)
  // e por construção nunca duplicam nem ficam abaixo da main.
  const nextOptions = ((): { label: string; kind: string }[] => {
    const parsed = versions
      .map((v) => ({ v, p: parseVer(v.name) }))
      .filter((x): x is { v: Version; p: [number, number, number] } => x.p != null)
    // Projeto NOVO escolhe onde começa (pedido do usuário, 2026-08-06): nem
    // todo produto nasce 1.0 — alfa/beta começam no 0.x e o semver segue
    // naturalmente dali (as opções patch/minor/major são calculadas da mais
    // alta existente).
    if (parsed.length === 0)
      return [
        { label: 'V1.0', kind: 'primeira versão — produto direto' },
        { label: 'V0.1.0', kind: 'beta — produto em validação' },
        { label: 'V0.0.1', kind: 'alfa — começo de tudo' }
      ]
    const top = [...parsed].sort((a, b) => cmpVer(b.p, a.p))[0]
    const [ma, mi, pa] = top.p
    const prefix = /^v/i.test(top.v.name) ? top.v.name.slice(0, 1) : ''
    return [
      { label: `${prefix}${ma}.${mi}.${pa + 1}`, kind: 'patch — correções' },
      { label: `${prefix}${ma}.${mi + 1}`, kind: 'minor — features' },
      { label: `${prefix}${ma + 1}.0`, kind: 'major — marco grande' }
    ].filter((c) => !versions.some((v) => v.name.toLowerCase() === c.label.toLowerCase()))
  })()

  // Excluir = via SELEÇÃO (decisão do usuário): um ou vários de uma vez,
  // sempre com confirmação.
  async function removeItems(items: BacklogItem[]): Promise<void> {
    if (!window.synkora.backlog) return
    for (const item of items) await window.synkora.backlog.removeItem(projectId, item.id)
    setSelected(new Set())
    await refresh()
  }

  async function addVersionNamed(name: string): Promise<void> {
    if (!window.synkora.backlog) return
    const created = await window.synkora.backlog.createVersion(projectId, { name })
    if (created) setSelVersion(created.id)
    await refresh()
  }

  async function addItem(): Promise<void> {
    if (!niTitle.trim() || !window.synkora.backlog) return
    await window.synkora.backlog.createItem(projectId, {
      title: niTitle.trim(),
      type: niType,
      versionId: selVersion ?? undefined
    })
    setNiTitle('')
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

  // SUBIR a versão: merge da branch version/<nome> na main (main process).
  async function releaseVersion(v: Version): Promise<void> {
    if (!window.synkora.backlog) return
    // aviso fica até o × (decisão do usuário)
    setReleaseMsg(await window.synkora.backlog.releaseVersion(v.id))
    await refresh()
  }

  // versão ATUAL na main = a lançada mais recente
  const current = [...versions]
    .filter((v) => v.status === 'lancada')
    .sort((a, b) => (a.releasedAt ?? '').localeCompare(b.releasedAt ?? ''))
    .at(-1)
  const inDev = versions.filter((v) => v.status === 'aberta')
  // Missão CONCLUÍDA já aparece em "o que já subiu" (delivery) — repeti-la em
  // "missões desta versão" era a mesma informação duas vezes (feedback do
  // usuário). Aqui ficam só as vivas/arquivadas.
  const versionMissions = version
    ? missions.filter((m) => m.versionId === version.id && m.status !== 'concluida')
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
        ) : (
          <span className="vs-current-none">nenhuma versão lançada ainda</span>
        )}
        {inDev.length > 0 && (
          <span className="vs-indev">em desenvolvimento: {inDev.map((v) => v.name).join(' · ')}</span>
        )}
      </div>

      {releaseMsg && (
        <div className="mission-msg">
          ⇪ {releaseMsg}
          <button className="mission-msg-close" data-tip="Fechar aviso" onClick={() => setReleaseMsg(null)}>
            ×
          </button>
        </div>
      )}

      <div className="vs-body">
      <aside className="bl-versions">
        <div className="bl-head">
          <span className="files-title">versões</span>
        </div>
        {/* criar versão EM CIMA, sem digitar número: patch/minor/major
            calculados da versão mais alta — nunca duplica nem fica abaixo
            da main (decisão do usuário) */}
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
              missions.filter((m) => m.versionId === v.id).length,
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
                      <button
                        className="btn ghost tiny danger"
                        data-tip="Derrubar o servidor de teste desta versão (fecha o pane e a árvore de processos)."
                        onClick={() => window.synkora.panes.requestClose(projectId, vPane.id)}
                      >
                        ■ derrubar teste
                      </button>
                    ) : (
                      <button
                        className="btn ghost tiny"
                        disabled={!version.branch}
                        data-tip={
                          version.branch
                            ? 'Subir o servidor da branch DESTA versão (missões já integradas, unificadas) num terminal para você testar. Você escolhe a porta.'
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

        {/* raio-x da versão: branch, missões dela e o que já subiu */}
        {version && (version.branch || versionMissions.length > 0 || version.deliveries.length > 0) && (
          <div className="vs-detail">
            {version.branch && (
              <span
                className="bl-chip mission"
                data-tip="Branch onde as missões desta versão acumulam até o release"
              >
                ⎇ {version.branch}
              </span>
            )}
            {versionMissions.length > 0 && (
              <div className="vs-block">
                <span className="vs-block-title">missões desta versão</span>
                {versionMissions.map((m) => (
                  <button
                    key={m.id}
                    className="vs-mission"
                    data-tip="Abrir a aba da missão no board"
                    onClick={() => {
                      setMissionTab(projectId, m.id)
                      setUniverseTab(projectId, 'board')
                    }}
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
                ))}
              </div>
            )}
            {version.deliveries.length > 0 && (
              <div className="vs-block">
                <span className="vs-block-title">o que já subiu nesta versão</span>
                {version.deliveries.map((d) => (
                  <div key={d.id} className="vs-delivery">
                    ▣ {d.title}
                    <span className="vs-delivery-date">
                      {new Date(d.at).toLocaleString('pt-BR')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {launched ? (
          <div className="bl-launched-note">
            ✓ esta versão já está na main — histórico read-only; trabalho novo vai na próxima
            versão
          </div>
        ) : (
          <div className="bl-quickadd">
            <Select
              value={niType}
              onChange={(v) => setNiType(v as BacklogItemType)}
              options={[
                { value: 'feature', label: '✨ feature' },
                { value: 'bug', label: '🐛 bug' },
                { value: 'melhoria', label: '🔧 melhoria' }
              ]}
            />
            <input
              placeholder={`+ item na ${version?.name ?? 'versão corrente'} — o que precisa ser feito?`}
              value={niTitle}
              onChange={(e) => setNiTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addItem()}
            />
          </div>
        )}

        {shown.length === 0 && (
          <div className="files-empty">nenhum item aqui ainda — despeje as ideias acima</div>
        )}

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
              Merge da branch {confirmRelease.branch ?? '—'} na base: tudo que as missões desta
              versão entregaram passa a valer no app. Ela vira a versão ATUAL.
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
                    setReleaseMsg(message)
                    await refresh()
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
