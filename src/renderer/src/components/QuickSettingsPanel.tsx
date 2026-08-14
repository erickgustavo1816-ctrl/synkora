import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { SynkoraPreferences } from '../../../preload'
import { useStore } from '../store'
import {
  CHAT_SOUND_CHOICE,
  NoticeSwitch,
  WINDOWS_CHOICES,
  type NoticePreference
} from './ChatNoticeSettings'

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface QuickSettingsPanelProps {
  open: boolean
  onClose: () => void
  returnFocusRef?: React.RefObject<HTMLElement | null>
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.getClientRects().length > 0
  )
}

/**
 * Gaveta global, curta e deliberadamente limitada aos avisos já suportados
 * pelo contrato de settings. O painel é portalizado para sair do stacking
 * context do host e o host continua responsável por esconder/congelar Panes.
 */
export default function QuickSettingsPanel({
  open,
  onClose,
  returnFocusRef
}: QuickSettingsPanelProps): React.JSX.Element | null {
  const settings = useStore((state) => state.settings)
  const patchSettings = useStore((state) => state.patchSettings)
  const panelRef = useRef<HTMLElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return

    restoreFocusRef.current =
      returnFocusRef?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)

    const frame = window.requestAnimationFrame(() => {
      const panel = panelRef.current
      const [first] = panel ? focusableElements(panel) : []
      const target = first ?? panel
      target?.focus()
    })

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const panel = panelRef.current
      if (!panel) return
      const controls = focusableElements(panel)
      if (controls.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = controls[0]
      const last = controls[controls.length - 1]
      const active = document.activeElement
      if (!panel.contains(active)) {
        event.preventDefault()
        first.focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onKeyDown, true)
      window.requestAnimationFrame(() => {
        const target = returnFocusRef?.current ?? restoreFocusRef.current
        if (target?.isConnected) target.focus()
      })
    }
  }, [open, returnFocusRef])

  if (!open) return null

  const checked = (key: NoticePreference): boolean => settings?.[key] ?? true
  const update = (key: NoticePreference, value: boolean): void => {
    void patchSettings({ [key]: value } as Pick<SynkoraPreferences, NoticePreference>)
  }

  return createPortal(
    <div
      className="quick-settings-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        ref={panelRef}
        id="quick-settings-panel"
        className="quick-settings-panel term-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-settings-title"
        tabIndex={-1}
      >
        <header className="quick-settings-head">
          <div>
            <span className="quick-settings-kicker">ajustes do dia</span>
            <h2 id="quick-settings-title">Ajustes rápidos</h2>
            <p>Sinais do chat que acompanham todos os seus universos.</p>
          </div>
          <button
            type="button"
            className="quick-settings-close"
            aria-label="Fechar ajustes rápidos"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="quick-settings-body">
          <fieldset>
            <legend>Avisos do chat</legend>
            {WINDOWS_CHOICES.map((choice) => (
              <NoticeSwitch
                key={choice.key}
                choice={choice}
                checked={checked(choice.key)}
                onChange={update}
                className="quick-settings-switch"
              />
            ))}
          </fieldset>

          <fieldset>
            <legend>Som</legend>
            <NoticeSwitch
              choice={CHAT_SOUND_CHOICE}
              checked={checked(CHAT_SOUND_CHOICE.key)}
              onChange={update}
              className="quick-settings-switch"
            />
            <p className="quick-settings-note">
              Os sinais visuais continuam ativos quando o som é desligado.
            </p>
          </fieldset>
        </div>
      </section>
    </div>,
    document.body
  )
}
