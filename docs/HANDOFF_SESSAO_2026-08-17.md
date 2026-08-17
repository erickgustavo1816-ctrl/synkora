# HANDOFF — sessão 2026-08-17 (A LIMPA F6 + card de plano + largura)

Sessão operada no esquema orquestrador (Fable) + frota Opus 5 max. Continuação
direta da 2026-08-15b (ler antes). TUDO na `nivel5-fase1`, nada pushado.

## ⚡ PRÓXIMA SESSÃO — COMEÇAR AQUI, NESTA ORDEM

### 0. RECUPERAR node_modules (bloqueia tudo; app do dono FECHADO antes)
Incidente no fim da sessão: ao limpar pastas velhas do Desktop, um
`Remove-Item -Recurse` atravessou junction viva de node_modules (a armadilha
da memória feedback-worktree-junction, violada) e destripou o node_modules do
repo; o `npm ci` de recuperação morreu em EPERM porque o `npm run dev` do dono
segurava o esbuild.exe. Com o app fechado:
`npm ci && node node_modules/electron/install.js && npm test`
CÓDIGO INTACTO — HEAD `5af421c`, tudo committado. Último gate raiz 100% verde
foi em `88c2964`; depois entrou só o concluir-planejamento (`5af421c`,
typecheck + test:project-landing 23/23 verdes; gate raiz pendente do
node_modules).

### 1. BUGS PARA ARRUMAR (primeira frente de trabalho)
1. 🐛 Medidor de contexto do CODEX passa de 100% (ex.: 404.325 tokens numa
   janela de 258.400 — clampa em 100% na UI mas a fonte está errada; a rodada
   do claude consertou só o lado claude; evidência em gui-sessions.json,
   pane gui-dev-7bcd1b79).
2. 🐛 Token `--err` sobre papel: 4,08:1 em texto pequeno (ex. botão excluir
   do quadro do plano; a aba Versões usa a mesma roupa em 3 lugares) —
   decisão de PALETA global, escurecer o token ou aceitar.
3. 🧹 Desktop: `Synkora-wt-limpa-mcp` e `-pipeline` presos por lock (inertes,
   junctions já removidas — deletar quando o Windows soltar / pós-reboot).
   `synkora2-teste`: perguntar ao dono se apaga. `Synkora2` NUNCA apagar
   (pedreira de ideias, decisão dele).
4. 👁 VALIDAÇÃO VISUAL pendente do dono: rodada 3 (barra APROVAR/AJUSTAR só
   em pergunta real; dashboard novo; ◈ = versão na main; versão digitável) +
   concluir planejamento (`5af421c`) + popover de contexto pós-fix.
5. 🔧 REGRA DE VERSÃO REFINADA (ordem do dono, 17/08, spec exata): a versão
   LIVRE (digitável) só existe enquanto o projeto tem ZERO versões — a
   primeira oferta é `1.0` · `0.1.0` · `0.0.1` + campo livre (caso do projeto
   que chega na 1.20). CRIADA a primeira, o campo livre SOME e daí em diante
   só as sugestões do motor (ex.: a partir de 1.20 → `2.0` · `1.21` ·
   `1.20.1`); duplicata continua proibida. AJUSTE sobre a rodada 3 (que
   deixou o campo livre SEMPRE visível — BacklogView sidebar). VERIFICAR a
   interação com ensureDefaultVersion (backlog.ts): se criar missão sem
   versão auto-semeia "V1.0", ela ROUBA a janela do campo livre do projeto
   1.20 — decidir se a auto-semeadura espera a primeira versão manual ou
   oferece o picker.
6. ✅ TRAVA DE RELEASE DO PLANO — ORDENADA pelo dono (17/08, spec exata):
   a) "⇪ subir versão" RECUSA enquanto o plano do MAPA tiver missão
      pendente da versão. A recusa NOMEIA as pendentes e receita as DUAS
      saídas: fazer a missão ou excluir o item ("ou eu excluo ou eu faço").
   b) PlanBoardView: cada item ganha DOIS verbos do dono — "começar" (já
      existe: criar missão) e "EXCLUIR" (novo: descarta o item — sai do
      progresso e da trava; recomendação: status 'descartada', que o motor
      já exclui das contas; confirm inline, nunca diálogo nativo).
   c) SEM botão de editar — decisão explícita do dono: edição é CONVERSA
      (abre missão de planejamento e pede; update_plan já cobre). Não criar
      superfície de edição manual.
   d) AMARRAÇÃO item→versão a resolver na investigação: Plan não tem
      versionId hoje. Modelo mental do dono: o plano mestre da release
      bloqueia a versão dele. Candidatos: (i) herdar da missão vinculada
      (item com missão carimbada na versão que sobe = pendente dela) +
      item SEM missão do plano MESTRE ativo conta como pendente da versão
      que sobe; (ii) versionId opcional no Plan carimbado na proposta.
      Decidir com evidência e registrar no design do fix.

### 2. ROADMAP ORDENADO PELO DONO (17/08, nesta sequência)
1º os bugs acima (inclui a trava de release do plano, item 6 — ordenada).
2º **SUBAGENTES SEM ABA — delegação cross-CLI pelo MCP interno** (etapa NOVA
   ordenada pelo dono, ANTES do browser). Spec nas palavras dele:
   - Hoje revisor/ajudante abrem OUTRA ABA de chat que ele nunca lê ("eu
     nunca vou conversar com esse agente que ele criou"). Isso acaba:
     subagente NUNCA vira aba.
   - O chat da missão delega POR DENTRO, "igual o Claude Code faz hoje com
     os Opus": o agente chama tools de delegação do MCP INTERNO NOVO (mesmo
     padrão do gui-planner — token por pane, catálogo próprio, "sempre com
     esse MCP novo, porque a conversa entre as LLMs fica melhor"), o
     harness roda o ajudante em sessão HEADLESS e o resultado volta como
     resposta de tool ao delegador.
   - A atividade aparece na LATERAL de subagentes que já existe (terceira
     fonte, ao lado dos nativos claude/codex) — mesmo lugar, mesmo idioma.
   - CROSS-CLI SEM DISTINÇÃO: chat Claude delega para ajudante GPT/Codex e
     vice-versa; para o dono é tudo "subagente na lateral".
   - Peças existentes a costurar: guiPlannerMcp (padrão de arm por pane),
     MaestroSession/CodexSession (motor headless), GuiSubagentSidebar +
     normalizeGuiSubagentSidebar (lateral), guiClaudeTasks/guiCodexAgents
     (precedentes de ciclo de vida). Botões REVISAR/AJUDANTE do rail passam
     a produzir subagente de lateral, nunca aba. Decisões de design para a
     investigação: catálogo das tools (delegate/status/result — padrão
     assíncrono, tool nunca bloqueia por minutos), escolha de seat/CLI do
     ajudante (quem decide: agente com defaults? dono?), teto de paralelo,
     e a cerca de que ajudante NUNCA herda o MCP de delegação (sem cadeia
     infinita nível 2 — espelho da regra dos nativos).
3º Push + instalador (`npm run dist` não roda desde a limpa;
   electron-builder.yml mudou — validar o build).
4º BROWSER EMBUTIDO (design fechado: DESIGN_SYNKORA_BROWSER_2026-08-15.md —
   RightDock estilo Claude Code primeiro, sonda CDP, browser por missão).
Opcional não pedido: planos no radar ANDAMENTO.

### 3. Regras de processo (memória — NÃO repetir os erros)
- Relatório de agente SEMPRE em arquivo; schema mínimo.
- Browser de agente = interno do Claude, nunca claude-in-chrome.
- Design = skill impeccable roteada pelo orquestrador.
- Worktree: junction SEMPRE checada antes de remoção recursiva; limpar tudo
  ao fim da rodada; agentes Opus max; teste novo vermelho antes de verde.

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

## RODADA 2 DE FIXES (mesma noite — 5 achados do dono no app real)
1. 🔴 "Acesso completo" matava o pane do planejador: respawn (troca de modo /
   /clear / fila com modo novo) nascia apontando para o config MCP que o
   dispose apagou ("MCP config file not found", 2 ocorrências no journal, com
   CONTROLE NEGATIVO provando que o bypass era inocente). Fix no seam do
   spawn: `guiPlannerArm.ts` re-arma idempotente a cada create (re-prova
   autoridade + confere o arquivo no disco); recusas auditadas por nome.
2. 🔴 Medidor de contexto MENTIA: `result.usage` do claude é o AGREGADO DO
   TURNO (soma das chamadas de API — 3×176k = os 528.703 da tela) e não o
   contexto. Provado por aritmética exata contra o /context do dono (176,3k
   reais). Fonte trocada para o usage da ÚLTIMA mensagem do turno; comando
   local não zera mais o medidor; rótulos honestos ("contexto", "custo da
   sessão" — o custo é verdadeiro, acumulado do processo).
3. Recibo de aprovação de plano deixou de virar bolha "VOCÊ" com uuid: novo
   `registry.announce` entrega ao modelo sem user-message; copy limpa.
4. Cabeçalho do quadro do plano (impeccable): gramática única de selos
   (mestre = identidade preenchida colada ao título; estado = contorno na
   outra ponta), descrição com "ver mais" (corta altura, nunca largura),
   título 21px/800, excluir isolado com roupa de perigo.
5. Leitor de .md da aba Arquivos: `max-width: 78ch` morreu — 51,5% → 93,7% de
   aproveitamento da folha, respiro proporcional.
ABERTOS desta rodada: medidor do CODEX passa de 100% (404k numa janela de
258k — rodada própria); token `--err` sobre papel dá 4,08:1 em texto pequeno
(decisão de token global, não de um botão); validação visual do popover.

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

## RODADA 3 (mesma noite — 5 achados do dono, todos fechados)
1. Barra APROVAR/AJUSTAR fantasma: era a heurística `.gui-ask` (bag-of-words)
   disparando em "está aprovado" 148 chars antes de uma pergunta aberta — o
   ÚNICO disparo dela no corpus real de 123 mensagens era o falso positivo.
   Novo `guiAskForGo.ts` precisão-primeiro (marcador na frase que pergunta;
   particípio fora); as 4 hipóteses do briefing refutadas com evidência; bug
   latente do `\b` pós-"?" morto de carona.
2. ◈ = versão NA MAIN (última lançada; nenhuma → sem chip); linhas de versão
   contam o carimbo próprio (viva sem carimbo → corrente); `missoesFeitas` =
   união recibo∪concluída-carimbada. Raiz era o LEITOR (`find(!lancada)`).
3. Dashboard profissional: banda de topo, duas colunas (trabalho|contexto),
   conta·modelo, gaveta de diff sob demanda, planos do mapa com progresso,
   cronologia só createdAt/completedAt. Corte de grade em 996px por conta.
4. Versão DIGITÁVEL na lateral (guardas mantidas; recusa explica a saída) —
   e o parser que parava no 3º ponto deixava "1.2.0.4" ATRAVESSAR a guarda de
   lançada em silêncio: morto, com compareVersionNumbers N-segmentos.
5. Rail do planejamento nomeia o arquivar (a alavanca existia, a palavra não).
Gate raiz REAL_EXIT=0 pós-integração. Sobras no Desktop: Synkora-wt-limpa-mcp
e -pipeline (locks, inertes, deletar à mão).
