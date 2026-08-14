import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { FileTreeAction, FileTreeNode } from './fileTreeTypes'

const LABELS: Readonly<Record<FileTreeAction, string>> = {
  'create-file': 'Criar arquivo',
  'create-folder': 'Criar pasta',
  rename: 'Renomear',
  trash: 'Mover para a Lixeira',
  'copy-path': 'Copiar caminho',
  'download-zip': 'Baixar pasta como ZIP'
}

const GLYPHS: Readonly<Record<FileTreeAction, string>> = {
  'create-file': '+',
  'create-folder': '▱',
  rename: '✎',
  trash: '⌫',
  'copy-path': '⧉',
  'download-zip': '⇩'
}

interface Props {
  node: FileTreeNode
  actions: FileTreeAction[]
  x: number
  y: number
  onChoose(action: FileTreeAction): void
  onDismiss(restoreFocus: boolean): void
}

export default function FileContextMenu({
  node,
  actions,
  x,
  y,
  onChoose,
  onDismiss
}: Props): React.JSX.Element {
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
    itemRefs.current[0]?.focus({ preventScroll: true })
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onDismiss(false)
    }
    const onViewportChange = (): void => onDismiss(true)
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
    if (actions.length === 0) return
    itemRefs.current[(index + actions.length) % actions.length]?.focus()
  }

  return createPortal(
    <div
      ref={menuRef}
      className="file-context-menu"
      role="menu"
      aria-label={`Ações de ${node.root ? 'raiz do projeto' : node.name}`}
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
          moveFocus(actions.length - 1)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onDismiss(true)
        } else if (event.key === 'Tab') {
          // O menu é uma unidade: Tab/Shift+Tab circulam sem deixar foco
          // escondido atrás do overlay. Escape devolve ao item da árvore.
          event.preventDefault()
          moveFocus(current + (event.shiftKey ? -1 : 1))
        }
      }}
    >
      {actions.map((action, index) => (
        <button
          key={action}
          ref={(element) => {
            itemRefs.current[index] = element
          }}
          type="button"
          role="menuitem"
          className={`file-context-item${action === 'trash' ? ' danger' : ''}`}
          onClick={() => onChoose(action)}
        >
          <span className="file-context-glyph" aria-hidden="true">{GLYPHS[action]}</span>
          <span>{LABELS[action]}</span>
        </button>
      ))}
    </div>,
    document.body
  )
}
