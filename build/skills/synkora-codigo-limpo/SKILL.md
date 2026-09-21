---
name: synkora-codigo-limpo
description: The owner's clean-code law and the cleanup review that enforces it. Use when reviewing finished work for cleanliness, when asked to "limpar", "revisar", "deixar o código limpo", before integrating a mission, or whenever you are about to CREATE a function, helper, or module that might already exist. Not a correctness/QA gate — it makes working code clean, it does not prove code works.
---

# Synkora — código limpo (a lei do dono)

Make the code as clean as it can be: one reusable implementation instead of
copies, names that explain themselves, almost no comments, nothing dead.
Findings are always concrete: `file:line` plus the exact cleanup move.
You speak with the owner in Brazilian Portuguese (PT-BR), always.

## The owner's law

1. **DRY for real.** Before writing ANY function, helper, component, or
   constant: search the codebase for the existing one (grep by domain words,
   not just by the name you would have chosen). Two equal or near-equal
   implementations found in review ⇒ extract ONE reusable module and point
   every caller at it. A near-duplicate of a canonical helper is debt even
   when it "works".
2. **Almost zero comments.** Code explains itself through names and shape.
   A comment is the rare exception, allowed only for a constraint the code
   cannot show (an external quirk, a non-obvious invariant, a hard-won trap).
   Forbidden: comments that narrate what the next line does, restate the
   function name, mark where code was removed, or talk to a reviewer.
   If the project's own CLAUDE.md declares a different comment policy, the
   project wins — the default is the owner's law.
3. **Small and focused.** A file crossing ~1000 lines splits now, not later.
   New feature = new module. A function you cannot read without scrolling is
   asking to be broken along its natural seams.
4. **Dead code is deleted, never kept.** No commented-out blocks, no unused
   exports, no `_unused` placeholders, no backwards-compat shims nobody
   calls. Git remembers; the codebase does not have to.

## The cleanup tests (run each finding through these)

- **Deletion test** — imagine deleting the abstraction. If complexity simply
  vanishes, it was a pass-through: delete it. If it would reappear across N
  callers, it earns its keep.
- **Third-use rule** — an abstraction must earn its complexity. Do not
  generalize on the second use; DO extract on the second COPY (copies are
  duplication, not premature abstraction).
- **Reduce, not relocate** — count the concepts a reader must hold before and
  after a cleanup. If the count is unchanged, it is not cleaner; prefer the
  restructuring that makes whole branches or modes disappear.
- **Repeated conditional = missing model** — the same `if` shape tested in
  several places signals a missing function, state, or dispatcher. Extract
  the decision once.
- **Logic in its owning layer** — feature-specific logic leaking into a
  shared module (or shared logic copy-pasted into a feature) gets moved home,
  reusing the canonical helper instead of growing a near-duplicate.
- **Fewer lines, same behavior** — 1000 lines where 100 suffice is a
  failure. "Clever" that needs explaining loses to "plain" that does not.

## How to run the review

1. Scope: the mission's diff (`git diff <base>...HEAD`) when reviewing work;
   the named area when asked to clean a region. Never the whole repo unasked.
2. Sweep the scope against the law and the tests above. For every suspected
   duplicate, FIND the other copy before claiming it (grep is the proof).
3. Report in PT-BR, one finding per line, ordered by payoff:
   `arquivo:linha — o problema — o movimento` (e.g. "extrair para
   src/lib/dates.ts e apontar os 3 chamadores"). Never "considere melhorar".
4. If asked to apply: one cleanup per commit-sized step, behavior unchanged,
   existing tests still green after each move.

## Not this skill

Correctness, bugs, and test coverage are QA's job, not this review. If the
code is broken, say so in one line and stop — clean broken code is still
broken.
