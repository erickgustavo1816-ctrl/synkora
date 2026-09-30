/**
 * MAINCONTEXT — contrato explícito do estado do main (Fase 1, commit 1).
 *
 * A cirurgia do índice (docs/PLANO_NIVEL_5.md + docs/FASE1_MAPA_MAINCONTEXT.md)
 * extrai módulos (ipc/, missionEngine, paneLifecycle…) que recebem ESTE
 * contrato em vez de viver no closure do whenReady. Aqui só há TIPOS — o
 * objeto é construído no index, logo após o hub nascer, expondo o que já
 * existe (qualquer divergência de shape quebra o typecheck).
 *
 * Regras de implementação (valem para quem constrói e para quem consome):
 * - Campos `readonly` podem ser getter por trás: variáveis reatribuídas em
 *   runtime (uiSender, hub, mcpPort…) e consts declaradas DEPOIS do ponto de
 *   construção entram como getter — leia sempre via ctx, nunca copie o valor.
 * - `ctx.tasks`: onMutation/onCreate/onRemove são atribuídos pelo index
 *   pós-construção — módulos que recebem o contexto NUNCA os reatribuem.
 * - `ctx.push` é o caminho único para empurrar evento à janela principal
 *   (encapsula o padrão `uiSender && !uiSender.isDestroyed()` — CHECK 17).
 */
import type { BrowserWindow, WebContents } from 'electron'
import type { ProjectStore } from './projects'
import type { SeatStore } from './seats'
import type { MissionStore } from './missions'
import type { PlanStore } from './plans'
import type { IntegrationQueueStore } from './integrationQueue'
import type { BacklogStore } from './backlog'
import type { MaestroStore } from './maestroStore'
import type { SettingsStore } from './settings'
import type { PtyManager } from './pty'
import type { SynVoiceService } from './synVoice'
import type { Blackbox } from './blackbox'
import type { StallAttribution } from './stallAttribution'
import type { SessionStatsWatcher } from './sessionStats'
import type { MaestroSession } from './maestroSession'
import type { CodexSession } from './codexSession'
import type { Hub, PaneIdentity } from './hub'
import type { McpServerHandle } from './mcpServer'
import type { PaneStartupMetrics } from './paneStartupMetrics'
import type { MaestroEvent } from './maestro'
import type { DevPaneSpec } from './paneLifecycle'

export interface MainContext {
  // ——— stores e serviços (referência estável — atribuídos 1×) ———
  readonly projects: ProjectStore
  readonly seats: SeatStore
  readonly missions: MissionStore
  /** Planos do universo (2.0, onda D — userData/plans.json). */
  readonly plans: PlanStore
  readonly integrationQueue: IntegrationQueueStore
  readonly backlog: BacklogStore
  readonly maestro: MaestroStore
  readonly settings: SettingsStore
  readonly ptys: PtyManager
  readonly synVoice: SynVoiceService
  readonly blackbox: Blackbox
  readonly mainStalls: StallAttribution
  readonly sessionStats: SessionStatsWatcher
  readonly maestroSessions: Map<string, MaestroSession | CodexSession>

  // ——— reatribuíveis em runtime (getters — sempre o valor ATUAL) ———
  /** Getter de propósito: quebra o ciclo Hub↔contexto (HubDeps captura
   *  projects/ptys/blackbox/uiSender antes de o hub existir). */
  readonly hub: Hub
  readonly uiSender: WebContents | null
  readonly mainWindow: BrowserWindow | null
  readonly mcpPort: number
  readonly mcpServerHandle: McpServerHandle | undefined
  readonly internalMcpState: 'starting' | 'ready' | 'unavailable'
  readonly paneStartupMetrics: PaneStartupMetrics | undefined

  // ——— estado vivo (Maps/Sets — a INSTÂNCIA é estável, o conteúdo muda) ———
  readonly paneTokens: Map<string, string>
  readonly paneMcpFiles: Map<string, string>
  readonly paneSessions: Map<string, string>
  readonly paneStatusNotes: Map<string, { text: string; at: string }>
  readonly voiceRequests: Map<string, { controller: AbortController; senderId: number }>
  readonly expiredSeats: Map<string, number>
  readonly integrationDrainTimers: Map<string, NodeJS.Timeout>
  readonly integrationDraining: Set<string>
  readonly surveyAborts: Map<string, () => void>
  readonly testServerPanes: Map<
    string,
    {
      projectId: string
      cwd: string
      /** Owner of a mission shell/test; required for solo teardown by identity. */
      missionId?: string
      /** ausente = terminal avulso da missão (2.0): não há script a digitar. */
      command?: string
      port?: number
      label?: string
      purpose?: 'test-server' | 'mission-shell'
    }
  >
  readonly livePaneSpecs: Map<
    string,
    { projectId: string; taskId: string; spec: DevPaneSpec }
  >
  readonly closingPaneIds: Set<string>
  readonly paneEverSpawned: Set<string>
  readonly pendingPtyPreparations: Map<string, symbol>
  readonly mcpCatalogServedByPane: Map<string, string>
  readonly mcpPaneFirstContact: Map<string, number>
  readonly seenMcpTokens: Set<string>

  // ——— funções do closure (delegação — imune à ordem de declaração) ———
  syncBoard(projectId: string): void
  emitLog(projectId: string, evt: MaestroEvent): void
  scheduleProgressSnapshot(): void
  ensureProjectRuntimeWritable(projectId: string): void
  maestroPaneId(projectId: string): string
  orchPaneId(projectId: string, missionId: string): string
  unregisterPane(paneId: string): PaneIdentity | undefined
  cleanPaneMcpFile(paneId: string): void
  abortVoiceRequests(): void

  /** Costura de push da Fase 3 (docs/FASE3_PLANO.md §3-D3): o destino deixa
   *  de ser "a janela" e passa a ser a VIEW. `pushBoard` = host (uiSender);
   *  `pushPanes` = WebContentsView do canvas (cai no host enquanto a view
   *  não existe — compat de 1 view); `pushAll` = broadcast para as duas.
   *  Todos encapsulam o padrão `sender && !sender.isDestroyed()` (CHECK 17).
   *  A classificação canal→destino vive na tabela do FASE3_PLANO §3 — um
   *  canal consumido pelos dois lados que for empurrado só para um deles
   *  meio-funciona em silêncio; na dúvida, pushAll. */
  pushBoard(channel: string, ...args: unknown[]): void
  pushPanes(channel: string, ...args: unknown[]): void
  pushAll(channel: string, ...args: unknown[]): void
}
