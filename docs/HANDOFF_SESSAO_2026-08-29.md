# HANDOFF — Sessão 2026-08-29 (Skills 2.0: o build)

Orquestrador + frota Opus max (A motor · B sync · C personas · D tela ·
E gate · F split · sonda F0). Item `skills-2-0-build` (fila #1) ENTREGUE.

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
