# HANDOFF — sessão 2026-08-18 (noite): rodadas 5-6 FECHAM o ciclo redondo

Sessão operada no esquema orquestrador (Fable) + frota Opus 5 max (metodologia
do handoff 15/08, seção "A metodologia que funcionou"). Continuação direta da
2026-08-17. TUDO na `nivel5-fase1`, nada pushado.

## O contexto da retomada

A noite de 17/08 terminou com SETE lançamentos de agente mortos no 529 da
Anthropic (incidente real no statuspage: "elevated errors on Opus 5", 16:20 UTC
até a madrugada). A receita de retomada do handoff anterior foi executada:
relançamento do workflow da R5 com backoff (tentativas 1 e 2 morreram em 529;
a 3ª pousou), vigia no statuspage até o incidente resolver.

## ✅ O QUE ENTROU (4 commits de feature + docs)

1. **R5** (`57a7f05`) — entrega SEMPRE em arquivo + correio nos resultados:
   - `.synkora/helpers/<id>.md` escrito pelo HARNESS no settle (deliver síncrono
     injetado no motor, entre registro e anúncio); `helper_result` endereça:
     caminho primeiro, ~2KB inline; falha de disco degrada honesta.
   - `GuiHelperInbox` = pote ÚNICO do despertador e das 6 tools (`withInbox` no
     seam do McpApi; transporte intocado); bloco `[synkora] ajudantes:` pega
     carona no próximo resultado de tool, entregue UMA vez, sem eco do próprio
     helper lido, irmãos contados após o long-poll.

2. **R6-A** (`fc93155`) — a fundação do ciclo:
   - Estado `interrupted` (assentado, NÃO terminal, único retomável);
     `interruptPane`/`interruptAll`; o will-quit INTERROMPE (nunca descarta).
   - Persistência `userData/gui-helpers.json` (jsonStore atômico; settle grava
     síncrono; rotina em debounce 250ms; `bulk()` colapsa encerramento em massa
     numa gravação; `result` inline NUNCA vai ao disco — o arquivo canônico é a
     entrega). Boot marca vivos como `interrupted` + `helper-restored` +
     retenção 7d + re-grava a foto marcada.
   - `sessionId` capturado cru dos dois CLIs; adaptadores com
     `claudeHelperSessionOptions`/`codexHelperSessionOptions` + resumeSessionId.
   - Escalonador GLOBAL de partida ~2s (spec literal do dono; recibos imediatos)
     + UMA re-tentativa automática de falha transitória (matcher conservador
     529/overloaded/5xx/429; respiro 20s pela mesma fila; visível na ficha).

3. **R6-B** — os verbos e o ■ atômico (commit desta integração):
   - `helper_resume` (7ª tool): só sobre interrupted; pedido reconstruído DO
     REGISTRO (sessionId→resume, seat re-resolvido, permissionMode persistido);
     nudge curto; cronômetro re-arma (`resumedAt`); pela fila do escalonador;
     sem sessionId RECUSA. Card de SEGUNDA VIDA (`helper:<id>#vida<N>`) porque
     o renderer nunca entrega resultado a card fechado nem a id duplicado.
   - `helper_cancel` = DESCARTE: aceita interrompido, apaga o arquivo canônico
     (caminho reconstruído pelo helperId — nunca do resultPath, anti rm-fora),
     recusa done/failed. `cancelAll` DELETADO.
   - ■ ATÔMICO (`GuiSessionRegistry.interrupt`): turno + frota→interrupted +
     `discardPending` (pote drenado, relógio morto, lotes intactos); auditoria
     `gui-interrupt`; vale mesmo sem turno ativo quando há frota.
   - Despertador de BOOT: abertura real posta os parados no MESMO pote com os
     dois verbos, uma vez (dedupe do pote). Placar do correio/wake distingue
     interrompido de concluído/falhou.
   - Desvio declarado e aceito no review: `maestroSession.ts` ganhou
     `| 'interrupted'` no union do tool-result (aditivo).

4. **R6-C** — a lateral e a persona (mesmo commit da integração):
   - Tom `interrupted` ("interrompido", palavra própria) lido de
     `result.status` — contrato byte a byte com a B; único terminal que NÃO
     encerra a ficha; ordem preservada; "agora" some em ficha parada.
   - Cronômetro CONGELADO (`guiSubagentElapsedMs`): vivo conta e grava; parado
     devolve a gravada (nunca lê relógio); `null` = card que voltou parado do
     anel (boot) → sem relógio, nunca "0:00" inventado.
   - CSS papel & painel sem animação: trilho tracejado + ponto vazado; `--err`
     proibido por teste (interromper não é falhar).
   - Persona: 2 linhas do CICLO nos 3 papéis ("volta com os subagentes" literal
     = um resume por interrompido); tetos anti-constituição subiram nas DUAS
     cópias datadas (2500/3700).
   - Split de projeções: `guiSubagentSidebarEntries` (lateral: trabalhando +
     interrompido) × `normalizeGuiSubagentSidebar` (o FIO: só quem trabalha) —
     GuiPane.tsx intocado.

5. **COSTURAS DE INTEGRAÇÃO** (do code review do orquestrador; a onda C mapeou
   os furos fora das fronteiras no §5 do relatório dela):
   - `acceptsGuiToolResult` aceita segundo desfecho em card `interrupted` (sem
     isso helper_cancel nunca fechava a ficha na lateral);
   - `settleLaunchedGuiSubagents` (replay de boot): card `helper:*` despachado
     vira `interrupted` (o motor preservou o registro); subagente NATIVO segue
     `cancelled`; texto do card ensina os dois verbos;
   - `capGuiItems` protege a ficha interrompida da poda do anel;
   - unions `GuiToolOutcome`/`guiApi`/`GuiTerminalToolResult` conhecem
     `interrupted`; `guiToolOutcomeView` mapeia (tone cancel, palavra própria);
   - teste C5 atualizado ao contrato novo (boot: helper→interrompido).

## Disciplina cumprida em TODAS as frentes

Vermelho-antes-de-verde PROVADO pelo orquestrador via stash em: R5 (15/15/1✖),
R6-A (export ausente + 8✖), R6-B/C (8✖ · export ausente · 2✖, amostra) e
costuras (2✖). Gate raiz `test:gui-system` com NPM-EXIT=0 após cada onda.
Review pessoal do diff INTEIRO das quatro frentes.

## Faxina da era antiga (ordem do dono, mesma noite)

- `6ec07c7`: 16 documentos F6 + benchmarks LSP fora de docs/ (14.570 linhas).
- CLAUDE.md REESCRITO para a era 2.0 (~180 linhas): era F6 narrativa saiu; as
  lições permanentes (PTY/ConPTY/env/PowerShell/CLIs) ficaram curadas.
- Memória: refatoração do index 18k REVOGADA pelo dono ("era do Synkora
  antigo") — não re-propor. Desktop já estava limpo (lock soltou no reboot).
- Pendências mortas pelo dono na mesma conversa: validação visual das rodadas
  antigas ("tá ótimo"), rodada de cores --ok/--accent/--warn ("por enquanto
  não vi problema").

## ✅ RODADA 7 (mesma noite — 5 achados da validação ao vivo do dono)

O dono validou o ciclo com DUAS frotas cross-CLI e achou 5 pontos; 3 frentes
Opus max (A na árvore; B e C em worktrees `Synkora-wt-r7*`, integradas por
cherry-pick e já removidos). Commits `0fe177d` · `f5f25ad` · `632ad82` ·
`b6dfad0`; design em `.synkora/reports/DESIGN_RODADA_7_2026-08-18.md`:

1. **Wake pelos bastidores** (A1): o despertador (settle E boot) deixou o
   `send()` — `deliverBackstage()` fatorou o caminho do `announce` (turno abre,
   nada no fio, sem bolha "VOCÊ") e `paneBusyReason()` compartilha as guardas
   de fila/troca de executor. Blackbox marca `silent: true`. Bônus preso em
   teste: o wake não queima mais o `pendingBriefing`.
2. **Entrega é INSUMO** (A2): personas dos dois lados — delegador nunca
   commita/copia relatório de helper (o 43d3270 do teste) e apaga o que a
   frota deixou; helper escreve pesquisa só em `.synkora/`. Tetos 3000/4200.
3. **Fim da ficha fantasma** (B1): `helperId` no input não promove mais —
   promoção só por NOME (delegate / helper:* / type); o long-poll do
   `helper_result` volta a ser card comum.
4. **Painel D8 digno** (B2): labels do seletor do composer injetadas no módulo
   puro (`GuiDelegationModelNamer`), id cru vira metadado; polish impeccable
   (contraste 6,3:1, aria-pressed/controls, alvos 30px, esperando≠vazio, pino
   fora do catálogo visível). Ficha da lateral com `guiSubagentModelName`.
5. **Abrir arquivo onde quiser** (C1): menu de contexto custom (portal,
   teclado completo) no trilho da entrega e na bancada de leitura — abrir no
   app / programa padrão do sistema / mostrar na pasta; IPC
   `files:openExternal` guardado pelo resolver do preview (caminho absoluto
   nasce e morre no main). Suíte nova `test:gui-file-context-menu` registrada
   no gate raiz pelo orquestrador.

Disciplina: vermelho-antes-de-verde nas 3 frentes (registrado nos relatórios
`r7a/r7b/r7c` do scratchpad), review do orquestrador no diff inteiro, gate
raiz NPM-EXIT=0 pós-integração.

## ✅ CAUDA DA RODADA 7 (madrugada — o caso do Painel de Gestão)

O dono validou de novo e trouxe: o menu "onde abrir" era para o CHAT (frente D,
`aec9adb` — token do fio + painel de código, rota `gui:fileOpenExternal` com a
MESMA cerca do gui:fileOpen; executável nunca abre); e o caso real dos 50 mil
linhas no projeto externo. Diagnóstico: a master do Painel avançou 50 commits
POR FORA do Synkora e a base da versão ficou no commit inicial — missão nasceu
em worktree vazio, o agente mergeou a master (corretamente) e a entrega contou
o repo inteiro. AÇÃO MANUAL (opção B do dono): base V1.0 fast-forwarded até a
master (dentro do worktree da versão); as 3 missões velhas do Painel
(a5fa56da, be3a6649, de237c87) nasceram da base vazia — o dono arquiva e
recria. ESTRUTURAL:

- **C2** (`46bf930`): `syncVersionBaseWithMain` (worktree.ts, via gitWorker) +
  `alignVersionBaseWithMain` dentro do createMissionImpl — base atrás e
  ancestral = fast-forward automático (layout com branch checada coberto;
  sujo = blocked preservando; CAS no update-ref); divergiu = advisory auditado
  com as duas saídas; falha de git nunca bloqueia a criação. Blackbox
  version-base-* + aviso no hub no nível do PROJETO.
- **E** (`728ff2b`): ■ com tools em voo nunca mais vira "falhou · erro sem
  detalhe" — `interrupted: true` aditivo no result dos DOIS motores
  (normalizado + bandeira ganha no renderer), card fecha "interrompida pelo
  dono", fio ganha nota neutra "turno interrompido". R6 intocado por
  construção (frota vai por stopPreserving).

Dívida de higiene ACUMULADA para rodada própria (package.json liberado):
`guiHelperSessions.ts` ~1990 e `missionEngine.ts` ~1778 linhas — dividir.

## ⚡ PRÓXIMO (nesta ordem)

1. **VALIDAÇÃO DO DONO ao vivo** do ciclo redondo completo: abrir frota → ver
   entrega em arquivo + correio no meio do turno → ■ (tudo para preservando,
   sem wake póstumo) → fechar o app → reabrir (fichas "interrompido" com
   cronômetro congelado + aviso com os dois verbos) → "volta com os
   subagentes" (resume, card de segunda vida) → descartar um (ficha fecha,
   arquivo some). Atenção especial à costura 5.2: conferir no olho que o card
   interrompido sobrevive ao boot como "interrompido" (o design da C previu a
   corrida main×replay).
2. RightDock (3º do roadmap).
3. Browser (4º).

## Pendências conhecidas (menores, anotadas nos relatórios dos agentes)

- `guiHelperSessions.ts` está em ~1990 linhas (régua da casa ~1000): dividir
  (candidato: bloco do disco → `guiHelperStore.ts`) numa rodada de higiene com
  package.json liberado — as suítes compilam por lista de arquivos.
- `forgetPane` (chat excluído) deixa o .md de um interrompido órfão no
  worktree (git-invisível; morre com o worktree). Aceito.
- Ficha interrompida pós-boot não mostra relógio (por desenho — não há carimbo
  de "quando parou" no renderer); se o dono quiser "trabalhou 4:12" após
  reboot, o harness manda `workedMs` no input do card sintetizado (1 linha de
  cada lado).
- Relatórios completos das ondas no scratchpad da sessão
  (`reports/w5-delivery.md`, `r6a-foundation.md`, `r6b-verbs.md`,
  `r6c-sidebar.md`).
