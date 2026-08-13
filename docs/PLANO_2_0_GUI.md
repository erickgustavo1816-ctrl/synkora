# Synkora 2.0 — a virada real (GUI no lugar do pane, DENTRO do Synkora)

Decisão final do dono (2026-08-13, depois de rejeitar o caminho do fork): **o Synkora
que existe é o produto**. Home, universos, board, mapa, versões, fila, identidade,
PT-BR — tudo fica. A mudança: **pane TUI morre; abrir uma missão abre um CHAT GUI**
dirigido pelo motor que já existe no repo (maestroSession/codexSession). O fork
claudecodeui (Desktop/Synkora2) fica como pedreira de ideias, não é o produto.

Referência visual do workspace: o mockup aprovado pelo dono — **missões na coluna
esquerda como cards (com o worktree embaixo de cada uma)**, chat no centro, trilho de
entrega à direita (diff · revisar · ajudante · terminal · ⇪ fila).

## Ondas

- **Onda A — o pane GUI nasce** (2 agentes em paralelo, contrato em
  docs/GUI_PANE_CONTRACT.md): motor por pane no main (+preload) × componente
  GuiPane no renderer (deck/chrome de sempre).
- **Onda B — missão vira o centro**: criar missão SEM orquestrador (worktree + pane
  GUI do dev com o goal/plano como 1º prompt); layout novo do universo (missões à
  esquerda com worktree, chat no centro, trilho à direita); revisar = pane GUI limpo
  com diff; ajudante = outro pane GUI no mesmo worktree; ⇪ = fila existente com
  caminho direto (conflito volta pra conversa do dev); terminal = pane shell de
  sempre como utilidade.
- **Onda C — o motor emagrece**: maestro/orquestrador deixam de nascer; hub de
  injeção/correio/mailbox/watchdogs/LSP saem do caminho novo (morte por desuso
  primeiro, remoção depois); skills ficam para uma decisão futura (kit mínimo).

## Regras

- Trabalho no repo `Desktop/Synkora`, base = snapshot `8dcc9f3` (branch nivel5-fase1).
- Pipeline antigo (fases/gates/MCP) NÃO é apagado nesta virada — o caminho novo o
  ignora; a demolição é a onda C, com o dono vendo o novo funcionar antes.
- Tudo que o usuário vê: PT-BR. Código/identificadores: inglês.
