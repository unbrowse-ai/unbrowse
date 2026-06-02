# Whitepaper Sign-off — Paper 2: *Internal APIs Were Not All You Needed*

This sheet is the **human gate** on the public rollout. Stage 2 of the sequenced
rollout (`scripts/rollout-sequence.sh`) does **not** trigger until an authorized
approver signs below. The machine pre-conditions are already green; what remains is
the editorial/business sign-off — that is a person's call, not a script's.

## What is being approved

The **public release** of Paper 2 — *Internal APIs Were Not All You Needed*
(`paper/internal-apis.tex` + `.pdf`) — and the code it reflects (`paper/reference/`).

## Pre-conditions (mechanical, verified by `scripts/whitepaper-signoff-gate.sh`)

- `papers-done-gate.sh` green — every paper claim backed by running, tested code.
- `leak-guard.sh` clean on `paper/internal-apis.tex` — no moat term in the public paper.
- `paper-gate.sh` green — every shipped claim anchored; no leak.
- Both PDFs compile clean (0 undefined refs/citations).

## Authorized approvers

**Kevin** OR **Rach Pradhan**.

## Sign-off

An approver adds **one line** below, verbatim, then commits it (git authorship
records who actually signed). The gate matches `Kevin` or `Rach Pradhan` + a date:

```
SIGNED-OFF: <Kevin | Rach Pradhan> <YYYY-MM-DD>
```

--- signatures below this line (do not edit the line above) ---

(unsigned — awaiting Kevin or Rach Pradhan)
