import type { Mission, VersionStats } from './store'

// A LANDING DO UNIVERSO — as contas do ✦ geral, fora do React (2026-08-15).
//
// Duas telas dividem a mesma coluna: o CONVITE (universo sem nenhuma missão) e
// o PAINEL DO PROJETO (a partir da primeira). Quem decide qual delas aparece,
// quanto cada número vale e o que a data de uma linha diz mora aqui, puro e
// testável — no componente ficaria escondido atrás de JSX.
//
// REGRA DE HONESTIDADE (a que mais custou): número só entra na tela com fonte
// real. Missão 2.0 não cria card nenhum, então `▣ 0/0` seria uma mentira dita
// com confiança — por isso `showsTaskCount`. E `updatedAt` NUNCA é "última
// atividade": ele só se move em mutação de store (status, seat, branch), nunca
// numa mensagem do chat ou num commit. O que dá para dizer com verdade é
// quando a missão nasceu e quando ela integrou.

/** Qual das duas telas o ✦ geral mostra. */
export type ProjectLanding = 'invite' | 'dashboard'

/**
 * ZERO missões de QUALQUER status = convite; a partir da primeira, painel
 * (decisão do dono, 2026-08-15). O critério é "qualquer status" de propósito:
 * um universo cujas missões já integraram TEM história — devolvê-lo ao
 * "crie a primeira missão" apagaria o que ele já entregou.
 */
export function projectLanding(missions: readonly Mission[]): ProjectLanding {
  return missions.length === 0 ? 'invite' : 'dashboard'
}

// `projectKpis` vivia aqui (os quatro tiles do painel largo). O painel morreu
// na Onda B do RIGHTDOCK (2026-08-22, mockup aprovado): o retrato compacto
// conta vivas com `liveMissions` e a espera com a régua única
// (`waitingOnOwner` do missionPresentation) — um placar de quatro números sem
// tela é debt, não proteção.

/** Missões vivas, mais recente primeiro — as linhas do topo do painel. */
export function liveMissions(missions: readonly Mission[]): Mission[] {
  return missions
    .filter((m) => m.status === 'ativa' || m.status === 'integrando')
    .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt))
}

/** Teto padrão da seção "integradas": o painel resume, não vira histórico. */
export const RECENT_CONCLUDED_CAP = 5

/**
 * Integradas, mais recentes primeiro. Ordena por `completedAt` (o carimbo da
 * transição para 'concluida') e cai em `createdAt` quando a missão é antiga
 * demais para tê-lo — nunca em `updatedAt`, que mede outra coisa.
 */
export function recentConcluded(
  missions: readonly Mission[],
  cap: number = RECENT_CONCLUDED_CAP
): Mission[] {
  return missions
    .filter((m) => m.status === 'concluida')
    .sort((a, b) => concludedAt(b) - concludedAt(a))
    .slice(0, Math.max(0, cap))
}

function concludedAt(mission: Mission): number {
  return timeOf(mission.completedAt) || timeOf(mission.createdAt)
}

function timeOf(iso?: string): number {
  if (!iso) return 0
  const at = new Date(iso).getTime()
  return Number.isFinite(at) ? at : 0
}

/** dd/mm/aaaa, ou null quando a data não existe/não é legível. */
export function formatDay(iso?: string): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return null
  return at.toLocaleDateString('pt-BR')
}

// `showsTaskCount` vivia aqui: guardava o `▣ feitas/total` para ele nunca
// aparecer como 0/0. Os CARDS morreram na purga F6 (2026-08-17) — o contador
// saiu inteiro, e um guarda de algo que não existe mais é debt, não proteção.
// `missionDayLabel` e `missionTimeline` (a data com verbo e a cronologia do
// painel largo) morreram com ele na Onda B do RIGHTDOCK (2026-08-22): o
// retrato compacto data as entregas com `formatDay` sobre o carimbo real.

/* ---------- ATRIBUIÇÃO DE VERSÃO (ordem do dono, 2026-08-17) ----------

   O dono leu "◈ V1.0" no alto do universo ao lado de contadores que somavam
   missão de outra linha, e ordenou duas regras:

   1. O ◈ de IDENTIDADE responde UMA pergunta — "o que está na main?" — e a
      resposta é a última versão LANÇADA. A régua antiga elegia a versão ABERTA
      mais antiga, que é o oposto: a linha em CONSTRUÇÃO, que ainda não subiu.
      Sem nenhum release o chip não existe; escrever "◈ V1.0" num projeto que
      nunca lançou é afirmar um release que não aconteceu.

   2. Cada LINHA de versão conta as missões CARIMBADAS nela (`mission.versionId`
      — o carimbo que `createMissionImpl` grava no nascimento). Uma só exceção,
      deliberada: missão VIVA sem carimbo conta na versão corrente, porque é
      nela que ela vai integrar (`ensureDefaultVersion`). Missão concluída sem
      carimbo não entra em linha nenhuma — ela integrou em algum lugar que o
      registro não sabe dizer, e escolher um por ela seria inventar.

   O módulo é puro de propósito: quem lê o disco é o `loadHomeStats`. */

/** O recorte de versão que a atribuição precisa — o `Version` do store o
 *  satisfaz por estrutura, e assim o cálculo não depende do store inteiro. */
export interface VersionRef {
  id: string
  name: string
  status: 'aberta' | 'lancada'
  createdAt: string
  releasedAt?: string
  deliveries: readonly { missionId: string }[]
}

export interface VersionPortrait {
  /** uma linha por versão ABERTA, da mais antiga para a mais nova; sem nenhuma
   *  aberta, a última lançada entra sozinha como referência do que ela entregou */
  versoes: VersionStats[]
  /** o que está NA MAIN: nome da última versão lançada. Ausente = nada subiu
   *  ainda, e nesse caso a tela não mostra chip de identidade nenhum. */
  versaoNaMain?: string
}

export function versionPortrait(
  versions: readonly VersionRef[],
  missions: readonly Mission[]
): VersionPortrait {
  const abertas = [...versions]
    .filter((v) => v.status === 'aberta')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const lancadas = [...versions]
    .filter((v) => v.status === 'lancada')
    .sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''))
  const refs = abertas.length ? abertas : lancadas.slice(0, 1)
  const corrente = abertas[0]?.id

  const versoes = refs.map((v) => {
    // FEITAS por DUAS provas da mesma verdade, unidas por id de missão: o
    // RECIBO da integração (`deliveries` — sobrevive à missão ser arquivada ou
    // excluída, e ela subiu de verdade) e o STATUS concluído carimbado nesta
    // versão (cobre missão antiga cujo recibo nunca foi registrado). Set, e não
    // soma, porque o caso normal é a mesma missão aparecer nas duas.
    const feitas = new Set(v.deliveries.map((d) => d.missionId))
    for (const m of missions)
      if (m.status === 'concluida' && m.versionId === v.id) feitas.add(m.id)

    const vivas = missions.filter(
      (m) =>
        (m.status === 'ativa' || m.status === 'integrando') &&
        !feitas.has(m.id) &&
        (m.versionId === v.id || (!m.versionId && v.id === corrente))
    ).length

    return {
      name: v.name,
      lancada: v.status === 'lancada',
      missoesFeitas: feitas.size,
      missoesTotal: feitas.size + vivas
    }
  })

  return { versoes, ...(lancadas[0] ? { versaoNaMain: lancadas[0].name } : {}) }
}

/**
 * RIGHTDOCK Onda B — a linha em CONSTRUÇÃO ("V1.0.6 em desenvolvimento" do
 * mockup): a versão aberta CORRENTE, que no retrato é a primeira não-lançada
 * (o `versionPortrait` já ordena as abertas da mais antiga para a mais nova —
 * a mesma régua do `ensureDefaultVersion`). É a resposta de "onde o trabalho
 * de agora integra", NUNCA a identidade — essa continua sendo `versaoNaMain`,
 * e sem nenhuma aberta o helper cala em vez de apontar uma lançada.
 */
export function versionInDev(versoes?: readonly VersionStats[]): string | undefined {
  return versoes?.find((v) => !v.lancada)?.name
}
