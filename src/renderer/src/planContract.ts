// CONTRATO DO PLANO (Synkora 2.0 — menu de planejamento do MAPA).
//
// Fonte única: `.synkora/reports/DESIGN_PLANNING_MENU_2026-08-15.md`, decisões
// D4.1 (modelo) e D4.4 (proposta no chat). O main é dono do `PlanStore`
// (`src/main/plans.ts`) e do IPC; este módulo é o ESPELHO do renderer — a mesma
// convenção do `guiApi.ts`, que copia a união do `SessionEvent` VERBATIM.
//
// Módulo de TIPOS, e só. Ele é importado por `import type` em todo lugar —
// inclusive no `guiApi.ts`, que é carregado pelas suítes com o strip-types do
// node: import de VALOR entre irmãos exigiria extensão no especificador, que o
// `moduleResolution: bundler` deste projeto recusa. Por isso a leitura
// defensiva do rascunho mora onde ela é usada (`readPlanDraft`, no guiApi —
// espelho 3 do contrato dos cinco espelhos).
//
// FRONTEIRA DE NOME (risco R4 da investigação): "Plan" aqui NUNCA é o
// `ProjectPlan` do roadmap F6 (`.synkora/PROJECT_PLAN.json`, era legada) nem o
// `TaskPlan` do orquestrador de missão. Três coisas, três nomes.

/** No máximo UM plano `mestre` ativo por projeto; o resto é `livre`. */
export type PlanKind = 'mestre' | 'livre'

export type PlanStatus = 'ativo' | 'concluido' | 'arquivado'

/** Tamanho declarado pelo planejador — espelha as seções do PLANNING_CONTRACT. */
export type PlanItemTier = 'pequeno' | 'medio' | 'grande'

/** `em_andamento`/`concluida` são DERIVADOS da missão vinculada: o agente nunca
 *  os escreve (D4.3), e o mapa nunca os persiste por conta própria. */
export type PlanItemStatus = 'planejada' | 'em_andamento' | 'concluida' | 'descartada'

export interface PlanItem {
  id: string
  title: string
  /** o que esta missão entrega, em prosa curta */
  objective: string
  outOfScope?: string
  doneCriteria: string[]
  tier?: PlanItemTier
  context?: string
  /** ids de outros `PlanItem` do MESMO plano */
  dependsOn: string[]
  order: number
  status: PlanItemStatus
  /** missão real criada a partir deste item (gesto do dono, nunca do agente) */
  missionId?: string
  /** brief em prosa no repo do produto, ex.: `plano/003-fila.md` */
  docPath?: string
  createdAt: string
  updatedAt: string
}

export type PlanOrigin =
  | { paneId: string; missionId?: string; proposedAt: string }
  | { manual: true }

export interface Plan {
  id: string
  projectId: string
  title: string
  description?: string
  kind: PlanKind
  status: PlanStatus
  origin: PlanOrigin
  items: PlanItem[]
  order: number
  createdAt: string
  updatedAt: string
  approvedAt?: string
  archivedAt?: string
}

/** Fotografia da missão vinculada que o main resolve na leitura (`plans:list`).
 *  O renderer PREFERE a missão viva do store — que muda a cada evento — e cai
 *  aqui quando ela não está carregada (missão arquivada, por exemplo). */
export interface PlanItemMissionView {
  id: string
  title: string
  status: 'ativa' | 'integrando' | 'concluida' | 'arquivada'
  pendingIntegrationApproval?: boolean
}

export interface PlanItemView extends PlanItem {
  mission?: PlanItemMissionView
}

export interface PlanView extends Omit<Plan, 'items'> {
  items: PlanItemView[]
}

// ————— rascunho (o que o agente propõe; vira Plan no clique do dono) —————

export interface PlanItemDraft {
  /** chave do próprio agente, usada só para amarrar `dependsOn` DENTRO do
   *  rascunho — o id definitivo nasce no store, na aprovação. */
  id?: string
  title: string
  objective: string
  outOfScope?: string
  doneCriteria?: string[]
  tier?: PlanItemTier
  context?: string
  dependsOn?: string[]
  docPath?: string
}

export interface PlanDraft {
  title: string
  description?: string
  kind?: PlanKind
  items: PlanItemDraft[]
}

export type PlanMutationResult =
  | { ok: true; plan: PlanView }
  | { ok: false; error: string }
