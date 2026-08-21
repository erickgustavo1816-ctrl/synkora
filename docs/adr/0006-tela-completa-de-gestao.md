# ADR-0006 — Skills 2.0: tela completa de gestão do kit

Data: 2026-08-21 · Sessão grill-with-docs com o dono · Status: aceita
(decisão do dono CONTRA a recomendação do orquestrador, registrada assim)

## Contexto

O orquestrador recomendou kit em módulo versionado sem tela no v1. O dono
escolheu a tela completa: ver E editar o kit pela UI, sem commit.

## Decisão

O kit vira DADO: store em userData (jsonStore atômico da casa), SEMEADO pela
proposta curada aprovada no veto do dono. A tela de gestão liga/desliga skill
por tipo de chat e mostra o kit ativo. As duas LEIS (ADR-0005) ficam FORA do
toggle — fixas na persona.

## Consequências

- Superfície de UI real no v1 (tela + IPC + store) — o v1 fica maior do que o
  mínimo recomendado.
- Toggle vale para conversa NOVA/spawn novo (o sync acontece no spawn);
  conversa aberta não re-sincroniza no meio — regra dita na própria tela.
