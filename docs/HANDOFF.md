# HANDOFF — Synkora (2026-07-21, fim da noite)

Documento de passagem de bastão. Leia junto com `CLAUDE.md` (arquitetura detalhada +
gotchas — é a fonte técnica principal), `docs/PLANO.md` (plano mestre F0–F5) e
`docs/SKILLS.md` (curadoria de skills p/ F4). A memória persistente do Claude tem
resumos (projeto-synkora, feedback-espelho-sem-mock).

## O que é

Synkora = ADE desktop (clone pessoal do overclock.sh) do Erick. Projetos são "universos"
com departamentos (front/back/qa/design/research), um Maestro (PM conversacional) e seats
(contas de CLIs de IA isoladas por config dir). Visual retrô "papel & painel". Tudo em
PT-BR para o usuário; código em inglês.

## Estado: F0 ✅ F1 ✅ F2 ✅ F3 ✅ · Próximo: validar F3 no uso real + F3.1 + F4 (skills)

Rodar: `npm run dev` (electron-vite; mudanças em src/main exigem restart; renderer tem HMR).
Typecheck: `npm run typecheck`. Preview UI em browser: http://localhost:5173 (devMock).
Git: repo iniciado, SEM COMMIT ainda (usuário nunca autorizou — perguntar!).

## Princício inegociável do usuário (aprendido a ferro nesta sessão)

NADA MOCADO. Tudo que aparece na UI tem que ser o real: listas de modelos vêm do CLI,
comandos slash executam de verdade, execução acontece em TERMINAIS REAIS visíveis, e
"não dá" só depois de sondar protocolo + binário (2x a limitação aparente era contornável:
/fast do codex = service tier `priority`; /fast do claude = settings `{"fastMode":true}`).

## Arquitetura atual (mapa rápido — detalhes no CLAUDE.md)

- `src/main/maestroSession.ts` — painel de fundo CLAUDE: processo `claude -p` persistente
  em stream-json bidirecional (--include-partial-messages --permission-prompt-tool stdio).
  Handshake `initialize` devolve caps REAIS (comandos, modelos iguais ao seletor do TUI,
  conta). set_model troca modelo AO VIVO. Interrupt via control_request (validado).
- `src/main/codexSession.ts` — painel de fundo CODEX: `codex app-server` (JSON-RPC v2).
  thread/start com persona em developerInstructions; thread/resume (sessionId salvo como
  `codex-thread:<id>`); model/effort/serviceTier são overrides POR TURNO; turn/steer =
  steering; aprovações são requests JSON-RPC respondidos com accept/acceptForSession/
  decline; runSlash mapeia /status /usage /compact /review /diff /init /permissions
  /rename /goal /mcp /skills /fast a RPCs reais.
- Ambos implementam a MESMA interface de eventos (`SessionEvent`/`MaestroBackend`).
- `src/main/index.ts` — IPC + orquestração do pipeline F3 (ver abaixo) + syncBoard
  (.synkora/BOARD.md) + uiSender (última janela; sessões sobrevivem a reload).
- `src/main/worktree.ts` — worktree/branch por tarefa + merge --no-ff + cleanup (smoke ok).
- `src/main/pty.ts` — PTYs dos panes; TEE da saída (ANSI limpo, flush 1,5s, dedupe) para
  transcript + heurística ATTENTION_RE que detecta prompts de aprovação nos TUIs.
- `src/main/catalog.ts` — modelos POR SEAT: claude via handshake initialize efêmero (sem
  tokens), codex via `codex debug models`. Cache renderer por `cli:seatId`.
- Renderer: `Board.tsx` (kanban + chat do Maestro + autocomplete "/" + pickers reais +
  toggle 🤖 harness), `PanesView.tsx` (panes reais + espelhos dormentes), `RunPanel.tsx`
  (MaestroLine/PermPicker compartilhados + espelho de run — DORMENTE, ver nota), 
  `TerminalPane.tsx`, `store.ts` (zustand), `App.tsx` (assinaturas de eventos).

## Pipeline F3 (como funciona HOJE — 100% panes TUI reais)

1. "▶ executar" (ou dispatcher com 🤖 harness auto ligado) → `preparePhasePane('dev')`:
   cria worktree (branch task/<id8> em userData/worktrees/; sem git = direto no projeto),
   registra watch e devolve spec → renderer abre PANE TUI REAL no worktree com o prompt
   da tarefa + instrução de criar `.synkora/runs/<id>.done` ao concluir.
2. Poller (3s) vê o .done → abre pane real 🧐 REVISÃO (gate 1; política do dept 'qa',
   fallback seat do dev) → revisor escreve `.synkora/runs/<id>.review.verdict` com
   "aprovada" ou "reprovada: motivo" → main parseia e FECHA o pane do gate.
3. Aprovada → pane real 🔎 QA (gate 2, status qa) → `<id>.qa.verdict` → aprovada →
   fecha pane dev, merge --no-ff, limpa branch → done. Conflito → branch preservada.
4. Reprovada em qualquer gate: com autopilot e task.cycles < 2, o feedback é DIGITADO no
   pane vivo do dev (evento tasks:feedback → pty.write; pane fechado → reabre com o
   feedback no prompt). Ciclos esgotados → análise com task.feedback.
5. Transcript de TUDO (tee dos panes) em `.synkora/runs/<id>.md`; board em
   `.synkora/BOARD.md` — a persona do Maestro manda ler ambos (nunca presumir).
6. Card mostra runSeat/runModel/cycles/feedback; card+pane PULSAM (needs-perm) quando o
   tee detecta prompt de aprovação; some quando o usuário digita no pane.
7. Dispatcher: 1 execução por seat, máx 3 por projeto, ordem de criação, só tarefa com
   política; redispara a cada mutação de tarefa/fim de fase.

NOTA: o espelho headless (TaskRun/RunPanel/tasks:run* IPCs de steering/perm) ficou
DORMENTE no código (taskRuns sempre vazio) — era a v1 da F3; o usuário exigiu panes
reais. Não apagar sem conversar; pode voltar como modo alternativo ou para F4.

## Maestro (chat espelho — sem TUI embutido, foi removido)

- Painel de fundo persistente por projeto (claude ou codex, por seat), com stream ao
  vivo, ferramentas com input real expandível, permissões com seletor ↑↓, ⏹ parar,
  steering durante o turno, rate-limit real, linha "painel de fundo pronto · conta/plano".
- "/" abre autocomplete com a lista REAL de comandos; claude faz passthrough de QUALQUER
  comando (/usage, /compact, /fast, skills…); codex mapeia os dele a RPCs; comandos de UI
  do TUI respondem com explicação/alternativa. /model e /effort com dados reais e ✓.
- /fast: claude via settings fastMode (respawn com --resume); codex via serviceTier
  priority por turno. /context: teto AUTOMÁTICO pela janela real do modelo ([1m]→1M,
  codex modelContextWindow); /context <n> fixa, /context auto volta.
- /estudar: claude one-shot headless; codex CodexSession com sandbox read-only +
  approvalPolicy never. Sempre mata o painel e reseta sessão p/ ler o dossiê novo.
- Sessões/modelo/effort/log persistem por projeto (userData/maestro.json); trocar de
  SEAT reseta modelo/effort (são por CLI). Altura do painel persiste (localStorage).
- ⏹ também aborta /estudar (surveyAborts) e turnos codex recém-disparados (wantInterrupt).

## Gotchas técnicos (os novos desta sessão; os antigos seguem no CLAUDE.md)

1. `--settings` JSON no Windows com shell:true precisa de DUPLA serialização
   (JSON.stringify(JSON.stringify(obj))) — senão o cmd come as aspas.
2. Panes são do RENDERER: o main não cria PTY sozinho — dispatcher manda 'panes:open' e
   o renderer addPane. Fases fecham via 'panes:close' (Pane tem role dev|review|qa).
3. Vereditos/conclusão por ARQUIVO (marcadores em .synkora/runs/) — robusto contra
   qualquer CLI, mas depende do agente criar o arquivo (o prompt instrui com ênfase).
4. Worktree em uso no Windows: se o pane dev ainda está aberto no worktree na hora do
   merge, o cleanup (worktree remove/branch -D) pode falhar silencioso — merge ok,
   sobras ficam até o pane fechar.
5. uiSender = último WebContents que falou com o main; sessões persistem a reloads do
   renderer e os eventos vão para a janela nova.
6. codex app-server: schemas oficiais via `codex app-server generate-json-schema`;
   TUI resume: `codex resume <SESSION_ID>` existe (handoff usa).
7. Heurística de aprovação (ATTENTION_RE) pode dar falso positivo — é só pulso visual.
8. catalog claude = spawn efêmero do handshake: initialize responde e o processo morre,
   sem custo de tokens.

## Decisões do usuário (não reverter sem perguntar)

- Design retrô papel/painel — NADA de dark futurista.
- NADA mocado; espelhos só quando são espelhos DE ALGO REAL rodando.
- Execução/gates em PANES TUI REAIS visíveis (espelho headless rejeitado 2x).
- Humano define política de modelos; IA classifica peso; harness aplica.
- Review de código ANTES do QA (2 gates). Bugs são tipo de tarefa, não departamento.
- Card travado quando em execução; interação vai direto no pane executor.
- Card deve MOSTRAR tudo (seat/modelo/ciclos/feedback) e GRITAR quando precisa de humano.
- TUI embutido do Maestro foi REMOVIDO (redundante) — não recriar sem pedir.
- Retry automático dev↔gate com teto de 2 ciclos; depois, humano decide.

## Pendências / não validado

- Pipeline reformado (panes reais + marcadores + retry) AINDA NÃO validado de ponta a
  ponta pelo usuário — primeira coisa a fazer: rodar uma tarefa completa e caçar arestas.
- F3.1: autonomia por DEPT (toggle 🤖 é global), custo por fase (perdido na migração p/
  panes; recuperável parseando transcript), review combinado front+back (plano original).
- Aprovações reais do codex (requestApproval) nunca dispararam num caso real observado.
- Login por seat codex (CODEX_HOME isolado) não conferido no app; smokes usaram ~/.codex.
- Commit inicial do git NUNCA foi feito (perguntar antes).
- Espelho headless dormente (ver nota no pipeline).

## Próximas fatias (ordem recomendada, alinhada com o usuário)

1. USAR a F3 num projeto real (luma-calculadora) até o gate do roadmap passar: feature
   completa sem digitar em terminal (fora as interações que o usuário QUER fazer no pane).
2. F3.1 (arestas acima, conforme doer no uso).
3. F4 skills: biblioteca versionada por dept (docs/SKILLS.md pronto), injeção automática
   no workspace do pane (.claude/skills do dept no preparePhasePane) e pipeline de
   planejamento do PM (grill-me → PRD → issues). Gate: planejar o app de celular.
4. F5 voz (push-to-talk + Whisper + notificações).
