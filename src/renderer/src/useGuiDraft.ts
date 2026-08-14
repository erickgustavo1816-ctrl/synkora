import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { readGuiDraft, removeGuiDraft, writeGuiDraft } from './guiDraftStorage'

export interface GuiDraftController {
  draft: string
  setDraft: Dispatch<SetStateAction<string>>
  clearDraft: () => void
}

/** P4: rascunho local por pane, com escrita curta e desmontagem sem perda. */
export function useGuiDraft(paneId: string, debounceMs = 220): GuiDraftController {
  const [draft, setDraft] = useState(() => readGuiDraft(paneId))
  const latestRef = useRef(draft)
  latestRef.current = draft

  useEffect(() => {
    const next = readGuiDraft(paneId)
    latestRef.current = next
    setDraft(next)
  }, [paneId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeGuiDraft(paneId, latestRef.current)
    }, debounceMs)
    return () => window.clearTimeout(timer)
  }, [debounceMs, draft, paneId])

  useEffect(
    () => () => {
      writeGuiDraft(paneId, latestRef.current)
    },
    [paneId]
  )

  const clearDraft = useCallback((): void => {
    latestRef.current = ''
    setDraft('')
    removeGuiDraft(paneId)
  }, [paneId])

  return { draft, setDraft, clearDraft }
}

