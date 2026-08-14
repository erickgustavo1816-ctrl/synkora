import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { GuiAttachmentDescriptor } from '../../preload'
import {
  readGuiComposerAttachments,
  removeGuiComposerAttachments,
  writeGuiComposerAttachments
} from './guiComposerAttachmentStorage'

export interface GuiComposerAttachmentsController {
  attachments: GuiAttachmentDescriptor[]
  setAttachments: Dispatch<SetStateAction<GuiAttachmentDescriptor[]>>
  clearAttachments: () => void
}

/** Descritores por pane: troca de missão/reload preserva chips sem transformar
 * o texto digitado num depósito de caminhos absolutos. */
export function useGuiComposerAttachments(
  paneId: string,
  debounceMs = 120
): GuiComposerAttachmentsController {
  const [attachments, setAttachments] = useState(() => readGuiComposerAttachments(paneId))
  const latestRef = useRef(attachments)
  latestRef.current = attachments

  useEffect(() => {
    const next = readGuiComposerAttachments(paneId)
    latestRef.current = next
    setAttachments(next)
  }, [paneId])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeGuiComposerAttachments(paneId, latestRef.current)
    }, debounceMs)
    return () => window.clearTimeout(timer)
  }, [attachments, debounceMs, paneId])

  useEffect(
    () => () => {
      writeGuiComposerAttachments(paneId, latestRef.current)
    },
    [paneId]
  )

  const clearAttachments = useCallback((): void => {
    latestRef.current = []
    setAttachments([])
    removeGuiComposerAttachments(paneId)
  }, [paneId])

  return { attachments, setAttachments, clearAttachments }
}
