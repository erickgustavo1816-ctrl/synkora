import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { ProgressOverlaySnapshot } from '../main/progressSnapshot'
import type {
  GuiDelegationDefaults,
  GuiDelegationDefaultsPatch,
  GuiDelegationDefaultsResult,
  GuiExecutorPatch,
  GuiExecutorResult,
  GuiLivePayload as MainGuiLivePayload,
  GuiPaneSpawn,
  GuiPermBehavior,
  GuiPermissionMode,
  GuiQueuedDeliveryInput,
  GuiResult
} from '../main/guiSessions'
import type { SessionEvent } from '../main/maestroSession'
import type {
  GuiAttachPayload,
  GuiAttachResult,
  GuiAttachmentAction,
  GuiAttachmentActionResult,
  GuiAttachmentPreviewPurpose,
  GuiAttachmentPreviewResult,
  GuiAttachmentDescriptor
} from '../main/guiAttachments'
import type { GuiMissionRole } from '../main/guiMissionContracts'
import type { GuiAlertPayload } from '../main/guiNotices'
import type {
  GuiFileChoice,
  GuiFileOpenResult,
  GuiFilePreview
} from '../main/guiFileResolver'
import type {
  MissionCommitDiffResult,
  MissionCommitsResult,
  MissionGuiSpecResult,
  MissionShellSpecResult,
  MissionWorkspaceFilesResult
} from '../main/ipc/missions'
/** Abrir arquivo fora do app (rodada 7, C1) — contrato do MAIN importado direto:
 *  a resposta do canal tem uma fonte só, sem espelho para desencontrar. */
import type { FileExternalOpenMode, FileExternalOpenResult } from '../main/ipc/files'
/** O irmão do canal acima para o CHAT: mesmo menu, autoridade do PANE. */
import type { GuiFileExternalOpenMode, GuiFileExternalOpenResult } from '../main/ipc/gui'
import type {
  MissionCommit,
  MissionWorkspaceFile,
  MissionWorkspaceSummary
} from '../main/worktree'
import type { GuiWorkspaceFilesResult } from '../main/guiWorkspaceFiles'
import type { PlanningGuiSpecResult } from '../main/ipc/projects'
import type {
  FilePreviewKind,
  FilePreviewResult,
  FileTreeEntry,
  FileTreeResult,
  FileTreeRoot
} from '../main/filePreview'
import type {
  FileActionResult,
  FileActionScope,
  FileTreeEntry as FileActionTreeEntry,
  FileTreeSnapshot
} from '../main/fileActions'
import type {
  HistoryLoadResult,
  HistoryPageRequest,
  HistoryPaneLoadResult,
  HistorySearchInput,
  HistorySearchHit,
  HistorySearchResult,
  HistoryTranscriptMessage,
  PaletteNavigationTarget
} from '../shared/commandPalette'

/** Contrato do pane GUI (docs/GUI_PANE_CONTRACT.md) — fonte única dos tipos.
 * O canal vivo do main carrega a união real. O renderer ainda recebe
 * `unknown` e valida antes do redutor, mas o preload não apaga campos aditivos
 * como `parentToolUseId` ao tipar o callback. */
export type GuiLivePayload = Omit<MainGuiLivePayload, 'evt'> & { evt: SessionEvent }

export type {
  GuiDelegationDefaults,
  GuiDelegationDefaultsPatch,
  GuiDelegationDefaultsResult,
  GuiExecutorPatch,
  GuiExecutorResult,
  GuiPaneSpawn,
  GuiPermBehavior,
  GuiPermissionMode,
  GuiQueuedDeliveryInput,
  GuiResult
}
export type { GuiAlertPayload }
export type { GuiFileChoice, GuiFileOpenResult, GuiFilePreview }
/** Saída do arquivo CITADO NO FIO para fora do app (rodada 7, C1 — metade do
 *  chat): programa padrão do sistema ou pasta com ele selecionado. */
export type { GuiFileExternalOpenMode, GuiFileExternalOpenResult }

/** Anexos do composer: o renderer recebe somente capacidade opaca; caminho,
 * prévia e ações de disco permanecem no main. */
export type {
  GuiAttachPayload,
  GuiAttachResult,
  GuiAttachmentAction,
  GuiAttachmentActionResult,
  GuiAttachmentDescriptor,
  GuiAttachmentPreviewPurpose,
  GuiAttachmentPreviewResult
}

/** Papéis do chat de missão 2.0 e as respostas das specs que o 2.0 abriu:
 *  chat da missão, terminal avulso do worktree e sessão de planejamento. */
export type { GuiMissionRole, MissionGuiSpecResult, MissionShellSpecResult, PlanningGuiSpecResult }

/** Diff vivo do worktree da missão (2.0, onda D) — o cabeçalho do trilho. */
export type { MissionWorkspaceFile, MissionWorkspaceFilesResult, MissionWorkspaceSummary }

/** Commits da missão — a lista por trás do `ahead` que o trilho já mostra. */
export type { MissionCommit, MissionCommitDiffResult, MissionCommitsResult }
export type { GuiWorkspaceFilesResult }
/** Ações P26 usam a mesma raiz lógica do preview, mas conservam seu contrato
 * próprio para entradas bloqueadas e mutações auditadas. */
export type { FileActionResult, FileActionScope, FileActionTreeEntry, FileTreeSnapshot }
export type {
  HistoryLoadResult,
  HistoryPageRequest,
  HistoryPaneLoadResult,
  HistorySearchInput,
  HistorySearchHit,
  HistorySearchResult,
  HistoryTranscriptMessage,
  PaletteNavigationTarget
}

export type {
  MissionProgressState,
  ProgressCoordinatorActivityKind,
  ProgressCoordinatorActivityInput,
  ProgressCoordinatorRole,
  ProgressCoordinatorSnapshot,
  ProgressMissionSnapshot,
  ProgressOverlaySnapshot,
  ProgressProjectSnapshot,
  ProgressTone,
  ProjectProgressState
} from '../main/progressSnapshot'

// Caixa-preta do RENDERER (F5.7e): erro JS não tratado na janela não derruba
// o processo, mas quebra a UI em silêncio — reporta ao main, que grava em
// userData/synkora-crash.log. Registrado AQUI (preload roda antes do app
// React montar) para pegar até erro de boot do renderer.
window.addEventListener('error', (e) =>
  ipcRenderer.send(
    'crash:renderer',
    `${e.message} @ ${e.filename || '?'}:${e.lineno ?? 0}${e.error instanceof Error && e.error.stack ? `\n${e.error.stack}` : ''}`
  )
)
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { stack?: string } | undefined
  ipcRenderer.send('crash:renderer', `unhandledrejection: ${r?.stack ?? String(e.reason)}`)
})

export interface Project {
  id: string
  name: string
  path: string
  createdAt: string
  mode?: 'greenfield' | 'existing'
  planStatus?: 'draft' | 'approved' | 'in_progress' | 'revision_pending' | 'awaiting_release' | 'done'
  /** avatar do projeto (data URL) — rail estilo Discord */
  photo?: string
  /** COMPUTADO na listagem: a pasta não existe mais (renomeada/movida fora
   *  do app) — a Home oferece "alterar pasta" */
  missing?: boolean
}

/**
 * Resultado de projects:create. É o Project de sempre; `gitWarning` só aparece
 * quando o link do GitHub ficou pela metade (push recusado por autenticação,
 * remoto não prendido) — o universo NASCE assim mesmo, e o aviso é para a UI
 * contar a verdade em vez de fingir que subiu.
 */
export type ProjectCreateResult = Project & { gitWarning?: string }

/** Resultado de projects:relocate (troca de pasta do projeto). */
export interface RelocateResult {
  ok: boolean
  project?: Project
  error?: string
}

export type SeatCli = 'claude' | 'codex'
export type SeatStatus = 'logado' | 'pendente' | 'expirado'

export interface Seat {
  id: string
  name: string
  cli: SeatCli
  createdAt: string
  status: SeatStatus
  configDir: string
}

export type PaneKind = 'shell' | 'claude' | 'codex'

export type Department =
  | 'front'
  | 'back'
  | 'qa'
  | 'design'
  | 'research'
  | 'copy'
  | 'cyber'
  | 'data'
export type MissionExecutionMode = 'fast' | 'standard' | 'deep'
export type MissionRiskLevel = 'low' | 'medium' | 'high'

// Biblioteca de skills (F4): catálogo curado, instalado da fonte (GitHub) e
// Missões (F3.8): fluxo de trabalho com orquestrador, tarefas e branch próprios.
export type MissionStatus = 'ativa' | 'integrando' | 'concluida' | 'arquivada'

/** NATUREZA da missão (2.0): 'planejamento' = UMA conversa na raiz do projeto
 *  que escreve plano/ (sem worktree, fora da fila de integração); ausente ou
 *  'dev' = missão de desenvolvimento. Espelho de src/main/guiMissionContracts. */
export type MissionType = 'dev' | 'planejamento'

export interface MissionIntegrationQueueView {
  state: 'queued' | 'sync_required' | 'blocked' | 'merging'
  position: number
  total: number
  lastError?: string
  owner?: 'maestro' | 'orchestrator'
}

export interface Mission {
  id: string
  projectId: string
  title: string
  goal?: string
  scope?: string
  status: MissionStatus
  branch?: string
  worktree?: string
  baseBranch?: string
  seatId?: string
  model?: string
  effort?: string
  /** 'direta' = registro de trabalho de agente livre (sem cards/orquestrador) */
  kind?: 'direta'
  /** SYNKORA 2.0: missão sem orquestrador e sem plano — o dono fala com o dev
   *  no chat e o ⇪ integra direto. Carimbado no nascimento e imutável. */
  direct?: true
  /** 2.0: 'planejamento' abre a conversa que escreve plano/ na raiz do projeto
   *  (sem worktree, sem ⇪); ausente = 'dev'. Carimbado no nascimento. */
  missionType?: MissionType
  /** criada pelo PM: aguarda a escolha de conta/modelo/effort do orquestrador */
  pendingOrchestrator?: boolean
  /** agente pediu integrar via MCP: merge aguarda o AVAL do dono no botão ⇪ */
  pendingIntegrationApproval?: boolean
  versionId?: string
  completedAt?: string
  /** Lugar desta missão na fila serial de integração do projeto. */
  integration?: MissionIntegrationQueueView
  createdAt: string
  updatedAt: string
}

export interface NewMission {
  title: string
  goal?: string
  scope?: string
  seatId?: string
  model?: string
  effort?: string
  versionId?: string
  /** 2.0: omitido pelo renderer = DIRETA (o main carimba). Só o nascimento
   *  decide; missão nenhuma muda de natureza depois. */
  direct?: boolean
  /** 2.0: 'planejamento' cria a missão que escreve plano/ em vez de código;
   *  omitido = 'dev'. Também só o nascimento decide. */
  missionType?: MissionType
}

// Backlog de produto: versões como escopo de planejamento + itens desejados.
export type VersionStatus = 'aberta' | 'lancada'
export type BacklogItemType = 'feature' | 'bug' | 'melhoria'
export type BacklogItemStatus = 'pendente' | 'em-missao' | 'feito'

/** Entrega automática: missão da versão integrou na branch da versão. */
export interface VersionDelivery {
  id: string
  missionId: string
  title: string
  at: string
}

export interface Version {
  id: string
  projectId: string
  name: string
  theme?: string
  goal?: string
  status: VersionStatus
  /** quando foi lançada (a mais recente = versão ATUAL na main) */
  releasedAt?: string
  /** o que já subiu nesta versão (automático, na integração da missão) */
  deliveries: VersionDelivery[]
  /** branch version/<nome> que acumula as missões até o release */
  branch?: string
  worktree?: string
  createdAt: string
  updatedAt: string
}

/** Espelho de `ReleaseRecord` (main/releasesStore — o par declarado): o
 *  RETRATO de uma subida que a aba Versões lê (R27F2). Nasce no sucesso do
 *  release; a aba só consome. */
export interface VersionReleaseRecord {
  id: string
  projectId: string
  versionId: string
  versionName: string
  missionId?: string
  at: string
  actor: string
  mergeDetail: string
  push: { attempted: boolean; ok?: boolean; error?: string }
  bump?: { version: string; committed: boolean }
  publishRequired: boolean
  outcome: string
}

/** Espelho de `CreateVersionResult` (main/ipc/backlog): criar versão devolve a
 *  versão OU o motivo da recusa — a lateral aceita um número digitado pelo
 *  dono, e recusa muda ali é um clique que não produz nada e não se explica. */
export type CreateVersionResult =
  | { ok: true; version: Version }
  | { ok: false; error: string }

/** Versoes abertas que uma nova missao pode escolher, mais o destino padrao. */
export interface MissionVersionChoices {
  versions: Version[]
  defaultVersionId?: string
}

export interface BacklogItem {
  id: string
  projectId: string
  versionId?: string
  type: BacklogItemType
  title: string
  notes?: string
  status: BacklogItemStatus
  missionId?: string
  createdAt: string
  updatedAt: string
}

/** Arquivo .md do projeto (aba Arquivos). */
export interface DocFile {
  path: string
  name: string
  group: 'projeto' | 'docs' | 'synkora' | 'transcripts'
  mtime: number
  size: number
}

/** Raiz autorizada pela main para a árvore/preview somente leitura. */
export type { FilePreviewKind, FilePreviewResult, FileTreeEntry, FileTreeResult, FileTreeRoot }

/** Abrir o arquivo FORA do app: programa padrão do sistema ou mostrar na pasta.
 *  O renderer manda raiz por ID + caminho relativo; quem tem caminho físico é o
 *  main, que resolve pelo mesmo resolver do preview antes de tocar no `shell`. */
export type { FileExternalOpenMode, FileExternalOpenResult }

export interface TerminalFileLink {
  start: number
  length: number
  text: string
}

export interface TerminalMarkdownTarget {
  ok: true
  action: 'markdown'
  paneId: string
  root: 'project' | 'pane'
  path: string
  name: string
  displayPath: string
}

export type TerminalFileOpenResult =
  | TerminalMarkdownTarget
  | { ok: true; action: 'external' }
  | { ok: true; action: 'reveal' }
  | { ok: false; error: string }

// ————— PLANOS DO UNIVERSO (2.0, onda D) — BLOCO NOVO, contrato do MAPA —————
//
// Espelho ESTRUTURAL de src/main/plans.ts (o renderer nunca importa main). Os
// campos derivados — `status` efetivo, `authoredStatus`, `mission` e
// `progress` — já chegam calculados: o mapa não recalcula progresso, ele
// desenha o que o main provou.

export type PlanKindView = 'mestre' | 'livre'
export type PlanStatusView = 'ativo' | 'concluido' | 'arquivado'
export type PlanItemStatusView = 'planejada' | 'em_andamento' | 'concluida' | 'descartada'
export type PlanItemTierView = 'pequeno' | 'medio' | 'grande'

export interface PlanItemMissionView {
  id: string
  title: string
  status: 'ativa' | 'integrando' | 'concluida' | 'arquivada'
}

export interface PlanItemView {
  id: string
  title: string
  objective: string
  outOfScope?: string
  doneCriteria: string[]
  tier?: PlanItemTierView
  context?: string
  /** ids de outros itens DESTE plano */
  dependsOn: string[]
  order: number
  /** estado EFETIVO: com missão viva, quem manda é a missão */
  status: PlanItemStatusView
  /** o que está gravado (a intenção) — a edição manual futura usa este */
  authoredStatus: PlanItemStatusView
  missionId?: string
  /** ausente = sem missão ou missão que sumiu (já reconciliado no main) */
  mission?: PlanItemMissionView
  docPath?: string
  /** anotação da autocura (ex.: a missão vinculada não existe mais) */
  note?: string
  createdAt: string
  updatedAt: string
}

export interface PlanView {
  id: string
  projectId: string
  title: string
  description?: string
  kind: PlanKindView
  status: PlanStatusView
  origin: { paneId: string; missionId?: string; proposedAt: string } | { manual: true }
  items: PlanItemView[]
  order: number
  progress: { done: number; total: number }
  createdAt: string
  /** mande de volta em expectedUpdatedAt: é o CAS de todo mutador */
  updatedAt: string
  approvedAt?: string
  archivedAt?: string
}

/** Rascunho aceito pelo `plans.create` manual (mesma forma da proposta). */
export interface PlanDraftItemInput {
  key?: string
  title: string
  objective: string
  outOfScope?: string
  doneCriteria?: string[]
  tier?: PlanItemTierView
  context?: string
  /** `key`s de itens ANTERIORES da mesma lista */
  dependsOn?: string[]
  docPath?: string
}

export interface PlanDraftInput {
  title: string
  description?: string
  kind?: PlanKindView
  items: PlanDraftItemInput[]
}

export interface PlanItemPatchInput {
  id: string
  title?: string
  objective?: string
  outOfScope?: string | null
  doneCriteria?: string[]
  tier?: PlanItemTierView | null
  context?: string | null
  dependsOn?: string[]
  docPath?: string | null
  /** 'concluida' não entra: é derivada da missão vinculada */
  status?: 'planejada' | 'em_andamento' | 'descartada'
}

export interface PlanPatchInput {
  title?: string
  description?: string | null
  status?: PlanStatusView
  order?: number
  items?: PlanItemPatchInput[]
  addItems?: (PlanDraftItemInput & { key: string; doneCriteria: string[]; dependsOn: string[] })[]
  removeItemIds?: string[]
}

export type PlanMutationResult = { ok: true; plan: PlanView } | { ok: false; error: string }
export type PlanRemovalResult = { ok: true } | { ok: false; error: string }

// ————— fim do BLOCO NOVO de planos —————

export interface CatalogModel {
  id: string
  label: string
  efforts?: string[]
  defaultEffort?: string
  /** R13 — espelho de `src/main/catalog.ts`: catálogo real responde true/false;
   *  fallback omite (silêncio nunca liga modo caro). */
  supportsFastMode?: boolean
}

export interface Catalog {
  models: CatalogModel[]
  efforts: string[]
}

/** Versão do CLI que os panes executam (espelha `main/cliUpdate.ts`). */
export interface CliStatus {
  cli: SeatCli
  version: string | null
  from?: string
  state: 'unknown' | 'updating' | 'current' | 'updated' | 'missing' | 'failed'
  detail?: string
  checkedAt: number
}

/** Telemetria viva de um pane, lida dos JSONL de sessão do próprio CLI. */
export interface PaneStats {
  model?: string
  inputTokens: number
  outputTokens: number
  freshInputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  contextTokens: number | null
  contextWindow: number | null
  costUsd?: number
}

/** Preferências globais editáveis; não inclui credenciais. */
export interface SynkoraPreferences {
  externalServicePreparation: 'automatic' | 'on-demand'
  /** ESCAPE HATCH do conpty.dll empacotado (Windows). Ausente/true = ligado.
   *  O campo existe em main/settings.ts desde a F5.1 e o main já o aplica em
   *  `ptys.setConptyDll`; faltava só no espelho de tipo daqui. */
  conptyDll?: boolean
  /** Métricas fixas de todos os terminais do Synkora. */
  terminalFontSize: number
  terminalLineHeight: number
  terminalFontFamily: string
  /** vazio/ausente usa o microfone padrão do sistema */
  synVoiceInputDeviceId?: string
  /** Avisos do chat e seu vocabulário sonoro (globais à máquina). */
  chatNotifyNeedsYou: boolean
  chatNotifyFinished: boolean
  chatNotifyFailed: boolean
  chatSoundsEnabled: boolean
}

/** Snapshot seguro do main. Nenhum segredo bruto cruza esta fronteira. */
export interface SynkoraSettings extends SynkoraPreferences {
}

export type SynkoraSettingsPatch = Partial<SynkoraPreferences>
export type SynVoiceProvider = 'openai' | 'openrouter'

export interface SynVoiceProviderConfig {
  configured: boolean
  source: 'secure-storage' | 'none'
  model: string
  selectedModel: string | null
}

export interface SynVoiceConfig {
  provider: SynVoiceProvider
  configured: boolean
  source: 'secure-storage' | 'none'
  model: string
  customVocabulary: string[]
  secureStorageAvailable: boolean
  providers: Record<SynVoiceProvider, SynVoiceProviderConfig>
}

export interface SynVoiceModel {
  id: string
  name: string
  description: string
  recommended?: boolean
}

export interface SynVoiceTranscript {
  text: string
  languages: string[]
  model: string
  delivery?: 'inserted' | 'clipboard' | 'none' | 'uncertain'
}

export type SynVoiceOverlayStage =
  | 'loading'
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'processing'
  | 'inserted'

export type SynVoiceOverlayCommand = 'toggle' | 'attach' | 'open-settings'

export type SynVoiceActivationMode = 'click' | 'toggle' | 'hold'

export type SynVoiceGlobalActivationBinding =
  | {
      mode: 'toggle'
      kind: 'keyboard'
      code: string
      ctrlKey: boolean
      altKey: boolean
      shiftKey: boolean
      metaKey: boolean
    }
  | { mode: 'toggle'; kind: 'mouse'; button: number }
  | {
      mode: 'hold'
      kind: 'keyboard'
      code: string
      ctrlKey: boolean
      altKey: boolean
      shiftKey: boolean
      metaKey: boolean
    }

export type SynVoiceGlobalActivationEvent = 'toggle' | 'hold-start' | 'hold-stop'

export interface SynVoiceOverlayState {
  stage: SynVoiceOverlayStage
  elapsed: number
  level: number
  bands: number[]
  configured: boolean
  status: string
  activationMode: SynVoiceActivationMode
  activationLabel: string
}

export interface SynVoiceOverlayTooltipRequest {
  text: string
  anchor: {
    left: number
    top: number
    width: number
    height: number
  }
}

export type SynVoiceNoticeTone = 'error' | 'warning' | 'info'

export type ProgressOverlayCommand =
  | 'close'
  | 'compact'
  | 'expand'
  | 'clear-history'
  | 'open-main'
  | 'open-target'

export interface ProgressOverlayState {
  snapshot: ProgressOverlaySnapshot
  compact: boolean
  historyClearedAt: string | null
}

export interface ProgressOpenTarget {
  projectId: string
  missionId?: string
}

// `MaestroPaneSpec` descrevia o pane TUI do PM/orquestrador. Morreu na purga
// F6 (2026-08-17) com o palco legado.


/** Um limite de uso da conta, já normalizado pelo main (ver seatUsage.ts). */
export interface UsageMeter {
  label: string
  pct: number
  /** `used` = barra enchendo (claude); `left` = barra esvaziando (TUI do codex) */
  mode: 'used' | 'left'
  /** 0..1 — quanto do limite já foi consumido, independente do modo */
  severity: number
  reset?: string
  window?: string
}

export interface SeatUsage {
  at: number
  account?: string
  plan?: string
  meters: UsageMeter[]
  /** texto cru; só vem preenchido quando nenhum medidor foi reconhecido */
  lines: string[]
}

/** Evento do hub (barramento central da orquestração). */
export interface HubEvent {
  ts: string
  projectId: string
  kind:
    | 'pane-open'
    | 'pane-close'
    | 'task-created'
    | 'task-updated'
    | 'report'
    | 'delegate'
    | 'merge'
    | 'image'
    | 'error'
    | 'info'
  text: string
  actor?: string
  /** missão de origem — o roteamento do hub usa para escolher o orquestrador */
  missionId?: string
  /** rotina: vai para EVENTS.md e para a UI, mas não é injetado no pane do PM */
  quiet?: boolean
}

/** Comunicação realmente entregue entre dois panes. O renderer usa os IDs
 *  estruturados para animar origem → destino sem deduzir direção por texto. */
export interface HubCommunicationEvent {
  id: string
  ts: string
  projectId: string
  missionId?: string
  taskId?: string
  sourcePaneId: string
  targetPaneId: string
  kind: 'message' | 'delegate' | 'report' | 'feedback' | 'handoff'
}

const api = {
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    /** `gitUrl` (2.0, onda D): pasta vazia CLONA o repositório; pasta com
     *  conteúdo ganha `origin` + push best-effort. Push recusado NÃO impede a
     *  criação — o aviso PT-BR volta em `gitWarning` para a UI mostrar. */
    create: (name: string, path: string, gitUrl?: string): Promise<ProjectCreateResult> =>
      ipcRenderer.invoke('projects:create', name, path, gitUrl),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('projects:remove', id),
    rename: (id: string, name: string): Promise<Project | null> =>
      ipcRenderer.invoke('projects:rename', id, name),
    setPhoto: (id: string): Promise<Project | null> =>
      ipcRenderer.invoke('projects:setPhoto', id),
    removePhoto: (id: string): Promise<Project | null> =>
      ipcRenderer.invoke('projects:removePhoto', id),
    relocate: (id: string): Promise<RelocateResult> =>
      ipcRenderer.invoke('projects:relocate', id),
    /** SYNKORA 2.0: spec do CHAT de PLANEJAMENTO do universo (a casa da coluna
     *  "✦ geral" quando não há missão legada viva). paneId determinístico —
     *  reabrir o universo cai na mesma conversa. */
    planningGuiSpec: (
      projectId: string,
      permissionMode?: GuiPermissionMode
    ): Promise<PlanningGuiSpecResult> =>
      ipcRenderer.invoke('projects:planningGuiSpec', projectId, permissionMode),
    onFlowChanged: (cb: (projectId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string): void => cb(projectId)
      ipcRenderer.on('projects:flowChanged', listener)
      return () => ipcRenderer.removeListener('projects:flowChanged', listener)
    }
  },
  seats: {
    list: (): Promise<Seat[]> => ipcRenderer.invoke('seats:list'),
    create: (name: string, cli: SeatCli): Promise<Seat> =>
      ipcRenderer.invoke('seats:create', name, cli),
    rename: (id: string, name: string): Promise<void> =>
      ipcRenderer.invoke('seats:rename', id, name),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('seats:remove', id),
    usage: (id: string): Promise<SeatUsage | null> =>
      ipcRenderer.invoke('seats:usage', id),
    /** R25.2 — SÓ o que o cache do main já tem, NUNCA uma coleta: é assim que o
     *  chat mostra a cota do seat dele sem abrir um processo de CLI por pane.
     *  `null` = ninguém colheu ainda, e a UI simplesmente não mostra a linha. */
    usagePeek: (id: string): Promise<SeatUsage | null> =>
      ipcRenderer.invoke('seats:usagePeek', id),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('seats:changed', listener)
      return () => ipcRenderer.removeListener('seats:changed', listener)
    }
  },
  // O NAMESPACE `tasks` (list/create/update/remove/run, aprovação e pausa de
  // plano, e os eventos de pane de fase) morreu na purga F6 (2026-08-17) com o
  // pipeline de cards que ele comandava.
  panes: {
    /** Snapshot dos panes gerenciados ainda vivos no processo principal.
     *  Usado para reidratar a UI depois de um reload do renderer. */
    /** F3-c3: nascimento de pane sem fase (test server) chega por
     *  evento do main às DUAS views — quem monta é a view de panes; o host
     *  espelha a lista. */
    onOpenFree: (
      cb: (projectId: string, kind: string, opts: Record<string, unknown>) => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        projectId: string,
        kind: string,
        opts: Record<string, unknown>
      ): void => cb(projectId, kind, opts)
      ipcRenderer.on('panes:open-free', listener)
      return () => ipcRenderer.removeListener('panes:open-free', listener)
    },
    /** F3-c3: fechar pane a partir do host (■ derrubar) — o main mata o PTY e
     *  ecoa panes:closeById para as duas views. */
    requestClose: (projectId: string, paneId: string): void =>
      ipcRenderer.send('panes:requestClose', projectId, paneId),
    /**
     * O OUVINTE do eco acima (R11, 19/08 — o bug da ABA ETERNA): o main sempre
     * ecoou `panes:closeById` ao matar um pane (derrubar teste, integração
     * fechando o worktree, missão arquivada), mas o listener do renderer
     * morreu junto com a aba PANES da onda D — a aba do terminal ficava na
     * tela para sempre, com o processo já morto. Quem ouve é o App, que
     * despacha ao `closePane` do store.
     */
    onCloseById: (cb: (projectId: string, paneId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string, paneId: string): void =>
        cb(projectId, paneId)
      ipcRenderer.on('panes:closeById', listener)
      return () => ipcRenderer.removeListener('panes:closeById', listener)
    },
    /** Servidor de teste do dono: pane shell no worktree da missão/versão com
     *  o script de runtime já digitado (o usuário escolhe a porta). */
    testServerSpec: (
      projectId: string,
      target: { missionId?: string; versionId?: string },
      port?: number
    ): Promise<{
      ok: boolean
      msg?: string
      paneId?: string
      cwd?: string
      command?: string
      title?: string
      missionId?: string
      versionId?: string
    }> => ipcRenderer.invoke('panes:testServerSpec', projectId, target, port),
    /** Portas em uso pelo harness (runtimes de QA + servidores de teste) —
     *  linha humana para o modal do ▶ testar (decisão do dono, 2026-08-07). */
    portsInUse: (projectId: string): Promise<string> =>
      ipcRenderer.invoke('panes:portsInUse', projectId)
  },
  /** Busca local da paleta. O main só devolve falas user/assistant já
   *  redigidas; selectionId é opaco e expira. */
  history: {
    search: (input: HistorySearchInput): Promise<HistorySearchResult> =>
      ipcRenderer.invoke('history:search', input),
    cancel: (requestId: string): void => ipcRenderer.send('history:cancel', requestId),
    load: (selectionId: string): Promise<HistoryLoadResult> =>
      ipcRenderer.invoke('history:load', selectionId),
    /** A CONVERSA COMPLETA DESTE PANE (R24.2): sem busca e sem seleção opaca —
     *  o main resolve o arquivo pelo registro do pane. `page` ausente = a
     *  página do COMEÇO, que é o pedaço que o anel perdeu. */
    loadForPane: (paneId: string, page?: HistoryPageRequest): Promise<HistoryPaneLoadResult> =>
      ipcRenderer.invoke('history:loadForPane', paneId, page)
  },
  /** PANE GUI (Synkora 2.0, onda A — docs/GUI_PANE_CONTRACT.md): o chat que
   *  substitui o xterm. O motor é MaestroSession/CodexSession por pane, no
   *  main; aqui só passa a costura. */
  gui: {
    /** Instancia a sessão do pane; os eventos começam a chegar em onLive. */
    create: (spawn: GuiPaneSpawn): Promise<GuiResult> => ipcRenderer.invoke('gui:create', spawn),
    /** Troca modelo/effort na sessão viva; sucesso não gera evento visual. */
    configureExecutor: (
      paneId: string,
      patch: GuiExecutorPatch
    ): Promise<GuiExecutorResult> =>
      ipcRenderer.invoke('gui:configureExecutor', paneId, patch),
    /** PADRÃO DOS AJUDANTES deste chat (D8): o modelo/effort que o dono carimba
     *  na abinha e que toda delegação sem pedido explícito passa a usar.
     *  Vazio = herdar da conversa. */
    delegationDefaults: (paneId: string): Promise<GuiDelegationDefaults> =>
      ipcRenderer.invoke('gui:delegationDefaults', paneId),
    /** `null` limpa o campo; ausente conserva. Devolve a fotografia canônica. */
    setDelegationDefaults: (
      paneId: string,
      patch: GuiDelegationDefaultsPatch
    ): Promise<GuiDelegationDefaultsResult> =>
      ipcRenderer.invoke('gui:setDelegationDefaults', paneId, patch),
    /** Turno novo com descritores revalidados pelo main antes de chegar ao CLI. */
    send: (
      paneId: string,
      text: string,
      messageId: string,
      attachments?: GuiAttachmentDescriptor[]
    ): Promise<GuiResult> => ipcRenderer.invoke('gui:send', paneId, text, messageId, attachments),
    /** A fila viaja com texto, anexos e opcoes numa unica operacao do main. */
    deliverQueued: (
      paneId: string,
      input: GuiQueuedDeliveryInput
    ): Promise<GuiResult> => ipcRenderer.invoke('gui:deliverQueued', paneId, input),
    /** Responde o card de permissão. */
    permission: (
      paneId: string,
      requestId: string,
      behavior: GuiPermBehavior
    ): Promise<GuiResult> =>
      ipcRenderer.invoke('gui:permission', paneId, requestId, behavior),
    /** Responde o card de PERGUNTA (AskUserQuestion): mapa
     *  { texto da pergunta → labels escolhidos unidos por ', ' }; mapa vazio
     *  = "pular" (o agente segue sem a escolha). */
    answerQuestion: (
      paneId: string,
      requestId: string,
      answers: Record<string, string>
    ): Promise<GuiResult> =>
      ipcRenderer.invoke('gui:answerQuestion', paneId, requestId, answers),
    /** Veredito do card de PLANO (ExitPlanMode): true = construir, false =
     *  devolver para revisão. */
    answerPlan: (paneId: string, requestId: string, approve: boolean): Promise<GuiResult> =>
      ipcRenderer.invoke('gui:answerPlan', paneId, requestId, approve),
    // ————— BLOCO NOVO (2.0, onda D): proposta de plano —————
    /** Card de PROPOSTA DE PLANO: `true` cria o plano a partir do rascunho que
     *  o main guardou (o renderer nunca devolve o conteúdo); `false` + texto
     *  manda o ajuste do dono de volta ao agente como mensagem. */
    answerPlanProposal: (
      paneId: string,
      requestId: string,
      approve: boolean,
      text?: string
    ): Promise<GuiResult> =>
      ipcRenderer.invoke('gui:answerPlanProposal', paneId, requestId, approve, text),
    // ————— fim do BLOCO NOVO —————
    interrupt: (paneId: string): Promise<GuiResult> =>
      ipcRenderer.invoke('gui:interrupt', paneId),
    kill: (paneId: string): Promise<GuiResult> => ipcRenderer.invoke('gui:kill', paneId),
    /** Replay para a remontagem (o main guarda ~500 eventos por pane). */
    state: (paneId: string): Promise<{
      events: unknown[]
      cursor: number
      exists: boolean
      alive: boolean
    }> =>
      ipcRenderer.invoke('gui:state', paneId),
    /** Lista read-only de caminhos relativos para o autocomplete @arquivo.
     *  O main resolve o worktree a partir do paneId e mantém cache por raiz. */
    workspaceFiles: (paneId: string): Promise<GuiWorkspaceFilesResult> =>
      ipcRenderer.invoke('gui:workspaceFiles', paneId),
    /** Abre uma citação de arquivo usando somente o cwd autoritativo do pane.
     *  `selectedPath` só existe após o main devolver uma lista ambígua e é
     *  revalidado na segunda chamada. Nunca há ação de executar arquivo. */
    fileOpen: (
      paneId: string,
      reference: string,
      selectedPath?: string
    ): Promise<GuiFileOpenResult> =>
      ipcRenderer.invoke('gui:fileOpen', paneId, reference, selectedPath),
    /** Rodada 7 (C1, metade do CHAT): manda o arquivo citado no fio para FORA do
     *  app — programa padrão do sistema (`default`) ou pasta com ele selecionado
     *  (`reveal`). MESMA cerca do `fileOpen`: a raiz é o `cwd` do pane e o
     *  caminho absoluto nasce e morre no main. Nome ambíguo é RECUSADO até o
     *  painel escolher (a escolha volta em `selectedPath`). */
    fileOpenExternal: (
      paneId: string,
      reference: string,
      selectedPath: string | undefined,
      mode: GuiFileExternalOpenMode
    ): Promise<GuiFileExternalOpenResult> =>
      ipcRenderer.invoke('gui:fileOpenExternal', paneId, reference, selectedPath, mode),
    /** Anexa print da área de transferência ou arquivo ao chat: o main grava
     *  em `<cwd do pane>/.synkora/attachments` e devolve capacidade opaca. */
    attach: (paneId: string, payload: GuiAttachPayload): Promise<GuiAttachResult> =>
      ipcRenderer.invoke('gui:attach', paneId, payload),
    /** Abre o seletor nativo do sistema e anexa uma referência a qualquer
     *  pasta local escolhida. O renderer nunca envia o caminho como autoridade.
     */
    attachFolder: (paneId: string): Promise<GuiAttachResult> =>
      ipcRenderer.invoke('gui:attachFolder', paneId),
    /** A prévia é PNG limitado produzido pelo main; nunca uma URL de arquivo. */
    attachmentPreview: (
      paneId: string,
      attachment: GuiAttachmentDescriptor,
      purpose: GuiAttachmentPreviewPurpose
    ): Promise<GuiAttachmentPreviewResult> =>
      ipcRenderer.invoke('gui:attachmentPreview', paneId, attachment, purpose),
    /** Abrir/baixar sempre volta ao main para revalidar a capacidade física. */
    attachmentAction: (
      paneId: string,
      action: GuiAttachmentAction,
      attachment: GuiAttachmentDescriptor
    ): Promise<GuiAttachmentActionResult> =>
      ipcRenderer.invoke('gui:attachmentAction', paneId, action, attachment),
    /** Pane realmente visível; alimenta o título [pronto] da janela. */
    visibility: (paneId: string, active: boolean): void =>
      ipcRenderer.send('gui:visibility', paneId, active),
    /** Confirma que o evento terminal terminou de aparecer na conversa. */
    presented: (paneId: string, terminalSeq: number): void =>
      ipcRenderer.send('gui:presented', paneId, terminalSeq),
    /** Evento vivo; devolve a função de cancelar a assinatura. */
    onLive: (cb: (payload: GuiLivePayload) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: GuiLivePayload): void => cb(payload)
      ipcRenderer.on('gui:live', listener)
      return () => ipcRenderer.removeListener('gui:live', listener)
    },
    /** Alerta canônico e não-replayável; somente o host toca áudio. */
    onAlert: (cb: (payload: GuiAlertPayload) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: GuiAlertPayload): void => cb(payload)
      ipcRenderer.on('gui:alert', listener)
      return () => ipcRenderer.removeListener('gui:alert', listener)
    }
  },
  // O NAMESPACE `maestro` (estado do chat do PM, spec do pane TUI e o par de
  // perguntas do ask_user) morreu na purga F6 (2026-08-17) com o papel.
  missions: {
    list: (projectId: string): Promise<Mission[]> =>
      ipcRenderer.invoke('missions:list', projectId),
    /** Fonte canonica de destinos elegiveis para uma nova missao. */
    versionChoices: (projectId: string): Promise<MissionVersionChoices> =>
      ipcRenderer.invoke('missions:versionChoices', projectId),
    create: (projectId: string, input: NewMission): Promise<Mission | null> =>
      ipcRenderer.invoke('missions:create', projectId, input),
    update: (
      id: string,
      patch: { title?: string; goal?: string; scope?: string; status?: 'ativa' | 'arquivada' | 'concluida' }
    ): Promise<Mission | null> => ipcRenderer.invoke('missions:update', id, patch),
    integrate: (missionId: string): Promise<string> =>
      ipcRenderer.invoke('missions:integrate', missionId),
    remove: (missionId: string): Promise<boolean> =>
      ipcRenderer.invoke('missions:remove', missionId),
    // missão criada pelo PM: grava conta/modelo/effort do orquestrador
    // escolhidos no modal e libera o pane nascer
    // `confirmOrchestrator` e `setOrchestratorSeat` (escolha e troca de conta
    // do ORQUESTRADOR de missão legada) morreram na purga F6 (2026-08-17).
    /** SYNKORA 2.0: a CONTA da conversa da missão direta — escolhida no card
     *  do chat vazio ou trocada pelo cabeçalho. Mesmo CLI = a conversa é
     *  transplantada; as sessões vivas morrem e o chat reabre no seat novo. */
    setChatSeat: (
      projectId: string,
      missionId: string,
      seatId: string
    ): Promise<{ ok: boolean; msg?: string }> =>
      ipcRenderer.invoke('missions:setChatSeat', projectId, missionId, seatId),
    /** SYNKORA 2.0: spec do CHAT da missão por papel (dev/reviewer/ajudante).
     *  O paneId é determinístico — reabrir cai na mesma conversa. Missão
     *  legada (com orquestrador) segue usando o paneSpec acima.
     *  `permissionMode` (onda D) omitido = a última escolha gravada do dono
     *  para aquele pane; trocar o modo respawna a sessão COM o resume. */
    guiSpec: (
      missionId: string,
      role: GuiMissionRole,
      permissionMode?: GuiPermissionMode
    ): Promise<MissionGuiSpecResult> =>
      ipcRenderer.invoke('missions:guiSpec', missionId, role, permissionMode),
    /** SYNKORA 2.0: TERMINAL avulso no worktree da missão (botão do trilho de
     *  entrega). Pane shell cru — sem CLI, sem persona, sem MCP. O main já
     *  emitiu `panes:open-free`, então a view MONTA o pane sozinha: o chamador
     *  só navega para a aba Panes (mesmo padrão do ▶ testar). */
    shellSpec: (missionId: string): Promise<MissionShellSpecResult> =>
      ipcRenderer.invoke('missions:shellSpec', missionId),
    /** SYNKORA 2.0 (onda D): diff VIVO do worktree — commits à frente da base,
     *  +N/−M e a lista de arquivos por status. Leitura pura: nunca cria nem
     *  repara worktree, então pode ser chamada com frequência pelo trilho. */
    workspaceFiles: (missionId: string): Promise<MissionWorkspaceFilesResult> =>
      ipcRenderer.invoke('missions:workspaceFiles', missionId),
    /** RIGHTDOCK: o diff de UM arquivo do trabalho da missão, recortado no
     *  teto do motor — o clique na linha abre isto inline. */
    workspaceFileDiff: (
      missionId: string,
      filePath: string
    ): Promise<{ ok: boolean; diff?: string; truncated?: boolean; error?: string }> =>
      ipcRenderer.invoke('missions:workspaceFileDiff', missionId, filePath),
    /** SYNKORA 2.0: os COMMITS que esta missão adicionou sobre a base, mais
     *  novos primeiro (teto 50). Mesma leitura pura do workspaceFiles — é a
     *  lista por trás do "N commits à frente" que o trilho já mostra. */
    commits: (missionId: string): Promise<MissionCommitsResult> =>
      ipcRenderer.invoke('missions:commits', missionId),
    /** SYNKORA 2.0/P24: patch read-only de um commit da lista. O main exige
     * SHA completo e recusa qualquer commit fora do histórico da missão. */
    commitDiff: (missionId: string, commitSha: string): Promise<MissionCommitDiffResult> =>
      ipcRenderer.invoke('missions:commitDiff', missionId, commitSha),
    onChanged: (cb: (projectId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string): void => cb(projectId)
      ipcRenderer.on('missions:changed', listener)
      return () => ipcRenderer.removeListener('missions:changed', listener)
    }
  },
  backlog: {
    listVersions: (projectId: string): Promise<Version[]> =>
      ipcRenderer.invoke('backlog:listVersions', projectId),
    /** Devolve a VERSÃO criada ou o MOTIVO da recusa (nome vazio, duplicado,
     *  abaixo/igual à lançada): o número passou a ser digitável na lateral de
     *  Versões, e um clique que não cria nada precisa dizer por quê. */
    createVersion: (
      projectId: string,
      input: { name: string; theme?: string; goal?: string }
    ): Promise<CreateVersionResult> =>
      ipcRenderer.invoke('backlog:createVersion', projectId, input),
    removeVersion: (projectId: string, id: string): Promise<string> =>
      ipcRenderer.invoke('backlog:removeVersion', projectId, id),
    releaseVersion: (id: string): Promise<string> =>
      ipcRenderer.invoke('backlog:releaseVersion', id),
    /** R10: o botão "subir pra main" abre (ou reencontra) a MISSÃO DE RELEASE
     *  da versão — quem sobe é o agente do chat; o clique é o mandato. */
    releaseChat: (
      id: string
    ): Promise<{ ok: true; missionId: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke('backlog:releaseChat', id),
    /** R27F2 — o retrato das subidas da versão (mais recente primeiro). */
    versionReleases: (id: string): Promise<VersionReleaseRecord[]> =>
      ipcRenderer.invoke('backlog:versionReleases', id),
    listItems: (projectId: string): Promise<BacklogItem[]> =>
      ipcRenderer.invoke('backlog:listItems', projectId),
    updateItem: (
      projectId: string,
      id: string,
      patch: {
        title?: string
        notes?: string
        type?: BacklogItemType
        status?: BacklogItemStatus
        versionId?: string | null
        missionId?: string | null
      }
    ): Promise<BacklogItem | null> =>
      ipcRenderer.invoke('backlog:updateItem', projectId, id, patch),
    removeItem: (projectId: string, id: string): Promise<void> =>
      ipcRenderer.invoke('backlog:removeItem', projectId, id),
    onChanged: (cb: (projectId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string): void => cb(projectId)
      ipcRenderer.on('backlog:changed', listener)
      return () => ipcRenderer.removeListener('backlog:changed', listener)
    }
  },
  files: {
    /** Árvore somente leitura: a main resolve a raiz pelo ID e devolve apenas
     * caminhos relativos, nunca caminhos absolutos ou URLs locais diretas. */
    listTree: (projectId: string, root: FileTreeRoot): Promise<FileTreeResult> =>
      ipcRenderer.invoke('files:listTree', projectId, root),
    /** Preview somente leitura. O caminho é relativo à raiz autorizada; não
     * existe operação de edição, download ou salvamento neste contrato. */
    preview: (
      projectId: string,
      root: FileTreeRoot,
      relativePath: string
    ): Promise<FilePreviewResult | null> =>
      ipcRenderer.invoke('files:preview', projectId, root, relativePath),
    /** Rodada 7 (C1): manda o arquivo para FORA do app — programa padrão do
     *  sistema (`default`) ou pasta com ele selecionado (`reveal`). Mesma raiz
     *  lógica do preview: o caminho absoluto nasce e morre no main. */
    openExternal: (
      projectId: string,
      root: FileTreeRoot,
      relativePath: string,
      mode: FileExternalOpenMode
    ): Promise<FileExternalOpenResult> =>
      ipcRenderer.invoke('files:openExternal', projectId, root, relativePath, mode),
    tree: (scope: FileActionScope): Promise<FileTreeSnapshot> =>
      ipcRenderer.invoke('files:tree', scope),
    createFile: (
      scope: FileActionScope,
      parentPath: string,
      name: string
    ): Promise<FileActionResult> =>
      ipcRenderer.invoke('files:createFile', scope, parentPath, name),
    createFolder: (
      scope: FileActionScope,
      parentPath: string,
      name: string
    ): Promise<FileActionResult> =>
      ipcRenderer.invoke('files:createFolder', scope, parentPath, name),
    rename: (
      scope: FileActionScope,
      relativePath: string,
      name: string
    ): Promise<FileActionResult> =>
      ipcRenderer.invoke('files:rename', scope, relativePath, name),
    trash: (
      scope: FileActionScope,
      relativePath: string
    ): Promise<FileActionResult> =>
      ipcRenderer.invoke('files:trash', scope, relativePath),
    copyPath: (
      scope: FileActionScope,
      relativePath: string
    ): Promise<FileActionResult> =>
      ipcRenderer.invoke('files:copyPath', scope, relativePath),
    downloadZip: (
      scope: FileActionScope,
      relativePath: string
    ): Promise<FileActionResult> =>
      ipcRenderer.invoke('files:downloadZip', scope, relativePath),
    onChanged: (cb: (scope: FileActionScope) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, scope: FileActionScope): void => cb(scope)
      ipcRenderer.on('files:changed', listener)
      return () => ipcRenderer.removeListener('files:changed', listener)
    },
    listDocs: (projectId: string): Promise<DocFile[]> =>
      ipcRenderer.invoke('files:listDocs', projectId),
    readDoc: (
      projectId: string,
      relPath: string
    ): Promise<{ content: string; mtime: number } | null> =>
      ipcRenderer.invoke('files:readDoc', projectId, relPath),
    terminalLinks: (
      projectId: string,
      paneId: string,
      text: string
    ): Promise<TerminalFileLink[]> =>
      ipcRenderer.invoke('files:terminalLinks', projectId, paneId, text),
    openTerminalFile: (
      projectId: string,
      paneId: string,
      candidate: string
    ): Promise<TerminalFileOpenResult> =>
      ipcRenderer.invoke('files:openTerminalFile', projectId, paneId, candidate),
    readTerminalDoc: (
      projectId: string,
      paneId: string,
      root: 'project' | 'pane',
      relPath: string
    ): Promise<{ content: string; mtime: number } | null> =>
      ipcRenderer.invoke('files:readTerminalDoc', projectId, paneId, root, relPath),
    /** F3-c4 (HOST): link .md clicado em QUALQUER terminal (host ou view de
     *  panes) chega aqui — o main empurra o desfecho para quem abre a aba. */
    onNavigate: (
      cb: (projectId: string, result: TerminalFileOpenResult) => void
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        projectId: string,
        result: TerminalFileOpenResult
      ): void => cb(projectId, result)
      ipcRenderer.on('files:navigate', listener)
      return () => ipcRenderer.removeListener('files:navigate', listener)
    }
  },
  catalog: {
    get: (cli: SeatCli, seatId?: string): Promise<Catalog> =>
      ipcRenderer.invoke('catalog:get', cli, seatId)
  },
  // Versão dos CLIs que os panes executam: o app checa/atualiza sozinho no
  // boot, e o botão do titlebar força a rodada.
  cli: {
    status: (): Promise<CliStatus[]> => ipcRenderer.invoke('cli:status'),
    update: (): Promise<CliStatus[]> => ipcRenderer.invoke('cli:update'),
    onStatus: (cb: (all: CliStatus[]) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, all: CliStatus[]): void => cb(all)
      ipcRenderer.on('cli:status', listener)
      return () => ipcRenderer.removeListener('cli:status', listener)
    }
  },
  perf: {
    /** travada do renderer (event-loop stall) → caixa-preta */
    reportStall: (lagMs: number): void => ipcRenderer.send('perf:renderer-stall', lagMs)
  },
  // O NAMESPACE `harness` (setBypass, setSensitiveBypass) morreu na purga F6:
  // a permissão da era 2.0 é por CONVERSA, decidida no próprio chat.
  plans: {
    /** As abas do MAPA, já com o progresso derivado das missões. */
    list: (projectId: string): Promise<PlanView[]> => ipcRenderer.invoke('plans:list', projectId),
    /** Criação MANUAL. A aprovação do card de proposta usa gui.answerPlanProposal:
     *  lá o rascunho vem do anel do pane, não do renderer. */
    create: (projectId: string, draft: PlanDraftInput): Promise<PlanMutationResult> =>
      ipcRenderer.invoke('plans:create', projectId, draft),
    /** Todo mutador leva o `updatedAt` que a tela mostrou (CAS otimista). */
    update: (
      planId: string,
      patch: PlanPatchInput,
      expectedUpdatedAt: string
    ): Promise<PlanMutationResult> =>
      ipcRenderer.invoke('plans:update', planId, patch, expectedUpdatedAt),
    /** DESIGNAÇÃO do dono: promove/rebaixa o plano mestre. Não existe por tool. */
    setKind: (
      planId: string,
      kind: PlanKindView,
      expectedUpdatedAt: string
    ): Promise<PlanMutationResult> =>
      ipcRenderer.invoke('plans:setKind', planId, kind, expectedUpdatedAt),
    /** Reversível: a aba some do mapa, o conteúdo fica. */
    archive: (planId: string, expectedUpdatedAt: string): Promise<PlanMutationResult> =>
      ipcRenderer.invoke('plans:archive', planId, expectedUpdatedAt),
    /** Exclusão DEFINITIVA — só com confirmação in-app. */
    remove: (planId: string, expectedUpdatedAt: string): Promise<PlanRemovalResult> =>
      ipcRenderer.invoke('plans:remove', planId, expectedUpdatedAt),
    /** O item virou missão: único caminho que grava o vínculo. */
    linkMission: (
      planId: string,
      itemId: string,
      missionId: string,
      expectedUpdatedAt: string
    ): Promise<PlanMutationResult> =>
      ipcRenderer.invoke('plans:linkMission', planId, itemId, missionId, expectedUpdatedAt),
    /** O main mexeu em algum plano deste universo (agente, clique ou autocura). */
    onChanged: (cb: (projectId: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, projectId: string): void => cb(projectId)
      ipcRenderer.on('plans:changed', listener)
      return () => ipcRenderer.removeListener('plans:changed', listener)
    }
  },
  // ————— fim do BLOCO NOVO de planos —————
  hub: {
    onEvent: (cb: (evt: HubEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, evt: HubEvent): void => cb(evt)
      ipcRenderer.on('hub:event', listener)
      return () => ipcRenderer.removeListener('hub:event', listener)
    },
    onCommunication: (cb: (evt: HubCommunicationEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, evt: HubCommunicationEvent): void => cb(evt)
      ipcRenderer.on('hub:communication', listener)
      return () => ipcRenderer.removeListener('hub:communication', listener)
    }
  },
  // O NAMESPACE `policies` (modelos por função) morreu na purga F6: quem
  // escolhe conta e modelo é o dono, dentro da conversa.
  settings: {
    get: (): Promise<SynkoraSettings> => ipcRenderer.invoke('settings:get'),
    set: (patch: SynkoraSettingsPatch): Promise<SynkoraSettings> =>
      ipcRenderer.invoke('settings:set', patch),
    /** F3-c4: o outro lado (host ↔ view de panes) gravou settings — recarrega
     *  (o zoom de fonte do terminal vale nas duas). */
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('settings:changed', listener)
      return () => ipcRenderer.removeListener('settings:changed', listener)
    }
  },
  progress: {
    ready: (): void => ipcRenderer.send('progress:renderer-ready'),
    openOverlay: (): Promise<void> => ipcRenderer.invoke('progress:overlay-open'),
    getSnapshot: (): Promise<ProgressOverlaySnapshot> =>
      ipcRenderer.invoke('progress:get-snapshot'),
    onSnapshot: (cb: (snapshot: ProgressOverlaySnapshot) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, snapshot: ProgressOverlaySnapshot): void =>
        cb(snapshot)
      ipcRenderer.on('progress:snapshot-changed', listener)
      return () => ipcRenderer.removeListener('progress:snapshot-changed', listener)
    },
    onOpenTarget: (cb: (target: ProgressOpenTarget) => void): (() => void) => {
      const listener = (_event: IpcRendererEvent, target: ProgressOpenTarget): void => cb(target)
      ipcRenderer.on('progress:open-target', listener)
      return () => ipcRenderer.removeListener('progress:open-target', listener)
    }
  },
  voice: {
    getConfig: (): Promise<SynVoiceConfig> => ipcRenderer.invoke('voice:getConfig'),
    setProvider: (provider: SynVoiceProvider): Promise<SynVoiceConfig> =>
      ipcRenderer.invoke('voice:setProvider', provider),
    setModel: (provider: SynVoiceProvider, model: string | null): Promise<SynVoiceConfig> =>
      ipcRenderer.invoke('voice:setModel', provider, model),
    setCustomVocabulary: (terms: string[]): Promise<SynVoiceConfig> =>
      ipcRenderer.invoke('voice:setCustomVocabulary', terms),
    listModels: (provider: SynVoiceProvider): Promise<SynVoiceModel[]> =>
      ipcRenderer.invoke('voice:listModels', provider),
    setApiKey: (provider: SynVoiceProvider, key: string | null): Promise<SynVoiceConfig> =>
      ipcRenderer.invoke('voice:setApiKey', provider, key),
    openApiKeys: (provider: SynVoiceProvider): Promise<void> =>
      ipcRenderer.invoke('voice:openApiKeys', provider),
    transcribe: (request: {
      requestId: string
      audio: ArrayBuffer
      mimeType: string
      durationMs: number
      externalTargetToken?: string | null
    }): Promise<SynVoiceTranscript> => ipcRenderer.invoke('voice:transcribe', request),
    // banquinho das últimas falas (2026-08-06): recuperar transcrição perdida
    history: (): Promise<Array<{ text: string; at: string }>> =>
      ipcRenderer.invoke('voice:history'),
    historyCopy: (index: number): Promise<boolean> =>
      ipcRenderer.invoke('voice:historyCopy', index),
    cancel: (requestId: string): void => ipcRenderer.send('voice:cancel', requestId),
    captureExternalTarget: (): Promise<string | null> =>
      ipcRenderer.invoke('voice:external-begin'),
    discardExternalTarget: (token: string): void =>
      ipcRenderer.send('voice:external-discard', token),
    openOverlay: (): Promise<void> => ipcRenderer.invoke('voice:overlay-open'),
    isOverlayDetached: (): Promise<boolean> => ipcRenderer.invoke('voice:overlay-is-detached'),
    publishOverlayState: (state: SynVoiceOverlayState): void =>
      ipcRenderer.send('voice:overlay-state', state),
    onOverlayCommand: (cb: (command: SynVoiceOverlayCommand) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, command: SynVoiceOverlayCommand): void => cb(command)
      ipcRenderer.on('voice:overlay-command-received', listener)
      return () => ipcRenderer.removeListener('voice:overlay-command-received', listener)
    },
    onOverlayVisibility: (cb: (detached: boolean) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, detached: boolean): void => cb(Boolean(detached))
      ipcRenderer.on('voice:overlay-visibility', listener)
      return () => ipcRenderer.removeListener('voice:overlay-visibility', listener)
    },
    setGlobalActivation: (binding: SynVoiceGlobalActivationBinding | null): void =>
      ipcRenderer.send('voice:global-activation-config', binding),
    onGlobalActivation: (cb: (event: SynVoiceGlobalActivationEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, event: SynVoiceGlobalActivationEvent): void => cb(event)
      ipcRenderer.on('voice:global-activation-event', listener)
      return () => ipcRenderer.removeListener('voice:global-activation-event', listener)
    },
    showNotice: (message: string, tone: SynVoiceNoticeTone = 'error'): void =>
      ipcRenderer.send('voice:show-notice', { message, tone })
  },
  blackbox: {
    /** exporta o pacote de diagnóstico completo (diário + estado + Git) */
    exportDiagnostics: (): Promise<{ ok: boolean; msg: string }> =>
      ipcRenderer.invoke('blackbox:export')
  },
  clipboard: {
    hasImage: (): boolean => ipcRenderer.sendSync('clipboard:hasImage') as boolean,
    saveImage: (projectId: string): Promise<string | null> =>
      ipcRenderer.invoke('clipboard:saveImage', projectId),
    readText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText')
  },
  /** Caminho absoluto de um File arrastado (Electron 43: File.path não existe;
   *  só o preload enxerga via webUtils). */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  attachments: {
    /** copia arquivos soltos num pane para .synkora/attachments do projeto */
    import: (projectId: string, paths: string[]): Promise<string[]> =>
      ipcRenderer.invoke('attachments:import', projectId, paths)
  },
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  pty: {
    create: (opts: {
      id: string
      cwd: string
      kind: PaneKind
      seatId?: string
      taskId?: string
      initialPrompt?: string
      model?: string
      cliArgs?: string[]
      appendSystemPrompt?: string
      cols?: number
      rows?: number
      logFile?: string
    }): Promise<boolean> => ipcRenderer.invoke('pty:create', opts),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id: string): void => ipcRenderer.send('pty:kill', id),
    /** Pedido inicial do renderer, antes da espera pela estabilização do layout. */
    markStartupRequest: (id: string): void => ipcRenderer.send('pty:startup-request', id),
    /** Primeiro frame com bytes do PTY realmente pintado pelo xterm. */
    markFirstFrame: (id: string): void => ipcRenderer.send('pty:first-frame', id),
    onData: (cb: (id: string, data: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, data: string): void => cb(id, data)
      ipcRenderer.on('pty:data', listener)
      return () => ipcRenderer.removeListener('pty:data', listener)
    },
    onExit: (cb: (id: string, exitCode: number) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, exitCode: number): void =>
        cb(id, exitCode)
      ipcRenderer.on('pty:exit', listener)
      return () => ipcRenderer.removeListener('pty:exit', listener)
    },
    /** o usuário digitou /clear (claude) ou /new (codex) neste pane — o xterm
     *  limpa tela E scrollback (sinal do comando, não adivinhação por texto) */
    onReset: (cb: (id: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string): void => cb(id)
      ipcRenderer.on('pty:reset', listener)
      return () => ipcRenderer.removeListener('pty:reset', listener)
    },
    /** últimas linhas LIMPAS que o agente escreveu (as mesmas do transcript) —
     *  alimenta os cartões-vivos: dá para ver o que 20 panes estão fazendo sem
     *  pintar 20 terminais */
    onLastLines: (cb: (id: string, lines: string[]) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, lines: string[]): void => cb(id, lines)
      ipcRenderer.on('pane:lastlines', listener)
      return () => ipcRenderer.removeListener('pane:lastlines', listener)
    },
    onStats: (cb: (id: string, stats: PaneStats) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, stats: PaneStats): void =>
        cb(id, stats)
      ipcRenderer.on('panes:stats', listener)
      return () => ipcRenderer.removeListener('panes:stats', listener)
    },
    /** effort REAL detectado no banner do CLI (o JSONL não registra effort) */
    onEffort: (cb: (id: string, effort: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, effort: string): void =>
        cb(id, effort)
      ipcRenderer.on('pty:effort', listener)
      return () => ipcRenderer.removeListener('pty:effort', listener)
    },
    /** modelo REAL detectado no banner do CLI — fallback do badge [MODELO]
     *  em panes sem modelo configurado (antes do JSONL da sessão existir) */
    onModel: (cb: (id: string, model: string) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, id: string, model: string): void =>
        cb(id, model)
      ipcRenderer.on('pty:model', listener)
      return () => ipcRenderer.removeListener('pty:model', listener)
    }
  }
}

export type SynkoraApi = typeof api

const overlayApi = {
  getState: (): Promise<SynVoiceOverlayState> => ipcRenderer.invoke('voice:overlay-get-state'),
  prepareInteraction: (): void => ipcRenderer.send('voice:overlay-prepare-interaction'),
  // banquinho das últimas falas TAMBÉM no mini destacado (2026-08-06): a
  // janela é fixa — abrir o menu cresce a própria janela via IPC dedicado
  history: (): Promise<Array<{ text: string; at: string }>> =>
    ipcRenderer.invoke('voice:overlay-history'),
  historyCopy: (index: number): Promise<boolean> =>
    ipcRenderer.invoke('voice:overlay-history-copy', index),
  setHistoryOpen: (open: boolean): void =>
    ipcRenderer.send('voice:overlay-history-open', open),
  command: (command: SynVoiceOverlayCommand): void =>
    ipcRenderer.send('voice:overlay-command', command),
  showTooltip: (request: SynVoiceOverlayTooltipRequest): void =>
    ipcRenderer.send('voice:overlay-tooltip-show', request),
  hideTooltip: (): void => ipcRenderer.send('voice:overlay-tooltip-hide'),
  onState: (cb: (state: SynVoiceOverlayState) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, state: SynVoiceOverlayState): void => cb(state)
    ipcRenderer.on('voice:overlay-state-changed', listener)
    return () => ipcRenderer.removeListener('voice:overlay-state-changed', listener)
  }
}

export type SynkoraOverlayApi = typeof overlayApi

const progressOverlayApi = {
  getState: (): Promise<ProgressOverlayState> =>
    ipcRenderer.invoke('progress:overlay-get-state'),
  command: (command: ProgressOverlayCommand, target?: ProgressOpenTarget): void =>
    ipcRenderer.send('progress:overlay-command', { command, ...target }),
  /** Alça própria de resize (janela transparente não tem resize nativo). */
  resize: (width: number, height: number): void =>
    ipcRenderer.send('progress:overlay-resize', { width, height }),
  onSnapshot: (cb: (snapshot: ProgressOverlaySnapshot) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, snapshot: ProgressOverlaySnapshot): void =>
      cb(snapshot)
    ipcRenderer.on('progress:snapshot-changed', listener)
    return () => ipcRenderer.removeListener('progress:snapshot-changed', listener)
  },
  onMode: (cb: (state: { compact: boolean }) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, state: { compact: boolean }): void => cb(state)
    ipcRenderer.on('progress:overlay-mode-changed', listener)
    return () => ipcRenderer.removeListener('progress:overlay-mode-changed', listener)
  },
  onHistory: (cb: (state: { clearedAt: string | null }) => void): (() => void) => {
    const listener = (
      _event: IpcRendererEvent,
      state: { clearedAt: string | null }
    ): void => cb(state)
    ipcRenderer.on('progress:overlay-history-changed', listener)
    return () => ipcRenderer.removeListener('progress:overlay-history-changed', listener)
  }
}

export type SynkoraProgressOverlayApi = typeof progressOverlayApi

const isSynVoiceOverlay = process.argv.includes('--synvoice-overlay')
const isProgressOverlay = process.argv.includes('--progress-overlay')

if (isProgressOverlay) {
  contextBridge.exposeInMainWorld('synkoraProgressOverlay', progressOverlayApi)
} else if (isSynVoiceOverlay) contextBridge.exposeInMainWorld('synkoraOverlay', overlayApi)
else contextBridge.exposeInMainWorld('synkora', api)
