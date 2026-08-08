# MAPA DA VARREDURA — paneLifecycle (Fase 1, commit 7)

Varredura READ-ONLY do domínio **ciclo de vida de pane** dentro de
`src/main/index.ts` (branch `nivel5-fase1`, **8.225 linhas**, HEAD `0cd958b`),
feita nos moldes das varreduras de `missionEngine`/`maestroEngine`
(docs/FASE1_MAPA_MISSIONENGINE.md · docs/FASE1_MAPA_MAESTROENGINE.md) para
guiar o ÚLTIMO grande corte da Fase 1.

**TODA linha citada aqui foi re-conferida por grep imediatamente antes da
escrita deste documento.** Toda âncora regex foi validada com `grep -cE` = 1.

---

## 0. Sumário executivo

| item | valor |
| --- | --- |
| blocos a mover | **16** (14 contíguos + 2 fatias do poller de 3s) |
| linhas movidas | **1.563** |
| handlers IPC movidos | **10** (`pty:*` ×6, `panes:*` ×4) |
| extras do engine | **4** |
| extras dos módulos IPC | **10** (pty) + **4** (panes) |
| substituições não-verbatim | **7 símbolos**, 47 ocorrências |
| imports órfãos previstos no index | **~30** |
| arquitetura recomendada | `paneLifecycle.ts` (engine) + `ipc/pty.ts` + `ipc/panes.ts` |
| ordem de construção NOVA | **paneLifecycle → mission → maestro → phase** |
| commits recomendados | **3 fatias** (7a engine · 7b ipc/pty · 7c ipc/panes + higiene) |
| index estimado no fim | **~6.730 linhas** (−18% sobre 8.225; −65% sobre as 19.448 pré-obra) |

O achado estrutural da varredura: **o domínio de pane é FUNDAÇÃO, não folha.**
`phaseEngine`, `missionEngine`, `mcpApi/helpers`, `mcpApi/report`,
`ipc/maestro`, `ipc/missions` e `ipc/projects` consomem 8 símbolos deste
domínio; o domínio consome de volta apenas 4 (`recordGateDeath`,
`ensureMissionWorktree`, `emitMissionsChanged`, `armGateMcpWatchdog`) — e os
quatro só aparecem DENTRO de handlers IPC. Separando engine × IPC, o
paneLifecycle nasce **primeiro**, com ZERO arrow late-bound, e todo o
acoplamento cruzado é resolvido no bloco de registro (fim do whenReady), onde
todo símbolo do closure já existe.

---

## 1. Inventário dos blocos a mover

Legenda: `→E` = vai para `paneLifecycle.ts` (engine) · `→P` = vai para
`ipc/pty.ts` · `→N` = vai para `ipc/panes.ts`.

| id | conteúdo | destino | faixa | L |
| --- | --- | --- | --- | --- |
| **P** | `interface PaneRequest` | →E (exportado) | 723–736 | 14 |
| **A** | `paneStartupDescriptor` + `mcpPaneArgs` + `armPane` | →E | 3690–3949 | 260 |
| **B** | `paneSpecStaggerUntil` + `staggerPaneSpawn` | →E | 5552–5564 | 13 |
| **C1** | `testServerPanes` + `harnessPortsInUse` + `closeTestServersUnder` | →E | 5717–5770 | 54 |
| **C2** | handler `panes:testServerSpec` | →N | 5771–5891 | 121 |
| **D** | handler `panes:portsInUse` | →N | 5893–5898 | 6 |
| **E** | handler `panes:freeSpec` | →N | 5900–5955 | 56 |
| **F** | `livePaneSpecs` + `closingPaneIds` + `paneEverSpawned` | →E | 6041–6061 | 21 |
| **G** | handler `panes:live` | →N | 6191–6196 | 6 |
| **H** | `rollbackFailedPaneSpawn` + `discardUnstartedPane` + `terminatePaneNow` + `terminateTaskHelpers` | →E | 6198–6309 | 112 |
| **I1** | `const HELPER_OPEN_GRACE_MS = 30_000` | →E | 6312 | 1 |
| **I2** | corpo do helper-open watchdog (fatia do poller de 3s) | →E | 6315–6376 | 62 |
| **J** | handlers `pty:startup-request` + `pty:first-frame` | →P | 6387–6395 | 9 |
| **K** | `pendingPtyPreparations` | →E | 6397–6399 | 3 |
| **L** | handler `pty:create` (**o gigante**) | →P | 6401–7193 | 793 |
| **M** | handlers `pty:write` + `pty:resize` + `pty:kill` | →P | 7194–7225 | 32 |
| | | | **total** | **1.563** |

**Excluídos por desenho** (confirmado): `crash:renderer` (2341) e
`perf:renderer-stall` (2375) — registrados em escopo de MÓDULO, antes do
whenReady; movê-los mudaria o momento de registro sem ganho.

### 1.1 Âncoras regex (todas validadas `grep -cE ... = 1`)

> `^  ipcMain\.handle\($` e similares NÃO são únicos — por isso C2 ancora na
> linha do NOME DO CANAL, com offset negativo.

| id | âncora INICIAL (regex) | linha | off | âncora FINAL (regex) | linha | off | fim |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P | `^interface PaneRequest \{$` | 723 | 0 | `^  logFile\?: string$` | 735 | +1 | 736 |
| A | `^  /\*\* Classificação allowlisted da abertura do pane\. Não inclui cwd, modelo,$` | 3690 | 0 | `^      return \{ paneId, cliArgs: args \}$` | 3942 | +7 | 3949 |
| B | `^  // ESCALONADOR DE SPAWN \(CHECK 1 adendo, 2026-08-07\)` | 5552 | 0 | `^    paneSpecStaggerUntil = Math\.max\(now, paneSpecStaggerUntil\) \+ MIN_GAP_MS$` | 5562 | +2 | 5564 |
| C1 | `^  // SERVIDOR DE TESTE DO DONO \(pedido do usuário, 2026-08-06` | 5717 | 0 | `^        reason: 'servidor de teste fechado antes do merge/release do worktree'$` | 5767 | +3 | 5770 |
| C2 | `^    'panes:testServerSpec',$` | 5772 | **−1** | `^        versionId: target\.versionId$` | 5888 | +3 | 5891 |
| D | `^  // Mapa de portas para o MODAL do ▶ testar \(decisão do dono, 2026-08-07\):$` | 5893 | 0 | `^    return formatPortMap\(harnessPortsInUse\(projectId\)\)$` | 5897 | +1 | 5898 |
| E | `^  // Spec do PANE TUI do Maestro: um terminal REAL do CLI do seat escolhido,$` | 5900 | 0 | `^      appendSystemPrompt: seat\.cli === 'claude' \? FREE_AGENT_PERSONA : undefined$` | 5953 | +2 | 5955 |
| F | `^  // TODAS as fases rodam em PANES TUI REAIS \(decisão do usuário\)` | 6041 | 0 | `^  const paneEverSpawned = new Set<string>\(\)$` | 6061 | 0 | 6061 |
| G | `^  ipcMain\.handle\('panes:live', \(\) =>$` | 6191 | 0 | (mesma âncora) | 6191 | +5 | 6196 |
| H | `^  /\*\* Reverte um armamento que nunca chegou a produzir um PTY\. Arquivos,$` | 6198 | 0 | `^      terminatePaneNow\(projectId, helper\.paneId\)$` | 6307 | +2 | 6309 |
| I1 | `^  const HELPER_OPEN_GRACE_MS = 30_000$` | 6312 | 0 | (mesma âncora) | 6312 | 0 | 6312 |
| I2 | `^    // Helper tambem nasce por` | 6315 | 0 | `^          \? 'o pedido de abertura se perdeu duas vezes'$` | 6373 | +3 | 6376 |
| J | `^  ipcMain\.on\('pty:startup-request', \(_e, paneId: string\) => \{$` | 6387 | 0 | `^    paneStartupMetrics\?\.mark\(paneId, 'terminal_first_frame'\)$` | 6394 | +1 | 6395 |
| K | `^  // Um modal pode ser fechado enquanto o seed assíncrono do seat ainda está$` | 6397 | 0 | `^  const pendingPtyPreparations = new Map<string, symbol>\(\)$` | 6399 | 0 | 6399 |
| L | `^  ipcMain\.handle\('pty:create', async \(e, req: PaneRequest\) => \{$` | 6401 | 0 | `^      sessionStats\.replay\(req\.id\)$` | 7190 | +3 | 7193 |
| M | `^  ipcMain\.on\('pty:write', \(_e, id: string, data: string\) => ptys\.write\(id, data\)\)$` | 7194 | 0 | `^    ptys\.kill\(id\)$` | 7223 | +2 | 7225 |

**Fechamentos** (lição do `cut-ipc.mjs`): C2 e G terminam em `  )` SOZINHO
(arrow com corpo de expressão / `ipcMain.handle` multilinha), não em `  })`.
D, E, J, L, M terminam em `  })`. A, B, C1, H terminam em `  }`.

**Anti-sobreposição**: as 16 faixas são disjuntas e crescentes. O script deve
abortar se qualquer par se cruzar (mesma guarda dos cortes 6a–6f).

---

## 2. Dependências por bloco

### 2.1 Membros de `ctx` usados (por bloco)

| bloco | membros de MainContext |
| --- | --- |
| A | `projects` `maestro` `settings` `blackbox` `hub` **`mcpPort`**(8×) `paneTokens` `paneMcpFiles` `externalPlaywrightForPane` `bypassOn` `unregisterPane` `cleanPaneMcpFile` |
| B | — (nenhum) |
| C1 | `projects` `tasks` `ptys` `blackbox` **`uiSender`**(3×) `testServerPanes`(próprio) |
| C2 | `projects` `backlog` `tasks` |
| D | — |
| E | `projects` `seats` `hub` `projectModeOf` `projectPlanOf` |
| F | (declara `livePaneSpecs`/`closingPaneIds`/`paneEverSpawned`) |
| G | `hub` `livePaneSpecs` `closingPaneIds` |
| H | `tasks` `ptys` `blackbox` `helperCompletions` `hub` **`uiSender`**(7×) `paneTokens` `paneSessions` `livePaneSpecs` `closingPaneIds` **`phaseWatches`**(2×) `pendingPtyPreparations` `syncBoard` `unregisterPane` `cleanPaneMcpFile` |
| I2 | `ptys` `blackbox` `hub` **`uiSender`**(3×) `livePaneSpecs` `paneEverSpawned` |
| J | `ptys` **`paneStartupMetrics`**(2×) |
| K | (declara `pendingPtyPreparations`) |
| L | `projects` `seats` `tasks` `missions` `maestro` `ptys` `blackbox` `sessionStats` `helperCompletions` `hub`(22×) **`uiSender`**(3×) **`mcpPort`** **`paneStartupMetrics`**(8×) `paneTokens` `paneMcpFiles` `paneSessions` `helperReported` `helperSeen` **`expiredSeats`**(2×) **`missionWatches`**(2×) `testServerPanes` `livePaneSpecs` `closingPaneIds` `paneEverSpawned` **`phaseWatches`**(4×) **`liveGateWaits`**(2×) `pendingPtyPreparations` **`mcpPaneFirstContact`**(2×) `syncBoard` `ensureProjectRuntimeWritable` `externalPlaywrightForPane` `unregisterPane` `cleanPaneMcpFile` |
| M | `ptys` `paneSessions` `livePaneSpecs` `closingPaneIds` `paneEverSpawned` `pendingPtyPreparations` |

**Em negrito**: os que EXIGEM leitura por `ctx.` (getter) — ver §5.4.

### 2.2 Símbolos de closure que NÃO estão no MainContext → candidatos a extras

| símbolo | onde nasce | forma | usado por | destino |
| --- | --- | --- | --- | --- |
| `ensureBypassAccepted(configDir, trustCwd?)` | index 3620 (closure) | fn pura | A (2×) | **extras do engine** |
| `ensureCodexTrust(configDir, projectPath)` | index 3661 (closure) | fn pura | A (1×) | **extras do engine** |
| `updateStoredHelperStatus(projectId, paneId, status, statusAt?)` | index 5415 (closure) | fn | H (2×), L (1×) | **extras** (engine E ipc/pty) |
| `helperOpenWatchdog` | index 345 (**módulo**) | instância `HelperOpenWatchdog` | H (3×), I2 (3×), L (1×) | **extras** (engine E ipc/pty) |
| `helperTranscriptPath(projectId, paneId)` | index 5383 (closure) | fn | L (1×) | extras ipc/pty |
| `paneCodexSkillProfiles` | index 357 (**módulo**) | `Map<string,string>` | L (2×) | extras ipc/pty |
| `armGateMcpWatchdog(identity, paneId)` | index 7446 (closure) | fn | L (1×) | extras ipc/pty |
| `scheduleProgressLiveSnapshot(paneId)` | index 1938 (**módulo**) | fn | L (1×) | extras ipc/pty |
| `refreshProgressLiveSnapshot()` | index 1902 (**módulo**) | fn | L (1×) | extras ipc/pty |
| `progressLiveIdleTimers` | index 515 (**módulo**) | `Map<string,Timeout>` | L (2×) | extras ipc/pty |
| `bindUiSender(sender)` | index 474 (**módulo**) | fn (escreve `uiSender`) | C2, D, E | extras ipc/panes |
| `codexDeveloperInstructions(value)` | index 307 (**módulo**) | fn pura | E (1×) | extras ipc/panes |
| `ensureMissionWorktree(missionId)` | missionEngine (alias 6091) | fn | C2 (1×) | extras ipc/panes |
| `emitMissionsChanged(projectId)` | missionEngine (alias 6088) | fn | L (1×) | extras ipc/pty |
| `recordGateDeath(taskId)` | phaseEngine (`phaseEngine.recordGateDeath`) | fn | L (1×, linha 6878) | extras ipc/pty |
| `rollbackFailedPaneSpawn` | H (próprio) | fn | I2 (2×), L (3×), M (1×) | **retornado pelo engine** |
| `paneSpecStaggerUntil` | index 5557 | **`let` mutável** | B | **nasce dentro do engine** (não precisa state-accessor) |
| `HELPER_OPEN_GRACE_MS` | index 6312 | const | I2 | const de módulo no engine |

**Nenhum `let` mutável precisa de state-accessor.** `paneSpecStaggerUntil` é o
único candidato e ele é lido/escrito EXCLUSIVAMENTE por `staggerPaneSpawn`
(bloco B) — os dois viajam juntos para o engine e o `let` vira estado privado
do factory. Confirmado por grep: as 3 ocorrências (5557, 5561, 5562) estão
todas dentro de 5552–5564.

### 2.3 Imports de topo necessários

**`paneLifecycle.ts` (engine)** — de `electron`: `app`; de `path`: `join`,
`resolve`; de `fs`: `existsSync`, `readFileSync`; de `crypto`: `randomUUID`;
e dos módulos:
`./mcpServer` (`claudeMcpArgs`, `codexMcpArgs`, `ensurePlaywrightCmd`,
`ensurePlaywrightTestCmd`, `resolveProjectPlaywrightTest`,
`writeClaudeMcpConfig`) ·
`./panePermissions` (`codexGateMcpDisableArgs`, `codexGateMcpPolicyArgs`,
`paneAccessProfile`, `effectiveSensitiveAccess`, `paneBrowserAvailable`,
`paneExternalMcpCapabilities`, `panePermissionArgs`, `type PaneAccessProfile`) ·
`./mcpProtocol` (`codexMcpProtocolArgs`, `getCodexMcpProtocolStatus`,
`prewarmCodexMcpProtocol`) ·
`./codexSkillIsolation` (`isMethodGovernedPaneRole`) ·
`./qaRuntime` (`activeQaRuntimes`, `stopQaRuntime`) ·
`./portMap` (`parsePortFromUrl`, `type PortUseEntry`) ·
`./paneStartupMetrics` (`type PaneStartupDescriptor`) ·
`./pty` (`type PaneKind`) · `./seats` (`type SeatCli`) ·
`./hub` (`type PaneIdentity`) · `./phaseTypes` (`type DevPaneSpec`) ·
`./helperOpenWatchdog` (`type HelperOpenWatchdog`) ·
`./helperRecovery` (`type HelperRecoveryStatus`, `type HelperRecoveryRecord`) ·
`./mainContext` (`type MainContext`).

**`ipc/pty.ts`** — `electron` (`ipcMain`); `path` (`join`, `resolve`); `crypto`
(`randomUUID`); `../ptyPreparationGuard` (`ptyPreparationCanContinue`);
`../codexSkillIsolation` (`isMethodGovernedPaneRole`,
`prepareCodexSkillIsolationProfile`, `removeCodexSkillIsolationProfile`);
`../mcpServer` (`resolveProjectPlaywrightTest`, `writeClaudeMcpConfig`);
`../panePermissions` (`paneAccessProfile`, `paneExternalMcpCapabilities`);
`../qaRuntime` (`stopQaRuntime`); `../sessionStats` (`type StatsWatchHandle`);
`electron` app (`app.getPath`); `../paneLifecycle` (`type PaneRequest`,
`type PaneLifecycleEngine`); `../hub` (`type PaneIdentity`); `../mainContext`.

**`ipc/panes.ts`** — `electron` (`ipcMain`); `path` (`join`); `fs`
(`existsSync`); `crypto` (`randomUUID`); `../maestro`
(`FREE_AGENT_PERSONA`); `../worktree` (`createVersionWorktree`);
`../qaRuntime` (`detectRuntimeScript`, `activeQaRuntimes`, `installCommand`,
`portInvocation`, `readScriptCommand`); `../portMap` (`formatPortMap`);
`../missions` (`type Mission`); `../seats` (`type SeatCli`);
`../hub` (`type PaneIdentity`); `../mainContext`; `../paneLifecycle`.

### 2.4 Chamadas para o `phaseEngine` — TODOS os toques cruzados do `onExit`

O `onExit` do `pty:create` (**6777–6958**, 182 linhas) é o ponto de maior
acoplamento do índice inteiro. Lista COMPLETA, linha a linha:

| linha | toque | domínio |
| --- | --- | --- |
| 6785 | `paneTokens.get(req.id) !== token` — **guard de geração** | pane |
| 6786 | `testServerPanes.delete(req.id)` | pane |
| 6787 | `paneStartupMetrics?.end(req.id)` | métricas |
| 6788 | `sessionStats.unwatch(req.id, statsWatchHandle)` | sessionStats |
| 6791 | `mcpPaneFirstContact.delete(req.id)` | MCP |
| 6792 | `unregisterPane(req.id)` | pane (ctx) |
| 6793 | `blackbox.record({event:'exit'})` | caixa-preta |
| 6811–6814 | `livePaneSpecs` / `closingPaneIds` / `paneTokens` / `cleanPaneMcpFile` | pane |
| 6817–6820 | `progressLiveIdleTimers` + `refreshProgressLiveSnapshot()` | **overlay ANDAMENTO** |
| 6822–6824 | `uiSender` → `panes:closeById` | UI |
| 6831–6832 | `helperReported.delete` / `helperSeen.delete` | helpers |
| 6833 | `helperCompletions.discard` | helpers |
| 6834 | `updateStoredHelperStatus(...)` | **helperRecovery** |
| 6836 | `helperTranscriptPath(...)` | **helperRecovery** |
| 6841 | `hub.notifyPane(delegator, ...)` | hub |
| 6859 | `stopQaRuntime(identity.taskId)` | **qaRuntime** |
| 6862–6864 | `liveGateWaits.get/delete` | **phaseEngine** |
| 6865–6867 | `phaseWatches.get/delete` | **phaseEngine** |
| **6878** | **`phaseEngine.recordGateDeath(identity.taskId)`** | **phaseEngine** |
| 6879 / 6904 | `tasks.update(...)` (gate morto × dev morto) | tasks |
| 6889 / 6914 | `hub.publish({kind:'error'})` | hub |
| 6899 | **`terminateTaskHelpers(...)`** | pane (próprio) |
| 6922 | `sender.send('tasks:changed')` | UI |
| 6923 | `syncBoard(identity.projectId)` | board |
| 6928–6930 | `missionWatches.get/delete` | **missionEngine** |
| 6931 | `missions.update(status:'ativa')` | missions |
| **6939** | **`emitMissionsChanged(identity.projectId)`** | **missionEngine** |
| 6942–6956 | `hub.publish({kind:'pane-close', quiet:true})` | hub |

Fora do `onExit`, no mesmo handler: `armGateMcpWatchdog` (6992),
`helperOpenWatchdog.acknowledge` (6977), `testServerPanes.get` + `ptys.inject`
(6980–6984), `mcpPaneFirstContact.has` (7004), `scheduleProgressLiveSnapshot`
(6653), `rollbackFailedPaneSpawn` (6442/6546/6969), `terminateTaskHelpers`
(6899), `paneStartupDescriptor` (6470), `armPane` — **não é chamado aqui**
(as 3 ocorrências de "armPane" em L são de COMENTÁRIO, linhas 6582, 6587,
6778; conferido).

### 2.5 Chamadas para missionEngine / maestroEngine

- **missionEngine**: `ensureMissionWorktree` (5796, bloco C2),
  `emitMissionsChanged` (6939, bloco L), `missionWatches` (6928/6930, bloco L),
  `missionEngine.tickMissionWatches()` (6378 — **FICA no index**, é o poller).
- **maestroEngine**: **nenhuma chamada direta.** A costura maestro↔pane é o
  **selo `maestro-<key>`** dentro do `pty:create` (§5.5) — `maestro.update(...)`
  cru, sem passar pelo engine.

---

## 3. Consumidores externos e a `PaneLifecycleApi`

### 3.1 Call sites FORA das faixas movidas (o que precisa continuar existindo)

| símbolo | call sites que ficam | forma |
| --- | --- | --- |
| **`armPane`** | index 6161 (`PhaseEngineExtras`) · 7367 (`buildHelpersApi`) · 8163 (`registerMaestroIpc`) · 8175 (`registerMissionsIpc`); consumido em phaseEngine.ts:1596, mcpApi/helpers.ts:539, ipc/maestro.ts:497, ipc/missions.ts:531 | extras (4 literais) |
| **`terminatePaneNow`** | index **4015 e 4023** (`removeTaskCascade`, FICA) · 6142 (phase) · 7371 (helpers); phaseEngine ×8, mcpApi/helpers ×1 | alias + extras |
| **`terminateTaskHelpers`** | index 6143 (phase); phaseEngine.ts:3402 | extras |
| **`discardUnstartedPane`** | index 6144 (phase) · 8134 (`registerProjectsIpc`); phaseEngine.ts:3916, ipc/projects.ts:196 | extras |
| **`harnessPortsInUse`** | index 6159 (phase); phaseEngine.ts:993 | extras |
| **`closeTestServersUnder`** | index **5202** (`releaseVersionImpl`, FICA) · 6082 (mission); missionEngine.ts:1890 | alias + extras |
| **`staggerPaneSpawn`** | index 8162 · 8174; ipc/maestro.ts:420, ipc/missions.ts:401 | extras |
| **`livePaneSpecs`** | ctx getter 3450 · **phaseEngine.ts:230 (DESTRUCTURE NO FACTORY)** · phaseEngine.ts:1701 (write) · mcpApi/helpers.ts:121/656/932 · missionEngine.ts:2184 (call time) | ctx |
| **`closingPaneIds`** | ctx getter 3453 · **phaseEngine.ts:231 (factory)** · phaseEngine.ts:1702 · mcpApi/helpers.ts:122/668/933/937 · mcpApi/report.ts:93/310 | ctx |
| **`paneEverSpawned`** | ctx getter 3456 — **sem consumidor externo** | ctx |
| **`pendingPtyPreparations`** | ctx getter 3486 — **sem consumidor externo** | ctx |
| **`testServerPanes`** | ctx getter 3447 — **sem consumidor externo** | ctx |
| **`rollbackFailedPaneSpawn`** | só dentro do domínio, mas **atravessa engine↔ipc/pty** | retornado |
| **`paneStartupDescriptor`** | só `pty:create` (6470) — atravessa engine↔ipc/pty | retornado |

**Consequência prática:** se o index mantiver **aliases desestruturados com os
mesmos nomes** (`const { armPane, terminatePaneNow, … } = paneLifecycle`),
**nenhum literal de extras muda** — os 4 literais de `armPane`, o `PhaseEngineExtras`,
o `MissionEngineExtras`, o `buildHelpersApi` e o `registerProjectsIpc` ficam
textualmente intactos. É o mesmo desfecho do commit 3.

### 3.2 `PaneLifecycleApi` proposta (retorno do factory)

```ts
export interface PaneLifecycleExtras {
  /** Pré-aceite de bypass + trust do cwd no config do seat claude. */
  ensureBypassAccepted(configDir: string, trustCwd?: string): void
  /** Trust do projeto + sandbox do Windows no config.toml do seat codex. */
  ensureCodexTrust(configDir: string, projectPath: string): void
  /** Carimbo de status no transcript durável do ajudante (helperRecovery). */
  updateStoredHelperStatus(
    projectId: string,
    paneId: string,
    status: HelperRecoveryStatus,
    statusAt?: string
  ): HelperRecoveryRecord | undefined
  /** Escopo de módulo do index — compartilhado com mcpApi/helpers. */
  helperOpenWatchdog: HelperOpenWatchdog
}

export type PaneLifecycleEngine = ReturnType<typeof createPaneLifecycle>

export function createPaneLifecycle(ctx: MainContext, extras: PaneLifecycleExtras) {
  // … blocos P, A, B, C1, F, H, I1, I2, K …
  return {
    // ——— estado vivo (aliases do index → getters do MainContext) ———
    livePaneSpecs,          // Map<string, { projectId; taskId; spec: DevPaneSpec }>
    closingPaneIds,         // Set<string>
    paneEverSpawned,        // Set<string>
    pendingPtyPreparations, // Map<string, symbol>
    testServerPanes,        // Map<string, { projectId; cwd; command; port?; label? }>
    // ——— armamento ———
    armPane,                // (identity, cli, opts?) => { paneId; cliArgs: string[] }
    paneStartupDescriptor,  // (req: PaneRequest) => PaneStartupDescriptor
    staggerPaneSpawn,       // () => Promise<void>
    // ——— encerramento ———
    rollbackFailedPaneSpawn, // (paneId, reason) => void
    discardUnstartedPane,    // (paneId) => void
    terminatePaneNow,        // (projectId, paneId) => void
    terminateTaskHelpers,    // (projectId, taskId, reason) => void
    // ——— servidor de teste do dono ———
    harnessPortsInUse,       // (projectId) => PortUseEntry[]
    closeTestServersUnder,   // (pathPrefix) => void
    // ——— fatia do poller de 3s ———
    tickHelperOpenWatchdog   // () => void
  }
}
```

`mcpPaneArgs` **não é retornado** (só `armPane` o chama, linha 3905).

### 3.3 Extras dos módulos IPC

```ts
export interface PtyIpcExtras {
  engine: PaneLifecycleEngine
  /** helperRecovery — carimbo + caminho do transcript do ajudante. */
  updateStoredHelperStatus(...): HelperRecoveryRecord | undefined
  helperTranscriptPath(projectId: string, paneId: string): string | undefined
  helperOpenWatchdog: HelperOpenWatchdog
  /** Escopo de módulo do index — perfil de skills isolado do codex. */
  paneCodexSkillProfiles: Map<string, string>
  /** Watchdog de 1º contato MCP do gate (index 7446). */
  armGateMcpWatchdog(identity: PaneIdentity, paneId: string): void
  /** Overlay de ANDAMENTO (escopo de módulo do index). */
  scheduleProgressLiveSnapshot(paneId: string): void
  refreshProgressLiveSnapshot(): unknown
  progressLiveIdleTimers: Map<string, NodeJS.Timeout>
  /** missionEngine — gate de integração fechado sem veredito. */
  emitMissionsChanged(projectId: string): void
  /** phaseEngine — breaker de crash-loop de gate. */
  recordGateDeath(taskId: string): { looping: boolean; deaths: number }
}

export interface PanesIpcExtras {
  engine: PaneLifecycleEngine
  bindUiSender(sender: Electron.WebContents): void
  codexDeveloperInstructions(value: string): string
  ensureMissionWorktree(missionId: string): Mission | undefined
}
```

Todos os 10 + 4 são **referências simples** no bloco de registro — **zero
arrow late-bound**, porque `registerPtyIpc`/`registerPanesIpc` são chamados no
fim do whenReady, depois de `armGateMcpWatchdog` (7446), `phaseEngine` (6141) e
`missionEngine` (6074) existirem.

---

## 4. Recomendação de arquitetura

### 4.1 Três módulos, não um

| módulo | conteúdo | L estimadas |
| --- | --- | --- |
| `src/main/paneLifecycle.ts` | blocos P, A, B, C1, F, H, I1, I2, K = 540L de corpo + cabeçalho/imports/extras/factory | **~670** |
| `src/main/ipc/pty.ts` | blocos J, L, M = 834L de corpo + cabeçalho/imports/extras | **~930** |
| `src/main/ipc/panes.ts` | blocos C2, D, E, G = 189L de corpo + cabeçalho/imports/extras | **~260** |

**Por que NÃO o engine registrando os próprios handlers.** Daria um
`paneLifecycle.ts` de ~1.750 linhas — violação direta da regra dura do dono
("arquivo cruzando ~1000 linhas se divide na hora"), e o débito já registrado
do `missionEngine` (2.247L) mostra o custo de aceitar isso "só desta vez".

**Por que NÃO um único `ipc/panes.ts` com os 10 handlers.** Daria ~1.113L —
também acima do teto. A fronteira `pty:*` × `panes:*` é a fronteira natural: o
`pty:create` é uma máquina de estado de morte de processo (793L sozinho); os
`panes:*` são specs e consultas.

**Por que a separação engine × IPC é a peça-chave.** Ela inverte o problema de
ordem. Com o engine carregando os handlers, ele precisaria de
`recordGateDeath`/`emitMissionsChanged`/`ensureMissionWorktree`/`armGateMcpWatchdog`
como **arrows late-bound** (o precedente `codeReportGuard` funciona, mas são 4
arrows novas + 6 leituras `ctx.*` em call time). Separando, esses 4 símbolos
viajam como referência direta no bloco de registro e **o engine fica com 4
extras, todos declarados ANTES do ponto de construção**.

### 4.2 Ordem de construção NOVA: paneLifecycle → mission → maestro → phase

Fato bloqueante conferido: **`phaseEngine.ts:230–231` faz
`const livePaneSpecs = ctx.livePaneSpecs` e `const closingPaneIds =
ctx.closingPaneIds` NO FACTORY** — não em call time. Se os Maps nascerem no
paneLifecycle, ele **precisa** existir antes do `createPhaseEngine`.

Ponto de construção recomendado: **exatamente onde hoje está o bloco F
(linha 6041)**, imediatamente antes do `createMissionEngine` (6074). Ali:

- `ensureBypassAccepted` (3620), `ensureCodexTrust` (3661) e
  `updateStoredHelperStatus` (5415) já existem → extras por valor ✓
- `helperOpenWatchdog` (345, módulo) já existe ✓
- os aliases `closeTestServersUnder`/`terminatePaneNow`/`terminateTaskHelpers`/
  `discardUnstartedPane`/`harnessPortsInUse`/`armPane` passam a existir ANTES
  dos literais de extras do missionEngine (6082) e do phaseEngine (6142–6161) ✓
- os getters `ctx.livePaneSpecs`/`closingPaneIds`/`paneEverSpawned`/
  `testServerPanes`/`pendingPtyPreparations` passam a apontar para o engine, e
  o primeiro leitor é o `createPhaseEngine` em 6141 ✓

### 4.3 `ipc/guards.ts` — a recomendação MUDOU: **não fazer agora**

O mapa histórico (docs/FASE1_MAPA_MAINCONTEXT.md:128) previa
"Guards de sender + `bindUiSender` → `ipc/guards.ts` único". A varredura
recomenda **adiar / descartar**, por três fatos:

1. **`bindUiSender` ESCREVE `uiSender`** (index 496), que o MainContext expõe
   como getter *readonly*. Extrair exigiria um `state:` accessor (padrão
   voice/progress) só para essa variável — ou um `setUiSender` novo no
   contrato. Custo real, ganho nenhum.
2. **Raio de explosão**: `bindUiSender` é extra de **11 módulos ipc** hoje
   (backlog, harness, maestro, misc, missions, projectPlan, projects, tasks +
   os 3 que faltam). Movê-lo muda **todos** os `register*Ipc` e todos os
   `XxxIpcExtras` — um diff enorme, ortogonal ao paneLifecycle.
3. **O domínio de pane não usa NENHUM `assert*Sender`.** Conferido: dos 10
   handlers que migram, só C2/D/E chamam `bindUiSender(e.sender)`; nenhum
   chama `assertMainRendererSender`. Os asserts (752–859) dependem de
   `mainWindow`/`synVoiceOverlayWindow`/`progressOverlayWindow` — três `let` de
   módulo — e pertencem ao futuro corte de **overlays**, não a este.

Portanto: `bindUiSender` e os asserts **FICAM em escopo de módulo no index**;
`ipc/panes.ts` recebe `bindUiSender` por extras, como os outros 11.

### 4.4 O que NÃO se move (e por quê)

| símbolo | linha | veredito |
| --- | --- | --- |
| `unregisterPane` | 417 (módulo) | **FICA.** Já é `ctx.unregisterPane`; toca codeIntelligence + skill leases + `plannedHelperAssignments` + `paneStatusNotes` — é cross-domain, não pane. |
| `cleanPaneMcpFile` | 358 (módulo) | **FICA.** Já é `ctx.cleanPaneMcpFile`; também remove o perfil de skills isolado do codex. |
| `paneTokens` / `paneMcpFiles` | 353 / 356 (módulo) | **FICAM.** Já estão no MainContext e são consumidos por `mcpApi/helpers`. O engine lê por `ctx`. |
| `paneCodexSkillProfiles` | 357 (módulo) | **FICA** (usado por `cleanPaneMcpFile` em 366); viaja como extras para `ipc/pty`. |
| `helperOpenWatchdog` | 345 (módulo) | **FICA** (extras de `mcpApi/helpers`, index 7380); viaja como extras. Candidato a entrar no MainContext em higiene futura. |
| `codexDeveloperInstructions` | 307 (módulo) | **FICA.** Função pura de 7 linhas, extra de 5 consumidores (phase, ipc/maestro, ipc/missions, mcpApi/helpers, ipc/panes). Mover só trocaria o dono do mesmo literal. Candidata a um `codexArgs.ts` puro em higiene futura. |
| `projectLifecycleOf` | 3216 | **NÃO É DESTE DOMÍNIO.** Único consumidor é `ipc/maestro` (466). Fica. |
| `FREE_AGENT_PERSONA` | import 32 | **VIAJA** com o bloco E (import direto em `ipc/panes.ts`). O import do index vira **órfão**. |
| `bindUiSender` / `assert*Sender` | 474 / 800–859 | **FICAM** (§4.3). |
| `crash:renderer` / `perf:renderer-stall` | 2341 / 2375 | **FICAM** (escopo de módulo, por desenho). |

---

## 5. Riscos (estilo phaseEngine)

### 5.1 🔴 TDZ da ordem de construção — o risco nº 1

`phaseEngine.ts:230–231` lê `ctx.livePaneSpecs`/`ctx.closingPaneIds` **na
construção**. Se o paneLifecycle nascer DEPOIS do phaseEngine, os getters
caem em TDZ (`Cannot access 'livePaneSpecs' before initialization`) —
**crash de boot, não erro de typecheck**.

**Mitigação obrigatória:** construir o paneLifecycle na linha 6041 (onde os
Maps estão hoje) e deixar um comentário-âncora no index e no cabeçalho do
módulo:
`// Ordem obrigatória: paneLifecycle → mission → maestro → phase (o phaseEngine
// desestrutura ctx.livePaneSpecs/ctx.closingPaneIds NA CONSTRUÇÃO).`

**Verificação barata:** rodar `npm run dev` uma vez. TDZ de getter aparece no
primeiro segundo do boot.

### 5.2 Consumidores declarados ANTES dos aliases (seguros, mas cheque)

Estes leem símbolos do domínio em código que fica ACIMA da linha 6041. Todos
são corpos de função executados em call time — **seguros**, mas o script não
pode "consertar" nada aqui:

- `removeTaskCascade` (3994) → `terminatePaneNow` (4015, 4023)
- `releaseVersionImpl` (5179) → `closeTestServersUnder` (5202)
- `panes:testServerSpec` (5771) → `testServerPanes`, `ensureMissionWorktree`
  (só até o commit 7c; depois migra)
- `panes:portsInUse` (5895) → `harnessPortsInUse` (idem)
- `panes:freeSpec` (5907) → `armPane` (idem)

Precedente idêntico já vive no repo: `removeTaskCascade` (3994) usa
`phaseWatches`/`liveGateWaits`/`closeLiveGateWait`, aliases nascidos em 6165+.

### 5.3 A corrida `armPane` × `cleanPaneMcpFile` — o comentário que EXPLICA o fix

O fix já existe e mora DENTRO do `pty:create` (linhas 6580–6606). Ele **não
pode** ser separado do handler, nem "simplificado". Texto literal (6580–6584):

> ```
> // CORRIDA REAL (maestro da Luma nasceu com "MCP config file not found"):
> // remount do pane reusa o MESMO id — o kill do pty antigo roda
> // cleanPaneMcpFile e apaga o arquivo que o armPane acabou de (re)gravar
> // para o pty novo. Regrava aqui, na hora do spawn: idempotente, o nome é
> // derivado do paneId e o conteúdo só depende de porta+token.
> ```

O par dele está no `pty:kill` (7200–7206):

> ```
> // Este canal chega a CADA REMOUNT do TerminalPane (cliArgs novos de um
> // paneSpec, troca de seat) — "remount" NÃO é "pane fechado". Desarmar aqui
> // apagava o token, a identidade no hub e o userData/mcp/<paneId>.json que o
> // armPane tinha ACABADO de gravar para o pty que ia nascer: … 
> // O desarmamento vive no onExit do pty:create, com guard de geração.
> ```

**Invariante a preservar:** `armPane` (engine) grava `paneMcpFiles`;
`pty:create` (ipc) **re-grava** no spawn; `pty:kill` (ipc) **NUNCA** desarma;
o desarme é só no `onExit`, sob o guard de geração. Os três blocos ficam
verbatim; a única mudança é que `paneMcpFiles` passa a ser lido por
`ctx.paneMcpFiles` no engine (o Map continua sendo o mesmo objeto de módulo).

### 5.4 Substituições não-verbatim autorizadas (precedente do commit 3/6)

| de | para | onde | ocorrências |
| --- | --- | --- | --- |
| `uiSender` | `ctx.uiSender` | C1, H, I2, L | 3 + 7 + 3 + 3 = **16** |
| `mcpPort` | `ctx.mcpPort` | A, L | 8 + 1 = **9** |
| `paneStartupMetrics` | `ctx.paneStartupMetrics` | J, L | 2 + 8 = **10** |
| `phaseWatches` | `ctx.phaseWatches` | H, L | 2 + 4 = **6** |
| `liveGateWaits` | `ctx.liveGateWaits` | L | **2** |
| `missionWatches` | `ctx.missionWatches` | L | **2** |
| `mcpPaneFirstContact` | `ctx.mcpPaneFirstContact` | L | **2** |

**Total: 7 símbolos, 47 ocorrências.** Nada mais.

Motivos, um a um:
- `uiSender` / `mcpPort` / `paneStartupMetrics`: `let` reatribuídos em runtime
  (o MainContext os lista como getters "sempre o valor ATUAL"). `mcpPort` é o
  mais crítico — `armPane`/`mcpPaneArgs` decidem "pane nasce sem tools" com
  base nele (linha 3734, 3940) e o servidor MCP sobe **assíncrono** (7630).
- `phaseWatches` / `liveGateWaits` / `missionWatches`: nascem em engines
  construídos **depois** do paneLifecycle (6165/6168/6085) → leitura só em call
  time.
- `mcpPaneFirstContact`: declarado em **7437**, DEPOIS do `pty:create` (6401).
  Hoje funciona por closure; num módulo tem de vir por `ctx`.

**Podem ser desestruturados no factory (seguro, corpo intacto):** `projects`,
`seats`, `tasks`, `missions`, `backlog`, `maestro`, `settings`, `ptys`,
`blackbox`, `sessionStats`, `helperCompletions`, `paneTokens`, `paneMcpFiles`,
`paneSessions`, `helperReported`, `helperSeen`, `expiredSeats` (3963, antes de
6041), `syncBoard`, `ensureProjectRuntimeWritable`, `externalPlaywrightForPane`,
`bypassOn`, `projectModeOf`, `projectPlanOf`, `unregisterPane`,
`cleanPaneMcpFile`, e `hub` (atribuído em **3262**, muito antes — mesmo
precedente do `const hub = ctx.hub` em phaseEngine.ts:227).

**Armadilha de sombreamento** (lição do `maestroResumeOverBudget`): conferir se
algum corpo movido declara `const ctx = …` local. Grep no domínio: **nenhuma
ocorrência** de `const ctx` / `let ctx` nas faixas 3690–3949, 5552–5955,
6041–6399, 6401–7225. ✅

### 5.5 O selo `maestro-<key>` — 4 pontos, todos dentro de `pty:create`

O `maestroEngine.ts` (cabeçalho, linhas 15–18) documenta:
*"O teto de resume é ESCRITO pelo pty:create (stampMaestroContext/onSession/
onCommand/onResumeFail) e LIDO aqui — a comunicação é a chave do maestroStore:
o paneId sem o prefixo `maestro-`. Preservar o prefixo em qualquer refatoração
futura do pty:create."*

Os 4 pontos, conferidos linha a linha (todos em `req.id.startsWith('maestro-')`
+ `req.id.slice('maestro-'.length)`):

| ponto | linhas | escreve |
| --- | --- | --- |
| `onResumeFail` | 6689–6694 | `tuiSessionId: undefined`, `tuiContextTokens: undefined` |
| `onCommand` (`/clear`, `/new`, `/fork`) | 6740–6745 | idem |
| `onSession` | 7138–7145 | `tuiSessionId: sessionId` (+ zera `tuiContextTokens` se a sessão MUDOU) |
| `stampMaestroContext` (via `onStats`) | 7114–7119 | `tuiContextTokens` com throttle de 25k |

**Todos os 4 viajam JUNTOS para `ipc/pty.ts`, verbatim.** Nada mais precisa
mudar: o leitor (`maestroResumeOverBudget`/`skipMaestroResume`) já vive no
maestroEngine e lê pelo `maestroStore`, não por referência de código. O único
cuidado é o de sempre: **não tocar nas strings `'maestro-'`**.

### 5.6 Guard de geração do `onExit` (token capturado no spawn)

Linha 6785: `if (paneTokens.get(req.id) !== token) return`. O `token` é
capturado em **6403** (`const token = paneTokens.get(req.id)`), no corpo do
handler, ANTES de qualquer await. Ao mover, o `const token` e o `onExit` ficam
no MESMO escopo (o handler inteiro é um bloco só) — **nenhuma ação necessária**,
mas o comentário 6778–6784 explica por que esse guard existe e não pode ser
"simplificado" para `hub.identityByPane`.

Mesmo raciocínio para o **ticket** `pendingPtyPreparations` (6476–6573): o
`Symbol(req.id)` é local ao handler; o Map é do engine. Como o Map é passado por
referência via `engine.pendingPtyPreparations`, o comportamento é idêntico.

### 5.7 sessionStats: watch / claim / unwatch

`statsWatchHandle` é um `let` declarado em **6609**, escrito em **7120**
(`sessionStats.watch`) e lido em **6788** (`sessionStats.unwatch`, dentro do
`onExit` — closure sobre o `let`). Os três pontos estão dentro do bloco L →
viajam juntos, verbatim. `sessionStats.noteReset` (6688, 6727) e
`sessionStats.replay` (7190) idem. **Zero risco**, desde que o bloco L não seja
fatiado.

**Corolário: NUNCA dividir o `pty:create` em sub-funções neste corte.** O
handler tem 4 closures (`onResumeFail`, `onCommand`, `onExit`, `onStats`/
`onSession`) que capturam `token`, `statsWatchHandle`, `seat`, `sender`,
`reusedPty`, `pendingIdentity`, `lastStampedCtx`, `lastMaestroCtx`,
`preparationTicket`. Refatorar isso é obra separada, depois do corte verde.

### 5.8 Quem é dono do `setInterval` de 3s

O poller (6313–6379) fica **no index**. Só o corpo do helper-open watchdog
migra, virando `tickHelperOpenWatchdog()` — exatamente o padrão de
`tickPhaseWatches` (phaseEngine) e `tickMissionWatches` (missionEngine). Estado
final:

```ts
  setInterval(() => {
    phaseEngine.tickPhaseWatches()
    paneLifecycle.tickHelperOpenWatchdog()
    missionEngine.tickMissionWatches()
  }, 3000)
```

`HELPER_OPEN_GRACE_MS` (6312) vira const de módulo em `paneLifecycle.ts` — não
tem outro leitor (grep: 6312 e 6319, ambos no domínio).

### 5.9 Escrita de fora para dentro

Quem escreve no estado do domínio a partir de OUTROS módulos (tudo por `ctx`,
já funcionando — não muda nada, mas o corte não pode quebrar):

| escritor | o quê |
| --- | --- |
| `phaseEngine.ts:1701–1702` | `livePaneSpecs.set` + `closingPaneIds.delete` (spawn de fase) |
| `mcpApi/helpers.ts:656/667/668` | `livePaneSpecs.set` + `helperOpenWatchdog.arm` + `closingPaneIds.delete` (spawn de ajudante) |
| `mcpApi/helpers.ts:930–938` | `helperOpenWatchdog.acknowledge`, `livePaneSpecs.delete`, `closingPaneIds.add/delete`, `paneTokens.delete`, `cleanPaneMcpFile` (helper_close) |
| `mcpApi/report.ts:310` | `closingPaneIds.add` (kill do ajudante pós-report) |
| `missionEngine.ts:2184` | `ctx.livePaneSpecs.delete` (stopMissionExecution) |

Nenhum deles precisa de alteração: continuam recebendo os mesmos Maps, agora
pelo `ctx` cujo getter aponta para o alias do engine.

### 5.10 `PaneRequest` e `instrumentIpcMain`

- `PaneRequest` (723–736) é interface **local** do index (não é exportada, não
  aparece no preload). Vira `export interface PaneRequest` em
  `paneLifecycle.ts`; `ipc/pty.ts` importa o tipo. Confirma o import órfão de
  `type PaneKind` (index 139) — a interface é a única consumidora.
- `instrumentIpcMain(ipcMain, mainStalls)` roda em **2336**, escopo de módulo,
  ANTES do whenReady. Registrar os 10 handlers no bloco de registro (≈8180) os
  mantém instrumentados — o rótulo `ipc:pty:create` continua no ranking de
  stall. ✅

### 5.11 Imports que ficam órfãos no index (rodar `check-orphan-imports.mjs`)

**Órfãos previstos (~30)**: `FREE_AGENT_PERSONA` (32), `createVersionWorktree`
(42), `ptyPreparationCanContinue` (75), `isMethodGovernedPaneRole` (77),
`prepareCodexSkillIsolationProfile` (78), `type PaneKind` (139),
`type StatsWatchHandle` (140), `claudeMcpArgs` (150), `codexMcpArgs` (151),
`ensurePlaywrightCmd` (152), `ensurePlaywrightTestCmd` (153),
`resolveProjectPlaywrightTest` (155), `writeClaudeMcpConfig` (157),
`codexMcpProtocolArgs` (195), `type PaneStartupDescriptor` (193),
`codexGateMcpDisableArgs` (265), `codexGateMcpPolicyArgs` (266),
`paneAccessProfile` (267), `effectiveSensitiveAccess` (268),
`paneBrowserAvailable` (269), `paneExternalMcpCapabilities` (270),
`panePermissionArgs` (271), `type PaneAccessProfile` (272),
`detectRuntimeScript` (275), `activeQaRuntimes` (276), `installCommand` (277),
`portInvocation` (278), `readScriptCommand` (279), `stopQaRuntime` (282),
`formatPortMap` + `parsePortFromUrl` + `type PortUseEntry` (284).

**NÃO são órfãos** (conferido, seguem usados no index): 
`removeCodexSkillIsolationProfile` (368, em `cleanPaneMcpFile`),
`getCodexMcpProtocolStatus` (7673), `prewarmCodexMcpProtocol` (3957, 3983),
`HelperOpenWatchdog` (345), `PaneStartupMetrics` (2472), `SessionStatsWatcher`
(347), `PtyManager` (315).

Regra do commit 6 mantida: **remover só os órfãos NOVOS**; a sujeira
pré-existente (`basename`, `nativeImage`, `GATE_DEATH_LIMIT`,
`MAX_PARALLEL_RUNS`…) fica anotada e intocada.

---

## 6. Plano de corte recomendado

### Commit 7a — `paneLifecycle.ts` (engine)

- **Move**: P (723–736), A (3690–3949), B (5552–5564), C1 (5717–5770),
  F (6041–6061), H (6198–6309), I1 (6312), I2 (6315–6376), K (6397–6399).
  **540 linhas.**
- **Constrói** em 6041 (onde estava F), **antes** do `createMissionEngine`:
  `const paneLifecycle = createPaneLifecycle(ctx, { ensureBypassAccepted,
  ensureCodexTrust, updateStoredHelperStatus, helperOpenWatchdog })` + o
  `const { … } = paneLifecycle` com os 17 aliases.
- **Substitui no corpo**: `uiSender`→`ctx.uiSender` (13×: C1 3, H 7, I2 3),
  `mcpPort`→`ctx.mcpPort` (8×), `phaseWatches`→`ctx.phaseWatches` (2×).
- **Substitui no poller**: as linhas 6315–6376 viram
  `paneLifecycle.tickHelperOpenWatchdog()`.
- **Não muda**: nenhum literal de extras (missionEngine 6074–6083,
  phaseEngine 6141–6163, mcpApi 7334–7419, register block 7999–8178) —
  os aliases mantêm os mesmos nomes.
- **Risco principal**: §5.1 (ordem de construção). Validar com boot.
- index: 8.225 → **~7.710**.

### Commit 7b — `ipc/pty.ts` (6 handlers, o gigante)

- **Move**: J (6387–6395), L (6401–7193), M (7194–7225). **834 linhas.**
- **Registra**: `registerPtyIpc(ctx, { engine: paneLifecycle,
  updateStoredHelperStatus, helperTranscriptPath, helperOpenWatchdog,
  paneCodexSkillProfiles, armGateMcpWatchdog, scheduleProgressLiveSnapshot,
  refreshProgressLiveSnapshot, progressLiveIdleTimers, emitMissionsChanged,
  recordGateDeath: phaseEngine.recordGateDeath })` no bloco de registro, depois
  de `registerMissionsIpc`.
- **Substitui no corpo**: `paneStartupMetrics`→`ctx.paneStartupMetrics` (10×),
  `uiSender`→`ctx.uiSender` (3×), `mcpPort`→`ctx.mcpPort` (1×),
  `phaseWatches`→`ctx.phaseWatches` (4×), `liveGateWaits`→`ctx.liveGateWaits`
  (2×), `missionWatches`→`ctx.missionWatches` (2×),
  `mcpPaneFirstContact`→`ctx.mcpPaneFirstContact` (2×), e
  `phaseEngine.recordGateDeath(...)`→`recordGateDeath(...)` (1×, linha 6878).
- **Riscos**: §5.3 (corrida MCP), §5.5 (selo `maestro-`), §5.6 (guard de
  geração), §5.7 (sessionStats — não fatiar o handler).
- index: ~7.710 → **~6.890**.

### Commit 7c — `ipc/panes.ts` (4 handlers) + higiene

- **Move**: C2 (5771–5891), D (5893–5898), E (5900–5955), G (6191–6196).
  **189 linhas.**
- **Registra**: `registerPanesIpc(ctx, { engine: paneLifecycle, bindUiSender,
  codexDeveloperInstructions, ensureMissionWorktree })`.
- **Higiene do mesmo commit**: `check-orphan-imports.mjs` no index atual e no
  index de `0cd958b`, removendo só os ~30 órfãos NOVOS (§5.11); atualização de
  `docs/HANDOFF_FASE1.md` + ESTADO do `docs/PLANO_NIVEL_5.md`.
- index: ~6.890 → **~6.730**.

### Cerca verde de cada fatia (inalterada)

`npm run typecheck` (node + web) + as 5 suítes: `orchestrator-flow` 39 ·
`mission-verification` 25 · `integration-queue` 14 · `pane-permissions` 14 ·
`stall-attribution` 8. App parado para editar `src/`. Commits `fase1:` sem
acentos. `git add` por caminho explícito. Scripts de corte por ÂNCORA, nunca
por número de linha, com validação `grep = 1×` e guarda anti-sobreposição.

### O que o bloco de registro ganha

Duas chamadas novas no fim (`registerPtyIpc`, `registerPanesIpc`) — **os
últimos 10 dos 138 handlers do índice**. Ao fim do commit 7c, **todo handler
IPC do Synkora vive em `src/main/ipc/`**, exceto os 2 de escopo de módulo
(`crash:renderer`, `perf:renderer-stall`), que ficam por desenho.

### Débito registrado após o commit 7

- `ipc/pty.ts` com ~930 linhas dominadas por um único handler: **candidato a
  partição futura** (`pty:create` → preparação × spawn × ciclo de vida do
  processo), obra separada, só depois de um boot de validação verde.
- `ipc/guards.ts` (§4.3): fica como opção de higiene, sem prazo.
- `codexDeveloperInstructions` → módulo puro `codexArgs.ts`: higiene barata,
  fora desta obra.
- `helperOpenWatchdog` entrar no MainContext: eliminaria 2 entradas de extras.
