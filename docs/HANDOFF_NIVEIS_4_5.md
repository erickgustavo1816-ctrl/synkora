# HANDOFF — Níveis 4 e 5 (escrito 2026-08-07 noite, pós-F6.10)

Para a sessão que vai continuar a jornada. Estado ao escrever: Onda 3 com
4/4 missões entregues (M04 integrada; M03/M05/M06 aguardando o ⇪ do dono —
a porteira mecânica nova vai pulsar quando os agentes pedirem); níveis 1-3
do plano de mudanças APLICADOS e verdes (CLAUDE.md § F6.10; typecheck + 122
asserções). Caderno da era: scratchpad NOTAS_TESTE_2026-08-06_onda3.md
(morre com a sessão — o que importa está neste doc, no CLAUDE.md e na
memória permanente).

## REGRAS QUE NÃO SE NEGOCIAM (memória permanente)

- `feedback-codigo-limpo-sem-arquivos-gigantes`: feature nova = módulo
  novo; arquivo cruzando ~1000 linhas se divide NA HORA; milhares de linhas
  é proibido. Checar `Get-Process electron` ANTES de QUALQUER edit em src —
  a prova de app fechado expira no instante em que é colhida (2
  reincidências reais em 2026-08-07).
- `projeto-refatoracao-index-18k`: o nível 5 SÓ começa com planejamento
  formal COM o dono — plano antes de código, sempre.
- Subagentes só com aval explícito; app só no terminal do dono; processo
  suspeito = evidência, nunca kill.

## NÍVEL 4 — Investigações (pouco código nosso)

> DESFECHO (2026-08-07 tarde, sessão dos níveis 4/5): **4a RESOLVIDO por
> sonda** — 10 runs (R1–R10) em `probe-claude-qa-resume-mcp.mjs` provaram a
> causa: o claude monta o catálogo de tools POR REQUEST e o request 1 do
> turno sai ANTES do handshake MCP completar quando o prompt viaja no argv.
> Pane RESUMADO recebe prompt-delta CURTO inline (F6.8i) e o modelo, que
> conhece a tool pela conversa carregada, chama runtime_control no request 1
> → "No such tool available" — MESMO com tools/list servido logo depois
> (reproduzido: R10 = NO-TOOL com list servido, a assinatura exata do
> journal). Frescos escapam porque o briefing-por-arquivo força um Read
> builtin antes de qualquer MCP. NÃO é regressão 2.1.220→2.1.224 (pin de
> versão descartado); a data bate com o prompt-delta da F6.8i, não com o
> update do CLI. FIX APLICADO na mesma data (prompt de resume por arquivo
> com read-first em preparePhasePane; typecheck + orchestrator-flow 35/35
> verdes) — validar ao vivo no próximo resume. Issue upstream: draft pronto em
> `docs/ISSUE_DRAFT_claude-code_mcp-first-turn.md` (o dono decide postar).
> **4b**: sem produção pós-F6.10 ainda; as 2 invalidações de 2026-08-07
> (15:13Z/15:53Z, card "tela de empresas") foram PRÉ-F6.10 e de causas já
> cobertas (migração do produto consertada na origem + screenshot de QA na
> raiz — a quarentena não agiu porque o tracked estava sujo junto).
> Monitorar no próximo boot. **Nível 5**: plano formal entregue em
> `docs/PLANO_NIVEL_5.md`, aguardando aprovação do dono.

### 4a. Bug do claude CLI: pane RESUMADO ignora tool servida (CHECK 14)

- PROVADO com journal: catálogo servido ao pane exato continha
  runtime_control (evento mcp/catalog-served) e o claude respondeu "No such
  tool available". 8/8 panes resumados sem a tool; TODOS os frescos com
  ela. Começou em 2026-08-07 00:42Z (pré-F6.9 — não é código nosso);
  claude atualizou 2.1.220→2.1.224 em algum boot do dia (suspeito de
  versão). BLINDAGEM JÁ EM PRODUÇÃO: QA resumado recebe o runtime DE PÉ
  pelo harness (URL no prompt) + instrumentação catalog-served.
- FAZER: rodar a sonda (roteiro completo em scratchpad
  probe-claude-qa-resume-mcp.md — recriar do roteiro resumido no CHECK 14
  do CLAUDE.md § F6.9 se o scratchpad tiver morrido): reproduzir o spawn
  EXATO do pane QA com --resume, bisecar flags (--allowedTools,
  --strict-mcp-config), comparar 2.1.220×2.1.224. Desfecho: issue no
  repositório do claude-code e/ou pin de versão no cliUpdate.
- CUSTO: gasta tokens de seat — só com aval do dono.

### 4b. Loop da fotografia — monitorar (provavelmente resolvido)

O produto ganhou o conserto (dados fora do boot) e a fotografia agora
NOMEIA os culpados no motivo. Se "arquivos não commitados" voltar, o nome
do arquivo diz na hora se é runtime do harness, evidência de gate ou
migração do produto.

## NÍVEL 5 — A cirurgia (sessão dedicada; PLANEJAMENTO COM O DONO ANTES)

### 5a. CHECK 13 + CHECK 1 — modularização do index.ts (~18k linhas) + barreira do veredito

Uma operação só, três faces:
1. `MainContext` explícito (interface com ptys/hub/tasks/maestro/projects/
   blackbox/…) substitui a captura por closure — pré-requisito de tudo.
2. Extração por MENOR acoplamento, 1 commit revisável por passo, suítes
   verdes a cada um: construtores de PROMPT das fases → API MCP (objeto
   mcpApi) → máquina de fases (advancePhase/preparePhasePane/phaseWatches/
   poller) → grupos de IPC por domínio.
3. NA extração da máquina de fases: tirar a barreira síncrona do veredito
   do main preservando a fotografia atômica (lock de transição por card +
   git no worker). Stalls medidos: 1,2–2,6s em TODA transição done→gate,
   crescendo com a carga (4/4 em 2026-08-06). O comentário-âncora "SYNC de
   propósito" em advancePhase conta a história do bug "[object Promise]" —
   respeitar o contrato, mudar o mecanismo.

### 5b. CHECK 2 — desempenho de render (multi-renderer + WebGL)

- SONDA POSITIVA pronta (2026-08-06, probe-webcontentsview-webgl.cjs — no
  scratchpad morto; recriar é trivial, o resultado está no CLAUDE.md §
  F6.9): cada WebContentsView tem renderer PRÓPRIO com balde WebGL PRÓPRIO
  (16 contextos POR view; ~107MB/view). Decisão do dono: Vertente B
  escolhida ("meu PC tem 32GB").
- Corte inicial: Board (PM+orquestradores) numa view, canvas de Panes
  noutra — dobra o orçamento e divide o parse dos streams por 2 mains de
  renderer. Depois: pool WebGL por visibilidade como complemento.
- Custos mapeados: drag ENTRE views = migração de processo (recriar xterm +
  SIGWINCH repinta — sondar o caso codex); portais/store zustand por
  renderer (sincronizar); pty:data é limpo (main roteia por webContents).

### 5c. CHECK 7c — QA de Electron com app REAL via CDP (sonda positiva)

`@playwright/mcp` aceita `--cdp-endpoint` (sondado 2026-08-07). Desenho:
qaRuntime detecta produto Electron → sobe o app real com
`--remote-debugging-port=<porta livre>` → o wrapper do playwright do pane
QA ganha `--cdp-endpoint http://127.0.0.1:<porta>` → o QA testa o renderer
DE VERDADE (preload/IPC reais; o duplo de bridge vira desnecessário).
Conferir: árvore do Electron do produto sob o guardião (guardExternalPid já
cobre o runtime — validar o filho), e o ciclo janela-do-produto na tela do
dono durante o QA.

## CORREIO MCP — próximas fases (depois do F1 assentar em produção)

- F2: correlationId fim-a-fim (HubDeps.inject ganha meta; coalescência por
  FATO no lugar do dedup por texto) + migrar os injetores diretos restantes.
- F3: aposentar a digitação de payload por completo (fica só o aviso 📬) e
  medir: delivery-injected deve virar exceção no journal.
- VALIDAR F1 ao vivo ANTES de F2: mailbox-post/mailbox-delivered no
  journal, agentes reagindo ao bloco "[synkora inbox]", nudge não poluindo.

## VALIDAÇÕES PENDENTES AO VIVO (F6.9 + F6.10 nunca vistos em produção)

⇪ pulsando "aprovar integração" (M03/M05/M06 serão os primeiros casos) ·
set_phase_executor com ordem antecipada · synkora-frontend-standard
declarada no done/report do próximo card front · correio MCP (inbox de
carona + check_messages) · reconciliador pane-open-lost · escalonador de
spawn (abrir o projeto deve parar de travar cliques) · mapa de portas ·
caça automática de porta · pré-trust (gates sem diálogo).

## PRODUTO (ações do dono, quando ele quiser)

⇪ integrar M03 (leva o conserto da PORTA p/ V1.0 — destrava a família
inteira), M05, M06 · go dos extratores M07/M08 (fecham a Onda 3) · release
da V1.0 quando o roadmap mandar · commit da era F6 no repo do Synkora.
