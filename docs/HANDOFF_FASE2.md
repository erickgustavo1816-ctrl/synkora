# HANDOFF — Fase 2 (veredito sem barreira síncrona) — EM ANDAMENTO

## PRÓXIMA SESSÃO (pós-clear) — leia isto primeiro

1. **ONDE ESTAMOS**: plano formal APROVADO pelo dono e commits **c1, c2 e c3
   FEITOS**, todos verdes. Detalhe por commit nos ESTADOs 1–4 da seção
   "Fase 2" de docs/PLANO_NIVEL_5.md. Os documentos-mestres:
   - `docs/FASE2_PLANO.md` — o plano aprovado (desenho do lock §3, tabela de
     entrantes §3.3, conversão §4, testes §5, fatiamento §6).
   - `docs/FASE2_MAPA_VEREDITO.md` + `docs/FASE2_MAPA_CONCORRENTES.md` — as
     varreduras (âncoras greppáveis; números de linha DESLOCARAM com os
     commits — re-localizar por grep sempre).
2. **PRÓXIMO PASSO: F2-c4 — SERIALIZAR.** Ligar o `PhaseTransitionLock`
   (src/main/phaseTransitionLock.ts, pronto desde o c1) em TODOS os
   entrantes da tabela §3.3 do plano, com advancePhase AINDA SYNC
   (comportamento hoje-idêntico; recusas/contagens já testáveis). Resumo da
   fiação: engine cria o lock e o expõe (ctx.phaseTransitions no
   MainContext); report adquire SÍNCRONO na entrada do veredito (call sites
   A/B + os 2 blocos `bloqueada`); poller do marcador adquire (posse
   substitui o re-check por referência); continuações herdam o token
   (release no settle da cadeia); recoverFinalizingTask e
   respawnInterruptedPhase adquirem; setPhaseExecutorImpl ESPERA
   (waitAndAcquire); run_task/removeTaskCascade/stopMissionExecution/
   projects:relocate RECUSAM com receita; tasks:update trata lock como
   hasActivePane; poller stale/pane-open-lost PULAM card travado; as 4
   contagens de MAX_PARALLEL_RUNS SOMAM lockedCount; sweepProjectFiles
   preserva marcador com lock; onExit só CONSULTA. Depois: c5 —
   DESSINCRONIZAR (§4 do plano, o corte real).
3. **GATE VERDE por commit** (cresceu na fase): typecheck node+web +
   orchestrator-flow 39 · mission-verification 25 · integration-queue 14 ·
   pane-permissions 14 · stall-attribution 8 · **phase-transition-lock 9 ·
   phase-verdict-races 7 · mission-worktree 27**. Reporter usa linhas
   `pass N`/`fail N` (regex 'pass (\d+)').
4. **O HARNESS (c2)**: `npm run test:phase-verdict-races` compila o fecho do
   phaseEngine (65 módulos) com `tsc --noCheck --module node16` para
   `.tmp/phase-verdict-races` e roda o engine REAL em node cru — stubs de
   `electron` E `./gitAsync` via Module._load; ctx fake mínimo (o que o
   createPhaseEngine desestrutura) com TaskStore REAL e fixture git REAL. O
   stub do gitAsync tem o gate `beforeCall` pronto — é ele que pausa o
   veredito em cada await para as corridas do c5 (matriz de 13 casos no
   §5.3 do plano). DESCOBERTA cravada em teste: o prefixo síncrono do
   retryOrBacklog zera verification.dev + evidência do gate reprovador
   ANTES do advancePhase retornar (§6.1 — a ordem que o c5 tem de manter).
5. **Pendências que não são código**: PUSH (44 commits locais à frente de
   origin — o dono decide) · validação AO VIVO do dono fecha a fase
   (critério §1 do plano: advancePhase:* some do ranking de stalls via
   `node scripts/bbwatch.mjs --grep stall`) · agentes Opus exigem
   re-liberação do dono POR SESSÃO.
6. **Regras vivas** (inalteradas): toda edição de src SÓ com app parado
   (checar `Get-Process electron` imediatamente antes — a prova expira; o
   Synkora INSTALADO rodando não importa, é isolado desde e944325) · cada
   commit reversível e verde · commits `fase2:` sem acentos · git add por
   caminho explícito · nunca "aproveitar e refatorar" fora do mapa ·
   higiene de imports por DIFF de órfãos.

## Fora da fase, feito nesta mesma sessão (2026-08-08)

- Empacotado ganhou userData PRÓPRIO (%LOCALAPPDATA%\Synkora) e o microfone
  do SynVoice foi consertado (origem `file:///` sondada em
  probe-file-media-origin; falha de captura agora avisa em vez de silêncio).
  Na main (0c11f19) e portado à branch (e944325); instalador validado pelo
  dono. Dev e instalado agora podem rodar JUNTOS (locks separados) — só não
  abrir o MESMO projeto nos dois.
- Auto-update do app NÃO existe (só o clis ▾ atualiza claude/codex);
  candidato a card futuro: electron-updater + destino de publicação (decisão
  pendente: releases públicos × repo de releases × servidor próprio).
