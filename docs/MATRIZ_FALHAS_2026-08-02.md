# Matriz de falhas — plano de estabilização 02/08/2026

Estado esperado, eventos esperados na caixa-preta e cobertura de cada um dos 12
cenários do plano. "Ao vivo" = passo 8 do plano (validação com o usuário, app
real, monitor da caixa-preta aberto em `userData/blackbox/journal-*.jsonl` /
`journal.md`).

Causas raiz confirmadas por sonda nesta rodada (6 sondas em binário real, ver
`scripts/probe-*.mjs` e `.tmp/probe-*.json`):

- **Codex 0.146 auto-nega TODA chamada de tool MCP** sob qualquer
  `--ask-for-approval` sem aprovação interativa ("user cancelled MCP tool
  call") — o gate read-only da F6.3 nunca conseguia chamar `synkora.report`.
  `--disable shell_tool` ainda removia toda leitura de arquivo (revisor cego).
- **Claude em plan mode bloqueia o `mcp__synkora__report`** (tool não
  read-only) — o gate claude da F6.3 nunca rodou em produção e falharia igual.
- **Perfil corrigido** (`panePermissions.ts`): gates seguem o toggle de bypass
  do projeto (como todo pane), MCPs herdados continuam desligados, features
  delegadoras desabilitadas, shell/leitura preservados; claude sem plan mode e
  sem nenhuma ferramenta de escrita no catálogo. A cerca read-only REAL é o
  fingerprint antes/depois no backend (invalida o veredito de qualquer
  escrita) + a ACL do servidor MCP.

| # | Cenário | Estado final esperado | Eventos esperados (caixa-preta) | Cobertura |
|---|---------|----------------------|--------------------------------|-----------|
| 1 | Fechar durante DEV | card → `backlog`, `activePhase: dev`, `phaseState: interrupted`; worktree + transcript preservados | `app/dirty-exit` (boot seguinte), `recovery/dev-interrupted` com prev/next | código F6.3 + records novos; ao vivo |
| 2 | Fechar depois do DEV, antes da revisão | card em `execucao/review/pending` no fechamento → boot marca `interrupted`, dev preservado | `recovery/gate-preserved` | código F6.3 + records; ao vivo |
| 3 | Fechar durante a revisão | gate `review` fica `interrupted`, dev intacto; reabre SÓ o gate (`run_task {phase:"review"}`) | `recovery/gate-preserved`, depois `pane/spawn` + `mcp/pane-connected` do gate novo | é o caso real de 01/08 (card `b6629070`); ao vivo |
| 4 | Fechar durante o QA | idem, gate `qa` | `recovery/gate-preserved` | código F6.3 + records; ao vivo |
| 5 | Fechar depois do QA, antes do merge | `phaseState: finalizing` → boot reconcilia com o journal Git (nunca presume entrega) | `recovery/finalizing-recheck`, `merge/*` conforme o journal | `recoverFinalizingTask` (F6.3) + `test:merge-repair` no nível git; ao vivo |
| 6 | Merge bloqueado com árvore de destino suja | card APROVADO permanece aprovado em `finalizing` (reparo de integração); **nunca volta a DEV**; orquestrador limpa o destino e chama `run_task {phase:"finalize"}` | `merge/task-merge-blocked` com motivo, `task/state-change`, `msg/hub-error` com a receita | **corrigido nesta rodada**; `test:merge-repair` (17 assertions); ao vivo |
| 7 | Codex com configuração MCP ausente/inválida | config herdada ilegível → gate bloqueado ANTES de abrir (`codexGateMcpDisableArgs` lança); gate que abre e não conecta → watchdog de 75s encerra com causa e preserva a fase | `mcp/pane-armed` (com `mcpConfigured`), `mcp/gate-mcp-timeout`, `msg/hub-error` com receita de retry | `test:pane-permissions` + watchdog novo; ao vivo |
| 8 | Remount de pane com o mesmo ID | identidade re-armada; token de geração impede o exit velho de desarmar o pane novo; first-contact MCP zerado no exit | `pane/remount`, `pane/exit`, novo `mcp/pane-connected` | código F4.2+/F6.3 + records novos; ao vivo |
| 9 | Commit preservado cuja comparação dá diff vazio | dev que reporta done sem NENHUMA alteração → bloqueado antes de abrir gate (estado explícito + 2 causas possíveis); fotografia degenerada persistida (base==entrega) → gate recusado com a mesma explicação | `phase/empty-delivery-blocked`, `git/immutable-diff` com `degenerateRange` | **corrigido nesta rodada** (2 guards); `test:merge-repair` (diff degenerado explícito); ao vivo |
| 10 | Mensagem quando o report está indisponível | gate sem conexão MCP nunca fica vivo em silêncio (watchdog); toda entrega de mensagem tem desfecho registrado (injetada/pane morto/descartada) | `mcp/gate-mcp-timeout`, `msg/delivery-injected|dead|discarded` | watchdog + hook `onDelivery` novos; sondas 1–6; ao vivo |
| 11 | Repetir a integração sem alterar o commit | `run_task {phase:"finalize"}` re-tenta SÓ o merge do MESMO commit aprovado; receipt `preparing` é refeito com o destino atual, `prepared` é revalidado integralmente | `merge/finalize-retry`, `merge/task-merge-ok` | **corrigido nesta rodada**; `test:merge-repair` (retry mesmo commit pós-reparo) | 
| 12 | Alterar a entrega depois da aprovação | fingerprint/head/tree divergentes do aprovado → `finalizeTask` bloqueia e invalida SÓ os gates dependentes; card volta ao dev com motivo | `task/state-change` com feedback `integração bloqueada: …` | código F6.3 (`invalidEvidence`) + `test:mission-verification`; ao vivo |

## Roteiro do passo 8 (validação ao vivo com o usuário)

1. Abrir o monitor: acompanhar `userData/blackbox/journal.md` (ou o JSONL do
   dia) enquanto o app roda.
2. Fluxo completo: criar/retomar um card FAST → dev → review (Codex) → QA →
   merge. Conferir no diário: `pane/spawn` → `mcp/pane-connected` de CADA gate
   → `mcp/tool-report` → `merge/task-merge-ok`.
3. Provocar merge bloqueado: sujar o worktree da missão antes do QA aprovar →
   conferir `merge/task-merge-blocked` + card aprovado preservado → commitar a
   sujeira → `run_task {phase:"finalize"}` → `merge/finalize-retry` + `ok`.
4. Fechar e reabrir o app durante o review → conferir `app/dirty-exit` +
   `recovery/gate-preserved` + retomada só do gate.
5. Exportar o diagnóstico (titlebar → clis ▾ → "◉ exportar diagnóstico") e
   conferir que o pacote reconstrói o fluxo sem screenshots.

## Caso real preservado (evidência)

`.tmp/evidence-20260802/` guarda a fotografia completa de antes de qualquer
mudança: stores do userData, `.synkora` do projeto CALCULADORA - Copia,
evidência Git (branches/worktrees/log) e crash log. O transcript
`runs/b6629070-*.md` documenta o revisor Codex sem ferramentas e o diff
degenerado `7d76a5a..7d76a5a`.

Sobras conhecidas no projeto CALCULADORA - Copia (decisão do usuário
pendente, nada foi limpo): worktrees órfãos `task/3310e9e7` e `task/88ad9810`
parados no commit base `e80ba1e` — lixo inofensivo de recuperações antigas; o
card `b6629070` destrava sozinho com o código novo (o gate reaberto recusa a
fotografia degenerada e explica a saída: o trabalho já está na missão).
