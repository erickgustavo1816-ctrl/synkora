import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { createPortal } from 'react-dom'
import { isPaletteNavigationTarget } from '../../../shared/commandPalette'
import type {
  DocFile,
  HistoryLoadResult,
  HistorySearchHit,
  MissionCommit,
  PaletteNavigationTarget
} from '../../../preload'
import { useStore } from '../store'
import {
  commandPaletteActions,
  subscribeCommandPaletteActions,
  type CommandPaletteAction,
  type CommandPaletteContext
} from '../commandPaletteRegistry'
import {
  navigateFromCommandPalette,
  onPaletteNavigationFailure
} from '../commandPaletteNavigation'

type PaletteSource = 'acoes' | 'arquivos' | 'sessoes' | 'commits' | 'branches'
type PaletteFilter = 'tudo' | PaletteSource

interface PaletteEntry {
  id: string
  source: PaletteSource
  title: string
  detail?: string
  keywords: string
  target?: PaletteNavigationTarget
  action?: CommandPaletteAction
}

const FILTERS: ReadonlyArray<{ id: PaletteFilter; label: string }> = [
  { id: 'tudo', label: 'Tudo' },
  { id: 'acoes', label: 'Ações' },
  { id: 'arquivos', label: 'Arquivos' },
  { id: 'sessoes', label: 'Sessões' },
  { id: 'commits', label: 'Commits' },
  { id: 'branches', label: 'Branches' }
]

const SOURCE_LABEL: Record<PaletteSource, string> = {
  acoes: 'ação',
  arquivos: 'arquivo',
  sessoes: 'sessão',
  commits: 'commit',
  branches: 'branch'
}

const SOURCE_GLYPH: Record<PaletteSource, string> = {
  acoes: '⌘',
  arquivos: '▤',
  sessoes: '◌',
  commits: '◇',
  branches: '⑂'
}

function searchable(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
}

function scoreEntry(entry: PaletteEntry, query: string): number {
  if (!query) return entry.source === 'acoes' ? 40 : 10
  const title = searchable(entry.title)
  const detail = searchable(entry.detail ?? '')
  const all = `${title} ${detail} ${searchable(entry.keywords)}`
  if (!all.includes(query)) return -1
  if (title === query) return 100
  if (title.startsWith(query)) return 80
  if (title.includes(query)) return 60
  return detail.includes(query) ? 35 : 20
}

function historyEntry(hit: HistorySearchHit): PaletteEntry {
  const who = hit.role === 'user' ? 'você' : 'assistente'
  const provider = hit.provider === 'claude' ? 'Claude' : 'Codex'
  return {
    id: `history:${hit.selectionId}`,
    source: 'sessoes',
    title: hit.label?.trim() || `${provider} · conversa ${hit.sessionId.slice(0, 8)}`,
    detail: `${who}: ${hit.snippet}`,
    keywords: `${provider} ${who} ${hit.sessionId} ${hit.snippet}`,
    target: {
      kind: 'history',
      selectionId: hit.selectionId,
      ...(hit.projectId ? { projectId: hit.projectId } : {}),
      ...(hit.missionId ? { missionId: hit.missionId } : {}),
      ...(hit.paneId ? { paneId: hit.paneId } : {}),
      canMount: hit.canMount
    }
  }
}

function resolvedActionTarget(
  action: CommandPaletteAction,
  context: CommandPaletteContext
): PaletteNavigationTarget | undefined {
  return typeof action.target === 'function' ? action.target(context) : action.target
}

function PreviewTranscript({ result }: { result: HistoryLoadResult }): React.JSX.Element {
  const selectedRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'center' })
  }, [result.selectionId])
  if (!result.ok || !result.messages || !result.targetMessageId) {
    return (
      <div className="command-palette-preview-error" role="alert">
        {result.error ?? 'não consegui carregar essa conversa antiga'}
      </div>
    )
  }
  return (
    <div className="command-palette-preview">
      <div className="command-palette-preview-note">
        <b>conversa antiga sem painel compatível</b>
        <span>Ela pode ser lida aqui, mas não dá para remontá-la no chat atual.</span>
      </div>
      <div className="command-palette-preview-thread">
        {result.messages.map((message) => {
          const selected =
            message.id === result.targetMessageId && message.cursor === result.targetCursor
          return (
            <div
              key={`${message.id}:${message.cursor}`}
              ref={selected ? selectedRef : undefined}
              className={`command-palette-preview-message ${message.role}${selected ? ' selected' : ''}`}
              data-history-message-id={message.id}
              data-history-cursor={message.cursor}
            >
              <span>{message.role === 'user' ? 'você' : 'assistente'}</span>
              <p>{message.text}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function CommandPalette(): React.JSX.Element | null {
  const projects = useStore((state) => state.projects)
  const projectId = useStore((state) => state.openProjectId)
  const missions = useStore((state) => state.missions)
  const bumpHostOverlay = useStore((state) => state.bumpHostOverlay)
  const registeredActions = useSyncExternalStore(
    subscribeCommandPaletteActions,
    commandPaletteActions,
    commandPaletteActions
  )
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<PaletteFilter>('tudo')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [docs, setDocs] = useState<DocFile[]>([])
  const [commits, setCommits] = useState<Array<{ missionId: string; missionTitle: string; commit: MissionCommit }>>([])
  const [history, setHistory] = useState<HistorySearchHit[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyLimited, setHistoryLimited] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [preview, setPreview] = useState<HistoryLoadResult | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const resultRefs = useRef(new Map<string, HTMLButtonElement>())
  const previousFocusRef = useRef<HTMLElement | null>(null)

  const currentProject = projects.find((project) => project.id === projectId)
  const currentMissions = missions.filter((mission) => mission.projectId === projectId)
  const context: CommandPaletteContext = { projectId }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLocaleLowerCase('pt-BR') !== 'k') return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      setOpen((value) => !value)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  useEffect(
    () =>
      onPaletteNavigationFailure((message) => {
        setOpen(true)
        setPreview(null)
        setStatus(message)
      }),
    []
  )

  useEffect(() => {
    if (!open) return
    bumpHostOverlay(1)
    return () => bumpHostOverlay(-1)
  }, [bumpHostOverlay, open])

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
    return () => {
      cancelAnimationFrame(frame)
      const previous = previousFocusRef.current
      if (previous?.isConnected && !previous.closest('[inert]')) {
        previous.focus({ preventScroll: true })
      }
      previousFocusRef.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      setQuery('')
      setFilter('tudo')
      setPreview(null)
      setStatus(null)
      setHistory([])
      setHistoryLimited(null)
      return
    }
    if (!projectId) {
      setDocs([])
      setCommits([])
      return
    }
    let alive = true
    void window.synkora.files
      .listDocs(projectId)
      .then((list) => alive && setDocs(list.slice(0, 240)))
      .catch(() => alive && setDocs([]))
    void Promise.all(
      currentMissions.slice(0, 16).map(async (mission) => {
        const result = await window.synkora.missions.commits(mission.id).catch(() => null)
        return result?.ok && result.commits
          ? result.commits.map((commit) => ({ missionId: mission.id, missionTitle: mission.title, commit }))
          : []
      })
    ).then((groups) => alive && setCommits(groups.flat().slice(0, 160)))
    return () => {
      alive = false
    }
  }, [open, projectId, currentMissions.map((mission) => mission.id).join('|')])

  useEffect(() => {
    if (
      !open ||
      query.trim().length < 2 ||
      (filter !== 'tudo' && filter !== 'sessoes')
    ) {
      setHistory([])
      setHistoryLoading(false)
      setHistoryLimited(null)
      return
    }
    const requestId = `palette:${crypto.randomUUID()}`
    let alive = true
    const timer = window.setTimeout(() => {
      setHistoryLoading(true)
      setHistoryLimited(null)
      void window.synkora.history
        .search({ requestId, query: query.trim(), ...(projectId ? { projectId } : {}) })
        .then((result) => {
          if (!alive || result.requestId !== requestId || result.cancelled) return
          setHistory(result.ok ? result.hits : [])
          setHistoryLimited(
            result.error ??
              (result.truncated
                ? `busca parcial: limite de ${result.limitReason ?? 'leitura'} atingido`
                : null)
          )
        })
        .catch(() => {
          if (alive) setHistoryLimited('não consegui pesquisar os históricos locais agora')
        })
        .finally(() => {
          if (alive) setHistoryLoading(false)
        })
    }, 170)
    return () => {
      alive = false
      window.clearTimeout(timer)
      window.synkora.history.cancel(requestId)
    }
  }, [filter, open, projectId, query])

  const entries = useMemo(() => {
    const output: PaletteEntry[] = [
      {
        id: 'app:home',
        source: 'acoes',
        title: 'Ir para o início',
        detail: 'Todos os universos',
        keywords: 'home inicio projetos universos',
        target: { kind: 'app', page: 'home' }
      },
      {
        id: 'app:settings',
        source: 'acoes',
        title: 'Abrir ajustes',
        detail: 'Contas, aparência e serviços',
        keywords: 'configuracoes settings contas aparencia servicos',
        target: { kind: 'app', page: 'settings' }
      }
    ]
    for (const project of projects) {
      output.push({
        id: `project:${project.id}`,
        source: 'acoes',
        title: `Abrir ${project.name}`,
        detail: project.path,
        keywords: `universo projeto ${project.name} ${project.path}`,
        target: { kind: 'project', projectId: project.id, tab: 'board' }
      })
    }
    if (currentProject && projectId) {
      for (const page of [
        ['board', 'Board', 'missões e conversas'],
        ['mapa', 'Mapa', 'visão do universo'],
        ['backlog', 'Versões', 'backlog e entregas'],
        ['arquivos', 'Arquivos', 'documentos do projeto']
      ] as const) {
        output.push({
          id: `page:${projectId}:${page[0]}`,
          source: 'acoes',
          title: `Abrir ${page[1]}`,
          detail: `${currentProject.name} · ${page[2]}`,
          keywords: `${page[0]} ${page[1]} ${page[2]}`,
          target: { kind: 'project', projectId, tab: page[0] }
        })
      }
      for (const mission of currentMissions) {
        output.push({
          id: `mission:${mission.id}`,
          source: 'sessoes',
          title: mission.title,
          detail: `Missão · ${mission.status}`,
          keywords: `${mission.title} ${mission.goal ?? ''} ${mission.scope ?? ''}`,
          target: { kind: 'project', projectId, tab: 'board', missionId: mission.id }
        })
        if (mission.branch) {
          output.push({
            id: `branch:${mission.id}:${mission.branch}`,
            source: 'branches',
            title: mission.branch,
            detail: mission.title,
            keywords: `branch ramo ${mission.branch} ${mission.title}`,
            target: { kind: 'project', projectId, tab: 'board', missionId: mission.id }
          })
        }
        if (mission.baseBranch) {
          output.push({
            id: `base-branch:${mission.id}:${mission.baseBranch}`,
            source: 'branches',
            title: mission.baseBranch,
            detail: `Base de ${mission.title}`,
            keywords: `branch base ${mission.baseBranch} ${mission.title}`,
            target: { kind: 'project', projectId, tab: 'board', missionId: mission.id }
          })
        }
      }
      for (const doc of docs) {
        output.push({
          id: `file:${doc.path}`,
          source: 'arquivos',
          title: doc.name,
          detail: doc.path,
          keywords: `${doc.name} ${doc.path} ${doc.group}`,
          target: { kind: 'file', projectId, path: doc.path, name: doc.name }
        })
      }
      for (const item of commits) {
        output.push({
          id: `commit:${item.missionId}:${item.commit.sha}`,
          source: 'commits',
          title: item.commit.subject,
          detail: `${item.commit.sha} · ${item.missionTitle}`,
          keywords: `commit ${item.commit.sha} ${item.commit.subject} ${item.missionTitle}`,
          target: { kind: 'project', projectId, tab: 'board', missionId: item.missionId }
        })
      }
    }
    for (const action of registeredActions) {
      let available = true
      try {
        available = action.when?.(context) ?? true
      } catch {
        available = false
      }
      if (!available) continue
      output.push({
        id: `registered:${action.id}`,
        source: 'acoes',
        title: action.title,
        ...(action.detail ? { detail: action.detail } : {}),
        keywords: action.keywords?.join(' ') ?? '',
        action
      })
    }
    output.push(...history.map(historyEntry))
    const normalizedQuery = searchable(query.trim())
    return output
      .filter((entry) => filter === 'tudo' || entry.source === filter)
      .map((entry) => ({ entry, score: scoreEntry(entry, normalizedQuery) }))
      .filter(({ score }) => score >= 0)
      .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, 'pt-BR'))
      .slice(0, 90)
      .map(({ entry }) => entry)
  }, [commits, currentMissions, currentProject, docs, filter, history, projectId, projects, query, registeredActions])

  useEffect(() => {
    setSelectedIndex((index) => Math.max(0, Math.min(index, Math.max(0, entries.length - 1))))
  }, [entries.length])

  useLayoutEffect(() => {
    const entry = entries[selectedIndex]
    if (entry) resultRefs.current.get(entry.id)?.scrollIntoView({ block: 'nearest' })
  }, [entries, selectedIndex])

  const close = (): void => setOpen(false)
  const execute = async (entry: PaletteEntry): Promise<void> => {
    setStatus(null)
    setPreview(null)
    try {
      const target = entry.target ?? (entry.action ? resolvedActionTarget(entry.action, context) : undefined)
      if (target && !isPaletteNavigationTarget(target)) {
        setStatus('esta ação devolveu um destino inválido')
        return
      }
      if (entry.action?.run) await entry.action.run(context)
      if (!target) {
        if (entry.action?.run) close()
        else setStatus('esta ação não tem um destino disponível agora')
        return
      }
      const outcome = await navigateFromCommandPalette(target)
      if (outcome.preview) setPreview(outcome.preview)
      if (outcome.error) setStatus(outcome.error)
      if (outcome.close) close()
    } catch {
      setStatus('não consegui executar essa ação agora')
    }
  }

  if (!open) return null
  const active = entries[selectedIndex]
  return createPortal(
    <div
      className="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Paleta de comandos"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (preview) setPreview(null)
            else close()
            return
          }
          if (event.key === 'ArrowDown' && !preview) {
            event.preventDefault()
            setSelectedIndex((index) => (entries.length ? (index + 1) % entries.length : 0))
            return
          }
          if (event.key === 'ArrowUp' && !preview) {
            event.preventDefault()
            setSelectedIndex((index) =>
              entries.length ? (index - 1 + entries.length) % entries.length : 0
            )
            return
          }
          if (event.key === 'Enter' && active && !preview) {
            event.preventDefault()
            void execute(active)
            return
          }
          if (event.key === 'Tab') {
            const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
              'input:not(:disabled), button:not(:disabled)'
            )
            if (!focusable?.length) return
            const items = [...focusable]
            const index = items.indexOf(document.activeElement as HTMLElement)
            const next = event.shiftKey
              ? items[(index - 1 + items.length) % items.length]
              : items[(index + 1) % items.length]
            event.preventDefault()
            next.focus()
          }
        }}
      >
        <div className="command-palette-search">
          <span aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            value={query}
            maxLength={240}
            placeholder="Buscar ações, arquivos, sessões, commits e branches…"
            aria-label="Buscar em toda a Synkora"
            aria-controls="command-palette-results"
            aria-activedescendant={active && !preview ? `command-entry-${active.id}` : undefined}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setSelectedIndex(0)
              setPreview(null)
              setStatus(null)
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="command-palette-filters" aria-label="Fontes da busca">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              className={filter === item.id ? 'active' : ''}
              onClick={() => {
                setFilter(item.id)
                setSelectedIndex(0)
                inputRef.current?.focus({ preventScroll: true })
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
        {preview ? (
          <PreviewTranscript result={preview} />
        ) : (
          <div
            id="command-palette-results"
            className="command-palette-results"
            role="listbox"
            aria-busy={historyLoading}
          >
            {entries.map((entry, index) => (
              <button
                key={entry.id}
                id={`command-entry-${entry.id}`}
                ref={(element) => {
                  if (element) resultRefs.current.set(entry.id, element)
                  else resultRefs.current.delete(entry.id)
                }}
                className={`command-palette-result${index === selectedIndex ? ' selected' : ''}`}
                role="option"
                aria-selected={index === selectedIndex}
                data-palette-entry-id={entry.id}
                onMouseMove={() => setSelectedIndex(index)}
                onClick={() => void execute(entry)}
              >
                <span className="command-palette-glyph" aria-hidden="true">
                  {SOURCE_GLYPH[entry.source]}
                </span>
                <span className="command-palette-copy">
                  <b>{entry.title}</b>
                  {entry.detail && <small>{entry.detail}</small>}
                </span>
                <span className="command-palette-source">{SOURCE_LABEL[entry.source]}</span>
              </button>
            ))}
            {entries.length === 0 && !historyLoading && (
              <div className="command-palette-empty">
                {query.trim().length < 2
                  ? 'Digite ao menos 2 caracteres para buscar no texto das conversas.'
                  : 'Nada encontrado nesta fonte.'}
              </div>
            )}
          </div>
        )}
        <div className="command-palette-footer" role="status" aria-live="polite">
          <span>
            {historyLoading ? 'procurando nas conversas locais…' : status ?? historyLimited ?? '↑↓ escolhe · Enter abre'}
          </span>
          <span>{navigator.platform.toLowerCase().includes('mac') ? '⌘ K' : 'Ctrl K'}</span>
        </div>
      </div>
    </div>,
    document.body
  )
}
