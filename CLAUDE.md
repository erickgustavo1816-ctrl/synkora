# Synkora

ADE (Agentic Development Environment) desktop: projetos como "universos", missões com
dev em CHAT GUI (era 2.0) rodando em worktrees isolados sobre múltiplas contas de CLIs
de IA ("seats"). O dono é o orquestrador.

**Sempre responda ao usuário em PT-BR.**

## ⚡ ERA 2.0 (2026-08-13) — LER PRIMEIRO: docs/PLANO_2_0_GUI.md + docs/GUI_PANE_CONTRACT.md

Decisão do dono: **o pane TUI morreu para missões novas; o GUI mora dentro do Synkora**.
Toda missão criada pelo usuário nasce `Mission.direct`: SEM maestro, SEM orquestrador,
SEM plano/gates — um CHAT (GuiPane) abre no centro do Board com o dev no worktree da
missão; reviewer/ajudantes só quando o dono pedir; ⇪ vai DIRETO pra fila (guardas de
plano desviadas só p/ direct; conflito volta pra conversa do dev). Peças: motor
`src/main/guiSessions.ts` (MaestroSession/CodexSession POR PANE) + `src/main/ipc/gui.ts`
+ `window.synkora.gui`; contratos `src/main/guiMissionContracts.ts`; `missions:guiSpec`;
renderer `GuiPane.tsx` (Pane.surface 'tui'|'gui'), `MissionColumn.tsx` (missões à
ESQUERDA, worktree embaixo de cada card — o layout aprovado pelo dono),
`MissionDeliveryRail.tsx` (⇪/revisar/ajudante/teste). Missões LEGADAS (sem `direct`)
mantêm todo o pipeline F6 abaixo — que segue válido SÓ para elas; suprimir, não demolir,
enquanto existirem. O fork claudecodeui em Desktop/Synkora2 foi REJEITADO como produto
(fica como pedreira de ideias). Skills: decisão adiada pelo dono (kit mínimo quando
voltar). Tudo abaixo desta seção descreve a era F6 (legado).

## Documentos de referência (ler antes de mudanças grandes)

- `docs/PLANO_2_0_GUI.md` — a virada 2.0 (GUI dentro do Synkora) + ondas A/B/C.
- `docs/GUI_PANE_CONTRACT.md` — contrato do pane GUI (canais, tipos, papéis).
- `docs/PLANO.md` — plano completo v1.1 (era F6): conceito, stack, domínio, roadmap F0–F5.
- `docs/SKILLS.md` — curadoria da biblioteca de skills por departamento (F4, era F6).

## Estado mais recente do fluxo (F6.8 — 2026-08-05, bloco do teste da M02c: gates vivos + renascimento no boot + árvore de processos)

Bloco único de 15 itens anotados durante o teste ao vivo da M02c (design system do
PAINEL DE GESTÃO) — caderno completo da sessão em scratchpad NOTAS_TESTE_2026-08-05.md.

- 🔴 BUG BLOQUEANTE DO GATE CORRIGIDO ("[object Promise]"): na conversão gitWorker,
  `taskSnapshotProblem` virou async e DOIS call sites ficaram sem await — advancePhase
  tratava a Promise como fotografia inválida e TODO veredito de gate era invalidado
  (visto ao vivo no 1º gate pós-gitWorker). As checagens moram agora em
  `worktree.snapshotProblemFor` (pura, fonte única): a async delega via gitOff numa
  viagem só; advancePhase — SYNC POR CONTRATO (barreira síncrona do veredito) — chama a
  mesma função direto no main, com comentário-âncora. Validado em produção no ciclo 3.
- GATES VIVOS (review E QA — decisão do usuário: "só tô gastando token de review; o QA
  testa o que mudou, o resto ele já testou"): reprovação LIMPA (readonly provado) NÃO
  fecha o pane do gate — `liveGateWaits` registra a espera e o próximo done do dev
  RECICLA a mesma conversa via openGatePane: baseline nova de fingerprint, phaseWatch
  re-armado no pane vivo e injeção com o delta SHA-provado (head_reprovado → head_novo:
  "re-cheque só sua lista + o delta; o que não mudou não se re-audita"). Aprovação,
  veredito inválido e ilegível fecham como antes; plano pausado/finalize/delete limpam a
  espera; pane fechado na mão cai sozinho no spawn normal. Gate esperando não tem
  phaseWatch → não conta no MAX_PARALLEL_RUNS nem no watchdog (que é só de 1º contato
  MCP). Rubrica nova do reviewer: PROVABLE BY READING ONLY (render/viewport é do QA —
  reprovação especulativa de "overflow em 320px" era vazamento de escopo) + COMPLETE
  LIST FIRST PASS (achado novo em diff já revisado = falha do review, não diligência).
- PANES DE EXECUÇÃO RENASCEM NO BOOT (função oficial — "não tem sentido o pane morrer e
  o orquestrador ter que reabrir"): o recovery de boot anota bootRespawnsPending e o
  respawn é LAZY no maestro:paneSpec (projeto aberto = renderer de pé). Dev claude volta
  via --resume com a conversa inteira (phaseSessions); dev/gate codex renascem frescos
  sobre o trabalho preservado (armadilha codex-resume-sem-MCP segue valendo). UMA
  tentativa por task por boot — sem loop de ressurreição. Guardas: plano pausado,
  capacidade (phaseLaunchCapacity), launch guard.
- PROMPT-DELTA NO RE-SPAWN COM RESUME (caso real: dev voltou com a conversa INTEIRA e
  recebeu o briefing completo de novo — "o dev tem o contexto, não tem por quê"):
  fase dev com resumable ganha prompt CURTO (só o feedback pendente + "corrija a
  CLASSE"); briefing completo fica para conversa genuinamente nova. Autocura de
  resume-fail coberta: o delta instrui ler o transcript preservado se a conversa nascer
  vazia.
- TROCA DE CONTA NOS PANES DE EXECUÇÃO (`tasks:setPhaseSeat` + botão ⇄ no chrome do
  pane de fase + PhaseSeatModal): mesma semântica do reseat do orquestrador — claude→
  claude transplanta a conversa (migrateCliSessionBetweenSeats) e renasce via resume;
  codex/cross-CLI renasce fresco; effort escolhido vira o NOVO carimbo do card; respawn
  imediato; evento seat-swap na caixa-preta. "Limite estourado nunca prende a missão."
- ÁRVORE DE PROCESSOS MORRE COM O PANE ("o que eles abrirem, eles fecham" — Chrome do
  Playwright e Electron do produto órfãos): SONDADO em processo real
  (probe-tree-kill.mjs): taskkill /T /F mata a árvore VIVA em ~160ms mas NÃO atravessa
  pai morto e é no-op com raiz morta. PtyManager ganhou fotografia periódica de
  Win32_Process (everSeen por pane, 20s + aquecimento no spawn, latência de processo
  filho — zero main thread) e no kill/exit: taskkill fast-path + CEIFA 700ms depois com
  verificação de identidade pid+nome (anti reuso) sobre o conjunto alcançável por
  parentesco. killAll (quit) dispara o taskkill por raiz viva. E o TAMPÃO 100% entrou
  na mesma data SEM addon nativo (sondado 42/42 em probe-jobobject-*, com Electron e
  Chrome REAIS em nested jobs): GUARDIÃO PowerShell embutido no pty.ts (gravado em
  tmpdir, Add-Type P/Invoke) cria um Job Object por pane com KILL_ON_JOB_CLOSE e SEM
  flags de breakaway (o default NEGA CREATE_BREAKAWAY_FROM_JOB); assign da raiz
  imediato pós-spawn (<1ms quente); close no kill mata a árvore NO KERNEL, inclusive
  órfão de pai morto; CRASH do app = EOF no stdin do guardião = tudo morre sozinho (o
  buraco do dirty-exit). Membership NÃO é retroativa (processo nascido antes do assign
  fica fora) — por isso taskkill+ceifa CONTINUAM como segunda camada, nunca remover.
  Guardião morto = respawn com teto 3/60s + re-assign das raízes vivas. Custo: ~272ms
  uma vez, ~82MB WS (PS 5.1). E os prompts de dev/review/QA exigem fechar browser/app
  do produto AO FIM DE CADA RODADA (comportamental, o caso limpo).
- SKILL SYNC INCREMENTAL DE VERDADE (medições da caixa-preta: 2794ms para destino JÁ
  IDÊNTICO; 353ms para 0 skills — o "pulo" existia mas o no-op era caro): as camadas
  eram re-varredura de supply-chain por skill a cada 10min de cache, 4 leituras de
  marcador por skill, poda relendo TODOS os marcadores e git rev-parse por sync. Fast
  path novo em skillsLibrary (decisão persistida não-block + avaliador na versão atual
  + marcador id+sha idêntico nos dois destinos = 1 leitura + 1 stat): repetição
  idêntica 2794ms → <1ms; 0 skills → 0,08ms. Divergência QUALQUER cai no caminho
  completo. E a CÓPIA REAL (worktree novo, ~1-4s) saiu do main na mesma data: o
  gitWorker ganhou workspaceSkills+skillPackageSecurity no registry; cópia, poda
  candidata e o scan de supply-chain viajam por gitOff; syncToWorkspace virou async
  (cadeia workspaceSyncChain serializa concorrência — a atomicidade que o sync
  síncrono dava de graça) e TODOS os call sites foram propagados (paneSpec handlers
  async). Mutação de estado da classe fica no main com guarda anti-janela-de-await.
- QUALIDADE NA 1ª PASSADA (a M02c levou 4 ciclos de reprovação; evidência: o dev usou 2
  skills em 52 e nunca rodou o kit de polish; o orquestrador não carimbou skills):
  devContract de front/design agora EXIGE declarar no done quais skills de polish rodou
  ("detail pass: impeccable, …" — done sem a declaração é incompleto); "FIX THE CLASS,
  not the cited examples" no contrato, no prompt-delta e na retriagem do orquestrador;
  create_tasks devolve LEMBRETE quando card front/design nasce sem skills carimbadas.
  CONTRATO MECÂNICO DE DS (P4, mesma data): card front/design STANDARD/DEEP em projeto
  com design language carrega QUEST de auditoria executável — o dev ESCREVE/atualiza
  scripts/design-audit no repo do produto (literais fora de tokens, identifiers no
  idioma errado, contraste, estados faltando — o que o DS tornar checável), RODA antes
  do done e cola a saída no report; o gate CONFIRMA a evidência em vez de caçar
  violação mecânica no olho (persona do orquestrador + devContract).
- EXPORT DE DIAGNÓSTICO COM PERÍODO: retenção segue 14d; o dialog de export pergunta o
  recorte (Hoje default / 3 dias / 7 dias / Tudo) e diagnostics filtra os journals
  diários por nome; manifest registra periodDays.
- INTRO DO ORQUESTRADOR OBRIGATÓRIA E DESAMBIGUADA: a apresentação (2-3 linhas PT-BR,
  goal+escopo) é a PRIMEIRA saída, antes de qualquer tool call (o pane trabalhava mudo);
  o caderno da missão é NOMEADO ("o caderno PLAN.md desta missão ainda não existe —
  normal em missão nova"; nunca "o plano não existe", que soava como briefing perdido).
- MÃOZINHA 🖐 REMOVIDA de todos os indicadores (chrome do pane, badge do card, mapa,
  miniatura) — decisão do usuário; o sinal de atenção segue pela cor/pulso needs-perm e
  Ctrl+Alt+P. Contadores do mapa viraram "N esperando" textual.
- DESCARTADO (decisão do usuário): alavanca de "segurar gate" (hold) — os gates vivos
  cobrem a dor; re-avaliar só se ela voltar.

### F6.14 — bloco 2026-08-12: forense dos "bloqueios de browser" + regras novas do dono (app parado; typecheck 0 · orchestrator-flow 39 · verdict-races 18 · pane-permissions 14 · task-adjustment 11 · phase-skill-prompts 10 · mission-verification 25 · mcp-protocol 5 · mcp-dual-era 32)

- 🔴 BUG RAIZ DOS "DEV DE UI BLOQUEADO POR FALTA DE BROWSER" (2 ocorrências,
  08-11 22:22 e 08-12 15:18, mesmo card): NÃO era processo morrendo — os
  mcp-logs do playwright terminam com browser_close LIMPO nas duas sessões e
  a recusa literal no journal era "report done recusado: este pane de UI não
  tem browser/runtime autorizado". Cadeia: watch do REVIEW nasce com
  browserAvailable=false POR DESENHO → reprovação → retryOrBacklog caminho
  liveDev re-armava o watch do dev com `{...watch}` DO REVIEWER → dev herdava
  o false → done recusado → o próprio texto da recusa mandava "reporte
  bloqueada ambiental" e o dev CONFABULAVA queda de MCP → pane reciclava
  (~20-30min + re-evidência por reprovação de review em card de UI). Fix:
  `devBrowserAvailable` no PhaseWatch — carimbado quando o watch do dev
  nasce, carregado pelos watches de gate e RESTAURADO no re-arm do liveDev
  (fallback true é invariante: dev de UI sem browser nunca passa do próprio
  done). RECLASSIFICAÇÃO: o "playwright MCP caiu 22:22" do handoff de 08-11
  era ESTE bug; de externo genuíno sobrou só o crash do Network Service
  (08-11 15:52). Forense útil: LiveKernelEvent 193 em rajada = WER
  re-tentando relatório antigo a cada boot (ruído); AsusDownloadAgent crasha
  em todo boot (bloatware).
- REVIEWER NÃO LEGISLA (ordem do dono: "revisar a qualidade do código,
  APENAS ISSO"; caso real: reprovou exigindo "migração versionada com
  rollback e backup" que card nenhum pediu): cerca nova na rubrica — "YOU
  REVIEW WHAT WAS DELIVERED, NEVER LEGISLATE WHAT SHOULD EXIST": exigir
  capacidade/infra nova fora do contrato (migração, rollback/backup,
  telemetria, feature flags, resiliência, hardening) NUNCA bloqueia — vira
  sugestão não-bloqueante; item bloqueante desse tipo = falha do gate que o
  orquestrador waiva.
- CARD DE QA NÃO TEM GATE DE QA (ordem do dono: "QA não tem necessidade de
  QA, apenas de code review"): gatesForTask ganhou `department` — test card
  (dept qa) nasce com gates ['review'] por default, INCLUSIVE sob risco alto
  (validateTaskSizing isenta dept qa do piso review+QA); escolha explícita
  continua valendo. E TEST CARD SÓ RODA APÓS O ACEITE DO DONO (caso real
  M09: a suíte re-rodava atrás de cada ajuste visual): persona T8 + lembrete
  no retorno do create_tasks — fica no backlog até o aceite explícito da UI
  coberta; ajustes acumulam e a suíte sincroniza UMA vez ao final.
- stop_task {id, reason} (tool nova, maestro/orquestrador, registrada após o
  corte de catálogo dos gates — ordem do dono: "ele tem que poder fazer o
  que quiser" com os panes da missão): gêmeo do complete_task — PARA a fase
  deliberadamente (pane fechado, worktree/commits/conversa preservados),
  card ao backlog interrompido SEM contar ciclo, evento
  task-stopped-by-authority com reason verbatim; feedback só entra com o
  campo VAZIO (lista de reprovação nunca é sobrescrita); gate parado morre
  SEM veredito (run_task {phase} reabre). Persona: o ciclo de vida dos panes
  da missão é do orquestrador — pedir ao dono para fechar pane é falha.
- TEMA DE FÁBRICA dark-ansi: ensureBypassAccepted também semeia
  `theme: "dark-ansi"` no settings.json do config dir de todo seat claude
  (chave sondada: é onde o picker /theme grava) — SÓ quando ausente, escolha
  do TUI nunca é sobrescrita. Os 3 seats atuais já estavam gravados à mão.
- STDERR DE BROWSER/APP LANÇADO DO SHELL vai para arquivo: o devCdpBlock
  agora instrui `2>.synkora/runtime-stderr.log` — filho herdando o console
  rabiscava a TUI por fora do claude (print real do dono; cosmético).
- Observando (sem fix ainda): "report de segurança recusado: reprovação
  precisa registrar ao menos um achado" 3× em 08-11 — reviewer perde uma
  volta re-enviando com findings.

BLOCO 2 na mesma data ("fechei o app, arruma os dois" — typecheck 0 ·
orchestrator-flow 40 · task-adjustment 11 · verdict-races 18 · mcp-protocol 5
· phase-skill-prompts 10 · mission-verification 25 · pane-permissions 14):

- 🔴 "MENTE FECHADA" DOS GATES MORTA EM TRÊS PONTOS (caso real M09: dono
  mandou "só reviewer, sem QA", orquestrador obedeceu com update_task +
  ownerOrder + gate-owner-waiver auditado, e o QA abriu MESMO ASSIM — ele
  teve que stop_task no gate): (1) advancePhaseInner force-appendava 'qa' em
  card de UI por cima de gates explícitos — agora os gates do card são o
  contrato e card de UI sem QA vira anotação auditada
  (ui-card-without-qa-gate); (2) gatesForTask re-impunha ['review','qa'] em
  card de UI com gates explícitos — morto, escolha explícita vale literal
  (default sem gates segue review+qa); (3) run_task {adjustment} em plano de
  risco ALTO re-carimbava gates ['review','qa'] no card — agora só em modo
  ESTRITO (foi esta linha que recolocou o QA às 17:19, antes do ownerOrder).
  Teste do contrato velho atualizado ao novo.
- RODADA QUICK IMPLEMENTADA (a espec do item 9 do caderno): run_task
  {adjustment} agora É a rodada quick — Task.quickRound carimbado no
  adjustment (true) e zerado em dispatch cheio; viaja no PhaseWatch (spread
  do liveDev/reciclo carrega). Cortes: devContract ganha QUICK ADJUSTMENT
  ROUND (só o delta; typecheck+lint+testes DOS ARQUIVOS TOCADOS — a suíte
  completa fica com a verificação do harness; evidência = o elemento mudado,
  viewports só se o ajuste for de layout; done curto; skills e barra visual
  INTEIRAS); validateGateVerificationEvidence aceita evidência mínima
  (summary+observação+1 surface) em quick; review vira OLHADA-RELÂMPAGO (só
  o diff, aprova salvo bug real, reprovação = lista mínima, minutos); QA
  NUNCA abre em rodada quick (advance filtra 'qa' — o aceite visual é do
  dono que pediu o ajuste). Persona + description do run_task ensinam a
  régua (copy, formatação, máscara, espaçamento, um elemento) e que o dono
  força nos dois sentidos. Meta: máscara de hoje (30+ min) vira ~5-7 min.
- VALIDADO AO VIVO NO MESMO DIA: stop_task usado corretamente pelo
  orquestrador na 1ª ocorrência real (18:03, matou o QA re-imposto citando a
  ordem do dono verbatim); rodada QUICK de ponta a ponta (quickRound: true,
  QA nunca abriu, merge automático na aprovação, 18:50).

BLOCO 3 na mesma noite (o dono, à beira de desistir do Synkora: "não adianta
consertar regra a regra — em que momento o orquestrador vai entender que é
ELE que tá no comando?"; typecheck 0 · as 8 suítes da família verdes):

- 🔴 PERSONA DO ORQUESTRADOR REESCRITA COMANDO-PRIMEIRO (a cirurgia, não o
  remendo — a persona tinha virado constituição de burocrata e ensinava o
  modelo a temer o próprio juízo; caso real: ele PROVOU por bytes que a
  reprovação era falsa e ainda assim rodou rodada-vazia de dev em vez do
  complete_task que ele mesmo citou): seção COMMAND no topo COM PRECEDÊNCIA
  EXPLÍCITA sobre todo o resto ("pipeline é ferramenta SUA, nunca seu
  chefe"; os 3 fracassos: escalar mecânica, esperar permissão que as
  alavancas já dão, queimar rodada em cerimônia); princípio "GATES INFORM
  YOU, THEY NEVER COMMAND YOU — reprovação com todos os itens julgados
  falsos É aprovação com zero achados: complete_task NA HORA, rodada-vazia
  proibida" (vale p/ review E QA); cercas duras SÓ as 3 de verificabilidade
  (evidência nunca fabricada · verificação conjunta · ⇪ do dono); ESCADA DO
  TAMANHO: PEQUENO = O ORQUESTRADOR IMPLEMENTA ELE MESMO no worktree da
  missão (edita, typecheck+lint+testes tocados, commit "ajuste:" imediato —
  branch nunca fica suja —, UM ajudante lê o diff, "pronto, olha aí"; a
  proibição de editar produto MORREU — o que fica proibido é tampering de
  verificação) · MÉDIO = run_task {adjustment} quick · GRANDE = NUNCA vira
  card sozinho: UMA pergunta via ask_user ("card ou eu mesmo faço?") e a
  resposta do dono vale. Contradições removidas do corpo (small-correction
  rule, "you do not implement", acceptance test).
- GATE JULGA-PRIMEIRO na seção de reprovação: verificar claims factuais
  VOCÊ MESMO quando barato (bytes/grep/render); contar sobreviventes; zero
  = complete_task, nunca re-entrega.
- 🔴 MOJIBAKE NO CANAL DE LEITURA DO GATE — SONDADO E CONFIRMADO (a raiz
  das 2 reprovações falsas de "aspas"): Get-Content default do PS 5.1
  decodifica arquivo UTF-8 como ANSI — "1T 2025" com aspas curvas vira
  "â€œ1T 2025â€" e o modelo lê como aspas quebradas (família do mojibake
  GESTÃO/F6.7, agora na leitura do reviewer). Mitigação em rubrica:
  CHARACTER-LEVEL CLAIMS REQUIRE BYTES (reprovar por aspas/traços/encoding
  exige verificação byte-authoritative) + aviso do trap ("conteúdo garbled =
  SEU canal, releia com -Encoding utf8"). Fix definitivo candidato (decisão
  do dono): ACP UTF-8 do Windows (Use Unicode UTF-8 worldwide) — mexe na
  máquina toda.
- MODO LEVE: escolha EXPLÍCITA de gates do orquestrador no update_task vale
  SEM ownerOrder (o piso de risco alto re-carimbava review+qa a cada update
  — o dono teve que repetir a ordem 2× no mesmo dia); auditado
  gates-explicit-light-mode; modo estrito mantém o piso.
- RECONCILIADOR DO BOARD (caso real: merge concluiu o card às 18:50 e o
  board seguiu mostrando "em execução" — push de tasks:changed perdido):
  board ATIVO re-busca as tasks a cada 30s (princípio F6.10: nenhum passo
  depende de entrega única).
- NADA COMMITADO (árvore segue compartilhada com o trabalho de skills).

### F6.13 — TESTE DE MISSÕES rodada 2: o pipeline ficou LIMPO (2026-08-11/12; 4 blocos de fixes; handoff completo em docs/HANDOFF_SESSAO_2026-08-11.md — LER PRIMEIRO)

Sessão inteira de teste ao vivo + 4 blocos com app parado. Placar: 11/18
missões (M06b repaginação, M07 PERDCOMP — a 1ª missão 100% LIMPA da
história — e M08 SPED integradas); M09 créditos 3/3 cards done aguardando
o ⇪ do dono. NADA COMMITADO (árvore compartilhada com o trabalho de
skills). Resumo dos fixes (detalhe e file:line no handoff):

- 🔴 `--disable-slash-commands` REMOVIDO do claudeSkillIsolation
  (panePermissions) — matava /model etc. do DONO em todo pane claude; a
  cerca do agente segue sendo --disallowedTools Skill,Agent,Task. Provado
  por sonda A/B em PTY real (2.1.227).
- 🔴 DELEGATE consertado: runModel volta a ser ID PURO (phaseEngine
  gravava "opus[1m] · max" e o clamp de tier consumia como id → recusa
  100%) + clamp defensivo split(' · ') p/ cards persistidos velhos.
- 🔴 GUARD DA CADEIA no run_task rebaixado para o re-carimbo auditado do
  conclude (plan-execution-head-restamped) — merge manual auditado do
  orquestrador travava card novo e nem reinício resolvia (beco real M09).
- ORDEM DO DONO (memória feedback-panes-vivos-esperando): dev e gate
  NUNCA fecham entre rodadas — vivos esperando, trafega SÓ o delta.
  Validado 3× ao vivo (gate-recycled na MESMA conversa 2×). Ctrl+A custom
  removido (tecla crua; Ctrl+Shift+A = apagar input).
- RESOLUÇÃO DIRETA AUDITADA de conflito MECÂNICO da fila:
  guide_integration_resolution ganhou directResolution (PM resolve na
  branch, harness valida origem limpa+destino contido, re-lacra e drena
  com o aval original — sem card; régua mecânico×semântico na persona).
- Risco por keyword no create_plan virou ANOTAÇÃO auditada em modo leve
  (payments casava prosa do plano mestre num produto tributário).
- Restore de runtime INSTRUMENTADO: skipReason em todo caminho de
  não-ação + evento gate-runtime-restore-skipped (23:04 invalidou com
  culpados 100% na allowlist e não dava para saber por quê).
- UI (agente paralelo): tooltip do host roteado PARA DENTRO da panes view
  (fim do clipe) + snapshot congelado (capturePage) sob popovers do host
  (fim do buraco). Validação visual pendente.
- Resiliência: retry/backoff no reload pós renderer-gone (crash do
  Network Service 15:52 = externo, sem minidump; Defender exclusions).
- VALIDADO EM PRODUÇÃO de carona: complete_task por ordem verbatim,
  record_learnings (estante viva re-escrita), espera = 1 long-poll,
  memória escalável do PM, renascimentos (222k–479k skip), job objects em
  crash sujo (zero órfãos), estratégia de conflito do PM 2×.

### F6.12 — TESTE DE MISSÕES rodada 1 + bloco do FACILITADOR (2026-08-10; typecheck + agregado skills-system + fila/verificação verdes)

Rodada 1 do teste de missões (roteiro do HANDOFF_FASE5): o MOTOR atravessou
dev→review→QA→conflito→estratégia do Maestro→card de sync→gates de ponta a
ponta com zero payload digitado — mas SEIS classes de burocracia do harness
travaram trabalho bom (veredito do dono: "mais atrapalhando que ajudando").
Caderno completo em scratchpad NOTAS_TESTE_MISSOES_2026-08-10.md; bloco
único aplicado com app parado (commits bb79f96 · da46c04 · 95376d1 ·
37a5b2b). PRINCÍPIO REAFIRMADO: guarda protege contra excesso do AGENTE,
nunca conta ação do próprio harness; toda guarda tem rota de saída.

- 🔴 DEADLOCK proporcionalidade × fila MORTO: `isHarnessQueueCard`
  (orchestratorFlow — briefing com marcador `[fila:...]`) tira o card de
  sync criado pela PRÓPRIA FILA da contagem do contrato (create_tasks E
  conclude_plan; caso real: plano de 3 + sync da fila = 4 e o conclude
  recusava com o create_plan congelado pela fila — nó circular sem saída).
- ORQUESTRADOR ALTERA CARD EM ANDAMENTO (ordem do dono): update_task aceita
  patch completo fora do backlog (vale para as fases FUTURAS; aviso honesto
  de que o pane rodando não relê briefing) e a contagem de proporcionalidade
  saiu do UPDATE (ajuste nunca muda contagem — a recusa punia estado
  pré-existente e foi o que deixou o card de sync sem affectsUi → sem CDP).
- VÁLVULA DA FOTOGRAFIA DEFASADA: conclude_plan em plano DONE com
  verification.final.head ≠ head atual REABRE o plano SÓ para a verificação
  conjunta re-rodar no head novo e fechar sozinha (evento
  plan-reverify-reopened com o range fora-da-cadeia auditado). Era o beco do
  "revalide a fotografia atual" sem ferramenta (caso M05: commit de runtime
  do teste de aceite moveu o head).
- ⇪ BLOQUEADO NUNCA É MUDO: todo retorno bloqueante do
  startMissionIntegration audita `queue/mission-integrate-blocked` e, em
  clique do DONO, manda o motivo+receita ao orquestrador (evento urgente).
  pendingIntegrationApproval só limpa quando o clique ATRAVESSA as checagens
  (o clear precoce matava a pulsação com o clique bloqueado). A PORTEIRA só
  anuncia "PRONTA" com fotografia PROVADA (árvore limpa + head==verificação)
  — agente com foto defasada recebe a receita da válvula em vez de pulsar um
  botão que ia falhar.
- 📬 NUDGE SÓ ACORDA PANE PARADO: nudgeMailbox ganhou o degrau que faltava
  (ptys.isIdle 2,5s + composer; re-checa a cada 5s até aquietar, teto
  ~10min) — 3 casos ao vivo de nudge digitado em pane EM TURNO (Maestro
  trabalhando, gate recém-reportado, QA na janela read-first = gatilho exato
  do CHECK 14). Texto anti-stale ("veio vazia = já chegou de carona").
- FIM DO LOOP DE 45s NA ESPERA DE GATE (crítica do dono: "~80
  inferências/hora gastando contexto à toa"): toda a doutrina de espera
  (idleWaiterHint codex, atomicRoundRule, mensagem do gate vivo, description
  e resposta-vazia do check_messages, advisor de helpers) virou "UMA chamada
  de ~45s e ENCERRE O TURNO — parado custa zero; o app acorda com a linha 📬"
  (que agora só dispara em pane ocioso = o despertador correto). Claude
  segue com o waiter de background. Pendente: sonda de long-poll mais longo
  no codex (tool_timeout_sec=300 já provado na W4).
- RECICLO DE GATE VIVO INSTRUMENTADO: os dois fallbacks silenciosos
  (renovação de skills falhou · range do delta inválido — candidato:
  amend/rebase do dev tornando o head reprovado inalcançável) agora gravam
  `live-gate-recycle-fallback` com a causa; na ocorrência real de 14:29 o
  gate em espera foi morto e um fresco nasceu sem o journal dizer por quê.
- QA-CDP INDEPENDE DE CLASSIFICAÇÃO DE UI: reserva de porta CDP acontece
  para QUALQUER card de QA em worktree cujo runtime script é Electron (card
  BACK de sync ficou sem reserva e o QA navegou a URL do vite — o duplo de
  bridge que a F4 veio matar).
- securityReview FORA DE LUGAR não derruba mais o report inteiro: campo
  descartado com auditoria (security-review-field-dropped) e o done processa
  (o dev perdeu uma rodada re-enviando o MESMO conteúdo).
- VARREDURA "mente fechada" (pedido do dono) — recomendações ABERTAS, não
  implementadas: (1) tool/botão de SAIR DA FILA para ticket não-merging
  (hoje só arquivando a missão); (2) par "risco subiu no ajuste" ×
  "create_plan congelado na fila" ainda é beco em modo estrito; (3) card no
  PRODUTO PAINEL: runtime data fora de caminho rastreado (a classe-raiz da
  fotografia defasada; persona greenfield nova já cobre produtos futuros).
- PÓS-BOOT deste bloco: plano da M03 pode estar pausado (re-aprovar no
  board) → orquestrador chama conclude_plan (agora passa com o card da
  fila) → verificação conjunta → fila drena Empresas e Notas; M05 destrava
  com conclude_plan (válvula da fotografia) → ⇪.

BLOCO 2 na mesma data (65474cc, "dá mais poder ao orquestrador" — ordem do
dono; princípio gravado em memória: guarda dura SÓ protege AUTORIDADE/
VERIFICABILIDADE, guarda de JULGAMENTO vira advisory auditado):
- T9 RUNTIME DECLARADO SOBREVIVE AO GATE (loop real de 4 ciclos na fila da
  Notas: QA aprovou no MÉRITO 2× e o veredito era descartado porque RODAR o
  app sujava data/* rastreado — gate read-only não limpa): tool nova
  `declare_runtime_paths` (maestro/orquestrador; allowlist por projeto em
  maestroStore.runtimePaths) + `restoreRuntimeAndRevalidate` (worktree, via
  gitWorker) no veredito — divergência composta SÓ de modificação NÃO-staged
  dentro da allowlist é restaurada ao commit julgado e revalidada (evento
  gate-runtime-dirt-restored). Restaurar ≠ aceitar: staged/deleção/fora da
  lista invalida integral (cerca contra gate-que-edita intacta); a mensagem
  de invalidação carrega a receita. Correção definitiva segue sendo card no
  produto (runtime fora de caminho rastreado).
- T10 ORDEM DO DONO TEM CANAL: update_task aceita `ownerOrder` verbatim
  (padrão set_phase_executor) — com ele, mudança de gates passa por cima dos
  pisos de risco (evento gate-owner-waiver; caso real: dono respondeu no
  ask_user "tira o QA deste card" e o motor recusou a decisão dele).
- REBAIXAMENTO: risco elevado em AJUSTE vira anotação auditada
  (risk-raise-annotated) em modo leve — recusa só no modo estrito.
- T8 TESTES AUTOMATIZADOS SÃO CARDS DE QA (prática profissional do dono:
  "quem escreve teste é QA — dev escrevendo valida a própria função
  quebrada"): persona do orquestrador pareia card de feature com TEST CARD
  de dept qa cujo executor escreve specs A PARTIR DOS CRITÉRIOS DE ACEITE,
  nunca da implementação; casca greenfield ganha item (d) harness e2e desde
  o dia um; prompt do gate de QA trata suíte verde (rodada pelo harness) como
  PISO DE REGRESSÃO e RECEITA specs faltantes em vez de re-testar na mão.
- Verdes: typecheck 0 · agregado skills-system 11 suítes 0 falhas ·
  mcp-protocol 5 · mission-worktree 29 · phase-verdict-races 18 ·
  task-adjustment 11 · qa-cdp 10 · mailbox-delivery 10.
- AO VIVO pós-boot 2: o orquestrador da Notas pode destravar o loop na hora
  com declare_runtime_paths(["data"]) — a receita chega sozinha na próxima
  invalidação.

BLOCO 3 na mesma data (26b4e30, meta /goal do dono: "só termina quando o
orquestrador e o maestro tiverem AUTONOMIA" — depois de um dev inteiro
queimado só p/ re-carimbar fotografia com finalize/reabrir-gate/adjustment
TODOS recusando; fim dos remendos, UMA primitiva de autoridade):
- `complete_task {id, reason}` (maestro/orquestrador; registrada DEPOIS do
  corte de catálogo dos gates — gate read-only nem VÊ a ferramenta): conclui
  card AUTO direto por juízo do orquestrador; o motor encerra panes/watch/
  gate-waits/runtime do card, marca done e grava gates faltantes como
  verdict 'waived' com o motivo VERBATIM (evento task-completed-by-authority)
  — juízo registrado, nunca evidência fabricada. conclude_plan aceita
  'waived'; cercas restantes = verificação conjunta + ⇪ do dono. As duas
  portas trancadas ("fase rodando"/"não está em finalização") agora apontam
  a receita do complete_task.
- restoreRuntimeAndRevalidate cobre também '??' (arquivo de runtime que
  NASCE no primeiro uso — achado AO VIVO pelo orquestrador: data/notes.json
  continuava derrubando veredito; combo modificado+novo resolve numa
  passada; remoção recursiva p/ diretório novo).
- Persona do orquestrador: YOUR AUTHORITY OVER YOUR OWN CARDS (primeira
  alavanca quando o motor não tem porta p/ um estado que ele já sabe ser
  verdadeiro; escalar mecânica ao dono é falha).
- Verdes: typecheck 0 · agregado 12 suítes (incl. mcp-dual-era: a cerca de
  catálogo dos gates PEGOU a 1ª tentativa de registro na zona errada — o
  teste salvou a invariante) · mission-worktree 29 · mission-verification 25
  · integration-queue 14 · phase-verdict-races 18 · mcp-protocol 5.
- ADENDO (b94fbf2, mesma noite): a isenção do card da fila por MARCADOR de
  briefing morreu quando um orquestrador reescreveu o briefing (a liberdade
  de update do bloco 1 apagou a placa do bloco 1 — deadlock ressuscitou com
  entrega JÁ mesclada e verde). Identidade agora é CAMPO persistente
  `Task.queueSync` (carimbado pela fila) + fallback estrutural p/ cards
  legados (plano COM grafo: card auto sem planItemId só o harness cria — o
  card travado da M06 conclui sem apagar nada). complete_task
  documenta que NÃO mescla a branch task/<id8> (o merge é do orquestrador —
  furo achado ao vivo por ele).

BLOCO 4 na mesma noite (8483b8d..cab38b2 + clamp não-commitado — HANDOFF
completo da sessão em docs/HANDOFF_SESSAO_2026-08-10.md; o dono deu /clear):
- 8483b8d: reparo de boot da fila pela identidade PERSISTENTE (fim da
  fábrica de FANTASMAS — cada boot criava sync duplicado quando o briefing
  perdia o marcador) + autocura remove fantasmas existentes
  (queue-sync-ghost-removed) + guarda da "cadeia reconhecida" no conclude
  virou re-carimbo auditado (plan-execution-head-restamped — merge manual
  do orquestrador é legítimo; a cerca é a verificação conjunta).
- d534d4b: DEV dirige o app Electron REAL via CDP (mesma reserva do card;
  prompt com a receita --remote-debugging-port); Ctrl+A = SELECIONAR tudo
  (Ctrl+C copia); apagar-input virou Ctrl+Shift+A.
- 7646928: memória ESCALÁVEL do Maestro — fato duro nunca é prosa (sempre
  board_status/git antes de afirmar); MAESTRO.md = ÍNDICE ≤~120 linhas;
  tópicos destilados ≤200 linhas em .synkora/maestro/ sob demanda;
  manutenção = reescrever menor, nunca anexar.
- df11983 + cab38b2: AJUDANTES DE VOLTA com régua QUALIDADE-PRIMEIRO — teto
  F6.2 restaurado (fast 0 · standard 2 · deep 4; um corte posterior tinha
  deixado tudo em 1 e o dev Opus-max fazia tela de 50min sozinho); delegar
  SÓ trabalho longo (~30min+ solo); ajudante CLONA o dev (mesmo modelo,
  MESMO effort, skills do bloco via delegate.skills); dev integra e ASSINA.
- CLAMP MECÂNICO do tier em mcpApi/helpers.ts (delegate sobrescreve
  modelo/effort do ajudante de dev para os do delegador, com aviso) ficou
  NÃO-COMMITADO de propósito: o arquivo carrega WIP de OUTRO agente (área
  de skills) — quem fechar aquele trabalho commita junto; nunca reverter
  helpers.ts sem preservar o clamp.

### F6.11 — FASES 3 e 4 do nível 5 CONCLUÍDAS (2026-08-08; typecheck + 22 suítes verdes; BOOT AO VIVO VALIDADO 2026-08-10 — falta o teste de missões)

Ordem do dono: FASE 3 → FASE 4 → teste de missão → push. Docs:
docs/FASE3_PLANO.md (plano formal + estado) e PLANO_NIVEL_5 (estados).

- **FASE 3 (multi-renderer, CHECK 2)**: o canvas de Panes saiu do renderer da
  janela para uma **WebContentsView própria** (`?view=panes`, mesmo bundle/
  preload — padrão dos overlays; `src/main/panesView.ts` novo, criação lazy
  com pré-aquecimento). O HOST é a view "board" (titlebar/rail/Home/Board/
  Versões/Arquivos); a view é dona da MONTAGEM dos panes de execução (o
  unicast por webContents do PtyManager divide o parse dos pty:data de graça)
  e o host mantém a lista como ESPELHO pelos mesmos eventos broadcast.
  Costura de push: `ctx.pushBoard/pushPanes/pushAll` REAIS (o ctx.push morto
  virou família; ~60 sites migrados por classificação canal→destino; os 45
  `bindUiSender(e.sender)` oportunistas morreram — o did-finish-load já
  cobria); canais de CHROME (panes:stats, pane:lastlines, pty:effort/model,
  tasks:attention, seats:changed, panes:closeById) saíram do sender capturado
  do pty para broadcast (pty:data/exit/reset seguem unicast POR CONTRATO).
  Nascimento/fecho de pane SEMPRE via evento do main (panes:open-free,
  panes:requestClose→terminatePaneNow). Esconder a view = `setVisible(false)`
  (sonda probe-webcontentsview-hidden: layout/rAF vivos = keepalive intacto;
  removeChildView MATA o rAF — nunca usar com pane vivo); `panes-view:shown`
  pausa o rAF decorativo do mapa. Overlays globais do host (popovers da
  titlebar, menu ✦ Agente, SeatGate, FreeAgentModal, SynVoice panel)
  escondem a view enquanto abertos (child view compõe POR CIMA do host —
  hostOverlayCount). Costuras cross-view via main: files:navigate (link .md
  → aba Arquivos), mapa→board, panes:activity, attention-cleared,
  settings:changed (zoom de fonte vale nas duas), ditado SynVoice no canvas
  (foco registrado no main, válido só com a view VISÍVEL; paste resolvido
  pelo registry local da view; banquinho já cobria perda). Segurança:
  trustedRendererView +'panes'; permission handlers por MEMBERSHIP (host =
  clipboard+mic; view = só clipboard); settings:get/set aceitam a view
  (assertAppRendererSender); asserts de voice/serviços/secrets continuam
  host-only. Driver E2E exclui `?view=` do target CDP. WEBGL_BUDGET=12 fica:
  o teto do Chromium é POR PROCESSO (16/view, sonda 2026-08-06).
- **FASE 4 (QA de Electron via CDP — mata o duplo de bridge)**: feita por
  agente Fable 5 em worktree isolado e mergeada (792e73a). `src/main/qaCdp.ts`
  novo: porta CDP reservada POR CARD em preparePhasePane (ANTES do armPane —
  o pane de QA nasce com `--cdp-endpoint` selado nos args do playwright;
  startQaRuntime consulta o MESMO registro e sobe o app com
  `--remote-debugging-port`); electron-vite recebe env REMOTE_DEBUGGING_PORT
  + argv `-- -- --remote-debugging-port=N`; prontidão = linha "DevTools
  listening" COMPLETA com o uuid (nunca a URL do vite; porta anunciada ≠
  reservada falha ALTO); decorador único `decorateBrowserLaunchArgs` nos
  DOIS gravadores de config do playwright (corrigiu de quebra o --output-dir
  dropado no re-grave anti-corrida do pty:create); prompts do QA em modo CDP
  (app REAL com preload/IPC verdadeiros; NÃO navegar URL; stop ao fim da
  rodada — browser.close só desconecta); guardião de job objects já cobria a
  árvore. Sondas probe-electron-cdp 4/4 + probe-electron-vite-cdp 4/4;
  suíte test:qa-cdp 10.
- BOOT AO VIVO VALIDADO (2026-08-10): `npm run dev` do dono funcionando;
  journal panes-view-created → sender-bound → ready limpos; sobrou o stall
  de PARTIDA conhecido (~2,4s, família Fase 0 rodada 2, pré-view).
- PRÓXIMO: **TESTE DE MISSÕES** (roteiro completo em docs/HANDOFF_FASE5.md
  — F5 zero-digitação + F3 view sob carga + F4 QA-CDP + skills receipts +
  validações F6.9 de carona) → PUSH → instalador novo. Worktrees de agente
  em .claude/worktrees/ NÃO remover sem checar junctions (lição
  feedback-worktree-junction).

### F6.10b — CHECK 14 com causa PROVADA por sonda + FIX APLICADO (2026-08-07 tarde; typecheck + orchestrator-flow 35/35 verdes)

Sessão dos níveis 4/5 do handoff (docs/HANDOFF_NIVEIS_4_5.md tem o desfecho
completo). Sonda probe-claude-qa-resume-mcp.mjs, 10 runs contra servidor MCP
fake com log de requests, spawn EXATO do pane QA (PowerShell -EncodedCommand,
env limpo, flags reais):

- CAUSA RAIZ (validada na 2.1.224): o claude monta o catálogo de tools POR
  REQUEST, e o request 1 do turno sai ANTES do handshake MCP quando o prompt
  inicial viaja no ARGV (initialPrompt = argumento posicional — o turno
  começa no instante zero do processo). Servidor que completa o handshake
  DEPOIS não entra no turno em andamento: R10 reproduziu NO-TOOL com
  tools/list SERVIDO (a assinatura exata do catalog-served × "No such tool
  available" do journal). Com delay >10s o cliente desiste do servidor de vez
  (tools/list nunca mais é pedido), sem aviso nenhum.
- Por que 8/8 RESUMADOS × 0 frescos: o prompt-delta curto dos resumados
  (F6.8i) vai inline e o modelo — que CONHECE runtime_control pela conversa
  carregada — a chama no request 1; o fresco recebe briefing POR ARQUIVO,
  o Read builtin consome o request 1 e o catálogo entra no request seguinte
  (proteção acidental que sempre nos salvou). A data do 1º caso (00:42Z de
  07/08, horas após a F6.8i) bate com o prompt-delta, não com o update
  2.1.220→2.1.224 — NÃO é regressão de versão; pin no cliUpdate descartado.
- FIX APLICADO (mesma data, janela de quit-clean do dono): em
  preparePhasePane (logo antes do spec), prompt de RESUME vai por arquivo
  (.synkora/prompt-resume-<paneId>.md, com BOM) e o initialPrompt vira a
  instrução read-first ("open and read the file X before anything else; do
  not call any mcp__* tool before finishing the read") + evento blackbox
  resume-prompt-via-file. NUNCA voltar a mandar prompt de resume inline.
  Validar ao vivo no próximo resume de fase (o evento novo no journal + a
  tool funcionando no turno 1). Issue upstream: draft em
  docs/ISSUE_DRAFT_claude-code_mcp-first-turn.md (o dono decide postar).
  Bônus da sonda: o claude 2.1.224 pede protocolVersion MCP 2025-11-25 e
  REJEITA 2026-07-28 oferecida pelo servidor (R11: initialize respondido com
  a spec nova → cliente para o handshake, nenhum tools/list; a string
  "2026-07-28" no binário é código em preparação, não suporte). codex
  0.147.0: flag mcp_2026_07_28 presente, desligada de fábrica — ligável por
  pane via settings.mcpProtocolMode='modern-experimental' (--enable). O lado
  servidor já é dual-era; re-sondar a cada update de CLI.
- FASE 0 DO NÍVEL 5 LIGADA (mesma data, janela de app fechado; typecheck +
  8+35+25 asserções verdes): `stallAttribution.ts` NOVO (módulo puro, suíte
  test:stall-attribution) + ligamento no index — instrumentIpcMain cobre os
  ~120 handlers IPC (`ipc:<canal>`), o watchdog anexa `culprits` ao
  event-loop-stall, wrappers finos (padrão wrapper→Inner) em
  preparePhasePane/advancePhase (contrato SYNC do veredito intacto)/
  completeMissionMerge/syncBoard e toda tool MCP vira `mcp:<tool>`. A partir
  do próximo boot, TODA travada do main nomeia os culpados; ler com
  `node scripts/bbwatch.mjs --grep stall`. Um dia de uso do dono = ranking
  que decide o corte das Fases 1–2. RODADA 2 (mesma data): 1º boot medido
  deu culprits VAZIO no stall de boot (~1,9s aos 3s, 0 panes) = culpado no
  caminho de PARTIDA, fora do instrumentado — entraram boot:stores/
  boot:project-sweep/boot:createWindow/boot:progressSnapshot/
  boot:cli-skills-kickoff e o limiar do watchdog caiu 1000→500ms (as
  travadinhas médias de clique viram dado). Vazio de novo no próximo boot =
  overhead de dev/GC por eliminação.
- ORDEM NOVA DO DONO (2026-08-07, memória
  feedback-zero-digitacao-entre-agentes): NENHUMA comunicação entre agentes
  por texto digitado + Enter — correio MCP até F3 (digitação de payload vira
  anomalia). Entrou como Fase 5 do plano do nível 5 (docs/PLANO_NIVEL_5.md);
  pré-condição segue sendo validar o F1 ao vivo. O "acordar pane ocioso sem
  input" foi SONDADO na mesma data (ideia do próprio dono; R12/R13 da mesma
  probe): (1) WAITER em background para pane com shell — o CLI acorda o
  agente parado quando a background task termina (R12: WAITING → 25s → 
  WOKE-UP com ZERO digitação); (2) LONG-POLL na tool check_messages para
  gates read-only — tool call segurada 45s sem timeout no perfil exato do
  gate (R13). Digitação vira último recurso auditado; sondar o equivalente
  codex antes de generalizar.
- NÍVEL 5: plano formal em docs/PLANO_NIVEL_5.md aguardando aprovação — os
  travamentos que o dono relatou ao vivo (abrir projeto + clicar missões,
  JÁ com o escalonador F6.10 ativo) são o CHECK 1/2/13; a Fase 0 do plano é
  instrumentação de ATRIBUIÇÃO de stall (o event-loop-stall de hoje não
  nomeia o culpado).

### F6.10 — CORREIO MCP + reconciliador + blindagem do canal (2026-08-07 noite; app parado; typecheck + 122 asserções verdes)

Ordem do dono ("níveis 1-3; handoff dos 4-5 em docs/HANDOFF_NIVEIS_4_5.md"),
após a Onda 3 fechar 4/4 missões. Princípio novo DE PROJETO (palavras dele:
"imagina se eu durmo e volto e não rodou nada porque uma mensagem se perdeu
— NÃO PODE"): NENHUM passo do pipeline depende de entrega única — ou a
mensagem é DURÁVEL com recibo, ou a ação é RE-DERIVÁVEL do estado e um
reconciliador a re-executa.

- CORREIO MCP F1 (CHECK 15 — "panes conversam sem digitar e dar Enter"):
  mailbox.ts novo — caixa postal DURÁVEL por endereço estável
  (task:<id>:<role> p/ fases/gates — sobrevive a paneId novo; pane:<id> p/
  maestro/helpers) em userData/mailboxes.json (jsonStore, poda 7d, cap 60).
  A costura é UM seam: o deps.inject do hub — pane com identidade MCP tem o
  payload POSTADO no correio + UMA linha curta de aviso no terminal
  ("📬 … chame check_messages", throttle 20s/pane); pane sem identidade
  segue na injeção clássica. ENTREGA DE CARONA: o monkey-patch do
  registerTool no buildServer embrulha TODO handler — resultado de tool
  ganha o bloco "[synkora inbox]" com as mensagens pendentes (exceções:
  check_messages e report — o silêncio pós-veredito dos gates fica
  intacto). Tool nova check_messages (TODAS as roles; entrou em
  SYNKORA_READ_ONLY_GATE_TOOLS + allowedTools claude + teste do catálogo).
  Recibos na caixa-preta: mailbox-post / mailbox-delivered (carona|check).
  Dedup F1 por texto idêntico não-entregue; correlationId fim-a-fim é F2.
  Personas (dev contract, atomicRoundRule dos gates, PM, orquestrador):
  "seu correio chega nos resultados das tools".
- RECONCILIADOR DE PANE PERDIDO (CHECK 17): panes:open era fire-and-forget
  — perdido (caso real 17:03Z: uiSender sequestrado), o pipeline INTEIRO
  esperou 11min30s em silêncio um pane que nunca nasceu. O poller de 3s
  ganhou a regra: fase pending com paneId armado e SEM PTY além da graça de
  30s → evento pane-open-lost + re-preparePhasePane sozinho (teto 1
  tentativa/2min; falha restaura o watch). Perder push custa segundos.
- uiSender BLINDADO (CHECK 17): bindUiSender substitui os 49
  `uiSender = e.sender` — só o webContents da JANELA PRINCIPAL amarra o
  canal; overlay/janela auxiliar é recusado com evento
  ui-sender-rebind-refused (1x por webContents) e troca legítima loga
  ui-sender-rebound.
- FIM DO AVISO DUPLO: invalidação de fotografia virou quiet — a injeção
  acionável é só a do retryOrBacklog (PASSO 1/2).
- FOTOGRAFIA NOMEIA OS CULPADOS (CHECK 16): snapshotProblemFor lista os
  arquivos sujos (git status --porcelain, 6 primeiros) no motivo — tracked
  sujo por migração × evidência untracked se distinguem de primeira; e a
  persona greenfield ganhou o 3º item da casca testável: DADOS DE RUNTIME
  NUNCA em caminho rastreado (migração no boot invalidou veredito 2x).
- ESCALONADOR DE SPAWN: maestro/missions:paneSpec espaçados ~350ms — fim da
  rajada "4 claudes no mesmo segundo + stall de 2,1s" na abertura do
  projeto.
- GUARDA DE PATH (CHECK 12): projects:create recusa path não-absoluto
  (barras comidas por escape) e path dentro do diretório do próprio Synkora
  — a pasta fantasma "UsersErick.synkora-e2ep1" não nasce de novo.
- Higiene: qa-runtime-harness-start (a rede de segurança do QA resumado
  deixou de ser cega); noteCatalogServed/drainInboxFor fora do proxy de
  tool-call (o triplo log morreu). CHECK 11 já tinha sido resolvido em
  sessão paralela (bundledSkillRevision.ts: sha por conteúdo + reinstala no
  boot + skillsRouting com a régua obrigatória).
- SONDA POSITIVA CHECK 7c: @playwright/mcp tem --cdp-endpoint — QA de
  Electron com app real via CDP é implementável; ficou no handoff.

### F6.9 — bloco de correções pós-Onda-3 (2026-08-07 manhã; app parado; typecheck + 98 asserções verdes)

Aplicado de uma vez após a 1ª noite de missões PARALELAS (4 missões, dono
ausente; caderno completo em scratchpad NOTAS_TESTE_2026-08-06_onda3.md):

- 🔴 PORTEIRA MECÂNICA DE INTEGRAÇÃO (caso real: o PM integrou a M04 na
  V1.0 18min depois de perguntar via ask_user e SEM resposta — "quem escolhe
  sou eu"; persona provou não ser cerca): integrate_mission/queue_missions
  de AGENTE nunca mergeiam — com a missão validada, registram
  Mission.pendingIntegrationApproval, o botão ⇪ vira "aprovar integração"
  pulsando (aba com glifo ⇪ idem) e SÓ o clique do dono (actor 'user')
  enfileira. Description da tool + personas: ausência NUNCA é consentimento.
- PRÉ-TRUST CLAUDE EM TODO PANE (QA nasceu PRESO no "trust this folder": o
  ensureBypassAccepted só rodava com accessProfile 'write' — gate read-only
  nunca ganhava a entrada; dev codex + QA claude no mesmo worktree era o
  caso descoberto): todo pane claude pré-grava trust do cwd E do root do
  projeto em UTF-8 correto (a entrada mojibake "GESTÃƒO" nunca casava). O
  paliativo trust-guardian.cjs da sessão fica aposentado por este fix.
- set_phase_executor (tool nova, maestro/orquestrador): troca seat/modelo/
  effort de fase POR ORDEM EXPLÍCITA do dono — live ou DEIXADA COM
  ANTECEDÊNCIA ("quando o QA abrir, roda na Gmail"); ownerOrder verbatim
  auditado; sem ordem a tool RECUSA (limite estourado = ask_user). Corpo
  compartilhado com o ⇄ (setPhaseExecutorImpl): transplante/resume/carimbo
  idênticos.
- GATES — A PRÓPRIA RECEITA VINCULA (caso real M06: reviewer receitou o
  valor exato no ciclo 2, dev obedeceu, ciclo 3 reabriu com régua mais
  funda): "YOUR OWN PRESCRIPTIONS BIND YOU" no atomicRoundRule (a lista só
  ENCOLHE; reabrir item feito-conforme-receita = falha do gate) + TOM seco e
  neutro obrigatório; o evento de reprovação manda o orquestrador WAIVAR
  autocontradição do gate na hora, sem consultar o dono.
- QA DE PRODUTO ELECTRON SEM PRELOAD (o QA da onda diagnosticou sozinho e
  montou duplo do IPC — virou instrução): playbook no prompt do QA (browser
  não tem window.api → estado de erro é AMBIENTE; usar devMock do produto ou
  montar duplo fiel via playwright lendo main/preload, sem tocar em arquivo);
  persona PM greenfield: casca Electron nasce com PORT por env + devMock do
  bridge ("casca testável" é parte do produto).
- synkora-frontend-standard — 1ª SKILL EMBUTIDA do app (ordem do dono:
  "frontend perfeito SEMPRE; dev e QA não veem desarmonia; skills não
  usadas"): skillsBundled.ts + installMany gravando SKILL.md p/ kind skill +
  auto-install no boot (sem rede). Régua única destilada da curadoria
  (espaçamento NA ESCALA, alinhamento, tipografia/tabular-nums, contraste,
  estados completos, harmonia/identidade, 2 viewports, evidência específica;
  depts front/design/qa). INVOCAÇÃO OBRIGATÓRIA NOMEADA: dev front/design
  declara "synkora-frontend-standard: <seções> · <n> ajustes" no done e o QA
  de UI declara a auditoria no report — sem a linha, done/report incompleto.
  Exceção CONSCIENTE ao "fim das ★" (menu livre virou não-uso), SÓ p/ front.
- PORTA PINADA (colisões QA×QA e dono×QA na 5174 do produto): o erro do
  qaRuntime nomeia QUEM segura a porta (runtime irmão + URL); a nota do
  servidor de teste avisa ANTES do crash; produto ATUAL ainda precisa do
  card "PORT por env" (1º da fila; a persona greenfield mata a classe nos
  próximos produtos).
- spawn EPERM transitório (esbuild/vitest recém-gravados + AV): a
  verificação re-tenta UMA vez após 3s quando a falha contém "spawn EPERM".
- npm ci SERIALIZADO (parte segura do CHECK 1): ensureVerificationBootstrap
  roda UM por vez — 4 concorrentes saturavam o disco nas janelas exatas das
  congeladas da UI.
- bbwatch escolhe o journal MAIS NOVO por nome (era data LOCAL — mudo da
  virada UTC até meia-noite local).
- PACOTE DA PORTA APLICADO (2026-08-07 tarde, 2ª janela parada; typecheck +
  50 asserções verdes): decisão do dono — "não tem que engessar sempre em
  uma". (1) `portMap.ts` NOVO (módulo puro — regra do código limpo): mapa
  humano das portas em uso pelo PRÓPRIO harness (runtime de QA = porta REAL
  parseada da URL anunciada; servidor de teste = porta PEDIDA com flag
  honesto). (2) QA nasce SABENDO O MAPA: qaRuntimeBlock lista as portas em
  uso e o dono de cada uma — escolhe livre de primeira. (3) Modal do
  ▶ testar mostra o MESMO mapa (IPC panes:portsInUse). (4) ▶ testar de
  produto Electron agora ENVIA a porta escolhida via PORT no env (o ramo
  electron do portInvocation devolvia prefixo VAZIO — o modal era mudo
  mesmo com produto PORT-aware; nota honesta nova). (5) CAÇA AUTOMÁTICA:
  startQaRuntime re-tenta sozinho com porta LIVRE do SO (bind de teste) até
  2× na falha "Port X is already in use" — strictPort pinado continua
  falhando idêntico (o erro nomeando o dono da porta + bloqueada seguem o
  desfecho certo até o card PORT-aware do produto integrar).
- 🔴 CHECK 14 BLINDADO (2026-08-07, 3ª janela; typecheck + 55 asserções):
  QA claude RESUMADO nasce SEM a tool runtime_control ("No such tool
  available") com report/browser funcionando — forense do journal: 8/8
  panes resumados sem a tool, TODOS os frescos com ela, desde o 1º resume
  (00:42Z, PRÉ-F6.9); identidade role=qa idêntica nos dois ⇒ o servidor
  serve o mesmo catálogo ⇒ perda é do LADO CLIENTE no --resume (variante
  claude da armadilha codex-resume-sem-MCP; causa exata pendente da sonda
  probe-claude-qa-resume-mcp.md). Blindagem tripla: (1) REDE DE SEGURANÇA —
  preparePhasePane de QA front/design RESUMADO sobe o runtime pelo HARNESS
  e entrega a URL no prompt (caminho fresco segue self-service, decisão
  F6.8h intacta); (2) INSTRUMENTAÇÃO mcp/catalog-served na caixa-preta
  (buildServer coleciona os nomes registrados e o app loga com dedupe por
  pane — mudança de catálogo é o alarme; na próxima ocorrência o journal
  prova sozinho servidor×cliente); (3) DEFESA — cacheHints de tools/list
  (TTL 5min, spec 2026-07-28) REMOVIDOS do buildServer: nenhum cliente
  validado os usava e um claude recém-atualizado honrando cache de catálogo
  é gatilho plausível; só re-anunciar com sonda.
- PENDENTE — SESSÃO DEDICADA DE DESEMPENHO (nunca meio-fazer): CHECK 1
  núcleo — tirar a barreira síncrona do veredito do main preservando a
  fotografia atômica (4/4 stalls de 1,2-2,1s medidos em done→review, cresce
  com a carga); CHECK 2 — split multi-renderer via WebContentsView (SONDA
  POSITIVA 2026-08-06: PIDs distintos, 16 contextos WebGL POR view,
  ~107MB/view — probe-webcontentsview-webgl.cjs) + pool WebGL por
  visibilidade como complemento.

### F6.8l — HANDOFF pós-clear (2026-08-06, noite): PRÓXIMO PASSO = rodar a Onda 3 com o radar novo — LER PRIMEIRO

Sessão encerrada por /clear do dono com TUDO aplicado e verde (typecheck +
~130 asserções nas suítes). O app estava aberto no terminal do dono e já
rebootou com o código novo (boot 21:13 local no journal). O que a PRÓXIMA
SESSÃO faz, na ordem:

1. SUBIR A CAIXA-PRETA: o monitor agora é PERMANENTE em `scripts/bbwatch.mjs`
   (traduz o journal em linhas humanas; `node scripts/bbwatch.mjs --follow`
   em background, `--since N` minutos, `--grep texto`). Rodar como monitor
   padrão da sessão de teste e NARRAR marcos sem ser pedido (disciplina
   F6.8g).
2. ONDA 3: o dono vai responder/autorizar com o PM na aba ✦ geral (a pergunta
   antiga "autorizo abrir a Onda 3? (6 missões em paralelo: empresas,
   assinantes, tarefas, notas, extrator PERDCOMP, extrator SPED)" EVAPOROU no
   binário antigo — ele responde direto; a próxima missão indicada do plano
   mestre é a M03-empresas). Perguntas novas agora PERSISTEM.
3. VALIDAR AO VIVO na primeira missão da onda (nada disso rodou em produção
   ainda): radar detalhado (status_note aparecendo por agente + pills +
   frescor + pergunta no radar), sons (plim de pergunta; blips reviewer/QA/
   integração), atenção multi-nível (rail + abas), teto de resume do PM/
   orquestrador (maestro-resume-skipped-cost + caderno MAESTRO.md nascendo),
   ask_user persistido (user-questions.json), anti-ressurreição na PRÓXIMA
   integração (orchestrator-respawn-refused-integration-in-flight), guardião
   cobrindo o runtime do QA, banquinho do SynVoice (titlebar + mini
   destacado). Anotar tropeços no caderno e aplicar em bloco único.
4. REGRAS DE SESSÃO VIVA continuam absolutas: app SÓ no terminal do dono;
   missão viva = monitor+caderno (não editar src — electron-vite relança o
   app); processo suspeito = evidência ao dono, nunca kill; subagentes SÓ com
   aval explícito (memória feedback-subagentes-so-com-aval).
5. Referências desta rodada: docs/MAPA_RETOMADA_2026-08-06.md (item 22, tudo
   verde) e os blocos F6.8k/F6.8j abaixo.

### F6.8k — sessão de 2026-08-06 (madrugada seguinte): reparo da M02d VALIDADO + 2 fixes 🔴 + memória barata do PM/orquestrador + MAPA DE RETOMADA entregue

Tudo aplicado com o app PARADO (typecheck + 85 asserções verdes: orchestrator-
flow 35, mission-verification 25, integration-queue 14, pane-permissions 11).
As mudanças de main entram no PRÓXIMO `npm run dev` (electron-vite compila do
fonte no launch).

- ✅ REPARO DA M02d VALIDADO NA CAIXA-PRETA (a 1ª tarefa do F6.8j): o dono
  abriu o app (boot 5a3dc434, 20:03:46Z) e o recovery reparou TUDO sozinho em
  ~2s — seq3 hub-merge "integração reconciliada após uma interrupção do
  aplicativo"; missão 7e31d314 → concluida, worktree mission-7e31d314 e a
  branch removidos, ticket cancelado (fila VAZIA), head da versão no merge
  7f10154. O caminho é o mapeado em index.ts 6811→6933, que roda ANTES do
  createWindow (janela limpa, sem pane para virar lock). PM pediu via ask_user
  "autorizo abrir a Onda 3?" e o app fechou limpo às 20:07Z — a pergunta
  EVAPOROU (binário antigo, Map volátil): o dono precisa responder ao PM ao
  reabrir; ela não vai re-pulsar sozinha.
- FIX 🔴 ask_user PERSISTIDO: pendingUserQuestions agora carrega/persiste em
  userData/user-questions.json (jsonStore atômico + backup, reidratação no
  boot) — a aba volta a pulsar depois de restart/crash até o dono abrir
  (questionSeen limpa e persiste). Pergunta de missão excluída fica como
  resíduo invisível no arquivo (aceito).
- MEMÓRIA BARATA DO PM/ORQUESTRADOR (pedido do dono: "eles não podem ter que
  reler a conversa toda — principalmente o maestro, que nunca morre"): mesmo
  racional do teto de fase (F6.8e) aplicado aos panes maestro-*.
  (1) `tuiContextTokens` novo no maestroStore, carimbado pelo watcher de stats
  (throttle 25k; zerado quando a sessão MUDA, no /clear//new e no
  resume-fail); (2) MAESTRO_RESUME_BUDGET_TOKENS=150k nos DOIS paneSpec —
  acima do teto o resume é PULADO (evento maestro-resume-skipped-cost),
  tuiSessionId limpo e o pane nasce FRESCO com intro que explica a economia ao
  usuário e reconstrói a memória pelos arquivos duráveis; (3) caderno novo do
  PM: .synkora/MAESTRO.md (persona DURABLE NOTEBOOK — reescrito a cada marco,
  snapshot e nunca log; par do PLAN.md do orquestrador), e a persona do
  orquestrador agora ensina que a conversa é DESCARTÁVEL por teto de custo —
  o caderno é o que torna isso grátis.
- ITEM 22 ENTREGUE: docs/MAPA_RETOMADA_2026-08-06.md — fluxo completo (15
  estágios) × 8 quedas, célula por célula com file:line e veredito ✅/⚠️/🔴,
  absorvendo a MATRIZ_FALHAS_2026-08-02. Os 2 🔴 conhecidos viraram 🔴→✅
  (integração×ressurreição e ask_user — ambos corrigidos nesta data). ⚠️
  aberto que sobrou: runtime do QA órfão em CRASH SUJO do app (spawn fora do
  job object — candidato a fix futuro); nota de desenho registrada para
  ninguém "consertar" o dev interrompido com auto-ressurreição.
- LIÇÃO DE PROCESSO (gravada em memória): frota de subagentes SÓ com aval
  explícito do dono — 4 agentes Fable de varredura foram abortados no início
  por consumo de limite; a varredura foi refeita inline nesta sessão.
- 2ª PASSADA DO MAPA (mesma data, ordem do dono: "deixa tudo verdinho" +
  "cheque se rodou todos os casos"; typecheck + 97 asserções verdes): TODAS as
  células ⚠️/🔴 resolvidas — fixes reais: (a) runtime do QA sob o GUARDIÃO de
  job objects (PtyManager.guardExternalPid/unguardExternalPid, re-assign no
  respawn; setQaRuntimeGuard no qaRuntime — crash sujo não deixa mais árvore
  órfã, e o close do job virou 1ª camada do stop); (b) 🔴 NOVO achado e
  corrigido: ask_user era AUTO-DISPENSADO por Board montado-e-escondido (o
  efeito de questionSeen não tinha guarda de visibilidade — pergunta de
  projeto de fundo morria sem ninguém ver); a dispensa agora exige isActive +
  aba 'board', e o estado subiu para o store global (askQuestions); (c) 🔴
  NOVO: SEM single-instance lock — dois `npm run dev` gravavam os mesmos
  stores (último vence); app.requestSingleInstanceLock antes do whenReady;
  (d) poda preguiçosa de pergunta órfã no maestro:pendingQuestions. Re-régua
  honesta das demais: recuperação por AGENTE (orquestrador reabre dev morto;
  dev recuperado relança helpers) e conversa descartável por desenho contam
  como ✅ — justificativas célula a célula no doc. Casos NOVOS mapeados: E16
  renderer reload (✅ já coberto) e E17 instância dupla (fix acima).
- ATENÇÃO MULTI-NÍVEL + PLIM (pedido do dono: "eu preciso entender onde o
  pane está me chamando" de qualquer lugar): estado das perguntas do ask_user
  virou GLOBAL no store do renderer (askQuestions por projeto; App assina
  onUserQuestion e reidrata TODOS os projetos no boot). Sinais: aba da missão
  (como antes) + aba Board do universo pulsa com ❓ quando o dono está em
  outra aba + aba Panes pulsa quando um terminal pede permissão + avatar do
  projeto PULSA NO RAIL com dot laranja (visível de outro projeto/Home) +
  plim minimalista (notify.ts, Web Audio sintetizado, 2 senoides E6→B6,
  throttle 2s) na chegada de pergunta nova e na transição para
  needs-perm. CSS: .rail-item.attn/.rail-ask-dot/.tab-attn (reusa
  perm-pulse/peek-ask).
- RADAR DE ANDAMENTO DETALHADO (pedido do dono com print de referência: "eu
  não confio no overlay — resume demais; preciso saber TUDO sem abrir o
  Synkora"; ordem explícita: copiar a IDEIA, nunca o design — visual segue o
  tema painel): (1) tool MCP nova `status_note` (TODOS os papéis, inclusive
  gates — entrou em SYNKORA_READ_ONLY_GATE_TOOLS e no teste do catálogo):
  frase curta "o que estou fazendo agora" (≤120 chars, sanitizada), guardada
  em paneStatusNotes (memória, morre com o pane via unregisterPane) →
  scheduleProgressSnapshot; personas/contratos (devContract, atomicRoundRule
  dos gates, PERSONA_TUI, missionPersona) mandam carimbar a cada etapa.
  (2) progressSnapshot ganhou: nota viva por card E por coordenador
  (ProgressPaneNoteInput viaja no input; nota do coordenador vai DENTRO do
  ProgressCoordinatorActivityInput para valer nos dois caminhos), pill de tom
  por card (tone/updatedAt em ProgressCardPreview; teto de prévia 4→6),
  PERGUNTA do ask_user no snapshot (mission.question/project.question —
  tone attention vence tudo, compact focus prioriza; projectState ganhou
  hasQuestion). (3) Overlay: StatusPill (trabalhando/travado/aguardando/
  finalizado/ocioso) + frescor "há Xs" (tick de 5s), frase viva em
  .progress-note, pergunta pulsando em .progress-question (clique abre o
  alvo). (4) SONS DE MARCO (playSoftBlip, 1 nota, ganho ~metade do plim,
  throttle 1,5s): reviewer entrou = A5, QA entrou = C#6, merge/integrada =
  E6 — ouvido aprende o vocabulário sem olhar (App.tsx: onPaneOpen por role +
  hub merge).
- BANQUINHO DO SYNVOICE (pedido do dono: "falo, clico transcrever, não tinha
  input focado, perde tudo"): TODA transcrição bem-sucedida entra ANTES da
  entrega em userData/synvoice-history.json (últimas 4, só texto+hora, áudio
  nunca retido); botão ↺ novo no controle do SynVoice na titlebar abre menu
  com as falas — clique COPIA para o clipboard com aviso "cole onde precisar".
  IPCs voice:history/voice:historyCopy (assertMainVoiceSender). TAMBÉM NO MINI
  DESTACADO (pedido do dono, mesma data): botão ↺ na janelinha flutuante — a
  janela é FIXA 255×72, então abrir as falas CRESCE a própria janela (IPC
  voice:overlay-history-open → setBounds 264px, sobe se estourar a work area;
  fechar/attach restaura; gravar/transcrever fecha sozinho para dar espaço).
  IPCs próprios do overlay (assertOverlayVoiceSender); item copiado mostra
  "copiado ✓" inline (o mini não tem janela de aviso). Concha vira linha de
  64px via :has() quando o cartão de falas está aberto.

### F6.8j — HANDOFF da sessão curta de 2026-08-06 (noite): incidente da integração da M02d diagnosticado — LER PRIMEIRO

Sessão encerrada por limite de conta logo após o diagnóstico. NENHUM código foi
alterado (o app estava vivo o tempo todo). O que a PRÓXIMA SESSÃO precisa saber:

- 🔴 CORRIDA NOVA DESCOBERTA (ressurreição do orquestrador × limpeza da
  integração): no integrate_mission da M02d "Casca de navegação do app"
  (missão 7e31d314, ticket #8 da fila), o merge foi GRAVADO com sucesso
  (sourceHead a5563f80… → version/d37662df…; merge commit 7f10154 no relato do
  orquestrador), mas a LIMPEZA do worktree falhou e a fila pausou em
  target_repair_pending. CAUSA RAIZ rastreada (journal boot 07c6ecea seq
  14–20 + código): completeMissionMerge mata o pane do orquestrador ANTES do
  merge (index.ts ~7069 — comentário anti-lock diz o porquê); durante o await
  do merge no gitWorker, o BOARD RESSUSCITOU o pane morto (mecânica F6.4 de
  respawn pós-morte, teto 3/30s) e o claude novo nasceu com cwd DENTRO do
  worktree da missão → a remoção bateu no lock. O próprio orquestrador
  ressuscitado — sem saber que ERA o lock — diagnosticou "processo do
  Synkora" e pediu restart via ask_user. O servidor de teste do dono NÃO foi
  o culpado (pane fechou às 19:16:03Z, 4s antes do aval; por isso não há
  test-server-closed no journal).
- ESTADO NO FIM DA SESSÃO: quit-clean às 19:49Z registrado no journal; app
  AINDA NÃO reaberto; ticket ainda blocked. A rota sancionada é o RESTART:
  o recovery de boot (index.ts ~6797–6943) prova o merge no git, alinha o
  destino, remove worktree/branch da origem, conclui a missão e destrava a
  fila (requeueAfterTargetRepair/cancel). 1ª TAREFA DA PRÓXIMA SESSÃO:
  validar na caixa-preta que o boot seguinte reparou (fila drenada, missão
  7e31d314 concluída, worktree mission-7e31d314 removido) — se o reparo
  falhar de novo, o lock é OUTRO processo e a caça recomeça.
- FIX APLICADO (2026-08-06, sessão seguinte, app parado; typecheck + 85
  asserções verdes): a ressurreição com integração em voo agora é RECUSADA
  usando o estado que JÁ cobre exatamente a janela do merge —
  `mission.status === 'integrando'` (setado no drain imediatamente antes do
  completeMissionMerge; resetado em TODO desfecho e no boot ~18372). Nenhuma
  flag nova para dessincronizar. Duas camadas: missions:paneSpec devolve null
  com evento auditável `orchestrator-respawn-refused-integration-in-flight`
  (cerca autoritativa, logo após o guard do pendingOrchestrator) e o efeito de
  respawn do Board pula missão 'integrando' ENTRE o drop da spec morta e o
  refetch (o drop continua rodando — pane morto some da tela). Rota de saída:
  falha do merge → 'ativa' + missions:changed → Board rebusca e o orquestrador
  nasce para o reparo; sucesso → 'concluida' (nunca respawna); crash no meio →
  recovery de boot solta 'integrando'.
- CONFIRMADO AO VIVO o candidato 🔴 do caderno: pergunta do ask_user é
  memória volátil — o restart que ela mesma pediu a apagou.
- ITEM 22 CONTINUA SENDO O 1º ENTREGÁVEL (MAPA DE RETOMADA, ANTES da Onda
  3): a varredura chegou a ser disparada (2 agentes: fases dev+gates e
  merge+integração) mas a sessão acabou antes de colher qualquer resultado —
  RECOMEÇAR a varredura do zero. Esqueleto pensado: matriz estágios (plano →
  dev → gates → gate vivo em espera → QA+runtime → finalize/merge do card →
  conclude/verificação → fila de integração → release, + orquestrador/PM,
  helpers, ask_user, servidor de teste) × quedas (pane fechado à mão, CLI
  morre sozinho, restart limpo, crash sujo, estado em memória perdido com app
  vivo, resume-fail, limite de conta/reseat, interferência do dono), cada
  célula com file:line e veredito ✅/⚠️/🔴; docs/MATRIZ_FALHAS_2026-08-02.md
  é o precursor. O incidente desta sessão já dá uma célula 🔴 de brinde
  (integração × corrida em memória) e o ask_user volátil outra.

### F6.8b — bloco 2 (mesma noite): auditoria Fable dupla do fluxo inteiro + convergência de gate

Após o card de DS consumir ~6h/9 reprovações SEM o QA nunca rodar, o usuário ordenou
auditoria total (2 analistas Fable, lentes ciclo-de-qualidade e orquestração ponta a
ponta — relatórios com linha do tempo dos 2 dias na caixa-preta) e a aplicação integral.
CRITÉRIO DE PRONTO NOVO (ordem do usuário): o Synkora só é "bom" quando DUAS missões
completas consecutivas atravessarem dev→review→QA→conclude→integração com ≤2 rodadas de
gate por card e zero parada de motor — validado por MIM via harness E2E, nunca por
achismo. Achados-chave da auditoria: o pipeline atravessou ponta a ponta 2× nos 2 dias
(M01, M02b) — o desenho funciona; a cauda sangrava por 5 defeitos raiz. Tudo aplicado:

- A RÉGUA TEM DONO, AGORA COM MECÂNICA: o gate passa a VER o contrato (o briefing do
  card viaja no prompt dos DOIS gates — antes só a description ia, e a régua virava o
  ideal do modelo: 24px WCAG, "autorização externa", meta-auditoria); cerca ampliada
  (norma externa/lane monitor/human_validation/execução de teste NUNCA reprovam — o
  harness roda os testes à parte); reviewer SÓ recebe skills de code review
  (REVIEW_GATE_SKILL_IDS — o menu completo da função qa com wcag/a11y/webapp era quem
  alimentava a régua de QA no gate 1); escopo positivo ("code quality in context: DRY,
  coisa no lugar certo, GOOD not perfect — you are NOT a second QA"); e critérios de
  aceite BINÁRIOS obrigatórios no nascimento do card (persona).
- LISTA FECHADA VIVE NO CARD (task.gateRound): a reprovação grava a lista integral +
  placar por rodada; gate FRESCO herda a lista da instituição em vez de re-legislar (a
  rodada 5 do caso real nasceu de um pane novo que re-auditou tudo); aprovação limpa.
- PLACAR + DETECTOR ANTI-LOOP: rodada 2+ começa com "placar: resolvidos X/Y · parciais
  P · pendentes Z · novos W" (parseGateScore); 2 rodadas sem NENHUM item sair da lista →
  evento urgente LOOP DETECTADO com a escada de intervenção (re-briefing cirúrgico /
  reseat / patch literal / waiver; a seguinte sem progresso escala ao USUÁRIO com UMA
  pergunta). Anti-falso-positivo 18b: lista encolhendo NUNCA alarma, parcial é
  progresso, alarme é informativo e nunca fecha nada.
- RODADA VAZIA É ANOMALIA DE ENCANAMENTO: done com head IDÊNTICO ao reprovado e sem
  waiver novo NÃO recicla o gate — devolve ao dev com a lista vigente
  (gate-round-empty-delta); waiver novo em gateNotes legitima rodada sem commit e chega
  ao gate vivo na injeção do reciclo (ORCHESTRATOR RULING binding).
- PATCH SUGERIDO VIA REPORT (item 17 — redesenho obrigatório: gates NÃO têm ferramenta
  de escrita, catálogo/sandbox; o desenho "gate escreve .diff" era inexecutável): campo
  suggestedPatch na tool report (só com reprovada, 64KB, trivial/mecânico apenas); o
  HARNESS grava em .synkora/reports/<task8>-<phase>-fixes-r<N>.diff (git-invisível,
  fotografia intacta) e o path viaja no motivo; o dev aplica com git apply, revisa e
  ASSUME (devContract).
- task.feedback TEM UM DONO (a doença por trás do item 16): 6 caminhos de
  interrupção/boot sobrescreviam a lista da reprovação com nota operacional — agora nota
  só entra com o campo VAZIO; o prompt-delta lê (feedback ?? task.feedback); motivo do
  veredito 300→1500 chars (o funil truncado fazia o dev corrigir o resumo enquanto o
  gate re-checava a lista completa da memória — "persistem…" em 3 rodadas).
- ENDEREÇO ESTÁVEL notify_pane {taskId, role}: o hub ganhou lápides (tombstoneOf) e o
  harness resolve o pane VIVO do card+papel sozinho (3 paneIds para o mesmo dev em 4min
  no caso real; o orquestrador usou o morto MESMO com o novo no evento — bookkeeping de
  máquina não se joga no LLM). paneId morto é reencaminhado com aviso; personas e o
  evento de reprovação ensinam o endereço.
- O EVENTO DE REPROVAÇÃO COMANDA O JULGAMENTO: PASSO 1 julgar cada bloqueio contra o
  contrato (waiver imediato em gateNotes para o que o contrato não pede) e PASSO 2
  repassar só a lista SOBREVIVENTE — o juiz existiu o dia inteiro com zero waivers
  porque o evento só mandava repassar.
- BREAKER DE CRASH-LOOP DE GATE: 3 mortes sem veredito em 60s suspendem a reabertura
  por 5min (gateCooldownUntil; run_task {phase} recusa durante o cooldown com a receita
  de diagnóstico) — o review morreu 3× em 33s e cada morte foi reaberta às cegas.
- VÁLVULA SANCIONADA NO BECO DA VERIFICAÇÃO: run_task {adjustment} aceito com a
  verificação final do plano existente e não aceita (taskAdjustment.verificationBlocked)
  — o ciclo de recusas mútuas de 00:25-00:45 (verificação×orçamento×adjustment) só
  destravou por restart afortunado. REGRA DE PROJETO: toda guarda mecânica nova nasce
  com rota de saída sancionada e auditada cujo destino final é o usuário em UMA
  pergunta — beco sem saída é bug, não rigor.
- DEV SEM MCP NUNCA É SILENCIOSO: watchdog SOFT de 120s sem 1º contato autenticado →
  evento informativo ao orquestrador (dev-mcp-silent; nada é morto — o done vem por
  marcador) — um dev codex rodou a fase inteira sem MCP e ninguém soube.

### F6.8i — bloco de fechamento pós-O02d (2026-08-06 noite; missão CONCLUÍDA, integração aguardando o usuário)

A O02d atravessou TUDO (dev → review → QA VISUAL genuíno com runtime próprio
→ merge → verificação conjunta verde, 19:03). Bloco aplicado com app parado
(typecheck + 112 asserções verdes):

- EVIDÊNCIA NUNCA NASCE GIT-VISÍVEL: todo pane com browser ganha
  `--output-dir <cwd>/.playwright-mcp` nos args do @playwright/mcp (o output
  PADRÃO era o cwd — screenshots do QA caíram na raiz e invalidaram o próprio
  veredito, duas rodadas; o wrapper codex é fingerprinted por args, cada cwd
  tem o seu). E `.playwright-mcp/` entrou no ensureSynkoraGitExcludes —
  git-invisível em QUALQUER produto.
- QUARENTENA DE EVIDÊNCIA (o que se integra é o COMMIT; untracked nunca entra
  no merge): na validação do veredito, divergência composta APENAS de
  arquivos novos untracked com head/árvore intactos → move para
  <projeto>/.synkora/quarantine/<task8>-<ts>/ e REVALIDA — o veredito
  sobrevive ao lixo de gate (worktree.quarantineUntrackedNew: só age com
  tracked 100% limpo; evento gate-evidence-quarantined). A invalidação real
  (arquivo rastreado mudou) continua intacta.
- REPROVAÇÃO PRESERVA EVIDÊNCIA APROVADA (a memoização por head agora vale):
  retryOrBacklog só zera dev + activeGate + a evidência do GATE QUE REPROVOU
  (rodada-vazia resolve o gate pelo liveGateWait) — re-entrega de head
  idêntico pula gates já pagos de verdade (o review re-rodou à toa às 18:45
  porque o reset varria tudo).
- PROMPT-DELTA PARA TODOS OS PAPÉIS (ordem do usuário: "não deveria cobrar só
  o dev"): gate RESUMADO recebe delta curto (contexto vale; só as gateNotes
  novas/motivo da reabertura; re-verificar apenas o que a interrupção afetou)
  — o QA resumido às 19:01 tinha o passe inteiro na memória e ainda engoliu o
  briefing completo.
- PENDÊNCIA ÚNICA DO CADERNO: item 22 — MAPA DE RETOMADA (ordem do usuário):
  fluxo completo × cada tipo de queda em cada estágio, célula por célula
  rastreada no código (✅/⚠️/🔴), como documento visual — PRIMEIRO entregável
  da próxima sessão, ANTES da Onda 3. Candidato já conhecido a 🔴: perguntas
  do ask_user são memória volátil (somem no restart).

### F6.8h — o QA sobe sozinho (2026-08-06, fim da saga da porta)

Fechamento do dia, aplicado com app parado (typecheck + 88 testes verdes):

- 🔴 DETECTOR DE URL ERA CEGO A ANSI (a raiz de TODAS as falhas de runtime do
  dia): o vite imprime a PORTA EM NEGRITO DENTRO da URL (http://localhost: +
  ESC[1m + 5174) e o match era por chunk cru — o servidor subia, anunciava, e
  o harness derrubava runtime saudável (3×; o próprio QA diagnosticou isso no
  bloqueada). Fix provado em teste real: strip de ANSI + match sobre o
  ACUMULADO (cleanTail 8k — URL cortada entre chunks também casa).
- PRÉ-AQUECIMENTO DO RUNTIME REMOVIDO ("não é só o próprio QA subir? que
  dificuldade" — o usuário): o pane do QA nasce NA HORA (fim do "Electron
  abre, morre, e o QA chega depois") e o PRÓPRIO QA sobe o produto via
  runtime_control — a tool espera a URL e a DEVOLVE na resposta. Reciclo
  idem (nota de status/instrução, zero pré-start). Deleção de código.
- CEIFA NO KILL DO RUNTIME (2 Electron órfãos na tela do usuário — taskkill
  /T não atravessa pai morto): killTree do qaRuntime virou varredura BFS por
  parentesco (Win32_Process) matando FOLHA→RAIZ, PID a PID.
- RESPAWN DE GATE NO BOOT DESTRAVADO: task.runSeat guarda NOME e a busca
  exigia ID — gate interrompido sem sessão nunca respawnava. Cadeia nova:
  sessão > seat por NOME > seat da missão > seat do PM (o preparePhasePane
  re-resolve o seat real do gate de qualquer forma).
- Débitos quitados: 9b (heurística "?": pane de PM/orquestrador aquietado com
  última linha em "?" e aba escondida → mesmo pulso do ask_user; visitar
  dispensa aquela pergunta) e 10c (report pós-rodada de gate responde "sua
  rodada fechou; silêncio no modo espera; sem segundo relatório").

### F6.8g — CAPACIDADE ANTES DE ESCALAÇÃO (2026-08-06 noite, ordem do usuário)

Nasceu da saga da porta ("desenha esse fluxo: 7 saltos, 4 agentes e 1 humano
para o que uma pessoa resolve em 30s — você se orgulha desse código?") e da
auditoria de guardas que o usuário mandou ("segurança que trava o fluxo não
serve pra nada"). PRINCÍPIO DE PROJETO NOVO: "o que uma pessoa normal faria?"
é o teste de cheiro de todo fluxo; o agente no ponto da dor deve ter a
ferramenta que resolve — escalação é o ÚLTIMO degrau. Typecheck + 76 testes
verdes. Mudanças:

- RE-ENTREGA SANCIONADA (o assassino do fluxo): report(done) do dev VIVO com
  o card ESTACIONADO (phaseState interrupted, nenhum gate julgando) é ACEITO
  — o codeReportGuard reconstrói a fase dev (watch + posição) e a entrega
  segue o caminho normal (snapshot novo → gates; com a memoização por head,
  só re-roda o que o commit novo exige). Plano pausado = mensagem clara
  ("commit seguro; re-aprove e reporte de novo"). Evento redelivery-accepted.
  A recusa antiga só sobra quando HÁ gate ativo julgando — e diz isso.
- runtime_control (SÓ QA): {action: status|restart|stop, port?} — comanda o
  runtime que o HARNESS possui (sem shell; fingerprint intacto). restart
  re-detecta o script, aceita porta (flag por ferramenta + PORT= no env) e
  devolve URL/erro; produto electron-vite ganha a nota honesta de porta
  PINADA. ACLs: allowedTools do QA claude + SYNKORA_READ_ONLY_GATE_TOOLS
  (teste de catálogo atualizado). Prompts do QA (spawn e reciclo): 1º
  runtime_control você mesmo, 2º "bloqueada", escalação por último.
- MENSAGENS-RECEITA (auditoria: ~60 recusas varridas, 3 eram beco): "a fase
  preservada é X" agora diz O QUE chamar; "não deu para abrir a execução"
  diz a causa real (corrida de transição, aguarde e repita); "já existe uma
  fase rodando" diz como soltar um pane zumbi. Persona do orquestrador ganhou
  CAPABILITY BEFORE ESCALATION + "bloqueada que chega a você já passou pela
  ferramenta do QA".
- CAIXA-PRETA LEGÍVEL PARA O CLAUDE (ordem do usuário: "eu não posso ter que
  exportar diagnóstico pra você entender"): scratchpad/bbwatch.mjs (fora do
  app) traduz o journal em linhas humanas (papel + card + args ⇒ resultado)
  com --follow/--since; vira o monitor de fundo padrão das sessões de teste.
  Disciplina correspondente: narrar marcos sem ser pedido; check de processos
  eletron + tail ANTES de qualquer edit (3 acidentes no dia por não olhar).

### F6.8f — bloco noturno pós-O02d (2026-08-06): o dia dos becos fechados

Aplicado com o app PARADO (ordem do usuário após um dia de tropeços — dois
deles MEUS: editar src/ com missão viva relança o app via electron-vite, e um
taskkill em "órfão" na 5173 que era o npm run dev VIVO dele; ver memória
feedback-nao-mexer-durante-teste-vivo REINCIDÊNCIA). Typecheck + 88 testes
verdes (pane-permissions 11, mcp-protocol 5, orchestrator-flow 35,
mission-verification 25, pty-transcript 12). REGRAS PESSOAIS NOVAS: missão
viva = monitor+caderno APENAS (nem renderer se edita — preload/renderer
recarregam o app igual); processo suspeito = evidência ao usuário, NUNCA
kill próprio; o app roda no TERMINAL DO USUÁRIO (nunca hospedar em sessão
minha — o harness ceifou meu background e derrubou tudo). FATO CORRIGIDO:
electron-vite 5 RELANÇA o main sozinho no rebuild (a convenção "restart
manual" está superada) e o Synkora dev SEMPRE ocupa a 5173 (produto vite cai
na 5174+). Mudanças:

- GUARDIAN pid 0 (err_open_87 em TODOS os panes de um boot): o pid do ConPTY
  DLL é preenchido ASSÍNCRONO — em máquina carregada o assign imediato lia 0.
  armJob adia até o pid ser real (30×100ms; sem pid = desiste, ceifa cobre).
- VEREDITO "bloqueada" (bloqueio ambiental NÃO é reprovação — caso real: QA
  sem runtime reprovou e a "lista" foi ao dev, que nada tinha a corrigir):
  report aceita bloqueada com motivo (gates); não conta ciclo, não grava
  gateRound/feedback, fecha o pane, evento gate-blocked-environment + receita
  ao orquestrador (run_task {phase} reabre e re-tenta runtime; 2ª falha
  escala ao usuário). Prompt do QA instrui bloqueada na falha de runtime.
- RECICLO DO GATE VIVO RE-TENTA O RUNTIME (o startQaRuntime morava só no
  preparePhasePane): openGatePane no reciclo sobe o runtime se não há URL
  viva e injeta a URL nova (ou instrui bloqueada) na mensagem do re-round.
- RUNTIME COM TIMEOUT ADAPTATIVO (vite frio ficou 60s+ em "Re-optimizing
  dependencies" e o teto fixo matou runtime que ia subir): processo vivo
  emitindo saída = espera continua; 45s de silêncio sem URL = falha; teto
  duro 5min. Bootstrap por LOCKFILE (npm ci/pnpm/yarn/bun; sem lockfile,
  npm install) no QA runtime E no servidor de teste do dono.
- MATERIAIS DO GATE DENTRO DO WORKTREE (reviewer codex sandbox-preso não lia
  DESIGN.md/transcript do PROJETO; path com Ã ainda quebrava no PS):
  preparePhasePane copia DESIGN.md + transcript do card para
  <worktree>/.synkora e o prompt cita caminhos RELATIVOS (nota
  workspaceMaterialsNote nos dois gates).
- RODADA DE GATE ATÔMICA (owner change em voo cruzou com o veredito e gerou
  2º relatório por fora): atomicRoundRule nos prompts dos gates (critério
  novo em análise em curso = "registrado para a próxima rodada"; 1 lista por
  rodada; pós-report = silêncio) + persona do orquestrador (mudança do dono
  com rodada aberta vai por gateNotes e chega no reciclo; "relatório" via
  notify_maestro é comentário — a lista oficial é a do report/gateRound).
- LANE DE QA OBRIGATÓRIA (o plano da O02d nasceu sem lane qa e o gate abriu
  com effort que ninguém escolheu): createPlan AUTO-COMPLETA a lane qa quando
  há entrega de código (cadeia política qa > seat da missão > PM), marcada
  como sugerida — o usuário ajusta no PlanModal antes de aprovar.
- ask_user (pergunta em prosa ficava invisível — PM no vácuo): tool nova
  (Maestro/orquestrador) registra pergunta ao DONO; a ABA do board pulsa
  (mission-tab.asking, glifo ❓, tooltip com a pergunta) até o usuário abrir
  (maestro:questionSeen limpa; maestro:pendingQuestions reidrata). Personas
  do PM e do orquestrador: TODA escalação ao usuário chama ask_user.
- HANDOFF DO DEV (o resume acima de 150k nasce fresco — o que salva o
  contexto são os arquivos): devContract exige manter .synkora/HANDOFF.md
  (feito/decisões/pendências/próximo passo) reescrito a cada marco; o prompt
  de recovery fresco manda ler o HANDOFF PRIMEIRO.
- BOTÃO ■ DERRUBAR TESTE (missão e versão): quando há pane de teste vivo do
  alvo, o ▶ testar vira ■ derrubar (closePane mata a árvore via job object).
  Pane de teste carrega versionId; nó "Teste" no mapa (▶ teste em andamento).

### F6.8e — bloco pós-integração da M02c (2026-08-06 tarde): QA de verdade + custo de resume + servidor de teste

Aplicado em bloco único após a M02c integrar (typecheck + pane-permissions
11/11 + mission-verification 25/25 + mission-worktree 24/24):

- BYPASS TAMBÉM NOS GATES CLAUDE (caso real: reviewer parou em prompt de
  LEITURA do DESIGN.md do projeto — .synkora é git-invisível, o arquivo não
  existe no worktree e leitura fora do cwd prompta; a F6.8c só cobrira o
  perfil write): ramo de gate claude ganha --permission-mode bypassPermissions
  quando o ⏩ está ligado. Sem NENHUMA ferramenta de escrita no catálogo, só
  silencia prompts de leitura — cerca segue catálogo+fingerprint+ACL. Teste
  test-pane-permissions ATUALIZADO ao contrato (o caso "sensitive writers"
  testava o contrato PRÉ-F6.8c e estava vermelho desde 05/08).
- QA DE VERDADE (ordem do usuário: "não um QA que só olha código" — o QA do
  DS aprovou em 2min29s com uma única chamada MCP, o próprio report):
  (1) qaRuntime.ts — em card front/design não-fast com worktree, o HARNESS
  sobe o script dev/preview/serve/start do worktree (spawn shell:true, URL
  local detectada no stdout, timeout 60s) ANTES do gate 2 e o prompt declara
  "o produto está DE PÉ em <url>, navegue com playwright"; falha ao subir =
  evento + instrução de NUNCA aprovar visual às cegas. Runtime morre com o
  pane do QA (gate vivo em espera mantém os dois; kill = taskkill /T /F) e no
  will-quit. Órfão em crash do app é gap aceito (sem job object). (2) Prompt:
  mandato visual INEGOCIÁVEL — lista herdada limita re-julgamento de CÓDIGO,
  nunca o mandato funcional/visual; aprovação de UI SEM evidência de navegação
  declarada (telas/estados/viewports) = report incompleto; sem runtime, nunca
  aprovar pelo código.
- TETO DE CUSTO NO RESUME (caso real: retomar dev Fable com ~700k custou ~10%
  do limite SÓ para reler a conversa): TaskPhaseResume.lastContextTokens
  carimbado pelo onStats (throttle 25k); preparePhasePane com resumable acima
  de RESUME_CONTEXT_BUDGET_TOKENS (150k) NÃO resume — nasce fresco sobre o
  trabalho preservado, evento resume-skipped-cost + info ao orquestrador.
- TROCA DE EXECUTOR VISÍVEL (caso real: usuário trocou dev p/ Opus via ⇄ e o
  orquestrador inventou "o app reabriu com Opus"): o evento do
  tasks:setPhaseSeat deixou de ser quiet — chega no pane do orquestrador como
  "o USUÁRIO trocou o executor… novo carimbo do card, não re-imponha a lane";
  persona (LIVE EXECUTOR SWAP IS THE OWNER'S PREROGATIVE) ensina a regra.
- EVIDÊNCIA NO BLOQUEIO DE VERIFICAÇÃO (caso real: "npm run test falhou no
  final" sem NENHUM trecho de saída — o orquestrador re-rodou na mão para
  diagnosticar; a falha original ficou irrecuperável): o evento
  plan-verification-blocked agora carrega o tail stderr/stdout dos comandos
  falhos (blackbox detail ~4k + mensagem ~900, sanitizados). A falha daquele
  dia: mesma árvore nas duas rodadas → flake (verificação roda sob
  Electron-as-node, habitat do EPERM de fixtures git — fix é card futuro do
  produto).
- SERVIDOR DE TESTE DO DONO (pedido do usuário): botão "▶ testar" na missão
  (mission-actions) e por versão (aba Versões) → TestServerModal pergunta a
  PORTA → pane SHELL no worktree com `npm run <script>` (+ ` -- --port N`)
  injetado pós-spawn (panes:testServerSpec; testServerPanes no main). Fechar
  o pane derruba o servidor (job object); integração (completeMissionMerge) e
  release fecham o server daquele worktree ANTES do merge (test-server-closed
  na caixa-preta). Versão sem worktree cria na hora (createVersionWorktree).

### F6.8d — corrida do poller × preparePhasePane (2026-08-06, retomada da M02c)

- 🔴 WATCH DA FASE MORRIA EM SILÊNCIO NO RESPAWN DE BOOT (caso real: dev da
  M02c renasceu, trabalhou 10min, e o report(done) foi recusado para sempre
  com "esta não é mais a fase dev ativa" enquanto o board dizia faseAtiva=dev
  — o board lê task.activePhase persistido, o guard lê phaseWatches em
  memória): preparePhasePane registra o watch ANTES do tasks.update para
  'execucao' e há awaits entre os dois (skill sync ~0,7s); o recovery de boot
  deixa o card em BACKLOG até esse update, e o tick do poller de 3s caiu na
  janela — viu watch com status divergente sem marcador e DELETOU sem
  registrar nada. Sintoma-assinatura: card preso em execucao/dev/PENDING
  (a transição pending→running no pty:create exige watch.paneId). Fixes:
  (1) createdAt no PhaseWatch + JANELA DE GRAÇA de 30s no poller — watch
  recém-criado com status divergente é preparação em curso, nunca staleness;
  (2) soltar watch NUNCA mais é silencioso (evento phase-watch-released com
  prev/reason); (3) cinto: se o watch sumir durante os awaits, o ponto do
  armPane RECONSTRÓI (todos os campos em escopo) e audita
  phase-watch-repaired. Validado ao vivo na retomada: re-dispatch atravessou
  pending→running. Card em backlog/interrupted NÃO respawna no boot por
  design (backlog é do orquestrador — run_task cobre, com resume da conversa
  via retryingOriginalDev).

### F6.8c — harness E2E + validação real de DUAS missões + últimos fixes (mesma noite)

- HARNESS E2E PERMANENTE (a prova substitui o achismo): `SYNKORA_E2E=1` liga o CDP em
  127.0.0.1:9222 (app.commandLine, nunca sem a env) e `scripts/e2e/driver.mjs` (dep dev
  ws) chama o `window.synkora` REAL do renderer — as MESMAS chamadas dos botões. VALIDADO:
  duas missões completas no projeto-fixture `~/.synkora-e2e/p1` (registrado na Home como
  "E2E BRL Utils" — pode ser removido da Home; a pasta fica): missão 1 "moeda BRL" LIMPA
  em 12min (1 rodada por gate), missão 2 "percentuais" em 11min com UMA parada — que
  virou o fix do bypass abaixo. Pegadinhas do driver: path com \\ vira escape comido
  (usar forward slashes); watcher bash sobre JSON escapado não casa em `case` (fazer o
  eval devolver sinal simples); a Home não recarrega projects após create via IPC
  (location.reload resolve); o clique útil do card é o botão "ABRIR →".
- BYPASS ⏩ LIGADO VALE SEMPRE (decisão do usuário: "independente do risco, high ou low"
  — caso real: plano risk HIGH suprimiu o bypass SILENCIOSAMENTE e o dev travou em "Do
  you want to create…?"): panePermissions só entra no ramo restritivo sensível com
  bypass DESLIGADO; a cerca real dos sensíveis segue (fingerprint, review+QA, ACL).
- CAS NA APROVAÇÃO DO PLANO (caso real: o orquestrador re-propôs ENQUANTO o usuário
  lia): tasks:planApprove leva a revisão vista (task.updatedAt do modal); plano mudou →
  {staleRevision} e o PlanModal avisa "releia" em vez de aprovar contrato velho. Persona:
  create_plan é a versão FINAL — o card aparece na hora; rascunho não sobe.
- RESEAT MESMO-SEAT PRESERVA A CONVERSA (tasks:setPhaseSeat): mesmo config dir não
  precisa de transplante — mantém phaseSessions e o respawn resume (apagar perdia a
  conversa à toa).
- A RÉGUA-MESTRA É DO DONO — "BOM E LIMPO, NUNCA PERFEITO" — e o RE-BRIEFING PASSA PELO
  JUÍZO DO WAIVER (caso real ciclo 8: a régua do reviewer morto sobreviveu ENTRANDO no
  briefing do RESUME e o reviewer novo a cobrou "legitimamente"): persona do
  orquestrador — exigência que seria waivada (meta-auditoria de tooling, norma externa,
  cerimônia) NÃO é promovida a briefing; o juiz pode waivar até contra o próprio
  briefing quando o item só existe lá por essa contaminação.
- PRIMEIRAS VALIDAÇÕES AO VIVO dos mecanismos F6.8b no card real de DS (ciclo 8):
  placar no formato exato ("resolvidos 1/4 · parciais 3 · pendentes 0 · novos 0" — zero
  itens novos, lista fechada funcionando), patch sugerido de 3,5KB gravado pelo harness
  (gate-suggested-patch), gate novo herdando a lista via task.gateRound.

## Estado anterior do fluxo (F6.7 — 2026-08-04 tarde, onda 2: qualidade de front + dev vivo + review sem teto)

- REVIEW SEM TETO DE DIFF: estouro dos 120k não devolve mais o card ("divida a
  entrega" era conselho impossível — caso real: design system legítimo de
  ~120k). `immutableReviewDiff` ganhou modo 'local': resumo inline + o gate lê
  o patch LOCALMENTE pelo range SHA-pinado (imutável por definição), instruído
  na voz do harness FORA do bloco untrusted. QA nunca teve teto. NENHUM tamanho
  de entrega bloqueia gate.
- DEV VIVO DURANTE OS GATES (decisão do usuário): o done NÃO fecha mais o pane
  do dev — reprovação com ciclos volta na MESMA conversa (o caminho liveDev do
  retryOrBacklog, que existia e nunca disparava). Fecha só: sem gates,
  aprovação final (finalizeTask), plano pausado, ciclos esgotados. Fingerprint
  do gate segue sendo a cerca. devContract manda ESPERAR sem tocar em nada.
  UM AVISO SÓ (refinamento do usuário, mesma noite — o dev recebia o veredito
  do harness E a triagem do orquestrador em duas mensagens): com orquestrador
  VIVO o harness NÃO injeta o veredito no dev; o orquestrador recebe veredito
  + paneId em evento URGENTE e manda UMA mensagem via notify_pane. Fallback
  (orquestrador morto/tarefa solta): injeção direta — o retry nunca fica
  órfão. SEGUNDA RODADA de refinamentos (mesma noite, caso real do card
  Sincronizar): (a) MENSAGEM CURTA obrigatória — só a lista do que corrigir
  ("arruma isso, isso e isso"), NUNCA re-briefing: a conversa viva já tem todo
  o contexto (o orquestrador tinha mandado o briefing inteiro de novo);
  (b) DEV VIVO NÃO TEM TETO DE CICLOS ("reprovou dez vezes porque errou dez
  vezes, paciência — não fecha enquanto não terminar") — cycles vira SINAL
  para o orquestrador intervir por decisão própria; teto continua SÓ para dev
  MORTO (respawn automático limitado) e tarefa solta; (c) DISPUTA DEV×GATE:
  dev que discorda contesta via notify_maestro e o ORQUESTRADOR é o juiz
  final ("arruma" ou "não arruma"); waiver é gravado em gateNotes para o gate
  seguinte não re-reprovar o mesmo ponto.
- PARALELISMO É LEI (decisão do usuário): "1 run por seat" era do dispatcher F3
  morto e NÃO existe no runTask — NUNCA reintroduzir exclusividade de seat.
  MAX_PARALLEL_RUNS=6 por projeto; dev esperandinho não conta extra.
- BRIEFING COMPLETO NO SPAWN (decisão do usuário: "instrução nunca persegue o
  pane"): `task.gateNotes {review, qa}` via update_task (patch SÓ de gateNotes
  aceito com card em andamento — o gate ainda não nasceu) → anexado ao prompt
  do gate no spawn. Persona do orquestrador: consolidar TUDO antes do run_task;
  notify_pane pós-spawn só para fato novo.
- QUALIDADE DE FRONT (3 camadas, decisões do usuário — "apps profissionais,
  como time de empresa"): (1) PM greenfield: missão = UMA entrega ("título com
  'e' = duas missões"); design system NUNCA colado com casca/telas e entrega
  STYLEGUIDE VIVO navegável (padrão github.com/jbrunnoo/ds-hope-finances:
  tokens semânticos, tabular-nums BR, specimens com estados, padrões de
  domínio) — contrato visual que o QA cobra; (2) dev front/design: DETAIL PASS
  obrigatória antes do done (impeccable/better-interface/typography-audit;
  espaçamento na escala, alinhamento, sem vãos, estados completos); orquestrador
  carimba o kit de polish em card de UI; (3) QA DE VERDADE: hover/active/focus/
  disabled de CADA elemento via browser, viewport pequeno E grande, estados
  vazio/erro/carregando, desarmonia REPROVA, evidência específica.
- ORDEM NATURAL DE ONDAS: o array do roadmap é a autoridade de execução e o
  merge appendava onda nova no FIM (O02b rodaria depois da O10 — bug real).
  `sortWavesNaturally` no applyRoadmapDraft: com TODOS os ids na convenção
  O<número><sufixo>, blocos ordenam O02 < O02b < O03; id fora do padrão
  desativa o sort. Ids de onda agora SIGNIFICAM a ordem (persona avisa).
- VERIFICAÇÃO COM BOOTSTRAP DE FATO: `ensureVerificationBootstrap` era DEAD
  CODE (definida e nunca chamada — baseline da M02 nasceu failed por falta de
  node_modules); agora roda antes da baseline E do final.
- SYNC DE SKILLS INCREMENTAL: marcador gerenciado ganhou `version` (sha
  instalado) — destino com id+versão idênticos NÃO é recopiado (era rm+cp de
  37 skills ×2 destinos em TODO spawn, suspeito nº 1 do stall). Atualizar/
  reinstalar muda o sha → recópia. Instrumentação nova na caixa-preta:
  `slow-skill-sync` e `slow-task-worktree` (>250ms).
- LSP WARM-UP: erro RETRYABLE com o server vivo na 1ª tentativa espera 900ms e
  repete UMA vez (a 1ª consulta pós-boot estourava enquanto o tsgo montava o
  programa).
- Tooltip da aba MAPA enxuto (1ª linha ≤110 chars — o outcome do conclude_plan
  cobria a tela); painel de validação de segurança do card com textos do modo
  atual (actor 'security-gate' reconhecido no renderer/preload); devContract:
  lint/format do produto DEVE ignorar .claude/.agents/.synkora (176 erros de
  lint eram as pastas injetadas).
- CODEX RESUME EM FASE: REABILITADO E REVERTIDO NO MESMO DIA — vence o app.
  A sonda isolada (probe-codex-resume-mcp.mjs, 0.146.0) provou `codex resume`
  nascendo COM MCP (6 req autenticadas), mas a reabilitação RECAIU no app real
  em horas (card Sincronizar: respawn via resume trabalhou a fase INTEIRA sem
  MCP; report-guard-degraded-no-mcp salvou pelo marcador .done). Algo do
  caminho do app (PTY/PowerShell/env/config por pane) difere da sonda
  (node-pty direto). Fase codex interrompida volta a respawnar FRESCA; próxima
  investigação exige sonda reproduzindo o CAMINHO EXATO do app. Strip de
  'codex-thread:' no id do resume claude/codex fica (robustez).
- EFFORT DO EXECUTOR É CONTRATO (caso real 2026-08-04: pane do dev morreu e a
  reabertura veio SEM o effort escolhido pelo usuário — caiu no default do
  modelo): `task.devEffort` carimbado na 1ª abertura da fase dev
  (preparePhasePane, effectiveDevEffort = param ?? carimbo) e TODA reabertura
  (re-dispatch, respawn, recovery) reusa o carimbo. O usuário decide o effort;
  o acaso nunca rebaixa.
- VERIFICAÇÃO ACEITA COMANDO REDEFINIDO EM MODO LEVE (caso real 2026-08-04,
  M02b: a missão trocou o script test de Electron+SQLite para `vitest run` —
  mudança legítima do objetivo, revisada em 4 rodadas de gate — e o
  conclude_plan travou em LOOP: o gate recusa alias cuja definição o diff
  alterou e não existia caminho sancionado; PM "aprovou em prosa" e o gate não
  lê prosa): com o switch de modo leve, comando do baseline fora da allowlist
  atual é substituído pela definição ATUAL redetectada (que está na allowlist
  segura), roda com exigência de verde e audita
  `verification-command-redefined-accepted` na caixa-preta. A cerca da mudança
  é o review+QA que auditou o diff. Modo ESTRITO preserva o bloqueio integral.
- PROMPT POR ARQUIVO COM BOM (caso real 2026-08-04: reviewer codex leu o
  briefing com `Get-Content` — PS 5.1 sem BOM decodifica UTF-8 como ANSI,
  "GESTÃO" virou mojibake DENTRO do contexto e o caminho literal do transcript
  parou de resolver): prompt-<paneId>.md agora nasce com '﻿' — o PS
  detecta e decodifica certo; o Read do claude ignora BOM. A lição anti-BOM da
  F6.0 segue valendo onde sempre valeu: SKILL.md parseado pelo frontmatter dos
  CLIs, nunca nestes arquivos de instrução lidos por shell.
- SHIMMER NÃO COME MAIS LETRAS NO TRANSCRIPT (sonda de bytes crus na MESMA
  captura + analyze-codex-bytes.mjs): o codex repinta SÓ a janela destacada da
  palavra por frame ("Working"→"orking"→"• king 4" — a cabeça NÃO está no
  chunk; cleaner não tem como reconstruir). Fix no flushLog:
  `collapseRepaintFrame` (pty.ts, pura/exportada) — fragmento cuja sequência
  de LETRAS está contida na linha anterior colapsa (drop/replace); linha
  legítima numerada difere em DÍGITOS e nunca colapsa ("passo 1"/"passo 2");
  glifo sozinho ("•") é chrome e cai. Medido no replay da captura real:
  resume 90→36 linhas, cadeias de sufixo zeradas. Suíte test:pty-transcript
  com as strings LITERAIS da sonda (12 classes).
- TRANSPLANTE DE SESSÃO ENTRE SEATS (decisão do usuário: "limite estourado
  nunca pode prender a missão nem custar o contexto"; DUAS sondas positivas
  2026-08-04): o contexto é ARQUIVO LOCAL, não estado da conta — claude JSONL
  copiado para outro seat respondeu a palavra-código sob a conta nova
  (--resume cobra no login do config dir); codex rollout copiado recuperou a
  conversa inteira (`codex exec resume <uuid>` headless funciona).
  `migrateCliSessionBetweenSeats` no index; troca MESMO-CLI migra a conversa
  POR PADRÃO (quem quiser zerar usa /clear), cross-CLI reseta e o agente se
  reergue pelos arquivos duráveis. Caminhos: PM via maestro:setSeat (⇄ de
  sempre) e ORQUESTRADOR via missions:setOrchestratorSeat + botão "⇄ conta"
  na mission-actions (NewMissionModal em modo reseat: título/goal/versão
  travados, conta/modelo/effort livres). Evento `seat-swap` na caixa-preta
  com o desfecho da migração.
- GIT FORA DO MAIN THREAD (a causa das "travadas" de executar/integrar —
  execFileSync congelava o main: spawn 1-2s, transição 1,8-3,5s, merge ~5s):
  `gitWorker.ts` (entry próprio no electron.vite.config → out/main/
  gitWorker.js; NUNCA importa electron) roda as funções síncronas de
  worktree.ts/reviewDiff.ts intactas num worker_thread único (operações
  naturalmente serializadas); `gitAsync.ts` expõe `gitOff('fn', ...)` tipado
  (Parameters/ReturnType) com FALLBACK síncrono se o worker não subir.
  CHECKPOINT SÍNCRONO (SharedArrayBuffer+Atomics): o mergeTaskWorktree do
  finalize persiste o recibo de integração NO MEIO do merge — o chamador põe
  GIT_CHECKPOINT_MARKER no lugar do callback, o WORKER pausa em Atomics.wait,
  o main grava e notifica (falha no main aborta o merge no worker; merge-
  repair intacto). Cadeias convertidas: integração (drain→completeMissionMerge),
  finalize de card, spawn (preparePhasePane async + propagação a openGatePane/
  retryOrBacklog/recoverFinalizingTask/tasks:run/runTask) e release. Os
  eventos slow-* agora medem tempo de WORKER (main livre).

## Estado anterior do fluxo (F6.6 — 2026-08-04, greenfield M01 completa + modo leve)

- TESTE GREENFIELD REAL COMPLETO: projeto "PAINEL DE GESTÃO — ERICK"
  (PER/DCOMP) atravessou descoberta → plano mestre (15 missões/10 ondas) →
  M01 fundação (dev codex → review codex → QA claude → merge → verificação
  conjunta VERDE → conclude → INTEGRADA na V1.0). Onda 2 pronta. 17 fixes de
  motor ao vivo — detalhe completo em docs/HANDOFF.md (seção 04/08).
- MODO LEVE por projeto: o switch "sensível ok" do board
  (maestroStore.sensitiveAutoOk, IPC harness:setSensitiveBypass, evento
  sensitive-bypass-override) governa TODA a camada de segurança burocrática:
  bypass vale em pane sensível, validação humana de plano não nasce,
  superfície nova é AUTO-ANOTADA (cards e ajustes), securityReview
  estruturado dispensado, verificação conjunta nunca desfaz card aprovado.
  FICA SEMPRE: fingerprint, review+QA, cerca .synkora, supply-chain 'block',
  guardas de argv. Sem o switch, modo estrito integral.
- GATE ESPECIALISTA: em modo estrito, plano sensível é validado pelo REVIEW
  com arsenal CYBER no menu; securityReview aprovado+imutável preenche
  manualSecurityValidation com actor 'security-gate' — humano nunca valida
  segurança (decisão do usuário).
- SKILLS EM TODO PANE (regra dura do usuário): elegibilidade do
  supply-chain virou block-only (licença fora das regras de conteúdo — a
  MIT disparava sensitive-external-effect em TODA skill; 'review' entra no
  menu), backfill de assessments legados no boot (383/383), menu vazio com
  biblioteca cheia = skills-sync-empty na caixa-preta.
- ARMADILHAS NOVAS PROVADAS: codex `resume` nasce SEM cliente MCP (fase
  codex interrompida respawna FRESCA — nunca reintroduzir resume sem sonda);
  aspas embutidas em token sem espaço morrem no caminho PS (quote() agora
  pré-escapa SEMPRE — o -c enabled_tools=[…] matava o reviewer no boot);
  npm_config_userconfig E globalconfig no MESMO NUL abortam o npm
  ("double-loading config") — a verificação usa dois arquivos vazios
  distintos + ensureVerificationBootstrap (npm ci) em worktree sem
  node_modules; prompt >8KB vai por arquivo (.synkora/prompt-<paneId>.md);
  lockfiles ficam FORA do diff imutável do reviewer (83% do diff da fundação
  era package-lock.json); trust do codex é ASCII-lowercase (path com acento
  não batia); LSP TS<7 cai no tsgo embutido; drag & drop de arquivo nos
  panes copia para .synkora/attachments e cola o caminho; watchdog de
  event-loop mede travadas (spawn 1-2s, merge ~5s — otimizar depois);
  start_project_mission agora exige o modal de orquestrador
  (pendingOrchestrator); aba MAPA mostra o plano mestre por ondas.
- REGRA DE TRABALHO: NUNCA editar main/preload/renderer com teste vivo e
  pane pensando — anotar, esperar aquietar, bloco único + um restart
  (memória feedback-nao-mexer-durante-teste-vivo).

## Estado anterior do fluxo (F6.5 — 2026-08-03, LSP validado + entrega por destino)

- LSP CROSS-FILE CONSERTADO (sondado no binário tsgo 7.0.2 direto, sem código
  Synkora): o TS nativo monta o programa pelo fecho de imports dos arquivos
  ABERTOS — references/implementations/call_hierarchy não enxergavam arquivo
  que IMPORTA o alvo (refs da classe Hub = 1 item; a aceitação era de arquivo
  único e nunca pegou). Um pull `textDocument/diagnostic` em arquivo FECHADO
  carrega o programa dele: `primeDependents` no manager (scan textual de
  imports acha os dependentes → pull-diagnostics; cache por processo, TTL 30s,
  tetos) roda antes dessas consultas no servidor nativo. Aceitação nova com
  fixture MULTI-arquivo. NUNCA remover o priming sem re-sondar o tsgo; p95
  quente segue ≤ 4,4ms. Economia de tokens MEDIDA com claude -p real (16
  runs): média ~neutra neste repo; ganho real em símbolo ambíguo no opus
  (−13% custo, −26% contexto) e 5,6× menos bytes por consulta — números em
  docs/benchmarks/2026-08-03/.
- AVISO DE CONCLUSÃO DE AJUDANTE TEM MODO POR DESTINO (bug real 2026-08-03:
  o delegador leu helper_output pré-report e a injeção digitou o payload
  INTEIRO de novo no input): `helperCompletion.ts` registra TODO leitor
  (noteOutputRead) e o announce calcula por destino — `full` (nunca leu),
  `short` (acompanhou: só o sinal, sem payload), `skip` (leu pós-report).
  Maestro/orquestrador também consome a PRÓPRIA entrega lendo helper_output
  pós-report (antes só o delegador exato podia — o publish reinjetava nele).
  Hub ganhou `stillNeeded` (HubNotificationOptions/HubPublishOptions):
  guarda reavaliada no INSTANTE da injeção no drain — consumo entre o
  enfileiramento e a digitação vira `discarded` na caixa-preta, nunca texto
  no input. O SINAL de conclusão sempre chega; EVENTS.md/UI seguem com o
  evento completo. Nunca voltar a entregar payload a destino que já leu.
- TRANSCRIPT SEM LETRAS COMIDAS (sondado em TUI claude real 2026-08-03,
  scratchpad/probe-tee-garble.mjs — parágrafo digitado no composer sem
  Enter, zero tokens): o cleanPtyChunk APAGAVA sequências de cursor e o
  texto fundia ("transcriptpreservapalavras…"; "helper_outpt" nas leituras
  reais do diário). Agora ele MODELA o movimento: CUF/CHA = separador; CUP
  com rastreio de linha (mesma linha = espaço, nova = quebra); CUU/CUD/CNL/
  CPL/VPA = quebra; params kitty `<=>` no CSI e ESC ( B / ESC = / ESC 7/8
  removidos (vazavam "<u78"/"(B"). Vale para transcript, outputTail,
  pane:lastlines, ultimaLinha e tails da caixa-preta; repaints idênticos
  reagrupam e o dedupe do flushLog pega mais. Suíte `test:pty-transcript`
  (9 classes provadas na sonda). NUNCA voltar a apagar cursor sem modelar.
- AGENTE LIVRE NÃO GERA TURNO DE PM POR ROTINA (caso real 2026-08-03: 9
  delegates de standby + 5 conclusões = 14 turnos do PM à toa): delegate e
  conclusão de ajudante cujo delegador é pane LIVRE publicam com quiet
  (EVENTS.md/UI registram; nada é digitado no PM). O delegador segue
  avisado; register_direct_mission segue não-quiet (é o marco que importa).
- OVERLAYS (mini SynVoice + ANDAMENTO) SEM MOLDURA E COM POSIÇÃO DURÁVEL
  (decisões do usuário, 2026-08-03): as janelas são TRANSPARENTES
  (transparent:true + '#00000000' + thickFrame:false) — a "borda escura" era
  o backgroundColor da janela vazando em volta do cartão CSS (anel da margem
  + cunhas entre raio CSS 13-14px e raio nativo ~8px) + moldura de resize;
  sondado em probe-thickframe.cjs. Mini do microfone: TAMANHO FIXO 270×72
  (sem resize, sem glifo; consts em synVoiceOverlayWindow.ts). ANDAMENTO:
  resize por ALÇA PRÓPRIA (.progress-overlay-resize → IPC
  progress:overlay-resize → setBounds clampado) — janela transparente não
  tem resize nativo no Windows. POSIÇÃO entre boots: monitores com escala
  MISTA (primário 125%, secundário 100%, medido) fazem a janela criada com
  x/y de outro monitor nascer deslocada — reaplicar setBounds PÓS-criação é
  o fix; clamp de load só reposiciona quando o retângulo está genuinamente
  fora de tela (overlayRectReachable) e o load NUNCA regrava o store (a
  regravação destruía a posição boa quando o clamp de boot errava).

## Estado anterior do fluxo (F6.4 — 2026-08-02, plano de estabilização)

- CAIXA-PRETA CENTRAL (`blackbox.ts`): diário JSONL append-only em
  `userData/blackbox/` + `journal.md` legível; ts/seq/boot + ids de correlação
  em TODO evento (pane, MCP, mensagens com desfecho de entrega, mudanças de
  card com prev/next, fotografias Git, merges, reconciliação de boot).
  Sanitização por chave, rotação, retenção 14d. Export de diagnóstico (.zip)
  no titlebar (clis ▾) via `diagnostics.ts`; IPC `blackbox:export`/`tail`.
- GATES REESCRITOS após 6 sondas em binário real: o perfil F6.3 (codex
  sandbox read-only + approval never + shell off; claude plan mode) deixava
  Reviewer/QA cegos e mudos — codex 0.146 AUTO-NEGA toda tool MCP sem
  aprovação interativa e plan mode bloqueia o report do claude. Perfil novo em
  `panePermissions.ts`: gates seguem o toggle de bypass do projeto, MCPs
  herdados desligados, features delegadoras off, shell (leitura) preservado;
  claude sem plan mode e sem ferramenta de escrita no catálogo. A cerca
  read-only REAL é o fingerprint antes/depois (invalida veredito) + ACL do
  servidor MCP. NUNCA reintroduzir sandbox/never/shell-off/plan em gate sem
  re-sondar o binário.
- Watchdog de gate: 75s sem requisição MCP autenticada → pane encerrado com
  causa, fase preservada, receita de retry no evento.
- REPARO DE INTEGRAÇÃO: merge bloqueado pós-aprovação deixa o card em
  `finalizing` com review+QA preservados (NUNCA volta ao dev); o orquestrador
  limpa o destino e chama `run_task {id, phase:"finalize"}` para re-tentar SÓ
  o merge do mesmo commit aprovado. Entrega vazia (head==base) é bloqueada
  antes de abrir gate; fotografia degenerada persistida recusa gate cego.
- Matriz dos 12 cenários de falha + roteiro de validação ao vivo:
  `docs/MATRIZ_FALHAS_2026-08-02.md`. Evidência do caso de 01/08 preservada em
  `.tmp/evidence-20260802/`.
- LIMITE DE ARGV NÃO SE ESCAPA POR ENV VAR (02/08 tarde, provado em
  `scripts/probe-argv-limit.mjs`): o PS expande `$env:X` DE VOLTA para a linha
  de comando do filho — o teto de 32.767 do CreateProcess (erro 206, morte em
  ~280ms) é re-atingido uma camada abaixo do -EncodedCommand. missionPersona
  (~27KB) + goal rico de PM estourava e o orquestrador morria no spawn; o
  Board ressuscitava sem teto = loop infinito (33 ciclos). Persona claude
  agora vai por ARQUIVO (`--append-system-prompt-file`, real no 2.1.220;
  arquivo por pane em `userData/prompts/`, sobrescrito no spawn e NUNCA
  apagado no exit — lição da corrida do arquivo MCP); pty.ts tem guarda dos
  dois tetos (estouro = erro legível, nunca morte muda); Board pára de
  ressuscitar após 3 mortes/30s ("tentar de novo"); pane/exit na caixa-preta
  carrega exitCode + últimas linhas. Codex segue com developer_instructions
  inline (cai na guarda) — canal por arquivo é pendência (ideia: profile -p).
- MISSÃO DO PM PEDE ORQUESTRADOR NO MODAL (decisão do usuário, 02/08):
  `create_mission` grava `pendingOrchestrator: true`; paneSpec recusa abrir
  enquanto o usuário não escolher conta/modelo/effort no NewMissionModal em
  modo confirmação (título/goal/versão travados) → IPC
  `missions:confirmOrchestrator` limpa o flag e o orquestrador nasce com a
  escolha. Nunca mais herança silenciosa do seat do PM em missão de PM.

## Estado anterior do fluxo (F6.2 — 2026-08-01)

- Missões persistem `executionMode` (`fast|standard|deep`) e `risk`
  (`low|medium|high`) separadamente, com justificativa e orçamento de cards.
  `fast` = exatamente 1 lane/1 card/0 helpers/até 1 skill; `standard` = até 4
  cards/2 helpers; `deep` = até 12 cards/4 helpers. O backend recusa expansão
  silenciosa; complexidade nova exige reclassificação e nova aprovação.
- Checklist não implica delegação. Helpers são opcionais por ganho líquido e o
  backend aplica o teto. Skills de planejamento são seletivas numa missão FAST
  clara; greenfield e planejamento material continuam auditando o uso real.
- Código nunca usa gates vazios; risco alto força review+QA. FAST conserva
  review+QA focados no diff e nos testes afetados, sem helpers/skills amplas.
  `non_code` pode encerrar sem gates. Diagnósticos de código independem deles.
- Retry automático: 1 em fast/standard, 2 em deep; esgotamento volta ao
  orquestrador. A fase ativa é persistida: restart/fechamento em review ou QA
  reabre só esse gate, sem repetir dev. `tasks.json` é atômico e tem backup.
- O board mostra perfil, risco, orçamento e fase 1/3–3/3; panes automáticos não
  mudam a aba do usuário. Base avançada é aviso; sync normal ocorre uma vez na
  cabeça da fila, e apenas conflito real recebe a skill/decisão rigorosa do
  Maestro.

## Estado anterior do fluxo (F6.1 — 2026-08-01)

- Greenfield usa `PROJECT_PLAN` schema 2. O roadmap avança por versão + onda:
  várias missões independentes da onda atual podem ficar ativas ao mesmo tempo;
  a próxima onda só libera quando a atual termina. Planos schema 1 migram para
  ondas seriais. `roadmapMeta.expectedCount/complete` protege mapas de 50–150
  missões salvos em lotes.
- Desenvolvimento é paralelo, integração é FIFO persistente por projeto em
  `integration-queue.json`. `integrate_mission` enfileira; `queue_missions`
  enfileira um lote com posições estáveis. Somente a cabeça faz merge.
- Destino avançou: a cabeça preserva posição e recebe card AUTO de sync + testes
  + review + QA. Conflito real: fila pausa; o PM Maestro decide e persiste a
  estratégia via `guide_integration_resolution`; o orquestrador apenas executa.
  O usuário só decide bifurcação real de produto, nunca mecânica Git.
- Cada ticket lacra o `planId`, o SHA aprovado e a identidade/SHA do destino.
  O worker exige origem limpa e mescla exatamente essa fotografia; drift pausa
  na mesma posição. A fila cria o único card de remediação e `conclude_plan`
  retoma automaticamente o aval original. Release também journaliza SHA
  definitivo e nunca auto-commita uma versão depois de abrir o intent. O ref de
  destino usa CAS de branch+SHA; falha ao alinhar arquivos preserva intent/ticket/
  branches e o recovery só conclui após reparar a fotografia com segurança.
- Skills de planejamento materializadas são anexadas à persona. Uso real é
  declarado via `record_planning_skill_use`, persistido no plano e separado de
  mera disponibilidade em `board_status`/PROJECT_PLAN.md.
- Seções históricas abaixo que ainda disserem “uma missão por vez”, “merge
  direto/imediato”, “branch de versão lazy” ou “gate reviewer de integração”
  estão superadas por esta seção e por `docs/HANDOFF.md`.

## Stack e estrutura

Electron + electron-vite + React 19 + TypeScript (strict). Vite fixado em ^7 (electron-vite 5 não suporta Vite 8).

- `src/main/` — main process: janela, IPC, `ProjectStore`, `SeatStore` e `TaskStore` (JSON em userData — decisão consciente: sem SQLite para evitar build nativo; trocar só se a escala pedir), `PtyManager` (@lydell/node-pty, prebuilt, sem node-gyp), `maestroSession.ts` (PAINEL DE FUNDO do Maestro: um processo `claude` PERSISTENTE por projeto em stream-json bidirecional — `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --verbose --permission-prompt-tool stdio` — o chat estruturado do board é só um espelho bonito dos eventos reais: deltas de texto ao vivo, tool_use com input completo, tool_result, e permissões chegam como `control_request can_use_tool` que a UI responde com allow/allow-always (`updatedPermissions` = ecoar `permission_suggestions`)/deny via `control_response`; interrupt = `control_request {subtype:'interrupt'}`; timeout de 10 min de inatividade PAUSA enquanto há permissão pendente; handshake `initialize` (control_request) devolve as CAPS REAIS do CLI — lista de comandos slash (nome/descrição/argumentHint), lista de modelos IGUAL ao seletor do TUI (displayName, descrição, supportsEffort, supportedEffortLevels por modelo) e conta/plano — cacheadas na sessão e expostas via IPC `maestro:capabilities` (ensureSession spawna sem custo: handshake não gasta tokens); troca de modelo é AO VIVO via `control_request {subtype:'set_model'}` (sessão preservada, confirmação real vem como `<local-command-stdout>`); qualquer `/comando` não-Synkora vai CRU como mensagem user e executa de verdade (/usage, /compact, skills…) — sem persona na frente; trocar effort/seat mata o processo e o próximo envio respawna com `--resume`; /fast do claude: o COMANDO é bloqueado em modo SDK ("not available in the Agent SDK"), mas a chave de settings `{"fastMode":true}` via `--settings` LIGA o fast mode real (validado: result.fast_mode_state=on) — o main intercepta /fast, alterna maestroStore.fastMode e respawna com --resume; no Windows o JSON do --settings precisa de dupla serialização por causa do shell; trocar de SEAT reseta model/effort/contextWindow (senão um modelo gpt vaza para o claude)), `codexSession.ts` (mesmo papel para seats CODEX: `codex app-server` persistente, JSON-RPC v2 via stdio — `initialize`+`initialized`, `thread/start` com persona em `developerInstructions`, `thread/resume` (sessionId salvo como `codex-thread:<id>`), `turn/start` com model/effort como OVERRIDES POR TURNO (trocar não exige respawn), eventos `item/agentMessage/delta`, `item/started|completed` (commandExecution/fileChange→tool), `thread/tokenUsage/updated`, `turn/completed`; aprovações chegam como REQUESTS JSON-RPC do servidor (`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`) e a UI responde `{decision: accept|acceptForSession|decline}`; caps via `model/list`+`account/read`; interrupt = `turn/interrupt {threadId,turnId}`; comandos slash do codex via `runSlash` — cada um mapeado ao RPC real: /status, /usage (rateLimitsByLimitId), /compact (thread/compact/start), /review (review/start target uncommittedChanges, roda como turno normal), /diff (git local), /init (turno com prompt canônico), /permissions (opts.approvalPolicy → override no turn/start: untrusted|on-request|never), /rename (thread/name/set), /goal (thread/goal/set|get), /mcp, /skills, /fast (REAL: toggle do serviceTier 'priority' no turn/start — "1.5x speed, increased usage", confirmado no catálogo embutido do binário; o TUI ganhou /fast em versão recente); comandos de UI do TUI (theme, vim, pets, quit…) respondem com explicação+alternativa via CODEX_TUI_ONLY/CODEX_UI_COMMANDS — a lista veio do slash_command.rs da versão instalada. STEERING: mensagem enviada DURANTE um turno entra no turno ativo — codex via turn/steer {expectedTurnId} (fallback turn/start); claude enfileira pela própria stream; a UI nunca bloqueia o input (busy também religa por delta/thinking/permission)), ambos implementam a MESMA interface de eventos (`SessionEvent`) e o main trata via união `MaestroBackend`, `maestro.ts` (persona PERSONA/PERSONA_DEV, parseTasks, toolLabel, `survey()` = /estudar one-shot que grava `<projeto>/.synkora/CONTEXT.md` (em seats codex: `surveyViaCodex` no index — CodexSession dedicada com sandbox 'read-only' + approvalPolicy 'never'; /estudar SEMPRE mata o painel do projeto e reseta sessionId/personaSent para a próxima conversa ler o dossiê novo); claude precisa de shell no Windows por ser shim .cmd), persona no 1º turno via mensagem (claude) ou developerInstructions (codex); cria tarefas SÓ quando a resposta contém bloco `<tasks>{json}</tasks>`, `maestroStore.ts` (persistência por projeto de sessão+modelo+log da conversa em userData/maestro.json — sair e voltar do projeto retoma tudo; sessão é presa ao seat, trocar de seat reabre sessão), `winPath.ts` (PATH fresco do registro no Windows). IPC do Maestro: `maestro:send` (claude E codex; fire-and-forget, turno termina com evento live `turn-end`), `maestro:permission`, `maestro:interrupt`; canal `maestro:event` = log persistido (kinds cmd/log/ok/err/say/tool/out/ask, `detail` carrega o input JSON da tool), canal `maestro:live` = efêmero (delta/flush/thinking/permission/turn-end).
- Seats (F1): cada conta = config dir isolado em `userData/seats/<id>`; o main injeta `CLAUDE_CONFIG_DIR` (Claude) ou `CODEX_HOME` (Codex) no env do PTY. Status "logado" = heurística de arquivo de credencial no config dir.
- `src/preload/` — bridge `window.synkora` (contextBridge); tipos em `index.d.ts`.
- `src/renderer/src/` — React: `screens/Home` (projetos + `components/SeatRail`), `screens/Universe` (abas Board/Panes; panes ficam montados ao trocar de aba — display:none, nunca desmontar, senão mata as sessões), `components/Board` (kanban + barra do Maestro), `components/PanesView`, `components/TerminalPane`, `store.ts` (zustand), `departments.ts` (departamentos/status), `util.ts`, `devMock.ts` (preview da UI em browser puro).

## Comandos

- `npm run dev` — roda o app (electron-vite dev, HMR no renderer).
- `npm run typecheck` — checa main/preload (tsconfig.node.json) e renderer (tsconfig.web.json).
- `npm run build` — build de produção em `out/`.

## Linguagem visual (decisão do usuário, 2026-07-21 — NÃO voltar ao tema escuro futurista)

Tema "papel & painel", inspirado em loops.overclock.sh: fundo papel quente (`--paper #efe9dc`),
tipografia 100% mono (Cascadia/Consolas), botões com borda ink e uppercase, e painéis de
terminal escuros (`--panel #26241f`) com bolinhas de janela (`.term-window`/`.term-titlebar`/`.dots`).
Acento laranja `#d96c3f`; sucesso verde `#3e9b5f`; erro `#c4453a`. Departamentos por matiz:
front 21 (laranja), back 210 (azul), qa 145 (verde). Logs estilo `[tag] texto` com `$` prompt.
Todo painel que "roda algo" (panes, maestro, login) usa o padrão .term-window.

## Fluxo de execução de tarefa (F3 COMPLETA em 2026-07-21 — EXECUÇÃO HEADLESS)

PIPELINE 100% EM PANES TUI REAIS (decisão do usuário 2026-07-21: ver o CLI de verdade ao
vivo em TODAS as fases; espelho headless descartado — o código do espelho segue no repo,
dormente): `preparePhasePane(phase)` cria worktree+transcript e devolve a spec; o
renderer abre TerminalPane no worktree (Pane tem role dev|review|qa; claude com
--permission-mode acceptEdits). ORQUESTRAÇÃO POR ARQUIVOS (poller 3s): dev cria
.synkora/runs/<id>.done → abre pane 🧐 review; gates criam <id>.<fase>.verdict com
"aprovada" ou "reprovada: motivo" → main parseia, FECHA o pane do gate ('panes:close') e
avança: review ok → pane 🔎 QA (status qa); QA ok → fecha pane dev + merge --no-ff
(`worktree.ts`; conflito → branch preservada) → done. REPROVAÇÃO: com autopilot e ciclos
< MAX_RETRY_CYCLES(2), o feedback é DIGITADO no pane vivo do dev via evento
'tasks:feedback' (pty.write; pane fechado → reabre com feedback no prompt) e
task.cycles++; sem ciclos → análise com task.feedback. Gates usam política do dept 'qa'
(fallback seat do dev). PTY faz tee da saída (ANSI limpo, flush 1,5s, dedupe) para o
transcript E detecta prompts de aprovação por heurística (ATTENTION_RE em pty.ts) →
evento 'tasks:attention' → card e pane pulsam (needs-perm) até o usuário digitar no pane.
Card mostra runSeat/runModel/cycles/feedback (campos novos na Task). Dispatcher abre
panes via 'panes:open'; mover o card para fora da fase solta o watch. Gates usam a política do dept 'qa'
(fallback: seat do dev) e rodam NO MESMO cwd/worktree do dev. Reprovação em qualquer gate
→ tarefa volta para análise com o motivo. DISPATCHER: `dispatch()` roda quando autopilot
(maestroStore.autopilot, toggle 🤖 no board, IPC harness:setAutopilot) está ligado — pega
backlog por ordem de criação, resolve política por dept+effort, pula tarefa sem política,
1 run por seat, MAX_PARALLEL_RUNS=3; re-dispara em toda mutação de tarefa e fim de run.
Custo por fase: evento result carrega costUsd (claude total_cost_usd) + contextTokens →
linha "fase X: ~Nk tokens · ~$Y acumulado" no espelho/transcript. APROVAÇÃO PENDENTE:
card e pane-espelho pulsam (classe needs-perm, keyframes perm-pulse). HANDOFF ▣ terminal
(`tasks:runHandoff`): mata o headless e abre um TUI REAL na MESMA conversa e no MESMO
worktree (claude `--resume <sid>`; codex `resume <threadId>`; Pane ganhou cwd próprio) —
o pipeline automático PARA para aquela tarefa (humano assume; card fica preso ao pane).

Execução é dirigida por POLÍTICA DE MODELOS (`policies.ts` + editor no painel do
departamento): humano define política (seat+modelo por peso), Maestro classifica `effort`,
harness aplica. "▶ executar" NÃO abre mais pane TUI: cria um TaskRun no main (`tasks:run`)
— uma sessão headless dedicada por tarefa (MaestroSession/CodexSession, os mesmos backends
do painel do Maestro) com `permissionMode: 'acceptEdits'` (claude) e `sandbox:
'workspace-write'` (codex): edits pré-aprovados, o resto pede aprovação NA UI. O modal da
tarefa vira o ESPELHO do executor: stream ao vivo, ferramentas, PermPicker de aprovação
(canais `taskrun:event`/`taskrun:live`), input de steering (`tasks:runSend`), ⏹ parar
(`tasks:runInterrupt`). Card mostra 🖐 piscando quando há aprovação pendente. Runs também
aparecem na aba PANES como panes-espelho (RunPanel compartilhado em
`components/RunPanel.tsx` com MaestroLine/PermPicker; executor fala como "executor>").
GATE 2 AUTOMÁTICO: dev concluiu → tarefa vai para QA e `startQaRun` troca a sessão por um
QA (seat/modelo da política do dept 'qa', fallback seat do dev) que lê o transcript, revisa
e TERMINA com `<verdict>aprovada</verdict>` ou `<verdict>reprovada: motivo</verdict>` — o
main parseia (tag some do espelho): aprovada → done; reprovada → volta para análise com o
motivo no log do Maestro; sem veredito → fica em QA manual.
Transcript de cada run em `<projeto>/.synkora/runs/<taskId>.md`; board em tempo real em
`.synkora/BOARD.md` (syncBoard em toda mutação de tarefa/run) — a PERSONA manda o Maestro
ler esses arquivos para responder sobre andamento (nunca presumir). Sem "claude padrão":
tudo roda em seats. Medidor de contexto: teto AUTOMÁTICO pela janela real do modelo
(claude: sufixo `[1m]` → 1M, senão 200k; codex: `modelContextWindow` do tokenUsage) —
`/context <n>` fixa manual, `/context auto` volta ao automático.

## F3.5 — Hub MCP, Maestro TUI, bypass e visual overclock (2026-07-22)

REDESIGN pedido pelo usuário: o orquestrador sabe de TUDO, agentes têm autonomia para
chamar uns aos outros, fluxo sem prompts de permissão, panes bonitos, Maestro = CLI real.

- `src/main/hub.ts` — BARRAMENTO central. `PaneIdentity` (paneId/projectId/role
  maestro|dev|review|qa|ajudante/taskId/cwd/seatId/delegatorPaneId) registrada por bearer
  token; `publish(HubEvent)` → append `.synkora/EVENTS.md` (rotação ~500 linhas) + canal
  UI `hub:event` + fila de INJEÇÃO no pane do Maestro: `ptys.inject` digita
  `[synkora] evento…` + Enter SÓ com o pane ocioso ≥4s (saída do PTY = não-ocioso; TUI
  ocupado/usuário digitando geram saída), throttle 8s, coalescência de até 3.
  `notifyPane` = aviso direto (ajudante→delegador). Eventos com actor 'maestro' não voltam
  para o próprio Maestro.
- `src/main/mcpServer.ts` — servidor MCP HTTP local (127.0.0.1, porta aleatória,
  StreamableHTTP stateless, `@modelcontextprotocol/sdk` + zod4). Auth = `Authorization:
  Bearer <token do pane>` → identity. Tools: `board_status`, `create_tasks` (caminho
  OFICIAL de criação — persona proíbe bloco <tasks>), `update_task`, `report`
  (done/aprovada/reprovada — move o pipeline; idempotente com o poller: quem chega
  primeiro deleta o phaseWatch), `delegate` (abre pane ajudante no MESMO cwd; política do
  dept OU seat do chamador; delegador é avisado no PTY quando o ajudante reporta done;
  pane do ajudante fecha sozinho via `panes:closeById`), `generate_image`, `notify_maestro`.
  Injeção por CLI (AMBAS validadas no binário): claude = `--mcp-config
  userData/mcp/<paneId>.json --strict-mcp-config` (strict SÓ em execução; Maestro sem
  strict p/ manter MCPs do seat); codex = `-c mcp_servers.synkora.url="http://127.0.0.1:
  <porta>/mcp" -c mcp_servers.synkora.bearer_token_env_var="SYNKORA_TOKEN"` + env
  SYNKORA_TOKEN no PTY (flags -c são globais, valem antes de subcomando; `codex mcp list`
  confirma "Bearer token"). `armPane()` no index registra identidade e monta cliArgs.
- BYPASS DE PERMISSÕES É O PADRÃO (toggle ⏩/🛡 no board, IPC `harness:setBypass`, campo
  `bypassOff` no maestroStore): claude `--permission-mode bypassPermissions` (+
  `ensureBypassAccepted` grava bypassPermissionsModeAccepted no .claude.json do seat p/
  não travar no aviso do 1º uso); codex `--dangerously-bypass-approvals-and-sandbox`.
  Toggle off volta a acceptEdits/aprovações.
- MAESTRO = PANE TUI REAL (chat estruturado REMOVIDO do Board; backends
  MaestroSession/CodexSession seguem no main p/ catálogo/survey/sondas): paneId estável
  `maestro-<projectId>`, spec via `maestro:paneSpec` — claude com `--append-system-prompt
  PERSONA_TUI` + `--resume <tuiSessionId>`; codex com persona no 1º prompt e `codex
  resume <sessionId>` depois (resume aceita flags globais e até prompt). `PERSONA_TUI`
  (maestro.ts): create_tasks via MCP, board_status antes de responder andamento, delegate
  p/ varredura pesada com modelo barato, linhas [synkora] = app (não usuário).
  tuiSessionId é descoberto pelo sessionStats (onSession) e persistido.
- SEAT DO MAESTRO NA ENTRADA: `SeatGate.tsx` (overlay) na 1ª entrada do projeto; sem
  default silencioso; persistido (maestroStore.seatId); trocar = botão ⇄ seat (respawn,
  reseta modelo/effort/sessões). `maestro:setSeat`.
- `src/main/sessionStats.ts` — telemetria REAL por pane: watcher incremental dos JSONL
  que os CLIs gravam. claude: `<configDir>/projects/<slug>/<sessionId>.jsonl` (slug =
  cwd.replace(/[^A-Za-z0-9]/g,'-')), linhas type assistant → message.usage
  (entrada nova/cache criado/cache lido/saída; contribuição por message.id aceita uma
  atualização tardia sem contar a mesma mensagem duas vezes). codex:
  `CODEX_HOME/sessions/AAAA/MM/DD/rollout-*.jsonl`; a metadata inicial pode passar de
  40 KiB e é lida incrementalmente até 1 MiB. O ID retomável é `payload.id`/UUID do
  filename, nunca `payload.session_id`; resume explícito procura o ID exato em todo o
  histórico, descoberta por cwd ignora rollouts de subagentes e cada arquivo tem claim
  por pane+geração. `/clear`, `/new` e `/fork` zeram o chrome imediatamente e o unwatch
  faz flush final do arquivo já adotado. `token_count` usa total acumulado para os
  badges e `last_token_usage` para o contexto vivo. Canal `panes:stats` → PaneChrome.
  SEM custo estimado: chip de custo só com fonte real (JSONL do TUI claude não tem USD).
- VISUAL overclock nos panes: paleta ANSI completa de 16 cores no TerminalPane (sem ela o
  xterm caía nos defaults ilegíveis — era o "sem cor"), WebglAddon com fallback,
  lineHeight 1.25, `PaneChrome.tsx` (dots mac coloridos, chip de role com hue, seat,
  badges ↓in ↑out, barra de contexto %, modelo), grid responsivo por data-count (3 = 2+1
  largo; 5+ = 3 colunas) e modo FOCAR (▢/▤ — CSS only, display:none, nunca desmonta).
- `src/main/seatUsage.ts` — hover no SeatRail mostra LIMITES reais: codex = app-server
  efêmero → account/read + account/rateLimits/read (zero tokens); claude = MaestroSession
  efêmera rodando `/usage` (comando local) e mostrando a saída crua. Cache 5 min. IPC
  `seats:usage`.
- IMAGENS: `settings.ts` (userData/settings.json, IPC settings:get/set, UI 🖼 na Home) +
  `imageProviders.ts`: CodexImageProvider (feature `image_generation` SONDADA via `codex
  features list` — stable true no binário atual; geração = CodexSession dedicada
  workspace-write/never instruída a salvar em `<cwd>/.synkora/attachments/`) e
  OpenRouterImageProvider (key + gpt-image-1/nano banana, base64 → arquivo). Tool MCP
  `generate_image` resolve pelo settings.
- pty.ts: fix CRÍTICO no quoting de cliArgs (o strip antigo destruía `-c chave="valor"` e
  paths com espaço — agora arg simples passa cru, resto é quotado); `isIdle`/`inject`/
  `has`/`lastOutput`; `onExit` hook (unwatch stats, unregister hub, publish pane-close);
  `appendSystemPrompt` agora passa pelo PaneRequest/preload.
- paneId agora é DEFINIDO PELO MAIN (DevPaneSpec.paneId; store.addPane aceita opts.id) —
  o hub conhece cada pane; `panes:closeById` fecha por id (ajudantes).
- Prompts das fases: report MCP é o caminho primário; arquivos-marcador (.done/.verdict)
  viram FALLBACK explícito no prompt e o poller de 3s continua vivo (advancePhase é
  compartilhado e idempotente).

## F3.6/F3.7 — Discord-mode, gates por tarefa, teclado dos panes (2026-07-22, tarde/noite)

- `ProjectRail.tsx`: rail lateral estilo Discord (Home ✦ + avatar por projeto; foto via
  clique direito → nativeImage 128px dataURL no projects.json; dot verde = panes vivos).
  TROCAR DE PROJETO NÃO MATA NADA: App mantém universos visitados MONTADOS
  (store.mountedProjects, display:none); openProject = switch + reload do estado global
  por-projeto (sem resets). Guardas: Board só recarrega/busca paneSpec quando ATIVO
  (paneSpec RESPAWNA o maestro — só chamar sem spec ou com seat trocado); portal do
  SeatGate só no universo ativo.
- GATES POR TAREFA (`task.gates` no create_tasks/update_task, decisão do Maestro):
  ausente = review+qa; ["qa"] pula revisão; [] = nenhum (trivial → dev direto pro merge).
  advancePhase/finalizeTask/openGatePane. AUTOPILOT REMOVIDO: humano inicia tarefas
  (▶ executar); retry de gate (2 ciclos) sempre ativo. VERSÃO do projeto: chip 🏷 no
  board (maestroStore.version), tarefas carimbadas, filtro por versão, coluna done
  capada em 20 + modal de concluída read-only (resumo + ↩ reabrir).
- TECLADO/PASTE dos panes (tudo validado com sonda em PTY real):
  - Shift+Enter = ESC+CR nos 2 CLIs; panes codex nascem com
    `-c tui.keymap.editor.insert_newline="alt-enter"` (keymap configurável do codex —
    achado nas strings do binário; sem isso NENHUMA sequência do xterm insere newline).
  - Shift+Tab = ESC[Z escrito direto no PTY (o browser roubava a tecla p/ foco).
  - Ctrl+V: keydown cola (imagem→PNG em .synkora/attachments + path digitado;
    texto→term.paste) + listener DOM como fallback com trava 400ms anti-dupla.
  - COPIAR/COLAR da seleção (2026-07-23): Ctrl+C COM seleção = copia (sem seleção
    segue cru = interrupt do TUI, padrão VS Code); Ctrl+Shift+C = copia sempre;
    clique direito = copia a seleção (ou cola se não há seleção, padrão Windows
    Terminal — sem menu nativo, que quebraria o foco no Windows). Seleção do xterm
    é VISUAL: o editor do TUI não a conhece — selecionar+Backspace nunca vai
    apagar; é limite de terminal, não bug.
  - Ctrl+A = LIMPA O INPUT INTEIRO do TUI (o "selecionar tudo e apagar" possível
    em terminal; panes claude/codex, shell fica nativo). Sondado em PTY real:
    ^U só limpa a linha atual em multilinha; ^C limpa mas interromperia resposta;
    a sequência é (Ctrl+K + Ctrl+U + Backspace) POR LINHA, 40×, FATIADA a 20ms —
    rajada única cai na detecção de paste do editor do claude e os controles são
    filtrados (nada acontece).
  - fit() do xterm NUNCA roda com o pane escondido (dimensão 0 embaralhava o texto do
    TUI e cortava o rodapé — pior bug visual da F3.6).
  - `--model` vai quotado e intacto (o sanitizador antigo comia colchetes de opus[1m]).
  - Windows: comando do pane via `-EncodedCommand` (base64 UTF-16LE) + pré-escape de
    aspas duplas em args com espaço (PS 5.1 não escapa → prompt virava argv solto).
- Trocar seat do Maestro: trust do cwd pré-gravado por seat
  (projects[cwd].hasTrustDialogAccepted) e guard de identidade no onExit do PtyManager
  (o exit do pty antigo apagava o registro/token/watchers do NOVO de mesmo id).
- Login expirado: LOGIN_RE no tee → seat "expirado" no rail (dot vermelho, 1 clique
  refaz /login); sem API p/ re-logar sem interação (alternativa futura: claude
  setup-token). Aceite do bypass gravado no boot p/ todos os seats claude.

## Cores nos panes + marca do CLI no titlebar (2026-07-22, sessão 2)

- CORES DOS TUIs: a causa REAL do "tudo branco" era o ENV do PTY (sondado em PTY real,
  4 sondas): no Windows o ConPTY NÃO exporta TERM (o `name` do node-pty só vale em posix)
  e o Electron herda `NO_COLOR=1` quando o `npm run dev` é lançado de dentro de uma
  sessão do Claude Code (o ambiente do Bash tool seta NO_COLOR) — qualquer um dos dois
  silencia TODAS as cores do claude (0 sequências SGR) e do codex. Fix no pty.ts: env do
  PTY ganha `TERM=xterm-256color` + `COLORTERM=truecolor` e DELETA `NO_COLOR`/
  `FORCE_COLOR` (validado: claude colore, codex emite truecolor). A paleta ANSI-16 do
  TerminalPane (F3.5) segue necessária — o claude usa cores ANSI-16, não truecolor.
- PaneChrome: dots mac SUBSTITUÍDOS pela MARCA do CLI (`CliLogo`: claude = logo Claude
  em `--accent`, codex = logo OpenAI claro, shell = `>_`; paths oficiais do Simple
  Icons inline). `.pane-kind` (glyph antigo) removido; SeatGate mantém os dots.

## F3.8 — MISSÕES: orquestrador por missão + branch isolada (2026-07-22, sessão 2)

Motivação (usuário): com 2+ tarefas paralelas o Maestro único vira bagunça; e nada
garantia que um trabalho não quebrasse o outro. Solução: MISSÃO = fluxo de trabalho com
orquestrador, tarefas e (com git) branch/worktree PRÓPRIOS — isolamento total durante o
desenvolvimento; risco concentrado na INTEGRAÇÃO (gateada e coordenada pelo PM).

- `src/main/missions.ts` — `Mission {title, goal, scope, status ativa|integrando|
  concluida|arquivada, branch mission/<id8>, worktree, baseBranch, seatId, effort}` em
  userData/missions.json. PROJETO SEM GIT: `initGitRepo` (worktree.ts) inicializa o repo
  na criação da missão (.gitignore mínimo p/ não engolir node_modules + commit inicial;
  identidade global, fallback -c Synkora) e `ensureMissionWorktree` promove missão antiga
  sem branch ao abrir a aba (git init + worktree + reset do tuiSessionId do orquestrador,
  que era do cwd velho) — anunciado via hub.
  `Task.missionId` (ausente = "Geral"). worktree.ts: `createMissionWorktree`,
  `currentBranch`, `createTaskWorktree(baseBranch?)` e `mergeTaskWorktree(targetDir?)` —
  tarefa de missão NASCE da branch da missão e MERGEIA de volta nela (merge roda no
  worktree da missão); tarefa solta segue direto na base.
- DOIS NÍVEIS: PM do universo (aba "✦ geral", persona PERSONA_TUI reescrita: cria missões
  via tool `create_mission` com goal/escopo, avisa sobreposição de escopo, coordena ordem
  de integração, tarefas soltas só p/ trabalho pequeno) e ORQUESTRADOR por missão (pane
  `maestro-<pid>--<mid>` — separador `--`, NUNCA `:`: o paneId vira NOME DE ARQUIVO da
  config MCP e dois-pontos é proibido no Windows (o write explodia e o pane não abria;
  writeClaudeMcpConfig também sanitiza o filename por garantia); `missionPersona(mission)`,
  cwd = worktree da missão, SEAT e EFFORT do orquestrador escolhidos no MODAL de nova
  missão (Mission.seatId/effort; default = herdar o seat do PM; lista de efforts vem do
  catálogo real do CLI do seat; claude `--effort` low..max validado no --help, codex
  `-c model_reasoning_effort="x"` que por ser flag global vai ANTES do subcomando resume),
  estado no maestroStore com chave `<pid>--<mid>` — o onSession do sessionStats persiste
  resume pelo mesmo slice de "maestro-"). create_tasks do orquestrador carimba missionId
  pela identity do token.
- ROTEAMENTO DO HUB: `HubEvent.missionId` + `PaneIdentity.missionId`; evento de missão é
  injetado SÓ no pane do orquestrador dela (fallback: PM se o pane morreu); evento sem
  missionId → PM. Decisão do usuário: PM recebe apenas criada/integrada/reprovada/conflito
  (publicados sem missionId). EVENTS.md ganha tag `[missão <id8>]`.
- INTEGRAÇÃO: `integrate_mission` (MCP, orquestrador = própria missão / PM = por id; exige
  aval do usuário) ou botão ⇪ no board (`missions:integrate`). Bloqueia com tarefa não
  concluída. Abre pane gate `⇪ integração` (política qa heavy>light, fallback seat do PM)
  no worktree da missão revisando `git diff base...HEAD`; veredito via `report` (identity
  com missionId sem taskId) ou marcador `.synkora/runs/mission-<id8>.verdict` (poller de
  3s compartilhado). Aprovada → mata o pane do orquestrador (cwd no worktree travaria a
  limpeza) → merge --no-ff na base → status concluida + evento aos DEMAIS orquestradores
  ativos: "base avançou — crie tarefa de sync". Reprovada/conflito → status ativa +
  evento ao orquestrador com o motivo (branch preservada).
- `board_status` escopado: orquestrador vê só a missão dele; PM vê tudo + resumo das
  missões (com ids). BOARD.md ganha seção "## Missões" e tag [missão: X] por tarefa.
- UI (Board): fila de abas `mission-tabs` (✦ geral + 🚀 por missão ativa + "+ missão" +
  select histórico…); kanban/chips de dept FILTRADOS pela aba; quick-add carimba a missão
  da aba; janela do maestro vira MULTI-SLOT (`.maestro-slot` display:none — PM e todos os
  orquestradores já abertos ficam MONTADOS, regra de ouro dos panes); chrome com branch da
  missão + ⇪ integrar/🗄 arquivar; modal 🚀 nova missão (título/objetivo/escopo);
  `missions:changed` recarrega. TaskModal mostra chip 🚀 da missão.
- ABA ARQUIVOS (`FilesView.tsx` + IPC `files:listDocs`/`files:readDoc`): lista os .md do
  projeto (raiz nível 0, docs/ até 3 níveis, .synkora, .synkora/runs) e renderiza no tema
  papel com `marked` + `DOMPurify` (deps novas). Guard de path (só .md dentro do projeto,
  cap 2MB). Não roda processo — monta/desmonta ao trocar de aba.
- Plugins do claude nos panes: são POR SEAT (config dir isolado). `/plugin install` dentro
  do pane funciona; plugin novo exige REABRIR o pane (CLI carrega plugins no boot;
  /reload-plugins cobre parte dos casos). O marketplace oficial é resolvido pelo próprio
  CLI mesmo em config dir virgem.
- Seletor de opções: as SETAS já chegam ao TUI (attachCustomKeyEventHandler só intercepta
  Shift+Enter/Shift+Tab/Ctrl+V) — seleção de opções usa o picker nativo do CLI, decisão
  do usuário (sem overlay clicável).
- PLANO NO TAMANHO DO TRABALHO (decisão do usuário, 2026-07-23): persona do orquestrador
  calibra o plano ANTES de planejar — missão pequena (uma área, sem dependências: copy,
  bugfix, polish de uma tela) = 1 card com quests, sem ondas, gates leves; ondas SÓ com
  dependências reais entre áreas ("6 ondas para arrumar copy de uma tela é fracasso").
  O PM carimba o tamanho no goal da missão ("missão PEQUENA: 1 card, sem ondas").
  Onda = fronteira de DEPENDÊNCIA, nomeada pelo(s) departamento(s) ("onda 1 — front",
  "onda 2 — back + front (paralelo)"); áreas independentes que não se batem nos arquivos
  saem JUNTAS na mesma onda (cards soltos ao mesmo tempo); onda seguinte só quando TODOS
  os cards da onda atual concluem.
- ONDAS + QUESTS (workflow do usuário): orquestrador planeja em ONDAS sequenciais
  (design→front→…→QA) — cria SÓ o card da onda atual, 1 por área, com checklist
  `task.quests` (Task/create_tasks/update_task; card mostra ▢, modal lista, harness
  anexa ao prompt do dev com dica de delegate — ajudantes usam o MESMO worktree, é assim
  que paraleliza sem colisão de merge). Próximo card só nasce quando o anterior INTEGRA,
  com briefing escrito com o resultado. MEMÓRIA PERSISTENTE:
  `.synkora/missions/<id8>.PLAN.md` — persona obriga ler no início de toda sessão e
  reescrever a cada onda (app fechar ≠ contexto perdido); board_status expõe o path, o
  gate de integração lê o plano, aba Arquivos lista.
- PM SILENCIOSO (decisão do usuário): `HubEvent.quiet` — evento de rotina (missão criada
  pelo usuário, integração iniciada, git init, promovida) vai p/ EVENTS.md+UI mas NÃO é
  injetado no pane do PM; persona manda reagir a marcos (integrada/reprovada/arquivada)
  e ficar quieto no resto. Arquivar/reativar publica evento próprio (não-quiet).
- window.confirm/alert NUNCA no renderer: o diálogo nativo QUEBRA o foco da janela no
  Windows (cliques param de funcionar até refocar) — confirmação de exclusão de missão é
  modal próprio (.confirm-modal).
- PENDENTE (combinado com o usuário): F3.9 "fechar versão" = corte de release (PM propõe
  bump semver + changelog, app grava CHANGELOG.md + tag git, carimba missões/tarefas do
  corte) substituindo o chip 🏷 manual + filtro de versão atuais, que o usuário considera
  mal pensados — NÃO removidos ainda.

## F3.9 — Página geral, funções expandidas e maestro lateral (2026-07-23)

- FUNÇÕES (departments) = 8 ENXUTAS (decisão do usuário: função só existe quando
  muda quem executa e como): front, back, qa, design, research + copy (✍️ 285),
  cyber (🛡️ 355), data (📊 170). mobile→front, devops→back, docs→research —
  as personas ensinam esse roteamento. Union em tasks.ts + mcpServer (zod enum)
  + preload + store + departments.ts. SKILLS e SUBAGENTES vêm PRÉ-SETADOS pelo
  app (defaults em departments.ts, campo agents novo) — sem UI de "sugestões";
  a IA escolhe o melhor para o caso (F4); lista editada persiste na política.
- FILTRO DO KANBAN só mostra chips de funções COM card no recorte atual
  (deptsWithCards); filtro apontando para função sem card cai em "all" (effFilter).
- MAESTRO LATERAL: o board virou `.board-main` em row-reverse — maestro/orquestrador
  é COLUNA DIREITA de altura total (largura redimensionável, persistida em
  localStorage synkora.maestroWidth; multi-slot montado igual antes), conteúdo à
  esquerda rola (`.board-content`; .board não rola mais).
- ABA "✦ GERAL" = PÁGINA DO PROJETO (`ProjectGeneral.tsx`): identidade (foto
  clicável, nome editável via projects:rename novo, pasta + 📁 relocar, stats
  missões/execução/concluídas) + FUNÇÕES em accordion (`func-card`): política de
  modelos (▲ pesadas/▽ leves, PolicyRow) + SKILLS e SUBAGENTES da função
  (`DeptPolicy.skills`/`agents` persistidos em policies.json; ChipsEditor com
  sugestões curadas de departments.ts; a INJEÇÃO no executor é F4 — hoje é
  curadoria). Editor de política saiu do DeptStats (painel do dept no kanban só
  mostra stats+skills e aponta para a aba geral). po-hint removido.
- `ModelSelect.tsx` compartilhado (ModelSelect + PolicyRow extraídos do Board).
- STATUS 'analise' EXTINTO (decisão do usuário): kanban tem 4 colunas (backlog →
  execução → qa → done); TODA reprovação/interrupção que antes "voltava para
  análise" agora volta para o BACKLOG com o feedback no card (badge ✗). Migração
  no load do TaskStore (analise→backlog); enums em tasks/preload/store/mcpServer;
  persona RECOVERY fala em backlog. Menções a "análise" em seções antigas deste
  arquivo leiam-se "backlog com feedback".
- MAESTRO LATERAL = METADE DA TELA por padrão (largura persistida em
  synkora.maestroWidth.v2 — a chave antiga guardou o default de 480px e
  sobrescreveria os 50%).

## F4.0 — VERSÕES com branch própria e release manual (2026-07-23)

Aba "Backlog" RENOMEADA para "Versões" (BacklogView.tsx segue como arquivo; substitui
o chip 🏷 manual planejado na F3.9-pendente). Modelo de release do usuário:

- CADA VERSÃO TEM BRANCH PRÓPRIA: `version/<nome>` + worktree em userData/worktrees
  (criados LAZY na 1ª integração de missão da versão; `createVersionWorktree` em
  worktree.ts; Version.branch/worktree em backlog.json). Missão COM versionId
  INTEGRA NA BRANCH DA VERSÃO (mergeTaskWorktree com targetDir) — a main fica
  INTOCADA; missão sem versão segue direto na base. Sync pós-integração: só as
  missões da MESMA versão são avisadas ("branch da versão avançou"); release avisa
  todas ("base avançou").
- ENTREGAS AUTOMÁTICAS: na integração, `backlog.addDelivery` registra a missão em
  Version.deliveries (idempotente por missionId) — a aba mostra "o que já subiu
  nesta versão" sozinha.
- SUBIR VERSÃO (`releaseVersionImpl` no index): merge direto da branch da versão na
  base (cada missão já passou pelo próprio gate; sem gate extra), SEMPRE disparado
  pelo usuário — botão "⇪ subir versão" na aba (confirm modal) ou tool MCP
  `release_version` do PM (persona exige pedido explícito). Bloqueia com missão
  ativa/integrando da versão. Sucesso: worktree+branch limpos, status 'lancada' +
  releasedAt — a lançada MAIS RECENTE = "versão atual na main" (banner da aba,
  `versaoAtualNaMain` no board_status). Excluir versão limpa worktree/branch.
- create_mission (PM/MCP) ganhou param `version` (NOME, ex. "v1.1") — resolve/cria a
  versão na hora. board_status expõe branch e `jaSubiuNaVersao` por versão. Itens de
  backlog (planejamento → virar missão) continuam como antes.
- MODAL DE MISSÃO COMPARTILHADO (`NewMissionModal.tsx`): seat + MODELO (ModelSelect,
  Mission.model novo → --model no spawn do orquestrador via spec.model) + effort +
  versão do app, em grade 2×2 com colunas IGUAIS `minmax(0,1fr)` (fr sem minmax(0)
  não encolhe abaixo do min-content do select — a coluna do modelo sumia). Usado
  pelo board (+ missão) E pela aba Versões ("criar missão com N itens" abre o MESMO
  modal com título/goal pré-preenchidos e a VERSÃO TRAVADA; itens vinculados no
  onCreated). Chip 🏷 <versão> no chrome do orquestrador e no tooltip da aba.
- SUB-ABA MISSÕES na tela Versões (`MissionsPane` em BacklogView.tsx): ecossistema
  completo — todas as missões (ativas/integrando/concluídas/arquivadas), filtros por
  status e versão, ordenação por criação, abrir no board, arquivar/reativar/excluir
  (confirm modal próprio). PAGINAÇÃO ADAPTATIVA (sem rolagem: ResizeObserver mede a
  lista e calcula quantas linhas cabem na altura — decisão do usuário);
  card em 2 linhas: título+status+🏷versão+⎇branch / ▣ X/Y tarefas (tooltip lista
  títulos) + criada em + integrada/arquivada em (updatedAt). O select "histórico…"
  do board FOI REMOVIDO — missão antiga se acha aqui. .task-modal-meta à ESQUERDA.
- CHROME DOS PANES (decisão do usuário): sem título repetido — PM fica só com o
  chip MAESTRO (title ''), orquestrador mostra SÓ o nome da missão; o chip da
  BRANCH (mission/<id8>) é clicável e copia o id completo da missão (o chip #id8
  separado foi removido). Ícones sem emoji: 🏷→◈ (versão), 🗄→⊟ (arquivar); botões
  de ação em fundo papel usam .btn ghost tiny (term-btn ghost-dim é SÓ para o
  titlebar escuro — em fundo claro o hover sumia). Altura PADRONIZADA de 20px para
  todos os chips/badges/botões do .pane-bar. Badges
  [MODELO] [EFFORT] (`.mini-badge`, cor do papel via --chip-hue; `prettyModel()`
  embeleza ids: claude-opus-4-8→OPUS 4.8, opus[1m]→OPUS 1M, gpt-5.2-codex→GPT-5.2
  CODEX; stats.model do JSONL tem prioridade). Botões integrar/arquivar/excluir da
  missão SAÍRAM do chrome → `.mission-actions` na linha dos filtros, à direita.

## Ajustes F4.0b (2026-07-23, noite)

- SEAT GATE escolhe também MODELO e EFFORT do Maestro (persistidos no
  maestroStore; maestro:setSeat ganhou params model/effort — mesmo seat com
  modelo novo mata o pane e renasce via resume; store.maestroSpecBump força o
  Board a rebuscar a spec). maestro:paneSpec agora aplica state.model (--model)
  e state.effort (claude --effort / codex -c model_reasoning_effort ANTES do
  subcomando resume).
- EFFORT REAL POR BANNER: o JSONL do claude NÃO registra effort (sondado) — o
  pty.ts detecta "with <x> effort" no banner do TUI e emite 'pty:effort' →
  store.paneEffort → fallback dos badges quando não há effort configurado.
- CHROME PADRONIZADO EM TODOS OS PANES (pedido do usuário, 2026-07-23): TODO
  pane mostra [MODELO] [EFFORT] + badges ↓in ↑out + barra de contexto desde o
  1º frame (ZERO_STATS exportado do PaneChrome; barra mostra "–" até a sessão
  do CLI existir). MODELO E EFFORT AO VIVO (`pty:model`/`pty:effort` →
  store.paneModel/paneEffort; tudo sondado em PTY real 2026-07-23): claude =
  banner ("Opus 4.8 (1M context) … ·", normalizado p/ opus-4.8[1m]; a forma
  solta SÓ vale em chunk com "Claude Code v…" — o picker do /model lista os
  outros modelos no mesmo formato e envenenaria o badge) + confirmação da
  troca ("Set model to Fable 5 …") + confirmação do /effort ("Set effort
  level to max …") + footer "<X> · /effort" (repinta a cada frame → effort
  muda NA HORA; níveis do claude vão ATÉ minimal/xhigh/ultra — alternação
  curta só com low..max deixava o badge mudo; o MARCADOR do footer varia por
  nível — ● high, ◈ max — e o ConPTY repinta por DIFF, só a palavra que
  mudou: NUNCA exigir o marcador nem o "with … effort" completo na detecção); codex = footer `<modelo> <effort> · ~cwd`
  (repinta a cada frame; modelo E effort juntos, mudam na hora da troca via
  /model; "extra high"→xhigh; exige "· ~"/"· C:" p/ não casar conversa).
  CADEIA nos badges: valor VIVO do TUI > configurado (spec/missão) >
  stats.model do JSONL (só atualiza no turno seguinte). O turn_context do
  rollout codex também carrega model+effort por turno (fonte reserva, não
  usada). Pane manual de CLI NÃO repete o nome do seat no título (o chip do
  seat já diz; título vazio, "· N" só com 2+ panes do mesmo seat);
  pane-espelho de execução ganhou seat (task.runSeat) e modelo (task.runModel)
  no chrome. closePane limpa paneEffort/paneModel junto com stats/activity.
- 🧹 LIMPAR no chrome do PM (maestro:cleanup): remove .md sem uso do .synkora —
  transcripts de tarefas inexistentes, runs/PLANs de missões concluídas ou
  excluídas, marcadores .done/.verdict e helpers. CONTEXT/BOARD/EVENTS e
  arquivos de missões vivas/arquivadas FICAM.
- FOTO DO PROJETO: guard contra dataURL quebrada (resize vazio não grava) +
  projects:removePhoto (botão "× remover" sob o avatar na página geral).
- Missão CONCLUÍDA na sub-aba missões não é clicável (abria pane vazio);
  copiar o código da missão dá feedback visual ("✓ código copiado!") no chip.
- CARD DONE DE MISSÃO FECHADA não tem "↩ reabrir" (bug real: reabria card de
  missão já integrada na main — worktree/branch nem existem mais). No lugar:
  "🚀 nova missão a partir deste card" — abre o NewMissionModal com
  título/goal pré-preenchidos referenciando o card ("REFERÊNCIA: card X da
  missão Y (já integrada na main)…"). missionClosed = missão concluída,
  arquivada ou excluída; card done de missão ATIVA e tarefa solta seguem com
  reabrir normal.

## Agente livre consciente + missão DIRETA (2026-07-24)

O pane manual "✦ Agente" abria o CLI CRU na pasta do projeto (= branch base) —
podia sujar/quebrar a main por fora do sistema de missões/versões. Agora:

- `panes:freeSpec` (IPC): o agente livre nasce ARMADO — `armPane` com role
  novo `livre` (HubPaneRole; MCP sem strict, mantém MCPs do seat) + persona
  `FREE_AGENT_PERSONA` nos DOIS CLIs: claude via --append-system-prompt;
  codex via `-c developer_instructions="…"` (VALIDADO em PTY real 2026-07-24,
  sonda BANANA123 — injeta developer instructions invisível; valor vai como
  string TOML de uma linha, \n/aspas escapados). freeSpec aceita `effort`
  (claude --effort / codex -c model_reasoning_effort). Pane/PaneOptions
  ganharam appendSystemPrompt e o PanesView repassa ao TerminalPane.
- MODAL DE ABERTURA (decisão do usuário): clicar num seat no menu "✦ Agente"
  abre `FreeAgentModal` (Universe.tsx) — MODELO (ModelSelect, catálogo real
  do seat) + EFFORT antes de abrir; o pane nasce com --model + effort + spec
  armada. A persona também declara AUTONOMIA total: delegate/list_seats
  (limites)/list_helpers/helper_send/helper_close/board_status/notify_maestro
  — o agente livre paraleliza igual qualquer agente do sistema.
- FILOSOFIA (decisão do usuário): agente livre = modo PRÁTICO, sem burocracia
  de cards. A persona exige: (1) NUNCA deixar a base suja — commitar sempre;
  (2) ao fim de uma sessão de mudanças, chamar `register_direct_mission`
  (title + points) → `missions.createDirect`: Mission `kind: 'direta'`, nasce
  CONCLUÍDA, goal = pontos, sem branch/orquestrador/cards; cai na versão
  corrente + addDelivery + evento ao PM. Guard: só role `livre` chama (o
  pipeline já registra o resto). Sub-aba missões mostra chip "⚡ direta";
  persona do PM ensina a tratar como changelog (nunca gerenciar).
- GUARDA CENTRAL em `mergeTaskWorktree` (worktree.ts): árvore de DESTINO com
  alterações não commitadas (`git status --porcelain -uno`) → recusa limpa
  ("agente manual/edição direta na base? commit ou stash") com branch
  preservada — cobre integração de missão, merge de tarefa e release de
  versão de uma vez.

## Relocação de projeto (2026-07-23)

Pasta do projeto renomeada/movida FORA do app quebrava tudo (o path absoluto em
projects.json envenena todo cwd derivado) e não havia como corrigir. Agora:

- `projects:list` devolve `missing` COMPUTADO (`!existsSync(path)`, nunca persistido).
  Home: card em alerta (borda tracejada, path riscado, "pasta não encontrada") + botão 📁
  "alterar pasta" em TODO card (hover, ao lado do ×); card quebrado não abre o universo —
  clique vira relocação. ProjectRail: dot vermelho + clique leva à Home.
- `projects:relocate` (IPC; `ProjectStore.setPath`) — o id NUNCA muda (todo estado é
  chaveado por id, path só existe em projects.json). Cascata, nesta ordem: mata
  killMaestroSession + todos os panes do projeto (`hub.panesOf` → ptys.kill +
  'panes:closeById') + taskRuns/phaseWatches; setPath; `repairWorktrees` (worktree.ts:
  `git worktree repair` + prune do repo NOVO — o `.git` dos worktrees em
  userData/worktrees aponta p/ o repo no caminho velho; os worktrees em si não se movem);
  migra sessões claude por seat (copia `<configDir>/projects/<slug(old)>` → slug(new) —
  o --resume resolve pelo slug do cwd) + `ensureBypassAccepted` (trust do cwd novo);
  se o seat do PM é claude e a migração falhou → reseta sessionId/tuiSessionId/personaSent
  (um --resume que não resolve travaria o pane; codex retoma por thread id, independe de
  cwd; orquestradores de missão rodam no worktree em userData — intocados); syncBoard.
  Valida colisão com pasta de outro universo; cancelar o picker não é erro.
- Guards de cwd morto: `maestro:paneSpec`/`missions:paneSpec`/`preparePhasePane`
  devolvem null com pasta faltando; `PtyManager.create` lança erro limpo (antes o spawn
  do node-pty estourava o invoke do renderer).

## Imagens, pickers e comandos do Maestro (2026-07-21 — PARCIALMENTE OBSOLETO pela F3.5)

- (F3.5) O chat estruturado do Maestro foi REMOVIDO — o Maestro agora é um pane TUI real
  (ver seção F3.5). Pickers /model/effort e autocomplete "/" do chat morreram junto: o
  TUI do próprio CLI cuida disso. maestro:send/capabilities/live seguem no main
  (dormentes na UI, usados por survey/sondas).
- Ctrl+V com imagem no painel do Maestro: main salva PNG em `<projeto>/.synkora/attachments/`
  e o path entra no prompt (o agente lê a imagem pelo caminho). IPC `clipboard:hasImage`
  (sendSync) e `clipboard:saveImage`.
- Ctrl+V com imagem nos panes TUI de execução: TerminalPane detecta via
  attachCustomKeyEventHandler e repassa o byte 0x16 ao PTY — o CLI lê o clipboard nativo.
- /model e /effort usam as CAPS do painel de fundo nos DOIS CLIs (lista idêntica ao TUI,
  descrição, ✓ no atual, "effort não suportado" p/ modelos sem reasoning); claude troca ao
  vivo via set_model, codex via override por turno. Digitar "/" abre autocomplete com os
  comandos reais (claude: todos do CLI + passthrough; codex: /status /usage /compact /mcp
  /skills via RPCs reais + os locais do Synkora).
- Catálogo `catalog.ts` (IPC `catalog:get`) alimenta ModelSelect (política de execução e
  modal ▶ executar) e o fallback de efforts. Claude: lista REAL via handshake initialize
  do stream-json com o config do seat (spawn efêmero, sem tokens; fallback = aliases
  curados); Codex: `codex debug models`. Cache renderer POR cli+seat (`catalogByCli`
  chaveado `cli:seatId`); ModelSelect só cai em texto livre se a lista JÁ carregou e o
  valor salvo não está nela (ou "outro…").
- Effort persistido por projeto (maestroStore.effort): claude `--effort <x>` no spawn;
  codex `effort` no turn/start.
- PTYs nascem com cols/rows reais do xterm (spawn em 80x24 + resize embaralhava o render).

## Titlebar Discord-mode + limites das contas (2026-07-23, noite)

- JANELA SEM MOLDURA: `titleBarStyle: 'hidden'` + `titleBarOverlay` (cor `--panel`,
  symbolColor `--panel-ink`, height 36) — os controles nativos min/max/fechar viram
  overlay sobre a barra escura. `TitleBar.tsx` desenha a barra custom no topo do
  app-shell (agora coluna: titlebar + `.app-body` com rail+main): ← voltar à esquerda
  (desabilitado na Home), NOME DO PROJETO CENTRALIZADO (`.tb-title`, pointer-events
  none p/ arrastar a janela), e botão "limites ▾" à direita antes dos controles —
  dropdown `.tb-usage-menu` com os limites reais de TODOS os seats (`seats:usage`,
  busca a cada abertura; cache de 5 min no main). Área útil via
  `env(titlebar-area-*)` (fallback 100% no devMock). O ‹ voltar e o ws-title do
  Universe MORRERAM (classes ws-title/ws-name/ws-path removidas); `.ws-actions`
  ganhou margin-left auto. Drag region: `-webkit-app-region: drag` na barra,
  no-drag nos botões/dropdown.
- /CLEAR NO PANE CLAUDE (sondado em PTY real): o ConPTY NÃO repassa ED2/ED3 —
  "limpa" apagando linha a linha e repintando o banner com o buffer velho
  intacto (pane virava sopa). Fix no TerminalPane (v2 em 2026-07-23, re-sondado:
  o v2.1.216 intercala SGR no meio do texto — `Claude Code \e[37mv2.1.216` — e
  o banner pós-/clear pode ser o COMPACTO com logo, sem a caixa `╭`; a âncora
  antiga nunca casava): CLAUDE_BANNER_TEXT_RE detecta o TEXTO "Claude Code v…"
  tolerando qualquer CSI entre as palavras, acha o ÚLTIMO cursor-home (`\e[H`)
  antes dele (sem home por perto = citação em texto de conversa, não limpa) e
  injeta um clear DE VERDADE (`\e[2J\e[3J\e[H`) nesse ponto; home num chunk já
  escrito → limpa e REPLAYA a repintura desde o home (posicionamento absoluto =
  replay idempotente). Carry de 600 chars p/ chunk cortado; validado contra os
  bytes crus das sondas (chunk único, splits e fatias de 32B). O /clear
  também começa um ARQUIVO DE SESSÃO NOVO (só na 1ª mensagem depois): o
  sessionStats agora RE-LOCALIZA a cada tick (adota arquivo estritamente mais
  novo, zera contadores, re-dispara onSession → tuiSessionId do resume nunca
  fica stale). E como o arquivo novo SÓ nasce na 1ª mensagem, /clear + fechar
  o app fazia o `--resume` trazer a conversa velha inteira de volta (bug
  real): o PtyManager acompanha o INPUT digitado (`feedInput`: linha "/" +
  Enter = comando executado; ignora CSIs, shift+enter e bracketed paste;
  ^C/^U zeram o buffer) e dispara `onCommand` → /clear (claude) e /new
  (codex) invalidam o tuiSessionId persistido NA HORA (panes `maestro-*`).
- MEDIDOR DE CONTEXTO REAL nos panes: o JSONL não registra a janela nem o [1m]
  (model vem "claude-opus-4-8" cru — sondado). Teto em 3 níveis: banner do TUI
  ("Opus 4.8 (1M context)" → pty.ts onCtxWindow → sessionStats.setWindowHint;
  sobrevive a /model e /clear; nas REPINTURAS o ConPTY troca espaço por \e[1C —
  cleanBanner normaliza, e o effort do banner agora re-emite por MUDANÇA em vez
  de latch) > marcador [1m] no modelo do SPAWN (modelHint: req.model no watch)
  > 200k. Codex segue com modelContextWindow do token_count. PanesView ganhou
  o badge de effort (paneEffort) que só o Board tinha; .spinner com flex:none +
  aspect-ratio (o flex do titlebar esticava o anel).
- LIMITES BONITOS (seatUsage.ts, sondado 2026-07-23): claude — o /usage NÃO vem
  mais em `<local-command-stdout>`: responde por mensagem assistant SINTÉTICA
  (`model:"<synthetic>"`) e o texto chega no `result` do turno → MaestroSession
  ganhou `resultText` no evento result e `formatClaudeUsage` parseia
  "X: N% used · resets Jul 25, 3am (TZ)" p/ PT-BR ("semana (geral): █░ N% usado ·
  reseta 25/07 03:00") com cabeçalho `email · PLANO` vindo do `caps.account` do
  handshake (`subscriptionType`, ex. "Claude Max"). codex — usa `limitName` do
  bucket ("GPT-5.3-Codex-Spark"; limitId "codex" sem nome → "geral") e mostra
  RESTANTE ("restam N%", barra esvaziando 100→0 — direção do TUI do codex, pedido
  do usuário). `prettyPlan`: "prolite"→PRO LITE, "Claude Max"→MAX (prefixo Claude
  cai), genérico separadores→espaço+uppercase ("pro_5x"→PRO 5X). Barra com █/░.

## F4.1 — controle de ajudantes, limites, travas e versões com sentido (2026-07-23, madrugada)

- STATS EM PANE RESUMADO (bug real): o locate do sessionStats só adotava
  arquivo com BIRTH pós-spawn — sessão retomada (--resume/resume) APPENDA num
  JSONL antigo e os badges ficavam mortos p/ sempre. Agora sem arquivo adotado
  vale birth OU MTIME recente (adoção lê o arquivo inteiro → totais da sessão
  corretos); codex vasculha 7 dias de rollouts (thread resumado mora no dia em
  que nasceu). Troca pós-/clear segue por birth estritamente mais novo.
- DUPLICAÇÃO DE TRANSCRIPT (reflow): o TUI do claude REIMPRIME o transcript
  inteiro sequencialmente (sem \e[H) em resize/reabertura — o banner duplicava
  na scrollback. A detecção do TerminalPane ganhou 2ª âncora: banner SEM home
  mas com arte/caixa (▐▛█/╭) na MESMA linha = reflow → clear no início da
  linha. Sem home E sem arte = citação em conversa (não limpa).
- MODELO CODEX EM MINÚSCULAS: política/delegate com display name
  ("GPT-5.6-Luna") dava 400 "model is not supported" — normalizado no spawn
  (pty.ts) e no turn/start (codexSession). list_seats agora devolve modelos
  como {id, label} e manda usar o id.
- CONTROLE TOTAL DE AJUDANTES (tools MCP novas): `list_helpers` (estado
  rodando/esperando/morto + última linha), `helper_output` (lê o TRANSCRIPT
  do ajudante — .synkora/runs/helper-<id8>.md, limpo/ordenado/dedupe, funciona
  até com o pane já fechado; bug real: o tail cru do PTY vinha EMBARALHADO
  pelas repinturas do TUI e a resposta final rolava pra fora — tail cru virou
  fallback; SEM LIXO: transcript entregue COMPLETO com o ajudante já morto →
  arquivo apagado na hora, e helper_close descarta o transcript após o flush),
  `helper_send` (digita e envia: responder pergunta/escolher opção),
  `helper_close`. Ajudante que morre SEM report avisa o delegador
  (helperReported evita aviso dobrado). Dono = delegador (maestro pode tudo).
- LIMITES NAS MÃOS DOS AGENTES: list_seats inclui `limites` reais por conta
  (getSeatUsage, cache 5 min, timeout 12s → "chame de novo") + dica de sempre
  delegar pra conta com mais folga.
- DELEGAÇÃO VIA ORQUESTRADOR (decisão do usuário): quem escolhe modelo/effort
  de ajudante é o ORQUESTRADOR (melhor modelo + enxerga limites), não o dev.
  Fluxo: dev manda o plano via `notify_maestro` (o texto é carimbado com
  "(de <role> · pane <paneId>)" pelo main) e ENCERRA o turno; o orquestrador
  responde na hora via tool nova `notify_pane {paneId, text}` (só role
  maestro; guarda de projeto/missão; injeta linha [synkora] no terminal do
  dev quando ocioso) com seatId + model id + effort por ajudante; o dev abre
  cada um com `delegate` usando exatamente a dica (fallback: sem resposta →
  decide sozinho via list_seats). Personas: quest hint do dev (index),
  DELEGATION ADVISOR no missionPersona e no PERSONA_TUI (PM cobre tarefa
  solta).
- ORQUESTRADOR SABE DO INÍCIO: ▶ executar publica evento com missionId
  ("usuário INICIOU o card…") — cai direto no pane do orquestrador.
- TRAVAS: card em status qa SEM run = "QA/integração em andamento" (modal
  read-only; merge falho grava feedback "merge pendente: …" e o card conclui
  sozinho quando o orquestrador resolver). Missão INTEGRANDO = overlay
  bloqueando a aba inteira (board + orquestrador) até o veredito.
- REVIEWER DE INTEGRAÇÃO CONFIGURÁVEL: página geral → "gate de integração"
  (seat+modelo+effort no maestroStore: reviewerSeatId/Model/Effort; IPC
  maestro:getReviewer/setReviewer). Cadeia: reviewer configurado > política
  qa (pesada>leve) > seat do PM.
- VERSÕES COM SENTIDO: lançada é READ-ONLY (sem add/mover/excluir item, sem
  criar missão, sem excluir a versão — já está na main). Missão sem versão cai
  na versão CORRENTE automática (`backlog.ensureDefaultVersion`: aberta mais
  antiga; sem nenhuma → "V1.0", ou minor+1 da última lançada). Branch da
  versão segue lazy (1º merge). A CAIXA "SEM VERSÃO" MORREU (decisão do
  usuário, 2026-07-24 — o mesmo trabalho aparecia riscado em "sem versão" E
  como entrega na versão): todo item nasce na versão corrente
  (createItem usa ensureDefaultVersion), item que vira missão migra para a
  versão da missão (onCreated do BacklogView), excluir versão manda os itens
  para a corrente. Migração no load: item FEITO sem versão é REMOVIDO (o
  registro real é a entrega da missão na versão); item aberto sem versão ou
  preso em lançada vai para a corrente. Sidebar sem "✧ sem versão"; seleção
  default = aberta mais antiga (fallback: lançada mais recente); select de
  mover só lista versões abertas; filtro "sem versão" da sub-aba missões
  também morreu. CRIAÇÃO AUTOMÁTICA DE VERSÃO (decisão do usuário,
  2026-07-24): sem digitar número — o sidebar oferece patch/minor/major
  calculados da versão mais ALTA existente (parseVersionName/
  cmpVersionTriples em backlog.ts, espelhados no BacklogView); lançada é
  VERDE na lista, abertas em cima (mais recente primeiro), lançadas embaixo
  (idem); lançada mostra `✓ enviadas/criadas` de MISSÕES (item 0/0 não diz
  nada); "+ nova versão" fica no TOPO do sidebar. Guardas
  (`validateNewVersion`, aplicada no IPC e no create_mission do PM): nome
  duplicado nunca, e nada numericamente ≤ à última LANÇADA ("main na 1.3 →
  1.2.12 não existe"); create_mission com versão já lançada recusa. NADA
  PENDENTE SOBE (decisão do usuário):
  release bloqueia também com ITEM de backlog aberto na versão — ou vira
  missão e é feito, ou o PM exclui via tool nova `remove_backlog_item`
  (PM-only; recusa item feito/versão lançada; acha por id ou trecho único do
  título). Migração no load do BacklogStore: item aberto preso em versão JÁ
  lançada (dado de antes da trava) volta para a caixa "sem versão". Persona
  do PM: antes de subir, varrer os itens abertos com o usuário.
- Modal de nova missão só fecha no × ou no botão "cancelar" (novo) — clique
  no backdrop não fecha. Hover de botão danger não preenche mais de vermelho
  (texto sumia). Linha "política do dept" do task modal virou grade legível.
- LIMPEZA AUTOMÁTICA PÓS-INTEGRAÇÃO (pedido do usuário): missão APROVADA no
  gate limpa os próprios arquivos na hora (`cleanupMissionFiles`: transcripts
  das tarefas da missão + marcadores, mission-<short>.*, PLAN) — o gate acabou
  de validar o trabalho; história consolidada = CONTEXT.md + entregas da
  versão. O 🧹 manual segue existindo e agora TAMBÉM pega transcript de tarefa
  de missão concluída/excluída (bug: a tarefa done ainda existe no board,
  então o filtro "tarefa inexistente" nunca pegava esses .md).

## F4.2 — telemetria de verdade + UI dos panes 100% responsiva (2026-07-24)

- BUG RAIZ DA TELEMETRIA MORTA (sondado em PTY real, 4 sondas): app lançado de
  DENTRO de uma sessão do Claude Code (`npm run dev` no Bash tool) herda os
  marcadores `CLAUDE_CODE_*`/`CLAUDECODE` no env — o CLI filho roda como
  "child session" e DESLIGA a gravação de transcript (v2.1.218 mostra o aviso
  "⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker";
  o 2.1.216 silenciava). Sem JSONL: sem badges de tokens/contexto e --resume
  morto. Mesma classe do bug do NO_COLOR. Fix: pty.ts, maestroSession.ts e
  maestro.ts DELETAM `CLAUDE_CODE_*` (menos CLAUDE_CONFIG_DIR, que não casa o
  prefixo) + `CLAUDECODE` do env de todo filho. CLI global atualizado p/
  2.1.218.
- ADOÇÃO DE SESSÃO DETERMINÍSTICA (sessionStats.ts reescrito): com N panes no
  MESMO cwd (helpers!) todos adotavam o JSONL mais novo. Agora: (1) mapa de
  CLAIMS arquivo→pane (nunca dois panes no mesmo arquivo; liberado no
  unwatch/adopt); (2) `sessionHint` extraído dos cliArgs (`--resume <sid>` /
  `resume <tid>`) = adoção EXATA (claude: `<sid>.jsonl`; codex: nome do
  rollout contém o uuid); (3) REGISTRO VIVO do claude (sondado 2.1.218):
  `<configDir>/sessions/<pid>.json` nasce no BOOT do TUI com
  {sessionId, cwd, startedAt} — resolve a sessão exata ANTES da 1ª mensagem
  (o transcript só nasce quando o usuário fala), reserva o arquivo esperado e
  dispara onSession cedo (resume persistido já); (4) pane novo sem registro:
  candidato de birth MAIS PRÓXIMO do spawn (não o mais novo de todos);
  (5) troca pós-/clear SÓ para o pane que digitou /clear//new
  (`noteReset` via onCommand do pty; o hint morre junto) — antes o /clear de
  um pane roubava o arquivo novo para os vizinhos. GUARDAS do registro
  (regressão real corrigida na mesma tarde: o maestro da Luma resumiu a
  conversa de um agente livre): entrada só vale se startedAt ≥ spawn do pane
  − 15s (processo mais velho é de OUTRO pane) E o PID estiver VIVO
  (process.kill(pid, 0) — pty morto na marra deixa o <pid>.json órfão; a
  entrada órfã casava com o próximo pane do mesmo cwd e envenenava o
  tuiSessionId persistido). E onSession do registro SÓ dispara quando o
  transcript JÁ EXISTE no disco: persistir o resume antes da 1ª mensagem
  gravava sessionId sem arquivo e o próximo spawn morria com "No conversation
  found" (2ª regressão real da mesma tarde). AUTOCURA no PtyManager: pane
  claude com --resume que imprime "No conversation found with session ID" →
  onResumeFail (main invalida o id persistido) + respawn AUTOMÁTICO do mesmo
  pane sem o --resume (o guard de identidade do onExit já protege o respawn;
  o xterm segue conectado e mostra "[synkora] a sessão antiga não existe
  mais — abrindo o CLI do zero…").
- PANES 100% RESPONSIVOS (container queries; .pane e .maestro-window viram
  container `pane`): o titlebar colapsa PROGRESSIVAMENTE — ≤760px some o seat
  e o rótulo do estado (fica o glifo); ≤640px somem os tokens ↓↑ e os rótulos
  dos botões (📚 estudar → 📚, via `<span class="btn-label">`); ≤540px somem
  effort e custo; ≤460px somem modelo e a barrinha de contexto (fica o %);
  ≤360px somem chips de versão/branch. `.pane-bar` é nowrap + overflow hidden
  e o TÍTULO é o único flexível (ellipsis) — nada estoura nem engole botão em
  largura nenhuma. Essencial sempre visível: logo, papel, contexto %, 🖐 e
  botões.
- FIT DO XTERM DEBOUNCED (TerminalPane): durante drag de resize o
  ResizeObserver disparava dezenas de fits = dezenas de SIGWINCH e o TUI
  repintava no meio da rajada (texto embaralhado). Agora: fit único 120ms após
  o fim do gesto, SÓ se cols/rows mudaram, + fit de assentamento 350ms após o
  mount (grade anima/troca data-count no nascimento). A regra "nunca fit
  escondido" segue.
- FIM DA DUPLICAÇÃO NO RESIZE (claude): mudança de LARGURA (cols) num pane
  claude já pintado arma `reflowClearUntil` — o 1º burst de dados pós-SIGWINCH
  (a repintura do ConPTY/reflow do TUI) ganha um clear real (ED2+ED3+home)
  antes: o transcript reimpresso nasce numa tela limpa, UMA cópia. Altura não
  arma (sem reflow de texto); o clear por âncora de banner segue p/ /clear e
  reaberturas. Custo consciente: scrollback anterior ao reflow morre no resize
  de largura.
- TOOLTIP CUSTOMIZADO GLOBAL: `components/Tooltip.tsx` (TooltipLayer no App)
  — QUALQUER elemento com `data-tip="…"` ganha tooltip no tema painel via
  portal (nunca clipado), delay 350ms, seta, quebra `\n` (pre-line), some em
  clique/scroll/resize. `title=` nativo NÃO se usa mais em JSX (varrido do
  app inteiro).
- SELECT CUSTOMIZADO: `components/Select.tsx` — gatilho no tema papel
  (variante `className="dark"` p/ painéis escuros) + dropdown via portal
  (flip pra cima, scroll interno, ✓ no selecionado, hint por opção) e teclado
  completo (setas/Home/End/Enter/Esc/type-ahead). TODOS os <select> nativos
  do renderer foram substituídos; regras de compat no fim do global.css
  (largura dos containers antigos; classes herdadas tipo .model-select no
  wrapper .sel têm a pintura neutralizada — o visual é do .sel-trigger).
- SCROLLBARS CUSTOMIZADAS: app papel (polegar tinta translúcido, trilho
  invisível) e painéis escuros/xterm-viewport (polegar claro discreto).
- CORRIDA DO ARQUIVO MCP (bug real: maestro nasceu com "Invalid MCP
  configuration: file not found"): remount de pane reusa o MESMO paneId — o
  kill do pty antigo roda cleanPaneMcpFile e apaga o arquivo que o armPane
  tinha acabado de (re)gravar para o pty novo. Fix: pty:create REGRAVA o
  arquivo na hora do spawn quando os cliArgs têm --mcp-config (idempotente:
  nome vem do paneId, conteúdo só depende de porta+token; port 0 nunca chega
  aqui — armPane nem inclui a flag).

## F4.3 — CLIs sempre atualizados (2026-07-24)

Bug real: o Opus 5 saiu e os panes seguiam sem ele. CAUSA (diagnosticada com o
handshake do binário): pane roda o CLI do PATH, e o `claude` do PATH estava
parado no 2.1.218 — cujo catálogo resolve `opus` → `claude-opus-4-8[1m]`. Na
2.1.219 o MESMO alias resolve `claude-opus-5[1m]`. O auto-updater do próprio
CLI não resolvia porque a máquina tem DUAS instalações (npm-global em
`AppData\Roaming\npm` + native em `.local\share\claude`) e a config apontava
para a native enquanto o PATH resolve a npm-global — ele atualizava um binário
que os panes nunca executam (`claude update` reescreveu a config para `global`).

- `src/main/cliUpdate.ts` — `updateCli`/`updateAllClis` rodam os comandos
  OFICIAIS de cada CLI (validados em PTY/exec real 2026-07-24): `claude update`
  (resolve sozinho npm-global vs native) e `codex update` (baixa o instalador
  oficial em modo não-interativo). Versão lida de `<cli> --version` ANTES e
  DEPOIS — `updated` só quando o número muda de fato; nada de confiar na saída
  ("🎉 Update ran successfully" sai até quando já estava em dia). Env sem os
  marcadores `CLAUDE_CODE_*`/`CLAUDECODE` (mesmo motivo do pty.ts). Estado por
  CLI (`unknown|updating|current|updated|missing|failed`) empurrado por
  `onCliStatus` → canal `cli:status`.
- QUANDO RODA: no boot, 2,5s depois do `whenReady` — ANTES de qualquer pane
  nascer. Trocar o binário com pane vivo é que travaria arquivo. O botão
  "clis ▾" no titlebar força a rodada (`cli:update`); chamadas concorrentes
  compartilham a mesma promessa.
- CATÁLOGO INVALIDADO POR VERSÃO: `clearCatalogCache()` (catalog.ts) no main +
  `clearCatalogs()` no store do renderer, disparados quando a versão muda — a
  lista de modelos vem do handshake do BINÁRIO e os dois caches eram eternos
  por processo, então nem reiniciar o CLI fazia modelo novo aparecer.
- Fallback curado do `catalog.ts` (e do devMock) perdeu os NÚMEROS de versão
  dos rótulos: alias aponta sempre para o mais novo da linha, e rótulo datado
  ("opus — Claude Opus 4.8") envelhece e mente. `opus` virou `opus[1m]`.
- UI: botão `clis ▾` no titlebar (à esquerda de "limites"), dropdown com versão
  + estado por CLI, botão "⟳ checar agora" e o aviso de que pane já aberto
  segue no binário antigo (só reabrir troca). Fica laranja quando acabou de
  atualizar, vermelho quando o CLI sumiu do PATH ou o update falhou.
  `.tb-actions-tight` zera o `margin-left:auto` do segundo grupo (dois autos
  dividiriam a sobra e abririam um vão no meio da barra).
- COROLÁRIO: modelo salvo como ALIAS (`opus`, `opus[1m]`, `sonnet`, `fable`)
  acompanha a versão nova sozinho; modelo salvo com id/rótulo datado fica
  preso. Política/missão nunca deve gravar display name.

## F4.4 — render da TUI e robustez dos panes (2026-07-24)

Motivo: "a TUI às vezes dá uma bugada". TUDO abaixo veio de SONDA EM PTY REAL
(bytes crus capturados de claude 2.1.219 e codex, ~66 KB, com replay da lógica
do `TerminalPane` contra esses bytes) — nada de teoria. As sondas ficam em
`scratchpad/probe-*.bin|.events.jsonl` enquanto a sessão dura.

- CAUSA Nº 1 (a "bugada" aleatória): o clear sintético era detectado por
  CONTEÚDO — texto `Claude Code v…` + arte de caixa `╭/██` — e a punição era
  `\e[2J\e[3J` (tela E SCROLLBACK). Casos reais reproduzidos: o USUÁRIO digitar
  "por que o Claude Code v2.1.219 duplica o banner?" no input (a caixa `╭` entra
  no mesmo prefixo), o Maestro LENDO este CLAUDE.md (a frase está aqui) e
  qualquer bloco com `██`. Cada um apagava o pane. Medido: 3 de 4 casos
  realistas disparavam.
- CAUSA Nº 2: `reflowClearUntil` gastava a janela no PRIMEIRO `pty:data` que
  chegasse — em streaming isso é um delta, então o ED3 caía NO MEIO da resposta
  (e o streaming nunca manda `\e[H`, então nada repintava: pane em branco) e os
  DOIS frames da repintura ficavam sem clear.
- FIX: detecção por PROTOCOLO. `FULL_FRAME_RE` — todo frame cheio do claude
  (boot, resposta ao SIGWINCH, /clear) abre com cursor-home precedido só de
  sequências neutras (`\e[?25l`, SGR, ED/EL, `\e[8;r;ct`, OSC de título), sempre
  no offset ≤ 19; durante STREAMING o claude NUNCA manda `\e[H` (0 em 307
  chunks / 18,6 KB — ele desenha com CUP absoluto). O usuário não consegue
  disparar isso escrevendo. Cada resize gera DOIS frames e os dois levam clear.
  ED3 (mata scrollback) SÓ na janela de mudança de LARGURA e no `/clear`/`/new`
  — este último via sinal REAL do comando digitado (`onCommand` no main → canal
  novo `pty:reset`), nunca por adivinhação de texto. Fora disso é ED2: tela
  limpa, HISTÓRICO PRESERVADO. Verificado por replay: streaming = 0 clears,
  cada resize = 2, boot e /clear = 1, e o payload chega intacto.
  CODEX NÃO ENTRA NESSA REGRA (medido: emite `\e[H` durante o streaming e já
  limpa de verdade no resize).
- CORREÇÃO DE FATO deste arquivo: o ConPTY REPASSA ED2/ED3 — quem nunca emite
  ED é o próprio claude, que repinta linha a linha.
- SUPERADA PELA F5.1 (ver abaixo): esta seção inteira tratava SINTOMA. A causa
  raiz era o ConPTY INBOX repintar o buffer visível a cada resize; com o
  `useConptyDll` a detecção de frame cheio por `FULL_FRAME_RE` foi REMOVIDA.
- `windowsPty: {backend:'conpty', buildNumber}` no xterm (build real via
  `window.synkora.host`, novo no preload). SEM isso o xterm PUXA scrollback
  para dentro do viewport quando as linhas crescem, enquanto o ConPTY faz o
  contrário (empurra linhas vazias no rodapé e mantém a mesma linha no topo —
  bytes: `\e[?25l\e[8;34;80t\e[H` + 34 linhas, as últimas só com `\e[K`). Medido
  em xterm real: pane crescendo de 20→34 linhas PERDIA 14 linhas do histórico
  (exatamente o crescimento); com a opção, 60 linhas → 60. Só isso muda:
  conferido em `Buffer.ts:184/296` e `CoreTerminal.ts:253` que o reflow já está
  ligado nos dois casos e a heurística de "wrapped" só valeria com build <
  21376. NUNCA usar `windowsMode: true` (liga a heurística E desliga o reflow).
- POWERSHELL SEM POLÍTICA (bug latente que quebraria TUDO): o `claude` do PATH
  resolve como `claude.ps1` (npm-global) e a política padrão do Windows client é
  Restricted → "o arquivo claude.ps1 não pode ser carregado". Hoje não aparece
  porque o app costuma ser lançado de DENTRO de uma sessão do Claude Code, que
  exporta `PSExecutionPolicyPreference=Bypass` e o filho HERDA; pelo atalho ou
  de um terminal limpo, todo pane claude nasceria morto. Provado em PTY real com
  o comando exato do pane (sem a flag: bloqueado; com: `claude 2.1.219`). Fix:
  `-ExecutionPolicy Bypass` nos args do pane (escopo de PROCESSO, não mexe na
  máquina).
- ORÇAMENTO DE WEBGL (`WEBGL_BUDGET = 12`): o Chromium mata o contexto MAIS
  ANTIGO quando o 17º nasce e NUNCA restaura (medido: 18 panes → 2 caem para o
  renderer DOM, e são os 2 mais velhos = Maestro). O estrago é ~3s de pane
  congelado + queda permanente para o DOM, onde `customGlyphs` não vale e as
  caixas `╭─│╰` passam a vir da fonte ("caixas desalinhadas"). Melhor nascer no
  DOM de propósito do que derrubar o vizinho.
- `altClickMovesCursor: false` (alt+clique DIGITAVA uma rajada de setas no PTY,
  mexendo no picker/histórico sozinho — caminho de mouse, não passava pelo
  attachCustomKeyEventHandler) e `rescaleOverlappingGlyphs: true`.
- GUARD DE TAMANHO por CONTENT BOX: `offsetWidth/Height` INCLUEM o padding do
  `.terminal-host` (18×20 com content box zerado) e o guard passava — o FitAddon
  então grampeia em `MINIMUM_COLS=2 / ROWS=1` e manda `resize(2,1)` ao ConPTY (o
  TUI reflowa tudo para 2 colunas). Agora usa `getComputedStyle` ≥ 40px.
- PANE QUE NASCE ESCONDIDO (orquestrador em segundo plano, aba/universo
  inativo) spawnava o CLI em 80x24 de fábrica. Agora nasce com o último tamanho
  BOM do próprio pane (`localStorage synkora.paneSize.<paneId>`, gravado a cada
  fit) ou 120x30.
- REFUTADO com sonda (não repetir a ideia): largura de emoji NÃO é a causa de
  desalinhamento — `⏺ ⏸ ⚡ ✅ ✓ ▶ ● ─` valem 1 no ConPTY E no xterm. Só emoji do
  plano 1 (🖐 🚀) divergem (ConPTY 2 × xterm 1). E NÃO instalar
  `@xterm/addon-unicode-graphemes`: ele passaria `⏺/⏸/⚡/✅` para 2 e quebraria o
  acordo com o ConPTY justamente nos caracteres mais frequentes do claude.

### HÍBRIDO fixo/elástico (decisão do usuário, 2026-07-24)

O ▢ focar continuava embaralhando a TUI (salto enorme de largura — caso que as
sondas não cobriram). Decisão: **na grade o PTY NUNCA é redimensionado**.

- `TerminalPane` ganhou `fixedZoom`: com a flag o terminal nasce e fica em
  `FIXED_COLS × FIXED_ROWS` (100×30) e a TUI cabe no pane por ZOOM — só o
  `term.options.fontSize` muda (`applyZoom`, itera 4× porque a métrica da célula
  não é linear no tamanho da fonte). Abrir/fechar pane vizinho, trocar de aba,
  redimensionar a janela ou trocar de universo passam a NÃO gerar SIGWINCH
  nenhum: sem repintura do ConPTY, sem reflow, sem duplicação. É também o fim do
  problema do "pane que nasce escondido" (o tamanho não depende de medida).
- Ao FOCAR (▢) o pane vira ELÁSTICO: `applyFit` devolve a fonte para 13, faz o
  fit real e redimensiona o PTY UMA vez — o único momento em que o usuário está
  olhando de perto. Voltar para a grade restaura 100×30 (outro resize, também
  sob o olhar do usuário). O clear anti-duplicação continua armado nos dois.
- `PanesView` passa `fixedZoom={focusedPane !== pane.id}`. O Maestro/orquestrador
  (coluna lateral, largura arrastada pelo usuário) segue ELÁSTICO — lá o resize é
  intencional e a alça já é debounced.
- O modo vive num REF (`fixedRef`) + efeito SEPARADO: `fixedZoom` NÃO pode entrar
  nas deps do efeito principal, senão focar um pane remontaria o xterm e mataria
  o PTY. `container.dataset.mode` = `fixo|elastico` (âncora de depuração).

### Robustez dos panes (mesma leva, achados de sweep verificado)

- `pty:kill` NÃO desarma mais o pane. Esse canal chega a CADA REMOUNT do
  TerminalPane (cliArgs novos vindos de um paneSpec, troca de seat) — e ele
  apagava o token, a identidade no hub e o `userData/mcp/<paneId>.json` que o
  `armPane` tinha ACABADO de gravar para o pty que ia nascer: o Maestro subia
  com `--mcp-config` apontando para arquivo inexistente e SEM NENHUMA tool
  synkora. O desarmamento vive no `onExit`, com GUARD DE GERAÇÃO (token
  capturado no spawn × token corrente).
- `onExit` do PtyManager voltou a rodar em kill explícito: a guarda
  `this.ptys.get(id) !== pty` era mais larga que a intenção (kill apaga o mapa
  ANTES do processo morrer, então `undefined !== pty` engolia TODO exit de kill)
  — e com ele morriam a devolução da tarefa ao backlog, a missão presa em
  "integrando", o aviso ao delegador do ajudante e o `pane-close`.
- ESTADO GLOBAL QUE VAZAVA ENTRE UNIVERSOS (universos ficam montados): agora é
  por projeto — `maestroSpecBumpByProject` (trocar o seat num projeto matava e
  respawnava o Maestro de TODOS os outros), `universeTabByProject` (pane aberto
  num projeto de FUNDO arrastava para a aba Panes o universo visível),
  `surveyBusyByProject`. Os `load*` por projeto ganharam guarda de corrida
  (`get().openProjectId !== projectId` → resposta atrasada não sobrescreve mais
  o universo visível).
- Telemetria (`paneStats/paneModel/paneEffort/paneActivity`) é zerada no
  NASCIMENTO do pane (`resetPaneTelemetry`): só `closePane` limpava, e o pane do
  PM/orquestradores nunca passa por lá — respawn de mesmo id exibia ↓/↑,
  contexto e "■ parado" da sessão MORTA sobre um terminal vazio.
- Card travado em "em execução" para sempre quando o CLI do pane morre sozinho:
  `livePaneOf` ignora pane com `paneActivity === 'dead'`.
- MEDIDOR DE CONTEXTO DO CODEX estava cravado em 100%: usava
  `total_token_usage` (ACUMULADO da sessão). Rollout real de 27 turnos:
  2.631.002 contra janela de 258.400 = 1018% vermelho, pedindo /compact, quando
  o contexto vivo (`last_token_usage`) era 139.563 = 54%. E o `↓in` somava
  `cached_input_tokens` (que é SUBCONJUNTO de `input_tokens` — conferido:
  input 13362 + output 10 == total 13372), inflando ~1,75×.
- Entradas `assistant` com `model:"<synthetic>"` (avisos locais do CLI: limite,
  crédito, login) têm `usage` com tudo em ZERO e zeravam o medidor de contexto
  do claude bem na hora em que ele importa — agora são ignoradas.
- `.pane-grid` ROLA (`overflow-y: auto`): a partir de ~7 panes as fileiras
  somavam mais que a altura e as últimas ficavam cortadas e inalcançáveis (nem
  o × dava para clicar).
- `.pane.needs-perm` finalmente PULSA (a classe existia sem CSS para `.pane` —
  o único sinal era o 🖐 de 12px no titlebar). O 🖐 agora é POR PANE
  (`paneAttention`): dev, ajudantes e gate dividem o taskId e acendiam todos.
- Alça de resize do Maestro virou elemento próprio na borda ESQUERDA
  (`.maestro-resizer`): o `resize: horizontal` do navegador desenha o grabber no
  canto inferior DIREITO e soma `x − x0`, mas o `.board-main` é `row-reverse`
  (o painel cresce para a esquerda) — a alça grudava na borda da janela e o
  gesto era invertido. Precisa ser o ÚLTIMO filho de `.maestro-window`, senão o
  React remonta o `.maestro-body` e MATA o PTY do Maestro.
- `pty.create` sem `.catch` deixava o pane PRETO e mudo quando o cwd não existia
  (a rejeição morria como unhandled). O agente livre também recusa nascer com
  spec nula (seria um CLI CRU na branch base, sem persona nem MCP).
- Relocar a pasta pela página ✦ geral deixava a área central EM BRANCO (o id
  saía de `mountedProjects` e ninguém renderizava): agora remonta por chave
  (`remountNonce`).
- Missão integrada/arquivada com a aba aberta deixava o board numa aba fantasma
  sem terminal: `selMission` só considera missão VIVA e a aba volta para ✦ geral.

## F5.0 — canvas de janelas livres (2026-07-24) — APOSENTADA pela F5.1

A aba PANES virou um canvas de janelas absolutas arrastáveis (`.pane-canvas`,
`paneLayout`, `arrangePanes`, modo monitor, `.pane-resize`). O usuário NÃO
gostou e pediu outra coisa; tudo isso foi REMOVIDO na F5.1. Fica registrado só
para não ser reinventado:
- a inspiração citada ("bridgemind") NÃO é um produto de canvas — o BridgeSpace
  é um ADE irmão do Synkora, com grade ladrilhada e abas. O canvas livre foi
  extrapolação, não referência;
- posicionamento livre de terminal é o modo que MAIS provoca resize de PTY, que
  é a operação mais cara e mais frágil do app.

## F5.1 — CONSTELAÇÃO & PALCO + a causa raiz da TUI bugada (2026-07-24)

### A CAUSA RAIZ (provada, não hipótese) — `useConptyDll`

Toda a família "a TUI não para de bugar" (banner duplicado, texto embaralhado,
rodapé cortado, pane virando sopa) tinha UMA causa: **no Windows o ConPTY
INBOX repinta o buffer visível inteiro a cada resize, inclusive quando só a
ALTURA muda.** Sonda nesta máquina com as TUIs reais:

|                        | claude inbox | claude dll | codex inbox | codex dll |
|------------------------|-------------|-----------|-------------|-----------|
| 12 resizes (arrastar)  | 23.094 B    | **28 B**  | 22.739 B    | 2.188 B   |
| só ALTURA              | 1.088 B     | **12 B**  | 7.254 B     | 419 B     |
| encolher largura       | 1.825 B     | 1.295 B   | 4.521 B     | **38 B**  |

O `@lydell/node-pty` JÁ EMPACOTA o ConPTY v2 do Windows Terminal
(`prebuilds/win32-x64/conpty/conpty.dll`, FileVersion 1.25.2603.03002, assinado
Microsoft) e expõe `useConptyDll` — a mesma opção que o VS Code publica como
`terminal.integrated.windowsUseConptyDll`. Ligada no spawn de `pty.ts`, com
escape hatch em `settings.conptyDll` (IPC já existente) para desligar sem
rebuild. `PtyManager.clear(id)` (ConptyClearPseudoConsole) passou a ser chamado
no `/clear`//new`, que é a forma OFICIAL do que o clear sintético fazia na mão.
ARMADILHA MEDIDA: o ConPTY v2 manda `\e[c` no boot e BLOQUEIA a saída ~3,2s
esperando resposta — o xterm responde sozinho SÓ porque o `termName` default é
"xterm". **NUNCA setar `termName` no Terminal do renderer** (comentário-âncora
no TerminalPane). Ao empacotar:
`"build": { "asarUnpack": ["**/node_modules/@lydell/node-pty-*/**"] }` — a DLL é
carregada por LoadLibraryW num caminho de disco e morre dentro do asar.

REMOVIDO em consequência (eram todos sintoma): `FULL_FRAME_RE` + `hardClearUntil`
(detecção de frame cheio por bytes — heurística sobre conteúdo que o usuário
controla), o MODO FIXO 100x30 e o `applyZoom` de fonte. Panes voltaram a ser
elásticos: fit real, resize real, sem repintura.

### O CLAUDE RODA EM ALT-SCREEN (`\e[?1049h`) — corrige o que eu afirmei antes

Capturado no boot de um pane, no app real:
`\e[?1049h\e[2J\e[H\e[?1000h\e[?1002h\e[?1003h\e[?1006h`. O CLI entra no BUFFER
ALTERNATIVO, como vim e htop, e liga rastreamento de mouse. Consequências que
invalidam raciocínios anteriores deste arquivo:
- **não existe scrollback para vazar** — toda a teoria de "o reflow empurra o
  frame antigo para o histórico" (e a tentativa do `backend: 'winpty'`) atacava
  um mecanismo que não existe aqui;
- a barra de rolagem do xterm SOME de propósito no pane, e o que sai por cima
  NÃO VOLTA. Quem rola é o próprio claude (`Jump to bottom (ctrl+End)`);
- sobra UMA explicação para conteúdo perdido, e ela é aritmética: **o frame do
  claude ocupa ~25 linhas; se o ladrilho tiver menos, o frame rola dentro do
  alt-screen e o topo se perde.**

Por isso o mosaico é 2×2 (decisão do usuário, 2026-07-24): três colunas davam
~28 linhas por ladrilho e o banner + prompt longo ecoado não cabia. `MAX_LIVE`
= 4; o excedente vira cartão-vivo.

### A DUPLICAÇÃO QUE SOBRAVA: REDIMENSIONAR DEPOIS DE JÁ TER TEXTO

**Regra única, e é a que importa: não redimensionar um pane depois que ele já
imprimiu.** O claude limpa apenas `rows` linhas a partir do home (medido:
`\e[H` + 30× `\e[2K\e[1B`, zero ED2/ED3), então o que já rolou para cima do
viewport não é apagado por ninguém — e a repintura na largura nova vira uma
SEGUNDA cópia. Nenhum clear alcança aquilo sem ED3, e ED3 apaga a conversa.

Dois gatilhos reais, os dois corrigidos:
1. **Geometria do mosaico dependia da CONTAGEM de panes** (colunas por √n).
   Abrir um ajudante levava a grade de 2 para 3 colunas, TODOS os ladrilhos
   mudavam de largura, TODOS os terminais eram redimensionados e TODOS
   reimprimiam. Mandar o Maestro "abrir 5 panes de sonnet" produzia cinco ondas
   de repintura sobre texto existente — era isso na tela do usuário. Agora
   `geometryFor(w, h)` é FUNÇÃO PURA DO PALCO: abrir/fechar pane só
   acrescenta LINHAS na grade, e linha extra não toca em terminal nenhum.
2. **Pane que nasce ESCONDIDO** bootava num tamanho de chute e era
   redimensionado ao aparecer. `MEASURED_BY_GROUP` (TerminalPane): ladrilhos do
   mesmo grupo têm caixa IDÊNTICA, então o primeiro que se mede publica o
   tamanho real e os escondidos já nascem certos — o resize ao aparecer vira
   no-op. A ESTIMATIVA (cols por proporção da fonte) erra feio — medido: dizia
   63x19 onde o real era 94x28, e o CLI nascia num frame estreito cujas quebras
   de linha sobravam por baixo do frame largo depois (fragmentos ".md file…",
   "-opus-5`…" na tela do usuário). Por isso o pane escondido ESPERA até 4s por
   uma medida real de um irmão antes de nascer (ajudantes nascem em bloco:
   basta um aparecer). Só então cai na estimativa.
3. **O PTY não nasce durante animação.** `startPty` só é chamado quando a caixa
   está estável (duas medidas iguais) — o `stage-transition` bloqueava o fit
   mas NÃO o spawn, e o pane nascia medido no meio da animação de 420ms da
   coluna do mapa.
4. **`scrollbar-gutter: stable` no `.stage-grid`.** Com `auto`, a barra
   aparecia → o palco perdia ~15px → o ladrilho encolhia → o terminal
   redimensionava → a grade encolhia → a barra sumia → recomeçava. Medido:
   rajada de 7 resizes em 1,5s. Ladrilho também quantizado em múltiplos de 8px.
5. **Piso de 60 colunas / 12 linhas** (era 40/8): a 40 colunas a TUI do claude
   sai embaralhada — visto na tela.

DIAGNÓSTICO POR INSTRUMENTAÇÃO, não por dedução: `SYNKORA_PROBE=1` liga em
`pty.ts` o log de cada resize (`[probe] RESIZE id antes -> depois`) e de cada
chunk nos 3s seguintes (home/EL2/ED2/banner + prefixo escapado). Foram três
diagnósticos meus errados em sequência antes disso; o primeiro log resolveu em
minutos. Ligar antes de teorizar.

### TENTATIVA DESCARTADA: desligar o reflow do xterm (`backend: 'winpty'`)

A hipótese era: a cópia está no SCROLLBACK e quem a coloca lá é o reflow do
xterm (`_reflowSmaller` incrementa ybase/ydisp, Buffer.ts:446-466). Os gates
foram conferidos no código instalado e `backend: 'winpty'` é de fato a única
combinação que dá reflow OFF (Buffer.ts:296-302) + heurística de wrapping OFF
(CoreTerminal.ts:255-258) + crescimento de linhas do ConPTY ON (typings:292).

**TESTADO NO APP: não funcionou.** A duplicação continuou E apareceu uma
regressão feia — sem reflow, texto impresso numa largura maior fica CLIPADO ao
estreitar. Custou legibilidade e não comprou nada. REVERTIDO para
`backend: 'conpty'`. Nunca forçar `buildNumber` abaixo de 21376 para desligar
reflow: isso LIGA a heurística de wrapping, que assume linha quebrada quando o
último caractere não é espaço (colar caixa `╭─│╰` viria tudo grudado).

Lição: a cadeia causal fechava no papel e mesmo assim estava errada — só o app
real decide.

**UM GESTO = UM RESIZE.** Não existe caminho rápido, e a tentativa de criar um
custou caro: seguindo a separação de eixos do VS Code ("vertical resize is
cheap"), apliquei a ALTURA na hora, a cada evento do ResizeObserver. Arrastar
dispara o observer dezenas de vezes ⇒ dezenas de SIGWINCH ⇒ o claude IMPRIME o
frame a cada um (ele imprime, não repinta no lugar) ⇒ **três banners empilhados
na tela**, exatamente o bug que se estava caçando. A sonda que dizia "altura
custa 12 bytes" mediu um PTY com a tela quase vazia; com transcript de verdade
a altura reimprime igual. O debounce por ESTABILIDADE (220ms + duas medidas
iguais seguidas) é o único caminho.
Do resto da receita do VS Code, o que ficou e vale: ordem `term.resize` primeiro
e o que vai ao PTY lido DE VOLTA do xterm (nunca o valor calculado pelo fit), e
guarda de `Number.isFinite` — `NaN < MIN_COLS` é false, os pisos não protegeriam
sozinhos. E o clear armado dispara em QUALQUER resize, não só de largura.

NÃO FAZER: `windowsMode: true` (removida da API pública na 6.0.0, liga a
heurística); `term.clear()` (destrói o scrollback inteiro) ou `term.reset()`
(é RIS, derruba modos que a TUI ligou sem ela saber); `reflowCursorLine: true`
(liga MAIS reflow, justo no bloco do cursor que o código deixa para o programa
consertar); coalescer resize no main; esperar correção upstream (a tentativa de
alinhar reflow ao conpty, xterm.js#5321, foi REVERTIDA em #5358 — "the buffer
could essentially get bricked").

### COLUNAS FIXAS, FONTE ELÁSTICA (TENTATIVA DESCARTADA — não repetir)

Antes de achar o reflow, tentei fixar as colunas e crescer a FONTE até 20px
para preencher a largura. O usuário reprovou na hora: **pane largo virava letra
gigante**. Densidade de texto é parte da identidade visual do terminal.
Nenhum dos emuladores pesquisados (VS Code, waveterm, tabby, hyper, ttyd,
wetty) faz isso — todos são elásticos; o único precedente é player de gravação
(asciinema). A fonte fica em 13px (12/11 em mosaico denso, via prop) e o
terminal acompanha a caixa.

### O CLEAR ARMADO (o que sobrou dele)

Vira CINTO DE SEGURANÇA, não a cura: o claude apaga exatamente `rows` linhas
COMO ELE as conhece, então se o xterm já cresceu e o ConPTY ainda não, resta
lixo no rodapé — o ED2 cobre o viewport e resolve. O `TerminalPane` arma uma
janela de 2s **só depois de um resize que NÓS pedimos** (nunca por leitura de
conteúdo — era isso que fazia texto do usuário apagar o pane) e injeta
`\e[2J\e[H` NO PONTO do primeiro cursor-home, fatiando o chunk (o que vem antes
do home seria reescrito depois do clear e apareceria fora de lugar). Detectar
`\e[H` **e** `\e[1;1H`: o claude usa as duas formas e detectar só a curta
deixava metade das repinturas passar (bug real). Nunca ED3.

Higiene junto: `PtyManager.resize` exige o pty existir antes de gravar em
`sizes` (senão o dedupe MENTIA e o pane ficava com quebra de linha errada para
sempre); alça do Maestro (Board) escreve a largura em rAF e liga
`body.stage-transition`; o debounce do fit passou a exigir ESTABILIDADE (só
refita quando a caixa medida repete); `hasRealSize` subiu para 200×80 e o fit é
grampeado em 40 cols / 8 rows; `windowsPty` só com build ≥ 21376 (abaixo disso a
opção desliga o reflow do xterm); `onScroll → refresh` coalescido em rAF e só no
modo DOM.

## F5.2 — canvas encaixável + Claude 2.1.220 fullscreen (2026-07-27)

O usuário voltou a pedir painéis elásticos como BridgeMind/overclock.sh. O
layout passou a ser um docking direto: arrastar qualquer cabeçalho e soltar nas
zonas do alvo encaixa à esquerda/direita/em cima/embaixo, o centro troca os
panes, e os botões do cabeçalho fazem o pane ocupar a coluna inteira, a linha
inteira ou o canvas. Os antigos presets AUTO/1+/GRADE/COL/LIN foram removidos.
O deck continua uma lista plana e estável; só as caixas absolutas mudam, então
reorganizar ou trocar de página nunca remonta o `TerminalPane` nem mata o PTY.

O docking é uma árvore binária serializável por página. Cada página aceita no
máximo 6 panes; o excedente abre uma nova aba `Página N`, e fechar um pane não
remaneja silenciosamente os panes das outras páginas. `CANVAS_GAP=0` mantém o
mosaico grudado e os divisores têm hitbox sobreposta, sem marcador visual no
meio. Quando a emenda é entre dois panes, o resize altera somente o par
adjacente; em uma costura compartilhada por uma subárvore, o grupo muda porque
não existe geometria retangular sem buracos. `resizeDockDivider` transporta por
transformação afim todos os overrides locais do mesmo eixo dentro dos dois
filhos: mover `pane full-height | grade` escala as costuras de cada linha, então
larguras iguais continuam iguais; overrides ortogonais e outros grupos ficam
intactos. O mínimo é recursivo: split em x
soma larguras, split em y soma alturas. Cada folha reserva 220×210px; numa janela
menor que a soma ideal, a falta é distribuída sem deixar uma subárvore sumir e o
divisor só aceita o movimento que melhora o lado deficitário. Encaixar um pane
existente numa borda composta troca com a folha daquela borda que cruza a mesma
faixa perpendicular (por exemplo, o pane à direita da mesma linha). Isso mantém
a grade e os mínimos; coluna/linha full-span continuam ações explícitas dos
botões do chrome.

O drop é resolvido novamente no `pointerup` usando a coordenada do próprio
evento e a geometria atual. O eixo dominante do gesto limita as zonas: arrasto
horizontal considera esquerda/direita; vertical considera topo/baixo. Sem isso,
um gesto lateral iniciado no cabeçalho era confundido com `top` e parecia
bloqueado, sobretudo nos extremos esquerdo/direito.

Todo chrome de pane, inclusive Maestro e orquestradores, tem altura fixa de
36px e ações alinhadas à direita. A informação cede espaço progressivamente:
os rótulos dos botões viram ícones, effort permanece enquanto cabe, papel vira
símbolo em pane muito estreito e título/modelo só somem no piso compacto. O
buffer normal mantém a scrollbar do DOM real do xterm 6 quando `length > rows`.
No alternate screen de Claude/Codex não existe range público: o histórico e o
scroll pertencem à própria TUI. Por decisão de confiabilidade, NÃO existe mais
barra externa/virtual, estimativa de posição, fingerprint ou probe. O xterm
encaminha a roda nativamente ao protocolo de mouse da TUI (ou setas quando ela
não pede mouse), e o próprio `Jump to bottom (Ctrl+End)` é a fonte de verdade.
Quando houver scrollback normal, volta o controle nativo simples do xterm, com
range real e desaparecimento automático quando tudo cabe. No modo imerso a faixa do palco
some, mas `mapa` e `sair do imerso` continuam no topo da espinha lateral.
`terminalGeometry.ts` e o fit imediato do
`TerminalPane` mantêm fonte/colunas coerentes durante o resize, sem cache de
120x30 vazando entre larguras diferentes.

O bug reproduzido em Claude 2.1.220 tinha duas causas independentes:

1. O CLI voltou a iniciar no renderer clássico, baseado em scrollback. A
   repintura dele se misturava ao reflow do xterm e deixava molduras antigas.
   `pty.ts` força, somente no processo do pane Claude,
   `CLAUDE_CODE_NO_FLICKER=1`; no Windows também força
   `CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT=1`. O boot entra em `CSI ?1049h` e cada
   shrink/grow testado emite ED2+home+frame autocontido. O clear sintético do
   `TerminalPane` foi removido; ED3 continua apenas no reset explícito.
2. Dois panes de ~394px estavam nascendo com uma geometria estimada diferente
   da caixa real. Claude conserva 60 colunas quando a medida física comporta o
   frame; em caixas genuinamente compactas o fallback cai para 24 para o buffer
   não ficar mais largo que o viewport e cortar a borda direita. O divisor usa
   o piso recursivo 220×210 e a fonte continua padronizada entre os panes.

Também removido `windowsPty` do xterm: ele modela o ConPTY inbox, mas o A/B com
a DLL v2 mostrou linhas vazias ao crescer 58→80; o comportamento padrão do
xterm restaurou o scrollback corretamente. A DLL moderna segue ligada no main.

Validação no app real, com `SYNKORA_PROBE=1`: dois panes Claude lado a lado,
um deles reduzido a ~390px, divisor de volta ao centro e janela
maximizada/restaurada. Cada gesto terminou em um único resize por pane; os
bursts começaram em ED2+home e as duas TUIs permaneceram íntegras.

### O DESENHO (decisão anterior, superada em Panes pela F5.2)

Mapa à ESQUERDA, terminais à DIREITA. Arrastar/redimensionar livre existe só nos
CARDS do mapa; terminal só vive em geometria fixa (o usuário abriu mão do
posicionamento livre justamente por isso).

- `ConstellationMap.tsx` — papel + campo de estrelas com seed estável por
  projeto (`starField`), NÚCLEO do projeto ao centro (foto, nome, N missões
  ativas, N painéis ativos) e um card por nó em anel determinístico
  (`ringPositions`; dois anéis a partir de 7 nós). Fios são bézier núcleo→card
  com marching ants SÓ quando há pane rodando de verdade, e em `--err` com ants
  invertidas quando há 🖐 pendente. Card arrasta com `setPointerCapture` +
  `pointercancel`, clamped à caixa, commit só no `pointerup` (durante o gesto o
  transform e o `d` do fio são escritos direto no DOM em rAF); duplo-clique
  devolve à vaga do anel. O NÚCLEO é CARTÃO-FANTASMA do Maestro: telemetria
  viva, mas clicar leva ao Board — o pane do PM mora lá e reparent MATA o PTY.
- `panesNodes.ts` — agrupamento. Um nó por missão viva, mais "Geral" (panes
  soltos) e "Órfãos" (missão concluída/arquivada com terminal ainda de pé —
  sem esse nó o pane sumia da tela e continuava rodando invisível). Execução de
  tarefa e ajudante NÃO viram nó: são panes DENTRO do nó da missão, e é isso
  que segura ~10 cards com 30 terminais abertos. Cadeia de resolução
  pane→missão: `pane.missionId` (novo, carimbado pelo main a partir da
  `PaneIdentity`) → tarefa → regex `maestro-<pid>--<mid>` → cwd = worktree.
- PALCO EM MOSAICO (decisão do usuário: mosaico direto, não "1 grande +
  trilha"). Ladrilho de tamanho CONSTANTE para um dado (palco × contagem):
  `geometryFor` escolhe colunas por `min(√n, largura/300, 4)` e a grade ROLA
  acima do que cabe, em vez de espremer o ladrilho abaixo do legível.
- **ACIMA DE 9 LADRILHOS** (a pergunta do usuário): o excedente vira
  CARTÃO-VIVO — mesmo ladrilho, mesmo cabeçalho (LED, seat, [MODELO],
  ↓in ↑out, contexto %, 🖐) e no corpo **as últimas 6 linhas que o agente
  escreveu**. Não é preguiça: abaixo de ~300px um terminal deixa de ser
  legível, então o texto puro informa MAIS que uma TUI espremida. Como o
  ladrilho tem o MESMO tamanho, clicar num cartão para promovê-lo custa ZERO
  resize (só muda a ordem visual). Ordem em qualquer corte: 🖐 > rodando >
  último promovido > criação.
- Canal novo `pane:lastlines` — o `flushLog` do `pty.ts` já produzia linhas
  limpas de ANSI e sem repetição; guarda as 8 últimas e emite com debounce de
  400ms (`store.paneLastLines`). É o que faz "vigiar 20 agentes" funcionar sem
  pintar 20 terminais.
- INVARIANTE ESCRITO NO CÓDIGO: o deck de panes é uma LISTA PLANA renderizada
  SEMPRE na mesma posição do JSX. Ancorar nó, promover, expandir e ir para
  imerso mudam só `className`, `style` e a propriedade CSS `order` — o DOM não
  se reordena. Wrapper condicional, `{cond && <deck/>}` ou portal desmontariam
  o `<TerminalPane>` e MATARIAM o PTY.
- Estado da aba é POR PROJETO (`panesUiByProject`, `mapLayoutByProject`):
  `focusedPane`/`monitorMode`/`paneLayout` estavam na RAIZ do store enquanto os
  universos ficam todos montados — abrir um 2º projeto sobrescrevia o arranjo
  do 1º e contaminava o localStorage dos dois. O loader MESCLA por projeto.
- Pane novo com nada ancorado ABRE o nó dele sozinho — senão abrir um agente
  livre levava para a aba Panes e mostrava só o mapa, com o terminal escondido
  atrás de um clique que o usuário não sabe que precisa dar.
- Teclado: `Ctrl+Alt+M` mapa · `Ctrl+Alt+F` imerso · `Ctrl+Alt+P` próximo 🖐 ·
  `Ctrl+Alt+←/→` troca o pane promovido · `Ctrl+Alt+1..9` ancora o nó N. O
  `TerminalPane` bloqueia o repasse de Ctrl+Alt ao TUI. **NUNCA usar Esc nem
  Esc-Esc**: o claude usa os dois (cancelar / editar mensagem anterior).
- ORDEM DOS LADRILHOS = ORDEM DE CRIAÇÃO, e ponto. A primeira versão ordenava
  por atividade (🖐 > rodando > parado) e o estado de um pane alterna entre
  'run' e 'idle' a cada 4 SEGUNDOS: os ladrilhos ficavam TROCANDO DE LUGAR
  sozinhos debaixo do mouse (bug real, reportado). Quem precisa de atenção se
  anuncia por COR e pelo Ctrl+Alt+P, NUNCA pulando de posição.
- FOCAR (▢) exige `grid-template-rows: 1fr` + `align-content: stretch` no
  `.stage-grid.has-expanded`: sem linha DEFINIDA o `height:100%` do pane resolve
  contra uma linha `auto` de altura indefinida e a caixa colapsa — era o
  "cliquei em focar e bugou tudo".
- ARMADILHA DE MEDIÇÃO (custou tempo, não repetir): validar layout pelo preview
  do navegador com o painel OCULTO dá resultado FALSO — sem compositing não
  rodam `requestAnimationFrame`, `ResizeObserver` nem transições CSS, e uma
  transição inacabada faz `getComputedStyle` devolver o valor INICIAL para
  sempre. Isso me levou a "diagnosticar" uma interpolação quebrada de
  `flex-basis` que não existia. Para medir layout ali, injetar
  `*{transition:none!important;animation:none!important}` antes.

## F5.3 — barra de scroll overlay dos panes (2026-07-27)

A scrollbar nativa do `.xterm-viewport` morreu (display:none, devolve ~9px ao
FitAddon) e o indicador dos panes é o overlay `.term-scroll`, criado pelo
TerminalPane em DOM imperativo dentro do `.terminal-host` (filho JSX ali
misturaria a reconciliação do React com o DOM do xterm). Só BUFFER NORMAL
(shell, saída fora do TUI): posição REAL via `viewportY/baseY/length`
(onRender coalescido em rAF + dirty-check). Autohide estilo VS Code: visível
fora do fundo (lendo histórico), em hover/drag e ~1s após a roda; arrastar
rola de verdade (scrollToLine), clique no trilho salta proporcional. Output
com o viewport no fundo NÃO acorda a barra (senão piscaria o streaming
inteiro).

ALT-SCREEN (TUI claude/codex) FICA SEM BARRA — decisão FINAL do usuário
(2026-07-27, "deixa sem então, como estava"), tomada após DUAS alternativas
construídas e testadas na mesma tarde. NÃO REINVENTAR nenhuma delas:
(1) manípulo de grip fixo no centro injetando roda SGR (`\e[<64/65;x;yM`,
?1006) no drag — rejeitado: "não se mexe, tá no meio", barra que não
acompanha o gesto lê como quebrada; (2) indicador RELATIVO ancorado no fundo
(contador de notches saturante offset/(offset+60), re-âncora em
Enter/ctrl+End, botão ⤓) — rejeitado também: sem posição absoluta publicada
pela TUI, a barra fica ou parada ou aproximada. A regra da F5.2 (nunca
probe/fingerprint/estimativa de posição) segue absoluta; o scroll da TUI é
da TUI (roda + Ctrl+End).

## F5.4 — MAPA VIVO: campo de partículas + universo com câmera (2026-07-28)

Pedido do usuário: "quero essa parte repleta de animações", com o fundo do
antigravity.google (bolinhas que reagem ao mouse). REGRA ADOTADA: movimento é
SINAL, não enfeite — todo pulso/onda/celebração sai de um fato real (pane
rodando, permissão pendente, missão integrada, agente morto); o que é ambiente
(respiração do campo e do fio) fica em amplitude baixa para nunca disputar
atenção com um sinal de verdade.

- `src/renderer/src/paperField.ts` — motor de partículas em **Canvas 2D, NUNCA
  WebGL**: o orçamento de contextos desta janela é dos terminais (o 17º mata o
  mais antigo e não restaura — WEBGL_BUDGET=12), então um fundo WebGL derrubaria
  silenciosamente o renderer de um pane. Engenharia reversa do shader GPGPU do
  antigravity (lido do bundle): Poisson-disc (Bridson, semeado pelo projectId —
  mesmo céu toda vez), ANEL que persegue o cursor com inércia e empurra as
  partículas da BANDA (não do disco) para fora enquanto elas crescem e
  escurecem, deriva por ruído virado ÂNGULO de campo de fluxo (metade do custo
  de amostrar um escalar por eixo, e sai mais orgânico), ondulação senoidal com
  fase por partícula, retorno elástico (damping 0,86 ⇒ tudo sempre assenta).
  API: `resize/pointer/setWells/shock/setPaused/destroy` — o motor NÃO escuta o
  mouse, quem alimenta é o React. MEDIDO em Chromium real (não estimado): 1311
  partículas a 1600×900, **0,8–1,0 ms/frame** (meta era 4). Dois achados de
  medição: `rect` de ÁREA CASADA (lado r·√π, cobertura dentro de ±3% do círculo)
  é ~4× mais rápido que `arc` e vale para as partículas em repouso; e
  `POISSON_DENSITY` real é 0,50–0,54 (o chute inicial de 0,72 subestimava o
  spacing). Degradação automática se a média de 30 frames passar de 9ms, no
  máximo 2 passos. `prefers-reduced-motion` desenha o campo estático.
- O campo é o ÉTER: fica parado, não acompanha a câmera (as partículas só
  existem na área visível — movê-las abriria faixas vazias na borda). A
  gravidade é que viaja: cada card vira um POÇO no campo (`setWells`, em
  coordenadas de tela) — trabalho ATRAI, permissão pendente REPELE (abre uma
  clareira em volta do card), hover engorda o poço. É o que amarra o fundo ao
  domínio em vez de deixá-lo decorativo.
- AJUSTES POR FEEDBACK (medidos com sonda headless em `scratchpad/`, não no
  olho): `EXCITED_SCALE` 2,1 → 0,85 — o pico media 8,5px de diâmetro sob o
  cursor ("bolinhas muito grandes"), agora 4,7px, com `HOT_ALPHA` 0,65 → 0,74
  compensando em contraste. E o campo estava MORTO com o mouse parado porque
  `RIPPLE_CALM_MUL` era 3 (o cursor calava a ondulação num raio de 450px, meia
  tela congelada): 1,1 + `RIPPLE_PUSH` 0,34 → 0,95 dão excursão medida de ~14px
  por partícula em 12s, cada uma na sua fase.
- FIOS VIVOS (`ConstellationMap`): todo path leva `pathLength={100}`, então
  dasharray/dashoffset viram unidades de PERCENTUAL DO FIO e a mesma animação
  serve para qualquer comprimento. Um COMETA por agente rodando (teto 3; a
  duração escala com a contagem, senão 3 agentes viram um borrão), pulso
  INVERTIDO em vermelho quando há permissão pendente (o agente chamando de
  volta), flash one-shot na conclusão correndo card→núcleo (o trabalho voltando)
  e `wire-draw` desenhando o fio quando um nó nasce. Hover num card acende o fio
  dele e apaga os outros. Um único rAF escreve o `d` de todos (~4 paths × 12
  nós, <0,1ms) e é ele que também aplica o parallax.
- O CURSOR EMPURRA O FIO COMO UMA CORDA — e a primeira versão saltava de um lado
  para o outro (bug reportado): o alvo troca de sinal no instante em que o
  ponteiro CRUZA a linha, e aplicá-lo direto é uma descontinuidade. O empurrão
  virou o ALVO de uma mola subamortecida por fio (K 0,16 / damp 0,24, estado
  vivo entre frames) — o mesmo cruzamento passa a ser o balanço natural da
  corda. Força máxima 30 → 20px e entrada no alcance por smoothstep.
- CELEBRAÇÃO DE DESFECHO: o store não guarda transição nenhuma (tudo é
  overwrite), então o "isto terminou" vem de três fontes complementares —
  (1) `hub:event`, que estava plumbado até o preload e SEM NENHUM consumidor no
  renderer, é a única com semântica explícita (`merge`/`report`/`error`, com
  `missionId` nos eventos de tarefa; o tipo no preload não declarava
  `missionId`/`quiet` e foi corrigido); (2) diff da lista de nós contra a do
  frame anterior — missão que SAI da lista com status `concluida` é integração,
  e o card vira FANTASMA que viaja até o núcleo em verde com selo ✓ (nada some
  seco); (3) bordas de `paneActivity === 'dead'` e de `paneAttention`. Todas
  disparam onda de choque no campo, com matiz do desfecho.
- **O UNIVERSO TEM COORDENADAS PRÓPRIAS, FIXAS** (`WORLD_W/H` = 1560×1000) e a
  viewport é só uma CÂMERA sobre ele. Antes as vagas saíam do tamanho da caixa
  (`ringPositions(count, box.w, box.h)`): clicar num card encolhia o mapa para a
  coluna lateral e o anel inteiro se reorganizava — "eu deixo de um jeito,
  quando clico no card está de outro" —, e redimensionar a janela fazia o mesmo.
  Agora nada em `placed` olha para a viewport; `.map-scene` é um plano de
  tamanho fixo centralizado por CSS e deslocado por `translate3d`, e encolher o
  mapa mostra MENOS do mesmo universo. Regra geral que vale para o app inteiro:
  **o que o usuário posicionou à mão não pode se rearranjar sozinho quando o
  contexto muda de tamanho.**
- CÂMERA: arrastar o vazio move o universo (o gesto sobre um card é do card);
  botão ⌖ centralizar (só aparece fora do centro) e duplo-clique no vazio voltam
  ao meio, com voo suave — o arrasto nunca tem transição, senão ganha lag.
  CLICAR NUM CARD CENTRALIZA NELE, e o foco SOBREVIVE À ANIMAÇÃO da coluna: o
  ResizeObserver dispara várias vezes durante os 420ms e o alvo é recalculado a
  cada disparo, então a câmera chega junto com o layout em vez de mirar numa
  geometria que ainda vai mudar. Arrastar à mão desliga a perseguição. Limites
  da câmera saem do MUNDO (dá para varrer tudo numa coluna de 300px); viewport
  que cresce traz a câmera de volta para dentro do limite novo.
- TENTATIVA DESCARTADA (não repetir): layout COMPACTO para o mapa estreito
  (núcleo menor no topo + cards em coluna, `columnPositions`). Resolvia o
  sintoma pelo caminho errado — reorganizar a constelação é justamente o que o
  usuário não quer. Com a câmera seguindo o card, perdeu a razão de existir e
  foi removido inteiro.
- ARMADILHAS resolvidas nesta leva: o "reflexo" do card bugava porque `.live` e
  `:hover` declaravam a MESMA animação com durações diferentes (entrar com o
  mouse reiniciava o ciclo no meio) — agora é uma regra só, presa a `.live`, e
  move `transform` (composto) em vez de `background-position`; o pulso de
  permissão saiu de `animation` do card para um `::after`, porque o card já usa
  `animation` na entrada com stagger e uma sobrescrevia a outra; o parallax vive
  na propriedade `translate`, INDEPENDENTE de `transform`, para não brigar com o
  transform do arrasto; e o rAF do mapa só roda com a caixa visível — o
  ResizeObserver entrega 0×0 para universo escondido por `display:none`, e é
  esse o sinal de pausa (do rAF dos fios e do campo).

## F5.5 — identidade, limites de verdade e o ícone do app (2026-07-28)

- **BUG DE CLASSE: `uiSender` nascia `null`.** O main empurra eventos para a UI
  por `uiSender`, que era preenchido só DE CARONA (`uiSender = e.sender`
  espalhado por ~35 handlers). Nenhum IPC do boot fazia isso, então tudo que o
  main empurrava antes do primeiro IPC "de carona" (que na prática só acontece
  ao ABRIR UM PROJETO) ia para o chão: a rodada de update dos CLIs roda 2,5s
  após o start e TODOS os `cli:status` sumiam — o dropdown ficava em
  "checando…" para sempre, e "funcionava na segunda vez" só porque abrir um
  projeto preenchia o `uiSender`. `hub:event` tinha a mesma exposição (e a
  aba Panes passou a depender dele). FIX NA RAIZ: a janela se registra em
  `did-finish-load` (vale também no reload por `render-process-gone`), e
  `cli:status`/`cli:update` passaram a amarrar o sender como todo o resto.
  `cli:update` também EMITE o estado atual na hora: chamada durante uma rodada
  em andamento entra na mesma promessa e não geraria evento nenhum.
- LIMITES DAS CONTAS reescritos: `seatUsage.ts` devolve MEDIDORES estruturados
  (`UsageMeter {label, pct, mode, severity, reset, window}`) em vez de linhas de
  texto. O `/usage` do claude despeja um relatório inteiro em inglês depois dos
  limites (requests, sessões paralelas, top MCP servers) e o parser antigo
  empurrava para a tela QUALQUER linha que não reconhecia — era esse o lixo na
  UI. Agora o ruído é descartado e o texto cru só sobrevive quando nenhum
  medidor é reconhecido. Bug de parsing junto: com 0% usado o CLI omite o
  `· resets`, e a regex exigia — o seat inteiro caía no balde de texto.
  `mode` preserva a direção de cada CLI (claude conta o usado, codex o que
  resta) e `severity` é a leitura única para a cor. A apresentação virou
  `components/UsageMeters.tsx`, compartilhada por titlebar e hover do SeatRail
  — a versão duplicada no rail ficou para trás na mudança de formato e passou a
  exibir "sem dados" (regressão real, achada por varredura).
- MULTIPLICADOR DO PLANO (5x/20x), tudo SONDADO:
  - claude: NÃO vem no handshake (`account` traz só email, organization,
    subscriptionType, apiProvider). Mora em `<configDir>/.claude.json` →
    `oauthAccount.organizationRateLimitTier` ("default_claude_max_20x").
    Lido do mais específico para o mais geral (`userRateLimitTier` →
    `seatTier` → `organizationRateLimitTier`); validado nos dois seats reais
    (um 20x, um 5x). Chip vira "MAX 20x".
  - codex: o CLI não tem campo nenhum — sondados `account/read`,
    `account/rateLimits/read`, os claims do JWT em `auth.json` e o próprio
    binário (enum `KnownPlan` = free|go|plus|pro|prolite|team|business|
    enterprise|edu, sem nenhuma string "5x"/"20x"). Mas o PRODUTO tem: o card
    "ChatGPT Pro" oferece as variantes 5x e 20x, e é a variante que define o
    `planType` — `prolite` é a de 5x, `pro` a de 20x. Mapeamento de PRODUTO
    (`CODEX_TIER`), não de campo: é ali que envelhece se a OpenAI reorganizar
    os planos. `planType` também vem dentro de cada bucket de rate limit, o que
    serve de rede quando `account/read` falha; créditos extras
    (`credits.hasCredits/unlimited/balance`) aparecem ao lado do plano.
- IDENTIDADE: `components/SynkoraMark.tsx` (estrela de 4 pontas + órbita) é a
  fonte única do logo, usada na titlebar, no cabeçalho da Home e no botão Home
  do rail. `components/CliMark.tsx` traz os logos OFICIAIS de Claude e OpenAI
  (Simple Icons) e substituiu os glifos `✦`/`⌁` em nove lugares — o `✦` é o
  símbolo do PRÓPRIO app, então usá-lo para o CLI fazia o Synkora se
  identificar onde na verdade identificava um provedor. `SelectOption` ganhou
  o campo `cli` (o `label` continua texto puro: é ele que alimenta o type-ahead
  do teclado). NÃO trocar: `ajudante: '✦'` no PaneChrome (papel, não provedor) e
  o `✦` do botão "Agente" (ação, não conta). O núcleo do mapa mostra as
  INICIAIS do projeto quando não há foto, como o rail — o `✦` genérico fazia
  todo universo parecer o mesmo lá dentro.
- HEADER DO UNIVERSO: botão "Terminal" REMOVIDO (decisão do usuário) e no lugar,
  colado no botão de agente, o CAMINHO DA PASTA — só leitura (o logo do app e o
  caminho não são clicáveis, decisão do usuário; o `.ws-path-text` usa
  `direction: rtl` para cortar o COMEÇO e preservar o nome da pasta).
- BARRA DE MISSÕES dividida em dois papéis com divisória: navegação à esquerda
  (abas com contador `feitas/total` e barra de progresso na aba que está
  integrando), controle do universo à direita. O bypass virou INTERRUPTOR
  (`.perm-switch`): antes era um chip que trocava de texto e exigia LER para
  saber o estado; agora a posição do knob informa. Rail de projetos ganhou o
  "+" no fim da lista (escolher a pasta já cria o universo; o nome sai da
  pasta).
- ÍCONE DO APP (`scripts/make-icon.mjs`, zero dependências): rasterizador em JS
  puro (PNG na mão com zlib, ICO montado à mão, supersampling 8×8) que desenha a
  MESMA marca do `SynkoraMark`. Sete tamanhos no `build/icon.ico` + `icon.png`
  256. Quatro correções vieram do usuário olhando a tela, e todas valem como
  regra: (1) a órbita é LARANJA — no SVG ela é `currentColor` com opacity .55 e
  o contexto pinta de acento; pintá-la de papel dava um anel cinza, "não é o
  mesmo ícone"; (2) a composição é ÚNICA em todo tamanho — tirar o anel no 16px
  para ganhar legibilidade foi recusado: um ícone que muda de composição é outra
  marca; (3) a escala é o VIEWBOX mapeado no lado, não "a estrela ocupa X%" —
  o parâmetro inventado inflava a marca em ~5%; (4) `MARK_SCALE = 0,72` (anel a
  61% do lado) foi ESCOLHIDO comparando quatro variantes renderizadas a 96px
  lado a lado — ajustes de 5% são invisíveis numa miniatura, então estimar é
  perder tempo; renderize e mostre. Descartados: a constelação (núcleo +
  satélites + fios) como ícone, o halo de recorte no 16px e a vinheta (em
  `#26241f` a diferença até `--panel-2` são 8 níveis: lê como sujeira, não como
  profundidade). Em DEV o Windows pode continuar mostrando o ícone do
  `electron.exe` no Explorer e em atalhos fixados — só um build empacotado
  embute o `.ico` nos recursos do executável; ainda não há config de
  electron-builder, mas `build/icon.ico`/`icon.png` já estão no caminho padrão
  que ele procura.
- FERRAMENTA DE DIAGNÓSTICO que vale reusar: para julgar ícone, EXTRAIA os PNGs
  de dentro do `.ico` e amplie (nearest-neighbour), com contagem de pixels por
  cor. Foi isso que mostrou 10,6% de pixels acinzentados onde deveria haver
  laranja — comparar com a fonte que se "acha" ter gerado não encontra esse
  tipo de erro.
- EMPACOTAMENTO (`electron-builder.yml` + `npm run dist` / `dist:dir`, saída em
  `release/`): a peça que NÃO pode faltar é o `asarUnpack` de
  `**/node_modules/@lydell/node-pty*/**` — o curinga precisa pegar também o
  pacote da PLATAFORMA (`@lydell/node-pty-win32-x64`), que é onde moram os
  `.node` e a `conpty.dll`; dentro do asar o caminho de disco que o
  LoadLibraryW usa não existe e todo pane morreria no spawn. `npmRebuild:
  false` (os prebuilds dispensam node-gyp, e ligar o rebuild chamaria o
  node-gyp que o projeto evita). `extraResources` copia o `icon.ico` para
  `process.resourcesPath`, que é onde o `resolveAppIcon()` procura quando
  empacotado — é OUTRA coisa que o `win.icon`, esse embute o ícone no .exe.
  `app.setAppUserModelId('dev.synkora.app')` no whenReady precisa bater com o
  `appId` do yml: é o AppUserModelID que amarra a janela ao app no Windows, e
  sem ele atalho fixado e Explorer continuam mostrando o ícone do binário que
  lançou o processo (o `electron.exe`, em desenvolvimento — a razão de o ícone
  novo não aparecer em todo canto durante o `npm run dev`).
  VALIDADO de ponta a ponta: `Synkora-0.1.0-setup.exe` (98 MB) gerado, app
  descompactado ABRE e fica vivo, `conpty.dll` e os `.node` estão em
  `resources/app.asar.unpacked/`, e o ícone extraído do PRÓPRIO `Synkora.exe`
  é a marca. Sem assinatura de código: o SmartScreen avisa na primeira
  execução (esperado; assinar exige certificado EV). macOS ficaria faltando o
  `build/icon.icns` — o gerador hoje só produz `.ico` e `.png`.

## F5.7 — MISSÃO DIRIGIDA POR PLANO (2026-07-28)

REDESIGN do fluxo de missão (decisão do usuário): com orquestrador por missão,
o card-a-card manual (usuário clicando ▶ em cada card) morreu. O ciclo agora é
PROPOR → APROVAR → AUTONOMIA:

- ORQUESTRADOR PROPÕE: estuda o goal e cria UM CARD DE PLANO via tool MCP
  `create_plan` (Task `kind:'plan'` + `TaskPlan {summary, lanes, conclusion?,
  approvedAt?}` e `PlanLane {dept, notes?, seatId?, model?, effort?}` em
  tasks.ts): summary = markdown PT-BR do que vai acontecer (ondas só com
  dependência real); lanes = funções envolvidas com executor sugerido
  (defaults no main: política do dept heavy>light > seat da missão > seat do
  PM). create_plan SUBSTITUI a proposta enquanto não aprovada (re-proposta
  zera approvedAt) e recusa com plano em execução; `create_tasks` é RECUSADO
  enquanto o plano proposto aguarda o usuário.
- USUÁRIO APROVA: card ◆ (borda dupla accent, pulsa aguardando aprovação,
  SEMPRE visível — ignora filtro de dept, primeiro da coluna). PlanModal:
  summary/conclusão renderizados com marked+DOMPurify (classe .md-view do
  FilesView reusada — o modal é papel), lanes EDITÁVEIS (Select seat +
  ModelSelect + effort do catálogo real; trocar seat reseta model/effort) SÓ
  antes de aprovar. "▶ aprovar e executar" = IPC `tasks:planApprove` (grava
  lanes finais + approvedAt, status execucao, injeta no pane do orquestrador
  o evento com as lanes — "a missão é sua"; o pane está montado porque o
  multi-slot do board monta todos os orquestradores vivos). "⏸ pausar"
  (`tasks:planStop`) volta o plano ao backlog e corta run_task NA HORA (runs
  vivos terminam a fase); re-aprovar retoma. LANES APROVADAS SÃO CONTRATO.
- AUTONOMIA: com plano em execução, create_tasks do orquestrador carimba
  `auto: true` — card read-only no board (sem mover/executar/excluir/editar;
  badge ⟡; modal informativo; guards TAMBÉM no main: tasks:update/remove/run
  recusam plan/auto) — e ELE dispara cada card via tool `run_task`: mesmo
  caminho dos gates (preparePhasePane + openPhasePane — o main abre o pane TUI
  sem clique do renderer), executor resolvido pela LANE do dept (> política >
  seat missão/PM), `MAX_PARALLEL_RUNS = 3` por projeto como backpressure
  (mensagem manda aguardar evento de conclusão). Reprovação pós-ciclos volta
  ao backlog com feedback → evento → orquestrador corrige briefing
  (update_task) e re-dispara. `delete_task` (MCP, só card auto, nunca em
  execução/qa; reusa removeTaskCascade extraído do IPC) limpa card que não
  será feito.
- CONCLUSÃO: `conclude_plan` (recusa com qualquer card da missão não-done)
  grava a conclusão (markdown) no card → status done; evento de MARCO vai ao
  PM (sem missionId). Integração continua humana: integrate_mission com aval
  explícito; o guard existente de integração já bloqueia com plano não-done
  (plano conta como task aberta — de propósito).
- SOBREVIVE AO BOOT: recovery pula `kind:'plan'` (plano em execução NÃO volta
  ao backlog); o orquestrador retoma sozinho — persona manda board_status +
  PLAN.md no início de TODA sessão e re-disparar cards parados. board_status
  ganhou seção `plano` (status legível + lanes + conclusão; PM vê o status do
  plano por missão); BOARD.md escreve linha `[PLANO] título — estado`.
- CONTAGENS: card de plano fora de TODAS as métricas de trabalho (homeStats,
  mt-count das abas, BacklogView ▣ X/Y, DeptStats, ProjectGeneral, "N/M
  tarefas" do BOARD.md/syncBoard). Quick-add some em missão com plano ativo
  (backlog/execução — quem cria card lá é o orquestrador; plano done → volta).
  missionAllDone segue contando o plano: ⇪ integrar exige plano concluído.
- PERSONAS: missionPersona reescrita (lifecycle PROPOSE→WAIT→EXECUTE→CONCLUDE
  + AUTONOMOUS EXECUTION: reagir a todo evento no mesmo turno, mesma-falha-2×
  → falar com o usuário, retomar sessão perdida sozinho, respeitar pausa);
  introPrompt do paneSpec: se o goal da missão já basta, propõe o plano na 1ª
  resposta; PERSONA_TUI do PM explica o fluxo novo ao criar missão.
- Skills/subagentes por card seguem F4 (pendente): quando existirem, é o
  ORQUESTRADOR que os repassa por card/execução (decisão do usuário,
  2026-07-28) — provavelmente como campos novos no create_tasks/lane.

### F5.7b — fixes do primeiro teste real (2026-07-28, tarde)

- MENSAGEM DO DEV CHEGAVA CORTADA no orquestrador ("só chegou o final, sem o
  paneId"): uma write única de ~1k chars no `inject` ESTOURA o buffer de input
  do ConPTY, que descarta o COMEÇO (ring) — o carimbo "(de dev · pane X)" fica
  no começo e sumia, quebrando o notify_pane de resposta. Fix: `inject`
  fatiado (chunks de 160 chars a cada 24ms, Enter 300ms após o último — mesmo
  remédio do Ctrl+A). Nunca voltar a write única para texto injetado.
- DELAY DE INJEÇÃO em resposta esperada: aprovação/pausa de plano e conselho
  de delegação passavam pela cadência do drain (2s + ocioso 4s + folga 8s).
  `HubEvent.urgent` + `hub.notifyPaneNow` (injeta NA HORA se o pane está
  quieto há 300ms — quem espera de turno encerrado não imprime; o echo da
  própria injeção derruba o isIdle e impede entrelaçar duas urgências;
  fallback = fila normal). Usado em: tasks:planApprove, tasks:planStop,
  notify_maestro (o pedido de conselho ao orquestrador) e notify_pane (a
  resposta ao dev).
- TERMINOLOGIA: o dev anunciava "enviado ao Maestro" — o retorno do
  notify_maestro agora nomeia o destino real ("ORQUESTRADOR da sua missão" vs
  "Maestro (PM)"), e o quest hint explica que a tool alcança o orquestrador.
- MODELO BANIDO (decisão do usuário, 2026-07-28): gpt-5.3-codex-spark é fraco
  demais para QUALQUER papel — "limite sobrando" não justifica (o barato
  aceitável do codex é luna/mini). `isBannedModel` (/spark/i) no index:
  filtrado do list_seats, recusado no delegate, limpo nas lanes do
  create_plan e no run_task; personas (advisors + PROPOSE + quest hint)
  avisam. A UI (ModelSelect) segue mostrando — o ban é dos AGENTES.
- ARQUIVAR MISSÃO MATA O PANE do orquestrador (bug real: o CLI seguia vivo
  com o pane aberto): missions:update com status 'arquivada' faz ptys.kill +
  hub.unregisterPane (como missions:remove já fazia); reativar respawna via
  resume (tuiSessionId persiste no maestroStore).
- HOVER DA ABA DE MISSÃO enxuto: o goal virou briefing gigante (o PM
  front-loada contexto) e o tooltip cobria a tela — agora mostra título + 1ª
  linha do goal (≤110 chars) + ◈ versão · branch · ▣ progresso. O briefing
  completo se lê no plano/orquestrador.
- LANE OBEDECE À POLÍTICA (decisão do usuário, 2026-07-28 — bug real: lane de
  qa veio com sonnet, que não está em slot nenhum da política): no
  PLANEJAMENTO, função COM política definida trava o orquestrador nos DOIS
  slots do usuário (▲ pesadas / ▽ leves) — a escolha dele é ENTRE os dois +
  o effort; o createPlan CORRIGE sugestão fora da política (snap para
  heavy>light, avisado no retorno da tool e na persona). Função sem política
  = escolha livre. Liberdade TOTAL de modelo só nos AJUDANTES do dev
  (delegate/conselho — fluxo de execução, não de planejamento). O usuário
  continua 100% livre no modal de aprovação.

### F5.7c — rodada 2 do teste real (2026-07-28, noite)

- INTRO DO ORQUESTRADOR pela riqueza do goal: goal MAGRO (<80 chars — missão
  criada à mão no modal) → apresenta-se em 1-2 linhas e ESPERA o usuário
  explicar (sem adivinhar nem interrogatório; feedback real: "calma, primeiro
  eu explico"); goal RICO (briefing do PM) → estuda e já propõe o plano.
  Persona PROPOSE com a mesma regra.
- QA DO PLANO NÃO SE DUPLICA (decisão do usuário): o gate de review/QA da
  lane roda sozinho DEPOIS do dev — quest hint e DELEGATION ADVISOR proíbem
  ajudante de QA que pré-valida o que o gate vai checar (crédito em dobro);
  o advisor VETA e explica que o gate cobre; self-check leve do dev basta.
- BYPASS CODEX DE VERDADE: o onboarding do codex 0.145+ (trust do diretório +
  setup do sandbox Windows) aparece MESMO com
  --dangerously-bypass-approvals-and-sandbox e travava ajudante codex no
  diálogo. `ensureCodexTrust` no armPane de todo pane codex — formato SONDADO
  no config.toml que o próprio CLI grava: `[projects.'<path minúsculo>']`
  (aspas simples, lowercase; trust do ROOT do repo cobre os worktrees) +
  `[windows] sandbox = "unelevated"` quando a seção não existe (nunca
  sobrescreve escolha feita). Append no fim do TOML.
- MODELOS TOP-3 PARA AGENTES (decisão do usuário): claude sonnet/opus/fable ·
  codex luna/terra/sol (`isTopModel` + `agentModelPool`). list_seats só lista
  esses; delegate RECUSA id fora do pool/inexistente (o advisor aconselhou
  gpt-5.4-mini — id MORTO que o codex migra p/ luna, visto na sonda do
  config.toml); createPlan valida lane de dept sem política; runTask degrada
  id morto para o padrão do seat (execução nunca trava). Personas: id SÓ do
  list_seats, nunca de memória. UI manual segue com catálogo completo.
- ROTEAMENTO DE MISSÃO SEM PM (decisão do usuário: "nenhum pane fala com o
  maestro, só o orquestrador"): maestroPaneOf perdeu o fallback — evento de
  missão com orquestrador morto fica em EVENTS.md (board_status recupera no
  respawn); report de AJUDANTE agora carrega missionId (ia pro PM — bug
  real); tasks:update do renderer idem.
- BROWSER POR CLI, SEM MENTIRA: playwright MCP só existe em pane CLAUDE — o
  hint do dev/ajudante codex agora diz isso (script npx playwright ou deixar
  o visual pro gate); advisors nunca mandam QA visual para seat codex (o
  caso real: ajudante codex reportou "browser tools não sobem" enquanto o
  gate de QA, claude, navegava normalmente).
- PROPOSTA E CONCLUSÃO EM LINGUAGEM LEIGA (pedido explícito do usuário):
  summary/conclusion do plano são escritos para NÃO-programador — o que muda
  na tela/comportamento, simples, sem jargão (z-index, DOM, IIFE…); termo
  técnico inevitável explicado em palavras comuns na mesma frase. Regra nas
  descrições das tools (create_plan/conclude_plan) E na persona (PROPOSE/
  CONCLUDE).
- TEXTO DO PLANO É SELECIONÁVEL (o app é user-select:none global): summary/
  conclusão/lanes/progresso do PlanModal ganham user-select:text — o usuário
  copia trechos para colar no orquestrador. E o guard de mousedown no overlay
  do PlanModal: seleção que termina FORA do modal não o fecha (o click só
  fecha se o gesto começou no próprio overlay).

### F5.7d — rodada 3: crash, remetentes e cards por plano (2026-07-28, noite)

- CRASH exit 5 SEM stack no stdout (o app caiu durante teste pesado, com
  muitas injeções/ajudantes): causa mais provável — write em pty cujo
  processo acabou de morrer (a janela entre o exit e o cleanup do mapa):
  EPIPE no pipe do ConPTY estoura fora de try/catch e derruba o main.
  Blindado: `safeWrite` no PtyManager (write/inject/resize/kill — escrever em
  processo morto é no-op, nunca fatal) + CAIXA-PRETA:
  process.on uncaughtException/unhandledRejection → `userData/crash.log`
  (loga e SEGUE de pé — não se derruba o app do usuário por pipe morto). Se
  crashar de novo, o log diz o porquê.
- REMETENTE CARIMBADO em toda mensagem agente→agente (pedido do usuário:
  "não sei quem mandou isso"): notify_pane injeta "(do orquestrador)/(do
  Maestro)"; helper_send prefixa "[do orquestrador]/[do Maestro]/[do seu
  delegador]" em instrução >20 chars (resposta curta de picker — "1", "y" —
  vai crua para não quebrar a seleção). devContract e prompt do ajudante
  ensinam a convenção: linha com carimbo/[synkora] = app/agente (aja e
  responda ao REMETENTE); sem carimbo = humano. (Bug real: o dev respondeu
  ao usuário uma cobrança que veio do orquestrador.)
- CONSELHO COM MODELO MORTO persistia (gpt-5.4-mini): o CONTEXTO retomado do
  orquestrador ainda contém o list_seats antigo — persona nova não apaga
  conversa velha. O delegate já recusa; agora o notify_pane ESCANEIA ids
  `gpt-*` na mensagem e anexa "CORREÇÃO synkora: X não existe; válidos: …" —
  a correção viaja junto e o dev nem tenta. (Ids claude são aliases curtos
  demais para escanear sem falso positivo — o delegate cobre.)
- CARDS POR PLANO (bug real: modal do plano CONCLUÍDO listava os cards em
  execução do plano seguinte, e vice-versa): `Task.planId` carimbado no
  create_tasks (id do plano ativo); modal e progresso do card de plano
  filtram por planId — card antigo sem carimbo conta só no plano ATIVO.
- PENDÊNCIA (reclamação real do dev): transcript de ajudante CODEX vem
  poluído por redraws do TUI (o dedupe do tee não segura o padrão de
  repintura do codex) — exige SONDA de bytes crus antes de mexer no
  flushLog; não chutar heurística.

### F5.7e — caixa-preta COMPLETA de crash + plano separado (2026-07-28)

- REDE DE CAPTURA em todas as camadas (pedido do usuário: "qualquer crash tem
  que deixar log"), tudo em `userData/synkora-crash.log` como linha do tempo
  (boot → eventos → crash/dirty-exit), cada linha com CONTEXTO (versão,
  electron, uptime, RSS, panes vivos — `ptys.count()`), rotação em ~512KB:
  1. `crashReporter.start({uploadToServer:false})` no topo do main — Crashpad
     grava MINIDUMP local (main/renderer/GPU) em `app.getPath('crashDumps')`;
     é o que pega crash NATIVO (o exit 5 não deixou rastro JS).
  2. `child-process-gone` (GPU/network/utility) → linha `child-gone`.
  3. Erros JS do RENDERER: window.onerror/unhandledrejection registrados no
     PRELOAD (pega até erro de boot, sem tocar no devMock) → IPC
     `crash:renderer` → linha `renderer-js` (throttle 5s por mensagem).
  4. MORTE SUJA: marcador `userData/session.alive` gravado no boot e removido
     só no `will-quit` — boot seguinte com marcador órfão loga `dirty-exit`
     apontando os minidumps (denuncia crash nativo/kill que não passa por
     nenhum handler).
  5. `render-process-gone` já logava + reload (mantido); uncaught/rejection
     do main já logavam e seguem vivos (mantido).
  6. `renderer-gone crashed (exitCode -1)` já registrado em campo às 17:08Z
     de 2026-07-28 = crash de renderer RECUPERADO por reload; o exit 5 do
     processo inteiro segue sem rastro — as camadas novas fecham o cerco.
- PLANO SEPARADO DO TRABALHO no kanban (pedido do usuário: "estão se
  misturando"): moldura dupla COMPLETA em accent + fundo mais presente +
  margem extra + divisor tracejado (::after) antes dos cards de dev; e o
  plano ordena PRIMEIRO em TODAS as colunas — inclusive na Concluída, onde a
  ordem cronológica o afogava no meio dos cards.

### F5.7j — ciclo de vida de pane é rotina, não conversa (2026-07-28)

- "pane-close" virou QUIET (decisão: coerência com o PM silencioso): abrir
  pane manual nunca injetou aviso — fechar injetava ("pane livre encerrado" →
  PM respondia "Ok.", puro ruído). O ciclo de vida cru de panes fica em
  EVENTS.md/UI; o que importa já tem evento próprio (fase interrompida =
  error; ajudante morto sem report = notifyPane ao delegador; trabalho do
  agente livre = register_direct_mission). O pane-open de FASE segue
  não-quiet (é progresso do pipeline que o orquestrador acompanha).

### F5.7i — foto do projeto quebrada era CSP (2026-07-28, noite)

- A foto do projeto (data URL PNG válida no projects.json — conferida no
  disco) quebrava no <img> porque o CSP do renderer não declarava `img-src`
  — herdava `default-src 'self'` e BLOQUEAVA `data:`. Fix no index.html:
  `img-src 'self' data:`. Lição: avatar quebrado com dado válido = olhar o
  CSP antes do handler.
- FOTO COM TRANSPARÊNCIA FLUI (o CSP consertado revelou estilos nunca
  vistos): PNG com margem transparente mostrava a "roupa" do fallback de
  iniciais por trás — quadro verde na página geral, anel verde no titlebar
  (no rail, fundo escuro neutro, ficava bom). Regra:
  `.pg-avatar:has(img)/.tb-title-avatar:has(img)` → background e borda
  transparentes; fundo por hue é EXCLUSIVO das iniciais. Bônus: `padding: 0`
  no .pg-avatar (padding UA de <button> encolhia a foto) e
  border-radius: inherit na img.

### F5.7h — a vassoura virou AUTOMÁTICA (2026-07-28, noite)

- CORREÇÃO DE DIAGNÓSTICO (o usuário desmentiu o anterior): o .synkora só
  estava limpo porque ele clicou no 🧹 — a limpeza automática da integração
  (cleanupMissionFiles) NÃO pegava os `helper-*.md`, e o modo plano
  multiplica ajudantes (2-4 por card): era esse o "cheio de lixo".
- `sweepProjectFiles(projectId)` = o corpo do 🧹 extraído em função ÚNICA,
  com duas proteções novas: transcript de helper com PANE VIVO fica (o
  delegador ainda lê via helper_output — o 🧹 antigo apagava transcript de
  ajudante rodando, bug latente) e marcador .done/.verdict com phaseWatch
  ATIVO fica (é o fallback do report). Roda em TRÊS lugares: 🧹 manual,
  INTEGRAÇÃO aprovada (após cleanupMissionFiles) e BOOT por projeto (app
  recém-aberto = nenhum pane vivo, todo helper/marcador órfão é lixo certo).

### F5.7g — higiene de .md e aba Versões sem eco (2026-07-28, noite)

- RELATÓRIOS DE AGENTE TÊM CASA: `.synkora/reports/<nome>.md` (pasta
  canônica nova). O caso real: a missão de auditoria escreveu
  `docs/auditoria-cookies-2026-07.md` e `docs/seguranca-luma.md` soltos no
  projeto — deliverable legítimo, lugar errado ("projeto grande vai ser
  difícil de achar", decisão do usuário). A regra vive em TODAS as camadas:
  devContract (REPO HYGIENE), prompt do ajudante, persona do orquestrador
  (briefing de card-relatório APONTA o path), FREE_AGENT_PERSONA, PM
  (consolida reports duráveis no CONTEXT.md) e board_status
  (`arquivos.reports`). Exceção única: a task pedir documentação DO PRODUTO.
  FilesView lista a pasta nova. A limpeza pós-integração do .synkora já
  funcionava — o "lixo" era isso.
- ABA VERSÕES SEM ECO (feedback: "tá repetindo"): missão CONCLUÍDA já
  aparece em "o que já subiu nesta versão" (delivery) — saiu da lista
  "missões desta versão", que agora só mostra vivas/arquivadas.

### F5.7f — o CRASH TINHA NOME: assert do conpty.node (2026-07-28, noite)

- CAUSA CONFIRMADA (diálogo do VC++ Runtime capturado pelo usuário + minidump
  do Crashpad da mesma hora): "Assertion failed! conpty.cc:106 —
  remove_pty_baton(baton->id)" dentro do conpty.node do @lydell/node-pty. O
  lado nativo liberando um pty JÁ liberado — kill() duplo em sequência, ou
  kill/write na janela entre o processo morrer e o onExit chegar ao JS — e
  assert nativo ABORTA o app sem passar por handler nenhum (era o exit
  5/3 sem rastro). BLINDAGEM POR OBJETO no PtyManager (WeakSet — id é
  reusado em respawn, o objeto nunca): `deadPtys` marcado como PRIMEIRA linha
  do onExit, `killedPtys` no safeKill — cada pty recebe no máximo UM kill na
  vida e pty morto/morrendo nunca mais é tocado no nativo
  (kill/write/resize/inject passam todos por aí). Se o assert reaparecer,
  considerar patch/pin do prebuilt (ele foi compilado com asserts ativos).
- CARDS LEGADOS fora do plano novo (`belongsToPlan`, Board): card sem planId
  só conta no plano ATIVO e se nasceu DEPOIS do approvedAt — cards do plano
  anterior (pré-carimbo) não vazam mais para o plano seguinte.
- ABRIR PROJETO POUSA NO BOARD ✦ GERAL (decisão do usuário): openProject
  reseta universeTab/missionTab do projeto — a última aba/missão visitada
  não gruda entre visitas.
- SONNET 5 = 1M de série (correção do usuário; o id não carrega [1m]):
  família /sonnet/i entra no teto de 1M do sessionStats (banner > [1m] >
  sonnet > 200k).
- AVISO DE AJUDANTE SEM RUÍDO: "ENCERROU SEM reportar done" só dispara em
  morte NÃO-acompanhada — helper_close deliberado marca reported, e
  helper_output lido pelo delegador marca `helperSeen` (feedback real: o
  aviso chegava depois de a saída já ter sido lida e incorporada). Report →
  delegador (notifyPane) e orquestrador (publish com missionId) continuam.

## F5.6 — HOME: o SAGUÃO (2026-07-28)

A Home era um formulário (header + chips de seat + uma linha solta de imagens +
grade de cards) e virou a tela de entrada do app. Curadoria feita com 3 agentes
Opus em paralelo (linguagem visual / arquitetura de informação / motion) + juiz
de síntese; o que sobreviveu está abaixo.

- ESQUELETO: `.home` (relative, overflow hidden) → `HomeField` (canvas) +
  `.home-paper` (2 radiais) + `.home-scroll > .home-inner` (max 1180,
  `container-type: inline-size`) com hero → alerta → universos → régua →
  decks. Componentes novos: `HomeField.tsx`, `UniverseCard.tsx`,
  `SeatDeck.tsx` (substitui o `SeatRail.tsx`, REMOVIDO), `SettingsPanel.tsx`,
  `cliState.ts` (CLI_STATE/cliDotClass — o titlebar importa daqui agora; a
  tabela duplicada foi como o rail antigo ficou para trás quando o formato de
  `UsageMeters` mudou).
- REGRA QUE ESTA TELA CUSTOU A APRENDER: a Home reaproveita MOTOR e PALETA do
  mapa, nunca a assinatura visual dele. Sem card flutuante, sem céu no card,
  sem órbita — e, no outro extremo, sem tirar todo o painel escuro. O que a
  Home tem de "universo" é o campo de partículas discreto atrás do papel.
- CARD ANCORADO, NUNCA FLUTUANTE (decisão do usuário): card que levanta e
  projeta sombra é a linguagem do MAPA, onde ele de fato flutua sobre o campo
  e é arrastável. Na Home é ficha na grade — responde por borda e fundo, sem
  `box-shadow` e sem `translateY` em nenhum card, e sem céu estrelado dentro
  do card. A MARCA do app também não se mexe: o hero manteve a caixa escura
  46px com a marca em acento ("o ícone do app você mudou" foi reprovação).
- CAMPO DE PARTÍCULAS DISCRETO (decisão do usuário: "fica, mais discreto"):
  mesmo motor do mapa (`paperField`, Canvas 2D — NUNCA WebGL, o orçamento de
  contextos é dos terminais), com `spacing: 38` e opacidade 0.6 no CSS. As
  constantes do motor NÃO se mexem: ele é compartilhado com a aba Panes.
- GRAVIDADE = FATO. `HomeField` expõe `setAnchors/shockAt/pointerAt/isLive`;
  cada card registra sua caixa por callback ref (`data-anchor`) e a Home
  converte em poços: trabalho rodando ATRAI (hue 145), alerta REPELE (hue 6,
  abre clareira), a marca respira só quando há pane rodando (hue 21). Matiz é
  vocabulário FECHADO em 3 — `HUE_SLOTS = 3` e `slotForHue` devolve −1 para a
  quarta, então `hueOf(project.name)` nunca vira poço.
- ONDAS só em TRANSIÇÃO, e a primeira passada de todo diff é engolida (`if
  (!prev) return`) — abrir o app com 3 contas expiradas não pode virar fogos.
  `shockAt` não dispara com o campo pausado (o `time` do motor só avança
  dentro do rAF: ondas enfileiradas estourariam todas juntas na volta).
  `hub.onEvent` ganhou seu primeiro consumidor GLOBAL: merge/report/error num
  universo de fundo agora aparecem na Home (o `ConstellationMap` filtra por
  projeto aberto).
- HOVER FORA DO REACT: `onPointerMove` na `.home` alimenta o anel do cursor e
  resolve o card por `closest('[data-anchor]')`; hover em estado re-renderizaria
  a tela inteira a cada movimento entre cards.
- ENTRADA UMA VEZ POR SESSÃO: a Home fica MONTADA (display:none) enquanto um
  projeto está aberto, e `display:none → flex` REINICIA animação CSS. As
  keyframes moram sob `.home:not(.booted)` e a classe entra 1400ms depois do
  mount. Nenhuma entrada anima `transform` (com `fill-mode: both` o valor
  final fica retido); usam `opacity`/`scale:`/`translate:`.
- DADOS REAIS, SEM MENTIR: `homeStats` no store (missões vivas, feitas/total,
  em curso, versão de referência) por `missions.list` + `tasks.list` +
  `backlog.listVersions`, escalonado 60ms por projeto e invalidado pelos três
  canais `*:changed`. Painéis vivos SÓ para projeto aberto nesta sessão (os
  panes nascem no renderer): projeto não visitado diz "— sessão fechada",
  nunca "0 painéis".
- CONTA = FICHA DE UMA LINHA (decisão do usuário, "ficou feio, não está
  combinando com o app"): disco + nome + marca do CLI + dot + estado, 42px de
  altura, ações aparecendo no hover sobre um degradê à direita (a linha não
  reflowa). Card alto com uma palavra dentro ("logado") não tem a cara de um
  app denso e mono. Clique só age em conta SEM login ou EXPIRADA — abrir um
  CLI por clique acidental numa conta boa não é comportamento de card.
- LIMITES DE USO NÃO MORAM NA HOME (decisão do usuário): já existem no
  `limites ▾` do titlebar, visível de qualquer tela — e cada consulta SPAWNA
  processo (sessão claude efêmera com /usage; app-server do codex). O
  `UsageMeters` segue usado por titlebar e SeatGate.
- AJUSTES = SÓ GERAÇÃO DE IMAGENS, por ora (decisão do usuário: "só faz
  sentido ali é a parte de geração de imagens"): provedor, conta codex, chave
  OpenRouter (nunca renderizar o valor: o campo abre vazio) e modelo. Fica num
  `.term-window` — a versão em papel foi REPROVADA na hora: sem nenhuma
  superfície escura a Home vira massa clara sem hierarquia, e o contraste
  papel × painel é a identidade do app, não um detalhe. Versão dos CLIs,
  ConPTY e limpar layouts foram RETIRADOS daqui (readout duplicado do titlebar
  e diagnóstico, que não é rotina de quem está entrando) — o `conptyDll`
  ficou no espelho de tipo do preload, onde faltava.
- A Home ainda assina `cli.onStatus`, mas só para ALERTAR (CLI fora do PATH ou
  update falho travam o trabalho) — o readout continua sendo o do titlebar.
- FICOU DE FORA por não existir capacidade (a regra de não mocar): versão do
  app (`app.getVersion` não exposto), sondagem do `image_generation` do codex,
  abrir a pasta de dados (`shell.openPath`), caminho de instalação do CLI.
- MEDIR ANTES DE ESTIMAR: a grade nasceu `minmax(310px, 1fr)` e caía para 2
  colunas — a terceira pedia 966px e a área útil dá 962. Quatro pixels
  deixavam metade da tela vazia; hoje é 288px.

## Stats por versão + retry de update dos CLIs (2026-07-29)

- ACUMULADO NUNCA É GLOBAL, E O RETRATO É POR VERSÃO (duas decisões do usuário
  na mesma tarde — "vai chegar uma hora que vai ter MUITO" e depois "pode ter
  2/3/6 versões em desenvolvimento", que derrubou a 1ª versão desta mudança
  com referência única): `HomeStats.versoes` = um `VersionStats` POR VERSÃO
  ABERTA (mais antiga primeiro; sem nenhuma aberta, a última lançada entra
  sozinha como "o que ela entregou") com missoesFeitas/missoesTotal
  (deliveries + vivas), feitas/total (tarefas das missões da versão) e emExec
  (vivo). Tarefa conta via missão (missionId → mission.versionId; missão VIVA
  sem carimbo conta na CORRENTE — é nela que integra); plano fora, como
  sempre. Página ✦ geral: os 3 tiles globais viraram uma LINHA POR VERSÃO
  (`.pgv-grid`, grid único com Fragment por versão para alinhar colunas —
  ◈nome + missões + em execução + concluídas) + linha "✧ N fora de versão"
  quando há tarefa solta viva. Card da Home: agrega as versões em dev e DIZ de
  quantas vem o número ("2 versões · 3/7 missões · 8/23 tarefas"; chip ◈ vira
  "N em dev" com os nomes no tooltip). Tarefa SOLTA done sai das contagens (a
  história mora no board e na aba Versões); quando uma versão lança, ela sai
  do retrato e os números dela renascem do zero na próxima. ProjectGeneral
  consome o MESMO homeStats (a Home fica montada com projeto aberto e os
  canais *:changed dela mantêm tudo fresco — sem IPC novo).
- cliUpdate.ts: falha sem instalar nada ganha UMA segunda tentativa 5s depois
  (caso real: codex 0.145→0.146 falhou na rodada do boot e rodou limpo logo em
  seguida — transitório) + saída completa em userData/cli-update.log; o
  `detail` de falha prefere a última linha de erro que NÃO seja o eco do
  comando do instalador (o codex ecoa o powershell inteiro em "Error: '…'" e o
  motivo real vem nas linhas anteriores).

## Spec MCP 2026-07-28 — avaliada, adoção mínima (2026-07-29)

Pesquisa completa (agente, fontes oficiais + sonda dos binários locais): a
revisão 2026-07-28 remove o handshake initialize/sessões (stateless core),
exige ttlMs/cacheScope nas listas e Mcp-Method/Mcp-Name no POST. PORÉM os dois
clientes desta máquina AINDA FALAM A SPEC VELHA (claude 2.1.220: zero menções
a 2026-07-28 no binário; codex 0.146.0: flag `mcp_2026_07_28` registrada mas
"under development", desligada). Decisões:
- APLICADO: `mcp_servers.synkora.startup_timeout_sec=30` no codexMcpArgs — o
  "MCP startup interrupted" de ajudante codex era o timeout DEFAULT de 10s
  estourando com o event loop do main ocupado na tempestade de boot de panes
  (o servidor já estava de pé; não é rede). Fix independente da spec.
- FUTURO (PR contido, só mcpServer.ts, quando os CLIs adotarem a spec):
  migrar de `@modelcontextprotocol/sdk` 1.29 (linha v1 = manutenção, NUNCA
  implementará 2026-07-28) para `@modelcontextprotocol/server@2` +
  `@modelcontextprotocol/node@2` com `createMcpHandler` (default
  `legacy:'stateless'` atende os clientes velhos no MESMO endpoint; factory
  recebe authInfo = o buildServer por identity de hoje; registerTool
  sobrevive; zod 4.4.3 serve). Ganho real só quando claude/codex virarem a
  chave: boot de pane sem handshake (3 round-trips → 1-2) + tools/list
  cacheável + localhostHostValidation de graça.
- IGNORAR para este caso (localhost single-user): Mcp-Method/Mcp-Name,
  subscriptions/listen, MRTR, Tasks extension, endurecimento OAuth (o modelo
  bearer-por-pane não usa OAuth e segue certo); o erro -32001 continua na
  faixa implementation-defined (legal).

## Delegação em lote, report que espera, cores e fios por função (2026-07-29)

- DELEGATE EM LOTE (reclamação real: dev levou ~3min para abrir 3 ajudantes —
  o custo é UMA RODADA DE MODELO por chamada, thinking em high + briefing
  longo, não o main): a tool `delegate` aceita `helpers[]` (1–8) e abre TODOS
  numa chamada só; `prompt` virou opcional (um OU outro). `McpApi.delegate` →
  `delegateMany(id, list)` no index (closure `one` = corpo antigo devolvendo
  {ok,msg}; rodapé de controle UMA vez). Personas ensinam o lote (PM,
  orquestrador, FREE_AGENT, quest hint do dev): "For 2+ helpers, ONE delegate
  call with the helpers array".
- REPORT DE AJUDANTE ESPERA O TERMINAL AQUIETAR (bug real 2026-07-29: o report
  chega ENQUANTO a resposta longa ainda está sendo impressa; avisar o
  delegador na hora + fechar o pane em 4s fixos fazia o dev ler helper_output
  ANTES do fim e o pane morrer no meio da impressão — transcript truncado,
  trabalho perdido, dev relançou tudo): agora o report agenda um tick de 1s
  até `ptys.isIdle(paneId, 2500)` (teto 90s; pty morto = já), então
  `ptys.flushLogOf(paneId)` (método novo do PtyManager — expõe o flush do tee,
  cujo debounce de 1,5s pendente também truncava o final), e SÓ ENTÃO
  publish + notifyPane + closeById. Prompt do helper ganhou: entregável de
  texto LONGO → escrever em .synkora/reports/<name>.md e reportar o path.
- CORES DAS FUNÇÕES EDITÁVEIS (pedido do usuário): o hue de departments.ts é
  só o DEFAULT; override do usuário em localStorage `synkora.deptHues`
  (GLOBAL à máquina, todos os universos) vira CSS var `--hue-<função>` no
  :root (defaults no global.css; `applyDeptHueVars` roda no boot do store e a
  cada `setDeptHue`). REGRA: pintar por função é `deptHueVar(key)` =
  `var(--hue-<key>)` — nunca o número cru (ignora o override); número só onde
  CSS var não alcança (`deptHueOf(key, s.deptHues)`: strokes calculados do
  mapa). Trocados: Board (todos os --dept-hue), func-card, PanesView
  (tileStyle/PaneChrome.deptHue viraram number|string), RunPanel. Editor =
  slider de matiz no func-card da página ✦ geral (dot + graus + "padrão").
- FIOS DO MAPA POR FUNÇÃO (pedido do usuário: "design e cyber rodando = linha
  rosa E azul se ligando"): `deptLinesByNode` no ConstellationMap (pane
  RODANDO → taskId → task.department; ids `run:<taskId>` incluídos) — cada
  função ativa no nó vira uma `wire-line` própria em TRILHO PARALELO (`wireD`
  ganhou `off` perpendicular; o rAF aplica por `data-off` com cache por
  offset no frame) na cor da função via `--wire-hue` (custom property inline,
  NUNCA stroke inline — as regras .alert/.hot/.on continuam vencendo pela
  cascata, então permissão pendente segue pintando o fio de --err). Cometas:
  um POR LINHA, no trilho e na cor da função, pulsos = agentes daquela função
  (teto 3). Sem função identificada (maestro/livre) = linha única neutra de
  sempre. Panes de fundo seguem com HMR aplicado ao vivo; as mudanças de MAIN
  desta leva (delegate/report/pty) só entram no PRÓXIMO RESTART — o usuário
  pediu para não derrubar o app no meio do teste dele.

## F5.8 — mapa orgânico de satélites + comando pleno da missão (2026-07-29)

- MAPA DE PANES REDESENHADO (pedido do usuário): o card do nó É O ORQUESTRADOR
  da missão (id/kind `mission:` preservados — offsets salvos e âncora intactos;
  muda a apresentação: "✦ orquestrador · N painéis", tooltip idem). Cada
  dev/execução vira CARD-SATÉLITE (`.map-sat`, pill 168×46 na cor da função)
  orbitando o orquestrador; AJUDANTE orbita o DEV que o delegou
  (`delegatorPaneId` novo no DevPaneSpec/Pane — chega do main no delegate;
  fallback sem o campo = pendura no orquestrador); GATE (review/qa) pendura no
  dev da mesma tarefa e fecha TRIÂNGULO com o orquestrador via `.wire-tri`
  (tracejado fluindo — supervisão). `panesNodes.satellitesOf()` monta os
  satélites SEM mexer no buildNodes (o palco/mosaico continua agregado por
  missão — decisão de menor risco: mapa e palco são camadas separadas).
  Posições: leque determinístico "para fora" (prolongamento núcleo→card),
  ORBIT_DEV 205 / ORBIT_HELPER 135; satélite é ARRASTÁVEL (mesmo mapa de
  offsets, `offsets[satId]`) e CLICÁVEL — abre o palco do nó com AQUELE
  terminal expandido (prop onOpenPane → PanesView.openPaneFromMap: anchored +
  expanded juntos). Fios de satélite no MESMO rAF (linkD genérico com recuo
  nas duas pontas; respiração leve SEM mola; cometa quando roda; wire-ask
  quando pede permissão); poços do campo só para satélite rodando/pedindo
  (poço por card parado multiplicaria custo sem informação). MUNDO 1560×1000 →
  2400×1560 + anéis maiores no ringPositions ("o campo dele é pequeno").
  Satélite nasce com sat-in (opacity/scale — NUNCA transform: parallax vive em
  `translate:`, arrasto em `transform`) e morre como mini-fantasma (Ghost.sat).
- GATE OBEDECE À LANE DO PLANO (bug real: usuário aprovou QA opus[1m], gate
  abriu FABLE 5): preparePhasePane só lia a política do dept 'qa' e, vazia,
  model ia undefined = default do seat. Cadeia nova: LANE 'qa' do plano
  APROVADO (contrato — seat+model+effort, o effort agora vai aos cliArgs do
  gate) > política qa (slot por peso) > seat/modelo do dev (modelo do dev SÓ
  quando o seat final é o do dev — modelo de um seat não vale noutro).
- ORQUESTRADOR FALA COM A MISSÃO INTEIRA (reclamação real: "não consigo mandar
  recado pro pane do QA"): tool nova `list_panes` (maestro-only; orquestrador
  vê a missão, PM vê o projeto — paneId/papel/card/estado), evento pane-open
  agora carrega o paneId, prompts de review/qa explicam linhas "[synkora] (do
  orquestrador)". notify_pane RECUSA alvo ajudante (decisão do usuário:
  "ajudante quem fala é o dev") apontando o dev delegador.
- DESIGN SYSTEM É LEI (caso real: tela saiu com a cara de OUTRO app): persona
  do orquestrador (estudo no PROPOSE + bullet DESIGN SYSTEM IS LAW: briefing
  de UI nomeia a fonte — .synkora/DESIGN.md > docs > tokens > telas reais; sem
  DS, o 1º card da onda EXTRAI um simples para .synkora/DESIGN.md), devContract
  de front/design (segue o DS, nunca inventa identidade) e QA (tela que quebra
  a identidade REPROVA mesmo funcionando).
- ESTILO NUNCA DESCE DE NÍVEL (decisão do usuário; caso real: folha de estilo
  delegada a ajudante mid-tier = design MUITO feio): dev NÃO delega o visual
  (stylesheets/identidade/polish) — faz ele mesmo; se paralelizar, ajudante do
  MESMO nível ou MELHOR. Nos hints do dev (quest), nos DOIS delegation
  advisors (que agora VETAM — "THREE standing rules"), no devContract de
  front/design e no FREE_AGENT. Sem guard de código: o app não sabe qual quest
  é "estilo" (heurística sobre conteúdo é proibida) — a regra vive nas
  personas e no veto do advisor.

## F5.8b — conversa instantânea entre panes + browser no codex (2026-07-29)

- INJEÇÃO INSTANTÂNEA (pedido do usuário: "quando um pane está ocupado a
  mensagem demora muito; a mensagem vai ficar na fila mesmo" — SONDADO em PTY
  real nos 2 CLIs, 7 runs): pane OCUPADO enfileira SOZINHO — claude mostra a
  mensagem pendente ("❯ …") e a auto-submete como turno novo ao fim do turno
  atual (1,9–4,2s medidos); codex mostra "Messages to be submitted after next
  tool call" e a steera para DENTRO do turno (3,1–7,4s). ZERO corrupção do
  stream ou da mensagem. O ÚNICO caso que corrompe é o COMPOSER SUJO do
  humano: a injeção entra na posição do cursor e o Enter submete tudo
  CONCATENADO (provado: "texto pela metade[synkora]…" virou uma mensagem só).
  Fix: hub.drain a cada 300ms (era 2s) SEM espera de ocioso (IDLE_MS 4s e
  throttle 8s MORRERAM; gap de 1,5s entre injeções no MESMO pane cobre o
  fatiamento da anterior); notifyPaneNow injeta na hora; a única trava é
  `PtyManager.composerBusy()` = inputBuf do feedInput não-vazio OU
  tecla/paste do usuário há <1,5s (feedInput agora ACUMULA conteúdo de
  bracketed paste no buffer — antes o paste era invisível e o guard ficaria
  cego para "colou e pausou"). `lastKeyAt` marca só o write do TECLADO (o
  inject não passa por ele). O settle do report de ajudante segue com
  ptys.isIdle (espera a SAÍDA terminar — outro problema, mantido).
- BROWSER NO CODEX (pedido: "QA de codex não tá abrindo um chrome"): panes
  codex de EXECUÇÃO (strict — dev/gate/ajudante, mesmo critério do claude)
  ganham o Playwright MCP via `mcp_servers.playwright.command="<wrapper>"`.
  O wrapper `userData/mcp/playwright.cmd` (`npx -y @playwright/mcp@latest %*`)
  existe porque o array TOML `args=[…]` NÃO sobrevive à linha do PowerShell
  (sondado: as aspas internas caem e o codex vê string — "expected a
  sequence"); path com FORWARD SLASHES (TOML trata `\U` como escape unicode);
  Rust ≥1.77 spawna .cmd via cmd automaticamente. Validado: `codex -c … mcp
  list` → playwright enabled; wrapper roda (`--version` 0.0.78).
  startup_timeout_sec=60 para o playwright (npx frio). browserHint unificado
  (todo pane de execução tem playwright); NOTE do ajudante codex morreu;
  advisors voltaram a "TWO standing rules" (a proibição de QA visual em codex
  caiu — a regra do estilo-nunca-desce continua).

## F6.0 — BIBLIOTECA DE SKILLS: curadoria + instalador + updater (2026-07-29)

A F4 real começou (rodada 1 = FRONT; ver docs/SKILLS.md para a curadoria e os
descartes). Skills = pastas SKILL.md instaladas da FONTE e injetadas POR
WORKSPACE — nunca por seat (metadata de toda skill instalada entra no system
prompt do CLI; instalar tudo em todo seat incharia todos os panes).

- `src/main/skillsLibrary.ts` (motor) + `skillsCatalog.ts` (curadoria, 30
  skills front). SkillDef: id = `name:` do frontmatter UPSTREAM (a pasta
  instalada usa o id — a spec exige pasta=name e o comando do claude vem do
  NOME DA PASTA; 5 fontes têm pasta≠name: taste-skill ×4, vercel ×4 com
  prefixo `vercel-`). `requires` = router arrasta as irmãs (better-interface
  → 6 better-*); `defaultFor` = entra sozinha na função.
- INSTALAÇÃO sem git, ORÇADA POR REPO (o usuário ESTOUROU os 60 req/h
  anônimos instalando a curadoria um-a-um no modelo antigo de 2 requests
  POR SKILL): `installMany` agrupa por repo — 1 request de HEAD
  (`commits?per_page=1`, sha do topo = versão pinada de TODAS as skills do
  repo) + 1 tree (`git/trees/<sha>?recursive=1`; só modes 100644/100755) +
  raws fora da quota (pool de 6; ponteiro LFS re-busca no media.github…).
  Cache de RAJADA (120s) de HEAD/tree: cliques um-a-um na UI também pagam
  2 requests só no primeiro do repo. Staging + rename atômico em
  `userData/skills/lib/<id>`. SEMPRE UTF-8 puro: BOM quebra o frontmatter
  NOS DOIS CLIs (sondado). 403/429 devolvem "a cota libera às HH:MM"
  (x-ratelimit-reset). Botão "⭳ instalar todas de <função>" usa o lote.
- UPDATE (o diferencial pedido pelo usuário): check no boot (TTL 24h, junto
  do updateAllClis) + botão "⟳ conferir". DOIS estágios na quota: 1 request
  condicional de HEAD por repo (manifest.repoHeads + ETag; igual = repo
  inteiro pulado); HEAD novo → 1 `compare/base...head` POR BASE distinta
  (os FILES do compare dizem quais pastas mudaram — sem request por skill;
  ≥300 files = trata como tudo mudou, conservador). Skill sem mudança é
  RE-PINADA no head novo sem download (migra sozinho manifests do modelo
  antigo por-path). updates[id]=sha novo → badge ⟳; atualizar = reinstalar.
- SKILL CUSTOM (pedido do usuário): "+ adicionar skill" na biblioteca —
  URL do GitHub (`owner/repo` ou `…/tree/<ref>/<subpasta>`; parseSkillUrl),
  o id/descrição saem do SKILL.md REAL (parseFrontmatter valida `name:` na
  regra da spec), entra na função selecionada com group "adicionadas por
  você", persiste em manifest.custom e usa o MESMO fluxo de
  install/update/remove. Colisão de nome com a curadoria é recusada.
- INJEÇÃO: `syncToWorkspace(cwd, ids)` copia lib → `<cwd>/.claude/skills/<id>`
  E `<cwd>/.agents/skills/<id>` (SEMPRE os dois: dev claude abre ajudante
  codex no MESMO worktree). SONDADO em binário real (2026-07-29): claude
  2.1.220 lê `.claude/skills` (project) + `CLAUDE_CONFIG_DIR/skills` (user) e
  NÃO lê `.agents`; codex 0.146 lê `.agents/skills` + `.codex/skills` (repo)
  + `CODEX_HOME/skills` (user) e materializa skills de sistema em
  `skills/.system` (não tocar). O handshake initialize do claude LISTA skills
  como comandos ("(user)"/"(project)" na descrição) e o codex tem
  `skills/list {cwds}` — validação de instalação sem custo. Git nunca vê:
  `ensureSkillsExcluded` grava `.claude/skills/` etc. no info/exclude do
  COMMON dir (vale p/ todos os worktrees; não suja .gitignore versionado;
  não afeta arquivo já trackeado). Fluxo validado ponta a ponta com sonda:
  download real → injeção → os DOIS CLIs listam a skill.
- QUEM ESCOLHE É O ORQUESTRADOR (decisão do usuário 2026-07-29): carimbo por
  card em `create_tasks.skills`/`update_task.skills` (validado contra
  instaladas; id fantasma = aviso no retorno da tool) e conselho de
  delegação com skills por ajudante (o dev repassa em `delegate.skills`,
  single e helpers[]). Tool `list_skills` (todas as roles) = id + quando
  usar + instalada. CADEIA no preparePhasePane (só fase dev nesta rodada;
  gates ganham skills na rodada de qa): task.skills > policies.skills da
  função > defaultFor instaladas. O prompt do executor ganha bloco "SKILLS
  INSTALLED FOR THIS TASK" com hint por skill (/nome claude · $nome codex);
  ajudante idem. Personas: orquestrador (bullet SKILLS LIBRARY + advisor com
  skills), PM advisor, FREE_AGENT e quest hint do dev ensinam o fluxo.
- UI (três decisões do usuário 2026-07-29, na ordem: "lista gigante no
  func-card ficou feia" → "biblioteca vai pra Home, serve todos os
  projetos" → "divide por card de função, senão 300 skills viram rolagem
  infinita"): a BIBLIOTECA mora na HOME (`components/SkillsLibrary.tsx`),
  nasce RECOLHIDA (header com resumo; estado em localStorage
  synkora.skillsLibOpen) e navega por CARDS DE FUNÇÃO (`.lib-dept-card`,
  um por função com `inst/total`; sem rodada ainda = "em breve" esmaecido)
  — o painel mostra SÓ a função selecionada, agrupada por OCASIÃO
  (SkillDef.group), nunca rolagem única. Ações: instalar / ⟳ atualizar /
  × remover / "⭳ instalar todas de <função>" / "+ adicionar skill". O
  func-card da página ✦ geral mostra as INSTALADAS da função como CHIPS
  compactos (`.skill-chip-inst`: ★ padrão por projeto + ⟳ read-only).
  RODADA POR FUNÇÃO: os depts do catálogo desta rodada são SÓ ['front'] —
  a rodada de cada função adiciona os depts dela. O func-card da página ✦ geral (SkillsPanel) mostra APENAS
  as INSTALADAS da função com a ★ padrão POR PROJETO (policies.skills;
  ausente = defaultFor) e um ⟳ read-only quando há update (aponta p/ Home).
  Modal de card mostra "⚡ /skill" quando carimbado. IPC `skills:list/
  install/remove/update/check` + push `skills:changed`. Canal no preload
  (`SkillState` espelhado) e devMock.
- SUBAGENTES (rodada 2, mesma data): `kind:'agent'` no MESMO motor — a
  fonte é UM ARQUIVO .md (source.path aponta o arquivo; vira
  `lib/<id>/agent.md`; download valida frontmatter name == id). SONDADO
  (2026-07-29): claude 2.1.220 resolve `<cwd>/.claude/agents/*.md` (project)
  E `<CLAUDE_CONFIG_DIR>/agents/*.md` (user), AMBOS listados no campo
  `agents` do handshake initialize; codex NÃO tem subagente nativo — em
  pane codex a persona viaja no spawn. DOIS MODOS DE USO:
  (1) POR CARD (`create_tasks.agents`/`update_task.agents`/`Task.agents` +
  política `policies.agents` + defaultFor): injetados em
  `.claude/agents/<id>.md` do workspace ANTES do spawn — o dev CLAUDE
  delega trabalho focado via Task tool (prompt ganha bloco "SPECIALIZED
  SUBAGENTS AVAILABLE", só em seat claude; injeção em codex é inofensiva e
  não-anunciada); (2) POR AJUDANTE (`delegate.agent`, um id só): o ajudante
  NASCE como o especialista — claude `--append-system-prompt` com o corpo
  do agent.md (`agentBody()` tira o frontmatter), codex
  `-c developer_instructions="…"` (mesma serialização TOML validada do
  agente livre); id inválido/não-instalado é RECUSADO com a dica; título do
  pane vira o nome do agente. Conselho de delegação (personas PM/
  orquestrador) agora diz EXPLICITAMENTE "agent: <id>" ou "agent: nenhum
  (generalista)" por ajudante — pedido do usuário. list_skills unificou:
  itens com `tipo: skill|subagente`; createTasks valida ID e TIPO por campo.
  `.claude/agents/` também entrou no info/exclude. UI: na Home são DUAS
  SEÇÕES IRMÃS separadas (decisão do usuário — "subagente não mora dentro
  da biblioteca de skills"): "biblioteca de skills" e "subagentes
  especializados" — o MESMO componente SkillsLibrary com prop kind, colapso
  e localStorage próprios (skillsLibOpen/agentsLibOpen), "+ adicionar" só
  na de skills, ⬡ prefixo nos subagentes; func-card tem "subagentes
  instalados" (chips ⬡ + ★ padrão = policies.agents); ChipsEditor de texto
  livre MORREU. Board: linha ⚡ do modal mostra /skills e ⬡ agents.
- TETO DE TAMANHO de skill: 200 arquivos + 30MB totais (o cap antigo de 80
  recusou o impeccable, que tem 128 arquivos LEGÍTIMOS de reference/ — caso
  real 2026-07-29).
- KIT ★ NA MÃO DO PM (pedido do usuário 2026-07-29: "quero que o maestro
  possa selecionar as melhores por padrão"): tool `set_default_skills`
  (PM-only) grava policies.skills/agents da função — validação de id/tipo/
  instalado igual ao createTasks; campo omitido não mexe, [] limpa; canal
  novo `policies:changed` (main→UI) recarrega as ★ da página ✦ geral na
  hora. Persona do PM: definir o kit PROATIVAMENTE ao conhecer a stack
  (CONTEXT.md/código), kit PEQUENO (2-4 skills, 0-2 subagentes), sempre
  avisando o usuário — carimbo por card continua vencendo o padrão.
- CURADORIA DE AGENTS front (5, verificados na fonte): design-review
  (OneRedOak — o canônico do review com Playwright), ui-visual-validator
  (wshobson; defaultFor front), accessibility-expert (wshobson),
  tailwind-frontend-expert (vijaythecoder — pasta tailwind-css-expert.md ≠
  name), expo-react-native-expert (VoltAgent — a exceção de qualidade da
  coleção). departments.ts front.agents = ['ui-visual-validator'].
- RODADA 3 = BACK+DEVOPS FEITA (2026-07-29, mesma receita): 39 skills
  (obra/superpowers metodologia, mattpocock engenharia, wshobson
  backend/cicd/python, vendors oficiais supabase/prisma/redis/stripe/
  cloudflare/hashicorp/temporal/mcollina, trailofbits PBT) + 16 subagentes
  (9 mercado: pragmatic-code-review, 3 da anthropics/claude-code sob a mesma
  licença do agent-creator, api-architect/backend-developer/
  performance-optimizer, incident-responder, debugger lst97; 7 in-house em
  agentsBundled com helper `mk(depts)`: ★backend-reality-checker,
  sql-query-surgeon, migration-surgeon, api-contract-guardian,
  container-optimizer, ci-doctor, observability-instrumentor). defaultFor
  back = test-driven-development + verification-before-completion +
  supabase-postgres-best-practices + backend-reality-checker (espelhado em
  departments.back). Curadoria completa, descartes e LIÇÕES NOVAS (licença
  POR SKILL em anthropics/openai; VoltAgent com "context manager" SEM hífen
  — grep por context-manager dá falso negativo; wshobson prefixa name de
  agents com o plugin; SKILL.md na RAIZ suportado com path ''; `code-review`
  do Pocock RESERVADO para a rodada qa) em docs/SKILLS.md.
- RODADA 4 = QA FEITA (2026-07-29): 31 skills (23 novas — gate de review
  code-review/rubrica/ce-code-review, webapp-testing oficial, kit playwright
  cli+currents, cypress/k6/vitest oficiais, quarteto flaky/contract/visual/
  coverage + exploratory/selector-drift/a11y-testing do petrkindlmann,
  mutation secondsky, wcag/screen-reader wshobson, frontend-design-review
  microsoft — + 8 RE-TAGS: a rodada da função ADICIONA 'qa' aos depts de
  skills/agents já curados que servem ao gate) e 18 subagentes (3 mercado +
  6 re-tags + 6 in-house test-writer★/bug-reproducer/regression-hunter/
  flaky-test-surgeon/e2e-scenario-author/acceptance-verifier + TRIO OFICIAL
  playwright planner/generator/healer TRADUZIDO como bundled, decisão do
  usuário "Vou querer!"). MOTOR NOVO: mcpPaneArgs injeta o MCP
  `playwright-test` (npx -y playwright run-test-mcp-server, wrapper .cmd p/
  codex) em pane de execução QUANDO hasPlaywrightConfig(cwd) — claude nomeia
  o server `playwright-test` (prefixo mcp__playwright-test__* que o trio
  declara), codex `playwright_test` (dotted TOML com hífen exigiria quote
  não sondado). defaultFor qa = code-review + code-review-and-quality +
  webapp-testing + test-writer. Descartes/lições em docs/SKILLS.md (EveryInc
  renomeou o repo e os 17 reviewers viraram personas de ce-code-review;
  "context manager" SEM hífen no grep; wcag-audit da CFLW é o melhor de a11y
  mas SEM arquivo LICENSE — re-entra se formalizarem).
- RODADA 5 = DESIGN FEITA (2026-07-29): 33 skills (21 novas — canvas-design/
  theme-factory/algorithmic-art da Anthropic, +5 do taste-skill (brandkit,
  imagegen web/mobile, redesign, brutalist — 6 pastas≠name no repo!), 5 do
  emilkowalski (apple-design, prototype, find/review/improve-animations),
  motion-design OFICIAL da LottieFiles, brand-identity/logo-design rampstackco,
  typography-audit 78 regras, design-first-ui-prompting do MengTo, excalidraw
  licenciado, ai-graphic-design, design-system-patterns wshobson — + 12
  RE-TAGS com create-design-md e frontend-design virando ★ de design) e 15
  subagentes (3 mercado: prompt-crafter vendor-neutro p/ generate_image,
  ui-ux-designer★ da Madina CC-BY-dentro-de-MIT, ascii-ui-mockup-generator;
  3 re-tags: design-review + design-token-guardian/svg-icon-specialist via
  helper AD; 9 in-house com helper D: image-asset-producer (executor do
  mcp__synkora__generate_image, valida OLHANDO), mockup-artist, brand-guardian,
  svg-logo-producer (geometria luongnv89 MIT), motion-director,
  design-brief-writer, palette-composer, ux-flow-mapper, favicon-og-producer).
  DESCOBERTAS: Remotion oficial e excalidraw líder SEM LICENÇA (fora até
  licenciarem); ecossistema Figma inteiro = pendência única (Developer Terms +
  MCP que o strict exclui); stitch tem name com `::` (filename ilegal no
  Windows). Docs completos em docs/SKILLS.md.
- RODADA 6 = RESEARCH FEITA (2026-07-29; escopo do usuário: pesquisa + docs +
  PLANEJAMENTO — "entra /grill-me etc."): 33 skills (32 novas + re-tag
  domain-modeling) e 11 subagentes (10 mercado + context-curator in-house,
  curador do CONTEXT.md). MOTOR NOVO `orchestratorDefault` (pedido do
  usuário: "o orquestrador é um planejador — deve sempre ver uma dessas
  skills antes de planejar"): SkillDef.orchestratorDefault +
  orchestratorPlanningIds() no skillsLibrary; maestro:paneSpec e
  missions:paneSpec fazem syncToWorkspace das marcadas (grilling, grill-me,
  brainstorming, writing-plans, to-tickets) para o cwd do PM/orquestrador
  ANTES do spawn; personas ganharam "PLANNING SKILLS FIRST" (planejar do
  zero com skill instalada = falha de processo). ACHADOS: /grilling passou a
  existir upstream (dead-ref da rodada back void); quarteto docx/pdf/pptx/
  xlsx da Anthropic é PROPRIETÁRIO ("may not extract/retain/distribute") —
  NUNCA instalar em rodada nenhuma; 1ª colisão skill×agent (fact-checker —
  id é global entre kinds; venceu o agent); knowledge-work-plugins tem
  competitive-brief DUPLICADO (PM×marketing, mesmo name — o de marketing
  fica FORA na rodada copy). Docs em docs/SKILLS.md.
- RODADA 7 = COPY FEITA (2026-07-29): 34 skills novas + re-tags better-writing
  (front→+copy ★) e fact-checker (research→+copy) e 14 subagentes. Backbone:
  coreyhaines31/marketingskills (MIT, 15 de 49 — copywriting 164k installs,
  ai-seo, offers, sales-enablement, public-relations, aso, ad-creative,
  launch…), rampstack (brand-voice/editorial-qa/landing-page-copy/long-form/
  content-and-copy), kwp marketing (brand-review/email-sequence) +
  stakeholder-update (ACHADO da rodada — venceu a internal-comms planejada),
  humanizer (32k★, raiz path ''), superseo (write-content/content-brief),
  naming (guia PT; whois degrada no Windows), kim barrett (headline-matrix/
  schwartz-awareness-mapper, MIT por skill), ce-promote (CAVEAT
  disable-model-invocation: executor claude não auto-invoca — anotado no
  summary; codex ignora), crisis-communications e founder-voice-ghostwriter
  (branch MASTER nos dois). Agents: 7 de mercado (trio seo wshobson ≥4, names
  SEM prefixo desta vez + quarteto rshah515) + 6 in-house helper C
  (microcopy-surgeon ★ — o gap nº 1 do mercado, voice-guardian
  (.synkora/VOICE.md), terminology-guardian (.synkora/GLOSSARY.md),
  release-notes-writer, copy-localizer, conversion-copy-reviewer) — o 15º NÃO
  foi inventado (régua). defaultFor copy = better-writing+humanizer+
  copywriting+microcopy-surgeon (espelhado em departments.copy). LIÇÕES:
  README ≠ TREE (realkimbarrett anuncia ~25, árvore tem ~13 —
  voice-of-customer-miner não existe; rshah515 idem na estrutura); POINTER
  SKILL = ruleset remoto com outra roupa (email-marketing-bible, conteúdo num
  site); agent .md com comando de install ERRADO é vetor real (VoltAgent
  content-quality-editor manda `npm i -g unslop`, que é dedup de CÓDIGO de
  outro autor). Curadoria completa e descartes em docs/SKILLS.md.
- FLEXIBILIZAÇÃO DA META (decisão do usuário, 2026-07-29, rodada research):
  "algumas vão ser difícil achar mais de 30, aí não precisa forçar" — a meta
  de ~30 skills / ~15 subagentes vale QUANDO O MERCADO DER; qualidade
  primeiro, nunca inflar com skill fraca, re-tag artificial ou in-house de
  enchimento para bater cota.
- RECEITA DAS RODADAS (METAS DO USUÁRIO, 2026-07-29 — valem para TODAS as
  funções que faltam: research, copy, cyber, data):
  (1) SKILLS: NO MÍNIMO 30 por função, as melhores do mercado — varredura
  multi-agente com TODO SKILL.md aberto na fonte, paths e frontmatter names
  conferidos (o processo da rodada front é a referência); (2) SUBAGENTES:
  NO MÍNIMO 15 por função — primeiro os MELHORES do mercado (verificados
  como os 5 do front), depois COMPLETAR criando in-house: rodar a skill de
  criação de subagentes instalada na biblioteca e escrever os que faltam
  seguindo a metodologia dela (corpo em `agentsBundled.ts` via bundledBody
  — instalam sem rede, nunca têm update). Curadoria por função nas rodadas
  (front: qa/copy/design ganharão os depts das skills multi-função quando
  chegarem). Descartes com motivo em docs/SKILLS.md (skills:
  web-design-guidelines = ruleset remoto sem pin; ui-ux-pro-max =
  Python+catálogo+autor anônimo; agents: VoltAgent context-manager
  fictício, zhsama/hesreallyhim sem licença, iannuttall arquivado) — não
  reavaliar sem fato novo.

## F6.1 — biblioteca portátil + rodadas CYBER e DATA fecham a F4 (2026-07-30)

- FIX do instalador: vídeo de demo na pasta upstream (caso real: ux-writing
  com .mp4 de ~5MB) derrubava a skill INTEIRA no teto de 4MB/arquivo — agora
  vídeo (`SKIP_MEDIA_RE`) e qualquer arquivo acima do teto são PULADOS
  (SKILL.md gigante segue recusando); a msg de sucesso conta os ignorados.
- EXPORT/IMPORT da biblioteca (decisão do usuário: "coloca o importar e o
  exportar mesmo" — pasta configurável/dentro do projeto foi DESCARTADA por
  ele; não reimplementar): botões ⇪/⇥ na biblioteca da Home; IPC
  `skills:export`/`skills:import` (dialogs) → `exportTo`/`importFrom` com
  adm-zip (dep nova, JS puro): UM .zip com manifest.json + lib/ inteira
  (skills, subagentes, customs e pins/etags — o 1º update-check na máquina
  nova não paga a quota do zero). Import 100% offline, guarda de zip-slip,
  sobrescreve por id, customs entram no catálogo vivo; msg vazia = usuário
  cancelou o dialog (não é erro).
- RODADA 8 = CYBER (48 skills + 15 subagentes novos + re-tags): núcleo
  trailofbits/skills (23, CC-BY-SA-4.0, pasta=name em 100%; plugins agrupam
  scripts/agents FORA da pasta da skill — o merge do semgrep degrada e a
  sarif-parsing cobre) + trio STRIDE do wshobson (name SEM prefixo desta
  vez) + petrkindlmann security/compliance/ai-system-testing (tb qa) +
  privacy-engineering (LGPD explícita) + GoldenWing-360 ×9 (prompt-injection,
  mcp-security, llm-app-security, secret-hygiene… — repo jovem, monitorar) +
  GitGuardian oficial. Re-tags: oauth/security-best-practices/
  owasp-security★/secrets-management/property-based-testing/
  crisis-communications (skills) e incident-responder/pragmatic-code-review
  (catálogo) + container-optimizer/observability-instrumentor (bundled, BC).
  7 agents de mercado (5 ToB standalone, malware-analyst defensivo,
  gdpr-ccpa-compliance) + 8 in-house (helper CY): secrets-hygiene-auditor,
  dependency-auditor (CVE por ALCANÇABILIDADE), authz-reviewer,
  threat-modeler, privacy-engineer (LGPD-first), crypto-usage-reviewer,
  web-surface-hardener, security-fix-verifier (red-green obrigatório). Kit
  ★: differential-review + insecure-defaults + security-testing +
  owasp-security / sharp-edges-analyzer. ACHADOS GRAVES: o plugin
  claude-security OFICIAL da Anthropic é PROPRIETÁRIO (proíbe uso com
  produto não-Anthropic) — NUNCA instalar; e name `security-review` sombreia
  o comando built-in do claude — nunca aceitar skill com esse id.
- RODADA 9 = DATA (39 skills + 13 subagentes novos + re-tags): oficiais em
  peso — dbt Labs ×5, DuckDB Foundation ×4, ClickHouse ×2 (advisor com
  requires), Confluent ×2, Polars Inc, Hugging Face, Dagster (ref MASTER),
  Astronomer ×4 (CLI af), kwp/data (Apache-2.0) + wshobson. Re-tags:
  supabase-postgres-best-practices/postgresql-table-design/domain-modeling
  (skills), performance-optimizer (catálogo) + sql-query-surgeon/
  migration-surgeon/backend-reality-checker (BD) e dataviz-frontend (FD) no
  bundled. 7 agents de mercado (lst97 ×3; VoltAgent CATEGORIA 10 — a leva
  nova é limpa, a 05-data-ai é 100% doente; vector-database-engineer;
  model-evaluator) + 6 in-house (DT): analytics-engineer (o dimensional
  modeling que não existe no mercado), data-quality-sentinel★,
  dataframe-surgeon, experiment-designer, event-taxonomy-designer
  (.synkora/TRACKING.md), metrics-guardian (.synkora/METRICS.md). Kit ★:
  sql-queries + statistical-analysis + validate-data +
  data-quality-frameworks / data-quality-sentinel. Licenças bloqueadoras
  novas: Polyform Noncommercial (majestic inteiro), Databricks license,
  chdb sem Windows (frontmatter `compatibility:` é campo real de vendor).
- TUDO DE UMA VEZ (pedido do usuário: "não quero ficar exportando frente por
  frente"): o export/import SEMPRE foi global (o zip leva as 8 funções;
  curada resolve o dept pelo catálogo, custom viaja com a def no manifest) —
  a UI é que confundia. Agora: botões "⇪ exportar tudo"/"⇥ importar tudo"
  (rótulos e tooltips explícitos), botão "⭳ instalar tudo (N)" (TODA a
  curadoria não-instalada, skills+subagentes das 8 funções numa chamada —
  RETOMÁVEL: só não-instalados entram, persist+notify POR GRUPO de repo, os
  ✓ acendem ao vivo e o que baixou fica se a cota estourar) e 🔑 TOKEN
  OPCIONAL do GitHub (settings.githubToken; fine-grained sem permissões;
  gh() manda Authorization: Bearer; 60/h → 5.000/h = instalar tudo numa
  tacada; campo na PRÓPRIA biblioteca — Ajustes segue só imagens; valor
  nunca renderizado, padrão openrouterKey; rateMsg aponta o token como
  dica). installMany compacta mensagens em massa (>8 oks = contagem; >6
  falhas = 3 exemplos + total). Os botões globais aparecem nas DUAS seções
  (skills e subagentes — mesma ação); e a de subagentes ganhou o
  "+ adicionar subagente" próprio: `addCustomAgent` (skills:addCustomAgent)
  aceita URL do ARQUIVO .md (blob ou raw, com refs/heads/ aceito —
  parseAgentUrl), id = frontmatter `name:` (lowercased, validado de novo no
  download), persiste como custom igual às skills; o addCustom de skill dá
  dica cruzada quando recebe URL de .md.
- FLUXO DE INTEGRAÇÃO REDESENHADO (decisão do usuário, 2026-07-30 — "cliquei
  para integrar e abriu um reviewer testando a página, não tem nexo"): o
  GATE DE INTEGRAÇÃO MORREU. Fluxo canônico: orquestrador → dev → review de
  CÓDIGO APENAS (gate 1: proibido rodar app/browser/playwright — o prompt
  agora proíbe explicitamente; kit fixo de code review instalado:
  code-review/code-review-and-quality/ce-code-review/differential-review +
  agent pragmatic-code-review) → QA (gate 2: valida FUNCIONANDO, browser e
  testes — kit da política qa > ★) → TESTE DE ACEITAÇÃO do humano (persona
  do orquestrador: a pedido, sobe o dev server DO WORKTREE na porta que o
  usuário nomear, como comando em background, e MATA o server antes de
  integrar — processo com cwd no worktree travaria a limpeza) → aval
  explícito → integrate_mission = MERGE DIRETO (`completeMissionMerge` no
  index: caminho único usado também pelo handleMissionVerdict, que segue
  vivo só p/ marcador .verdict órfão de sessão antiga; status 'integrando' e
  o overlay nunca mais acontecem — o merge é síncrono). O ReviewerCard da
  página ✦ geral foi REAPROVEITADO (pedido do usuário na sequência): virou
  "🧐 reviewer de código (gate 1)" — seat+modelo+effort no MESMO storage
  (maestroStore.reviewer*, IPCs maestro:get/setReviewer) e no TOPO da cadeia
  do REVIEW: reviewer configurado > lane 'qa' do plano > política qa >
  seat/modelo do dev (modelo/effort seguem a ORIGEM do seat escolhido —
  nunca misturar modelo de um seat com outro). QA (gate 2) mantém a cadeia
  lane > política > dev. Personas (PM + orquestrador) e a description do
  integrate_mission reescritas para o fluxo novo. PRÉ-CHECAGEM DE CONFLITO
  (caso real do 1º teste: conflito chegou com o orquestrador JÁ MORTO):
  `missionMergePrecheck` (worktree.ts — commit das pendências + destino sujo
  + `git merge-tree --write-tree --name-only`, in-memory, exit 1 = conflito
  com a lista de arquivos; git <2.38 degrada p/ ok) roda ANTES do
  ptys.kill do orquestrador — conflito → pane VIVO recebe o evento injetado
  e resolve (merge da base na branch); limpo → aí sim mata e mergeia.
  Missão presa em 'integrando' (estado do fluxo velho) é solta no boot.
- FLUIDEZ = NINGUÉM DEVOLVE TRABALHO AO HUMANO (reclamação real, 2026-07-30:
  "um jogando pro outro e ngm resolve" — PM mandou o usuário arquivar missão
  pelo board e o orquestrador novo re-perguntou decisão já tomada):
  (1) tool nova `archive_mission` (PM-only; id ou trecho único do título;
  mata o pane do orquestrador, arquiva, branch preservada) — o PM arquiva
  missão superada SOZINHO; (2) personas com a regra dura do usuário: GIT
  NUNCA É PROBLEMA DO HUMANO — modelo de dono nas palavras do usuário:
  "problemas dentro da BRANCH → orquestrador resolve; problemas dentro do
  DEV → maestro resolve antes de jogar em prod". Ou seja: branch da missão =
  orquestrador (merge da base na branch, resolve, commit, integra de novo,
  no MESMO turno); linha de DEV = PM (branch da versão version/<nome>, base,
  conflitos de release, sobras de tarefa solta, qualquer coisa sem
  orquestrador vivo) — a MAIN é prod e só recebe release LIMPA
  (release_version), garantir isso é trabalho manual do PM; humano só decide
  BIFURCAÇÃO DE PRODUTO
  genuína, em UMA AskUserQuestion, e os agentes executam a escolha de ponta
  a ponta; (3) anti-re-litigação no orquestrador: briefing com FATOS errados
  → repo é a verdade dos fatos, decisão gravada do usuário é a verdade da
  INTENÇÃO — adapta o plano e explica a divergência no summary (o aval do
  plano é o ponto de decisão), nunca novo questionário; (4) PM verifica
  fatos de git ANTES de escrever briefing (log/branch --contains).
- GATES POR NATUREZA (regra do usuário, 2026-07-30: "QA é apenas para
  desenvolvimento — design chamando QA não tem nexo"): review/QA existem
  para CÓDIGO QUE RODA; card cujo entregável é DOCUMENTO/guia/spec/asset
  (.md, imagem, brief) nasce com gates: [] — não há o que executar e o gate
  repetiria auditoria já feita (o orquestrador revisa o conteúdo ao
  consumi-lo no briefing seguinte). Regra na persona do orquestrador E na
  description do create_tasks.
- REABRIR SÓ O GATE (caso real, 2026-07-30: usuário fechou o pane do QA e a
  única saída era re-rodar o DEV inteiro — o orquestrador teve que inventar
  uma "rodada de verificação pura"): `run_task` ganhou `phase:
  "review"|"qa"` — reabre APENAS o gate sobre o worktree existente
  (preparePhasePane é idempotente; o trabalho do dev fica intacto). Gate que
  FECHA sem veredito NÃO devolve mais o card ao backlog: evento ao
  orquestrador com a receita (run_task {id, phase}); recovery de BOOT também
  mudou — status 'qa' FICA (worktree persiste entre restarts), só 'execucao'
  volta ao backlog. Persona: "GATE DIED ≠ WORK LOST".
- FIM DAS ★ (decisão do usuário, 2026-07-30: "não quero mais esse negócio de
  estrela — a IA vai receber TUDO da função e ela mesma escolhe"): o
  conceito de kit padrão MORREU. Dev recebe TODAS as instaladas da função
  (+ carimbos de fora dela no card); gates (review E qa) recebem TODAS as
  da função qa (o review segue CÓDIGO APENAS pelo prompt — a cerca é
  comportamental, não de menu); prompt sem ★ ("Nothing is pre-selected: YOU
  choose"). Removidos: tool set_default_skills (registro; api dormente no
  index), bullet do kit na persona do PM (virou "biblioteca bem abastecida +
  conselho por ajudante"), ★/☆ do SkillsPanel da página ✦ geral (agora só
  retrato das instaladas). policies.skills/agents e defaultFor seguem nos
  tipos (dormentes) — defaultIdsFor sem uso no caminho de execução.
- FILA DE PANE MORTO (o 2º buraco silencioso da comunicação, 2026-07-30):
  paneId MORRE com o pane — card reaberto/re-rodado nasce com paneId NOVO, e
  mensagem enfileirada para pane morto girava/sumia em silêncio. Fixes:
  HubDeps.alive (ptys.has) — notifyPaneNow devolve 'dead' sem enfileirar,
  notifyPane descarta, drain deleta fila de pane morto na hora; notify_pane
  devolve erro com a receita (id atual no último pane-open/list_panes);
  advisors (PM + orquestrador) com "PANEIDS DIE WITH THE PANE — nunca
  re-tentar id velho".
- COMPOSER PRESO = DEV SURDO (a causa RAIZ dos travamentos dev codex ×
  orquestrador, 2026-07-30 — duas ocorrências reais; diagnosticada pelo
  retorno novo do notify_pane acusando "na fila" eterno): o xterm RESPONDE
  SOZINHO a queries do TUI pelo MESMO canal pty:write do teclado — DSR
  (\e[l;cR), DA (\e[?…c) e OSC 10/11 de cor (\e]11;rgb:…). Três buracos no
  rastreador do pty.ts: (1) write() marcava lastKeyAt em TODA resposta
  automática — codex polla, composer nunca "esfriava"; (2) o feedInput não
  tratava \e]/\eP: o payload OSC inteiro entrava no inputBuf como texto
  digitado e NUNCA saía (sem Enter) — composerBusy true eterno; (3) CSI
  cortada entre chunks perdia \e[200~/201~ (pane "colando" p/ sempre).
  Fixes: `hasHumanInput()` classifica dedo × resposta (finais R/c/n e params
  ?/> = resposta; setas/teclas/printable = humano) e só humano marca
  lastKeyAt; feedInput consome OSC/DCS até BEL/ST ATRAVESSANDO chunks
  (inOsc, cap 2s) e faz CARRY de sequência cortada (escCarry, cap 64);
  VÁLVULA no composerBusy: buffer sujo sem atividade humana há 30s = lixo,
  limpa e libera. NUNCA voltar a marcar lastKeyAt sem classificar.
- CONSELHEIRO TOOL-FIRST (caso real: dev ficou >1min parado esperando — o
  encanamento entrega em segundos, o atraso era o conselheiro ESCREVENDO
  ENSAIO antes de chamar a tool): os dois DELEGATION ADVISORs (PM +
  orquestrador) agora exigem que o notify_pane seja a PRIMEIRA ação do
  turno, resposta CURTA (só as linhas de decisão por ajudante), narração no
  próprio pane só DEPOIS. E o notify_pane devolve o status real da entrega
  (hub.notifyPaneNow retorna 'injected'|'queued'): "ENTREGUE AGORA" vs "na
  fila — entra em segundos, não reenvie".
- SKILL GATE NO DEV (pedido do usuário, 2026-07-30: "os devs estão ignorando
  totalmente as skills — antes de qualquer passo ele tem que ler todas e
  carregar as que vai usar"): a fase dev agora injeta o MENU COMPLETO da
  função (installedIdsForDept no skillsLibrary — TODAS as instaladas do
  dept; metadata é barata, progressive disclosure) e o bloco do prompt virou
  SKILL GATE — MANDATORY STEP 0: ler o menu inteiro, INVOCAR as que servem
  ANTES de planejar/codar/delegar, declarar na 1ª mensagem quais carregou (e
  quais vão aos ajudantes via delegate.skills) ou dizer explicitamente
  "nenhuma skill se aplica". ★ = carimbo do card > política > padrão
  (a escolha do orquestrador segue destacada). O roster de subagentes entrou
  no mesmo passo 0; o skillsBlock subiu para ANTES do questBlock no prompt;
  o prompt do ajudante manda invocar as skills recebidas PRIMEIRO.
- SKILLS NOS GATES (pedido do usuário: "o reviewer não sabe que tem skill"):
  a pendência da rodada front ("gates ganham skills na rodada qa") nunca
  tinha sido fechada — review/qa de tarefa e o gate de INTEGRAÇÃO nasciam
  sem skill nenhuma. `gateSkillsFor(projectId, cwd, cli)` no index: kit da
  função 'qa' (policies.qa > defaultFor instaladas), syncToWorkspace antes
  do spawn + blocos "SKILLS INSTALLED FOR THIS REVIEW"/subagentes no prompt
  dos TRÊS gates (preparePhasePane review/qa + integrateMission). Dev segue
  com a cadeia própria (carimbo > política > defaultFor).
- TODAS AS 8 FUNÇÕES COBERTAS — a curadoria da F4 está completa;
  departments.ts de cyber/data com ids REAIS (placeholders mortos
  removidos). Lições novas de varredura em docs/SKILLS.md (árvore de repo
  via data.jsdelivr.com sem tocar api.github.com; dead-ref só se confirma
  por fetch direto; licença POR PASTA de plugin; agregador se detecta por
  taxonomia clonada + zero atribuição).

## F5.9 — SYNVOICE (2026-07-30)

- Ditado global montado uma única vez na `TitleBar`, com três modos persistidos:
  botão da barra (clique inicia/para), atalho liga/desliga (tecla ou botão
  auxiliar do mouse; padrão `F9`) e segure-para-falar (padrão `F8`, `keydown`
  grava e `keyup` transcreve). Atalhos inseguros sem modificador são recusados,
  exceto F1–F12; mouse esquerdo/direito também são recusados.
- Paleta flutuante em tamanho M fixo (440×390), arrastável, sem presets P/M/G
  e sem bolinhas decorativas. Ao terminar, transcreve e insere diretamente no
  destino selecionado; o usuário revisa/edita no próprio input.
- Destino é efêmero: terminal usa `term.paste`; inputs/textarea usam o setter
  nativo + evento `input`. Destino oculto/desmontado é revalidado e nunca
  recebe texto. Sem destino, a transcrição vai para o clipboard.
- OpenAI é o padrão: `gpt-transcribe`, com `prompt`, `keywords[]` e
  `languages[]` PT/EN. OpenRouter usa `/api/v1/audio/transcriptions`; o
  catálogo vem de `models?output_modalities=transcription`, portanto o
  seletor nunca mistura modelos de texto/imagem.
- Chaves de OpenAI e OpenRouter são independentes, cifradas por
  `safeStorage` em `synvoice-secret.json`; nunca retornam ao renderer e não
  entram no ambiente dos PTYs. Chave já configurada aparece apenas mascarada
  e bloqueada; para trocar é obrigatório confirmar a remoção primeiro.
  Assinatura ChatGPT e cobrança da API são separadas.
- Áudio fica em memória, é enviado ao provedor escolhido e é liberado após
  sucesso; só permanece para retry quando a transcrição falha. Limites:
  20 MB, 5 minutos e uma requisição por vez.
- Segurança: navegação remota é bloqueada/aberta externamente; permissões de
  mídia aceitam apenas áudio do renderer exato; todo IPC `voice:*` valida o
  frame remetente.

## Convenções

- TypeScript strict em tudo; sem `any` salvo interop inevitável.
- Renderer nunca importa Electron/Node — só fala com o main via `window.synkora`.
- Sem StrictMode no React: o double-mount de dev mataria/recriaria PTYs reais.
- No `TerminalPane`, assinar `onData` ANTES de `pty.create` (senão perde output inicial).
- Seletores zustand devem retornar referências estáveis (nunca `?? []` inline — loop de re-render).
- Dropdowns/overlays: cuidado com stacking context (animações com transform); header tem z-index próprio e overlays vão via portal para o body.
- Mudanças em `src/main`/`src/preload` exigem reiniciar o `npm run dev` (HMR só cobre o renderer).
- UI em PT-BR; código e identificadores em inglês.
- Roadmap: nunca construir a fase N+1 sem a fase N estar em uso (gates no PLANO.md).
