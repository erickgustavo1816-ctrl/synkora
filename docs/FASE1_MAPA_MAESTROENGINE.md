# FASE 1 — mapa do MAESTRO ENGINE (varredura read-only, 2026-08-08)

Survey do domínio MAESTRO dentro de `src/main/index.ts` (branch `nivel5-fase1`,
**11.768 linhas** no momento da varredura) para preparar a extração mecânica de
`src/main/maestroEngine.ts` + `src/main/ipc/maestro.ts`, no MESMO padrão do
`phaseEngine.ts` (commit 3) e dos módulos `ipc/` (commit 5):

- `createMaestroEngine(ctx: MainContext, extras: MaestroEngineExtras)` — estado do
  domínio nasce DENTRO do engine; o index mantém aliases destruturados para os
  call sites legados e para os getters do `MainContext` ficarem textualmente
  intactos.
- `registerMaestroIpc(ctx: MainContext, extras: MaestroIpcExtras)` — chamado do
  `whenReady` (bloco único antes do `createWindow`), NUNCA no import.

> **TODOS os números de linha deste documento foram re-verificados por grep
> imediatamente antes da escrita.** Cada âncora regex foi conferida com
> `grep -cE` = 1 (exatamente uma ocorrência no arquivo). O mapa anterior
> (`FASE1_MAPA_MAINCONTEXT.md`) tem linhas OBSOLETAS — não usar.

---

## 0. Resumo executivo

| | blocos | linhas |
|---|---|---|
| `maestroEngine.ts` (recomendado mover) | 9 | **431** |
| `ipc/maestro.ts` (18 handlers) | 18 | **520** |
| **Total recomendado** | **27** | **951** |
| Fronteira opcional (`migrateCliSessionBetweenSeats`) | 1 | 55 |
| Avaliados e **RECOMENDADOS A FICAR** | 4 | 78 |

Extras distintos: **19** (8 só do engine, 14 do IPC, 3 compartilhados).
Crossings para o domínio MISSION dentro dos blocos do maestro: **ZERO**
(verificado por grep de 15 símbolos de missão em todos os ranges — ver §2.d).
Crossings para a máquina de fases: **1**, já coberto pela `PhaseApi` atual
(`drainPendingRespawns`) — **a `PhaseApi` NÃO precisa crescer**.

---

## 1. Inventário — blocos do `maestroEngine.ts`

Convenção das âncoras: quando a última linha do bloco é uma chave nua (`}` /
`})` / `)`) — que nunca é única no arquivo — o campo **âncora final** traz a
última linha DISTINTIVA do bloco + o offset até a linha final real. O corte
scriptado deve usar `linha_da_âncora + offset`.

### W2 · `planningPreparationTickets` + `preparePlanningRun`
- **Range:** `[3002, 3084]` — **83 linhas**
- **Âncora inicial (1×, :3002):** `^  const planningPreparationTickets = new Map<string, string>\(\)$`
- **Âncora final (1×, :3082, offset +2):** `^      return fail\('falha ao preparar o método nativo de planejamento'\)$`
- Prepara o método nativo `synkora-planning-standard` e devolve o `skillBlock`
  com o `receiptId` que o PM/orquestrador é obrigado a ativar.

### W4 · `MAESTRO_RESUME_BUDGET_TOKENS` + `maestroResumeOverBudget` + `skipMaestroResume`
- **Range:** `[7980, 8009]` — **30 linhas** (inclui o comentário-âncora de 8 linhas)
- **Âncora inicial (1×, :7980):** `^  // TETO DE CUSTO DO RESUME DO PM/ORQUESTRADOR \(pedido do usuário, 2026-08-06:$`
- **Âncora final (1×, :8008, offset +1):** `^    maestro\.update\(key, \{ tuiSessionId: undefined, tuiContextTokens: undefined \}\)$`
- `const MAESTRO_RESUME_BUDGET_TOKENS = 150_000` em :7988 — vira `export const`
  do módulo (mesmo tratamento que `MAX_PARALLEL_RUNS` recebeu no phaseEngine).

### W6 · `makeEmitter`
- **Range:** `[8240, 8245]` — **6 linhas**
- **Âncora inicial (1×, :8240):** `^  function makeEmitter\(sender: Electron\.WebContents, projectId: string\) \{$`
- **Âncora final:** a linha 8245 é `  }` — usar `âncora inicial + 5`.

### W7 · `emitLog` + `emitLive`
- **Range:** `[8287, 8295]` — **9 linhas**
- **Âncora inicial (1×, :8287):** `^  // Emissores baseados no uiSender atual: a sessão persistente sobrevive a$`
- **Âncora final (1×, :8293, offset +2):** `^  function emitLive\(evt: unknown\): void \{$`

### W8 · `sessionSink`
- **Range:** `[8297, 8445]` — **149 linhas**
- **Âncora inicial (1×, :8297):** `^  // Traduz os eventos crus do painel de fundo em log persistido \+ live da UI\.$`
- **Âncora final (1×, :8440, offset +5):** `^            emitLive\(\{ type: 'exit' \}\)$`
- ⚠️ NÃO usar `^          if \(isCurrent\(\)\) \{$` como âncora: casa 2× (:8429 e :8438).

### W9 · `ensureSession`
- **Range:** `[8447, 8512]` — **66 linhas**
- **Âncora inicial (1×, :8447):** `^  // Garante o painel de fundo vivo para o projeto\+seat \(respawn se preciso\)\.$`
- **Âncora final (1×, :8511, offset +1):** `^    return session$`

### W10 · `surveyAborts`
- **Range:** `[8609, 8610]` — **2 linhas**
- **Âncora inicial (1×, :8609):** `^  // /estudar roda FORA do painel — o ⏹ precisa de um caminho próprio\.$`
- **Âncora final (1×, :8610):** `^  const surveyAborts = new Map<string, \(\) => void>\(\)$`

### W11 · `surveyViaCodex`
- **Range:** `[8630, 8692]` — **63 linhas**
- **Âncora inicial (1×, :8630):** `^  // /estudar num seat CODEX: sessão dedicada do app-server em sandbox$`
- **Âncora final (1×, :8690, offset +2):** `^      session\.send\(SURVEY_PROMPT\)$`

### W13 · `userQuestionsFile` + `pendingUserQuestions` + `persistUserQuestions`
- **Range:** `[9629, 9651]` — **23 linhas** (inclui o comentário de 5 linhas)
- **Âncora inicial (1×, :9634):** `^  const userQuestionsFile = join\(app\.getPath\('userData'\), 'user-questions\.json'\)$`
  (o comentário começa em :9629 → cortar de `âncora − 5`)
- **Âncora final (1×, :9647, offset +4):** `^      persistJsonStore\(userQuestionsFile, Object\.fromEntries\(pendingUserQuestions\)\)$`
- **Decisão de posse:** ver §5.4 — o WRITE vem de FORA (tool `ask_user` em
  `mcpApi/panes.ts`), mas via `ctx`. A posse é do maestro; nada muda no
  `MainContext`.

### W12 (FRONTEIRA, opcional) · `migrateCliSessionBetweenSeats`
- **Range:** `[8784, 8838]` — **55 linhas** (o JSDoc começa em :8784)
- **Âncora inicial (1×, :8784):** `^  /\*\* TRANSPLANTE DE SESSÃO ENTRE SEATS \(sondas 2026-08-04, ambas positivas:$`
- **Âncora final:** a linha 8838 é `  }` — âncora distintiva (1×, :8790)
  `^  function migrateCliSessionBetweenSeats\($` → usar `+48`.
- ⚠️ As linhas **8782–8783** (`// Trocar de seat é ação explícita: …`) são um
  comentário ÓRFÃO que pertence semanticamente a `maestro:setSeat` (:8990) —
  o `setPhaseExecutorImpl` se meteu no meio. Ele deve viajar com o handler
  para `ipc/maestro.ts`, não com esta função.
- **Recomendação:** esta função tem **ZERO dependências de closure** (só usa
  `app`, `join`, `relative`, `dirname`, `existsSync`, `mkdirSync`,
  `copyFileSync`, `readdirSync` — todos imports de topo). É candidata ideal a
  **módulo puro próprio** (`cliSessionTransplant.ts`) num commit separado, o
  que evita que o phase-domain (`setPhaseExecutorImpl`, :8890) passe a depender
  do maestroEngine. Se preferir o caminho curto, entra no engine e vira membro
  da `MaestroApi`.

---

## 1b. Blocos avaliados e **RECOMENDADOS A FICAR** (com o motivo)

| bloco | range | linhas | por que fica |
|---|---|---|---|
| **M1** `type MaestroBackend` + `const maestroSessions` | `[473, 476]` | 4 | ESCOPO DE MÓDULO. O handler `app.on('window-all-closed')` (:11762–11766, fora do `whenReady`) itera `maestroSessions.values()` e chama `.clear()`. Mover para o engine forçaria um `let maestroEngineRef` global — troca segurança por estética. O engine lê via `ctx.maestroSessions` (já no MainContext, :136). Âncoras: `^// Painéis de fundo do Maestro \(um processo persistente por projeto:$` / `^const maestroSessions = new Map<string, MaestroBackend>\(\)$`. |
| **M2** `killMaestroSession` | `[693, 702]` | 10 | ESCOPO DE MÓDULO, vizinho do bloco de progresso headless (`finishProgressMaestroTurn` :734, `endProgressHeadlessActivity` :716) que é cross-domain (overlay de ANDAMENTO). Já viaja como extra para `ipc/projects.ts` (:24/:46/:188). Vira `extras.killMaestroSession` do engine e do IPC. Âncora inicial: `^function killMaestroSession\(projectId: string\): void \{$`; final = `+9`. |
| **W1** `maestroSystemPromptFile` / `surveySystemPromptFile` | `[2774, 2781]` | 8 | Consts calculadas 1× no boot via `persistTrustedSystemPrompt` (:2764), helper genérico da pasta de prompts confiáveis. Viajam por VALOR (`string \| undefined`) nos extras — zero risco. |
| **W5** `paneSpecStaggerUntil` + `staggerPaneSpawn` | `[8019, 8026]` | 8 | É concern de **ciclo de vida de PANE**, não de maestro: `missions:paneSpec` (:8030) e `maestro:paneSpec` (:9291) usam os dois. Destino natural é o futuro `paneLifecycle`. Contém um `let` mutável (`paneSpecStaggerUntil`) — se um dia mover, exige o padrão `extras.state`. |

---

## 2. Classificação de dependências, bloco a bloco

### 2.a — Membros JÁ no `MainContext` (o engine destrutura de `ctx`)

Contagens obtidas por varredura de todos os 74 membros do `MainContext` em
cada range (falsos positivos de string/comentário já removidos à mão).

| bloco | `ctx.*` usados |
|---|---|
| W2 `preparePlanningRun` | `skillsLib` (2: `orchestratorPlanningIds`, indireto via `prepareSkillPlanInputs`), `releasePaneSkillLease` (1 — ver nota) |
| W4 resume budget | `maestro` (3), `blackbox` (1) |
| W6 `makeEmitter` | `maestro` (1: `appendLog`) |
| W7 `emitLog`/`emitLive` | `maestro` (1), `uiSender` (3) |
| W8 `sessionSink` | `maestro` (7), `maestroSessions` (2), `tasks` (1: `createMany`), `uiSender` (3), `syncBoard` (1), `emitLog` (13 — interno ao engine após a extração) |
| W9 `ensureSession` | `projects` (1), `seats` (3), `maestro` (5), `maestroSessions` (3), `emitLog` (1) |
| W10 `surveyAborts` | — (é ele próprio o `ctx.surveyAborts`, :3554) |
| W11 `surveyViaCodex` | — (só `surveyAborts` do próprio engine) |
| W13 perguntas do dono | — (é ele próprio `ctx.pendingUserQuestions` :3578 + `ctx.persistUserQuestions` :3621) |
| W12 `migrateCliSessionBetweenSeats` | **NENHUM** (função pura) |

**Nota sobre `releaseSkillLease`:** `preparePlanningRun` chama
`releaseSkillLease(input.paneId)` (:3016). É EXATAMENTE a mesma função que
`ctx.releasePaneSkillLease` — o index faz `releasePaneSkillLease = releaseSkillLease`
em :2960 (o `let` mora em :402). Na cirurgia, `releaseSkillLease` →
`ctx.releasePaneSkillLease`. **Não criar extra para isso.**

**Nota sobre `uiSender`:** precedente estabelecido (phaseEngine :506/:1151/:1590,
`ipc/tasks.ts` :212, `mcpApi/board.ts` :653) — a única mudança não-verbatim
permitida é `uiSender` → `ctx.uiSender`. Total nos blocos do engine: **6
ocorrências** (3 em W7, 3 em W8).

### 2.b — Símbolos de closure FORA do `MainContext` → `MaestroEngineExtras`

```ts
export interface MaestroEngineExtras {
  /** Escopo de módulo (:693) — mata o painel de fundo e fecha o turno do overlay. */
  killMaestroSession(projectId: string): void
  /** Escopo de módulo (:734) — encerra o turno no snapshot de ANDAMENTO. */
  finishProgressMaestroTurn(
    projectId: string,
    session: MaestroSession | CodexSession,
    force?: boolean
  ): void
  /** Valor const do boot (:2774) — política de sistema do painel claude. */
  maestroSystemPromptFile: string | undefined
  /** Infra compartilhada de skill runtime (:2973) — já é extra do phaseEngine. */
  prepareSkillPlanInputs(
    rootIds: string[],
    describe: (id: string) => Pick<PlannedSkillInput, 'operation' | 'reason' | 'required'>
  ): Promise<{ definitions: SkillDef[]; inputs: PlannedSkillInput[]; missing: string[] }>
  /** :2940 — já é extra do phaseEngine. */
  syncPaneSkillLease(
    paneId: string,
    cwd: string,
    ids: string[]
  ): Promise<{ injected: SkillDef[]; missing: string[] }>
  /** `let` late-bound do módulo (:403, atribuído em :3085) — arrow no call site. */
  releasePaneSkillPlan(paneId: string): void
  /** Instância (:2961) — já é extra do phaseEngine. */
  skillRuntime: SkillRuntime
  /** Map (:2962) — já é extra do phaseEngine. */
  skillPlanScopes: Map<
    string,
    { phase: string; phaseRun: string; agentIds: string[]; taskId?: string; projectId?: string; missionId?: string }
  >
}
```

**8 extras.** Natureza: 4 funções puras de delegação, 1 valor const, 1 `let`
late-bound (arrow obrigatória no call site — mesmo tratamento de
`releasePaneSkillPlan` no `createPhaseEngine` :9594), 1 instância de classe,
1 Map. **NENHUM `let` mutável precisa do padrão `extras.state`** — o único `let`
do domínio (`paneSpecStaggerUntil`) fica no index (bloco W5).

### 2.c — Imports de topo que o módulo novo passa a fazer

```ts
import type { WebContents } from 'electron'                      // makeEmitter
import { app } from 'electron'                                   // W13 (userData)
import { join } from 'path'                                      // W13
import { randomUUID } from 'crypto'                              // W2
import {
  parseTasks as parseTasksJson,   // W8 :8330
  PERSONA_DEV,                    // W9 :8502
  SURVEY_PROMPT,                  // W11 :8690
  SURVEY_SECURITY_PROMPT,         // W11 :8656
  toolLabel,                      // W8 :8363 · W11 :8663
  type MaestroEvent               // W6/W7/W11
} from './maestro'
import { MaestroSession, type SessionEvent } from './maestroSession' // W8/W9
import { CodexSession } from './codexSession'                        // W8/W9/W11
import { assessMissionRisk } from './orchestratorFlow'                // W8 :8335
import { loadJsonStore, persistJsonStore } from './jsonStore'         // W13
import { SYNKORA_PLANNING_STANDARD_ID } from './skillsRouting'        // W2 :3028
import { SkillRuntime, type PlannedSkillInput } from './skillRuntime' // tipos dos extras
import type { SkillDef } from './skillsLibrary'                       // tipos dos extras
import type { PendingUserQuestion } from './phaseTypes'               // W13
import type { MainContext } from './mainContext'
```

Se W12 entrar no engine, somam-se `dirname`/`relative` (path),
`copyFileSync`/`existsSync`/`mkdirSync`/`readdirSync` (fs) e `type SeatCli`
(`./seats`).

**Tipo `MaestroBackend`:** hoje é `type MaestroBackend = MaestroSession | CodexSession`
(:475, escopo de módulo do index). Como M1 **fica**, o engine re-declara o
alias localmente OU importa de `mainContext` (o `MainContext` já tipa
`maestroSessions: Map<string, MaestroSession | CodexSession>` :136). Recomendo
**exportar `MaestroBackend` do `maestroEngine.ts`** e o index passar a importar
o tipo — evita duplicação silenciosa.

### 2.d — Chamadas ao domínio MISSION (a fronteira maestro↔missão)

**Varredura executada:** 15 símbolos (`createMissionImpl`, `startMissionIntegration`,
`missionsWithIntegration`, `stopMissionExecution`, `missionWatches`,
`completeMissionMerge`, `handleMissionVerdict`, `ensureMissionWorktree`,
`missionWorkspacePath`, `emitMissionsChanged`, `cleanupMissionFiles`,
`integrateMissionImpl`, `releaseVersionImpl`, `transitionLinkedProjectPlanMission`,
`orchKey`) contra **todos os 17 ranges** (engine + IPC).

> **Resultado: ZERO ocorrências.** O domínio maestro NÃO chama nada da máquina
> de missões.

A dependência existe **só na direção oposta** — e é ela que obriga a
coordenação com o survey paralelo de missões:

| call site (domínio MISSION) | símbolo do maestro | linha |
|---|---|---|
| `missions:paneSpec` | `staggerPaneSpawn` | :8030 |
| `missions:paneSpec` | `orchKey` | :8124 |
| `missions:paneSpec` | `maestroResumeOverBudget` | :8135 |
| `missions:paneSpec` | `skipMaestroResume` | :8137 |
| `missions:paneSpec` | `preparePlanningRun` | :8143 |
| `missions:remove` | `orchKey` (`maestro.forget`) | :7966 |
| bloco de integração | `orchKey` (`maestro.forget`) | :5361 |
| bloco de integração | `orchKey` (`maestro.update`) | :5226 |

Ou seja: `ipc/missions.ts` (ou o `missionEngine`) vai precisar de
`maestroApi.maestroResumeOverBudget`, `maestroApi.skipMaestroResume` e
`maestroApi.preparePlanningRun` nos seus extras. **Ordem de corte:
maestroEngine ANTES do missionEngine** (senão o mission survey inventa
duplicatas desses três).

Único acesso "de missão" nos blocos do maestro é o **store**, não a máquina:
`maestro:pendingQuestions` chama `missions.get(...)` (:9659) para a poda
preguiçosa — `ctx.missions`, sem crossing de domínio.

### 2.e — Chamadas à máquina de fases

**Varredura executada:** 20 símbolos da `PhaseApi` + estado de fase contra
todos os ranges.

> **Resultado: 1 ocorrência — `drainPendingRespawns(projectId)` em `maestro:paneSpec` :9299.**

Já está na `PhaseApi` (`mainContext.ts` :113). Passa a ser
`ctx.phase.drainPendingRespawns(projectId)`.

> **A `PhaseApi` NÃO precisa crescer para esta extração.** Nenhuma assinatura
> nova é necessária.

(`setPhaseExecutorImpl` :8844–8988 usa fundo de fase — `phaseWatches`,
`terminateTaskPhasePane`, `preparePhasePane`, `openPhasePane`, `phaseLaunches` —
mas ele **NÃO faz parte deste corte**: fica no index, é phase/pane lifecycle.)

---

## 3. Superfície pública — a `MaestroApi`

Call sites **fora** dos ranges movidos, por função (varredura em todo
`src/main/`, incluindo `ipc/` e `mcpApi/`):

| símbolo movido | call sites externos | destino |
|---|---|---|
| `emitLog` | `ctx.emitLog` :3609 · `phaseEngine.ts` ×10 (:2007, :2148, :2173, :2730, :2741, :2766, :2792, :3394, :3731, :3825) · `mcpApi/board.ts` ×2 (:644, :645) · `ipc/harness.ts` ×2 (:32, :54) · handlers `send`/`permission`/`interrupt`/`setSeat` | **`MaestroApi.emitLog`** (o getter `ctx.emitLog` delega) |
| `emitLive` | só os handlers `send` (:8521, :8530, :8547, :8566) e `interrupt` (:8626) | **`MaestroApi.emitLive`** |
| `makeEmitter` | `setEffort` :8269 · `setContextLimit` :8278 · `survey` :8698 · `setModel` :9453 | **`MaestroApi.makeEmitter`** |
| `ensureSession` | `send` :8527 · `capabilities` :8584 — **e mais nada em `src/main/`** | **`MaestroApi.ensureSession`** |
| `sessionSink` | só `ensureSession` :8502/:8503 | **interno ao engine** (não exportar) |
| `surveyViaCodex` | `survey` :8726 | **`MaestroApi.surveyViaCodex`** |
| `surveyAborts` | `interrupt` :8614 · `survey` :8733/:8750 · (interno: :8644/:8689) | já é **`ctx.surveyAborts`** :3554 |
| `maestroResumeOverBudget` | `missions:paneSpec` :8135 · `maestro:paneSpec` :9346 | **`MaestroApi.maestroResumeOverBudget`** |
| `skipMaestroResume` | `missions:paneSpec` :8137 · `maestro:paneSpec` :9348 | **`MaestroApi.skipMaestroResume`** |
| `preparePlanningRun` | `missions:paneSpec` :8143 · `maestro:paneSpec` :9354 | **`MaestroApi.preparePlanningRun`** |
| `pendingUserQuestions` | `progressSnapshotSource` (index :2694) · `ctx` :3578 · `mcpApi/panes.ts` :52/:167 (via ctx) · handlers :9657/:9664/:9669/:9673 | já é **`ctx.pendingUserQuestions`** |
| `persistUserQuestions` | `ctx` :3621 · `mcpApi/panes.ts` :57/:173 (via ctx) · handlers :9668/:9674 | já é **`ctx.persistUserQuestions`** |
| `migrateCliSessionBetweenSeats` (se mover) | `setPhaseExecutorImpl` :8890 (**fica no index**) · `maestro:setSeat` :9016 | **`MaestroApi.migrateCliSessionBetweenSeats`** ou módulo puro |

**Nada em `mcpApi/` chama `ensureSession`** (verificado). As HubDeps NÃO tocam
`ensureSession`; o que elas capturam é `maestroPaneId`/`orchPaneId`
(`hub.maestroPaneOf` :3379–3385), e esses **ficam no index** (ver §5.2).

### Assinatura proposta

```ts
export type MaestroEngine = ReturnType<typeof createMaestroEngine>

export interface MaestroApi {
  // ——— log/live do painel do Maestro ———
  emitLog(projectId: string, evt: MaestroEvent): void
  emitLive(evt: unknown): void
  makeEmitter(sender: WebContents, projectId: string): (evt: MaestroEvent) => void

  // ——— painel de fundo (claude stream-json | codex app-server) ———
  ensureSession(projectId: string, seatId?: string): MaestroBackend | null

  // ——— /estudar ———
  readonly surveyAborts: Map<string, () => void>
  surveyViaCodex(
    projectId: string,
    cwd: string,
    configDir: string | undefined,
    onTool: (evt: MaestroEvent) => void
  ): Promise<string>

  // ——— teto de custo do resume (PM e orquestrador) ———
  maestroResumeOverBudget(key: string): number | undefined
  skipMaestroResume(
    key: string,
    overBudget: number,
    ids: { projectId: string; missionId?: string; paneId: string }
  ): void

  // ——— método nativo de planejamento (PM e orquestrador) ———
  preparePlanningRun(input: {
    paneId: string
    projectId: string
    missionId?: string
    cwd: string
  }): Promise<{ ok: true; phaseRun: string; skillBlock: string } | { ok: false; message: string }>

  // ——— perguntas dirigidas ao dono (tool ask_user) ———
  readonly pendingUserQuestions: Map<string, PendingUserQuestion>
  persistUserQuestions(): void

  // ——— opcional (ver W12) ———
  migrateCliSessionBetweenSeats(
    cli: SeatCli,
    fromSeatId: string,
    toSeatId: string,
    cwd: string,
    sessionId: string
  ): boolean
}
```

---

## 4. Os 18 handlers `maestro:*` → `src/main/ipc/maestro.ts`

Todos confirmados por grep. `registerMaestroIpc` é chamado no bloco único do
`whenReady` (:11569–11721) — `instrumentIpcMain` roda em :2363 (topo de módulo,
antes de tudo), então **a mudança de ordem de registro é inócua** para a cerca
viva da Fase 0.

| # | canal | range | linhas | âncora inicial (1×) | âncora final |
|---|---|---|---|---|---|
| 1 | `maestro:cleanup` | `[7882, 7894]` | 13 | `^  ipcMain\.handle\('maestro:cleanup', \(e, projectId: string\) => \{$` | :7893 `` ^    return `🧹 \$\{removed\} arquivo\(s\) sem uso removido\(s\) do \.synkora`$ `` (+1) |
| 2 | `maestro:getState` | `[8247, 8263]` | 17 | `^  ipcMain\.handle\('maestro:getState', \(e, projectId: string\) => \{$` | :8261 `^      version: state\.version \?\? null$` (+2) |
| 3 | `maestro:setEffort` | `[8265, 8273]` | 9 | `^  ipcMain\.handle\('maestro:setEffort', \(e, projectId: string, effort: string\) => \{$` | :8271 `` ^      text: `effort do maestro: \$\{effort \|\| 'padrão do modelo'\}`$ `` (+2) |
| 4 | `maestro:setContextLimit` | `[8275, 8285]` | 11 | `^  ipcMain\.handle\('maestro:setContextLimit', \(e, projectId: string, limit: number\) => \{$` | :8283 `^          : 'medidor de contexto no automático \(janela real do modelo\)'$` (+2) |
| 5 | `maestro:send` | `[8514, 8578]` | 65 | :8515 `^    'maestro:send',$` (**−1**: o `ipcMain.handle(` está em :8514) | :8572 `^        session\.send\(message\)$` (+6) |
| 6 | `maestro:capabilities` | `[8580, 8587]` | 8 | :8580 `^  // Capacidades reais do painel \(comandos, modelos, conta\) — spawna o painel$` | :8586 `^    return session\.waitCaps\(\)$` (+1) |
| 7 | `maestro:permission` | `[8589, 8607]` | 19 | :8590 `^    'maestro:permission',$` (**−1**) | :8603 `` ^          text: `\$\{verdict\} — \$\{info\.toolName\} \$\{info\.description\}`\.trim\(\)$ `` (+4) |
| 8 | `maestro:interrupt` | `[8612, 8628]` | 17 | `^  ipcMain\.handle\('maestro:interrupt', \(e, projectId: string\) => \{$` | :8625 `^      emitLog\(projectId, \{ kind: 'log', tag: 'maestro', text: 'nada rodando para interromper' \}\)$` (+3) |
| 9 | `maestro:survey` | `[8694, 8754]` | 61 | :8695 `^    'maestro:survey',$` (**−1**) | :8751 `^        endProgressHeadlessActivity\(projectId, 'survey', progressSurveyToken\)$` (+3) |
| 10 | `maestro:reset` | `[8756, 8759]` | 4 | `^  ipcMain\.handle\('maestro:reset', \(_e, projectId: string\) => \{$` | :8758 `^    maestro\.clear\(projectId\)$` (+1) |
| 11 | `maestro:getReviewer` | `[8761, 8770]` | 10 | :8761 `^  // Seat do Maestro é escolhido NA ENTRADA do projeto \(gate\) e persistido\.$` | :8768 `^      effort: s\.reviewerEffort \?\? null$` (+2) |
| 12 | `maestro:setReviewer` | `[8771, 8780]` | 10 | :8772 `^    'maestro:setReviewer',$` (**−1**) | :8777 `^        reviewerEffort: effort \|\| undefined$` (+3) |
| 13 | `maestro:setSeat` | `[8990, 9047]` | 58 | `^  ipcMain\.handle\('maestro:setSeat', \(e, projectId: string, seatId: string, model\?: string, effort\?: string\) => \{$` | :9045 `` ^        : `seat trocado de \$\{prevSeat\?\.name \?\? prev\} para \$\{seat\?\.name \?\? seatId\} sem migração \(CLI diferente ou sem sessão\)`$ `` (+2) |
| 14 | `maestro:paneSpec` | `[9289, 9449]` | 161 | `^  ipcMain\.handle\('maestro:paneSpec', async \(e, projectId: string\) => \{$` | :9447 `^      model: state\.model$` (+2) |
| 15 | `maestro:setModel` | `[9451, 9468]` | 18 | `^  ipcMain\.handle\('maestro:setModel', async \(e, projectId: string, model: string\) => \{$` | :9467 `` ^    emit\(\{ kind: 'ok', text: `modelo do maestro: \$\{model \|\| 'padrão do seat'\}` \}\)$ `` (+1) |
| 16 | `maestro:pendingQuestions` | `[9652, 9670]` | 19 | `^  ipcMain\.handle\('maestro:pendingQuestions', \(e, projectId: string\) => \{$` | :9669 `^    return \[\.\.\.pendingUserQuestions\.values\(\)\]\.filter\(\(q\) => q\.projectId === projectId\)$` (+1) |
| 17 | `maestro:questionSeen` | `[9671, 9678]` | 8 | `^  ipcMain\.handle\('maestro:questionSeen', \(e, projectId: string, missionKey: string\) => \{$` | :9673 `` ^    if \(pendingUserQuestions\.delete\(`\$\{projectId\}--\$\{missionKey\}`\)\) \{$ `` (+5) ⚠️ NÃO usar `^    return true$` (5×) |
| 18 | `maestro:setVersion` | `[9938, 9949]` | 12 | :9938 `^  // Versão atual do projeto: tarefas novas são carimbadas com ela \(filtro do$` | :9946 `` ^      text: version\.trim\(\) \? `versão atual do projeto: \$\{version\.trim\(\)\}` : 'versão do projeto limpa',$ `` (+3) |

⚠️ Âncora proibida para os handlers 5, 7, 9 e 12: `^  ipcMain\.handle\($` casa
**8×** no arquivo (:7079, :7109, :7187, …). Usar a linha do canal com offset −1.

### 4.b — `MaestroIpcExtras` (além de `ctx` + `MaestroApi`)

```ts
export interface MaestroIpcExtras {
  // guarda de canal (padrão de todos os ipc/*)
  bindUiSender(sender: Electron.WebContents): void            // 12 handlers

  // maestro:cleanup
  sweepProjectFiles(
    projectId: string,
    opts?: { preserveInterruptedHelpers?: boolean }
  ): number                                                    // :7776

  // maestro:setEffort · reset · send · survey · setSeat · setModel
  killMaestroSession(projectId: string): void                  // :693

  // maestro:send
  beginProgressMaestroTurn(projectId: string, session: MaestroBackend): void   // :729
  finishProgressMaestroTurn(projectId: string, session: MaestroBackend, force?: boolean): void // :734

  // maestro:survey
  beginProgressHeadlessActivity(projectId: string, kind: 'conversation' | 'survey'): number   // :704
  endProgressHeadlessActivity(projectId: string, kind: 'conversation' | 'survey', token?: number): void // :716
  surveySystemPromptFile: string | undefined                   // :2778

  // maestro:setSeat  (se W12 NÃO for para o engine)
  migrateCliSessionBetweenSeats(
    cli: SeatCli, fromSeatId: string, toSeatId: string, cwd: string, sessionId: string
  ): boolean                                                   // :8790

  // maestro:paneSpec
  staggerPaneSpawn(): Promise<void>                            // :8020
  armPane(
    identity: Omit<PaneIdentity, 'paneId'> & { paneId?: string },
    cli: SeatCli,
    opts?: { strictMcp?: boolean; configDir?: string; sensitive?: boolean }
  ): { paneId: string; cliArgs: string[] }                     // :3917  (FICA no index — futuro paneLifecycle)
  releasePaneSkillPlan(paneId: string): void                   // :403/:3085
  codexDeveloperInstructions(value: string): string            // :333
  projectLifecycleOf(projectId: string): string                // :3326
}
```

**14 extras** (13 se `migrateCliSessionBetweenSeats` virar membro da
`MaestroApi`). Compartilhados com o engine: `killMaestroSession`,
`finishProgressMaestroTurn`, `releasePaneSkillPlan` → **19 extras distintos no total**.

Já resolvidos por **import de topo** no novo `ipc/maestro.ts` (não são extras):
`ensureSynkoraGitExcludes` (`../worktree`), `ensureProjectSecurityBaseline`,
`ensureGreenfieldProjectPlan` (`../projectPlan`), `redactSensitiveText`
(`../securityRedaction`), `maestroProjectPersona` / `survey` / `type MaestroEvent`
(`../maestro`), `MaestroSession` / `type PermissionChoice` (`../maestroSession`),
`CodexSession`, `mkdirSync`/`writeFileSync` (`fs`), `join` (`path`).

Guardas: **nenhum handler `maestro:*` usa `assertMainRendererSender` nem os
guards de voz** — o padrão do domínio é `bindUiSender(e.sender)`, presente em
**13 dos 18** handlers. Os **5 que NÃO chamam** (contagem verificada por grep):
`maestro:setEffort`, `maestro:setContextLimit`, `maestro:reset`,
`maestro:getReviewer`, `maestro:setReviewer`. **Não "harmonizar" isso na
cirurgia**: a assimetria é o comportamento atual e mexer nela é mudança de
semântica, não movimentação.

---

## 5. Riscos, no formato do `phaseEngine`

### 5.1 — Hoisting / TDZ

O que hoje funciona **só por hoisting de `function`** e vira `const`
destruturado do engine:

| símbolo | forma hoje | consumidor que roda ANTES da declaração | veredito |
|---|---|---|---|
| `emitLog` | `function` :8289 | `ctx.emitLog` (:3609, arrow) · `phaseEngine` (via ctx) · `sessionSink` :8311… | ✅ seguro: todo consumidor é arrow/callback, nenhum roda no corpo síncrono do `whenReady` |
| `emitLive` | `function` :8293 | idem | ✅ |
| `makeEmitter` | `function` :8240 | handlers (:8269, :8278) registrados ANTES da declaração | ✅ registro ≠ execução |
| `sessionSink` | `function` :8298 | `ensureSession` :8502 | ✅ interno |
| `ensureSession` | `function` :8449 | `maestro:send` (:8527) registrado em :8514, ANTES de :8449? **NÃO** — :8514 > :8449 | ✅ |
| `surveyViaCodex` | `function` :8632 | `maestro:survey` :8726 | ✅ |
| `maestroResumeOverBudget` / `skipMaestroResume` | `function` :7989/:7995 | `missions:paneSpec` :8135/:8137 (registrado DEPOIS) | ✅ |
| `preparePlanningRun` | `const` :3003 | :8143 / :9354 (arrow-deferred) | ✅ |
| `surveyAborts` | `const` :8610 | `ctx.surveyAborts` getter :3554 — **hoje já é TDZ-por-getter e funciona** | ✅ |
| `pendingUserQuestions` | `const` :9635 | `progressSnapshotSource` :2694 (só executa no `boot:progressSnapshot` :11725) · `ctx` :3578 | ✅ **melhora**: se o engine nascer junto do `phaseEngine` (:9580), a Map existe 55 linhas mais CEDO que hoje |

**Ponto de construção recomendado do `createMaestroEngine`: imediatamente ANTES
do `createPhaseEngine` (:9580).** Motivos:
1. `ctx` já existe (construído até :3650).
2. Todos os consumidores até lá são arrows/handlers.
3. `syncBoard` (`function` :9482) chama `syncMaestroProjectLifecycle` :9545 —
  se um dia esse helper mudar de casa, o primeiro `syncBoard` real é o
  `boot:project-sweep` :11557, folgadamente depois.

⚠️ **Armadilha real:** `maestro:cleanup` (:7882) e o bloco W4 (:7980) estão
ANTES do ponto de construção. Ao mover `maestroResumeOverBudget`/`skipMaestroResume`
para o engine, o call site `missions:paneSpec` :8135/:8137 passará a ler um
`const` declarado em :9580. Como :8135 está dentro de um handler async, é
seguro — mas **um script de corte que reordene blocos deve preservar essa
propriedade**. Não mover NADA do maestro para o corpo síncrono de boot.

### 5.2 — Símbolos maestro-adjacentes que **NÃO** podem ir no primeiro corte

- `maestroPaneId` (:3317), `orchKey` (:3323), `orchPaneId` (:3324),
  `projectLifecycleOf` (:3326), `syncMaestroProjectLifecycle` (:3336–3356).
  São funções puras de string + um notificador, declaradas **entre o hub e o
  ctx**, e `hub.maestroPaneOf` (:3379–3385) as captura. `orchKey`/`orchPaneId`
  têm 9 call sites no domínio de MISSÃO (:5226, :5361, :6904, :7124, :7128,
  :7243, :7941, :7966, :8053, :8124, :8133) — movê-las para o `maestroEngine`
  criaria dependência mission→maestro onde hoje não há nenhuma.
  **Recomendação:** commit separado extraindo `maestroPaneId`/`orchKey`/
  `orchPaneId` para um módulo PURO (`paneKeys.ts`), fora dos dois engines.
- `armPane` (:3917) e `mcpPaneArgs` (:3834) — **excluídos por ordem explícita**;
  destino é o futuro `paneLifecycle`. `maestro:paneSpec` os consome por extra.
- Recovery de boot e handlers de `pty` — excluídos.
- `setPhaseExecutorImpl` (:8844–8988) — sanduichado ENTRE
  `migrateCliSessionBetweenSeats` (:8784) e `maestro:setSeat` (:8990). É
  phase/pane domain e já viaja como extra para `ipc/tasks.ts` (:46). **Fica.**

### 5.3 — Timers, watchers e caches

- **Não existe cache de capabilities no index.** `maestro:capabilities` (:8582)
  é `ensureSession(...).waitCaps()` puro — o cache mora dentro da
  `MaestroSession`/`CodexSession`. Nada a mover, nada a invalidar.
  (O cache de 5 min é do `seatUsage.ts` — domínio de SEATS, não maestro.)
- **`sessionStats.watch` NÃO pertence ao maestro.** Ele é registrado dentro do
  handler `pty:create` (:9971, EXCLUÍDO) — ver 5.5.
- **Único timer do domínio:** `staggerPaneSpawn` (:8025, `setTimeout` de ≤350ms)
  — e ele **fica no index** (bloco W5).
- `surveyAborts` guarda **callbacks de kill**, não timers. O `survey()` de
  `maestro.ts` tem `setTimeout` interno (:430) e expõe `registerKill` (:373/:507)
  — o ciclo de vida é do próprio módulo; o engine só guarda o kill no Map.
- `progressHeadlessActivities` / `progressMaestroTurnTokens` (:483/:487) são
  estado do **overlay de ANDAMENTO**, limpos no `window-all-closed` (:11765).
  Ficam no index; o engine os toca só via `finishProgressMaestroTurn`.

### 5.4 — Estado escrito de FORA do domínio

| estado | quem escreve de fora | como |
|---|---|---|
| `pendingUserQuestions` | **`mcpApi/panes.ts` :167** (tool `ask_user`) — `pendingUserQuestions.set(...)` + `persistUserQuestions()` :173 | via `ctx` (:52/:57). **Nada quebra**: a Map continua exposta por `ctx.pendingUserQuestions` (getter :3578) e `ctx.persistUserQuestions` (:3621), agora delegando ao engine. `mcpApi/panes.ts` também envia `maestro:userQuestion` direto (`ctx.uiSender.send`, :182) — canal de push, não estado. |
| `maestroSessions` | `window-all-closed` :11763–11764 (`kill()` + `clear()`) — **escopo de módulo, fora do `whenReady`** | é O motivo de M1 ficar (§1b). |
| `maestro` store — `tuiSessionId` / `tuiContextTokens` | **handler `pty:create`, EXCLUÍDO** — ver 5.5 | |
| `maestro` store — `seatId`/`model`/`effort` | `ipc/projects.ts` :188 (`killMaestroSession` na relocação) | já é extra |
| `surveyAborts` | **ninguém de fora** | ✅ ilha |

### 5.5 — `MAESTRO_RESUME_BUDGET_TOKENS`, `tuiContextTokens` e a invalidação por `/clear`

Três mecanismos do maestro que **moram no handler `pty:create` (:9971) e por
ordem explícita NÃO se movem** — mas precisam ficar registrados porque o corte
não pode quebrá-los:

1. **Carimbo de `tuiContextTokens`** — `stampMaestroContext` :10684–10689
   (throttle 25k), chamado no `onStats` :10700. Escreve
   `maestro.update(paneId.slice('maestro-'.length), { tuiContextTokens })`. É
   ele que ALIMENTA o `maestroResumeOverBudget` (bloco W4, que vai para o
   engine). **Acoplamento por chave de string (`maestro-<key>`), não por
   símbolo** — o corte é seguro, mas a regra "a chave do maestroStore é o
   paneId sem o prefixo `maestro-`" fica implícita em dois arquivos. Anotar no
   cabeçalho do `maestroEngine.ts`.
2. **`onSession`** :10702–10715 — persiste `tuiSessionId` e ZERA
   `tuiContextTokens` quando a sessão muda (o carimbo da conversa antiga não
   pode vetar o resume barato da nova).
3. **`onCommand`** :10282–10328 (`/clear` claude, `/new`|`/fork` codex) e
   **`onResumeFail`** :10256–10277 — invalidam `tuiSessionId` +
   `tuiContextTokens` para panes `maestro-*`. Quem REGISTRA esses callbacks é
   o `pty:create`, não o maestro.

**Conclusão:** o teto de resume é escrito no `pty:create` e lido no
`maestroEngine`. O corte é seguro (comunicação via `maestro` store), mas é a
costura mais frágil do domínio — qualquer refatoração futura do `pty:create`
tem que preservar o prefixo `maestro-`.

### 5.6 — Não-verbatim autorizado (e só isso)

1. `uiSender` → `ctx.uiSender` (6 ocorrências no engine; 3 nos handlers) —
   precedente `phaseEngine` :506/:1151/:1590.
2. `releaseSkillLease` → `ctx.releasePaneSkillLease` (1 ocorrência, :3016) —
   são a MESMA função (:2960).
3. Destruturação de `ctx`/`extras` no topo de cada função exportada.

**Qualquer outra alteração de texto é bug de cirurgia, não refatoração.**

---

## 6. Plano de corte recomendado

Cinco commits, do mais isolado ao mais acoplado. Typecheck verde obrigatório em
cada um; app PARADO (mudanças em `src/main` só entram no próximo `npm run dev`).

### Commit A — `cliSessionTransplant.ts` (opcional, mas recomendado primeiro)
Move W12 (`[8784, 8838]`, 55 linhas) para um módulo PURO. Zero dependências de
closure. Os dois call sites (`setPhaseExecutorImpl` :8890 e `maestro:setSeat`
:9016) passam a importar do módulo — e o maestro deixa de dever nada ao phase
domain. Também re-ancora o comentário órfão :8782–8783 no handler `setSeat`.
**Ganho colateral: tira `migrateCliSessionBetweenSeats` da `MaestroApi`.**

### Commit B — `maestroEngine.ts`, núcleo de sessão (W6 · W7 · W8 · W9 · W10 · W11)
`makeEmitter` + `emitLog`/`emitLive` + `sessionSink` + `ensureSession` +
`surveyAborts` + `surveyViaCodex` = **295 linhas**, 6 blocos CONTÍGUOS em
`[8240, 8692]` com apenas os handlers 2–8 intercalados. É a ilha mais limpa:
zero mission, zero phase, extras = `killMaestroSession`,
`finishProgressMaestroTurn`, `maestroSystemPromptFile`.
Index passa a ter os aliases `const { emitLog, emitLive, makeEmitter,
ensureSession, surveyViaCodex, surveyAborts } = maestroEngine`.

### Commit C — `maestroEngine.ts`, planejamento e memória (W2 · W4 · W13)
`preparePlanningRun` (:3002–3084) + teto de resume (:7980–8009) + perguntas do
dono (:9629–9651) = **136 linhas**. Aqui entram os extras de skill runtime
(`prepareSkillPlanInputs`, `syncPaneSkillLease`, `releasePaneSkillPlan`,
`skillRuntime`, `skillPlanScopes`) — os MESMOS 5 que o `createPhaseEngine`
(:9591–9596) já recebe. **Este é o commit que o survey de MISSÕES espera:**
`missions:paneSpec` (:8135/:8137/:8143) passa a chamar
`maestroApi.maestroResumeOverBudget` / `.skipMaestroResume` / `.preparePlanningRun`.

### Commit D — `ipc/maestro.ts`, os 14 handlers simples
Todos menos `paneSpec`, `send`, `survey` e `setSeat`: canais 1–4, 6–7, 10–12,
15–18 = **~150 linhas**. Extras mínimos (`bindUiSender`, `sweepProjectFiles`,
`killMaestroSession`) + `MaestroApi`.

### Commit E — `ipc/maestro.ts`, os 4 handlers pesados
`maestro:send` (65) · `maestro:survey` (61) · `maestro:setSeat` (58) ·
`maestro:paneSpec` (161) = **345 linhas**. São os que carregam a cauda de
extras (`begin/finishProgressMaestroTurn`, `begin/endProgressHeadlessActivity`,
`surveySystemPromptFile`, `staggerPaneSpawn`, `armPane`, `releasePaneSkillPlan`,
`codexDeveloperInstructions`, `projectLifecycleOf`) e o único crossing de fase
(`ctx.phase.drainPendingRespawns`).

### Coordenação com o survey PARALELO de MISSÕES

**Código interleaved que força ordem de corte:**

1. **`missions:paneSpec` `[8028, 8238]` × maestro.** É o único ponto onde os
   dois domínios se tocam. O bloco W4 (`[7980, 8009]`) e `staggerPaneSpawn`
   (`[8019, 8026]`) estão **encravados entre `missions:remove` (:7899–7978) e
   `missions:paneSpec` (:8028)** — um corte de missões por range que engula
   `[7899, 8238]` inteiro levaria o teto de resume junto **por acidente**.
   ➜ **Regra: o Commit C (maestro) roda ANTES de qualquer corte de missões.**

2. **`maestro:paneSpec` × `missions:paneSpec` — helpers compartilhados.**
   Confirmado por leitura lado a lado: os dois compartilham **8 helpers** —
   `staggerPaneSpawn`, `unregisterPane`, `preparePlanningRun`,
   `maestroResumeOverBudget`, `skipMaestroResume`, `armPane`,
   `releasePaneSkillLease`/`releasePaneSkillPlan`, `codexDeveloperInstructions`
   — e a mesma sequência de montagem (persona + `planningRun.skillBlock` →
   `armPane` → `--effort`/`-c model_reasoning_effort` → `--resume`/`resume` →
   `initialPrompt`). **NÃO existe hoje um "paneSpec builder" comum**; é
   duplicação estrutural de ~40 linhas.
   ➜ **Onde cada helper deve morar:**
   | helper | casa recomendada |
   |---|---|
   | `preparePlanningRun`, `maestroResumeOverBudget`, `skipMaestroResume` | **`maestroEngine`** (a mecânica de PM/orquestrador é a mesma — chave `projectId` vs `orchKey`) |
   | `staggerPaneSpawn`, `armPane`, `mcpPaneArgs`, `codexDeveloperInstructions` | **index → futuro `paneLifecycle`** (nem maestro nem missão) |
   | `releasePaneSkillLease` / `releasePaneSkillPlan` | index (skill runtime), já são `ctx`/extra |
   | `maestroPaneId` / `orchKey` / `orchPaneId` | **módulo puro `paneKeys.ts`** (commit próprio) |
   ➜ **NÃO tentar unificar os dois `paneSpec` num builder comum nesta fase.**
   Os textos de intro divergem (greenfield/discovery vs goal rico/magro), a
   persona vem de fontes diferentes (`maestroProjectPersona` vs `missionPersona`)
   e a missão tem `ensureMissionWorktree`/`missionMergePrecheck` no meio.
   Unificação é refatoração de comportamento — assunto de outra fase.

3. **`orchKey` (:3323) é lido por missões em 5 lugares** (:5226, :5361, :7124,
   :7966, :8124). Se o survey de missões propuser levá-lo, **coordenar**: ele
   é irmão de `maestroPaneId`, e a decisão deste mapa é módulo puro à parte.

---

## 7. Checklist de verificação pós-corte

- [ ] `npm run typecheck` verde.
- [ ] `grep -c "ipcMain.handle('maestro:" src/main/index.ts` = **0** e
      `src/main/ipc/maestro.ts` = 14 (+4 no formato `ipcMain.handle(\n 'maestro:x',`).
- [ ] `registerMaestroIpc(ctx, {...})` está no bloco de :11569–11721, **nunca** no import.
- [ ] `ctx.emitLog` / `ctx.surveyAborts` / `ctx.pendingUserQuestions` /
      `ctx.persistUserQuestions` continuam existindo com a MESMA forma
      (`mainContext.ts` intocado — esta extração **não muda o `MainContext`**).
- [ ] `phaseEngine.ts`, `mcpApi/board.ts`, `ipc/harness.ts` seguem chamando
      `emitLog` via `ctx` sem alteração de texto.
- [ ] `mcpApi/panes.ts` (tool `ask_user`) continua escrevendo em
      `ctx.pendingUserQuestions` e chamando `ctx.persistUserQuestions()`.
- [ ] `PhaseApi` **não** ganhou nenhum membro.
- [ ] Suítes: `test:orchestrator-flow`, `test:mission-verification`,
      `test:pane-permissions`, `test:stall-attribution`.
- [ ] Ao vivo: abrir projeto (`maestro:paneSpec` → pane do PM nasce), `/estudar`
      (survey + ⏹), trocar seat do PM (`maestro:setSeat` com transplante),
      `ask_user` de um orquestrador → aba pulsa e sobrevive a restart.
