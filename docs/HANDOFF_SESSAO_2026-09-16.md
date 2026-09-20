# HANDOFF — Sessão 2026-09-16 (o fecho contínuo da integração + o pulso do agente)

Orquestrador Fable, sem frota: duas entregas pequenas, implementação direta com
prova de vermelho antes do verde. Relatório completo (diagnóstico
instrumentado, diff por arquivo, provas) em
`.synkora/reports/FIX_FECHO_CONTINUO_E_PULSO_2026-09-16.md` (local).

## Os dois prints do dono

1. **"Esse é um bug"** — depois do ⇪, o agente dizia "Integrada." e encerrava;
   a pasta ficou presa; o fio recebia a RECEITA inteira do agente como nota,
   mais "↻ finalização pendente", mais um selo `⏱ rodada: 0:00`, e só então
   o agente voltava. Ordem: "o turno não termina, o Synkora avisa o agente,
   ele arruma e termina a missão — sem eu ver nada disso".
2. **"UI horrível"** — o bloco "o agente está pensando / Última atividade
   registrada / Sem atualização do agente há 1 min". Ordem: nova UI com
   mockup para aprovação, usando "a melhor skill de repositório público".
   No meio do turno: "animação diferente pra cada ação". **Aprovado.**

## Entregue

### 1. Fecho contínuo (main — ESPERA RESTART)

- `guiIntegrationReply.ts`: o ENVELOPE DA RODADA — `observe` roda antes do
  anel e devolve o evento a publicar; o `result` do agente com o fecho armado
  sai com `continues: true`; o fecho fecha a rodada (`turn-continuation`
  terminal) quando ninguém mais vai falar; `finish` vazio não vira nota;
  `afterFinish` devolve a geração retomada, que HERDA a rodada (absorve o
  `result` do resume até haver atividade do modelo — pensar/falar/tool).
- `missionEngine.ts` / `missionFinalization.ts`: resposta `MERGE GRAVADO`
  (proíbe anunciar "integrada"; o app anuncia); nota do fecho para o DONO
  (`MISSION_FOLDER_HELD_NOTE`); `finishForOwner` no retry; reabertura
  (`pane-open`) sem nota; receita do agente nomeia a causa comum ("processo
  que VOCÊ iniciou: encerre pelo PID/porta").
- `guiMissionContracts.ts` (seção do integrador 1987/2000) e `mcpServer.ts`.

### 2. O pulso do agente (renderer — HMR)

- `guiAgentPulse.ts` (puro; SÓ tipos por import), `components/GuiAgentPulse
  .tsx` + `.css` (12 gestos, só transform/opacity, reduced-motion = traço
  parado), `guiThinkingPresentation.ts` ganha `phase`. Mortos:
  `GuiWorkProgress.tsx/.css`, `.gui-thinking` do global.css.
- Mockup: `scripts/harness/agent-pulse.html` (CSS real) +
  `docs/mockups/agent-pulse-2026-09-16.html` (autocontido). Direção:
  impeccable (Operate + craft floor) lido do repo público; a lei da casa
  vence onde conflitam.

### 3. Conversa pesada no medidor (R25.3b — renderer + main)

- Print do dono: a nota "esta conversa re-lê ~453k tokens…" no fio "é feia; um aviso
  em tooltip seria melhor". A nota morreu no main (marco + diário ficam); a receita
  vive em `guiCostSignals.guiHeavyConversationTip`, no tooltip do chip de contexto
  (que veste moldura tracejada acima de 150k) e numa linha do painel aberto. Provas
  com red-proof e render nativo com capturas.

### 4. Cancelar = contraordem (main + renderer)

- Print do dono: cancelar uma mensagem não lida cortava o turno (o CLI só cancela fila
  com `interrupt cancel_queued`). Agora o registro não interrompe: apaga a cópia
  durável, tira a bolha do fio e manda atrás da fala um bilhete `[synkora] MENSAGEM DO
  DONO — o dono RETIROU a mensagem que começa com "…"` (chega junto na próxima
  fronteira). `guiOwnerCancellation.ts` morreu. Provas com red-proof; fixture Electron
  do composer confere a bolha sumindo.

## Provas

- Vermelho comprovado no código velho: reply (8 asserções), mission-creation
  (4). Verde depois: reply 18, mission-creation 45, contratos 90, lifecycle/
  question/queued 53, thinking-feedback 10, render real PASS (capturas
  `.synkora/reports/chat-agent-pulse{,-detail}.png` inspecionadas),
  chat-ui (cerca C5b atualizada para o pulso).
- Gate raiz (npm run test:gui-system, 2026-09-16): typecheck verde; 1639 testes node:test verdes até a suíte nativa de captura do browser, que PARA a cadeia com a MESMA falha pré-existente de 14/09 (test-browser-capture-host-native.mjs — pixel [60,140,18] vs [60,140,20], captura nativa; nada desta sessão toca captura); as 9 suítes seguintes da cadeia rodadas em separado: 279 testes + 3 fixtures nativas verdes. Total: 1918 verdes, 1 falha pré-existente fora do escopo.

## PENDÊNCIAS

- **RESTART do app** quando o dono liberar (main/preload não chegam por HMR).
- Validação ao vivo: missão com servidor de fundo próprio → ⇪ → UMA rodada,
  uma nota curta, nenhuma receita no fio; o pulso vivo no chat.
- Sem commit: a árvore carrega 09-09..09-15 sem separação confiável (mesmo
  desvio declarado em 2026-09-11). Pousar em bloco quando o dono decidir.
- Dívida nova (backlog): instrumentar o desfecho do `taskkill /T` — o
  processo do agente que segurou a pasta era um "background shell command"
  do CLI e sobreviveu ao kill da árvore.

## Armadilhas novas (não redescobrir)

- Módulo puro do renderer importado direto por suíte `--experimental-strip-
  types` NÃO pode ter import de VALOR sem extensão (`./guiActivity` não
  resolve); só tipos entram — o texto/formatador fica no componente.
- O CLI claude, ao retomar uma conversa com tarefa de fundo morta, emite
  `tool-result isError` + `result` ANTES de qualquer fala: um `result` sem
  atividade do modelo não é o agente falando.
- A seção do integrador do contrato tem teto de 2000 chars (suíte de
  contratos); cada frase nova custa outra.
