# Components and product patterns

## Component contract

For each affected family, document and implement:

- purpose and non-goals;
- anatomy and owned regions;
- variants, sizes, density, and composition boundaries;
- default, hover, active, selected, focus-visible, disabled, read-only, loading,
  empty, error, success, and permission behavior where meaningful;
- short, long, missing, localized, numeric, and asymmetric content behavior;
- responsive geometry, wrapping, truncation, collision, scroll, and overlay
  ownership;
- semantic element, accessible name, role, state/value, keyboard order,
  dismissal, focus restoration, and reduced-motion behavior;
- API, defaults, escape hatches, examples, tests, and migration notes.

Do not force every state onto every component. Mark a state not applicable with
the reason, rather than silently omitting it. Prefer composition and explicit
slots over boolean-prop explosions. Shared behavior belongs in primitives;
product-specific meaning stays in patterns.

## Layering

Keep elements, components, and patterns distinct. Elements are small visual or
semantic building blocks. Components own a reusable interaction contract.
Patterns compose components into product behavior such as navigation, forms,
search/filter/sort, authentication, onboarding, feedback, data entry, data
review, and destructive confirmation.

For data-dense products, deliberately cover representative KPI/value displays,
charts and legends, dense tables, status/progress, cards, calendars or timelines,
comparison, filters, empty/loading/error states, and responsive reductions where
the domain uses them. Never add those families merely to fill a checklist.

## Consistency tests

Compare equivalent controls side by side. Verify shared height, padding,
baseline, icon geometry, focus treatment, state language, and content policy.
Then place them in real product patterns: isolated component beauty does not
prove compositional coherence.
