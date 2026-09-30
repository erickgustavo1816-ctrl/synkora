import { openSoloMission } from '../../shared/projectVersioning'

// O UNIVERSO SEM VERSIONAMENTO — as decisões da tela, fora do React
// (2026-09-30; mockup aprovado: docs/mockups/projeto-sem-versao-2026-09-30.html).
//
// A tela tem três vistas e uma régua para cada: a MISSÃO aberta ocupa a tela
// inteira (uma por vez, a regra da costura `openSoloMission`); sem ela, o
// INÍCIO (a folha de escrever + o histórico das finalizadas) ou a LEITURA de
// uma finalizada, no mesmo lugar. Aqui também moram o estado do FINALIZAR, o
// aviso de finalizar no meio do turno e as palavras do livro-razão — tudo o
// que no componente ficaria escondido atrás de JSX.
//
// Módulo puro: tipos estruturais, nada de store (as suítes node o carregam
// sozinho). Vocabulário do modo: pasta, edições, finalizar, histórico — nunca
// branch, commit ou versão.

/** O que a tela lê de uma missão (espelho estrutural de `Mission` do store). */
export interface SoloMissionLike {
  id: string
  projectId: string
  title: string
  status: string
  createdAt: string
  updatedAt?: string
  completedAt?: string
  summary?: string
}

export type SoloProjectView<M> =
  | { kind: 'mission'; mission: M }
  | { kind: 'reading'; mission: M }
  | { kind: 'start' }

/**
 * A missão aberta É a tela; sem ela, a leitura pedida (só de missão
 * FINALIZADA deste projeto) ou o Início. Com uma missão aberta a leitura não
 * rouba a tela: ela só é alcançável a partir do Início.
 */
export function soloProjectView<M extends SoloMissionLike>(
  missions: readonly M[],
  projectId: string,
  readingId: string | null
): SoloProjectView<M> {
  const open = openSoloMission(missions, projectId)
  if (open) return { kind: 'mission', mission: open }
  const reading = readingId
    ? missions.find((m) => m.id === readingId && m.projectId === projectId && m.status === 'concluida')
    : undefined
  return reading ? { kind: 'reading', mission: reading } : { kind: 'start' }
}

/** Quando a missão foi finalizada. Sem o carimbo, a última mutação do
 *  registro — que numa missão finalizada é justamente o finalizar. */
function finishedAt(mission: SoloMissionLike): string {
  return mission.completedAt ?? mission.updatedAt ?? mission.createdAt
}

function time(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/** O histórico: só as FINALIZADAS deste projeto, a mais recente primeiro. */
export function soloHistory<M extends SoloMissionLike>(missions: readonly M[], projectId: string): M[] {
  return missions
    .filter((m) => m.projectId === projectId && m.status === 'concluida')
    .sort((a, b) => time(finishedAt(b)) - time(finishedAt(a)) || time(b.createdAt) - time(a.createdAt))
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']

/** Data curta do livro-razão, no fuso do dono: "30 set" + "11:02". Outro ano
 *  ganha o ano ("31 dez 2025") — senão "3 jan" mentiria. */
export function ledgerWhen(iso: string, now: Date = new Date()): { day: string; time: string } | null {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return null
  const day = `${date.getDate()} ${MONTHS[date.getMonth()]}${
    date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`
  }`
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return { day, time: `${hh}:${mm}` }
}

/** A frase de quando falta o resumo: a linha DIZ isso, em vez de sumir. */
export const SOLO_SUMMARY_MISSING = 'sem resumo: o agente não deixou um'

export interface SoloHistoryRow {
  id: string
  title: string
  day: string
  time: string
  /** a frase do `mission_summary`; null = o agente não deixou uma */
  summary: string | null
  /** nome acessível da linha inteira (é um botão) */
  label: string
}

export function soloHistoryRow(mission: SoloMissionLike, now: Date = new Date()): SoloHistoryRow {
  const when = ledgerWhen(finishedAt(mission), now)
  const summary = mission.summary?.trim()
  return {
    id: mission.id,
    title: mission.title,
    day: when?.day ?? '',
    time: when?.time ?? '',
    summary: summary ? summary : null,
    label: `Ler a missão ${mission.title}`
  }
}

/** "finalizada em 29 set, 16:05" — a linha da cabeça da leitura. */
export function soloFinishedLabel(mission: SoloMissionLike, now: Date = new Date()): string {
  const when = ledgerWhen(finishedAt(mission), now)
  return when ? `finalizada em ${when.day}, ${when.time}` : 'finalizada'
}

/** O turno do agente está ABERTO (trabalhando ou esperando o dono no meio
 *  dele) — a mesma régua do chip de conta da cabeça do palco. */
export function soloTurnOpen(status: string | undefined): boolean {
  return status === 'working' || status === 'waiting-you'
}

/**
 * O FINALIZAR na cabeça do palco:
 *  - `blocked` — a missão ainda escolhe a conta (a saída é escolher uma);
 *  - `ready`   — o agente entregou o resumo e fechou o turno: botão laranja da
 *                casa com UM anel (sinal, não enfeite);
 *  - `rest`    — tinta, o resto do tempo.
 */
export type SoloFinishButton = 'blocked' | 'rest' | 'ready'

export function soloFinishButton(input: {
  needsSeat: boolean
  summary: string | undefined
  turnOpen: boolean
}): SoloFinishButton {
  if (input.needsSeat) return 'blocked'
  return input.summary?.trim() && !input.turnOpen ? 'ready' : 'rest'
}

export interface SoloFinishRisk {
  headline: string
  consequence: string
}

/** O aviso de finalizar no meio do trabalho: fala só do que existe (agente no
 *  turno, ajudantes rodando), com plural certo. `null` = nada a interromper. */
export function soloFinishRisk(input: {
  turnOpen: boolean
  /** há quanto tempo o turno corre ("2:14"); null = relógio desarmado */
  elapsed: string | null
  helpersRunning: number
}): SoloFinishRisk | null {
  const { turnOpen, elapsed, helpersRunning } = input
  if (!turnOpen && helpersRunning <= 0) return null
  const helpers =
    helpersRunning === 1 ? '1 ajudante ainda trabalha' : `${helpersRunning} ajudantes ainda trabalham`
  const agent = `O agente está no meio de uma resposta${elapsed ? ` (há ${elapsed})` : ''}`
  const headline = turnOpen
    ? helpersRunning > 0
      ? `${agent} e ${helpers}.`
      : `${agent}.`
    : `${helpers}.`
  const stops = turnOpen
    ? helpersRunning === 0
      ? 'o agente'
      : helpersRunning === 1
        ? 'os dois'
        : 'o agente e os ajudantes'
    : helpersRunning === 1
      ? 'o ajudante'
      : 'os ajudantes'
  return {
    headline,
    consequence: `Finalizar agora interrompe ${stops}, e uma edição feita pela metade pode ficar na pasta.`
  }
}

export const SOLO_TITLE_NEEDED = 'Dê um título para a missão.'

/** O pedido de missão do Início: título obrigatório, objetivo opcional, e a
 *  natureza é sempre a de desenvolvimento direto (planejamento e release não
 *  existem neste modo). */
export type SoloStartDraft =
  | {
      ok: true
      input: { title: string; goal?: string; direct: true; missionType: 'dev' }
    }
  | { ok: false; error: string }

export function soloStartDraft(title: string, goal: string): SoloStartDraft {
  const cleanTitle = title.trim()
  if (!cleanTitle) return { ok: false, error: SOLO_TITLE_NEEDED }
  const cleanGoal = goal.trim()
  return {
    ok: true,
    input: { title: cleanTitle, ...(cleanGoal ? { goal: cleanGoal } : {}), direct: true, missionType: 'dev' }
  }
}

/** As duas abas do modo. O valor guardado segue o do store ('board' = Missão),
 *  e qualquer valor antigo (mapa, versões) cai na Missão. */
export function soloUniverseTab(tab: string | undefined): 'missao' | 'arquivos' {
  return tab === 'arquivos' ? 'arquivos' : 'missao'
}
