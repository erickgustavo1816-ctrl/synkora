# FASE 1 — MAPA DO `missionEngine.ts` (levantamento READ-ONLY)

Branch `nivel5-fase1` · `src/main/index.ts` com **11768 linhas** · levantamento
de 2026-08-08. **Nenhum arquivo sob `src/` foi alterado.**

Este documento dirige um corte VERBATIM por faixa de linhas. Todas as faixas e
âncoras abaixo foram **re-localizadas por grep imediatamente antes da escrita**
deste arquivo — mas a regra da casa continua valendo: **números de linha
envelhecem; re-conferir por âncora antes de qualquer `sed`/script.**

Padrão a replicar: `src/main/phaseEngine.ts`
(`createPhaseEngine(ctx, extras)` — estado nasce no engine, `index` destructura
aliases para os call sites e para os getters do `MainContext` ficarem
textualmente intactos).

Referências estruturais do `index.ts` (verificadas):

| ponto | linha |
|---|---|
| `const ctx: MainContext = {` | 3485 |
| getters `missionWatches` / `integrationDrainTimers` / `integrationDraining` | 3545 / 3548 / 3551 |
| região MISSÕES (bloco contíguo) | 5012 – 7056 |
| `const phaseEngine = createPhaseEngine(ctx, {` | 9580 |
| `} = phaseEngine` (destructure dos aliases) | 9628 |
| poller de 3s (`setInterval`) | 9848 – 9935 |
| `const mcpApi: McpApi = {` | 10904 |
| recuperação de boot (`for (const p of projects.list())`) | 11375 – 11560 |
| `registerBacklogIpc` / `registerTasksIpc` | 11706 / 11712 |

---

## 1. Inventário dos blocos a mover

### 1.1 `missionEngine.ts` — 29 blocos, **2044 linhas**

Legenda das âncoras: são regexes **multilinha** (`gm`) validados com contagem
de ocorrências no arquivo inteiro — **cada um casa exatamente 1×**. `\n` é
quebra de linha real. As âncoras de FIM precisam de 2–7 linhas porque `^  }$`
sozinho casa 214× no arquivo.

| # | bloco | faixa | linhas |
|---|---|---|---|
| 1 | `emitMissionsChanged` | [5017, 5020] | 4 |
| 2 | `integrationQueueView` | [5022, 5036] | 15 |
| 3 | `missionsWithIntegration` | [5038, 5050] | 13 |
| 4 | `missionWorkspacePath` (+ JSDoc) | [5052, 5064] | 13 |
| 5 | `ensureMissionWorktree` (+ comentário) | [5102, 5228] | 127 |
| 6 | `createMissionImpl` | [5230, 5264] | 35 |
| 7 | `ensureMissionVersion` | [5266, 5311] | 46 |
| 8 | `MissionStartIntent` + `missionStartIntentPath` + `writeMissionStartIntent` + `clearMissionStartIntent` | [5313, 5350] | 38 |
| 9 | `rollbackPlannedMission` | [5352, 5366] | 15 |
| 10 | `ensurePlannedMissionBacklogItem` | [5368, 5407] | 40 |
| 11 | `recoverMissionStartIntents` | [5409, 5577] | 169 |
| 12 | `completeLinkedProjectPlanMission` (+ JSDoc) | [5579, 5666] | 88 |
| 13 | `reconcileConcludedMission` (+ JSDoc) | [5668, 5716] | 49 |
| 14 | `transitionLinkedProjectPlanMission` | [5718, 5750] | 33 |
| 15 | `cleanupMissionFiles` (+ comentário) | [5752, 5790] | 39 |
| 16 | **ESTADO**: `missionWatches` + `integrationDrainTimers` + `integrationDraining` (+ comentário) | [5792, 5795] | 4 |
| 17 | `interface MissionIntegrationTarget` + `resolveMissionIntegrationTarget` | [5797, 5886] | 90 |
| 18 | `scheduleIntegrationDrain` | [5888, 5897] | 10 |
| 19 | `createIntegrationSyncTask` | [5899, 5976] | 78 |
| 20 | `repairIntegrationSyncTickets` | [5978, 6032] | 55 |
| 21 | `startMissionIntegration` | [6034, 6197] | 164 |
| 22 | `drainIntegrationQueue` | [6199, 6452] | 254 |
| 23 | `emitIntegrationBlockForMaestro` | [6454, 6485] | 32 |
| 24 | `missionIntegrationIntentPath` + `interface MissionIntegrationIntent` + `writeMissionIntegrationIntent` + `clearMissionIntegrationIntent` | [6487, 6549] | 63 |
| 25 | `recoverMissionIntegrationIntents` | [6551, 6760] | 210 |
| 26 | comentário + `interface MissionMergeCompletion` + `completeMissionMerge` + `completeMissionMergeInner` | [6762, 7023] | 262 |
| 27 | `handleMissionVerdict` | [7025, 7056] | 32 |
| 28 | `stopMissionExecution` | [9801, 9844] | 44 |
| 29a | comentário órfão do tick (ver §5.7) | [9850, 9850] | 1 |
| 29b | corpo do `tickMissionWatches` (hoje inline no poller) | [9914, 9934] | 21 |

**Total: 2044 linhas.** Blocos 1–27 são **contíguos** (5012–7056, com apenas as
linhas em branco entre eles) — na prática o corte é **uma fatia grande**
(5012–7056, 2045 linhas incluindo o cabeçalho de comentário de 5012–5015 e as
linhas em branco) mais 3 fatias pequenas (28, 29a, 29b).

#### Âncoras (regex `gm`, 1 ocorrência cada — conferidas)

```
#1  emitMissionsChanged [5017,5020]
 FIRST ^  function emitMissionsChanged\(projectId: string\): void \{$
 LAST  ^    if \(uiSender && !uiSender\.isDestroyed\(\)\) uiSender\.send\('missions:changed', projectId\)\n    scheduleProgressSnapshot\(\)\n  \}$

#2  integrationQueueView [5022,5036]
 FIRST ^  function integrationQueueView\(ticket: IntegrationQueueTicketView\): \{$
 LAST  ^      owner: ticket\.block\?\.owner\n    \}\n  \}$

#3  missionsWithIntegration [5038,5050]
 FIRST ^  function missionsWithIntegration\(projectId: string\): Array<$
 LAST  ^    \}\)\)\n  \}$

#4  missionWorkspacePath [5052,5064]
 FIRST ^  /\*\*\n   \* Projeto sem Git ainda pode operar diretamente\. Em projeto Git, porém, uma$
 LAST  ^      mission\.worktree\n    \)\n  \}$

#5  ensureMissionWorktree [5102,5228]
 FIRST ^  /\*\* Garante branch/worktree da missão — inicializando o GIT do projeto se$
 LAST  ^    return missions\.get\(mission\.id\)\n  \}$

#6  createMissionImpl [5230,5264]
 FIRST ^  function createMissionImpl\($
 LAST  ^    return fresh\n  \}$

#7  ensureMissionVersion [5266,5311]
 FIRST ^  function ensureMissionVersion\($
 LAST  ^    return \{ versionId: created\.id, name: created\.name \}\n  \}$

#8  MissionStartIntent + paths [5313,5350]
 FIRST ^  interface MissionStartIntent \{$
 LAST  ^      unlinkSync\(missionStartIntentPath\(projectPath, missionId\)\)\n    \} catch \{\n      // nunca iniciou ou já foi reconciliada\n    \}\n  \}$

#9  rollbackPlannedMission [5352,5366]
 FIRST ^  function rollbackPlannedMission\(projectId: string, missionId: string\): void \{$
 LAST  ^    emitBacklogChanged\(projectId\)\n    syncBoard\(projectId\)\n  \}$

#10 ensurePlannedMissionBacklogItem [5368,5407]
 FIRST ^  function ensurePlannedMissionBacklogItem\($
 LAST  ^        syncBoard\(projectId\)\n      \}\n      return undefined\n    \} catch \(error\) \{\n      return error instanceof Error \? error\.message : String\(error\)\n    \}\n  \}$

#11 recoverMissionStartIntents [5409,5577]
 FIRST ^  function recoverMissionStartIntents\(projectId: string\): void \{$
 LAST  ^          text: `a missão "\$\{mission\.title\}" foi recuperada e vinculada ao mapa, mas o espelho em Versões ainda precisa ser reconciliado: \$\{mirrorError\}`,\n          actor: 'harness'\n        \}\)\n      \}\n    \}\n  \}$

#12 completeLinkedProjectPlanMission [5579,5666]
 FIRST ^  /\*\*\n   \* Avança o mapa macro quando uma missão ligada ao roadmap é integrada\.$
 LAST  ^      \}\)\n      return false\n    \}\n  \}$

#13 reconcileConcludedMission [5668,5716]
 FIRST ^  /\*\*\n   \* Reconcilia todos os registros derivados de uma missão já pousada\. É$
 LAST  ^      return \{ ok: false, doneItems: 0 \}\n    \}\n  \}$

#14 transitionLinkedProjectPlanMission [5718,5750]
 FIRST ^  function transitionLinkedProjectPlanMission\($
 LAST  ^        detachStoredProjectMission\(project\.path, \{ missionId \}\)\n      \}\n      return undefined\n    \} catch \(error\) \{\n      return error instanceof Error \? error\.message : String\(error\)\n    \}\n  \}$

#15 cleanupMissionFiles [5752,5790]
 FIRST ^  // Missão integrada: os arquivos operacionais dela \(transcripts das tarefas,$
 LAST  ^    zap\(join\(project\.path, '\.synkora', 'missions', `\$\{short\}\.PLAN\.md`\)\)\n  \}$

#16 ESTADO [5792,5795]
 FIRST ^  // Gate de integração pendente por missão \(tipo em phaseTypes\.ts\)\.$
 LAST  ^  const integrationDraining = new Set<string>\(\)$

#17 MissionIntegrationTarget + resolve [5797,5886]
 FIRST ^  interface MissionIntegrationTarget \{$
 LAST  ^      versionId: version\.id\n    \}\n  \}$

#18 scheduleIntegrationDrain [5888,5897]
 FIRST ^  function scheduleIntegrationDrain\(projectId: string\): void \{$
 LAST  ^    integrationDrainTimers\.set\(projectId, timer\)\n  \}$

#19 createIntegrationSyncTask [5899,5976]
 FIRST ^  function createIntegrationSyncTask\($
 LAST  ^    if \(uiSender && !uiSender\.isDestroyed\(\)\) uiSender\.send\('tasks:changed', mission\.projectId\)\n    return true\n  \}$

#20 repairIntegrationSyncTickets [5978,6032]
 FIRST ^  function repairIntegrationSyncTickets\(projectId: string\): void \{$
 LAST  ^      syncBoard\(projectId\)\n    \}\n  \}$

#21 startMissionIntegration [6034,6197]
 FIRST ^  function startMissionIntegration\(missionId: string, actor: string\): string \{$
 LAST  ^      : 'missão colocada na fila de integração'\n  \}$

#22 drainIntegrationQueue [6199,6452]
 FIRST ^  async function drainIntegrationQueue\(projectId: string\): Promise<void> \{$
 LAST  ^      integrationDraining\.delete\(projectId\)\n    \}\n  \}$

#23 emitIntegrationBlockForMaestro [6454,6485]
 FIRST ^  function emitIntegrationBlockForMaestro\($
 LAST  ^    syncBoard\(mission\.projectId\)\n  \}$

#24 intent de integração [6487,6549]
 FIRST ^  function missionIntegrationIntentPath\(projectPath: string, missionId: string\): string \{$
 LAST  ^      unlinkSync\(missionIntegrationIntentPath\(projectPath, missionId\)\)\n    \} catch \{\n      // nunca iniciou ou já foi reconciliada\n    \}\n  \}$

#25 recoverMissionIntegrationIntents [6551,6760]
 FIRST ^  function recoverMissionIntegrationIntents\(projectId: string\): void \{$
 LAST  ^          text: `integração da missão "\$\{mission\.title\}" reconciliada após uma interrupção do aplicativo`,\n          actor: 'harness'\n        \}\)\n      \}\n    \}\n  \}$

#26 completeMissionMerge (+Inner) [6762,7023]
 FIRST ^  // O MERGE da missão \(caminho único da integração\): mata o orquestrador,$
 LAST  ^        \}\n  \}$

#27 handleMissionVerdict [7025,7056]
 FIRST ^  function handleMissionVerdict\(watch: MissionWatch, content: string\): void \{$
 LAST  ^    startMissionIntegration\(watch\.missionId, 'review legado'\)\n  \}$

#28 stopMissionExecution [9801,9844]
 FIRST ^  function stopMissionExecution\(projectId: string, missionId: string, reason: string\): void \{$
 LAST  ^    \}\n    syncBoard\(projectId\)\n  \}$

#29a comentário órfão [9850,9850]
 ÚNICA ^    // Marcadores de INTEGRAÇÃO de missão \(fallback do report MCP do gate\)\.$

#29b tickMissionWatches inline [9914,9934]
 FIRST ^    for \(const \[missionId, watch\] of \[\.\.\.missionWatches\]\) \{$
 LAST  ^      handleMissionVerdict\(watch, content\)\n    \}$
```

### 1.2 `src/main/ipc/missions.ts` — 8 handlers, **501 linhas**

| handler | faixa | linhas |
|---|---|---|
| `missions:list` | [7058, 7058] | 1 |
| `missions:create` | [7060, 7074] | 15 |
| `missions:confirmOrchestrator` (+ comentário) | [7076, 7102] | 27 |
| `missions:setOrchestratorSeat` (+ comentário) | [7104, 7185] | 82 |
| `missions:update` | [7187, 7265] | 79 |
| `missions:integrate` | [7267, 7270] | 4 |
| `missions:remove` (+ comentário) | [7897, 7978] | 82 |
| `missions:paneSpec` | [8028, 8238] | 211 |

```
missions:list [7058,7058]
 FIRST/LAST ^  ipcMain\.handle\('missions:list', \(_e, projectId: string\) => missionsWithIntegration\(projectId\)\)$

missions:create [7060,7074]
 FIRST ^  ipcMain\.handle\('missions:create', \(e, projectId: string, input: NewMission\) => \{$
 LAST  ^    return createMissionImpl\(projectId, input, 'user'\)\n  \}\)$

missions:confirmOrchestrator [7076,7102]
 FIRST ^  // Missão criada pelo PM: o usuário escolhe conta/modelo/effort do$
 LAST  ^      return true\n    \}\n  \)$

missions:setOrchestratorSeat [7104,7185]
 FIRST ^  // Troca de CONTA do orquestrador no meio da missão \(decisão do usuário,$
 LAST  ^          : 'conta trocada; conversa recomeça e o orquestrador se reergue pelos arquivos da missão'\n      \}\n    \}\n  \)$

missions:update [7187,7265]
 FIRST ^  ipcMain\.handle\(\n    'missions:update',$
 LAST  ^      return updated \?\? null\n    \}\n  \)$

missions:integrate [7267,7270]
 FIRST ^  ipcMain\.handle\('missions:integrate', \(e, missionId: string\) => \{$
 LAST  ^    return startMissionIntegration\(missionId, 'user'\)\n  \}\)$

missions:remove [7897,7978]
 FIRST ^  // Excluir missão: só ARQUIVADA \(fluxo: arquivar → excluir\)\. Leva junto as$
 LAST  ^    syncBoard\(mission\.projectId\)\n    return true\n  \}\)$

missions:paneSpec [8028,8238]
 FIRST ^  ipcMain\.handle\('missions:paneSpec', async \(e, projectId: string, missionId: string\) => \{$
 LAST  ^      missionId\n    \}\n  \}\)$
```

**Total geral do levantamento: 2545 linhas (2044 engine + 501 ipc).**

### 1.3 O que fica de fora, e por quê

| símbolo | faixa | decisão | justificativa |
|---|---|---|---|
| `versionIsolationIsUnique` / `versionIsolationIsValid` | [5066, 5100] | **FICA no index** → vira `extras` do engine | Domínio VERSÃO, não missão. Já é `extras` de `ipc/backlog.ts` (`BacklogIpcExtras.versionIsolationIsValid`). Movê-lo para o `missionEngine` obrigaria o `ipc/backlog` a importar do engine de missões — acoplamento invertido. Candidato natural a um `versionIsolation.ts` puro numa fase futura. |
| `releaseVersionImpl` | [7510, 7705] | **FICA no index** | Release de VERSÃO, não de missão. Toca `missions` só como GUARDA (`missions.list(...).filter(m.versionId === versionId && (ativa\|integrando))`, linha 7591). Consumidores: `ipc/backlog.ts` (extras) e o `release_version` do PM. Pertence a um futuro `releaseEngine`/`backlogEngine`, junto com `versionReleaseIntentPath` [7282], `VersionReleaseIntent` [7286], `writeVersionReleaseIntent` [7297], `clearVersionReleaseIntent` [7341] e `recoverVersionReleaseIntents` [7350, 7508]. |
| `emitBacklogChanged` | [7273, 7275] | **FICA no index** → `extras` | Domínio backlog; já é extras de `ipc/backlog.ts`. |
| `sweepProjectFiles` | [7776, ...] | **FICA no index** → `extras` | Vassoura genérica do `.synkora` (helpers, marcadores, prints); missão é só um dos consumidores. |
| `closeTestServersUnder` | [9085, ...] | **FICA no index** → `extras` | Ciclo de vida de PANE de teste (`testServerPanes`). |
| Recuperação de boot | [11375, 11560] | **FICA no index** (§5.3) | Varre projetos/tarefas/versões inteiros; missão é uma seção. Consome o engine pela superfície pública. |

---

## 2. Classificação de dependências

### 2.a Membros já presentes no `MainContext`

Varredura por bloco (identificadores cruzados contra a interface `MainContext`).
**Nenhum bloco da região de missões usa símbolo de nível de módulo do `index.ts`
que não esteja no `MainContext`** — verificado: os únicos encontrados foram
`ptys@341`, `hub@397`, `codeIntelligence@401`, `projects@469`, `tasks@471`,
`uiSender@491`, `scheduleProgressSnapshot@1954`, `blackbox@2284`,
`mainStalls@2362` — todos membros de `ctx`.

| bloco | `ctx.*` usados |
|---|---|
| #1 `emitMissionsChanged` | `uiSender`, `scheduleProgressSnapshot` (2) |
| #2 `integrationQueueView` | — (0) |
| #3 `missionsWithIntegration` | `integrationQueue`, `missions` (2) |
| #4 `missionWorkspacePath` | — (0) |
| #5 `ensureMissionWorktree` | `missions`, `projects`, `hub`, `backlog`, `maestro`, `tasks` (6) |
| #6 `createMissionImpl` | `missions`, `projects`, `backlog`, `hub`, `syncBoard` (5) |
| #7 `ensureMissionVersion` | `backlog` (1) |
| #8 intents de start | — (0) |
| #9 `rollbackPlannedMission` | `missions`, `projects`, `backlog`, `maestro`, `hub`, `codeIntelligence`, `syncBoard` (7) |
| #10 `ensurePlannedMissionBacklogItem` | `backlog`, `syncBoard` (2) |
| #11 `recoverMissionStartIntents` | `projects`, `missions`, `backlog`, `hub`, `syncBoard`, `projectModeOf` (6) |
| #12 `completeLinkedProjectPlanMission` | `projects`, `hub`, `projectModeOf` (3) |
| #13 `reconcileConcludedMission` | `missions`, `backlog`, `hub`, `syncBoard` (4) |
| #14 `transitionLinkedProjectPlanMission` | `projects` (1) |
| #15 `cleanupMissionFiles` | `projects`, `tasks` (2) |
| #17 `resolveMissionIntegrationTarget` | `backlog`, `hub`, `blackbox` (3) |
| #18 `scheduleIntegrationDrain` | `integrationDrainTimers`, `integrationDraining` (2 — **estado que passa a nascer no engine**) |
| #19 `createIntegrationSyncTask` | `tasks`, `maestro`, `skillsLib`, `uiSender` (4) |
| #20 `repairIntegrationSyncTickets` | `projects`, `missions`, `integrationQueue`, `tasks`, `hub`, `syncBoard` (6) |
| #21 `startMissionIntegration` | `missions`, `projects`, `backlog`, `integrationQueue`, `tasks`, `hub`, `syncBoard` (7) |
| #22 `drainIntegrationQueue` | `missions`, `projects`, `integrationQueue`, `tasks`, `hub`, `syncBoard`, `integrationDraining` (7) |
| #23 `emitIntegrationBlockForMaestro` | `missions`, `integrationQueue`, `hub`, `syncBoard` (4) |
| #24 intents de integração | `integrationQueue` (1) |
| #25 `recoverMissionIntegrationIntents` | `projects`, `missions`, `backlog`, `integrationQueue`, `hub`, `codeIntelligence` (6) |
| #26 `completeMissionMerge(+Inner)` | `missions`, `projects`, `backlog`, `hub`, `ptys`, `syncBoard`, `mainStalls`, `orchPaneId`, `codeIntelligence` (9) |
| #27 `handleMissionVerdict` | `missions`, `hub`, `uiSender` (3) |
| #28 `stopMissionExecution` | `tasks`, `ptys`, `hub`, `syncBoard`, `uiSender`, `phaseWatches`, `livePaneSpecs`, `helperCompletions`, `helperReported`, `helperSeen`, `unregisterPane`, `ensureProjectRuntimeWritable` (12) |
| #29b `tickMissionWatches` | `missionWatches`, `ensureProjectRuntimeWritable` (2) |

> **Nota mecânica (mesma do `phaseEngine`):** `uiSender` é **getter reatribuível**.
> As **5 ocorrências** dentro do material movido (linhas **5018, 5974, 7028, 7029**
> no engine e **7974** no `ipc/missions.ts`) precisam virar `ctx.uiSender`
> — é a única alteração não-verbatim obrigatória, exatamente como o
> `phaseEngine` fez (`phaseEngine.ts:506`, `:1151`, `:1590`…). Nunca destructurar
> `uiSender`.
> Idem para `hub`: capturar `const hub = ctx.hub` **uma vez**, no corpo do
> `createMissionEngine` (o hub é atribuído 1× antes do engine nascer).

### 2.b Símbolos do closure FORA do `MainContext` → `MissionEngineExtras`

Determinado por script (identificadores declarados no closure do `whenReady`,
usados dentro das faixas movidas, não declarados dentro delas e ausentes do
`MainContext`). **8 extras — todos funções puras de delegação, nenhum `let`
mutável, nenhum `Map`/`Set`.**

```ts
export interface MissionEngineExtras {
  /** @3323 — `${projectId}--${missionId}`; chave do maestroStore do orquestrador. */
  orchKey(projectId: string, missionId: string): string
  /** @3652 — arrow const. */
  securityWaiverOptions(projectId: string): { sensitiveWaiverAllowed: boolean }
  /** @4185 — plano ativo da missão. */
  currentPlanOf(projectId: string, missionId: string): Task | undefined
  /** @4490 */
  finalVerificationAccepted(checkpoint: PlanVerificationCheckpoint | undefined): boolean
  /** @5090 — type predicate; domínio VERSÃO, fica no index (§1.3). */
  versionIsolationIsValid(
    projectPath: string,
    version: Version
  ): version is Version & { branch: string; worktree: string }
  /** @7273 — domínio backlog. */
  emitBacklogChanged(projectId: string): void
  /** @7776 — vassoura genérica do .synkora. */
  sweepProjectFiles(projectId: string, opts?: { preserveInterruptedHelpers?: boolean }): number
  /** @9085 — derruba servidor de teste com cwd sob o prefixo (antes do merge). */
  closeTestServersUnder(pathPrefix: string): void
}
```

Onde cada um é consumido dentro das faixas movidas:

| extra | consumidores (blocos) |
|---|---|
| `orchKey` | #5 (5226 `maestro.update`), #9 (5361 `maestro.forget`) |
| `securityWaiverOptions` | #21 (6063) |
| `currentPlanOf` | #12, #19, #21, #22 |
| `finalVerificationAccepted` | #21, #22 |
| `versionIsolationIsValid` | #5 (5183), #17 (5858), #25 (6619), #26 (6825) |
| `emitBacklogChanged` | #7, #9, #10, #13 |
| `sweepProjectFiles` | #26 (`completeMissionMergeInner`) |
| `closeTestServersUnder` | #26 (`completeMissionMergeInner`) |

**Nenhum extra é late-bound.** Todos estão declarados antes do ponto proposto de
criação do engine (§6.1) — diferente do `codeReportGuard` do `phaseEngine`.

### 2.c Imports de topo de arquivo que o novo módulo passa a fazer

Determinado por varredura com evidência linha-a-linha (rótulos string de
`gitOff` e prosa PT-BR dos comentários foram descartados — ver §5.6).

```ts
import { app } from 'electron'                       // app.getPath('userData') @5206,5218,5834,6708
import { join, resolve } from 'path'
import {
  alignWorktreeFromSnapshot, createMissionWorktree, createVersionWorktree,
  currentBranch, ensureSynkoraGitExcludes, gitCommitReached, gitHead,
  gitLocalBranchExists, hasGitCommit, initGitRepo, isExpectedWorktree,
  isWorktreeClean, missionWorktreeDescriptor, removeWorktreeAndBranch,
  resolveMissionWorkspace
} from './worktree'
import { type Mission, type NewMission } from './missions'
import { type IntegrationQueueTicketView } from './integrationQueue'
import {
  loadProjectPlan, projectPlanReleaseGate,
  completeStoredProjectMission, deferStoredProjectMission,
  detachStoredProjectMission, reactivateStoredProjectMission,
  startProjectMission as bindProjectMission,     // MESMO alias do index
  type ProjectPlan
} from './projectPlan'
import { manualSecurityValidationPending } from './manualSecurityValidation'
import { gitOff } from './gitAsync'
import {
  existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync
} from 'fs'
import { type MissionWatch } from './phaseTypes'
import { type MainContext } from './mainContext'
// para tipar os extras:
import { type Task, type PlanVerificationCheckpoint } from './tasks'
import { type Version } from './backlog'
```

**Armadilha confirmada:** `missionMergePrecheck`, `mergeTaskWorktree`,
`alignWorktreeFromSnapshot` e `removeWorktreeAndBranch` aparecem também como
**rótulos string de `gitOff`** (linhas 6361, 6866, 6907, 6921, 6925). Só
`alignWorktreeFromSnapshot` (chamada direta @6687), `removeWorktreeAndBranch`
(@5357) e `missionWorktreeDescriptor` (@6707) são imports de verdade;
`missionMergePrecheck` e `mergeTaskWorktree` **NÃO** devem entrar no import (são
nomes resolvidos dentro do `gitWorker`).

### 2.d Fronteira MISSÃO ↔ MAESTRO

**A região 5012–7056 é limpíssima nesse eixo — apenas 3 cruzamentos, todos com
o `MaestroStore` (persistência), NUNCA com a sessão do Maestro:**

| linha | código | natureza |
|---|---|---|
| 5226 | `maestro.update(orchKey(mission.projectId, mission.id), { tuiSessionId: undefined })` | `ctx.maestro` (store) + extra `orchKey` |
| 5361 | `maestro.forget(orchKey(projectId, missionId))` | `ctx.maestro` + extra `orchKey` |
| 6904 | `ptys.kill(orchPaneId(projectId, missionId))` | `ctx.ptys` + `ctx.orchPaneId` |

**Zero** ocorrências de `ensureSession`, `preparePlanningRun`, `survey`,
`surveyViaCodex`, `maestroSessions`, `killMaestroSession`, `MaestroBackend`,
`maestroPaneId` no engine. `stopMissionExecution` [9801,9844] e
`tickMissionWatches` [9914,9934] também não têm nenhum.

**Toda a costura mission↔maestro está concentrada nos IPC handlers** (§4),
principalmente em `missions:paneSpec` e `missions:setOrchestratorSeat`:

| linha | símbolo maestro | handler |
|---|---|---|
| 7124, 7966, 8124 | `orchKey` @3323 | setOrchestratorSeat, remove, paneSpec |
| 7138 | `migrateCliSessionBetweenSeats` @8790 | setOrchestratorSeat |
| 8030 | `staggerPaneSpawn` @8020 | paneSpec |
| 8135 | `maestroResumeOverBudget` @7989 | paneSpec |
| 8137 | `skipMaestroResume` @7995 | paneSpec |
| 8143 | `preparePlanningRun` @3003 | paneSpec |
| 8160 | `armPane` @3917 | paneSpec |
| 8190 | `missionPersona` (import `./maestro`) | paneSpec |
| 8222 | `codexDeveloperInstructions` @333 (nível de módulo) | paneSpec |
| 8172/8173 | `releasePaneSkillLease` (ctx) / `releasePaneSkillPlan` @403 (`let` de módulo) | paneSpec |

> **Coordenação com o levantamento paralelo do MAESTRO:** `missions:paneSpec` é
> o handler mais disputado do arquivo. Ele é *mission-shaped* na entrada
> (`missions.get`, `ensureMissionWorktree`, `pendingOrchestrator`, guarda
> `'integrando'`) e *maestro-shaped* na saída (persona, resume, budget de
> contexto, armamento de pane). **Recomendação: fica em `ipc/missions.ts`** e
> consome o lado maestro por `extras` — assim o `maestroEngine` não precisa
> conhecer `Mission`. Se o levantamento do maestro reivindicar
> `staggerPaneSpawn`/`maestroResumeOverBudget`/`skipMaestroResume`, eles viram
> membros de um `MaestroApi` e o `MissionsIpcExtras` encolhe. **Decidir isso
> ANTES do commit dos IPCs.**

### 2.e Máquina de fases (`ctx.phase`)

**A região 5012–7056 tem ZERO chamadas à máquina de fases.** Grep por
`phaseWatches|preparePhasePane|advancePhase|retryOrBacklog|openGatePane|finalizeTask|openPhasePane|closePhasePane|terminateTaskPhasePane|liveGateWaits|recoverFinalizingTask|closeLiveGateWait|drainPendingRespawns|taskIntegrationMarker`
na faixa: **nenhum resultado.**

O único ponto de contato é **`stopMissionExecution` [9801,9844]**, e só com o
registry de watches — **já coberto pelo `MainContext`**, não pela `PhaseApi`:

```
9809   const watch = phaseWatches.get(taskId)   → ctx.phaseWatches.get(taskId)
9810   phaseWatches.delete(taskId)              → ctx.phaseWatches.delete(taskId)
9824   watch?.phase
```

`ctx.phaseWatches` é `Map<string, PhaseWatch> & { detach(taskId): boolean }` —
`get`/`delete` estão na superfície. **A `PhaseApi` NÃO precisa crescer.**

Dependência inversa a registrar: o **`PhaseEngineExtras` consome DUAS funções de
missão** — `missionWorkspacePath` (`phaseEngine.ts:156`) e `ensureMissionWorktree`
(`:157`), passadas no `createPhaseEngine` do index (linhas 9588/9589). Isso
**força a ordem de criação** (§6.1).

---

## 3. Chamadores externos → a `MissionApi`

Varredura em toda a árvore `src/main` (index, `ipc/`, `mcpApi/`, `phaseEngine`).

### 3.1 Superfície pública necessária

| função | chamadores fora das faixas movidas |
|---|---|
| `missionsWithIntegration` | `ipc/missions.ts` (7058) |
| `createMissionImpl` | `ipc/missions.ts` (7073) · `mcpApi/missions.ts` (546, 660) |
| `emitMissionsChanged` | `index` onExit de PTY (10509) · `mcpApi/missions.ts` (166, 222, 409) · `ipc/missions.ts` (7099, 7177, 7260, 7975, 8110) |
| `missionWorkspacePath` | `index` (4238) · `PhaseEngineExtras` (9588) · `ipc/tasks.ts` (247) · `mcpApi/board.ts` (1461, 1590) · `mcpApi/code.ts` (116) · `mcpApi/missions.ts` (569) |
| `ensureMissionWorktree` | `index` (9128) · `PhaseEngineExtras` (9589) · `mcpApi/board.ts` (1458, 1589) · `ipc/missions.ts` (8101) |
| `ensureMissionVersion` | `mcpApi/missions.ts` (509, 655) |
| `writeMissionStartIntent` | `mcpApi/missions.ts` (533) |
| `clearMissionStartIntent` | `mcpApi/missions.ts` (563, 572, 600, 620) |
| `rollbackPlannedMission` | `mcpApi/missions.ts` (571, 599) |
| `ensurePlannedMissionBacklogItem` | `mcpApi/missions.ts` (608) |
| `recoverMissionStartIntents` | **boot recovery** (11387) |
| `reconcileConcludedMission` | **boot recovery** (11532) |
| `transitionLinkedProjectPlanMission` | `ipc/missions.ts` (7210, 7922) · `mcpApi/missions.ts` (148) |
| `resolveMissionIntegrationTarget` | `mcpApi/missions.ts` (369) |
| `createIntegrationSyncTask` | `mcpApi/missions.ts` (extras) |
| `scheduleIntegrationDrain` | `ipc/missions.ts` (7228) · **boot** (11556) · `mcpApi/missions.ts` (168) |
| `repairIntegrationSyncTickets` | **boot** (11555) |
| `startMissionIntegration` | `index` (4594, dentro da verificação final do plano) · `ipc/missions.ts` (7269) · `mcpApi/missions.ts` (701, 715) |
| `recoverMissionIntegrationIntents` | **boot** (11388) |
| `handleMissionVerdict` | poller (9933 → passa a ser interno de `tickMissionWatches`) · `mcpApi/report.ts` (350) |
| `stopMissionExecution` | `ipc/missions.ts` (7230, 7936) · `mcpApi/missions.ts` (151) |
| `missionWatches` (Map) | `ctx` getter (3545) · `index` onExit (10498, 10500) · `mcpApi/report.ts` (326, 327, 333) |
| `integrationDrainTimers` (Map) | `ctx` getter (3548) — **sem outro consumidor** |
| `integrationDraining` (Set) | `ctx` getter (3551) — **sem outro consumidor** |

**Puramente internos (NÃO entram na `MissionApi`):** `integrationQueueView`,
`cleanupMissionFiles`, `completeMissionMerge`/`Inner`, `drainIntegrationQueue`,
`emitIntegrationBlockForMaestro`, `completeLinkedProjectPlanMission`,
`missionStartIntentPath`, `missionIntegrationIntentPath`,
`writeMissionIntegrationIntent`, `clearMissionIntegrationIntent`.

### 3.2 `MissionApi` proposta

```ts
export type MissionEngine = ReturnType<typeof createMissionEngine>

export function createMissionEngine(ctx: MainContext, extras: MissionEngineExtras) {
  // ...corpo verbatim...
  return {
    // ——— estado (nasce AQUI; ctx expõe por getter via alias no index) ———
    missionWatches,            // Map<string, MissionWatch>
    integrationDrainTimers,    // Map<string, NodeJS.Timeout>
    integrationDraining,       // Set<string>

    // ——— ciclo de vida de missão ———
    emitMissionsChanged,       // (projectId: string) => void
    missionsWithIntegration,   // (projectId) => Array<Mission & { integration?: … }>
    missionWorkspacePath,      // (projectPath: string, mission: Mission) => string | undefined
    ensureMissionWorktree,     // (missionId: string) => Mission | undefined
    createMissionImpl,         // (projectId, input: NewMission, actor: string, reservedId?: string) => Mission | null
    ensureMissionVersion,      // (projectId, input?) => { versionId?, name?, error? }
    stopMissionExecution,      // (projectId, missionId, reason: string) => void

    // ——— vínculo com o plano mestre (roadmap) ———
    writeMissionStartIntent,   // (projectPath, intent: MissionStartIntent) => void
    clearMissionStartIntent,   // (projectPath, missionId) => void
    rollbackPlannedMission,    // (projectId, missionId) => void
    ensurePlannedMissionBacklogItem, // (projectId, mission, item: ProjectPlan['roadmap'][number]) => string | undefined
    transitionLinkedProjectPlanMission, // (projectId, missionId, action: 'archive'|'reactivate'|'detach') => string | undefined
    reconcileConcludedMission, // (projectId, missionId, fallbackOutcome) => { ok: boolean; doneItems: number }

    // ——— fila de integração ———
    resolveMissionIntegrationTarget, // (project: {id,path}, mission) => MissionIntegrationTarget | undefined
    createIntegrationSyncTask, // (ticket, mission, target, targetHead) => boolean
    scheduleIntegrationDrain,  // (projectId) => void
    startMissionIntegration,   // (missionId, actor: string) => string
    handleMissionVerdict,      // (watch: MissionWatch, content: string) => void   [legado]

    // ——— recuperação (chamada pelo boot; ver §5.3) ———
    recoverMissionStartIntents,        // (projectId) => void
    recoverMissionIntegrationIntents,  // (projectId) => void
    repairIntegrationSyncTickets,      // (projectId) => void

    // ——— tick do poller de 3s ———
    tickMissionWatches         // () => void
  }
}
```

Os tipos `MissionIntegrationTarget`, `MissionStartIntent` e
`MissionMergeCompletion` devem ser `export interface` no módulo novo
(`mcpApi/missions.ts` já declara a assinatura de
`resolveMissionIntegrationTarget` com um shape estrutural equivalente — conferir
na hora do corte se vale importar do engine para evitar duplicação).

---

## 4. Os 8 handlers IPC — `src/main/ipc/missions.ts`

Imports do módulo novo (verificados com evidência):

```ts
import { ipcMain } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { ensureSynkoraGitExcludes, removeWorktreeAndBranch } from '../worktree'
import { type Mission, type NewMission } from '../missions'
import { assessMissionRisk } from '../orchestratorFlow'
import { missionPersona } from '../maestro'
import { ensureProjectSecurityBaseline } from '../projectSecurityBaseline'
import { requiresManualSecurityValidation } from '../securityPolicy'
import type { MainContext } from '../mainContext'
import type { MissionEngine } from '../missionEngine'
```

| handler | faixa | `ctx.*` | `MissionApi` | extras adicionais |
|---|---|---|---|---|
| `missions:list` | [7058,7058] | — | `missionsWithIntegration` | — |
| `missions:create` | [7060,7074] | `hub`, `projectModeOf`, `projectPlanOf` | `createMissionImpl` | `bindUiSender` |
| `missions:confirmOrchestrator` | [7076,7102] | `missions`, `seats`, `blackbox` | `emitMissionsChanged` | `bindUiSender` |
| `missions:setOrchestratorSeat` | [7104,7185] | `missions`, `seats`, `projects`, `ptys`, `maestro`, `hub`, `blackbox`, `orchPaneId`, `unregisterPane` | `emitMissionsChanged` | `bindUiSender`, **`orchKey`**, **`migrateCliSessionBetweenSeats`** |
| `missions:update` | [7187,7265] | `missions`, `integrationQueue`, `ptys`, `hub`, `syncBoard`, `orchPaneId`, `unregisterPane` | `emitMissionsChanged`, `scheduleIntegrationDrain`, `stopMissionExecution`, `transitionLinkedProjectPlanMission` | `bindUiSender` |
| `missions:integrate` | [7267,7270] | — | `startMissionIntegration` | `bindUiSender` |
| `missions:remove` | [7897,7978] | `missions`, `projects`, `tasks`, `backlog`, `integrationQueue`, `ptys`, `hub`, `maestro`, `codeIntelligence`, `syncBoard`, `orchPaneId`, `uiSender` | `emitMissionsChanged`, `stopMissionExecution`, `transitionLinkedProjectPlanMission` | `bindUiSender`, **`orchKey`**, **`emitBacklogChanged`** |
| `missions:paneSpec` | [8028,8238] | `missions`, `projects`, `seats`, `ptys`, `maestro`, `hub`, `blackbox`, `orchPaneId`, `unregisterPane`, `projectModeOf`, `releasePaneSkillLease` | `emitMissionsChanged`, `ensureMissionWorktree`, `missionWorkspacePath` | `bindUiSender`, **`orchKey`**, **`staggerPaneSpawn`**, **`maestroResumeOverBudget`**, **`skipMaestroResume`**, **`preparePlanningRun`**, **`armPane`**, **`codexDeveloperInstructions`**, **`releasePaneSkillPlan`** |

```ts
export interface MissionsIpcExtras {
  bindUiSender(sender: Electron.WebContents): void
  orchKey(projectId: string, missionId: string): string
  emitBacklogChanged(projectId: string): void
  migrateCliSessionBetweenSeats(
    cli: SeatCli, fromSeatId: string, toSeatId: string, cwd: string, sessionId: string
  ): boolean
  staggerPaneSpawn(): Promise<void>
  maestroResumeOverBudget(key: string): number | undefined
  skipMaestroResume(
    key: string, overBudget: number,
    ids: { projectId: string; missionId?: string; paneId: string }
  ): void
  preparePlanningRun(input: {
    paneId: string; projectId: string; missionId?: string; cwd: string
  }): Promise<{ ok: true; phaseRun: string; skillBlock: string } | { ok: false; message: string }>
  armPane(
    identity: Omit<PaneIdentity, 'paneId'> & { paneId?: string },
    cli: SeatCli,
    opts?: { strictMcp?: boolean; configDir?: string; sensitive?: boolean }
  ): { paneId: string; cliArgs: string[] }
  codexDeveloperInstructions(value: string): string
  releasePaneSkillPlan(paneId: string): void
}
```

Notas:

- `releasePaneSkillPlan` é um **`let` de nível de módulo** (`index.ts:403`,
  atribuído em `:3085`). Passar como **arrow** (`releasePaneSkillPlan: (paneId) =>
  releasePaneSkillPlan(paneId)`) — é exatamente o que `createPhaseEngine` e
  `buildHelpersApi` já fazem.
- `codexDeveloperInstructions` (`:333`) e `bindUiSender` (`:501`) são funções de
  **nível de módulo**, não do closure — mesma solução (extras), igual aos outros
  `ipc/*`.
- **`missions:paneSpec` também `await staggerPaneSpawn()` e `await
  preparePlanningRun(...)`** — o handler é `async`; preservar.
- `completeMissionMerge` aparece na faixa de `paneSpec` **apenas dentro de um
  comentário** (linha 8040). Não é dependência.

---

## 5. Riscos (à moda `phaseEngine`)

### 5.1 Hoisting / TDZ

**Dentro da região movida, quatro dependências vivem HOJE só por *function
hoisting* — o consumidor está ANTES da declaração:**

| consumidor | linha | símbolo | declarado em |
|---|---|---|---|
| `scheduleIntegrationDrain` | 5894 | `drainIntegrationQueue` | 6199 |
| `ensureMissionVersion` / `rollbackPlannedMission` / `ensurePlannedMissionBacklogItem` / `reconcileConcludedMission` | 5286…5713 | `emitBacklogChanged` | 7273 |
| `completeMissionMergeInner` | ~6900 | `sweepProjectFiles` | 7776 |
| `completeMissionMergeInner` | ~6900 | `closeTestServersUnder` | 9085 |

Depois do corte:
- `drainIntegrationQueue` continua sendo `function` **dentro do engine** →
  hoisting preservado, zero TDZ.
- `emitBacklogChanged`, `sweepProjectFiles`, `closeTestServersUnder` viram
  **extras entregues por referência na construção** → o problema **desaparece**
  (é a mesma cura que o `MAX_PARALLEL_RUNS` recebeu no `phaseEngine`).

**Risco de TDZ NOVO, no index:** os aliases (`const { … } = missionEngine`)
passam a ser declarados no ponto de criação do engine (§6.1). Todos os call
sites que **avaliam** o identificador estão depois:
`mcpApi` @10904, boot recovery @11375, `register*Ipc` @11706. Os demais
(4238, 4594, 9128, 10498/10500/10509) estão **dentro de corpos de função** —
resolvem em runtime. **Confirmado seguro.** Os getters de `ctx`
(3545/3548/3551) continuam textualmente iguais e passam a devolver os aliases
— exatamente o que já acontece com `phaseWatches` (getter @3569 → alias @9606).

### 5.2 Contratos síncronos

- `advancePhase` **não é tocado** (a região não fala com a máquina de fases).
- `handleMissionVerdict`, `startMissionIntegration`, `scheduleIntegrationDrain`,
  `stopMissionExecution`, `repairIntegrationSyncTickets`,
  `recoverMissionStartIntents`, `recoverMissionIntegrationIntents`,
  `reconcileConcludedMission` são **síncronos e devem continuar**. Em especial
  `startMissionIntegration` devolve `string` (a mensagem que sobe para a tool
  MCP e para o IPC) — transformar em `Promise` quebraria `integrate_mission` e
  `queue_missions` em silêncio.
- **Assíncronos:** `drainIntegrationQueue`, `completeMissionMerge`,
  `completeMissionMergeInner`. `completeMissionMerge` é o **wrapper fino da Fase
  0** (`mainStalls.wrap('completeMissionMerge', …)`, linha 6780) — manter o par
  wrapper→Inner intacto e o rótulo `'completeMissionMerge'` **idêntico**, senão
  o ranking de `stall` perde a série histórica.

### 5.3 Recuperação de boot (**EXCLUÍDA do engine**)

Bloco `for (const p of projects.list())` em **[11375, 11560]**, roda **antes do
`createWindow`**. Ele toca, na ordem:

| linha | chamada | fonte após o corte |
|---|---|---|
| 11387 | `recoverMissionStartIntents(p.id)` | `MissionApi` (alias) |
| 11388 | `recoverMissionIntegrationIntents(p.id)` | `MissionApi` (alias) |
| 11389 | `recoverVersionReleaseIntents(p.id)` | **fica no index** (domínio versão) |
| 11530 | `missions.update(m.id, { status: 'ativa' })` para `m.status === 'integrando'` | `ctx.missions` — **solta a missão presa em voo** |
| 11532 | `reconcileConcludedMission(p.id, m.id, …)` | `MissionApi` (alias) |
| 11545 | `completeStoredProjectPlanRelease(...)` | import `projectPlan` (fica) |
| 11554 | `sweepProjectFiles(p.id, { preserveInterruptedHelpers: true })` | fica no index |
| 11555 | `repairIntegrationSyncTickets(p.id)` | `MissionApi` (alias) |
| 11556 | `if (integrationQueue.head(p.id)?.state === 'queued') scheduleIntegrationDrain(p.id)` | `ctx.integrationQueue` + `MissionApi` |

**Como o corte mantém isso funcionando:** os aliases destructurados do
`missionEngine` (§6.1) são declarados em ~9578, muito antes de 11375 — o bloco
continua **textualmente idêntico**, sem tocar em nada. **Nenhuma linha do bloco
de boot deve ser editada.**

O `'integrando' → 'ativa'` da linha 11530 é a rota de saída de crash no meio do
merge (§5.5). Manter.

### 5.4 Timers — quem é dono de `integrationDrainTimers`

Único ponto de criação e único de limpeza, **ambos dentro de
`scheduleIntegrationDrain` [5888, 5897]**:

```
5889  if (integrationDrainTimers.has(projectId) || integrationDraining.has(projectId)) return
5893    integrationDrainTimers.delete(projectId)      // dentro do callback
5894    void drainIntegrationQueue(projectId)
5896  integrationDrainTimers.set(projectId, timer)
```

`integrationDraining` é adicionado em 6201 e removido no `finally` de
`drainIntegrationQueue` (6450). **Nenhum código fora do domínio escreve nesses
dois.** O único consumidor externo é o getter de `ctx` (3548/3551) — e o
`MainContext` não tem nenhum leitor deles hoje em `ipc/` ou `mcpApi/`.

> **Nota de higiene (não é bug):** não existe `clearTimeout` para
> `integrationDrainTimers` em nenhum caminho de shutdown. O timer é de 1 tick e
> o `will-quit` não o cancela. Ao mover, **não "consertar"** — é comportamento
> vigente; se virar problema, é card próprio.

### 5.5 Estado escrito de FORA do domínio

| escritor | onde | o que toca | tratamento no corte |
|---|---|---|---|
| **`onExit` do PTY** | `index` 10498–10510 | lê `missionWatches.get(identity.missionId)`, `missionWatches.delete(...)`, `missions.update(..., {status:'ativa'})`, `hub.publish`, `emitMissionsChanged` | Fica no index; usa o **alias** `missionWatches` e `emitMissionsChanged`. **Textualmente intacto.** |
| **`mcpApi/report.ts`** | 326–350 | `missionWatches.has/get/delete` (via `ctx.missionWatches`, já destructurado em `:91`) + `handleMissionVerdict` (extra em `:50/:102`) | O extra `handleMissionVerdict` passa a vir do `MissionApi`; `ctx.missionWatches` **não muda**. |
| **Boot recovery** | 11530 | `missions.update(m.id, {status:'ativa'})` | Fica; §5.3. |
| **`mcpApi/missions.ts`** | `integrate_mission` (~369, 701), `queue_missions` (~715), `archive_mission` (~148/151) | consome 15 extras de missão (ver §3.1) | Todos passam a vir do `MissionApi`; o objeto `MissionsApiExtras` de `mcpApi/missions.ts` **não muda de shape**, só de origem. |

### 5.6 `missionWatches` está MORTO (achado)

`grep` no `src/main` inteiro: **não existe nenhum `missionWatches.set(...)`**.
As únicas operações são `get`/`has`/`delete` (index 9914/9932/10498/10500 e
`mcpApi/report.ts` 326/327/333). O gate de integração morreu na F6.1
("O GATE DE INTEGRAÇÃO MORREU" — `CLAUDE.md`) e `handleMissionVerdict` sobrou
apenas como caminho de marcador `.verdict` órfão de sessão antiga (o próprio
comentário em 7053 diz "review legado").

**Consequência para o corte:** mover `missionWatches` + `tickMissionWatches` +
`handleMissionVerdict` **como estão** (a rede não se remove inteira —
`feedback-nao-remover-rede-inteira`). Registrar como candidato a card de
higiene separado, **nunca dentro desta cirurgia**.

### 5.7 `pendingIntegrationApproval` — a porteira do dono

Fluxo inteiramente contido em `startMissionIntegration` [6034, 6197]:

```
6093  if (!missions.get(missionId)?.pendingIntegrationApproval) {
6094    missions.update(missionId, { pendingIntegrationApproval: true })   // agente pediu → espera o clique
6110  if (missions.get(missionId)?.pendingIntegrationApproval) {
6111    missions.update(missionId, { pendingIntegrationApproval: false })  // actor 'user' → enfileira
```

O discriminante é o parâmetro `actor: string` (`'user'` vem do
`missions:integrate` @7269; qualquer outro valor vem de agente). **Não mexer no
contrato do `actor`** — "ausência NUNCA é consentimento" (F6.9). O campo é
persistido em `missions.ts:49` e listado no allowlist de patch em `:189`.

### 5.8 Guardas de `mission.status === 'integrando'`

| linha | onde | fica onde |
|---|---|---|
| 5196 | `ensureMissionWorktree` (colisão de worktree de versão) | **engine** |
| 6041 | `startMissionIntegration` (recusa reentrada) | **engine** |
| 6408 | `drainIntegrationQueue` — **quem SETA** `status:'integrando'` logo antes do `completeMissionMerge` | **engine** |
| 6614 | `recoverMissionIntegrationIntents` | **engine** |
| 7591 | `releaseVersionImpl` (bloqueia release com missão em voo) | index |
| 8049 | **`missions:paneSpec`** — `orchestrator-respawn-refused-integration-in-flight` | **`ipc/missions.ts`** |
| 9662 | poda de `pendingUserQuestions` | index |
| 11530 | boot recovery (solta o preso) | index |
| — | `progressSnapshot.ts:414` | módulo próprio |

A cerca anti-ressurreição (8049–8059) **é o par do kill do orquestrador feito
por `completeMissionMergeInner` (linha 6904, `ptys.kill(orchPaneId(...))`)** —
os dois lados ficam em módulos DIFERENTES depois do corte (engine × ipc). O
comentário 8039–8048 explica a corrida da M02d e **precisa viajar inteiro** com
o handler; conferir depois do corte que ele continua citando
`completeMissionMerge` (é a única pista escrita de que existe um par).

### 5.9 Código de missão e de maestro na MESMA faixa

Só um caso, e é de comentário, no poller de 3s:

```
9849    phaseEngine.tickPhaseWatches()
9850    // Marcadores de INTEGRAÇÃO de missão (fallback do report MCP do gate).   ← MISSÃO
9851    // Helper tambem nasce por `panes:open`, que e um push sem ACK. ...        ← HELPER
9855    for (const pending of helperOpenWatchdog.due(...)) { … }                   ← HELPER
9914    for (const [missionId, watch] of [...missionWatches]) { … }                ← MISSÃO
```

A linha **9850 é um comentário órfão**: descreve o laço de 9914, mas ficou
grudada acima do watchdog de helpers. **Ela deve viajar com o bloco #29b** (por
isso o inventário a lista como #29a). Não há entrelaçamento de *código*
mission×maestro em nenhuma outra faixa.

Fora isso, o único ponto que exige coordenação com o levantamento paralelo do
maestro é o conjunto de extras de `missions:paneSpec`/`setOrchestratorSeat`
(§2.d). **Não há sobreposição de faixas de linha entre os dois domínios** —
`missionEngine` fica em 5012–7056 + 9801–9844 + 9850 + 9914–9934;
`ipc/missions.ts` em 7058–7270 + 7897–7978 + 8028–8238. As funções de maestro
que ambos os cortes citam (`preparePlanningRun` @3003, `armPane` @3917,
`staggerPaneSpawn` @8020, `maestroResumeOverBudget` @7989,
`skipMaestroResume` @7995, `migrateCliSessionBetweenSeats` @8790) estão **fora**
dessas faixas — nenhum dos dois cortes as remove; ambos só as consomem.

### 5.10 Outros

- **`uiSender` destructurado seria bug.** Ver nota em §2.a. 5 ocorrências.
- **`mainStalls.wrap('completeMissionMerge', …)`** — rótulo de atribuição de
  stall; não renomear.
- **`ensureProjectRuntimeWritable`** é chamado com `try/catch` em
  `stopMissionExecution` (9813) e em `tickMissionWatches` (9923) — é a guarda de
  `.synkora` versionado. Preservar o `catch { continue }` do tick: sem ele, um
  projeto com runtime não gravável trava o poller inteiro.
- **`ipc/missions.ts` deve ser registrado no MESMO bloco** de
  `register*Ipc` (~11706), dentro do `whenReady` e antes do `createWindow` — a
  "cerca viva da Fase 0" (`instrumentIpcMain` só cobre handlers registrados
  depois dele).

---

## 6. Plano de corte recomendado

### 6.1 Ponto de criação e aliases (decisão central)

**Sim — o estado (`missionWatches`, `integrationDrainTimers`,
`integrationDraining`) deve nascer NO ENGINE, com aliases no index, exatamente
como o `phaseEngine` fez.** Os getters de `ctx` (3545/3548/3551) ficam
textualmente intactos e passam a devolver os aliases.

**Ordem obrigatória** (o `PhaseEngineExtras` consome `missionWorkspacePath` e
`ensureMissionWorktree`):

```ts
// ~9578, IMEDIATAMENTE ANTES do createPhaseEngine
const missionEngine = createMissionEngine(ctx, {
  orchKey, securityWaiverOptions, currentPlanOf, finalVerificationAccepted,
  versionIsolationIsValid, emitBacklogChanged, sweepProjectFiles,
  closeTestServersUnder
})
const {
  missionWatches, integrationDrainTimers, integrationDraining,
  emitMissionsChanged, missionsWithIntegration, missionWorkspacePath,
  ensureMissionWorktree, createMissionImpl, ensureMissionVersion,
  stopMissionExecution, writeMissionStartIntent, clearMissionStartIntent,
  rollbackPlannedMission, ensurePlannedMissionBacklogItem,
  transitionLinkedProjectPlanMission, reconcileConcludedMission,
  resolveMissionIntegrationTarget, createIntegrationSyncTask,
  scheduleIntegrationDrain, startMissionIntegration, handleMissionVerdict,
  recoverMissionStartIntents, recoverMissionIntegrationIntents,
  repairIntegrationSyncTickets
} = missionEngine

const phaseEngine = createPhaseEngine(ctx, { …, missionWorkspacePath, ensureMissionWorktree, … })
```

Todos os 8 extras estão declarados antes de 9578 (3323, 3652, 4185, 4490, 5090,
7273, 7776, 9085) → **nenhum precisa ser late-bound.**

`tickMissionWatches` fica fora do destructure e é chamado como
`missionEngine.tickMissionWatches()` no poller (paralelo a
`phaseEngine.tickPhaseWatches()` na linha 9849) — o poller passa a ser:

```ts
setInterval(() => {
  phaseEngine.tickPhaseWatches()
  // …watchdog de helper (9851–9912, intacto)…
  missionEngine.tickMissionWatches()
}, 3000)
```

> **Atenção à ORDEM dentro do tick:** hoje o laço de missão roda **DEPOIS** do
> watchdog de helpers. Preservar essa ordem.

### 6.2 Sequência de commits — **4 commits**

**Commit A — `missionEngine.ts` nasce (mecânica)**
Cria `src/main/missionEngine.ts` com o cabeçalho de contrato (à moda do
`phaseEngine.ts`: o que o módulo não pode quebrar), `MissionEngineExtras`,
`createMissionEngine`, imports (§2.c). Move VERBATIM os blocos **#1–#27**
(faixa 5012–7056 inteira, incluindo o cabeçalho de comentário
`// ————— MISSÕES (F3.8) —————` de 5012–5015) **exceto** `versionIsolationIsUnique`/`IsValid`
[5066, 5100], que permanecem no index nessa mesma posição relativa.
No index: insere a criação + destructure em ~9578 (§6.1).
Ajusta as 4 ocorrências de `uiSender` → `ctx.uiSender` (5018, 5974, 7028, 7029).
Os getters de `ctx` (3545/3548/3551) **não mudam**.
*Verde exigido:* `npm run typecheck` + `test:orchestrator-flow` (35) +
`test:integration-queue` (14) + `test:mission-verification` (25).

**Commit B — `stopMissionExecution` + `tickMissionWatches`**
Move #28 [9801, 9844] e #29a/#29b (9850 + 9914–9934) para o engine,
transformando 29 no método `tickMissionWatches()`. Substitui no poller pela
chamada `missionEngine.tickMissionWatches()`.
Separado de A **de propósito**: são os dois únicos blocos fora da faixa
contígua e os únicos que tocam `ctx.phaseWatches` e o poller — se algo quebrar
no tick, o `git bisect` aponta um commit de 66 linhas, não um de 2000.

**Commit C — `src/main/ipc/missions.ts`**
Move os 8 handlers, define `MissionsIpcExtras`, registra
`registerMissionsIpc(ctx, extras)` no bloco de `register*Ipc` (~11706).
**Pré-requisito:** decisão sobre a fronteira de `paneSpec` com o levantamento
paralelo do maestro (§2.d).

**Commit D — limpeza dos extras redundantes**
Com `MissionApi` disponível, os `MissionsApiExtras` de `mcpApi/missions.ts`
(15 membros de missão), `mcpApi/report.ts` (`handleMissionVerdict`),
`mcpApi/board.ts` (`ensureMissionWorktree`, `missionWorkspacePath`),
`mcpApi/code.ts` e `ipc/tasks.ts` (`missionWorkspacePath`) e o
`PhaseEngineExtras` (`missionWorkspacePath`, `ensureMissionWorktree`) podem
passar a receber a referência **direto do engine** em vez de aliases do index.
**Commit opcional e adiável** — puramente cosmético; os aliases já resolvem.
Se ele for feito, `PhaseEngineExtras` perde 2 membros e ganha uma dependência
de ordem explícita (mission antes de phase), o que já é verdade.

### 6.3 Tamanho resultante

| arquivo | antes | depois |
|---|---|---|
| `src/main/index.ts` | 11768 | ~9250 (−2545, +~30 de criação/aliases/registro) |
| `src/main/missionEngine.ts` | — | ~2100 |
| `src/main/ipc/missions.ts` | — | ~560 |

> `missionEngine.ts` nasce com ~2100 linhas — acima da régua do dono
> (`feedback-codigo-limpo-sem-arquivos-gigantes`). O `phaseEngine.ts` (4114)
> abriu o precedente para a fase 1; **registrar como débito**: uma fase 2
> pode partir `missionEngine` em `missionLifecycle` (blocos #1–#15, ~700
> linhas) × `integrationQueueEngine` (#16–#27, ~1250 linhas) — a costura entre
> os dois é fina (`missionWorkspacePath`, `ensureMissionWorktree`,
> `reconcileConcludedMission`, `cleanupMissionFiles`,
> `completeLinkedProjectPlanMission`).
