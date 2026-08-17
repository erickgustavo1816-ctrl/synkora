# HANDOFF — sessão 2026-08-17 (A LIMPA F6 + card de plano + largura)

Sessão operada no esquema orquestrador (Fable) + frota Opus 5 max. Continuação
direta da 2026-08-15b (ler antes). TUDO na `nivel5-fase1`, nada pushado.

## O que entrou (ordem cronológica)
1. **Fix do card de proposta que sumia** (`001dc13`): política pura
   `guiInteractionQueue.ts` — pendência que não bloqueia o CLI não é tratada
   como uma que bloqueia; card aparece SÓ quando o agente termina de falar
   (coreografia ordenada pelo dono) e fica até a decisão; travessia completa
   provada (mid-turn → result → kill → rehydrate → resolvível).
2. **Prosa do plano em largura total** (`1e5206f`): medidas de leitura
   66-72ch e tetos de 980px das superfícies NOVAS de plano morreram.
3. **A LIMPA F6** (ordem do dono: "acabou" — revogou o suprimir-não-demolir).
   3 waves + integração, ~86.000 LOC removidas, 25 commits de demolição:
   - W1 `1bbb457..010ce34`: aba F6 do mapa morta (um design só de plano) +
     **designação de mestre** (plans:setKind, só o dono designa; card de
     proposta mostra kind — fim do clique cego; promover exige plano ativo);
     motores de skills/subagentes/imagens/LSP/serviços/cofre órfão (35.574
     LOC). As 404 skills do dono em %APPDATA% ficaram (dado, não motor).
   - W2 `1d9ca9b..20da071`: catálogo MCP legado + correio/mailbox mortos;
     hub reduzido ao REGISTRO DE IDENTIDADE (o gui-planner depende dele);
     mcpServer 2.198→683 linhas. Suítes novas: test:gui-planner-mcp
     (round-trip com controle negativo) e test:mcp-dual-era reescrito sobre
     o catálogo vivo.
   - W3 `05e9cb3..9a68078`: pipeline de fases/gates + ajudantes + motor do
     plano mestre F6 + TaskStore/PolicyStore (prova no commit: sync-card
     inalcançável por missão direct) + radar re-derivado de missões+fila;
     ilha panes-view inteira; Board 3.555→1.260; abas de terminal migradas
     ANTES do machado (R-20); .maestro-body com filhos POR CHAVE (classe de
     bug de remontagem morta por construção); palavra "Maestro" zerada na UI;
     agregados novos test:domain + test:platform + **`npm test` raiz —
     nenhuma folha fora de agregado**.
   Design vinculante + anexos: .synkora/reports/DESIGN_LIMPA_F6_2026-08-17.md
   e PURGE_{MAIN,MAP,TESTS,RENDERER}_2026-08-17.md + relatórios de execução.

## Flags para o dono (decisões tomadas, reversíveis)
- R-5: o gate de release do roadmap F6 morreu SEM substituto (fila/worktree/
  missões/backlog seguram); se quiser trava equivalente no plano 2.0, é card.
- R-17: reiniciar o MCP interno = reiniciar o app (painel Serviços morreu).
- Radar: planos 2.0 NÃO aparecem no overlay (o slot morreu com o plano F6;
  adicionar seria feature nova — pedir se quiser).
- ask_user legado morreu — pergunta de agente ao dono é o card no chat.
- Legado em disco (tasks.json, PROJECT_PLAN.json, maestro.json) fica INERTE e
  legível; missão legada no board mostra "missão do fluxo antigo, sem
  conversa" — nunca crasha (suíte store-legacy-documents prova).

## Pendências
1. **VALIDAÇÃO VISUAL NO APP REAL da limpa inteira** (agentes verificaram em
   harness; ninguém rodou o app): Home sem seções mortas, Settings 3 seções,
   Board 2.0 (chat + terminais + pílulas novas do ✦ geral), mapa (rotas +
   planos + designação de mestre), versões, arquivos, radar enxuto, missão
   LEGADA inerte. `npm run build`/instalador não rodados.
2. Diretórios de worktree presos por lock (junctions removidas, cópias
   inertes): Synkora-wt-limpa-mcp / -pipeline (deletar à mão quando soltar).
3. sessionStats.ts ficou (lê JSONL dos CLIs; login panes usam) — reavaliar.
4. Dívidas D2: hostOverlayCount sem leitor; ~270 regras CSS de seletor misto
   para varredura futura.
5. Wave futura já desenhada: browser embutido
   (DESIGN_SYNKORA_BROWSER_2026-08-15.md — RightDock estilo Claude Code
   primeiro, sonda CDP depois).

## Regras novas de processo (memória)
- Relatório de agente SEMPRE em arquivo (schema mínimo) — um schema rico
  estourou e queimou 35min de rodada.
- Browser de agente = interno do Claude, nunca o Chrome real do dono.
- Design sempre com a skill impeccable, roteada pelo orquestrador.
