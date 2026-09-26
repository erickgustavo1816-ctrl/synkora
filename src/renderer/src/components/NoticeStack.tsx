import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  dismissNotice,
  noticeAutoCloseSeconds,
  noticeRole,
  noticeSentence,
  pushNotice,
  shownNotices,
  type Notice,
  type NoticeCorner,
  type NoticeSpec,
  type NoticeTone
} from '../noticeStack'
import './NoticeStack.css'

// A pilha de avisos flutuantes (mockup: docs/mockups/avisos-2026-09-26.html).
// A regra mora em `noticeStack.ts`; aqui só o desenho e o relógio de saída.

const STAMP_GLYPH: Record<NoticeTone, string> = { queued: '⇪', warn: '!', error: '✕', info: 'i' }

/** a saída anima ~190ms; o timeout garante a remoção mesmo sem `animationend`
 *  (janela oculta congela a linha do tempo das animações) */
const LEAVE_MS = 200

export interface NoticeStackState {
  notices: Notice[]
  push: (spec: NoticeSpec) => void
  dismiss: (id: number) => void
}

/** O estado de uma pilha: cada tela (Board, Backlog) tem a sua. */
export function useNoticeStack(): NoticeStackState {
  const [notices, setNotices] = useState<Notice[]>([])
  const nextId = useRef(1)
  const push = useCallback((spec: NoticeSpec) => {
    const id = nextId.current++
    setNotices((stack) => pushNotice(stack, spec, id))
  }, [])
  const dismiss = useCallback((id: number) => setNotices((stack) => dismissNotice(stack, id)), [])
  return { notices, push, dismiss }
}

function NoticeStamp({ tone }: { tone: NoticeTone }): React.JSX.Element {
  return (
    <span className="notice-stamp" aria-hidden="true">
      <span>{STAMP_GLYPH[tone]}</span>
    </span>
  )
}

export function NoticeStack({
  notices,
  onDismiss,
  corner,
  autoCloseSeconds
}: {
  notices: readonly Notice[]
  onDismiss: (id: number) => void
  corner: NoticeCorner
  autoCloseSeconds: number
}): React.JSX.Element {
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(() => new Set())
  const timers = useRef(new Map<number, number>())
  useEffect(() => {
    const pending = timers.current
    return () => pending.forEach((t) => window.clearTimeout(t))
  }, [])
  const close = useCallback(
    (id: number) => {
      if (timers.current.has(id)) return
      setLeaving((prev) => new Set(prev).add(id))
      timers.current.set(
        id,
        window.setTimeout(() => {
          timers.current.delete(id)
          setLeaving((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          onDismiss(id)
        }, LEAVE_MS)
      )
    },
    [onDismiss]
  )
  const { shown, hiddenCount } = shownNotices(notices)
  return (
    <div className={`notice-stack${corner === 'top' ? ' at-top' : ''}`} aria-live="polite">
      {hiddenCount > 0 && (
        <span className="notice-more">
          +{hiddenCount} {hiddenCount > 1 ? 'avisos' : 'aviso'}
        </span>
      )}
      {shown.map((n) => {
        const ttl = noticeAutoCloseSeconds(n.tone, autoCloseSeconds)
        return (
          <div
            key={n.id}
            className={`notice${leaving.has(n.id) ? ' is-leaving' : ''}`}
            data-tone={n.tone}
            role={noticeRole(n.tone)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.stopPropagation()
              close(n.id)
            }}
          >
            <NoticeStamp tone={n.tone} />
            <div className="notice-head">
              <span className="notice-title">{n.title}</span>
              {n.chip && <span className="notice-chip">{n.chip}</span>}
            </div>
            <button
              type="button"
              className="notice-close"
              aria-label="Fechar aviso"
              data-tip="Fechar aviso"
              onClick={() => close(n.id)}
            >
              ×
            </button>
            <p className="notice-body">{n.body}</p>
            {(n.context || n.action) && (
              <div className="notice-foot">
                <span className="notice-context">
                  {n.context && (
                    <>
                      {n.contextKind ?? 'missão'} · <b>{n.context}</b>
                    </>
                  )}
                </span>
                {n.action && (
                  <button
                    type="button"
                    className="btn notice-action"
                    onClick={() => {
                      n.action?.run()
                      close(n.id)
                    }}
                  >
                    {n.action.label}
                  </button>
                )}
              </div>
            )}
            {ttl > 0 && (
              <span
                className="notice-timer"
                style={{ '--notice-ttl': `${ttl}s` } as CSSProperties}
                onAnimationEnd={() => close(n.id)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/** A mesma anatomia DENTRO de uma janela (erro de formulário): no lugar, sem
 *  flutuar e sem sombra. */
export function InlineNotice({
  tone,
  title,
  children
}: {
  tone: NoticeTone
  title?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="notice is-inline" data-tone={tone} role={noticeRole(tone)}>
      <NoticeStamp tone={tone} />
      {title && (
        <div className="notice-head">
          <span className="notice-title">{title}</span>
        </div>
      )}
      <p className="notice-body">{typeof children === 'string' ? noticeSentence(children) : children}</p>
    </div>
  )
}
