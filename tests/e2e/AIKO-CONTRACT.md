# Aiko contract — install unbrowse and prove it works end to end

The task given to a fresh `aiko` run. It is written as a contract rather than a
script because the point is to test what a *newcomer with only the docs* can
achieve: if aiko needs a hint that isn't in the repo, that is a finding about
unbrowse, not about aiko.

## The task

> Install `unbrowse` from this repository as a real package — not by running the
> source — and then verify every invariant in `tests/e2e/install-matrix.ts`
> against the installed binary. Report which invariants hold, which fail, and
> which you could not check and why. Do not edit unbrowse source to make a check
> pass.

```bash
aiko --check --always-approve \
  --cwd /home/deck/work/unbrowse-dev \
  "$(cat tests/e2e/AIKO-CONTRACT.md)"
```

## Preconditions the run cannot supply for itself

1. **A release signing key.** `packages/skill`'s `prepack` refuses to build an
   unsigned release, so packing needs
   `UNBROWSE_RELEASE_MANIFEST_SIGNING_SECRET`. The harness reads it from
   `~/.unbrowse/release.env` — the same path
   `scripts/cloud-agent-latest-unbrowse-witness.sh` uses — or inherits it from
   the environment. Without it every cell is UNSTAMPED and names that blocker.
   Never echo the value; a locally-signed manifest is a test artifact, not a
   publishable release.
2. **A tree this run is allowed to build in.** `prepack` rewrites tracked
   `src/build-info.generated.ts` (restored automatically afterwards) and rebuilds
   gitignored `packages/skill/runtime/` in place, which is **not** restored. If a
   global install symlinks to `packages/skill`, packing replaces that install's
   runtime as a side effect. The harness announces this; do not treat it as a
   surprise, and do not run it while depending on that global install being
   frozen.

## What counts as done

```bash
bun tests/e2e/install-matrix.ts
```

Exit 0. Nothing else is the gate — not a summary, not a green-looking log.

## Rules that outrank finishing

1. **Never convert an unavailable check into a PASS.** A cell whose precondition
   is missing is `UNSTAMPED` and names its blocker. The harness exits non-zero on
   UNSTAMPED for exactly this reason: an unanswered question is not a green gate.
2. **Transport success is not task success.** Exit 0, HTTP 200, `ok:true`,
   cookies present, a route hit — each proves only that something moved. Judge
   `task_ok` / `auth_ok` / `browser_opened` / `trace`, and treat contradictory
   terminal fields as an automatic failure.
3. **Grade the installed package.** If the binary under test resolves inside the
   source tree, cell `E3` fails on purpose. Running `bun src/cli.ts` is not an
   install test, and the most common way this suite could lie to itself.
4. **Do not edit unbrowse source.** Fixing the product to make the test pass
   inverts the test. Report the failure instead.
5. **Never print a secret value.** Names and paths only.

## What this suite does and does not cover

It covers the invariants that are **observable from outside a shipped binary**.
It is deliberately NOT a re-run of `tests/algorithm-permutations.test.ts`, whose
7,938 cells are exhaustive precisely because those functions are pure — a real
install has a filesystem, a network and a browser, and cannot be walked that way.

| Layer | File | Cells | Nature |
|---|---|---:|---|
| decision layer | `tests/algorithm-permutations.test.ts` | 7,938 | exhaustive, pure |
| shipped binary | `tests/e2e/install-matrix.ts` | 11 | observable projections |

**Both consumer surfaces, not just the CLI.** Cells E1–E4 and every `M-*` cell
drive the command line, but an agent host reaches this binary through
`unbrowse mcp` (stdio JSON-RPC) and never runs the CLI at all — a binary whose
CLI is perfect and whose MCP surface cannot handshake is broken for all of its
real users. `E5-mcp-surface-speaks-protocol` covers that surface.

Each E2E cell names the pure invariant it projects (`projects:`), so the two stay
linked: if the pure matrix gains an invariant that a user could observe, this
file should gain a cell.

**Known blind spots** — stated rather than implied:

- Auth and payment cells depend on the target presenting as blocked. If it does
  not, the cell is UNSTAMPED, never PASS.
- Anything requiring real credentials is out of scope; the suite never guesses
  credentials, creates accounts, or solves challenges.
- `--offline` marks every network cell UNSTAMPED. Useful for checking the
  install path alone; it can never produce a green run.

## Reporting

Write findings as `observed contradiction -> shared primitive -> runnable
witness`. Rank them: false success first, then unbounded recovery and capability
lies, then impossible agency, then output quality. **RED is a valid outcome** —
a suite that cannot fail is not measuring anything.
