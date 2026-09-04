import { useCallback, useRef, useState, type RefObject } from 'react'
import { GUI_INLINE_IMAGE_OPEN_ATTR, guiInlineImageState, type GuiInlineImageState } from '../guiInlineImageHtml'
import GuiAttachmentLightbox from './GuiAttachmentLightbox'

interface ImagePreview {
  reference: string
  name: string
  state: GuiInlineImageState | undefined
}

/** The wrapper owns one delegated gesture, even when streaming replaces its DOM. */
export function useGuiInlineImagePreview(
  containerRef: RefObject<HTMLDivElement | null>,
  cacheRef: RefObject<Map<string, GuiInlineImageState>>
): {
  open: (frame: HTMLButtonElement, event: { preventDefault: () => void; stopPropagation: () => void }) => void
  refresh: () => void
  close: (restoreFocus?: boolean) => void
  preview: React.JSX.Element | null
} {
  const [selected, setSelected] = useState<ImagePreview | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const selectedRef = useRef<ImagePreview | null>(null)

  const close = useCallback((restoreFocus = true): void => {
    const previous = selectedRef.current
    selectedRef.current = null
    setSelected(null)
    if (!restoreFocus || !previous) return
    window.requestAnimationFrame(() => {
      const trigger = triggerRef.current
      const replacement = Array.from(containerRef.current?.querySelectorAll<HTMLButtonElement>(
        `button[${GUI_INLINE_IMAGE_OPEN_ATTR}]`
      ) ?? []).find((frame) => frame.getAttribute(GUI_INLINE_IMAGE_OPEN_ATTR) === previous.reference)
      const target = trigger?.isConnected ? trigger : replacement
      target?.focus({ preventScroll: true })
    })
  }, [containerRef])

  const open = useCallback((frame: HTMLButtonElement, event: { preventDefault: () => void; stopPropagation: () => void }): void => {
    const reference = frame.getAttribute(GUI_INLINE_IMAGE_OPEN_ATTR)
    if (!reference) return
    // Image links enlarge here without also activating their HTTPS ancestor.
    event.preventDefault()
    event.stopPropagation()
    triggerRef.current = frame
    const snapshot = {
      reference,
      name: frame.querySelector('.gui-md-image-caption')?.textContent || 'Imagem',
      state: guiInlineImageState(reference, cacheRef.current)
    }
    selectedRef.current = snapshot
    setSelected(snapshot)
  }, [cacheRef])

  const refresh = useCallback((): void => {
    const previous = selectedRef.current
    if (!previous) return
    const belongsToMessage = Array.from(containerRef.current?.querySelectorAll(
      `button[${GUI_INLINE_IMAGE_OPEN_ATTR}], button[data-gui-file-token]`
    ) ?? []).some((frame) => (frame.getAttribute(GUI_INLINE_IMAGE_OPEN_ATTR) ||
      frame.getAttribute('data-gui-file-token')) === previous.reference)
    if (!belongsToMessage) {
      close(false)
      return
    }
    const state = guiInlineImageState(previous.reference, cacheRef.current)
    if (state?.status === previous.state?.status &&
      (state?.status !== 'ready' || (previous.state?.status === 'ready' && state.dataUrl === previous.state.dataUrl)) &&
      (state?.status !== 'refused' || (previous.state?.status === 'refused' && state.error === previous.state.error))) return
    const snapshot = { ...previous, state }
    selectedRef.current = snapshot
    setSelected(snapshot)
  }, [cacheRef, close, containerRef])

  const closeFromDialog = useCallback(() => close(true), [close])
  return {
    open, refresh, close,
    preview: selected ? (
      <GuiAttachmentLightbox
        name={selected.name}
        src={selected.state?.status === 'ready' ? selected.state.dataUrl : null}
        loading={!selected.state}
        error={selected.state?.status === 'refused' ? selected.state.error : null}
        feedback={null}
        downloading={false}
        onClose={closeFromDialog}
      />
    ) : null
  }
}
