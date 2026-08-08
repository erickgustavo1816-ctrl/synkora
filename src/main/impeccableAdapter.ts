const ALLOWED_OPERATIONS = new Set(['layout', 'adapt', 'harden', 'typeset', 'polish'])

const PLAYBOOKS: Readonly<Record<string, string>> = {
  layout: `## Diagnose relationships

Name the primary task, reading path, dominant region, supporting regions and
intended density before moving elements. Use proximity and shared rails to show
ownership. Navigation, page context, global commands, list controls and item
actions must each occupy the smallest region they govern.

Allocate width and height by task value and content pressure. Empty space must
clarify hierarchy; leftover grid tracks, distant action islands and tall bands
with little content are defects. Group filters by the result they affect. Place
page actions with the page heading, list actions with the list heading and item
actions in a stable item-owned rail.

Repeated cards and rows use one anatomy: identity, decision-critical metadata,
state and actions. Long titles may wrap without shifting equivalent metadata to
random baselines. Equivalent controls share target box, height, padding, icon
scale and state geometry. Establish within-group, between-group and section
spacing roles instead of repeating one gap everywhere.

Verify the whole composition at representative narrow, pressure and wide
widths, plus long/missing content. Use the squint test for primary/secondary
order, then inspect optical alignment, line boxes, icon weight and divider ends.`,

  adapt: `## Recompose under pressure

Identify the groups, priority order, preferred co-row relationships and
fallback order. Change topology when real content no longer fits or remains
usable; do not merely stack every desktop band above the work.

Use intrinsic geometry: min-width: 0 for flexible children, minmax(0, 1fr) for
flexible grid tracks, protected action rails and border-box sizing. Reorder,
collapse, reveal or change representation while preserving every core task.
Visual, DOM, Tab and reverse-Tab order must remain coherent.

Choose wrap, ellipsis, clamp or full display per field. Truncation never changes
the source value and important hidden content needs a keyboard- and
touch-accessible disclosure. Test the smallest supported width, intermediate
pressure points, wide view, zoom/text resize, short/long/localized content,
pointer, touch and keyboard. Any permitted scroll has a declared owner, bounded
axis and reachable endpoints.`,

  harden: `## Make reachable extremes safe

Inventory states and content the component can actually receive: short, long,
missing, duplicated, localized and asymmetric values; loading, empty, no
results, error, success, disabled, pending, read-only, offline, timeout and
permission limits. Cover only reachable states, but do not omit inconvenient
ones.

Give every text field an explicit wrap/truncate/full-value policy. Fix the
owning geometry instead of hiding leaks with global clipping. Preserve complete
values for copy, data operations and accessible reading. Protect focus rings,
overlays, sticky elements, safe areas, z-order and both endpoints of legitimate
scroll regions.

Enabled controls must either perform their promise or give truthful feedback.
Async actions prevent duplicate effects, preserve context and announce success
or failure. Overlays have naming, trigger relationship, collision policy,
keyboard dismissal, focus containment/restoration and mobile behavior. Verify
edge cases in the running surface, not only through source inspection.`,

  typeset: `## Build a readable type system

Map semantic roles before changing fonts: display, page title, section title,
body, label, metadata, data and action. Use the fewest distinct sizes and
weights that produce unmistakable hierarchy. Product importance, not component
defaults, determines emphasis.

Choose a face that fits the established identity and language coverage. Check
real font loading and fallbacks to avoid layout shift or a mismatched initial
render. Set line-height, measure, tracking and paragraph spacing by reading
role. Align numerals and tabular data deliberately; preserve differentiation at
zoom, high contrast and reduced font availability.

Exercise long headings, compact controls, multiline labels, localization and
text resize. Wrapping must not create accidental hierarchy, clipped controls or
inconsistent card anatomy. Verify optical baselines beside icons and controls
after the structural type scale is stable.`,

  polish: `## Finish without changing direction

Preserve the approved structure, behavior, copy and visual identity. First fix
the most visible inconsistency class across the affected surface; do not turn a
finish pass into redesign or add decoration to compensate for weak hierarchy.

Inspect shared geometry of peer controls, optical baselines, icon weight,
corner and border grammar, color roles, contrast, focus, dividers, edge balance
and state transitions. Remove duplicated containers, badges, shadows or
separators whose absence improves grouping. Motion, when already in scope,
clarifies state and respects reduced motion.

Perform one bounded rendered inspection across the affected widths/states, fix
the observed class in one batch and confirm once. Stop when the scoped surface
is coherent; leave preference-level alternatives for human judgment.`
}

function safeOperation(value: string): string | undefined {
  return ALLOWED_OPERATIONS.has(value) ? value : undefined
}

/**
 * The upstream package is a broad interactive router. Synkora intentionally
 * uses an app-owned, operation-scoped distillation so upstream setup, links,
 * helpers and cross-command handoffs can never reopen the routed decision.
 * The second argument is accepted only to keep the loader API stable; raw
 * upstream instructions are never included in the activation payload.
 */
export function buildSynkoraImpeccableActivation(
  operationInput: string,
  _selectedReference = ''
): string | undefined {
  const operation = safeOperation(operationInput)
  if (!operation) return undefined

  return `# Synkora Impeccable adapter: ${operation}

This is a closed, operation-scoped technique. Synkora has already selected **${operation}** for this pane.

Binding rules:

- Apply only **${operation}**. Do not route again, invoke another Impeccable command, or stack another aesthetic method.
- Do not load the upstream root, routing menu, setup workflow, scripts, hooks, or another operation reference.
- Do not spawn or delegate a design assessment. Work in this pane; a separate Synkora QA phase judges the result independently.
- Preserve the brief, product behavior, factual copy, established visual identity, and everything outside the card scope.
- Diagnose the whole defect class, state the relevant design thesis, implement it in production code, and verify affected states, content extremes and viewports proportionally.
- Stop when ${operation} is implemented and verified. Do not continue into a general redesign or follow-up operation.

${PLAYBOOKS[operation]}`
}
