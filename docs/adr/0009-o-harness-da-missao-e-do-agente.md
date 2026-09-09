# ADR-0009 — Skills 3.0: o harness da missão é do agente, e ele o escreve

Data: 2026-09-08 · Sessão de planejamento com o dono · Status: aceita
(refina a ADR-0001; o kit da ADR-0003/0006 vira prateleira)

## Contexto

Palavras do dono: "não quero mais algo fixo. Quero que a IA decida qual é a
melhor opção pra ela ali naquele momento, e ela vá atrás, ela busque, ela
pegue e ela faça. O harness que o próprio modelo cria é melhor do que um
harness bruto que já vem." Hoje o kit de 16 sincronizado no spawn é uma
CERCA: fora dele o agente não tem caminho.

## Decisão

1. O kit do dono vira PRATELEIRA: ponto de partida, nunca cerca. A tela de
   gestão continua (ADR-0006).
2. O agente nomeia as OCASIÕES da missão e procura a melhor skill NESTA
   ORDEM: prateleira → biblioteca da máquina → catálogo curado da casa (as
   ~275 skills verificadas na fonte na era F6, agora como dado offline) →
   internet, com a busca web que o CLI já tem — só quando o catálogo não
   cobre.
3. Ferramentas no chat: `skill_search` (offline), `skill_pull` (id, URL do
   GitHub ou pasta autoral), `skill_discard`.
4. O harness de verdade é ESCRITO: o `mission-playbook` (skill autoral no
   worktree — direção, referências do dono, regras extraídas do que puxou,
   checklist de pronto) sobrevive a restart, entra no catálogo nativo dos dois
   CLIs e vai automaticamente ao briefing de todo ajudante.
5. O harness é DECLARADO no mini-plano (≤ 5 linhas: ocasião → skill → por
   quê). "Nenhuma skill" é resposta válida, dita.

## Consequências

- Heurística de conteúdo continua proibida no HARNESS: quem escolhe é o
  agente; a busca é sobre a query dele, nunca sobre o chat.
- A qualidade da escolha é a qualidade do índice: o catálogo carrega
  `summary` (PT-BR) e `hint` (EN, "use when…") da curadoria F6.
