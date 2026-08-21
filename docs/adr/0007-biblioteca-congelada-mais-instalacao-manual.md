# ADR-0007 — Skills 2.0: biblioteca congelada + instalação manual por URL

Data: 2026-08-21 · Sessão grill-with-docs com o dono · Status: aceita

## Contexto

As ~400 skills instaladas estão pinadas por sha (instalador F6); o updater
automático morreu na LIMPA. Reviver o updater agora traria superfície de rede
e supply-chain para o v1.

## Decisão

Sem update automático no v1. A tela de gestão (ADR-0006) ganha UM verbo de
rede: "instalar por URL", pinado no sha do momento da instalação — para
quando o dono achar uma skill nova. As regras do instalador F6 valem
(UTF-8 sem BOM, pasta = `name:` do frontmatter, verificação na fonte).

REFINAMENTO DO DONO (mesma sessão): as ~400 instaladas NÃO ficam — a
biblioteca é PODADA para conter só o kit aprovado ("não quero mais que tenha
as 400 skills"). A massa sai do disco na implementação, depois do veto do
dono sobre o kit; qualquer uma volta re-instalável pinada (fontes e shas
documentados no SKILLS.md/skillsCatalog — nada se perde em conhecimento,
só em disco e ruído).

## Consequências

- Zero rede em uso normal; rede só no gesto explícito do dono.
- O updater completo (check diário, badge ⟳) continua documentado no
  SKILLS.md como rodada futura, se a dor aparecer.
