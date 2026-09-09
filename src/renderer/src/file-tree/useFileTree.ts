import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileActionScope, FileActionTreeEntry } from '../../../preload/index'

interface DirectoryPage {
  entries: FileActionTreeEntry[]
  loading: boolean
  error?: string
  nextOffset?: number
}

type LoadMode = 'initial' | 'more' | 'retry'

/** Cache por pasta da origem atual. Só a expansão pede filhos ao main;
 * respostas de uma origem antiga nunca entram na árvore nova. */
export function useFileTree(scope: FileActionScope): {
  entries: FileActionTreeEntry[]
  directories: Record<string, DirectoryPage>
  loading: boolean
  error: string | null
  loadDirectory: (path: string, mode?: LoadMode) => Promise<void>
  refresh: () => Promise<void>
} {
  const [directories, setDirectories] = useState<Record<string, DirectoryPage>>({})
  const cache = useRef(directories)
  const generation = useRef(0)
  const currentScope = useRef(scope)
  currentScope.current = scope

  const publish = useCallback((next: Record<string, DirectoryPage>): void => {
    cache.current = next
    setDirectories(next)
  }, [])

  const loadDirectory = useCallback(async (path: string, mode: LoadMode = 'initial'): Promise<void> => {
    if (currentScope.current !== scope) return
    const previous = cache.current[path]
    if (previous?.loading || (mode === 'initial' && previous)) return
    if (mode === 'more' && previous?.nextOffset === undefined) return
    const offset = mode === 'more' ? previous!.nextOffset! : 0
    const epoch = generation.current
    const isCurrent = (): boolean => epoch === generation.current && currentScope.current === scope
    publish({ ...cache.current, [path]: { ...previous, entries: previous?.entries ?? [], loading: true, error: undefined } })
    try {
      const snapshot = await window.synkora.files.tree(scope, path, offset)
      if (!isCurrent()) return
      if (!snapshot.ok) {
        publish({ ...cache.current, [path]: {
          ...previous, entries: previous?.entries ?? [], loading: false,
          error: snapshot.error ?? 'Não foi possível carregar esta pasta.'
        } })
        return
      }
      // A lista é de filhos diretos. Também permite ler respostas do preload
      // anterior enquanto o app ainda aguarda reinício após uma atualização.
      const children = snapshot.entries.filter((entry) => entry.parentPath === path)
      const merged = new Map((mode === 'more' ? previous?.entries ?? [] : []).map((entry) => [entry.path, entry]))
      for (const entry of children) merged.set(entry.path, entry)
      const nextOffset = snapshot.nextOffset
      const invalidContinuation = snapshot.truncated && (
        nextOffset === undefined || !Number.isSafeInteger(nextOffset) || nextOffset <= offset
      )
      publish({ ...cache.current, [path]: {
        entries: [...merged.values()], loading: false,
        ...(snapshot.truncated && !invalidContinuation ? { nextOffset } : {}),
        ...(invalidContinuation ? { error: 'A lista ficou incompleta. Reinicie o app e recarregue esta pasta.' } : {})
      } })
    } catch {
      if (!isCurrent()) return
      publish({ ...cache.current, [path]: {
        ...previous, entries: previous?.entries ?? [], loading: false,
        error: 'Não foi possível carregar esta pasta. Tente novamente.'
      } })
    }
  }, [publish, scope])

  const refresh = useCallback(async (): Promise<void> => {
    if (currentScope.current !== scope) return
    generation.current += 1
    publish({})
    await loadDirectory('')
  }, [loadDirectory, publish, scope])

  useEffect(() => {
    void refresh()
    return () => { generation.current += 1 }
  }, [refresh])

  const entries = useMemo(() => {
    const result: FileActionTreeEntry[] = []
    const append = (path: string): void => {
      for (const entry of directories[path]?.entries ?? []) {
        result.push(entry)
        if (entry.kind === 'directory') append(entry.path)
      }
    }
    append('')
    return result
  }, [directories])

  return {
    entries, directories, loadDirectory, refresh,
    loading: directories['']?.loading ?? true,
    error: directories['']?.error ?? null
  }
}
