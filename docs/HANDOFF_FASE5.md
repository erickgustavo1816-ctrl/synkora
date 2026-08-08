# HANDOFF — Fase 5 (zero digitação entre agentes) — 2026-08-08 (sessão 2, "bora, continua")

## PRÓXIMA SESSÃO (pós-clear) — leia isto primeiro

0. **TEXTO QUE O DONO VAI COLAR** (referência do combinado):
   > Continua a FASE 5 na branch nivel5-fase1. Lê docs/HANDOFF_FASE5.md
   > primeiro. [Validei ao vivo com missão / ainda não]. Agentes Opus
   > [liberados / não]. App [aberto / fechado]. Push [SÓ quando terminar
   > tudo — decisão do dono 2026-08-08].
1. **ONDE ESTAMOS** (ESTADOs F5-1..F5-3 do PLANO_NIVEL_5.md): a Fase 5 está
   com o CÓDIGO COMPLETO até o F3 — falta só a validação ao vivo e a
   decisão final do nudge.
   - Triagem (ESTADO 9): §1.3 fechado; travadinha do clique NOMEADA e
     **APLICADA** (missionWorkspaceReadout via gitWorker — pedido explícito
     do dono nesta sessão).
   - Sonda codex (F5-1): long-poll POSITIVO (75s+ sem config;
     tool_timeout_sec funciona) · waiter background NEGATIVO (codex nunca
     acorda pós-turno — W5 provado no rollout).
   - F2 (F5-2): correio entrega IMEDIATO com status `mailboxed` (journal:
     mailbox-post com meta causal; delivery-injected = só digitação real),
     nudge auditado (mailbox-nudge), dedup por FATO (dedupKey), helper_send
     picker por teclado cru auditado, retornos honestos.
   - F3a (F5-3): check_messages é LONG-POLL (segura 45s; retorna na hora da
     chegada). **Validado com codex REAL** (sonda W6: longpoll-mail-read).
   - F3b (F5-3): WAITER claude — GET /mail-wait (bearer, teto 10min, close
     drena pendurados) + env SYNKORA_MAIL_WAIT_URL + hint por CLI no
     devContract/orquestrador/PM. **Smoke do curl exato validado** (pendura
     e responde MAIL no instante do post).
2. **TAREFA 1 — VALIDAÇÃO AO VIVO** (primeira missão real no DEV — o
   instalado roda binário antigo; os fixes só entram nele num novo
   empacotamento): `node scripts/bbwatch.mjs --grep mailbox` deve mostrar
   mailbox-post (meta causal no detail) + mailbox-nudge
   (typed/throttled/skipped-composer-busy) + mailbox-delivered
   (carona|check); `--grep delivery-injected` ≈ zero em pane de agente
   (exceções auditadas: helper-send-raw-keystroke, pane shell). Observar:
   gate reprovador esperando via loop de check_messages (long-poll) e dev/
   orquestrador claude armando o waiter (`curl … /mail-wait` em background).
3. **TAREFA 2 — APOSENTAR O NUDGE (decisão do DONO, só após a tarefa 1)**:
   com waiter+long-poll validados ao vivo, o nudge 📬 vira redundância —
   remoção = anomalia auditada no lugar (o F3 do plano). NUNCA remover sem
   a validação (regra: nunca remover a rede inteira).
4. **RESIDUAIS menores** (baixo valor, sem pressa): meta causal
   (sourcePaneId/kind) nas ~13 chamadas de hub.notifyPane do harness — nota:
   sem pane de origem real o pulso direcional não existe; o ganho é só
   coalescência, reavaliar se vale; item 17 do inventário (pane shell do
   servidor de teste) documentado como exceção do F3.
5. **GATE VERDE da sessão 2**: typecheck 0 · mailbox-delivery 10 ·
   mail-wait 2 (SUÍTE NOVA) · mission-worktree 29 (+2) · helper-completion
   14 · orchestrator-flow 39 · mcp-protocol 5 · mcp-dual-era 32 ·
   phase-skill-prompts 9 · pty-recovery 4 · helper-recovery 9 ·
   phase-verdict-races 18. Débito test:harness-lifecycle segue VERMELHO
   (herdado da Fase 1; decisão pendente do dono).
6. **Pendências que não são código**: PUSH só quando a Fase 5 fechar
   (ordem do dono) · Opus por sessão · empacotamento novo para o instalado
   ganhar F2/F3 (candidato: depois da validação ao vivo).
7. **Regras vivas**: edição de src SÓ com app parado (Get-Process electron
   — o Synkora INSTALADO rodando não importa, é isolado) · commits `fase5:`
   sem acentos · git add por caminho explícito · sondas: resposta de TUI se
   lê no ROLLOUT, nunca na tela (2ª reincidência salva pela regra nesta
   sessão: o eco do prompt deu falso positivo no W5) · destructuring com
   default: `undefined` explícito ATIVA o default (bug real na suíte
   mail-wait).

## Teste sem missão do dono (2026-08-08, noite — agente livre + 2 ajudantes)

- PROVOU o correio ao vivo: zero delivery-injected; o "empurrão" do
  delegador foi mailbox-post → nudge 📬 (1 linha) → check_messages 4s
  depois. O texto visto no pane do ajudante é o ECO do initialPrompt
  (spawn), não digitação.
- ACHOU BUG REAL: scope de skills do ajudante sem projectId → activate_skill
  recusava sempre → report(done) em beco (os 2 ajudantes travaram; o
  delegador pollou list_helpers 15× + helper_output 8× esperando um report
  que nunca viria). CORRIGIDO em a3267be, junto com: hint de espera no
  agente livre, regra DELEGOU-NÃO-ASSISTE (retorno do delegate + idle
  waiter hint de todos os papéis) e teto do livre 1→4 ajudantes.
- RE-TESTE 2 (22:51): 2 ajudantes em PARALELO ✓, activate_skill ✓, reports
  pelo correio ✓ — mas o 📬 foi digitado com long-poll pendurado (reclamação
  do dono: "não teria que o Synkora avisar") e um ajudante do teste seguinte
  (23:00, 1º com contrato no system prompt) imprimiu a resposta SEM chamar
  report. Fixes em bc8cdd7: nudge só para quem NÃO tem espera armada
  (hasWaiters checado ANTES do post; outcome skipped-waiter-armed), throttle
  re-agenda em vez de engolir, linha de fecho do report de volta ao turno
  visível, lembrete "ainda esperando?" no drain do check_messages.
- **RE-TESTE FINAL (23:10) — VALIDADO PELO DONO ("funcionou certinho, sem o
  aviso digitado")**: 2 delegates paralelos, 2 reports via MCP, 2×
  `skipped-waiter-armed` (zero digitação — o post acordou o long-poll), o
  principal manteve o loop entre as respostas e consolidou as duas. O
  vocabulário completo do correio está validado ao vivo SEM missão. O nudge
  não precisa ser "aposentado": o desenho final é o CONDICIONAL (typed =
  rede para pane sem espera armada; é a exceção auditada do F3).

## Fatos novos da sessão 2 (resumo de 1 tela)

- probe-codex-mailbox-wait.mjs ganhou W6 (check_messages long-poll com
  codex real → longpoll-mail-read em 23s, mensagem chegando aos 12s).
- Endpoint /mail-wait: MAIL/TIMEOUT em texto plano; instrução de chamar
  check_messages no corpo da resposta (o agente acordado sabe o que fazer).
- Commits sessão 2: 6374f7f (travadinha paneSpec) · e516169 (F3a long-poll
  + prefixos) · e99c63f (F3b waiter + hints) · +docs.
- Commits sessão 1: ad74c87 (triagem+sonda+inventário) · 1300de3 (F2 c1) ·
  1da04a2 (F2 c2) · c8a187c (handoff v1).
