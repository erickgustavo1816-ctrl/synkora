import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type {
  GuiAttachmentAction,
  GuiAttachmentDescriptor
} from '../../../preload'
import { guiApi } from '../guiApi'
import { safePreviewSource } from '../guiAttachmentPreview'
import GuiAttachmentLightbox from './GuiAttachmentLightbox'
import GuiComposerImagePreview from './GuiComposerImagePreview'

interface GuiAttachmentChipsProps {
  attachments: readonly GuiAttachmentDescriptor[]
  onRemove?: (id: string) => void
  /** Pane that owns the opaque attachment capability. */
  paneId?: string
  presented?: boolean
  /** Active composer only: preview without blocking the draft. */
  previewable?: boolean
  previewAnchorRef?: RefObject<HTMLElement | null>
  className?: string
}

function attachmentLabel(kind: GuiAttachmentDescriptor['kind']): string {
  if (kind === 'image') return 'imagem'
  if (kind === 'folder') return 'pasta'
  return 'arquivo'
}

function attachmentGlyph(kind: GuiAttachmentDescriptor['kind']): string {
  if (kind === 'image') return '▧'
  if (kind === 'folder') return '▱'
  return '⌁'
}

function formatSize(size: number | null): string | null {
  if (size === null) return null
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
}

function cleanFeedback(value: string | undefined, fallback: string): string {
  return value?.replace(/\s+/gu, ' ').trim().slice(0, 240) || fallback
}

function GuiAttachmentChip({
  attachment,
  paneId,
  presented,
  onRemove,
  onPreview
}: {
  attachment: GuiAttachmentDescriptor
  paneId?: string
  presented: boolean
  onRemove?: (id: string) => void
  onPreview?: (id: string) => void
}): React.JSX.Element {
  const interactive = presented && Boolean(paneId)
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const [thumbnailError, setThumbnailError] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [lightboxSource, setLightboxSource] = useState<string | null>(null)
  const [lightboxLoading, setLightboxLoading] = useState(false)
  const [lightboxError, setLightboxError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<GuiAttachmentAction | null>(null)
  const [actionFeedback, setActionFeedback] = useState<string | null>(null)
  const [thumbnailVisible, setThumbnailVisible] = useState(false)
  const thumbnailTriggerRef = useRef<HTMLButtonElement>(null)
  const thumbnailEpoch = useRef(0)
  const lightboxEpoch = useRef(0)
  const actionPendingRef = useRef(false)
  const closeLightbox = useCallback((): void => {
    lightboxEpoch.current += 1
    setLightboxOpen(false)
    setLightboxSource(null)
    setLightboxLoading(false)
    setLightboxError(null)
  }, [])

  useEffect(() => {
    if (!interactive || attachment.kind !== 'image') return
    const trigger = thumbnailTriggerRef.current
    if (!trigger || typeof IntersectionObserver === 'undefined') {
      setThumbnailVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setThumbnailVisible(Boolean(entry?.isIntersecting)),
      { rootMargin: '160px' }
    )
    observer.observe(trigger)
    return () => observer.disconnect()
  }, [attachment.kind, interactive])

  useEffect(() => {
    if (!thumbnailVisible) {
      thumbnailEpoch.current += 1
      setThumbnail(null)
      setThumbnailError(null)
      return
    }
    if (!interactive || !paneId || attachment.kind !== 'image') return
    const epoch = ++thumbnailEpoch.current
    setThumbnailError(null)
    void guiApi.attachmentPreview(paneId, attachment, 'thumbnail').then((result) => {
      if (thumbnailEpoch.current !== epoch) return
      const source = safePreviewSource(result)
      if (source) setThumbnail(source)
      else {
        setThumbnail(null)
        setThumbnailError(
          cleanFeedback(result.ok ? undefined : result.error, 'prévia indisponível')
        )
      }
    })
    return () => {
      thumbnailEpoch.current += 1
    }
  }, [attachment, interactive, paneId, thumbnailVisible])

  useEffect(() => {
    if (!lightboxOpen || !paneId || attachment.kind !== 'image') return
    const epoch = ++lightboxEpoch.current
    setLightboxLoading(true)
    setLightboxError(null)
    void guiApi
      .attachmentPreview(paneId, attachment, 'lightbox')
      .then((result) => {
        if (lightboxEpoch.current !== epoch) return
        const source = safePreviewSource(result)
        if (source) setLightboxSource(source)
        else {
          setLightboxSource(null)
          setLightboxError(
            cleanFeedback(result.ok ? undefined : result.error, 'prévia ampliada indisponível')
          )
        }
      })
      .finally(() => {
        if (lightboxEpoch.current === epoch) setLightboxLoading(false)
      })
    return () => {
      lightboxEpoch.current += 1
    }
  }, [attachment, lightboxOpen, paneId])

  const runAction = useCallback(
    async (action: GuiAttachmentAction): Promise<void> => {
      if (!paneId || actionPendingRef.current) return
      actionPendingRef.current = true
      setPendingAction(action)
      setActionFeedback(null)
      try {
        const result = await guiApi.attachmentAction(paneId, action, attachment)
        if (!result.ok && !result.cancelled) {
          setActionFeedback(cleanFeedback(result.error, 'não consegui concluir a ação'))
        } else if (result.ok && action === 'download') {
          setActionFeedback('Cópia salva')
        }
      } finally {
        actionPendingRef.current = false
        setPendingAction(null)
      }
    },
    [attachment, paneId]
  )

  const kind = attachmentLabel(attachment.kind)
  const size = formatSize(attachment.size)
  const thumbnailBusy =
    interactive &&
    attachment.kind === 'image' &&
    thumbnailVisible &&
    !thumbnail &&
    !thumbnailError
  const actionFailed = Boolean(actionFeedback && actionFeedback !== 'Cópia salva')
  const copy = (
    <span className="gui-attachment-copy">
      <span className="gui-attachment-name" title={attachment.name}>{attachment.name}</span>
      <span className="gui-attachment-meta">{kind}{size ? ` · ${size}` : ''}</span>
      {(thumbnailError || actionFeedback) && (
        <span className={`gui-attachment-feedback${thumbnailError || actionFailed ? ' error' : ''}`}
          role={thumbnailError || actionFailed ? 'alert' : 'status'}>
          {thumbnailError ?? actionFeedback}
        </span>
      )}
    </span>
  )
  const draftPreview = Boolean(onPreview && attachment.kind === 'image' && !presented)
  return (
    <li className="gui-attachment-chip" data-kind={attachment.kind}>
      {draftPreview ? (
        <button className="gui-attachment-draft-preview" type="button"
          aria-label={`Ver imagem ${attachment.name}`} aria-haspopup="dialog"
          onPointerDown={event => event.preventDefault()}
          onClick={() => onPreview?.(attachment.id)}>
          <span className="gui-attachment-kind" aria-hidden="true">{attachmentGlyph(attachment.kind)}</span>
          {copy}
        </button>
      ) : interactive && attachment.kind === 'image' ? (
        <button
          ref={thumbnailTriggerRef}
          className="gui-attachment-preview-trigger"
          type="button"
          disabled={thumbnailBusy}
          aria-label={`Ampliar imagem ${attachment.name}`}
          onClick={() => {
            setLightboxSource(thumbnail)
            setLightboxOpen(true)
          }}
        >
          {thumbnail ? (
            <img src={thumbnail} alt="" draggable={false} />
          ) : (
            <span className="gui-attachment-kind" aria-hidden="true">
              {thumbnailBusy ? '…' : attachmentGlyph(attachment.kind)}
            </span>
          )}
        </button>
      ) : (
        <span className="gui-attachment-kind" aria-hidden="true">
          {attachmentGlyph(attachment.kind)}
        </span>
      )}
      {!draftPreview && copy}
      {interactive && attachment.kind === 'file' && (
        <span className="gui-attachment-actions">
          <button
            type="button"
            disabled={pendingAction !== null}
            aria-label={`Abrir arquivo ${attachment.name}`}
            onClick={() => void runAction('open')}
          >
            Abrir
          </button>
          <button
            type="button"
            disabled={pendingAction !== null}
            aria-label={`Baixar arquivo ${attachment.name}`}
            onClick={() => void runAction('download')}
          >
            Baixar
          </button>
        </span>
      )}
      {onRemove && (
        <button
          className="gui-attachment-remove"
          type="button"
          aria-label={`Remover anexo ${attachment.name}`}
          onClick={() => onRemove(attachment.id)}
        >
          ×
        </button>
      )}
      {lightboxOpen && (
        <GuiAttachmentLightbox
          name={attachment.name}
          src={lightboxSource}
          loading={lightboxLoading}
          error={lightboxError}
          feedback={actionFeedback}
          downloading={pendingAction === 'download'}
          onDownload={() => void runAction('download')}
          onClose={closeLightbox}
        />
      )}
    </li>
  )
}

/** No local paths enter the DOM; both previews use the existing capability bridge. */
export default function GuiAttachmentChips({
  attachments,
  onRemove,
  paneId,
  presented = false,
  previewable = false,
  previewAnchorRef,
  className = ''
}: GuiAttachmentChipsProps): React.JSX.Element | null {
  const [selected, setSelected] = useState<{ paneId: string; id: string } | null>(null)
  const closePreview = useCallback(() => setSelected(null), [])
  const selectedAttachment = previewable && selected?.paneId === paneId
    ? attachments.find(attachment => attachment.id === selected?.id && attachment.kind === 'image')
    : undefined
  useEffect(() => {
    if (!selectedAttachment) setSelected(null)
  }, [selectedAttachment])
  if (attachments.length === 0) return null
  return (
    <>
    <ul className={`gui-attachment-chips ${className}`.trim()} aria-label="Anexos">
      {attachments.map((attachment) => (
        <GuiAttachmentChip
          key={attachment.id}
          attachment={attachment}
          paneId={paneId}
          presented={presented}
          onRemove={onRemove}
          onPreview={previewable && paneId ? id => setSelected({ paneId, id }) : undefined}
        />
      ))}
    </ul>
    {selectedAttachment && paneId && <GuiComposerImagePreview
      key={`${paneId}:${selectedAttachment.capability}`}
      paneId={paneId} attachment={selectedAttachment} anchorRef={previewAnchorRef} onClose={closePreview} />}
    </>
  )
}
