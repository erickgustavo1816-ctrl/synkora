# ADR-0002 — Skills 2.0: transporte por pasta no worktree

Data: 2026-08-21 · Sessão grill-with-docs com o dono · Status: aceita

## Contexto

Três transportes possíveis: pasta de skills no worktree (suporte NATIVO dos
dois CLIs — sondas de 2026-07-29: claude lista `<config>/skills` e
`.claude/skills` do cwd no handshake com carga sob demanda; codex tem
`skills/list` por cwd), tools MCP (`skill_menu`/`skill_load`), ou menu na
persona + Read na biblioteca.

## Decisão

O harness SINCRONIZA o kit do tipo de chat para a pasta de skills do worktree
da missão (git nunca vê — `info/exclude`, máquina existente). Os CLIs consomem
nativo; os ajudantes headless herdam o kit de graça (mesmo worktree). Falha de
sync NUNCA é silenciosa: vira nota no chat (regra da casa).

## Consequências

- Reusa a UX nativa de skills dos CLIs (menu automático + progressive
  disclosure) em vez de reinventá-la por MCP.
- Armadilhas conhecidas valem aqui: BOM mata o frontmatter nos dois CLIs;
  pasta = `name:`; a pasta `skills/` precisa existir no boot do pane.
- A skill de orquestração fica visível ao ajudante (mesma pasta) — inofensivo:
  as tools que ela ensina não existem no catálogo só-LSP dele, e a recusa
  nomeia a receita.
