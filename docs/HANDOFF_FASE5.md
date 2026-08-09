# HANDOFF — nível 5 (pós-Fase 5, auditado) — próximo: FASES 3 e 4, depois a missão

Atualizado em 2026-08-09 (madrugada), antes do /clear do dono.

## PRÓXIMA SESSÃO (pós-clear) — leia isto primeiro

0. **TEXTO QUE O DONO VAI COLAR** (referência do combinado):
   > Continua o nível 5 na branch nivel5-fase1. Lê docs/HANDOFF_FASE5.md
   > primeiro. Agora é a FASE 3 (multi-renderer) [e depois a FASE 4].
   > Agentes Opus [liberados / não]. App [aberto / fechado].
1. **DECISÃO DO DONO (2026-08-09)**: "quero tudo redondo" — as Fases 3 e 4
   do PLANO_NIVEL_5.md entram ANTES do teste de missão. Ordem:
   **FASE 3 → FASE 4 → teste de missão → PUSH** (push só no final de tudo).
2. **ONDE ESTAMOS**: Fases 0, 1, 2 e 5 CONCLUÍDAS, auditadas e verdes.
   - F0: atribuição de stall (culprits no journal). F1: index modularizado
     (19448→6658 linhas; phaseEngine/mcpApi/ipc). F2: veredito sem barreira
     síncrona (lock por card; validado ao vivo pelo dono). Triagem: git
     síncrono do paneSpec moveu para o gitWorker (travadinha da abertura
     morta).
   - F5 (zero digitação): correio MCP com entrega imediata e status
     `mailboxed`; long-poll do check_messages (segura ~45s; sondas R13 +
     W2–W6); WAITER claude via GET /mail-wait (endpoint no servidor MCP,
     env SYNKORA_MAIL_WAIT_URL); nudge 📬 CONDICIONAL (só digita para pane
     SEM espera armada — `skipped-waiter-armed` no journal é o caminho
     normal); panes abrem LIMPOS nos dois CLIs (claude:
     --append-system-prompt-file; codex: developer_instructions no PROFILE
     por pane — sonda P1–P3, 40KB ok, e `-c` VENCE o profile: nunca os dois
     no mesmo spawn); personas codex todas no canal por arquivo (fim do
     risco de argv da F6.4); instrução de AÇÃO FINAL sempre no turno
     visível (lição real: helper imprimiu resposta e não chamou report).
     VALIDADO pelo dono sem missão (2 ajudantes paralelos, zero digitação).
   - AUDITORIA FINAL (2026-08-09): TODOS os testes do repo verdes —
     harness-lifecycle re-habilitada (26 âncoras mortas aposentadas, 14
     comportamentais ficam), bundled-skills re-apontada, agregado
     skills-system 11 suítes sem falha, typecheck 0. 11 docs de processo
     varridos da branch (lixo não sobe no push).
3. **TAREFA 1 — FASE 3: multi-renderer (CHECK 2)** — seção "Fase 3 (5b)" do
   PLANO_NIVEL_5.md. Resumo do que já se sabe:
   - Sonda POSITIVA (probe-webcontentsview-webgl.cjs, 2026-08-06):
     WebContentsView = renderer PRÓPRIO por view, 16 contextos WebGL POR
     view, ~107MB/view. Decisão do dono JÁ TOMADA: Vertente B ("meu PC tem
     32GB").
   - Corte 1: Board (PM+orquestradores) numa view, canvas de Panes noutra —
     dobra o orçamento WebGL e divide o parse dos pty:data por 2 processos.
     O main roteia pty:data por webContents.
   - Custos mapeados: drag ENTRE views = migração de processo (recriar
     xterm + SIGWINCH repinta — SONDAR codex antes); store zustand POR
     renderer (sincronizar via push do main, que já é o padrão);
     portais/overlays por view.
   - Complemento posterior: pool WebGL por visibilidade.
   - É sessão própria, cirurgia de renderer: plano formal ANTES de código
     (padrão das fases 1/2: mapa → commits pequenos e verdes → validação).
4. **TAREFA 2 — FASE 4: QA de Electron com app real via CDP** — seção
   "Fase 4 (5c)" do plano. Resumo:
   - `@playwright/mcp` aceita `--cdp-endpoint` (SONDADO 2026-08-07).
   - qaRuntime detecta produto Electron → sobe o app real com
     `--remote-debugging-port=<porta livre do mapa>` → o wrapper playwright
     do pane QA ganha `--cdp-endpoint http://127.0.0.1:<porta>` → QA testa
     preload/IPC REAIS (o duplo de bridge morre).
   - Conferir na implementação: árvore do Electron do produto sob o
     guardião (guardExternalPid no filho real) e fechar a janela do produto
     ao fim da rodada (prompts já mandam).
   - Estimativa do plano: 1 janela + validação em missão de QA real.
5. **TAREFA 3 — TESTE DE MISSÃO (o dono roda; a gente monitora)**: missão
   real dev→review→QA no DEV observando: gates reprovando e esperando a
   rodada nova SÓ por long-poll (zero digitação no reciclo); retry chegando
   ao dev pelo correio; panes abrindo limpos nos dois CLIs; skills ativadas
   (ACTIVE SKILL PLAN ficou no turno — conferir receipts); journal:
   `node scripts/bbwatch.mjs --grep mailbox` cheio (mailbox-post com meta
   causal + mailbox-delivered + skipped-waiter-armed) e
   `--grep delivery-injected` ≈ zero para agentes (exceções auditadas:
   helper-send-raw-keystroke, pane shell). Validações F6.9 ainda não vistas
   ao vivo entram de carona: porteira ⇪ de integração, set_phase_executor,
   synkora-frontend-standard declarada, caça de porta.
6. **DEPOIS DO TESTE**: PUSH de tudo (ordem do dono: só quando terminar
   tudo) · gerar INSTALADOR novo (o instalado roda binário antigo; os fixes
   só entram nele num empacotamento) · decisões avulsas do dono: postar ou
   não docs/ISSUE_DRAFT_claude-code_mcp-first-turn.md (bug do claude CLI,
   CHECK 14) · candidato futuro electron-updater · varrer ou não os .md
   históricos da MAIN (MAPA_RETOMADA, MATRIZ_FALHAS, EM_ABERTO, HANDOFF_F6.3,
   PLANO_ESTABILIZACAO — pré-branch, fora do escopo da limpeza feita).
   Este arquivo (HANDOFF_FASE5.md) também se varre no fechamento.
7. **Otimização registrada e NÃO recomendada agora**: gateVerdictFacts faz 2
   varreduras de árvore por veredito (custo de worker, não trava o main) —
   não mexer em área recém-estabilizada sem motivo.
8. **Regras vivas** (inalteradas): edição de src SÓ com app parado
   (`Get-Process electron` imediatamente antes — a prova expira; o Synkora
   INSTALADO rodando não importa, é isolado) · commits `fase3:`/`fase4:`
   sem acentos, reversíveis e verdes · git add por caminho explícito ·
   nunca "aproveitar e refatorar" fora do mapa · sonda antes de afirmar
   (resposta de TUI codex se lê no ROLLOUT, nunca na tela) · app SÓ no
   terminal do dono · subagentes/Opus só com aval POR SESSÃO.

## Gate verde da última sessão (referência)

typecheck node+web 0 · skills-system agregado 11 suítes 0 falhas
(harness-lifecycle 14 · bundled-skills 9 · codex-skill-isolation 7 ·
orchestrator-flow 39 · pane-permissions 14 · mcp-dual-era 32 clients · +5) ·
phase-verdict-races 18 · phase-transition-lock 9 · mission-worktree 29 ·
mailbox-delivery 10 · mail-wait 2 · helper-completion 14 · helper-recovery 9
· mission-verification 25 · stall-attribution 8 · pty-recovery 4 ·
mcp-protocol 5 · phase-skill-prompts 9.

## Sondas re-rodáveis desta era (a cada update de CLI)

- scripts/probe-codex-mailbox-wait.mjs — long-poll MCP (W1–W4, W6) + waiter
  background codex (W5, NEGATIVO: codex nunca acorda pós-turno).
- scripts/probe-codex-profile-instructions.mjs — developer_instructions no
  profile por pane (P1 curto · P2 40KB · P3 precedência do -c).
