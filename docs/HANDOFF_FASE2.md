# HANDOFF — Fase 2 (veredito sem barreira síncrona) — CONCLUÍDA E VALIDADA PELO DONO (2026-08-08)

## PRÓXIMA SESSÃO (pós-clear) — leia isto primeiro

0. **TEXTO QUE O DONO VAI COLAR** (referência do que foi combinado):
   > Continua o nível 5 na branch nivel5-fase1. Lê docs/HANDOFF_FASE2.md
   > primeiro (seção "PRÓXIMA SESSÃO"). A Fase 2 está concluída e validada.
   > Tarefas, na ordem: (1) triagem da travadinha residual de abrir projeto
   > pelo journal (bbwatch --grep stall); (2) começar a FASE 5 — zero
   > digitação entre agentes (correio MCP); (3) se sobrar, sonda do
   > SynVoice mais rápido. Agentes Opus [liberados / não]. App [aberto /
   > fechado]. Push [feito / pendente].
1. **ONDE ESTAMOS**: FASE 2 CONCLUÍDA — commits c1…c5d todos verdes, matriz
   de corridas ligada (races 18), revisão adversarial aplicada, e o dono
   VALIDOU AO VIVO ("melhorou bastante; nada se compara ao que estava
   antes"). Detalhe por commit nos ESTADOs 1–8 da seção "Fase 2" de
   docs/PLANO_NIVEL_5.md. Documentos-mestres: docs/FASE2_PLANO.md +
   docs/FASE2_MAPA_VEREDITO.md + docs/FASE2_MAPA_CONCORRENTES.md (âncoras
   greppáveis; linhas deslocaram — grep sempre).
2. **TAREFA 1 — TRIAGEM DO RESIDUAL (barata, fazer primeiro)**: o dono
   relatou "leve travadinha ao clicar no projeto" (ABERTURA do projeto —
   não é o veredito). `node scripts/bbwatch.mjs --grep stall` no journal do
   uso de 2026-08-08+ NOMEIA o culpado (Fase 0 instrumentou boot:*, ipc:*,
   mcp:*, spawn). De quebra, fechar o critério §1.3 formal: advancePhase:*
   fora do ranking · zero `phase-advance-without-lock` · contenções
   (`phase-transition-contention`) raras. Culpado = renderer/WebGL/spawn →
   evidência da FASE 3 (multi-renderer, Vertente B já decidida), NÃO
   consertar na mão; culpado barato e nomeado → card pequeno.
3. **TAREFA 2 — FASE 5: ZERO DIGITAÇÃO ENTRE AGENTES** (a prioridade que o
   dono declarou: "depois vai resolver a questão do MCP"). O plano formal é
   a seção "Fase 5" de docs/PLANO_NIVEL_5.md; a ordem do dono está na
   memória feedback-zero-digitacao-entre-agentes. Estado real: o correio F1
   (mailbox durável + entrega de carona nos resultados de tools) está EM
   PRODUÇÃO desde F6.10; o que resta digitado é o AVISO curto "📬 …" e os
   fallbacks. Pré-condição do plano: validar o F1 ao vivo — dá para provar
   pelo journal (eventos mailbox-post/mailbox-delivered carona|check) antes
   de desenhar. As sondas que provam o caminho do zero absoluto: R12
   (WAITER em background acorda pane ocioso sem digitar) e R13 (long-poll
   de check_messages para gates read-only) — falta sondar o equivalente
   CODEX antes de generalizar (regra: sonda antes de afirmar).
4. **TAREFA 3 (se sobrar) — SYNVOICE MAIS RÁPIDO** (pedido do dono
   2026-08-08: a transcrição demora perceptível após soltar a gravação;
   "poderia ser quase instantâneo"). Diagnóstico honesto: o fluxo atual é
   NÃO-STREAMING (grava tudo → sobe o arquivo → espera o modelo processar o
   clipe inteiro → texto) — a espera é majoritariamente da OpenAI, mas o
   DESENHO amplifica. Três degraus, sondar antes de mexer (synVoice.ts):
   (a) BARATO: conferir/trocar o modelo para o transcribe MINI (mais
   rápido) + `stream=true` no /v1/audio/transcriptions (o texto começa a
   chegar antes do fim do processamento — corta a latência percebida);
   (b) MÉDIO: transcrição em STREAMING DURANTE a gravação via Realtime
   API/WebSocket — ao soltar o botão o texto já está ~pronto (é o único
   caminho para "quase instantâneo"); custo: reescrever o fluxo de captura
   para chunks + WS no main, mais pontos de falha; (c) descartar por ora:
   modelo local (whisper.cpp) — qualidade/manutenção não compensam. Regra
   viva: sondar a API real com a chave do dono ANTES de prometer números.
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
5. **Pendências que não são código**: PUSH (~54 commits locais à frente de
   origin — o dono decide) · agentes Opus exigem re-liberação do dono POR
   SESSÃO · débito test:harness-lifecycle vermelho (item 3 da lista de
   débitos acima) aguarda decisão do dono (re-apontar × aposentar).
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
