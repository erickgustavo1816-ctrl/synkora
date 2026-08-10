# HANDOFF — sessão de 2026-08-10 (teste de missões → revolução da AUTONOMIA)

A PRÓXIMA SESSÃO lê isto primeiro. O dono deu /clear por custo de token.
Bloco F6.12 do CLAUDE.md tem o registro canônico; este arquivo é o mapa de
retomada. Caderno detalhado da sessão (efêmero): scratchpad
NOTAS_TESTE_MISSOES_2026-08-10.md.

## O QUE ESTA SESSÃO FOI

Rodada 1 do teste de missões (roteiro do HANDOFF_FASE5). O MOTOR atravessou
dev→review→QA→conflito→estratégia→sync→gates de ponta a ponta com zero
digitação de payload — mas o dia expôs ~10 classes de guardas do harness
travando trabalho BOM (veredito do dono: "o Synkora tá mais atrapalhando
que ajudando" → "o orquestrador é tão inteligente quanto você, não adianta
capar ele" → /goal "só termina quando der autonomia"). A sessão virou a
reforma da autoridade: 14 commits em 4 blocos + 1 clamp não-commitado.

DOUTRINA NOVA (memória permanente feedback-guardas-nao-capam-inteligencia):
guarda DURA só protege AUTORIDADE/VERIFICABILIDADE (fotografia lacrada dos
gates, ⇪ do dono, catálogo read-only dos gates, supply-chain, argv/path);
guarda de JULGAMENTO vira advisory auditado; decisão do dono SEMPRE tem
canal mecânico (ownerOrder verbatim, padrão set_phase_executor).

## ESTADO VIVO DO TESTE (projeto PAINEL DE GESTÃO — ERICK)

- M03 Empresas: INTEGRADA na V1.0 ✅ (a fila drenou ao vivo pós-bloco 1).
- M06 Notas: entrega PRONTA e MESCLADA na branch da missão (merge manual
  767a6a8 do orquestrador, 449 testes verdes) — falta conclude_plan (com os
  fixes PASSA: contrato 2/2 via queueSync/estrutural, executionHead
  re-carimba, fantasma 1c086e24 se REMOVE sozinho no boot) → verificação
  conjunta → ⇪ do dono → merge. Card real de sync: 3263ab4d (done, gates
  waived por autoridade + 2 aprovações de QA no mérito no journal).
- M05 Tarefas simples: queued atrás da Notas; head==fotografia (o
  orquestrador dela desfez o commit de runtime sozinho).
- data/ declarada como runtime do produto (declare_runtime_paths) na M06;
  card DEFINITIVO no produto (runtime fora de caminho rastreado) ainda por
  criar (o PM cria; T9 segura enquanto isso).

## OS 14 COMMITS (bb79f96..cab38b2)

1. bb79f96 — fila destravada: card da fila fora do contrato de
   proporcionalidade; válvula de revalidação da fotografia (plano done com
   head defasado re-verifica); ⇪ bloqueado audita + receita ao orquestrador;
   porteira prova a fotografia antes de pulsar; update em card andando livre.
2. da46c04 — 📬 só acorda pane PARADO (anti-stale; 3 casos ao vivo, incl.
   janela read-first do CHECK 14); espera = 1 long-poll + ENCERRE O TURNO
   (fim do loop de 45s, ~80 inferências/hora economizadas).
3. 95376d1 — fallbacks do reciclo de gate auditados; CDP reservado p/
   QUALQUER card de produto Electron (era só uiWork).
4. 37a5b2b — securityReview fora de lugar é descartado, não derruba report.
5. 02aa901/55a6989/d1c0be6/24978e1 — docs F6.12 (blocos 1-3 + adendo).
6. 65474cc — declare_runtime_paths + restoreRuntimeAndRevalidate (sujeira
   de runtime declarado restaurada, veredito sobrevive); ownerOrder em
   update_task (gates contra piso de risco por ordem do dono);
   risk-raise em ajuste = anotação em modo leve; T8 test-cards de QA
   (specs dos CRITÉRIOS, nunca da implementação; card dept qa; gate roda
   suíte como piso de regressão).
7. 26b4e30 — AUTONOMIA: complete_task {id, reason} (conclui card AUTO
   direto; gates faltantes viram verdict 'waived' auditado; registrado FORA
   do catálogo dos gates — o teste mcp-dual-era pegou a 1ª posição errada);
   conclude_plan aceita waived; portas trancadas apontam a receita.
8. b94fbf2 — identidade PERSISTENTE do card da fila (Task.queueSync +
   fallback estrutural: plano com grafo, card auto sem planItemId = só
   harness cria) — reescrita de briefing matava o marcador e ressuscitava o
   deadlock; complete_task avisa que NÃO mescla a branch task/<id8>.
9. 8483b8d — reparo de boot da fila usa a identidade persistente (fim da
   FÁBRICA DE FANTASMAS: cada boot criava card de sync duplicado), remove
   fantasmas existentes sozinho (queue-sync-ghost-removed), e a guarda da
   "cadeia reconhecida" no conclude virou re-carimbo auditado
   (plan-execution-head-restamped) — merge manual do orquestrador é
   legítimo, a cerca é a verificação conjunta.
10. d534d4b — DEV dirige o app Electron REAL via CDP (mesma reserva do
    card; prompt entrega a receita npm run + --remote-debugging-port);
    Ctrl+A = selecionar tudo (copiar com Ctrl+C), apagar-input virou
    Ctrl+Shift+A.
11. 7646928 — memória ESCALÁVEL do Maestro: fato duro nunca é prosa
    (board_status/git, nunca afirmar sem verificar); MAESTRO.md = ÍNDICE
    com teto ~120 linhas; tópicos destilados ≤200 linhas em
    .synkora/maestro/ lidos sob demanda; manutenção = reescrever menor.
12. df11983 — AJUDANTES DE VOLTA: teto F6.2 restaurado (fast 0 · standard
    2 · deep 4 — um corte posterior tinha deixado TUDO em 1) e diretivas
    sem pedir-licença.
13. cab38b2 — régua QUALIDADE-PRIMEIRO da delegação (refinamento do dono):
    delegar SÓ trabalho longo (~30min+ solo); ajudante CLONA o dev — mesmo
    modelo, mesmo effort, skills do bloco; dev integra e ASSINA.

## ⚠️ WORKING TREE COMPARTILHADO — NÃO COMMITAR NEM REVERTER

Outro agente de IA trabalha AO MESMO TEMPO na área de SKILLS. Uncommitted
no tree: docs/SKILLS.md, skillsBundled/skillsLibrary/skillsRouting,
skillsBackendCyberBundled.ts (novo), testes de skills, e patches em
phaseEngine/phasePrompts/mcpApi/helpers.ts POR CIMA dos meus commits.
DENTRO de mcpApi/helpers.ts também está o MEU CLAMP DE TIER não-commitado
(ajudante de dev herda modelo+effort do delegador mecanicamente, com aviso
"tier do delegador aplicado" — typecheck e suítes de helpers verdes na
árvore combinada). Quem fechar o trabalho de skills commita o arquivo
inteiro; NUNCA reverter helpers.ts sem preservar o clamp.

## PENDÊNCIAS (ordem sugerida)

1. VALIDAR AO VIVO no próximo boot: fantasma da Notas removido →
   conclude_plan passa → verificação conjunta → ⇪ → fila drena M06 e M05.
   Monitor: node scripts/bbwatch.mjs --follow (narrar sem ser pedido).
2. Validações novas de carona: complete_task/waived no fluxo real,
   restore de runtime (' M' e '??'), nudge skipped-busy, espera sem loop,
   dev-CDP em card de UI, ajudantes clonando tier.
3. Card no PRODUTO: runtime data fora de caminho rastreado (PM cria).
4. PUSH de tudo (ordem do dono: só no fim) + INSTALADOR novo + varrer
   HANDOFF_FASE5.md e este arquivo no fechamento.
5. Recomendações ABERTAS: tool/botão SAIR DA FILA (ticket não-merging);
   sonda long-poll codex ≥300s (tool_timeout provado W4); beco
   risco-subiu×fila em modo ESTRITO; rabo do nudge embaralhado no echo
   (cosmético — sonda do fatiamento do inject antes de mexer).
6. Higiene: worktrees de agente em .claude/worktrees/ — remover SÓ com
   checagem de junctions (lição feedback-worktree-junction).
7. docs/ISSUE_DRAFT_claude-code_mcp-first-turn.md — o dono decide postar.

## REGRAS VIVAS (inalteradas)

App SÓ no terminal do dono · src SÓ com app parado (Get-Process electron
imediatamente antes) · commits sem acentos, por caminho explícito,
reversíveis e verdes · sonda antes de afirmar · subagentes/Opus só com aval
POR SESSÃO · missão viva = monitor + caderno.
