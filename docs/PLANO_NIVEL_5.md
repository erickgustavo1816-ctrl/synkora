# PLANO NÍVEL 5 — cirurgia de desempenho e modularização (para aprovação do dono)

Escrito 2026-08-07 (sessão dos níveis 4/5). REGRA VIGENTE (memória
`projeto-refatoracao-index-18k`): este plano precisa do teu OK antes de
qualquer código. Nada abaixo foi implementado.

## A dor, com evidência

- Relato do dono (2026-08-07, ao vivo): "quando eu abro o Synkora e vou
  clicando nas missões, os panes vão abrindo e vai dando umas lagadas" — e o
  binário em uso JÁ TEM o escalonador de spawn do F6.10 (paneSpec espaçados
  ~350ms). A mitigação não bastou.
- Medições acumuladas: stalls de 1,2–2,6s em TODA transição done→gate (4/4 em
  2026-08-06, cresce com a carga); journal de 2026-08-07: 22 `event-loop-stall`,
  12 `slow-skill-sync`, 5 `slow-task-worktree`; boot de 18:41Z stallou já aos
  4s de uptime com 0 panes.
- Estrutura: `src/main/index.ts` = **18.896 linhas / 829KB / 120 handlers IPC**.

Duas classes de travamento, com culpados diferentes:

1. **Main process bloqueado** (event-loop-stall): barreira síncrona do
   veredito, resíduos síncronos de fs/git, tempestade de boot — quando o main
   trava, NENHUM clique responde (todo IPC espera).
2. **Renderer saturado**: um único renderer parseia todos os `pty:data`,
   pinta todos os xterms e divide 12 contextos WebGL — a UI laga mesmo com o
   main livre.

O relato do clique-nas-missões tem cara das duas somadas: cada aba de missão
monta o orquestrador (spawn + skill sync + catálogo) no main E acrescenta um
xterm vivo no renderer.

## Fase 0 — instrumentação de ATRIBUIÇÃO (pré-requisito; 1 janela curta)

`event-loop-stall` hoje diz "travou 1,2s" sem dizer QUEM. Antes de cortar
qualquer coisa: um rastreador barato de "operação em curso no main" (marcar
início/fim de paneSpec, spawn, skill sync, veredito/fotografia, syncBoard,
merge; no stall, logar a pilha de operações abertas). Um dia de uso normal do
dono devolve o ranking REAL dos culpados — a cirurgia corta pelo dado, não
pelo palpite (memória `feedback-instrumentar-antes-de-teorizar`).

ESTADO (2026-08-07): **FASE 0 CONCLUÍDA E LIGADA** (janela de app fechado;
typecheck + test:stall-attribution 8/8 + orchestrator-flow 35/35 +
mission-verification 25/25 verdes). O que entrou:
- `src/main/stallAttribution.ts` novo (módulo puro, sem electron; suíte
  própria): tracker de operações abertas + ring das recém-fechadas ≥120ms;
  blame(lag) devolve o que intersecta a janela do stall.
- index.ts: instrumentIpcMain cobre os ~120 handlers (`ipc:<canal>` /
  `ipc-on:<canal>`); o watchdog anexa `culprits` ao event-loop-stall;
  wrappers finos (padrão wrapper→Inner, zero mudança de comportamento) em
  preparePhasePane, advancePhase (contrato SYNC do veredito intacto — wrap
  sync devolve sync), completeMissionMerge, syncBoard; e toda tool MCP vira
  `mcp:<tool>` dentro do instrumentMcpApi.
Validação em produção: um dia de uso normal do dono; todo event-loop-stall
no journal passa a vir com a lista de culpados. Leitor:
`node scripts/bbwatch.mjs --grep stall`. O ranking decide o corte das Fases
1–2.

RODADA 2 (mesma data, após o 1º boot medido): o stall de boot (~1,9s aos 3s,
0 panes) veio com `culprits: []` — sensor ATIVO e culpado FORA do
instrumentado, ou seja, no caminho de PARTIDA. Entraram: `boot:stores`
(cargas síncronas dos 8 stores), `boot:project-sweep` (vassoura/repair/
syncBoard por projeto), `boot:createWindow`, `boot:progressSnapshot`,
`boot:cli-skills-kickoff` (trecho sync do tick de 2,5s). E o limiar do
watchdog caiu 1000→500ms — as "travadinhas" de clique que eram invisíveis
viram dado com culpado. Se o próximo boot AINDA vier vazio, a leitura por
eliminação é overhead do modo dev/GC — registrar e seguir para a Fase 1.

## Fase 1 (5a parte 1) — MainContext + extração por menor acoplamento

Âncoras reais (index.ts de hoje): bindUiSender :463 · mcpPaneArgs :3988 ·
armPane :4062 · recovery de boot :6797–6943 · completeMissionMerge :7344 ·
syncBoard :10263 · preparePhasePane :10949 · construtores de prompt
(devContract :11539, atomicRoundRule :11616) · retryOrBacklog :12078 ·
finalizeTask :12561 · openGatePane :12909 · advancePhase :13098 · poller
:13709 · mcpApi :15139 · startMcpServer :18894.

Commits pequenos, revisáveis, suítes verdes a cada um:

1. **`MainContext`** (interface explícita: ptys, hub, tasks, missions,
   projects, seats, backlog, maestro, blackbox, settings, uiSender,
   phaseWatches, liveGateWaits…) — commit 1, zero movimentação de código.
2. **Construtores de PROMPT das fases** → `phasePrompts.ts` (funções puras;
   devContract/atomicRoundRule/prompt-delta/recovery). Menor acoplamento do
   arquivo, maior densidade de texto.
3. **`mcpApi`** (~15139 até o fim, o maior bloco) → pasta `mcpApi/` por
   domínio (board/tasks/missions/helpers/gates/imagens), cada módulo
   recebendo MainContext.
4. **Máquina de fases** → `phaseEngine.ts` (preparePhasePane, advancePhase,
   retryOrBacklog, openGatePane, finalizeTask, poller, liveGateWaits,
   gateDeathLog, phaseWatches).
5. **Grupos de IPC por domínio** → `ipc/<dominio>.ts` (voice 25, maestro 14,
   tasks 11, skills 10, projects 7, …).

Critério de pronto por commit: `npm run typecheck` + suítes da área
(orchestrator-flow 35, mission-verification 25, integration-queue,
pane-permissions, pty-transcript) + boot de validação TEU ao fim de cada
bloco. Nunca "aproveitar e refatorar" fora do mapa.

## Fase 2 (5a parte 2) — veredito sem barreira síncrona (CHECK 1 núcleo)

- Hoje `advancePhase` é SYNC POR CONTRATO (comentário-âncora em :10855; a
  cicatriz do "[object Promise]"): a fotografia atômica é garantida por
  sincronicidade, e o git síncrono no main é o stall de toda transição.
- Desenho proposto: **lock de transição por card** (fila serializada
  taskId→Promise) + `snapshotProblemFor` viajando pelo gitWorker (gitOff) +
  estado transitório do card durante a validação (nenhuma segunda transição
  entra enquanto o lock vive; poller e report respeitam o lock — a
  idempotência "quem chega primeiro deleta o watch" passa a ser "quem SEGURA O
  LOCK deleta o watch"). O contrato (nenhum veredito com fotografia velha)
  fica preservado por SERIALIZAÇÃO, não por sincronicidade.
- Risco alto: call sites do advancePhase viram await; teste novo obrigatório
  de corrida (2 vereditos simultâneos no mesmo card + veredito × boot).

## Fase 3 (5b) — multi-renderer (CHECK 2; sessão própria)

- Sonda positiva de 2026-08-06 (probe-webcontentsview-webgl): WebContentsView
  = renderer PRÓPRIO por view, 16 contextos WebGL POR view, ~107MB/view.
  Decisão do dono já tomada: Vertente B ("meu PC tem 32GB").
- Corte 1: Board (PM+orquestradores) numa view, canvas de Panes noutra —
  dobra o orçamento WebGL e divide o parse dos streams por 2 processos de
  renderer. `pty:data` é limpo (o main roteia por webContents).
- Custos mapeados: drag ENTRE views = migração de processo (recriar xterm +
  SIGWINCH repinta — sondar codex antes); store zustand por renderer
  (sincronizar via push do main, que já é o padrão); portais/overlays por
  view.
- Complemento posterior: pool WebGL por visibilidade.

## Fase 4 (5c) — QA de Electron com app real via CDP (1 janela + validação)

- `@playwright/mcp` aceita `--cdp-endpoint` (sondado 2026-08-07). qaRuntime
  detecta produto Electron → sobe o app real com
  `--remote-debugging-port=<porta livre do mapa>` → o wrapper playwright do
  pane QA ganha `--cdp-endpoint http://127.0.0.1:<porta>` → QA testa
  preload/IPC REAIS (o duplo de bridge morre).
- Conferir na implementação: árvore do Electron do produto sob o guardião
  (guardExternalPid no filho real), e o ciclo da janela do produto na tela do
  dono durante o QA (prompts já mandam fechar ao fim da rodada).

## Fase 5 — correio MCP até o fim: ZERO digitação entre agentes (ordem do dono, 2026-08-07)

Ordem literal: "não quero mais NADA sendo enviado por texto e mandando Enter —
pode me atrapalhar na hora que eu estiver escrevendo; quero a conversa entre
eles extremamente rápida" (memória `feedback-zero-digitacao-entre-agentes`).

- Pré-condição (regra do handoff): validar o F1 ao vivo primeiro —
  mailbox-post/mailbox-delivered no journal, agentes reagindo ao bloco
  "[synkora inbox]", nudge não poluindo. Acontece no uso normal com missões.
- **F2**: correlationId fim-a-fim (HubDeps.inject ganha meta; coalescência por
  FATO no lugar do dedup por texto) + migrar TODOS os injetores diretos
  restantes para o correio.
- **F3**: aposentar a digitação de payload por completo — `delivery-injected`
  no journal vira exceção registrada como anomalia.
- DESENHO DO ACORDAR-SEM-INPUT (ideia do DONO, SONDADA em binário real
  2026-08-07, probe R12/R13 no claude 2.1.224 — o limite físico caiu):
  (1) pane COM shell (dev/orquestrador/ajudante) arma um WAITER em background
  ao entrar em espera — comando que long-polla a mailbox; quando ele termina
  (mensagem chegou), o CLI acorda o agente com a notificação de background
  task, ZERO input (R12: WAITING → turno encerrado → 25s → WOKE-UP sem
  digitação); (2) gate read-only (sem shell, de propósito) usa LONG-POLL na
  própria tool check_messages — o servidor segura a resposta até ter mensagem
  (R13: tool call segurada 45s no perfil exato do gate, sem timeout; calibrar
  o teto por ciclo de re-poll na implementação). Digitação sobra como último
  recurso AUDITADO (anomalia no journal) — nunca remover a rede inteira.
  Sondar o equivalente no codex antes de generalizar (background/long-poll).
- Encaixe: pode rodar ANTES da Fase 3 (multi-renderer) se a validação do F1
  vier limpa — é menor que qualquer fase da cirurgia e independe dela; a
  Fase 1 (extração do mcpApi/hub) deixa o terreno mais limpo para o F2.

## Nota de estado — spec MCP 2026-07-28 (verificado em sonda, 2026-08-07)

- claude 2.1.224: propõe protocolo 2025-11-25 no initialize e REJEITA
  2026-07-28 quando o servidor a oferece (handshake para; sonda R11). A
  string "2026-07-28" existe no binário = código em preparação, não suporte.
- codex 0.147.0: flag `mcp_2026_07_28` presente e DESLIGADA de fábrica
  ("under development"). O app já liga por pane (`--enable mcp_2026_07_28`)
  quando settings.mcpProtocolMode = 'modern-experimental'; em 'auto' espera a
  OpenAI ligar de fábrica. Servidor do Synkora já é dual-era — nada a
  construir do nosso lado; re-sondar a cada update de CLI.

## Ordem e cercas

- Fase 0 → 1 → 2 → 3 → 4, sem sobreposição ("nunca meio-fazer").
- Toda edição de src SÓ com app parado (checagem de processo imediatamente
  antes de cada edit — a prova expira).
- Cada commit reversível e verde; regressão de suíte = parar e voltar.
- Janelas estimadas: F0 = 1 curta · F1 = 2–4 · F2 = 1–2 + validação ao vivo ·
  F3 = sessão própria · F4 = 1 + missão de QA real.

## Pendências que este plano NÃO cobre (ficam onde estão)

- Fix do CHECK 14 (prompt de resume por arquivo) — já desenhado na sessão dos
  níveis 4, entra na primeira janela de app parado, ANTES da Fase 0.
- Correio MCP F2/F3 — depois do F1 assentar em produção (handoff).
