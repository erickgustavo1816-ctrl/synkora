# Synkora — Biblioteca de Skills (arquitetura v4, 2026-08-10)

## ⚡ SKILLS 2.0 — O ESTADO VIVO (build de 2026-08-29)

O sistema F6 descrito abaixo foi DEMOLIDO na LIMPA; esta página fica como
memória de curadoria (fontes + shas + vetos — é ela que permite reinstalar
qualquer skill pinada). O que vale hoje:

- **ADRs 0001–0007** (`docs/adr/`) + glossário (`CONTEXT.md`): agente escolhe
  do cardápio; transporte por pasta no worktree; kit por tipo de chat (dev com
  alas execução/orquestração, planejamento; release sem kit); UMA lei
  (UI ⇒ `impeccable`, na persona); tela completa de gestão; biblioteca
  congelada + instalar-por-URL pinado.
- **Build entregue em 2026-08-29** (commit `2e7be90`): `skillsKit`
  (store semeado com o kit de 16 aprovado pelo dono), `skillsSync` +
  `guiSpawnSkills` (sync no `gui:create`, manifesto gerenciado — pasta do dono
  nunca é tocada), `skillsLibraryScan`/`skillsInstall`/`skillsPrune`,
  IPC `skills:*` + `api.skills`, tela Ajustes ▸ Skills, personas com cardápio
  (dev/ajudante/planejador) e a lei (dev/ajudante). Gate: `test:skills-kit` +
  `test:skills-settings-ui` no `test:gui-system`.
- **Sonda 2026-08-29** (`scripts/probe-skills-cwd.mjs` +
  `.synkora/reports/PROBE_SKILLS_CWD_2026-08-29.md`): claude lê
  `.claude/skills` do cwd (pasta precisa existir no boot; `/reload-skills`
  recupera com 0 token); codex lê `.agents/skills` E `.codex/skills` — mas
  criar `.codex/` dispara ERROR de trust a cada sessão, então o sync escreve
  SÓ em `.agents/skills`. BOM hoje quebra SÓ o codex (claude 2.1.250 tolera);
  a regra segue UTF-8 sem BOM. `skills/extraRoots/set` do codex funciona
  (apontar em vez de copiar) — registrado, fora do v1.
- **PODA executada em 2026-08-29**: 406 → 16 pastas na lib (o kit inteiro);
  manifest limpo preservando procedência. Qualquer skill desta página volta
  re-instalável pela URL da fonte, pinada.
- **RESTAURO v3 em 2026-08-29 (mesmo dia, depois do build)**: a lista de 16 que
  o build semeou era uma RECONSTRUÇÃO da curadoria — aprovada às cegas porque a
  original ainda não tinha aparecido. A lista fechada com o dono no grill de
  2026-08-21 foi recuperada da memória de longo prazo e ele mandou restaurá-la
  verbatim. É a de baixo (kit v3), e ela é a única que vale.

### O KIT v3 (o de 2026-08-21 — uma skill por ocasião)

| Chat / ala | Ocasião | Skill |
|---|---|---|
| dev · execução | mexer em UI (**A LEI**, fora de toggle) | `impeccable` |
| dev · execução | criar/evoluir design system | ★ `synkora-design-system-standard` |
| dev · execução | limpar/revisar o próprio código | ★ `synkora-codigo-limpo` |
| dev · execução | investigar antes de mexer | ★ `synkora-investigacao` |
| dev · execução | desenhar a arquitetura | `codebase-design` |
| dev · execução | back-end Node/runtime | `node` |
| dev · execução | caçar um bug | `systematic-debugging` |
| dev · execução | código novo com teste | `test-driven-development` |
| dev · execução | declarar pronto | `verification-before-completion` |
| dev · execução | segurança | `owasp-security` |
| dev · execução | copy de interface | `better-writing` |
| dev · orquestração | destrinchar/planejar a frota | `writing-plans` |
| planejamento | estressar uma proposta | `grilling` |
| planejamento | ser entrevistado a fundo | `grill-me` |
| planejamento | entrevista que escreve docs/ADRs | `grill-with-docs` |
| planejamento | modelar o domínio | `domain-modeling` |
| planejamento | escrever o plano | `writing-plans` |

★ = da casa (sem entrada no manifest: não têm procedência de rede).
17 slots, 16 pastas — `writing-plans` serve duas ocasiões.

**Instaladas no restauro** (pinadas pelo instalador por URL, 2026-08-29):

| Skill | URL da pasta | sha pinado |
|---|---|---|
| `node` | `mcollina/skills` → `skills/node` | `c605269f85f6e449c1f76b7c9e8c73381fccfc68` |
| `grilling` | `mattpocock/skills` → `skills/productivity/grilling` | `85f83d3fde1d3a90d5c9a657f6998c79a6c37308` |
| `grill-me` | `mattpocock/skills` → `skills/productivity/grill-me` | `fcf0071560d32913c9d4f820e0d7ca467c881619` |
| `grill-with-docs` | `mattpocock/skills` → `skills/engineering/grill-with-docs` | `447ca70872026d5b79d6073a546dac082117fed7` |

`synkora-design-system-standard` voltou do bundle da era F6
(`git show d43a3b4^:src/main/skillsBundled.ts`), com a de-F6ização de
2026-08-21 aplicada no texto (fase → ocasião; briefing do card → intenção do
dono). SKILL.md + 5 references + template de manifesto + validador.

**Saíram na re-poda** (citadas pelo kit v1 reconstruído, não pelo v3):
`architecture-decision-records`, `brainstorming`, `nodejs-backend-patterns`,
`resolving-merge-conflicts`, `supabase-postgres-best-practices`. Continuam
re-instaláveis — as fontes estão nas seções históricas desta página.

**Armadilha do restauro (não redescobrir)**: `mattpocock/skills` foi
REORGANIZADO — hoje é `skills/productivity/<nome>` e `skills/engineering/<nome>`
(era `skills/engineering/<nome>` na rodada 3 e raiz antes disso). Pior: a
listagem `data.jsdelivr.com/v1/packages/gh/<owner>/<repo>@main?structure=flat`
devolveu uma árvore ANTIGA (pastas na raiz, sem `grilling`) enquanto
`raw.githubusercontent.com/.../main/README.md` já mostrava a nova. jsdelivr
serve para economizar cota, mas o path final se confere no raw da branch.

---

Skills que o Synkora instala da fonte, seleciona por necessidade e entrega por
receipt somente ao pane autorizado. A biblioteca pode ser grande; o contexto
de cada execução é deliberadamente pequeno.
Cobertura automática atual: Front/UI, Design System, Back, DevOps, Cyber,
Data, Research, Copy e QA autoral. O board continua com oito funções porque
DevOps é uma lane especializada de Back; cada fluxo executável tem contrato
nativo, roteamento contextual limitado e gate independente. As contagens da
curadoria de mercado permanecem nas seções históricas abaixo, mas quantidade
instalada nunca significa quantidade entregue a um pane.

A curadoria vem de varredura de mercado com verificação na fonte (todo SKILL.md
aberto no repo real; paths, frontmatter `name` e branch conferidos em 2026-07-29).
Fonte da verdade em código: `src/main/skillsCatalog.ts`.

## Planejamento no Maestro

O Maestro e o orquestrador recebem **um único método** de planejamento:
`synkora-planning-standard`. Não existe fallback externo. Se o pacote nativo
não estiver disponível, o seletor retorna vazio em vez de substituí-lo por uma
metodologia diferente. O playbook nativo traduz descoberta e decomposição
para `save_project_plan`, `create_plan` e `create_tasks`, sem criar outro fluxo
de docs, commits, worktrees ou subagentes. O pacote é entregue por um receipt
novo a cada abertura do Maestro/orquestrador. `save_project_plan`,
`create_plan` e `create_mission` recusam qualquer mutação sem esse receipt
ativado e declarado; a identidade do pacote fica gravada na mesma fotografia
do artefato. No plano mestre, um SHA-256 canônico liga a prova ao conteúdo e um
carimbo no control-plane impede que editar o JSON do workspace reaproveite o
receipt para outro roadmap. Não existe registro retroativo nem bypass por
“raciocínio direto”. Planos já aprovados antes deste contrato continuam
executáveis com a marca explícita `legacy_unverified`; proposta nova nunca usa
essa exceção.

As skills externas do grupo `planejamento` continuam instaláveis no catálogo
como `manualOnly`, para usos manuais fora do Maestro. Elas nunca são injetadas
no PM ou no orquestrador e sua instalação não altera o método nativo.

## Design system nativo (2026-08-10)

Criação/evolução de design system ganhou um contrato próprio e fixo:
`synkora-design-system-standard`. Ele ocupa o mesmo slot visual que o
Impeccable; os dois nunca são empilhados. O roteador distingue trabalho
sistêmico (tokens, biblioteca de componentes, padrões, documentação viva e
governança) do uso cotidiano de um sistema existente numa tela. O primeiro usa
o standard novo; o segundo continua usando exatamente uma operação Impeccable.

O pacote nativo cobre cinco camadas conectadas: fundamentos/tokens, elementos e
componentes, padrões de produto, documentação/specimen executável e governança.
Ele inclui referências progressivas, um template de manifesto rastreável e um
validador determinístico de estrutura/caminhos. O validador não atribui nota
estética. O QA recebe `synkora-design-system-qa` além do contrato de UI e do QA
visual geral; ele cruza manifesto, fontes, documentação e render sem herdar o
método do criador.

A pesquisa comparou [RampStack design-system](https://github.com/rampstackco/claude-skills/blob/main/skills/design-system/SKILL.md),
[Wshobson design-system-patterns](https://github.com/wshobson/agents/blob/main/plugins/ui-design/skills/design-system-patterns/SKILL.md),
[UI UX Pro Max design-system](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/main/.claude/skills/design-system/SKILL.md),
[Vercel design-systems-to-agent-skills](https://github.com/vercel-labs/design-systems-to-agent-skills)
e [Penpot AI Kit](https://github.com/penpot/penpot-ai-kit). RampStack foi a
melhor referência única de criação completa; Wshobson contribuiu a hierarquia
técnica de tokens e Vercel a disciplina de extração/verificação. Nenhum workflow
externo é injetado cru: o adapter nativo preserva receipts, fases e gates do
Synkora.

O [ds-hope-finances](https://github.com/jbrunnoo/ds-hope-finances) foi usado
apenas como benchmark funcional de completude — paletas, tipografia, spacing,
componentes/estados, formulários, KPIs, gráficos, tabelas densas, calendário,
feedback e exemplos de produto. Como o repositório não publica licença, nenhum
código, texto ou asset foi copiado.

## Contratos nativos de Back, DevOps e Cyber (2026-08-10)

Estas três frentes agora usam a mesma arquitetura que estabilizou o Front: uma
régua nativa obrigatória, no máximo uma técnica externa contextual e um QA
independente. A quantidade do catálogo não aumenta o contexto do executor.

| Frente | DEV/ajudante | Técnica contextual (máx. 1) | QA independente |
|---|---|---|---|
| Back | `synkora-backend-standard` | OAuth, API, Postgres, MCP, Stripe, Node, Python, debugging ou TDD conforme o card | `synkora-backend-standard` + `synkora-backend-qa` |
| DevOps | `synkora-devops-standard` | GitHub Actions, Terraform, SLO/PromQL, Workers ou pipeline/deployment conforme o card | `synkora-devops-standard` + `synkora-devops-qa` |
| Cyber | `synkora-cyber-standard` | OAuth, segredos, supply chain, prompt injection, MCP, Next.js, threat model ou security testing conforme o card | `synkora-cyber-standard` + `synkora-cyber-qa` |

DevOps continua aparecendo como função Back no board atual, mas o roteador
classifica artefatos operacionais concretos (CI/CD, workflows, IaC, Terraform,
containers, rollout/rollback, SLO/observabilidade) antes da escolha da técnica.
Near-misses como “pipeline de dados”, uma entidade chamada Release ou um card
que declara “sem mudanças no deployment” continuam no fluxo normal de Back.

O contrato de Back cobre limites de API/serviço, autenticação versus
autorização, compatibilidade, efeitos externos, persistência, transações,
idempotência, concorrência, migrações, jobs, falhas e observabilidade. Seu QA
transforma o card em uma matriz proporcional de ator, entrada, estado, saída,
efeito e maior caminho negativo; ele usa somente evidência autorizada e bloqueia
quando o comportamento essencial não pode ser observado.

O contrato de DevOps trata pipeline e infraestrutura como código de produto:
trust de triggers, permissões, pinning, build reproduzível, artefato imutável,
IaC/state, containers, least privilege, compatibilidade de rollout, rollback e
SLOs. Nem DEV nem QA fazem apply, deploy, release, destroy, rotação de segredo ou
mutação de cloud/produção autonomamente; esses efeitos continuam atrás da
aprovação humana específica do produto.

O contrato de Cyber é estritamente defensivo e limitado ao repositório/escopo
autorizado. Ele cobre trust boundaries, authz/tenant, segredos e supply chain,
LLM/prompt injection/MCP e remediação com evidência sanitizada. Seu QA verifica
a alegação e a classe da correção com dados sintéticos; não abre varredura ampla,
não lê valores secretos e não transforma a aprovação de um card em declaração
de pentest, certificação ou segurança total.

A curadoria contextual preserva fontes fortes em vez de copiá-las para um
workflow monolítico: [Supabase Postgres Best Practices](https://github.com/supabase/agent-skills),
[HashiCorp Agent Skills](https://github.com/hashicorp/agent-skills),
[Trail of Bits Skills](https://github.com/trailofbits/skills) e o
[OWASP Secure Agent Playbook](https://github.com/OWASP/secure-agent-playbook).
Os corpos externos continuam subordinados aos receipts, capacidades e fases do
Synkora; nenhum deles recebe o direito de abrir outro processo, gate ou efeito
externo.

## Contratos nativos de Data, Research e Copy (2026-08-10)

A segunda rodada de contratos de resultado cobre as três funções de conhecimento.
O catálogo continua amplo, mas cada pane recebe somente o contrato nativo e no
máximo uma técnica contextual. O QA recebe um contrato próprio e nunca herda o
método usado pelo autor.

| Frente | DEV/ajudante | Técnica contextual (máx. 1) | QA independente |
|---|---|---|---|
| Data | `synkora-data-standard` | dbt/MetricFlow, Polars, DuckDB, SQL, KPI, dashboard, visualização, data quality, experimento ou estatística conforme o artefato | `synkora-data-standard` + `synkora-data-qa` |
| Research | `synkora-research-standard` | reverse-spec, PRD, competitive brief, market sizing, user-research synthesis ou pesquisa por fontes primárias | `synkora-research-standard` + `synkora-research-qa` |
| Copy | `synkora-copy-standard` | brand review/voice, UX writing, landing, email, social, SEO, copy editing ou humanização conforme o canal | `synkora-copy-standard` + `synkora-copy-qa` |

Data trata cada número como um claim ligado a source snapshot, grain, definição,
tempo e transformação reproduzível. O contrato cobre joins, denominadores,
missingness, outliers, leakage, experimentos, incerteza, dashboards e privacidade.
Seu QA reconstrói a alegação, reconcilia ao menos um total/invariante por rota
independente e limita a aprovação ao snapshot e método realmente observados.

Research parte de uma pergunta que reduz incerteza para uma decisão. Fontes
primárias e atuais vencem resumos secundários; cada claim material precisa de
suporte direto, data e proveniência. Contradições, inferências e gaps ficam
explícitos. O roteador não injeta automaticamente `deep-research`, porque seu
workflow próprio de subagentes/counter-review disputaria o controle do Synkora;
pedidos profundos usam a técnica source-primary `research` dentro do contrato.
O QA audita primeiro os claims capazes de mudar a decisão, incluindo fonte,
recência, counterevidence e confiança.

Copy separa verdade de persuasão. O contrato fixa audiência, momento, ação,
voz, product truth, prova, canal, acessibilidade e consentimento. Ele proíbe
claims, depoimentos, escassez ou garantias inventadas e nunca autoriza publicar,
enviar campanha ou alterar CMS autonomamente. O QA verifica brief, claims, voz,
completude do canal, estados de UX e o maior risco de interpretação; aprovação
não equivale a clearance jurídico nem garantia de conversão.

A curadoria reutiliza técnicas fortes sem importar seus workflows inteiros:
[Anthropic Knowledge Work Plugins](https://github.com/anthropics/knowledge-work-plugins)
para Data, Research e revisão de marca; [dbt Labs Agent Skills](https://github.com/dbt-labs/dbt-agent-skills)
para analytics engineering e semantic layer; [DuckDB Skills](https://github.com/duckdb/duckdb-skills)
para arquivos e consulta local; e [Corey Haines Marketing Skills](https://github.com/coreyhaines31/marketingskills)
para copy, canal e edição. Cada técnica permanece subordinada ao contrato,
receipt, capability e fase do Synkora.

## QA autoral nativo (2026-08-10)

QA agora tem dois papéis separados. Um **card da função QA** cria ou repara
testes, fixtures, harnesses e checks; a **fase QA desse card** julga de forma
independente se os testes entregues realmente detectam o defeito/contrato que
alegam cobrir. O executor não aprova o próprio trabalho.

| Momento | Plano automático | Responsabilidade |
|---|---|---|
| DEV/ajudante de QA | `synkora-qa-standard` + no máximo uma técnica contextual | transformar critérios e risco em oráculos sensíveis, fixtures determinísticas e evidência executável |
| QA do card QA | `synkora-qa-qa` | auditar traceabilidade, sensibilidade ao defeito, limites reais, determinismo e resultados sem herdar a técnica do autor |

O roteador escolhe técnica somente quando a necessidade é inequívoca:
Playwright/Cypress/browser, Vitest, API, contrato, visual, acessibilidade,
segurança, carga k6, mutation, coverage, flaky/reliability, exploratory ou
selector drift. Sem sinal específico, fica apenas o contrato nativo; não existe
fallback genérico de navegador. Uma negação como “sem testes de API ou browser”
não ativa essas técnicas por coincidência textual.

As capacidades também são parte da decisão. Uma técnica de browser só entra
quando o pane realmente recebeu browser; um carimbo explícito incompatível
falha fechado em vez de ser substituído. O contrato autoral exige leitura,
escrita e shell para criar e executar testes. O gate `synkora-qa-qa` é
read-only e recebe somente a evidência/artefatos autorizados.

`webapp-testing` permanece instalável como `manualOnly`: seu workflow próprio
de Python, servidor e Playwright é útil fora do fluxo governado, mas não é
mais fallback automático. Isso evita que um card de unit, API, contrato ou
confiabilidade seja transformado silenciosamente num teste de navegador.

## Como o sistema funciona (F4 — implementado)

- **Catálogo curado** (`skillsCatalog.ts`): id = `name:` do frontmatter upstream
  (a pasta instalada usa o id; a spec Agent Skills exige pasta = name).
- **Instalação** (HOME → "biblioteca de skills" — global à máquina, serve
  todos os universos; a página geral de cada projeto mostra apenas a
  disponibilidade por função): baixa a subpasta do repo
  (GitHub commits→trees→raw, SEM git; sha do último commit da subpasta = versão
  pinada) para `userData/skills/lib/<id>`. UTF-8 puro — **BOM quebra o parse
  do frontmatter nos DOIS CLIs** (sondado). Routers instalam as dependências
  junto (`requires`).
- **Atualização** (o diferencial): check diário no boot + botão "⟳ conferir
  skills" na página geral. Duas etapas para caber na quota anônima do GitHub
  (60 req/h): 1 request de HEAD por repo (HEAD igual = nada mudou em nenhuma
  skill do repo); só repo com HEAD novo paga 1 request por skill
  (`commits?path=`). Skill com update ganha badge ⟳; atualizar = re-baixar
  pinado no sha novo.
- **Roteamento mínimo por fase**: disponibilidade não significa injeção. DEV
  recebe os contratos de resultado aplicáveis, no máximo uma operação estética
  e uma técnica contextual; REVIEW usa uma allowlist curta de revisão. QA usa
  um contrato independente da superfície: UI, design system, Back, DevOps,
  Cyber, Data, Research, Copy, autoria de QA ou runtime genérico quando nenhuma
  dessas lanes se aplica — nunca o método técnico/estético do DEV.
- **Entrega privada por receipt**: o plano é congelado por pane/fase/rodada,
  versão e fingerprint. O executor chama `activate_skill(receiptId)` e só então
  o pacote é materializado numa raiz efêmera da sessão, fora do projeto e fora
  das pastas autodetectadas por Claude/Codex. Uma skill do DEV não aparece no
  QA; o boot e o encerramento varrem sobras de sessões interrompidas. Scripts,
  referências, templates e assets relativos continuam disponíveis quando o
  playbook selecionado os permite.
- **Conclusão rastreável**: `report` exige os receipts obrigatórios ativados e
  declarados em `skillApplications`. Isso prova seleção, entrega do conteúdo e
  declaração; não prova qualidade. O QA independente decide o resultado.
- **Busca limitada**: `list_skills` exige contexto (`query`, função ou tipo) e
  devolve no máximo vinte itens. O catálogo inteiro nunca entra no prompt.
- **Escolha explícita**: cards e ajudantes aceitam no máximo uma técnica
  concreta e um especialista. Direções estéticas alternativas não são
  empilhadas; UI usa `synkora-frontend-standard` + exatamente um método visual:
  uma operação Impeccable para produto/telas ou
  `synkora-design-system-standard` para criação/evolução sistêmica. Subagentes
  nascem por `delegate.agent`, sem descoberta global.
- **Git nunca vê o runtime**: `.synkora/` e as antigas roots gerenciadas de
  skills permanecem no `info/exclude`; arquivos locais divergentes nunca são
  podados ou sobrescritos pelo Synkora.

## Roteamento de ajudantes e personas

A autoridade de **necessidade** é o orquestrador. Todo card novo nasce com
`delegation="none"` ou `delegation="parallel"`; `optional` existe somente para
compatibilidade com cards antigos. `none` bloqueia a abertura de ajudantes.
`parallel` exige dois ou mais blocos longos, independentes e de baixa
sobreposição, e o DEV não consegue concluir a rodada até ao menos um ajudante
ter reportado e sido integrado.

Depois dessa decisão, um roteador fechado cruza função, texto real do card,
instalação e capacidades do pane. Ele pode escolher **no máximo uma** das 56
personas nativas quando há aderência forte; palavra genérica não fabrica um
especialista. A persona ocupa um único ajudante da rodada. Se houver outros
blocos paralelos, eles nascem genéricos. FAST abre zero ajudantes; STANDARD
permite até dois simultâneos; DEEP, até quatro.

O DEV continua responsável pela execução: chama `delegate`, delimita o bloco,
supervisiona, lê a entrega e integra o resultado no mesmo worktree. Ele não
decide unilateralmente que um card `none` precisava de paralelismo e não troca
a persona roteada. Se surgir evidência nova, notifica o Maestro; o Maestro
altera quests+delegation antes do spawn. A conclusão fica ligada à `phaseRun`:
o backend exige o helper e, quando houver, a persona exata; o card mostra
planejada → concluída junto do plano efetivo.

As 56 personas app-owned são reparadas no boot sem rede, mas não entram no
prompt nem na descoberta global. Só o especialista escolhido para aquela
rodada recebe sua persona privada. Ter uma biblioteca grande, portanto, não
significa empilhar subagentes nem aumentar o contexto de cada executor.

## Curadoria FRONT (rodada 1) — 30 skills instaláveis

★ = candidata histórica a `defaultFor`; o roteador atual ainda escolhe no
máximo uma técnica contextual e pode não usar nenhuma. Oficial = mantida pelo
autor real da lib/plataforma.

| Ocasião | Skill (id) | Fonte | Nota |
|---|---|---|---|
| Direção estética | ★ `frontend-design` | anthropics/skills (oficial) | A mais instalada do mercado (~718k); baseline anti-genérico, leve |
| Direção estética | `design-taste-frontend` | Leonxlnx/taste-skill | Rulebook anti-slop com dials + pre-flight de 68 itens |
| Direção estética | `high-end-visual-design` | Leonxlnx/taste-skill (`skills/soft-skill`) | Estética premium |
| Direção estética | `minimalist-ui` | Leonxlnx/taste-skill (`skills/minimalist-skill`) | Linguagem minimalista |
| Polish/micro | ★ `better-ui` | jakubkrehel/skills | Valores exatos (press scale, springs, focus ring) |
| Polish/micro | `baseline-ui` | ibelick/ui-skills | 27 restrições "deslop" — passada barata |
| Polish (sistema) | `impeccable` | pbakaus/impeccable | Design-ops: 23 comandos + 60 detectores determinísticos (precisa Node) |
| Layout/espaçamento | ★ `better-layout` | jakubkrehel/skills | Escalas de spacing, hierarquia, container queries |
| Tipografia | `better-typography` | jakubkrehel/skills | Line-height por uso, measure, text-wrap balance |
| Cor/tokens | `better-colors` | jakubkrehel/skills | OKLCH ponta a ponta, APCA/WCAG, P3, Tailwind v4 |
| Acessibilidade | `better-accessibility` | jakubkrehel/skills | Keyboard-first → screen reader, limiares concretos |
| Microcopy | `better-writing` | jakubkrehel/skills | Copy de interface (botões, erros, empty states) — também na função copy |
| Review de interface | `better-interface` | jakubkrehel/skills | Router das 6 irmãs (requires instala junto); evidência file:line |
| Review de drift | `improve-ui` | ibelick/ui-skills | Auditoria read-only com prova tripla; entrega planos |
| Animação | `emil-design-eng` | emilkowalski/skills (autor real) | Filosofia de motion do Emil Kowalski (sonner/vaul) |
| Animação | `vercel-react-view-transitions` | vercel-labs/agent-skills (oficial) | View Transitions API no React |
| Animação (perf) | `fixing-motion-performance` | ibelick/ui-skills | Conserto de jank: compositor-only, FLIP, scroll-timeline |
| Animação (GSAP) | `gsap-core` / `gsap-react` | greensock/gsap-skills (oficial) | API correta; useGSAP/cleanup/SSR |
| React/perf | `vercel-react-best-practices` | vercel-labs/agent-skills (oficial) | 70 regras priorizadas por impacto |
| React/arquitetura | `vercel-composition-patterns` | vercel-labs/agent-skills (oficial) | Compound components, React 19 |
| Performance web | `core-web-vitals` | addyosmani/web-quality-skills | LCP/CLS/INP com disciplina de medição |
| Design system | `create-design-md` | ibelick/ui-skills | Extrai DESIGN.md de repo/URL — par do `.synkora/DESIGN.md` (★ em design) |
| Design system | `tailwind-design-system` | wshobson/agents | Tokens OKLCH em Tailwind v4 CSS-first |
| Componentes | `shadcn` | shadcn-ui/ui (oficial) | Opera o CLI/registry do jeito certo |
| Mobile | `vercel-react-native-skills` | vercel-labs/agent-skills (oficial) | 32 regras RN de performance |
| Mobile | `expo-router` / `expo-native-ui` / `expo-data-fetching` / `expo-tailwind-setup` | expo/skills (oficial) | Navegação, HIG nativo, dados, NativeWind v5 |
| Imagem→código | `image-to-code` | Leonxlnx/taste-skill (`skills/image-to-code-skill`) | Mockup/screenshot → implementação (exige visão) |

## Ficou de FORA (e por quê — não reavaliar sem motivo novo)

- **web-design-guidelines (Vercel)**: o SKILL.md é casca que baixa o ruleset
  remoto SEM PIN em runtime — as instruções executadas podem mudar upstream a
  qualquer momento (superfície de supply-chain). Contra a filosofia de versão
  pinada da biblioteca.
- **ui-ux-pro-max** (~290k installs, 111k★): substância existe (retrieval BM25
  offline), mas depende de Python no runner, o autor é anônimo com perfil de
  growth-hacking, e o estilo "de catálogo" briga com o DESIGN SYSTEM IS LAW.
- **frontend-ui-engineering (addyosmani/agent-skills)**: referência MORTA no
  corpo (`references/accessibility-checklist.md` não existe no repo).
- **web-quality-audit (addyosmani)**: router com links `../` para as irmãs —
  quebra em instalação single-folder. O standalone `core-web-vitals` entrou.
- **accessibility (addyosmani)**: standalone ok, mas o nome genérico colide
  conceitualmente com `better-accessibility` (vencedora do gênero).
- **taste-design / design-md (google-labs-code/stitch-skills)**: acoplados ao
  Stitch MCP. O `shadcn-ui` do mesmo repo é standalone, mas o oficial
  `shadcn` (shadcn-ui/ui) vence.
- **extract-design-system (arvindrk)**: pesado (npx + Chromium) e sobrepõe o
  `create-design-md`.
- **higgsfield-ai/skills**: 6 de 7 são geração de mídia p/ marketing; a de
  websites exige CLI+créditos próprios e faz deploy direto em produção.
- **webapp-testing (anthropics)**: excelente como loop autônomo de
  Python+Playwright, mas disputa ciclo de servidor/browser com o harness do
  Synkora. Fica `manualOnly`; não é fallback do QA autoral.
- **mattpocock/skills e obra/superpowers**: metodologia de processo (grill,
  tdd, plans) — zero skills de front; candidatas às rodadas de PM/back/qa.
- **hyperframes/remotion/humanizer**: nichos reais (vídeo, copy) — entram nas
  rodadas das funções deles se fizer sentido.

## Lições de sonda (2026-07-29 — não redescobrir)

- BOM em SKILL.md = "missing YAML frontmatter" nos dois CLIs (PowerShell
  `-Encoding utf8` no PS 5.1 grava BOM; o instalador escreve via Node).
- O handshake initialize do claude LISTA as skills como comandos (com sufixo
  `(user)`/`(project)` na descrição) — dá para validar instalação sem custo.
- Codex: `skills/list {cwds}` via app-server; erros de parse vêm no campo
  `errors` — ótimo para diagnóstico.
- 5 fontes têm pasta upstream ≠ frontmatter name (taste-skill ×4, vercel ×4
  com prefixo `vercel-`) — SEMPRE instalar com pasta = name.
- Claude: o comando vem do NOME DA PASTA; o watcher de skills exige a pasta
  `skills/` existir no boot do pane (a injeção acontece antes do spawn — ok).

## Curadoria de SUBAGENTES front (rodada 2 — 2026-07-29)

★ = defaultFor de front. Todos verificados na fonte (frontmatter name == id,
sem BOM; 4 core requests para validar os 4 repos).

| Papel | Subagente (id) | Fonte | Nota |
|---|---|---|---|
| Review de design com browser | `design-review` | OneRedOak/claude-code-workflows | O CANÔNICO (viral 2025): 7 fases via Playwright, viewports, WCAG AA, triage com screenshots. Repo congelado = "adotado e estável" |
| Cético visual | ★ `ui-visual-validator` | wshobson/agents | Validação adversarial de evidência visual ("não atingido até provado"), checklist de 13 itens |
| Auditoria a11y | `accessibility-expert` | wshobson/agents | WCAG 2.1/2.2 por critério + APG + AT real, remediação priorizada |
| Tailwind | `tailwind-frontend-expert` | vijaythecoder/awesome-claude-agents (`agents/universal/tailwind-css-expert.md` — pasta ≠ name) | Único Tailwind v4-aware com workflow e checklist numérico |
| Mobile Expo/RN | `expo-react-native-expert` | VoltAgent/awesome-claude-code-subagents | A exceção de qualidade da coleção (SDK 52+, sem "context-manager") |

**Meta — criação de agentes (a fonte oficial, instalável):** skill
`agent-development` + agent `agent-creator` (anthropics/claude-code,
plugins/plugin-dev/…) — é o system prompt de PRODUÇÃO do gerador do próprio
Claude Code, com 4 arquétipos, guia de descriptions e `validate-agent.sh`.
Licença Anthropic Commercial ToS: uso com Claude Code ok; NUNCA redistribuir
o conteúdo. Runner-up: meta-agent do disler (sem licença, tools datadas).

**+10 SUBAGENTES IN-HOUSE do Synkora** (`src/main/agentsBundled.ts`, campo
`bundledBody` — instalam sem rede, sem update; criados com a metodologia
oficial: description "Use this agent when… Trigger PROACTIVELY… Not for…",
responsabilidade única, tools mínimas, workflow numerado, hard rules com
VALORES, output em PT-BR, forbidden behaviors): `css-surgeon`,
`motion-choreographer`, `design-token-guardian` (★ front),
`responsive-auditor` (playwright), `component-architect`,
`microcopy-reviewer`, `web-perf-auditor` (playwright),
`form-ux-specialist`, `svg-icon-specialist`, `dataviz-frontend`.
TOTAL front: 16 subagentes (5 mercado + 10 in-house + agent-creator) e 31
skills — metas do usuário (≥15 / ≥30) atendidas. Refinamento futuro: rodar
o `agent-creator` para enriquecer as descriptions dos in-house com os blocos
<example> completos do formato oficial.

**Descartes de agents (não reavaliar sem fato novo):** VoltAgent em geral
(frontend-developer/ui-ux-tester exigem um "context-manager" que não existe no
Claude Code puro; ui-ux-tester declara tools fictícias `chrome-mcp`); wshobson
ui-designer/frontend-developer (inventário genérico, nomes prefixados feios,
redundante com o dev do card + skills Vercel); vijaythecoder frontend-developer
(frontmatter QUEBRADO); zhsama e hesreallyhim (SEM licença — bloqueia a
biblioteca); iannuttall (repo arquivado); dl-ezo (morto, sem licença). NENHUM
autor de skill curada embarca subagente instalável (os `agents/` dentro das
skills são `openai.yaml` de metadados, não personas).

## Subagentes (rodada 2 — mecânica implementada 2026-07-29)

Mesmo motor (`kind: 'agent'`), fonte = UM arquivo .md (vira `lib/<id>/agent.md`;
o download valida frontmatter `name` == id). Sondado em binário real: claude
resolve `.claude/agents/*.md` (project) e `<CLAUDE_CONFIG_DIR>/agents/*.md`
(user) — ambos aparecem no campo `agents` do handshake; codex NÃO tem
subagente nativo. Dois modos:

- **Por card** (`create_tasks.agents`, no máximo um): o plano anuncia o id ao
  dev, que o abre por `delegate.agent` somente se o subproblema independente
  realmente existir. Nenhum arquivo vai para a descoberta compartilhada do CLI.
- **Por ajudante** (`delegate.agent`, um id): o ajudante NASCE como o
  especialista — claude via `--append-system-prompt` com o corpo do
  agent.md; codex via `-c developer_instructions` (persona no spawn).

O conselho de delegação do orquestrador/PM agora diz por ajudante:
`agent: <id>` ou `agent: nenhum (generalista)` — decisão do usuário.
`list_skills` unificou skills e subagentes (`tipo: skill|subagente`).

## Curadoria BACK + DEVOPS (rodada 3, 2026-07-29) — 39 skills

Mesmo processo da front: 3 agentes de varredura em paralelo (coleções
conhecidas · descoberta ampla/vendors · subagentes), TODO SKILL.md aberto na
fonte, path + frontmatter `name` + branch + LICENSE conferidos. devops→back
(roteamento do app). ★ = `defaultFor` de back.

| Ocasião | Skill (id) | Fonte | Nota |
|---|---|---|---|
| Metodologia | ★ `test-driven-development` | obra/superpowers | O TDD mais completo do mercado; "se não viu o teste falhar, não sabe o que ele testa" |
| Metodologia | `tdd` | mattpocock/skills (`skills/engineering/tdd`) | TDD enxuto por seams — opção barata por card |
| Metodologia | ★ `verification-before-completion` | obra/superpowers | Rodar a verificação FRESCA antes de declarar pronto — a falha nº 1 de executor |
| Metodologia | `receiving-code-review` | obra/superpowers | Reagir a review com rigor (proíbe concordância performática) — casa com reprovação de gate |
| Metodologia | `resolving-merge-conflicts` | mattpocock/skills | Preservar a INTENÇÃO dos dois lados — o cenário dos merges de worktree |
| Arquitetura | `codebase-design` | mattpocock/skills | Módulos profundos, seams, deletion test — a melhor de arquitetura |
| Arquitetura | `domain-modeling` | mattpocock/skills | Glossário, stress-test de relações, ADRs |
| Arquitetura | `architecture-patterns` | wshobson/agents | Clean/Hexagonal/DDD com regras de dependência e troubleshooting real |
| Debugging | `diagnosing-bugs` | mattpocock/skills | Feedback loop apertado ANTES de hipóteses; 6 fases |
| Debugging | `systematic-debugging` | obra/superpowers | 4 fases; proíbe guess-and-check |
| Debugging | `debugging-code` | AlmogBaku/debug-skill (ref `master`) | Debugger REAL via DAP (breakpoints/stepping); exige CLI `dap` + adapters |
| API & serviços | `api-design-principles` | wshobson/agents | REST/GraphQL central: semântica HTTP, versionamento, N+1 |
| API & serviços | `nodejs-backend-patterns` | wshobson/agents | ~2k linhas de código real nas references (camadas, middleware, pooling) |
| API & serviços | `node` | mcollina/skills | Node runtime pelo Matteo Collina (Fastify/Node TSC) |
| API & serviços | `fastify-best-practices` | mcollina/skills (`skills/fastify` — pasta ≠ name) | Pelo criador do framework |
| API & serviços | `nestjs-expert` | Jeffallan/claude-skills | NestJS estruturado (única colhida da coleção de 66 — garimpar depois) |
| API & serviços | `mcp-builder` | anthropics/skills (Apache-2.0 POR SKILL) | Oficial: servidores MCP em 4 fases |
| API & serviços | `temporal-developer` | temporalio/skill-temporal-developer (SKILL.md na RAIZ, path `''`) | Durable execution/saga oficial, 7 SDKs |
| API & serviços | `stripe-best-practices` | stripe/ai (oficial) | Pagamentos: seleção de API, webhooks, keys |
| API & serviços | `workers-best-practices` | cloudflare/skills (oficial) | 40+ regras de Workers/edge |
| Auth & segurança | `oauth` | mcollina/skills | OAuth 2.0/2.1 por RFC: PKCE, refresh rotation, JWT |
| Auth & segurança | `security-best-practices` | openai/skills (`skills/.curated/…`, Apache-2.0 por skill, repo deprecated) | Secure-by-default por stack — a forte de segurança de API |
| Auth & segurança | `owasp-security` | agamm/claude-code-owasp (`.claude/skills/…`) | OWASP Top 10:2025 + ASVS 5.0; unsafe/safe em 20+ linguagens |
| Auth & segurança | `secrets-management` | wshobson/agents | Vault, secret stores de CI, rotação |
| TS & Python | `typescript-advanced-types` | wshobson/agents | Generics/conditional/mapped com código executável |
| TS & Python | `fastapi-templates` | wshobson/agents | FastAPI de produção com pytest+AsyncClient |
| TS & Python | `python-testing-patterns` | wshobson/agents | pytest: fixtures, mocking, freezegun |
| TS & Python | `async-python-patterns` | wshobson/agents | asyncio com tabela de decisão |
| TS & Python | `python-project-structure` | wshobson/agents | Layout, API pública, naming |
| Banco | ★ `supabase-postgres-best-practices` | supabase/agent-skills (oficial; ~314k installs) | O canônico de Postgres — vale fora do Supabase |
| Banco | `postgresql-table-design` | wshobson/agents (`…/skills/postgresql` — pasta ≠ name) | Schema com opinião: IDENTITY>UUID, FK não auto-indexada |
| Banco | `prisma-client-api` | prisma/skills (pastas na RAIZ do repo) | Referência oficial do client |
| Banco | `redis-core` | redis/agent-skills (oficial) | Estrutura certa + key naming (base de cache/filas) |
| Testes avançados | `property-based-testing` | trailofbits/skills (CC-BY-SA-4.0) | Árvore de decisão + catálogo de propriedades |
| DevOps | `deployment-pipeline-design` | wshobson/agents | Estágios, gates, canary, migração backward-compatible |
| DevOps | `github-actions-templates` | wshobson/agents | 4 workflows YAML completos + trivy |
| DevOps | `terraform-style-guide` | hashicorp/agent-skills (oficial, MPL-2.0; path profundo `terraform/code-generation/skills/…`) | Convenções oficiais de HCL |
| DevOps | `terraform-skill` | antonbabenko/terraform-skill (ref `master`) | Operacional sintoma→referência (AWS Hero) |
| DevOps | `slo-implementation` | wshobson/agents | PromQL real, error budget, multi-window alerts |

### Subagentes BACK — 9 de mercado + 7 in-house = 16

Mercado (frontmatter name == id validado; tools reais): `pragmatic-code-review`
(OneRedOak, irmão do design-review — checklist 7 categorias + triage),
`silent-failure-hunter` / `pr-test-analyzer` / `code-architect`
(anthropics/claude-code, plugins pr-review-toolkit e feature-dev — os corpos
mais bem escritos da rodada; MESMA licença Anthropic Commercial ToS do
agent-creator: usar com Claude Code ok, nunca redistribuir; o
silent-failure-hunter tem leak de convenções internas do repo na seção final —
inofensivo, anotado no summary), `api-architect` / `backend-developer` /
`performance-optimizer` (vijaythecoder — contratos OpenAPI/RFC 9457, generalista
com stack-detection, perf measure-first ≥2x), `incident-responder` (wshobson —
a exceção com SLAs P0–P3 duros), `debugger` (lst97 — 3 fases, fix em diff; o
único da coleção sem a maquinaria "Context Manager").

In-house (`agentsBundled.ts`, bundledBody; espaço negativo confirmado vazio no
mercado): ★ `backend-reality-checker` (o par do ui-visual-validator: claim
falso até comando FRESCO provar), `sql-query-surgeon` (EXPLAIN antes/depois
obrigatório), `migration-surgeon` (expand→migrate→contract, locks mapeados,
CONCURRENTLY, batches), `api-contract-guardian` (diff de superfície,
BREAKING/compatível, expand-contract), `container-optimizer` (multi-stage,
cache por ordem de layers, non-root, números antes/depois), `ci-doctor`
(log-first, flaky vs real, cache por hash de lockfile),
`observability-instrumentor` (níveis com critério, zero PII, cardinalidade
bounded).

### Decisões históricas da rodada back

- **Conflito com o pipeline do app** (decisão original, superada em
  2026-07-31): as skills Superpowers abaixo passaram a existir na biblioteca.
  As que tentam controlar worktree, execução, revisão ou merge ficam
  `manualOnly`; assim podem ser escolhidas explicitamente sem disputar o ciclo
  nativo do Synkora. `dispatching-parallel-agents` é segura na injeção
  automática. `writing-plans` pertence ao catálogo manual de planejamento e
  não acompanha Maestro/PM.
- **Referência morta**: `grill-with-docs` e `improve-codebase-architecture`
  (mattpocock) invocam `/grilling`, que NÃO existe no repo.
- **Casca**: `implement` (mattpocock, 75 palavras que só invocam as irmãs).
- **Slot já coberto**: `requesting-code-review` também foi adicionada em
  2026-07-31 como `manualOnly` (o gate nativo continua autoritativo);
  `microservices-patterns` (raso;
  architecture-patterns+temporal cobrem), `prometheus-configuration` (listicle;
  slo-implementation cobre), `terraform-module-library` (2 de Terraform já),
  `k8s-manifest-generator`/`helm-chart-scaffolding` (checklists rasos — K8s
  entra sob demanda via skill custom).
- **curl|bash sem pin**: `sentry` (openai) instala CLI remoto no runtime —
  rejeição automática (pior que ruleset sem pin).
- **Peso/contexto**: `claude-api` (anthropics) — SKILL.md de ~18k palavras
  entra INTEIRO no contexto ao invocar + risco no teto de 200 arquivos; sob
  demanda por URL quando um projeto integrar a API.
- **Vendor sob demanda** (bons, adicionar por URL quando o projeto usar):
  `neon-postgres` (metade plataforma), `auth0` (oauth genérico cobre),
  `mongodb-schema-design` (oficial ok; mainstream atual é Postgres),
  `cloud-run-basics`/família GCP (google/skills, 15k★), deploys por
  plataforma do openai/.curated, `deploy-to-vercel`/`vercel-cli-with-tokens`/
  `vercel-optimize` (paths `/mnt/` do sandbox claude.ai + conta), `use-railway`
  (description induz fluxo de signup — flag), `encore-*` (nicho; pasta≠name em
  todo o repo), `aws-cdk-development` (acoplado a MCPs AWS), duckdb/clickhouse
  → rodada DATA, `gh-fix-ci` (exige gh autenticado; repo deprecated).
- **SEM LICENÇA** (bloqueia; re-checar se mudarem): triggerdotdev/skills,
  better-auth/skills, contains-studio/agents (agents).
- **Agents rejeitados**: VoltAgent backend INTEIRA (26 corpos: "Query context
  manager" — SEM HÍFEN, grep por `context-manager` dá falso negativo — + JSON
  `requesting_agent` + métricas fabricadas); wshobson inventário-class (20/24
  sondados com zero valores/proibições; muitos `name:` PREFIXADOS pelo plugin,
  ex. `backend-development-backend-architect`); `code-reviewer` da Anthropic
  (excelente rubrica de confiança ≥80, mas redundante com pragmatic-code-review
  no mesmo slot); `code-reviewer` do vijay (delega a agentes inexistentes);
  `django-orm-expert` (nicho+context7); lst97 `backend-architect` (near-miss:
  description exige Context Manager); 0xfurai (model PINADO
  `claude-sonnet-4-20250514` — a armadilha de modelo datado);
  stretchcloud/davepoon/rshah515 (stubs/gerado em massa/ASCII decorativo);
  EveryInc compound-engineering (os 17 reviewers viraram SKILLS na v3 —
  candidatos à biblioteca de skills numa rodada futura, não de agents).

### Lições novas da rodada 3 (não redescobrir)

- anthropics/skills e openai/skills licenciam POR SKILL (`LICENSE.txt` DENTRO
  da pasta — Apache-2.0 conferido em mcp-builder/claude-api/
  security-best-practices/gh-fix-ci); os repos NÃO têm licença global.
- openai/skills está DEPRECATED e as skills moram em `skills/.curated/<nome>`
  (dotfolder no path — funciona no installer; updater nunca verá mudança).
- Pasta ≠ name novos: `postgresql`→`postgresql-table-design`,
  `fastify`→`fastify-best-practices`; prisma/skills tem pastas na RAIZ;
  temporal tem SKILL.md na RAIZ (installer suporta `path: ''`);
  hashicorp usa `terraform/<área>/skills/<nome>`.
- wshobson REORGANIZOU em plugins e PREFIXOU o `name:` de muitos agents
  (`error-debugging-debugger`) — validar name sempre; os 2 agents do front
  mudaram de PASTA na reorganização (paths do catálogo já apontam os novos).
- mattpocock reorganizou: skills em `skills/engineering/<nome>`.
- Licenças não-MIT aceitas: MPL-2.0 (hashicorp), CC-BY-SA-4.0 (trailofbits —
  atenção só em redistribuição modificada), Apache-2.0, Anthropic Commercial
  ToS (precedente agent-creator: instalar/usar ok, redistribuir nunca).

## Curadoria QA (rodada 4, 2026-07-29) — 31 skills (23 novas + 8 re-tags) e 18 subagentes

Mesmo processo (3 agentes de varredura + verificação minha das 3 últimas na
fonte). Esta rodada estreia as RE-TAGS: skills/agents das rodadas anteriores
que servem ao GATE ganharam 'qa' nos depts — better-interface, improve-ui,
better-accessibility, core-web-vitals (front) e systematic-debugging,
property-based-testing, python-testing-patterns, verification-before-completion
(back); agents design-review, ui-visual-validator, accessibility-expert (front)
e pragmatic-code-review, pr-test-analyzer, silent-failure-hunter (back).
★ = `defaultFor` de qa.

| Ocasião | Skill (id) | Fonte | Nota |
|---|---|---|---|
| Review (gate) | ★ `code-review` | mattpocock/skills | O motor: 2 eixos paralelos (Standards com smells de Fowler × fidelidade à Spec) |
| Review (gate) | ★ `code-review-and-quality` | addyosmani/agent-skills | A rubrica: 5 eixos, severidade Critical/Nit/FYI, red flags de processo |
| Review (gate) | `ce-code-review` | EveryInc/compound-engineering-plugin | O pipeline: personas selecionadas por risco do diff (evolução dos 17 reviewers da Every), schema JSON, P0–P3 |
| Teste ao vivo | `webapp-testing` (`manualOnly`) | anthropics/skills (Apache-2.0 por skill) | Loop de QA oficial: Python+Playwright com gestão própria de servidores; não entra no roteamento automático |
| Teste ao vivo | `playwright-cli` | microsoft/playwright-cli (oficial; ~102k installs) | 40+ comandos de browser via CLI, 9 docs de referência |
| Teste ao vivo | `playwright-best-practices` | currents-dev (pasta na RAIZ; ~66k) | 57 docs em 8 áreas: flaky, visual, a11y, POM, CI |
| Teste ao vivo | `exploratory-testing` | petrkindlmann/qa-skills | SBTM operacionalizado: charters, sessões time-boxed, 7 oráculos |
| Autoria | `vitest` | antfu/skills (lead do Vitest) | Referência 5.x: mocking, snapshots, coverage, fixtures |
| Autoria | `api-testing` | petrkindlmann/qa-skills | APIRequestContext/Supertest + Zod/AJV, CRUD, paginação |
| Autoria | `contract-testing` | petrkindlmann/qa-skills | Pact-JS v16 + alternativa schema-first — neutro de plataforma |
| Autoria | `visual-testing` | petrkindlmann/qa-skills | toHaveScreenshot vs serviços, máscaras, baselines em Docker |
| Autoria | `cypress-author` / `cypress-explain` | cypress-io/ai-toolkit (oficial) | Criar/consertar e revisar-sem-editar |
| Saúde da suíte | `test-reliability` | petrkindlmann/qa-skills | A melhor de flaky: 7 categorias com decision tree, quarentena, confiança |
| Saúde da suíte | `selector-drift-recovery` | petrkindlmann/qa-skills | Recuperação em LOTE de seletores: rubrica 0–5, aplica só ≥3, PR com evidência |
| Saúde da suíte | `coverage-analysis` | petrkindlmann/qa-skills | Ratchet, diff por PR, "meaningful vs vanity coverage" |
| Saúde da suíte | `mutation-testing` | secondsky/claude-skills | Stryker (TS/JS) + mutmut (Python) — venceu a da trailofbits (colisão de id; mewt não serve stack web) |
| A11y (gate) | `wcag-audit-patterns` | wshobson/agents | WCAG 2.2 por POUR, severidade 3 camadas, automação pega 30-50% |
| A11y (gate) | `screen-reader-testing` | wshobson/agents | NVDA/VoiceOver passo a passo — único no gênero |
| A11y (gate) | `accessibility-testing` | petrkindlmann/qa-skills | axe-core NA suíte + teclado + AT; thresholds concretos |
| Debug & regressão | `debugging-and-error-recovery` | addyosmani/agent-skills | 6 passos, triagem por camada, bisect — single-file, zero deps |
| Gate visual | `frontend-design-review` | microsoft/skills (`.github/skills/…`) | Review contra DS + 3 pilares — "quebrou a identidade = reprova" |
| Perf & carga | `k6` | grafana/skills (oficial) | Scripts k6 validados com k6 run; thresholds vs SLA |

### Subagentes QA — 3 mercado novos + 6 re-tags + 6 in-house + trio Playwright = 18

Novos de mercado: `comment-analyzer` (Anthropic — comment rot, report-only),
`code-review-preshipment` (wshobson — checklist de 10 seções com valores duros,
veredito SHIP/DO NOT SHIP; placeholders {{…}} degradam suave), `team-debugger`
(wshobson — UMA hipótese com critérios de falseamento definidos ANTES).

In-house (`agentsBundled.ts`): ★ `test-writer` (bateria padrão
vazio/borda/duplicado/permissão; prova que o teste PODE falhar),
`bug-reproducer` (repro mínima determinística — o teste falha antes do fix;
NOT-REPRODUCED é resultado válido), `regression-hunter` (raio de explosão
dirigido pela CAUSA, irmãos do bug, guard tests), `flaky-test-surgeon`
(mecanismo do flake por bisecção; retry nunca é cura; cura = N verdes + ainda
pega a quebra), `e2e-scenario-author` (usa o playwright MCP do pane; seletores
role>testid>texto; cenários independentes validados ao vivo),
`acceptance-verifier` (critérios do card item a item com evidência EXECUTADA).

**Trio oficial do Playwright** (decisão do usuário: "Vou querer!"):
`playwright-test-planner` / `playwright-test-generator` /
`playwright-test-healer` — seeds Apache-2.0 de microsoft/playwright traduzidas
para o loop claude (mapeamento do `init-agents --loop=claude`; corpo verbatim,
bundled). MOTOR: `mcpPaneArgs` agora injeta o MCP **`playwright-test`**
(`npx -y playwright run-test-mcp-server`) em pane de execução quando
`hasPlaywrightConfig(cwd)` (config na raiz OU dep @playwright/test) — claude
com o server nomeado `playwright-test` (o prefixo `mcp__playwright-test__*` é
o que o trio declara), codex com `playwright_test` (underscore: dotted key TOML
com hífen exigiria segmento quotado, não sondado). Wrapper
`userData/mcp/playwright-test.cmd`; `npx` resolve o playwright LOCAL do cwd.
Regenerar a tradução quando o Playwright atualizar as seeds.

### Ficou de FORA na rodada qa (não reavaliar sem fato novo)

- **Pendência de motor (qualidade ok, MCP errado)**: `web-perf` (cloudflare) e
  `browser-testing-with-devtools` (addyosmani) instruem o MCP
  `chrome-devtools`, que o app não injeta — candidatas a voltar se um dia o
  armPane oferecer esse server opcional.
- **Licença**: `wcag-audit` (CFLW-AI) — o MELHOR conteúdo de a11y (contraste
  programático + eval com ground-truth), mas SEM arquivo LICENSE (MIT só no
  rodapé do README); re-entra quando formalizarem. bruno-collections e
  darcyegb/ClaudeCodeAgents (o conceito "karen"/task-completion-validator
  inspirou o acceptance-verifier) idem — sem licença.
- **Referência morta**: `performance-optimization` (addyosmani) cita
  references/ que não existe. `triage` (mattpocock): scaffolding do repo dele.
- **Ids genéricos + ../**: `performance`, `best-practices`, `seo` (addyosmani
  web-quality — best-practices ainda linka a web-quality-audit REJEITADA).
- **Playwright redundante/acoplado**: `playwright` (openai — path $CODEX_HOME
  mente no nosso layout, repo deprecated), `playwright-interactive` (js_repl +
  danger-full-access), `agent-browser` (vercel, 593k installs — stub cujo
  conteúdo vem do CLI, não pinável), LambdaTest (40% vendor-bias).
- **Ecossistema ce-***: `ce-test-browser` (lsof não existe no Windows + driver
  próprio), `ce-debug` (amarrada às irmãs), `ce-proof` (API paga externa).
- **Nicho/slot**: pactflow (plataforma), testcontainers go/.NET (sob demanda),
  pypict (raiz + releases/ com binários), rampstackco, charlyautomatiza (k6
  oficial supera), PramodDutta (name com ESPAÇOS — viola a spec), tendera01
  (descriptions em alemão + refs fora da pasta), trailofbits
  testing-handbook ×15 (fuzzing/sanitizers → rodadas cyber/back).
- **Agents**: `code-reviewer` do pr-review-toolkit (2ª recusa — slot cheio, id
  genérico), `type-design-analyzer` (excelente, guardado para engordar back),
  `qa-expert` lst97 (entregáveis são documentos), `team-reviewer` (redundante),
  wshobson ship-mate qa/playwright/review (HARD-coupled ao pipeline do plugin
  deles — checklists mineradas para os in-house), `code-simplifier` (refactor +
  convenções do repo claude-code hardcoded), supatest/gensecaihq (livro-texto /
  template em massa).

### Lições novas da rodada 4

- EveryInc RENOMEOU o repo (`compound-engineering` → `compound-engineering-plugin`,
  o antigo dá 404) e os 17 reviewers viraram PERSONAS dentro de
  `ce-code-review/references/personas/` — não existem como agents standalone.
- wshobson prefixa o `name:` de ALGUMAS cópias por plugin e não de outras; os 3
  agents adotados nas rodadas passadas seguem com id limpo no HEAD (conferido).
  Sempre validar o name real antes de adotar.
- A doença VoltAgent aparece como "context manager" (DUAS palavras) — grep por
  `context-manager` dá falso negativo.
- microsoft/skills guarda tudo em `.github/skills/` (dot-folder no path).
- A busca do skills.sh é SPA (não renderiza server-side) — usar topic pages.
- A quota anônima da API do GitHub estava ZERADA durante a pesquisa e nada
  quebrou: raw + HTML não contam na quota (o desenho do instalador está certo).

## Curadoria DESIGN (rodada 5, 2026-07-29) — 33 skills (21 novas + 12 re-tags) e 15 subagentes

Re-tags desta rodada (a função design é dona natural): frontend-design (★
agora também de design), design-taste-frontend, high-end-visual-design,
minimalist-ui, create-design-md (★ — como anotado na rodada front),
tailwind-design-system, better-colors, better-typography, image-to-code,
impeccable, frontend-design-review; agents design-review,
design-token-guardian e svg-icon-specialist (via helper `AD`).
★ = `defaultFor` de design.

| Ocasião | Skill (id) | Fonte | Nota |
|---|---|---|---|
| Direção visual | `canvas-design` | anthropics/skills (Apache-2.0 por skill) | A skill de pôster/arte: design philosophy → artefato .png/.pdf; fontes empacotadas |
| Direção visual | `design-first-ui-prompting` | MengTo/Skills (3.9k★) | Meng To: trava layout primeiro, itera UMA variável por vez |
| Direção visual | `industrial-brutalist-ui` | Leonxlnx/taste-skill (`skills/brutalist-skill` — pasta ≠ name) | Swiss print × terminal militar — 3ª linguagem completa |
| Direção visual | `redesign-existing-projects` | Leonxlnx/taste-skill (`skills/redesign-skill` — pasta ≠ name) | Upgrade visual sem quebrar função, ordem de impacto |
| Direção visual | `algorithmic-art` | anthropics/skills | Arte generativa p5.js com seed reproduzível |
| Identidade | `brand-identity` | rampstackco/claude-skills | Sistema completo de identidade com stress-testing |
| Identidade | `logo-design` | rampstackco/claude-skills | 6–12 variantes por arquitetura, testadas em favicon/bordado/reverse |
| Identidade | `brandkit` | Leonxlnx/taste-skill | Brand boards via geração de imagem — casa com o generate_image |
| Identidade | `ai-graphic-design` | designrique (SKILL.md na RAIZ, path `''`) | O ofício de logo com IA por designer real: briefing, vetorização, IP |
| DS & theming | ★ `design-system-patterns` | wshobson/agents | Tokens primitive→semantic→component framework-agnóstico |
| DS & theming | `theme-factory` | anthropics/skills | 10 temas prontos + gerar tema novo no formato |
| Tipografia | `typography-audit` | mblode/agent-skills | 78 regras em 10 categorias com fix por achado |
| Mockups & imagem | `prototype` | emilkowalski/skills | 3–5 direções divergentes atrás de um picker (PICKER.md) |
| Mockups & imagem | `imagegen-frontend-web` / `imagegen-frontend-mobile` | Leonxlnx/taste-skill | Direção de imagem p/ referências web (1 por seção) e mobile (38 regras) |
| Mockups & imagem | `excalidraw` | Agents365-ai (`skills/excalidraw-skill` — pasta ≠ name) | NL → .excalidraw com paleta semântica; export Kroki = conteúdo sai da máquina (nota) |
| Motion | `motion-design` | LottieFiles/motion-design-skill (OFICIAL) | Princípios puros: Disney→UI, 4 arquétipos de personalidade |
| Motion | `apple-design` | emilkowalski/skills | Física fluid-interfaces da Apple com números |
| Motion | `find-animation-opportunities` / `review-animations` / `improve-animations` | emilkowalski/skills | Propor onde · revisar contra 10 padrões · planos p/ executores baratos |

### Subagentes DESIGN — 3 mercado + 3 re-tags + 9 in-house = 15

Mercado: `prompt-crafter` (wshobson/meigen, MIT, vendor-NEUTRO — o escritor de
prompts em lote para o generate_image), `ui-ux-designer` ★ (Madina Gbotoe via
davila7 — crítico com pesquisa citada, CC BY 4.0 com atribuição no arquivo),
`ascii-ui-mockup-generator` (davila7 — wireframes ASCII, terminal-native).

In-house (`agentsBundled.ts`, helper `D`): `image-asset-producer` (executor do
generate_image: prompt estruturado, valida OLHANDO o resultado, organiza os
arquivos; lições do banana e do molde meigen), `mockup-artist` (HTML estático
single-file em .synkora/mockups/, 2–3 direções, nunca lorem ipsum),
`brand-guardian` (extrai o brief REAL da marca do repo e audita superfícies —
nível acima do design-token-guardian), `svg-logo-producer` (geometria canônica
do luongnv89 MIT creditado; favicon 16px simplificado; 4 testes matadores),
`motion-director` (o vocabulário de motion do projeto gravado no DESIGN.md —
direção, nunca implementação), `design-brief-writer` (pedido vago → brief com
critérios de aceite CHECÁVEIS), `palette-composer` (rampas OKLCH → tokens
claro/escuro com TODOS os contrastes medidos), `ux-flow-mapper` (fluxos com
branches de falha FORÇADOS; becos e telas órfãs viram achados),
`favicon-og-producer` (kit completo com maskable safe-zone; o logo NUNCA é
regenerado por IA).

### Ficou de FORA na rodada design (não reavaliar sem fato novo)

- **SEM LICENÇA (re-checar se licenciarem)**: remotion-dev/skills — OFICIAL da
  Remotion e o melhor conteúdo de vídeo programático, mas sem LICENSE e
  auto-declarado "internal package"; coleam00/excalidraw-diagram-skill (4.3k★,
  o líder da categoria); figma/mcp-server-guide (regido pelos Figma Developer
  Terms, sem SPDX).
- **PENDÊNCIA FIGMA (uma decisão só)**: família figma-* da openai (licença =
  Figma Developer Terms proprietária/beta + refs `../` entre irmãs + exige
  Figma MCP que o `--strict-mcp-config` dos panes de execução EXCLUI),
  southleft/skills-for-figma (MIT, endossada pela Figma, mas depende da
  figma-use oficial + MCP), senlindesign/claude2figma, delight-audit. Se um
  dia o Synkora suportar seat com Figma MCP nos executores, reavaliar o
  pacote inteiro de uma vez.
- **Infra paralela de imagem**: `banana` (901★ — exige Google AI key + MCP
  próprio; a metodologia "creative director de prompt" foi absorvida pelo
  in-house image-asset-producer), fal genmedia (FAL_KEY + binário),
  meigen image-generator (tool pinada no MCP deles — virou o molde do nosso),
  `image` do marketingskills (50k installs; id genérico + é marketing → rodada
  copy/marketing).
- **Plataforma**: hyperframes/motion-graphics (Apache-2.0, conteúdo excelente
  — mas declara macOS/Linux apenas; sem Windows, sem entrada).
- **Acoplamento**: text-to-lottie (assume o repo clonado como workspace),
  design-tokens do plugin87 (refs fora da pasta + id genérico), brand-landingpage
  (Stitch SDK + key), stitch-skills inteiro (reestruturado em plugins/, segue
  100% Stitch; `stitch::extract-design-md` tem name com `::` — spec-inválido e
  FILENAME ILEGAL no Windows), ui-skills-root (CLI npx em runtime),
  zephyrwang6 (npx @latest em runtime), claude-to-figma (MCP de terceiro +
  plano pago), sleek (SaaS US$ 49,99/mês), lottie-animator (derivada da
  oficial), infographic (GPL-3.0 + slot de research/data), rive-interactive
  (implementação → front), brand-guidelines da Anthropic (carimbaria a MARCA
  DA ANTHROPIC nos projetos).
- **Agents**: wshobson design-system-architect e ui-ux-designer de
  multi-platform (inventário), gallery-researcher (acervo do vendor), lst97
  ui/ux-designer (MCPs magic/context7 + inventário), davila7 ui-designer e
  ux-researcher ("query context manager"), se-ux-ui-designer (port de chatmode
  Copilot com tools fictícias), screenshot-* (pipeline acoplado de 5),
  pptx-deck-creation-builder (qualidade real, escopo deck adjacente — se
  apresentações virarem função, reavaliar), trio luongnv89 (SEM frontmatter —
  base MIT dos nossos in-house), hyperframes director/builder (sem frontmatter
  + runtime próprio), aiagentskit (lavagem dos contains-studio com frontmatter
  inválido), NicholasSpisak (sem licença).

### Lições novas da rodada 5

- name com `::` (stitch) é DUPLAMENTE fatal: viola a spec e `:` é proibido em
  nome de arquivo no Windows — o mesmo veneno do paneId da F3.8.
- Vendors de design (Figma, Canva, Framer, Adobe, LottieFiles) publicam
  MCP + SKILLS; NENHUM publica subagente .md — o deserto confirma a cota
  in-house.
- `skills/*/agents/*.md` SEM frontmatter são agentes INTERNOS de skill
  (hyperframes, luongnv89, skill-creator) — checar o frontmatter antes de
  avaliar o conteúdo economiza a leitura.
- Coleções agregadoras (davila7) carregam licenças POR ARQUIVO (CC BY dentro
  de MIT) e ports de chatmode do Copilot — julgar arquivo a arquivo.
- Clones "relicenciados" do contains-studio (aiagentskit et al.): grep por
  brand-guardian/whimsy-injector detecta a linhagem.
- taste-skill agora soma 6 pastas ≠ name (brutalist, redesign, output, stitch,
  v1, gpt) — conferir SEMPRE o frontmatter da fonte.

## Curadoria RESEARCH (rodada 6, 2026-07-29) — 33 skills (32 novas + 1 re-tag) e 11 subagentes

ESCOPO definido pelo usuário no meio da rodada: pesquisa + DOCUMENTAÇÃO
(docs→research) + PLANEJAMENTO ("não é só pesquisa no cru — entra /grill-me
etc."). E a META FLEXIBILIZADA ("não precisa forçar 30") estreou aqui: as
SOBREPOSIÇÕES foram cortadas em vez de somadas (3 skills de spec → 2, 3 de
concorrência → 2, 2 de síntese → 1, 2 de changelog → 1, 2 de sizing → 1,
meta-triplicata → 1). Re-tag: domain-modeling (back→+research).

MOTOR ATUAL — o grupo `planejamento` conserva as opções externas como catálogo
`manualOnly`, mas elas nunca acompanham PM/orquestrador. O único método
automático e executável pelo Maestro é `synkora-planning-standard`; não existe
prioridade ou fallback externo. Se o standard faltar, a seleção fica vazia e o
fluxo deve falhar fechado, sem trocar silenciosamente de metodologia.

| Ocasião | Skill (id) | Fonte | Nota |
|---|---|---|---|
| Planejamento | `grilling` ⚙ | mattpocock/skills | EXISTE AGORA (a dead-ref da rodada back foi consertada upstream); interrogatório 1-pergunta-por-vez |
| Planejamento | `grill-me` ⚙ | mattpocock/skills (requires grilling) | O lançador que o usuário citou nominalmente |
| Planejamento | `grill-with-docs` | mattpocock/skills (requires grilling+domain-modeling) | Interrogatório gerando ADRs+glossário no caminho |
| Planejamento | `brainstorming` ⚙ | obra/superpowers | Socrático com gate duro; spec documentada (venceu o product-brainstorming oficial: deliverable > sparring) |
| Planejamento | `writing-plans` ⚙ | obra/superpowers | REAVALIADA: como deliverable de card não conflita com o create_plan do app |
| Planejamento | `to-tickets` ⚙ | mattpocock/skills | Fatias verticais "1 ticket = 1 janela de contexto"; modo local .md |
| Planejamento | `before-you-build` | wshobson/agents | Pre-mortem em 7 lentes de risco |
| Planejamento | `roadmap-planning` | rampstackco | Capacidade honesta 40–70% + lista "Not now" |
| Specs | `write-spec` | anthropics/knowledge-work-plugins (PM) | PRD oficial com anti-scope-creep (nome real — não "feature-spec") |
| Specs | `create-prd` | phuryn/pm-skills (24.6k★) | Template de 8 seções do Pawel Huryn |
| Specs | `requirement-writer` | DivikWu (path `.claude/skills/…`) | Descoberta guiada: Problem Framing → SRD → PRD com scoring |
| Specs | `feature-forge` / `spec-miner` | Jeffallan/claude-skills | Workshop EARS de requisitos · engenharia REVERSA de specs de legado |
| Specs | `ce-strategy` | EveryInc | STRATEGY.md por entrevista com pushback (Rumelt) |
| Pesquisa | ★ `research` | mattpocock/skills | Fontes PRIMÁRIAS, claim rastreado ao dono autoritativo |
| Pesquisa | ★ `deep-research` | daymade/claude-code-skills | P0–P7 com counter-review obrigatório; WebSearch/WebFetch NATIVOS (venceu a colisão de id com 199-biotech) |
| Pesquisa | `firecrawl-search` | firecrawl/cli (ISC; ~77k installs) | Key necessária; seção de "feedback por créditos" IGNORADA |
| Pesquisa | `web-search` | brave/brave-search-skills | REST puro + env token (id genérico anotado) |
| Pesquisa | `ce-pov` | EveryInc | Veredito de ADOÇÃO de lib/ferramenta com posição merecida |
| Pesquisa | `competitive-brief` | knowledge-work-plugins (PM) | COLISÃO no próprio repo: marketing/ tem gêmeo com o MESMO name — só este entra |
| Pesquisa | `competitors-analysis` | daymade | Concorrência POR CÓDIGO-FONTE (file:line) |
| Pesquisa | `market-sizing-analysis` | wshobson/agents | TAM/SAM/SOM triplo (venceu market-research do alirezarezvani — menor atrito) |
| Pesquisa | `synthesize-research` | knowledge-work-plugins (PM) | User research → findings ranqueados com confiança |
| Docs | `documentation` | knowledge-work-plugins (engineering) | 5 formatos oficiais (id genérico anotado) |
| Docs | `good-readme` | adewale/good-readme | 22 critérios + anti-drift verificado no código (dispensou o in-house readme-writer) |
| Docs | `agents-md` | getsentry/skills (oficial) | AGENTS.md/CLAUDE.md <60 linhas reference-backed |
| Docs | `code-documenter` | Jeffallan | Documentar código existente com exemplos VALIDADOS |
| Docs | `architecture-decision-records` | wshobson/agents | 5 templates de ADR + ciclo de vida (dispensou o in-house adr-writer) |
| Docs | `openapi-spec-generation` | wshobson/agents | OpenAPI 3.1 como documentação |
| Docs | `generate-changelog` | inprojectspl (SKILL.md na RAIZ, path `''`) | Keep a Changelog 1.1.0 com validador (venceu changelog-automation) |
| Docs | `ce-doc-review` | EveryInc | O gate de documentos: review multi-persona de specs/planos |
| Docs | `writing-skills` | obra/superpowers | Pré-existente; preservada, mas explicitamente excluída do novo lote Superpowers de 2026-07-31 |

⚙ = skill externa do grupo `planejamento`, preservada no catálogo como
`manualOnly` e nunca injetada no Maestro/PM · o único método automático é
`synkora-planning-standard` · ★ = candidata histórica a `defaultFor` de
research, sujeita ao roteamento contextual.

#### Lote Superpowers integrado em 2026-07-31

Foram auditadas e instaladas: `brainstorming`,
`dispatching-parallel-agents`, `executing-plans`,
`finishing-a-development-branch`, `receiving-code-review`,
`requesting-code-review`, `subagent-driven-development`,
`systematic-debugging`, `test-driven-development`, `using-git-worktrees`,
`using-superpowers`, `verification-before-completion` e `writing-plans`.
`writing-skills` ficou fora do lote por pedido explícito do usuário; uma cópia
pré-existente foi preservada.

As skills `executing-plans`, `finishing-a-development-branch`,
`requesting-code-review`, `subagent-driven-development`,
`using-git-worktrees` e `using-superpowers` são `manualOnly`. Elas aparecem na
biblioteca e podem ser escolhidas em um card/ajudante, mas não entram sozinhas
em uma execução, porque o Synkora já controla isolamento, gates e integração.

### Subagentes RESEARCH — 10 mercado + 1 in-house = 11

Mercado: `code-explorer` (Anthropic — mapa de codebase com file:line),
`documentation-generation-docs-architect` / `-api-documenter` /
`-tutorial-engineer` (wshobson — ATENÇÃO: prefixo de plugin por arquivo e
INCONSISTENTE; o docs-architect tem um GÊMEO com outro id em
code-documentation/), `search-specialist` e `startup-analyst` (nomes limpos),
`technical-researcher` ★ (o tech-evaluator vindo do mercado — rubricas fixas),
`fact-checker` (venceu a SKILL homônima do daymade na 1ª colisão skill×agent
da biblioteca), `competitive-intelligence-analyst`, `diagram-architect`.
In-house: `context-curator` (curador do .synkora/CONTEXT.md — edita
cirurgicamente com fonte por frase; Synkora-nativo). Os in-house planejados
adr-writer/readme-writer/tech-evaluator/api-documenter foram DISPENSADOS pelo
mercado — régua "não forçar" aplicada.

### Ficou de FORA na rodada research (não reavaliar sem fato novo)

- **LICENÇA PROPRIETÁRIA — NUNCA INSTALAR (vale para TODAS as rodadas)**: o
  quarteto `docx`/`pdf`/`pptx`/`xlsx` da anthropics/skills. Verbatim do
  LICENSE.txt: usuários "may not: Extract these materials from the Services or
  retain copies… Create derivative works… Distribute, sublicense, or
  transfer". O instalador retém cópia em userData e distribui por workspace =
  violação literal. O README confirma "source-available, not open source".
- **Licença ambígua**: `doc-coauthoring` (anthropics) — repo SEM LICENSE raiz
  (404 verificado 2×) e a pasta sem LICENSE.txt; só o blanket "many skills…
  are Apache 2.0" no README. Fora até grant explícito.
- **Sem licença**: adr-skill (skillrecordings — o melhor ADR-como-spec; issue
  vale a pena), exa-labs/agent-skills, readwiseio (oficiais recentes — monitorar).
- **curl|bash em runtime**: tavily (DENTRO do SKILL.md, 14.5k installs — a
  exceção mais frustrante da regra), microsoft-docs (fallback npx
  @microsoft/learn-cli).
- **Licenças restritivas**: deanpeters/Product-Manager-Skills (CC BY-NC-SA —
  provavelmente o melhor conteúdo PM do mercado, bloqueado para uso
  comercial), spec-to-repo do borghei (MIT + Commons Clause — conservadorismo
  jurídico), imbad0202 (CC BY-NC).
- **Sobreposição cortada (régua "não forçar")**: pm-spec-writing e
  discovery-research-synthesis (rampstack — write-spec/create-prd e
  synthesize-research cobrem), prd-write (3º de PRD), competitive-landscape
  (frameworks genéricos; o brief aplica), market-research (alirezarezvani),
  changelog-automation (wshobson), elimination-research (ce-pov cobre),
  product-brainstorming (obra brainstorming venceu), user-stories,
  writing-great-skills + skill-creator (meta-triplicata), the-fool (grilling+
  ce-pov cobrem), fact-checker SKILL (o agent venceu o id).
- **Acoplamento/fluxo**: to-spec e wayfinder (tracker do ecossistema
  mattpocock; o app tem PLAN.md/missões), handoff + ce-handoff (o app tem
  handoff nativo), ce-brainstorm/ce-plan/ce-ideate/ce-compound (pipeline
  ce-*), executing-plans (rejeição histórica; adicionada em 2026-07-31 como
  `manualOnly`), define-goal (tools exclusivas do
  harness Codex), notion-* (MIT da Notion Labs! mas dependência dura do
  Notion MCP — sob demanda), github-issue-creator (fraco; to-tickets cobre),
  hads (padrão inventado sem adoção), teach (tutoria pessoal), seo (metade
  copy + `../` confirmados de novo → decidir na rodada copy),
  fixing-metadata (é skill de EDITAR código → recomendada re-arquivar para
  front), kql (→ rodada data), internal-comms (→ rodada copy).
- **Agents**: lst97 api-documenter/documentation-expert (context7-locked),
  davila7 clones VoltAgent no deep-research-team (telemetria fake "94%
  confidence" — julgamento POR ARQUIVO naquela pasta), research-orchestrator/
  coordinator/brief-generator/query-clarifier (team-locked), nia-oracle/arch/
  docusaurus-expert, vijaythecoder documentation-specialist (delega a agente
  rejeitado), reference-builder/mermaid-expert (slots cobertos),
  academic-researcher/research-synthesizer/report-generator (nicho/pipeline).

### Lições novas da rodada 6

- A anthropics/skills NÃO tem licença de repo — cada pasta decide (Apache nas
  criativas, PROPRIETÁRIA nas de documento, AUSENTE na doc-coauthoring).
  Nunca assumir por vizinhança.
- Dead-refs upstream se CONSERTAM: /grilling nasceu depois da nossa rejeição —
  re-verificar rejeições por referência morta quando a fonte é ativa.
- Colisão skill×agent existe (fact-checker) — o id da biblioteca é GLOBAL
  entre kinds; e colisão dentro do MESMO repo também (competitive-brief ×2 no
  knowledge-work-plugins).
- wshobson: o prefixo de plugin no `name:` é POR ARQUIVO e inconsistente até
  dentro do mesmo plugin; o docs-architect existe 2× com ids diferentes.
- skills.sh: a busca é SPA e a API exige token — as páginas por-skill
  (`/{owner}/{repo}/{skill}`) rendem installs+audits.

## Curadoria COPY (rodada 7, 2026-07-29) — 34 skills novas + 2 re-tags e 14 subagentes

ESCOPO: UX writing/microcopy, voz do produto, marketing copy (landing/email/
social/ads), SEO content, naming, PR/crise e comms de stakeholder. Backbone =
`coreyhaines31/marketingskills` (MIT, 42k★ — 15 das 49 skills entraram; TODAS
as 22 avaliadas foram abertas na fonte) + rampstack + plugin `marketing/`
oficial da Anthropic (Apache-2.0 conferido no plugin). Re-tags: better-writing
(front→+copy, vira ★ de copy) e fact-checker (research→+copy — claims de
marketing). Deferrals da rodada 6 FECHADOS: internal-comms perdeu para
stakeholder-update; o `seo` (que era do addyosmani, não da openai) saiu como
OUT permanente; image/video do marketingskills ficaram fora (mídia é do
design: generate_image + image-asset-producer).

| Ocasião | Skill (id) | Fonte | Nota |
|---|---|---|---|
| Voz | `product-marketing` | coreyhaines31/marketingskills | Dossiê .agents/product-marketing.md que o kit corey inteiro lê — rodar PRIMEIRO |
| Voz | `brand-voice` | rampstackco | DEFINE o sistema de voz (X-não-Y, 8-15 tons, 15-25 pares) |
| Voz | `brand-review` | knowledge-work-plugins (marketing) | REVISA contra a voz: 7 eixos, severidade, antes/depois — o melhor revisor de tom do mercado |
| Voz | `marketing-psychology` | coreyhaines31 | ~60 modelos mentais de persuasão |
| Voz | `naming` | glacierphonk/naming (raiz, path '') | Único naming sério; guia PT; whois degrada p/ WebSearch no Windows |
| Voz | `founder-voice-ghostwriter` | BayramAnnakov (raiz, branch MASTER) | Ghostwriting de founder em 4 estágios |
| Microcopy | ★ `better-writing` | jakubkrehel (re-tag front→+copy) | O dia-a-dia da copy de UI num ADE |
| Microcopy | `ux-writing` | content-designer/ux-writing-skill (raiz; pasta ≠ name) | 2ª lente sistemática de microcopy (core do dept aceita 2 ângulos, como qa aceitou 3 de review) |
| Edição | `copy-editing` | coreyhaines31 | 7 passadas (clareza→zero-risco) |
| Edição | `editorial-qa` | rampstackco | O GATE pré-publicação (brief, voz, fatos, cara-de-IA) |
| Edição | ★ `humanizer` | blader/humanizer (raiz) | 32k★; 33 sinais de IA com guardas de falso positivo (installs reais: 3.1k — o "32k" era estrela) |
| Conversão | ★ `copywriting` | coreyhaines31 | 164k installs — princípios + frameworks por página + CTA |
| Conversão | `headline-matrix` | realkimbarrett/advertising-skills | 25 headlines × 7 ângulos (Schwartz); MIT por skill no frontmatter |
| Conversão | `schwartz-awareness-mapper` | realkimbarrett | Estágio de consciência → abordagem de mensagem; upstream é dica soft |
| Conversão | `landing-page-copy` | rampstackco | Estrutura de landing em 7 seções (venceu o onewave de 5.2k installs) |
| Conversão | `offers` | coreyhaines31 | Value equation, garantias, bonus stack — o que a página DIZ |
| Conversão | `competitors` | coreyhaines31 | Páginas vs/alternative públicas (não colide com competitive-brief interno) |
| Conteúdo | `content-strategy` | coreyhaines31 | Pilares/clusters/funil (gêmeos rampstack e kwp small-business ficaram fora) |
| Conteúdo | `content-brief` | inhouseseo/superseo-skills | Briefs de SERP AO VIVO, 23 tipos, sem APIs |
| Conteúdo | `write-content` | inhouseseo/superseo-skills | Artigo SEO completo anti-slop (Koray/Kyle Roof/Lily Ray) |
| Conteúdo | `ai-seo` | coreyhaines31 | AEO/GEO ~8k palavras: answer blocks, llms.txt, Princeton GEO |
| Conteúdo | `long-form-content-frameworks` | rampstackco | 7 formatos × 5 arquétipos — único de long-form |
| Conteúdo | `content-and-copy` | rampstackco | Editorial geral 5 dimensões (venceu a gêmea draft-content da kwp) |
| Email/social | `email-sequence` | knowledge-work-plugins (marketing) | Lifecycle com copy completa + branching (venceu emails/corey e email-sequences/rampstack) |
| Email/social | `cold-email` | coreyhaines31 | Outbound B2B (job distinto de lifecycle) |
| Email/social | `social` | coreyhaines31 | Playbooks por plataforma; curls de listening são opcionais |
| Email/social | `developer-newsletter` | jonathimer/devmarketing-skills | Newsletter dev 70-20-10 — o caso típico dos universos |
| Lançamento | `launch` | coreyhaines31 | ORB + 5 fases + Product Hunt; ref do Introw é decorativa |
| Lançamento | `ce-promote` | EveryInc | Promo do que JÁ shipou a partir de PRs/diffs. CAVEAT: disable-model-invocation — executor claude não auto-invoca (ler o SKILL.md/comando; codex ignora) |
| PR | `public-relations` | coreyhaines31 | Pitches com barra de 6 pontos + 4 modos (venceu press-release do realjaymes) |
| PR | `crisis-communications` | jamditis/claude-skills-journalism (branch MASTER, pasta aninhada) | Comms de incidente — holding statements, correções, escalada |
| Comms | `stakeholder-update` | knowledge-work-plugins (PM) | ACHADO da rodada: updates por audiência, green-yellow-red, ROAM — venceu internal-comms |
| Collateral | `sales-enablement` | coreyhaines31 | Decks com speaker notes, one-pagers, talk tracks |
| Collateral | `ad-creative` | coreyhaines31 | Ad copy ATERRADA (recusa gerar sem grounding); v2.8, a mais iterada do repo |
| Collateral | `aso` | coreyhaines31 | Copy de loja de app com contagem de caracteres por campo |

★ = `defaultFor` de copy (espelhado em departments.copy: better-writing +
humanizer + copywriting; agents: microcopy-surgeon).

### Subagentes COPY — 7 mercado + 6 in-house + 1 re-tag = 14

O mercado de agents de copy é maior do que se esperava (23 verificados IN na
varredura), mas majoritariamente 3.5-inventário: entraram só os ≥4 sem
sobreposição com skill instalada. Mercado: trio SEO do wshobson
(`seo-content-writer` com padrões mensuráveis, `seo-content-auditor`,
`seo-meta-optimizer` — names verbatim SEM prefixo de plugin desta vez) +
quarteto rshah515/claude-code-subagents (`copywriter-specialist` ~4,2k
palavras, `content-editor`, `email-copywriter` (tools firecrawl opcionais),
`social-content-creator` (declara playwright — os panes de execução já
injetam)). In-house (helper `C` em agentsBundled): ★`microcopy-surgeon` (o
gap nº 1 confirmado: NÃO existe agent de UX writing elegível no mercado),
`voice-guardian` (.synkora/VOICE.md — define/audita, paralelo do
brand-guardian do design), `terminology-guardian` (.synkora/GLOSSARY.md — um
conceito um termo, código intocável), `release-notes-writer` (git+BOARD+
entregas → notas por benefício em .synkora/reports/), `copy-localizer` (gap
confirmado: nada instalável de localização de copy no mercado; placeholders
validados mecanicamente), `conversion-copy-reviewer` (gate de landing
review-only, prova NUNCA inventada). Re-tag: `fact-checker`
(research→+copy). O 15º NÃO foi inventado — régua "não forçar" (precedente:
research fechou com 11).

### Ficou de FORA na rodada copy (não reavaliar sem fato novo)

- **Runtime-fetch**: vercel `writing-guidelines` (WebFetch de ruleset noutro
  repo, sem pin — mesma classe da web-design-guidelines da rodada front; e o
  name verbatim NÃO tem prefixo vercel-, ao contrário das 4 instaladas);
  `email-marketing-bible` (249★, POINTER SKILL: os 19 capítulos moram num
  site, não no repo).
- **`../` quebradas + escopo**: `seo` do addyosmani (refs a core-web-vitals e
  web-quality-audit quebram em instalação de pasta única; e é SEO técnico de
  implementação — front/back, não escrita). Deferral fechado.
- **Perdeu o slot**: internal-comms (Apache por pasta OK, 62k installs, mas é
  template pack "formats my company likes" — stakeholder-update 5/5 venceu);
  avoid-ai-writing 2.7k★ (59 categorias, MAS mesmo job do humanizer — 1 por
  job); generic-language-killer (humanizer+copy-editing cobrem);
  press-release do realjaymes (public-relations 4.5 cobre); seo-content-writer
  SKILL do Yaroslavle (write-content venceu); landing-page-copywriter onewave
  (rampstack venceu); ill-communication e newsroom-style (nicho);
  email-marketing KB (3 lanes de email bastavam); draft-content+
  content-creation (par interno da kwp; content-and-copy + especialistas
  cobrem); seo-audit corey×kwp (ai-seo cobre o lado content);
  programmatic-seo corey×rampstack (nicho growth); campaign-plan e
  performance-report da kwp (planejamento/analytics — performance-report
  anotada para a rodada DATA); ce-explain (acoplado a produtos Every);
  avatar-extraction (product-marketing cobre o slot de contexto de público).
- **corey OUT**: sms (compliance/ops US-centric, refs soft a tools/),
  lead-magnets (planejamento — o próprio texto delega a escrita à
  copywriting), video (APIs de vídeo + scaffolding Remotion), image (50k
  installs, mas mídia é do design: generate_image + image-asset-producer).
- **Licença/tamanho**: contains-studio marketing (SEM LICENSE; clones
  "relicenciados" tipo msitarzewski detectáveis por whimsy-injector),
  yoyothesheep (sem licença + deps Ahrefs), creative-director do smixs
  (CC-BY-4.0 mas 571 case cards > cap de 200 arquivos), angelarose210
  ghostwriter (../ entre as 4 pastas irmãs), OpenClaudia (derivativo do corey
  + APIs Resend/SemRush), boraoztunc (vendoring, proveniência suja),
  agregadores kursku/borghei/sickn33 (nunca instalar de agregador),
  webflow/better-i18n/seranking (MCP/plataforma), TribeAI brand-voice (7
  conectores MCP), AgriciDaniel claude-seo/claude-email (monólito de
  sub-skills, licença não verificada), tone-of-voice/brandvoice/
  analystacademy/humanize-text (fracas/0 adoção/ids genéricos colidindo).
- **Agents OUT**: content-marketer do wshobson (inventário aspiracional de 3k
  palavras) e os 7 seo-* de nota 3.5 (só os ≥4 entraram); VoltAgent
  content-marketer/seo-specialist (context-manager fictício + telemetria fake
  "+234% organic traffic") e content-quality-editor (TRAP REAL: manda
  `npm install -g unslop`, que no npm é um dedup de CÓDIGO não relacionado — o
  de prosa é o unslop do MohamedAbdallah-14 via pip; corpo de agent também
  passa por review de segurança); davila7 business-marketing (espelhos
  VoltAgent); social-publishing-publisher (SOCIALCLAW_API_KEY); vizra-ai
  (cards de 240-650 palavras); gtm-agents (cards de 165-240 palavras — o
  conhecimento mora nas skills do plugin) e seu content-strategist (colisão
  com o rshah515 homônimo — NENHUM entrou: estratégia é papel do orquestrador
  com a skill content-strategy); rshah515 brand-voice-designer/
  messaging-architect/seo-strategist/seo-expert/geo-strategist/pr-strategist
  (sobreposição com skills instaladas; geo-strategist anotado — a ai-seo
  cobre AEO); stretchcloud content-strategist (anunciado no README, o ARQUIVO
  NÃO EXISTE no repo).

### Lições novas da rodada 7

- **README ≠ TREE**: o realkimbarrett anuncia ~25 skills, a árvore tem ~13 —
  voice-of-customer-miner, landing-page-architect e email-sequence-architect
  SÓ existem no README. Nunca pinar pick sem abrir a árvore/raw (parente da
  lição do /grilling: lá a dead-ref se consertou depois; aqui nunca existiu).
  E o README do rshah515 descreve pastas que não existem (digital-marketing/)
  — os arquivos moram em marketing/ raiz.
- Nem todo wshobson prefixa o name: os 10 seo-* têm name verbatim = filename.
  A regra segue "conferir POR ARQUIVO", nos dois sentidos.
- Colisão skill×agent às vezes CONVIVE: seo-content-writer era skill
  (Yaroslavle, OUT) e agent (wshobson, IN) — só um lado entrou e o id ficou
  limpo; no 1º caso (fact-checker) os dois eram bons e exigiu escolha.
- POINTER SKILL é ruleset remoto com outra roupa: repo estrelado cujo
  conteúdo mora num site (email-marketing-bible) cai na mesma regra do pin.
- Instrução de instalação ERRADA dentro de agent .md é vetor real: o
  content-quality-editor manda instalar o pacote npm errado (unslop de
  código ≠ unslop de prosa) — revisar SEMPRE os comandos de install no corpo.
- `disable-model-invocation: true` numa skill instalada (ce-promote): o
  executor claude não a auto-invoca — o catálogo anota o caveat no summary
  para o orquestrador saber que o caminho é ler o SKILL.md; o codex ignora.
- Corey marca refs soft para `tools/` na RAIZ do repo (launch,
  sales-enablement, sms, ad-creative) — sempre opcionais, viram dead link em
  instalação de pasta única, metodologia intacta (o repo se anuncia
  individualmente instalável via npx skills add).

## Curadoria CYBER (rodada 8, 2026-07-30) — 48 skills + 15 subagentes novos

Três varreduras (ToB integral · coleções conhecidas · descoberta ampla; a
fatia vendors/descoberta rodou 2×, a 1ª leva de sub-agentes falhou muda e a
2ª entregou). NÚCLEO = **trailofbits/skills** (23 skills, CC-BY-SA-4.0 —
precedente property-based-testing; commits do PRÓPRIO dia; pasta=name em
100%; 30 agents no repo, 24 presos a orquestrador de pipeline). Kit ★ cyber:
`differential-review` + `insecure-defaults` + `security-testing` +
`owasp-security` (re-tag); agent ★ `sharp-edges-analyzer`.

| Ocasião | Skills | Fonte |
|---|---|---|
| Review de segurança | ★`differential-review`, `fp-check`, `vulnerability-triage-brocards`, `variant-analysis`, `audit-context-building`, `security-ownership-map` | trailofbits ×5 · openai (Apache POR skill, repo deprecated — pin salva) |
| Review de segurança | `security-reviewer` | Security-Phoenix (MIT) — venceu o homônimo do Jeffallan no id (7 guias por linguagem); path com ESPAÇOS no repo (encodeURIComponent cobre) |
| Threat modeling | `stride-analysis-patterns`, `attack-tree-construction`, `threat-mitigation-mapping`, `security-requirement-extraction` | wshobson security-scanning — desta vez name SEM prefixo de plugin (conferido POR arquivo) |
| Threat modeling | `security-threat-model` | openai — ancorado no repo (evidência do código) |
| Código & config | ★`insecure-defaults`, `sharp-edges` | trailofbits |
| Código & config | `secure-code-guardian` | Jeffallan (MIT + licença no frontmatter) — o lado BUILD (bcrypt/Zod/JWT/CSP) |
| Testes seg & privacidade | ★`security-testing`, `compliance-testing`, `ai-system-testing` (os 3 também em qa) | petrkindlmann (MIT por skill) — CI 5 camadas c/ ZAP; consent/GPC/AI Act; red-team defensivo de features LLM |
| Testes seg & privacidade | `privacy-engineering` | briiirussell (MIT) — ÚNICA com LGPD explícita (DSAR, deleção em cascata, 72h) |
| SAST & scanners | `semgrep`, `codeql`, `sarif-parsing`, `semgrep-rule-creator`, `semgrep-rule-variant-creator` | trailofbits — semgrep/codeql exigem os CLIs; o merge SARIF do plugin mora FORA da pasta (single-folder degrada; sarif-parsing cobre) |
| Supply chain & segredos | `supply-chain-risk-auditor`, `agentic-actions-auditor`, `open-sourcing` | trailofbits — o agentic-actions audita Actions com agentes de IA (caso Synkora) |
| Supply chain & segredos | `secrets-audit` | briiirussell — agnóstica de ferramenta (venceu secrets-gitleaks) |
| Supply chain & segredos | `github-sensitive-data-cleanup` | daymade (MIT) — a REMEDIAÇÃO (filter-repo c/ backup); destrutiva por design |
| Criptografia | `wycheproof`, `constant-time-analysis`, `zeroize-audit` | trailofbits — wycheproof baixa VETORES (dados, não instruções) |
| Fuzzing & sanitizers | `harness-writing`, `fuzzing-obstacles`, `address-sanitizer` | trailofbits (Testing Handbook embutido, zero fetch) |
| Hardening de infra | `k8s-security-policies` (wshobson), `iac-checkov` (AgentSecOps, CC-BY-SA+MPL), `docker-container-security` (GoldenWing) | YAML/Checkov/baseline docker |
| Por linguagem | `c-review`, `rust-review` | trailofbits — orquestração PESADA em tokens (avisado no summary) |
| Segurança de agentes/LLM | `prompt-injection-defense`, `mcp-security`, `llm-app-security` | GoldenWing-360 (MIT) — injeção direta/indireta, auditoria de MCP (sob medida p/ ADE), OWASP LLM Top 10 operacional |
| Segredos (gap-sweep) | `scan-secrets` (GitGuardian OFICIAL — ggshield+conta free; NUNCA a irmã install-hooks), `secret-hygiene`, `dependency-supply-chain`, `github-actions-security` (GoldenWing) | rotação em ordem, typosquat/slopsquat, SHA-pinning/OIDC |
| Código & config (gap) | `nextjs-security` (GoldenWing) | o melhor hardening web achado; específico de Next.js — o genérico fica com security-best-practices/secure-code-guardian |

**Caveat de concentração**: 9 skills vêm de GoldenWing-360 (repo jovem, 14★,
autor com empresa real, CI de validação; todas as 9 verificadas
individualmente com 2-3,2k palavras de substância) — a coleção defensiva
mais substanciosa fora da ToB; MONITORAR o repo.

**Re-tags**: skills `oauth`/`security-best-practices`/★`owasp-security`/
`secrets-management`/`property-based-testing` (back→+cyber) e
`crisis-communications` (copy→+cyber); agents `incident-responder` e
`pragmatic-code-review` (catálogo) + `container-optimizer` e
`observability-instrumentor` (bundled, helper BC).

**Subagentes** — 7 mercado: `data-flow-analyzer`, `exploitability-verifier`,
★`sharp-edges-analyzer`, `poc-builder`, `adversarial-modeler` (ToB — as
exceções standalone), `malware-analyst` (wshobson, triagem DEFENSIVA, name
sem prefixo), `gdpr-ccpa-compliance` (a exceção LIMPA do VoltAgent 04). +8
in-house (helper CY, gaps confirmados — segurança no ecossistema é
hooks/MCP/skill, quase nunca subagente): `secrets-hygiene-auditor` (o
RACIOCÍNIO sobre o que o gitleaks acha: vivo/morto, ordem de rotação),
`dependency-auditor` (CVE por ALCANÇABILIDADE), `authz-reviewer` (matriz
IDOR/tenant com prova por rota), `threat-modeler` (STRIDE de design →
.synkora/reports/, vira cards), `privacy-engineer` (LGPD-first no CÓDIGO —
o gdpr-ccpa-compliance explica regimes, este mapeia o repo),
`crypto-usage-reviewer` (mau uso de primitivas com substituição exata),
`web-surface-hardener` (CSP/CORS/cookies/SSRF — audita E aplica, CSP sempre
Report-Only primeiro), `security-fix-verifier` (red-green obrigatório: teste
que falha → fix → prova). Total função: 15 novos + 4 re-tags = 19.

### Ficou de FORA na rodada cyber (não reavaliar sem fato novo)

- **`claude-security` (anthropics/claude-plugins-official)** — o melhor
  pipeline do mercado (6 fases, painel 2-de-3) e PROPRIETÁRIO: o LICENSE da
  PASTA proíbe redistribuir modificado E "use with any non-Anthropic
  product" — o Synkora injeta também para panes codex. Mesma classe do
  quarteto docx. LIÇÃO: ler o LICENSE da pasta do plugin, não só o do repo.
- **`security-review` (WorldFlowAI)** — o name SOMBREIA o comando built-in
  /security-review do claude; nunca instalar nenhum candidato com esse id.
- **Phoenix suite engines** (threat-modeling/security-assessment/0day-scanner)
  — SEM frontmatter YAML (inválido na spec) + engines de pipeline REST/MCP
  próprio; `secure-prd-skill`→name `prd-generator` (pasta≠name) + Confluence
  MCP no core; `cti-search-skill` exige API key de busca.
- **Dead-refs/`../`**: `sast-configuration` (wshobson — references/ 404 +
  `../` para skills que NÃO EXISTEM no plugin), `security-and-hardening`
  (addyosmani — a doença de dead-ref do repo, confirmada de novo),
  `opengrep-rule-generator` (paths errados no corpo; o par ToB vence),
  UnitOneAI inteiro (`../../../docs|schemas` cross-repo; conteúdo excelente,
  re-visitar SE o motor um dia carregar pastas extras).
- **Licença**: better-auth security (bom, SEM LICENSE — re-entra se
  licenciar); mukul975 (agregador de 817 skills sem proveniência + nome
  flertando com a marca Anthropic); rohitg00/tresor (taxonomia VoltAgent
  clonada + zero atribuição = relicenciamento suspeito).
- **curl|bash**: varlock-claude-skill (install.sh remoto no corpo).
- **Ofensivo/escopo**: Masriyan (42% red-team), AgentSecOps `offsec/*`,
  ToB smart-contracts/yara/apk/dwarf/burp/seatbelt (macOS)/trailmark,
  8 skills de fuzzer específico (trio de metodologia cobre), ToB
  `dimensional-analysis` (anota o codebase inteiro — write em massa).
- **Perdeu o slot**: threat-modeling briiirussell×UnitOneAI (colisão de id
  entre si; wshobson trio + openai cobrem), gdpr-data-handling
  (privacy-engineering mais funda), auth-implementation-patterns
  (oauth+secure-code-guardian), mtls-configuration (stub 350 palavras),
  incident-runbook-templates/postmortem-writing (SRE, não security),
  compliance-check kwp (compliance-testing vence; licença por-plugin não
  lida), VibeSec-Skill (id com MAIÚSCULA e sufixo -Skill fora do padrão;
  sobreposição), security-audit netresearch (id genérico + skew PHP/TYPO3),
  secrets-gitleaks (a agnóstica venceu), `function-analyzer` ToB (287
  palavras, formato de saída mora FORA da pasta — degrada demais sozinho).
- **Gap-sweep, perdeu o slot**: `gdpr-technical-controls` (GoldenWing —
  privacy-engineering com LGPD venceu; 1 por job), `cti-domain-research`
  (Phoenix, pasta≠name — dois verificadores divergiram sobre as deps de API
  key; threat intel é marginal p/ time de produto), `semgrep`/`code-security`/
  `llm-security` do **semgrep org** (Semgrep Rules License v1.0, não-OSI —
  re-entram se relicenciarem), cloudflare/hashicorp/chainguard/aqua/falco/
  sysdig/socket/snyk (NENHUM publica skill instalável; snyk/agent-scan é
  scanner DE skills — lead de motor p/ auditar a biblioteca), gitleaks/
  trufflesecurity (sem skills first-party; a prática entra via
  secret-hygiene), obra `defense-in-depth` (não existe mais — entrada stale
  do awesome), ecossistema OpenClaw/ClawHub (a Snyk reportou 280+ skills
  vazando credenciais nesse registry — proveniência tóxica).
- **Agents OUT**: wshobson `security-auditor` em 4 cópias TODAS com name
  prefixado + corpo inventário; VoltAgent 04 doente (context-manager +
  telemetria fake) exceto a aceita; lst97 security-auditor (metodologia
  DEPENDE de mcp context7/sequential-thinking + se anuncia pentest); davila7
  read-only-auditor (`hooks:` em frontmatter de agent é mecanismo não
  sondado — e o agentBody() do Synkora DESCARTA frontmatter no modo
  ajudante: a garantia read-only evapora; a ideia se reproduz com tools);
  harness agents (raptor/tachi/florianbuetow/c-review-*/zeroize-* — o .md é
  estágio de pipeline com {output_dir}/schemas/libexec); 0xfurai (model
  pinado, 2ª confirmação).

## Curadoria DATA (rodada 9, 2026-07-30) — 39 skills + 13 subagentes novos

Fonte OFICIAL em peso: dbt Labs, DuckDB Foundation, ClickHouse, Confluent,
Polars Inc, Hugging Face, Dagster (ref MASTER), Astronomer, Anthropic
knowledge-work-plugins (Apache-2.0 por plugin) + wshobson (MIT). NENHUMA
pasta≠name na rodada (raro). Kit ★ data: `sql-queries` +
`statistical-analysis` + `validate-data` + `data-quality-frameworks`; agent
★ `data-quality-sentinel` (in-house).

| Ocasião | Skills | Nota |
|---|---|---|
| SQL & warehouse | ★`sql-queries`, `explore-data`, `data-context-extractor` (kwp/data) + `profiling-tables` (astronomer) | dialetos+50 snippets; perfil de tabela SQL puro; meta-skill que gera skill de contexto do warehouse (par do CONTEXT.md) |
| Estatística & experimentos | ★`statistical-analysis` (kwp), `ab-testing` (corey — livre da rodada 7) | effect size > p-value; peeking explícito |
| Qualidade & validação | ★`validate-data` (kwp), ★`data-quality-frameworks` (wshobson) | gate de análise (18 itens, 7 armadilhas); único GX instalável com licença sã |
| Visualização & BI | `data-visualization`, `build-dashboard` (kwp), `kpi-dashboard-design`, `data-storytelling` (wshobson) | charts Python; dashboard HTML single-file (CDN é do ARTEFATO); a única de narrativa |
| Análise local (DuckDB) | `query`, `read-file`, `attach-db`, `duckdb-docs` | OFICIAL DuckDB Foundation; ids genéricos de 1 palavra anotados; duckdb-docs cacheia índice local (dados, não ruleset) |
| Dataframes & notebooks | `polars` (Polars Inc oficial — 9 gotchas de falha silenciosa), `jupyter-notebook` (openai, Apache POR skill) | |
| Analytics eng (dbt) | `using-dbt-for-analytics-engineering`, `adding-dbt-unit-test`, `building-dbt-semantic-layer`, `running-dbt-commands`, `creating-mermaid-dbt-dag` | dbt Labs OFICIAL; MCP preferido mas CLI local basta |
| Pipelines & orquestração | `airflow-dag-patterns` (wshobson) + `authoring-dags`/`testing-dags`/`debugging-dags` (astronomer, CLI `af` gratuito) + `dagster-expert` (oficial, ref MASTER) + `spark-optimization` (wshobson) | conhecimento + operação; Databricks caiu por licença |
| Streaming (Kafka) | `kafka-streams-programming`, `developing-kafka-python-client` | Confluent oficial; servem Kafka OSS |
| OLAP (ClickHouse) | `clickhouse-best-practices` + `clickhouse-architecture-advisor` (requires a primeira) | oficial; 31 regras dentro da pasta |
| ML & LLM data | `ml-pipeline-workflow`, `rag-implementation`, `llm-evaluation`, `embedding-strategies`, `vector-index-tuning` (wshobson) + `huggingface-datasets` (HF oficial) | |

**Re-tags**: `supabase-postgres-best-practices`, `postgresql-table-design`,
`domain-modeling` (→+data); agents `performance-optimizer` (catálogo) +
`sql-query-surgeon`/`migration-surgeon`/`backend-reality-checker` (bundled,
helper BD) e `dataviz-frontend` (bundled, helper FD).

**Subagentes** — 7 mercado: `ab-test-analysis` e `cohort-analysis` (VoltAgent
categoria 10 — a leva NOVA é limpa; a 05 é 100% doente), `model-evaluator`
(davila7, composição original), `vector-database-engineer` (wshobson com
NÚMEROS), `data-engineer`/`ml-engineer`/`data-scientist` (lst97 — MCPs
declarados degradam sem quebrar). +6 in-house (helper DT):
`analytics-engineer` (dbt/marts com GRAIN declarado — o dimensional
modeling que NÃO existe no mercado), ★`data-quality-sentinel` (mede com
números e deixa teste permanente; reprovar é resultado válido),
`dataframe-surgeon` (pandas/polars/duckdb por medição),
`experiment-designer` (o PAR pré-teste do ab-test-analysis; pré-registro em
.synkora/reports/), `event-taxonomy-designer` (.synkora/TRACKING.md como
contrato), `metrics-guardian` (.synkora/METRICS.md — a família guardian).
Total função: 13 novos + 5 re-tags = 18.

### Ficou de FORA na rodada data (não reavaliar sem fato novo)

- **Licença**: majesticlabs INTEIRO (**Polyform Noncommercial 1.0.0** — nova
  licença bloqueadora no radar; dói: etl-core-patterns e great-expectations
  eram legítimas), Databricks (licença própria não-SPDX), Imbad0202 (CC
  BY-NC, 2ª vez). **K-Dense**: VENDOROU o `docx` PROPRIETÁRIO da Anthropic
  dentro do repo — checar a árvore por docx/pdf/pptx/xlsx virou teste
  rápido de proveniência.
- **Sem Windows**: `chdb-sql`/`chdb-datastore` (frontmatter `compatibility:
  "macOS or Linux"` — campo real de vendor; conferir SEMPRE).
- **Vendor/conta**: MotherDuck (18 skills, tudo orbita token), Snowflake
  coco-skills (CLI Cortex), `azure-kusto` (fecha o deferral `kql` da rodada
  6: subscription+MCP+az, sem modo offline), huggingface-llm-trainer (plano
  PAGO + scripts por URL em runtime), Confluent cloud-side, dbt Cloud-side.
- **Pendência-PACOTE (classe Figma)**: PostHog (~90 skills, o melhor
  material de product analytics — mas TUDO via MCP `posthog:*` que o strict
  exclui) e GrowthBook (GB_API_KEY + helper de plugin; self-hostable —
  candidata a custom-por-URL quando um projeto adotar).
- **Deferrals FECHADOS**: `performance-report` (kwp) é funil de MARKETING
  (CTR/ROAS), não analytics — se um dia houver função growth, lá;
  `infographic` GPL segue fora (slot coberto).
- **Sobreposição**: dbt-transformation-patterns (oficial vence), kwp
  write-query/create-viz/analyze (espelhos), similarity-search/langchain
  (cobertas), duckdb install/read-memories/s3/spatial/convert,
  clickhouse-js-node-rowbinary (**352 files > cap 200**), astronomer
  nicho/vendor (2 com `skill.md` MINÚSCULO — violação da spec em repo
  oficial).
- **Agents OUT**: wshobson inventário (data-engineer/scientist/sql-pro/
  ml/mlops; database-architect/optimizer com name PREFIXADO — armadilha
  reconfirmada), VoltAgent 05-data-ai 100% doente (e `data-researcher` da
  10 reprovou por telemetria "4.7M records"), rshah515 família data (zero
  thresholds em 4 amostrados), lst97 `ai-engineer` (slot é back), davila7
  clones/vendor-locks, 0xfurai pandas-expert (model pinado).

### Lições novas das rodadas 8–9 (não redescobrir)

- **Árvore de repo SEM tocar api.github.com**:
  `data.jsdelivr.com/v1/packages/gh/<owner>/<repo>@<ref>?structure=flat`
  lista a árvore inteira com quota própria do jsDelivr.
- **Listing resumido é LOSSY**: dead-ref só se confirma por fetch direto do
  arquivo (404 real) — o flat listing "escondeu" references/ do wshobson e
  quase causou descarte em massa.
- Plugin-marketplace ≠ repo de skills flat: ToB agrupa skills+agents+
  scripts/ POR PLUGIN — a skill pode referenciar `../scripts/` do plugin
  (semgrep) e o single-folder degrada; anotar no summary o que degrada.
- Segurança no ecossistema Claude Code = hooks/MCP/scanner/skill — quase
  não existe subagente publicado; a cota in-house de cyber foi a maior.
- A doença VoltAgent é POR LEVA, não por repo: 05-data-ai e 04 (maioria)
  doentes; categoria 10 (descriptions "Triggers on:") limpa.
- Licença POR PASTA de plugin: claude-plugins-official é aberto, o plugin
  claude-security dentro dele é proprietário com cláusula anti-produto-
  não-Anthropic.
- Agregador se detecta pela taxonomia (10 categorias VoltAgent clonadas +
  zero atribuição) e por README que credita skills a repo onde não existem
  (mingrath).

## MAPA DE FONTES para as próximas rodadas (onde tem skill/agent BOM)

Registrado a pedido do usuário (2026-07-29): estes lugares têm material para
as OUTRAS frentes também — começar as rodadas futuras por aqui, sempre abrindo
o SKILL.md real na fonte antes de curar.

**Diretórios de descoberta:**
- skills.sh (Vercel) — o diretório com contagem de installs; buscar por termo.
- VoltAgent/awesome-agent-skills — a única lista awesome com valor real (foi
  ela que revelou microsoft/expo/openai). Para AGENTS:
  VoltAgent/awesome-claude-code-subagents (CUIDADO: muitos dependem de um
  "context-manager" fictício — avaliar um a um).
- Newsletters que curam: aihero.dev (Matt Pocock) e charliehills.substack.com.

**Coleções gerais (várias frentes):**
- anthropics/skills — oficial; qa (webapp-testing), design (canvas-design,
  theme-factory), meta (skill-creator), docs/artifacts.
- mattpocock/skills (AIHero, ~194k★) — PM/processo (grill-me, grill-with-docs,
  to-spec, to-tickets, wayfinder, triage, handoff), back (implement, tdd,
  codebase-design, diagnosing-bugs), qa (code-review), research, meta
  (writing-great-skills). O coração das rodadas de PM/back/qa.
- obra/superpowers (~263k★) — metodologia (brainstorm→plans→TDD→verification);
  instala hooks (pegada maior — avaliar com calma).
- wshobson/agents (~38k★) — 180+ skills E agents organizados em plugins POR
  ÁREA (frontend-mobile, backend, data, security, devops…) — fonte para TODAS
  as frentes; qualidade média "inventário", garimpar os que têm metodologia.
- openai/skills — curadas do Codex (figma-implement-design, playwright).
- microsoft/skills — frontend-design-review e afins corporativos.

**Oficiais por stack (padrão-ouro quando o projeto usa a stack):**
- vercel-labs/agent-skills (React/Next/RN/writing), shadcn-ui/ui (skills/
  shadcn), greensock/gsap-skills, expo/skills, remotion-dev/skills.

**Por frente:**
- Front/design: jakubkrehel/skills (better-*), ibelick/ui-skills,
  Leonxlnx/taste-skill, emilkowalski/skills, pbakaus/impeccable,
  nextlevelbuilder/ui-ux-pro-max (com as ressalvas já documentadas).
- QA/qualidade: addyosmani/web-quality-skills + addyosmani/agent-skills
  (perf/CWV/browser-testing), anthropics webapp-testing, CFLW-AI/wcag-audit
  (único com eval documentado), better-interface/improve-ui como gates.
- Cyber: Security-Phoenix-demo/security-skills-claude-code
  (/security-review, /threatmodel), owasp-security (via BehiSecc/
  awesome-claude-skills).
- Copy: blader/humanizer (~32k★), better-writing, vercel writing-guidelines.
- Mídia/vídeo (design/marketing): heygen-com/hyperframes, remotion-dev/skills,
  higgsfield-ai/skills (vendor-lock — cuidado).
- Agents de review: OneRedOak/claude-code-workflows (design-review e irmãos
  de code review/security review — workflows completos).
- Meta (criar agents): disler/claude-code-hooks-mastery (meta-agent) e
  anthropics skill-creator — confirmação final na pesquisa da rodada 2.

## Roadmap das rodadas

1. ✅ Skills front (esta página).
2. ✅ Subagentes front (curadoria + mecânica acima). Pendência residual: a
   flag `--agents` do claude CLI (JSON inline) existe e pode um dia
   substituir a cópia por workspace — registrada, não explorada.
3. ✅ Skills+subagentes de back+devops (rodada 3, seção própria acima).
4. ✅ Skills+subagentes de qa (rodada 4, seção própria acima — inclui o motor
   do MCP playwright-test e as primeiras re-tags multi-função).
5. ✅ Skills+subagentes de design (rodada 5, seção própria acima).
6. ✅ Skills+subagentes de research (rodada 6, seção própria acima — escopo
   pesquisa+docs+planejamento; o antigo motor `orchestratorDefault` foi
   substituído pelo standard nativo único, régua "não forçar").
7. ✅ Skills+subagentes de copy (rodada 7, seção própria acima — deferrals
   fechados: internal-comms perdeu para stakeholder-update, seo do addyosmani
   OUT permanente, image/video do marketingskills fora porque mídia é do
   design; competitive-brief de marketing/ PULADO como planejado).
8. ✅ Skills+subagentes de cyber (rodada 8, seção própria acima — núcleo
   ToB + trio STRIDE wshobson + petrkindlmann; achado: claude-security da
   Anthropic é PROPRIETÁRIO, nunca instalar).
   ✅ Skills+subagentes de data (rodada 9, seção própria acima — oficiais
   em peso; deferrals kql e performance-report FECHADOS; PostHog/GrowthBook
   viraram pendência-pacote junto com Figma). Reserva viva:
   `type-design-analyzer` (back).
9. Possíveis melhorias do motor: fallback `git clone --sparse` quando a API
   do GitHub bloquear; PAT opcional nas settings (60/h → 5k/h); skill custom
   de tipo subagente.
