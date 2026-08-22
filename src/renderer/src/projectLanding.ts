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

export interface ProjectKpis {
  /** missões vivas: 'ativa' + 'integrando' */
  emAndamento: number
  /** missões que já entraram na linha de destino */
  integradas: number
  /** na fila serial ⇪ ou esperando o aval do dono para entrar nela */
  naFila: number
  arquivadas: number
}

/**
 * O placar do universo. `naFila` conta o mesmo que o chip da barra: ticket na
 * fila serial, merge em curso, ou o ⇪ parado esperando o clique do dono (a
 * porteira é mecânica — pedido de agente nunca mergeia sozinho).
 */
export function projectKpis(missions: readonly Mission[]): ProjectKpis {
  const vivas = missions.filter((m) => m.status === 'ativa' || m.status === 'integrando')
  return {
    emAndamento: vivas.length,
    integradas: missions.filter((m) => m.status === 'concluida').length,
    naFila: vivas.filter(
      (m) => Boolean(m.integration) || m.status === 'integrando' || Boolean(m.pendingIntegrationApproval)
    ).length,
    arquivadas: missions.filter((m) => m.status === 'arquivada').length
  }
}

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

/**
 * A data da linha, com o VERBO certo: integrada mostra quando integrou (e só
 * quando o carimbo existe); qualquer outra mostra quando nasceu. Sem data
 * legível a linha simplesmente não fala de tempo.
 */
export function missionDayLabel(mission: Mission): string | null {
  if (mission.status === 'concluida') {
    const done = formatDay(mission.completedAt)
    return done ? `integrada em ${done}` : null
  }
  const born = formatDay(mission.createdAt)
  return born ? `criada em ${born}` : null
}

// `showsTaskCount` vivia aqui: guardava o `▣ feitas/total` para ele nunca
// aparecer como 0/0. Os CARDS morreram na purga F6 (2026-08-17) — o contador
// saiu inteiro, e um guarda de algo que não existe mais é debt, não proteção.

/* ---------- ATIVIDADE RECENTE (2026-08-17) ----------

   A cronologia do universo, montada SÓ com os dois carimbos que existem de
   verdade: `createdAt` (a missão nasceu) e `completedAt` (ela integrou). Não
   há evento de "arquivada" nem de "última atividade" porque não há carimbo
   para eles — `updatedAt` se move em qualquer mutação de store e chamá-lo de
   atividade seria a mentira que este módulo existe para não contar. */

export type MissionEventKind = 'criada' | 'integrada'

export interface MissionEvent {
  missionId: string
  title: string
  kind: MissionEventKind
  /** ISO do carimbo real do evento */
  at: string
  /** dd/mm/aaaa já formatado */
  day: string
}

/** Teto da faixa: ela é um relance da cronologia, não o histórico (esse é a
 *  aba Versões). */
export const RECENT_ACTIVITY_CAP = 6

export function missionTimeline(
  missions: readonly Mission[],
  cap: number = RECENT_ACTIVITY_CAP
): MissionEvent[] {
  const events: MissionEvent[] = []
  for (const mission of missions) {
    const born = formatDay(mission.createdAt)
    if (born && mission.createdAt)
      events.push({
        missionId: mission.id,
        title: mission.title,
        kind: 'criada',
        at: mission.createdAt,
        day: born
      })
    if (mission.status !== 'concluida') continue
    const done = formatDay(mission.completedAt)
    if (done && mission.completedAt)
      events.push({
        missionId: mission.id,
        title: mission.title,
        kind: 'integrada',
        at: mission.completedAt,
        day: done
      })
  }
  return events.sort((a, b) => timeOf(b.at) - timeOf(a.at)).slice(0, Math.max(0, cap))
}

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
