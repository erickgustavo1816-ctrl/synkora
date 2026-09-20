import { useCallback, useEffect, useRef, useState } from 'react'
import { isGuiBrowserReferenceList, type GuiBrowserReference } from '../../shared/guiBrowserReferences'
import { guiApi } from './guiApi'
import { readGuiQueuedMessage } from './guiMessageQueue'

/** O main guarda os snapshots por pane. Eventos atualizam a lista sem mover o
 * foco; a consulta inicial recupera seleções feitas enquanto o chat estava fora. */
export function useGuiBrowserReferences(paneId: string) {
  const [state, setState] = useState<{ paneId: string; references: GuiBrowserReference[] }>({ paneId, references: [] })
  const [error, setError] = useState<string | null>(null)
  const version = useRef(0)
  const currentPane = useRef(paneId)
  currentPane.current = paneId

  useEffect(() => {
    let active = true
    const startedAt = ++version.current
    setState({ paneId, references: [] })
    setError(null)
    const unsubscribe = guiApi.onBrowserReferencesChanged(payload => {
      if (!active || payload.paneId !== paneId || !isGuiBrowserReferenceList(payload.references)) return
      version.current += 1
      setState({ paneId, references: payload.references })
      setError(null)
    })
    if (guiApi.browserReferencesAvailable()) {
      // Fecha a janela de crash entre gravar a fila e limpar os pins: o
      // envelope já durável é a confirmação de que esses IDs saíram do draft.
      const queuedIds = readGuiQueuedMessage(paneId)?.browserReferences?.map(ref => ref.id) ?? []
      const initial = queuedIds.length > 0
        ? guiApi.consumeBrowserReferences(paneId, queuedIds)
        : guiApi.browserReferencesList(paneId)
      void initial.then(result => {
        if (!active || version.current !== startedAt) return
        if (result.ok && isGuiBrowserReferenceList(result.references)) setState({ paneId, references: result.references })
        else setError(result.error ?? 'não foi possível carregar as referências da página')
      })
    }
    return () => { active = false; version.current += 1; unsubscribe() }
  }, [paneId])

  const remove = useCallback(async (id: string): Promise<void> => {
    const startedAt = version.current
    const result = await guiApi.removeBrowserReference(paneId, id)
    if (currentPane.current !== paneId) return
    if (!result.ok || !isGuiBrowserReferenceList(result.references)) setError(result.error ?? 'não foi possível remover a referência')
    else if (version.current === startedAt) {
      version.current += 1
      setState({ paneId, references: result.references })
      setError(null)
    }
  }, [paneId])

  const consume = useCallback(async (sent: readonly GuiBrowserReference[]): Promise<void> => {
    if (sent.length === 0) return
    const startedAt = version.current
    const result = await guiApi.consumeBrowserReferences(paneId, sent.map(ref => ref.id))
    if (currentPane.current !== paneId) return
    if (!result.ok || !isGuiBrowserReferenceList(result.references)) setError(result.error ?? 'não foi possível atualizar as referências enviadas')
    else if (version.current === startedAt) {
      version.current += 1
      setState({ paneId, references: result.references })
      setError(null)
    }
  }, [paneId])

  return { references: state.paneId === paneId ? state.references : [], error, remove, consume }
}
