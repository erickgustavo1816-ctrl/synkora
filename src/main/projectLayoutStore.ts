// ————————————————————————————————————————————————————————————————————————
// O LAYOUT DOS UNIVERSOS NO MAIN (grupos, 2026-09-29): a ordem do rail e os
// grupos em `userData/project-layout.json`, arquivo PRÓPRIO — projects.json
// não muda de formato (R-12 de ./projects.ts).
//
// Sem import de Electron (testável em node puro: scripts/test-project-layout.mjs).
// A lista de universos entra por `listProjectIds`: toda leitura e toda
// operação partem do layout RECONCILIADO com ela, então universo criado ou
// removido fora daqui nunca deixa o rail desencontrado.
// ————————————————————————————————————————————————————————————————————————
import { loadJsonStore, persistJsonStore } from './jsonStore'
import {
  applyProjectLayoutOp,
  reconcileProjectLayout,
  sanitizeProjectLayout
} from '../shared/projectLayoutOps'
import type { ProjectLayout, ProjectLayoutOp, ProjectLayoutOpResult } from '../shared/projectLayout'

export interface ProjectLayoutStoreOptions {
  file: string
  listProjectIds: () => string[]
  /** gerador do id de grupo novo (o index passa `randomUUID`) */
  newId?: () => string
  /** padrão: persistJsonStore (atômico + .bak) — injetável para teste */
  persist?: (file: string, layout: ProjectLayout) => void
}

const hasEntries = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Array.isArray((value as { entries?: unknown }).entries)

export class ProjectLayoutStore {
  private layout: ProjectLayout

  constructor(private readonly options: ProjectLayoutStoreOptions) {
    // principal corrompido cai no .bak; os dois ruins = layout vazio (a
    // reconciliação devolve os universos soltos, na ordem do projects.json)
    this.layout = sanitizeProjectLayout(loadJsonStore<unknown>(options.file, () => null, hasEntries))
  }

  get(): ProjectLayout {
    return this.reconcile().layout
  }

  /** Encaixa o layout na lista de universos atual; grava só quando mudou. */
  reconcile(): { layout: ProjectLayout; changed: boolean } {
    const next = reconcileProjectLayout(this.layout, this.options.listProjectIds())
    if (next === this.layout) return { layout: next, changed: false }
    this.commit(next)
    return { layout: next, changed: true }
  }

  apply(op: ProjectLayoutOp): ProjectLayoutOpResult {
    const current = this.reconcile().layout
    const result = applyProjectLayoutOp(current, op, { newId: this.options.newId })
    if (result.layout !== current) this.commit(result.layout)
    return result
  }

  private commit(layout: ProjectLayout): void {
    this.layout = layout
    const persist = this.options.persist ?? persistJsonStore
    try {
      persist(this.options.file, layout)
    } catch (err) {
      // o layout segue valendo em memória; a próxima mudança tenta gravar de novo
      console.warn('[projectLayout] gravação falhou', err)
    }
  }
}
