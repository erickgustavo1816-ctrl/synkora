import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { PaneActivity, PaneKind, PaneStats } from '../store'

export type PaneRole =
  | 'maestro'
  | 'orquestrador'
  | 'dev'
  | 'review'
  | 'qa'
  | 'ajudante'
  | 'livre'

const ROLE_LABEL: Record<PaneRole, string> = {
  maestro: 'MAESTRO',
  orquestrador: 'ORQUESTRADOR',
  dev: 'DEV',
  review: 'REVIEW',
  qa: 'QA',
  ajudante: 'AJUDANTE',
  livre: 'LIVRE'
}

// Em panes muito estreitos o nome do papel cede lugar ao simbolo para os
// controles de janela continuarem acessiveis. O texto completo fica no tooltip.
const ROLE_SYMBOL: Record<PaneRole, string> = {
  maestro: '♛',
  orquestrador: '◇',
  dev: '⌘',
  review: '✓',
  qa: '◆',
  ajudante: '✦',
  livre: '•'
}

// Hue padrão por papel (dev herda o hue do departamento quando conhecido).
const ROLE_HUE: Record<PaneRole, number> = {
  maestro: 21,
  orquestrador: 21,
  dev: 21,
  review: 265,
  qa: 145,
  ajudante: 45,
  livre: 190
}

// Paths oficiais (Simple Icons, viewBox 24x24): marca do CLI no titlebar.
const CLAUDE_PATH =
  'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'
const OPENAI_PATH =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z'

/** Marca do CLI no lugar dos dots: claude → logo Claude, codex → logo OpenAI. */
function CliLogo({ kind }: { kind: PaneKind }): React.JSX.Element {
  if (kind === 'shell') return <span className="pane-logo shell">&gt;_</span>
  const path = kind === 'claude' ? CLAUDE_PATH : OPENAI_PATH
  return (
    <span
      className={`pane-logo ${kind}`}
      data-tip={kind === 'claude' ? 'Claude Code' : 'OpenAI Codex'}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d={path} fill="currentColor" />
      </svg>
    </span>
  )
}

/** Telemetria zerada de um pane recém-nascido (JSONL da sessão ainda não
 *  existe) — padronização: os badges ↓/↑ e contexto aparecem desde o 1º frame. */
export const ZERO_STATS: PaneStats = {
  inputTokens: 0,
  outputTokens: 0,
  contextTokens: null,
  contextWindow: null
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

function fmtExactTokens(n: number): string {
  return Math.max(0, Math.round(n)).toLocaleString('pt-BR')
}

/** Explica o total real: no Claude, cada tool call processa novamente o
 * contexto e boa parte dele costuma vir do cache. O número grande continua
 * correto, mas o detalhamento impede confundir cache lido com entrada nova. */
function tokenUsageTip(stats: PaneStats): string {
  const breakdown: string[] = []
  if (stats.freshInputTokens != null)
    breakdown.push(`nova ${fmtExactTokens(stats.freshInputTokens)}`)
  if (stats.cacheReadInputTokens != null)
    breakdown.push(`cache lido ${fmtExactTokens(stats.cacheReadInputTokens)}`)
  if (stats.cacheWriteInputTokens != null)
    breakdown.push(`cache criado ${fmtExactTokens(stats.cacheWriteInputTokens)}`)
  const detail = breakdown.length > 0 ? ` (${breakdown.join(' · ')})` : ''
  return `tokens processados nesta sessão — entrada total ${fmtExactTokens(stats.inputTokens)}${detail} · saída ${fmtExactTokens(stats.outputTokens)}`
}

/** Id de modelo → nome BONITO: "claude-opus-4-8" → OPUS 4.8 · "opus[1m]" →
 *  OPUS 1M · "gpt-5.2-codex" → GPT-5.2 CODEX. */
export function prettyModel(id: string): string {
  let s = id.trim()
  const oneM = /\[1m\]/i.test(s) || /-1m$/i.test(s)
  s = s
    .replace(/\[1m\]/i, '')
    .replace(/^claude-/i, '')
    .replace(/-\d{8}$/, '') // sufixo de data dos ids completos
  const claude = s.match(/^(opus|sonnet|haiku|fable|mythos)[-.]?(\d+(?:[-.]\d+)*)?/i)
  if (claude) {
    const name = claude[1].toUpperCase()
    const ver = claude[2] ? claude[2].replace(/-/g, '.') : ''
    return `${name}${ver ? ` ${ver}` : ''}${oneM ? ' 1M' : ''}`
  }
  const gpt = s.match(/^gpt-?(\d+(?:\.\d+)*)?-?(.*)$/i)
  if (gpt) {
    const ver = gpt[1] ? `-${gpt[1]}` : ''
    const rest = gpt[2] ? ` ${gpt[2].replace(/-/g, ' ').toUpperCase()}` : ''
    return `GPT${ver}${rest}`.trim()
  }
  return s.replace(/-/g, ' ').toUpperCase()
}

interface Props {
  role?: PaneRole
  kind: PaneKind
  /** hue do departamento (número ou `var(--hue-<função>)` — sobrepõe o hue
   *  padrão do papel; a var acompanha a cor editada pelo usuário ao vivo) */
  deptHue?: number | string
  seatName?: string
  model?: string
  /** effort do modelo (badge [HIGH] na cor do papel) */
  effort?: string
  title: string
  /** estado vivo do PTY: ● rodando / ◌ esperando / ■ parado */
  activity?: PaneActivity
  stats?: PaneStats
  /** ancora a telemetria no grupo direito (usado pelo orquestrador) */
  pinStats?: boolean
  focused?: boolean
  onToggleFocus?: () => void
  /** Faz este pane ocupar a altura inteira, com os demais ao lado. */
  onMakeColumn?: () => void
  /** Faz este pane ocupar a largura inteira, com os demais abaixo. */
  onMakeRow?: () => void
  onClose?: () => void
  closeTitle?: string
  /** botões extras (ex.: ▣ terminal do handoff) */
  children?: ReactNode
  /** informação extra que pode ceder espaço sem empurrar as ações para fora */
  details?: ReactNode
  /** referências essenciais, ancoradas à direita antes do estado do pane */
  priorityDetails?: ReactNode
  /** arrastar a JANELA pelo titlebar (canvas de panes livres) */
  onDragStart?: (e: React.PointerEvent<HTMLDivElement>) => void
}

/**
 * Titlebar padrão dos panes (estilo overclock): marca do CLI, chip de papel
 * colorido, seat, título e badges ao vivo de tokens/contexto/custo/modelo.
 */
const ACTIVITY_UI: Record<PaneActivity, { glyph: string; label: string }> = {
  run: { glyph: '●', label: 'rodando' },
  idle: { glyph: '◌', label: 'esperando' },
  dead: { glyph: '■', label: 'parado' }
}

export default function PaneChrome({
  role,
  kind,
  deptHue,
  seatName,
  model,
  effort,
  title,
  activity,
  stats,
  pinStats = false,
  focused,
  onToggleFocus,
  onMakeColumn,
  onMakeRow,
  onClose,
  closeTitle,
  children,
  details,
  priorityDetails,
  onDragStart
}: Props): React.JSX.Element {
  const barRef = useRef<HTMLDivElement>(null)
  const hue = deptHue ?? (role ? ROLE_HUE[role] : undefined)
  const ctxPct =
    stats && stats.contextTokens != null && stats.contextWindow
      ? Math.min(100, Math.round((stats.contextTokens / stats.contextWindow) * 100))
      : null
  // prop primeiro: os callers passam o valor VIVO detectado no TUI (pty:model),
  // que muda na hora da troca via /model — o JSONL (stats.model) só atualiza
  // na mensagem/turno seguinte, então é fallback.
  const shownModel = model ?? stats?.model
  const statsView = stats ? (
    <>
      <span
        className="stat-chip tokens"
        data-tip={tokenUsageTip(stats)}
        aria-label={tokenUsageTip(stats)}
      >
        ↓{fmtTokens(stats.inputTokens)} ↑{fmtTokens(stats.outputTokens)}
      </span>
      <span
        className={`stat-chip ctx ${ctxPct == null || ctxPct < 60 ? 'ok' : ctxPct >= 85 ? 'crit' : 'warn'}`}
        data-tip={
          ctxPct != null
            ? `contexto: ${fmtTokens(stats.contextTokens ?? 0)} de ${fmtTokens(stats.contextWindow ?? 0)}`
            : 'contexto: aguardando a sessão do CLI'
        }
      >
        <i className="ctx-bar">
          <b style={{ width: `${ctxPct ?? 0}%` }} />
        </i>
        {ctxPct != null ? `${ctxPct}%` : '–'}
      </span>
      {stats.costUsd != null && (
        <span className="stat-chip cost" data-tip="custo acumulado (reportado pelo CLI)">
          ${stats.costUsd.toFixed(2)}
        </span>
      )}
    </>
  ) : null

  useLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return

    const fitClasses = [
      'fit-hide-title',
      'fit-hide-seat',
      'fit-hide-task',
      'fit-hide-cost',
      'fit-hide-button-labels',
      'fit-hide-state-label',
      'fit-compact-role',
      'fit-compact-context',
      'fit-hide-tokens',
      'fit-hide-context',
      'fit-compact-refs',
      'fit-hide-effort',
      'fit-hide-model'
    ] as const

    const clearFit = (): void => {
      bar.classList.remove(...fitClasses)
    }

    const hasRoom = (): boolean => {
      const info = bar.querySelector<HTMLElement>('.pane-info')
      const actions = bar.querySelector<HTMLElement>('.pane-actions')
      if (!info || !actions) return true

      const barStyle = getComputedStyle(bar)
      const infoStyle = getComputedStyle(info)
      const padding =
        (Number.parseFloat(barStyle.paddingLeft) || 0) +
        (Number.parseFloat(barStyle.paddingRight) || 0)
      const barGap = Number.parseFloat(barStyle.columnGap || barStyle.gap) || 0
      const infoGap = Number.parseFloat(infoStyle.columnGap || infoStyle.gap) || 0

      // O título é o único item elástico. Medimos os demais pela largura real,
      // inclusive após trocar fonte/zoom, e reservamos apenas os gaps que de
      // fato existem. Assim todo papel reduz no ponto de colisão, não num
      // breakpoint estimado para outra máquina.
      const visibleInfoItems = Array.from(info.children).filter((node) => {
        const element = node as HTMLElement
        return getComputedStyle(element).display !== 'none'
      }) as HTMLElement[]
      const fixedInfoWidth = visibleInfoItems.reduce(
        (total, element) =>
          element.classList.contains('pane-title')
            ? total
            : total + element.getBoundingClientRect().width,
        0
      )
      const infoGaps = Math.max(0, visibleInfoItems.length - 1) * infoGap
      const actionsWidth = actions.getBoundingClientRect().width
      const required = padding + fixedInfoWidth + infoGaps + barGap + actionsWidth

      return required <= bar.clientWidth + 0.5
    }

    const fit = (): void => {
      clearFit()
      for (const className of fitClasses) {
        if (hasRoom()) break
        bar.classList.add(className)
      }
    }

    let frame = 0
    const scheduleFit = (): void => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    }

    fit()
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(bar)
    window.addEventListener('resize', scheduleFit)
    document.fonts?.addEventListener('loadingdone', scheduleFit)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', scheduleFit)
      document.fonts?.removeEventListener('loadingdone', scheduleFit)
      clearFit()
    }
  }, [
    activity,
    children,
    details,
    effort,
    pinStats,
    priorityDetails,
    seatName,
    shownModel,
    stats?.contextTokens,
    stats?.contextWindow,
    stats?.costUsd,
    stats?.inputTokens,
    stats?.outputTokens,
    title
  ])

  return (
    <div
      ref={barRef}
      className={`pane-bar term-titlebar pane-adaptive${onDragStart ? ' draggable' : ''}`}
      // Todo o chrome é uma alça, exceto controles interativos. Assim o pane
      // pode ser pego pelo nome/chips como numa janela.
      onPointerDown={
        onDragStart
          ? (e) => {
              const target = e.target as HTMLElement
              if (target.closest('button, input, select, textarea, a')) return
              onDragStart(e)
            }
          : undefined
      }
    >
      <span className="pane-info">
        <CliLogo kind={kind} />
        {role && (
          <span
            className="role-chip"
            style={{ ['--chip-hue' as string]: hue }}
            data-tip={ROLE_LABEL[role]}
            aria-label={ROLE_LABEL[role]}
          >
            <span className="role-label">{ROLE_LABEL[role]}</span>
            <span className="role-symbol" aria-hidden="true">
              {ROLE_SYMBOL[role]}
            </span>
          </span>
        )}
        {seatName && <span className="seat-chip-mini">{seatName}</span>}
        {/* modelo + effort na COR DO PAPEL (decisão do usuário): [OPUS 4.8] [HIGH] */}
        {shownModel && (
          <span
            className="mini-badge model-badge"
            style={{ ['--chip-hue' as string]: hue }}
            data-tip={`modelo: ${shownModel}`}
          >
            {prettyModel(shownModel)}
          </span>
        )}
        {effort && (
          <span
            className="mini-badge effort-badge"
            style={{ ['--chip-hue' as string]: hue }}
            data-tip={`effort: ${effort}`}
          >
            {effort.toUpperCase()}
          </span>
        )}
        <span className="pane-title" data-tip={title || undefined}>
          {title}
        </span>
        {/* padronização: TODO pane com telemetria armada mostra os badges desde
            o nascimento — ↓0 ↑0 e barra vazia até os números reais chegarem. */}
        {!pinStats && statsView}
        {details}
      </span>
      <span className="pane-actions">
        {pinStats && statsView}
        {priorityDetails}
        {/* O estado é vital e nunca pode cair dentro da área recortável de
            metadados. Assim a bolinha some/entra inteira, mesmo quando seat,
            tokens ou título precisam ceder espaço. */}
        {activity && (
          <span
            className={`pane-state ${activity}`}
            data-tip={`pane ${ACTIVITY_UI[activity].label}`}
          >
            {ACTIVITY_UI[activity].glyph}
            <i className="act-label">{ACTIVITY_UI[activity].label}</i>
          </span>
        )}
        {children}
        {onMakeColumn && (
          <button
            className="term-btn ghost-dim dock-span-btn"
            data-tip="Ocupar uma coluna inteira"
            aria-label="Ocupar uma coluna inteira"
            onClick={onMakeColumn}
          >
            ▯
          </button>
        )}
        {onMakeRow && (
          <button
            className="term-btn ghost-dim dock-span-btn"
            data-tip="Ocupar uma linha inteira"
            aria-label="Ocupar uma linha inteira"
            onClick={onMakeRow}
          >
            ▭
          </button>
        )}
        {onToggleFocus && (
          <button
            className="term-btn ghost-dim focus-btn"
            data-tip={focused ? 'Restaurar o layout' : 'Expandir este pane'}
            aria-label={focused ? 'Restaurar o layout' : 'Expandir este pane'}
            onClick={onToggleFocus}
          >
            {focused ? '⤡' : '⤢'}
          </button>
        )}
        {onClose && (
          <button className="pane-close" data-tip={closeTitle ?? 'Fechar pane'} onClick={onClose}>
            ×
          </button>
        )}
      </span>
    </div>
  )
}
