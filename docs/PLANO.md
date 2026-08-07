# Synkora — Plano v1.1 (2026-07-21)

Ambiente de Desenvolvimento Agêntico (ADE) pessoal, inspirado no overclock.sh.
App desktop onde cada projeto é um "universo" com departamentos (PM, Front, Back, QA),
e um orquestrador delega tarefas para múltiplas contas de CLIs de IA com harness automático.

Plano visual completo (diagramas + wireframes): https://claude.ai/code/artifact/71cb4d72-81f8-4c49-9577-3bfc2112e4dc

## Conceito

- **Projetos → Universos → Departamentos.** Cada departamento tem orquestrador próprio, pool de agentes, skills padrão e quality gate.
- **Zero custo de modelo:** o app dirige CLIs que o usuário já paga (Claude Code, Codex/ChatGPT, Gemini). Nenhuma chamada de API própria.
- **100% visual:** o usuário vem do GUI. Tudo que o CLI faz aparece em painéis (status, diffs, custo, board kanban).

## Stack

| Camada | Escolha |
|---|---|
| Shell | Electron + Vite + React + TypeScript |
| Terminais | xterm.js + node-pty (ConPTY no Windows) |
| Painéis | React Flow / grid fixo (MVP: grid) |
| Estado | JSON stores em userData + Zustand (decisão F2: better-sqlite3 exigiria build nativo/VS Build Tools; JSON aguenta a escala e a troca fica contida na camada de store) |
| Agentes | Adapters por CLI (login, headless, parse de eventos, rate limit) |
| Isolamento | git worktree por tarefa |
| Voz | **SynVoice**: ditado literal PT-BR/inglês técnico com inserção direta; botão clique-clique, atalho liga/desliga por tecla/mouse ou segure-para-falar; OpenAI `gpt-transcribe` automático ou modelos STT do OpenRouter |

Referência de arquitetura/código: https://github.com/eneskirca/nodeterm (Electron, panes de terminal, status de agentes).

## Modelo de domínio

- **Projeto** — repo + metadados.
- **Departamento** — preset: prompt do orquestrador, skills, subagentes, seats permitidos, quality gate.
- **Tarefa** — item do board (backlog → análise → execução → QA → concluída).
- **Run** — execução de uma tarefa por um seat (eventos, custo, diff), isolada em worktree.
- **Seat** — conta + CLI + diretório de config isolado. Claude: `CLAUDE_CONFIG_DIR` por seat. Codex: `CODEX_HOME`. 3 seats Claude + 1 Codex previstos.

## Estrutura de equipes (decisão de 2026-07-21)

- **Departamentos**: front, back, qa + **design** (identidade visual, mockups, protótipos, imagens) e **research** (pesquisa de mercado/tech, referências, viabilidade). Planejamento sem código = Maestro orquestrando research + design antes do dev.
- **Bugs NÃO são um departamento** — são um **tipo de tarefa** (`type: feature | bug`). Bug relatado ao Maestro vira tarefa 🐛 no departamento certo, com passos de reprodução, + validação no QA quando fizer sentido.
- Barra de contexto do Maestro no painel (tokens da sessão vs janela de 200k) para saber a hora do /clear.

## Cadeia de comando

O usuário fala com **um único chefe: o Maestro** (PM do universo do projeto) — por texto ou voz.
Os orquestradores de departamento ("leads") trabalham para o Maestro, não para o usuário:

- **Você → Maestro:** pedido grande ("quero a feature de login"). Maestro roda grill-me, escreve o mini-PRD e quebra em tarefas etiquetadas por departamento.
- **Maestro → Leads:** cada lead pega as tarefas da sua área, escolhe seat livre, injeta skills/subagentes do departamento e dispara o run. São automáticos — o usuário não os gerencia, só acompanha nos painéis.
- **Leads → Seats:** as contas executando em worktrees isolados.
- **Maestro → Você:** resumo consolidado em PT-BR ao final.
- **Atalho:** pedido cirúrgico ("Front, aumenta esse botão") pode ser falado direto no painel do departamento, pulando o Maestro.

Tecnicamente todos os orquestradores são o mesmo motor com presets diferentes (prompt, skills, seats, gate).
No roadmap: na F2 o Maestro faz tudo sozinho; os leads ganham vida própria na F3 junto com o dispatcher.

## Harness (fluxo de tarefa)

1. Pedido do usuário (texto ou voz) → orquestrador PM roda `grill-me` (validação) e decompõe em tarefas no board.
2. Dispatcher atribui tarefa a um seat livre; monta workspace com `.claude/skills/` e `.claude/agents/` do departamento.
3. Run headless: `claude -p --output-format stream-json` (Codex: `codex exec --json`) — eventos JSON alimentam os painéis.
4. **Gate 1 — Revisor de código:** analisa os diffs de front e back JUNTOS (cada dev trabalhou isolado no seu worktree): contratos de API batem? quebrou algo existente? Reprovado → volta pro dev com feedback.
5. **Gate 2 — QA funcional:** só recebe código já revisado; roda os testes e valida o comportamento contra a spec. Reprovado → volta com feedback. Aprovado → merge.
6. Toggle por departamento: autonomia total vs. "me chama antes do merge".

Racional dos dois gates: review pega defeito estático (encaixe, contrato, regressão) onde é barato;
QA pega defeito de comportamento. Decisão do usuário em 2026-07-21.

## Skills embarcadas (curadoria inicial)

- **PM:** grill-me → domain-model → to-prd → to-issues (pipeline do aihero.dev).
- **Front:** design de UI, subagentes frontend-dev e design-reviewer.
- **Back:** modelagem de API/banco, subagentes backend-dev e security-reviewer.
- **QA:** code review adversarial, testes, subagente qa-gatekeeper.

## Roadmap (nunca construir N+1 sem usar N)

- **F0 fundação:** shell Electron, lista de projetos, panes de terminal com Claude Code. Gate: 2 panes lado a lado funcionando.
- **F1 seats:** multi-contas com config dirs isolados, badges de status, uso por seat. Gate: 3 Claudes + 1 Codex logados.
- **F2 universo:** departamentos, board kanban, PM decompõe pedido em tarefas (atribuição manual). Gate: pedido → tarefas no board.
- **F3 harness:** dispatcher, worktrees, runs headless, QA gate, merge. Gate: feature completa sem digitar em terminal.
- **F4 skills:** biblioteca versionada + injeção automática + pipeline de planejamento. Gate: planejar o app de celular dentro do Synkora.
- **F5 voz:** SynVoice global, gravação por botão, atalho liga/desliga ou tecla mantida pressionada, transcrição literal e inserção direta sem enviar Enter. Gate: ditar para qualquer painel/campo e editar o resultado no próprio destino.

## Riscos

- Rate limits/ToS: respeitar limites de cada seat (contas próprias e pagas), não burlar.
- Escopo grande: F0–F1 já devem substituir o uso básico do overclock.
- CLIs mudam: tudo atrás de adapters.
- node-pty no Windows: estudar como o nodeterm resolveu antes de escrever o nosso.
- QA gate obrigatório — sem ele o harness gera retrabalho.

## Decisões confirmadas (2026-07-21)

1. Nome: **Synkora**.
2. Layout: **grid fixo** no MVP (canvas livre é ideia futura).
3. Voz: **via API**; OpenAI `gpt-transcribe` é o padrão de máxima precisão e OpenRouter oferece escolha restrita ao catálogo de transcrição. Processamento local pode ser avaliado depois.
4. Grok: adapter previsto na arquitetura, implementação futura.
5. Cadeia de comando: **Maestro** como única porta de entrada; leads de departamento automáticos, com atalho direto pelo painel da área.
