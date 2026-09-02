# HANDOFF — Sessão 2026-09-02 (R39: A FALA DO DONO PARA O TURNO + pouso + incidente da integração)

Orquestrador + frota Opus (3 agentes, fronteiras disjuntas, worktree
`Synkora-wt-owner-steer`, branch `owner-steer`). Design vinculante:
`.synkora/reports/DESIGN_FALA_DO_DONO_PARA_O_TURNO_2026-09-02.md`; reports por
fatia em `.synkora/reports/owner-steer-agent-{A,B,C}-report.md`; sonda
`PROBE_PRETOOLUSE_BLOCK_2026-09-02.md`; prova visual `owner-steer-agent-C-*.png`.

## A queixa e o que foi MEDIDO

"Toda mensagem que eu enviar… ele vai parar, vai ler o que eu falei e vai
complementar com o que ele tava fazendo." Missão d13f0a00, 01/09 21:30–21:40:
3 falas do dono esperaram 3 min por uma tool do Synkora (as nativas não
carregam a carona); entregues, o modelo (fable xhigh, 451k de contexto, 40–90 s
por passo) emendou SEIS tools recusadas pela dívida de resposta antes de
escrever a primeira linha — 8 min até a resposta. Entrega ≠ obediência; a
posição da fala é a causa (dentro de resultado de tool é a que ele menos
respeita).

## O que foi ENTREGUE (branch `owner-steer`)

- **D1 — a fala PARA o turno e volta como turno novo** (`guiOwnerSteer.ts` +
  `guiOwnerMail.ts` + costura em `guiSessions.ts`): para QUALQUER pane e CLI
  com turno aberto, a fala entra no pote marcada `handoff`, o harness manda
  `interrupt()` só ao turno (a frota não para) e o fecho interrompido entrega
  o pote como turno novo com o ENVELOPE DE RETOMADA (`guiOwnerHandText`: "você
  foi PARADO", "Você estava em: <tool cortada | pensando>", "responda
  PRIMEIRO, depois retome"). A carona (`withOwnerMail`) nunca leva correio
  `handoff`. Pergunta aberta (`AskUserQuestion`): o texto do dono VIRA a
  resposta (provado com 15 pares reais nas transcrições). Permissão/plan-review
  pendente: a fala espera no pote (rota `hold` — dívida nomeada).
- **D4 — dívida de resposta UNIVERSAL** (`guiOwnerDebtHook.ts` +
  `guiOwnerReplyDebt.ts` + `--settings` fundido em `maestroSession.ts`): a
  dívida escreve uma BANDEIRA em `userData/owner-debt/<paneId>.txt` com o
  envelope `deny-json`; um hook `PreToolUse` (matcher `*`) do claude faz
  `if [ -f … ]; then cat …; fi` antes de CADA tool, nativas inclusive.
  SONDADO no claude 2.1.258: o hook roda em `/usr/bin/bash` (NÃO cmd.exe —
  `cmd /c` não bloqueia), as três formas de bloqueio funcionam, `deny-json`
  escolhida; 28 ms de mediana por chamada. Texto da recusa diz "TODAS as
  tools" (o velho dizia "esta tool" e o modelo trocou de tool 5 vezes). Codex:
  só guarda do MCP + persona.
- **D6 — a bolha conta a verdade** (`guiOwnerBubble.ts`, `store.ts`,
  `GuiPane.tsx`, CSS `gui-owner-state-*`): carimbo mono sob a bolha —
  "parando o agente…" (pulsa) · "entregue 21:33:46" · "respondida" — com
  marca por FORMA (círculo/risco/canto), estado só anda para frente, validado
  em tela real a 380 e 900 px.
- **D8 — persona** (`OWNER_VOICE_ORDER`): o app PARA o turno e entrega como
  turno novo; a tool cortada é nomeada; responder primeiro; TODA tool
  bloqueada até responder.
- **Diário**: `gui-owner-stop`, `gui-owner-hand` (msSincePost, lastStep),
  `gui-owner-answer`, `owner-debt-flags-swept`.
- **Gate**: suítes novas `test:gui-owner-mail` (22), `test:gui-owner-debt-hook`
  (28), `test:gui-owner-bubble` (12) no `test:gui-system`; `test:gui-sessions`
  177, `test:gui-delegation-wiring` 114, `test:gui-mission-contracts` 78 —
  todas com prova de vermelho no código velho.

## O DIA (para quem chega depois)

1. **Pouso** em `nivel5-fase1`: `c6c13d3` (WIP de 30/08–01/09: planejador
   delega + vigia de versão dos CLIs), `d296e43` (ajudantes fechando como
   failed: steer no meio do turno + `held`), `625919f` (abas por identidade +
   porta por ajudante). Gate raiz verde na árvore principal.
2. **Incidente da integração** (missão d13f0a00, ⇪ às 12:55): merge gravado
   em 15 s; o `integration_run` matou o próprio pane chamador (kill-batch)
   7 s antes do resultado voltar — o dono viu "rodando" por 1h25; a limpeza do
   worktree falhou porque 4 `python -m reedit.webui` (nohup, dev/ajudantes)
   seguravam a pasta → carcaça sem `.git`, ticket `target_repair_pending`
   (reconcilia só no boot). Servidores derrubados por PID; dívida no backlog
   com os 3 consertos (resultado antes de matar o pane; ceifar processos com
   cwd no worktree; reparo sem boot).
3. **Restart do app**: pendente do dono (main/preload novos + reparo).

## PENDÊNCIAS NOMEADAS

- Rota `hold` (permissão/plan-review pendente) → re-avaliar quando a
  pendência resolver (backlog).
- Carimbo da bolha não entra em `isGuiPersistedEvent` (some no boot).
- `MaestroSession.matches()` não compara `settings` (inofensivo enquanto o
  hook for constante por pane).
- `guiSessions.ts` (3.7k linhas) e `browserPane.ts` (1.2k) seguem acima do
  teto — dívidas já no backlog.
- Aviso visível de conversa pesada no composer (advisory) — candidata.
- Validação AO VIVO da R39 (mandar mensagem com o dev em Bash longo e ver o
  carimbo + o envelope) depende do restart.

## R39.1 — SEM PARAR por padrão + "LER AGORA" (mesma tarde)

O dono viu bônus/ônus do corte e decidiu: *"pode ser sem parar, puro. Aí
minha mensagem vai ficar lá… tipo que ela não foi lida ainda… se eu quiser
eu posso forçar, quando for algo urgente."* Design
`.synkora/reports/DESIGN_FALA_DO_DONO_SEM_PARAR_R39_1_2026-09-02.md`; sonda
`PROBE_STEER_RECEIPT_2026-09-02.md`; reports `owner-steer2-agent-{A,C}-report.md`.

- **Rota padrão `steer`** (`guiOwnerSteer.ts`): com turno vivo a fala vai
  AGORA ao CLI (claude stdin com `uuid`; codex `turn/steer` com
  `clientUserMessageId`), uma cópia `steered` fica no pote como CINTO até o
  recibo; carona e fecho de turno a pulam; só o renascimento a entrega.
- **Recibo de leitura SONDADO** (claude 2.1.258 / codex 0.152.1): claude emite
  `command_lifecycle{state:"started"}` para comando COM `uuid` (capacidade
  `msg_lifecycle_v1` no `system/init`; sem uuid, nada); codex ecoa
  `item/started` de `userMessage` com o `clientId`. Motores emitem
  `owner-steer-absorbed{tag}`; o registro apaga a cópia, carimba `read`, ARMA
  a dívida nesse instante (nunca no envio) e grava `gui-owner-read` com
  `msSinceSend` e `signal: echo|approx` (approx só em CLI sem eco).
- **"Ler agora"** (`gui:forceOwnerMessage`, botão na bolha `unread`): corta só
  o turno; por CAPACIDADE, não por classe — claude preserva a fila
  (`interrupt_receipt_v1`, `still_queued`) e promove a fala a turno novo
  1 ms após o `result`: o harness manda só o envelope curto
  (`guiOwnerForceText`); codex DESCARTA o steer no corte (sonda 3b): a cópia
  vira `handoff` e o fecho a entrega com o envelope completo. O ■ do dono
  ganhou o mesmo resgate no motor que descarta.
- **Bolha**: `unread` ("não lida ainda" + LER AGORA, sem pulso) → `stopping` →
  `read` ("lida hh:mm:ss") / `delivered` → `answered`; escada não regride;
  recusa do main na própria bolha; prova visual real (8 PNGs).
- Persona: a fala chega no próximo passo (ou como turno novo se forçada);
  responder primeiro; toda tool bloqueada até a resposta; nada foi cortado.
- Gate: owner-mail 32, gui-sessions 186, delegation-wiring 116, contracts 79,
  owner-bubble 25 — todas com prova de vermelho.

Pendência nova: anel de foco do app usa `--accent` (2,81:1, abaixo de 3:1) —
o botão LER AGORA usa `--accent-deep`; candidata a rodada de tokens.
