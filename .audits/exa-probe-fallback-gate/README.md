# exa-probe-fallback-gate

**Status**: Day-6 Worker-3 codification (audit shipped 2026-05-27).
**Memory**: [[audits-directory-convention]] specifies the 4-file shape; this
audit is the first project-local rule built under that convention in the
unbrowse repo.
**Linked commits**: `599c7b0b5` (orchestrator: quality-gate exa probe-fallback
to stop fake-green bench coverage).

## Why this rule exists

Day-5 Worker-3 evidence (`/tmp/d5w3-resolve.json`) showed that the intent
*"see **my** github notifications"* with `--url https://github.com/notifications`
returned an envelope with `success: true`, `status_code: 200`, and a `data[0]`
body containing the public **github docs page about managing notifications** —
not the user's actual notification inbox. The skill_id was `exa-web-search`,
the source was `exa`, and the probe-fallback quality gate let it through
because the docs page has rich highlights (`hasRichHit === true`).

Day-5 Worker-1 (`/tmp/d5w1-resolve.json`) showed the matching pattern for
"get the github profile for user lekt9" — same `success: true`, same
synthetic Exa skill, but in this case the candidate URLs (`github.com/lekt9`)
were correct; only the lack of round-trippable execute paths was the bug.

Together these two failures expose the same root: **a synthetic Exa
shortlist that satisfies a `LIST_INTENT` quality gate can still violate the
agent UX contract** when (a) the user's intent carries a personal pronoun
("my", "mine", "our"), (b) the URL host is in the known-auth-gated set
(github.com, x.com, gmail.com, ...), and (c) the local machine has no fresh
cookie for that host. In that combination, the only honest response is
`auth_required` + `unbrowse_auth_capture` next_step — never a docs-about-X
page dressed up as `success: true`.

## What this rule checks

The audit enforces three invariants on every code path that emits a resolve
envelope (currently `src/orchestrator/index.ts`, `src/orchestrator/resolve-race.ts`,
`src/execution/index.ts`, `src/cli.ts`):

**Invariant A — no login-shaped body under success:true.** A grep across
shipped TypeScript looks for any `{ success: true, ... data: ... }` literal
or builder where the same scope ALSO contains `<title>Sign in to` /
`Login` / `docs about` / `Sign in - ` markers without an accompanying
`auth_required: true` flag. This catches the W3 regression at static-analysis
time without needing a live probe.

**Invariant B — auth-gated host list lives as a const array.** The set of
known-auth-gated hosts (`github.com`, `x.com`, `twitter.com`, `gmail.com`,
`mail.google.com`, ...) MUST be declared once as an exported `const` array
(e.g. `export const AUTH_GATED_HOSTS: readonly string[] = [...]`), not as
a switch/if-else chain. Audit greps for `host === "github.com"` /
`host === "x.com"` patterns at module scope OUTSIDE the constants file
and fails if it finds the registry inlined.

**Invariant C — synthetic skills carry fetch/go next_step.** Any synthetic
shortlist row (Exa probe-fallback or future search-engine fallbacks) MUST
include a `next_step.fetch` AND `next_step.go` per candidate so the agent
can round-trip via `unbrowse fetch` or `unbrowse go` and never auto-execute
a synthetic endpoint as if it were a captured skill.

## Today's expected state

Worker-1's fix lands at `src/cli.ts` + `src/execution/index.ts` later in this
wave. Until those edits arrive, `verify.sh` may exit non-zero on
invariant A — that's HONEST evidence, not a false positive. The audit was
codified now (per `audits-directory-convention.md` rule 1: "Build `verify.sh`
first, before `fix.sh`") so the rule is load-bearing the moment W1 lands.

## Related

- Memory: `audits-directory-convention.md`
- Memory: `rule-changes-backfill-retroactively.md` (the meta-rule)
- Commit: `599c7b0b5` (the orchestrator quality-gate that this audit
  protects from drift)
- Source: `src/orchestrator/index.ts:3760` (the quality-gate code)
- Test: `tests/exa-probe-fallback-gate.test.ts` (to be added by W1)
