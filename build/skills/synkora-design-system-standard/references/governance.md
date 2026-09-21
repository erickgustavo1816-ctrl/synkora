# Governance and adoption

A system without ownership becomes a one-time gallery. Define the smallest
governance model the team can actually operate.

Record:

- accountable owner and review path;
- contribution flow and acceptance criteria;
- source-of-truth locations and generated artifacts;
- versioning policy and compatibility promise;
- deprecation window, migration guidance, and removal criteria;
- decision-log location and exception expiry;
- release notes or change communication appropriate to the repository;
- adoption plan for existing screens, including measurement of remaining drift.

Prefer incremental adoption. Establish foundations, migrate representative
families and patterns, then expand based on product use. Do not mass-rewrite the
product merely to satisfy the system. A compatibility layer may be safer than a
flag day, but it must have an owner and an exit condition.

Add a new token or variant only when a real product need cannot be expressed by
the existing contract. Review contributions for semantic reuse, accessibility,
content behavior, responsive evidence, tests, documentation, and migration
impact. Deprecations remain visible until consumers are migrated.

Keep human approval for brand direction and meaningful breaking changes. The
validator can prove references and coverage declarations; it cannot decide
whether the product feels right.
