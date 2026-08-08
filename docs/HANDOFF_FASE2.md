# HANDOFF — Fase 2 (veredito sem barreira síncrona) — CÓDIGO COMPLETO; falta a validação ao vivo do dono

## PRÓXIMA SESSÃO (pós-clear) — leia isto primeiro

1. **ONDE ESTAMOS**: TODO O CÓDIGO DA FASE ESTÁ CORTADO E VERDE — commits
   **c1, c2, c3, c4, c5a, c5b, c5c e c5d FEITOS** (o corte real foi o
   c5a/c5b: advancePhase é ASYNC, o git do veredito viaja ao worker em 1-2
   pacotes e a atomicidade vem do PhaseTransitionLock por card). A matriz
   §5.3 está ligada (races 9→18, com injeção de corrida via pauseGitTrip) e
   o diff passou por revisão adversarial de agente Opus (APPROVED WITH
   FIXES — todos aplicados no c5d, incluindo o F1 🔴: re-check de vigência
   pós-await do sha256 no report). Detalhe por commit nos ESTADOs 1–7 da
   seção "Fase 2" de docs/PLANO_NIVEL_5.md. Documentos-mestres:
   - `docs/FASE2_PLANO.md` — o plano aprovado.
   - `docs/FASE2_MAPA_VEREDITO.md` + `docs/FASE2_MAPA_CONCORRENTES.md` — as
     varreduras (âncoras greppáveis; linhas deslocaram — grep sempre).
2. **PRÓXIMO PASSO: VALIDAÇÃO AO VIVO DO DONO** (critério §1.3 do plano — é
   o que FECHA a fase): rodar uma missão com gates atravessando
   dev→review→QA no app real e conferir com
   `node scripts/bbwatch.mjs --grep stall` que `advancePhase:*` SUMIU do
   ranking de culpados; zero evento `phase-advance-without-lock`;
   contenções de lock (`phase-transition-contention`) raras e explicadas.
   Os casos 3/4/8 da matriz (run_task recusado no meio · onExit no meio ·
   re-entrega × veredito) não são alcançáveis pelo harness (moram fora do
   fecho compilado) — a validação ao vivo é a cobertura deles.
3. **DÉBITOS REGISTRADOS na revisão (decisão do dono, fora do gate)**:
   (a) `test:harness-lifecycle` está VERMELHO (26 falhas) desde a FASE 1 —
   as âncoras leem src/main/index.ts e as implementações migraram para
   phaseEngine/mcpApi; entre os testes mortos estão os que guardavam a
   ordem R7/R8 e o rollback do report (hoje obsoleto: virou
   rollbackVerdictTransaction). Re-apontar as âncoras ou aposentar a suíte
   explicitamente — ela contamina o agregado test:skills-system.
   (b) `gateVerdictFacts` faz 2 varreduras de árvore por viagem (fingerprint
   explícito + o interno do snapshotProblemFor) — R10 cumprido em VIAGENS,
   não em custo; otimização candidata: snapshotProblemFor aceitar
   fingerprint pré-calculado. (c) probes antigos (probe-codex-gate-*, etc.)
   usam o contrato velho do codeReportGuard — sondas descartáveis, só
   atualizar se re-rodar.
4. **GATE VERDE por commit** (o de agora): typecheck node+web +
   orchestrator-flow 39 · mission-verification 25 · integration-queue 14 ·
   pane-permissions 14 · stall-attribution 8 · **phase-transition-lock 9 ·
   phase-verdict-races 18 · mission-worktree 27 · mcp-protocol 5 ·
   mcp-dual-era 32 clients**. Reporter usa linhas `pass N`/`fail N`
   (regex 'pass (\d+)'); o dual-era reporta "MCP dual-era passed: N
   clients".
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
5. **Pendências que não são código**: PUSH (52 commits locais à frente de
   origin — o dono decide) · validação AO VIVO do dono fecha a fase (item
   2 acima) · agentes Opus exigem re-liberação do dono POR SESSÃO.
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
