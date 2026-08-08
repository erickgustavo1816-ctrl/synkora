# HANDOFF — Synkora (2026-08-06 noite — O02d CONCLUÍDA; F6.8d–i aplicadas; Mapa de Retomada é o próximo entregável)

Estado real do projeto. Detalhes técnicos completos nas seções datadas do
CLAUDE.md (fonte da verdade — ler F6.8d até F6.8i antes de mexer: documentam
TUDO da sessão de 06/08).

## SESSÃO 06/08 (DIA INTEIRO) — M02c integrada, O02d concluída, motor soldado sob fogo

RESULTADO: DUAS missões atravessaram o pipeline hoje. M02c (design system)
INTEGRADA na V1.0 de manhã. O02d (casca de navegação) CONCLUÍDA às 19:03 com
verificação conjunta VERDE — dev → review → QA VISUAL GENUÍNO (runtime
próprio via runtime_control, passe de hover/focus/viewports/forced-colors com
evidência) → merge. **A O02d NÃO FOI INTEGRADA ainda** (decisão do usuário:
aplicar os fixes antes); o orquestrador perguntou via ask_user "integrar na
V1.0 e abrir a Onda 3?" — SEM RESPOSTA ainda. ~30 fixes de motor no dia
(F6.8d–i), todos com caso real anotado; typecheck + 112 asserções verdes no
fechamento.

### O que mudou de mais importante (detalhe no CLAUDE.md)

- CORRIDA DO POLLER (watch de fase morto em silêncio) → janela de graça +
  eventos phase-watch-released/repaired (F6.8d).
- QA DE VERDADE: runtime_control (o QA sobe o produto SOZINHO — capacidade
  antes de escalação), veredito "bloqueada" (ambiente ≠ reprovação, sem
  ciclo, nunca vai ao dev), mandato visual inegociável com evidência de
  navegação obrigatória, detector de URL imune a ANSI, --output-dir do
  playwright + .playwright-mcp/ no exclude universal, QUARENTENA de untracked
  (veredito sobrevive a lixo de gate) (F6.8e/g/h/i).
- RE-ENTREGA SANCIONADA: done do dev SEMPRE aceito quando nenhum gate está
  julgando; MEMOIZAÇÃO por head (gate aprovado não re-roda para o mesmo
  commit — e a reprovação agora PRESERVA evidência aprovada); prompt-delta
  para TODOS os papéis resumados (F6.8g/i).
- TETO DE CUSTO NO RESUME (150k FIXO, decisão do dono): conversa acima do
  teto nasce fresca sobre o trabalho preservado + HANDOFF.md obrigatório do
  dev a cada marco (validado 2× ao vivo, ~355k e ~154k economizados) (F6.8e).
- ask_user + pulso na aba (pergunta ao dono nunca mais invisível) + heurística
  do "?"; troca de executor ⇄ visível ao orquestrador; lane de QA obrigatória
  no plano; rodada de gate ATÔMICA; evidência nos bloqueios de verificação;
  botão ▶ testar (missão/versão) com ■ derrubar; guardian com pid adiado;
  ceifa BFS no kill de runtime (F6.8e/f/g/h).
- REGRAS PESSOAIS DO CLAUDE (3 acidentes meus no dia — ver memória
  feedback-nao-mexer-durante-teste-vivo): app vivo = monitor+caderno, ZERO
  edits (electron-vite relança main sozinho; preload/renderer recarregam e
  matam panes); NUNCA matar processo por diagnóstico próprio (matei o npm run
  dev VIVO do usuário achando que era órfão); o app roda SÓ no terminal do
  usuário; check obrigatório (processos+monitor) antes de qualquer edit;
  narrar marcos sem ser pedido (Monitor tool armado no journal legível —
  scratchpad/bbwatch.mjs, receita na F6.8g).

### PRÓXIMA SESSÃO — roteiro (ordem do usuário)

1. Rearmar monitor: `node scripts/bbwatch.mjs --follow` (agora versionado no
   repo) + Monitor tool com grep de marcos.
2. Usuário sobe o app; responder ao orquestrador da O02d (a pergunta do
   ask_user segue pendente): INTEGRAR a O02d na V1.0.
3. **MAPA DE RETOMADA (item 22 do caderno — ORDEM DO USUÁRIO, antes da Onda
   3)**: documento VISUAL do fluxo completo de missão × cada tipo de queda em
   cada estágio (PM planejando, orquestrador propondo, plano aguardando
   aprovação, dev trabalhando, dev→snapshot, review rodando, review em
   espera, QA rodando com runtime, finalize/merge, verificação, fila de
   integração, release) × (quit limpo, crash/kill, pane fechado na mão, pane
   morre sozinho, plano pausado). Cada célula RASTREADA NO CÓDIGO com
   veredito ✅/⚠️/🔴 e receita. Candidato conhecido a 🔴: perguntas do
   ask_user são memória volátil (somem no restart). "99% do erro aconteceu
   entre o plano e o QA terminar" — o mapa é o contrato de retomada.
4. Corrigir os 🔴 do mapa; SÓ ENTÃO Onda 3 (6 missões em paralelo — o
   primeiro teste multi-missão do fluxo novo).
5. Critério de PRONTO segue o de 05/08: duas missões consecutivas limpas
   (≤2 rodadas de gate por card, zero parada de motor) — a O02d teve paradas
   de motor (minhas e do app); a contagem reinicia na Onda 3.

## SESSÃO 05/08 (DIA INTEIRO) — o dia que o motor foi refeito sob teste real

CONTEXTO EMOCIONAL IMPORTANTE: o usuário passou ~7h preso num único card
(design system da M02c, 9 reprovações, QA nunca rodou), declarou "chega" duas
vezes e deu DUAS ordens que agora são LEI: (1) auditoria total por mim + 2
agentes Fable e aplicação integral das mudanças; (2) **"PRONTO" SÓ COM PROVA
E2E MINHA** — ele NÃO testa mais; antes de declarar qualquer coisa boa, EU rodo
o fluxo completo e apresento evidência (memória feedback-pronto-so-com-e2e).

RESULTADO DA SESSÃO (~24 itens de caderno + 15 mudanças da auditoria, TODOS
aplicados, typecheck+suítes verdes):

- CICLO DE GATE REFEITO: gates VIVOS (reprovação não fecha o pane; re-round na
  MESMA conversa com delta SHA-provado), lista fechada persistida no card
  (task.gateRound — pane novo herda em vez de re-legislar), placar obrigatório
  ("placar: resolvidos X/Y · parciais P · pendentes Z · novos W") + detector
  anti-loop informativo, rodada-vazia devolvida como anomalia de encanamento,
  breaker de crash-loop de gate (3 mortes/60s → cooldown 5min), motivo
  300→1500 chars, patch sugerido via report (harness grava o .diff
  git-invisível; dev aplica e ASSUME), task.feedback com dono único (gate
  escreve, nota operacional nunca clobbera).
- A RÉGUA TEM DONO ("bom e limpo, NUNCA perfeito" — palavras dele): gate vê o
  BRIEFING como teto; norma externa/meta-auditoria/execução-de-teste nunca
  reprovam; reviewer só recebe skills de CODE REVIEW (o menu qa com wcag/
  playwright alimentava a régua errada); o orquestrador é JUIZ COMANDADO
  (evento manda julgar antes de repassar; waiver em gateNotes) e o RE-BRIEFING
  passa pelo mesmo juízo (a régua do reviewer morto tinha sobrevivido entrando
  no briefing — item 24, aplicado por último).
- FUNÇÕES OFICIAIS NOVAS: panes de execução RENASCEM no boot (dev claude via
  resume); troca de conta ⇄ nos panes de fase (transplante mesmo-CLI;
  mesmo-seat preserva sessão); prompt-delta em respawn com resume (nunca mais
  re-briefing; lê task.feedback); notify_pane {taskId, role} (endereço estável
  + lápides no hub); bypass ⏩ ligado vale SEMPRE (supressão silenciosa por
  sensível morreu); CAS na aprovação de plano (re-proposta durante a leitura
  recusa o aprovar); ceifa de visuais no marco de rodada + tree-kill
  (taskkill+fotografia+ceifa) + JOB OBJECT kill-on-close via guardião
  PowerShell embutido (42/42 na sonda, crash do app derruba tudo); skill sync
  incremental DE VERDADE (<1ms repetido) e cópia inicial no worker; export de
  diagnóstico com período; mãozinha 🖐 removida.
- HARNESS E2E (ativo permanente): SYNKORA_E2E=1 → CDP 9222 + scripts/e2e/
  driver.mjs chama o window.synkora real. VALIDADO: DUAS missões completas de
  ponta a ponta no projeto-fixture ~/.synkora-e2e/p1 (12min e 11min, 1 rodada
  por gate) — a missão 2 expôs e matou a supressão de bypass.
- M02c (card DS): RETOMADA à noite com o motor novo — ciclo 8 mostrou placar
  correto (1/4 resolvido + 3 parciais + 0 novos), patch sugerido de 3,5KB e
  lista fechada. PENDENTE para amanhã: o usuário (ou o juiz) waivar os 2
  pontos de meta-auditoria herdados no briefing e fechar o ponto real (estado
  normal do Badge) — o card está a UMA rodada do fim. Cosmético anotado:
  hub-error benigno de worktree durante integração (corrida board×merge).
- PROJETO-FIXTURE "E2E BRL Utils" segue registrado na Home (remover o card
  quando o app estiver sob CDP; a pasta ~/.synkora-e2e fica para o harness).

COMO RETOMAR AMANHÃ: subir o app, abrir o PAINEL DE GESTÃO, mandar o
orquestrador da M02c aplicar o waiver dos pontos 2-3 do último veredito e
re-despachar o dev (o patch sugerido está em .synkora/reports/
d45230fd-review-fixes-r1.diff). Depois seguir o roadmap (O02d-casca em
diante). Caderno completo da sessão: scratchpad NOTAS_TESTE_2026-08-05.md
(24 itens); análises Fable em ANALISE_CICLO_QUALIDADE.md e
ANALISE_FLUXO_ORQUESTRACAO.md no mesmo scratchpad (nota: scratchpad é
por-sessão — o conteúdo durável está TODO no CLAUDE.md F6.8/b/c).

## SESSÃO 04/08 TARDE/NOITE — onda 2 refeita, M02b INTEGRADA, F6.7 completa

RESULTADO: a antiga M02 (design system + casca juntos) foi EXCLUÍDA pelo
usuário e o roadmap refeito com granularidade de equipe real (decisão dura:
missão = UMA entrega; título com "e" = duas missões). Ordem nova por sort
natural de ondas: O02b-persistencia (RODOU PRIMEIRO) → O02c-design-system →
O02d-casca → O03+. A M02b (SQLite→JSON determinístico + botão Sincronizar)
atravessou TUDO — card 1 direto, card 2 com 4 rodadas de review (binary
planting → máquina de estados → classificador → formatos HTTP) — e está
INTEGRADA na V1.0. ~20 fixes/decisões de motor ao vivo, TODOS documentados na
seção F6.7 do CLAUDE.md (fonte da verdade). Highlights:

- QUALIDADE "TIME DE VERDADE" (3 decisões do usuário): dev VIVO durante os
  gates SEM teto de ciclos ("reprovou dez vezes, paciência"); reprovação =
  UMA mensagem CURTA do orquestrador (só a lista de correções — o harness não
  fala mais com o dev; fallback direto se orquestrador morto); disputa
  dev×gate tem JUIZ (orquestrador decide, waiver vai em gateNotes).
- gateNotes {review,qa} no update_task → anexadas ao prompt do gate no spawn
  (o orquestrador usou nos DOIS cards da M02b sem ser mandado).
- REVIEW SEM TETO DE DIFF (modo local por SHA — nunca mais "divida a
  entrega"); QA de verdade (hover/viewport/estados por elemento, em card com
  UI); DETAIL PASS obrigatória em front/design; PM greenfield exige styleguide
  VIVO (modelo github.com/jbrunnoo/ds-hope-finances — referência do usuário).
- TRANSPLANTE DE SESSÃO ENTRE SEATS (2 sondas + validado ao vivo pelo
  usuário): conversa é arquivo local; ⇄ do PM migra automático (mesmo CLI) e
  missão ganhou botão "⇄ conta" (modal reseat). Limite estourado nunca mais
  prende missão nem contexto.
- VERIFICAÇÃO: bootstrap npm ci RELIGADO (era dead code — baseline da M02b
  nasceu VERDE); comando REDEFINIDO pela missão aceito em MODO LEVE (caso
  real: script test Electron→vitest travou conclude_plan em loop de
  escalação; o fix destravou e a missão integrou). PERSONAS ANTI-TAMPER: gate
  travado NUNCA se resolve editando produto (PM chegou a instruir reverter
  script "byte-idêntico" — proibido dos dois lados; escala ao USUÁRIO).
- effort do executor CARIMBADO no card (reabertura nunca cai no default);
  prompt >8KB por arquivo agora com BOM (PS 5.1 lia UTF-8 como ANSI e
  mojibake quebrava caminhos); shimmer codex não come mais letras no
  transcript (collapseRepaintFrame, bytes reais); LSP embutido serve worktree
  SEM node_modules (major declarado basta); codex resume em fase REVERTIDO
  (sonda isolada passou, app recaiu no mesmo dia — evidência do app vence).
- Sync de skills INCREMENTAL (marcador com sha; re-sync silencioso) — cortou
  ~600ms do spawn; stalls medidos e atribuídos.

### GIT FORA DO MAIN THREAD — FEITO (as travadas de executar/integrar)

As "travadas" eram o MAIN congelado por git SÍNCRONO (spawn 1-2s, transição
1,8-3,5s, MERGE ~4-5s). RESOLVIDO por WORKER de git: `gitWorker.ts` (entry
próprio no electron.vite.config — `out/main/gitWorker.js`) roda as funções
síncronas de worktree.ts/reviewDiff.ts intactas; `gitAsync.ts` expõe
`gitOff('fn', ...)` tipado + fallback síncrono se o worker não subir (nunca
pior que antes). Convertidas as cadeias: INTEGRAÇÃO (drain→completeMissionMerge),
FINALIZE de card (com CHECKPOINT SÍNCRONO SharedArrayBuffer/Atomics — o recibo
de integração persiste NO MEIO do merge, worker pausa/main grava/notifica,
merge-repair intacto), SPAWN (preparePhasePane async: worktree+fingerprint+
diff imutável+snapshotProblem; propagado a openGatePane/retryOrBacklog/
recoverFinalizingTask/tasks:run/runTask) e RELEASE. Validado: typecheck,
build com worker emitido, mission-worktree 24/24, merge-repair 17/17.
VALIDAR AO VIVO na próxima sessão: clicar executar/integrar deve ficar fluido;
os eventos slow-* agora medem tempo do WORKER (main livre).

### Outras pendências

- Sonda do codex resume reproduzindo o CAMINHO EXATO do app (PTY/PS/env) —
  a isolada não reproduz a falha; até lá, spawn fresco.
- Flake real de cleanup Windows nos testes do PRODUTO (EPERM em rmSync de
  fixtures git sob Electron-as-node) — os agentes acharam; vira melhoria
  legítima em missão futura do painel (rmSync maxRetries + chdir fora).
- Painel "validação humana de segurança" do card: textos atualizados nesta
  sessão (actor security-gate reconhecido); revisar visibilidade fina depois.
- terraform-skill/agentic-actions-auditor 'block' no supply-chain (falso
  positivo aceito; whitelist se fizerem falta).

### PRÓXIMA SESSÃO — roteiro

1. Subir o app (build novo com o git worker) e VALIDAR a fluidez de
  executar/integrar de passagem.
2. Teste ao vivo: abrir a O02c-design-system — é o TESTE DE FOGO das
  personas de qualidade de front (styleguide vivo navegável no padrão
  ds-hope-finances + DETAIL PASS + QA de verdade em card COM UI, que a M02b
  não exercitou por ser backend).
3. Depois O02d-casca → O03 (cadastros, 6 missões em paralelo — primeiro
  teste de onda multi-missão do fluxo novo).
4. MONITOR (rearmar): tail -n 0 -f do journal do dia em
  %APPDATA%/synkora/blackbox/ com grep -vE '"cat":"msg"|"event":"tool-codeQuery".*\\"ok\\":true'.
5. Memórias novas da sessão: feedback-missao-uma-entrega,
  feedback-apps-profissionais, feedback-qa-de-verdade,
  feedback-briefing-completo-no-spawn (ler antes de mexer em retry/gates).

## SESSÃO 04/08 — TESTE GREENFIELD DE PONTA A PONTA (a M01 atravessou TUDO)

O teste combinado aconteceu: projeto REAL "PAINEL DE GESTÃO — ERICK"
(PER/DCOMP, prompt de docs/PROMPT_MAESTRO_PERDCOMP.md colado inteiro).
RESULTADO: descoberta 5 etapas → plano mestre APROVADO (15 missões, 10 ondas)
→ M01-fundacao (Electron+React+TS+SQLite, dev codex gpt-5.6-sol) → review
codex → QA claude (com Playwright) → merge na branch da missão → verificação
conjunta VERDE (typecheck+test+lint reais) → conclude_plan → INTEGRADA na
V1.0. Roadmap marca M01 done; **Onda 2 (M02-design-system) PRONTA para
abrir**. Cada travamento do caminho virou fix de motor NA HORA (17 ao todo),
monitorado pela caixa-preta com intervenção ao vivo — dinâmica das sessões
02-03/08.

### Fixes de motor embarcados nesta sessão (todos com caso real e sonda)

1. DRAG & DROP DE ARQUIVOS nos panes (pedido do usuário para entregar os PDFs
   de exemplo): soltar arquivo em qualquer TerminalPane copia para
   `<projeto>/.synkora/attachments/` (IPC `attachments:import`, dedupe por
   nome+tamanho) e cola os caminhos no composer via bracketed paste (nada é
   enviado sozinho). `window.synkora.pathForFile` no preload (Electron 43:
   File.path morreu — webUtils.getPathForFile). Guard global de dragover/drop
   no main.tsx (sem ele o Chromium NAVEGA para file:// e mata o renderer).
   Anel accent no pane alvo (.terminal-host.drop-target).
2. REGRA DE TRABALHO NOVA (bronca real do usuário — memória
   feedback-nao-mexer-durante-teste-vivo): edição de main/preload/renderer
   derruba turno de pane vivo (reload do electron-vite respawna tudo). Com
   teste rodando: ANOTAR a melhoria, esperar os panes aquietarem, editar em
   BLOCO ÚNICO + typecheck + UM restart combinado.
3. MODAL DE ORQUESTRADOR NO GREENFIELD (bug confirmado pelo usuário):
   `start_project_mission` agora cria a missão com `pendingOrchestrator:
   true` — o pane só nasce após o usuário escolher conta/modelo/effort no
   NewMissionModal (mesma regra do create_mission de 02/08; antes herdava o
   seat do PM em silêncio e sem modal).
4. SWITCH "SENSÍVEL OK" POR PROJETO (`maestroStore.sensitiveAutoOk`; IPC
   `harness:setSensitiveBypass`; segundo perm-switch no board, visível com
   bypass ligado): o classificador de risco marcava o projeto INTEIRO como
   superfície sensível (domínio fiscal → `personal_data` em todo goal) e
   suprimia o bypass de todo pane escritor. Com o switch, o toggle de bypass
   volta a mandar; cada pane nasce auditado (`sensitive-bypass-override` na
   caixa-preta). Padrão sem o switch continua protegido.
5. ABA "MAPA" (pedido do usuário: o plano mestre era invisível):
   `PlanMapView.tsx` + IPC `projectPlan:get` — ondas em ordem, missões com
   estado (✔ concluída / ▶ em execução / ● pronta / ○ futura / ⏸ adiada),
   progresso, onda atual destacada, versão por onda, refetch em
   missions:changed. Só aparece em projeto greenfield.
6. PRÉ-VOO DO create_plan (veredito do usuário: "ele deveria ter analisado
   tudo isso na primeira vez" — o plano da M01 custou 3 aprovações para zero
   trabalho novo): a avaliação de risco da proposta varre TAMBÉM o plano do
   PROJETO (problem/vision/criteria/scope) e o item do roadmap da missão —
   superfícies nascem declaradas; retorno do create_plan avisa na hora que
   FAST não comporta card pesada; persona ganhou "PRE-FLIGHT BEFORE EVERY
   create_plan".
7. TRUST DO CODEX COM ACENTO (dev preso no diálogo MESMO com bypass;
   evidência: o aceite do usuário fez o codex gravar
   `[projects.'…gestÃo…']` ao lado do nosso `…gestão…`): o codex normaliza
   path com lowercase SÓ ASCII. `ensureCodexTrust` grava as DUAS formas com
   checagem EXATA por forma (case-insensitive não as distingue).
8. WATCHDOG DE EVENT-LOOP (duas "travadas sinistras" sem rastro): main e
   renderer medem o próprio loop; stall >1s vira `event-loop-stall`/
   `renderer-stall` na caixa-preta com duração+contexto. JÁ MEDIU: spawn de
   pane trava o main 1-2s; merge/integração ~5s — balde de otimização com
   dados. (As travadas do usuário eram o smoke test do dev subindo um
   SEGUNDO electron + vite na 5173/5174 — contenção transitória.)
9. LSP PARA TS<7 (scaffold declara typescript 6.0.3; nenhum projeto tem
   typescript-language-server local; o tsgo embutido só era emprestado com
   major idêntico → SERVER_UNAVAILABLE estrutural, dev caiu em busca textual
   e martelou ~30 chamadas no serviço morto): fallback para o tsgo EMBUTIDO
   em servers.ts (é o port Go do mesmo compilador; version anota o
   fallback). Validado em produção: diagnostics/symbols/refs ok:true ~25ms.
   Obs: 1ª consulta logo após boot pode dar SERVER_UNAVAILABLE transiente
   (warm-up) — resolve sozinho na repetição.
10. DIFF DO REVIEWER SEM LOCKFILES (fundação: 9.195 linhas, 7.684 = 83% era
    package-lock.json; 119,9KB truncado → harness devolvia o card com
    "divida a entrega", conselho impossível): `GENERATED_LOCKFILES` em
    reviewDiff.ts — lockfiles fora do patch E do orçamento, LISTADOS no
    resumo ("+7684/-0 — confira presença, não conteúdo"). Validado: 53,8KB
    sem truncar, review fluiu.
11. CODEX RESUME NASCE SEM MCP (dois respawns por `codex resume` seguidos
    sem NENHUM pane-connected; servidor saudável com 401; rollout não
    persiste config MCP; turn_context provou que os -c de permissão
    aplicaram): até sonda de binário dizer o contrário, fase codex
    interrompida respawna FRESCA (sem resume) com o prompt de recovery —
    spawn fresco conecta em <1s, comprovado. Claude segue com --resume.
12. PROMPT GRANDE POR ARQUIVO (o prompt do reviewer carrega o diff imutável;
    via $env o PS re-expande na linha do filho e o teto de 32.767 estourava
    — reviewer NUNCA abria, guarda acusando ~64k): initialPrompt >8KB vai
    para `<cwd>/.synkora/prompt-<paneId>.md` e o argv leva um ponteiro
    curto. Mesma lição da persona por arquivo (02/08). Nunca apagado no
    exit.
13. QUOTE() PRÉ-ESCAPA ASPAS SEMPRE (reviewer passou a spawnar e MORRIA no
    boot: "Error loading config.toml: invalid type: string
    \"[report,code_diagnosti…\"" — o -c enabled_tools=["…"] do gate perdia
    as aspas internas em token SEM espaço; sonda red/green por
    -EncodedCommand em codex real reproduziu e provou o fix): pré-escape de
    `"` embutida agora vale para qualquer token, não só com espaço. Valores
    simples key="x" só sobreviviam por sorte (o -c trata TOML inválido como
    string crua).
14. GUARD DE CONCLUSÃO SEM MCP + ALLOWLIST DOS GATES: pane que nunca
    autenticou no MCP não fica mais preso no beco "rode code_diagnostics"
    (degrada para fotografia+gates locais com evento
    `report-guard-degraded-no-mcp`); allowlist read-only dos gates claude
    ganhou `board_status` e `list_skills` (QA parava num prompt de
    permissão para board_status).
15. EAGAIN ASSÍNCRONO TOLERADO: conclusão async de write no pipe do ConPTY
    (WriteWrap.onWriteComplete) escapava do safeWrite e virava uncaught —
    agora EAGAIN/EPIPE/ECONNRESET com stack de stream viram evento
    `pty-write-async-error` e o app segue.
16. SKILLS EM TODO PANE — a REGRA DURA do usuário ("todo mundo, TODO MUNDO
    tem acesso às skills da sua função") estava MUDA: biblioteca com 383
    instaladas e worktree/prompt/menu VAZIOS em dev, review e QA da M01.
    CAUSA TRIPLA no gate de supply-chain: (a) a licença MIT contém
    "publish/distribute" e disparava sensitive-external-effect — TODA skill
    curada caía em 'review'; (b) elegibilidade exigia 'allow' ESTRITO;
    (c) 382 legadas sem assessment eram invisíveis para sempre. FIXES:
    licença fora das regras de conteúdo (segue no fingerprint);
    elegível = decisão !== 'block' (só crítico real exclui: exfiltração,
    download-e-executa); backfill em lotes no boot (383/383 em ~40s:
    252 allow · 129 review · 2 block) com `skills-backfill-done`; menu
    vazio com biblioteca cheia = evento `skills-sync-empty`. VALIDADO: o QA
    seguinte nasceu com o menu COMPLETO da função qa no prompt.
17. VERIFICAÇÃO CONJUNTA CONSERTADA EM DOBRO: (a) worktree recém-criado sem
    node_modules → `ensureVerificationBootstrap` roda `npm ci` uma vez
    (manifesto+lockfile presentes; falha vira evento, nunca silêncio);
    (b) O ASSASSINO REAL: sanitizedVerificationEnvironment apontava
    npm_config_userconfig E globalconfig para o MESMO `NUL` — o npm ABORTA
    no boot ("double-loading config …/NUL as global, previously loaded as
    user"), os três comandos morriam em ~120ms e a verificação reprovava um
    produto comprovadamente verde. Agora: dois arquivos VAZIOS e DISTINTOS
    no tmp (fallback: remove a variável). Validado: typecheck/test/lint
    rodaram DE VERDADE e passaram.

### MODO LEVE (decisão do usuário: "muita barra de segurança, não estamos
### conseguindo avançar")

O switch "sensível ok" virou o interruptor do MODO LEVE do projeto inteiro:
- Validação humana de segurança por plano NÃO NASCE (planos antigos com
  'pending' também destravam via manualSecurityValidationPending com
  securityWaiverOptions).
- Superfície nova em cards E em ajustes (run_task adjustment) é AUTO-ANOTADA
  no plano aprovado (`plan-surfaces-auto-annotated`) — nunca recusa nem
  rodada extra de aprovação.
- securityReview estruturado do reviewer é dispensado.
- Verificação conjunta reprovada NUNCA desfaz card aprovado nos gates — vira
  evento urgente ao orquestrador ("modo leve: nenhum card foi desfeito").
- FICA SEMPRE (com ou sem switch): fingerprint dos gates, review+QA, cerca
  .synkora, supply-chain nível 'block', guardas de argv.
Modo ESTRITO (switch desligado) preserva todo o comportamento anterior — e a
dispensa manual em plano sensível passou a ser aceita SÓ com o switch
(resolveManualSecurityValidation com options.sensitiveWaiverAllowed).

### GATE ESPECIALISTA DE SEGURANÇA (task #11 — decisão do usuário: "não sou
### especialista, ou retira ou um especialista olha o código")

Em modo ESTRITO, plano sensível não pede mais validação ao humano: o gate de
REVIEW soma o arsenal da função CYBER ao menu (gateSkillsFor
{includeCyber}) e o securityReview APROVADO sobre fotografia imutável
preenche `manualSecurityValidation` sozinho com actor `security-gate`
(evento `security-gate-validated`). ManualSecurityValidationActor agora é
'user' | 'security-gate'. O humano decide produto e integração, nunca
segurança.

### Suítes atualizadas nesta sessão

- test-manual-security-validation: regex das chamadas com
  securityWaiverOptions; contrato de dispensa com switch.
- test-mission-verification: npmrc user/global DISTINTOS e vazios.
- test-review-diff, test-pane-permissions, test-code-intelligence,
  test-skill-package-security: verdes com os contratos novos.

### Pendências abertas (tasks da sessão + observações)

1. (task #12) Scaffold greenfield deve nascer com lint ignorando `.claude/`
   `.agents/` `.synkora/` (o orquestrador remediou no produto — 176 erros de
   lint eram as pastas injetadas pelo Synkora; virar regra de
   persona/devContract ou validação do motor).
2. Sonda de binário do `codex resume` × cliente MCP (o fix atual evita o
   resume em fase codex; se o upstream consertar, reavaliar).
3. Otimizar os stalls MEDIDOS do main (spawn 1-2s; merge/integração ~5s —
   git síncrono no main thread).
4. LSP: warm-up pós-boot dá SERVER_UNAVAILABLE transiente na 1ª consulta.
5. Terraform-skill e agentic-actions-auditor ficaram 'block' no supply-chain
   (fixtures de payload em skill de segurança — falso positivo aceitável;
   whitelist futura se fizerem falta).
6. Painel "validação humana de segurança" do card de plano: com modo leve +
   gate especialista, revisar textos/visibilidade (hoje ainda oferece
   confirmar/dispensar manual).
7. Transcript tails ainda comem letras em repinturas pesadas do codex
   ("m  pass u") — o cleanPtyChunk da F6.5 não cobre todas as classes.

### PRÓXIMA SESSÃO — continuar o teste: ONDA 2

- Estado do projeto de teste: M01 done+INTEGRADA na V1.0 (master intocada,
  correto); roadmap com onda atual O02-design e M02-design-system PRONTA.
- Roteiro: usuário autoriza a onda 2 ao PM → start_project_mission M02 →
  DESTA VEZ o modal de orquestrador deve aparecer (validar o fix #3) → plano
  → dev/review/QA com MENU DE SKILLS visível (validar #16 de novo) → modo
  leve fluindo SEM nenhuma parada de segurança → integração.
- Validar de passagem: aba Mapa refletindo M01 ✔ e M02 ▶; drag & drop dos
  PDFs quando o Maestro pedir os exemplos (M07/M08).
- MONITOR (rearmar): tool Monitor com
  `tail -n 0 -f "/c/Users/Erick/AppData/Roaming/synkora/blackbox/journal-<AAAAMMDD>.jsonl" | grep --line-buffered -vE '"cat":"msg"'`
  (persistent; data do dia). App estava rodando ao fim da sessão (boot
  470db1e2, `npm run dev` em background).

## SESSÃO 03/08 — LSP de cabo a rabo + entrega por destino no MCP (pré-greenfield)

Pedido do usuário antes do greenfield: provar o LSP, medir economia REAL de
tokens e acabar com "o pane já sabia o resultado e o input digitou tudo de
novo". Relatório completo com números: `docs/benchmarks/2026-08-03/REPORT.md`
(+ `ab-tokens.json` e `lsp-bench-posfix.json`).

- LSP FUNCIONA e ficou melhor: aceitação 10/10, p95 quente ≤ 4,4 ms, pool/
  isolamento/lifecycle ok. BUG REAL corrigido: tsgo 7.0.2 só achava
  referências dentro do fecho de imports dos arquivos abertos (refs
  cross-file da classe Hub = 1 item; a aceitação antiga era de arquivo único
  e nunca viu). Fix `primeDependents` no manager (scan de imports →
  pull-diagnostics nos dependentes, cache por processo, TTL 30 s) + teste de
  aceitação multi-arquivo novo. NUNCA remover o priming sem re-sondar o tsgo.
- ECONOMIA DE TOKENS MEDIDA com claude -p real (opus+sonnet, 16 runs, tudo
  correto): média ~NEUTRA neste repo (meta 15–40% do plano NÃO confirmada
  como média); ganho real em símbolo ambíguo/alto fan-out no opus (−13%
  custo, −26% contexto) e 5,6× menos bytes por consulta (4,6 KB vs 25,6 KB
  nas 145 refs de Hub.publish). Valor principal comprovado: CORREÇÃO (sem o
  fix, referências cross-file respondiam errado).
- MCP dual-era OK: 5/5 + 32 clientes; codex 0.146 com mcp_2026_07_28 under
  development/false → auto fica legado (correto); claude 2.1.220 legado.
- FIM DO RESULTADO RE-DIGITADO (evidência no diário de HOJE, boot 4496ed13
  14:46: livre leu helper_output pré-report, mandou "finalize", e a injeção
  digitou o payload inteiro de novo): aviso de conclusão agora tem MODO POR
  DESTINO (full/short/skip — helperCompletion.ts), maestro/orquestrador
  também consome a própria entrega via helper_output pós-report, e o Hub
  ganhou guarda `stillNeeded` reavaliada no instante da injeção (consumo
  tardio → `discarded` na caixa-preta, nunca digitação). O SINAL de conclusão
  sempre chega; o que morre é o payload repetido. test:helper-completion
  14/14 (5 novos). EVENTS.md/UI seguem com o evento completo.
- Suítes re-validadas: typecheck, code-intelligence, mcp-protocol,
  mcp-dual-era, helper-recovery, orchestrator-flow, helper-completion.
- RODADA DE MELHORIAS PÓS-TESTE (mesma sessão, pedida pelo usuário):
  1. TRANSCRIPT SEM LETRAS COMIDAS: o limpador do tee (cleanPtyChunk)
     APAGAVA sequências de cursor — palavras fundiam
     ("transcriptpreservapalavras…") e leituras reais vinham corrompidas
     ("helper_outpt" no diário). Sondado em TUI claude REAL
     (probe-tee-garble.mjs, zero tokens: parágrafo digitado no composer sem
     Enter): agora CUF/CHA viram separador, CUP rastreia a linha (mesma
     linha = espaço, nova = quebra), CSI kitty (\e[>1u) e ESC ( B / ESC 7/8
     não vazam mais como lixo. Beneficia helper_output, pane:lastlines,
     ultimaLinha do list_helpers, tails da caixa-preta e a detecção de
     ATTENTION/LOGIN (frases fundidas não casavam o regex). Suíte NOVA:
     `test:pty-transcript` (9 casos, cada um uma classe provada na sonda).
     Codex deve melhorar igual (classes universais), mas sonda codex
     específica fica como follow-up.
  2. PM SEM TURNOS DE ROTINA DO AGENTE LIVRE: delegate/conclusão de
     ajudante de pane LIVRE viraram quiet (EVENTS.md/UI registram; o PM não
     ganha um turno de modelo por isso — 14 injeções à toa só hoje).
     Precedente: PM silencioso/pane-close quiet (F5.7j). O DELEGADOR segue
     avisado normalmente; register_direct_mission segue não-quiet.
- OVERLAYS ARRUMADOS a pedido do usuário (detalhe técnico no CLAUDE.md
  F6.5): mini do microfone e ANDAMENTO sem a borda escura (janelas
  transparentes; a borda era o fundo da janela vazando + moldura nativa),
  mic com TAMANHO FIXO 255×72 sem resize e sem glifo, ANDAMENTO
  redimensionável por alça própria (IPC progress:overlay-resize), e
  POSIÇÃO/TAMANHO agora sobrevivem ao restart do app (fix do DPI misto
  125%/100% via setBounds pós-criação + clamp só quando fora de tela +
  load nunca regrava o store). App reiniciado com tudo embarcado.
- A limpeza pós-teste foi feita: o MCP standalone do A/B, snapshot e sondas
  viviam FORA do repo (scratchpad de sessão) e foram apagados; zero
  referências no código. Ficaram: fixes de produto + suítes de regressão +
  docs/benchmarks/2026-08-03/ (evidência).
- RODADA NOTURNA (03/08 ~21h, diagnóstico via zip do usuário — 3 bugs):
  1. AVISO FALSO "ajudante X não conseguiu abrir (pane fechado antes de
     iniciar)" chegava ~1s DEPOIS da conclusão entregue, em TODO helper
     (pré-existente; visível no diário desde 13:35): o pty:kill TARDIO do
     renderer (após o main matar o PTY no pós-report) caía no detector de
     "nunca abriu" (`!ptys.has && livePaneSpecs.has`). Fix: marcador
     `paneEverSpawned` (pane cujo PTY existiu nunca vira rollback; kill
     tardio vira limpeza silenciosa de registro).
  2. MOJIBAKE NO FONTE: 16 strings com encoding corrompido ("nÃ£o", "â€”")
     em index.ts/SynVoice.tsx/preload/store — inclusive a própria mensagem
     do aviso falso (o "nÃ£o" que o usuário viu no terminal vinha DO CÓDIGO).
     Varridas e corrigidas; grep de controle zerado.
  3. MIC DESTACADO NÃO INSERIA NOS PANES DO SYNKORA: destacado ⇒ toda
     ativação vira modo external ⇒ o renderer descartava o destino em-app E
     a captura externa devolve token nulo quando o foco é o PRÓPRIO Synkora
     (capture() recusa o próprio pid) ⇒ transcrição caía no clipboard. Fix
     no SynVoice.tsx: o destino em-app é SEMPRE capturado; token externo
     nulo = entrega em-app (term.paste no pane focado). Token válido segue
     tendo prioridade (ditado para outro app não muda).
  App reiniciado com os três fixes; typecheck + helper-completion verdes.

## PRÓXIMA SESSÃO — 04/08: TESTE COMPLETO GREENFIELD (combinado com o usuário)

O usuário vai dar /clear e fazer o teste de ponta a ponta: criar um PROJETO DO
ZERO no app e seguir o fluxo greenfield inteiro (PROJECT_PLAN schema 2 → ondas
→ missões → releases), CONSERTANDO os bugs que aparecerem pelo caminho — mesma
dinâmica de 02/08: monitor da caixa-preta armado, narração de observador,
intervenção quando quebrar.

- O PROJETO REAL escolhido: app desktop de CONTROLE DE PER/DCOMP (domínio
  fiscal do usuário — conferência primárias × SPED por período E valores,
  importação de PDFs com extração local, empresas/créditos/standby/tarefas/
  notas). O prompt do Maestro está PRONTO e fechado com o usuário em
  `docs/PROMPT_MAESTRO_PERDCOMP.md` — criar o projeto do zero e colar
  inteiro. NÃO reescrever o prompt; ele foi lapidado em 6 rodadas.
- LIÇÃO DE CASA do usuário (combinada): ter à mão PDFs DE EXEMPLO reais
  (primária PIS, primária COFINS, recibo SPED) — o Maestro deve pedi-los
  antes de construir o extrator; formato de documento NUNCA se inventa.
- RITUAL DE ABERTURA (combinado com o usuário 03/08 à noite): ARMAR O
  MONITOR da caixa-preta ANTES de o usuário colar o prompt no Maestro —
  ele quer acompanhamento ao vivo do fluxo greenfield novo (que nunca foi
  testado) com intervenção imediata em bug, como nas sessões de 02-03/08.

- MONITOR: tool Monitor com
  `tail -n 0 -f "/c/Users/Erick/AppData/Roaming/synkora/blackbox/journal-<AAAAMMDD>.jsonl" | grep --line-buffered -vE '"cat":"msg"'`
  (persistent; a data do arquivo é a DO DIA). Os eventos `cat:"msg"` ficam de
  fora do monitor mas existem no arquivo — bloqueio de release/hub chegam por
  lá quando precisar auditar.
- ESTADO: todos os fixes de 02/08 embarcados e validados (suítes verdes:
  mission-worktree 24, merge-repair 17, blackbox 18, dual-era com PM de 33
  tools, pane-permissions 8). Ver as duas seções de 02/08 abaixo para o
  detalhe: persona por arquivo (argv), cap de respawn, exit com
  exitCode+tail, modal do orquestrador em missão do PM, summarizeResult do
  Proxy, guards falantes, cerca .synkora (report + precheck de integração),
  neutralização de junctions na limpeza de worktree, hold de release do PM
  (set_release_hold) e verificação conjunta com journaling `verify` +
  mensagem honesta quando passa por PARIDADE.
- ARMADILHAS QUE PODEM MORDER NO GREENFIELD (decidir quando aparecerem):
  1. Worktree de missão NÃO tem node_modules — a verificação conjunta cai em
     paridade de ambiente quebrado (agora avisa explicitamente). Decisão
     pendente: bootstrap `npm ci` por worktree (custo × evidência real).
  2. run_task {phase: review/qa} ainda passa pelos guards de missão-limpa
     (pendência leve de 02/08 manhã).
  3. `test:mcp-dual-era` reescreve docs/benchmarks/.../phase4-mcp.json (ruído
     de git).
  4. Invocação de SKILL não aparece no diário (é interna ao CLI) — auditar
     via JSONL dos seats quando precisar (grep '"name":"Skill"').
  5. Worktree pré-.gitattributes com CRLF fantasma — receita no CONTEXT.md
     do projeto CALCULADORA.
- O projeto de teste CALCULADORA - Copia fica como está (V1.0 publicada na
  master; missões arquivadas podem ser excluídas normalmente).

## SESSÃO 02/08 TARDE — loop de respawn do orquestrador RESOLVIDO + modal do PM

- CASO REAL: missão "Link bonito no WhatsApp" (7e1a1295, goal de 4,5KB criado
  pelo PM) entrou em LOOP infinito de spawn→morte(280ms)→respawn (33 ciclos até
  o usuário arquivar). CAUSA PROVADA (`scripts/probe-argv-limit.mjs`): o PS
  expande `$env:SYNKORA_SYSPROMPT` DE VOLTA na linha de comando do filho — o
  teto de 32.767 chars do CreateProcess (erro 206) é re-atingido uma camada
  abaixo do fix antigo do -EncodedCommand. missionPersona ~27KB + goal rico
  estourava; "Tela admin" passava raspando. FIXES: (1) persona claude vai por
  ARQUIVO — `--append-system-prompt-file` (flag real do 2.1.220), arquivo por
  pane em `userData/prompts/`; (2) guarda explícita dos DOIS tetos no pty.ts —
  estouro agora é erro legível no pane, nunca morte muda (codex segue inline e
  cai na guarda: pendência = canal por arquivo para codex, ver profiles -p);
  (3) Board só ressuscita orquestrador morto 3× em 30s → para e mostra
  "tentar de novo" (o respawn sem teto era o amplificador); (4) evento
  pane/exit da caixa-preta agora carrega exitCode + últimas linhas (a
  investigação ficou cega sem isso).
- FEATURE NOVA (pedido do usuário): missão criada pelo PM (`create_mission`)
  NÃO nasce mais com orquestrador herdado em silêncio — `pendingOrchestrator`
  na Mission; o Board abre o MESMO NewMissionModal em modo confirmação
  (título/goal/versão read-only; só conta/modelo/effort editáveis) e o pane só
  nasce após `missions:confirmOrchestrator`. "depois" fecha; o placeholder da
  aba da missão reabre o modal.
- SEGUNDO BUG ACHADO NA MESMA VALIDAÇÃO (missão recriada e0e8eabb): o
  report(done) do dev claude do card non_code morria 5x com "Cannot read
  properties of undefined (reading 'length')" SEM rastro no diário. Causa: o
  `summarizeResult` do Proxy da caixa-preta fazia `JSON.stringify(value).length`
  — e `JSON.stringify(undefined)` devolve undefined SEM lançar; codeReportGuard
  retorna undefined justamente no SUCESSO, então o instrumentador derrubava a
  própria tool no caminho feliz (recusas, que são strings, registravam
  normal). Fix: `?? String(value)` + recordCall embrulhado em try/catch
  (observador nunca derruba a chamada — regra dos hooks do TaskStore).
  Provado por eliminação com `scripts/probe-report-length-crash.mjs` (servidor
  real + api stub sem proxy = 5 formas de report passam). Validado:
  typecheck + test:blackbox + test:mcp-dual-era verdes.
- TERCEIRO ACHADO (pós-release): um dev commitou `.synkora/DESIGN.md` na
  branch da missão, os merges levaram à versão e o release levou à MASTER —
  e aí `ensureSynkoraGitExcludes` (que lança com .synkora versionado) passou
  a bloquear MUDO tanto o `missions:remove` ("não consigo excluir") quanto o
  `missions:paneSpec` (nenhum orquestrador novo abriria). Destravado com
  `git rm --cached .synkora/DESIGN.md` na master (b7ada2c; arquivo segue no
  disco); os dois guards agora publicam erro legível no hub. PENDÊNCIAS
  ABERTAS desta validação: (1) a cerca de entrega não impede agente de
  commitar `.synkora/**` (o info/exclude não segura `git add` explícito) —
  barrar no snapshot/merge; (2) alegação de teste não-verificável: dev disse
  "testes passaram" mas worktree de missão não tem node_modules e a
  verificação proporcional (cat `verify`) não disparou para nenhum card da
  missão — exigir evidência real de execução; (3) não há trava de release
  durante verificação em andamento do PM (o usuário subiu a V1.0 no meio da
  investigação e a branch da versão foi limpa debaixo do PM);
  (4) INCIDENTE REAL DE JUNCTION: o PM criou junction de node_modules para
  dentro do worktree da versão; a limpeza pós-release apagou o worktree e a
  exclusão ATRAVESSOU a junction, esvaziando o node_modules REAL da pasta
  base (consertado com npm ci; regra "nunca linkar, npm ci no worktree" no
  CONTEXT.md) — endurecer a limpeza de worktree contra reparse points é a
  cerca de motor que falta; (5) worktree criado ANTES do .gitattributes fica
  com CRLF no disco e o git status não acusa (stat cache) — teste de
  paridade falha "do nada"; receita no CONTEXT.md do projeto.
  DESFECHO DA INVESTIGAÇÃO DO PM: os "testes falhando" eram os artefatos
  (4)/(5) — master pós-release com 312 testes verdes; V1.0 PUBLICADA.
- VALIDAÇÃO AO VIVO 02/08 TARDE (missão e0e8eabb "Link bonito no WhatsApp"):
  modal do orquestrador OK; spawn com persona 32KB por arquivo OK; card FRONT
  completou o pipeline INTEIRO (dev codex → review reprova por voz da marca →
  retry cirúrgico → review aprova → QA claude aprova em browser → merge na
  branch da missão). Card DESIGN destravou com o fix acima.
- Crash do app às 17:17Z registrado (renderer -1 + dirty-exit) — minidumps no
  Crashpad; não investigado nesta sessão (não se repetiu).

## PRÓXIMA SESSÃO — estado vivo em 02/08 (pós-validação, escrito antes do /clear)

O plano de estabilização foi executado E validado ao vivo de ponta a ponta com o
usuário (relatório por cenário em `docs/MATRIZ_FALHAS_2026-08-02.md`). Contexto
que NÃO está em doc nenhum:

- APP RODANDO com todos os fixes EXCETO um ajuste de texto do guard de entrega
  vazia (index.ts, feito depois do último restart) — o próximo restart do
  `npm run dev` o embarca. Nenhuma outra mudança pendente de deploy.
- PROJETO DE TESTE `CALCULADORA - Copia`: missão "Tela admin" INTEGRADA na
  branch `version/9e36f098-…` (V1.0, aberta, acumulando); `master` intocada em
  e80ba1e — release (`⇪ subir versão`) é decisão futura do usuário. O usuário
  pediu ao PM uma missão nova: "index.html no celular" (aplicar a régua
  .synkora/DESIGN.md à tela da cliente). O combinado: acompanhar o FLUXO
  COMPLETO dela (plano → aprovação → dev → review → QA → integração na V1.0)
  narrando pela caixa-preta, como observador — o fluxo roda sozinho; só
  intervir se algo quebrar.
- COMO MONITORAR (o monitor morre com a sessão — rearmar): tool Monitor com
  `tail -n 0 -f "/c/Users/Erick/AppData/Roaming/synkora/blackbox/journal-<AAAAMMDD>.jsonl" | grep --line-buffered -vE '"cat":"msg"'`
  (persistent). O resumo legível é `journal.md` na mesma pasta. Cada evento tem
  ts/seq/boot + ids; as chamadas de tool trazem `detail.result` (o retorno) —
  recusas de tool aparecem ali, nunca precisam ser caçadas.
- PENDÊNCIAS LEVES anotadas na validação (nenhuma bloqueia):
  1. run_task com `phase: "review"/"qa"` (REABRIR gate) ainda passa pelos
     guards de missão-limpa/executionHead — desnecessário para gate (o merge
     revalida o destino); o orquestrador contorna sozinho, mas custa uma
     rodada. Relaxar com cuidado (retorno antecipado antes dos guards de
     missão, preservando as validações de fase).
  2. A pasta PRINCIPAL do projeto ficou em detached HEAD após as operações de
     merge da fila (o PM detectou e religou ao master sozinho) — investigar
     qual operação do worker deixa a base detached.
  3. `test:mcp-dual-era` reescreve `docs/benchmarks/2026-07-31/phase4-mcp.json`
     a cada run (ruído de git).
- EVIDÊNCIA/HISTÓRICO: caso de 01/08 preservado em `.tmp/evidence-20260802/`;
  sondas em `scripts/probe-*.mjs` (+ resultados `.tmp/probe-*.json`); o
  diagnóstico exportado pelo usuário está em
  `C:\Users\Erick\Desktop\synkora-diagnostico-2026-08-02-17-04.zip`.
- REGRAS NOVAS DO USUÁRIO firmadas nesta sessão: caixa-preta SEM EXCEÇÕES
  (toda tool + retorno no diário); QA sempre com Chrome PRÓPRIO (Playwright
  isolado, nunca Claude-in-Chrome); pausa de plano para reclassificação é
  AUTOMÁTICA quando nenhum card roda (aprovação continua humana).

## F6.4 (2026-08-02) — plano de estabilização executado

O plano `docs/PLANO_ESTABILIZACAO_2026-08-02.md` foi executado. A evidência do
caso de referência (revisor Codex sem ferramentas, diff vazio, card aprovado
devolvido ao dev) está preservada em `.tmp/evidence-20260802/` e cada causa foi
CONFIRMADA por sonda em binário real antes de qualquer correção
(`scripts/probe-*.mjs`; matriz completa em `docs/MATRIZ_FALHAS_2026-08-02.md`).

1. CAIXA-PRETA CENTRAL (`src/main/blackbox.ts`): diário único JSONL
   append-only em `userData/blackbox/journal-<dia>.jsonl` + resumo legível
   `journal.md`, com ts/seq/boot e ids de correlação (projeto, missão, card,
   fase, pane, papel, seat). Instrumentado: boot/quit/crash/dirty-exit
   (espelha o synkora-crash.log), spawn/remount/exit de pane, armamento MCP,
   PRIMEIRA conexão MCP autenticada de cada pane, toda chamada de tool que
   move estado (Proxy sobre o McpApi), desfecho real de cada mensagem
   injetada (hub.onDelivery: injected/dead/discarded), mudanças de estado de
   card (hooks no TaskStore com prev/next), fotografia do dev, diff imutável
   (com range e flag de degenerado), tentativas/resultados de merge e cada
   decisão da reconciliação de boot. Sanitização por chave (token/key/etc.),
   truncagem, rotação e retenção de 14 dias. "◉ exportar diagnóstico"
   (titlebar → clis ▾) gera um .zip com diário + stores + settings sanitizado
   + evidência Git por projeto (`src/main/diagnostics.ts`); IPC
   `blackbox:export`/`blackbox:tail`.
2. GATES QUE FUNCIONAM (a F6.3 read-only deixava o gate CEGO E MUDO — causa
   provada por 6 sondas): codex 0.146 auto-nega toda tool MCP sob qualquer
   `--ask-for-approval` sem aprovação interativa ("user cancelled MCP tool
   call") e `--disable shell_tool` removia toda leitura; claude em plan mode
   bloqueia o próprio `mcp__synkora__report`. `panePermissions.ts` reescrito:
   gates seguem o toggle de bypass do projeto (como qualquer pane), MCPs
   herdados continuam desligados, features delegadoras desabilitadas, shell
   (leitura) preservado; claude sem plan mode e sem NENHUMA ferramenta de
   escrita no catálogo (`--tools Read,Grep,Glob,Skill`). A cerca read-only
   REAL segue no backend: fingerprint antes/depois invalida veredito de
   qualquer escrita + ACL do servidor MCP. Validado fim-a-fim (report chegou
   ao servidor real + leitura ok nos dois CLIs).
3. GATE NUNCA MAIS PARCIALMENTE EQUIPADO: watchdog de 75s — gate que não faz
   nenhuma requisição MCP autenticada é encerrado com causa explícita
   (`mcp/gate-mcp-timeout`), fase preservada e receita de retry no evento.
4. REPARO DE INTEGRAÇÃO (merge bloqueado pós-aprovação NUNCA volta ao dev):
   card aprovado com merge bloqueado fica em `finalizing` com review+QA
   preservados; o orquestrador resolve a causa no destino (a branch da missão
   é dele) e chama `run_task {id, phase:"finalize"}` — re-tenta SÓ o merge do
   MESMO commit aprovado (receipt `preparing` é refeito com o destino atual;
   `prepared` é revalidado). Persona ensinada; `test:merge-repair` cobre o
   ciclo completo no Git real.
5. ENTREGA VAZIA/DIFF DEGENERADO vira estado explícito: dev que reporta done
   sem nenhuma alteração sobre a base é bloqueado ANTES de abrir gate (com as
   2 causas possíveis no evento); fotografia degenerada persistida
   (base==entrega) recusa reabrir gate cego — o card real travado de 01/08
   destrava com a explicação correta.
6. Reconciliação de boot registra cada decisão na caixa-preta
   (`recovery/*` com prev/next/motivo/evidência).

Validação: typecheck + suíte completa verde (291 testes existentes + 35
assertions novas: `test:blackbox`, `test:merge-repair`;
`test:pane-permissions` atualizado para o contrato novo). O passo 8 do plano
(validação ao vivo com o usuário, com monitor da caixa-preta) está roteirizado
na matriz de falhas.

## F6.2 (2026-08-01) — fluxo proporcional sem perder segurança

O plano de cada missão agora persiste dois eixos independentes: perfil de
execução (`fast`, `standard`, `deep`) e risco (`low`, `medium`, `high`). O
orquestrador justifica ambos e informa o orçamento exato de cards antes da
aprovação. O backend, e não apenas a persona, aplica os limites: `fast` usa uma
lane, um card, zero ajudantes e no máximo uma skill diretamente relevante;
`standard` aceita até quatro cards e dois ajudantes simultâneos; `deep`, até
doze cards e quatro ajudantes. Checklist nunca implica delegação. Se a realidade
exceder o contrato aprovado, o plano é reclassificado e volta para nova aprovação.

Tamanho não reduz segurança: código continua com validação, e risco alto força
review + QA. Em `fast`, ambos são focados somente no diff e nos testes afetados,
sem helpers, menus amplos ou varredura do repositório. Documento/asset declarado
`non_code` pode encerrar sem panes de gate. Diagnósticos estruturais de código são
independentes de gates. Retry automático é 1 em `fast`/`standard` e 2 em `deep`;
depois disso o diagnóstico volta ao orquestrador, não ao usuário.

A fase do card é persistida (`dev`, `review`, `qa`). Fechar o pane ou reiniciar o
app durante review/QA preserva o worktree e reabre somente esse gate; pausar um
plano também não deixa a próxima fase nascer às escondidas. `tasks.json` usa
gravação atômica e backup. O board mostra perfil, risco, orçamento e a fase atual;
panes automáticos não arrancam mais o usuário do board.

A fila continua FIFO. Avanço da base é informativo para missões fora da cabeça;
a sincronização normal ocorre uma vez quando chega a vez da missão. O card limpo
de sync não abre ajudantes nem skill de conflito; conflito verdadeiro permanece
rigoroso e a decisão é do Maestro.

Pacote validado desta revisão: `release/orchestrator-right-sized-verified-20260801-r2/
win-unpacked/Synkora.exe`. O app em execução não foi reiniciado durante a entrega.

## F6 (2026-07-31) — projeto do zero com plano mestre vivo

Uma pasta efetivamente vazia nasce em modo `greenfield`; um repositório com
conteúdo continua no fluxo de projeto existente. No greenfield, o Maestro conduz
cinco etapas visíveis — problema/público, limites/sucesso, decisões, roadmap e
aprovação — e
começa cada resposta dizendo onde estamos, o que já foi decidido, o que falta e
qual é a única próxima pergunta/ação.

O estado autoritativo fica em `.synkora/PROJECT_PLAN.json`; a versão legível para
o usuário é `.synkora/PROJECT_PLAN.md`, com backup automático. O mapa exige
aprovação explícita e avança por **ondas**: uma onda pode abrir várias missões
independentes em paralelo, mas a onda/versão seguinte não fura essa fronteira.
Cada missão ainda passa pelo seu próprio card de plano, execução, gates e
integração. Missões de uma versão formam um bloco contínuo;
antes de começar o bloco seguinte, o MD/board indicam a publicação da versão
anterior como único próximo passo. Missões seguintes da mesma versão nascem da
branch que já contém as entregas anteriores. Depois da última integração, o
projeto fica em `awaiting_release`; só a publicação final explicitamente aceita
muda para `done`.
A aprovação rejeita dependências fora de ordem, versões numéricas regressivas,
blocos intercalados, ids contraditórios e trabalho novo em versão já publicada.
Uma missão adiada pausa o mapa no próprio ponto até ser retomada ou retirada por
uma revisão aprovada; ela nunca é pulada silenciosamente.
A partir de `done`, melhorias voltam ao fluxo normal de missões focadas.

Atalhos incompatíveis ficam fechados durante o plano mestre: tarefa avulsa,
missão manual e agente livre. O backend repete as mesmas guardas, e somente o
orquestrador da missão pode criar/ajustar cards AUTO depois da aprovação do plano.
O Maestro Codex recebe a persona por `developer_instructions`, resistente a
`/new`, e a persona greenfield relê o status persistido em vez de confiar no
estado em memória.

As 13 skills permitidas de `obra/superpowers` foram adicionadas (o novo lote
exclui `writing-skills`). Todas as oito skills classificadas como planejamento
acompanham Maestro e orquestrador; workflows que disputariam git/review/merge são
somente explícitos. Cópias locais com o mesmo id são preservadas, cópias geridas
desinstaladas são podadas por marker e leases impedem helpers paralelos de podar
as skills uns dos outros.

## F6.1 (2026-08-01) — ondas paralelas, fila de integração e skills auditáveis

O schema 2 do plano mestre adiciona `wave`, `roadmapMeta`, `activeItemIds`,
`readyItemIds` e `planningSkills`. Roadmaps grandes podem ser salvos em lotes;
`expectedCount` + `complete` impedem aprovação acidental de um mapa parcial de
50–150 missões. Planos schema 1 migram automaticamente, com uma onda por item,
para preservar a serialidade já aprovada.

Desenvolvimento é paralelo; integração é uma fila FIFO persistente por projeto
(`userData/integration-queue.json`, com backup). `integrate_mission` apenas
enfileira e `queue_missions` registra um lote inteiro antes do worker começar.
Só a cabeça altera a branch de versão/base. Se o destino avançou, a missão
mantém a posição e recebe um card AUTO de sincronização + testes + review + QA.
Conflito real pausa a fila: o Maestro inspeciona e persiste a decisão com
`guide_integration_resolution`; o orquestrador executa essa orientação. O usuário
só entra quando houver uma bifurcação real de produto, nunca para resolver Git.
O ticket lacra `planId`, SHA da missão e identidade/SHA do destino aprovados; o
worker revalida tudo e exige origem limpa antes de mesclar exatamente esse SHA.
Alteração posterior aos gates nunca vira commit escondido: pausa na mesma posição
e volta ao Maestro. A fila é dona exclusiva do card de remediação; ao concluí-lo,
`conclude_plan` reutiliza automaticamente o aval original, sem perguntar de novo.
Crash/restart recupera intent + ancestralidade do Git e nunca presume uma entrega.
O journal de release também exige a branch da versão limpa e grava o SHA definitivo
antes do merge. O destino é atualizado por compare-and-swap contra branch+SHA
validados; se o Windows impedir a atualização dos arquivos, intent/ticket/branches
ficam preservados e o boot só conclui depois de um reparo seguro da mesma fotografia.

O planejamento usa somente `synkora-planning-standard`, entregue por receipt da
rodada — nenhum catálogo de métodos é anexado à persona. O Maestro precisa ativar
esse receipt e incluí-lo no próprio artefato. Roadmap e plano de missão guardam
versão/fingerprint do pacote; o plano mestre também vincula o receipt ao hash do
conteúdo e a um carimbo do control-plane fora do workspace. Proposta nova sem essa
prova não pode ser aprovada nem gerar cards. Planos já aprovados antes do contrato
continuam executáveis como `legacy_unverified`, sem fingir que usaram a skill.

## Plano executado (2026-07-31) — performance, MCP 2026 e LSP

O briefing que guiou essa entrega está em `docs/PLANO_MCP_LSP.md`; suas fases já foram
executadas. A ordem preservada foi: medir → retirar `npx @latest` do caminho crítico →
criar LSP TypeScript compartilhado por worktree → ampliar linguagens → migrar MCP em
modo dual-era → expor controles na Configuração. O documento permanece como registro
das decisões e dos critérios de aceitação, não como próxima missão pendente.

## F5.9 (2026-07-30) — SynVoice

Ditado global implementado na barra superior. OpenAI `gpt-transcribe` é o
automático de máxima precisão; OpenRouter é alternativo e lista ao vivo apenas
modelos de transcrição. Chaves independentes ficam no `safeStorage`. A paleta
flutuante é M fixa e arrastável. O fluxo insere direto no destino, sem enviar
Enter; há modos botão clique-clique, atalho liga/desliga por tecla/botão
auxiliar do mouse e segure-para-falar com tecla configurável.
Chave salva fica mascarada/bloqueada até a remoção explícita. Segurança de
navegação, microfone e IPC foi endurecida junto.

## F5.7 (2026-07-28) — missão dirigida por PLANO

Fluxo de missão redesenhado (seção F5.7 do CLAUDE.md tem os detalhes):
1. Orquestrador propõe UM card de plano (`create_plan`: summary markdown +
   lanes com seat/modelo/effort por função).
2. Usuário lê o card ◆ no board, ajusta as lanes se quiser e "▶ aprovar e
   executar" (`tasks:planApprove`); "⏸ pausar" reverte.
3. Depois é 100% do orquestrador: cards nascem `auto` (read-only, visuais) e
   ELE dispara cada um via `run_task` (main abre o pane sozinho, teto de 6
   paralelos), corrige reprovados e limpa com `delete_task`.
4. `conclude_plan` pousa a conclusão (markdown) no card do plano → done; o
   usuário decide a integração como sempre.
Plano sobrevive a restart (recovery pula kind plan; persona retoma sozinha);
plano fora de todas as contagens de trabalho; quick-add some com plano ativo.

## F4.2 (sessão da tarde) — o que mudou

1. TELEMETRIA RESSUSCITADA — causa raiz sondada em PTY real: app lançado de
   dentro de uma sessão do Claude Code herda `CLAUDE_CODE_CHILD_SESSION` e o
   CLI filho DESLIGA a gravação de transcript (sem JSONL = badges mortos e
   --resume quebrado; o 2.1.218 mostra o aviso, o 2.1.216 silenciava).
   pty.ts/maestroSession.ts/maestro.ts limpam `CLAUDE_CODE_*`+`CLAUDECODE` do
   env de todo filho. CLI global atualizado p/ 2.1.218.
2. ADOÇÃO DE SESSÃO DETERMINÍSTICA no sessionStats: claims arquivo→pane,
   sessionHint dos cliArgs (resume), registro vivo `<configDir>/sessions/
   <pid>.json` (sessão exata ANTES da 1ª mensagem), birth mais próximo do
   spawn p/ pane novo, e troca pós-/clear só para quem digitou /clear
   (noteReset). N panes no mesmo cwd nunca mais disputam o mesmo JSONL.
3. PANES 100% RESPONSIVOS: container queries no .pane/.maestro-window —
   titlebar colapsa progressivamente (seat → tokens/rótulos de botão →
   effort/custo → modelo/barrinha → chips de versão) sem nunca estourar;
   título é o único flexível. Botões do maestro viram só ícone no aperto.
4. FIT DO XTERM DEBOUNCED (120ms + assentamento 350ms, só se cols/rows
   mudaram) — fim do texto embaralhado em drag de resize.
5. TOOLTIP CUSTOMIZADO GLOBAL (data-tip + TooltipLayer via portal) — todos os
   title= do renderer migrados (~70).
6. SELECT CUSTOMIZADO (components/Select.tsx, portal + teclado + variante
   dark) — todos os 27 <select> nativos substituídos; compat de layout no fim
   do global.css.
7. SCROLLBARS CUSTOMIZADAS (papel no app, claras nos painéis escuros/xterm).

## O que existe e funciona (sessão anterior, F4.1)

1. /CLEAR DEFINITIVO: detecção do banner reescrita (texto "Claude Code v…"
   tolerando CSIs no meio — o v2.1.216 intercala SGR; âncora no último \e[H antes
   do texto; home em chunk anterior → clear + REPLAY idempotente; 2ª âncora p/
   REFLOW sem home: banner com arte/caixa na mesma linha). E /clear + fechar o
   app não ressuscita mais a conversa: PtyManager.feedInput acompanha o INPUT
   digitado (linha "/" + Enter; ignora CSIs/shift+enter/bracketed paste) →
   onCommand → /clear (claude) e /new (codex) invalidam o tuiSessionId NA HORA.
2. BADGES AO VIVO EM TODOS OS PANES: modelo E effort mudam na hora da troca —
   claude: banner + "Set model to …" + "Set effort level to …" + footer
   "<X> · /effort" (marcador varia por nível, ConPTY repinta por DIFF — nunca
   exigir ● nem "with"); codex: footer "<modelo> <effort> · ~cwd". Cadeia: vivo >
   configurado > stats.model do JSONL. Stats/contexto funcionam em pane RESUMADO
   (sessionStats adota arquivo por birth OU mtime; codex vasculha 7 dias).
   ZERO_STATS: badges desde o 1º frame. Modelo codex normalizado p/ minúsculas
   (display name dava 400).
3. CONTROLE TOTAL DE AJUDANTES: list_helpers / helper_output (lê o TRANSCRIPT
   limpo — o tail cru vinha embaralhado pelo TUI; funciona pós-morte do pane;
   SEM LIXO: leitura completa de ajudante morto APAGA o arquivo; helper_close
   também descarta) / helper_send / helper_close. Ajudante que morre sem report
   avisa o delegador. list_seats traz LIMITES reais por conta.
4. DELEGAÇÃO VIA ORQUESTRADOR: dev manda o plano por notify_maestro (texto
   carimbado com "(de dev · pane X)"), orquestrador responde via notify_pane
   com seatId + model id + effort por ajudante (persona DELEGATION ADVISOR no
   orquestrador E no PM). Fallback: sem resposta → dev decide via list_seats.
5. AGENTE LIVRE CONSCIENTE (✦ Agente): modal de MODELO + EFFORT na abertura;
   nasce ARMADO (MCP role 'livre' + FREE_AGENT_PERSONA nos 2 CLIs — codex via
   `-c developer_instructions="…"`, VALIDADO com sonda BANANA123). Filosofia:
   modo prático, sem cards — base sempre commitada e, ao fim da sessão de
   mudanças, `register_direct_mission` (title+points) → missão ⚡ DIRETA (nasce
   concluída, sem orquestrador; vira delivery da versão corrente; PM avisado).
   Autonomia total: delegate/list_seats/helpers/board_status/notify_maestro.
   GUARDA central: mergeTaskWorktree recusa merge com árvore de destino suja.
6. VERSÕES COM SENTIDO: caixa "sem versão" MORTA (item nasce na versão corrente,
   acompanha a missão, migrações no load); criação AUTOMÁTICA (botões
   patch/minor/major calculados da versão mais alta — nunca duplica nem fica
   abaixo da main; validateNewVersion também no create_mission do PM); lançada
   VERDE, read-only, contador ✓ enviadas/criadas de MISSÕES; abertas em cima
   (recentes primeiro); "+ nova versão" no topo; NADA PENDENTE SOBE (item
   aberto bloqueia release; PM tem remove_backlog_item); excluir itens = via
   seleção com confirm modal; "criar missão com N itens" no rodapé.
7. TRAVAS DE PIPELINE: card done de missão fechada não tem "reabrir" — virou
   "🚀 nova missão a partir deste card" (modal pré-preenchido com a referência);
   card em QA sem run = read-only; missão INTEGRANDO = overlay bloqueando a aba.
8. REVIEWER DE CÓDIGO CONFIGURÁVEL na página geral (seat/modelo/effort no
   maestroStore; cadeia reviewer > lane qa do plano > política qa > seat do dev).
   Ele revisa cada tarefa antes do QA e não cria um gate extra na fila de integração.
9. LIMPEZA SEM LIXO: integração APROVADA limpa os arquivos da missão na hora
   (cleanupMissionFiles); 🧹 pega transcript de tarefa de missão concluída/
   excluída (antes escapava); Maestro remove item de backlog via tool.
10. ORQUESTRADOR SABE DE TUDO: ▶ executar publica evento com missionId direto
    no pane dele; eventos de missão roteados pelo hub (já era) + missões
    diretas explicadas na persona do PM (changelog, nunca gerenciar).

## Regras de trabalho combinadas (além das do CLAUDE.md)

- SEMPRE derrubar e resubir o app (`npm run dev`) ao terminar qualquer mudança —
  sem esperar pedido (memória feedback-restart-apos-mudanca).
- Sondar em PTY real / binário ANTES de dizer "não dá" ou de confiar em formato
  de saída de TUI (as sondas .cjs ficam no scratchpad da sessão; capturar bytes
  crus com ESC visível e validar a regex contra eles).
- window.confirm/alert NUNCA (quebra o foco no Windows) — modal próprio
  .confirm-modal; exclusões sempre com confirmação.
- ConPTY repinta por DIFF: detecção de texto de TUI nunca pode exigir a frase
  inteira — só a palavra que muda + âncora estável.

## Pendências conhecidas

- F4 de verdade: injetar skills/subagentes das funções no prompt dos executores
  (hoje é curadoria na página geral).
- Transcript de ajudante CODEX poluído por redraws do TUI (reclamação real de
  um dev em 2026-07-28): o dedupe do tee (pty.ts flushLog) não segura o padrão
  de repintura do codex — SONDAR bytes crus antes de mexer (não chutar).
- Crash exit 5 de 2026-07-28 sem stack: blindado (safeWrite) + caixa-preta em
  userData/crash.log — se repetir, o log diz a causa real.
- Duplicação de transcript em resize: RESOLVIDA na F5.2. Claude 2.1.220 usa o
  renderer clássico por padrão; cada pane Claude agora nasce no fullscreen
  oficial (`CLAUDE_CODE_NO_FLICKER=1`) e, no Windows, com full repaint para
  ConPTY. O próprio CLI emite ED2+home+frame completo. Não existe clear
  sintético no resize e ED3 fica exclusivo de `/clear`/`/new` explícito.
- Canvas F5.2 final: docking direto por arrastar/soltar, sem presets; panes sem
  gap, divisor com hitbox sobreposta e sem marcador central. Emendas locais
  redimensionam só o par adjacente; emendas estruturais usam mínimos recursivos
  com folha de 220×210px e transportam por transformação afim as costuras
  locais internas do mesmo eixo. Assim, ao alargar um pane full-height, todas
  as colunas das linhas vizinhas encolhem juntas (panes iguais continuam
  iguais), sem consumir apenas o primeiro. Um
  pane existente solto numa borda composta troca com o pane daquela borda que
  cruza a mesma faixa (direita da mesma linha, por exemplo), preservando a
  topologia. Coluna/linha full-span ficam exclusivamente nos botões do chrome.
  Há até 6 panes por página e abas `Página N` para o excedente, sem desmontar os
  terminais.
- O drop usa a coordenada final do `pointerup` e recalcula a preview de forma
  síncrona antes do commit; o eixo dominante do gesto impede que um arraste
  lateral iniciado no cabeçalho seja confundido com `top`, e esquerda/direita
  não perdem mais o último frame nem parecem travadas.
- Maestro, orquestradores e demais panes usam chrome fixo de 36px, ações sempre
  à direita e colapso progressivo de informações (effort sobrevive enquanto
  cabe; papel vira ícone no mínimo). Buffer normal usa a scrollbar real do
  xterm 6 (`length > rows`). No alternate screen, Claude/Codex guardam o
  histórico dentro da própria TUI e não publicam posição nem tamanho; por isso
  não há mais barra virtual. Roda e `Ctrl+End` seguem pelo caminho nativo, sem
  porcentagem ou percurso inventados. Modo imerso remove a faixa
  superior do palco, mas mantém
  `mapa` e `sair do imerso` no topo da espinha lateral.
- Codex como agente livre usa developer_instructions global (-c) — se o codex
  mudar a chave em versão futura, re-sondar (sonda probe-codex-devinstr.cjs).
- Panes/agentes abertos antes desta sessão precisam reabrir para nascer armados.
