import type { PlanDraft, PlanKind, PlanMutationResult, PlanView } from './planContract'

// ÚNICA costura do renderer com `window.synkora.plans` (D4.2). Nenhum
// componente do mapa fala com a ponte direto — mesma regra do `guiApi.ts`.
//
// O acesso é resolvido A CADA CHAMADA por um cast estreito: o namespace pode
// nascer depois deste módulo ser importado (o motor é de outra frente) e o
// preview em browser puro roda sem ele. Sem ponte a UI DIZ isso; nunca finge
// que gravou.
//
// CAS EM TODO MUTADOR: a aba do plano fica aberta enquanto o agente edita pela
// tool, então `expectedUpdatedAt` é o que separa "eu decidi sobre o que estou
// vendo" de "escrevi por cima do que mudou" (padrão de `ipc/projectPlan.ts`).

/**
 * O que a ABA do plano pode escrever. `kind` NUNCA entra (canal próprio: a
 * designação é gesto do dono) e 'concluida' não é autoral — vem da missão
 * vinculada. Itens entram por MERGE de id: hoje só o verbo EXCLUIR do dono,
 * que marca 'descartada' e tira o item do progresso e da trava de release.
 */
export interface PlanBoardPatch {
  title?: string
  description?: string
  status?: 'ativo' | 'concluido'
  items?: { id: string; status: 'planejada' | 'em_andamento' | 'descartada' }[]
}

interface PlansBridge {
  list: (projectId: string) => Promise<PlanView[]>
  create: (projectId: string, draft: PlanDraft) => Promise<PlanMutationResult>
  update: (
    planId: string,
    patch: PlanBoardPatch,
    expectedUpdatedAt: string
  ) => Promise<PlanMutationResult>
  setKind: (
    planId: string,
    kind: PlanKind,
    expectedUpdatedAt: string
  ) => Promise<PlanMutationResult>
  archive: (planId: string, expectedUpdatedAt: string) => Promise<PlanMutationResult>
  remove: (planId: string, expectedUpdatedAt: string) => Promise<{ ok: boolean; error?: string }>
  linkMission: (
    planId: string,
    itemId: string,
    missionId: string,
    expectedUpdatedAt: string
  ) => Promise<PlanMutationResult>
  onChanged: (cb: (projectId: string) => void) => () => void
}

function bridge(): Partial<PlansBridge> | undefined {
  return (window as unknown as { synkora?: { plans?: Partial<PlansBridge> } }).synkora?.plans
}

const NO_BRIDGE = 'os planos ainda não estão disponíveis nesta janela'

function failure(error: unknown): { ok: false; error: string } {
  return { ok: false, error: error instanceof Error ? error.message : String(error) }
}

export const plansApi = {
  /** false = janela sem o namespace (preview de browser, ou motor ainda não
   *  mesclado): a aba mostra o aviso em vez de uma lista vazia mentirosa. */
  available(): boolean {
    return typeof bridge()?.list === 'function'
  },

  /** Já vem com o progresso derivado por item (a missão vinculada resolvida no
   *  main). Lista vazia é resposta legítima: projeto sem plano nenhum. */
  async list(projectId: string): Promise<PlanView[]> {
    const api = bridge()
    if (!api?.list) return []
    try {
      const plans = await api.list(projectId)
      return Array.isArray(plans) ? plans : []
    } catch {
      return []
    }
  },

  async create(projectId: string, draft: PlanDraft): Promise<PlanMutationResult> {
    const api = bridge()
    if (!api?.create) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.create(projectId, draft)
    } catch (error) {
      return failure(error)
    }
  },

  async update(
    planId: string,
    patch: PlanBoardPatch,
    expectedUpdatedAt: string
  ): Promise<PlanMutationResult> {
    const api = bridge()
    if (!api?.update) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.update(planId, patch, expectedUpdatedAt)
    } catch (error) {
      return failure(error)
    }
  },

  /** DESIGNAÇÃO: promover/rebaixar o plano mestre. Canal PRÓPRIO — `kind` nunca
   *  entra num patch, senão `update_plan` daria ao agente o gesto do dono. */
  async setKind(
    planId: string,
    kind: PlanKind,
    expectedUpdatedAt: string
  ): Promise<PlanMutationResult> {
    const api = bridge()
    if (!api?.setKind) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.setKind(planId, kind, expectedUpdatedAt)
    } catch (error) {
      return failure(error)
    }
  },

  /** Arquivar é reversível e o agente também alcança (delete_plan = soft). */
  async archive(planId: string, expectedUpdatedAt: string): Promise<PlanMutationResult> {
    const api = bridge()
    if (!api?.archive) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.archive(planId, expectedUpdatedAt)
    } catch (error) {
      return failure(error)
    }
  },

  /** Exclusão DEFINITIVA — só pelo gesto do dono no mapa, nunca por tool. */
  async remove(
    planId: string,
    expectedUpdatedAt: string
  ): Promise<{ ok: boolean; error?: string }> {
    const api = bridge()
    if (!api?.remove) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.remove(planId, expectedUpdatedAt)
    } catch (error) {
      return failure(error)
    }
  },

  /** Amarra o item à missão recém-criada pelo dono (mesmo gesto, uma escrita). */
  async linkMission(
    planId: string,
    itemId: string,
    missionId: string,
    expectedUpdatedAt: string
  ): Promise<PlanMutationResult> {
    const api = bridge()
    if (!api?.linkMission) return { ok: false, error: NO_BRIDGE }
    try {
      return await api.linkMission(planId, itemId, missionId, expectedUpdatedAt)
    } catch (error) {
      return failure(error)
    }
  },

  /** `plans:changed` — o agente edita por tool e a aba aberta acompanha. */
  onChanged(cb: (projectId: string) => void): () => void {
    const api = bridge()
    if (!api?.onChanged) return () => undefined
    try {
      return api.onChanged(cb) ?? (() => undefined)
    } catch {
      return () => undefined
    }
  }
}
