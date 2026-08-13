# HANDOFF — sessão de 2026-08-11/12 (teste de missões rodada 2 → 4 blocos de fixes ao vivo)

A PRÓXIMA SESSÃO lê isto primeiro. O dono deu /clear. Esta sessão validou o
F6.12 em produção, caçou e corrigiu bugs em 4 blocos (com app parado entre
missões) e terminou com o pipeline atravessando missões INTEIRAS sem erro.
Monitor da sessão: vigias node sobre o journal (padrão: script inline que
espera evento novo e sai; bbwatch --since para leitura).

## PLACAR E ESTADO VIVO (projeto PAINEL DE GESTÃO — ERICK)

- Plano mestre: **11/18 missões concluídas**. Integradas HOJE: M06b
  repaginação (branch mission/c71757dd), M07 PERDCOMP (**a 1ª missão 100%
  limpa da história** — zero reprovação, zero anomalia), M08 SPED (conflito
  mecânico de package.json resolvido via estratégia do PM + card de sync).
- **M09 "Créditos por empresa com standby automático" (mission/48b330e9):
  ATIVA, aguardando o ⇪ do dono** — 3/3 cards done (back dados+IPC, front
  seção de créditos, QA testes de aceite com 20 specs/6 critérios validados
  por mutação), conclude_plan + record_learnings rodados (00:06Z),
  verificação conjunta disparada. Se o ⇪ não aconteceu ainda, é o único
  passo pendente; a fila estava VAZIA no fechamento.
- CRITÉRIO DE PRONTO do dono (F6.8b: 2 missões consecutivas limpas): M07
  foi a 1ª; a M08 teve conflito de fila (externo ao ciclo). Contagem segue.
- Estante do Maestro viva: .synkora/maestro/telas.md + pedras-pipeline.md
  (o orquestrador reescreve a cada conclude — validado 2×). O tópico
  pedras-pipeline ainda lista o bug do delegate como aberto; foi CORRIGIDO
  (bloco 2) — se corrige sozinho no 1º delegate que funcionar.

## OS 4 BLOCOS DE FIXES (nenhum commitado — working tree compartilhado)

BLOCO 1 (manhã–tarde, app parado):
- 🔴 SLASH COMMANDS MORTOS em todo pane claude: o trabalho paralelo de
  skills tinha posto `--disable-slash-commands` no claudeSkillIsolation
  (panePermissions.ts:187) — slash é interface do HUMANO; a cerca do agente
  é o --disallowedTools Skill,Agent,Task que FICOU. Provado por sonda A/B
  no claude 2.1.227 (scratchpad probe morreu com a sessão; método: PTY real,
  caso nu funciona, com a flag reproduz "Unknown command"). Teste
  test-pane-permissions atualizado (14/14).
- 🔴 DELEGATE 100% MORTO: phaseEngine.ts (~1781) gravava runModel como
  display "opus[1m] · max" e o clamp de tier (mcpApi/helpers.ts:324+) o
  consumia como id → pool recusava tudo. Fix: runModel = id puro (effort já
  tem devEffort) + clamp defensivo com split(' · ') p/ cards persistidos no
  formato velho. SEM PROVA VIVA ainda (nenhum delegate rodou depois).
- Ctrl+A custom REMOVIDO (TerminalPane) — ordem do dono: a tecla vai crua
  ao TUI; Ctrl+Shift+A segue como apagar-input.
- FALSO POSITIVO DE RISCO no create_plan (orchestratorFlow.ts:385 regex
  payments casando prosa do plano MESTRE — produto tributário fala de
  honorários): em modo LEVE, elevação vinda SÓ de texto virou ANOTAÇÃO
  auditada (plan-risk-raise-annotated) — risco do plano = declarado +
  superfícies declaradas; modo estrito impõe integral (board.ts createPlan).
- Itens 13/14 (composição quarentena+restore; meritRecipe apontando
  complete_task na invalidação com veredito de mérito) — APLICADOS neste
  bloco (comentários 2026-08-11 no phaseEngine ~3886/4206 confirmam).
- Resiliência pós-crash do Network Service (15:52, renderers em cascata,
  sem minidump — externo/AV): retry com backoff no reload pós
  renderer-gone; dono adicionou exclusões do Defender. Dirty-exits antigos
  explicados (0xC000013A = Ctrl+C no console).

BLOCO 2/3 (noite, app parado, PARALELO — eu + agente Fable na MESMA árvore
com arquivos particionados; worktree isolado seria pior: a árvore carrega
uncommitted de todos):
- RESOLUÇÃO DIRETA AUDITADA de conflito mecânico (ordem do dono — caso
  M08: 1 linha de package.json custou ciclo inteiro):
  guide_integration_resolution ganhou directResolution (mcpServer schema +
  mcpApi/missions.ts): valida origem LIMPA + gitCommitReached(targetHead),
  re-lacra via requeueAfterSync no head novo, audita
  queue-direct-resolution com range+estratégia verbatim, drena — a fila
  retoma com o aval ORIGINAL do dono, sem card. Persona do PM (maestro.ts
  GIT PROBLEMS) com a régua mecânico×semântico (na dúvida = semântico).
  SEM PROVA VIVA ainda.
- UI (agente Fable): tooltip do host ROTEADO para dentro da panes view
  (canais panes-view:tip-show/tip-hide; Tooltip.tsx mede e roteia;
  panesViewVisibleRect no store como fonte única) + CONGELADO da view sob
  popover do host (capturePage → .panes-freeze no workspace-stage;
  contador de geração anti-corrida; falha degrada pro buraco antigo).
  Zero wiring em index.ts. VALIDAÇÃO VISUAL PENDENTE (hover titlebar na
  aba Panes; popover de CLIs na aba Panes).

BLOCO 4 (madrugada, app parado):
- 🔴 GUARD DA CADEIA NO run_task rebaixado (board.ts runTask ~1576): "a
  branch avançou fora da cadeia de cards" agora RE-CARIMBA auditado
  (plan-execution-head-restamped) igual ao conclude — beco real da M09
  (merge manual auditado como idêntico travava o 3º card; nem reinício
  resolvia). VALIDADO AO VIVO: o card de QA da M09 destravou na hora.
- INSTRUMENTAÇÃO do restore de runtime: restoreRuntimeAndRevalidate
  (worktree.ts:279) devolve skipReason em TODO caminho de não-ação;
  phaseEngine grava `gate-runtime-restore-skipped` nomeando a condição
  (incl. head do veredito ≠ entrega do dev). Motivo: 23:04 o QA da M09 foi
  invalidado com culpados 100% data/* DENTRO da allowlist e o porquê era
  indiagnosticável — a PRÓXIMA ocorrência se explica sozinha no journal.

## ORDENS NOVAS DO DONO (memórias gravadas)

- feedback-panes-vivos-esperando (2026-08-11): pane de dev e gate NUNCA
  fecham entre rodadas — vivos esperando, trafega SÓ o delta nos dois
  sentidos e nos dois gates. "Fechou" = janelas de teste, não o pane.
  Fechos legítimos: aprovação final, plano pausado, fallbacks de pane
  morto. VALIDADO AO VIVO 3×: dev esperando pós-done; reviewer reciclado
  na MESMA conversa 2× ("gate-recycled ... re-verificação incremental").
- Delta ponta a ponta (item 12): gate FRESCO de rodada 2+ ainda nasce com
  briefing INTEGRAL — pendente: delta-prompt (lista herdada + range SHA +
  contrato mínimo) quando o fallback do reciclo disparar.

## VALIDAÇÕES VIVAS CONFIRMADAS NESTA SESSÃO

complete_task por ordem verbatim · record_learnings (estante nasceu e é
re-escrita) · porteira start_project_mission · espera = 1 long-poll
(waitForMail 600s acordado por correio, mailbox-nudge skipped-waiter-armed
em série) · memória escalável do PM (maestro-resume-skipped-cost ~162k →
fresco pelo MAESTRO.md) · renascimento de dev pós-crash e pós-bloqueio
(resume-skipped-cost 222k/290k/479k, ACTIVE SKILL PLAN re-entregue e
re-ativado) · guardião de job objects em crash sujo real (zero órfãos) ·
phase-prompt-via-file auditado · bloqueio ambiental (dev-ui-blocked-
environment, playwright MCP caiu 22:22) · estratégia de conflito do PM 2×
(stash de runtime; card de sync) · plan-execution-head-restamped no
conclude E no run_task · Fase 0 nomeando stalls (ipc:projectPlan:
startMission ~1151ms = dado p/ sessão de desempenho).

## PENDÊNCIAS (ordem sugerida)

1. M09: ⇪ do dono → integração (12/18). Depois o PM indica a próxima onda.
2. Validar ao vivo o que não teve prova: delegate consertado (ajudante
   clonando tier), directResolution no próximo conflito mecânico, tooltip/
   freeze na aba Panes, gate-runtime-restore-skipped (na próxima
   invalidação com allowlist o journal dirá a causa exata — aí o fix
   definitivo do item 17).
3. Delta-prompt p/ gate fresco de rodada 2+ (item 12) + causa da falha
   INTERMITENTE da renovação de skills no reciclo (item 10; o fallback
   live-gate-recycle-fallback já audita a causa).
4. Card no PRODUTO: runtime data/ fora de caminho rastreado (classe-raiz
   de 4 episódios em 2 dias; o PM cria — cobrar na próxima onda).
5. Observar: 2 classes de processo auxiliar morrendo no mesmo dia (network
   service 15:52; playwright MCP 22:22) — recorrência = investigar AV/RAM.
6. PUSH de tudo (ordem do dono: só no fim) + instalador + varrer handoffs.
7. Recomendações abertas herdadas: tool SAIR DA FILA; sonda long-poll
   codex ≥300s; beco risco-subiu×fila em modo estrito.

## ⚠️ WORKING TREE COMPARTILHADO — NÃO COMMITAR NEM REVERTER

O trabalho de SKILLS de outro agente segue uncommitted na árvore, misturado
com os 4 blocos desta sessão e o clamp de tier. Quem fechar o trabalho de
skills commita os arquivos compartilhados juntos; NUNCA reverter
helpers.ts/phaseEngine.ts/panePermissions.ts sem preservar os fixes daqui.

## REGRAS VIVAS (inalteradas)

App SÓ no terminal do dono · src SÓ com app parado (Get-Process electron
antes) · sonda antes de afirmar · instrumentar antes de teorizar ·
subagentes/Opus só com aval POR SESSÃO (o aval de 2026-08-11 NÃO carrega) ·
missão viva = monitor + caderno · commits só com ordem.
