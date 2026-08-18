import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  fileContextOptions,
  runFileOpen,
  type FileContextAction,
  type FileContextOption,
  type FileContextTarget
} from '../guiFileContextMenu'

// MENU DE CONTEXTO DE ARQUIVO (rodada 7, C1) — a superfície das três saídas.
//
// Menu NATIVO não existe no palco 2.0 (o do Chromium tem tema próprio, rouba o
// foco no Windows e não fala PT-BR): este é o mesmo desenho do menu da árvore
// de arquivos (`file-tree/FileContextMenu.tsx`, o PAR declarado deste arquivo),
// portal em `document.body`, posição grampeada na viewport depois de medir, e
// teclado inteiro — setas, Home/End, Tab circular, Escape devolvendo o foco.
//
// O que muda em relação ao par: as ações aqui não MUTAM nada (ler no app,
// mandar para o programa padrão do sistema, mostrar na pasta), então não há
// item destrutivo e nenhum modal de confirmação depois do clique.

interface Props {
  target: FileContextTarget
  options: FileContextOption[]
  x: number
  y: number
  onChoose(action: FileContextAction): void
  onDismiss(restoreFocus: boolean): void
}

export default function GuiFileContextMenu({
  target,
  options,
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
    if (options.length === 0) return
    itemRefs.current[(index + options.length) % options.length]?.focus()
  }

  const name = target.path.split('/').at(-1) ?? target.path

  return createPortal(
    <div
      ref={menuRef}
      className="file-context-menu gui-file-context-menu"
      role="menu"
      aria-label={`Onde abrir ${name}`}
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
          moveFocus(options.length - 1)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          onDismiss(true)
        } else if (event.key === 'Tab') {
          // O menu é uma unidade: Tab/Shift+Tab circulam sem deixar foco
          // escondido atrás do overlay. Escape devolve ao item de origem.
          event.preventDefault()
          moveFocus(current + (event.shiftKey ? -1 : 1))
        }
      }}
    >
      {options.map((option, index) => (
        <button
          key={option.action}
          ref={(element) => {
            itemRefs.current[index] = element
          }}
          type="button"
          role="menuitem"
          className="file-context-item"
          data-tip={option.tip}
          onClick={() => onChoose(option.action)}
        >
          <span className="file-context-glyph" aria-hidden="true">{option.glyph}</span>
          <span>{option.label}</span>
        </button>
      ))}
    </div>,
    document.body
  )
}

interface FileContextMenuState {
  target: FileContextTarget
  options: FileContextOption[]
  x: number
  y: number
}

export interface FileContextMenuController {
  menu: FileContextMenuState | null
  /** última recusa do sistema; a superfície mostra e some no gesto seguinte */
  notice: string | null
  openFromPointer(event: React.MouseEvent, target: FileContextTarget): void
  openFromKeyboard(event: React.KeyboardEvent, target: FileContextTarget): void
  openFromAnchor(element: HTMLElement | null, target: FileContextTarget): void
  choose(action: FileContextAction): void
  dismiss(restoreFocus: boolean): void
}

/**
 * O estado do menu vive AQUI porque duas superfícies o usam (o trilho de
 * entrega e a bancada de leitura) e nenhuma das duas deve reimplementar o
 * teclado, o foco de volta nem a recusa em texto.
 *
 * `openInApp` é a saída DEFAULT — o que o clique de sempre já fazia; as outras
 * duas atravessam o `files:openExternal` pela guarda de `guiFileContextMenu.ts`.
 */
export function useFileContextMenu(
  openInApp: (target: FileContextTarget) => void
): FileContextMenuController {
  const [menu, setMenu] = useState<FileContextMenuState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)

  const open = useCallback(
    (target: FileContextTarget, at: { x: number; y: number }, anchor: HTMLElement | null): void => {
      const options = fileContextOptions(target)
      // Sem saída possível (arquivo apagado nesta branch, caminho recusado pela
      // guarda) o menu NÃO abre: lista vazia seria uma promessa sem conteúdo.
      if (options.length === 0) return
      anchorRef.current = anchor
      setNotice(null)
      setMenu({ target, options, x: at.x, y: at.y })
    },
    []
  )

  const openFromPointer = useCallback(
    (event: React.MouseEvent, target: FileContextTarget): void => {
      event.preventDefault()
      event.stopPropagation()
      open(target, { x: event.clientX, y: event.clientY }, event.currentTarget as HTMLElement)
    },
    [open]
  )

  const openFromAnchor = useCallback(
    (element: HTMLElement | null, target: FileContextTarget): void => {
      const rect = element?.getBoundingClientRect()
      open(target, { x: rect ? rect.left : 12, y: rect ? rect.bottom + 4 : 12 }, element ?? null)
    },
    [open]
  )

  const openFromKeyboard = useCallback(
    (event: React.KeyboardEvent, target: FileContextTarget): void => {
      // As MESMAS teclas da árvore de arquivos: tecla de menu e Shift+F10.
      const wanted = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)
      if (!wanted) return
      event.preventDefault()
      openFromAnchor(event.currentTarget as HTMLElement, target)
    },
    [openFromAnchor]
  )

  const dismiss = useCallback((restoreFocus: boolean): void => {
    setMenu(null)
    if (restoreFocus) anchorRef.current?.focus({ preventScroll: true })
  }, [])

  const choose = useCallback(
    (action: FileContextAction): void => {
      const current = menu
      setMenu(null)
      if (!current) return
      anchorRef.current?.focus({ preventScroll: true })
      if (action === 'open-in-app') {
        openInApp(current.target)
        return
      }
      void runFileOpen(action === 'reveal' ? 'reveal' : 'default', current.target).then(
        (outcome) => {
          setNotice(outcome.ok ? null : (outcome.error ?? 'não deu para abrir este arquivo agora'))
        }
      )
    },
    [menu, openInApp]
  )

  return { menu, notice, openFromPointer, openFromKeyboard, openFromAnchor, choose, dismiss }
}
