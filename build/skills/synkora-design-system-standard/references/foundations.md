# Foundations and tokens

## Begin with product truth

Extract the existing visual language before inventing one. Inspect real product
surfaces, brand assets, themes, data density, content range, platform limits,
accessibility targets, and existing reusable code. Separate intentional rules
from accidental repetition.

Write a design thesis short enough to make choices: product character,
information hierarchy, density, geometry, color behavior, motion tone, and the
relationship between brand expression and operational clarity. Every adjective
needs an observable consequence.

## Token architecture

Use three levels when the product needs them:

- primitives describe raw scales and ramps;
- semantic tokens describe purpose, such as surface, text, border, action,
  feedback, focus, and data series;
- component tokens exist only for a stable component-specific contract.

Components consume semantic or component tokens, never arbitrary primitive
values. Document aliases and fallbacks. Preserve one source of truth across CSS,
code, theme files, and documentation; generated outputs identify their source.

Cover the applicable foundations:

- color ramps, surfaces, text, borders, actions, feedback, focus, overlays, and
  data visualization, including theme and contrast behavior;
- typography families, roles, sizes, weights, line heights, tracking, measure,
  numeric alignment, and responsive scaling;
- spacing, sizing, grid, containers, breakpoints, and density modes;
- radius, border, elevation, opacity, layering, and icon geometry;
- motion duration, easing, reduced-motion behavior, and state transitions;
- content conventions, locale expansion, numbers, dates, currency, and labels.

Name tokens by role rather than current appearance. A rename or theme should not
require editing every component. Do not create a scale because a template says
so; every scale needs consumers and every hardcoded exception needs a reason.

## Verification

Check contrast in every supported theme and state, keyboard focus against each
surface, text and zoom expansion, forced colors where applicable, and compact
and wide layouts. Compare token source, compiled output, documentation, and the
rendered specimen for drift.
