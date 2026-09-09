# HANDOFF — Sessão 2026-09-08 (O HARNESS É DO MODELO — Skills 3.0, release 1)

Orquestrador Fable + frota Opus (A ∥ B ∥ C na Onda 1; D na Onda 2), mesma
árvore com fronteiras de arquivo disjuntas. Design vinculante:
`.synkora/reports/DESIGN_HARNESS_DO_MODELO_2026-09-08.md`; sonda
`PROBE_SKILL_RELOAD_MIDTURN_2026-09-08.md`; reports por fatia
`harness-agent-{A,B,C,D}-report.md` (todos em `.synkora/reports/`, local).
Doutrina: `docs/adr/0008–0011` + `CONTEXT.md` + `docs/SKILLS.md` (estado vivo).
Plano aprovado pelo dono: `~/.claude/plans/keen-wibbling-squirrel.md` (+ a
versão leiga em HTML entregue no chat).

## A ordem do dono e as decisões dele nesta sessão

"Não quero mais algo fixo. Quero que a IA decida qual é a melhor opção para
ela ali naquele momento, e ela vá atrás, ela busque, ela pegue e ela faça. O
harness que o próprio modelo cria é melhor do que um harness bruto que já vem."

- Q1 (onde a skill da internet vive): **efêmera** — "ir lá, ler a skill,
  utilizar na missão e depois descartar" (o orquestrador concordou; card de
  aprovação por repositório saiu do v1).
- Q2 (a ordem de 15/08 "todo design usa impeccable" vale para o orquestrador
  na UI do Synkora?): **"cai junto"** — memória `feedback-design-impeccable`
  atualizada.
- Sinceridade pedida ("faça o melhor plano"): 4 mudanças entraram — padrão de
  direção de UI no lugar da lei; o `mission-playbook` como centro do harness;
  internet é exceção (catálogo curado primeiro); duas releases (R1 núcleo,
  R2 tela).

## O que foi ENTREGUE (commit `8462dcf`, sobre o pouso `4322caf`)

- **A lei caiu** (ADR-0008): `impeccable` é slot comum; `law`/`restoreLaw`
  apagados; a ocasião da era da lei no `skills-kit.json` do dono migra UMA vez
  na leitura (`skills-kit-migrated`); persona com `UI_DIRECTION_LINE` (padrão,
  não lei).
- **Personas** (ADR-0009/0011): `SKILLS_HARNESS_ORDER` (dev/ajudante/
  planejador) + `UI_DIRECTION_LINE` (dev/ajudante) + `PLANNING_METHOD_ORDER`
  (planejador: SIMPLE × ABSTRACT declarado; sugestão de skills no `context`).
  Reviewer e release byte-idênticos. Tetos: contratos 17000, planejamento
  13600.
- **Catálogo da casa como dado** (`src/main/skillsCatalogData.json` +
  `skillsCatalog.ts`): 270 skills da curadoria F6 (`git show
  d43a3b4^:src/main/skillsCatalog.ts`), busca offline por query, vetos
  permanentes (proprietárias, `security-review`, ruleset remoto, e as 5
  Superpowers que ensinam subagente nativo / worktree e branch à mão).
  Gerador re-rodável `scripts/skills-catalog-from-f6.mjs`.
- **Motor**: `downloadSkillFolder` (extraído do instalador do dono; `expectId`
  para as 13 entradas com pasta ≠ id), `skillsSync` LEI 4 (entrada
  `origin:'agent'` sobrevive a todo sync), `skillsAgentSync.ts` (materialize /
  mirror / discard só com impressão digital), `skillsHarness.ts`
  (`.synkora/harness.json` + notas + briefing dos ajudantes),
  `settings.skillsAgentPull` (padrão ligado).
- **Ferramentas MCP** `skill_search` / `skill_pull` / `skill_discard`
  (`guiSkillKit.ts` folha + `guiSkillTools.ts` motor) para dev, planejador e
  ajudante (reviewer fora); pré-sanção nas três listas; nota `❖` no fio;
  diário (`skill-search`, `skill-pulled`, `skill-authored`, `skill-discarded`,
  `skill-pull-refused`, `gui-skill-reload-asked/done`…).
- **Recarga SONDADA em binário**: no claude o `/reload-skills` mandado com o
  turno aberto fica na fila e executa como mini-turno DEPOIS do `result` do
  agente (recibo "Reloaded skills: N skills available (1 added)"); no codex a
  pasta entra no turno seguinte sozinha. Logo: o recibo do `skill_pull` entrega
  o caminho do SKILL.md para uso imediato; `registry.reloadSkills` manda o
  slash cru pelo bastidor (sem `turn-started`) e o `result` do mini-turno vira
  NOTA `❖ catálogo de skills recarregado — …` por marca ESTRUTURAL (contador
  de results do agente, TTL 1h, limpa no dispose).
- **Ajudantes** recebem `SKILLS THIS MISSION ALREADY PULLED …` na persona
  (`guiHelperPersonaFor(lsp, port, harnessBriefing)`); conclusão de missão de
  PLANEJAMENTO varre as skills do agente da raiz do projeto.
- **Gate raiz**: `test:gui-system` verde, 1585 testes (suítes novas
  `test:skills-catalog` 19, `test:gui-skill-tools` 20; reescritas com prova de
  vermelho: contratos 81, skills-kit 50, sessions 237, wiring 119, pinos de
  catálogo por papel).

## O DIA (para quem chega depois)

1. Plano em modo de planejamento (2 rejeições do dono: quis a versão visual
   leiga em HTML, depois "é a melhor opção? seja sincero") → aprovado.
2. Onda 0: design + ADRs + glossário + package.json + backlog + memória.
3. Sonda: 1ª rodada do claude INVÁLIDA (o seat executa Bash sem `can_use_tool`;
   o gatilho da pasta nunca disparou) — corrigida para o `tool_use`; 2ª rodada
   válida. Codex válido na 1ª.
4. Onda 1 (A/B/C) → review do orquestrador: 5 vetos por id no catálogo +
   poda de `requires` órfãos; migração da ocasião da lei; teto do dev 16500 →
   17000 (184 chars de folga não são uma régua).
5. Onda 2 (D) → review → gate → **dois commits**: `4322caf` (pouso de três
   dias de trabalho anterior que estava sem commit: cabeça do palco, aba
   ajudantes, polish do fio, drop zone, painéis do workspace — árvore verde
   antes de pousar) e `8462dcf` (Skills 3.0 R1; carrega os últimos hunks do
   pino de conta da aba ajudantes por partilhar arquivos).

## PENDÊNCIAS NOMEADAS

- **RESTART do app** (main/preload novos não chegam por HMR): quando o dono
  liberar. Nada da R1 foi validado AO VIVO ainda.
- **Validação ao vivo da R1** (roteiro em §"Verificação" do plano): missão
  "landing" (o dev declara o harness e puxa taste-skill/outra; chip ❖; nota
  `repo @ sha7`); missão "backend" (`skill_search` → web → `skill_pull(url)`;
  pasta nos dois alvos; `skill_discard`; biblioteca segue com 16);
  planejamento simples ("sem skill") e abstrato (método declarado); conclusão
  do planejamento limpa a raiz; a linha `❖ catálogo de skills recarregado` no
  fio.
- **R2** (item na FILA do backlog): Ajustes › Skills com o interruptor; painel
  "HARNESS DESTA MISSÃO" com "guardar na biblioteca" (pinado no mesmo sha);
  limpar `law?` do preload/renderer/devMock/`test-skills-settings-ui`; nota do
  pull dizendo qual AJUDANTE puxou; traduzir `system/commands_changed` no
  `maestroSession` (mata o risco residual do recibo da recarga).
- Dívidas anteriores seguem no backlog (guiSessions 3.9k linhas etc.).

## Armadilhas novas (não redescobrir)

- Sonda com seat do app: Bash NÃO passa por `can_use_tool` — gatilho de
  "pasta criada no meio do turno" tem de ser o `tool_use` do stream.
- `/reload-skills` no stdin com turno aberto = fila; executa após o `result`
  como mini-turno (`commands_changed` → `init` → `result`). Nunca no turno
  corrente.
- JSON importado com `resolveJsonModule` é EMITIDO pelo tsc no outDir das
  suítes — mas quem importa o módulo do catálogo arrasta 270 entradas para a
  compilação: por isso `guiSkillKit.ts` é folha (só nomes/tipos/textos) e o
  `mcpServer`/pré-sanções importam dele, nunca do motor.
- Pasta upstream ≠ `name:` em 13 skills da curadoria (taste-skill etc.):
  `downloadSkillFolder` exige `expectId` para elas.
