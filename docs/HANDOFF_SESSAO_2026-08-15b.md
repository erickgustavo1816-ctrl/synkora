# HANDOFF — sessão 2026-08-15b (Fable orquestrador + 4 workflows Opus max)

Sessão operada na metodologia do handoff anterior (orquestrador + code reviewer;
TODO trabalho em Opus 5 effort max via workflows; worktrees com junction pelo
orquestrador; integração por cherry-pick; review pessoal do diff; gates; teste
novo provado vermelho no código antigo). **~20 commits na `nivel5-fase1`**
(`54347a3..HEAD`), nada pushado.

## O que entrou

### Wave 1 — as 3 frentes de UI (design: .synkora/reports/DESIGN_3FRENTES_UI_2026-08-15.md)
- **Arquivos** (`54347a3`): só missão ATIVA com worktree próprio é raiz
  navegável. Cerca autoritativa em `resolveFileActionRoot` (códigos novos
  'mission-closed'/'mission-no-workspace', mensagens-receita PT-BR) espelhada em
  `readOnlyRootPath`; vale também para as 6 mutações P26. FilesView filtra o
  picker, assina `missions:changed` e cai para a raiz do projeto quando a origem
  aberta encerra. Matou a mentira "raiz do projeto rotulada worktree da missão".
- **✦ geral** (`637d0a8`,`7d1f5d5`): convite centralizado (família visual do
  task-modal) só com ZERO missões de qualquer status; com missões, o
  `ProjectDashboard.tsx` novo (KPIs em stat-tiles, retrato por versão compacto
  via homeStats, linha por missão viva + integradas recentes com teto 5, âmbar
  "esperando você", ▣ só quando total>0, datas honestas com `completedAt` novo
  no Mission do renderer). Foto trocou de casa: os DOIS avatares do topo
  (`.tb-title-avatar` no titlebar — no-drag+pointer-events explícitos — e
  `.ws-avatar` no header) viraram botões. `missionPresentation.ts` novo unifica
  dot/badge/status entre coluna e painel. Mockup emendado (nota datada).
- **Missão arquivada** (`0b5eccc..08d7156`): clique em missão 2.0 encerrada
  (arquivada E concluída — extensão consciente, validar com o dono) abre a
  CONVERSA CONGELADA: `GuiPane readOnly` (early-return ANTES do
  shouldCreateGuiSession — teste com 2 controles negativos; predicado `inert`
  cobre perm/question/plan/askingGo/composer), `ArchivedMissionChat.tsx` novo
  (sonda paneIds determinísticos via gui:state, abas por papel, empty states
  honestos, autofecha na reativação, Esc fecha). Legada/sem chat = não clicável
  com tooltip verdadeiro. Excluir avisa que apaga a conversa.

### Passe impeccable (`34a4527`) — regra permanente do dono aplicada
Piso de leitura das superfícies novas (1,91–3,23:1 → ≥4,36:1), selo âmbar
"espera você" preenchido (7,05:1), frase de espera sem corte, cadência
4·6·10·18, foco 2px, hover dos avatares no acento. `test:landing-polish` novo
CALCULA contraste WCAG real dos tokens/color-mix (12/12 vermelho no CSS velho).
Defeito global registrado e NÃO tocado: `.btn.accent` 3,41:1 (identidade — dono
decide).

### Wave 2 — menu de planejamento (design: .synkora/reports/DESIGN_PLANNING_MENU_2026-08-15.md)
- **Domínio** (`2c9ef63`): `plans.ts` (PlanStore em userData/plans.json, CAS
  DENTRO do store, autocura de missionId pendurado, UM mestre ativo por
  universo) + `planDraft.ts` (camada pura do rascunho: keys, porteira total,
  validador de hidratação) + `ipc/plans.ts` + preload/devMock.
- **Chat com ferramentas** (`4fac91e`): MCP mínimo `gui-planner` SÓ no pane de
  missão de planejamento (early-return no buildServer = cerca de catálogo;
  claude --strict-mcp-config; codex -c sem aspas, sondado no 0.147; token por
  pane idempotente, revogado no dispose). `propose_plan` NUNCA cria — vira o
  evento `plan-proposal` no ring (5 espelhos; NÃO bloqueia o CLI, sobrevive ao
  result; re-propor SUPERSEDE) e o card decide: `gui:answerPlanProposal`
  (aprovar cria o Plan lendo o draft AUTORITATIVO do ring, nunca do renderer;
  ajustar devolve a prosa). PLANNING_CONTRACT reescrito.
- **Renderer** (`dcb6b50..7fc31da`): espelhos 2/3/5 (guiApi normaliza o draft;
  store enfileira como interação; `answerGuiPlanProposal`),
  `GuiPlanProposalCard.tsx` (itens expansíveis, ✓ criar / ✎ ajustar),
  `UniverseMapView` reescrito (abas dinâmicas: rotas + plano mestre F6 quando
  existir + uma por plano; aba lembrada por projeto), `PlanBoardView.tsx`
  (progresso derivado, chip vivo da missão vinculada, "criar missão" abre
  NewMissionModal pré-preenchido + linkMission com CAS, arquivar/excluir/
  concluir), `plansApi.ts`/`planContract.ts`/`planBoardPresentation.ts`.
  Impeccable aplicado (shape→craft-floor→layout/polish→clarify).
- **Costuras do orquestrador**: preload/devMock unificados no contrato do main;
  `readPlanDraft` lê `key` (o main emite keys, não ids — mismatch A×B achado no
  review); relógio do PlanStore virou ESTRITAMENTE monotônico (o teste de CAS
  pegou AO VIVO: duas mutações no mesmo ms deixavam a segunda invisível para a
  fotografia — buraco real, não flake); GUI_PANE_CONTRACT.md ganhou o canal e o
  evento novos.

### Demolição Onda 1 (`6c71e25..e60e288`) — auditoria .synkora/reports/DEAD_CODE_AUDIT_2026-08-15.md
~1.300 LOC de fiação órfã removidos conforme o relatório (com 1.D aprovado pelo
dono): 21 canais IPC sem emissor (incl. 14 maestro:* dormentes — getState/
paneSpec/pendingQuestions/questionSeen FICAM), aliases sem chamador, PolicyRow,
planningGui.ts, @types/ws. TRÊS achados foram verificados e MANTIDOS (a
auditoria mandava conferir): reviewer*/contextLimit do maestroStore (lidos pelo
phaseEngine/getState) e missionWorkspaceFileDiff (test-pinned). Zero testes
tocados; baseline == depois em todas as suítes; `npm run build` inteiro verde.

## Estado dos gates (fim da sessão)
`test:gui-system` agora = typecheck + 17 suítes (novas: project-landing 11 ·
archived-chat 6 · landing-polish 12 · plan-board 13). Gate final completo da
árvore integrada: TUDO verde (gui-sessions 105, chat-ui 71, plans 20 — estável
em 4 execuções após o fix do relógio, skills-system 203, mission-worktree 35,
project-plan 58, mais file-actions/file-preview/backlog/titlebar/right-rail/
command-palette/mailbox/blackbox/mission-creation/mcp-protocol/quick-settings).

## RODADA DE FIXES DO TESTE VIVO (mesma noite — o dono rodou o app e achou 7)
Investigação read-only (3 Opus max) com o app do dono ABERTO + fixes em 2
worktrees, integrados após o dono fechar. Os 7, todos com causa PROVADA:
1. **MCP do planejador nunca chegou ao CLI** (o crítico): o main armava tudo
   (journal `plannerTools:true`, config+bearer escritos, servidor de pé —
   suspeito "servidor não sobe na era 2.0" REFUTADO por netstat), mas o
   RENDERER descartava o campo `mcp`: GuiPane reconstrói o spawn de props
   enumeradas e o espelho de tipo nunca ganhou o campo (typecheck cego a
   opcional omitido). Fix: carry nos 4 pontos + **CERCA DE PARIDADE** no
   test:gui-chat-ui (compara campo a campo GuiPaneSpawn do main × espelho ×
   Props × literais × atributos do Board — pegou o bug de hoje em 1 linha) +
   evento blackbox `gui-planner-mcp-dropped`. Codex perdia args E o bearer.
2. **Chat nasce MUDO** (ordem do dono): `sendFirstPrompt` morreu; o briefing
   vira `pendingBriefing` no motor e sai COLADO na 1ª mensagem do dono
   (`guiBriefedPrompt`); sobrevive a troca de permissão/remount, não queima em
   slash, não some em recusa por teto (checado ANTES de qualquer sink). Regra
   nova no GUI_PANE_CONTRACT ("O PANE NASCE MUDO").
3. Popover de contexto isento da guarda de turno (é leitura) + fecha pelo
   caminho normal quando a medição some (compaction codex).
4. Medidor de contexto: `measuredWindow` no maestroSession (o init repetido
   deixa de reanunciar o PISO por cima da MEDIÇÃO; troca de modelo descarta) +
   replay de conversa morta zera o par (só session-restarted é autoridade).
5. Dashboard ENCHE a coluna (max-width 860 morreu; lista vira grade auto-fill
   ≥1000px; KPIs = instrumento 560px) — medido 1566px numa janela de 1920.
6. Coluna de missões: largura ÚNICA `--mission-col-width: 240px` (era 240×216)
   + fix da cascata da faixa estreita (altura 1239px→77px) + régua de 10px dos
   botões via `--scrollbar-w`.
7. Versões em GRADE de cards (~3 por linha nativa, 4 em 1600px) + a lista
   "missões desta versão" ganhou os 3 destinos do missionCardAccess (era a 2ª
   superfície com clique morto em arquivada).
Validar ao vivo: chat de planejamento re-spawna 1× (resume) e o agente deve
listar propose_plan/list_plans de primeira (prova no journal: catalog-served
role=gui-planner); caminho CODEX do planejador consertado mas não provado ao
vivo; briefing colado — conferir que o agente responde o que o dono perguntou.

## 🔴 BUG PARA AMANHÃ (dono validou ao vivo 2026-08-15 noite)
O MCP do planejador FUNCIONOU (tools permitidas, propose_plan rodou, card de
proposta NASCEU no chat) — mas o agente continuou falando depois de propor e o
card "bugou e sumiu" quando a resposta seguiu. Hipótese nº 1 (forte): o MAIN
isentou `plan-proposal` da limpeza de fim de turno no RING (ele não bloqueia o
CLI — decisão registrada no contrato), mas o REDUCER do renderer (mirror 5,
plans-ui) foi moldado nos irmãos permission/question, que SÃO limpos no
`result`/turn-end — o card cai na chegada do result. Verificar store.ts: onde a
interactionQueue é esvaziada em result/fatal/closed, o kind 'plan-proposal'
precisa da MESMA isenção do ring (+ teste chat-ui espelhando o teste do ring).
Hipótese nº 2: REFUTADA na mesma noite (o "zero plan-proposal no snapshot" era
falso negativo do scan do orquestrador — assumiu wrapper {seq,evt}; o formato
persistido é SessionEvent CRU). A proposta real do dono ("V1.0 — Lista de
tarefas…", 5 missões) está INTEIRA e SEM RESPOSTA no transcript persistido de
gui-dev-46b9f49c (índice 103/104), e o draft verbatim passou por
isGuiPersistedEvent + rehydrate completo do ring. A persistência sempre esteve
correta — ninguém deve reabrir essa trilha.
Workaround possível para o dono ver o plano hoje: se a hipótese 1 for a única,
sair da missão e voltar re-replaya o ring e o card deve voltar; se o card não
voltar, a hipótese 2 é real.
**DECISÃO DE UX DO DONO (mesma noite, vinculante para o fix):** o card NÃO
aparece no meio da fala — o agente termina de falar ("o plano está aí abaixo"),
e SÓ ENTÃO o card aparece, embaixo da resposta, e FICA até o dono decidir.
Implementação: (a) plan-proposal nunca é limpo por result/turn-end (nos DOIS
espelhos — ring já isenta, reducer precisa isentar); (b) o RENDER do card é
gateado por turno-não-ativo (status != working/stream vazio) — pendente durante
a fala, visível no fim; (c) PLANNING_CONTRACT orienta o agente a fechar a fala
anunciando o plano abaixo. Teste: proposta no meio do turno → card ausente
durante o streaming, presente após o result, sobrevivendo a turnos seguintes
até o desfecho.

## Pendências / decisões
1. **VALIDAÇÃO VISUAL NO APP REAL** (ninguém rodou o app): dashboard do ✦ geral
   nos 3 estados; convite centralizado; clique nos DOIS avatares (falha
   silenciosa de no-drag/pointer-events só aparece ao vivo); viewer congelado
   (arquivada E concluída) + confirmar que NENHUM CLI nasce (Task Manager);
   picker de Arquivos com missão arquivada/reativada; mapa com abas de plano;
   fluxo completo de proposta (missão de planejamento → propose_plan → card →
   criar → aba nova); boot do 1.D (maestro:getState/paneSpec vivos).
2. Primeira abertura pós-upgrade RESPAWNA (com resume) o pane de cada missão de
   planejamento viva — fingerprint ganhou o campo mcp. Esperado, não é bug.
3. Decisões do dono em aberto: (a) `.btn.accent` 3,41:1; (b) plano arquivado
   não tem aba nem caminho de volta na UI (plans:update já aceita — falta
   alavanca); (c) viewer congelado para CONCLUÍDA (extensão) confirmar.
4. Próxima sessão dedicada: **Onda 2 da demolição (ilha panes-view ~9.100 LOC,
   aprovada)** + **Onda 3 (pipeline F6 ~38k, aprovada para sessão própria)**.
5. Browser do Synkora: plano aprovado em direção
   (.synkora/reports/DESIGN_SYNKORA_BROWSER_2026-08-15.md) — RightDock estilo
   Claude Code primeiro, sonda CDP-proxy antes de qualquer código.
6. Follow-ups menores: files:listDocs (Ctrl+K) ainda lista docs de missão
   arquivada (fora de escopo D3.4); devMock sem worktree na missão mock (picker
   da preview mostra só raiz); truncation flag no GuiStatePayload; foco-trap do
   modal congelado (Esc entrou; trap não).

## Regras novas desta sessão (gravadas na memória)
- TODO design usa a skill impeccable; o ORQUESTRADOR roteia o playbook.
- Agente de sessão usa o browser INTERNO do Claude; NUNCA claude-in-chrome.
- Fork do Dama-IDE VETADO (PolyForm Perimeter; ADE concorrente).
