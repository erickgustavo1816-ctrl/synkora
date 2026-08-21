# ADR-0003 — Skills 2.0: kit por tipo de chat, e o kit dev tem duas alas

Data: 2026-08-21 · Sessão grill-with-docs com o dono · Status: aceita

## Contexto

Missão 2.0 não tem campo de função/departamento (criação pergunta só o
título, decisão do dono). O sinal estrutural que existe é o TIPO da conversa:
dev, planejamento, release. E o dono usa o MESMO chat dev em dois modos: dev
solo ("faz você") e orquestrador de subagentes ("orquestra") — pediu
explicitamente uma skill para planejar/designar subagentes melhor.

## Decisão

Um kit por TIPO de chat, sem campo novo:

- **dev** — kit da casa em DUAS ALAS, sempre presentes: EXECUÇÃO (técnicas
  por domínio: front, back, cyber, data, copy, QA) e ORQUESTRAÇÃO (planejar a
  frota: fatiar por fronteiras disjuntas, designar, paralelismo). O modo não é
  campo — é o momento; o cardápio serve os dois.
- **planejamento** — kit próprio (entrevista, modelagem de domínio, planos).
- **release** — sem kit (o contrato do papel já cobre o show).

## Consequências

- Zero gesto novo na criação de missão.
- Se um dia o kit único apertar, camadas por área entram por cima sem quebrar
  o desenho.
