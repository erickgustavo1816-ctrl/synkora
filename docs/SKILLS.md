# Synkora — Biblioteca de Skills (curadoria v1)

Skills que o Synkora embarca e injeta nos workspaces das tarefas, por departamento.
Todas as fontes abaixo são MIT — podem ser vendoradas na biblioteca central com atribuição.

## Fontes

| Fonte | Licença | O que traz |
|---|---|---|
| [mattpocock/skills](https://github.com/mattpocock/skills) (AIHero, Matt Pocock) | MIT | 31 skills de engenharia e produtividade — o coração do fluxo de planejamento e implementação |
| [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | MIT | "Anti-Slop Frontend Framework" — skills de design de UI com dials de variância/motion/densidade |
| [Security-Phoenix-demo/security-skills-claude-code](https://github.com/Security-Phoenix-demo/security-skills-claude-code) | ver repo | AppSec: `/security-review`, `/security-assessment`, `/threatmodel`, `/security-0day` |
| owasp-security (via [awesome-claude-skills](https://github.com/BehiSecc/awesome-claude-skills)) | ver repo | OWASP Top 10:2025 + ASVS 5.0, padrões seguros por linguagem |
| [awesome-skills/code-review-skill](https://github.com/awesome-skills/code-review-skill) | ver repo | Review de código em 20+ linguagens, carregamento progressivo |

Nota: no repo do Matt Pocock, `to-prd` virou **`to-spec`** e `to-issues` virou **`to-tickets`** — mesmos conceitos dos posts do aihero.dev.

## Mapa por departamento

### 🎯 Maestro / PM
- `grill-me` + `grilling` — entrevista exaustiva até resolver todos os ramos de decisão (antes de qualquer PRD)
- `grill-with-docs` — entrevista de alinhamento que constrói o modelo de domínio e atualiza docs
- `domain-modeling` — afia a terminologia do projeto (CONTEXT.md)
- `to-spec` — sintetiza a conversa em especificação publicável
- `to-tickets` — quebra o plano em tickets verticais (tracer bullets) com dependências
- `wayfinder` — planeja trabalho grande multi-sessão
- `triage` — máquina de estados para triagem de issues
- `handoff` — compacta contexto para passar de um agente a outro (usado pelo dispatcher entre runs)

### 🎨 Front
- `design-taste-frontend` (v2, com dials) — skill principal de UI
- `minimalist-ui` / `high-end-visual-design` / `industrial-brutalist-ui` — linguagens visuais alternativas por projeto
- `image-to-code` — pipeline imagem → análise → implementação
- `redesign-existing-projects` — auditoria e melhoria de UI existente
- `imagegen-frontend-mobile` / `imagegen-frontend-web` / `brandkit` — mockups e identidade
- `prototype` (Pocock) — protótipos descartáveis para validar decisões de design

### ⚙️ Back
- `tdd` — loop red-green-refactor
- `implement` — constrói a partir de spec/tickets com TDD + code review no fechamento
- `codebase-design` — princípios de módulos profundos
- `improve-codebase-architecture` — varre o codebase por melhorias
- `diagnosing-bugs` — reproduzir → minimizar → hipotetizar → instrumentar → corrigir
- `owasp-security` — padrões seguros ao escrever endpoints/auth/input

### 🔍 QA
- `code-review` (Pocock) — review em dois eixos: padrões + conformidade com a spec
- `code-review-skill` — guidelines por linguagem/framework
- `security-review` — gate de segurança em todo diff que toca auth, input, secrets ou API
- `resolving-merge-conflicts` — resolve conflitos hunk a hunk por intenção
- `tdd` — QA roda/exige os testes do run

### 🛡️ Segurança (transversal — roda como gate extra do QA em código sensível)
- `/security-review`, `/security-assessment`, `/threatmodel` (Phoenix Security)
- `owasp-security` — checklist OWASP Top 10:2025 / ASVS 5.0

## Como o Synkora usa isso (F4)

1. Biblioteca central versionada em `library/skills/` (vendorada dos repos acima, com atribuição e pin de versão).
2. Cada departamento declara suas skills padrão no preset.
3. O dispatcher monta o workspace da tarefa com `.claude/skills/` contendo só as skills do departamento + as marcadas na tarefa.
4. O prompt do run referencia a skill explicitamente (ex.: "use /tdd para implementar o ticket").
5. Atualização: comando "sincronizar biblioteca" busca novas versões dos repos-fonte e mostra o diff antes de aplicar.
