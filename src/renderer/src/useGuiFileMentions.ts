import { useCallback, useEffect, useMemo, useState } from 'react'
import { guiApi } from './guiApi'
import {
  completeFileMention,
  fileMentionQueryAt,
  filterFileMentions,
  isFileMentionQueryDismissed,
  mentionDismissalAt,
  type FileMentionCompletion,
  type FileMentionDismissal,
  type FileMentionQuery
} from './guiFileMentions'

export interface GuiFileMentionsState {
  files: string[]
  loading: boolean
  error: string | null
  query: FileMentionQuery | null
  matches: string[]
  open: boolean
  index: number
  setIndex: (index: number) => void
  dismiss: () => void
  complete: (path: string, cursor: number) => FileMentionCompletion | null
}

/**
 * Carrega a árvore uma vez por pane. A busca/filtro seguinte é 100% local;
 * portanto digitar no token não cria chamadas IPC nem novas varreduras.
 */
export function useGuiFileMentions(
  paneId: string,
  draft: string,
  cursor: number,
  slashOpen: boolean
): GuiFileMentionsState {
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [index, setIndexState] = useState(0)
  const [dismissal, setDismissal] = useState<FileMentionDismissal | null>(null)

  useEffect(() => {
    let alive = true
    setFiles([])
    setLoading(true)
    setError(null)
    setDismissal(null)
    setIndexState(0)
    void guiApi.workspaceFiles(paneId).then((result) => {
      if (!alive) return
      if (result.ok) {
        setFiles(result.files ?? [])
        setError(null)
      } else {
        setFiles([])
        setError(result.error ?? 'não foi possível ler os arquivos do projeto')
      }
      setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [paneId])

  const query = useMemo(() => fileMentionQueryAt(draft, cursor), [cursor, draft])
  const activeQuery =
    slashOpen || isFileMentionQueryDismissed(dismissal, draft, query) ? null : query
  const matches = useMemo(
    () => (activeQuery ? filterFileMentions(files, activeQuery.query) : []),
    [activeQuery, files]
  )
  const open = !slashOpen && activeQuery !== null

  const setIndex = useCallback(
    (next: number): void => {
      setIndexState((current) => {
        const target = Number.isFinite(next) ? Math.floor(next) : current
        if (matches.length === 0) return 0
        return Math.max(0, Math.min(matches.length - 1, target))
      })
    },
    [matches.length]
  )

  useEffect(() => {
    setIndexState((current) => (matches.length === 0 ? 0 : Math.min(current, matches.length - 1)))
  }, [activeQuery?.at, activeQuery?.query, matches.length])

  const dismiss = useCallback((): void => {
    if (!query) return
    setDismissal(mentionDismissalAt(draft, query.at))
    setIndexState(0)
  }, [draft, query])

  const complete = useCallback(
    (path: string, completionCursor: number): FileMentionCompletion | null => {
      const result = completeFileMention(draft, completionCursor, path)
      if (result && query) {
        setDismissal(mentionDismissalAt(result.text, query.at))
        setIndexState(0)
      }
      return result
    },
    [draft, query]
  )

  return {
    files,
    loading,
    error,
    query: activeQuery,
    matches,
    open,
    index,
    setIndex,
    dismiss,
    complete
  }
}
