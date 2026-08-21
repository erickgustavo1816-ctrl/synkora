# ADR-0004 — Skills 2.0: curadoria por proposta-e-veto do dono

Data: 2026-08-21 · Sessão grill-with-docs com o dono · Status: aceita

## Contexto

A biblioteca tem ~400 skills instaladas e verificadas na fonte (curadoria F6
em docs/SKILLS.md, com vetos documentados — herança paga). O dono não quer
"50 mil skills" no contexto.

## Decisão

O orquestrador PROPÕE o kit v1 (a partir da curadoria existente, honrando os
vetos documentados — "não reavaliar sem motivo novo"), com uma linha de porquê
por skill; o dono corta/troca por cima. Depois do v1, skill nova só entra no
kit com aval explícito do dono. O kit é curto por LEI, não por acaso.

REFINAMENTO DO DONO (mesma sessão, verbatim na intenção): "curadoria
perfeita" — UMA skill excelente por ocasião, não 10/15/20/30. Back-end tem
UMA muito boa; front tem o impeccable; orquestração tem UMA; planejamento tem
duas-três. A régua do kit é ocasião→skill, nunca coleção.

## Consequências

- Os vetos históricos do SKILLS.md continuam valendo (ex.: skills que ensinam
  o subagente NATIVO do CLI não entram — o caminho é cercado no Synkora).
- A skill de orquestração é IN-HOUSE (`synkora-orquestracao`), porque a
  doutrina de delegação do Synkora (gui-delegator, ciclo redondo, orquestrador
  barato) não existe no mercado.
