# Living documentation and specimen

Documentation is a product surface, not a screenshot archive. It must make the
system understandable, inspectable, and usable without reading its source.

Include:

- the design thesis and token hierarchy with semantic names and theme behavior;
- component anatomy, API, variants, states, accessibility, content rules, and
  do/don't examples;
- representative patterns built from the real components;
- working theme, density, viewport, and state controls when those capabilities
  exist;
- copyable implementation examples tied to the actual source;
- ownership, contribution, versioning, migration, and deprecation guidance;
- a change record or decision log for intentional exceptions.

Use realistic product content. Exercise long labels, empty data, errors,
permissions, loading, localization, large numbers, dates, and dense information
where applicable. A specimen control must actually change the rendered state;
fake toggles and decorative examples are failures.

Inspect at representative compact and wide sizes, adding an intermediate size
only where the layout changes. Test the documentation itself for navigation,
keyboard access, focus, contrast, overflow, deep links, and readable code.

The rendered specimen and product implementation must import the same system
sources. If documentation hand-copies values or markup, label it as illustrative
and add a drift check or replace it with a live example.
