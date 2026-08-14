import { useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserObserverSnapshot, BrowserScreenshotMeta } from '../../../preload'
import { guiApi } from '../guiApi'

interface Props {
  paneId: string
  active: boolean
}

const TIME_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

function formatTime(value: number): string {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? TIME_FORMAT.format(date) : 'horário indisponível'
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function sourceLabel(frame: BrowserScreenshotMeta): string {
  return frame.source === 'playwright' ? '.playwright-mcp' : '.synkora/attachments'
}

function mimeLabel(frame: BrowserScreenshotMeta): string {
  return frame.mime.replace('image/', '').toUpperCase()
}

export default function BrowserObserverPanel({ paneId, active }: Props): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<BrowserObserverSnapshot>({
    paneId,
    status: 'stopped'
  })
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [frameError, setFrameError] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const imageUrlRef = useRef<string | null>(null)
  const frameRequestRef = useRef(0)
  const expandButtonRef = useRef<HTMLButtonElement>(null)
  const bridgeAvailable = guiApi.browserObserverAvailable()

  useEffect(() => {
    let alive = true
    let pushed = false
    const unsubscribe = guiApi.onBrowserObserver((next) => {
      if (!alive || next.paneId !== paneId) return
      pushed = true
      setSnapshot(next)
      setActionError(null)
    })
    void guiApi.browserObserverState(paneId).then((next) => {
      if (alive && !pushed) setSnapshot(next)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [paneId])

  const frameId = snapshot.frame?.id
  useEffect(() => {
    const request = ++frameRequestRef.current
    const previous = imageUrlRef.current
    if (previous) URL.revokeObjectURL(previous)
    imageUrlRef.current = null
    setImageUrl(null)
    setFrameError(null)
    if (!frameId || !active) return

    let cancelled = false
    void guiApi.browserObserverFrame(paneId, frameId).then((result) => {
      if (cancelled || request !== frameRequestRef.current) return
      if (!result.ok) {
        setFrameError(result.error)
        return
      }
      const url = URL.createObjectURL(new Blob([result.bytes], { type: result.mime }))
      if (cancelled || request !== frameRequestRef.current) {
        URL.revokeObjectURL(url)
        return
      }
      imageUrlRef.current = url
      setImageUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [active, frameId, paneId])

  useEffect(
    () => () => {
      frameRequestRef.current += 1
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current)
      imageUrlRef.current = null
    },
    []
  )

  useEffect(() => {
    if (snapshot.frame) return
    setExpanded(false)
  }, [snapshot.frame])

  useEffect(() => {
    if (!expanded) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setExpanded(false)
      window.setTimeout(() => expandButtonRef.current?.focus({ preventScroll: true }), 0)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [expanded])

  const statusLabel = snapshot.status === 'watching' ? 'observando' : 'parado'
  const frame = snapshot.frame
  const dimensionLabel = useMemo(() => {
    if (!frame?.width || !frame.height) return null
    return `${frame.width} × ${frame.height}`
  }, [frame?.height, frame?.width])

  const toggleObservation = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setActionError(null)
    const result =
      snapshot.status === 'watching'
        ? await guiApi.browserObserverStop(paneId)
        : await guiApi.browserObserverStart(paneId)
    if (result.ok) setSnapshot(result.snapshot)
    else setActionError(result.error)
    setBusy(false)
  }

  return (
    <section
      className={`gui-browser-observer${expanded ? ' expanded' : ''}`}
      aria-label="Observação local do navegador"
      role={expanded ? 'dialog' : undefined}
    >
      <div className="gui-browser-head">
        <span className="gui-browser-mark" aria-hidden="true">
          ◉
        </span>
        <span className="gui-browser-title">navegador</span>
        <span className={`gui-browser-status ${snapshot.status}`}>
          <i aria-hidden="true" />
          {statusLabel}
        </span>
        {frame && (
          <span className="gui-browser-time">arquivo salvo às {formatTime(frame.modifiedAt)}</span>
        )}
        <span className="gui-browser-actions">
          <button
            className="gui-browser-btn"
            type="button"
            disabled={busy || !bridgeAvailable}
            aria-label={
              snapshot.status === 'watching'
                ? 'Parar observação local'
                : 'Começar observação local'
            }
            data-tip={
              snapshot.status === 'watching'
                ? 'Parar de acompanhar novos arquivos'
                : 'Acompanhar arquivos locais — não abre navegador'
            }
            onClick={() => void toggleObservation()}
          >
            {busy
              ? 'aguarde…'
              : snapshot.status === 'watching'
                ? 'parar'
                : 'começar'}
          </button>
          {frame && (
            <button
              ref={expandButtonRef}
              className="gui-browser-btn"
              type="button"
              disabled={!imageUrl && !expanded}
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? 'fechar' : 'expandir'}
            </button>
          )}
        </span>
      </div>

      {!bridgeAvailable && (
        <div className="gui-browser-message" role="status">
          observação local indisponível nesta janela
        </div>
      )}

      {bridgeAvailable && snapshot.status === 'watching' && !frame && (
        <div className="gui-browser-message" role="status">
          aguardando uma imagem em .playwright-mcp ou nos anexos deste pane
        </div>
      )}

      {frame && (
        <div className="gui-browser-body">
          <div className="gui-browser-preview">
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={`Última imagem local: ${frame.name}`}
                onError={() => {
                  if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current)
                  imageUrlRef.current = null
                  setImageUrl(null)
                  setFrameError('o arquivo não pôde ser exibido como imagem')
                }}
              />
            ) : (
              <span>{frameError ?? 'carregando a última imagem…'}</span>
            )}
          </div>
          <dl className="gui-browser-meta">
            <div>
              <dt>arquivo</dt>
              <dd title={frame.name}>{frame.name}</dd>
            </div>
            <div>
              <dt>origem local</dt>
              <dd>{sourceLabel(frame)}</dd>
            </div>
            <div>
              <dt>formato</dt>
              <dd>{mimeLabel(frame)}</dd>
            </div>
            <div>
              <dt>tamanho</dt>
              <dd>{formatBytes(frame.bytes)}</dd>
            </div>
            {dimensionLabel && (
              <div>
                <dt>dimensões</dt>
                <dd>{dimensionLabel}</dd>
              </div>
            )}
            <div>
              <dt>detectado às</dt>
              <dd>{formatTime(frame.observedAt)}</dd>
            </div>
          </dl>
        </div>
      )}

      {(actionError || snapshot.note) && (
        <div className="gui-browser-error" role="alert">
          {actionError ?? snapshot.note}
        </div>
      )}

      {(frame || snapshot.status === 'watching') && (
        <p className="gui-browser-scope">
          Este modo recebe só a imagem local. URL, título, clique e cursor não são fornecidos.
        </p>
      )}
    </section>
  )
}
