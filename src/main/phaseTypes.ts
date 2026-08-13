/**
 * TIPOS DA MÁQUINA DE FASES (dev / review / qa) — commit 0 da Fase 1.
 *
 * Extraídos do closure do whenReady (src/main/index.ts) na cirurgia do índice
 * — ver docs/PLANO_NIVEL_5.md e docs/FASE1_MAPA_MAINCONTEXT.md. Módulo PURO:
 * só tipos, nada de electron/fs/estado vivo. Os Maps/Sets que usam estes
 * tipos continuam no index (viram MainContext no commit 1); o phaseEngine
 * (commit 3) passa a importar daqui.
 */
import type { TaskWorktree } from './worktree'

export type RunPhase = 'dev' | 'review' | 'qa'

export interface DevPaneSpec {
  /** id do pane definido pelo MAIN (o hub conhece cada pane pelo id) */
  paneId: string
  kind: 'claude' | 'codex'
  seatId: string
  model?: string
  cwd: string
  cliArgs?: string[]
  initialPrompt: string
  /** persona de SUBAGENTE do ajudante (delegate.agent) — claude via
   *  --append-system-prompt; codex vai por -c developer_instructions */
  appendSystemPrompt?: string
  logFile: string
  title: string
  role: RunPhase | 'ajudante'
  /** missão dona do pane — o mapa da aba Panes agrupa por aqui */
  missionId?: string
  /** pane que delegou (ajudante) — o mapa pendura o card no dev certo */
  delegatorPaneId?: string
}

export interface PhaseWatch {
  projectId: string
  taskId: string
  phase: RunPhase
  /** seat/modelo/effort do DEV (os gates resolvem o próprio pela política do qa) */
  devSeatId: string
  devModel?: string
  devEffort?: string
  cwd: string
  worktree: TaskWorktree | null
  logFile: string
  marker: string
  paneId?: string
  /** Instante do registro. O poller de 3s NÃO pode soltar um watch recém-
   * criado por divergência de status: o preparePhasePane registra o watch
   * ANTES do tasks.update para 'execucao' e há awaits (skill sync ~0,7s+)
   * entre os dois — corrida real 2026-08-06: o tick caiu na janela, deletou
   * o watch em silêncio e o report(done) do dev ficou recusado para sempre
   * com o card preso em execucao/dev/pending. */
  createdAt: number
  /** Fotografia persistida no card e copiada aqui para recusar qualquer
   * alteracao feita por review/QA, inclusive depois de um restart. */
  gateBaselineFingerprint?: string
  gateStartedAt?: string
  /** Patch grande entregue fora do prompt; bytes ficam presos a esta rodada. */
  reviewArtifact?: {
    /** Caminho app-private; nunca é revelado ao DEV nem ao gate. */
    privatePath: string
    sha256: string
    bytes: number
    /** Manifesto calculado quando os bytes sao congelados. Cada bloco lido
     * precisa bater com este hash antes de ser devolvido ao reviewer. */
    chunks: Array<{
      offset: number
      bytes: number
      sha256: string
    }>
    /** Cursor servido sequencialmente ao reviewer pela tool privada. */
    servedUntil: number
    lastServedOffset?: number
    lastServedNextOffset?: number
  }
  /** Mesma decisão/capacidade usada pelo prompt e pelo guard do report. */
  uiWork?: boolean
  browserAvailable?: boolean
  /** Rodada QUICK (ajuste rápido do dono): evidência do delta basta. */
  quickRound?: boolean
  /** Capacidade de browser DO DEV, carimbada quando o watch da fase dev nasce
   * e carregada pelos watches de gate: o re-arm do dev vivo (retryOrBacklog)
   * restaura ESTE valor, nunca o do gate — bug real 2026-08-11/12: o spread
   * do watch do REVIEWER (browser false por desenho) fazia o done seguinte do
   * dev ser recusado como "sem browser/runtime" e o pane inteiro reciclar. */
  devBrowserAvailable?: boolean
  /** Snapshot criado pelo guard de report e validado por diagnóstico antes
   * de a chamada poder avançar para review/QA. */
  devSnapshot?: {
    head: string
    tree: string
    fingerprint: string
    baseHead?: string
  }
  /** Última re-abertura automática por push perdido (CHECK 17) — teto de
   * 1 tentativa a cada 2min para nunca virar loop de respawn. */
  lastOpenLostRetryAt?: number
}

/** Gate de integração pendente por missão (espelho do phaseWatches de tarefa). */
export interface MissionWatch {
  projectId: string
  missionId: string
  marker: string
  logFile: string
  paneId: string
}

/** Pergunta dirigida ao USUÁRIO (tool ask_user) — persistida entre boots. */
export type PendingUserQuestion = {
  projectId: string
  missionKey: string
  question: string
  at: string
}

/** Espera de GATE VIVO: reprovação limpa não fecha o pane — o próximo done
 *  do dev recicla a MESMA conversa (ver o bloco do liveGateWaits no index). */
export interface LiveGateWait {
  phase: 'review' | 'qa'
  paneId: string
  rejectedHead?: string
  rejectedReason: string
  rejectedAt: string
  /** gateNotes no instante da reprovação — waiver NOVO legitima rodada com
   *  head idêntico (o juiz pode anular pontos sem exigir commit). */
  gateNotesAtRejection?: string
}
