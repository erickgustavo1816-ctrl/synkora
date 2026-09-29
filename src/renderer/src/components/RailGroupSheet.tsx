import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  layoutGroups,
  PROJECT_GROUP_HUES,
  PROJECT_GROUP_NAME_MAX,
  type ProjectGroupHue
} from '../../../shared/projectLayout'
import { useProjectLayout } from '../projectLayoutStore'
import { railGroupHueLabel, railGroupMembersLine } from '../railGroupPresentation'
import { useStore } from '../store'
import { hueStyle, RailFolderGrid } from './RailGroupFolder'

// ————————————————————————————————————————————————————————————————————————
// A FOLHA DO GRUPO — nome à la iPhone + cor (grupos, 2026-09-29).
//
// Portal ancorado ao lado do grupo no rail, com bico. O nome é grande e
// centralizado; num grupo recém-nascido ele nasce SELECIONADO para o dono
// digitar por cima (o gesto do iPhone). A cor aplica na hora. Enter, "pronto"
// ou clique fora GRAVAM o nome; Esc desfaz o nome E a cor para o que eram
// quando a folha abriu. Abre de qualquer lugar (`openGroupSheet`): menu do
// rail, arraste que cria grupo, seção e card da Home.
// ————————————————————————————————————————————————————————————————————————

const HUES: ReadonlyArray<ProjectGroupHue | null> = [null, ...PROJECT_GROUP_HUES]

interface Props {
  groupId: string
  selectName: boolean
  activeProjectId: string | null
  /** a lista do rail (onde mora o slot do grupo, a âncora) */
  listRef: React.RefObject<HTMLDivElement | null>
}

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('input, button:not(:disabled), [tabindex]:not([tabindex="-1"])')
  ).filter((el) => el.tabIndex >= 0)
}

export default function RailGroupSheet({ groupId, selectName, activeProjectId, listRef }: Props): React.JSX.Element | null {
  const layout = useProjectLayout((s) => s.layout)
  const group = useMemo(() => (layout ? layoutGroups(layout).find((g) => g.id === groupId) ?? null : null), [layout, groupId])
  const projects = useStore((s) => s.projects)
  // o que a folha encontrou ao abrir — o Esc volta para isto
  const [original] = useState(() => ({ name: group?.name ?? '', hue: group?.hue ?? null }))
  const [draft, setDraft] = useState(original.name)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const hueRefs = useRef<Array<HTMLButtonElement | null>>([])
  const closedRef = useRef(false)
  const returnFocusRef = useRef<Element | null>(document.activeElement)

  const close = (): void => {
    closedRef.current = true
    useProjectLayout.getState().closeGroupSheet()
  }

  const finish = (): void => {
    if (closedRef.current || !group) return
    const name = draft.trim()
    // nome vazio mantém o anterior (o main também garante)
    if (name && name !== group.name) void useProjectLayout.getState().apply({ op: 'renameGroup', groupId, name })
    close()
  }

  const revert = (): void => {
    if (closedRef.current || !group) return
    if (group.hue !== original.hue) void useProjectLayout.getState().apply({ op: 'setGroupHue', groupId, hue: original.hue })
    close()
  }

  const dissolve = (): void => {
    if (closedRef.current) return
    close()
    void useProjectLayout.getState().apply({ op: 'dissolveGroup', groupId })
  }

  const pickHue = (hue: ProjectGroupHue | null): void => {
    if (!group || group.hue === hue) return
    void useProjectLayout.getState().apply({ op: 'setGroupHue', groupId, hue })
  }

  // foco: o nome (selecionado no grupo recém-nascido); ao fechar, volta a
  // quem estava com ele — ou à pasta do grupo no rail
  useEffect(() => {
    const input = inputRef.current
    if (input) {
      input.focus({ preventScroll: true })
      if (selectName) input.select()
      else input.setSelectionRange(input.value.length, input.value.length)
    }
    const list = listRef.current
    return () => {
      const back = returnFocusRef.current
      if (back instanceof HTMLElement && back.isConnected && back !== document.body) {
        back.focus({ preventScroll: true })
        return
      }
      list
        ?.querySelector<HTMLElement>(`[data-folder="${CSS.escape(groupId)}"], [data-head="${CSS.escape(groupId)}"]`)
        ?.focus({ preventScroll: true })
    }
    // só na abertura: a folha é remontada por grupo (key no ProjectRail)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // âncora: ao lado do slot do grupo, com o bico apontando para a pasta
  const position = (): void => {
    const sheet = sheetRef.current
    const list = listRef.current
    if (!sheet) return
    const anchor = list?.querySelector<HTMLElement>(`[data-slot][data-gid="${CSS.escape(groupId)}"]`) ?? null
    const anchorTop = anchor ? anchor.getBoundingClientRect().top : 80
    const railRight = list?.closest('.project-rail')?.getBoundingClientRect().right ?? 68
    const height = sheet.getBoundingClientRect().height
    const top = Math.max(10, Math.min(anchorTop - 16, window.innerHeight - height - 10))
    const nib = Math.max(14, Math.min(height - 26, anchorTop + 23 - top - 6))
    sheet.style.left = `${Math.round(railRight + 12)}px`
    sheet.style.top = `${Math.round(top)}px`
    sheet.style.setProperty('--nib', `${Math.round(nib)}px`)
  }

  useLayoutEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-slot][data-gid="${CSS.escape(groupId)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // re-ancora a cada desenho (a cor, a pasta que abriu, a lista que rolou)
  useLayoutEffect(position)

  useEffect(() => {
    const onResize = (): void => position()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  if (!group) return null

  const names = group.projectIds.map((id) => projects.find((p) => p.id === id)?.name ?? '').filter(Boolean)
  const checkedIndex = Math.max(0, HUES.indexOf(group.hue))

  const onHueKey = (event: React.KeyboardEvent, index: number): void => {
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (delta === 0) return
    event.preventDefault()
    const next = (index + delta + HUES.length) % HUES.length
    hueRefs.current[next]?.focus()
    pickHue(HUES[next])
  }

  return createPortal(
    <>
      <div className="rail-gsheet-catch" aria-hidden="true" onPointerDown={finish} />
      <div
        ref={sheetRef}
        className="rail-gsheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Nome e cor do grupo ${group.name}`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            revert()
            return
          }
          if (event.key === 'Tab') {
            const list = sheetRef.current ? focusables(sheetRef.current) : []
            if (list.length === 0) return
            const at = list.indexOf(document.activeElement as HTMLElement)
            const next = event.shiftKey ? (at <= 0 ? list.length - 1 : at - 1) : at === list.length - 1 ? 0 : at + 1
            event.preventDefault()
            list[next]?.focus()
          }
        }}
      >
        <div className="rail-gs-top">
          <div className={`rail-gs-folder${group.hue !== null ? ' has-hue' : ''}`} style={hueStyle(group.hue)}>
            <RailFolderGrid projectIds={group.projectIds} activeProjectId={activeProjectId} />
          </div>
          <input
            ref={inputRef}
            className="rail-gs-name"
            value={draft}
            maxLength={PROJECT_GROUP_NAME_MAX}
            spellCheck={false}
            autoComplete="off"
            aria-label="Nome do grupo"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              finish()
            }}
          />
        </div>
        <div className="rail-gs-label" id={`rail-gs-hues-${groupId}`}>
          cor
        </div>
        <div className="rail-gs-hues" role="radiogroup" aria-labelledby={`rail-gs-hues-${groupId}`}>
          {HUES.map((hue, index) => (
            <button
              key={hue ?? 'none'}
              ref={(el) => {
                hueRefs.current[index] = el
              }}
              type="button"
              role="radio"
              className={`rail-gs-hue${hue === null ? ' none' : ''}`}
              style={hueStyle(hue)}
              aria-checked={group.hue === hue}
              aria-label={railGroupHueLabel(hue)}
              data-tip={railGroupHueLabel(hue)}
              tabIndex={index === checkedIndex ? 0 : -1}
              onClick={() => pickHue(hue)}
              onKeyDown={(event) => onHueKey(event, index)}
            />
          ))}
        </div>
        <div className="rail-gs-members">{railGroupMembersLine(names)}</div>
        <div className="rail-gs-actions">
          <button type="button" className="btn ghost tiny" onClick={dissolve}>
            desfazer grupo
          </button>
          <button type="button" className="btn accent tiny" onClick={finish}>
            pronto
          </button>
        </div>
      </div>
    </>,
    document.body
  )
}
