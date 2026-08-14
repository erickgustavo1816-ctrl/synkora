import { useId, useLayoutEffect, useRef } from 'react'
import type { GuiContextPanelPresentation } from '../guiContextPanel'

interface Props {
  usage: GuiContextPanelPresentation | null
  /** Rótulo compacto do botão (por exemplo, `26% contexto`). */
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Mantém o grid do composer dono do posicionamento do indicador. */
  className?: string
}

/**
 * Indicador de contexto do composer.
 *
 * O painel é um popover de leitura: foco entra no diálogo ao abrir, Esc fecha
 * e devolve o foco ao gatilho. Não há ação escondida nem comando CLI paralelo;
 * os números são somente a última fotografia canônica do store.
 */
export default function GuiContextPanel({
  usage,
  label,
  open,
  onOpenChange,
  className
}: Props): React.JSX.Element | null {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef(false)
  const panelId = useId()
  const titleId = `${panelId}-title`

  useLayoutEffect(() => {
    if (open) {
      wasOpenRef.current = true
      panelRef.current?.focus({ preventScroll: true })
      return
    }
    if (!wasOpenRef.current) return
    wasOpenRef.current = false

    // Se outro controle já tomou o foco (por exemplo, o seletor de modelo),
    // não o roube de volta. No caminho de Esc/fechar, o foco ainda está no
    // diálogo e volta para o gatilho como exige o contrato do popover.
    const active = document.activeElement
    if (
      active === triggerRef.current ||
      active === document.body ||
      active === null ||
      (active instanceof HTMLElement && !active.isConnected) ||
      panelRef.current?.contains(active)
    ) {
      triggerRef.current?.focus({ preventScroll: true })
    }
  }, [open])

  if (!usage) return null

  const rootClass = ['gui-menu-host', 'gui-context-panel', className].filter(Boolean).join(' ')

  return (
    <div className={rootClass}>
      <button
        ref={triggerRef}
        className="gui-context-trigger"
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Contexto da conversa: ${usage.tooltip}`}
        data-tip={usage.tooltip}
        onClick={() => onOpenChange(!open)}
      >
        <span className="gui-context-trigger-bar" aria-hidden="true">
          <i style={{ width: `${usage.percent}%` }} />
        </span>
        <span>{label}</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          className="gui-context-popover"
          role="dialog"
          tabIndex={-1}
          aria-labelledby={titleId}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            onOpenChange(false)
          }}
        >
          <div className="gui-context-popover-head">
            <strong id={titleId}>Uso de contexto</strong>
            <button
              className="gui-context-close"
              type="button"
              aria-label="Fechar painel de contexto"
              onClick={() => onOpenChange(false)}
            >
              ×
            </button>
          </div>
          <dl className="gui-context-metrics">
            <div>
              <dt>usados</dt>
              <dd>{usage.contextTokensLabel} tokens</dd>
            </div>
            <div>
              <dt>janela</dt>
              <dd>{usage.contextWindowLabel} tokens</dd>
            </div>
            <div>
              <dt>percentual</dt>
              <dd>{usage.percentLabel}</dd>
            </div>
            {usage.costLabel && (
              <div>
                <dt>custo</dt>
                <dd>{usage.costLabel}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
    </div>
  )
}
