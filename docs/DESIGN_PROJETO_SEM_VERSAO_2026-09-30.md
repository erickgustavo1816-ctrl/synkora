# Projeto sem versionamento — design (2026-09-30)

> Ordem do dono: "hoje o Synkora é muito bom com projetos que mexem com Git, mas
> se eu quero, por exemplo, fazer apenas um documento, ele se torna
> burocrático". Funcionalidade GRANDE e nova — design do zero, sem remendo.

## 1. O que é

Um projeto nasce **versionado** (o de sempre) ou **sem versionamento**, por um
interruptor no modal de criação. Sem versionamento:

- não existem **versões**, **mapa/planejamento**, **worktree**, **commits**,
  **fila ⇪**, **release** nem **revisor** (não há diff para revisar);
- a missão edita a **pasta do projeto direto** — o efeito é imediato;
- **uma missão aberta por vez** (sem isolamento não há como ter duas); com a
  missão aberta **não existe trilho lateral de missões**: a missão É a tela;
- o máximo de cerimônia é o dono **finalizar** a missão.

### Decisões do dono (2026-09-30)

1. **Só pasta SEM Git.** Se a pasta escolhida tem `.git`, o interruptor trava
   em "versionado" e o main recusa `versioning: 'none'`.
2. **Definitivo por enquanto.** Converter depois fica para uma missão futura.
3. **Depois de finalizar:** tela de Início limpa + **histórico** das missões
   finalizadas (reabrir o chat em modo leitura).
4. **Sem rede de desfazer** nesta entrega: as edições caem direto na pasta; os
   cartões de diff do chat seguem mostrando o que mudou.

## 2. A costura única

`src/shared/projectVersioning.ts` (puro, compartilhado main + renderer):

- `Project.versioning?: 'git' | 'none'` — só a exceção é gravada; ausente =
  `'git'`. **Toda leitura passa por `projectVersioning()` /
  `isUnversionedProject()`** — nunca `project.versioning === ...` espalhado.
- `openSoloMission(missions, projectId)` — a regra de uma missão por vez
  (status `ativa`/`integrando` ocupa; `concluida` é histórico).
- `unversionedRefusal(capability)` — o texto PT-BR de TODA recusa, com a saída
  nomeada (regra da casa: beco sem saída é bug).
- `MissionFinishResult`, `ProjectFolderInspection`.

A modalidade é a **intenção** gravada no nascimento: nunca se infere do disco.
Num projeto sem versionamento **nenhum processo git é iniciado pelo Synkora**
(nem probe de leitura).

## 3. Regras do servidor (o main é a autoridade; esconder botão não basta)

| Área | Projeto sem versionamento |
|---|---|
| `projects:create(name, path, gitUrl?, versioning?)` | `'none'` + `gitUrl` → recusa `git-remote`; `'none'` + pasta com `.git` → recusa `git-folder`; sem clone/init/remote/`ensureSynkoraGitExcludes`. Baseline de segurança continua. |
| `projects:inspectFolder(path)` | NOVO. `{ exists, hasGit, empty }` por filesystem (sem git). |
| `missions:create` | Só `missionType` dev; planejamento/release recusados. Sem versão (nem `ensureDefaultVersion`), sem git init, sem worktree/branch/baseBranch/versionId. Já existe missão aberta → recusa `second-mission` (checada ANTES do primeiro await, contra corrida). |
| cwd da missão (`missions:guiSpec`, `shellSpec`, rearme MCP, helpers) | `project.path`. Nunca gravar `project.path` em `mission.worktree`. Papel `reviewer` recusado (`review`). |
| `missions:finish(id)` | NOVO. Só projeto sem versionamento (versionado recusa: lá é o ⇪). Encerra chat do dev, **ajudantes** (antes de liberar a próxima missão — eles escrevem na mesma pasta) e terminais da missão; grava `status: 'concluida'` + `completedAt`. Nada de merge/discard/clean/worktree remove. Idempotente em missão já concluída. |
| `missions:update` | Troca de status recusada (fim é só por `finish`; reabrir concluída → recusa `reopen`). Título/objetivo seguem editáveis. |
| `missions:remove` | Missão concluída sai do histórico: só o registro (e o chat arquivado), nenhum caminho de worktree. |
| `missions:integrate`, tickets, `integration_*` | Recusa `integration`. Nenhum ticket nasce. |
| `missions:workspaceFiles/workspaceFileDiff/commits/commitDiff` | Recusa `history` (a tela nem chama). |
| versões/backlog (`createVersion`, `directRelease`, `releaseChat`) | Recusa `versions`/`release`. `listVersions` devolve `[]`. |
| planejamento (`projects:planningGuiSpec`, `plans:*` de escrita, role `gui-planner`) | Recusa `planning`. |
| Terminal de teste (`panes`) | Roda na raiz do projeto, sem worktree de versão. |
| Arquivos (`ipc/files`, `fileActions`) | Raiz autorizada = `project.path` para a missão aberta. |
| Relocar pasta | Missão aberta: encerra chat/ajudantes/terminais; reabrem no caminho novo (o cwd sai de `project.path`). |
| Boot, recovery, Hub, `syncBoard`, sweep, anexos/clipboard, diagnóstico exportado | Pulam **toda** chamada git (excludes, prune, recovery de integração/release, `gitEvidence`) — o filtro acontece ANTES da chamada. |
| Contexto (`context_*`) | Memória de projeto/missão preservada; sem `projectContextSnapshot` (nenhum git) e sem vocabulário de branch/publicação/versão. |
| LSP `lsp_diagnostics` sem `files` | Sem git para saber "o que mudou": recusa com receita "passe `files`". |
| Codex `/diff` | Recusa `history`. |

## 4. O agente (persona e catálogo)

- **Contrato novo** para o dev de projeto sem versionamento (não é o
  `DEV_CONTRACT` com remendos): trabalha DIRETO na pasta do projeto, as edições
  valem na hora, não há commit/branch/⇪/release/versão/mapa; só uma missão por
  vez; ao terminar chama `mission_summary` e diz que está pronto — **quem
  finaliza é o dono**. Browser, ajudantes, skills, commentary, plan_approval,
  LSP, mobile seguem iguais. Textos de delegação/skills que dizem "morre com o
  worktree" ganham a verdade deste modo (a pasta é permanente; ajudante
  cancelado não desfaz nada).
- **Catálogo MCP** por modalidade, decidido no `buildServer`: sem
  `integration_*`, sem kit de planos, sem release; `mission_summary` fica
  (recibo fala em "histórico do projeto", não em versão).

## 5. A tela (o mockup é o contrato visual)

`docs/mockups/projeto-sem-versao-2026-09-30.html`, APROVADO pelo dono em
2026-09-30 com uma troca: a "orelha" do avatar saiu (parecia documento) e a
marca do modo é o **selo de pasta** (opção B de
`docs/mockups/projeto-sem-versao-marca-2026-09-30.html`) no rail, no cabeçalho
e no card da Home, sempre com o selo textual "sem versionamento" onde há
espaço. Mais decisões da aprovação: Arquivos segue como ABA; apagar missão do
histórico entra nesta entrega (na tela de leitura, confirmação na própria
linha); o botão "Pedir revisão" NÃO existe neste modo; o objetivo no Início é
opcional; o contraste do botão laranja da casa fica para missão própria. Cenas: modal de criação com o interruptor (ligado,
desligado, travado por Git) · Início sem missão · Início com histórico · missão
aberta em tela cheia (sem trilho de missões, sem chips de versão/fila, com
FINALIZAR) · confirmação de finalizar · missão finalizada aberta em leitura ·
card da Home do projeto sem versionamento.

Reaproveitado sem mexer: `GuiPane`, `MissionStageHead`, `GuiSeatPick`, moldura
`WorkspacePanels`, painéis Browser/Mobile/Frota, `FilesView`, `TerminalPane`,
`NoticeStack`, `ProjectRail`. Fora deste modo: `MissionColumn`, abas
Mapa/Versões, `ProjectDashboard`, painéis Trabalho/Histórico/Release,
`MissionHeaderActions` (⇪), fontes commits/branches da paleta.

## 6. Frota e fronteiras de arquivo

| Frente | Dono | Arquivos |
|---|---|---|
| Contrato | dev da missão | `src/shared/projectVersioning.ts`, tipos em `projects.ts`/preload/`store.ts` |
| Back A — domínio | GPT 6 Astra xhigh | `projects.ts`, `ipc/projects.ts`, `projectFolder.ts`, `missions.ts`, `missionEngine.ts`, `missionLifecycle.ts`, `ipc/missions.ts`, `ipc/backlog.ts`, `backlog.ts`, `directRelease.ts`, `releaseChat.ts`, `ipc/plans.ts`, `ipc/panes.ts`, `ipc/files.ts`, `fileActions.ts`, `mainContext.ts`, módulo novo `soloMission.ts` + testes novos |
| Back B — agente e pollers | GPT 6 Astra xhigh | `guiMissionContracts.ts`, `mcpServer.ts`, `guiDelegateMcp.ts`, `guiPlannerArm.ts`, `projectContextTools.ts`, `projectContextCatalog.ts`, `guiLspTools.ts`, `codexSession.ts`, `guiDelegationWiring.ts`, `missionSummary.ts`, `index.ts`, `hub.ts`, `ipc/gui.ts`, `ipc/misc.ts`, `diagnostics.ts` + testes novos |
| Mockup | Opus 5.5 xhigh | `docs/mockups/projeto-sem-versao-2026-09-30.html` |
| Front A / Front B | Opus 5.5 xhigh | definidos depois do mockup aprovado |

Mudança fora da fronteira = relatar, nunca editar.

## 7. Testes exigidos (cada um FALHA no código velho)

- ausência de `versioning` preserva o legado; `'none'` gravado e relido;
- criar projeto `'none'`: recusa pasta com `.git` e `gitUrl`; zero chamadas git;
- criar missão: cwd = raiz, sem versão/worktree/branch; segunda missão aberta
  recusada (inclusive duas criações concorrentes);
- finalizar: encerra dev + ajudantes + terminais; bytes da pasta intactos;
  nenhum caminho alcança discard/clean/restore/worktree remove; libera a próxima;
- versões/planejamento/release/integração/reviewer recusados com a receita;
- boot/recovery/Hub/anexos não iniciam git num projeto `'none'`;
- persona/catálogo do dev sem versionamento não anunciam commit/⇪/versão/mapa.

## 8. Limites conhecidos (registrados na integração do back, 2026-09-30)

- **Saída dos processos.** `missions:finish` derruba chat, ajudantes (inclusive
  os órfãos, pelo motor real) e terminais antes de gravar a conclusão; a morte
  da árvore de processos do SO é assíncrona e não é aguardada. A próxima missão
  só nasce depois de o dono escrever o título e escolher a conta, então a
  janela é desprezível — tornar o encerramento aguardável atravessaria
  `guiSessions`/`maestroSession`/`codexSession`/`guiHelperSessions`/
  `guiProcessTree` e fica para quando houver motivo.
- **Pastas internas.** Como em todo projeto, o Synkora grava `.synkora/`
  (entregas de ajudantes, capturas, baseline de segurança) e as skills em
  `.claude/` e `.agents/` dentro da pasta. Num projeto versionado o Git as
  esconde; aqui elas aparecem na pasta do dono.
- **Testes nativos.** Módulos de `src/main` importam `shared/` sem extensão (o
  que os builds tsc/bundler exigem); as suítes que os carregam com
  `--experimental-strip-types` usam `scripts/test-unversioned-agent-loader.mjs`.
