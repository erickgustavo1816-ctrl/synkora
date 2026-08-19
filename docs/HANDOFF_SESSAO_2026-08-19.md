# HANDOFF — Sessão de 2026-08-19 (o estado vivo da obra)

Sessão do dia inteiro, branch `nivel5-fase1`, rodadas **R12 a R22** commitadas
e com gate raiz verde. Metodologia da casa em todas: orquestrador investiga e
desenha (design em `.synkora/reports/`), agentes Opus max implementam em
worktrees (`Synkora-wt-*` + junction de node_modules criada/removida pelo
orquestrador), integração por cherry-pick, review no diff inteiro, vermelho
provado antes do verde, gate raiz, commit em bloco. **Worktree só por
PowerShell** (o `git worktree add` via bash escapou `..\` e criou pasta dentro
do repo — o agente da R21 reparou; lição paga).

## ⚠ PRIMEIRO ATO DA PRÓXIMA SESSÃO

**O app do dono NÃO foi reiniciado desde a R17** (`ec1a6d9`) — ele estava
usando e proibiu restart. **R18 a R22 só existem no disco**: o próximo
`npm run dev` sobe tudo de uma vez. Subir o app é a primeira coisa (e a
instância que estava viva morreu no /clear desta sessão — era filha dela;
kill de job do Windows, NÃO crash: ver memória feedback-restart-apos-mudanca).

## A RODADA PENDENTE: R23 — "o ■ sempre vence + pane morto renasce no envio"

**Ordem do dono: fazer amanhã.** Design vinculante PRONTO e sondado:
`.synkora/reports/DESIGN_PARADA_QUE_MANDA_R23_2026-08-19.md`. Resumo:

- Incidente real (caixa-preta 23:16–23:17): CLI encravou pós-erro de API com o
  turno aberto → pane "pensando" eterno; dois ■ sem confirmação ("o Claude não
  confirmou a interrupção") e o processo ficou DE PÉ; sessão morreu (código 1);
  composer trancou sem receita; a única fuga foi trocar de conta.
- R23.1: `failInterrupt` (maestroSession.ts ~1312, timeout de 10s do
  `interrupt()` ~1030) passa a DERRUBAR o processo em vez de só anunciar — o ■
  do dono é guarda dura de autoridade; sondar e aplicar o mesmo contrato no
  codexSession. Interrupção confirmada (R7-E) fica byte-idêntica.
- R23.2: pane `dead` (store.ts case 'closed' ~1477) não tranca o composer:
  placeholder-verdade ("a sessão morreu (código N) — enviar reabre a MESMA
  conversa") e o envio dispara o respawn-com-resume que JÁ existe
  (guiApi.create com o spawnRef; o R12 deixou o restart retomado quieto) e
  então envia. Falha de revive não engole a mensagem (fica no draft).
- Cerca: NENHUM watchdog/relógio novo de turno (doutrina R19 vale aqui).
- Um agente Opus max em worktree; suítes: gui-sessions (seam comportamental do
  interrupt), a do codexSession (sondar), gui-chat-ui (composer/revive).
- Um agente chegou a ser lançado e foi PARADO a pedido (nada aproveitável).

## CANDIDATA SEGUINTE: R24 — histórico completo do chat

Queixa do dono (não desenhada ainda): "não tenho acesso ao histórico inteiro —
subo, subo, e acaba". Diagnóstico inicial: o anel do pane poda por espaço
(GUI_RING_CAP=500 eventos / 4MB, guiSessions.ts ~294) — o fio da tela perde o
começo de conversa longa. O histórico COMPLETO existe no disco do próprio CLI,
e o app já tem leitor de transcript sanitizado (GuiHistoryTarget / paleta
Ctrl+K, que mapeia sessionId→pane). Caminho provável: ao bater no topo do
anel, oferecer "ver conversa completa" abrindo o leitor ancorado na sessão do
pane — leitura efêmera, sem inflar o anel. Investigar antes de desenhar.

## O QUE ESTA SESSÃO ENTREGOU (R12–R22, tudo commitado e verde)

- **R12–R13 — fast**: toggle ⚡ quieto (respawn retomado com `resumed` não
  pisca UI), pino ⚡ no painel D8 com inteligência de catálogo POR MODELO
  (claude handshake publica supportsFastMode — só opus/default têm; codex
  `debug models` publica service_tiers), botão gigante era CÉLULA (todo filho
  do grid do composer precisa de grid-area — lição permanente).
- **R14 (+14.1) — cópia + LSP era 2.0**: botão ⧉ de volta (régua pula notas
  finais), fio selecionável; LSP novo em src/main/lsp (motor pull+push,
  lançador em escada: TS nativo do projeto → clássico → TS do app; o TS 7 é a
  linha NATIVA com `tsc --lsp --stdio` pull-only — sondado no binário), tools
  lsp_* nos 3 papéis de chat + papel `ajudante` SÓ-LSP (cerca D1 virou
  catálogo legível; bearer por vida, revogação no dispose).
- **R15 — worktree mobiliado**: junction de node_modules na criação
  (nodeModulesLink.ts) com a cinta `git check-ignore -q node_modules/` (a
  BARRA é obrigatória — padrão de diretório não casa dir inexistente).
- **R16 — o conhecimento atravessa**: Mission.delivery (fato git capturado
  ANTES do mergeTaskWorktree — a limpeza dele leva worktree E branch),
  briefing do dev ganha "WHAT YOUR DEPENDENCIES ALREADY DELIVERED" (sem
  delivery = linha honesta, nunca omitida), planejador carimba o MAPA DA
  FATIA no `context` (viaja verbatim via planItemMissionGoal).
- **R17–R18 — o ⇪ sem travar**: sensores permanentes na caixa-preta
  (git-sync-slow ≥200ms, main-thread-stall ≥400ms); a rajada leve de git
  síncrono do caminho de integração foi para o gitOff NA MESMA ORDEM (a ordem
  é parte do lacre; testes pinam a lista ordenada); integration_status, fecho
  do merge e probe de versão idem. R18.4 (twin no criar missão) foi entregue,
  MEDIDA e revertida (zero ganho real). Resíduo git nomeado do fecho:
  `sweepProjectFiles` (receita de twin no relatório r18).
- **R19 — ajudante sem teto**: o watchdog de 30min MORREU (ordem do dono);
  virou advisory `helper-longrun` uma vez por vida (carimbo persiste; resume
  re-arma); carona ao delegador recusada POR MÉRITO (canal é de encerramento;
  cutucar o agente o empurraria a matar).
- **R20 — contexto ao vivo**: o claude publica context-usage a cada chamada
  de API (paridade codex); régua única da janela (`contextWindowNow`).
- **R21 (+voz do 5xx) — limite honesto**: allowed_warning é NOTA
  ("APROXIMANDO — nada parou"), só bloqueio real é erro COM receita; dedup por
  status+resetsAt; o result veste a voz da casa com o limite armado (estado
  estrutural, nunca palavras — há assert pinando); troca de conta liberada no
  meio do turno (setChatSeat nunca teve guarda de ocupação; cursor:wait
  morreu); rodada fantasma não carimba selo; API 5xx veste PT-BR com receita
  (assinatura sondada do wrapper do CLI, precedente do matcher dos ajudantes).
- **R22 — a mensagem fura o turno**: pote do dono (guiOwnerMail.ts, persistido
  em gui-owner-mail.json), carona em todo resultado de tool de delegação (o
  bloco do dono por ÚLTIMO), wakePane resolve o long-poll na hora, fecho de
  turno/nascimento do pane flusham o pote (nada se perde); cercas: slash cru
  vai ao binário, briefing segue como prompt; pane não-delegador intocado.

## Resíduos nomeados (nenhum urgente, todos com receita nos relatórios)

- `sweepProjectFiles` síncrono no fecho do merge (r18-agent-report, nota 3).
- Pote de avisos próprio se o dono quiser notificação ativa do helper-longrun
  (r19-agent-report §3.1).
- Recibo da carona sem o nome da tool (r22-agent-report §3.5).
- `onProtocolError` do LspManager sem raiz (r14 L2 report 4.5).
- Checkpoint de transcript por context-usage (r20-agent-report 5.1 — sem
  sintoma; sensores armados).
- Chip de tarefa possivelmente pendente: teste de conflito sensível ao git
  local (já corrigido em 25a22a2 — chip foi dispensado).

## Relatórios e memória

Relatórios completos dos agentes desta sessão no scratchpad da sessão (morrem
com ela — o essencial está nos commits e neste handoff). Designs vinculantes
em `.synkora/reports/DESIGN_*_2026-08-19.md` (onze arquivos). A memória do
projeto (`projeto-synkora.md`) está atualizada até a R19; as R20-R22 entram
pelo commit log + este handoff.
