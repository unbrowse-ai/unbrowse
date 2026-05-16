# unbrowse-flex-settlement criteria

Built from 10 evidence records (code, faremeter), wave 1, 2026-05-17.
Source dump: `.evidence-build/unbrowse-flex-settlement/evidence-*.jsonl`.
Each lane cites code:path#Ln (live grep of HEAD, which already carries the
6ef1fed9 account-or-x402 gate) or faremeter:<doc> (the bundled Flex/PayAI
client contract). Builds the settle path the prior wave scoped out.

## Pass criteria

- **deps-present**: `@faremeter/flex-solana`, `@faremeter/payment-solana`,
  and `@faremeter/fetch` are real dependencies (or the documented client
  flow is vendored under src/payments/flex/), so escrow/authorization code
  can import them. Today none are present. Sources:
  [code:package.json#faremeter-deps, faremeter:flex-quickstart#escrow]
- **escrow-session-key**: a client helper creates or reuses a Flex escrow
  and registers an Ed25519 session key, binding the facilitator at
  escrow-creation time to the EXISTING declared config
  (`UNBROWSE_X402_FACILITATOR ?? https://facilitator.payai.network`), never
  a new hardcoded literal. Sources:
  [faremeter:flex-quickstart#escrow, code:src/payments/index.ts#L143]
- **authorize-on-402**: on an HTTP 402, the pay path builds + Ed25519
  session-key-signs a Flex payment authorization (serializePaymentAuthorization
  / createPaymentHandler equivalent) and retries, instead of only returning
  the structured buildGateRefusal next_step. Sources:
  [faremeter:flex-quickstart#authorize, code:src/payments/index.ts#buildGateRefusal]
- **splits-from-frozen-computeFlexSplits**: the authorization `splits`
  array is exactly the output of the UNCHANGED computeFlexSplits (platform
  1000 bps, total 10000, <=5 recipients); flex.ts diff vs HEAD is zero
  lines. Sources:
  [code:backend/src/services/flex.ts#L34, faremeter:flex-concepts#splits]
- **payai-facilitator-submit**: the signed authorization is submitted to
  the configured PayAI facilitator (verify/settle), reading the declared
  config, no per-call-site host literal. Sources:
  [faremeter:payai#facilitator, code:src/payments/index.ts#L143]
- **mcp-cli-settle-parity**: an MCP-originated AND a CLI-originated paid
  execute both reach the real Flex authorize+submit+retry path (one shared
  implementation), preserving the 6ef1fed9 gate semantics and the 146/0
  payment/auth suite. Sources:
  [code:src/mcp.ts#L1058, code:src/client/index.ts#L642]
- **no-mock-echo-falsifier**: the settle path is exercised end-to-end with
  NO mocks against the x402.payai.network instant-refund echo (a real
  facilitator round-trip whose test payments auto-refund), and a test
  asserts a 402 becomes a settled+retried success. Sources:
  [faremeter:payai#facilitator, faremeter:flex-quickstart#authorize]

## Out of scope

- on-chain-flex-anchor-program-internals: the Solana program is upstream.
- payai-facilitator-service-itself: we are a client of it.
- computeFlexSplits-math-change: frozen NON-GOAL.
- gate-semantics-change-from-6ef1fed9: the account-or-x402 gate stays.
- kuri-zig.

## Adversarial (held, not a fail by itself)

- escrow-funding-headless-limit: full escrow funding needs a human at the
  hosted approval URL; account-register stays the headless satisfiable
  path. The settle path is proven via the x402.payai.network instant-refund
  echo so it is exercisable without real funds; a real-mainnet settle is
  NOT required to pass.

## Rubric (machine-readable)

```yaml
lanes:
  - id: deps-present
    description: "@faremeter/flex-solana + payment-solana + fetch are real deps or the client flow is vendored"
    source_ids: [code:package.json#faremeter-deps, faremeter:flex-quickstart#escrow]
    bench_signal: |
      echo "== faremeter deps ==" ; grep -nE '@faremeter/(flex-solana|payment-solana|fetch)' package.json || echo NONE
      echo "== vendored client flow? ==" ; ls src/payments/flex/ 2>/dev/null || echo NO_VENDOR
    pass_when: >
      package.json declares the three @faremeter packages OR src/payments/flex/
      vendors the documented client flow. Today neither: NONE + NO_VENDOR =
      RED. Agent reads the grep/ls output and judges.
  - id: escrow-session-key
    description: "client creates/reuses Flex escrow + Ed25519 session key, facilitator from declared config"
    source_ids: [faremeter:flex-quickstart#escrow, code:src/payments/index.ts#L143]
    bench_signal: |
      grep -rnE 'getCreateEscrowInstructionAsync|getRegisterSessionKeyInstructionAsync|registerSessionKey|createEscrow' src/payments src/client 2>/dev/null | head -20 || echo NO_ESCROW_CODE
      grep -n 'UNBROWSE_X402_FACILITATOR' src/payments/index.ts | head -2
      ls tests/flex-settlement*.test.ts 2>/dev/null || echo NO_FLEX_TEST
    pass_when: >
      An escrow+session-key helper exists and binds the facilitator from the
      declared UNBROWSE_X402_FACILITATOR config (not a new literal), with a
      test. Agent judges from the dumped code + test.
  - id: authorize-on-402
    description: "402 builds + session-key-signs a Flex authorization and retries, not just buildGateRefusal"
    source_ids: [faremeter:flex-quickstart#authorize, code:src/payments/index.ts#buildGateRefusal]
    bench_signal: |
      grep -rnE 'serializePaymentAuthorization|createPaymentHandler|signAuthorization|sessionKey.*sign' src/payments src/client 2>/dev/null | head -20 || echo NO_AUTHORIZE_CODE
      grep -n 'buildGateRefusal' src/payments/index.ts | head -3
      bun test tests/flex-settlement.test.ts 2>&1 | tail -15 || true
    pass_when: >
      The 402 path constructs + Ed25519-signs a Flex authorization and
      retries; buildGateRefusal remains only the fallback when no
      wallet/escrow. A test drives a 402 to a retried success. Agent judges.
  - id: splits-from-frozen-computeFlexSplits
    description: "authorization splits == unchanged computeFlexSplits output (1000/10000/<=5); flex.ts diff zero"
    source_ids: [code:backend/src/services/flex.ts#L34, faremeter:flex-concepts#splits]
    bench_signal: |
      git diff --stat HEAD -- backend/src/services/flex.ts | tail -1
      grep -n 'PLATFORM_BPS\|computeFlexSplits' backend/src/services/flex.ts | head
      grep -rnE 'computeFlexSplits' src/payments src/client 2>/dev/null | head
    pass_when: >
      flex.ts has zero diff vs HEAD (math frozen) AND the authorization
      builder consumes computeFlexSplits output for its splits array
      (sum 10000, <=5). Agent judges from diff + wiring grep.
  - id: payai-facilitator-submit
    description: "signed authorization submitted to the configured PayAI facilitator, declared config only"
    source_ids: [faremeter:payai#facilitator, code:src/payments/index.ts#L143]
    bench_signal: |
      grep -rnE 'facilitator.*(verify|settle)|payai|/verify|/settle|X402_CONFIG.facilitator' src/payments src/client 2>/dev/null | head -20 || echo NO_SUBMIT
      grep -rn 'facilitator.payai\|facilitator.corbits' src/ --include=*.ts 2>/dev/null | grep -v test | wc -l
    pass_when: >
      The submit path posts the signed authorization to the configured
      facilitator and reads X402_CONFIG.facilitator (the single declared
      literal count stays 1, no per-call-site host). Agent judges.
  - id: mcp-cli-settle-parity
    description: "MCP and CLI paid execute both reach one shared Flex authorize+submit+retry path; 6ef1fed9 gate + 146/0 intact"
    source_ids: [code:src/mcp.ts#L1058, code:src/client/index.ts#L642]
    bench_signal: |
      grep -rnE 'serializePaymentAuthorization|flexAuthorize|handleFlexSettle' src/mcp.ts src/client/index.ts 2>/dev/null | head
      bun test tests/payment-wiring.test.ts tests/lobster-payments.test.ts tests/mcp-x402.test.ts tests/payment-gate.test.ts 2>&1 | grep -E '[0-9]+ (pass|fail)' | tail -1
    pass_when: >
      Both src/mcp.ts and src/client/index.ts reach the same shared Flex
      settle function (parity), and the prior payment/auth suite stays
      green (no regression, gate semantics from 6ef1fed9 unchanged).
  - id: no-mock-echo-falsifier
    description: "settle path exercised no-mock against x402.payai.network instant-refund echo: 402 -> settled+retried"
    source_ids: [faremeter:payai#facilitator, faremeter:flex-quickstart#authorize]
    bench_signal: |
      ls tests/flex-settlement-echo*.test.ts 2>/dev/null || echo NO_ECHO_TEST
      grep -rn 'x402.payai.network' tests/ src/ 2>/dev/null | head
      bun test tests/flex-settlement-echo.test.ts 2>&1 | tail -15 || true
    pass_when: >
      A no-mock test hits the real x402.payai.network echo, drives a 402
      through the full authorize+submit+retry, and asserts a settled
      success (instant-refunded). Agent judges the real round-trip, not a
      stubbed 200.
out_of_scope:
  - on-chain-flex-anchor-program-internals
  - payai-facilitator-service-itself
  - computeFlexSplits-math-change
  - gate-semantics-change-from-6ef1fed9
  - kuri-zig
adversarial:
  - escrow-funding-headless-limit
```
