# ADR-0011 — Skills 3.0: planejamento com método escolhido

Data: 2026-09-08 · Sessão de planejamento com o dono · Status: aceita

## Contexto

Palavras do dono: "às vezes ele nem usa skill, e às vezes ele usa, sendo que
o certo seria ele entender: pô, é um planejamento simples, então vou montar
de uma forma simples; é um planejamento mais abstrato, então eu vou usar uma
skill e fazer um planejamento muito mais complexo." O planejador recebia 5
skills e o mesmo bloco do dev, sem régua de método.

## Decisão

- Antes da primeira proposta, o planejador diz em UMA linha que tipo de
  planejamento é: SIMPLES (o dono já sabe o que quer — corta em missões
  direto, sem skill) ou ABSTRATO (objetivo/domínio/trade-offs em aberto —
  entrevista, estressa a proposta, modela o domínio, e só então corta). A
  linha é o método, e o dono pode derrubá-la.
- O método escolhe o playbook (prateleira, ou `skill_search`/`skill_pull`
  como manda a ADR-0009).
- O planejador pode SUGERIR skills por missão no `context` do item (nome +
  URL da fonte): viaja verbatim ao briefing do dev, que decide. Sem schema
  novo — é o caso LANDING-LUMA (05/09) que o dono fez à mão.

## Consequências

- Zero mecânica nova no motor de planos; a mudança é persona + ferramentas
  que o planejador já compartilha com o dev.
