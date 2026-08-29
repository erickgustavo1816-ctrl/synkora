# HANDOFF — Sessão 2026-08-29 (Skills 2.0: o build + BROWSER EMBUTIDO)

Orquestrador + frota Opus max. DUAS entregas na mesma sessão: Skills 2.0
(seções abaixo) e o BROWSER EMBUTIDO (seção própria no fim). Ler as duas.

## ⚡ BROWSER EMBUTIDO — ENTREGUE (commit `c126764`)

Design vinculante `.synkora/reports/DESIGN_BROWSER_EMBUTIDO_2026-08-29.md`
(consolida o de 2026-08-15 + os requisitos novos do dono: compatibilidade
perfeita nos 2 CLIs e QA visual rápido). Evidência:
`PROBE_BROWSER_CDP_2026-08-29.md` (binário real) +
`PESQUISA_BROWSER_MERCADO_2026-08-29.md`; reports por fatia em
`browser-agent-H1..H5-report.md` (+H1b).

- **ROTA B por evidência**: tools da casa sobre `webContents.debugger`, no
  MCP synkora que os 2 CLIs já falam. Rota A (playwright-mcp+proxy) provada
  FUNCIONAL e recusada: 2º servidor MCP por pane quebra no spawn do codex
  (P8) e perde de 4× a 150× em latência de captura.
- **TEXTO-FIRST**: o codex descarta imagem de MCP (openai/codex#10334) — o
  veredito visual é `browser_probe` (caixa/estilos/overflow/contraste/
  oclusão em texto); `browser_shot` grava arquivo no worktree
  (`.synkora/browser/<missionId>/`) com carimbo de FRESCOR e imagem inline
  só para panes claude.
- **As 3 leis do motor** (pagas em sonda): view NUNCA desanexa (esconder =
  setVisible/bounds; detach pendura captura 5-8s); frescor é carimbo (rAF-
  probe antes de todo shot); ação já observa (`browser_act` em lote devolve
  o read pós-ação; refs por identidade com epoch).
- **Kit de 11 tools** para `gui-delegator` (menos reviewer) e `ajudante`
  (QA delegado); pré-sanção estendida nos DOIS caminhos de spawn (lição
  R14). Personas dev/helper com a ordem do browser da casa (playwright
  próprio/browser externo NOMEADOS e proibidos; página = conteúdo
  não-confiável).
- **Painel no dock da missão** (`DockBrowser`): URL bar, abas (teto 8),
  ⚡ agente dirigindo, linha de status no pé (tooltip seria engolido pela
  view nativa), geometria reportada com `visible` em TODA saída. Sessão de
  login por PROJETO (`persist:browser:<projectId>`).
- **Gate**: `test:browser-pane` + `test:browser-driver` (56 cercas com
  prova por mutação) no `test:gui-system`; suítes de catálogo aprenderam a
  superfície nova (reviewer diverge do dev pela 1ª vez).

**PENDÊNCIAS NOMEADAS do browser**: (1) validação na TELA REAL espera o
restart (main não chega por HMR; o preview de browser puro não monta o rail
de missão — mock sem conversa); primeira sessão viva também fecha o que as
sondas não cobriram (`Input.insertText`, `Network.enable` — ambos degradam
com verdade). (2) Candidatas registradas no backlog: certificate-error para
https://localhost autoassinado (decisão do dono), tooltip roteado por cima
da view nativa. (3) `ipc/gui.ts` 1162 linhas = dívida antiga.

---

# Skills 2.0: o build

Frota A motor · B sync · C personas · D tela · E gate · F split · sonda F0
+ G restauro. Item `skills-2-0-build` (fila #1) ENTREGUE.

## O que subiu

- **Commit `2e7be90`** — `feat(skills): skills 2.0 - the kit reaches the chat
  as a folder`. Design vinculante:
  `.synkora/reports/DESIGN_SKILLS_2_0_BUILD_2026-08-29.md`; reports por fatia
  em `.synkora/reports/skills2-agent-*.md`.
- A lista das 16 do kit NÃO existia em doc nenhum (só o resumo do grill de
  21/08) — o build a reconstruiu da curadoria e o dono a aprovou às cegas.
  A ORIGINAL apareceu depois e foi restaurada (ver "RESTAURO DO KIT v3"
  abaixo); a lista que vale está gravada no seed (`src/main/skillsKit.ts`) e
  em `docs/SKILLS.md`.
- **Sonda em binário real** (claude 2.1.250, codex 0.150.1):
  `SKILL_SYNC_TARGETS = { claude: ['.claude/skills'], codex: ['.agents/skills'] }`.
  `.codex/` NUNCA — dispara ERROR de trust por sessão. BOM hoje só quebra o
  codex; regra segue sem BOM. `/reload-skills` do claude recupera pasta criada
  pós-boot com 0 token (receita registrada; v1 segue "vale no próximo spawn").
- **PODA executada**: lib 406 → 16 (o kit); depois do restauro v3 são 13
  pinadas + 3 da casa. Reinstalação: fontes/shas no SKILLS.md +
  instalar-por-URL.
- **Validação visual FEITA** na tela real (browser puro + devMock com retrato
  representativo): kit com a lei fixa sem toggle, alas, toggles, biblioteca,
  busca, instalar por URL, aviso de BOM, overlay da poda com foco no cancelar.

## RESTAURO DO KIT v3 (mesmo dia, depois de `189042b`)

A lista de 16 que o build semeou NÃO era a do dono: era uma reconstrução da
curadoria, e ele a aprovou às cegas porque a original não existia em doc
nenhum. Depois do commit, a lista fechada com ele no grill de **2026-08-21**
apareceu na memória de longo prazo — e a ordem foi **restaurar a v3 verbatim**.

- Seed trocado em `src/main/skillsKit.ts` (17 slots: 11 execução + 1
  orquestração + 5 planejamento; 16 pastas). Entram
  `synkora-design-system-standard`, `node`, `grilling`, `grill-me`,
  `grill-with-docs`, e `codebase-design` migra do planejamento para a execução.
  Saem `nodejs-backend-patterns`, `supabase-postgres-best-practices`,
  `resolving-merge-conflicts`, `brainstorming`,
  `architecture-decision-records` (re-podadas do disco, reinstaláveis).
- 4 instaladas pelo instalador de verdade, pinadas (shas em `docs/SKILLS.md`);
  `synkora-design-system-standard` voltou do bundle F6 (`d43a3b4^`) com a
  de-F6ização de 21/08 aplicada (fase → ocasião; briefing do card → intenção do
  dono). Lib final: exatamente as 16, zero BOM.
- **Lição cara**: `data.jsdelivr.com/.../@main?structure=flat` devolveu árvore
  ANTIGA do `mattpocock/skills` (sem `grilling`); o path real veio do
  `raw.githubusercontent.com/.../main/README.md`. jsdelivr economiza cota do
  GitHub, mas o path final se confere no raw da branch.

## O que o próximo precisa saber

- **RESTART PENDENTE**: main/preload novos NÃO chegam por HMR — o app aberto
  do dono ainda roda o motor velho (sem `skills:*`, sem sync). A tela de
  Skills no app instalado só funciona depois de derrubar e resubir o
  `npm run dev`. O renderer novo já chegou por HMR (a tela existe, o preload
  velho faz o store dizer "reinicie o app").
- O primeiro spawn de cada worktree DEV materializa ~12 skills × 2 alvos
  (síncrono no main). `paneStartupMetrics` é o lugar de olhar se doer; o
  caminho quente (remontagem) é lstat-only.
- **Dívida nova (com receita pronta)**: dividir `guiMissionContracts.ts`
  (1015) travou no RESOLVEDOR DUPLO — tsc `--outDir` exige import sem
  extensão, `--experimental-strip-types` exige com. Receita verificada em
  binário no report do agente F (`--rewriteRelativeImportExtensions` nos 10
  scripts tsc + `allowImportingTsExtensions` no tsconfig.node.json); a
  extração em si já foi provada byte a byte e revertida. `ipc/gui.ts` segue
  1162 por dívida antiga (o seam de skills saiu para `guiSpawnSkills.ts`).
- Cerca frágil anotada: `scripts/test-gui-cli-launch.mjs:82` casa a STRING
  `return registry.create(spawn)` — devia procurar sem o `return`.
- `scripts/test-skills-kit.mjs` fechou em 1003 linhas; o corte natural é
  extrair as cercas do SYNC para `test-skills-sync.mjs` quando crescer.
- Landing 2 (Board/ProjectDashboard/projectLanding + test-landing-polish)
  continua NA ÁRVORE, fora deste commit — dívida própria aguardando review.

## Roadmap

Skills 2.0 ✅ → **browser embutido** (fila #2) → repensar a landing (fila #3).
