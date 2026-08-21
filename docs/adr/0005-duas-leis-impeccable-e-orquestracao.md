# ADR-0005 — Skills 2.0: UMA lei de ocasião no v1 (impeccable)

Data: 2026-08-21 · Sessão grill-with-docs com o dono · Status: aceita
(REVISADA na mesma sessão — a v1 desta ADR tinha duas leis; o dono derrubou a
segunda: "orquestração não é lei, nem sempre toda missão eu quero que ele
seja um orquestrador")

## Contexto

Lei ≠ cardápio: lei é skill que a persona OBRIGA na ocasião; cardápio é
julgamento do agente. O dono tinha uma lei declarada (impeccable para
front-end, ordem de 2026-08-15). A ideia de uma segunda lei (skill de
orquestração obrigatória antes de delegar) caiu: o fluxo real do dono é
planejamento → missão → o agente destrincha e delega OU resolve sozinho — o
ofício comum é PLANEJAR/DESTRINCHAR, não "orquestrar", e o momento de usar é
julgamento dele.

## Decisão

UMA lei no v1, fixa na PERSONA (não no toggle da tela):

1. Trabalho de UI ⇒ `impeccable`, sempre — nunca empilhada com outra direção
   estética.

A skill de planejamento/decomposição fica no CARDÁPIO dos dois tipos de chat
(dev e planejamento) — o agente a carrega quando vai destrinchar, seja para a
frota, seja para si. A mecânica específica de delegação do Synkora
(gui-delegator, fatias disjuntas, ciclo redondo, orquestrador barato) segue
morando na PERSONA, onde sempre morou — não vira skill.

## Consequências

- Mudar uma lei é decisão de doutrina com o dono (commit), nunca clique.
- Área só é promovida a lei com caso concreto de escolha ruim na mão.
- A `synkora-orquestracao` in-house da v1 desta ADR NÃO será escrita.
