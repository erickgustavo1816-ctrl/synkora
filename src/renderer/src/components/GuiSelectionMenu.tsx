import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// MENU DA SELEÇÃO DO FIO (R33) — o botão direito sobre texto selecionado.
//
// ESPELHO DECLARADO do `GuiFileContextMenu.tsx`: mesmo portal em
// `document.body`, mesma posição grampeada na viewport, mesmo teclado (setas,
// Home/End, Tab circular, Escape) e as MESMAS classes de CSS
// (`.file-context-menu`/`.file-context-item` — a árvore de arquivos é dona do
// desenho; um segundo desenho seria uma segunda verdade). Menu nativo não
// existe no palco 2.0: o do Chromium tem tema próprio, rouba o foco no
// Windows e não fala PT-BR.
//
// O que muda em relação ao par: o alvo é TEXTO (a seleção do dono no fio), as
// duas ações não mutam nada fora do composer, e o menu não guarda estado de
// recusa — copiar e citar não falham com receita, falham nunca.

export type GuiSelectionAction = 'copy' | 'quote'

interface Props {
  x: number
  y: number
  onChoose(action: GuiSelectionAction): void
  onDismiss(): void
}

// Sem tooltip de propósito (ordem do dono, 23/08: "não precisa de tooltip nas
// seleções") — os dois verbos se explicam sozinhos.
const OPTIONS: Array<{ action: GuiSelectionAction; glyph: string; label: string }> = [
  { action: 'copy', glyph: '⧉', label: 'copiar' },
  { action: 'quote', glyph: '❝', label: 'anexar à resposta' }
]

export default function GuiSelectionMenu({ x, y, onChoose, onDismiss }: Props): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [position, setPosition] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const margin = 8
    const rect = menu.getBoundingClientRect()
    setPosition({
      left: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin))
    })
    // Foco no primeiro item SEM rolar: o menu nasce sob o cursor, e o fio não
    // pode pular por causa dele.
    itemRefs.current[0]?.focus({ preventScroll: true })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onDismiss()
    }
    const onViewportChange = (): void => onDismiss()
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('blur', onViewportChange)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('blur', onViewportChange)
    }
  }, [onDismiss])

  const moveFocus = (index: number): void => {
    itemRefs.current[(index + OPTIONS.length) % OPTIONS.length]?.focus()
  }

  return createPortal(
    <div
      ref={menuRef}
      className="file-context-menu gui-selection-menu"
      role="menu"
      aria-label="Trecho selecionado do fio"
      style={{ left: position.left, top: position.top }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const current = itemRefs.current.findIndex((item) => item === document.activeElement)
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          moveFocus(current + 1)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          moveFocus(current - 1)
        } else if (event.key === 'Home') {
          event.preventDefault()
          moveFocus(0)
        } else if (event.key === 'End') {
          event.preventDefault()
          moveFocus(OPTIONS.length - 1)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onDismiss()
        } else if (event.key === 'Tab') {
          event.preventDefault()
          moveFocus(current + (event.shiftKey ? -1 : 1))
        }
      }}
    >
      {OPTIONS.map((option, index) => (
        <button
          key={option.action}
          ref={(element) => {
            itemRefs.current[index] = element
          }}
          type="button"
          role="menuitem"
          className="file-context-item"
          onClick={() => onChoose(option.action)}
        >
          <span className="file-context-glyph" aria-hidden="true">
            {option.glyph}
          </span>
          <span>{option.label}</span>
        </button>
      ))}
    </div>,
    document.body
  )
}
