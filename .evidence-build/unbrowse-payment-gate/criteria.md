# unbrowse-payment-gate criteria

Built from 14 evidence records (code, podman), evidence-build wave 1, 2026-05-16.
Source dump: `.evidence-build/unbrowse-payment-gate/evidence-*.jsonl`.
Each lane cites the `source_id`s that surfaced the gap (code:path#Ln from the live
codebase grep, podman:* from the fresh-machine container probe).

Directive (Lewis): hard gate login, but if they pay via x402 it is fine. A fresh
machine must not use unbrowse anonymously: usage requires EITHER a registered
account API key OR a working x402 wallet that pays per call.

## Pass criteria

- **gate-anon-refused**: A resolve or execute with no account API key AND no x402
  payment is refused before doing the work, on both the CLI client path and the
  MCP path. Today apiRequest omits the Authorization header when no key exists and
  the backend uses optionalAuth on resolve, so a fresh container with no
  `~/.unbrowse`, no `UNBROWSE_API_KEY`, no wallet still ran resolve against prod.
  Sources: [code:src/client/index.ts#L561, code:backend/src/middleware/auth.ts#L130, podman:resolve-anonymous, podman:setup-no-gate]
- **gate-x402-bypasses-login**: When there is no account API key but a valid x402
  payment is presented, the request proceeds. x402 payment substitutes for login;
  the gate must not block a paying agent. Sources: [code:src/client/index.ts#L642, code:backend/src/services/flex.ts#L34, podman:mcp-x402]
- **gate-actionable-nextstep**: The anonymous refusal returns a structured
  next_step naming both satisfiable paths (register an account OR fund a wallet
  via Lobster Cash) with concrete suggested_commands, not a bare error. Today
  `unbrowse account` on a fresh machine reports signed_in:no wallet:none and the
  product proceeds anyway. Sources: [code:src/cli.ts#L1863, podman:setup-no-gate, podman:resolve-anonymous]
- **mcp-402-carried**: On a backend HTTP 402, the MCP execute path must carry the
  challenge, pay via the wallet, and retry, instead of returning the 402 body as
  an error string. Today src/mcp.ts api() dispatches via fastify inject() and
  only accepts 2xx, so paid execute via MCP never pays. Sources: [code:src/mcp.ts#L1033, code:src/client/index.ts#L642, podman:mcp-x402]
- **mcp-cli-payment-parity**: The MCP execute payment behavior reaches parity with
  the CLI payAndRetry path: the same 402 that the CLI pays and retries must also
  be paid and retried when the call originates from an MCP tool. Sources: [code:src/client/index.ts#L642, code:src/mcp.ts#L1033]
- **splits-settle-on-mcp**: After an MCP paid execute, the existing server side
  split math (computeFlexSplits, platform 1000 bps, contributors 9000 bps by
  delta) settles and the payment is recorded, exactly as it already does for the
  CLI and sponsor rails. The break is purely that MCP never triggers payment.
  Sources: [code:backend/src/services/flex.ts#L34, code:src/mcp.ts#L1033, podman:mcp-x402]
- **setup-registers-or-wallet**: `unbrowse setup` on a fresh machine ends at a
  satisfiable gate: it either completes account registration OR provisions a
  wallet, and never finishes in the silent signed_in:no wallet:none state that a
  fresh container currently reaches. Sources: [code:src/cli.ts#L1863, code:src/runtime/setup.ts#L259, podman:setup-no-gate, podman:install]
- **setup-lobster-path**: Setup surfaces the Lobster Cash wallet provisioning path
  as the wallet onboarding step, including the human approval URL handoff, and
  detects the resulting wallet. lobster-cli is reachable from a fresh machine
  (npx @crossmint/lobster-cli ran, version 3.2.0). Sources: [code:src/runtime/setup.ts#L210, code:src/payments/wallet.ts#L95, podman:lobster-reachable]

## Out of scope

- kuri-zig-binary-changes: Kuri is a separately maintained Zig binary.
- lobster-cli-internal-behaviour: we shell out to it, we do not own it.
- hosted-lobster-approval-page-ux: the lobster.cash hosted consent page is theirs.
- ranker-confidence-calibration: unrelated to the payment gate.

## Adversarial (held, not a fail by itself)

- lobster-headless-limit: a fresh user cannot get a funded wallet purely headless.
  The deposit and consent step needs a human at the hosted approval URL. The gate
  must therefore accept account registration as the fully headless satisfiable
  path and surface the Lobster approval URL as the wallet path, not hard block on
  wallet funding completing in-process.

## Rubric (machine-readable)

```yaml
lanes:
  - id: gate-anon-refused
    description: "resolve/execute with no API key AND no x402 payment is refused before work, on CLI client path and MCP path"
    source_ids: [code:src/client/index.ts#L561, code:backend/src/middleware/auth.ts#L130, podman:resolve-anonymous, podman:setup-no-gate]
    bench_signal: |
      echo "== client omits auth when no key ==";
      grep -n 'noAuth ? "" : getApiKey' src/client/index.ts || echo "MARKER_GONE_client_auth_omission";
      echo "== backend optionalAuth on resolve route ==";
      grep -rn "optionalAuth" backend/src/index.ts src/api/routes.ts 2>/dev/null | head;
      echo "== gate guard present? ==";
      grep -rniE "account[_-]?required|requireAccountOrPayment|anonymous.*refus|gate.*(account|wallet|x402)" src/client/index.ts src/mcp.ts backend/src/middleware/ 2>/dev/null | head;
      echo "== gate test ==";
      ls tests/ 2>/dev/null | grep -iE "payment-gate|auth-gate|anon" || echo "NO_GATE_TEST";
      bun test tests/payment-gate.test.ts 2>&1 | tail -25 || true
    pass_when: >
      A pre-work gate exists and runs on BOTH the client apiRequest path and the
      MCP api() path. A dedicated gate test exists and passes, exercising the real
      refusal of a no-key no-payment call. The grep for the bare optionalAuth
      anonymous path no longer shows resolve served without any account-or-payment
      check. Agent judges by reading the dumped code and test output, not a script
      verdict.
  - id: gate-x402-bypasses-login
    description: "no account API key but valid x402 payment present => request proceeds; gate never blocks a paying agent"
    source_ids: [code:src/client/index.ts#L642, code:backend/src/services/flex.ts#L34, podman:mcp-x402]
    bench_signal: |
      echo "== CLI 402 pay-and-retry path ==";
      grep -n "payAndRetry" src/client/index.ts || echo "MARKER_GONE_payAndRetry";
      echo "== gate honors x402 instead of blocking ==";
      grep -rniE "x402|payment.*satisf|paid.*proceed|payment.*bypass.*account" src/client/index.ts src/mcp.ts backend/src/middleware/ 2>/dev/null | head -20;
      echo "== gate test covering the paying-agent path ==";
      bun test tests/payment-gate.test.ts 2>&1 | grep -iE "x402|pay|wallet|proceed" | tail -20 || echo "NO_PAYING_AGENT_ASSERTION"
    pass_when: >
      The gate logic explicitly lets a request through when a valid x402 payment is
      presented even with no account API key, and a test asserts a paying-agent
      call is NOT refused. Agent reads the code path plus test output and judges
      that paying substitutes for login.
  - id: gate-actionable-nextstep
    description: "anonymous refusal returns a structured next_step (register OR fund wallet via lobster) with suggested_commands, not a bare error"
    source_ids: [code:src/cli.ts#L1863, podman:setup-no-gate, podman:resolve-anonymous]
    bench_signal: |
      echo "== refusal payload shape ==";
      grep -rniE "next_step|next_action|suggested_command" src/client/index.ts src/mcp.ts src/cli.ts 2>/dev/null | grep -iE "account|wallet|register|lobster|x402" | head -20 || echo "NO_GATE_NEXTSTEP";
      echo "== fresh account state today ==";
      grep -n "no longer registers" src/cli.ts || echo "MARKER_GONE_registration_optional";
      bun test tests/payment-gate.test.ts 2>&1 | grep -iE "next_step|suggested|register|lobster" | tail -15 || echo "NO_NEXTSTEP_ASSERTION"
    pass_when: >
      The refusal carries a structured next_step that names BOTH satisfiable paths
      (register an account, fund a wallet via Lobster Cash) and concrete
      suggested_commands. A test asserts the shape. Agent judges the dumped
      payload-construction code and test output.
  - id: mcp-402-carried
    description: "MCP execute on backend 402 carries the challenge, pays via wallet, retries; does not return 402 as error string"
    source_ids: [code:src/mcp.ts#L1033, code:src/client/index.ts#L642, podman:mcp-x402]
    bench_signal: |
      echo "== MCP api() dispatch + status handling ==";
      grep -n "app.inject\|statusCode\|payAndRetry\|402" src/mcp.ts | head -30;
      echo "== MCP payment retry test ==";
      ls tests/ 2>/dev/null | grep -iE "mcp.*402|mcp.*pay|mcp-x402" || echo "NO_MCP_402_TEST";
      bun test tests/mcp-x402.test.ts 2>&1 | tail -25 || true
    pass_when: >
      src/mcp.ts api() now handles a 402 by paying and retrying (a payAndRetry
      equivalent reachable from the MCP path), not by returning the body as an
      error. A test drives an MCP execute against a 402 and asserts the retried
      call succeeds after payment. Agent reads the dumped api() code and test
      output and judges.
  - id: mcp-cli-payment-parity
    description: "the same 402 the CLI pays+retries is also paid+retried when the call originates from an MCP tool"
    source_ids: [code:src/client/index.ts#L642, code:src/mcp.ts#L1033]
    bench_signal: |
      echo "== shared payment path between CLI and MCP ==";
      grep -rn "payAndRetry\|handle402\|payForChallenge\|x402" src/client/index.ts src/mcp.ts src/payments/ 2>/dev/null | head -30;
      echo "== parity test ==";
      bun test tests/mcp-x402.test.ts tests/payment-gate.test.ts 2>&1 | grep -iE "parity|cli|mcp|retr|402" | tail -20 || echo "NO_PARITY_ASSERTION"
    pass_when: >
      CLI and MCP share one payment-on-402 implementation (one function both call)
      or an equivalent that demonstrably produces the same retry+success behavior.
      A test exercises both surfaces against the same 402 and asserts identical
      outcomes. Agent judges from the dumped shared-path code and test output.
  - id: splits-settle-on-mcp
    description: "after an MCP paid execute, computeFlexSplits settles + payment records, as it already does for CLI/sponsor"
    source_ids: [code:backend/src/services/flex.ts#L34, code:src/mcp.ts#L1033, podman:mcp-x402]
    bench_signal: |
      echo "== split math unchanged ==";
      grep -n "PLATFORM_BPS\|computeFlexSplits\|contributorPool" backend/src/services/flex.ts | head;
      echo "== ledger/earnings recording reachable post MCP pay ==";
      grep -rn "recordTransaction\|updateContributorDelta\|sponsor:ledger\|earnings" backend/src/services/ backend/src/middleware/sponsor.ts 2>/dev/null | head -20;
      echo "== splits test still green ==";
      bun test ./backend/tests/skills-publish-proofs.test.ts 2>&1 | tail -15 || true;
      bun test tests/mcp-x402.test.ts 2>&1 | grep -iE "split|ledger|earn|record" | tail -15 || echo "NO_SPLIT_ON_MCP_ASSERTION"
    pass_when: >
      computeFlexSplits math is untouched (platform 1000 bps, contributors 9000
      bps). A test shows that an MCP-originated paid execute reaches the same
      settle+record code path the CLI/sponsor rails reach (splits computed, ledger
      written). Agent judges from dumped code + test output; no per-domain
      heuristic added.
  - id: setup-registers-or-wallet
    description: "fresh-machine `unbrowse setup` ends at a satisfiable gate (account registered OR wallet provisioned), never silent signed_in:no wallet:none"
    source_ids: [code:src/cli.ts#L1863, code:src/runtime/setup.ts#L259, podman:setup-no-gate, podman:install]
    bench_signal: |
      echo "== setup registration posture ==";
      grep -n "no longer registers\|Registration is optional" src/cli.ts || echo "MARKER_GONE_registration_optional";
      echo "== setup escrow/session-key stubs ==";
      grep -n "HONEST-SKIP\|promptFundEscrow\|promptRegisterSessionKey\|flex" src/runtime/setup.ts | head -20;
      echo "== setup-gate test ==";
      ls tests/ 2>/dev/null | grep -iE "setup.*gate|setup-onboard|fresh-machine" || echo "NO_SETUP_GATE_TEST";
      bun test tests/setup-gate.test.ts 2>&1 | tail -20 || true
    pass_when: >
      setup no longer ends in the silent anonymous state: it either drives account
      registration to completion OR provisions a wallet, and a test asserts that
      after setup the account/wallet state is satisfiable (not signed_in:no
      wallet:none with usage still open). Agent reads the dumped setup flow and
      test output and judges.
  - id: setup-lobster-path
    description: "setup surfaces the Lobster Cash wallet provisioning path (incl. human approval URL handoff) and detects the resulting wallet"
    source_ids: [code:src/runtime/setup.ts#L210, code:src/payments/wallet.ts#L95, podman:lobster-reachable]
    bench_signal: |
      echo "== lobster provisioning invocation ==";
      grep -n "lobster-cli\|@crossmint/lobster\|LOBSTER_WALLET_ADDRESS\|approvalUrl\|consentUrl" src/runtime/setup.ts src/payments/wallet.ts 2>/dev/null | head -25;
      echo "== wallet detection after provisioning ==";
      grep -n "checkWalletConfigured\|getWalletContext\|agents.json" src/payments/wallet.ts | head;
      echo "== lobster path test ==";
      bun test tests/setup-gate.test.ts 2>&1 | grep -iE "lobster|wallet|approval|consent" | tail -15 || echo "NO_LOBSTER_PATH_ASSERTION"
    pass_when: >
      setup invokes the Lobster Cash provisioning path, surfaces the human
      approval/consent URL as the next step (does not silently skip it), and
      re-detects the wallet via checkWalletConfigured afterward. A test asserts the
      lobster path is offered and the post-provision wallet state is recognized.
      Agent judges from dumped code + test output.
out_of_scope:
  - kuri-zig-binary-changes
  - lobster-cli-internal-behaviour
  - hosted-lobster-approval-page-ux
  - ranker-confidence-calibration
adversarial:
  - lobster-headless-limit
```
