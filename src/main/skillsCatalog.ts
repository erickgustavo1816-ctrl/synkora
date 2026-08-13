import type { SkillDef } from './skillsLibrary'

// ————————————————————————————————————————————————————————————————————————
// CURADORIA DA BIBLIOTECA (F4) — rodada 1: FRONT-END (2026-07-29).
// Cada entrada foi VERIFICADA na fonte (SKILL.md real aberto, path e
// frontmatter `name` conferidos; ver docs/SKILLS.md para o racional e para
// o que ficou de fora e por quê). REGRAS desta curadoria:
//   · id = `name:` do frontmatter upstream (a pasta instalada usa o id — a
//     spec exige pasta=name; várias fontes têm pasta upstream diferente).
//   · Oficial do autor da lib > fan-made (gsap=GreenSock, shadcn=shadcn,
//     expo=Expo, remotion=Remotion, frontend-design=Anthropic).
//   · Nada de skill que busca RULESET REMOTO sem pin em runtime (superfície
//     de supply-chain — foi o motivo de web-design-guidelines ficar fora).
//   · defaultFor = o que entra sozinho na função quando o card não carimba
//     nada; o resto o ORQUESTRADOR carimba por card/ajudante (list_skills).
//   · group = ocasião (agrupamento visual da seção "biblioteca de skills").
//   · RODADA POR FUNÇÃO (decisão do usuário, 2026-07-29): nesta rodada TUDO
//     pertence só a 'front' — mesmo skills que também servirão a qa/copy/
//     design (better-accessibility, better-writing, create-design-md…).
//     Quando a rodada daquela função chegar, ELA ganha os depts dela aqui.
// ————————————————————————————————————————————————————————————————————————

export const CURATED_SKILLS: SkillDef[] = [
  // ——— direção estética / gosto ———
  {
    id: 'frontend-design',
    kind: 'skill',
    depts: ['front', 'design'],
    group: 'direção estética',
    source: { repo: 'anthropics/skills', path: 'skills/frontend-design', ref: 'main' },
    summary:
      'Direção estética oficial da Anthropic (a skill de design mais instalada do mercado): tipografia como personalidade, plano compacto de 4-6 cores + autocrítica contra defaults genéricos antes de codar.',
    hint: 'Use when building or restyling ANY user-facing screen — sets the aesthetic direction pass before writing code.',
    defaultFor: ['front', 'design']
  },
  {
    id: 'design-taste-frontend',
    kind: 'skill',
    depts: ['front', 'design'],
    group: 'direção estética',
    source: { repo: 'Leonxlnx/taste-skill', path: 'skills/taste-skill', ref: 'main' },
    summary:
      'O rulebook "anti-slop" mais completo: dials de variância/motion/densidade, proibições mecânicas (herói com máx. 4 elementos, fontes default banidas) e pre-flight de 68 checagens.',
    hint: 'Use for high-stakes visual work when the screen must NOT look AI-generated — hard rules, dials and a 68-point pre-flight.'
  },
  {
    id: 'high-end-visual-design',
    kind: 'skill',
    depts: ['front', 'design'],
    group: 'direção estética',
    source: { repo: 'Leonxlnx/taste-skill', path: 'skills/soft-skill', ref: 'main' },
    summary: 'Linguagem visual "cara": estética premium/soft para páginas que precisam parecer produto caro.',
    hint: 'Use when the brief asks for a premium/luxurious look (landing pages, marketing surfaces).'
  },
  {
    id: 'minimalist-ui',
    kind: 'skill',
    depts: ['front', 'design'],
    group: 'direção estética',
    source: { repo: 'Leonxlnx/taste-skill', path: 'skills/minimalist-skill', ref: 'main' },
    summary: 'Linguagem visual minimalista: reduzir até doer, hierarquia por espaço e tipografia.',
    hint: 'Use when the design language is minimalist/clean — reduction-first rules.'
  },

  // ——— polish / micro-interações ———
  {
    id: 'better-ui',
    kind: 'skill',
    depts: ['front'],
    group: 'polish & micro-interações',
    source: { repo: 'jakubkrehel/skills', path: 'skills/better-ui', ref: 'main' },
    summary:
      'Polimento com valores EXATOS: scale(0.96) no press, springs, blur de ícones, focus outline OKLCH — 15 princípios de micro-interação com severidade.',
    hint: 'Use when polishing components/micro-interactions — exact values for press states, springs, focus rings.',
    defaultFor: ['front']
  },
  {
    id: 'baseline-ui',
    kind: 'skill',
    depts: ['front'],
    group: 'polish & micro-interações',
    source: { repo: 'ibelick/ui-skills', path: 'skills/baseline-ui', ref: 'main' },
    summary:
      '27 restrições rápidas de "deslop" (animação só no compositor, safe-area, reduced motion) — a passada barata que evita cara de IA.',
    hint: 'Use as a fast constraint pass on any new UI — 27 cheap rules that prevent generic AI-looking output.'
  },
  {
    id: 'impeccable',
    kind: 'skill',
    depts: ['front', 'design'],
    group: 'polish & micro-interações',
    source: { repo: 'pbakaus/impeccable', path: '.claude/skills/impeccable', ref: 'main' },
    summary:
      'Design-ops com 23 operações roteadas: escolha somente a que domina o pedido (como layout, adapt, harden, typeset ou polish); comandos interativos, de auditoria ou alta agência exigem contexto e fase apropriados.',
    hint: 'Use exactly one context-matched Impeccable operation at a time. Do not chain commands or stack it with another aesthetic-direction skill; keep the user brief, local design authority, and Synkora UI contract above its defaults.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'browser'],
    adapter: 'impeccable-operation'
  },

  // ——— layout / tipografia / cor ———
  {
    id: 'better-layout',
    kind: 'skill',
    depts: ['front'],
    group: 'layout · tipografia · cor',
    source: { repo: 'jakubkrehel/skills', path: 'skills/better-layout', ref: 'main' },
    summary:
      'Layout e ESPAÇAMENTO: escalas de spacing (12/16/24), hierarquia, reading order, container queries, safe-area — com tabela dos 9 erros clássicos.',
    hint: 'Use when structuring pages or fixing spacing/hierarchy/alignment/responsiveness issues.',
    defaultFor: ['front']
  },
  {
    id: 'better-typography',
    kind: 'skill',
    depts: ['front', 'design'],
    group: 'layout · tipografia · cor',
    source: { repo: 'jakubkrehel/skills', path: 'skills/better-typography', ref: 'main' },
    summary:
      'Tipografia: line-height por uso, measure 60-75ch, text-wrap balance, números tabulares, inputs ≥16px no iOS — com cheat sheet CSS↔Tailwind.',
    hint: 'Use when choosing/refining type scales, line-heights, measures or fixing text-layout issues.'
  },
  {
    id: 'better-colors',
    kind: 'skill',
    depts: ['front', 'design'],
    group: 'layout · tipografia · cor',
    source: { repo: 'jakubkrehel/skills', path: 'skills/better-colors', ref: 'main' },
    summary:
      'Cor de ponta a ponta em OKLCH: paletas, contraste APCA/WCAG, gamut/P3, tokens semânticos e Tailwind v4 — 5 guias de referência.',
    hint: 'Use when building palettes, theming, checking contrast or defining semantic color tokens (OKLCH-first).'
  },

  // ——— acessibilidade & microcopy ———
  {
    id: 'better-accessibility',
    kind: 'skill',
    depts: ['front', 'qa'],
    group: 'acessibilidade & microcopy',
    source: { repo: 'jakubkrehel/skills', path: 'skills/better-accessibility', ref: 'main' },
    summary:
      'Acessibilidade keyboard-first → screen-reader: hit areas 24×24, focus ring 2px, zoom 200%, 13 anti-padrões e template de auditoria.',
    hint: 'Use when implementing or auditing accessibility: keyboard flows, focus, ARIA, hit areas, zoom.'
  },
  {
    id: 'better-writing',
    kind: 'skill',
    depts: ['front', 'copy'],
    group: 'acessibilidade & microcopy',
    source: { repo: 'jakubkrehel/skills', path: 'skills/better-writing', ref: 'main' },
    summary:
      'Microcopy de INTERFACE: botões verbo-primeiro, erros que instruem ao lado do campo, estados vazios, matriz de tom — ★ da função copy (re-tag rodada 7; upstream reconferido).',
    hint: 'Use when writing/reviewing interface copy: buttons, errors, empty states, labels, tone.',
    defaultFor: ['copy']
  },

  // ——— review de interface ———
  {
    id: 'better-interface',
    kind: 'skill',
    depts: ['front', 'qa'],
    group: 'review de interface',
    source: { repo: 'jakubkrehel/skills', path: 'skills/better-interface', ref: 'main' },
    summary:
      'Revisão HOLÍSTICA de interface: orquestra as 6 skills irmãs (a11y primeiro), exige evidência file:line, consolida por causa-raiz e fecha com veredito único.',
    hint: 'Use to run a coordinated interface review across a11y/layout/type/color/ui/copy with file:line evidence and a single verdict.',
    requires: [
      'better-ui',
      'better-layout',
      'better-typography',
      'better-colors',
      'better-accessibility',
      'better-writing'
    ]
  },
  {
    id: 'improve-ui',
    kind: 'skill',
    depts: ['front', 'qa'],
    group: 'review de interface',
    source: { repo: 'ibelick/ui-skills', path: 'skills/improve-ui', ref: 'main' },
    summary:
      'Auditoria read-only de DRIFT do design system com prova tripla (contrato + caminho de runtime + correção determinística) — entrega planos, não edita.',
    hint: 'Use to audit UI drift against the design system without editing — produces evidence-backed fix plans.'
  },

  // ——— animação ———
  {
    id: 'emil-design-eng',
    kind: 'skill',
    depts: ['front'],
    group: 'animação',
    source: { repo: 'emilkowalski/skills', path: 'skills/emil-design-eng', ref: 'main' },
    summary:
      'A filosofia de animação de interface do Emil Kowalski (sonner/vaul, animations.dev): ease-out sempre, <300ms, só transform/opacity, quando NÃO animar.',
    hint: 'Use when adding or reviewing interface animations — purpose, easing, duration and performance rules from a real authority.'
  },
  {
    id: 'vercel-react-view-transitions',
    kind: 'skill',
    depts: ['front'],
    group: 'animação',
    source: { repo: 'vercel-labs/agent-skills', path: 'skills/react-view-transitions', ref: 'main' },
    summary:
      'View Transitions API no React (oficial Vercel): quando animar, shared elements, addTransitionType e receitas CSS prontas.',
    hint: 'Use when implementing page/element transitions in React with the View Transitions API.'
  },
  {
    id: 'fixing-motion-performance',
    kind: 'skill',
    depts: ['front'],
    group: 'animação',
    source: { repo: 'ibelick/ui-skills', path: 'skills/fixing-motion-performance', ref: 'main' },
    summary:
      'Conserto de animação travada: compositor-only, scroll-timeline em vez de polling, blur ≤8px, FLIP, will-change cirúrgico — 9 níveis.',
    hint: 'Use when animations jank or scroll performance drops — a corrective performance pass for motion.'
  },
  {
    id: 'gsap-core',
    kind: 'skill',
    depts: ['front'],
    group: 'animação',
    source: { repo: 'greensock/gsap-skills', path: 'skills/gsap-core', ref: 'main' },
    summary:
      'GSAP oficial (GreenSock): API correta de to/from/fromTo, autoAlpha, matchMedia responsivo — mata as alucinações clássicas da lib.',
    hint: 'Use when the project animates with GSAP — correct core API usage and common-mistake avoidance.'
  },
  {
    id: 'gsap-react',
    kind: 'skill',
    depts: ['front'],
    group: 'animação',
    source: { repo: 'greensock/gsap-skills', path: 'skills/gsap-react', ref: 'main' },
    summary: 'GSAP em React (oficial): useGSAP, cleanup correto e SSR.',
    hint: 'Use when integrating GSAP inside React components (useGSAP, cleanup, SSR).'
  },

  // ——— engenharia react / performance web ———
  {
    id: 'vercel-react-best-practices',
    kind: 'skill',
    depts: ['front'],
    group: 'react & performance',
    source: { repo: 'vercel-labs/agent-skills', path: 'skills/react-best-practices', ref: 'main' },
    summary:
      'Performance React/Next oficial da Vercel: 70 regras priorizadas por impacto (waterfalls → bundle → server → re-render), cada uma com exemplo certo/errado.',
    hint: 'Use when writing or optimizing React/Next code — impact-ranked performance rules.'
  },
  {
    id: 'vercel-composition-patterns',
    kind: 'skill',
    depts: ['front'],
    group: 'react & performance',
    source: { repo: 'vercel-labs/agent-skills', path: 'skills/composition-patterns', ref: 'main' },
    summary:
      'Arquitetura de componentes React (oficial Vercel): compound components contra proliferação de boolean props, APIs do React 19.',
    hint: 'Use when designing component APIs — composition over boolean-prop proliferation, React 19 patterns.'
  },
  {
    id: 'core-web-vitals',
    kind: 'skill',
    depts: ['front', 'qa'],
    group: 'react & performance',
    source: { repo: 'addyosmani/web-quality-skills', path: 'skills/core-web-vitals', ref: 'main' },
    summary:
      'Core Web Vitals pelo Addy Osmani (Chrome): medir antes, limiares LCP/CLS/INP e o ciclo measure→fix→verify→guard.',
    hint: 'Use when diagnosing or protecting page-load and interaction performance (LCP/CLS/INP).'
  },

  // ——— design system / componentes ———
  {
    id: 'create-design-md',
    kind: 'skill',
    depts: ['front', 'design'],
    group: 'design system & componentes',
    source: { repo: 'ibelick/ui-skills', path: 'skills/create-design-md', ref: 'main' },
    summary:
      'Gera/atualiza um DESIGN.md canônico a partir do código do repo (ou de uma URL de referência): tokens, estilos computados, schema validado — nunca toca no source.',
    hint: 'Use to extract or refresh the durable design system in tracked tokens plus the repo documentation convention (or docs/design-system.md); .synkora/DESIGN.md is read-only runtime context.',
    defaultFor: ['design']
  },
  {
    id: 'tailwind-design-system',
    kind: 'skill',
    depts: ['front', 'design'],
    group: 'design system & componentes',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/frontend-mobile-development/skills/tailwind-design-system',
      ref: 'main'
    },
    summary:
      'Design system em Tailwind v4 CSS-first: @theme, tokens OKLCH em hierarquia brand→semantic→component, starter code.',
    hint: 'Use when creating or restructuring a Tailwind v4 token system (CSS-first @theme).'
  },
  {
    id: 'shadcn',
    kind: 'skill',
    depts: ['front'],
    group: 'design system & componentes',
    source: { repo: 'shadcn-ui/ui', path: 'skills/shadcn', ref: 'main' },
    summary:
      'shadcn/ui OFICIAL: operar via CLI (search/docs/add/diff), tokens semânticos (nunca cor crua), forms com Field/InputGroup — compose, don\'t reinvent.',
    hint: 'Use when the project uses shadcn/ui — drive the CLI and registry correctly instead of hand-writing components.'
  },

  // ——— mobile (react native / expo) ———
  {
    id: 'vercel-react-native-skills',
    kind: 'skill',
    depts: ['front'],
    group: 'mobile',
    source: { repo: 'vercel-labs/agent-skills', path: 'skills/react-native-skills', ref: 'main' },
    summary:
      'React Native (oficial Vercel): 32 regras de performance — FlashList, animação GPU-safe, navegação nativa, safe area.',
    hint: 'Use when writing React Native code — performance and correctness rules with wrong/right pairs.'
  },
  {
    id: 'expo-router',
    kind: 'skill',
    depts: ['front'],
    group: 'mobile',
    source: { repo: 'expo/skills', path: 'plugins/expo/skills/expo-router', ref: 'main' },
    summary: 'Expo Router oficial: telas, navegação, tabs nativas — o coração de qualquer app Expo.',
    hint: 'Use when building screens/navigation in an Expo app (Expo Router).'
  },
  {
    id: 'expo-native-ui',
    kind: 'skill',
    depts: ['front'],
    group: 'mobile',
    source: { repo: 'expo/skills', path: 'plugins/expo/skills/expo-native-ui', ref: 'main' },
    summary:
      'UI nativa no Expo (oficial): Apple HIG, cores semânticas, SF Symbols, Reanimated, blur/glass — 8 docs de referência.',
    hint: 'Use when the mobile UI must feel native (HIG patterns, semantic colors, SF Symbols, Reanimated).'
  },
  {
    id: 'expo-data-fetching',
    kind: 'skill',
    depts: ['front'],
    group: 'mobile',
    source: { repo: 'expo/skills', path: 'plugins/expo/skills/expo-data-fetching', ref: 'main' },
    summary: 'Dados no Expo (oficial): React Query/SWR, cache, offline e loaders.',
    hint: 'Use when wiring data fetching/caching/offline in an Expo app.'
  },
  {
    id: 'expo-tailwind-setup',
    kind: 'skill',
    depts: ['front'],
    group: 'mobile',
    source: { repo: 'expo/skills', path: 'plugins/expo/skills/expo-tailwind-setup', ref: 'main' },
    summary: 'Tailwind v4 no Expo via NativeWind v5 (oficial): setup correto pelo Metro, sem Babel.',
    hint: 'Use when setting up or fixing Tailwind/NativeWind styling in an Expo project.'
  },

  // ——— imagem → código ———
  {
    id: 'image-to-code',
    kind: 'skill',
    depts: ['front', 'design'],
    group: 'imagem → código',
    source: { repo: 'Leonxlnx/taste-skill', path: 'skills/image-to-code-skill', ref: 'main' },
    summary: 'Pipeline imagem→código: analisa um mockup/screenshot e implementa fiel (exige modelo com visão).',
    hint: 'Use when implementing a screen from a mockup/screenshot image — structured analyze-then-build pipeline.'
  },

  // ——— meta: criação de subagentes (a FONTE OFICIAL — pesquisa 2026-07-29:
  // é o system prompt de produção do gerador do próprio Claude Code +
  // validador mecânico; licença Anthropic Commercial ToS = uso com Claude
  // Code ok, nunca REDISTRIBUIR o conteúdo) ———
  {
    id: 'agent-development',
    kind: 'skill',
    depts: ['front'],
    group: 'meta · criação de agentes',
    source: {
      repo: 'anthropics/claude-code',
      path: 'plugins/plugin-dev/skills/agent-development',
      ref: 'main'
    },
    summary:
      'A metodologia OFICIAL da Anthropic para criar subagentes: o system prompt de produção do gerador do Claude Code, 4 arquétipos, guia de descriptions (491 linhas) e validador mecânico.',
    hint: 'Use when authoring or refining a Claude Code subagent — the official methodology, references and validator.'
  },
  {
    id: 'agent-creator',
    kind: 'agent',
    depts: ['front'],
    group: 'meta · criação de agentes',
    source: {
      repo: 'anthropics/claude-code',
      path: 'plugins/plugin-dev/agents/agent-creator.md',
      ref: 'main'
    },
    summary:
      'O agente OFICIAL que gera subagentes prontos aplicando a metodologia da skill agent-development (frontmatter validado, description com exemplos, prompt estruturado).',
    hint: 'Delegate generating a new specialist subagent .md from a role description to this official creator.'
  },

  // ——— SUBAGENTES especializados (rodada 2, 2026-07-29) ———
  // source.path aponta o ARQUIVO .md; id = frontmatter name (validado no
  // download). Descartes com motivo em docs/SKILLS.md (VoltAgent depende de
  // "context-manager" inexistente; vijaythecoder frontend-developer tem
  // frontmatter quebrado; zhsama/hesreallyhim sem licença; iannuttall
  // arquivado; nenhum autor de skill curada embarca subagente instalável).
  {
    id: 'design-review',
    kind: 'agent',
    depts: ['front', 'qa', 'design'],
    group: 'subagentes especializados',
    source: {
      repo: 'OneRedOak/claude-code-workflows',
      path: 'design-review/design-review-agent.md'
    },
    summary:
      'O CANÔNICO da revisão de design com browser de verdade: dirige o Playwright em 7 fases (interação, viewports 1440/768/375, polish, WCAG AA, robustez, console), triage Blocker/High/Medium/Nit com screenshots.',
    hint: 'Delegate a live-browser design review of an implemented UI to this specialist (it drives the playwright MCP tools available in this pane).'
  },
  {
    id: 'ui-visual-validator',
    kind: 'agent',
    depts: ['front', 'qa'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/accessibility-compliance/agents/ui-visual-validator.md',
      ref: 'main'
    },
    summary:
      'O cético visual: valida mudanças de UI por evidência com postura adversarial ("não atingido até provado"), checklist mandatório de 13 itens e comportamentos proibidos.',
    hint: 'Delegate skeptical verification of visual changes (screenshots/evidence) to this validator before claiming a UI task done.',
    defaultFor: ['front']
  },
  {
    id: 'accessibility-expert',
    kind: 'agent',
    depts: ['front', 'qa'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/ui-design/agents/accessibility-expert.md',
      ref: 'main'
    },
    summary:
      'Auditoria de acessibilidade WCAG 2.1/2.2 por critério: ARIA/APG, navegação por teclado, testes com leitores de tela reais e remediação priorizada por impacto.',
    hint: 'Delegate an accessibility audit or WCAG remediation plan of a screen/flow to this specialist.'
  },
  {
    id: 'tailwind-frontend-expert',
    kind: 'agent',
    depts: ['front'],
    group: 'subagentes especializados',
    source: {
      repo: 'vijaythecoder/awesome-claude-agents',
      path: 'agents/universal/tailwind-css-expert.md'
    },
    summary:
      'Especialista Tailwind v4 (OKLCH, @theme, container queries) com workflow de 5 passos: docs → auditoria → design → build → verificação com Lighthouse/axe.',
    hint: 'Delegate Tailwind-specific implementation or refactor work (v4 idioms, tokens, responsive) to this specialist.'
  },
  {
    id: 'expo-react-native-expert',
    kind: 'agent',
    depts: ['front'],
    group: 'subagentes especializados',
    source: {
      repo: 'VoltAgent/awesome-claude-code-subagents',
      path: 'categories/02-language-specialists/expo-react-native-expert.md'
    },
    summary:
      'Especialista Expo/React Native atual (SDK 52+, RN 0.76+, Expo Router, Reanimated, EAS) — a exceção de qualidade da coleção VoltAgent, sem dependências fictícias.',
    hint: 'Delegate Expo/React Native mobile implementation work to this specialist.'
  },

  // ————————————————————————————————————————————————————————————————————————
  // RODADA 3: BACK-END + DEVOPS (2026-07-29). Mesmo processo da front:
  // varredura multi-agente, TODO SKILL.md aberto na fonte, path + frontmatter
  // `name` + branch conferidos. devops→back (roteamento do app). Descartes e
  // racional em docs/SKILLS.md. Armadilhas verificadas: postgresql e fastify
  // têm pasta upstream ≠ name; temporal-developer tem SKILL.md na RAIZ do
  // repo (path '' é suportado pelo installer); anthropics/openai licenciam
  // POR SKILL (LICENSE.txt dentro da pasta, Apache-2.0 conferido).
  // ————————————————————————————————————————————————————————————————————————

  // ——— metodologia de implementação ———
  {
    id: 'test-driven-development',
    kind: 'skill',
    depts: ['front', 'back', 'qa'],
    group: 'metodologia de implementação',
    source: { repo: 'obra/superpowers', path: 'skills/test-driven-development', ref: 'main' },
    summary:
      'O TDD mais completo do mercado: red-green-refactor mandatório ("se você não viu o teste falhar, não sabe o que ele testa"), contra-argumentos às racionalizações comuns e checklist de verificação.',
    hint: 'Use when implementing any backend feature or fix — enforces the red-green-refactor discipline with failure-first proof.',
    defaultFor: ['back']
  },
  {
    id: 'tdd',
    kind: 'skill',
    depts: ['back'],
    group: 'metodologia de implementação',
    source: { repo: 'mattpocock/skills', path: 'skills/engineering/tdd', ref: 'main' },
    summary:
      'TDD enxuto do Matt Pocock: testes pela interface pública (seams), anti-padrões nomeados (testes tautológicos, acoplamento a implementação), fatias verticais com refactor adiado ao review.',
    hint: 'Use as a lightweight TDD pass on smaller cards — public-interface seams and named anti-patterns, cheaper than the full discipline.'
  },
  {
    id: 'verification-before-completion',
    kind: 'skill',
    depts: ['front', 'back', 'qa'],
    group: 'metodologia de implementação',
    source: { repo: 'obra/superpowers', path: 'skills/verification-before-completion', ref: 'main' },
    summary:
      'Antes de declarar "pronto": identificar o comando de verificação, rodá-lo FRESCO, ler saída e exit code — proíbe "should work"/"probably". Ataca a falha nº 1 de agente executor.',
    hint: 'Use before reporting any task done — forces running the real verification command and reading its output first.',
    defaultFor: ['back']
  },
  {
    id: 'receiving-code-review',
    kind: 'skill',
    depts: ['front', 'back'],
    group: 'metodologia de implementação',
    source: { repo: 'obra/superpowers', path: 'skills/receiving-code-review', ref: 'main' },
    summary:
      'Receber feedback de review com rigor: ler tudo, verificar contra o estado real do código, aceitar ou rebater com razão — proíbe concordância performática. Casa com o ciclo reprovação-do-gate → correção.',
    hint: 'Use when handling gate/review feedback (reprovações) — verify each point against the code before acting on it.'
  },
  {
    id: 'requesting-code-review',
    kind: 'skill',
    depts: ['front', 'back', 'qa'],
    group: 'metodologia de implementação',
    source: { repo: 'obra/superpowers', path: 'skills/requesting-code-review', ref: 'main' },
    summary:
      'Pedir revisão com contexto fechado (requisitos + faixa exata do diff) e tratar achados por severidade. Fica sob escolha explícita porque o Synkora já possui review automático no pipeline de cada card.',
    hint: 'Use only when an extra, explicitly requested code review is useful — Synkora already runs the normal review gate.',
    manualOnly: true
  },
  {
    id: 'resolving-merge-conflicts',
    kind: 'skill',
    depts: ['back'],
    group: 'metodologia de implementação',
    source: { repo: 'mattpocock/skills', path: 'skills/engineering/resolving-merge-conflicts', ref: 'main' },
    summary:
      'Resolver conflito de merge preservando a INTENÇÃO dos dois lados (via mensagens de commit/PRs), fechando com typecheck e testes — o cenário exato dos merges de worktree do app.',
    hint: 'Use when resolving git merge conflicts (mission/task worktree merges) — intent-preserving resolution, then verify.'
  },
  {
    id: 'using-git-worktrees',
    kind: 'skill',
    depts: ['back'],
    group: 'git · entrega',
    source: { repo: 'obra/superpowers', path: 'skills/using-git-worktrees', ref: 'main' },
    summary:
      'Criação segura de workspace isolado com detecção de worktree existente, preferência pela ferramenta nativa e baseline de testes. Uso explícito: missões e cards do Synkora já nascem isolados pelo app.',
    hint: 'Use only outside the normal Synkora mission/card isolation flow, when an explicitly requested extra worktree is needed.',
    manualOnly: true
  },
  {
    id: 'finishing-a-development-branch',
    kind: 'skill',
    depts: ['back'],
    group: 'git · entrega',
    source: {
      repo: 'obra/superpowers',
      path: 'skills/finishing-a-development-branch',
      ref: 'main'
    },
    summary:
      'Fechamento disciplinado de uma branch: testes frescos, opções de integração e limpeza por proveniência. Uso explícito porque, dentro do Synkora, integração e limpeza pertencem ao integrate_mission.',
    hint: 'Use only for branch work that is explicitly outside Synkora\'s managed integrate_mission flow.',
    manualOnly: true
  },

  // ——— arquitetura & domínio ———
  {
    id: 'codebase-design',
    kind: 'skill',
    depts: ['back'],
    group: 'arquitetura & domínio',
    source: { repo: 'mattpocock/skills', path: 'skills/engineering/codebase-design', ref: 'main' },
    summary:
      'Vocabulário de módulos profundos (deep vs shallow, seams, adapters, leverage), deletion test e interfaces testáveis — a melhor skill de arquitetura de código da varredura.',
    hint: 'Use when designing module boundaries or judging code structure — deep-module vocabulary and the deletion test.'
  },
  {
    id: 'domain-modeling',
    kind: 'skill',
    depts: ['back', 'research', 'data'],
    group: 'arquitetura & domínio',
    source: { repo: 'mattpocock/skills', path: 'skills/engineering/domain-modeling', ref: 'main' },
    summary:
      'Modelagem de domínio: desafiar terminologia imprecisa contra glossário, stress-test de relações com cenários de borda, ADRs capturados na hora.',
    hint: 'Use when the domain language is fuzzy or entities/relations need stress-testing before implementation.'
  },
  {
    id: 'architecture-patterns',
    kind: 'skill',
    depts: ['back'],
    group: 'arquitetura & domínio',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/backend-development/skills/architecture-patterns',
      ref: 'main'
    },
    summary:
      'Clean/Hexagonal/DDD tático com regras de dependência explícitas, adapter de teste in-memory completo e troubleshooting de imports circulares e contaminação por decorator de framework.',
    hint: 'Use when structuring a service (layers, ports/adapters, DDD) or untangling circular imports and framework leakage.'
  },

  // ——— debugging ———
  {
    id: 'diagnosing-bugs',
    kind: 'skill',
    depts: ['back'],
    group: 'debugging',
    source: { repo: 'mattpocock/skills', path: 'skills/engineering/diagnosing-bugs', ref: 'main' },
    summary:
      'Loop de diagnóstico em 6 fases que começa por construir um feedback loop apertado ANTES de hipóteses, com instrumentação, teste de regressão e post-mortem (template de script incluso).',
    hint: 'Use when investigating a bug — builds the tight feedback loop first, then instruments and proves the root cause.'
  },
  {
    id: 'systematic-debugging',
    kind: 'skill',
    depts: ['front', 'back', 'qa'],
    group: 'debugging',
    source: { repo: 'obra/superpowers', path: 'skills/systematic-debugging', ref: 'main' },
    summary:
      'Debugging em 4 fases (reprodução → evidência → hipótese → fix com teste); proíbe guess-and-check e fix de sintoma; inclui root-cause tracing e defense-in-depth.',
    hint: 'Use when a bug resists quick fixes — forbids guess-and-check; evidence-first root-cause methodology.',
    requires: ['test-driven-development', 'verification-before-completion']
  },
  {
    id: 'debugging-code',
    kind: 'skill',
    depts: ['back'],
    group: 'debugging',
    source: { repo: 'AlmogBaku/debug-skill', path: 'skills/debugging-code', ref: 'master' },
    summary:
      'Dá ao agente um DEBUGGER de verdade via Debug Adapter Protocol: breakpoints, stepping, inspeção de variáveis — em vez de printf. Exige o CLI `dap` + adapter da linguagem (debugpy, Delve, js-debug).',
    hint: 'Use for hard runtime bugs when the dap CLI is available — real breakpoints and variable inspection instead of print statements.'
  },

  // ——— api & serviços ———
  {
    id: 'api-design-principles',
    kind: 'skill',
    depts: ['back'],
    group: 'api & serviços',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/backend-development/skills/api-design-principles',
      ref: 'main'
    },
    summary:
      'O guia REST/GraphQL central: semântica HTTP por método, versionamento com exemplos, plural para coleções, anti-padrões GraphQL (N+1).',
    hint: 'Use when designing or reviewing any API surface — REST semantics, versioning, GraphQL anti-patterns.'
  },
  {
    id: 'nodejs-backend-patterns',
    kind: 'skill',
    depts: ['back'],
    group: 'api & serviços',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/javascript-typescript/skills/nodejs-backend-patterns',
      ref: 'main'
    },
    summary:
      'O guia Node/TS backend: camadas controller/service/repository, middleware de auth/validação/rate-limit, error classes, pooling e caching — ~2k linhas de código real nas referências.',
    hint: 'Use when building Node/TypeScript backend services — layering, middleware, error handling, pooling, caching.'
  },
  {
    id: 'node',
    kind: 'skill',
    depts: ['back'],
    group: 'api & serviços',
    source: { repo: 'mcollina/skills', path: 'skills/node', ref: 'main' },
    summary:
      'Best practices de Node.js do Matteo Collina (criador do Fastify, Node TSC): type stripping nativo, graceful shutdown, classificação de erros, streams com backpressure, profiling.',
    hint: 'Use for Node.js runtime concerns — shutdown, error classes, streams/backpressure, profiling — from a Node TSC member.'
  },
  {
    id: 'fastify-best-practices',
    kind: 'skill',
    depts: ['back'],
    group: 'api & serviços',
    source: { repo: 'mcollina/skills', path: 'skills/fastify', ref: 'main' },
    summary:
      'Fastify pelo próprio criador: ciclo de vida completo (hooks, serialização, Pino), plugins, validação JSON Schema, auth, CORS, WebSockets, deploy.',
    hint: 'Use when the project uses Fastify — lifecycle, plugins, schema validation and deployment done right.'
  },
  {
    id: 'nestjs-expert',
    kind: 'skill',
    depts: ['back'],
    group: 'api & serviços',
    source: { repo: 'Jeffallan/claude-skills', path: 'skills/nestjs-expert', ref: 'main' },
    summary:
      'NestJS estruturado: módulos/controllers/services/DTOs/guards/interceptors com exemplos completos (TypeORM, DI, validação) e prevenção de dependência circular.',
    hint: 'Use when the project uses NestJS — module architecture, DI, guards/interceptors, circular-dependency prevention.'
  },
  {
    id: 'mcp-builder',
    kind: 'skill',
    depts: ['back'],
    group: 'api & serviços',
    source: { repo: 'anthropics/skills', path: 'skills/mcp-builder', ref: 'main' },
    summary:
      'Oficial da Anthropic: construir servidores MCP em 4 fases (pesquisa → implementação → review → avaliações), princípios de tool design, guias Node e Python.',
    hint: 'Use when building or extending an MCP server — official methodology, tool-design principles, Node/Python guides.'
  },
  {
    id: 'temporal-developer',
    kind: 'skill',
    depts: ['back'],
    group: 'api & serviços',
    source: { repo: 'temporalio/skill-temporal-developer', path: '', ref: 'main' },
    summary:
      'Skill oficial da Temporal (durable execution): workflows, activities, workers, erros de não-determinismo, signals/queries, versioning e saga em 7 SDKs.',
    hint: 'Use when the project uses Temporal or needs durable workflows/sagas — official guidance across 7 SDKs.'
  },
  {
    id: 'stripe-best-practices',
    kind: 'skill',
    depts: ['back'],
    group: 'api & serviços',
    source: { repo: 'stripe/ai', path: 'skills/stripe-best-practices', ref: 'main' },
    summary:
      'Stripe oficial: seleção de API (Checkout vs PaymentIntents), billing, webhooks, restricted keys e migração de APIs deprecadas — sincronizada da doc oficial.',
    hint: 'Use when integrating payments with Stripe — correct API selection, webhooks and key security.'
  },
  {
    id: 'workers-best-practices',
    kind: 'skill',
    depts: ['back'],
    group: 'api & serviços',
    source: { repo: 'cloudflare/skills', path: 'skills/workers-best-practices', ref: 'main' },
    summary:
      'Cloudflare Workers oficial: 40+ regras e 15+ anti-padrões (streaming, floating promises, secrets, bindings, observability) + wrangler.jsonc.',
    hint: 'Use when building on Cloudflare Workers/edge — rules and anti-patterns from the vendor.'
  },

  // ——— auth & segurança ———
  {
    id: 'oauth',
    kind: 'skill',
    depts: ['back', 'cyber'],
    group: 'auth & segurança',
    source: { repo: 'mcollina/skills', path: 'skills/oauth', ref: 'main' },
    summary:
      'OAuth 2.0/2.1 na prática: authorization code + PKCE, client credentials, device flow, rotação de refresh token, validação JWT — compliance RFC com checklist de segurança.',
    hint: 'Use when implementing OAuth/JWT auth flows — PKCE, refresh rotation, token validation per the RFCs.'
  },
  {
    id: 'security-best-practices',
    kind: 'skill',
    depts: ['back', 'cyber'],
    group: 'auth & segurança',
    source: { repo: 'openai/skills', path: 'skills/.curated/security-best-practices', ref: 'main' },
    summary:
      'Código secure-by-default + detecção passiva de vulnerabilidade + relatório com severidades, com referências por stack (Python, JS/TS, Go). A skill forte de segurança de API da varredura.',
    hint: 'Use when writing security-sensitive backend code or reviewing for vulnerabilities — per-stack secure defaults.'
  },
  {
    id: 'owasp-security',
    kind: 'skill',
    depts: ['back', 'cyber'],
    group: 'auth & segurança',
    source: { repo: 'agamm/claude-code-owasp', path: '.claude/skills/owasp-security', ref: 'main' },
    summary:
      'OWASP Top 10:2025 + ASVS 5.0 + LLM Top 10: rubrica de triagem de findings e checklists de review com exemplos unsafe/safe em 20+ linguagens.',
    hint: 'Use for an OWASP-grounded security review of backend code — triage rubric and per-language unsafe/safe pairs.',
    defaultFor: ['cyber']
  },
  {
    id: 'secrets-management',
    kind: 'skill',
    depts: ['back', 'cyber'],
    group: 'auth & segurança',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/cicd-automation/skills/secrets-management',
      ref: 'main'
    },
    summary:
      'Segredos de ponta a ponta: Vault com comandos reais, GitHub Actions/GitLab CI configs, Terraform para AWS Secrets Manager e rotação automatizada.',
    hint: 'Use when wiring secrets into CI/CD or infra — Vault, platform secret stores, rotation.'
  },

  // ——— typescript & python ———
  {
    id: 'typescript-advanced-types',
    kind: 'skill',
    depts: ['back'],
    group: 'typescript & python',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/javascript-typescript/skills/typescript-advanced-types',
      ref: 'main'
    },
    summary:
      'Sistema de tipos avançado com código executável: generics com constraints, conditional types com infer, mapped types, template literals, discriminated unions.',
    hint: 'Use when modeling complex TypeScript types — generics, conditional/mapped types, discriminated unions.'
  },
  {
    id: 'fastapi-templates',
    kind: 'skill',
    depts: ['back'],
    group: 'typescript & python',
    source: { repo: 'wshobson/agents', path: 'plugins/api-scaffolding/skills/fastapi-templates', ref: 'main' },
    summary:
      'FastAPI de produção: estrutura de pastas, padrões async, dependency injection e testes reais com pytest + AsyncClient.',
    hint: 'Use when building Python APIs with FastAPI — production structure, async patterns, DI, tests.'
  },
  {
    id: 'python-testing-patterns',
    kind: 'skill',
    depts: ['back', 'qa'],
    group: 'typescript & python',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/python-development/skills/python-testing-patterns',
      ref: 'main'
    },
    summary: 'pytest a fundo: AAA, fixtures, mocking com side effects, freezegun para tempo, markers.',
    hint: 'Use when writing or fixing Python tests — pytest fixtures, mocking, time control.'
  },
  {
    id: 'async-python-patterns',
    kind: 'skill',
    depts: ['back'],
    group: 'typescript & python',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/python-development/skills/async-python-patterns',
      ref: 'main'
    },
    summary:
      'asyncio com código: gather, tasks, error handling, timeouts, tabela de decisão sync vs async, context managers e iterators async.',
    hint: 'Use when writing or reviewing async Python — correct task/error/timeout patterns.'
  },
  {
    id: 'python-project-structure',
    kind: 'skill',
    depts: ['back'],
    group: 'typescript & python',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/python-development/skills/python-project-structure',
      ref: 'main'
    },
    summary: 'Organização de projeto Python: template quick-start, 7 padrões com código, API pública via __all__, convenções de nomes.',
    hint: 'Use when creating or restructuring a Python project — layout, public API, naming.'
  },

  // ——— banco de dados ———
  {
    id: 'supabase-postgres-best-practices',
    kind: 'skill',
    depts: ['back', 'data'],
    group: 'banco de dados',
    source: {
      repo: 'supabase/agent-skills',
      path: 'skills/supabase-postgres-best-practices',
      ref: 'main'
    },
    summary:
      'O canônico de Postgres (a skill de banco mais instalada do mercado): otimização em 8 categorias priorizadas por impacto, cada regra com SQL incorreto vs correto e análise de query plan. Vale fora do Supabase.',
    hint: 'Use for any Postgres work — impact-ranked optimization rules with wrong/right SQL pairs (works beyond Supabase).',
    defaultFor: ['back']
  },
  {
    id: 'postgresql-table-design',
    kind: 'skill',
    depts: ['back', 'data'],
    group: 'banco de dados',
    source: { repo: 'wshobson/agents', path: 'plugins/database-design/skills/postgresql', ref: 'main' },
    summary:
      'Design de schema Postgres com opinião: BIGINT IDENTITY > UUID, "Postgres NÃO auto-indexa FK", JSONB trade-offs, particionamento >100M linhas, evolução segura de schema.',
    hint: 'Use when designing or evolving Postgres schemas — types, FK indexing, JSONB, partitioning thresholds.'
  },
  {
    id: 'prisma-client-api',
    kind: 'skill',
    depts: ['back'],
    group: 'banco de dados',
    source: { repo: 'prisma/skills', path: 'prisma-client-api', ref: 'main' },
    summary:
      'Referência oficial do Prisma Client: 17 métodos de query, filtros, operadores, transações e raw SQL em 8 categorias com exemplos.',
    hint: 'Use when the project uses Prisma — correct client API usage for queries, transactions, raw SQL.'
  },
  {
    id: 'redis-core',
    kind: 'skill',
    depts: ['back'],
    group: 'banco de dados',
    source: { repo: 'redis/agent-skills', path: 'skills/redis-core', ref: 'main' },
    summary:
      'Redis oficial: escolha da estrutura certa (String/Hash/JSON/Stream/Sorted Set/Vector) e key naming hierárquico — a base de caching e filas.',
    hint: 'Use when adding caching/queues with Redis — pick the right data structure and key scheme.'
  },

  // ——— testes avançados ———
  {
    id: 'property-based-testing',
    kind: 'skill',
    depts: ['back', 'qa', 'cyber'],
    group: 'testes avançados',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/property-based-testing/skills/property-based-testing',
      ref: 'main'
    },
    summary:
      'Property-based testing pela Trail of Bits: árvore de decisão de quando aplicar, catálogo de propriedades com hierarquia de força, padrões (serialização/parsing/validação) que pedem PBT. Licença CC-BY-SA.',
    hint: 'Use when unit tests are not enough — find the properties (round-trips, invariants) and generate the tests.'
  },

  // ——— devops · ci/cd · iac ———
  {
    id: 'deployment-pipeline-design',
    kind: 'skill',
    depts: ['back'],
    group: 'devops · ci/cd · iac',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/cicd-automation/skills/deployment-pipeline-design',
      ref: 'main'
    },
    summary:
      'Pipelines multi-estágio com gates de aprovação, canary com análise automática, troubleshooting real (health check passa no CI e falha em prod) e migração backward-compatible.',
    hint: 'Use when designing or fixing deployment pipelines — stages, gates, canary, safe migrations.'
  },
  {
    id: 'github-actions-templates',
    kind: 'skill',
    depts: ['back'],
    group: 'devops · ci/cd · iac',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/cicd-automation/skills/github-actions-templates',
      ref: 'main'
    },
    summary:
      '4 workflows YAML completos (test, build/push Docker, deploy K8s, matrix), reusable workflows e security scanning com trivy.',
    hint: 'Use when writing GitHub Actions workflows — complete, working YAML templates to adapt.'
  },
  {
    id: 'terraform-style-guide',
    kind: 'skill',
    depts: ['back'],
    group: 'devops · ci/cd · iac',
    source: {
      repo: 'hashicorp/agent-skills',
      path: 'terraform/code-generation/skills/terraform-style-guide',
      ref: 'main'
    },
    summary:
      'Convenções OFICIAIS da HashiCorp para HCL: organização de arquivos, naming, formatação, segurança e checklist de review. Licença MPL-2.0.',
    hint: 'Use when writing Terraform — the official style and review checklist from HashiCorp.'
  },
  {
    id: 'terraform-skill',
    kind: 'skill',
    depts: ['back'],
    group: 'devops · ci/cd · iac',
    source: { repo: 'antonbabenko/terraform-skill', path: 'skills/terraform-skill', ref: 'master' },
    summary:
      'Terraform operacional (AWS Hero, mantenedor do terraform-aws-modules): roteamento sintoma→referência (state corruption, blast radius, secrets), contrato com validação e rollback, testing e CI.',
    hint: 'Use when diagnosing or hardening Terraform operations — symptom-first troubleshooting and safe rollout.'
  },
  {
    id: 'slo-implementation',
    kind: 'skill',
    depts: ['back'],
    group: 'devops · ci/cd · iac',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/observability-monitoring/skills/slo-implementation',
      ref: 'main'
    },
    summary:
      'Observabilidade por SLO: PromQL real para SLIs de availability/latência, política de error budget com limiares de decisão e alertas multi-window (fast/slow burn).',
    hint: 'Use when defining SLOs/alerts or building observability — real PromQL and error-budget policy.'
  },

  // ——— SUBAGENTES de mercado (rodada back, 2026-07-29) — 9 verificados na
  // fonte (frontmatter name == id, tools reais; VoltAgent caiu INTEIRA de
  // novo: a maquinaria fictícia é "context manager" SEM hífen no corpo —
  // grep por "context-manager" dá falso negativo). Anthropic feature-dev/
  // pr-review-toolkit seguem a licença Commercial ToS do agent-creator
  // (uso com Claude Code ok; nunca redistribuir). ———
  {
    id: 'pragmatic-code-review',
    kind: 'agent',
    depts: ['back', 'qa', 'cyber'],
    group: 'subagentes especializados',
    source: {
      repo: 'OneRedOak/claude-code-workflows',
      path: 'code-review/pragmatic-code-review-subagent.md'
    },
    summary:
      'O code review de backend do mercado (irmão do design-review): framework "Net Positive > Perfection", checklist de 7 categorias priorizadas (segurança non-negotiable), triage Critical/Improvement/Nit.',
    hint: 'Delegate a pragmatic full code review of a diff/feature to this specialist before the gate — prioritized checklist with triage.'
  },
  {
    id: 'silent-failure-hunter',
    kind: 'agent',
    depts: ['back', 'qa'],
    group: 'subagentes especializados',
    source: {
      repo: 'anthropics/claude-code',
      path: 'plugins/pr-review-toolkit/agents/silent-failure-hunter.md',
      ref: 'main'
    },
    summary:
      'Auditor de error-handling sem paralelo no mercado: 5 regras não-negociáveis ("catch vazio = proibido"), baterias de perguntas por categoria (logging, fallbacks, propagação), severidade CRITICAL/HIGH/MEDIUM. Nota: a seção final cita convenções internas do repo do Claude Code — ignorar nomes de arquivos que não existirem no projeto.',
    hint: 'Delegate hunting swallowed errors / empty catches / silent fallbacks across changed code to this auditor.'
  },
  {
    id: 'pr-test-analyzer',
    kind: 'agent',
    depts: ['back', 'qa'],
    group: 'subagentes especializados',
    source: {
      repo: 'anthropics/claude-code',
      path: 'plugins/pr-review-toolkit/agents/pr-test-analyzer.md',
      ref: 'main'
    },
    summary:
      'Análise de cobertura COMPORTAMENTAL (não line coverage): criticidade 1–10 por faixa concreta, caça teste frágil acoplado a implementação, anti-pedantismo explícito.',
    hint: 'Delegate reviewing whether the tests of a change actually cover the behaviors that matter (not line %).'
  },
  {
    id: 'code-architect',
    kind: 'agent',
    depts: ['back'],
    group: 'subagentes especializados',
    source: {
      repo: 'anthropics/claude-code',
      path: 'plugins/feature-dev/agents/code-architect.md',
      ref: 'main'
    },
    summary:
      'Arquitetura orientada ao código EXISTENTE: padrões do codebase (file:line) → decisão decisiva (sem menu de opções) → blueprint arquivo-a-arquivo com sequência de build.',
    hint: 'Delegate designing how a feature integrates into the existing codebase — returns a file-by-file implementation blueprint.'
  },
  {
    id: 'api-architect',
    kind: 'agent',
    depts: ['back'],
    group: 'subagentes especializados',
    source: {
      repo: 'vijaythecoder/awesome-claude-agents',
      path: 'agents/universal/api-architect.md'
    },
    summary:
      'Arquiteto de contratos de API agnóstico de framework: OpenAPI 3.1/GraphQL, RFC 9457 (problem+json), entrega openapi.yaml + guidelines e valida com spectral.',
    hint: 'Delegate designing or formalizing an API contract (OpenAPI/GraphQL) to this specialist — deliverable-first.'
  },
  {
    id: 'incident-responder',
    kind: 'agent',
    depts: ['back', 'cyber'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/incident-response/agents/incident-responder.md',
      ref: 'main'
    },
    summary:
      'Resposta a incidente com valores duros: primeiros 5 minutos em 3 passos, classificação P0–P3 com SLAs concretos (P0: ack <15min), post-mortem blameless — a exceção de qualidade do wshobson.',
    hint: 'Delegate triaging a production incident (outage, data issue, sev classification, comms cadence) to this responder.'
  },
  {
    id: 'backend-developer',
    kind: 'agent',
    depts: ['back'],
    group: 'subagentes especializados',
    source: {
      repo: 'vijaythecoder/awesome-claude-agents',
      path: 'agents/universal/backend-developer.md'
    },
    summary:
      'Implementador backend poliglota: detecção de stack por lockfile, heurísticas com valor ("functions <40 lines", validar todo input externo), Implementation Report e Definition of Done obrigatórios.',
    hint: 'Delegate a self-contained backend implementation chunk (any stack) to this generalist — detects the stack and reports.'
  },
  {
    id: 'performance-optimizer',
    kind: 'agent',
    depts: ['back', 'data'],
    group: 'subagentes especializados',
    source: {
      repo: 'vijaythecoder/awesome-claude-agents',
      path: 'agents/core/performance-optimizer.md'
    },
    summary:
      'Perf com dogma measure-first: baseline P50/P95 + custo → profile → fix do maior gargalo → verificação com meta ≥2x no caminho mais lento; report Before/After/Δ.',
    hint: 'Delegate a backend performance pass (slow endpoint/job/query) — measures first, fixes the top bottleneck, proves the gain.'
  },
  {
    id: 'debugger',
    kind: 'agent',
    depts: ['back'],
    group: 'subagentes especializados',
    source: {
      repo: 'lst97/claude-code-sub-agents',
      path: 'agents/quality-testing/debugger.md',
      ref: 'main'
    },
    summary:
      'Debugger de 3 fases (triage/reproduzir → hipótese-teste-refina → fix mínimo verificado), saída com fix em formato DIFF e proibições explícitas ("No New Features", não tratar sintoma).',
    hint: 'Delegate isolating and fixing a reproducible bug — minimal verified fix, no scope creep.'
  },

  // ————————————————————————————————————————————————————————————————————————
  // RODADA 4: QA (2026-07-29). Além das novas abaixo, skills/agents das
  // rodadas front/back que servem ao GATE ganharam 'qa' nos depts (re-tags —
  // regra do usuário: a rodada da função adiciona o dept dela). Armadilhas:
  // EveryInc RENOMEOU o repo (compound-engineering → -plugin) e os 17
  // reviewers viraram personas DENTRO de ce-code-review; mutation-testing da
  // trailofbits COLIDE de id com a da secondsky (a secondsky entrou: Stryker
  // TS/JS + mutmut Python servem o stack web; mewt não); microsoft/skills
  // mora em .github/skills/. Trio playwright oficial: bundled TRADUZIDO em
  // agentsBundled.ts + MCP playwright-test injetado pelo main (condicional a
  // projeto com Playwright — ver mcpPaneArgs).
  // ————————————————————————————————————————————————————————————————————————

  // ——— review de código (gate) ———
  {
    id: 'code-review',
    kind: 'skill',
    depts: ['qa'],
    group: 'review de código (gate)',
    source: { repo: 'mattpocock/skills', path: 'skills/engineering/code-review', ref: 'main' },
    summary:
      'O motor de gate de review: dois eixos em paralelo — STANDARDS (convenções do repo + ~12 smells de Fowler nomeados) e SPEC (fidelidade à origem do card) — agregados sem re-rankear.',
    hint: 'Use as the review-gate engine on a diff: standards axis + spec-fidelity axis, aggregated without cross-ranking.',
    defaultFor: ['qa']
  },
  {
    id: 'code-review-and-quality',
    kind: 'skill',
    depts: ['qa'],
    group: 'review de código (gate)',
    source: { repo: 'addyosmani/agent-skills', path: 'skills/code-review-and-quality', ref: 'main' },
    summary:
      'A rubrica do review: 5 eixos (correção, legibilidade, arquitetura, segurança, performance) com severidade Critical/Nit/FYI, alvos de tamanho (~100 linhas ideal) e red flags de processo ("LGTM" sem evidência).',
    hint: 'Use as the review rubric: severity labels, size targets and process red flags to grade a change consistently.',
    defaultFor: ['qa']
  },
  {
    id: 'ce-code-review',
    kind: 'skill',
    depts: ['qa'],
    group: 'review de código (gate)',
    source: { repo: 'EveryInc/compound-engineering-plugin', path: 'skills/ce-code-review', ref: 'main' },
    summary:
      'O pipeline de review mais completo do mercado (evolução dos 17 reviewers da Every): escopo por estado do git, SELEÇÃO de personas por sinal de risco do diff, dispatch paralelo com schema JSON de findings, síntese com dedupe e P0–P3. Report-only por padrão.',
    hint: 'Use for a deep multi-persona review of a risky diff — persona selection by risk signals, parallel dispatch, deduped P0-P3 synthesis.'
  },

  // ——— teste ao vivo (browser) ———
  {
    id: 'webapp-testing',
    kind: 'skill',
    depts: ['qa'],
    group: 'teste ao vivo (browser)',
    source: { repo: 'anthropics/skills', path: 'skills/webapp-testing', ref: 'main' },
    summary:
      'O loop de QA ao vivo oficial da Anthropic: Python+Playwright com gestão de ciclo de vida de servidores (with_server.py), descoberta de seletores, captura de console — roda local (exige Python + playwright + Chromium).',
    hint: 'Use to live-test a local web app end-to-end (start servers, drive the browser, capture console) — requires Python with playwright installed.',
    manualOnly: true,
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell', 'browser']
  },
  {
    id: 'playwright-cli',
    kind: 'skill',
    depts: ['qa'],
    group: 'teste ao vivo (browser)',
    source: { repo: 'microsoft/playwright-cli', path: 'skills/playwright-cli', ref: 'main' },
    summary:
      'A skill OFICIAL da Microsoft para dirigir browser via CLI: 40+ comandos (click/type/forms/tabs/snapshot/screenshot, mock de rede, tracing, vídeo) com 9 docs de referência. Exige @playwright/cli global.',
    hint: 'Use to drive a real browser from the shell (clicks, forms, network mocks, traces) via the official playwright-cli.'
  },
  {
    id: 'playwright-best-practices',
    kind: 'skill',
    depts: ['qa'],
    group: 'teste ao vivo (browser)',
    source: { repo: 'currents-dev/playwright-best-practices-skill', path: 'playwright-best-practices', ref: 'main' },
    summary:
      'A enciclopédia Playwright (Currents, vendor de CI para Playwright): 57 docs em 8 áreas — flaky, visual, a11y com axe, POM, auth, CI — com decision tree e loop de validação real.',
    hint: 'Use when writing or fixing Playwright tests — comprehensive best-practice references with a validation loop.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell', 'browser']
  },
  {
    id: 'exploratory-testing',
    kind: 'skill',
    depts: ['qa'],
    group: 'teste ao vivo (browser)',
    source: { repo: 'petrkindlmann/qa-skills', path: 'skills/exploratory-testing', ref: 'main' },
    summary:
      'Testing exploratório SBTM operacionalizado: charters, sessões time-boxed (15min orientar → 40 explorar → 20 bordas/erros → 15 documentar), 7 oráculos de bug e pipeline exploração→automação.',
    hint: 'Use for a charter-driven exploratory session on a feature — time-boxed, oracle-based bug recognition, findings feed automation.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'browser']
  },

  // ——— autoria de testes ———
  {
    id: 'vitest',
    kind: 'skill',
    depts: ['qa'],
    group: 'autoria de testes',
    source: { repo: 'antfu/skills', path: 'skills/vitest', ref: 'main' },
    summary:
      'Referência Vitest 5.x mantida pelo Anthony Fu (lead do Vitest — semi-oficial): mocking, snapshots, coverage, fixtures, benchmarks.',
    hint: 'Use when authoring or fixing unit tests with Vitest — current API reference from the project lead.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell']
  },
  {
    id: 'api-testing',
    kind: 'skill',
    depts: ['qa'],
    group: 'autoria de testes',
    source: { repo: 'petrkindlmann/qa-skills', path: 'skills/api-testing', ref: 'main' },
    summary: 'Testes de API: APIRequestContext/Supertest, validação de schema com Zod/AJV, auth, ciclo CRUD, paginação.',
    hint: 'Use when writing API-level tests — request contexts, schema validation, auth flows, CRUD lifecycles.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell']
  },
  {
    id: 'contract-testing',
    kind: 'skill',
    depts: ['qa'],
    group: 'autoria de testes',
    source: { repo: 'petrkindlmann/qa-skills', path: 'skills/contract-testing', ref: 'main' },
    summary:
      'Contract testing neutro: Pact-JS v16, broker, can-i-deploy, message pacts e alternativa schema-first (OpenAPI/Ajv/Schemathesis).',
    hint: 'Use when services need consumer-driven or schema-first contract tests (Pact or OpenAPI-based).',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell']
  },
  {
    id: 'visual-testing',
    kind: 'skill',
    depts: ['qa'],
    group: 'autoria de testes',
    source: { repo: 'petrkindlmann/qa-skills', path: 'skills/visual-testing', ref: 'main' },
    summary:
      'Regressão visual: toHaveScreenshot vs serviços (Chromatic/Percy/Argos), máscara de conteúdo dinâmico, baselines só em Docker de CI, tuning de thresholds.',
    hint: 'Use when adding or stabilizing visual-regression tests — baseline discipline and dynamic-content masking.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell', 'browser']
  },
  {
    id: 'cypress-author',
    kind: 'skill',
    depts: ['qa'],
    group: 'autoria de testes',
    source: { repo: 'cypress-io/ai-toolkit', path: 'skills/cypress-author', ref: 'main' },
    summary: 'Oficial do Cypress: criar/atualizar/consertar testes E2E e de componente com subskills de tarefa.',
    hint: 'Use when the project tests with Cypress — official authoring workflow.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell', 'browser']
  },
  {
    id: 'cypress-explain',
    kind: 'skill',
    depts: ['qa'],
    group: 'autoria de testes',
    source: { repo: 'cypress-io/ai-toolkit', path: 'skills/cypress-explain', ref: 'main' },
    summary: 'Oficial do Cypress: explicar/revisar/criticar testes SEM alterar código — o lado gate do kit.',
    hint: 'Use to review or critique existing Cypress tests without modifying them.'
  },

  // ——— saúde da suíte ———
  {
    id: 'test-reliability',
    kind: 'skill',
    depts: ['qa'],
    group: 'saúde da suíte',
    source: { repo: 'petrkindlmann/qa-skills', path: 'skills/test-reliability', ref: 'main' },
    summary:
      'A melhor skill de flaky da varredura: 7 categorias de flake com decision tree, healing multi-atributo, quarentena e auto-repair com score de confiança.',
    hint: 'Use when tests are flaky — classify the flake mechanism, heal or quarantine with confidence scoring.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell']
  },
  {
    id: 'selector-drift-recovery',
    kind: 'skill',
    depts: ['qa'],
    group: 'saúde da suíte',
    source: { repo: 'petrkindlmann/qa-skills', path: 'skills/selector-drift-recovery', ref: 'main' },
    summary:
      'Recuperação EM LOTE de seletores após refactor de UI: aria-snapshots pareados, candidatos rankeados por rubrica 0–5 (aplica só ≥3), validação da suíte inteira, PR revisável com screenshots.',
    hint: 'Use after a UI refactor breaks many selectors — batch-regenerate with a stability rubric and human-reviewable evidence.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell', 'browser']
  },
  {
    id: 'coverage-analysis',
    kind: 'skill',
    depts: ['qa'],
    group: 'saúde da suíte',
    source: { repo: 'petrkindlmann/qa-skills', path: 'skills/coverage-analysis', ref: 'main' },
    summary:
      'Cobertura com juízo: ratchet no CI, diff de coverage por PR, mutation para qualidade de asserção, "meaningful vs vanity coverage".',
    hint: 'Use to judge and improve what coverage MEANS — ratchets, per-PR diffs, assertion quality.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell']
  },
  {
    id: 'mutation-testing',
    kind: 'skill',
    depts: ['qa'],
    group: 'saúde da suíte',
    source: { repo: 'secondsky/claude-skills', path: 'plugins/mutation-testing/skills/mutation-testing', ref: 'main' },
    summary:
      'Mutation testing no stack web: Stryker (TS/JS com Vitest) + mutmut (Python), runs incrementais, leitura de killed/survived, alvo 80%+.',
    hint: 'Use to judge test-suite strength with mutation testing (Stryker/mutmut) — surviving mutants = weak tests.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell']
  },

  // ——— acessibilidade (gate) ———
  {
    id: 'wcag-audit-patterns',
    kind: 'skill',
    depts: ['qa'],
    group: 'acessibilidade (gate)',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/accessibility-compliance/skills/wcag-audit-patterns',
      ref: 'main'
    },
    summary:
      'Auditoria WCAG 2.2 por POUR e níveis A/AA/AAA, severidade em 3 camadas, honestidade sobre automação (pega 30-50%) e remediação orientada.',
    hint: 'Use to run a structured WCAG 2.2 audit with severity tiers and a remediation plan.'
  },
  {
    id: 'screen-reader-testing',
    kind: 'skill',
    depts: ['qa'],
    group: 'acessibilidade (gate)',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/accessibility-compliance/skills/screen-reader-testing',
      ref: 'main'
    },
    summary:
      'Teste com leitores de tela DE VERDADE: roteiros NVDA/VoiceOver passo a passo, browse vs focus mode, cenários prontos (modal com focus trap, live regions) — único no gênero.',
    hint: 'Use to test flows with real screen readers (NVDA/VoiceOver scripts) — the manual half automation cannot cover.'
  },
  {
    id: 'accessibility-testing',
    kind: 'skill',
    depts: ['qa'],
    group: 'acessibilidade (gate)',
    source: { repo: 'petrkindlmann/qa-skills', path: 'skills/accessibility-testing', ref: 'main' },
    summary:
      'A11y INTEGRADA à suíte: axe-core no Playwright + auditoria de teclado + AT real, thresholds concretos (4.5:1, 24×24px), gate que não aceita "axe passou" como aprovação.',
    hint: 'Use to wire accessibility checks INTO the test suite (axe-core + keyboard + AT) and gate releases on both.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell', 'browser']
  },

  // ——— debugging & regressão / gate visual / performance ———
  {
    id: 'debugging-and-error-recovery',
    kind: 'skill',
    depts: ['qa'],
    group: 'debugging & regressão',
    source: { repo: 'addyosmani/agent-skills', path: 'skills/debugging-and-error-recovery', ref: 'main' },
    summary:
      'Recuperação sistemática de falha em 6 passos com checklist por camada (UI/API/DB/build), padrões de teste flaky, git bisect para regressões — single-file, zero dependências.',
    hint: 'Use when hunting a regression or recovering from a failure — layer triage, minimal repro, bisect, guard test.'
  },
  {
    id: 'frontend-design-review',
    kind: 'skill',
    depts: ['qa', 'design'],
    group: 'gate visual',
    source: { repo: 'microsoft/skills', path: '.github/skills/frontend-design-review', ref: 'main' },
    summary:
      'Review de UI da Microsoft contra design system + 3 pilares (tarefa em ≤3 interações, WCAG 2.1 AA como nota mínima, erros acionáveis) — o gate de "quebrou a identidade = reprova".',
    hint: 'Use to review an implemented UI against the design system and interaction-quality pillars before approving.'
  },
  {
    id: 'k6',
    kind: 'skill',
    depts: ['qa'],
    group: 'performance & carga',
    source: { repo: 'grafana/skills', path: 'skills/grafana-k6/k6', ref: 'main' },
    summary:
      'Load testing oficial da Grafana: gera/valida/revisa scripts k6 (load/stress/spike/soak, HTTP/WS/gRPC/browser, thresholds) com validação real via k6 run.',
    hint: 'Use to author and validate k6 load-test scripts against SLAs — requires the k6 binary.',
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell']
  },

  // ——— SUBAGENTES de mercado (rodada qa) ———
  {
    id: 'comment-analyzer',
    kind: 'agent',
    depts: ['qa'],
    group: 'subagentes especializados',
    source: {
      repo: 'anthropics/claude-code',
      path: 'plugins/pr-review-toolkit/agents/comment-analyzer.md',
      ref: 'main'
    },
    summary:
      'Caça comment rot num diff: accuracy factual cruzada com o código, completude, valor de longo prazo — análise apenas, nunca edita (Anthropic, irmão dos outros 3 do pr-review-toolkit).',
    hint: 'Delegate auditing the comments/docs of a change for accuracy and rot — report-only.'
  },
  {
    id: 'code-review-preshipment',
    kind: 'agent',
    depts: ['qa'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/operating-kit/agents/code-review-preshipment.md',
      ref: 'main'
    },
    summary:
      'O melhor gate pré-merge do mercado: checklist de 10 seções com valores concretos (off-by-one, falsy 0/"", ms vs s, read-modify-write), veredito SHIP / SHIP WITH FIXES / DO NOT SHIP. Tem placeholders {{…}} de template — infira do contexto quando não preenchidos.',
    hint: 'Delegate a final pre-merge walk of the change — 10-section concrete checklist ending in an explicit SHIP verdict.'
  },
  {
    id: 'team-debugger',
    kind: 'agent',
    depts: ['qa'],
    group: 'subagentes especializados',
    source: { repo: 'wshobson/agents', path: 'plugins/agent-teams/agents/team-debugger.md', ref: 'main' },
    summary:
      'Investigação de UMA hipótese com falseabilidade: critérios de confirmação/refutação definidos ANTES de olhar código, confiança por faixas (>80% / 50-80% / <50%), evidência contrária obrigatória, resultado negativo é achado válido.',
    hint: 'Delegate testing ONE bug hypothesis with falsifiability criteria — cited evidence either way, negative results welcome.'
  },

  // ————————————————————————————————————————————————————————————————————————
  // RODADA 5: DESIGN (2026-07-29). Além das novas abaixo, 12 skills e 3
  // agents das rodadas anteriores ganharam 'design' (re-tags; create-design-md
  // virou ★ como anotado na rodada front). Armadilhas: taste-skill soma 6
  // pastas ≠ name; Remotion OFICIAL e o excalidraw líder (coleam00) estão SEM
  // LICENÇA (fora até licenciarem); ecossistema Figma inteiro (oficial +
  // southleft endossada) = licença proprietária/Figma MCP que o strict não
  // injeta — pendência única; Stitch tem name com `::` (filename ilegal no
  // Windows). Descartes completos em docs/SKILLS.md.
  // ————————————————————————————————————————————————————————————————————————

  // ——— direção visual & linguagens ———
  {
    id: 'canvas-design',
    kind: 'skill',
    depts: ['design'],
    group: 'direção visual & linguagens',
    source: { repo: 'anthropics/skills', path: 'skills/canvas-design', ref: 'main' },
    summary:
      'A skill de pôster/arte da Anthropic: escreve uma design philosophy (manifesto de forma/espaço/cor) e a expressa como artefato visual .png/.pdf — tipografia esparsa, margens rigorosas, fontes empacotadas.',
    hint: 'Use when producing a poster, cover, visual artifact or any static art piece — philosophy-first canvas design.'
  },
  {
    id: 'design-first-ui-prompting',
    kind: 'skill',
    depts: ['design'],
    group: 'direção visual & linguagens',
    source: { repo: 'MengTo/Skills', path: 'agent-skills/ui/design-first-ui-prompting', ref: 'main' },
    summary:
      'Do Meng To (Design+Code): prompts de UI dirigidos por spec — trava layout/hierarquia primeiro, itera UMA variável por vez, template goal→format→layout→type→color→constraints.',
    hint: 'Use when directing UI generation — lock the layout spec first and iterate one variable at a time.'
  },
  {
    id: 'industrial-brutalist-ui',
    kind: 'skill',
    depts: ['design'],
    group: 'direção visual & linguagens',
    source: { repo: 'Leonxlnx/taste-skill', path: 'skills/brutalist-skill', ref: 'main' },
    summary:
      'Linguagem Swiss print × terminal militar: um arquétipo por projeto, contraste tipográfico extremo, vermelho aviação, degradação analógica via CSS (scanlines, halftone).',
    hint: 'Use when the design language is industrial/brutalist — a complete third aesthetic alongside minimal and premium.'
  },
  {
    id: 'redesign-existing-projects',
    kind: 'skill',
    depts: ['design'],
    group: 'direção visual & linguagens',
    source: { repo: 'Leonxlnx/taste-skill', path: 'skills/redesign-skill', ref: 'main' },
    summary:
      'Upgrade visual de projeto EXISTENTE sem quebrar função: audita padrões genéricos por checklist e aplica em ordem de impacto (font swap → cor → estados → spacing → componentes).',
    hint: 'Use when restyling an existing project — impact-ordered upgrade that never breaks behavior.'
  },
  {
    id: 'algorithmic-art',
    kind: 'skill',
    depts: ['design'],
    group: 'direção visual & linguagens',
    source: { repo: 'anthropics/skills', path: 'skills/algorithmic-art', ref: 'main' },
    summary:
      'Arte generativa da Anthropic: manifesto computacional → sketch p5.js autocontido com seed reproduzível e controles de parâmetro (flow fields, partículas).',
    hint: 'Use when producing generative/algorithmic visual assets (p5.js) — philosophy, seeded reproducibility, parameter controls.'
  },

  // ——— identidade & marca ———
  {
    id: 'brand-identity',
    kind: 'skill',
    depts: ['design'],
    group: 'identidade & marca',
    source: { repo: 'rampstackco/claude-skills', path: 'skills/brand-identity', ref: 'main' },
    summary:
      'Sistema de identidade visual completo: logo, cor, tipografia, imagery, iconografia e motion com princípios concretos, padrões de falha e stress-testing.',
    hint: 'Use when defining or evolving a full brand identity system — principles, failure patterns, stress tests.'
  },
  {
    id: 'logo-design',
    kind: 'skill',
    depts: ['design'],
    group: 'identidade & marca',
    source: { repo: 'rampstackco/claude-skills', path: 'skills/logo-design', ref: 'main' },
    summary:
      'Logo por arquitetura de marca: 6–12 variantes (wordmark/lockup/symbol/monogram), cada uma testada contra favicon, bordado, single-color e reverse, com specs de produção.',
    hint: 'Use when designing or iterating a logo — architecture variants stress-tested across real usage contexts.'
  },
  {
    id: 'brandkit',
    kind: 'skill',
    depts: ['design'],
    group: 'identidade & marca',
    source: { repo: 'Leonxlnx/taste-skill', path: 'skills/brandkit', ref: 'main' },
    summary:
      'Direção de arte para GERAR pranchas de brand identity via geração de imagem: metodologia de logo, composição de board, modos visuais (dark developer, luxury, voice AI) — tool-agnóstico, casa com o generate_image do app.',
    hint: 'Use when producing brand identity boards via image generation (works with the generate_image tool available in panes).'
  },
  {
    id: 'ai-graphic-design',
    kind: 'skill',
    depts: ['design'],
    group: 'identidade & marca',
    source: { repo: 'designrique/ai-graphic-design-skill', path: '', ref: 'main' },
    summary:
      'O OFÍCIO de logo/identidade com IA por um designer gráfico real: briefing antes de gerar, roteamento por ferramenta, vetorização (Box Method), mockups com displacement map, segurança de IP.',
    hint: 'Use when doing graphic-design work with AI generation — brief-first craft, tool routing, vectorization, IP safety.'
  },

  // ——— design system & theming ———
  {
    id: 'design-system-patterns',
    kind: 'skill',
    depts: ['design'],
    group: 'design system & theming',
    source: { repo: 'wshobson/agents', path: 'plugins/ui-design/skills/design-system-patterns', ref: 'main' },
    summary:
      'Design systems framework-agnósticos: hierarquia primitive→semantic→component em CSS custom properties, tema claro/escuro, naming, Style Dictionary, pipeline Figma→código, antipadrões (token sprawl).',
    hint: 'Use when structuring or refactoring a design token system — framework-neutral 3-tier hierarchy and theming infra.',
    defaultFor: ['design']
  },
  {
    id: 'theme-factory',
    kind: 'skill',
    depts: ['design'],
    group: 'design system & theming',
    source: { repo: 'anthropics/skills', path: 'skills/theme-factory', ref: 'main' },
    summary:
      'Theming oficial da Anthropic: 10 temas prontos (paleta + par de fontes) com showcase, aplicáveis a qualquer artefato, e workflow de gerar tema novo no mesmo formato.',
    hint: 'Use when theming an artifact (slides, docs, landing) — pick from 10 ready themes or spin a new one in the same format.'
  },

  // ——— tipografia ———
  {
    id: 'typography-audit',
    kind: 'skill',
    depts: ['design'],
    group: 'tipografia',
    source: { repo: 'mblode/agent-skills', path: 'skills/typography-audit', ref: 'main' },
    summary:
      'Auditoria tipográfica contra 78 regras em 10 categorias (medida, pontuação, ritmo, hierarquia, OpenType, pairing) com achados file:line e fix por impacto.',
    hint: 'Use to audit and fix typography as a design decision — 78 rules with per-finding fixes.'
  },

  // ——— mockups & imagem ———
  {
    id: 'prototype',
    kind: 'skill',
    depts: ['design'],
    group: 'mockups & imagem',
    source: { repo: 'emilkowalski/skills', path: 'skills/prototype', ref: 'main' },
    summary:
      'Divergência estruturada do Emil Kowalski: 3–5 direções GENUINAMENTE diferentes do mesmo componente atrás de um picker visual, tabela de tradeoffs honestos, usuário promove a vencedora.',
    hint: 'Use when a component/screen needs real design exploration — render 3-5 divergent directions behind a picker.'
  },
  {
    id: 'imagegen-frontend-web',
    kind: 'skill',
    depts: ['design'],
    group: 'mockups & imagem',
    source: { repo: 'Leonxlnx/taste-skill', path: 'skills/imagegen-frontend-web', ref: 'main' },
    summary:
      'Direção de imagem para referências de design de SITES: uma imagem horizontal por seção, disciplina de espaçamento, anti-clichês de IA (purple gradient slop) — §1–§21.',
    hint: 'Use when generating web-design reference images (one per section) with the generate_image tool.'
  },
  {
    id: 'imagegen-frontend-mobile',
    kind: 'skill',
    depts: ['design'],
    group: 'mockups & imagem',
    source: { repo: 'Leonxlnx/taste-skill', path: 'skills/imagegen-frontend-mobile', ref: 'main' },
    summary:
      '38 regras para telas MOBILE premium em mockups de phone: design bible travada (paleta/tipo/spacing) para consistência multi-tela, anti-tells de IA — só imagens, nunca código.',
    hint: 'Use when generating premium mobile screen mockups as images — locked design bible for multi-screen consistency.'
  },
  {
    id: 'excalidraw',
    kind: 'skill',
    depts: ['design'],
    group: 'mockups & imagem',
    source: { repo: 'Agents365-ai/excalidraw-skill', path: 'skills/excalidraw-skill', ref: 'main' },
    summary:
      'Linguagem natural → .excalidraw JSON: paleta semântica de 8 cores, regra 60-30-10, 5 padrões de diagrama, loop render-verify-fix. Nota: o export SVG opcional usa a API kroki.io (conteúdo sai da máquina).',
    hint: 'Use when producing wireframes/diagrams as .excalidraw files — semantic palette and layout patterns (avoid the Kroki export for private content).'
  },

  // ——— motion design ———
  {
    id: 'motion-design',
    kind: 'skill',
    depts: ['design'],
    group: 'motion design',
    source: { repo: 'LottieFiles/motion-design-skill', path: 'skills/motion-design', ref: 'main' },
    summary:
      'Motion design OFICIAL da LottieFiles, agnóstico de ferramenta: timing, easing, coreografia, princípios Disney adaptados a UI, 4 arquétipos de personalidade, checklist de 8 passos.',
    hint: 'Use when directing motion design (personality, choreography, timing) — pure principles from the Lottie vendor.'
  },
  {
    id: 'apple-design',
    kind: 'skill',
    depts: ['design'],
    group: 'motion design',
    source: { repo: 'emilkowalski/skills', path: 'skills/apple-design', ref: 'main' },
    summary:
      'Fluid interfaces da Apple traduzidas para web: damping/response com números, projeção de momentum, animar do valor ATUAL (interrupção), materiais translúcidos — 8 princípios.',
    hint: 'Use when the motion language should feel Apple-fluid — physics values and interruption-first principles.'
  },
  {
    id: 'find-animation-opportunities',
    kind: 'skill',
    depts: ['design'],
    group: 'motion design',
    source: { repo: 'emilkowalski/skills', path: 'skills/find-animation-opportunities', ref: 'main' },
    summary:
      'Read-only: varre a UI e propõe ONDE motion agrega, com 4 gates (Frequency/Purpose/Speed/Function), máx. 5–7 sugestões com valores exatos — "a melhor animação às vezes é nenhuma".',
    hint: 'Use to propose where motion would add value (and where not) — direction only, no implementation.'
  },
  {
    id: 'review-animations',
    kind: 'skill',
    depts: ['design'],
    group: 'motion design',
    source: { repo: 'emilkowalski/skills', path: 'skills/review-animations', ref: 'main' },
    summary:
      'Review de motion contra 10 padrões inegociáveis (sub-300ms, GPU-only, interruptibilidade), triggers de escalada (transition: all, ease-in em UI), hierarquia de remédio (deletar > reduzir).',
    hint: 'Use to review implemented animations against non-negotiable motion standards.'
  },
  {
    id: 'improve-animations',
    kind: 'skill',
    depts: ['design'],
    group: 'motion design',
    source: { repo: 'emilkowalski/skills', path: 'skills/improve-animations', ref: 'main' },
    summary:
      'Advisor read-only de motion: recon do stack → auditoria em 8 categorias → planos AUTOCONTIDOS para executores baratos (PLAN-TEMPLATE) — casa com o fluxo de delegação do app.',
    hint: 'Use to audit motion and produce self-contained improvement plans a cheaper executor can apply.'
  },

  // ——— SUBAGENTES de mercado (rodada design) — vendors de design não
  // publicam subagente .md (só MCP+skills); estes 3 são o que passou a
  // régua. A Madina (ui-ux-designer) é CC BY 4.0 dentro de repo MIT com a
  // atribuição em comentário no próprio arquivo (viaja na instalação). ———
  {
    id: 'prompt-crafter',
    kind: 'agent',
    depts: ['design'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/meigen-ai-design/agents/prompt-crafter.md',
      ref: 'main'
    },
    summary:
      'Escritor de prompts de geração de imagem em LOTE (vendor-neutro — serve o generate_image do app): 50–150 palavras por prompt, autocontido, direções genuinamente distintas, guias por estilo com valores concretos.',
    hint: 'Delegate writing batches of distinct, self-contained image-generation prompts (pairs with the generate_image tool).'
  },
  {
    id: 'ui-ux-designer',
    kind: 'agent',
    depts: ['design'],
    group: 'subagentes especializados',
    source: {
      repo: 'davila7/claude-code-templates',
      path: 'cli-tool/components/agents/development-team/ui-ux-designer.md',
      ref: 'main'
    },
    summary:
      'Crítico de direção visual com pesquisa CITADA (NN Group, alvos 44×44, WCAG 2.2, INP<200ms): review numerado, formato obrigatório (Verdict/Critical/One Big Win) e anti-patterns nomeados ("Generic SaaS Aesthetic").',
    hint: 'Delegate a research-backed visual-direction critique of a design or screen — mandatory verdict format.',
    defaultFor: ['design']
  },
  {
    id: 'ascii-ui-mockup-generator',
    kind: 'agent',
    depts: ['design'],
    group: 'subagentes especializados',
    source: {
      repo: 'davila7/claude-code-templates',
      path: 'cli-tool/components/agents/development-tools/ascii-ui-mockup-generator.md',
      ref: 'main'
    },
    summary:
      'Wireframes ASCII pré-implementação direto no terminal: 3–5 variações obrigatórias com rationale, conjunto de caracteres definido, seleção numerada — perfeito para alinhar layout antes de codar.',
    hint: 'Delegate quick ASCII wireframe variations to align on layout before any code — terminal-native mockups.'
  },

  // ————————————————————————————————————————————————————————————————————————
  // RODADA 6: RESEARCH (2026-07-29) — escopo do usuário: pesquisa +
  // DOCUMENTAÇÃO (docs→research) + PLANEJAMENTO ("entra /grill-me etc.").
  // Métodos externos de planejamento permanecem no catálogo para uso manual,
  // mas nunca são injetados no Maestro. Régua flexibilizada ("não forçar 30"):
  // sobreposições foram
  // CORTADAS (2 de spec, 2 de concorrência, 1 de síntese, meta-triplicata →
  // writing-skills só). REJECT histórico: docx/pdf/pptx/xlsx da Anthropic
  // têm licença PROPRIETÁRIA que proíbe reter cópias fora dos Services —
  // NUNCA instalar, em NENHUMA rodada. Descartes em docs/SKILLS.md.
  // ————————————————————————————————————————————————————————————————————————

  // ——— planejamento externo (catálogo manual; nunca injetado no Maestro) ———
  {
    id: 'grilling',
    kind: 'skill',
    depts: ['research'],
    group: 'planejamento',
    manualOnly: true,
    source: { repo: 'mattpocock/skills', path: 'skills/productivity/grilling', ref: 'main' },
    summary:
      'Interrogatório implacável de plano/decisão: UMA pergunta por vez, lacunas factuais resolvidas explorando o ambiente (não perguntando), árvore de decisão com recomendação por ramo. A skill que faltava upstream — existe agora.',
    hint: 'Use to interrogate a vague plan/decision until it holds — one question at a time, environment-first fact finding.'
  },
  {
    id: 'grill-me',
    kind: 'skill',
    depts: ['research'],
    group: 'planejamento',
    manualOnly: true,
    source: { repo: 'mattpocock/skills', path: 'skills/productivity/grill-me', ref: 'main' },
    summary: 'O lançador do interrogatório: "/grill-me" inicia uma sessão de grilling sobre o plano atual.',
    hint: 'Invoke to start a relentless interview that sharpens the current plan or design.',
    requires: ['grilling']
  },
  {
    id: 'grill-with-docs',
    kind: 'skill',
    depts: ['research'],
    group: 'planejamento',
    manualOnly: true,
    source: { repo: 'mattpocock/skills', path: 'skills/engineering/grill-with-docs', ref: 'main' },
    summary:
      'O interrogatório gerando documentação no caminho: ADRs + glossário (via domain-modeling) enquanto a conversa afia o plano.',
    hint: 'Use to grill a plan while capturing ADRs and glossary entries as you go.',
    requires: ['grilling', 'domain-modeling']
  },
  {
    id: 'brainstorming',
    kind: 'skill',
    depts: ['research'],
    group: 'planejamento',
    manualOnly: true,
    source: { repo: 'obra/superpowers', path: 'skills/brainstorming', ref: 'main' },
    summary:
      'Diálogo socrático PRÉ-implementação com gate duro (nada de código antes de design aprovado): propostas com trade-offs, spec documentada e self-review contra placeholders/ambiguidade.',
    hint: 'Use before creative/new work to explore the space and land an approved, documented design — hard gate against premature code.',
    requires: ['writing-plans']
  },
  {
    id: 'writing-plans',
    kind: 'skill',
    depts: ['research'],
    group: 'planejamento',
    manualOnly: true,
    source: { repo: 'obra/superpowers', path: 'skills/writing-plans', ref: 'main' },
    summary:
      'Escrever PLANOS como documento: tarefas bite-sized independentes e testáveis com código real (nunca placeholder), paths exatos e contratos de interface. Reavaliada: como deliverable de card não conflita com o pipeline do app.',
    hint: 'Use when the deliverable is a written implementation plan — bite-sized verifiable tasks with real code and exact paths.'
  },
  {
    id: 'to-tickets',
    kind: 'skill',
    depts: ['research'],
    group: 'planejamento',
    manualOnly: true,
    source: { repo: 'mattpocock/skills', path: 'skills/engineering/to-tickets', ref: 'main' },
    summary:
      'Decomposição em tickets "tracer-bullet": fatias VERTICAIS (schema→API→UI→testes) dimensionadas para caber numa única janela de contexto fresca, com bloqueios declarados. Modo local grava um .md por ticket.',
    hint: 'Use to decompose planned work into vertical, context-window-sized slices with declared blocking edges (local .md mode).'
  },
  {
    id: 'before-you-build',
    kind: 'skill',
    depts: ['research'],
    group: 'planejamento',
    manualOnly: true,
    source: { repo: 'wshobson/agents', path: 'plugins/before-you-build/skills/before-you-build', ref: 'main' },
    summary:
      'Pre-mortem de produto/feature em 7 lentes de risco (demanda, posicionamento, monetização, retenção, confiança, distribuição, adoção) — prioriza a suposição mais arriscada e o menor passo de validação.',
    hint: 'Use before committing to build — surface the riskiest assumption and the cheapest way to validate it.'
  },
  {
    id: 'roadmap-planning',
    kind: 'skill',
    depts: ['research'],
    group: 'planejamento',
    manualOnly: true,
    source: { repo: 'rampstackco/claude-skills', path: 'skills/roadmap-planning', ref: 'main' },
    summary:
      'Backlog → roadmap defensável em 8 passos com modelagem HONESTA de capacidade (40–70%, nunca 100%) e lista "Not now" obrigatória.',
    hint: 'Use to turn a backlog into a defensible roadmap — honest capacity modeling and an explicit not-now list.'
  },
  {
    id: 'dispatching-parallel-agents',
    kind: 'skill',
    depts: ['front', 'back', 'qa', 'design', 'research', 'copy', 'cyber', 'data'],
    group: 'coordenação de agentes',
    source: {
      repo: 'obra/superpowers',
      path: 'skills/dispatching-parallel-agents',
      ref: 'main'
    },
    summary:
      'Como separar problemas realmente independentes, escrever briefings autocontidos e despachar ajudantes em paralelo sem disputa de estado — alinhada ao delegate em lote do Synkora.',
    hint: 'Use when two or more independent work streams can safely run in parallel through focused helper briefings.'
  },
  {
    id: 'executing-plans',
    kind: 'skill',
    depts: ['research'],
    group: 'execução de planos',
    source: { repo: 'obra/superpowers', path: 'skills/executing-plans', ref: 'main' },
    summary:
      'Executar um plano escrito passo a passo, com revisão crítica e checkpoints. Fica sob escolha explícita porque missões Synkora já têm orquestrador, cards, gates e integração próprios.',
    hint: 'Use only for an explicitly requested external plan-execution workflow; normal missions use create_plan/create_tasks/run_task.',
    requires: ['using-git-worktrees', 'finishing-a-development-branch'],
    manualOnly: true
  },
  {
    id: 'subagent-driven-development',
    kind: 'skill',
    depts: ['research'],
    group: 'execução de planos',
    source: {
      repo: 'obra/superpowers',
      path: 'skills/subagent-driven-development',
      ref: 'main'
    },
    summary:
      'Execução de plano com um implementador novo por tarefa, revisão em duas camadas, ledger persistente e ciclos de correção limitados. Uso explícito para não duplicar o pipeline nativo do Synkora.',
    hint: 'Use only when the user explicitly chooses this external execution controller instead of the normal Synkora mission pipeline.',
    requires: [
      'using-git-worktrees',
      'requesting-code-review',
      'finishing-a-development-branch'
    ],
    manualOnly: true
  },
  {
    id: 'using-superpowers',
    kind: 'skill',
    depts: ['research'],
    group: 'meta · uso de skills',
    source: { repo: 'obra/superpowers', path: 'skills/using-superpowers', ref: 'main' },
    summary:
      'Router meta que obriga checar skills antes de agir. Fica sob escolha explícita: o Synkora já possui seu próprio Skill Gate e suas regras de missão têm precedência.',
    hint: 'Use only when explicitly adopting the Superpowers meta-workflow; Synkora\'s own Skill Gate and mission rules remain authoritative.',
    manualOnly: true
  },

  // ——— specs & requisitos ———
  {
    id: 'write-spec',
    kind: 'skill',
    depts: ['research'],
    group: 'specs & requisitos',
    source: {
      repo: 'anthropics/knowledge-work-plugins',
      path: 'product-management/skills/write-spec',
      ref: 'main'
    },
    summary:
      'Ideia vaga → PRD estruturado (oficial Anthropic): problema, goals/non-goals, user stories, requisitos P0/P1/P2, métricas, fases — com anti-scope-creep explícito. Refs a CONNECTORS.md são informativas (degrada para WebSearch).',
    hint: 'Use to turn a vague idea into a structured PRD with prioritized requirements and success metrics.'
  },
  {
    id: 'create-prd',
    kind: 'skill',
    depts: ['research'],
    group: 'specs & requisitos',
    source: { repo: 'phuryn/pm-skills', path: 'pm-execution/skills/create-prd', ref: 'main' },
    summary:
      'PRD pelo Pawel Huryn (referência mundial de PM): template de 8 seções com ênfase em gathering antes de escrever e linguagem acessível.',
    hint: 'Use for a full-discipline PRD following an 8-section template from a leading PM educator.'
  },
  {
    id: 'requirement-writer',
    kind: 'skill',
    depts: ['research'],
    group: 'specs & requisitos',
    source: {
      repo: 'DivikWu/product-requirement-craft',
      path: '.claude/skills/requirement-writer',
      ref: 'main'
    },
    summary:
      'Descoberta de requisitos GUIADA em 6 fases gerando três documentos progressivos (Problem Framing → SRD → PRD) com scoring de completude 🟢🟡🔴 e review multi-papel.',
    hint: 'Use for interactive requirements discovery — progressive documents with completeness scoring.'
  },
  {
    id: 'feature-forge',
    kind: 'skill',
    depts: ['research'],
    group: 'specs & requisitos',
    source: { repo: 'Jeffallan/claude-skills', path: 'skills/feature-forge', ref: 'main' },
    summary:
      'Workshop estruturado de requisitos (perspectiva PM+Dev): entrevista guiada, requisitos EARS, user stories, acceptance criteria testáveis, NFRs.',
    hint: 'Use to run a requirements workshop producing EARS requirements and testable acceptance criteria.'
  },
  {
    id: 'spec-miner',
    kind: 'skill',
    depts: ['research'],
    group: 'specs & requisitos',
    source: { repo: 'Jeffallan/claude-skills', path: 'skills/spec-miner', ref: 'main' },
    summary:
      'Engenharia REVERSA de specs de código legado/sem docs: perspectiva dupla arquitetura+QA, requisitos observados em formato EARS, incertezas explícitas — complementa o /estudar do app.',
    hint: 'Use to mine the specs OUT of undocumented code — observed EARS requirements with explicit uncertainties.'
  },
  {
    id: 'ce-strategy',
    kind: 'skill',
    depts: ['research'],
    group: 'specs & requisitos',
    source: { repo: 'EveryInc/compound-engineering-plugin', path: 'skills/ce-strategy', ref: 'main' },
    summary:
      'STRATEGY.md por entrevista rigorosa em 5 seções (problema, abordagem, persona, métricas, tracks) com rodadas de pushback obrigatórias — base Rumelt.',
    hint: 'Use to create or update the project STRATEGY.md through a rigorous pushback interview.'
  },

  // ——— pesquisa & avaliação ———
  {
    id: 'research',
    kind: 'skill',
    depts: ['research'],
    group: 'pesquisa & avaliação',
    source: { repo: 'mattpocock/skills', path: 'skills/engineering/research', ref: 'main' },
    summary:
      'Investigação contra FONTES PRIMÁRIAS (docs oficiais, código-fonte, specs): cada claim rastreado até o dono autoritativo, resultado em markdown único com citações.',
    hint: 'Use for source-primary technical research — every claim traced to its authoritative owner, written up with citations.',
    defaultFor: ['research']
  },
  {
    id: 'deep-research',
    kind: 'skill',
    depts: ['research'],
    manualOnly: true,
    group: 'pesquisa & avaliação',
    source: { repo: 'daymade/claude-code-skills', path: 'deep-research', ref: 'main' },
    summary:
      'Deep research P0–P7 com subagentes paralelos, registro de citações deduplicado, counter-review OBRIGATÓRIO (≥3 issues) e passe de verificação — usa WebSearch/WebFetch nativos, zero deps.',
    hint: 'Use only when the user explicitly chooses its external subagent/counter-review workflow; normal Synkora research routes through the native contract plus the source-primary research technique.'
  },
  {
    id: 'firecrawl-search',
    kind: 'skill',
    depts: ['research'],
    group: 'pesquisa & avaliação',
    source: { repo: 'firecrawl/cli', path: 'skills/firecrawl-search', ref: 'main' },
    summary:
      'Busca web com extração de página completa em markdown (Firecrawl, a mais instalada da categoria): filtros de tempo/local, resultados em .firecrawl/ para poupar contexto. Exige API key; IGNORE a seção de "feedback ao vendor".',
    hint: 'Use for web search with full-page markdown extraction (requires FIRECRAWL key; skip the vendor-feedback section).'
  },
  {
    id: 'web-search',
    kind: 'skill',
    depts: ['research'],
    group: 'pesquisa & avaliação',
    source: { repo: 'brave/brave-search-skills', path: 'skills/web-search', ref: 'main' },
    summary:
      'Brave Search por REST puro (a integração de vendor mais limpa: só curl + env token): operadores, freshness, Goggles de re-ranking. Tier grátis disponível.',
    hint: 'Use for API web search via Brave (curl + token, free tier) — operators, freshness filters, custom re-ranking.'
  },
  {
    id: 'ce-pov',
    kind: 'skill',
    depts: ['research'],
    group: 'pesquisa & avaliação',
    source: { repo: 'EveryInc/compound-engineering-plugin', path: 'skills/ce-pov', ref: 'main' },
    summary:
      'Veredito fundamentado para PERGUNTAS DE ADOÇÃO ("usamos a lib X?"): gate de posição merecida (contexto do repo + precedentes + verificação externa), tiers de reversibilidade, decisões guardadas em solutions/.',
    hint: 'Use to produce a grounded adopt-or-not verdict on a library/tool/approach for THIS project.'
  },
  {
    id: 'competitive-brief',
    kind: 'skill',
    depts: ['research'],
    group: 'pesquisa & avaliação',
    source: {
      repo: 'anthropics/knowledge-work-plugins',
      path: 'product-management/skills/competitive-brief',
      ref: 'main'
    },
    summary:
      'Brief competitivo oficial (Anthropic PM): overview de concorrentes, matriz de features, posicionamento e implicações estratégicas — degrada para WebSearch puro. NOTA: o repo tem um gêmeo em marketing/ com o MESMO name (só este entra).',
    hint: 'Use to produce a competitive brief (feature matrix, positioning, implications) from web research.'
  },
  {
    id: 'competitors-analysis',
    kind: 'skill',
    depts: ['research'],
    group: 'pesquisa & avaliação',
    source: { repo: 'daymade/claude-code-skills', path: 'competitors-analysis', ref: 'main' },
    summary:
      'Inteligência competitiva POR CÓDIGO-FONTE: clona repos de concorrentes e exige citação file:line para claims técnicos; separa fato de julgamento. Workspace persistente em $HOME (nota).',
    hint: 'Use to analyze competitors through their actual source code — file:line evidence for every technical claim.'
  },
  {
    id: 'market-sizing-analysis',
    kind: 'skill',
    depts: ['research'],
    group: 'pesquisa & avaliação',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/startup-business-analyst/skills/market-sizing-analysis',
      ref: 'main'
    },
    summary: 'TAM/SAM/SOM por três metodologias (top-down, bottom-up, value theory) com processo passo a passo.',
    hint: 'Use to size a market with triangulated TAM/SAM/SOM methodologies.'
  },
  {
    id: 'synthesize-research',
    kind: 'skill',
    depts: ['research'],
    group: 'pesquisa & avaliação',
    source: {
      repo: 'anthropics/knowledge-work-plugins',
      path: 'product-management/skills/synthesize-research',
      ref: 'main'
    },
    summary:
      'Síntese de user research (entrevistas/surveys/tickets) em 5 estágios: análise temática, 5–8 findings ranqueados por frequência×impacto com nível de confiança, oportunidades e recomendações.',
    hint: 'Use to synthesize raw user research into ranked, confidence-scored findings and opportunities.'
  },

  // ——— documentação ———
  {
    id: 'documentation',
    kind: 'skill',
    depts: ['research'],
    group: 'documentação',
    source: {
      repo: 'anthropics/knowledge-work-plugins',
      path: 'engineering/skills/documentation',
      ref: 'main'
    },
    summary:
      'Docs técnicas oficiais (Anthropic engineering): README, API docs, runbooks, architecture docs e onboarding com 5 princípios (leitor primeiro, essencial primeiro, exemplos, atualidade).',
    hint: 'Use when writing or maintaining technical documentation in any of the 5 standard formats.'
  },
  {
    id: 'good-readme',
    kind: 'skill',
    depts: ['research'],
    group: 'documentação',
    source: { repo: 'adewale/good-readme', path: 'skills/good-readme', ref: 'main' },
    summary:
      'READMEs com rubrica de 22 critérios e score /100; o "Source-Grounded API Drift Protocol" verifica cada função/flag documentada contra o CÓDIGO antes de escrever (anti-alucinação). Autor de Apprenticeship Patterns.',
    hint: 'Use to create or audit a README — 22-criteria rubric with source-grounded anti-drift verification.'
  },
  {
    id: 'agents-md',
    kind: 'skill',
    depts: ['research'],
    group: 'documentação',
    source: { repo: 'getsentry/skills', path: 'skills/agents-md', ref: 'main' },
    summary:
      'AGENTS.md/CLAUDE.md concisos (<60 linhas) e reference-backed, pela Sentry: inspeciona o repo primeiro, aponta para docs existentes em vez de duplicar.',
    hint: 'Use to create or maintain AGENTS.md/CLAUDE.md files — concise, reference-backed, repo-grounded.'
  },
  {
    id: 'code-documenter',
    kind: 'skill',
    depts: ['research'],
    group: 'documentação',
    source: { repo: 'Jeffallan/claude-skills', path: 'skills/code-documenter', ref: 'main' },
    summary:
      'Documentar código EXISTENTE em 6 passos: descoberta de formato, docstrings/JSDoc/OpenAPI, VALIDAÇÃO de exemplos (doctest/tsc) e relatório de cobertura.',
    hint: 'Use to document existing code — consistent formats with validated examples and a coverage report.'
  },
  {
    id: 'architecture-decision-records',
    kind: 'skill',
    depts: ['research'],
    group: 'documentação',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/documentation-generation/skills/architecture-decision-records',
      ref: 'main'
    },
    summary:
      'ADRs completos: 5 templates (MADR, Y-statement, RFC-style), ciclo de vida Proposed→Superseded, estrutura docs/adr/ com índice e checklists de revisão.',
    hint: 'Use to write or restructure Architecture Decision Records — 5 templates with lifecycle management.'
  },
  {
    id: 'openapi-spec-generation',
    kind: 'skill',
    depts: ['research'],
    group: 'documentação',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/documentation-generation/skills/openapi-spec-generation',
      ref: 'main'
    },
    summary: 'OpenAPI 3.1 design-first/code-first/híbrido: reuso via $ref, documentação de erros, template completo de exemplo.',
    hint: 'Use to generate or restructure an OpenAPI 3.1 spec as API documentation.'
  },
  {
    id: 'generate-changelog',
    kind: 'skill',
    depts: ['research'],
    group: 'documentação',
    source: { repo: 'inprojectspl/generate-changelog', path: '', ref: 'main' },
    summary:
      'Keep a Changelog 1.1.0 imposto com spec embarcada e validate-changelog.sh; allowed-tools restrito a git. O changelog mais disciplinado da varredura.',
    hint: 'Use to write or fix CHANGELOG.md strictly per Keep a Changelog 1.1.0 — with a mechanical validator.'
  },
  {
    id: 'ce-doc-review',
    kind: 'skill',
    depts: ['research'],
    group: 'documentação',
    source: { repo: 'EveryInc/compound-engineering-plugin', path: 'skills/ce-doc-review', ref: 'main' },
    summary:
      'Review multi-persona de requirements/planos/specs: lentes de coerência/viabilidade + condicionais (produto/design/segurança), dedupe/síntese — o gate de documentos.',
    hint: 'Use to review a spec/plan/requirements doc through multiple expert lenses before it drives work.'
  },
  {
    id: 'writing-skills',
    kind: 'skill',
    depts: ['research'],
    group: 'documentação',
    source: { repo: 'obra/superpowers', path: 'skills/writing-skills', ref: 'main' },
    summary:
      'TDD aplicado a ESCREVER SKILLS: ver o agente falhar sem o doc, escrever o mínimo que corrige, pressure-tests via subagentes (RED-GREEN-REFACTOR) — a meta-metodologia mais rigorosa (escolhida sobre writing-great-skills e skill-creator).',
    hint: 'Use when authoring or improving agent skills — test-driven documentation with subagent pressure-tests.'
  },

  // ——— SUBAGENTES de mercado (rodada research) ———
  {
    id: 'code-explorer',
    kind: 'agent',
    depts: ['research'],
    group: 'subagentes especializados',
    source: { repo: 'anthropics/claude-code', path: 'plugins/feature-dev/agents/code-explorer.md', ref: 'main' },
    summary:
      'Exploração de codebase para ENTENDIMENTO (Anthropic oficial): 4 fases (entry points → trace de execução → arquitetura → detalhes), file:line em tudo, output com fluxos e arquivos essenciais.',
    hint: 'Delegate mapping how a codebase/feature actually works — traced flows with file:line evidence.'
  },
  {
    id: 'documentation-generation-docs-architect',
    kind: 'agent',
    depts: ['research'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/documentation-generation/agents/docs-architect.md',
      ref: 'main'
    },
    summary:
      'Documentação técnica LONGA a partir do codebase: Discovery→Structuring→Writing com seções obrigatórias (Executive Summary, Architecture Overview, Design Decisions), refs file:line. (Id prefixado pelo plugin — name verbatim.)',
    hint: 'Delegate producing long-form technical documentation (architecture guides, ebooks) from the codebase.'
  },
  {
    id: 'documentation-generation-api-documenter',
    kind: 'agent',
    depts: ['research'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/documentation-generation/agents/api-documenter.md',
      ref: 'main'
    },
    summary:
      'Documentação de API: OpenAPI 3.1 em 8 passos, docs-as-code, exemplos testáveis, forbidden behaviors (docs sem exemplos). (Id prefixado pelo plugin.)',
    hint: 'Delegate documenting an API — OpenAPI 3.1 with testable examples, docs-as-code discipline.'
  },
  {
    id: 'documentation-generation-tutorial-engineer',
    kind: 'agent',
    depts: ['research'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/documentation-generation/agents/tutorial-engineer.md',
      ref: 'main'
    },
    summary:
      'Tutoriais e onboarding: objetivos de aprendizado → decomposição de conceitos → exercícios, formatos com duração (Quick Start 5min / Deep Dive 30-60min). (Id prefixado pelo plugin.)',
    hint: 'Delegate creating tutorials/onboarding docs — learning objectives, exercises, timed formats.'
  },
  {
    id: 'search-specialist',
    kind: 'agent',
    depts: ['research'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/content-marketing/agents/search-specialist.md',
      ref: 'main'
    },
    summary:
      'Pesquisa web profunda: 3–5 variações de query, broad→narrow, cross-reference multi-fonte, contradições documentadas, credibilidade de fontes e gaps no output.',
    hint: 'Delegate deep web research on a question — query strategies, cross-referenced sources, documented gaps.'
  },
  {
    id: 'startup-analyst',
    kind: 'agent',
    depts: ['research'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/startup-business-analyst/agents/startup-analyst.md',
      ref: 'main'
    },
    summary:
      'Análise de oportunidade: TAM/SAM/SOM, unit economics (CAC/LTV/payback) com fórmulas explícitas, fontes com URL+data obrigatórias, seção de premissas mandatória.',
    hint: 'Delegate market-opportunity analysis — sizing, unit economics, sourced and dated claims.'
  },
  {
    id: 'technical-researcher',
    kind: 'agent',
    depts: ['research'],
    group: 'subagentes especializados',
    source: {
      repo: 'davila7/claude-code-templates',
      path: 'cli-tool/components/agents/deep-research-team/technical-researcher.md',
      ref: 'main'
    },
    summary:
      'Avaliação técnica de libs/tools: stats de repo, rubricas FIXAS (testing/maintenance por faixa), formato de citação estrito, quotes ≤125 chars — o tech-evaluator vindo do mercado.',
    hint: 'Delegate evaluating a library/tool/framework — fixed rubrics, strict citations, structured verdict.',
    defaultFor: ['research']
  },
  {
    id: 'fact-checker',
    kind: 'agent',
    depts: ['research', 'copy'],
    group: 'subagentes especializados',
    source: {
      repo: 'davila7/claude-code-templates',
      path: 'cli-tool/components/agents/deep-research-team/fact-checker.md',
      ref: 'main'
    },
    summary:
      'Verificação de claims: evidência pró/contra, thresholds numéricos de confiança (HIGH ≥0.8), veredito em 6 estados (TRUE…UNVERIFIABLE), forbidden behaviors. (Venceu a skill homônima do daymade na colisão de id.)',
    hint: 'Delegate verifying factual claims against sources — numeric confidence thresholds, 6-state verdicts.'
  },
  {
    id: 'competitive-intelligence-analyst',
    kind: 'agent',
    depts: ['research'],
    group: 'subagentes especializados',
    source: {
      repo: 'davila7/claude-code-templates',
      path: 'cli-tool/components/agents/deep-research-team/competitive-intelligence-analyst.md',
      ref: 'main'
    },
    summary:
      'Scan de concorrência multi-fonte (filings, news, job postings): SWOT + Porter, scoring 1–10 de oportunidade, só fontes públicas.',
    hint: 'Delegate a competitor scan across public sources — SWOT, Porter, scored opportunities.'
  },
  {
    id: 'diagram-architect',
    kind: 'agent',
    depts: ['research'],
    group: 'subagentes especializados',
    source: {
      repo: 'davila7/claude-code-templates',
      path: 'cli-tool/components/agents/documentation/diagram-architect.md',
      ref: 'main'
    },
    summary:
      'Diagramas de documentação em 4 formatos (ASCII/Mermaid/PlantUML/Draw.io) com regras concretas (≤20 nós, legenda >5 tipos).',
    hint: 'Delegate producing documentation diagrams — right format for the audience, node caps, legends.'
  },

  // ————————————————————————————————————————————————————————————————————————
  // RODADA 7: COPY (2026-07-29) — UX writing, voz do produto, marketing copy,
  // SEO content, comms. Além das novas abaixo, re-tags: better-writing
  // (front→+copy, ★) e fact-checker (research→+copy — claims de marketing).
  // Colisões geridas: competitive-brief de marketing/ PULADO (gêmeo de id do
  // instalado); email = UMA lane de lifecycle (email-sequence venceu emails/
  // corey e email-sequences/rampstack; cold-email é outbound, job distinto);
  // draft-content cortada (content-and-copy + especialistas por formato
  // cobrem). Armadilha nova: README ≠ TREE no realkimbarrett (voice-of-
  // customer-miner só existe no README — nunca pinar pick sem ver a árvore).
  // vercel writing-guidelines rejeitada (ruleset remoto sem pin, mesma classe
  // da web-design-guidelines); seo do addyosmani rejeitada (../ quebradas +
  // é SEO técnico de implementação, não escrita). Racional em docs/SKILLS.md.
  // ————————————————————————————————————————————————————————————————————————

  // ——— voz & fundamento ———
  {
    id: 'product-marketing',
    kind: 'skill',
    depts: ['copy'],
    group: 'voz & fundamento',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/product-marketing', ref: 'main' },
    summary:
      'Cria/atualiza o dossiê de marketing do projeto (.agents/product-marketing.md): posicionamento, ICP, voz e provas — o contexto que as skills irmãs do kit corey leem antes de escrever (changelog versionado).',
    hint: 'Use FIRST on marketing work — creates the .agents/product-marketing.md context (positioning, ICP, voice, proof) sibling marketing skills read.'
  },
  {
    id: 'brand-voice',
    kind: 'skill',
    depts: ['copy'],
    group: 'voz & fundamento',
    source: { repo: 'rampstackco/claude-skills', path: 'skills/brand-voice', ref: 'main' },
    summary:
      'Sistema de voz em 4 camadas: atributos "X, não Y", 8-15 contextos de tom, vocabulário/gramática e 15-25 exemplos pareados — produz o voice.md que DEFINE a identidade verbal (a brand-review revisa; esta define).',
    hint: 'Use when defining a brand voice system from scratch — attributes, tone contexts, vocabulary, paired examples.'
  },
  {
    id: 'brand-review',
    kind: 'skill',
    depts: ['copy'],
    group: 'voz & fundamento',
    source: {
      repo: 'anthropics/knowledge-work-plugins',
      path: 'marketing/skills/brand-review',
      ref: 'main'
    },
    summary:
      'Review oficial de conteúdo contra a voz da marca (Anthropic marketing): espectros de voz em 7 eixos, matrizes de tom, severidade e correções antes/depois — o melhor revisor de voz/tom do mercado.',
    hint: 'Use to review any content against brand voice/style — 7-axis spectrums, tone matrices, before/after fixes.'
  },
  {
    id: 'marketing-psychology',
    kind: 'skill',
    depts: ['copy'],
    group: 'voz & fundamento',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/marketing-psychology', ref: 'main' },
    summary:
      '~60 modelos mentais aplicados a marketing (ancoragem, aversão à perda, JTBD, prova social…) — o substrato de persuasão que fundamenta qualquer copy.',
    hint: 'Use to ground copy in persuasion principles — ~60 mental models mapped to marketing use.'
  },
  {
    id: 'naming',
    kind: 'skill',
    depts: ['copy'],
    group: 'voz & fundamento',
    source: { repo: 'glacierphonk/naming', path: '', ref: 'main' },
    summary:
      'Naming sério em 7 passos guiado por metáfora: gates anti-slop, checagem de disponibilidade bloqueante e guias por idioma (incluindo PT). O whois dos checks não existe no Windows — degrada para WebSearch.',
    hint: 'Use when naming products/features/companies — 7-step metaphor-driven method with availability checks and anti-slop gates.'
  },
  {
    id: 'founder-voice-ghostwriter',
    kind: 'skill',
    depts: ['copy'],
    group: 'voz & fundamento',
    source: { repo: 'BayramAnnakov/founder-voice-ghostwriter', path: '', ref: 'master' },
    summary:
      'Ghostwriting de founder em 4 estágios: calibração de voz → entrevista de extração → draft → refino — thought leadership que soa como a PESSOA, não como IA. (Branch master.)',
    hint: 'Use when ghostwriting founder/thought-leadership content — voice calibration, extraction interview, draft, refine.'
  },

  // ——— microcopy & edição ———
  {
    id: 'ux-writing',
    kind: 'skill',
    depts: ['copy'],
    group: 'microcopy & edição',
    source: { repo: 'content-designer/ux-writing-skill', path: '', ref: 'main' },
    summary:
      'Microcopy sistemático de UI: 4 padrões de qualidade, patterns de erro/tom/acessibilidade e templates prontos — segunda lente sobre copy de interface ao lado da better-writing. (Pasta upstream ux-writing-skill ≠ name.)',
    hint: 'Use when writing interface copy with a systematic method — quality standards, error/tone/a11y patterns, templates.'
  },
  {
    id: 'copy-editing',
    kind: 'skill',
    depts: ['copy'],
    group: 'microcopy & edição',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/copy-editing', ref: 'main' },
    summary:
      'Sistema de edição em 7 passadas: clareza, voz, "so what", prove-it, especificidade, emoção, zero-risco — transforma rascunho em copy afiada (3 arquivos de referência).',
    hint: 'Use to edit any draft through 7 focused passes — clarity, voice, so-what, proof, specificity, emotion, zero-risk.'
  },
  {
    id: 'editorial-qa',
    kind: 'skill',
    depts: ['copy'],
    group: 'microcopy & edição',
    source: { repo: 'rampstackco/claude-skills', path: 'skills/editorial-qa', ref: 'main' },
    summary:
      'O gate pré-publicação de conteúdo: aderência ao brief, consistência de voz, exatidão de fatos, auditoria de "cara de IA" e amostragem em escala (10 arquivos de referência).',
    hint: 'Use as the pre-publish gate for content — brief adherence, voice consistency, fact accuracy, AI-content audit.'
  },
  {
    id: 'humanizer',
    kind: 'skill',
    depts: ['copy'],
    group: 'microcopy & edição',
    source: { repo: 'blader/humanizer', path: '', ref: 'main' },
    summary:
      'A skill anti-IA mais famosa (32k★): remove os 33 sinais catalogados de texto de IA (guia da Wikipedia) com calibração de voz, pares antes/depois, guardas de falso positivo e gate anti-fabricação.',
    hint: 'Use as a final pass on any text that must not read AI-written — 33 AI-tell categories with fixes and false-positive guards.',
    defaultFor: ['copy']
  },

  // ——— conversão & landing ———
  {
    id: 'copywriting',
    kind: 'skill',
    depts: ['copy'],
    group: 'conversão & landing',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/copywriting', ref: 'main' },
    summary:
      'Copy de conversão para páginas de marketing (a skill de marketing mais instalada do mercado, 164k): princípios, frameworks por tipo de página e fórmulas de CTA (2 arquivos de referência).',
    hint: 'Use when writing conversion copy for marketing pages — page-type frameworks and CTA formulas.',
    defaultFor: ['copy']
  },
  {
    id: 'headline-matrix',
    kind: 'skill',
    depts: ['copy'],
    group: 'conversão & landing',
    source: {
      repo: 'realkimbarrett/advertising-skills',
      path: 'skills/copy-chief/headline-matrix',
      ref: 'main'
    },
    summary:
      '25 variações de headline em 7 ângulos psicológicos (escola Eugene Schwartz, license MIT por skill no frontmatter) — para nunca publicar a primeira headline que saiu.',
    hint: 'Use to generate and rank headline options — 25 variations across 7 psychological angles.'
  },
  {
    id: 'schwartz-awareness-mapper',
    kind: 'skill',
    depts: ['copy'],
    group: 'conversão & landing',
    source: {
      repo: 'realkimbarrett/advertising-skills',
      path: 'skills/copy-chief/schwartz-awareness-mapper',
      ref: 'main'
    },
    summary:
      'Diagnóstico do estágio de consciência do público (cold→most-aware, Schwartz) e a abordagem de mensagem certa para cada estágio — decide COMO a copy fala antes de escrever. (Upstream avatar-extraction é dica soft; roda sozinha.)',
    hint: 'Use before writing copy to map audience awareness stage and pick the matching messaging approach.'
  },
  {
    id: 'landing-page-copy',
    kind: 'skill',
    depts: ['copy'],
    group: 'conversão & landing',
    source: { repo: 'rampstackco/claude-skills', path: 'skills/landing-page-copy', ref: 'main' },
    summary:
      'Framework de landing em 7 seções: hierarquia de mensagem, padrões de CTA, tratamento de objeções e lista de falhas clássicas — profundidade de ESTRUTURA de página (a copywriting dá os princípios).',
    hint: 'Use when structuring/writing a landing page — 7-section framework with objection handling and CTA patterns.'
  },
  {
    id: 'offers',
    kind: 'skill',
    depts: ['copy'],
    group: 'conversão & landing',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/offers', ref: 'main' },
    summary:
      'Construção de oferta pela value equation: enquadramento de valor, bonus stacking, desenho de garantia, escassez honesta e naming da oferta — o que a página de vendas DIZ (7 referências; delega a prosa à copywriting).',
    hint: 'Use to construct/name the offer before writing the page — value equation, guarantees, bonus stack, honest urgency.'
  },
  {
    id: 'competitors',
    kind: 'skill',
    depts: ['copy'],
    group: 'conversão & landing',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/competitors', ref: 'main' },
    summary:
      'Páginas comparativas PÚBLICAS em 4 formatos (vs / alternative / alternatives / A-vs-B) com posicionamento honesto, TL;DRs e migration paths — copy + superfície de SEO (sem colisão com o competitive-brief interno).',
    hint: 'Use when writing public comparison/alternative pages — honest positioning, 4 formats, TL;DRs.'
  },

  // ——— conteúdo & SEO ———
  {
    id: 'content-strategy',
    kind: 'skill',
    depts: ['copy'],
    group: 'conteúdo & SEO',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/content-strategy', ref: 'main' },
    summary:
      'Estratégia de conteúdo: pilares, topic clusters, mapeamento por estágio do funil e priorização. (Id também existe em rampstack e kwp small-business — este entrou; os gêmeos ficam fora.)',
    hint: 'Use to plan content pillars/clusters and prioritize topics by buyer stage.'
  },
  {
    id: 'content-brief',
    kind: 'skill',
    depts: ['copy'],
    group: 'conteúdo & SEO',
    source: { repo: 'inhouseseo/superseo-skills', path: 'skills/content-brief', ref: 'main' },
    summary:
      'Briefs prontos-para-escrever a partir de SERP AO VIVO: 23 tipos de conteúdo, classificação de intenção — a pauta nasce do que a busca mostra, não de achismo (sem APIs).',
    hint: 'Use to produce writer-ready content briefs from live SERP research — intent classification, 23 content types.'
  },
  {
    id: 'write-content',
    kind: 'skill',
    depts: ['copy'],
    group: 'conteúdo & SEO',
    source: { repo: 'inhouseseo/superseo-skills', path: 'skills/write-content', ref: 'main' },
    summary:
      'Escrita de artigo SEO completa com ruleset anti-slop e auto-pesquisa de SERP, SEM APIs — metodologia Koray Tuğberk/Kyle Roof/Lily Ray (venceu o seo-content-writer solo do Yaroslavle).',
    hint: 'Use to write full SEO articles — SERP self-research, semantic structure, anti-slop ruleset, no external APIs.'
  },
  {
    id: 'ai-seo',
    kind: 'skill',
    depts: ['copy'],
    group: 'conteúdo & SEO',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/ai-seo', ref: 'main' },
    summary:
      'AEO/GEO (~8k palavras, 5 referências): answer blocks, llms.txt, pesquisa de citação (Princeton GEO) e diferenças por plataforma — otimizar para respostas de IA, não só para o Google.',
    hint: 'Use to optimize content for AI answers (ChatGPT/Claude/Perplexity) — answer blocks, llms.txt, citation research.'
  },
  {
    id: 'long-form-content-frameworks',
    kind: 'skill',
    depts: ['copy'],
    group: 'conteúdo & SEO',
    source: {
      repo: 'rampstackco/claude-skills',
      path: 'skills/long-form-content-frameworks',
      ref: 'main'
    },
    summary:
      '7 formatos longos × 5 arquétipos estruturais, calibração de peso por seção e padrões de lede/fechamento (8 docs de referência) — nada mais no catálogo cobre long-form.',
    hint: 'Use when writing long-form content — pick the format × structure archetype, calibrate section weights.'
  },
  {
    id: 'content-and-copy',
    kind: 'skill',
    depts: ['copy'],
    group: 'conteúdo & SEO',
    source: { repo: 'rampstackco/claude-skills', path: 'skills/content-and-copy', ref: 'main' },
    summary:
      'Produção editorial geral em 5 dimensões (hook, estrutura, voz, substância, fechamento) com workflow brief-first — o complemento editorial da copywriting de conversão (venceu a gêmea draft-content da kwp).',
    hint: 'Use for general editorial production — brief-first workflow scoring hook/structure/voice/substance/closing.'
  },

  // ——— email & social ———
  {
    id: 'email-sequence',
    kind: 'skill',
    depts: ['copy'],
    group: 'email & social',
    source: {
      repo: 'anthropics/knowledge-work-plugins',
      path: 'marketing/skills/email-sequence',
      ref: 'main'
    },
    summary:
      'Sequências multi-email com copy completa, branching e condições de saída: 8 frameworks prontos com benchmarks (welcome, nurture, re-engajamento…) — a lane de lifecycle (venceu emails/corey e email-sequences/rampstack).',
    hint: 'Use when building lifecycle email sequences — 8 frameworks with full copy, branching and exit conditions.'
  },
  {
    id: 'cold-email',
    kind: 'skill',
    depts: ['copy'],
    group: 'email & social',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/cold-email', ref: 'main' },
    summary:
      'Cold outreach B2B: princípios de voz de PAR (não de vendedor), personalização em 4 níveis e cadências de follow-up (5 arquivos de referência) — outbound é job distinto de lifecycle.',
    hint: 'Use when writing B2B cold outreach — peer-voice principles, 4-level personalization, follow-up cadences.'
  },
  {
    id: 'social',
    kind: 'skill',
    depts: ['copy'],
    group: 'email & social',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/social', ref: 'main' },
    summary:
      'Playbooks por plataforma, hooks, sistema de repurposing, carrosséis e roteiros de vídeo curto (7 arquivos de referência). Os curls de social listening das referências são opcionais em runtime.',
    hint: 'Use when writing social content — platform playbooks, hooks, repurposing, carousels, short-video scripts.'
  },
  {
    id: 'developer-newsletter',
    kind: 'skill',
    depts: ['copy'],
    group: 'email & social',
    source: { repo: 'jonathimer/devmarketing-skills', path: 'skills/developer-newsletter', ref: 'main' },
    summary:
      'Newsletter para público DEV: mix 70-20-10, teste de subject line e higiene de entregabilidade (SPF/DKIM) — feita para produtos técnicos, o caso típico dos universos deste app.',
    hint: 'Use when writing developer-audience newsletters — 70-20-10 mix, subject testing, deliverability hygiene.'
  },

  // ——— lançamento, PR & collateral ———
  {
    id: 'launch',
    kind: 'skill',
    depts: ['copy'],
    group: 'lançamento, PR & collateral',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/launch', ref: 'main' },
    summary:
      'Lançamentos em 5 fases com o framework ORB de canais e playbook de Product Hunt (~3,5k palavras). A menção ao Introw nas referências é decorativa (link morre fora do repo, metodologia intacta).',
    hint: 'Use when planning/writing a product launch campaign — ORB channel framework, 5 phases, Product Hunt.'
  },
  {
    id: 'ce-promote',
    kind: 'skill',
    depts: ['copy'],
    group: 'lançamento, PR & collateral',
    source: { repo: 'EveryInc/compound-engineering-plugin', path: 'skills/ce-promote', ref: 'main' },
    summary:
      'Copy de divulgação do que JÁ SHIPOU a partir de PRs/diffs/changelog: thread de X, LinkedIn, changelog público. NOTA: traz disable-model-invocation — o executor claude não a auto-invoca (leia o SKILL.md pelo path ou use como comando; codex ignora a flag). Caminho Spiral é opcional e degrada.',
    hint: 'Use to draft promo copy for shipped work from PRs/diffs — X thread, LinkedIn, public changelog formats.'
  },
  {
    id: 'public-relations',
    kind: 'skill',
    depts: ['copy'],
    group: 'lançamento, PR & collateral',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/public-relations', ref: 'main' },
    summary:
      'PR de verdade: pitches para jornalistas com barra de qualidade em 6 pontos (≤150 palavras, fit de pauta), 4 modos de PR e medição anti-AVE (4 referências) — venceu o press-release solo do realjaymes.',
    hint: 'Use for PR work — journalist pitches with a 6-point quality bar, press releases, op-eds.'
  },
  {
    id: 'crisis-communications',
    kind: 'skill',
    depts: ['copy', 'cyber'],
    group: 'lançamento, PR & collateral',
    source: {
      repo: 'jamditis/claude-skills-journalism',
      path: 'journalism-core/skills/crisis-communications',
      ref: 'master'
    },
    summary:
      'Comunicação de crise/incidente: holding statements, correções, matrizes de escalada e comms sob pressão — do Center for Cooperative Media (Joe Amditis). (Branch master, pasta aninhada no plugin.)',
    hint: 'Use when writing incident/crisis communications — holding statements, corrections, escalation matrices.'
  },
  {
    id: 'stakeholder-update',
    kind: 'skill',
    depts: ['copy'],
    group: 'lançamento, PR & collateral',
    source: {
      repo: 'anthropics/knowledge-work-plugins',
      path: 'product-management/skills/stakeholder-update',
      ref: 'main'
    },
    summary:
      'Updates sob medida por audiência (exec/eng/cross-func/cliente/board): disciplina green-yellow-red, riscos ROAM e "conclusão primeiro" — a melhor skill de comms interno do mercado (venceu a internal-comms de templates).',
    hint: 'Use when writing stakeholder/status updates — audience-tailored, status discipline, lead with the conclusion.'
  },
  {
    id: 'sales-enablement',
    kind: 'skill',
    depts: ['copy'],
    group: 'lançamento, PR & collateral',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/sales-enablement', ref: 'main' },
    summary:
      'Autoria de collateral de vendas: decks slide-a-slide com speaker notes, one-pagers, talk tracks de objeção e roteiros de demo cronometrados ("se o vendedor reescreve teu deck, você escreveu o deck errado").',
    hint: 'Use when authoring sales collateral — decks with speaker notes, one-pagers, objection talk tracks, demo scripts.'
  },
  {
    id: 'ad-creative',
    kind: 'skill',
    depts: ['copy'],
    group: 'lançamento, PR & collateral',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/ad-creative', ref: 'main' },
    summary:
      'Ad copy ATERRADA em evidência (v2.8, a mais iterada do repo): headlines/descrições/primary text rastreados a anúncios vencedores e reviews — recusa geração sem grounding; modos com APIs de plataforma são opcionais.',
    hint: 'Use when writing ad copy — grounded generation traced to winning ads and reviews; refuses ungrounded output.'
  },
  {
    id: 'aso',
    kind: 'skill',
    depts: ['copy'],
    group: 'lançamento, PR & collateral',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/aso', ref: 'main' },
    summary:
      'Auditoria de copy de loja de app (ASO): busca o listing real, classifica tier de marca e prescreve mudanças COM contagem de caracteres por campo (specs Apple/Google Play + benchmarks nas referências).',
    hint: 'Use when auditing/writing app-store listing copy — scored dimensions and prescriptive changes with character counts.'
  },

  // ——— subagentes de copy (mercado) ———
  {
    id: 'seo-content-writer',
    kind: 'agent',
    depts: ['copy'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/seo-content-creation/agents/seo-content-writer.md',
      ref: 'main'
    },
    summary:
      'Escreve artigos SEO com padrões MENSURÁVEIS: densidade 0,5-1,5%, nível de leitura grade 8-10, sinais E-E-A-T e pacote completo (artigo + títulos + meta + FAQ). (Name verbatim, sem prefixo de plugin.)',
    hint: 'Delegate writing an SEO article — measurable standards and a complete output package (article, titles, meta, FAQ).'
  },
  {
    id: 'seo-content-auditor',
    kind: 'agent',
    depts: ['copy'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/seo-content-creation/agents/seo-content-auditor.md',
      ref: 'main'
    },
    summary:
      'Audita conteúdo existente com nota 1-10 por dimensão (profundidade, E-E-A-T, legibilidade) em tabela com correções priorizadas.',
    hint: 'Delegate auditing existing content for SEO quality — scored table with prioritized fixes.'
  },
  {
    id: 'seo-meta-optimizer',
    kind: 'agent',
    depts: ['copy'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/seo-technical-optimization/agents/seo-meta-optimizer.md',
      ref: 'main'
    },
    summary:
      'Meta titles/descriptions/URLs dentro do orçamento de caracteres, com variantes A/B — a superfície de copy mais negligenciada dos projetos.',
    hint: 'Delegate writing meta titles/descriptions/URLs — character budgets and A/B variants.'
  },
  {
    id: 'copywriter-specialist',
    kind: 'agent',
    depts: ['copy'],
    group: 'subagentes especializados',
    source: {
      repo: 'rshah515/claude-code-subagents',
      path: 'marketing/content-production/copywriter-specialist.md',
      ref: 'main'
    },
    summary:
      'O melhor copywriter generalista do mercado de agents (~4,2k palavras): AIDA/PAS/Before-After-Bridge, protocolo de A/B e ética de "só escassez real" — tools limpas.',
    hint: 'Delegate conversion copywriting — classic frameworks, A/B protocol, real-scarcity-only ethics.'
  },
  {
    id: 'content-editor',
    kind: 'agent',
    depts: ['copy'],
    group: 'subagentes especializados',
    source: {
      repo: 'rshah515/claude-code-subagents',
      path: 'marketing/content-production/content-editor.md',
      ref: 'main'
    },
    summary:
      'Edição multi-nível na ordem certa (estrutura antes de linha), fact-check com fontes primárias e QA de voz de marca — o executor delegável das skills de edição.',
    hint: 'Delegate editing a draft — structural-then-line passes, primary-source fact-check, brand-voice QA.'
  },
  {
    id: 'email-copywriter',
    kind: 'agent',
    depts: ['copy'],
    group: 'subagentes especializados',
    source: {
      repo: 'rshah515/claude-code-subagents',
      path: 'marketing/email-marketing/email-copywriter.md',
      ref: 'main'
    },
    summary:
      'Email copy com psicologia de subject line (curiosity gap), CTAs de verbo-resultado e A/B de 1 variável. (As tools firecrawl da lista são opcionais — WebSearch/WebFetch presentes cobrem.)',
    hint: 'Delegate writing email copy — subject-line psychology, outcome-verb CTAs, single-variable A/B.'
  },
  {
    id: 'social-content-creator',
    kind: 'agent',
    depts: ['copy'],
    group: 'subagentes especializados',
    source: {
      repo: 'rshah515/claude-code-subagents',
      path: 'marketing/social-media/social-content-creator.md',
      ref: 'main'
    },
    summary:
      'Social copy por mecânica de plataforma: hook nos 3s do TikTok, carrossel hook→valor→CTA, limites por rede — declara tools playwright que os panes de execução já injetam.',
    hint: 'Delegate producing platform-native social copy — platform mechanics, hooks, carousels, video scripts.'
  },

  // ————————————————————————————————————————————————————————————————————————
  // RODADA 8: CYBER (2026-07-30). Núcleo = trailofbits/skills (23 skills,
  // CC-BY-SA-4.0 — precedente property-based-testing; repo com commit do
  // PRÓPRIO dia da varredura, pasta=name em 100% dos casos) + coleções
  // (wshobson security-scanning SEM prefixo no name desta vez, petrkindlmann,
  // Jeffallan, Phoenix, daymade). Re-tags: oauth/security-best-practices/
  // owasp-security(★)/secrets-management/property-based-testing (back→+cyber),
  // incident-responder (agent back→+cyber), crisis-communications
  // (copy→+cyber). Colisões geridas: id `security-reviewer` disputado por
  // Phoenix×Jeffallan — Phoenix venceu (7 guias por linguagem); o name
  // `security-review` NÃO existe em nenhuma aceita (sombrearia o comando
  // built-in do claude); mutation-testing/semgrep/codeql/coverage-analysis
  // duplicadas DENTRO do ToB (testing-handbook × plugins) — venceram as
  // operacionais do static-analysis. Racional e descartes em docs/SKILLS.md.
  // ————————————————————————————————————————————————————————————————————————

  // ——— review de segurança ———
  {
    id: 'differential-review',
    kind: 'skill',
    depts: ['cyber'],
    group: 'review de segurança',
    source: { repo: 'trailofbits/skills', path: 'plugins/differential-review/skills/differential-review', ref: 'main' },
    summary:
      'Review de segurança de DIFFs/PRs da Trail of Bits: adapta a profundidade ao tamanho da mudança, calcula blast radius com histórico git e previne regressão — o gate cyber do dia a dia, par do code-review do qa.',
    hint: 'Use to security-review a diff/PR/commit — blast radius, depth adapted to change size, markdown report.',
    defaultFor: ['cyber']
  },
  {
    id: 'fp-check',
    kind: 'skill',
    depts: ['cyber'],
    group: 'review de segurança',
    source: { repo: 'trailofbits/skills', path: 'plugins/fp-check/skills/fp-check', ref: 'main' },
    summary:
      'Verificação sistemática de finding suspeito → veredito TRUE/FALSE POSITIVE com evidência e gates de revisão obrigatórios — o carimbo pós-scan.',
    hint: 'Use to verify whether a specific suspected vulnerability is real or a false positive — not for hunting.'
  },
  {
    id: 'vulnerability-triage-brocards',
    kind: 'skill',
    depts: ['cyber'],
    group: 'review de segurança',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/vulnerability-triage-brocards/skills/vulnerability-triage-brocards',
      ref: 'main'
    },
    summary:
      'Triage de reports/CVEs/bounty com 7 "brocards" falsificáveis (coerência com o threat model, alcançabilidade, proporcionalidade) → aceitar/descartar/pedir mais info.',
    hint: 'Use to triage incoming vulnerability reports/CVEs/bounty submissions before investing investigation time.'
  },
  {
    id: 'variant-analysis',
    kind: 'skill',
    depts: ['cyber'],
    group: 'review de segurança',
    source: { repo: 'trailofbits/skills', path: 'plugins/variant-analysis/skills/variant-analysis', ref: 'main' },
    summary:
      'Achou 1 bug → acha os irmãos: generalização iterativa do padrão (rg→semgrep→codeql) com teto de falso positivo e templates de query por linguagem.',
    hint: 'Use after finding one vulnerability to hunt its variants across the codebase via patterns/queries.'
  },
  {
    id: 'audit-context-building',
    kind: 'skill',
    depts: ['cyber'],
    group: 'review de segurança',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/audit-context-building/skills/audit-context-building',
      ref: 'main'
    },
    summary:
      'Contexto arquitetural linha a linha (invariantes, fluxos) ANTES de caçar bug — anti-alucinação para auditoria séria; pesada em tokens por natureza.',
    hint: 'Use before a deep security audit to build line-by-line architectural context of the target.'
  },
  {
    id: 'security-reviewer',
    kind: 'skill',
    depts: ['cyber'],
    group: 'review de segurança',
    source: {
      repo: 'Security-Phoenix-demo/security-skills-claude-code',
      path: 'skills/Security Assessment/Security-automated-claude-skills/.claude/skills/security-reviewer',
      ref: 'main'
    },
    summary:
      'A metodologia de secure code review POR LINGUAGEM mais funda da varredura: 7 guias (py/js-ts/go/rust/java/ruby/dotnet) + OWASP/ASVS L1, 8 categorias de diagnóstico e template por finding — as menções a hooks/subagent externos são decorativas (a pasta é autocontida).',
    hint: 'Use for a per-language secure code review of new/changed code — 8 diagnostic categories, per-finding output template.'
  },

  // ——— threat modeling ———
  {
    id: 'stride-analysis-patterns',
    kind: 'skill',
    depts: ['cyber'],
    group: 'threat modeling',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/security-scanning/skills/stride-analysis-patterns',
      ref: 'main'
    },
    summary:
      'STRIDE de verdade: matriz de ameaças + referência de ~5k palavras (template de documento, análise por interação/DFD, matrizes de risco) — o slot de threat modeling que faltava no catálogo.',
    hint: 'Use when threat-modeling a system or feature — STRIDE methodology, DFD analysis, risk matrices.'
  },
  {
    id: 'attack-tree-construction',
    kind: 'skill',
    depts: ['cyber'],
    group: 'threat modeling',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/security-scanning/skills/attack-tree-construction',
      ref: 'main'
    },
    summary:
      'Árvores de ataque com nós OR/AND e atributos de custo/tempo/skill/detecção — visualiza caminhos de ameaça contra o próprio sistema e prioriza defesas; complementa o STRIDE.',
    hint: 'Use to build attack trees mapping threat paths and defense gaps against your own system.'
  },
  {
    id: 'threat-mitigation-mapping',
    kind: 'skill',
    depts: ['cyber'],
    group: 'threat modeling',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/security-scanning/skills/threat-mitigation-mapping',
      ref: 'main'
    },
    summary:
      'Fecha o ciclo ameaça→controle: biblioteca de 13+ controles, análise de cobertura/lacunas e defense-in-depth com scoring — o trio de threat modeling instala bem junto.',
    hint: 'Use to map identified threats to security controls and build a prioritized remediation plan.'
  },
  {
    id: 'security-requirement-extraction',
    kind: 'skill',
    depts: ['cyber'],
    group: 'threat modeling',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/security-scanning/skills/security-requirement-extraction',
      ref: 'main'
    },
    summary:
      'Ameaça → requisito de segurança TESTÁVEL (user stories, rastreabilidade, casos de teste) — a ponte do threat model para os cards do orquestrador.',
    hint: 'Use to derive actionable security requirements/user stories from a threat model.'
  },

  // ——— código & config seguros ———
  {
    id: 'insecure-defaults',
    kind: 'skill',
    depts: ['cyber'],
    group: 'código & config seguros',
    source: { repo: 'trailofbits/skills', path: 'plugins/insecure-defaults/skills/insecure-defaults', ref: 'main' },
    summary:
      'Caça defaults fail-open: secret hardcoded, auth fraca, config permissiva — com trace do code path para só reportar o que é explorável em produção.',
    hint: 'Use when auditing config/env handling for fail-open defaults, hardcoded credentials and permissive security.',
    defaultFor: ['cyber']
  },
  {
    id: 'sharp-edges',
    kind: 'skill',
    depts: ['cyber'],
    group: 'código & config seguros',
    source: { repo: 'trailofbits/skills', path: 'plugins/sharp-edges/skills/sharp-edges', ref: 'main' },
    summary:
      'APIs footgun, configs perigosas e ergonomia criptográfica que induz erro: 6 categorias, 3 perfis de adversário, severidade — read-only e barata, complementa a insecure-defaults.',
    hint: 'Use when reviewing API/config/crypto ergonomics for misuse-resistance and secure-by-default design.'
  },
  {
    id: 'secure-code-guardian',
    kind: 'skill',
    depts: ['cyber'],
    group: 'código & config seguros',
    source: { repo: 'Jeffallan/claude-skills', path: 'skills/secure-code-guardian', ref: 'main' },
    summary:
      'O lado BUILD da segurança: implementar authN/authZ/validação direito (bcrypt/argon2, SQL parametrizado, Zod, JWT, CORS/CSP, cookies) com 5 exemplos funcionais e checkpoints — par de implementação do owasp-security.',
    hint: 'Use when IMPLEMENTING auth, input validation or security headers — working patterns with MUST/MUST-NOT constraints.'
  },

  // ——— testes de segurança & privacidade ———
  {
    id: 'security-testing',
    kind: 'skill',
    depts: ['cyber', 'qa'],
    group: 'testes de segurança & privacidade',
    source: { repo: 'petrkindlmann/qa-skills', path: 'skills/security-testing', ref: 'main' },
    summary:
      'Verificação de segurança do PRÓPRIO app em CI, 5 camadas (secret scan→deps→SAST→DAST ZAP→testes de auth) + padrões Playwright de XSS/CSRF/SQLi/SSRF/IDOR e JWT alg:none — exige provar que o teste FALHA contra alvo vulnerável.',
    hint: 'Use to add automated security verification of your own app — CI scanning layers plus negative-path auth/injection tests.',
    defaultFor: ['cyber'],
    allowedPhases: ['dev', 'helper'],
    requiresCapabilities: ['read', 'write', 'shell']
  },
  {
    id: 'compliance-testing',
    kind: 'skill',
    depts: ['cyber', 'qa'],
    group: 'testes de segurança & privacidade',
    source: { repo: 'petrkindlmann/qa-skills', path: 'skills/compliance-testing', ref: 'main' },
    summary:
      'Privacidade/consentimento EXECUTÁVEL: cookies pré-consentimento bloqueados, TCF v2/Consent Mode v2, GPC, AI Act art. 50 e drift de inventário de cookies — metodologia GDPR que transfere para a LGPD.',
    hint: 'Use to test consent/privacy compliance — CMP behavior, pre-consent blocking, GPC, cookie inventory drift.'
  },
  {
    id: 'ai-system-testing',
    kind: 'skill',
    depts: ['cyber', 'qa'],
    group: 'testes de segurança & privacidade',
    source: { repo: 'petrkindlmann/qa-skills', path: 'skills/ai-system-testing', ref: 'main' },
    summary:
      'Segurança DEFENSIVA de features com LLM: red-team do próprio produto (injeção direta e indireta via tool output/RAG, exfiltração por agente), regressão de prompts, grounding e detector de conteúdo não-confiável embutido.',
    hint: 'Use to test LLM features you ship — prompt-injection red-teaming, tool-call validation, RAG grounding, evals.'
  },

  // ——— SAST & scanners ———
  {
    id: 'semgrep',
    kind: 'skill',
    depts: ['cyber'],
    group: 'SAST & scanners',
    source: { repo: 'trailofbits/skills', path: 'plugins/static-analysis/skills/semgrep', ref: 'main' },
    summary:
      'Orquestra scan Semgrep com subagentes paralelos, 2 modos (tudo × alta confiança) e rulesets ToB/0xdea/Decurity — exige o CLI semgrep; o script de merge SARIF do plugin mora FORA da pasta (single-folder degrada o merge; a sarif-parsing cobre a agregação).',
    hint: 'Use to run a Semgrep security scan of the codebase — parallel workers, curated rulesets, SARIF output.'
  },
  {
    id: 'codeql',
    kind: 'skill',
    depts: ['cyber'],
    group: 'SAST & scanners',
    source: { repo: 'trailofbits/skills', path: 'plugins/static-analysis/skills/codeql', ref: 'main' },
    summary:
      'Pipeline CodeQL completo (database→data extensions→taint tracking interprocedural) — exige o CLI codeql e assume ambiente unix-like (no Windows, WSL é a ressalva real).',
    hint: 'Use for deep CodeQL analysis with taint tracking — build DB, data extensions, SARIF processing.'
  },
  {
    id: 'sarif-parsing',
    kind: 'skill',
    depts: ['cyber'],
    group: 'SAST & scanners',
    source: { repo: 'trailofbits/skills', path: 'plugins/static-analysis/skills/sarif-parsing', ref: 'main' },
    summary:
      'Pós-processamento SARIF de qualquer scanner (CodeQL/Semgrep): filtro, dedupe, conversão e integração CI com 40+ queries jq prontas — não roda scans.',
    hint: 'Use to parse/aggregate/deduplicate SARIF results from static-analysis tools.'
  },
  {
    id: 'semgrep-rule-creator',
    kind: 'skill',
    depts: ['cyber'],
    group: 'SAST & scanners',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/semgrep-rule-creator/skills/semgrep-rule-creator',
      ref: 'main'
    },
    summary:
      'Regra Semgrep custom test-first (análise de AST obrigatória, gates de validação) — transforma bug achado em detecção permanente; consulta docs oficiais do semgrep em runtime (referência, não ruleset executável).',
    hint: 'Use to write a custom Semgrep rule for a vulnerability or code pattern of your codebase — test-first.'
  },
  {
    id: 'semgrep-rule-variant-creator',
    kind: 'skill',
    depts: ['cyber'],
    group: 'SAST & scanners',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/semgrep-rule-variant-creator/skills/semgrep-rule-variant-creator',
      ref: 'main'
    },
    summary:
      'Porta uma regra Semgrep existente para outras linguagens com validação test-driven por alvo — o par da rule-creator.',
    hint: 'Use to port an existing Semgrep rule to more languages with per-language tests.'
  },

  // ——— supply chain & segredos ———
  {
    id: 'supply-chain-risk-auditor',
    kind: 'skill',
    depts: ['cyber'],
    group: 'supply chain & segredos',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/supply-chain-risk-auditor/skills/supply-chain-risk-auditor',
      ref: 'main'
    },
    summary:
      'Auditoria de dependências por risco de takeover: 6 critérios objetivos (mantenedor único, abandono, CVEs, canal de segurança) — exige gh CLI; cria workspace local próprio.',
    hint: 'Use to assess dependency/supply-chain risk and flag takeover-prone packages.'
  },
  {
    id: 'agentic-actions-auditor',
    kind: 'skill',
    depts: ['cyber'],
    group: 'supply chain & segredos',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/agentic-actions-auditor/skills/agentic-actions-auditor',
      ref: 'main'
    },
    summary:
      'Audita GitHub Actions que RODAM agentes de IA: 9 vetores de input controlado por atacante chegando ao agente no CI (prompt injection, exfiltração) — diretamente relevante para apps como o próprio Synkora.',
    hint: 'Use to audit AI-agent GitHub Actions workflows for prompt-injection/exfiltration attack vectors.'
  },
  {
    id: 'open-sourcing',
    kind: 'skill',
    depts: ['cyber'],
    group: 'supply chain & segredos',
    source: { repo: 'trailofbits/skills', path: 'plugins/open-sourcing/skills/open-sourcing', ref: 'main' },
    summary:
      'Prontidão para abrir um repo: auditoria de secrets como passo 1 IRREVERSÍVEL, licenciamento, docs, CI e empacotamento por linguagem — adicionada upstream em 2026-07-29, fresquíssima.',
    hint: 'Use before making a repo public — secrets hygiene, licensing, CI and release readiness.'
  },
  {
    id: 'github-sensitive-data-cleanup',
    kind: 'skill',
    depts: ['cyber'],
    group: 'supply chain & segredos',
    source: { repo: 'daymade/claude-code-skills', path: 'github-sensitive-data-cleanup', ref: 'main' },
    summary:
      'A REMEDIAÇÃO do vazamento: varre e REESCREVE o histórico git (gitleaks→regex→review semântico + git filter-repo com backup em bundle e gates de visibilidade) — destrutiva por natureza; exige python, gitleaks, git-filter-repo e gh.',
    hint: 'Use AFTER a secret leaked into git history — scan and rewrite history safely, with backups and verification.'
  },

  // ——— criptografia ———
  {
    id: 'wycheproof',
    kind: 'skill',
    depts: ['cyber'],
    group: 'criptografia',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/testing-handbook-skills/skills/wycheproof',
      ref: 'main'
    },
    summary:
      'Valida implementações criptográficas contra os vetores Wycheproof (AES-GCM, ECDSA, RSA…) — baixa VETORES DE TESTE (JSON de dados do repo C2SP, não instruções nem executável).',
    hint: 'Use to test crypto implementations against known-attack test vectors (Wycheproof suite).'
  },
  {
    id: 'constant-time-analysis',
    kind: 'skill',
    depts: ['cyber'],
    group: 'criptografia',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/constant-time-analysis/skills/constant-time-analysis',
      ref: 'main'
    },
    summary:
      'Side-channels de timing em código cripto — 11 linguagens INCLUINDO JS/TS/Python (menos nicho do que parece), analyzer local e triage de FP; KyberSlash e Lucky Thirteen como casos reais.',
    hint: 'Use when implementing/reviewing crypto code for timing side-channels (secret-dependent branches/division).'
  },
  {
    id: 'zeroize-audit',
    kind: 'skill',
    depts: ['cyber'],
    group: 'criptografia',
    source: { repo: 'trailofbits/skills', path: 'plugins/zeroize-audit/skills/zeroize-audit', ref: 'main' },
    summary:
      'Zeroização de segredos ausente OU eliminada pelo compilador (diff de IR/ASM por nível de otimização) em C/C++/Rust — deps pesadas (clang, cargo nightly, Python); o MCP serena citado é opcional de verdade.',
    hint: 'Use to audit C/C++/Rust secret handling for missing or compiler-eliminated zeroization.'
  },

  // ——— fuzzing & sanitizers ———
  {
    id: 'harness-writing',
    kind: 'skill',
    depts: ['cyber'],
    group: 'fuzzing & sanitizers',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/testing-handbook-skills/skills/harness-writing',
      ref: 'main'
    },
    summary:
      'Harness de fuzzing eficaz multi-linguagem — ~5,8k palavras do Testing Handbook da ToB EMBUTIDAS na skill (zero fetch do site).',
    hint: 'Use when creating or improving fuzz targets/harnesses in any supported language.'
  },
  {
    id: 'fuzzing-obstacles',
    kind: 'skill',
    depts: ['cyber'],
    group: 'fuzzing & sanitizers',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/testing-handbook-skills/skills/fuzzing-obstacles',
      ref: 'main'
    },
    summary:
      'Destrava fuzzer parado: patch de checksums, estado global e outras barreiras, com before/after C++/Rust — autocontida.',
    hint: 'Use when a fuzzer stalls on checksums/global state — patch techniques to unblock it.'
  },
  {
    id: 'address-sanitizer',
    kind: 'skill',
    depts: ['cyber'],
    group: 'fuzzing & sanitizers',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/testing-handbook-skills/skills/address-sanitizer',
      ref: 'main'
    },
    summary:
      'ASan de ponta a ponta no fuzzing: compilar, configurar, interpretar relatórios de erro de memória e limites, com tabela de troubleshooting.',
    hint: 'Use to wire AddressSanitizer into builds/fuzzing and interpret its memory-error reports.'
  },

  // ——— hardening de infra ———
  {
    id: 'k8s-security-policies',
    kind: 'skill',
    depts: ['cyber'],
    group: 'hardening de infra',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/kubernetes-operations/skills/k8s-security-policies',
      ref: 'main'
    },
    summary:
      'Hardening K8s de produção: Pod Security Standards, NetworkPolicy, RBAC (5 padrões de least-privilege), OPA Gatekeeper/Rego e Istio mTLS — só YAML declarativo; peso morto em projeto sem k8s.',
    hint: 'Use when securing Kubernetes — Pod Security Standards, NetworkPolicy, RBAC least-privilege, Gatekeeper.'
  },

  // ——— auditoria por linguagem ———
  {
    id: 'c-review',
    kind: 'skill',
    depts: ['cyber'],
    group: 'auditoria por linguagem',
    source: { repo: 'trailofbits/skills', path: 'plugins/c-review/skills/c-review', ref: 'main' },
    summary:
      'Auditoria C/C++ multi-agente da ToB (workers paralelos + 2 judges + SARIF, ~47 classes de bug) — nicho de linguagem e orquestração PESADA em tokens; exige python3.',
    hint: 'Use for a comprehensive C/C++ security audit — orchestrated parallel workers, dedup/FP judges, SARIF report.'
  },
  {
    id: 'rust-review',
    kind: 'skill',
    depts: ['cyber'],
    group: 'auditoria por linguagem',
    source: { repo: 'trailofbits/skills', path: 'plugins/rust-review/skills/rust-review', ref: 'main' },
    summary:
      'Idem para Rust: fronteira safe/unsafe, memória em unsafe, concorrência, panic-DoS, FFI, async — mesmas ressalvas de custo do c-review.',
    hint: 'Use for a comprehensive Rust security audit — unsafe boundary, FFI, concurrency, panic-DoS.'
  },

  // ——— complemento da descoberta ampla (2026-07-30, mesma rodada) ———
  {
    id: 'security-threat-model',
    kind: 'skill',
    depts: ['cyber'],
    group: 'threat modeling',
    source: { repo: 'openai/skills', path: 'skills/.curated/security-threat-model', ref: 'main' },
    summary:
      'Threat modeling ANCORADO NO REPO (OpenAI, Apache-2.0 por skill): 8 passos com evidência do próprio código e gate de validação com o usuário — complementa o trio STRIDE genérico; repo deprecated, o pin por sha segura a cópia.',
    hint: 'Use to threat-model grounded in the actual code of the current repo — evidence-anchored 8-step methodology.'
  },
  {
    id: 'security-ownership-map',
    kind: 'skill',
    depts: ['cyber'],
    group: 'review de segurança',
    source: { repo: 'openai/skills', path: 'skills/.curated/security-ownership-map', ref: 'main' },
    summary:
      'Mapa de DONOS do código sensível via histórico git: bus factor, código órfão, reality-check de CODEOWNERS, export CSV/JSON — nicho único da varredura; exige Python + networkx.',
    hint: 'Use to map security-relevant code ownership and find orphaned sensitive code from git history.'
  },
  {
    id: 'privacy-engineering',
    kind: 'skill',
    depts: ['cyber'],
    group: 'testes de segurança & privacidade',
    source: { repo: 'briiirussell/cybersecurity-skills', path: 'skills/privacy-engineering', ref: 'main' },
    summary:
      'Privacidade de ponta a ponta COM LGPD EXPLÍCITA (+ GDPR/CCPA/PIPEDA): pipeline de DSAR, deleção em cascata (backups/caches/analytics), DPIA, relógio de 72h de breach e greps de auditoria — o top pick de privacidade da varredura.',
    hint: 'Use for privacy engineering — DSAR pipelines, deletion fan-out, DPIA, breach clocks (LGPD/GDPR/CCPA).'
  },
  {
    id: 'secrets-audit',
    kind: 'skill',
    depts: ['cyber'],
    group: 'supply chain & segredos',
    source: { repo: 'briiirussell/cybersecurity-skills', path: 'skills/secrets-audit', ref: 'main' },
    summary:
      'Higiene de segredos agnóstica de ferramenta: detecção de vazamento (histórico git, artefatos, Docker/CI) + postura, greps para 8+ provedores, comparação gitleaks/trufflehog e triage de rotação por blast radius.',
    hint: 'Use to audit secrets hygiene and leaks across git history, artifacts and CI — detection plus rotation triage.'
  },
  {
    id: 'iac-checkov',
    kind: 'skill',
    depts: ['cyber'],
    group: 'hardening de infra',
    source: { repo: 'AgentSecOps/SecOpsAgentKit', path: 'skills/devsecops/iac-checkov', ref: 'main' },
    summary:
      'Hardening de IaC com Checkov (Terraform/CloudFormation/K8s/Docker): scan, triage e correção com scripts e referências NA pasta — exige pip install checkov; licença CC-BY-SA-4.0 + MPL-2.0.',
    hint: 'Use to scan and harden IaC (Terraform/K8s/Docker) with Checkov — run, triage and fix findings.'
  },

  // ——— gap-sweep final (GoldenWing-360 = a coleção defensiva mais
  // substanciosa fora da ToB; repo jovem, monitorar) + GitGuardian oficial ———
  {
    id: 'prompt-injection-defense',
    kind: 'skill',
    depts: ['cyber'],
    group: 'segurança de agentes/LLM',
    source: { repo: 'GoldenWing-360/claude-security-skills', path: 'prompt-injection-defense', ref: 'main' },
    summary:
      'Defesa contra injeção direta/indireta em apps LLM: source-of-trust tagging, confirmação de tools após conteúdo não-confiável, bloqueio de exfiltração via imagem markdown e checklist red-team.',
    hint: 'Use to harden LLM features against direct/indirect prompt injection — trust tagging, tool confirmation, exfiltration blocks.'
  },
  {
    id: 'mcp-security',
    kind: 'skill',
    depts: ['cyber'],
    group: 'segurança de agentes/LLM',
    source: { repo: 'GoldenWing-360/claude-security-skills', path: 'mcp-security', ref: 'main' },
    summary:
      'Auditoria de configs MCP: risk-tiering em 5 níveis, detecção de server malicioso (tool-description poisoning, postinstall), least-privilege e rotação — sob medida para um ADE cheio de MCPs.',
    hint: 'Use to audit MCP server configs — risk tiers, malicious-server indicators, least-privilege scoping.'
  },
  {
    id: 'llm-app-security',
    kind: 'skill',
    depts: ['cyber'],
    group: 'segurança de agentes/LLM',
    source: { repo: 'GoldenWing-360/claude-security-skills', path: 'llm-app-security', ref: 'main' },
    summary:
      'OWASP LLM Top 10 mapeado a controles OPERACIONAIS: rate limits, cost caps com kill-switch $/dia, PII scrubbing, pinning de modelo e audit logs — o complemento operacional do prompt-injection-defense.',
    hint: 'Use for operational LLM app controls — OWASP LLM Top 10, rate/cost caps, PII scrubbing, audit logs.'
  },
  {
    id: 'scan-secrets',
    kind: 'skill',
    depts: ['cyber'],
    group: 'supply chain & segredos',
    source: { repo: 'GitGuardian/agent-skills', path: 'skills/scan-secrets', ref: 'main' },
    summary:
      'Vendor OFICIAL GitGuardian: varre paths, staged, histórico git, imagens Docker e pacotes por 700+ tipos de segredo via ggshield, com gestão de falso positivo — exige ggshield CLI + conta (free tier); NUNCA instalar a irmã install-hooks (mexe em config global).',
    hint: 'Use to scan paths, git history, Docker images and packages for 700+ secret types via ggshield.'
  },
  {
    id: 'secret-hygiene',
    kind: 'skill',
    depts: ['cyber'],
    group: 'supply chain & segredos',
    source: { repo: 'GoldenWing-360/claude-security-skills', path: 'secret-hygiene', ref: 'main' },
    summary:
      'Ciclo de vida do segredo SEM exigir conta: ordem de rotação (o vazado primeiro), purge de histórico com git-filter-repo como último recurso, prevenção pre-commit e tabela de prefixos de token — par do scan-secrets.',
    hint: 'Use to rotate leaked credentials in the right order and prevent recurrence — no vendor account needed.'
  },
  {
    id: 'dependency-supply-chain',
    kind: 'skill',
    depts: ['cyber'],
    group: 'supply chain & segredos',
    source: {
      repo: 'GoldenWing-360/claude-security-skills',
      path: 'dependency-supply-chain',
      ref: 'main'
    },
    summary:
      'Cadeia de suprimentos npm/pnpm/PyPI: higiene de lockfile, limites do npm audit, socket.dev/OSV, revisão de postinstall, typosquat/SLOPSQUAT e CI sem credencial — o curl à api do npm é métrica, não instrução.',
    hint: 'Use to defend against malicious dependencies — lockfiles, postinstall review, typosquats, behavior scanning.'
  },
  {
    id: 'github-actions-security',
    kind: 'skill',
    depts: ['cyber'],
    group: 'supply chain & segredos',
    source: {
      repo: 'GoldenWing-360/claude-security-skills',
      path: 'github-actions-security',
      ref: 'main'
    },
    summary:
      'Hardening de GitHub Actions: SHA-pinning, GITHUB_TOKEN mínimo, OIDC no lugar de credencial longa e a armadilha pull_request_target — o par GERAL do agentic-actions-auditor (que cobre o caso com agentes de IA).',
    hint: 'Use to harden GitHub Actions — SHA pinning, scoped tokens, OIDC, pull_request_target trap.'
  },
  {
    id: 'nextjs-security',
    kind: 'skill',
    depts: ['cyber'],
    group: 'código & config seguros',
    source: { repo: 'GoldenWing-360/claude-security-skills', path: 'nextjs-security', ref: 'main' },
    summary:
      'Hardening específico de Next.js — o melhor conteúdo web da varredura: CVE-2025-29927 (middleware bypass), CSP com nonce no App Router, vazamento NEXT_PUBLIC_, RSC over-fetch e SSRF via remotePatterns.',
    hint: 'Use when hardening a Next.js app — middleware bypass, CSP nonces, NEXT_PUBLIC leaks, image SSRF.'
  },
  {
    id: 'docker-container-security',
    kind: 'skill',
    depts: ['cyber'],
    group: 'hardening de infra',
    source: {
      repo: 'GoldenWing-360/claude-security-skills',
      path: 'docker-container-security',
      ref: 'main'
    },
    summary:
      'Baseline de containers: non-root, filesystem read-only, cap-drop, secrets por mount, trivy no CI, distroless e o pitfall Docker-ignora-UFW — o exemplo wget sem checksum no corpo é guidance, anotado.',
    hint: 'Use to harden Docker containers — non-root, read-only fs, dropped caps, trivy scans, distroless.'
  },

  // ——— SUBAGENTES especializados (rodada cyber) ———
  // O mercado de segurança publica hooks/MCP/skills, quase nunca subagente:
  // 24 dos 30 agents do ToB são presos a orquestrador de pipeline — estes são
  // as exceções standalone. O plugin claude-security OFICIAL da Anthropic é
  // PROPRIETÁRIO (proíbe uso com produto não-Anthropic) — nunca instalar.
  {
    id: 'data-flow-analyzer',
    kind: 'agent',
    depts: ['cyber'],
    group: 'subagentes especializados',
    source: { repo: 'trailofbits/skills', path: 'plugins/fp-check/agents/data-flow-analyzer.md', ref: 'main' },
    summary:
      'Rastreia source→sink de uma suspeita de vuln: fronteiras de confiança, contratos de API, proteções de ambiente — toda afirmação com file:line, "provavelmente" proibido; o mais limpo do lote ToB.',
    hint: 'Delegate tracing whether attacker-controlled data actually reaches a suspected sink — every claim cited at file:line.'
  },
  {
    id: 'exploitability-verifier',
    kind: 'agent',
    depts: ['cyber'],
    group: 'subagentes especializados',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/fp-check/agents/exploitability-verifier.md',
      ref: 'main'
    },
    summary:
      'Decide se a suspeita é EXPLORÁVEL de verdade: prova controle do atacante, limites matemáticos e viabilidade de corrida — separa "impossível / inviável na prática / viável" antes de alguém gastar um fix.',
    hint: 'Delegate deciding whether a suspected vulnerability is truly exploitable before anyone spends a fix on it.'
  },
  {
    id: 'sharp-edges-analyzer',
    kind: 'agent',
    depts: ['cyber'],
    group: 'subagentes especializados',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/sharp-edges/agents/sharp-edges-analyzer.md',
      ref: 'main'
    },
    summary:
      'Audita a superfície PRÓPRIA (APIs, configs, defaults) por resistência a mau uso — "uso seguro tem de ser o caminho de menor resistência"; 6 categorias de footgun com severidade e file:line; par da skill sharp-edges.',
    hint: 'Delegate reviewing our APIs/configs for footguns and dangerous defaults — misuse-resistance review.',
    defaultFor: ['cyber']
  },
  {
    id: 'poc-builder',
    kind: 'agent',
    depts: ['cyber'],
    group: 'subagentes especializados',
    source: { repo: 'trailofbits/skills', path: 'plugins/fp-check/agents/poc-builder.md', ref: 'main' },
    summary:
      'PoC concreto de vuln JÁ confirmada (pseudocódigo + executável + teste) e PoC negativo das pré-condições — valores concretos, nunca placeholder; ESCREVE arquivos, não usar como gate read-only.',
    hint: 'Delegate building a concrete PoC that proves a confirmed finding is real (plus a negative PoC of its preconditions).'
  },
  {
    id: 'adversarial-modeler',
    kind: 'agent',
    depts: ['cyber'],
    group: 'subagentes especializados',
    source: {
      repo: 'trailofbits/skills',
      path: 'plugins/differential-review/agents/adversarial-modeler.md',
      ref: 'main'
    },
    summary:
      'Modelagem de atacante de um DIFF de risco: quem/qual acesso/onde, vetor com prova de alcançabilidade, exploitability EASY/MEDIUM/HARD e impacto MENSURÁVEL (nunca "poderia causar problemas") — o par da skill differential-review.',
    hint: 'Delegate adversarial threat modeling of a high-risk change — attacker model, reachable attack path, measurable impact.'
  },
  {
    id: 'malware-analyst',
    kind: 'agent',
    depts: ['cyber'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/reverse-engineering/agents/malware-analyst.md',
      ref: 'main'
    },
    summary:
      'Triagem DEFENSIVA de artefato suspeito (dependência maliciosa, binário estranho): Triage→Static→Dynamic com comandos concretos, template YARA e relatório de IOCs — nicho e tool-heavy (strings/x64dbg/Wireshark).',
    hint: 'Delegate triaging a suspicious dependency/artifact — static/dynamic analysis with IOCs and a defensive report.'
  },
  {
    id: 'gdpr-ccpa-compliance',
    kind: 'agent',
    depts: ['cyber'],
    group: 'subagentes especializados',
    source: {
      repo: 'VoltAgent/awesome-claude-code-subagents',
      path: 'categories/04-quality-security/gdpr-ccpa-compliance.md',
      ref: 'main'
    },
    summary:
      'Gap assessment GDPR/CCPA (bases legais, direitos do titular, ações priorizadas por risco) — a exceção LIMPA da coleção VoltAgent (sem context-manager/telemetria fake); NÃO cobre LGPD: o privacy-engineer in-house completa.',
    hint: 'Delegate a GDPR/CCPA gap assessment of data practices — legal bases, subject rights, prioritized actions.'
  },

  // ————————————————————————————————————————————————————————————————————————
  // RODADA 9: DATA (2026-07-30). Fonte OFICIAL em peso: dbt Labs, DuckDB
  // Foundation, ClickHouse, Confluent, Polars Inc, Hugging Face, Dagster,
  // Astronomer, Anthropic knowledge-work-plugins (Apache-2.0 por plugin) +
  // wshobson (MIT). Re-tags: supabase-postgres-best-practices/
  // postgresql-table-design/domain-modeling (→+data), sql-query-surgeon/
  // migration-surgeon/backend-reality-checker/dataviz-frontend (bundled,
  // helpers BD/FD) e performance-optimizer (agent →+data). Descartes por
  // LICENÇA: majesticlabs INTEIRO (Polyform Noncommercial), Databricks
  // (licença própria), chdb-* (frontmatter declara "macOS or Linux" — sem
  // Windows). PostHog/GrowthBook = pendência-pacote (MCP/API key, classe
  // Figma). NENHUMA pasta≠name nesta rodada (raro). Racional completo em
  // docs/SKILLS.md.
  // ————————————————————————————————————————————————————————————————————————

  // ——— SQL & warehouse ———
  {
    id: 'sql-queries',
    kind: 'skill',
    depts: ['data'],
    group: 'SQL & warehouse',
    source: { repo: 'anthropics/knowledge-work-plugins', path: 'data/skills/sql-queries', ref: 'main' },
    summary:
      'Referência SQL POR DIALETO (Snowflake/BigQuery/Databricks/Postgres/Redshift): 50+ snippets de window functions, cohort/funnel, dedupe e debugging — a base de consulta do dia a dia.',
    hint: 'Dialect-aware SQL reference — patterns, window functions, cohorts, dedupe, debugging across warehouses.',
    defaultFor: ['data']
  },
  {
    id: 'profiling-tables',
    kind: 'skill',
    depts: ['data'],
    group: 'SQL & warehouse',
    source: { repo: 'astronomer/agents', path: 'skills/profiling-tables', ref: 'main' },
    summary:
      'Perfil profundo de UMA tabela: INFORMATION_SCHEMA → stats por tipo → cardinalidade → amostra → score de qualidade — SQL puro, zero dependências.',
    hint: 'Use to deep-profile a specific warehouse table: stats, cardinality, freshness, quality score.'
  },
  {
    id: 'explore-data',
    kind: 'skill',
    depts: ['data'],
    group: 'SQL & warehouse',
    source: { repo: 'anthropics/knowledge-work-plugins', path: 'data/skills/explore-data', ref: 'main' },
    summary:
      'Workflow de 7 passos para dataset DESCONHECIDO, com thresholds de null-rate — a ref ../CONNECTORS.md é soft (padrão kwp) e o MCP de warehouse é opcional.',
    hint: 'Use to profile an unfamiliar dataset end-to-end before analysis.'
  },
  {
    id: 'data-context-extractor',
    kind: 'skill',
    depts: ['data'],
    group: 'SQL & warehouse',
    source: {
      repo: 'anthropics/knowledge-work-plugins',
      path: 'data/skills/data-context-extractor',
      ref: 'main'
    },
    summary:
      'Meta-skill: entrevista + descoberta de schema para extrair o conhecimento tribal do warehouse (entidades, métricas, pegadinhas) e GERAR uma skill de contexto da empresa — par conceitual do CONTEXT.md.',
    hint: 'Use to interview + schema-discover the warehouse and generate a company-specific data-context skill.'
  },

  // ——— estatística & experimentos ———
  {
    id: 'statistical-analysis',
    kind: 'skill',
    depts: ['data'],
    group: 'estatística & experimentos',
    source: {
      repo: 'anthropics/knowledge-work-plugins',
      path: 'data/skills/statistical-analysis',
      ref: 'main'
    },
    summary:
      'Rigor estatístico aplicado: decisão mean×median, tendência, outliers (Z/IQR), testes de hipótese com EFFECT SIZE acima de p-value, Simpson e survivorship — o chão estatístico do dept.',
    hint: 'Descriptive stats, trends, outliers and hypothesis tests with effect-size-first rigor.',
    defaultFor: ['data']
  },
  {
    id: 'ab-testing',
    kind: 'skill',
    depts: ['data'],
    group: 'estatística & experimentos',
    source: { repo: 'coreyhaines31/marketingskills', path: 'skills/ab-testing', ref: 'main' },
    summary:
      'Desenho de experimento válido: sample size PRÉ-comprometido, peeking problem explícito, guardrail metrics e priorização ICE — refs soft ao padrão corey (opcionais).',
    hint: 'Use to design statistically valid experiments — sample size, significance, no peeking, guardrails.'
  },

  // ——— qualidade & validação ———
  {
    id: 'validate-data',
    kind: 'skill',
    depts: ['data'],
    group: 'qualidade & validação',
    source: { repo: 'anthropics/knowledge-work-plugins', path: 'data/skills/validate-data', ref: 'main' },
    summary:
      'O GATE de análise: checklist de 18 itens + catálogo de 7 armadilhas com detecção (join explosion, denominator shifting, average-of-averages, timezone) — o par de dados do verification-before-completion.',
    hint: 'Use to QA an analysis before sharing — methodology, calculations, bias and sanity checks.',
    defaultFor: ['data']
  },
  {
    id: 'data-quality-frameworks',
    kind: 'skill',
    depts: ['data'],
    group: 'qualidade & validação',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/data-engineering/skills/data-quality-frameworks',
      ref: 'main'
    },
    summary:
      'Validação automatizada: Great Expectations + dbt tests + data contracts + CI — o único GX instalável com licença sã da varredura (o da majestic caiu por Polyform).',
    hint: 'Use to wire automated data validation — Great Expectations, dbt tests, data contracts in CI.',
    defaultFor: ['data']
  },

  // ——— visualização & BI ———
  {
    id: 'data-visualization',
    kind: 'skill',
    depts: ['data'],
    group: 'visualização & BI',
    source: {
      repo: 'anthropics/knowledge-work-plugins',
      path: 'data/skills/data-visualization',
      ref: 'main'
    },
    summary:
      'Charts Python de publicação: 13 relações→tipo de gráfico, anti-patterns, exemplos matplotlib/seaborn/plotly, paletas colorblind e checklist de acessibilidade.',
    hint: 'Publication-quality Python charts — selection guide, code patterns, accessibility.'
  },
  {
    id: 'build-dashboard',
    kind: 'skill',
    depts: ['data'],
    group: 'visualização & BI',
    source: { repo: 'anthropics/knowledge-work-plugins', path: 'data/skills/build-dashboard', ref: 'main' },
    summary:
      'Dashboard interativo em HTML single-file (Chart.js, dados embutidos, KPI cards, filtros) — o CDN do Chart.js é dependência do ARTEFATO gerado, não da skill.',
    hint: 'Use to build a self-contained interactive HTML dashboard with charts, filters and KPI cards.'
  },
  {
    id: 'kpi-dashboard-design',
    kind: 'skill',
    depts: ['data'],
    group: 'visualização & BI',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/business-analytics/skills/kpi-dashboard-design',
      ref: 'main'
    },
    summary:
      'Escolha e estrutura de KPIs: framework estratégico/tático/operacional, hierarquia de dashboard e troubleshooting com SQL/Python reais.',
    hint: 'Use to choose and structure KPIs — dashboard hierarchy and real-time patterns.'
  },
  {
    id: 'data-storytelling',
    kind: 'skill',
    depts: ['data'],
    group: 'visualização & BI',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/business-analytics/skills/data-storytelling',
      ref: 'main'
    },
    summary:
      'Análise → narrativa executiva (story arc, 3 pilares) — corpo curto com a carne em references/details.md (existe, conferido); a única skill de narrativa de dados do mercado.',
    hint: 'Use to turn analysis into a stakeholder narrative — story arc, context, persuasive structure.'
  },

  // ——— análise local (DuckDB) — oficial DuckDB Foundation ———
  {
    id: 'query',
    kind: 'skill',
    depts: ['data'],
    group: 'análise local (DuckDB)',
    source: { repo: 'duckdb/duckdb-skills', path: 'skills/query', ref: 'main' },
    summary:
      'DuckDB oficial: sessão/ad-hoc, NL→SQL, guarda de resultado >1M linhas e "Friendly SQL" (GROUP BY ALL, PIVOT, COLUMNS(*)) — id genérico de 1 palavra, atenção a colisões futuras.',
    hint: 'Use to run DuckDB SQL against attached DBs or ad-hoc files.'
  },
  {
    id: 'read-file',
    kind: 'skill',
    depts: ['data'],
    group: 'análise local (DuckDB)',
    source: { repo: 'duckdb/duckdb-skills', path: 'skills/read-file', ref: 'main' },
    summary:
      'Macro read_any() para CSV/JSON/Parquet/Avro/Excel/spatial/SQLite → schema + amostra em segundos — paths cloud pedem credencial (opcional).',
    hint: 'Use to preview any data file schema and sample rows via DuckDB.'
  },
  {
    id: 'attach-db',
    kind: 'skill',
    depts: ['data'],
    group: 'análise local (DuckDB)',
    source: { repo: 'duckdb/duckdb-skills', path: 'skills/attach-db', ref: 'main' },
    summary:
      'Anexa bancos .duckdb com state file reutilizável entre sessões — cita a irmã install-duckdb (não instalada; o agente avisa/instala o binário por conta própria).',
    hint: 'Use to attach a DuckDB database and persist session state for querying.'
  },
  {
    id: 'duckdb-docs',
    kind: 'skill',
    depts: ['data'],
    group: 'análise local (DuckDB)',
    source: { repo: 'duckdb/duckdb-skills', path: 'skills/duckdb-docs', ref: 'main' },
    summary:
      'Busca BM25 (extensão fts) sobre índice das docs do DuckDB CACHEADO localmente (baixa na 1ª execução, TTL 2 dias) — fetch de DADOS, não de instruções.',
    hint: 'Use to full-text search DuckDB/DuckLake docs from a locally cached index.'
  },

  // ——— dataframes & notebooks ———
  {
    id: 'polars',
    kind: 'skill',
    depts: ['data'],
    group: 'dataframes & notebooks',
    source: { repo: 'polars-inc/skills', path: 'polars', ref: 'main' },
    summary:
      'OFICIAL da Polars Inc: lazy-first, 5 regras de performance, template canônico de 10 passos e 9 GOTCHAS de falha silenciosa verificados na 1.x — o MCP polars-mcp é opcional.',
    hint: 'Idiomatic lazy Polars — canonical query pattern, context selection, silent-failure traps.'
  },
  {
    id: 'jupyter-notebook',
    kind: 'skill',
    depts: ['data'],
    group: 'dataframes & notebooks',
    source: { repo: 'openai/skills', path: 'skills/.curated/jupyter-notebook', ref: 'main' },
    summary:
      'Notebooks limpos e reproduzíveis a partir de templates .ipynb + script stdlib-only (modos experimento/tutorial) — Apache-2.0 POR SKILL; repo deprecated (pin por sha segura a cópia).',
    hint: 'Use to create clean, reproducible Jupyter notebooks from bundled templates.'
  },

  // ——— analytics engineering (dbt) — oficial dbt Labs ———
  {
    id: 'using-dbt-for-analytics-engineering',
    kind: 'skill',
    depts: ['data'],
    group: 'analytics engineering (dbt)',
    source: {
      repo: 'dbt-labs/dbt-agent-skills',
      path: 'skills/dbt/skills/using-dbt-for-analytics-engineering',
      ref: 'main'
    },
    summary:
      'O carro-chefe dbt OFICIAL: DAG DRY com ref()/source(), "you must look at the data" (dbt show), gestão de custo (--defer, clone, --limit) e tabela de red flags — CLI local basta, MCP é preferência.',
    hint: 'Use to build and modify dbt models with engineering discipline — validate with dbt show.'
  },
  {
    id: 'adding-dbt-unit-test',
    kind: 'skill',
    depts: ['data'],
    group: 'analytics engineering (dbt)',
    source: {
      repo: 'dbt-labs/dbt-agent-skills',
      path: 'skills/dbt/skills/adding-dbt-unit-test',
      ref: 'main'
    },
    summary:
      'Unit tests dbt em YAML com mocks de input e output esperado pinado — cobre incremental/ephemeral/versioned; 100% local.',
    hint: 'Use to write dbt unit tests that mock inputs and pin expected outputs.'
  },
  {
    id: 'building-dbt-semantic-layer',
    kind: 'skill',
    depts: ['data'],
    group: 'analytics engineering (dbt)',
    source: {
      repo: 'dbt-labs/dbt-agent-skills',
      path: 'skills/dbt/skills/building-dbt-semantic-layer',
      ref: 'main'
    },
    summary:
      'MetricFlow oficial: semantic models, 5 tipos de métrica, decisão spec latest×legacy e validação local (mf validate-configs).',
    hint: 'Use to define semantic models and MetricFlow metrics with spec-version awareness.'
  },
  {
    id: 'running-dbt-commands',
    kind: 'skill',
    depts: ['data'],
    group: 'analytics engineering (dbt)',
    source: {
      repo: 'dbt-labs/dbt-agent-skills',
      path: 'skills/dbt/skills/running-dbt-commands',
      ref: 'main'
    },
    summary:
      'Referência operacional do dbt CLI: 3 sabores, graph selectors, build>run e análise de run_results.json.',
    hint: 'Correct dbt CLI usage — selectors, flags, flavors, post-run analysis.'
  },
  {
    id: 'creating-mermaid-dbt-dag',
    kind: 'skill',
    depts: ['data'],
    group: 'analytics engineering (dbt)',
    source: {
      repo: 'dbt-labs/dbt-agent-skills',
      path: 'skills/dbt-extras/skills/creating-mermaid-dbt-dag',
      ref: 'main'
    },
    summary:
      'Lineage dbt → diagrama Mermaid, com fallback por manifest.json/código quando não há MCP — inclui alerta de prompt-injection em nomes de modelo.',
    hint: 'Use to draw dbt model lineage as a Mermaid diagram from manifest or MCP.'
  },

  // ——— pipelines & orquestração ———
  {
    id: 'airflow-dag-patterns',
    kind: 'skill',
    depts: ['data'],
    group: 'pipelines & orquestração',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/data-engineering/skills/airflow-dag-patterns',
      ref: 'main'
    },
    summary:
      'Padrões de DAG Airflow (operators, sensors, testing, deploy) com um DAG completo de exemplo — o par de CONHECIMENTO do trio operacional da Astronomer.',
    hint: 'Airflow DAG design patterns — operators, sensors, testing, scheduling.'
  },
  {
    id: 'authoring-dags',
    kind: 'skill',
    depts: ['data'],
    group: 'pipelines & orquestração',
    source: { repo: 'astronomer/agents', path: 'skills/authoring-dags', ref: 'main' },
    summary:
      'Autoria de DAGs da ASTRONOMER (oficial): 6 fases com validação real (af dags errors/warnings/explore) — exige o CLI af (gratuito, uv tool install; serve Airflow OSS); 1 ref soft fora da pasta.',
    hint: 'Use to author Airflow DAGs through a discover→plan→validate→test loop with the af CLI.'
  },
  {
    id: 'testing-dags',
    kind: 'skill',
    depts: ['data'],
    group: 'pipelines & orquestração',
    source: { repo: 'astronomer/agents', path: 'skills/testing-dags', ref: 'main' },
    summary:
      'Ciclo trigger→debug→fix com af runs trigger-wait e 6 cenários — dependência dura do CLI af apontando para um Airflow VIVO.',
    hint: 'Use for iterative DAG test-debug-fix cycles against a live Airflow.'
  },
  {
    id: 'debugging-dags',
    kind: 'skill',
    depts: ['data'],
    group: 'pipelines & orquestração',
    source: { repo: 'astronomer/agents', path: 'skills/debugging-dags', ref: 'main' },
    summary:
      'RCA estruturado de DAG quebrado: logs, classificação código/dado/infra e drift de pacotes via diff de imagem — usa curl para JSON do PyPI (dados) e docker para inspeção.',
    hint: 'Use to root-cause failed DAGs — logs, code/data/infra classification, dependency drift.'
  },
  {
    id: 'dagster-expert',
    kind: 'skill',
    depts: ['data'],
    group: 'pipelines & orquestração',
    source: {
      repo: 'dagster-io/skills',
      path: 'skills/dagster-expert/skills/dagster-expert',
      ref: 'master'
    },
    summary:
      'OFICIAL Dagster (ref MASTER, não main): assets/components, dg CLI via uv e índice de 40+ integrações em references — "consultar antes de responder, nunca de memória".',
    hint: 'Dagster and dg CLI guidance backed by reference files, not memory.'
  },
  {
    id: 'spark-optimization',
    kind: 'skill',
    depts: ['data'],
    group: 'pipelines & orquestração',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/data-engineering/skills/spark-optimization',
      ref: 'main'
    },
    summary:
      'Tuning de Spark: partitioning, shuffle, memória e config PySpark real — o único Spark instalável com licença sã (Databricks caiu pela licença própria).',
    hint: 'Use to tune Spark jobs — partitioning, caching, shuffle, memory.'
  },

  // ——— streaming (Kafka) — oficial Confluent ———
  {
    id: 'kafka-streams-programming',
    kind: 'skill',
    depts: ['data'],
    group: 'streaming (Kafka)',
    source: { repo: 'confluentinc/agent-skills', path: 'skills/kafka-streams-programming', ref: 'main' },
    summary:
      'Kafka Streams oficial em 3 modos (architect/build/debug): EOS, windowing e 11 defaults invariantes — serve Apache Kafka OSS além de Confluent; exige JVM 17+.',
    hint: 'Use to design, build and debug Kafka Streams topologies (works on OSS Kafka).'
  },
  {
    id: 'developing-kafka-python-client',
    kind: 'skill',
    depts: ['data'],
    group: 'streaming (Kafka)',
    source: {
      repo: 'confluentinc/agent-skills',
      path: 'skills/developing-kafka-python-client',
      ref: 'main'
    },
    summary:
      'Producers/consumers de produção em confluent-kafka-python + Schema Registry, com caminho Docker local OSS e gate de confirmação antes de gerar código.',
    hint: 'Use to build production Kafka producers/consumers in Python with Schema Registry.'
  },

  // ——— OLAP (ClickHouse) — oficial ———
  {
    id: 'clickhouse-best-practices',
    kind: 'skill',
    depts: ['data'],
    group: 'OLAP (ClickHouse)',
    source: { repo: 'ClickHouse/agent-skills', path: 'skills/clickhouse-best-practices', ref: 'main' },
    summary:
      'ClickHouse oficial: 31 regras priorizadas (schema/query/insert/agent) com as rules DENTRO da pasta — serve qualquer instância, cloud ou self-hosted.',
    hint: '31 prioritized ClickHouse rules for schema, queries and inserts.'
  },
  {
    id: 'clickhouse-architecture-advisor',
    kind: 'skill',
    depts: ['data'],
    group: 'OLAP (ClickHouse)',
    source: {
      repo: 'ClickHouse/agent-skills',
      path: 'skills/clickhouse-architecture-advisor',
      ref: 'main'
    },
    summary:
      'Decisão de arquitetura ClickHouse por workload (observability/IoT/analytics…) com proveniência marcada (official/derived/field) — camada sobre a best-practices, que instala junto.',
    hint: 'Workload-aware ClickHouse architecture decisions layered on the best-practices rules.',
    requires: ['clickhouse-best-practices']
  },

  // ——— ML & LLM data ———
  {
    id: 'ml-pipeline-workflow',
    kind: 'skill',
    depts: ['data'],
    group: 'ML & LLM data',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/machine-learning-ops/skills/ml-pipeline-workflow',
      ref: 'main'
    },
    summary: 'MLOps ponta a ponta: data prep, treino, validação e deploy com DAG YAML de exemplo.',
    hint: 'End-to-end ML pipeline — data prep, training, validation, deployment.'
  },
  {
    id: 'rag-implementation',
    kind: 'skill',
    depts: ['data'],
    group: 'ML & LLM data',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/llm-application-dev/skills/rag-implementation',
      ref: 'main'
    },
    summary: 'RAG com código executável: vector DBs, retrieval híbrido, reranking.',
    hint: 'Use to build RAG systems — retrieval strategies, reranking, vector stores.'
  },
  {
    id: 'llm-evaluation',
    kind: 'skill',
    depts: ['data'],
    group: 'ML & LLM data',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/llm-application-dev/skills/llm-evaluation',
      ref: 'main'
    },
    summary: 'Avaliação de apps LLM: métricas automatizadas, human eval e LLM-as-judge com suite em código.',
    hint: 'Use to evaluate LLM apps — automated metrics, human eval, LLM-as-judge.'
  },
  {
    id: 'embedding-strategies',
    kind: 'skill',
    depts: ['data'],
    group: 'ML & LLM data',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/llm-application-dev/skills/embedding-strategies',
      ref: 'main'
    },
    summary: 'Seleção de modelo de embedding (tabela comparativa de 10) + estratégias de chunking por caso.',
    hint: 'Use to choose embedding models and chunking strategies for search/RAG.'
  },
  {
    id: 'vector-index-tuning',
    kind: 'skill',
    depts: ['data'],
    group: 'ML & LLM data',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/llm-application-dev/skills/vector-index-tuning',
      ref: 'main'
    },
    summary:
      'Tuning de índice vetorial por volume de dados: HNSW, quantização e trade-off recall×latência — corpo curto com a carne em references.',
    hint: 'Use to tune vector indexes — HNSW params, quantization, recall-latency tradeoffs.'
  },
  {
    id: 'huggingface-datasets',
    kind: 'skill',
    depts: ['data'],
    group: 'ML & LLM data',
    source: { repo: 'huggingface/skills', path: 'skills/huggingface-datasets', ref: 'main' },
    summary:
      'OFICIAL Hugging Face: explora/extrai datasets via Dataset Viewer API (paginação, busca, parquet) — chamadas à API do HF são DADOS; HF_TOKEN só para gated datasets.',
    hint: 'Use to explore and extract Hugging Face datasets via the Dataset Viewer API.'
  },

  // ——— SUBAGENTES especializados (rodada data) ———
  {
    id: 'ab-test-analysis',
    kind: 'agent',
    depts: ['data'],
    group: 'subagentes especializados',
    source: {
      repo: 'VoltAgent/awesome-claude-code-subagents',
      path: 'categories/10-research-analysis/ab-test-analysis.md',
      ref: 'main'
    },
    summary:
      'Estatístico de A/B com decisão ship/no-ship: p<0,05 + MDE pré-especificado, SRM invalida o teste, segmentação post-hoc = p-hacking, taxonomia de peeking/Simpson — da leva NOVA e limpa do VoltAgent (categoria 10).',
    hint: 'Delegate analyzing A/B or experiment results — p-values, effect size, integrity checks (peeking, SRM), ship/no-ship verdict.'
  },
  {
    id: 'cohort-analysis',
    kind: 'agent',
    depts: ['data'],
    group: 'subagentes especializados',
    source: {
      repo: 'VoltAgent/awesome-claude-code-subagents',
      path: 'categories/10-research-analysis/cohort-analysis.md',
      ref: 'main'
    },
    summary:
      'Retenção/cohorts com diagnóstico de curva (achatando = saudável; indo a zero = problema de PMF, não de growth), 4 tipos de cohort e análise de ativação — as tabelas do corpo são exemplos didáticos, não telemetria fabricada.',
    hint: 'Delegate retention/cohort analysis — cohort table, curve diagnosis, activation behaviors, ranked recommendations.'
  },
  {
    id: 'model-evaluator',
    kind: 'agent',
    depts: ['data'],
    group: 'subagentes especializados',
    source: {
      repo: 'davila7/claude-code-templates',
      path: 'cli-tool/components/agents/ai-specialists/model-evaluator.md',
      ref: 'main'
    },
    summary:
      'Avaliação de modelos/LLM com rigor raro: mínimos de amostra por poder estatístico, gatilhos de re-avaliação (queda ≥5%, update de provider, drift) e seleção de framework (lm-eval/RAGAS/Promptfoo) por caso — composição original, não clone.',
    hint: 'Delegate designing/running LLM or model evaluations — golden sets, statistical minimums, framework selection, re-eval triggers.'
  },
  {
    id: 'vector-database-engineer',
    kind: 'agent',
    depts: ['data'],
    group: 'subagentes especializados',
    source: {
      repo: 'wshobson/agents',
      path: 'plugins/llm-application-dev/agents/vector-database-engineer.md',
      ref: 'main'
    },
    summary:
      'A exceção com NÚMEROS do wshobson: chunking 500–1000 tokens com overlap 10–20%, tuning HNSW/IVF, quantização INT8/PQ e alvo <100ms P95 — o slot de busca vetorial/RAG prep.',
    hint: 'Delegate vector-search work — embedding/chunking strategy, index tuning (pgvector/Qdrant), hybrid retrieval, latency targets.'
  },
  {
    id: 'data-engineer',
    kind: 'agent',
    depts: ['data'],
    group: 'subagentes especializados',
    source: { repo: 'lst97/claude-code-sub-agents', path: 'agents/data-ai/data-engineer.md', ref: 'main' },
    summary:
      'O melhor pipeline/ETL do mercado: decisão em 5 critérios (testability>readability>consistency>simplicity>reversibility), quality gates duros e exemplos concretos de DAG/Spark/schema — declara MCPs context7/sequential-thinking que degradam sem quebrar.',
    hint: 'Delegate ETL/ELT pipeline design or fixes — Airflow DAGs, Spark jobs, idempotency, with hard quality gates.'
  },
  {
    id: 'ml-engineer',
    kind: 'agent',
    depts: ['data'],
    group: 'subagentes especializados',
    source: { repo: 'lst97/claude-code-sub-agents', path: 'agents/data-ai/ml-engineer.md', ref: 'main' },
    summary:
      'Ciclo de vida de ML em produção: SOP de 7 fases (Define→Monitor→Iterate), "version everything", monitoração de data/concept drift obrigatória e entrega em fatias verticais — venceu todos os rivais de inventário.',
    hint: 'Delegate production ML work — training pipeline, serving, drift monitoring, reproducible rollout.'
  },
  {
    id: 'data-scientist',
    kind: 'agent',
    depts: ['data'],
    group: 'subagentes especializados',
    source: { repo: 'lst97/claude-code-sub-agents', path: 'agents/data-ai/data-scientist.md', ref: 'main' },
    summary:
      'Análise SQL com juízo: clarifica pedido ambíguo ANTES de rodar, avisa custo de query cara e sintetiza além do óbvio — a description tem sabor BigQuery, mas vale para qualquer SQL.',
    hint: 'Delegate SQL-based analysis questions — cost-aware queries, validated assumptions, synthesized insights.'
  }
]
