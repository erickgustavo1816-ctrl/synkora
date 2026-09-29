import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useProjectLayout } from '../projectLayoutStore'
import {
  layoutGroups,
  PROJECT_GROUP_NAME_MAX,
  type ProjectLayoutGroupEntry
} from '../../../shared/projectLayout'
import { GroupGlyph, HomePopover, type PopoverAnchor } from './HomeIndexBar'

// ————————————————————————————————————————————————————————————————————————
// UMA SEÇÃO DA VISÃO "POR GRUPO" (mockup de 2026-09-29, `.hg*`): seta que
// recolhe, a pasta em miniatura, o NOME (clique renomeia ali mesmo), a
// contagem ("n" ou "n de m" com filtro), a régua e o `···` do grupo. Os
// soltos fecham a lista como "sem grupo", sem nome editável nem menu.
// ————————————————————————————————————————————————————————————————————————

interface HomeGroupSectionProps {
  /** null = a seção dos soltos ("sem grupo") */
  group: ProjectLayoutGroupEntry | null
  count: number
  total: number
  shut: boolean
  hues: ReadonlyMap<string, number>
  menuOpen: boolean
  onToggle: () => void
  onGroupMenu: (groupId: string, at: PopoverAnchor) => void
  /** a grade — só entra aberta: recolhida, os cards desmontam e deixam de
   *  ser âncora do campo de partículas */
  children: ReactNode
}

const CARET = (
  <svg className="hb-ico" viewBox="0 0 16 16" aria-hidden="true">
    <path d="m4 6 4 4 4-4" />
  </svg>
)

export default function HomeGroupSection({
  group,
  count,
  total,
  shut,
  hues,
  menuOpen,
  onToggle,
  onGroupMenu,
  children
}: HomeGroupSectionProps): React.JSX.Element {
  const apply = useProjectLayout((s) => s.apply)
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const settledRef = useRef(false)
  const nameRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const refocusRef = useRef(false)
  const label = group ? group.name : 'sem grupo'

  // abre com o nome selecionado (digitar substitui); fechou pelo teclado, o
  // foco volta ao nome
  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus({ preventScroll: true })
      inputRef.current?.select()
      return
    }
    if (!refocusRef.current) return
    refocusRef.current = false
    nameRef.current?.focus({ preventScroll: true })
  }, [renaming])

  function startRename(): void {
    if (!group) return
    settledRef.current = false
    setDraft(group.name)
    setRenaming(true)
  }

  /** Enter e blur gravam; Esc desfaz. Uma vez só — o blur que vem depois do
   *  Enter/Esc não grava de novo. */
  function settle(save: boolean, refocus: boolean): void {
    if (!group || settledRef.current) return
    settledRef.current = true
    refocusRef.current = refocus
    setRenaming(false)
    const name = draft.trim()
    if (save && name && name !== group.name) void apply({ op: 'renameGroup', groupId: group.id, name })
  }

  return (
    <section className={`hg${shut ? ' shut' : ''}`} aria-label={label}>
      <div className="hg-head">
        <button
          className="hg-caret"
          type="button"
          aria-expanded={!shut}
          aria-label={`${shut ? 'Mostrar' : 'Esconder'} ${label}`}
          onClick={onToggle}
        >
          {CARET}
        </button>
        <GroupGlyph group={group} hues={hues} className="hg-folder" />
        {!group ? (
          <span className="hg-name static">sem grupo</span>
        ) : renaming ? (
          <input
            ref={inputRef}
            className="hg-name-input"
            aria-label="Nome do grupo"
            maxLength={PROJECT_GROUP_NAME_MAX}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => settle(true, false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) settle(true, true)
              if (e.key === 'Escape') {
                e.stopPropagation()
                settle(false, true)
              }
            }}
          />
        ) : (
          <button
            ref={nameRef}
            className="hg-name"
            type="button"
            aria-label={`Renomear grupo ${group.name}`}
            onClick={startRename}
          >
            {group.name}
          </button>
        )}
        <span className="hg-count">{count === total ? `${total}` : `${count} de ${total}`}</span>
        <span className="hg-rule" aria-hidden="true" />
        {group && (
          <button
            className="uc-menu-trigger"
            type="button"
            aria-label={`Ações do grupo ${group.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => onGroupMenu(group.id, e.currentTarget)}
          >
            ···
          </button>
        )}
      </div>
      {!shut && children}
    </section>
  )
}

/** O menu do grupo — o mesmo pelo `···` da seção e pelo clique direito na
 *  aba: renomear e cor (a folha do rail), abrir/fechar no rail, desfazer. */
export function HomeGroupMenu({
  groupId,
  anchor,
  onClose
}: {
  groupId: string
  anchor: PopoverAnchor
  onClose: () => void
}): React.JSX.Element | null {
  const layout = useProjectLayout((s) => s.layout)
  const apply = useProjectLayout((s) => s.apply)
  const openGroupSheet = useProjectLayout((s) => s.openGroupSheet)
  const group = layout ? (layoutGroups(layout).find((g) => g.id === groupId) ?? null) : null

  // o grupo sumiu (desfeito em outra janela, esvaziado no rail): o menu vai junto
  useEffect(() => {
    if (!group) onClose()
  }, [group, onClose])

  if (!group) return null

  const pick = (run: () => void) => (): void => {
    onClose()
    run()
  }

  return (
    <HomePopover
      anchor={anchor}
      owner={anchor instanceof HTMLElement ? anchor : null}
      className="uc-menu-pop is-floating"
      role="menu"
      label={`Ações do grupo ${group.name}`}
      itemSelector='[role="menuitem"]'
      initialFocus="first"
      gap={4}
      onClose={onClose}
    >
      <button type="button" role="menuitem" onClick={pick(() => openGroupSheet(group.id, false))}>
        renomear e cor…
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={pick(() => void apply({ op: 'setGroupOpen', groupId: group.id, open: !group.open }))}
      >
        {group.open ? 'fechar no rail' : 'abrir no rail'}
      </button>
      <div className="uc-menu-sep" role="separator" />
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={pick(() => void apply({ op: 'dissolveGroup', groupId: group.id }))}
      >
        desfazer grupo
      </button>
    </HomePopover>
  )
}
