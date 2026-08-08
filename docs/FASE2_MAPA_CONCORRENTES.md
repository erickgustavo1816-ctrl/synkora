# MAPA DOS CONCORRENTES DO VEREDITO — Fase 2 (advancePhase async + lock por card)

Varredura **READ-ONLY** do estado compartilhado da transação de veredito, feita
para o plano formal da **Fase 2 do nível 5** (docs/PLANO_NIVEL_5.md :352 —
"veredito sem barreira síncrona"). Nos moldes de
docs/FASE1_MAPA_MISSIONENGINE.md e docs/FASE1_MAPA_PANELIFECYCLE.md.

Branch `nivel5-fase1`, HEAD `2ac4ad6`. Arquivos de referência:
`src/main/phaseEngine.ts` (4.114 L), `src/main/index.ts` (6.658 L),
`src/main/mcpApi/report.ts` (767 L), `src/main/mcpApi/board.ts` (1.707 L),
`src/main/ipc/pty.ts` (954 L), `src/main/paneLifecycle.ts` (687 L),
`src/main/missionEngine.ts` (2.253 L), `src/main/mcpApi/code.ts` (362 L).

**Nenhum arquivo de código foi alterado.** Toda âncora citada aqui foi
re-conferida por `grep -cE` imediatamente antes da escrita, e a contagem de
match está declarada em cada tabela. Números de linha são cortesia — a âncora
regex é o que se procura.

---

## 0. Sumário executivo

| item | valor |
| --- | --- |
| sites de código que leem/escrevem `phaseWatches` | **66** (+2 iterações que não casam `phaseWatches.`) |
| módulos envolvidos | **12** (phaseEngine, report, code, board, panes, helpers, ipc/pty, ipc/tasks, ipc/projects, paneLifecycle, missionEngine, index) |
| call sites de `advancePhase` | **3** (report ×2, poller ×1) |
| pontos que hoje entram na transação | **2** (tool MCP `report`, poller de 3s do marcador `.done`) |
| o que garante a atomicidade HOJE | `detach` + corpo do `advancePhase` **na mesma pilha síncrona** (zero await) |
| entrantes que voltam a ser possíveis pós-conversão | **11** classes (§7) |
| mutadores que precisam ADQUIRIR o lock | **6** |
| mutadores que precisam ser RECUSADOS durante o lock | **5** |
| mutadores ortogonais (nada a fazer) | **7** |
| buracos que **já existem hoje** (pré-conversão) | **3** (§7.1, §7.9, §7.10) |
| divergência doc × código encontrada | **1** — `phase-watch-repaired` não existe mais no código (§3.4) |

**Achado estrutural.** A atomicidade do veredito não é garantida por nenhuma
estrutura: é um **efeito colateral do `advancePhase` ser síncrono**. Todos os
~20 guards espalhados pelo main que perguntam "esta carta está livre?" fazem
isso lendo `phaseWatches.has(taskId)` / `.get(taskId)` — e o primeiro ato da
transação é justamente **remover a carta do registry** (`detach`). Ou seja:
durante a transação, o card parece **OCIOSO** para o app inteiro. Hoje isso é
inofensivo porque a janela dura zero ticks. Pós-conversão, essa janela passa a
conter awaits de git (`gitOff`), e o card "ocioso" fica visível para o poller,
para o `run_task`, para o respawn de boot, para o `delegate`, para o
`pty:create` e para a vassoura de arquivos.

Corolário para o desenho: **o lock por card não pode ser um detalhe interno do
`advancePhase`.** Ele precisa ser um estado *consultável* — "esta carta está em
transição" — porque a ausência do watch deixou de significar "livre".

---

## 1. O estado compartilhado da transação

### 1.1 `phaseWatches` — o registry (fonte única)

Nasce em `phaseEngine.ts`; o `MainContext` o expõe com o tipo estrutural
`Map<string, PhaseWatch> & { detach(taskId): boolean }` (mainContext.ts :180)
para não criar ciclo de import.

| âncora (`grep -cE` = 1) | arquivo:linha | papel |
| --- | --- | --- |
| `class PhaseWatchRegistry extends Map<string, PhaseWatch> \{` | phaseEngine.ts:423 | subclasse com 3 contratos |
| `const phaseWatches = new PhaseWatchRegistry\(\)` | phaseEngine.ts:447 | a instância única |
| `    detach\(taskId: string\): boolean \{` | phaseEngine.ts:443 | remove **só a indexação** |

Os três contratos da subclasse:

- **`set(taskId, watch)`** — se já havia um watch com `reviewArtifact` de
  caminho DIFERENTE, o artefato antigo é apagado do disco
  (`cleanupReviewArtifact(previous)`). Isto é: `set` tem **efeito colateral em
  disco**. Um rollback que re-indexa o MESMO objeto (`privatePath` idêntico)
  **não** apaga nada — é por isso que os rollbacks funcionam.
- **`delete(taskId)`** — apaga o `reviewArtifact` do watch removido.
- **`detach(taskId)`** — `super.delete` puro, **sem** tocar no artefato: o
  `advancePhase` continua dono dele até aceitar (`cleanupReviewArtifact`
  explícito nos ramos de veredito) ou restaurar a rodada.

> **Consequência para a Fase 2:** o par `detach → advancePhase` não é apenas
> "quem chega primeiro"; é uma **transferência de propriedade do artefato de
> review**. Se o lock passar a ser o dono da transação, ele herda essa
> responsabilidade: abortar o lock sem `set` de rollback vaza o `.diff`
> privado no `userData` (só o `sweepReviewArtifactsOnce` do boot limpa —
> phaseEngine.ts:297).

### 1.2 O campo `createdAt` (a janela de graça)

`PhaseWatch.createdAt` (phaseTypes.ts :54, com o comentário da corrida real de
2026-08-06) é gravado em **3** lugares — `grep -cE 'createdAt: Date\.now\(\)'`
= 3 em `src/main`:

| arquivo:linha | quem cria |
| --- | --- |
| phaseEngine.ts:1121 | `preparePhasePaneInner` (nascimento normal da fase) |
| phaseEngine.ts:2444 | `recoverFinalizingTask` (watch **sintético**, nunca indexado) |
| mcpApi/code.ts:152 | re-entrega sancionada (`redelivery-accepted`) |

Todos os **`set` de reciclo/rollback preservam o `createdAt` original** (spread
do watch antigo ou o mesmo objeto). Isso importa: um rollback pós-await
devolve ao registry um watch cujo `createdAt` já venceu a graça de 30s, e a
próxima varredura do poller pode julgá-lo stale (§7.4).

### 1.3 Os demais mapas vivos que a transação toca

| estrutura | dono | vida | tocado pelo veredito? |
| --- | --- | --- | --- |
| `liveGateWaits` | phaseEngine.ts:1735 | memória | **sim** — `delete` em 5 ramos, `set` no ramo de reprovação limpa |
| `gateDeathLog` | phaseEngine.ts:1739 | memória | não diretamente (escrito só por `recordGateDeath`) |
| `gateCooldownUntil` | phaseEngine.ts:1740 | memória | não (lido pelo `run_task`) |
| `phaseMarkersProcessing` | phaseEngine.ts:3841 | memória | **sim** — trava do poller |
| `phaseLaunches` (`PhaseLaunchGuard`) | phaseEngine.ts:448 | memória | indiretamente (o veredito abre fases sem token) |
| `phaseLaunchCapacity` | phaseEngine.ts:449 | memória | indiretamente (contagem derivada de `phaseWatches`) |
| `bootRespawnsPending` | phaseEngine.ts:1820 | memória | não escreve; o drain **lê** `phaseWatches` |
| `skillPlanScopes` / `SkillRuntime` | extras | memória | **sim** — `acceptance.commitRuntime()` |
| `livePaneSpecs` / `closingPaneIds` | paneLifecycle.ts:~470 | memória | via `terminatePaneNow` |
| runtime do QA (`qaRuntime`) | qaRuntime.ts | processo | via `stopQaRuntime` no `terminateTaskPhasePane` |
| `tasks.json` (`TaskStore`) | tasks.ts | **disco atômico** | **sim** — é o commit da transação |
| marcador `.done` / `.verdict` | `.synkora/runs/` | **disco** | **sim** — `unlinkSync` nas duas entradas |
| `integrationReceipt` no card | tasks.json | **disco atômico** | **sim** — no `finalizeTask` (pós-veredito) |

`TaskStore.update`/`updateMany` persistem por `persistJsonStore` →
`atomicWrite` (tmp + `renameSync`) + `.bak` (jsonStore.ts :9-34). Os hooks
`tasks.onMutation/onCreate/onRemove` (index.ts :2428, :2456, :2472) **só
gravam na caixa-preta** — nenhuma reentrância escondida a partir de um
`tasks.update`.

---

## 2. Inventário COMPLETO dos leitores/escritores de `phaseWatches`

`grep -n "phaseWatches\." src/main --include=*.ts` → **66 sites de código**
(mais 2 iterações que não casam o padrão: `for (const [tid, watch] of
phaseWatches)` em ipc/projects.ts:193 e `for (const [taskId, watch] of
[...phaseWatches])` em phaseEngine.ts:3848).

Legenda da coluna **conc.** (pode rodar ao mesmo tempo que um veredito em voo,
DEPOIS da conversão?): `SIM` = sim e é perigoso · `sim*` = sim, mas hoje já é
protegido por outra guarda · `não` = impossível por desenho (boot antes da
janela, mesma pilha síncrona).

### 2.1 `phaseEngine.ts` — 30 sites (o dono)

| linha | função | op | gatilho | conc. |
| --- | --- | --- | --- | --- |
| 570 | `preparePhasePaneInner` | `has` (guard de entrada) | qualquer abertura de fase | **SIM** |
| 1104 | `preparePhasePaneInner` | **`set`** (arma o watch, `plannedPaneId`) | idem | **SIM** |
| 1126 | `blockForMissingFrontendStandard` | `delete` | falha de skill obrigatória | sim* |
| 1473 | `preparePhasePaneInner` (checkpoint) | `get` | pós-awaits do preparo | sim* |
| 1484 | idem | `delete` | `phase-prepare-cancelled` | sim* |
| 1520 | idem | `delete` | ruling mudou / rodada sem delta | sim* |
| 1618 | idem | `get` + **mutação in place** (`armedWatch.paneId = armed.paneId`) | pós-`armPane` | sim* |
| 1832 | `respawnInterruptedPhase` | `has` (guard) | drain de boot (projeto aberto) | **SIM** |
| 1850 | `respawnInterruptedPhase` | `values().filter` (capacidade) | idem | **SIM** |
| 1973 | `retryOrBacklog` (dev vivo) | `delete` | plano de skills expirou | sim* |
| 2052 | `retryOrBacklog` (dev vivo) | **`set`** (objeto NOVO, `phase:'dev'`) | reprovação com dev vivo | sim* |
| 2077 | `retryOrBacklog` | `delete` | `notifyPane` devolveu `dead` | sim* |
| 2118 | `retryOrBacklog` | `delete` | `notifyPaneNow` devolveu `dead` | sim* |
| 2868 | `openGatePane` (reciclo) | `delete` | renovação de skills falhou | sim* |
| 2919 | `openGatePane` (reciclo) | `delete` | range SHA inválido | sim* |
| 2944 | `openGatePane` (reciclo) | `delete` | delta de review indisponível | sim* |
| 2966 | `openGatePane` (reciclo) | `delete` | delta de QA indisponível | sim* |
| 2985 | `openGatePane` (reciclo) | **`set`** (objeto NOVO, gate na mesma conversa) | reciclo do gate vivo | sim* |
| 3074 | `openGatePane` (reciclo) | `delete` | pane morreu entre `has()` e a injeção | sim* |
| 3182 | `advancePhaseInner` | **`set` (MESMO objeto)** — rollback | ajudante ainda aberto | — |
| 3212 | `advancePhaseInner` | **`set` (MESMO objeto)** — rollback | fotografia mudou pós-diagnóstico | — |
| 3285 | `advancePhaseInner` | **`set` (MESMO objeto)** — rollback | non_code com caminho executável | — |
| 3530 | `advancePhaseInner` | **`set` (MESMO objeto)** — rollback | projeto sumiu (securityReview) | — |
| 3536 | `advancePhaseInner` | **`set` (MESMO objeto)** — rollback | `persistSecurityReview` falhou | — |
| 3848 | `tickPhaseWatches` | iteração sobre **cópia** (`[...phaseWatches]`) | timer 3s | **SIM** |
| 3859 | `tickPhaseWatches` | `delete` + `phase-watch-released` | watch stale | **SIM** |
| 3915 | `tickPhaseWatches` (pane-open-lost) | `delete` | reconciliador de pane perdido | **SIM** |
| 3931 / 3942 | idem | `has` (guarda do fallback) | re-prepare falhou | **SIM** |
| 4054 | `tickPhaseWatches` (marcador) | `get` — **re-check de identidade** | pós-`codeReportGuard` | **SIM** |
| 4060 | `tickPhaseWatches` (marcador) | **`detach`** — abre a transação | idem | **SIM** |

`grep -cE 'phaseWatches\.set\(watch\.taskId, watch\)' src/main/phaseEngine.ts`
= **5** — exatamente os cinco rollbacks de mesmo-objeto (3182, 3212, 3285,
3530, 3536).

### 2.2 `mcpApi/report.ts` — 8 sites (a outra entrada da transação)

| linha | contexto | op | gatilho | conc. |
| --- | --- | --- | --- | --- |
| 117 | `readReviewEvidence` | `get` (guard de rodada) | tool MCP do reviewer | **SIM** |
| 355 | `report` | `get` — resolve o watch da rodada | tool MCP | **SIM** |
| 433 | `report` (artefato inválido) | **`detach`** → `advancePhase` | tool MCP | **SIM** |
| 526 | `report` (gate `bloqueada`) | `delete` | tool MCP | **SIM** |
| 577 | `report` (dev `bloqueada`) | `delete` | tool MCP | **SIM** |
| 693 | `report` (**transação principal**) | **`detach`** | tool MCP | **SIM** |
| 743 | `report` | **`set` (MESMO objeto)** — rollback do ledger | acceptance ausente | — |
| 759 | `report` | **`set` (MESMO objeto)** — rollback de exceção | `advancePhase` lançou | — |

Âncoras: `phaseWatches\.detach\(watch\.taskId\)` = 2 ·
`phaseWatches\.set\(watch\.taskId, watch\)` = 2 ·
`phaseWatches\.delete\(watch\.taskId\)` = 2 ·
`ctx\.phase\.advancePhase\(` = 2 (todos em report.ts).

O cabeçalho do módulo já grava os dois contratos que a Fase 2 vai quebrar
(report.ts :12-15): *"report devolve string SÍNCRONO no caminho do veredito"* e
*"A transação: phaseWatches.detach ANTES do advancePhase; falha/recusa
re-indexa com phaseWatches.set (rollback) — nunca reordenar."*

### 2.3 `mcpApi/code.ts` — 3 sites (o guard do done + a re-entrega)

| linha | contexto | op |
| --- | --- | --- |
| 128 | `codeReportGuard` — condição da re-entrega sancionada (`!phaseWatches.get(...)`) | `get` |
| 141 | `codeReportGuard` — **`set`** (objeto NOVO) reconstruindo a fase dev (`redelivery-accepted`) | `set` |
| 176 | `codeReportGuard` — `const watch = phaseWatches.get(id.taskId)` e depois **mutação in place** de `watch.devSnapshot` (187/195/205) | `get` + mutação |

> **Peça central da corrida.** O `codeReportGuard` é `async` e roda **antes**
> do `report` no handler MCP (`const blocked = await api.codeReportGuard(identity)`
> em mcpServer.ts:871, `grep -c` = 1 no arquivo) **e** dentro da IIFE do poller
> (phaseEngine.ts:4029). Ele **escreve** `watch.devSnapshot` diretamente no
> objeto do registry — dois caminhos concorrentes escrevem o mesmo campo do
> mesmo objeto. Hoje isso é benigno porque o consumidor (`advancePhase`, linha
> 3201) lê o campo na pilha síncrona seguinte.

### 2.4 `mcpApi/board.ts` — 6 sites (o `run_task` e o orçamento)

| linha | contexto | op | conc. |
| --- | --- | --- | --- |
| 1114 | `createPlan` — recusa replanejar com card em execução | `has` | sim* |
| 1247 | `runTask` — *"já existe uma fase rodando para este card"* | `has` | **SIM** |
| 1252 | `runTask` — capacidade na reserva (`activeAtReservation`) | `values().filter` | **SIM** |
| 1423 | `runTask` (`phase`) — *"já existe uma fase X rodando"* | `get` | **SIM** |
| 1484 | `runTask` — `running >= MAX_PARALLEL_RUNS` | `values().filter` | **SIM** |
| 1531 | `runTask` — `activeBeforeSpawn >= MAX_PARALLEL_RUNS` | `values().filter` | **SIM** |

As **três** contagens de capacidade derivam de `phaseWatches.values()`. Um card
em transição (detached) **não é contado** → o teto de 6 pode ser furado por 1
por cada veredito em voo.

### 2.5 Demais módulos — 19 sites

| arquivo:linha | função | op | gatilho | conc. |
| --- | --- | --- | --- | --- |
| mcpApi/panes.ts:77 | `runtimeControl` — `activeWatch` | `get` | tool MCP do QA | **SIM** |
| mcpApi/panes.ts:80 | `runtimeControl` — `isCurrentQaRound()` (re-check pós-await) | `get` | idem | **SIM** |
| mcpApi/helpers.ts:171 | `delegateMany` — exige DEV ativo | `get` | tool MCP do dev | **SIM** |
| mcpApi/helpers.ts:214 | `helperParentStillActive()` (re-check pós-awaits) | `get` | idem | **SIM** |
| ipc/pty.ts:222 | `phaseStillActive()` dentro do `pty:create` | `get` | IPC do renderer | **SIM** |
| ipc/pty.ts:592 | `onExit` — fase morreu com o pane | `get` | **exit do processo** | **SIM** |
| ipc/pty.ts:594 | `onExit` | `delete` | idem | **SIM** |
| ipc/pty.ts:790 | pós-spawn — transição `pending → running` | `get` | IPC do renderer | **SIM** |
| ipc/tasks.ts:159 | `tasks:update` — `hasActivePane` (sanitização do patch) | `has` | clique do dono | **SIM** |
| ipc/projects.ts:193/195 | `projects:relocate` — solta TODOS os watches do projeto | iteração + `delete` | clique do dono | **SIM** |
| paneLifecycle.ts:506/508 | `rollbackFailedPaneSpawn` | `get` + `delete` | falha de spawn | sim* |
| missionEngine.ts:2155/2156 | `stopMissionExecution` | `get` + `delete` | arquivar/excluir missão | **SIM** |
| index.ts:3686 | `removeTaskCascade` — `activeWatchToRemove` | `get` | `tasks:remove` / `delete_task` | **SIM** |
| index.ts:3701 | `removeTaskCascade` | `delete` | idem | **SIM** |
| index.ts:5181 | `sweepProjectFiles` — *marcador com watch ativo FICA* | `has` | boot / integração / 🧹 | **SIM** |
| index.ts:5254 | `setPhaseExecutorImpl` | `get` (pega o `cwd`) | ⇄ do dono / `set_phase_executor` | **SIM** |
| index.ts:5274 | `setPhaseExecutorImpl` | `delete` | idem | **SIM** |

---

## 3. O poller de 3s — mecânica atual e onde ela abre

### 3.1 Onde o tick é registrado

`setInterval` único no index (`phaseEngine\.tickPhaseWatches\(\)`, `grep -c` = 1
em index.ts:5629), rodando três fatias: fases, watchdog de helper e missões.

```
setInterval(() => {
  phaseEngine.tickPhaseWatches()
  paneLifecycle.tickHelperOpenWatchdog()
  missionEngine.tickMissionWatches()
}, 3000)
```

**O `setInterval` é armado em index.ts:5629, ANTES do bloco de recovery de boot
(index.ts:6223).** Não há `await` de nível superior entre os dois pontos
(varrido: os únicos `await` na faixa 5628–6230 estão dentro dos corpos de
`agentModelPool` e `startInternalMcp`), então o **primeiro tick só pode cair
depois que o corpo síncrono do `whenReady` termina** — isto é, depois do
recovery. Isso é sorte estrutural, não contrato: qualquer `await` novo inserido
nessa faixa põe o poller a rodar **dentro** do recovery.

### 3.2 As 4 travas anti-corrida de HOJE

Ordem exata do ramo do marcador (phaseEngine.ts:3956-4066):

1. **Gate nunca avança por arquivo** — `if (watch.phase !== 'dev')` (:3960):
   o `.verdict` de review/QA é **apagado** e o pane recebe um aviso. Só o
   `.done` do DEV chega ao `advancePhase`. Portanto **a única corrida
   poller × report é no report de DEV**.
2. **`phaseMarkersProcessing`** (`if \(phaseMarkersProcessing\.has\(taskId\)\)
   continue`, `grep -c` = 1, :3980): `Set` por `taskId`, adicionado
   **sincronamente** antes da IIFE e removido no `finally` (:4063). Impede o
   tick seguinte (3s depois) de abrir uma SEGUNDA IIFE para o mesmo card
   enquanto a primeira ainda aguarda o `codeReportGuard`.
3. **Re-check de identidade por REFERÊNCIA** (`if \(phaseWatches\.get\(taskId\)
   !== watch\) return`, `grep -c` = 1, :4054): depois do `await
   codeReportGuard(identity)`, o poller confere que o registry ainda aponta
   para **o mesmo objeto** que ele capturou na iteração. Se o `report` MCP já
   passou (detach) ou se um re-prepare substituiu o watch por um objeto novo, o
   poller desiste.
4. **`detach` + `advancePhase` na MESMA pilha** (:4060-4061): entre remover a
   indexação e terminar a transição não existe ponto de suspensão. É esta a
   "barreira síncrona do veredito" — o comentário-âncora está em phaseEngine.ts
   :3424 e o contrato está gravado no tipo (`mainContext.ts` :77-91).

Do lado do `report` MCP a ordem espelha: `phaseWatches.detach(watch.taskId)`
(:693) → `unlinkSync(watch.marker)` (:695) → grava o patch sugerido → monta
`acceptance` → `advancePhase` (:748), tudo síncrono. O `unlink` do marcador
**depois** do detach é o que impede o poller de reprocessar o mesmo `.done`.

### 3.3 Onde os buracos abrem quando o `advancePhase` passa a aguardar

| trava | sobrevive? | por quê |
| --- | --- | --- |
| gate não avança por arquivo | **sim** | é decisão de ACL, não de corrida |
| `phaseMarkersProcessing` | **parcial** | só cobre poller × poller; nada sabe do `report` MCP |
| re-check por referência | **NÃO** | ver §7.1: o rollback restaura o **mesmo objeto** e a comparação volta a passar |
| `detach` + `advancePhase` síncronos | **morre por construção** | é exatamente o que a Fase 2 remove |

E, além dessas quatro, **todo guard `phaseWatches.has()` da §2 passa a mentir**
durante a janela — o card detached parece livre.

### 3.4 As outras duas rotas do poller que MEXEM em watch

**(a) Liberação de watch stale** (`phase-watch-released`, `grep -c` = 1 em
`src/main`), phaseEngine.ts:3857-3879:

```
if (!task || (task.status !== activeStatus && !existsSync(watch.marker))) {
  if (task && Date.now() - watch.createdAt < PHASE_WATCH_GRACE_MS) continue
  phaseWatches.delete(taskId)
  if (watch.paneId) terminatePaneNow(watch.projectId, watch.paneId)
  ...
}
```

`PHASE_WATCH_GRACE_MS = 30_000` (`grep -c` = 1). A graça existe porque o
`preparePhasePane` registra o watch (:1104) **antes** do `tasks.update` para
`execucao` (:1564) e há awaits entre os dois (skill sync ~0,7s, worktree ~1-4s)
— a corrida real de 2026-08-06. **Este ramo mata o pane** (`terminatePaneNow`),
não só o watch.

**(b) Reconciliador de pane perdido** (`pane-open-lost`, `grep -c` = 1),
phaseEngine.ts:3888-3955: fase `pending` com `paneId` armado que nunca virou
PTY, além da graça, com teto de 1 tentativa/2min (`watch.lastOpenLostRetryAt =
Date.now()`, `grep -c` = 1) → `phaseWatches.delete(taskId)` + `discardUnstartedPane`
+ `preparePhasePane` novo, dentro de uma IIFE async **sem** entrar em
`phaseMarkersProcessing`. Guarda: `phaseLaunches.reserve(taskId)`.

> ⚠️ **Divergência doc × código.** O CLAUDE.md (bloco F6.8d) e
> docs/MAPA_RETOMADA_2026-08-06.md :105 descrevem um terceiro mecanismo — o
> "cinto" que **RECONSTRÓI** o watch perdido durante os awaits e audita
> `phase-watch-repaired`. Esse evento **não existe mais no código**:
> `grep -rn "phase-watch-repaired" .` casa **apenas** em CLAUDE.md:834 e em
> docs/MAPA_RETOMADA_2026-08-06.md:105 — **zero** ocorrências em `src/`. O que
> existe hoje no mesmo ponto (o checkpoint pós-await do `preparePhasePaneInner`,
> :1477-1503, e a conferência pós-`armPane`, :1618-1626) **CANCELA** em vez de
> reparar: `phase-prepare-cancelled` (`grep -c` = 1) e, no segundo,
> `terminatePaneNow(projectId, armed.paneId)` + `return null` sem evento
> próprio. O plano da Fase 2 não pode assumir a existência do reparo.

### 3.5 O que o poller NÃO faz (e por isso não é o único entrante)

- Não processa `.verdict` de gate (só apaga).
- Não roda `retryOrBacklog`, `finalizeTask` nem `openGatePane` diretamente —
  eles são disparados **de dentro** do `advancePhase` com `void` (§4.4).
- Não conhece `liveGateWaits`, `gateCooldownUntil` nem `bootRespawnsPending`.

---

## 4. BOOT — o que roda, quando, e o que sobrevive a uma morte no meio

### 4.1 A janela de boot (síncrona) — não interleava com veredito

Âncora: `// RECUPERAÇÃO PÓS-FECHAMENTO/CRASH: nenhum processo sobrevive, mas a
FASE` (`grep -c` = 1), index.ts:6219. O laço vai até :6404;
`mainStalls.wrap('boot:createWindow', undefined, () => createWindow())` está em
:6614 — **o recovery inteiro roda ANTES da janela existir**, portanto antes de
qualquer pane, qualquer MCP autenticado e qualquer veredito. Não há
`await` de nível superior entre :6223 e :6614 (varrido).

O que o laço faz por card (`recoveryDecision` audita cada decisão na caixa-preta
— `grep -c` = 1 em index.ts):

| condição do card | ação | escreve |
| --- | --- | --- |
| `kind === 'plan'` | `resumePlanVerificationIfNeeded` (ou reconciliação offline) | `plan.verification` |
| `phaseState === 'finalizing'` | **`void recoverFinalizingTask(t)`** (fire-and-forget) + `continue` | ver §4.2 |
| `status === 'execucao'` e `activePhase === 'review'` | `gate-preserved` → `phaseState:'interrupted'` + `notePendingRespawn` | `tasks.json` |
| `status === 'execucao'` e `activePhase === 'qa'` | `gate-preserved` → `status:'qa'` + `interrupted` + `notePendingRespawn` | `tasks.json` |
| `status === 'execucao'` (dev) | `dev-interrupted` → `status:'backlog'` + `activePhase:'dev'` + `interrupted` + `notePendingRespawn` | `tasks.json` |
| `status === 'qa'` | `gate-preserved` → `interrupted` + `notePendingRespawn` | `tasks.json` |

Também no laço: missões `integrando` voltam a `ativa` (:6374),
`sweepProjectFiles(p.id, { preserveInterruptedHelpers: true })` (:6398) — que
lê `phaseWatches.has(tid)` para **preservar marcadores de fase ativa**
(index.ts:5181) — e `repairIntegrationSyncTickets` / drain da fila.

**Nenhum `phaseWatches.set` acontece no boot.** O registry nasce vazio; quem o
repovoa é o drain (§4.3).

### 4.2 `recoverFinalizingTask` — a exceção fire-and-forget

`async function recoverFinalizingTask\(task: Task\)` (`grep -c` = 1),
phaseEngine.ts:2196. Disparada de **2** lugares:

- **boot**, `void recoverFinalizingTask(t)` (index.ts:6291) — o `void` faz o
  corpo async **sobreviver ao bloco de boot**: ele continua rodando (git,
  merge, `tasks.update`) depois que o `whenReady` retorna, em paralelo com o
  poller, com o `createWindow` e com tudo que vier depois;
- **agente**, `run_task {phase:'finalize'}` → `await
  ctx.phase.recoverFinalizingTask(latest)` (mcpApi/board.ts:1292).

Ela monta um **`PhaseWatch` sintético** (phaseEngine.ts:2431-2445) que **nunca
entra no registry** e chama `void finalizeTask(watch, task, 'gates já aprovados
antes do reinício')` (:2446).

> **Consequência dura para o lock:** existe um caminho que muta o card
> (status → `done`, remove worktree/branch, escreve `integrationReceipt`) **sem
> nenhum watch indexado**. Um lock que só cubra "quem tem watch" não o alcança.
> O lock precisa ser chaveado por **`taskId`**, não por watch.

### 4.3 `drainPendingRespawns` — o boot que roda TARDE

| âncora (`grep -c` = 1 em phaseEngine.ts) | linha |
| --- | --- |
| `const bootRespawnsPending = new Map<string, Set<string>>\(\)` | 1820 |
| `function notePendingRespawn\(` | 1821 |
| `async function respawnInterruptedPhase\(` | 1826 |
| `function drainPendingRespawns\(` | 1890 |

O drain é chamado **de um único lugar**: `ctx.phase.drainPendingRespawns(projectId)`
em `ipc/maestro.ts:428`, dentro do handler `maestro:paneSpec` — ou seja,
**quando o dono ABRE o projeto**, com o app inteiramente vivo. Ele apaga a
entrada do mapa antes de começar (`bootRespawnsPending.delete(projectId)`,
:1893), o que dá "uma tentativa por projeto por boot", e depois roda um `for …
await respawnInterruptedPhase(...)` dentro de uma IIFE `void`.

`respawnInterruptedPhase` tem 3 guardas relevantes:
`if (phaseWatches.has(taskId)) return` (:1832), `phaseLaunches.reserve(taskId)`
(:1848) e `phaseLaunchCapacity.reserve(projectId, active, MAX_PARALLEL_RUNS)`
com `const active = [...phaseWatches.values()].filter(...)` (:1850).

**Resposta direta à pergunta do escopo — "recovery também roda ao abrir o
projeto?"**: sim. O *recovery de estado* roda só no boot (antes da janela), mas
o *respawn* que ele agenda roda ao abrir o projeto, serializado por projeto e
**concorrente com tudo o mais**. Cenário real: o drain está no card #4 da lista
enquanto o dev do card #1 (respawnado 40s antes) já reportou `done`. Mesma
carta, não; **mesmo projeto, sim** — e o que eles compartilham é a **contagem
de capacidade derivada de `phaseWatches`** (§7.6).

### 4.4 As continuações `void` do próprio veredito

`advancePhase` é síncrono, mas termina disparando trabalho async sem esperar:

| linha | chamada | fase seguinte |
| --- | --- | --- |
| 3404 | `if (next) void openGatePane(watch, next)` | dev → review/qa |
| 3406 | `void finalizeTask(...)` | dev sem gates |
| 3709 | `void retryOrBacklog(watch, …, reason)` | veredito invalidado |
| 3791 | `void retryOrBacklog(watch, who, motivo)` | reprovação |
| 3816 | `void finalizeTask(...)` | review aprovado com QA memoizado |
| 3827 | `void openGatePane(watch, 'qa')` | review → qa |
| 3834 | `void finalizeTask(watch, task, …)` | aprovação final |

Ou seja: **hoje já existe uma janela async pós-veredito** em que o card está
persistido no estado novo (`pending`/`finalizing`/`backlog`) mas **sem watch no
registry** e **sem pane novo**. Ela dura o tempo de `preparePhasePane`
(worktree + skill sync + gitOff ≈ 1-4s) ou do merge (≈ 4s). Todo guard
`phaseWatches.has()` já mente nesse intervalo hoje. A Fase 2 **estende** essa
janela para trás, cobrindo também a decisão do veredito.

### 4.5 O que sobrevive se o app morre entre o `detach` e o `tasks.update`

Inventário para o teste "veredito × boot":

| artefato | sobrevive? | estado após a queda |
| --- | --- | --- |
| `phaseWatches` | **não** (memória) | registry vazio no boot |
| `phaseMarkersProcessing` / `liveGateWaits` / `gateDeathLog` / `gateCooldownUntil` / `bootRespawnsPending` | **não** (memória) | zerados |
| marcador `.done` / `.verdict` | **não** | **já foi apagado** — report: `unlinkSync` em :695 (após o detach); poller: `unlinkSync` em :4056 (antes do detach) |
| `tasks.json` | **sim**, atômico (tmp+rename+`.bak`) | fotografia **PRÉ-veredito** |
| commit do dev no worktree | **sim** | o `snapshotTaskWorktree` do `codeReportGuard` já commitou |
| `reviewArtifact` (`.diff` privado em `userData`) | **sim, órfão** | limpo pelo `sweepReviewArtifactsOnce` (phaseEngine.ts:297) |
| `integrationReceipt` | **sim** se o `finalizeTask` já tinha gravado | reconciliado por `recoverFinalizingTask` |
| evidência de gate em `.synkora/reports/*.diff` | **sim** | escrita antes do detach |

Como o boot reconcilia, por caso:

- **Report de DEV perdido no meio** → card ficou `execucao/dev/running` → boot
  decide `dev-interrupted` → `backlog` + `notePendingRespawn` → o dev claude
  volta por `--resume` e **reporta de novo**; a re-entrega é aceita pelo caminho
  `redelivery-accepted` (mcpApi/code.ts:141), que reconstrói o watch.
  **Custo: uma re-entrega. Perda: zero.**
- **Veredito de REVIEW perdido no meio** → card ficou `execucao/review/running`
  → boot decide `gate-preserved` → o gate **reabre e re-audita** (a evidência
  `verification.review` nunca foi persistida, então a memoização por head não
  ajuda). **Custo: uma rodada de gate.**
- **Veredito de QA perdido no meio** → idem, com `status:'qa'`.
- **Aprovação persistida mas merge não** → `phaseState:'finalizing'` → boot
  chama `recoverFinalizingTask`, que prova o merge pelo journal
  (`integrationReceipt`) ou pelo marcador `synkora-task:<id>` no histórico e
  conclui/repara. **Coberto.**
- **`updateMany` do gate de segurança** (veredito + plano na MESMA transação,
  phaseEngine.ts:3655) — atômico por construção; ou os dois pousam, ou nenhum.

> **Conclusão para o desenho:** hoje, uma queda no meio do veredito custa no
> máximo **uma rodada repetida**, nunca corrupção. Esse é o padrão de
> qualidade que a Fase 2 tem que manter — o lock **não pode** introduzir um
> estado persistido intermediário ("em transição") que o boot não saiba
> desfazer. Se o lock precisar de marca em disco, ela tem que ser
> auto-reconciliável exatamente como o `integrationReceipt`.

---

## 5. Outros mutadores do estado de fase

Para cada um: o que muta, quem dispara, e o veredito de projeto —
**ADQUIRIR** o lock, **RECUSAR** durante o lock, ou **ORTOGONAL**.

### 5.1 `setPhaseExecutorImpl` — troca de executor (⇄ do dono / `set_phase_executor`)

Âncora: `async function setPhaseExecutorImpl\(` (`grep -c` = 1), index.ts:5238.
Entradas: `tasks:setPhaseSeat` (ipc/tasks.ts:367, actor `user`) e
`api.setPhaseExecutor` (mcpApi/board.ts:1675, actor `maestro`, exige ordem
verbatim do dono).

Muta, em sequência **síncrona** até o respawn: `phaseWatches.delete(taskId)`
(:5274) → `terminateTaskPhasePane` → transplante de sessão CLI
(`migrateCliSessionBetweenSeats`) → `tasks.update` (phaseSessions, phaseResume,
runSeat, runModel, devEffort) → evento `seat-swap` → **`await
preparePhasePane(...)`** com `launchToken` (:5333-5350).

- **Veredito: ADQUIRIR.** É o mutador mais perigoso da lista: ele **apaga o
  watch e mata o pane** do card. Se cair no meio de um veredito, o
  `advancePhase` termina escrevendo estado sobre um card cujo executor já foi
  trocado, e o `preparePhasePane` do reseat compete com o `openGatePane` da
  continuação. Precisa esperar o lock; enquanto espera, a mensagem honesta é
  *"a rodada está sendo fechada; a troca entra em seguida"*.

### 5.2 `removeTaskCascade` — exclusão do card

Âncora: `function removeTaskCascade\(task: Task\): boolean \{` (`grep -c` = 1),
index.ts:3677. Entradas: IPC `tasks:remove` e tool `delete_task`.

Muta: `closeLiveGateWait` → mata todos os panes do card →
`phaseWatches.delete(task.id)` (:3701) → `terminateTaskPhasePane` ×3 →
**`tasks.remove(task.id)`** → apaga transcript/marcadores → remove
worktree+branch.

- **Veredito: RECUSAR durante o lock.** Um `tasks.remove` no meio do veredito
  faz o `advancePhase` continuar contra um card inexistente — `tasks.update`
  devolve `undefined` e o código de aprovação **lança**
  (`'card desapareceu antes do commit do veredito do gate'`, :3681), o que hoje
  é impossível de acontecer. Pior: o worktree é removido enquanto o
  `finalizeTask` ainda pode estar mergeando dele. Recusar com receita ("a
  rodada está fechando; tente de novo em segundos") é mais honesto que
  enfileirar uma exclusão.

### 5.3 `stopMissionExecution` — arquivar/excluir missão

Âncora: `function stopMissionExecution\(` (`grep -c` = 1),
missionEngine.ts:2144. Entradas: `ipc/missions.ts:271` e `:352`
(clique do dono) e `mcpApi/missions.ts:151` (`archive_mission` do PM).

Muta, para **cada** card não-plan da missão: `phaseWatches.get` + `delete`
(:2155-2156) → `unlinkSync(watch.marker)` → `tasks.update({status:'backlog',
activePhase, phaseState:'interrupted'})` → mata todos os panes da missão.

- **Veredito: ADQUIRIR (por card) ou RECUSAR (missão inteira).** É um `delete`
  em lote sobre o registry, sem nenhuma consulta a "há transição em voo".
  Recomendação: recusar a operação inteira quando **qualquer** card da missão
  estiver com o lock tomado, com a lista dos cards — arquivar uma missão é
  gesto deliberado, esperar 3s é aceitável; perder um veredito não é.

### 5.4 `projects:relocate` — mudar a pasta do projeto

ipc/projects.ts:172. Âncora do laço: `for \(const \[tid, watch\] of
phaseWatches\) \{` (`grep -c` = 1), :193 → `phaseWatches.delete(tid)` (:195) +
`discardUnstartedPane`.

- **Veredito: RECUSAR durante o lock.** Antes do laço ele já matou todos os
  panes e vai chamar `projects.setPath` — o `cwd` do watch em voo deixa de
  existir no meio do `advancePhase`. É um gesto raro e explícito do dono
  (abre um `dialog`): recusar com "há uma rodada fechando" é trivial e correto.

### 5.5 `onExit` do PTY → `recordGateDeath` / devolução ao backlog

ipc/pty.ts:582-652. Ordem: `stopQaRuntime` (se QA) → limpa `liveGateWaits` se o
`paneId` bate → `const watch = ctx.phaseWatches.get(identity.taskId)`
(`grep -c` = 2 nesse arquivo — este é o de :592, o outro é o de :790) →
`if (watch && watch.phase === identity.phase)` → `delete` → `recordGateDeath`
(gates) **ou** `terminateTaskHelpers` + volta ao backlog (dev).

Duas propriedades salvam este caminho hoje:

1. `const identity = unregisterPane(req.id)` (ipc/pty.ts:519) lê a identidade
   **no momento do exit**; e `terminatePaneNow` (paneLifecycle.ts:548)
   **desregistra ANTES do kill** (:557 antes de :561). Logo, **morte
   deliberada** (a que o `advancePhase` provoca via `terminateTaskPhasePane`)
   chega ao `onExit` com `identity === undefined` → `if (!identity) return` →
   o bloco inteiro é pulado.
2. Morte **não** deliberada (o dono fecha o pane, o CLI crasha) mantém a
   identidade → o bloco roda, e a guarda `watch.phase === identity.phase`
   protege: durante a transação o watch está detached → `undefined` → no-op.

- **Veredito: ORTOGONAL-COM-RESSALVA.** Não precisa do lock, mas **a ordem
  `detach` antes de qualquer await tem que ser preservada** — é ela que torna o
  `onExit` inofensivo. Se o lock for tomado *antes* do detach e o detach vier
  *depois* de um await, um `onExit` no meio devolve o card ao backlog por baixo
  do veredito. Ressalva 2: `stopQaRuntime(identity.taskId)` (:586) roda
  **fora** de qualquer guarda de watch — pode derrubar o runtime de uma rodada
  de QA reciclada.

### 5.6 `rollbackFailedPaneSpawn` — spawn que falhou

paneLifecycle.ts:482 (`grep -c` = 1). Guarda `watch?.paneId === paneId &&
watch.phase === identity.role` antes do `delete` (:507-508).

- **Veredito: ORTOGONAL.** A guarda por `paneId` é exata; um veredito em voo
  tem o watch detached (não casa) ou re-indexado com o mesmo `paneId` (e aí o
  spawn falhou de verdade e o card **deve** cair). Nada a fazer.

### 5.7 `closeLiveGateWait` / reciclo de gate vivo

`function closeLiveGateWait\(` (`grep -c` = 1), phaseEngine.ts:1741. Chamado
por: `retryOrBacklog` (plano pausado, :1942), `removeTaskCascade` (index.ts:3690)
e o `ipc/panes` (contrato `PhaseApi.closeLiveGateWait`, mainContext.ts:111).

O reciclo mora dentro do `openGatePane` (:2822-3078) e é **fortemente async**:
`renewLivePaneSkillRun`, `gitOff('immutableReviewRangeValid')`,
`gitOff('immutableReviewDiff')`, `gitOff('immutableReviewChangedPaths')`,
`gitOff('gitVisibleWorktreeFingerprint')` — e só então `phaseWatches.set`
(:2985) + `tasks.update` (:2996) + `notifyPaneNow`. Em cada falha intermediária
faz `phaseWatches.delete` e cai no spawn normal.

- **Veredito: ADQUIRIR (é a continuação natural do veredito).** Hoje ele já
  roda "fora" da transação (chamado com `void` a partir do `advancePhase`) e é
  a maior janela sem watch do sistema. Se o lock cobrir `advancePhase +
  continuação`, este trecho fica protegido de graça — e o `run_task` deixa de
  conseguir abrir um gate duplicado no meio dele.

### 5.8 `tasks:planStop` / `tasks:planApprove` — pausa e retomada do plano

ipc/tasks.ts:275 (`grep -c` = 1) e :~230. O `planStop` só faz
`tasks.update(taskId, { status: 'backlog' })` no **card de PLANO** e publica um
evento urgente. Não toca `phaseWatches`.

Mas o veredito **lê** esse estado em dois pontos assíncronos:
`retryOrBacklog` (:1937 — `planTask?.status === 'backlog' && planTask.plan?.approvedAt`
→ fecha dev e gate vivo) e `openGatePane` (:2802 — mesma condição).

- **Veredito: ORTOGONAL, mas com leitura tardia.** A pausa no meio de um
  veredito hoje é lida pela continuação (`retryOrBacklog`/`openGatePane`) e
  produz o comportamento certo ("aguarda o plano ser retomado"). Pós-conversão
  isso continua valendo **desde que a leitura do plano permaneça DENTRO do
  trecho protegido** — ler `planTask` uma vez, antes do primeiro await, e usar
  o valor lido no fim, seria uma regressão silenciosa (a pausa do dono seria
  ignorada).

### 5.9 `completeMissionMerge` × `finalizeTask` — merge de missão × merge de card

`completeMissionMergeInner` (missionEngine.ts:1876) mescla a **branch da
missão** no destino; `finalizeTask` (phaseEngine.ts:2450) mescla o **worktree
do card** na branch da missão. Os dois usam `gitOff`/`gitOffWithCheckpoint` (o
mesmo worker, portanto **serializados entre si** no worker thread), mas a
sequência de decisões em volta (fotografias, receipts) **não** é.

A cerca real existente é do lado da missão: `integrate_mission` só enfileira
com todos os cards concluídos, e o drain da fila roda com a missão em
`integrando`. Além disso `completeMissionMergeInner` revalida
`currentSourceHead !== expectedSourceHead` (:1934) — um merge de card que caia
no meio faz o merge de missão **falhar limpo**, não corromper.

- **Veredito: ORTOGONAL (protegido pelo worker + revalidação de fotografia).**
  Registrar como caso de teste, não como consumidor do lock.

### 5.10 Watchdogs por timer

| watchdog | onde | efeito | veredito |
| --- | --- | --- | --- |
| MCP de gate (75s sem 1º contato) | `armGateMcpWatchdog` (index.ts:5860, `grep -c` = 1) | `ptys.kill(paneId)` | **ORTOGONAL** — só mata o pane; o `onExit` guarda por `watch.phase`; e o gate que já reportou tem `mcpPaneFirstContact` gravado |
| dev sem MCP (120s, SOFT) | ipc/pty.ts:729 | só evento | ORTOGONAL |
| helper-open (30s) | `tickHelperOpenWatchdog` (paneLifecycle.ts:600) | reenvia `panes:open` / `rollbackFailedPaneSpawn` | ORTOGONAL |
| runtime do QA | qaRuntime.ts:283 | derruba o runtime | ORTOGONAL |
| `pane-open-lost` (poller) | phaseEngine.ts:3888 | **`delete` + re-prepare** | **RECUSAR durante o lock** |

### 5.11 `pty:create` (`phaseStillActive`) e a transição `pending → running`

ipc/pty.ts:206-233 (`const watch = ctx.phaseWatches.get(pendingIdentity.taskId)`,
`grep -c` = 1) e :790 (pós-spawn, `phaseState:'running'`).

- **Veredito: ORTOGONAL.** Ambos exigem casar `watch.paneId === req.id`. Com o
  watch detached, o `phaseStillActive()` devolve `false` e o spawn é abortado —
  que é o comportamento correto: o pane que estava nascendo é o da fase que
  acabou de fechar. Vale documentar como *decisão*, não como acaso.

### 5.12 `tasks:update` do renderer (`hasActivePane`)

ipc/tasks.ts:158-170. Com o watch detached, `hasActivePane` cai para a
varredura de panes do hub — e durante o veredito o `terminateTaskPhasePane` já
matou o pane. Resultado: o patch do dono é sanitizado como se o card estivesse
**ocioso** (mais permissivo).

- **Veredito: RECUSAR durante o lock** (ou, no mínimo, tratar lock tomado como
  `hasActivePane = true`). É o caminho por onde o dono consegue mover um card
  no kanban exatamente enquanto o veredito o move.

---

## 6. `liveGateWaits`, `gateCooldownUntil` e `gateDeathLog`

### 6.1 `liveGateWaits` — ciclo de vida completo

Tipo em phaseTypes.ts:112; mapa em phaseEngine.ts:1735
(`const liveGateWaits = new Map<string, LiveGateWait>\(\)`, `grep -c` = 1).

**Nasce** em um único lugar: `advancePhaseInner`, ramo de reprovação **limpa**
(readonly provado), phaseEngine.ts:3770-3780 — condicionado a
`watch.paneId && ptys.has(watch.paneId)`. Guarda `rejectedHead`,
`rejectedReason`, `rejectedAt` e `gateNotesAtRejection` (o JSON das notas no
instante da reprovação).

**Morre** em:

| local | contexto |
| --- | --- |
| phaseEngine.ts:3688 | veredito **inválido** (não-readonly) |
| phaseEngine.ts:3723 | veredito **ilegível** |
| phaseEngine.ts:3806 / :3824 / :3833 | aprovações (memoizada, review→qa, final) |
| phaseEngine.ts:2451 | `finalizeTask` (primeira linha) |
| phaseEngine.ts:2867 / :2872 / :3076 | reciclo do gate (consumo ou pane morto) |
| phaseEngine.ts:1744 | `closeLiveGateWait` (plano pausado, card removido) |
| report.ts:538 | veredito `bloqueada` |
| ipc/pty.ts:589-591 | `onExit` com `paneId` casando |

**É lido** em: `openGatePane` (:2822 — a decisão de reciclar) e
`retryOrBacklog` (:1930 — para saber qual gate reprovou e zerar só a evidência
dele).

**Interação com a transação do veredito: ALTA e bidirecional.** O `set` e
quase todos os `delete` acontecem **dentro** do `advancePhaseInner`, na pilha
síncrona. Pós-conversão, entre o `liveGateWaits.set` (:3771) e o
`void retryOrBacklog` (:3791) passa a haver espaço; e `retryOrBacklog` **lê**
`liveGateWaits.get(watch.taskId)?.phase` (:1930) para decidir qual evidência
zerar. Um `onExit` do pane do gate nesse meio (o dono fechando o pane logo após
ver a reprovação) apaga a espera e `rejectingGate` vira `undefined` → **a
evidência do gate que reprovou NÃO é zerada** → a memoização por head pode
"aprovar" na próxima entrega um gate que reprovou.

> **Este é um bug latente concreto que a Fase 2 pode criar.** Hoje é
> impossível (mesma pilha). Recomendação: `retryOrBacklog` receber
> `rejectingGate` como **parâmetro** calculado dentro do lock, em vez de
> re-consultar `liveGateWaits`.

### 6.2 `gateDeathLog` e `gateCooldownUntil`

`const gateDeathLog = new Map<string, number\[\]>\(\)` (:1739) e
`const gateCooldownUntil = new Map<string, number>\(\)` (:1740), ambos
`grep -c` = 1.

- **Escritor único:** `function recordGateDeath\(taskId: string\)` (:4073,
  `grep -c` = 1), chamado **exclusivamente** pelo `onExit` do PTY
  (ipc/pty.ts:605). O comentário do cabeçalho do módulo (phaseEngine.ts:20-21)
  grava o contrato: *"gateDeathLog é escrito pelo onExit do PTY via
  recordGateDeath(taskId), nunca pelo Map cru"*.
- **Leitor único:** `run_task` com `phase` review/qa (mcpApi/board.ts:1243).
- Janela `GATE_DEATH_WINDOW_MS = 60_000`, teto `GATE_DEATH_LIMIT = 3`, cooldown
  de 5min.

**Interação com a transação: NENHUMA.** `recordGateDeath` só é alcançado
quando o `onExit` encontra um watch **com a mesma fase** — e durante a
transação o watch está detached. Um gate que reporta veredito e é morto pelo
`terminateTaskPhasePane` chega ao `onExit` já desregistrado (§5.5) e **não**
conta morte. Correto e preservado pela conversão, **desde que o detach continue
antes do primeiro await**.

- **Veredito: ORTOGONAL.** Nenhum dos dois mapas precisa do lock. Vale apenas
  incluir no teste de corrida a asserção *"veredito seguido de kill do pane não
  incrementa `gateDeathLog`"* — é uma regressão barata de cometer.

---

## 7. RISCOS — os interleavings que a conversão torna possíveis

Cada item traz: **quem** entra, **onde** entra, **o que quebra** e **o que o
lock precisa fazer**.

### 7.1 🔴 Rollback re-indexa o MESMO objeto e o poller volta a "acertar" a identidade

**Já é possível hoje**, em janela estreitíssima; pós-conversão vira janela de
segundos.

Sequência: o poller entra na IIFE, chega em `await codeReportGuard(identity)`
(:4029). Nesse meio, o `report` MCP do mesmo dev roda: `detach` (:693) →
`advancePhase` → cai num ramo de rollback → `phaseWatches.set(watch.taskId,
watch)` (:743 ou :759 — **o MESMO objeto**). O poller retoma, executa
`if (phaseWatches.get(taskId) !== watch) return` (:4054): **a comparação por
referência PASSA**, porque o objeto restaurado é idêntico. O poller então faz
`unlink` do marcador (já apagado — o `catch` engole) e chama `advancePhase(watch,
content)` **uma segunda vez**, com o conteúdo `done` lido do arquivo.

**O que quebra:** dupla execução do veredito; no caminho de aprovação isso
significa dois `openGatePane` (protegidos entre si pelo checkpoint do
`preparePhasePane`, mas gerando `phase-prepare-cancelled` e ruído) e dois
`commitRuntimeAcceptance`.

**Lock:** o re-check de identidade precisa deixar de ser "mesmo objeto" e
passar a ser **"eu ainda sou o dono do lock desta carta"** — token opaco no
padrão do `PhaseLaunchGuard` (Symbol, phaseLaunchGuard.ts:17-24), não igualdade
de referência.

### 7.2 🔴 Dois `report` MCP concorrentes no mesmo card

O handler MCP faz `await api.codeReportGuard(identity)` (mcpServer.ts:871)
**antes** de `await api.report(...)` (:876). Duas chamadas do mesmo pane (o
modelo repetindo a tool) ou de panes diferentes (dev + gate no mesmo `taskId`)
podem estar simultaneamente paradas nesse await.

Hoje: a segunda entra em `report` depois que a primeira já detachou → cai em
`if (!watch)` (:356) → mensagem "sua rodada já FECHOU". **Correto.**

Pós-conversão: continua correto **se e somente se** o `detach` (ou a tomada do
lock) permanecer no trecho síncrono do `report`, antes de qualquer `await`. Se
o `report` virar `async` e o `detach` migrar para depois de um await, as duas
chamadas veem o mesmo watch e as duas seguem.

**Lock:** tomar o lock **sincronamente** na entrada do caminho de veredito (o
`reserve` do `PhaseLaunchGuard` é síncrono de propósito — phaseLaunchGuard.ts
:11-13 já documenta exatamente esse motivo).

### 7.3 🔴 Poller × report enquanto o veredito aguarda o `gitOff`

O plano prevê `snapshotProblemFor` viajando pelo worker. A janela do
`advancePhase` passa a conter pelo menos: `gitOff('snapshotProblemFor')`,
possivelmente `gitVisibleWorktreeFingerprint`, e a quarentena de evidência
(`quarantineUntrackedNew`). Durante ela, o próximo tick do poller (3s) roda com
o card **sem watch**.

**O que quebra:** nada no ramo do marcador (sem watch, o card não aparece na
iteração). Mas **tudo** nos guards `has()` de outros módulos (§7.5, §7.6).

### 7.4 🟠 Rollback devolve um watch com `createdAt` vencido → o poller o solta

Depois de um rollback, o registry volta a ter o watch com o `createdAt`
ORIGINAL. Se, no mesmo intervalo, o card estiver num status que não casa
`activeStatus` (ex.: o `advancePhase` já tinha escrito `status:'qa'` antes de
falhar, ou o rollback do `report` acontece depois de o `recordGate` ter movido
o card), o poller executa o ramo `phase-watch-released` **sem** graça (já
vencida) → `phaseWatches.delete` **+ `terminatePaneNow`**: mata o pane do
executor.

Hoje impossível (rollback e status na mesma pilha). Pós-conversão é uma corrida
real de 3s.

**Lock:** o ramo de liberação stale (:3857) precisa pular cards com o lock
tomado — e, idealmente, os rollbacks devem **renovar** `createdAt`.

### 7.5 🔴 `run_task` durante a transação (o card parece livre)

`if (phaseWatches.has(taskId))` (board.ts:1247) e
`const active = phaseWatches.get(taskId)` (:1423) são as **únicas** cercas do
`run_task` contra fase duplicada. Com o card detached, o orquestrador — que
acabou de receber o evento de reprovação, ou que está fazendo retriagem — pode
abrir um dev ou reabrir um gate **enquanto o veredito ainda decide**.

Depois há uma segunda linha de defesa: o `preparePhasePane` também checa
`phaseWatches.has(taskId)` (:570) e `phaseLaunches.isReserved(taskId)` (:571).
Mas o `run_task` **reserva** o `phaseLaunches` antes (board.ts:1249), e a
continuação do veredito (`openGatePane` → `preparePhasePane`) chama **sem
token** (phaseEngine.ts:3079-3086) → a continuação do veredito é a que **perde**
(retorna `null`) e o card cai em `phaseState:'interrupted'` com
*"não foi possível abrir o gate"*.

**Lock:** `run_task` deve **RECUSAR** com receita enquanto o lock estiver
tomado ("a rodada anterior está fechando — aguarde o evento e chame de novo").

### 7.6 🟠 Teto `MAX_PARALLEL_RUNS` furado pelas contagens derivadas

Quatro contagens derivam de `phaseWatches.values()`:
board.ts:1252, :1484, :1531 e phaseEngine.ts:1850. Cada veredito em voo
**subtrai 1** do total percebido. Com 3 vereditos simultâneos numa onda, o
projeto pode chegar a 9 fases abertas com teto de 6.

**Lock:** a contagem de ocupação deve somar `phaseWatches.size` **+ locks
tomados** (exatamente como o `PhaseLaunchCapacityGuard` já soma
`activeCount + pending.size`, phaseLaunchGuard.ts:62).

### 7.7 🔴 O dono fecha o pane no meio do veredito

`onExit` → ipc/pty.ts:582. Com o watch detached, o bloco é pulado (bom). Mas:

- `stopQaRuntime(identity.taskId)` (:586) roda **antes** de qualquer guarda →
  derruba o runtime do produto no meio de um veredito de QA reciclado;
- `ctx.liveGateWaits.delete(identity.taskId)` (:591) casa por `paneId` → apaga
  a espera que o veredito **acabou** de registrar → §6.1 (evidência do gate
  reprovado não é zerada);
- se o veredito rolar de volta (`set`) **antes** do `onExit` chegar, o bloco
  roda: `delete` + card ao backlog, por baixo de um `report` que já respondeu
  "preservado".

**Lock:** o `onExit` deve consultar o lock e, se tomado, **apenas registrar**
(evento na caixa-preta) e deixar a decisão para o dono do lock. Nunca mutar.

### 7.8 🔴 Plano pausado no meio do veredito

`tasks:planStop` (ipc/tasks.ts:275) é síncrono e só mexe no card de plano. As
leituras que importam (`planTask?.status === 'backlog' && planTask.plan?.approvedAt`)
estão em `retryOrBacklog` (:1937) e `openGatePane` (:2802) — **depois** de
awaits. Hoje o comportamento é o desejado: pausou → o veredito é gravado e o
card estaciona.

O risco é de **implementação**: se a conversão "otimizar" lendo o `planTask`
uma única vez no topo do `advancePhase` e reusando, a pausa do dono passa a ser
ignorada e um pane novo nasce depois do "pare AGORA".

**Lock:** ortogonal, mas o plano da Fase 2 deve marcar essa leitura como
**tardia obrigatória** (comentário-âncora).

### 7.9 🟠 `run_task {phase:'finalize'}` × `finalizeTask` em voo

**Já é possível hoje.** `recordGate('approved', …, 'finalize')` persiste
`phaseState:'finalizing'` e só então dispara `void finalizeTask(...)`. Se o
orquestrador chamar `run_task {phase:'finalize'}` nessa janela (o guard exige
exatamente `task.phaseState === 'finalizing'`, board.ts:1270), dois merges do
mesmo card correm.

Mitigação existente: o `gitWorker` serializa as operações git, e o
`mergeTaskWorktree` valida `expectedTargetHead`/`expectedSourceHead` — o
segundo falha limpo. Mas o segundo caminho é o `recoverFinalizingTask`, que
pode **remover worktree e branch** (`completeRecoveredIntegration`, :2244) sob
o primeiro.

**Lock:** `finalizeTask` e `recoverFinalizingTask` precisam **ADQUIRIR** o lock
do card, e o `run_task {phase:'finalize'}` precisa **RECUSAR** com ele tomado.

### 7.10 🟠 `codeReportGuard` escreve `watch.devSnapshot` de dois caminhos

**Já é possível hoje.** `watch.devSnapshot = preparedSnapshot`
(mcpApi/code.ts:195) e `watch.devSnapshot = undefined` (:187/:205) mutam o
objeto **dentro** do registry. Duas execuções concorrentes do guard (poller +
MCP) escrevem o mesmo campo; o `advancePhase` lê `watch.devSnapshot` em :3201 e
compara com o git.

Hoje o resultado prático é benigno: o `snapshotStillExact` re-verifica tudo
contra o git antes de aceitar (:3202-3208), e uma fotografia "roubada" pelo
outro caminho simplesmente reprova com "a fotografia mudou depois dos
diagnósticos". Pós-conversão a janela cresce e o falso-negativo vira rotina.

**Lock:** o guard de report deveria rodar **dentro** do lock, ou o snapshot
deveria deixar de morar no objeto compartilhado (passar como valor).

### 7.11 🟠 Card removido / missão arquivada / projeto relocado no meio

§5.2, §5.3, §5.4. Os três apagam o watch e/ou o card **sem consultar nada**.
`tasks.update` devolvendo `undefined` faz o ramo de aprovação **lançar**
(:3681) — e a exceção, no caminho do `report`, é capturada e vira rollback
`phaseWatches.set` (:759) de um card que **não existe mais**: watch fantasma no
registry para sempre (só o poller o solta, matando um pane que já morreu).

**Lock:** recusar os três durante o lock.

### 7.12 Resumo — o que faz o quê com o lock

| entrante | ação |
| --- | --- |
| tool MCP `report` (veredito) | **ADQUIRIR** (síncrono, na entrada) |
| poller — ramo do marcador `.done` | **ADQUIRIR** (substitui o re-check por referência) |
| `openGatePane` / `retryOrBacklog` / `finalizeTask` (continuações) | **ADQUIRIR** (ou herdar o lock do veredito) |
| `recoverFinalizingTask` | **ADQUIRIR** (watch sintético — chave é o `taskId`) |
| `setPhaseExecutorImpl` (⇄ / `set_phase_executor`) | **ADQUIRIR** (esperar, não recusar — é ordem do dono) |
| `respawnInterruptedPhase` (drain de boot) | **ADQUIRIR** (já tem `phaseLaunches`; somar o lock) |
| `run_task` (todas as formas) | **RECUSAR** com receita |
| `removeTaskCascade` (`tasks:remove` / `delete_task`) | **RECUSAR** |
| `stopMissionExecution` (arquivar/excluir missão) | **RECUSAR** (com a lista dos cards travados) |
| `projects:relocate` | **RECUSAR** |
| poller — ramos `phase-watch-released` e `pane-open-lost` | **RECUSAR** (pular o card) |
| `tasks:update` do renderer | **RECUSAR** (ou forçar `hasActivePane = true`) |
| contagens de `MAX_PARALLEL_RUNS` (4 sites) | **SOMAR** os locks tomados |
| `onExit` do PTY | **CONSULTAR** e não mutar |
| `armGateMcpWatchdog` / watchdog de dev / helper-open / runtime QA | ortogonal |
| `rollbackFailedPaneSpawn` | ortogonal (guarda por `paneId`) |
| `pty:create` (`phaseStillActive`, `pending→running`) | ortogonal (guarda por `paneId`) |
| `completeMissionMerge` | ortogonal (worker serializa + revalida fotografia) |
| `tasks:planStop` | ortogonal — mas **leitura tardia obrigatória** |
| `recordGateDeath` / `gateCooldownUntil` | ortogonal |
| `delegateMany` / `runtimeControl` / `readReviewEvidence` | ortogonal (re-checam por `paneId`) |
| `sweepProjectFiles` | ortogonal-com-ressalva (§8.4) |

---

## 8. Notas de desenho para o plano formal

### 8.1 O lock não substitui o `detach` — ele o protege

O `detach` continua sendo obrigatório e continua tendo que ser **a primeira
coisa síncrona** da transação: é ele que torna inofensivos o `onExit` (§5.5), o
segundo `report` (§7.2) e o `pty:create` (§5.11). O lock resolve o problema
*oposto*: dizer ao resto do app que "sem watch" **não** significa "livre".

Ordem recomendada, síncrona, sem nenhum await entre os três passos:

```
1. lockToken = phaseTransitions.acquire(taskId)   // Symbol, síncrono
2. phaseWatches.detach(taskId)                     // como hoje
3. unlinkSync(marker)                              // como hoje
   ... a partir daqui pode haver await ...
```

### 8.2 O rollback precisa de um contrato novo

Os 7 rollbacks (`set` do mesmo objeto — 5 no `advancePhaseInner`, 2 no
`report.ts`) hoje funcionam porque restauram o objeto idêntico. Pós-conversão
eles precisam, no mínimo: renovar `createdAt` (§7.4), liberar o lock **depois**
do `set`, e não deixar o marcador apagado (hoje o `.done` some antes de
qualquer rollback — o dev precisa reportar de novo pela tool, o que funciona
via `redelivery-accepted`, mas é preciso conferir que o caminho continue aberto
com o lock).

### 8.3 O artefato de review é propriedade da transação

`detach` **não** limpa `reviewArtifact` (por desenho). Se o lock puder ser
abortado por timeout/exceção fora dos ramos conhecidos, o `.diff` privado vaza
até o próximo boot. Recomendação: `finally` do lock chama
`cleanupReviewArtifact` quando o watch **não** foi re-indexado.

### 8.4 `sweepProjectFiles` e o marcador

index.ts:5181 (`if (!phaseWatches.has(tid)) zap(full)`) preserva marcadores de
fase ativa. Durante o lock, `has` é `false` → uma integração ou um 🧹 manual
disparado nesse instante apagaria um `.done` que ainda não foi consumido.
Janela minúscula (o `unlink` do veredito vem logo em seguida), mas é
literalmente o mesmo bug de classe do §7.5. Barato de cobrir.

### 8.5 Matriz mínima do teste novo de corrida

O escopo do plano exige "2 vereditos simultâneos + veredito × boot". A varredura
sugere **7** casos (suíte candidata: `scripts/test-orchestrator-flow.mjs`, que
já cobre 35 asserções do fluxo, ou uma suíte nova `test:phase-transition-lock`
no padrão dos módulos puros):

1. **report × report** no mesmo card (dois awaits do `codeReportGuard` em voo) →
   exatamente **um** avanço; o segundo recebe "sua rodada já FECHOU".
2. **poller × report** com rollback no meio (§7.1) → o poller **não** executa o
   segundo `advancePhase` mesmo com o objeto restaurado.
3. **`run_task` durante o veredito** (§7.5) → recusa com receita; nenhum
   `phase-prepare-cancelled` gerado.
4. **`onExit` do pane no meio** (§7.7) → nenhuma mutação de card; `gateDeathLog`
   **não** incrementa.
5. **plano pausado no meio** (§7.8) → o veredito é gravado e o card estaciona;
   nenhum pane novo nasce.
6. **`removeTaskCascade` no meio** (§7.11) → recusado; nenhum watch fantasma
   sobra no registry.
7. **veredito × boot**: matar o processo entre o `detach` e o `tasks.update` →
   no boot seguinte, o card reconcilia exatamente como no inventário §4.5
   (dev → `backlog`+respawn com re-entrega aceita; gate → `gate-preserved`;
   `finalizing` → `recoverFinalizingTask`), **sem** worktree órfão e **sem**
   receipt inconsistente.

Complemento barato (não é corrida, é regressão): asserção de que
`MAX_PARALLEL_RUNS` conta locks tomados (§7.6).

### 8.6 Primitiva sugerida

`PhaseLaunchGuard` (src/main/phaseLaunchGuard.ts, 47 linhas, módulo puro, já com
suíte `test:phase-launch-guard`) é o molde exato: `reserve` **síncrono** com
comentário explicando por quê, token `Symbol` como prova de dono, `owns`,
`release` que só aceita o dono. Um `PhaseTransitionLock` irmão — mesma casa,
mesma suíte, com `acquire/owns/isLocked/release` **+ `lockedCount(projectId)`**
para as contagens de capacidade — resolve §7.1, §7.2, §7.5, §7.6 e §7.11 sem
introduzir estado em disco (e portanto sem novos casos de reconciliação de
boot, §4.5).
