# Testing Patterns

**Analysis Date:** 2026-04-01

## Test Framework

**Runner:** Bun test (built-in bun:test)

**Assertion library:** bun:test built-in (`expect`, `it`, `test`, `describe`, `beforeAll`, `afterAll`)

**Run Commands:**
```bash
bun test tests/path-params.test.ts tests/utils.test.ts evals/quality-gate.test.ts  # default suite
bun test tests/                                                                      # all unit tests
bun test tests/cli-e2e.test.ts                                                       # CLI e2e tests
bun run test:all                                                                     # all tests incl. backend
bun run test:p0-p1                                                                   # P0/P1 regression runner
bun run test:p0-p1:unit                                                              # unit category only
bun run test:p0-p1:cli                                                               # CLI category only
bun run test:p0-p1:integration                                                       # integration category (manual)
```

## No Mocking Policy

**Never mock in tests.** Tests must hit real endpoints, real files, real functions. Mocked tests pass when prod is broken — they prove nothing.

- Use live backend URLs (gated behind env vars for CI)
- Use real filesystem temp dirs (`mkdtempSync`)
- Call actual functions, not stubs

If a test can't run without mocking, the code is too coupled — fix the code, not the test.

**Tests that require unavailable resources (cookies, auth, running server) skip with a `console.log` message:**

```typescript
const cookies = await getAuthCookies("github.com");
if (!cookies || cookies.length === 0) {
  console.log("SKIP: not logged into github.com in Chrome");
  return;
}
```

This is the canonical skip pattern throughout `tests/auth-integration.test.ts` and `tests/cli-e2e.test.ts`.

## Test File Organization

**Location:** `tests/` directory, co-located alongside source in `evals/`

**Naming:** `<feature-or-bug>.test.ts` — descriptive of the concern being tested

**Examples:**
- `tests/path-params.test.ts` — unit tests for URL parameterization
- `tests/har-headers-guard.test.ts` — regression guard for footgun patterns
- `tests/auth-integration.test.ts` — live integration tests using Chrome cookies
- `tests/cli-e2e.test.ts` — end-to-end CLI tests with real HTTP server
- `tests/p0-p1-issues.test.ts` — regression suite for closed P0/P1 GitHub issues
- `evals/quality-gate.test.ts` — extraction quality validation logic

## Test Structure

**Standard unit test pattern:**

```typescript
import { describe, it, expect } from "bun:test";
import { extractEndpoints } from "../src/reverse-engineer/index.js";

describe("feature name (BUG-NNN)", () => {
  it("does the expected thing", () => {
    const result = extractEndpoints([/* real data */]);
    expect(result.length).toBe(1);
    expect(result[0].url_template).toMatch(/\{[a-z_]+\}/);
  });
});
```

**Integration test with server lifecycle:**

```typescript
import { beforeAll, afterAll, describe, it, expect } from "bun:test";

let serverProc: Bun.Subprocess | null = null;

beforeAll(async () => {
  if (await isServerUp()) return;
  serverProc = Bun.spawn([process.execPath, "src/index.ts"], {
    env: { ...process.env, UNBROWSE_NON_INTERACTIVE: "1" },
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitForServer();
});

afterAll(() => { serverProc?.kill(); });
```

File: `tests/cli-e2e.test.ts`

**Long timeout annotation** (required for network/browser tests):

```typescript
it("resolve + execute works for a public page", async () => {
  // ...
}, 90_000);  // 90-second timeout
```

## Fixture Data Pattern

Unit tests construct minimal fixture objects inline rather than loading fixture files:

```typescript
function makeReq(method: string, url: string, responseBody?: string): RawRequest {
  return {
    url,
    method,
    request_headers: { "accept": "application/json", "user-agent": "test" },
    response_headers: { "content-type": "application/json" },
    response_body: responseBody ?? JSON.stringify({ ok: true }),
    status: 200,
  } as RawRequest;
}
```

File: `tests/path-params.test.ts`

## Eval Harness

The eval harness in `evals/` is a separate system from unit/integration tests. It drives the full CLI and stores results as JSON artifacts for agent review.

### Running Evals

```bash
bun run eval:codex                            # interactive single case or cases file
bun run eval:codex:product-success            # canonical product-success suite
bun run eval:codex:stress                     # stress suite (breadth)
bun run eval:codex:public                     # alias for product-success
bun run eval:codex:agent-targets              # alias for stress
```

Pass a single case without a case file:
```bash
bun run eval:codex -- --intent "search repos" --url "https://github.com/search?q=openai" --force-capture
```

### Eval Lifecycle

1. Harness runs `resolve` against each case via the CLI (`bun src/cli.ts resolve ...`)
2. Each case stops at resolve — no automatic execute
3. Collector status stored: `ready_for_review`, `fail`, or `skip`
4. Agent judges shortlist quality in-thread; execute is optional for deeper validation
5. Results written to `evals/codex-harness-last-run.json`
6. Review queue written to `evals/codex-harness-last-run.review-queue.json`

### Reading Eval Artifacts

Before patching based on eval results, read:
- `evals/codex-harness-last-run.json` — full artifact (resolve excerpt, endpoint shortlist, graph section)
- `evals/codex-harness-last-run.review-queue.json` — compact view for batch agent review

**Key fields to check:**
- `collector_status` — `ready_for_review` / `fail` / `skip`
- `agent_review.execute_candidates` — CLI commands ready to copy/paste for execute
- `resolve_excerpt` — compressed resolve response
- `query_source` — `url`, `params`, or `mixed`
- `graph.selection_summary` / `graph.dependency_summary` — graph health

### Eval Case Files

- `evals/codex-cases.product-success.json` — canonical product claims
- `evals/codex-cases.stress.json` — breadth/hostile surfaces
- `evals/codex-cases.example.json` — minimal reference format

Do not add new parallel eval harnesses. Extend `evals/codex-harness.ts` or its helpers in `evals/codex-harness-lib.ts`.

### Auth in Evals

If a case needs auth, ensure local vault/browser cookies exist first:
```bash
bun run eval:codex:auth    # scripted auth runner for known sites
```

Cases with `auth` set will skip (`collector_status: "skip"`) if cookies are not present.

## Quality Gate Test

`evals/quality-gate.test.ts` runs as part of the default test suite and validates extraction quality logic:

- Concatenation detection (e.g., `AAPLApple`, `Inc978`)
- Deduplication (>50% duplicate rows)
- Diversity (all items share same link/title = nav chrome)
- SPA data extraction (`__NEXT_DATA__`, `__INITIAL_STATE__`, `__PRELOADED_STATE__`)

These test helper functions defined inline in the test file (mirroring `execution/index.ts` logic for isolated testing).

## P0/P1 Regression Framework

### What It Is

A two-tier system for validating closed GitHub issues remain fixed:

- **`tests/p0-p1-issues.json`** — test cases extracted from closed P0/P1 GitHub issues
- **`tests/p0-p1-analyses.json`** — categorization of each issue (unit/cli/integration testable)
- **`scripts/p0-p1-test-runner.ts`** — orchestrates unit, CLI, and integration test runs
- **`evals/p0-p1-test-results.json`** — output artifact with pass/fail per issue

### Running P0/P1 Tests

```bash
bun run test:p0-p1                   # all categories
bun run test:p0-p1 --category unit   # unit only
bun run test:p0-p1 --category cli    # CLI health check per issue
bun run test:p0-p1:analyze           # generate analyses from issue data
bun run test:p0-p1:generate          # fetch issues from GitHub into p0-p1-issues.json
```

### Categories

- **`unit_testable`** — pure function tests; runs `bun test tests/`
- **`cli_testable`** — runs `bun src/cli.ts health` as a smoke check per issue
- **`integration_testable`** — requires manual setup (auth, running servers); printed as guide only

### Pre-push Hook

The `.husky/pre-push` hook runs the full P0/P1 suite before pushing, gated on `tests/p0-p1-analyses.json` existing and being non-empty. Skip with `git push --no-verify` if needed.

The `.husky/pre-commit` hook (`scripts/precommit.sh`) runs targeted tests based on which files are staged:
- Changes to `src/client/`, `src/runtime/`, `src/cli.ts` → `tests/client-registration.test.ts`, `tests/runtime-setup.test.ts`
- Changes to `src/kuri/`, `src/runtime/paths.ts`, `packages/skill/` → `scripts/check-packaged-kuri.sh`
- Changes to execution/orchestrator/capture/extraction → `tests/cli-input-payload.test.ts`, `tests/intent-match.test.ts`, `tests/graph-filters.test.ts`
- Changes to `src/cli.ts` or `SKILL.md` → SKILL.md sync check

## Test Coverage Notes

**Smoke tests only:** `tests/basic.test.ts` and `tests/utils.test.ts` are stubs (`it('works', () => {})`) — placeholders.

**Live network tests skip gracefully** when not logged in or backend is unavailable — they never fail due to environment.

**Source-scanning tests** check source code structure directly (see `tests/har-headers-guard.test.ts`) to enforce coding footgun guards.

---

*Testing analysis: 2026-04-01*
