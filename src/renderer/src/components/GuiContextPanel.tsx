import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GuiContextPanelPresentation } from '../guiContextPanel'
import type { GuiOdometerPresentation, GuiSeatQuotaPresentation, GuiUsageGroupPresentation,
  GuiUsageMetersPresentation } from '../guiCostSignals'
import { guiContextPopoverLayout } from '../guiContextPopover'
import './GuiContextPanel.css'

interface Props {
  usage: GuiContextPanelPresentation | null
  /** Rótulo compacto do botão (por exemplo, `26% contexto`). */
  label: string
  /** R25.1 — o que esta conversa já custou de cota. `null` = o main ainda não
   *  contou nada, e a linha simplesmente não existe. */
  odometer?: GuiOdometerPresentation | null
  usageMeters?: GuiUsageMetersPresentation | null
  /** R25.2 — a cota REAL do seat desta conversa, do cache do poller. */
  seat?: GuiSeatQuotaPresentation | null
  /** R25.3b — a conversa cruzou o limiar de contexto pesado: a receita das
   *  três saídas (`guiHeavyConversationTip`). `null` = chip quieto. */
  heavy?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Mantém o grid do composer dono do posicionamento do indicador. */
  className?: string
}

export function GuiUsageGroup({ group }: { group: GuiUsageGroupPresentation }): React.JSX.Element {
  return (
    <div className="gui-context-cost gui-context-group">
      <dt>{group.label}</dt>
      <dd>
        <div>{group.valueLabel}</div>
        {group.weightLabel && <div>{group.weightLabel}</div>}
        {group.parcels.length > 0 && (
          <details className="gui-usage-breakdown">
            <summary>parcelas em tokens</summary>
            <dl>
              {group.parcels.map(parcel => (
                <div key={parcel.key}>
                  <dt>{parcel.label}</dt>
                  <dd>{parcel.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
        <p className="gui-context-physics">{group.scopeNote}</p>
      </dd>
    </div>
  )
}

/**
 * Indicador de contexto do composer.
 *
 * O painel é um popover de leitura: foco entra no diálogo ao abrir, Esc fecha
 * e devolve o foco ao gatilho. Não há ação escondida nem comando CLI paralelo;
 * os números são somente a última fotografia canônica do store.
 *
 * R25 — ele passa a responder DUAS perguntas, e não uma: "quanto ainda cabe"
 * (a janela) e "quanto isto já custou" (o odômetro da conversa + a cota do
 * seat). São réguas diferentes e por isso ficam em GRUPOS separados na mesma
 * lista, com um fio entre eles — mesma forma, mesma grade, sem card novo.
 */
export default function GuiContextPanel({
  usage,
  label,
  odometer = null,
  usageMeters = null,
  seat = null,
  heavy = null,
  open,
  onOpenChange,
  className
}: Props): React.JSX.Element | null {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const wasOpenRef = useRef(false)
  const panelId = useId()
  const titleId = `${panelId}-title`
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)
  const hasUsage = usage !== null

  useLayoutEffect(() => {
    setPortalRoot(open && hasUsage
      ? triggerRef.current?.closest<HTMLElement>('.gui-pane') ?? document.body
      : null)
  }, [open, hasUsage])

  useLayoutEffect(() => {
    const panel = panelRef.current, trigger = triggerRef.current
    if (!open || !portalRoot || !panel || !trigger) return
    const measure = (): void => {
      const rootBox = portalRoot.getBoundingClientRect()
      const origin = { left: rootBox.left + portalRoot.clientLeft, top: rootBox.top + portalRoot.clientTop }
      const pane = { ...origin, right: origin.left + portalRoot.clientWidth, bottom: origin.top + portalRoot.clientHeight }
      const anchor = trigger.getBoundingClientRect()
      const viewport = { width: window.innerWidth, height: window.innerHeight }
      const scrollTop = panel.scrollTop
      panel.style.width = `${guiContextPopoverLayout(anchor, pane, viewport, 0).width}px`
      panel.style.maxHeight = 'none'
      const position = guiContextPopoverLayout(anchor, pane, viewport, panel.getBoundingClientRect().height)
      Object.assign(panel.style, { left: `${position.left - origin.left}px`, top: `${position.top - origin.top}px`,
        maxHeight: `${position.maxHeight}px` })
      panel.scrollTop = scrollTop
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(portalRoot)
    observer.observe(trigger)
    observer.observe(panel)
    const onScroll = (event: Event): void => {
      if (event.target instanceof Node && panel.contains(event.target)) return
      measure()
    }
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, portalRoot])

  useLayoutEffect(() => {
    if (open) {
      if (!portalRoot) return
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
  }, [open, portalRoot])

  // MEDIÇÃO QUE SOME FECHA PELO CAMINHO NORMAL. Sem `usage` o componente
  // inteiro desmonta (return null abaixo) — se isso acontecer com o popover
  // ABERTO, o diálogo é arrancado com o foco dentro dele e o efeito de
  // restauração nunca roda: o foco cai no <body>. Acontece de verdade: a
  // compactação do Codex zera os dois números de uma vez. Avisar o dono do
  // estado faz o fechamento passar pela mesma porta do Esc.
  useEffect(() => {
    if (!usage && open) onOpenChange(false)
  }, [usage, open, onOpenChange])

  if (!usage) return null

  const rootClass = ['gui-menu-host', 'gui-context-panel', className].filter(Boolean).join(' ')
  // R25.3b — a conversa pesada avisa AQUI, não no fio: o tooltip do chip ganha
  // a receita, o chip muda de FORMA (moldura tracejada — o mesmo vocabulário
  // de "atenção sem alarme" do pulso) e o painel aberto repete a linha.
  const tip = heavy ? `${usage.tooltip}\n${heavy}` : usage.tooltip

  return (
    <div className={rootClass}>
      <button
        ref={triggerRef}
        className={`gui-context-trigger${heavy ? ' heavy' : ''}`}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Contexto da conversa: ${tip}`}
        data-tip={tip}
        onClick={() => onOpenChange(!open)}
      >
        <span className="gui-context-trigger-bar" aria-hidden="true">
          <i style={{ width: `${usage.percent}%` }} />
        </span>
        <span className="gui-context-trigger-label">{label}</span>
        <span className="gui-context-trigger-percent" aria-hidden="true">{usage.percent}%</span>
      </button>

      {open && portalRoot && createPortal(
        <div
          ref={panelRef}
          id={panelId}
          className="gui-context-popover gui-menu-host"
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
              {/* "usados" prometia o gasto da última pergunta; o número sempre
                  foi a ocupação da janela pela conversa toda. */}
              <dt>contexto</dt>
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
                <dt>USD do motor · sessão</dt>
                <dd>{usage.costLabel}</dd>
              </div>
            )}
            {/* R25 — a segunda régua: o que a conversa JÁ CUSTOU de cota. Fio
                acima porque é outra classe de informação, como a nota de
                escopo — os números acima descrevem a janela, estes o gasto.
                E a FORMA muda junto: aqui o rótulo fica ACIMA do valor. Não é
                enfeite — estes valores são frases curtas ("139 chamadas · ~3.6
                mi tokens-peso"), e espremê-los na coluna direita das linhas de
                cima os quebraria em duas linhas tortas a cada medição. */}
            {usageMeters?.round && <GuiUsageGroup group={usageMeters.round} />}
            {usageMeters?.conversation && <GuiUsageGroup group={usageMeters.conversation} />}
            {!usageMeters?.conversation && odometer && (
              <div className="gui-context-cost gui-context-group">
                <dt>total da conversa</dt>
                <dd className={`gui-context-signal ${odometer.tone}`}>{odometer.valueLabel}</dd>
              </div>
            )}
            {seat && (
              <div className={`gui-context-cost${odometer ? '' : ' gui-context-group'}`}>
                <dt>
                  cota da conta · {seat.label}
                  {seat.ageLabel && <i className="gui-context-age">{seat.ageLabel}</i>}
                </dt>
                <dd className={`gui-context-signal ${seat.tone}`}>{seat.valueLabel}</dd>
                <dd className="gui-context-physics">Compartilhada por todas as tarefas desta conta.</dd>
              </div>
            )}
          </dl>
          {usageMeters ? <p className="gui-context-physics">{usageMeters.hint}</p>
            : odometer && <p className="gui-context-physics">{odometer.hint}</p>}
          {heavy && <p className="gui-context-heavy">{heavy}</p>}
          <p className="gui-context-scope">{usage.scopeNote}</p>
        </div>, portalRoot
      )}
    </div>
  )
}
