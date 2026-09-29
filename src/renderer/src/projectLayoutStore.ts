import { create } from 'zustand'
import type { ProjectLayout, ProjectLayoutOp, ProjectLayoutOpResult } from '../../shared/projectLayout'

// ————————————————————————————————————————————————————————————————————————
// O LAYOUT DOS UNIVERSOS NO RENDERER (grupos, 2026-09-29).
//
// Store próprio (feature nova = módulo novo; store.ts já passou do teto).
// O main é o ÚNICO que muda o layout: `apply` manda a operação e guarda o
// layout que volta; o broadcast `projectLayout:changed` mantém as outras
// janelas em dia. A folha de nome/cor do grupo mora no rail, mas é aberta de
// qualquer lugar (menu do rail, seção e card da Home) por `openGroupSheet`.
// ————————————————————————————————————————————————————————————————————————

interface ProjectLayoutState {
  /** null até a primeira leitura — quem desenha cai na ordem de `projects` */
  layout: ProjectLayout | null
  /** grupo cuja folha de nome e cor está aberta (null = nenhuma) */
  sheetGroupId: string | null
  /** a folha abriu para um grupo recém-nascido: o nome nasce selecionado para
   *  o dono digitar por cima (o gesto do iPhone) */
  sheetSelectName: boolean
  load: () => Promise<void>
  apply: (op: ProjectLayoutOp) => Promise<ProjectLayoutOpResult | null>
  openGroupSheet: (groupId: string, selectName?: boolean) => void
  closeGroupSheet: () => void
}

let subscribed = false

export const useProjectLayout = create<ProjectLayoutState>((set) => ({
  layout: null,
  sheetGroupId: null,
  sheetSelectName: false,

  load: async () => {
    const api = window.synkora?.projectLayout
    if (!api) return
    if (!subscribed) {
      subscribed = true
      api.onChanged((layout) => set({ layout }))
    }
    try {
      set({ layout: await api.get() })
    } catch (err) {
      console.warn('[projectLayout] leitura falhou', err)
    }
  },

  apply: async (op) => {
    const api = window.synkora?.projectLayout
    if (!api) return null
    try {
      const result = await api.apply(op)
      set({ layout: result.layout })
      return result
    } catch (err) {
      console.warn('[projectLayout] operação recusada', op.op, err)
      return null
    }
  },

  openGroupSheet: (groupId, selectName = false) => set({ sheetGroupId: groupId, sheetSelectName: selectName }),
  closeGroupSheet: () => set({ sheetGroupId: null, sheetSelectName: false })
}))
