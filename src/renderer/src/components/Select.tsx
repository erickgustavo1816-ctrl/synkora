import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import CliMark from './CliMark'
import type { SeatCli } from '../store'

// Select customizado do app (substitui o <select> nativo, feio e fora do
// tema): botão-gatilho no tema papel (variante .dark para painéis escuros) +
// dropdown via PORTAL no body (nunca clipado, sempre acima de overlays).
// Teclado completo: setas, Home/End, Enter/Espaço, Esc, type-ahead.

export interface SelectOption {
  value: string
  label: string
  /** texto menor à direita (ex.: descrição do modelo) */
  hint?: string
  disabled?: boolean
  /** marca do provedor antes do rótulo (seats). `label` continua sendo texto
   *  puro de propósito: é ele que alimenta o type-ahead do teclado. */
  cli?: SeatCli
}

interface Props {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  /** classes extras no wrapper (ex.: "dark" em painel escuro) */
  className?: string
  /** título acessível do gatilho (vira data-tip) */
  tip?: string
}

export default function Select({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  className,
  tip
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(-1)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ text: '', at: 0 })

  const selected = options.find((o) => o.value === value)

  const close = (): void => {
    setOpen(false)
    setHover(-1)
  }

  const commit = (v: string): void => {
    close()
    if (v !== value) onChange(v)
    triggerRef.current?.focus()
  }

  // fecha em clique fora / scroll fora / resize (posição fixa invalida)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      close()
    }
    const onScroll = (e: Event): void => {
      if (menuRef.current?.contains(e.target as Node)) return
      close()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  // posiciona o menu sob o gatilho (flip para cima se não couber)
  useLayoutEffect(() => {
    const menu = menuRef.current
    const trigger = triggerRef.current
    if (!open || !menu || !trigger) return
    const r = trigger.getBoundingClientRect()
    const margin = 8
    menu.style.minWidth = `${Math.round(r.width)}px`
    menu.style.maxWidth = `${Math.round(Math.max(r.width, 340))}px`
    const h = menu.offsetHeight
    const below = r.bottom + 4
    const fitsBelow = below + h + margin <= window.innerHeight
    const top = fitsBelow ? below : Math.max(margin, r.top - h - 4)
    let left = r.left
    left = Math.max(margin, Math.min(left, window.innerWidth - menu.offsetWidth - margin))
    menu.style.top = `${Math.round(top)}px`
    menu.style.left = `${Math.round(left)}px`
    // opção selecionada visível ao abrir
    const sel = menu.querySelector<HTMLElement>('.sel-opt.selected')
    sel?.scrollIntoView({ block: 'nearest' })
  }, [open])

  const move = (dir: 1 | -1, from: number): void => {
    if (options.length === 0) return
    let i = from
    for (let n = 0; n < options.length; n++) {
      i = (i + dir + options.length) % options.length
      if (!options[i].disabled) break
    }
    setHover(i)
    // mantém a opção visível ao navegar por teclado
    window.requestAnimationFrame(() => {
      menuRef.current
        ?.querySelectorAll<HTMLElement>('.sel-opt')
        [i]?.scrollIntoView({ block: 'nearest' })
    })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (disabled) return
    const startIdx = hover >= 0 ? hover : options.findIndex((o) => o.value === value)
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        setOpen(true)
        setHover(startIdx)
      }
      return
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault()
        close()
        break
      case 'ArrowDown':
        e.preventDefault()
        move(1, startIdx)
        break
      case 'ArrowUp':
        e.preventDefault()
        move(-1, startIdx < 0 ? 0 : startIdx)
        break
      case 'Home':
        e.preventDefault()
        setHover(options.findIndex((o) => !o.disabled))
        break
      case 'End':
        e.preventDefault()
        setHover(options.length - 1)
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (hover >= 0 && !options[hover].disabled) commit(options[hover].value)
        else close()
        break
      case 'Tab':
        close()
        break
      default: {
        // type-ahead simples: digite o começo do label
        if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          const now = Date.now()
          const t = typeahead.current
          t.text = (now - t.at < 700 ? t.text : '') + e.key.toLowerCase()
          t.at = now
          const idx = options.findIndex(
            (o) => !o.disabled && o.label.toLowerCase().startsWith(t.text)
          )
          if (idx >= 0) setHover(idx)
        }
      }
    }
  }

  return (
    <span className={`sel${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        ref={triggerRef}
        className="sel-trigger"
        disabled={disabled}
        data-tip={tip}
        aria-label={tip ? `${tip}: ${selected?.label ?? placeholder ?? '—'}` : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (open) close()
          else {
            setOpen(true)
            setHover(options.findIndex((o) => o.value === value))
          }
        }}
        onKeyDown={onKeyDown}
      >
        <span className={`sel-value${selected ? '' : ' placeholder'}`}>
          {selected?.cli && <CliMark cli={selected.cli} size={11} />}
          {selected ? selected.label : (placeholder ?? '—')}
        </span>
        <span className="sel-caret">▾</span>
      </button>
      {open &&
        createPortal(
          <div ref={menuRef} className="sel-menu" role="listbox">
            {options.map((o, i) => (
              <button
                type="button"
                key={`${o.value}-${i}`}
                className={`sel-opt${o.value === value ? ' selected' : ''}${i === hover ? ' hover' : ''}`}
                role="option"
                aria-selected={o.value === value}
                disabled={o.disabled}
                onMouseEnter={() => setHover(i)}
                onClick={() => commit(o.value)}
              >
                <span className="sel-opt-label">
                  {o.cli && <CliMark cli={o.cli} size={11} />}
                  {o.label}
                </span>
                {o.hint && <span className="sel-opt-hint">{o.hint}</span>}
              </button>
            ))}
          </div>,
          document.body
        )}
    </span>
  )
}
