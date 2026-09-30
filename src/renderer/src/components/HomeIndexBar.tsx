import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import type { ProjectLayoutGroupEntry } from '../../../shared/projectLayout'
import {
  HOME_PERIODS,
  HOME_SORT_OPTIONS,
  HOME_STATE_OPTIONS,
  periodLabel,
  removeToken,
  toggleState,
  type HomeIndex,
  type HomeTabKey,
  type HomeView
} from '../homeIndexModel'
import './HomeIndex.css'

// ————————————————————————————————————————————————————————————————————————
// O ÍNDICE DA HOME — a barra que gruda no topo da rolagem: UMA busca,
// FILTRAR (estado + criação), ORDEM, a visão (por grupo | todos juntos), as
// abas de grupo sobre a régua e as etiquetas do que está ativo. Mockup
// aprovado: docs/mockups/grupos-universos-2026-09-29.html. Toda a lógica mora
// no modelo puro (homeIndexModel.ts); aqui é só desenho e teclado.
//
// Também moram aqui as duas peças que a seção e o card reaproveitam: o
// POPOVER (portal, some com clique fora / Esc / rolagem) e o GLIFO da pasta.
// ————————————————————————————————————————————————————————————————————————

export type PopoverAnchor = HTMLElement | { x: number; y: number }

interface HomePopoverProps {
  /** onde ele abre: embaixo de um botão (alinhado pela direita) ou num ponto */
  anchor: PopoverAnchor
  /** o dono do popover: apertar DENTRO dele é assunto do dono (o botão
   *  alterna; o card tem a própria cortina), nunca "clique fora" */
  owner: HTMLElement | null
  className: string
  role: 'dialog' | 'menu'
  label: string
  /** os itens que as setas percorrem */
  itemSelector: string
  initialFocus: 'checked' | 'first' | 'last'
  gap?: number
  /** `restoreFocus`: o Esc devolve o foco a quem abriu */
  onClose: (restoreFocus: boolean) => void
  children: ReactNode
}

const EDGE = 8

export function HomePopover({
  anchor,
  owner,
  className,
  role,
  label,
  itemSelector,
  initialFocus,
  gap = 6,
  onClose,
  children
}: HomePopoverProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })

  const close = useCallback(
    (restoreFocus: boolean): void => {
      if (restoreFocus && anchor instanceof HTMLElement) anchor.focus({ preventScroll: true })
      closeRef.current(restoreFocus)
    },
    [anchor]
  )

  // posição e foco inicial ANTES da pintura: nada pisca no canto da tela
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left: number
    let top: number
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect()
      left = r.right - w
      top = r.bottom + gap
      if (top + h > window.innerHeight - EDGE && r.top - gap - h >= EDGE) top = r.top - gap - h
    } else {
      left = anchor.x
      top = Math.min(anchor.y, window.innerHeight - h - EDGE)
    }
    el.style.left = `${Math.max(EDGE, Math.min(left, window.innerWidth - w - EDGE))}px`
    el.style.top = `${Math.max(EDGE, top)}px`

    const items = el.querySelectorAll<HTMLElement>(`${itemSelector}:not(:disabled)`)
    const target =
      initialFocus === 'checked'
        ? (el.querySelector<HTMLElement>(`${itemSelector}[aria-checked="true"]`) ?? items[0])
        : initialFocus === 'last'
          ? items[items.length - 1]
          : items[0]
    ;(target ?? el).focus({ preventScroll: true })
    // posiciona UMA vez: quem abre de outro lugar remonta o popover
  }, [])

  useEffect(() => {
    const outside = (target: EventTarget | null): boolean =>
      !(target instanceof Node) || !(ref.current?.contains(target) || owner?.contains(target))
    const onPointerDown = (e: PointerEvent): void => {
      if (outside(e.target)) close(false)
    }
    // posição fixa não acompanha a rolagem: fecha quando a âncora ANDOU. A
    // barra é sticky, e um filtro que encolhe a grade dispara scroll (o
    // Chromium grampeia o scrollTop) sem mover o botão — isso não fecha.
    const anchorTop = anchor instanceof HTMLElement ? anchor.getBoundingClientRect().top : null
    const onScroll = (e: Event): void => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      if (anchorTop !== null && anchor instanceof HTMLElement && Math.abs(anchor.getBoundingClientRect().top - anchorTop) < 1) return
      close(false)
    }
    const onResize = (): void => close(false)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [owner, close, anchor])

  return createPortal(
    <div
      ref={ref}
      className={className}
      role={role}
      aria-label={label}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close(true)
          return
        }
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
        const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(`${itemSelector}:not(:disabled)`))
        if (items.length === 0) return
        e.preventDefault()
        const i = items.indexOf(document.activeElement as HTMLElement)
        const next =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? items.length - 1
              : i < 0
                ? e.key === 'ArrowDown' ? 0 : items.length - 1
                : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items[next]?.focus()
      }}
      onBlur={(e) => {
        const to = e.relatedTarget
        if (to instanceof Node && (e.currentTarget.contains(to) || owner?.contains(to))) return
        // foco saiu por Tab (ou para a página): o popover não fica órfão
        if (to !== null) close(false)
      }}
    >
      {children}
    </div>,
    document.body
  )
}

/** A pasta em miniatura (2×2) do grupo — na aba e no cabeçalho da seção.
 *  Sem grupo = o contorno tracejado dos soltos. */
export function GroupGlyph({
  group,
  hues,
  className
}: {
  group: ProjectLayoutGroupEntry | null
  hues: ReadonlyMap<string, number>
  className: string
}): React.JSX.Element {
  if (!group) {
    return (
      <span className={`${className} loose`} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
    )
  }
  return (
    <span
      className={`${className}${group.hue !== null ? ' has-hue' : ''}`}
      style={group.hue !== null ? ({ '--g-hue': group.hue } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      {group.projectIds.slice(0, 4).map((id) => (
        <i key={id} style={{ '--card-hue': hues.get(id) ?? 30 } as CSSProperties} />
      ))}
    </span>
  )
}

const CHECK = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m2.5 6.2 2.3 2.3 4.7-5" />
  </svg>
)

const CROSS = (
  <svg className="hb-ico" viewBox="0 0 16 16" aria-hidden="true">
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </svg>
)

function isTypingTarget(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable
}

interface HomeIndexBarProps {
  index: HomeIndex
  view: HomeView
  query: string
  hues: ReadonlyMap<string, number>
  /** o painel que a barra comanda (as abas apontam para ele) */
  panelId: string
  /** o scroller da Home: a barra ganha papel e filete quando gruda nele */
  scrollRef: RefObject<HTMLDivElement | null>
  /** registra a barra como a âncora 'universos' (os vitais rolam até ela) */
  anchorRef: (el: HTMLElement | null) => void
  onQuery: (query: string) => void
  onView: (view: HomeView) => void
  onClearFilters: () => void
  onGroupMenu: (groupId: string, at: PopoverAnchor) => void
}

export default function HomeIndexBar({
  index,
  view,
  query,
  hues,
  panelId,
  scrollRef,
  anchorRef,
  onQuery,
  onView,
  onClearFilters,
  onGroupMenu
}: HomeIndexBarProps): React.JSX.Element {
  const barRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const [pop, setPop] = useState<{ kind: 'filter' | 'sort'; button: HTMLElement } | null>(null)
  const [stuck, setStuck] = useState(false)
  const [fade, setFade] = useState({ l: false, r: false })
  const stateLabelId = useId()
  const periodLabelId = useId()
  const now = new Date()

  const setBar = useCallback(
    (el: HTMLDivElement | null): void => {
      barRef.current = el
      anchorRef(el)
    },
    [anchorRef]
  )

  // papel + filete só quando a barra está de fato grudada no topo
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    let raf = 0
    const measure = (): void => {
      raf = 0
      const bar = barRef.current
      if (!bar) return
      setStuck(scroller.scrollTop > 0 && bar.getBoundingClientRect().top - scroller.getBoundingClientRect().top <= 1)
    }
    const onScroll = (): void => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    measure()
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [scrollRef])

  // "/" busca — só com a Home na frente e ninguém digitando
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
      const s = useStore.getState()
      if (s.appPage !== 'workspace' || s.openProjectId !== null) return
      if (isTypingTarget(document.activeElement)) return
      // modal aberto (os da casa usam `.overlay`): o teclado fica dentro dele
      if (document.querySelector('[aria-modal="true"], .overlay')) return
      e.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // esmaece só a borda das abas que esconde conteúdo
  const measureTabs = useCallback((): void => {
    const t = tabsRef.current
    if (!t) return
    const l = t.scrollLeft > 1
    const r = t.scrollLeft + t.clientWidth < t.scrollWidth - 1
    setFade((f) => (f.l === l && f.r === r ? f : { l, r }))
  }, [])

  useLayoutEffect(measureTabs, [index.tabs, measureTabs])

  useEffect(() => {
    const t = tabsRef.current
    if (!t || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measureTabs)
    ro.observe(t)
    return () => ro.disconnect()
  }, [measureTabs])

  // a aba escolhida entra na faixa visível (só na horizontal — nunca rola a Home)
  useEffect(() => {
    const t = tabsRef.current
    const on = t?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!t || !on) return
    const r = on.getBoundingClientRect()
    const c = t.getBoundingClientRect()
    if (r.left < c.left) t.scrollLeft -= c.left - r.left + 24
    else if (r.right > c.right) t.scrollLeft += r.right - c.right + 24
  }, [index.tab])

  const selectTab = (key: HomeTabKey): void => {
    if (key !== index.tab) onView({ ...view, group: key })
  }

  const closePop = (restoreFocus: boolean): void => {
    if (restoreFocus) pop?.button.focus({ preventScroll: true })
    setPop(null)
  }

  const togglePop = (kind: 'filter' | 'sort', button: HTMLElement): void => {
    setPop((cur) => (cur?.kind === kind ? null : { kind, button }))
  }

  const sortShort = HOME_SORT_OPTIONS.find((s) => s.id === view.sort)?.short ?? ''

  return (
    <div ref={setBar} className={`hb${stuck ? ' stuck' : ''}`}>
      <div className="hb-row">
        <label className="hb-search">
          <svg className="hb-ico" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" />
            <path d="m10.4 10.4 3.4 3.4" />
          </svg>
          <input
            ref={searchRef}
            type="search"
            placeholder="buscar universo, pasta ou grupo"
            autoComplete="off"
            spellCheck={false}
            aria-label="Buscar universo"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return
              e.preventDefault()
              onQuery('')
              e.currentTarget.blur()
            }}
          />
          {query ? (
            <button
              className="hb-clear"
              type="button"
              aria-label="Limpar busca"
              onClick={(e) => {
                e.preventDefault()
                onQuery('')
                searchRef.current?.focus()
              }}
            >
              {CROSS}
            </button>
          ) : (
            <span className="hb-kbd" aria-hidden="true">
              /
            </span>
          )}
        </label>

        <button
          className="btn ghost hb-ctl"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={pop?.kind === 'filter'}
          onClick={(e) => togglePop('filter', e.currentTarget)}
        >
          <svg className="hb-ico" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
          </svg>
          filtrar
          {index.filterCount > 0 && <span className="hb-badge">{index.filterCount}</span>}
        </button>

        <button
          className="btn ghost hb-ctl"
          type="button"
          aria-haspopup="menu"
          aria-expanded={pop?.kind === 'sort'}
          onClick={(e) => togglePop('sort', e.currentTarget)}
        >
          ordem <span className="v">{sortShort}</span>
          <svg className="hb-ico chev" viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </button>

        <div className="hb-seg" role="group" aria-label="Visualização">
          <button
            type="button"
            aria-pressed={view.grouped}
            aria-label="Separar por grupo"
            data-tip="Separar por grupo"
            onClick={() => {
              if (!view.grouped) onView({ ...view, grouped: true })
            }}
          >
            <svg className="hb-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 3h4M2.5 5.5h11M2.5 8h11M2.5 10.5h4M2.5 13h11" />
            </svg>
          </button>
          <button
            type="button"
            aria-pressed={!view.grouped}
            aria-label="Todos juntos"
            data-tip="Todos juntos"
            onClick={() => {
              if (view.grouped) onView({ ...view, grouped: false })
            }}
          >
            <svg className="hb-ico" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1" />
              <rect x="9" y="2.5" width="4.5" height="4.5" rx="1" />
              <rect x="2.5" y="9" width="4.5" height="4.5" rx="1" />
              <rect x="9" y="9" width="4.5" height="4.5" rx="1" />
            </svg>
          </button>
        </div>
      </div>

      <div className={`hb-tabs-wrap${fade.l ? ' fade-l' : ''}${fade.r ? ' fade-r' : ''}`}>
        <div
          ref={tabsRef}
          className="hb-tabs"
          role="tablist"
          aria-label="Grupos"
          onScroll={measureTabs}
          onKeyDown={(e) => {
            const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']
            if (!keys.includes(e.key)) return
            const all = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
            const i = all.indexOf(document.activeElement as HTMLButtonElement)
            const next =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? all.length - 1
                  : (i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length
            const tab = all[next]
            if (!tab) return
            e.preventDefault()
            selectTab(tab.dataset.tab ?? 'all')
            tab.focus()
          }}
        >
          {index.tabs.map((t) => {
            const on = t.key === index.tab
            const zero = t.key !== 'all' && t.count === 0 && !on
            const group = t.group
            return (
              <button
                key={t.key}
                type="button"
                className={`hb-tab${zero ? ' zero' : ''}`}
                role="tab"
                aria-selected={on}
                aria-controls={panelId}
                tabIndex={on ? 0 : -1}
                data-tab={t.key}
                onClick={() => selectTab(t.key)}
                onContextMenu={
                  group
                    ? (e) => {
                        e.preventDefault()
                        // tecla de menu chega sem coordenada: abre sob a aba
                        onGroupMenu(group.id, e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : e.currentTarget)
                      }
                    : undefined
                }
              >
                {group && <GroupGlyph group={group} hues={hues} className="tab-glyph" />}
                {t.label}
                <span className="n">{t.count}</span>
              </button>
            )
          })}
        </div>
      </div>

      {index.tokens.length > 0 && (
        <div className="hb-active">
          {index.tokens.map((t) => (
            <span className="hb-tok" key={`${t.kind}:${t.id}`}>
              {t.kind === 'state' && <span className={`hb-dot ${t.dot}`} aria-hidden="true" />}
              {t.label}
              <button
                type="button"
                aria-label={`Remover filtro: ${t.label}`}
                onClick={() => (t.kind === 'query' ? onQuery('') : onView(removeToken(view, t)))}
              >
                {CROSS}
              </button>
            </span>
          ))}
          <span className="sum">
            mostrando <b>{index.shown.length}</b> de {index.total} ·{' '}
            <button className="hb-link" type="button" onClick={onClearFilters}>
              limpar tudo
            </button>
          </span>
        </div>
      )}

      {pop?.kind === 'filter' && (
        <HomePopover
          anchor={pop.button}
          owner={pop.button}
          className="hb-pop"
          role="dialog"
          label="Filtrar universos"
          itemSelector=".hb-pop-opt"
          initialFocus="checked"
          onClose={() => setPop(null)}
        >
          <div className="hb-pop-label" id={stateLabelId}>
            estado
          </div>
          <div role="group" aria-labelledby={stateLabelId}>
            {HOME_STATE_OPTIONS.map((s) => (
              <button
                key={s.id}
                className="hb-pop-opt"
                type="button"
                role="checkbox"
                aria-checked={view.states.includes(s.id)}
                onClick={() => onView(toggleState(view, s.id))}
              >
                <span className="box">{CHECK}</span>
                <span className={`hb-dot ${s.dot}`} aria-hidden="true" />
                {s.label}
                <span className="n">{index.stateCounts[s.id]}</span>
              </button>
            ))}
          </div>
          <div className="hb-pop-sep" />
          <div className="hb-pop-label" id={periodLabelId}>
            criado
          </div>
          <div role="radiogroup" aria-labelledby={periodLabelId}>
            {HOME_PERIODS.map((p) => (
              <button
                key={p}
                className="hb-pop-opt"
                type="button"
                role="radio"
                aria-checked={view.period === p}
                onClick={() => {
                  if (view.period !== p) onView({ ...view, period: p })
                }}
              >
                <span className="box radio" />
                {periodLabel(p, now)}
              </button>
            ))}
          </div>
          <div className="hb-pop-sep" />
          <div className="hb-pop-foot">
            <button
              className="hb-link"
              type="button"
              onClick={() => onView({ ...view, states: [], period: 'any' })}
            >
              limpar estado e data
            </button>
            <button className="btn tiny" type="button" onClick={() => closePop(true)}>
              pronto
            </button>
          </div>
        </HomePopover>
      )}

      {pop?.kind === 'sort' && (
        <HomePopover
          anchor={pop.button}
          owner={pop.button}
          className="hb-pop sort"
          role="menu"
          label="Ordenar universos"
          itemSelector=".hb-pop-opt"
          initialFocus="checked"
          onClose={() => setPop(null)}
        >
          <div className="hb-pop-label">ordenar por</div>
          {HOME_SORT_OPTIONS.map((s) => (
            <button
              key={s.id}
              className="hb-pop-opt"
              type="button"
              role="menuitemradio"
              aria-checked={view.sort === s.id}
              onClick={() => {
                if (view.sort !== s.id) onView({ ...view, sort: s.id })
                closePop(true)
              }}
            >
              <span className="box radio" />
              {s.label}
            </button>
          ))}
        </HomePopover>
      )}
    </div>
  )
}
