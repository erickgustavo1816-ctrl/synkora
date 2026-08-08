# FASE 5 — Inventário dos injetores de texto (mapa de migração F2/F3)

Data: 2026-08-08 · varredura completa de `src/main` (agente + verificação
pontual das âncoras críticas). Objetivo do dono (memória
`feedback-zero-digitacao-entre-agentes`): NENHUMA comunicação entre agentes
por texto digitado + Enter.

## 0. A chave de leitura — o funil já é um seam único

Todo o tráfego agente↔agente converge em `Hub.beginInjection` →
`HubDeps.inject` (index.ts, âncora `CHECK 15 F1`): pane com identidade no hub
→ `mailbox.post` + nudge digitado curto; sem identidade → `ptys.inject`
clássico. Como `hub.registerPane` roda no `armPane` (paneLifecycle.ts), TODO
pane de agente (maestro/orquestrador/dev/review/qa/ajudante/livre) tem
identidade desde o spawn ⇒ **todo payload já viaja pelo correio hoje**. O que
ainda é digitado de verdade entre agentes: o NUDGE 📬 (e as exceções §2).

## 1. Caminhos que geram texto digitado (resumo classificado)

Classes: (a) já coberto pelo correio (só o nudge é digitado) · (b) payload
completo — formalmente digitado, hoje cai em (a) via seam · (c) interação
picker que PRECISA ser digitada · (d) pane sem identidade (injeção clássica).

| # | Âncora | O que digita | Classe |
|---|--------|--------------|--------|
| 1 | `hub.ts` `Hub.drain()` | batch `[synkora] N eventos: …` (300ms) | a/d |
| 2 | `hub.ts` `notifyPaneNow()` | `[synkora] <texto>` urgente (~69 call sites via `publish({urgent})`) | a/d |
| 3 | `hub.ts` `notifyPane()` | enfileira p/ drain | a/d |
| 4 | `hub.ts` `publish()` → PM/orquestrador | `${kind}: ${text}` (~176 call sites) | a |
| 5 | `index.ts` `nudgeMailbox()` | **📬 NUDGE — o único texto real do F1**; `ptys.inject` DIRETO, throttle 20s/pane | resíduo F3 |
| 6 | `index.ts` `syncMaestroProjectLifecycle` | instrução longa de etapa | a |
| 7 | `phaseEngine.ts` `retryOrBacklog` (2 ramos) | feedback de gate + skills block — MAIOR payload do sistema | b→a |
| 8 | `phaseEngine.ts` `openGatePane` reciclo | prompt de re-rodada do gate vivo | b→a |
| 9 | `phaseEngine.ts` guardas do report | 5 avisos curtos `[synkora] conclusão bloqueada…` | a |
| 10 | `phaseEngine.ts` `tickPhaseWatches` | 5 recusas de marcador por arquivo | a |
| 11 | `mcpApi/panes.ts` `notify_pane` | mensagem livre do orquestrador (+CORREÇÃO de modelo) | b→a |
| 12 | `mcpApi/helpers.ts` `helperSend` | instrução carimbada OU **resposta de picker crua** | **c — QUEBRADO (§3.1)** |
| 13 | `mcpApi/report.ts` conclusão de ajudante | aviso curto OU payload completo (`noticeMode`) | a/b |
| 14 | `mcpApi/panes.ts` `notify_maestro` | `(de <role> · pane X) texto` — TEM meta causal completa (padrão a copiar) | a |
| 15 | `ipc/pty.ts` onExit ajudante sem report | aviso ao delegador | a |
| 16 | `paneLifecycle.ts` `rollbackFailedPaneSpawn` | aviso de spawn falho (sem meta causal) | a |
| 17 | `ipc/pty.ts` servidor de teste do dono | comando do dev server em pane SHELL — fora do escopo (não é agente); exceção explícita no F3 | d |
| 18 | `index.ts` fallback clássico do seam | payload inteiro p/ pane SEM identidade (teste/simulado) | d |
| 19 | `ipc/pty.ts` `pty:write` | teclado do HUMANO — fora do escopo | — |

`initialPrompt` NÃO é digitado (argv/arquivo no spawn) — nada a migrar.

## 2. O que continua digitado por decisão (exceções do F3)

- Nudge 📬 até o acordar-sem-input entrar (waiter/long-poll — sondas W*).
- `helper_send` com resposta curta de picker («1», «y») — interação de TUI,
  precisa de bypass explícito e AUDITADO (§3.1).
- Item 17 (pane shell do servidor de teste) e item 18 (pane sem identidade).

## 3. BUGS DO F1 descobertos na varredura (consertar no F2)

1. **`helper_send` com picker está QUEBRADO pelo F1** (verificado em
   `mcpApi/helpers.ts` `helperSend` + `HubDeps.inject`): a resposta crua
   («1»/«y») passa por `notifyPaneNow` → seam → ajudante TEM identidade →
   vai para a MAILBOX. O picker do TUI nunca recebe a tecla; a seleção fica
   pendurada. Precisa de rota `rawKeystroke`/`forceInject` que fure o seam,
   com evento auditado (o "último recurso auditado" do plano).
2. **`delivery-injected` mente no caminho do correio**: o seam chama
   `onSubmitted(true)` → o hub reporta `injected` → journal grava
   `delivery-injected` SEM digitação (junto do `mailbox-post`). O critério do
   F3 ("delivery-injected vira anomalia") é inatingível assim. Precisa de
   status novo `mailboxed` na cadeia hub→blackbox.
3. **O nudge é invisível no journal e fura as guardas**: `ptys.inject` direto,
   sem evento blackbox e sem respeitar `composerBusy`/`inFlight`/gap — pode se
   intercalar com injeção clássica fatiada em curso. Precisa de evento
   `mailbox-nudge` + passar pelas guardas do hub.
4. **Retornos de tool mentem**: `notify_pane` responde "ENTREGUE AGORA — a
   linha [synkora] já apareceu no terminal" e `helper_send` "enviado — leia a
   reação" quando na verdade foi para o correio. Corrigir os textos pela via
   real de entrega.
5. (menor) **Throttle de 20s do nudge** pode engolir o acordar da 2ª mensagem
   em <20s num pane ocioso — mitigado de verdade só pelo acordar-sem-input.
6. (menor) **Formatação de terminal vaza para o correio**: prefixo
   `[synkora]` duplicado (hub + ~10 textos do phaseEngine), coalescência
   textual "N eventos" do drain e dedup por texto do mailbox operando sobre
   texto formatado — o correlationId fim-a-fim do F2 substitui isso por
   coalescência por FATO. ~13 chamadas sem `sourcePaneId`/`kind`/
   `correlationId` (itens 9, 10, 16 e o ramo vivo do 7).

## 4. Fatos codex (sonda probe-codex-mailbox-wait.mjs, 2026-08-08)

Vereditos (codex 0.147.0, gpt-5.6-luna, servidor MCP real do app):
- **Long-poll POSITIVO**: tool call segurada 45s e 75s SEM config → resposta
  chega ao modelo (W2/W3); `tool_timeout_sec=300` por servidor funciona (W4).
- **Waiter background NEGATIVO**: `--enable unified_exec` dá functions.exec +
  functions.wait no catálogo (W5a), mas processo background que termina NÃO
  acorda o agente pós-turno (W5 em TUI real: WAITING no rollout, 180s, nunca
  WOKE-UP). Espera codex = DENTRO do turno (wait/tool segurada).
- Desenho F3 resultante: claude ocioso com shell = WAITER background (R12);
  gate claude read-only = long-poll check_messages (R13); codex QUALQUER
  papel = long-poll check_messages (o waiter não existe lá).

Aprendizados de encanamento da própria sonda: perfil de gate codex SÓ
funciona com `codexGateMcpPolicyArgs()` (enabled_tools +
`default_tools_approval_mode="approve"` + required) — sem ela o codex
auto-nega ("user cancelled MCP tool call"), com bypass ligado ou não; stub de
api para `startMcpServer` precisa de `drainInboxFor` FALSY (Promise truthy
corrompe o content da tool); resposta de TUI codex se lê no ROLLOUT, nunca na
tela (eco do prompt = falso positivo — lição R7).

## 5. Estado da migração (2026-08-08)

- **c1 APLICADO**: decisão de correio no hub (hasMailbox/deliverToMailbox
  ANTES das guardas de teclado — entrega imediata), status `mailboxed`
  (journal: `mailbox-post` com meta causal via onDelivery; delivery-injected
  = só digitação real), nudge auditado (`mailbox-nudge`
  typed/throttled/skipped-composer-busy) respeitando o composer, mailbox com
  meta fim-a-fim + dedup por FATO (dedupKey). Suíte test:mailbox-delivery.
- **c2 APLICADO**: §3.1 e §3.4 consertados — helper_send curto vai por
  teclado CRU com `helper-send-raw-keystroke` auditado; retornos de
  notify_pane/helper_send dizem a via real.
- Pendências F2: preencher meta causal nas ~13 chamadas sem origem (§3.6);
  limpar o prefixo `[synkora]` duplicado dos textos do phaseEngine; migrar o
  item 17 para exceção explícita documentada. F3: aposentar o nudge
  (waiter claude + long-poll check_messages nos dois CLIs).
