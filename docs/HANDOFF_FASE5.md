# HANDOFF — Fase 5 (zero digitação entre agentes) — sessão de 2026-08-08 (noite)

## PRÓXIMA SESSÃO (pós-clear) — leia isto primeiro

0. **TEXTO QUE O DONO VAI COLAR** (referência do combinado):
   > Continua a FASE 5 na branch nivel5-fase1. Lê docs/HANDOFF_FASE5.md
   > primeiro. [Validei ao vivo com missão / ainda não validei]. Agentes
   > Opus [liberados / não]. App [aberto / fechado]. Push [feito / pendente].
1. **ONDE ESTAMOS**: TRIAGEM DO RESIDUAL FEITA (ESTADO 9 do
   PLANO_NIVEL_5.md — §1.3 formal fechado, Fase 2 limpa no journal; culpado
   da travadinha do clique NOMEADO: git síncrono no missions:paneSpec,
   ~450ms por missão — card pequeno registrado, NÃO consertado). FASE 5 em
   andamento: sonda codex FEITA (ESTADO F5-1: long-poll POSITIVO ≥75s sem
   config + tool_timeout_sec funciona; waiter background NEGATIVO — espera
   codex é DENTRO do turno), inventário completo dos injetores em
   docs/FASE5_INVENTARIO_INJETORES.md (4 bugs do F1 achados), e F2 c1+c2
   APLICADOS (ESTADO F5-2): entrega de correio imediata com status
   `mailboxed`, nudge auditado, meta causal + dedup por fato no mailbox,
   helper_send picker por teclado cru auditado, retornos honestos.
2. **TAREFA 1 — VALIDAÇÃO AO VIVO DO F1+F2** (pré-condição do F3; nenhuma
   missão rodou desde F6.10 — journals 07-08 zerados de mailbox-*): na
   primeira missão real, `node scripts/bbwatch.mjs --grep mailbox` deve
   mostrar mailbox-post (com sourcePaneId/kind/correlationId no detail) +
   mailbox-nudge (typed/throttled) + mailbox-delivered (carona|check); e
   `--grep delivery-injected` deve mostrar ZERO para panes de agente (só
   pane shell/teste). Agentes reagindo ao bloco "[synkora inbox]" sem
   re-briefing = F1/F2 validados.
3. **TAREFA 2 — F3: aposentar o nudge** (os DOIS lados estão sondados):
   (a) `check_messages` vira LONG-POLL (handler async no mcpServer segura
   até ter mensagem; hoje `api.checkMessages` é sync — mcpServer.ts:904);
   claude gate read-only aguenta 45s+ por call (R13), codex aguenta 75s+
   sem config e `tool_timeout_sec=300` dá folga (sonda W2–W4); calibrar o
   teto por ciclo de re-poll. (b) WAITER background pós-turno é EXCLUSIVO
   claude (R12) — codex NUNCA acorda pós-turno (W5: WAITING no rollout,
   nunca WOKE-UP, provado em TUI real). Prompts/personas ensinam o ciclo de
   espera por CLI. Digitação sobra como anomalia auditada (nunca remover a
   rede inteira).
4. **F2 RESIDUAL (mecânico, baixo risco)**: preencher meta causal
   (sourcePaneId/kind/correlationId) nas ~13 chamadas de hub.notifyPane sem
   origem (phaseEngine itens 9/10 do inventário + paneLifecycle
   rollbackFailedPaneSpawn + ramo vivo do retryOrBacklog) e tirar o prefixo
   "[synkora]" duplicado dos textos do phaseEngine (o hub já prefixa no
   teclado; no correio ele é ruído).
5. **CARD PEQUENO da travadinha (dono decide quando)**: caminho de LEITURA
   do paneSpec (ensureMissionWorktree: hasGitCommit/isExpectedWorktree/
   ensureSynkoraGitExcludes — missionEngine.ts:191) viaja por gitOff;
   mutação fica no main com guarda anti-janela-de-await (padrão da cópia de
   skills F6.8). Stall de BOOT (~1,6s) é overhead de dev não-instrumentado
   (instalado: zero stalls) — não perseguir.
6. **GATE VERDE desta sessão**: typecheck node+web 0 erros ·
   test:mailbox-delivery 9 (SUÍTE NOVA) · helper-completion 14 ·
   orchestrator-flow 39 · mcp-protocol 5 · helper-recovery 9 ·
   phase-verdict-races 18. Débito test:harness-lifecycle segue VERMELHO
   (herdado da Fase 1; decisão do dono pendente: re-apontar × aposentar).
7. **Pendências que não são código**: PUSH (~57 commits locais à frente) ·
   Opus por sessão · validação ao vivo (item 2).
8. **Regras vivas** (inalteradas): edição de src SÓ com app parado
   (Get-Process electron imediatamente antes — a prova expira; o Synkora
   INSTALADO rodando não importa) · commit reversível e verde · commits
   `fase5:` sem acentos · git add por caminho explícito · nunca "aproveitar
   e refatorar" fora do mapa · sondas: resposta de TUI codex se lê no
   ROLLOUT, nunca na tela.

## Fatos novos desta sessão (resumo de 1 tela)

- Journal: §1.3 fechado; travadinha do clique = ipc:missions:paneSpec ×3
  (~450ms cada, git síncrono) — evidência: journal dev 2026-08-07
  19:31:12Z. Instalado (userData próprio) sem nenhum stall.
- Sonda scripts/probe-codex-mailbox-wait.mjs (re-rodável a cada update de
  CLI): W0–W4 long-poll ok · W5a catálogo unified_exec (exec/wait/
  request_user_input) · W5 waited-never-woke. Resultado:
  .tmp/probe-codex-mailbox-wait.json.
- docs/FASE5_INVENTARIO_INJETORES.md: mapa completo dos 19 caminhos de
  digitação + estado da migração (§5).
- Commits: ad74c87 (docs+sonda) · 1300de3 (c1 hub/mailbox/index + suíte) ·
  1da04a2 (c2 helper_send/notify_pane).
