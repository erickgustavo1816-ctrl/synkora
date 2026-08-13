# HANDOFF — sessão de 2026-08-13/14: a virada Synkora 2.0 (LER PRIMEIRO)

Sessão encerrada por /clear do dono com o 2.0 COMPLETO no tronco e **o voo inaugural
ainda pendente** (o app sobe no terminal DELE, nunca do agente). Tronco final:
**`e2d6516` em `nivel5-fase1`** — typecheck (node+web) limpo, `npm run build` compila,
8 suítes com zero falhas, repo com 1 worktree, todas as branches de agente consumidas.

## O que é o Synkora 2.0 (o retrato aprovado pelo dono)

**O Synkora que existia é o produto** — Home, universos, versões, fila, identidade
papel & painel, PT-BR. A mudança: **o pane TUI morreu para missões novas; missão abre
um CHAT (GuiPane) em papel no palco central**. Sem maestro, sem orquestrador, sem
gates: o DONO é o orquestrador. Reviewer/ajudante/terminal só quando ele pedir
(pílulas de conversa no topo do palco). ⇪ vai direto pra fila FIFO (guardas de plano
desviadas só para `Mission.direct`); conflito volta pra conversa do dev com receita.
Planejamento é um TIPO de missão (`missionType: 'planejamento'`) que o dono cria —
roda na RAIZ, escreve `plano/`, não entra na fila. O universo começa VAZIO.

Documentos-contrato (ordem de leitura):
1. `docs/MOCKUP_WORKSPACE.md` — **O CONTRATO VISUAL**. Chat é PAPEL (painel escuro é
   SÓ do terminal). Estrutura: missões à esquerda (~216px) · chat com TUDO no centro ·
   trilho de entrega à direita (~204px) · chips ◈ versão / fila ⇪ na barra.
2. `docs/PLANO_2_0_GUI.md` — as ondas A–D e o escopo.
3. `docs/GUI_PANE_CONTRACT.md` — canais/tipos do motor GUI (inclui `gui:attach`).
4. CLAUDE.md abre com a seção "ERA 2.0" — tudo abaixo dela é legado F6 (válido só
   para missões antigas sem `direct`).

## O que foi construído (ondas A–E + frota F1 + 2 peças finais, ~20 agentes Opus)

- **Motor GUI** (`src/main/guiSessions.ts`, `ipc/gui.ts`, preload `gui.*`):
  MaestroSession/CodexSession POR PANE, ring buffer + replay, resume persistido
  (`userData/gui-sessions.json`), idleTimeout desligável, thinking com texto,
  permissionMode por conversa ('default'|'acceptEdits'|'bypass'|'plan') com
  **respawn+resume na troca** (fingerprint), `gui:attach` (anexos → `.synkora/attachments`).
- **Missão direta** (`Mission.direct`, `ipc/missions.ts`, `missionEngine.ts`):
  criar = worktree + chat do dev com goal como 1º prompt (`missions:guiSpec`
  dev/reviewer/helper, contratos em `guiMissionContracts.ts`); ⇪ direto; conflito
  entregue no chat; kills re-mirados; **cerca do maestro MORTA** (missão nasce pelo
  clique do dono em QUALQUER projeto — teste red-green em `test:mission-creation`).
- **Palco** (`Board.tsx` stage-mode, `MissionStageHead.tsx`, `MissionColumn.tsx`,
  `MissionDeliveryRail.tsx`, `GuiPane.tsx` reescrito em papel): pílulas de conversa,
  composer com ⛭ modo/mic/enviar, tool cards claros com desfecho à direita, card de
  permissão accent. Trilho: diff vivo `+N −M` (`missions:workspaceFiles`), diff por
  arquivo (`missions:fileDiff`), commits (`missions:commits`), terminal como SLOT no
  palco (`missions:shellSpec`), ⇪, arquivar.
- **Casca renovada**: FUNÇÕES/reviewer/aba PANES/botão AGENTE/bypass-switches FORA;
  identidade+chips na barra; abas BOARD·MAPA·VERSÕES·ARQUIVOS; **MAPA = quadro de
  rotas** (`MissionRouteBoard.tsx`); constelação DORMENTE (código intacto, sem rAF).
- **Extras**: notificações de desktop (`desktopNotifications.ts` — permissão pendente/
  conflito/merge, só com janela sem foco), GitHub no criar projeto (clona OU init+push,
  URL validada contra flag-injection, aviso PT-BR se push falhar), PM só nasce com
  missão LEGADA viva.

Suítes novas/vivas: `test:gui-sessions` 22 · `test:gui-mission-contracts` 28 ·
`test:mission-creation` 4 · `test:mission-worktree` 33 · + as legadas (orchestrator-flow
40, mission-verification 25, integration-queue 14, pane-permissions 14).

## PRÓXIMO PASSO (o primeiro da próxima sessão)

1. **VOO INAUGURAL**: o dono roda `npm run dev`, abre um universo → deve começar VAZIO
   → "+ nova missão" (tipo missão) → chat em papel no centro → permissões com botões →
   commit → ⇪. Nada disso foi validado COM O APP RODANDO (regra: app no terminal do
   dono). Esperar prints/tropeços e corrigir com AGENTES PEQUENOS.
2. Criar também uma missão tipo **planejamento** e ver o contrato de arquiteto agir.
3. Depois do voo: demolição do legado F6 (phaseEngine/mcpServer/hub/LSP + bench-*/run-*
   do package.json) — SÓ quando as missões legadas dos projetos reais estiverem
   concluídas/arquivadas; hoje é supressão, não demolição.

## Pendências conhecidas (registradas, não escondidas)

- Câmera do mapa... o mapa agora é o quadro de rotas; a constelação dormente guarda a
  pendência antiga (câmera reseta por visita) — irrelevante enquanto dormir.
- "Concluir planejamento" no trilho é o arquivar re-rotulado (não existe transição
  'concluída' para missão no main — se incomodar, é uma peça pequena no missions:update).
- SynVoice global hotkeys seguem do jeito de sempre (o mic do composer foca e aciona o
  trigger da titlebar).
- Skills/subagentes: decisão ADIADA pelo dono ("muita skill atrapalha") — se voltar, é
  kit mínimo por missão, nunca menu gigante.
- `Desktop/Synkora2` (fork claudecodeui completo, 8 frentes) = PEDREIRA de ideias
  (plugins, notificações web, Auto Mode) — NÃO é o produto, não desenvolver lá.

## Lições de processo desta sessão (caras — não repagar)

1. **"O GUI dentro do Synkora" era LITERAL.** O fork foi construído inteiro e rejeitado.
   Confirmar o SUBSTANTIVO da frase antes de mover uma frota.
2. **O mockup é o contrato.** "Chat = painel escuro" foi invenção minha e custou uma
   onda inteira; o aprovado era papel. Medir pixel contra `MOCKUP_WORKSPACE.md`.
3. **MUITOS agentes pequenos > poucos gigantes** (ordem do dono, comprovada): peça
   pequena com dono único + relatório = qualidade; escopo de 500 linhas dilui.
4. **Worktree isolation do harness prende no repo da SESSÃO** — agente para OUTRO repo
   precisa criar o worktree manualmente (instruir no prompt; todos aprenderam).
5. **NUNCA resolver conflito de merge por regex-união**: corrompeu 5 arquivos uma vez.
   Hunk a hunk na mão; handlers entrelaçados se reconstroem das FONTES
   (`git show branch:arquivo`). E `grep | head -3` esconde conflitos — listar TODOS.
6. Husky+commitlint no fork exigem mensagens convencionais; o repo Synkora não tem.
7. Snapshot commit antes de frota (8dcc9f3 salvou 52 arquivos de WIP alheio).
