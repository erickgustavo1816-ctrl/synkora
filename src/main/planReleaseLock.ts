/**
 * A TRAVA DE RELEASE DO PLANO MESTRE (ordem do dono, 2026-08-17).
 *
 * "⇪ subir versão" RECUSA enquanto o plano do MAPA ainda tiver missão pendente
 * da versão que sobe. A recusa NOMEIA as pendentes e receita as DUAS saídas,
 * nas palavras dele: "ou eu excluo ou eu faço" — os dois verbos que a linha do
 * item mostra no mapa ("criar missão" e "excluir").
 *
 * MÓDULO PURO: entra a fotografia (plano mestre + carimbos de versão das
 * missões + a versão que sobe), sai a recusa ou `null`. O `releaseVersionImpl`
 * só chama — é o que deixa a régua ser provada em node puro (test:plan-release-lock)
 * em vez de conferida no olho dentro de um guard de 60 linhas.
 *
 * AMARRAÇÃO ITEM→VERSÃO — candidato (i) do handoff, decidido no design
 * (`.synkora/reports/DESIGN_RODADA_BUGS_2026-08-17B.md`, BUG 6): `Plan` NÃO
 * ganha `versionId`. A versão de um item é a da MISSÃO vinculada; item ainda
 * sem missão é trabalho aprovado pelo dono e não atribuído — ele conta contra
 * QUALQUER release, que é exatamente o caso "ou eu excluo ou eu faço". Nenhum
 * campo novo persistido, nenhuma mudança no contrato do planejador.
 */
import {
  effectivePlanItemStatus,
  type PlanItem,
  type PlanKind,
  type PlanMissionSnapshot,
  type PlanStatus
} from './plans'

/** O que a trava LÊ de um item — nada além disto entra na conta. */
export type PlanReleaseLockItem = Pick<PlanItem, 'id' | 'title' | 'status' | 'missionId'>

export interface PlanReleaseLockPlan {
  title: string
  kind: PlanKind
  status: PlanStatus
  items: readonly PlanReleaseLockItem[]
}

/** Fotografia da missão: o ESTADO (que decide o estado efetivo do item) e o
 *  CARIMBO DE VERSÃO (que decide de qual release ela é pendência). */
export interface PlanReleaseLockMission extends PlanMissionSnapshot {
  versionId?: string
}

export interface PlanReleaseLockInput {
  /** a versão que sobe */
  versionId: string
  versionName: string
  /** o plano MESTRE do universo (`activeMasterPlan`); ausente = não há nenhum */
  plan?: PlanReleaseLockPlan
  missions: readonly PlanReleaseLockMission[]
}

/** Só o que ainda é trabalho: concluída e descartada nunca chegam aqui. */
export type PlanReleasePendingStatus = 'planejada' | 'em_andamento'

export interface PlanReleasePendingItem {
  id: string
  title: string
  /** estado EFETIVO no instante da checagem, nunca o autoral */
  status: PlanReleasePendingStatus
  missionId?: string
}

export interface PlanReleaseLock {
  pending: PlanReleasePendingItem[]
  /** a recusa pronta, na voz dos guards irmãos do `releaseVersionImpl` */
  message: string
}

/** Teto da lista nomeada na recusa (padrão do `worktree.ts`: mostra os
 *  primeiros e DIZ quantos ficaram de fora — recusa não vira paredão). */
export const PLAN_RELEASE_LOCK_LIST_MAX = 6

/** Só o plano mestre ATIVO barra uma publicação: plano `livre` é recorte
 *  paralelo do dono, e mestre concluído/arquivado já saiu de cena. */
function blocksRelease(plan: { kind: PlanKind; status: PlanStatus }): boolean {
  return plan.kind === 'mestre' && plan.status === 'ativo'
}

/** O invariante do `PlanStore` garante no máximo um; a busca é o mesmo recorte
 *  do `create`/`setKind`, para a régua viver num lugar só. */
export function activeMasterPlan<T extends { kind: PlanKind; status: PlanStatus }>(
  plans: readonly T[]
): T | undefined {
  return plans.find((plan) => blocksRelease(plan))
}

export function planReleaseLock(input: PlanReleaseLockInput): PlanReleaseLock | null {
  const plan = input.plan
  if (!plan || !blocksRelease(plan)) return null

  const byId = new Map(input.missions.map((mission) => [mission.id, mission]))
  const pending: PlanReleasePendingItem[] = []
  for (const item of plan.items) {
    const mission = item.missionId ? byId.get(item.missionId) : undefined
    // Mesma semântica do mapa (`planView`): missão concluída ⇒ item concluído;
    // missão ARQUIVADA preserva o estado autoral — engavetar não faz o trabalho
    // acontecer, e a saída é excluir o item.
    const status = effectivePlanItemStatus(item, mission)
    if (status !== 'planejada' && status !== 'em_andamento') continue
    // Vínculo VIVO herda a versão da missão (missão sem carimbo não é pendência
    // de release nenhuma — a mesma régua do guard irmão de missões em
    // andamento). Vínculo apontando para missão que não existe mais cai aqui
    // como item solto: a autocura vai desvinculá-lo, e até lá é trabalho sem
    // casa, que nunca deve escapar por uma janela de reconciliação.
    if (mission && mission.versionId !== input.versionId) continue
    pending.push({
      id: item.id,
      title: item.title,
      status,
      ...(item.missionId ? { missionId: item.missionId } : {})
    })
  }
  if (pending.length === 0) return null
  return { pending, message: refusal(input.versionName, plan.title, pending) }
}

function refusal(
  versionName: string,
  planTitle: string,
  pending: readonly PlanReleasePendingItem[]
): string {
  const visible = pending
    .slice(0, PLAN_RELEASE_LOCK_LIST_MAX)
    .map((item) => `"${item.title}"`)
    .join(', ')
  const rest =
    pending.length > PLAN_RELEASE_LOCK_LIST_MAX
      ? ` +${pending.length - PLAN_RELEASE_LOCK_LIST_MAX}`
      : ''
  const title = planTitle.trim() || 'plano sem título'
  return (
    `a versão ${versionName} ainda tem ${pending.length} missão(ões) pendente(s) no plano mestre ` +
    `"${title}": ${visible}${rest} — faça (comece pelo mapa: "criar missão") ou exclua o item do ` +
    `plano ("excluir") antes de subir`
  )
}
