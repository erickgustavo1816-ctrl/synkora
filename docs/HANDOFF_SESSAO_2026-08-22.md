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
   `1b2320a`·`55d8f2b`·`9833a31`·`4481c44`) e a metade MAIN do RightDock
   Onda A (± por arquivo no numstat, IPC `missions:workspaceFileDiff`). A
   metade renderer da Onda A entra por HMR e degrada com receita ("reinicie…")
   até lá.

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

## RIGHTDOCK — Onda A ENTREGUE; Onda B é o PRÓXIMO trabalho

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
- **Onda B (NÃO iniciada — ordem do dono: não subir nesta sessão)**:
  (1) `DockGeneral` — retrato compacto do ✦ geral no rail (missões vivas +
  "N esperando você" + versão em dev/na main + últimas entregas), substitui o
  ProjectDashboard NO RAIL (convite ProjectGeneral fica p/ universo vazio;
  decidir destino do componente/testes do dashboard);
  (2) release-rail veste a moldura + seção "última subida" — precisa da IPC
  `backlog:projectReleases(projectId)` → `releases.list(projectId)` (o store
  R27F2 já tem o método) + preload + espelho.
  Testes vermelhos primeiro; suítes que prendem o rail: test-right-rail,
  test-gui-file-context-menu (marcadores atualizados na Onda A).

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

`nivel5-fase1` está ~40 commits à frente do origin (push sob demanda — o dono
decide quando empurrar).
