# HANDOFF — sessão 2026-08-15 (orquestrador Fable + frota Opus 5 max)

Sessão inteira operada no esquema **orquestrador + code reviewer**: todo trabalho
foi feito por subagentes **Opus 5 effort max** (ordem do dono, sempre), em
workflows paralelos; o orquestrador consolidou investigações em design docs,
integrou os diffs, revisou linha a linha (achou e corrigiu 1 bug real de agente),
rodou os gates e limpou a infraestrutura. **10 commits** na `nivel5-fase1`
(`6b55f36..96c6d68`), nada pushado, árvore limpa.

## O que entrou (4 rodadas)

### Rodada 1 — regressão de subagentes CLAUDE (`6b55f36`, parte 1)
Fonte: `.synkora/reports/REGRESSAO_SUBAGENTES_CHAT_2026-08-14.md`. Design + toda
a evidência: **`.synkora/reports/FIX_SUBAGENTES_DESIGN_2026-08-15.md`** (LER — é
o documento central da sessão).
- CLI ≥2.1.232 roda a tool Agent em **background por padrão**: o tool_result é
  RECIBO (`async_launched`), o terminal factual é `system/task_notification`, e
  `background_tasks_changed` é fotografia autoritativa (**trap**: set vazio OMITE
  a chave `tasks`). Sonda real capturou 132 envelopes; hipótese "texto de filho
  sem linhagem" REFUTADA (filho não emite delta; os "textos intercalados" são
  **ciclos autônomos** raiz legítimos, um por conclusão de agente).
- Fix: módulo novo `src/main/guiClaudeTasks.ts` (registro de tarefas vivas);
  `tool-result` ganhou `agentStatus: 'launched'|'settled'` + `agentTaskId`;
  `result.continues` conta o registro (⇒ UM plim por turno lógico via sequencer
  intocado); renderer só fecha tools pendentes no terminal real; filhos órfãos
  (cap eviction) nunca mais renderizam no chat; lateral remove só no settled.
- O caminho dominante que esvaziava a lateral era `closePendingGuiTools`
  carimbando 'failed' em todo card a cada result raiz (+ o falso erro de órfão).
- Review do orquestrador corrigiu: filho pendente de pai já resolvido ficava
  pendente para sempre na cascata nova (teste de regressão fixa).

### Rodada 2 — subagentes CODEX invisíveis + file-open (`6b55f36`, parte 2)
- Causa: o motor collab escutava `collabToolCall` (**zero ocorrências no binário
  de 298MB**) e `collabAgentToolCall{spawnAgent}` nunca é emitido. Wire real
  (sonda viva ×3 + schema gerado pelo PRÓPRIO binário): spawn =
  `subAgentActivity{kind:"started", agentThreadId, agentPath}` no thread raiz;
  trabalho do filho = frames com threadId do FILHO (antes 100% dropados pela
  guarda); terminal = `turn/completed` do filho. `agentsStates` sempre `{}`.
- Fix: módulo novo `src/main/guiCodexAgents.ts` (id sintético
  `codex-agent:<agentThreadId>`, nome = último segmento do agentPath), roteador
  de frames de filho ANTES da guarda de thread, result raiz adiado com filho
  vivo, drenos garantidos em interrupt/failed/closed/fatal/kill. Renderer:
  ZERO mudanças. Cerca A10 intacta (backends nunca compartilham inferência).
- **Ferramenta permanente**: `codex app-server generate-json-schema --out <dir>`
  (e `generate-ts`) — o binário publica o próprio contrato; passo 1 de toda
  sonda Codex futura. Nunca mais fixture de memória.
- file-open: a causa NÃO era CRLF — guard de segurança varria o arquivo INTEIRO
  e um `shell.openPath` legítimo (anexos, commit posterior) o quebrou; guard
  escopado à região do handler `gui:fileOpen` com controle negativo embutido.
- **DECISÃO DE PRODUTO ABERTA**: `turnActive` agora conta subagente Codex vivo ⇒
  trocar modelo/effort é recusado enquanto um filho trabalha (semântica que o
  código sempre declarou; assimetria consciente com o Claude). Mudar é pequeno.

### Rodada 3 — 4 melhorias de GUI (`3c3f3bf..54981d4`)
- `3c3f3bf` **contexto real por modelo**: o CLI resolve `claude-fable-5[1m]` →
  `claude-fable-5` SEM sufixo (por isso Fable mostrava 200k). Piso curado no
  init (fable/mythos/opus/sonnet=1M, haiku=200K) + autoridade =
  `result.modelUsage[<model do init>].contextWindow` (janela REAL medida pelo
  CLI). Troca de modelo atualiza (init reemite por turno). Sonda:
  `scripts/probe-claude-caps-context.mjs`.
- `29c897b` **indicador de trabalho em background** no fio do chat: pílula
  `.gui-background-work` ("N subagente(s) trabalhando em segundo plano"),
  derivada da MESMA `normalizeGuiSubagentSidebar` da lateral (fonte única);
  suprime a linha genérica de "pensar" enquanto há fundo (era mentira).
- `ea7134f` **botões enviar/parar**: fim do círculo laranja de 38px (idioma de
  outro produto); 30×30 na grade do composer, SVG grade-16, stop na família do
  erro em contorno, estados completos, swap sem shift. Aria "Interromper
  resposta".
- `54981d4` **animação do rail**: rampa 220ms só em `.is-animating` (drag nunca
  a liga), rail em fluxo durante a rampa com conteúdo congelado; medido em
  harness real (24 frames, centro ±216px exatos, zero squash).

### Rodada 4 — 7 ajustes era 2.0 (`20d5fa2..96c6d68`)
- `20d5fa2` **mensagem duplicada pós-restart**: `guiItemId()` era contador de
  processo que ZERA a cada boot; user-messages persistem o id da geração
  anterior e o boot novo re-cunhava os mesmos ids (chaves React duplicadas ⇒
  bolha 2×; provado no snapshot REAL do disco do dono: 9 e 13 colisões por
  pane). Segundo sintoma da mesma raiz: id re-cunhado caía na dedup do main e a
  mensagem nova era ENGOLIDA em silêncio. Fix: `guiItemIdentity.ts` (token por
  boot, charset = régua do main) + `claimGuiItemId` para bilhete da fila. Dados
  antigos se curam sozinhos.
- `f8dc372` **viewer de commit**: rail mostra resumo por arquivo (+N −M);
  clique abre diff completo em overlay largo (term-window, arquivos colapsáveis,
  teto honesto "… +N linhas"). Parser próprio `guiDiffPresentation.ts` (9 casos:
  binário, rename, CRLF, paths com escape...). Viewer fecha no refresh pós-⇪.
- `5e52e1c` **era-PM arrancada**: `SeatGate.tsx` DELETADO (zero call sites; o
  fluxo 2.0 é proibido de herdar seat do maestro e tem picker próprio — todos os
  consumidores legados degradam com mensagem); botões ESTUDAR/⇄CONTA/LIMPAR
  fora. IPCs dormentes (suprimir, não demolir).
- `efc4697` **landing = missão**: projeto abre no Board; ✦ geral virou convite
  de missão (CTA → NewMissionModal; copy adapta a missionCount) + identidade em
  rodapé discreto; tiles de versão migraram pro topo da aba Versões (mesmo
  homeStats); quick-add de item nas Versões REMOVIDO (criação: direto, planejador
  ou "+ nova missão"; `createItem` do main continua p/ o planejador).
- `96c6d68` **Arquivos na identidade da casa**: Select do app (fim do <select>
  nativo), árvore mono com guias de indentação em CSS puro, leitor em PAPEL
  (--panel é exclusivo do terminal) com gutter fixo de números, empty-state com
  voz do produto. `components/FileTree.tsx` órfão deletado. Verificado em
  browser via devMock (2 defeitos visuais achados e corrigidos pré-commit).

## Gates e provas
- Gate padrão da sessão: `npm run test:gui-system` (agregado NOVO — typecheck +
  13 suítes gui) + right-rail + file-actions + backlog + suítes de superfície.
  Estado final: TUDO verde (gui-sessions 95, chat-ui 68, right-rail 15,
  queue-draft 14 — o CRLF pré-existente foi consertado de carona na rodada 3).
- Disciplina de prova: todo teste de regressão novo foi EXECUTADO contra o
  código antigo (falha comprovada, não presumida). Agentes verificaram visual em
  harness de browser com o CSS/markup reais quando não podiam rodar o app.

## Pendências para a próxima sessão
1. **VALIDAÇÃO VISUAL NO APP REAL de tudo** (ninguém rodou o app — regra de
   sessão viva): prioridade para viewer de diff, landing nova, Arquivos,
   animação do rail, botões, indicador de fundo, contexto 1M em pane Fable,
   subagentes Codex aparecendo na lateral.
2. Push + instalador novo quando o dono aprovar o visual.
3. Decisões do dono em aberto: (a) turnActive × troca de modelo com filho Codex
   vivo (mantido bloqueando); (b) D3 — falha de subagente não pinta o turno
   (comportamento atual mantém); (c) matar o rodapé de identidade do ✦ geral?
4. TODOs anotados no código: retenção sticky do ring p/ lifecycle vivo
   (guiSessions.ts + capGuiItems no store.ts); arestas do grafo de commits
   desalinham com linha expandida (pré-existente, menos grave agora).
5. Sub-agente de sub-agente (nível 2) não aparece na lateral — deliberado, sem
   vazamento; fase própria se o dono quiser.
6. Re-sondar a cada update de CLI: `scripts/probe-claude-background-agents.mjs`,
   `scripts/probe-codex-collab-agents.mjs`, `scripts/probe-claude-caps-context.mjs`
   (+ `codex app-server generate-json-schema`). Capturas em `.tmp/probe-*`.

## A metodologia que funcionou (replicar)
Fases por rodada: **(1) investigação paralela** (mapa de código + sonda de
binário REAL quando há protocolo + auditoria de testes, com schemas
estruturados) → **(2) design registrado em doc** (.synkora/reports/) com
decisões vinculantes e contratos byte a byte → **(3) implementação paralela**
(mesma árvore SÓ com fronteiras de arquivos 100% disjuntas; senão worktrees
`Synkora-wt-*` com branch própria + junction de node_modules criada/removida
PELO ORQUESTRADOR com `rmdir` sem recursão — nunca pelo agente) → **(4)
integração por cherry-pick** na nivel5-fase1 → **(5) code review pessoal do
orquestrador no diff inteiro** (achou bug real na rodada 1) → **(6) gate
completo** → **(7) cleanup + commit em bloco convencional**.
Regras duras: subagente SEMPRE `model:'opus', effort:'max'` no Workflow;
prompts de agente em EN; agente reporta filesChanged/testResults/deviations/
notesForReviewer; teste novo tem que falhar no código velho; nunca rodar o app
do dono; heurística sobre conteúdo proibida — só sinal estrutural sondado.
