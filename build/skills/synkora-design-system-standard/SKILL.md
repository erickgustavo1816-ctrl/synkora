---
name: synkora-design-system-standard
description: Native Synkora method for creating, evolving, consolidating, migrating, documenting, or governing a complete product design system. Use for system-level tokens, component libraries, patterns, living documentation, and governance. Do not use merely to consume an existing design system while building one screen or component; that remains an Impeccable task.
---

# Synkora design-system standard

Build a product-owned system whose rules, implementation, specimen, and
governance agree. This is the one visual creation method for this occasion.
Do not invoke Impeccable, another design-system workflow, or a second
aesthetic method. The owner's stated intent and existing product truth remain
authoritative.

## Required outcome

A complete system has five connected layers:

1. foundations and semantic tokens;
2. elements and reusable component families;
3. product patterns and templates;
4. living documentation and a rendered specimen;
5. ownership, contribution, versioning, migration, and deprecation rules.

Store durable outputs in tracked product sources. A screenshot, moodboard,
token list, component gallery, or DESIGN.md alone is not a design system.

## Method

1. Inventory existing product language, duplicated values, component families,
   states, content shapes, breakpoints, accessibility constraints, and product
   patterns before defining a new taxonomy.
2. Write a short design thesis: product character, hierarchy, density,
   interaction tone, and the few deliberate constraints that distinguish this
   system. Avoid arbitrary style adjectives without observable rules.
3. Define primitive, semantic, and component tokens; implement components from
   semantic contracts rather than copied literals.
4. Specify anatomy, variants, states, content behavior, responsive behavior,
   semantics, keyboard behavior, and failure/loading/empty behavior for each
   affected family. Compose representative product patterns from those parts.
5. Build living documentation and a real rendered specimen. Include realistic
   content and working controls; prove both compact and wide behavior.
6. Fill a tracked manifest using
   [the template](assets/design-system-manifest.template.json), run
   [the validator](scripts/validate-design-system.mjs), and resolve its factual
   gaps. The validator checks structure and traceability, never aesthetic taste.
7. Record ownership, contribution, versioning, migration, and deprecation so
   the system can survive the current task.

## Progressive references

- [Foundations and tokens](references/foundations.md)
- [Components and patterns](references/components-patterns.md)
- [Living documentation and specimen](references/showcase.md)
- [Governance and adoption](references/governance.md)
- [Completion evidence](references/evidence.md)

Report the tracked sources, manifest, rendered surfaces, covered states and
viewports, validator result, and any intentionally deferred family. Never claim
completeness from generated files alone; observable product coverage decides.
