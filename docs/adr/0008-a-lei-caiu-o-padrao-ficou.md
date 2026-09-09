# ADR-0008 — Skills 3.0: a lei caiu, o padrão ficou

Data: 2026-09-08 · Sessão de planejamento com o dono · Status: aceita
(revoga a ADR-0005)

## Contexto

A ADR-0005 fixava UMA lei na persona: trabalho de UI ⇒ `impeccable`, sempre.
O dono mediu o custo na prática: "impeccable não é a melhor opção pra landing
page" (a `taste-skill` seria), e "às vezes o impeccable não vai dar" a melhor
animação. A lei escolhia a skill no lugar do modelo — e o harness fixo "nem
sempre serve pra tudo".

## Decisão

Não há mais lei de skill. `impeccable` vira candidata como qualquer outra
(`design-taste-frontend`, `frontend-design`, `emil-design-eng`…). O que fica
é um PADRÃO declarado na persona: trabalho de interface quase sempre pede UMA
direção de design escolhida pela obra; pular a direção é decisão dita em voz
alta; empilhar direções contraditórias deixa de ser proibição e vira advisory.

A revogação alcança também o orquestrador na UI do próprio Synkora (ordem de
2026-08-15 revogada: "cai junto" — palavra do dono nesta sessão).

## Consequências

- `UI_LAW_LINE`, `law: true` e `restoreLaw` saem do código; a tela deixa de
  mostrar ficha fixa; o slot `impeccable` é comum.
- O risco muda de lado: não é mais escolher errado, é PULAR a disciplina — por
  isso a linha de padrão existe e a suíte de contratos a prende.
