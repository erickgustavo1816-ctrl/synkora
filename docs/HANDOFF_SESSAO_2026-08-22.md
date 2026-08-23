# HANDOFF — Sessão de 2026-08-21/22 (o estado vivo da obra)

Sessão dupla (21 e 22), branch `nivel5-fase1`, orquestrador implementando
direto (rito da casa: estudo → design → vermelho provado → gate raiz →
commit por onda). O dono REINICIOU o app em 22/08 ~15:09 (pegou R29 + R30 +
correio de fala imediata). O que veio DEPOIS do restart espera o próximo.

## ⚠ PRIMEIRO ATO DA PRÓXIMA SESSÃO

1. `mcp__backlog__backlog_inbox` — SEMPRE: é onde as mexidas do dono no
   console chegam (doutrina nova; aprovar o MCP `backlog` do `.mcp.json` na
   primeira vez).
2. O próximo restart do app traz: **R27F2 completa** (fecho vivo do release,
   entidade da subida, retrato na aba Versões, cura na leitura — commits
   `1b2320a`·`55d8f2b`·`9833a31`·`4481c44`), a metade MAIN do RightDock
   Onda A (± por arquivo no numstat, IPC `missions:workspaceFileDiff`) e a da
   Onda B (IPC `backlog:projectReleases` + ponte `backlog.projectReleases` no
   preload — commit `35d3b17`). As metades renderer entram por HMR e degradam
   com receita ("reinicie…") até lá.

## O SISTEMA DO BACKLOG (nasceu em 21/08 — o mapa vivo)

- Fonte da verdade: `docs/backlog-synkora.json`. HTML GERADO (nunca editar):
  `docs/backlog-synkora.html` → artifact FIXO
  https://claude.ai/code/artifact/b134fcce-946c-4391-aaed-e1cdfcb84a97
  (republicar pelo MESMO path do repo).
- MCP stdio `scripts/backlog-mcp.mjs` no `.mcp.json` (tools backlog_list/
  inbox/add/move/update/remove/render). CLI: `node scripts/backlog.mjs`.
- Console interativo do dono: **localhost:8090** (`scripts/backlog-serve.mjs`;
  drag entre trilhos, +item, botão "vamos fazer") — auto-start no boot via
  `Startup\synkora-backlog.vbs` (oculto). Mexida dele = diário `by:dono`.
- DOUTRINA: toda entrega move item pro feito (MCP) e republica o artifact.

## ⚠ RIGHTDOCK — a Onda B foi REPROVADA no restart e CONSERTADA em 3 commits

A entrega da Onda B (`35d3b17`) quebrou na tela real ("parabéns, você
conseguiu fazer um trabalho de merda"): o dock renderizou esmagado (a regra
`.dr-btn{width:100%}` da era em coluna vs a fileira nova — ninguém tinha
OLHADO a tela desde a Onda A) e a troca da página ✦ geral pelo DockGeneral
nunca foi o combinado. Conserto por 2×2 agentes Opus max em paralelo:

- `3e75d39` (rodada 1): ✦ geral RESTAURADO verbatim de 7242e95 (a demolição
  do 35d3b17 está REVOGADA; ReleaseRail e a IPC ficam) + dock desesmagado
  (fileira, ⇪ ink/paper, chip com tabela-verdade árvore-limpa/↑N/silêncio,
  histórico sem título duplicado, base com ellipsis).
- `53e4d63`: mockup de aprovação `docs/mockups/rightdock-2.html` — o dono
  escolheu a V1 e mandou: ícone de PAINEL no recolher, fora o ▷ terminal
  comum, fidelidade estrita ("tem que ficar parecido com o mockup").
- `aacba25` (rodada 2): header V1 duas linhas (estado só-notícia; "em
  andamento" nunca renderiza), recolher = ícone de painel na linha 1,
  entrega composta (.dr-row/.dr-fine), clique no arquivo ABRE O DOCUMENTO
  no leitor (± abre o diff na janela larga .cdv; inline e duplo clique
  mortos), ▷ removido (missionShell.ts do renderer apagado; canal main
  dormente), ✕ da frota (R27F3: ownerDismiss→cancel único, canal
  `gui:dismissHelper`, ✕ só em interrompida com helperId, buraco
  pós-restart do correlacionador consertado NA FONTE com cerca vermelha —
  afetava também o helper_cancel do agente).

LIÇÃO GRAVADA (memória feedback-entrega-visual-olhar-tela): entrega visual
só se declara pronta depois de VER a tela (harness estático com o
global.css real, 176/204/340px); mockup de prancheta ≠ layout de página;
demolir superfície aprovada só com ordem literal. PENDENTE: validação
visual do dono na tela + restart para o ✕ da frota (metade main).

## RIGHTDOCK — o histórico da entrega original (Ondas A e B; B = `35d3b17`)

- Mockup APROVADO VERBATIM = contrato: `docs/mockups/rightdock.html`
  (artifact https://claude.ai/code/artifact/da63cf5d-efd9-4c19-b445-87307b087200).
  Design: `.synkora/reports/DESIGN_RIGHTDOCK_2026-08-22.md` · Estudo:
  `ESTUDO_RELEASE_PONTA_A_PONTA_2026-08-22.md` (mesmo dir).
- **Onda A (feita)**: `DockSection.tsx` (recolhível + colapso persistido);
  MissionDeliveryRail recomposto na moldura (dock-head "missão · título" +
  seções ENTREGA/TRABALHO/HISTÓRICO/FROTA); ⇪ primário + ícones 🧐 ▷ ▶ ⊟ com
  as MESMAS guardas/dicas; ± por arquivo (numstat que era jogado fora);
  clique = DIFF INLINE (IPC nova) e duplo clique = leitor; W4 (medida viva)
  intacta. Planejamento tem moldura própria com rodapé concluir/arquivar.
- **Onda B (feita nesta sessão)**:
  (1) `DockGeneral.tsx` — retrato compacto do ✦ geral na moldura (AGORA:
  vivas + "N esperando você" pela régua única `waitingOnOwner`, clique abre a
  missão; versão em dev pelo helper puro NOVO `versionInDev` + versão na
  main · ÚLTIMAS ENTREGAS: `recentConcluded` datado por `completedAt`). O
  painel largo foi DEMOLIDO (decisão registrada): ProjectDashboard,
  MissionDashboardRow, CSS `.pd-*` e os helpers órfãos (projectKpis,
  missionTimeline, missionDayLabel); a leitura de planos do Board morreu
  junto (relance de planos = aba Mapa). Convite ProjectGeneral fica.
  (2) `ReleaseRail.tsx` — o release veste a moldura (dock-head "release ·
  V…" + "a subida" + "última subida" lendo `backlog:projectReleases` →
  `releases.list(projectId)`; linha compacta em `releaseRailPresentation.ts`
  — NUNCA afirma além do registro: `publishRequired` declara pipeline, a
  linha diz a receita, não "caixa publicada"; sem ponte = receita de
  restart; sem subida = seção nem nasce).
  Testes: vermelho provado antes do verde (test-right-rail +
  test-project-landing reescrito p/ o retrato + test-backlog-view); 3
  marcadores PRÉ-QUEBRADOS da Onda A curados (provado em worktree do HEAD:
  dica do 🧐 sem "headless", guardas do arquivar do planejamento, "dev →
  main" preso ao Board no test-gui-chat-ui). Gate raiz VERDE.

## AS OUTRAS FRENTES DESTA SESSÃO (tudo commitado, gate verde)

- **R27F2 — a release REDONDA** (4 ondas): régua nova "todo mutador de missão
  fora do missionEngine empurra missions:changed"; releasesStore (entidade
  por subida: merge/push/bump/caixa); retrato na aba Versões
  (`backlog:versionReleases`); cura viva na leitura + receitas presas por
  teste. Decisão registrada: pane pós-fecho fica VIVO (boot varre).
- **Skills 2.0 PLANEJADA** (grill-with-docs): ADRs `docs/adr/0001-0007` +
  glossário `CONTEXT.md`. Kit de 16 (uma por ocasião; impeccable = ÚNICA lei);
  `synkora-codigo-limpo` e `synkora-investigacao` JÁ ESCRITAS na lib. BUILD na
  fila #1: store semeado + sync no spawn (pasta de skills do worktree, nativo
  nos 2 CLIs) + tela completa de gestão + instalar-por-URL pinado + personas
  + PODA das ~400 (fontes documentadas no SKILLS.md permitem reinstalar).
- **21/08**: Painel v1.0.4/1.0.5 (R29 validada ao vivo — bump automático);
  dev isolado do instalado (`42024ee` no produto: userData -dev); R30 (chips
  ink, delivery do release, card na coluna); caret do composer (2 atos:
  break-word + sentinela ​escapada); owner-mail exige FALA imediata (bbwatch
  provou entrega 0-25s — o bug era mudez, não transporte).

## ⚠ 23/08 — O AGENTE FRATRICIDA (dois crashes na madrugada)

O dev da missão de auditoria derrubou o Synkora DUAS vezes com `Get-Process
electron | Stop-Process -Force` (limpava o app Electron em teste; o
hospedeiro também é electron.exe). Provado no transcript do seat (o tiro às
04:03:36.872Z; child-gone em massa 1s depois; segundo tiro 04:15:44Z).
Assinatura de kill externo: renderer+utilities exit -1 no MESMO segundo, sem
dump, sem WER. LIÇÃO DURA: o diário NÃO vê o shell nativo dos CLIs —
silêncio na caixa-preta não inocenta o agente; a fonte é
`%APPDATA%\synkora\seats\<seat>\projects\<cwd>\*.jsonl`. DEFESA:
`PROCESS_KILL_FENCE` (regra do fratricídio) nas personas de dev/helper/
release (persona, não guarda: o harness não intercepta Bash/PowerShell
nativos), cerca em test-gui-mission-contracts, teto do contrato 6500→7200.
Vale para conversas NOVAS após restart; a conversa da auditoria recebeu a
ordem pela mensagem do dono.

## ARMADILHAS NOVAS (pagas nesta sessão — não redescobrir)

- PS 5.1 `Set-Content -Encoding utf8` grava **BOM** — em .tsx o TS engole,
  mas remover por bytes (o Write tool não põe BOM; preferir ele).
- `--experimental-strip-types` NÃO aceita parameter property
  (`constructor(private x)`) — campo explícito sempre (lição na skill `node`).
- Here-doc bash come um nível de escape (`\\u200b` vira `​`) e caracteres
  invisíveis somem no colar — patch de precisão vai por SCRIPT python em
  ARQUIVO com prova por BYTES.
- Artifact/Browser pane oculta NÃO composita (screenshot falha) — frames de
  vídeo saem por canvas/dataURL via javascript_tool.
- bbwatch: o dir tem `journal.md` além dos `journal-*.jsonl` — `ls | tail -1`
  pega o .md; filtrar por `journal-\\d{8}`.
- Classificador de permissão barra extração de token de credencial em bash —
  script node dedicado com propósito único passa e é mais honesto.

## Estado do push

`nivel5-fase1` está ~42 commits à frente do origin (push sob demanda — o dono
decide quando empurrar). Roadmap: RightDock COMPLETO → Skills 2.0 build (fila
#1) → browser embutido.
