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
