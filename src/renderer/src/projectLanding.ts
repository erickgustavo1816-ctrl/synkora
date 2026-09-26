import type { Mission, VersionStats } from './store'

// A LANDING DO UNIVERSO — as contas do ✦ geral, fora do React (2026-08-15).
//
// Duas telas dividem a mesma coluna: o CONVITE (universo sem nenhuma missão) e
// o PAINEL DO PROJETO (a partir da primeira). Quem decide qual delas aparece,
// quanto cada número vale e o que a data de uma linha diz mora aqui, puro e
// testável — no componente ficaria escondido atrás de JSX.
//
// REGRA DE HONESTIDADE (a que mais custou): número só entra na tela com fonte
// real. `updatedAt` NUNCA é "última atividade": ele só se move em mutação de
// store (status, seat, branch), nunca numa mensagem do chat ou num commit. O
// que dá para dizer com verdade é quando a missão nasceu e quando ela integrou.

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

const isLive = (mission: Mission): boolean =>
  mission.status === 'ativa' || mission.status === 'integrando'
const isPlanning = (mission: Mission): boolean => mission.missionType === 'planejamento'

/** "1 missão", "3 missões". */
export function missionCount(count: number): string {
  return `${count} ${count === 1 ? 'missão' : 'missões'}`
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
  const vivas = missions.filter(isLive)
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
  return missions.filter(isLive).sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt))
}

function timeOf(iso?: string): number {
  if (!iso) return 0
  const at = new Date(iso).getTime()
  return Number.isFinite(at) ? at : 0
}

/** `dd/mm` no ano corrente, `dd/mm/aaaa` fora dele; null sem data legível. */
export function shortDay(iso: string | undefined, now: Date = new Date()): string | null {
  if (!iso) return null
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return null
  return at.getFullYear() === now.getFullYear()
    ? at.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
    : at.toLocaleDateString('pt-BR')
}

/**
 * A data da linha, com o VERBO certo: integrada mostra quando integrou (e só
 * quando o carimbo existe); qualquer outra mostra quando nasceu. Sem data
 * legível a linha simplesmente não fala de tempo.
 */
export function missionDayLabel(mission: Mission, now: Date = new Date()): string | null {
  if (mission.status === 'concluida') {
    const done = shortDay(mission.completedAt, now)
    return done ? `integrada em ${done}` : null
  }
  const born = shortDay(mission.createdAt, now)
  return born ? `criada em ${born}` : null
}

/* ---------- OS ESTADOS DA LANDING (R38, 2026-08-24) ----------

   A reprovação de 2026-08-24: universo com a 0.1.1 COMPLETA e nada vivo. A
   tela mostrava três zeros grandes e uma coluna vazia — e não contava a única
   história do momento, que é "a versão está pronta esperando o lançamento".

   A máquina de estados é pequena e mecânica de propósito:
     · vivas > 0                          → o retrato de hoje (o de sempre);
     · vivas = 0 e versão completa aberta → o MARCO da versão;
     · universo zerado                    → o convite (`projectLanding`).
   Nenhum estado inventa dado: o marco só existe com uma linha de versão que o
   `homeStats` já conta como completa. */

/**
 * A versão que merece o palco, ou `null` quando o momento é o retrato de hoje.
 * Duas ou mais completas: a PRIMEIRA da lista — o `versoes` chega da mais
 * antiga para a mais nova e o release é serial, então a que espera há mais
 * tempo é a que se lança primeiro.
 */
export function landingMilestone(
  missions: readonly Mission[],
  versoes?: readonly VersionStats[]
): VersionStats | null {
  if (!versoes || versoes.length === 0) return null
  if (liveMissions(missions).length > 0) return null
  return (
    versoes.find(
      // `missoesTotal > 0` é a cerca do 0 === 0: uma linha SEM missão nenhuma
      // não é uma versão pronta, é uma versão vazia.
      (v) => !v.lancada && v.missoesTotal > 0 && v.missoesFeitas === v.missoesTotal
    ) ?? null
  )
}

/** A fração da linha de versão em porcentagem inteira; sem denominador não há
 *  barra a preencher (0/0 nunca é 100%). */
export function versionPercent(feitas: number, total: number): number {
  if (!Number.isFinite(feitas) || !Number.isFinite(total) || total <= 0) return 0
  return Math.round((Math.min(Math.max(feitas, 0), total) / total) * 100)
}

export interface LandingHeadline {
  title: string
  /** ausente no marco: ali o título já nomeia a versão */
  building?: string
  progress?: { feitas: number; total: number }
}

export function landingHeadline(
  missions: readonly Mission[],
  versoes?: readonly VersionStats[]
): LandingHeadline {
  const marco = landingMilestone(missions, versoes)
  if (marco)
    return {
      title: `${marco.name} pronta para lançar`,
      progress: { feitas: marco.missoesFeitas, total: marco.missoesTotal }
    }
  const vivas = liveMissions(missions).length
  const title = vivas > 0 ? `${missionCount(vivas)} em andamento` : 'Nenhuma missão em andamento'
  const corrente = versoes?.find((v) => !v.lancada)
  if (!corrente) return { title }
  return {
    title,
    building: corrente.name,
    ...(corrente.missoesTotal > 0
      ? { progress: { feitas: corrente.missoesFeitas, total: corrente.missoesTotal } }
      : {})
  }
}

export function progressLabel(progress: { feitas: number; total: number }): string {
  const noun = progress.total === 1 ? 'missão integrada' : 'missões integradas'
  return `${progress.feitas} de ${progress.total} ${noun}`
}

export interface VersionLine {
  version: VersionStats
  ready: boolean
  /** quem espera o dono primeiro, depois a mais nova */
  live: Mission[]
  /** da integração mais recente para a mais antiga */
  done: Mission[]
}

export interface VersionWork {
  lines: VersionLine[]
  /** vivas que nenhuma linha aberta recebe: trabalho vivo nunca some do painel */
  loose: Mission[]
}

const newestDone = (a: Mission, b: Mission): number =>
  timeOf(b.completedAt) - timeOf(a.completedAt)

export function versionWork(
  missions: readonly Mission[],
  versoes: readonly VersionStats[] | undefined,
  versionLabelOf: (mission: Mission) => string | undefined,
  waiting: (mission: Mission) => boolean
): VersionWork {
  const lines: VersionLine[] = (versoes ?? [])
    .filter((v) => !v.lancada)
    .map((version) => ({
      version,
      ready: version.missoesTotal > 0 && version.missoesFeitas === version.missoesTotal,
      live: [],
      done: []
    }))
  const byName = new Map(lines.map((line) => [line.version.name, line]))
  const loose: Mission[] = []
  for (const mission of missions) {
    if (isPlanning(mission)) continue
    const label = versionLabelOf(mission)
    if (isLive(mission)) {
      // a mesma régua do `versionPortrait`: viva sem carimbo integra na corrente
      const host = label ? byName.get(label) : lines[0]
      if (host) host.live.push(mission)
      else loose.push(mission)
      continue
    }
    const line = label ? byName.get(label) : undefined
    if (mission.status === 'concluida' && line) line.done.push(mission)
  }
  const byUrgency = (a: Mission, b: Mission): number =>
    Number(waiting(b)) - Number(waiting(a)) || timeOf(b.createdAt) - timeOf(a.createdAt)
  for (const line of lines) {
    line.live.sort(byUrgency)
    line.done.sort(newestDone)
  }
  loose.sort(byUrgency)
  return { lines, loose }
}

/** Planejamento nunca integra: mora num bloco próprio, fora das linhas de versão. */
export function livePlanning(missions: readonly Mission[]): Mission[] {
  return liveMissions(missions).filter(isPlanning)
}

export interface ReleasedLine {
  name: string
  onMain: boolean
  /** da integração mais recente para a mais antiga */
  titles: string[]
}

export const RELEASED_LINES_CAP = 4

export function releasedLines(
  missions: readonly Mission[],
  versoes: readonly VersionStats[] | undefined,
  versionLabelOf: (mission: Mission) => string | undefined,
  versaoNaMain?: string,
  cap: number = RELEASED_LINES_CAP
): ReleasedLine[] {
  // sem o retrato não dá para saber quais linhas seguem abertas
  if (!versoes) return []
  const abertas = new Set(versoes.filter((v) => !v.lancada).map((v) => v.name))
  const groups = new Map<string, Mission[]>()
  for (const mission of missions) {
    if (mission.status !== 'concluida' || isPlanning(mission)) continue
    // concluída sem carimbo não entra em linha nenhuma: escolher uma seria inventar
    const name = versionLabelOf(mission)
    if (!name || abertas.has(name)) continue
    groups.set(name, [...(groups.get(name) ?? []), mission])
  }
  return [...groups.entries()]
    .map(([name, list]) => ({ name, list: [...list].sort(newestDone) }))
    .sort((a, b) => newestDone(a.list[0], b.list[0]))
    .slice(0, Math.max(0, cap))
    .map(({ name, list }) => ({
      name,
      onMain: name === versaoNaMain,
      titles: list.map((mission) => mission.title)
    }))
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
      registro não sabe dizer, e escolher um por ela seria inventar. E a exceção
      NÃO alcança o PLANEJAMENTO: ele fica fora de versão por régua de
      nascimento (escreve plano/ e nunca integra) — sem essa cerca, uma sessão
      de planejamento viva inflava o total da corrente.

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
        isLive(m) &&
        // planejamento nunca integra em versão: fora da corrente e da conta
        !isPlanning(m) &&
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
