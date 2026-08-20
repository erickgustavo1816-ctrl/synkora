# HANDOFF — Sessão de 2026-08-20 (o estado vivo da obra)

Sessão do dia inteiro, branch `nivel5-fase1` (ahead ~360 do origin, push sob
demanda). Manhã/tarde: metodologia da casa (design em `.synkora/reports/`,
agentes Opus max em worktrees, cherry-pick, review no diff inteiro, vermelho
provado, gate raiz). Noite: por ordem do dono ("sem ajudante, você resolve"),
o orquestrador implementou direto — mesmo rito, sem frota.

## ⚠ PRIMEIRO ATO DA PRÓXIMA SESSÃO

O app do dono está NO AR com tudo até a R28 (`c23dffe`). **Só a R28.1
(`e75205a`, aviso de dependências no desfecho do release) e a R28.2
(`494004a`+ estão vivas… conferir `git log`) esperam o próximo restart** —
nada urgente; o aviso é advisory. O gate raiz agora tem **30 suítes**
(`test:command-palette` entrou na cadeia).

## O QUE ESTA SESSÃO ENTREGOU (tudo commitado, gate verde em cada bloco)

- **R23 (`f39c88c`)** — o ■ sempre vence: `failInterrupt` derruba o processo
  sem confirmação em 10s COM nota+receita (o kill já existia; o buraco real
  era a nota muda + guarda que saía em silêncio com turno perdido — caso
  concreto: steer falho do codex); pane `dead` não tranca o composer —
  placeholder-verdade com exitCode, enviar = revive-com-resume, draft nunca
  se perde. Voz única em `guiInterruptEscalation.ts`.
- **Fix do paste (`75ceed7`)** — o overlay de menções transladava a própria
  caixa clipada: paste grande pintava texto sobre o fio e o composer ficava
  invisível (só rabiscos do corretor). A caixa não se move mais; composer
  ganhou `spellCheck={false}`.
- **R24 (`ea966a6`)** — histórico completo: anel conta a poda
  (`evictedCount` + `history-pruned`), linha-verdade no topo abre o leitor do
  PRÓPRIO pane (`history:loadForPane`; claude por caminho direto, codex por
  varredura de datas), paginação por FAIXA DE BYTES (cursor = offset),
  binding codex da paleta consertado. `historySessionReader.ts` novo.
- **R25 (`02b7805`)** — cota visível e orquestrador barato: ODÔMETRO da
  conversa (parcelas por chamada dos 2 CLIs somadas no MAIN, persistidas,
  viajando no sticky `context-usage`; pesos cw1.25/cr0.1/in1/out5 VALIDADOS
  contra o /usage real — `guiConversationOdometer.ts`), cota do seat no
  painel do pane (`peekSeatUsage`, zero coleta nova), nota advisory de
  conversa pesada (1 por marco de 150k, receitas /compact + fechar missão),
  aviso de troca cara nos menus, doutrina do orquestrador barato nas
  personas que delegam. Base: `AUDITORIA_COTA_CLAUDE_2026-08-20.md` (sem
  vazamento — física sem medidor; conversa de 285k fez 139 chamadas ≈ 70% da
  janela de 5h; restart re-escreve caches).
- **R26 (`9cb053b`)** — preview de `.md` no chat renderiza como a aba
  Arquivos (um pipeline só: `FileMarkdownContent`), sem scroll lateral.
- **A ESTREIA DO RELEASE cobrou 4 dívidas** (R10 nunca tinha sido validada):
  navegação muda (`19c1447` — loadMissions antes de navegar), pane desarmado
  (`0876cb3` — o re-arme aprendeu o papel gui-release), auto-bloqueio
  (`1b15354` — missão release nunca é pendência de release, por TIPO nas
  duas réguas) e registro imortal (`b3d7844` — a reconciliação de boot
  conclui a missão release junto com a versão). A V1.0 do Painel subiu de
  verdade; a reconciliação travada foi destravada REPARANDO a identidade
  (worktree recriado) e deixando o reconciliador oficial completar.
- **R27 (`38faa7f`) — RELEASE É RELEASE** (ordem verbatim do dono): o
  registro interno fica (carrega conversa/conta/resume) mas some de TODA
  superfície de missão — régua `isReleaseMissionRecord` em
  `missionCardAccess.ts`, consumida por Board, BacklogView, quadro de rota e
  retrato (`d71a09e`, `494004a` fecharam os contadores que o dono pegou:
  "8/9"); trilho próprio `release-rail` (sem fila/arquivar); o chat do
  release opera a PASTA DO PROJETO (matou o autoconflito: morava no worktree
  que a subida apaga); firstPrompt com o MAPA dev→prod; aba Versões com
  endereços (`vs-prod-line`, "mora em:", confirm "dev → prod").
- **R28 (`c23dffe`)** — o release EMPURRA o remoto: com `origin` configurado,
  subir versão = merge + `git push` (runner de rede, nunca force, via git
  worker); falha de push não desfaz o release e ensina o comando;
  `release_status` ganhou a linha REMOTE. **R28.1 (`e75205a`)** — o desfecho
  avisa quando o `package.json` mudou na subida ("rode npm install na pasta
  do projeto") — o LOOP DAS 4 VERSÕES: missão adicionou electron-updater,
  merge levou o manifesto, ninguém instalou na main, o gate do produto
  barrava o dist e o agente "consertava" no worktree um problema que só
  existia na main.
- **Docs**: `1e3b894` corrigiu o CLAUDE.md — `electron-vite dev` NÃO relança
  main/preload (provado); restart manual obrigatório.

## O PRODUTO DO DONO (Painel de Gestão) — estado deixado

- `C:\Users\Erick\Desktop\PAINEL DE GESTÃO - ERICK`, branch local renomeada
  `master`→**`main`** (o GitHub tinha main default PARADA no passado + o
  trabalho todo na master — o verdadeiro "GitHub desatualizado" que o dono
  via). Remoto agora: SÓ `main` (default, em dia), tag `v1.0.3` (a `v0.1.0`
  órfã foi removida). O Synkora usa `currentBranch` dinâmico — nada a
  ajustar.
- `package.json` version alinhada em **1.0.3** (`7eaa552`); instalador
  gerado e assinado `release\Painel-de-Gestao-PER-DCOMP-Setup-1.0.3.exe`
  (o Setup-1.0.0 velho foi apagado). NÃO existe V1.0.4 — nada mudou desde a
  1.0.3; a próxima missão real nasce nela.
- OBS: o produto commita `data: sync <timestamp>` sozinho na main (missão de
  backup automático) — commits por fora são absorvidos pelo ff da criação
  de missão (C2/46bf930).
- FLUXO ENSINADO ao dono: instalador se testa NO WORKTREE (mandar o agente
  rodar npm install + npm run dist e passar o caminho; "mostrar na pasta"
  abre; ⇪ só depois de provado) — nunca queimar release por iteração.

## Candidatas / pendências (nenhuma urgente)

- **R29 candidata**: o release bumpa o `version` do package.json do produto
  (= nome da versão do Synkora) e taggeia `vX.Y.Z` no push — etiqueta e
  caixa nunca mais se separam (hoje foi manual).
- **Persona "build de prova"**: missão que mexe em instalador/build oferece
  o dist de prova sozinha antes do ⇪ (ofereci ao dono; ficou sem resposta).
- **R27 fase 2** (se o dono pedir): release como entidade própria até no
  dado + painel embutido na aba Versões (hoje o host é o Board, de
  propósito — desmontar mata conversa).
- Resíduos R24/R25 nomeados nos relatórios (`r24-agent-report.md`,
  `r25-agent-report.md`); 3 worktrees órfãs `.claude/worktrees/agent-*`
  (remoção bloqueada por permissão; patch salvo no scratchpad da sessão).
- `historySearch.ts` a 1051 linhas (receita no r24-report §6.1);
  `GuiPane.tsx` a ~2500 (extrair GuiHistoryOverlay quando doer).

## Armadilhas NOVAS pagas hoje (não redescobrir)

- `electron-vite dev` NÃO recompila/relança main/preload — restart manual
  (CLAUDE.md já corrigido).
- `bbwatch` imprime UTC (local = UTC-3): reconciliar horários antes de
  concluir qualquer coisa.
- PS 5.1: aspas DUPLAS dentro de here-string de `git commit -m` quebram o
  argv do native exe (a mensagem vira pathspec) — mensagens sem `"`.
- Byte NUL cru em source vira arquivo BINÁRIO pro git (sem diff/review) —
  separador imprimível ou `\u0000` escapado (r24, §7).
- Transcripts do CLI carregam `message.usage` por chamada — auditoria de
  cota REAL se faz somando os .jsonl dos seats (scripts no scratchpad;
  metodologia na `AUDITORIA_COTA_CLAUDE_2026-08-20.md`).
- Os dois CLIs atualizaram DUAS vezes hoje (claude 2.1.236→238, codex
  0.147→149) — nenhuma quebra observada; re-sondar se algo estranhar.

## Relatórios e designs desta sessão (em `.synkora/reports/`)

`AUDITORIA_COTA_CLAUDE_2026-08-20.md` · `INVESTIGACAO_R24_*` · `DESIGN_R24_*`
· `DESIGN_R25_*` · `DESIGN_R27_*` · `r2{3,4,5,6}-red-proof/agent-report` ·
`paste-overlay-red-proof.txt`. A memória do projeto está atualizada até a
R27 + saga; R28/28.1 entram por este handoff + commits.
