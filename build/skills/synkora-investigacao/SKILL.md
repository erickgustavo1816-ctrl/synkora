---
name: synkora-investigacao
description: Study an area of the codebase and hand back real understanding — entry points, one flow traced end to end, layers, invariants, and traps, all with file:line references, delivered as a written report. Use when asked to "investigar", "estudar", "entender como funciona", when an orchestrator delegates a study slice, or before planning work in unfamiliar territory. Read-only by nature - this skill never edits code.
---

# Synkora — investigação (estudar e devolver entendimento)

Turn an unfamiliar area into understanding someone else can act on: the owner
deciding, an orchestrator slicing work for a fleet, or you planning your next
move. The deliverable is a WRITTEN report with `file:line` for every claim.
You report in Brazilian Portuguese (PT-BR), always.

## Method

1. **Frame the question.** One sentence: what decision or work does this
   study serve? Everything you collect must serve it — a study without a
   question becomes a tour.
2. **Find the entry points.** Where the feature starts: the UI handler, IPC
   channel, route, CLI verb, or scheduled job. List them with `file:line`.
3. **Trace ONE flow end to end.** Pick the most representative path and
   follow it from entry to effect (storage, network, screen), step by step,
   naming the data transformations along the way. One real flow traced fully
   beats five flows skimmed.
4. **Map the layers and seams.** Which modules own which responsibility,
   where the interfaces sit, which direction dependencies flow. Note the
   places where behavior can be changed without editing callers.
5. **Collect invariants and traps.** What must stay true (ordering,
   idempotency, persisted formats), what looks safe but is not, what the
   comments and tests reveal about past incidents.
6. **Name the essential files.** The short list (5-15) someone must read to
   own this area, one line each on why.

## The deliverable

Always a FILE, never only chat (understanding that lives in scrollback dies
there). As a delegated helper, write where the harness collects deliveries;
in a chat, write where the owner asked — default `.synkora/reports/`. Shape:

- **Pergunta** — what this study answers.
- **Mapa de entrada** — entry points, `file:line`.
- **O fluxo, ponta a ponta** — the traced path with transformations.
- **Camadas e costuras** — who owns what, where change is safe.
- **Invariantes e armadilhas** — what must hold, what bites.
- **Arquivos essenciais** — the reading list.
- **Recomendações de fatiamento** — only when the study serves delegation:
  which slices are independent, where the file boundaries are disjoint.

## Rules

- Read-only: this skill never edits, fixes, or "improves while passing by".
  Findings worth fixing are listed, not applied.
- Every claim carries `file:line` or names the command that proved it.
  A claim you cannot point at is a guess — label guesses explicitly.
- Depth follows the question: a slicing study goes wide and shallow; a
  "why does this break" study goes narrow and deep.
