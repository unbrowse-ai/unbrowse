# Flex Settlement - Wave 1 Hand-off

Branch: jl/unbrowse-flex-settlement-w1 (baseline 959ec8cb, carries shipped 6ef1fed9 gate).
Status: HOLD. Do NOT merge to main, do NOT push. Cherry-pick the listed commits.

## Jesus-loop verdict

Sabbath (step 7) and Emergence (step 9): HOLD, not PROMOTE. No SHIPPED emitted.
6 of 7 acceptance lanes converged and were verified GREEN. AC7 (the headline
behavioral proof) is honestly RED because it is impossible to prove headless.

## Deliverable commits (cherry-pick these)

- 56538f0f feat(flex-pay): seed settleViaFlex + failing-first no-mock tests
- f83b0d43 test(flex-pay): harden Step-4 luminaries into true falsifiers
- 71922c3f feat(flex-pay): real settleViaFlex seam, CLI+MCP 402 funnel before fallback
- c5129946 refactor(flex-pay): John 15:2 prune dead isFlexAvailable + kill test:36 tautology

Plus the reproducible evidence bundle committed with this hand-off:
.evidence-build/unbrowse-flex-settlement/ and scripts/unbrowse-flex-settlement-evidence-bench.sh

## Verified GREEN this Sabbath (evidence, not narration)

- AC4 splits-from-frozen: backend/src/services/flex.ts diff vs 959ec8cb = ZERO lines. computeFlexSplits math untouched, splits read verbatim from the 402 terms by topology.
- AC6 mcp-cli-settle-parity: MCP src/mcp.ts:1062 AND CLI src/client/index.ts:642 both reach the ONE shared src/payments/flex-pay.ts::settleViaFlex before fallback.
- 6ef1fed9 account-or-x402 gate code byte-unchanged (src/payments/index.ts diff 0 lines). Semantics intact.
- Named payment/auth suite green, no regression (stash-isolation: baseline 5p/3f -> impl 7p/1f, the surviving RED is the declared adversarial_held, not a regression).
- Criteria validator: 7/7 lanes cite valid source_ids.
- Substrate-clean: no facilitator literal (declared X402_CONFIG only), no host=== branch, no em dash. A real CLAUDE.md case-study #6 tautology at test:36 was found and replaced with a mutation-proven falsifier.

## The single human-gated step (HOLD -> SHIPPED)

AC7 no-mock-echo-falsifier cannot be proven by any headless agent. flex-pay.ts
returns null until a real provisioned escrow exists (resolveFlexWallet at
src/payments/flex-pay.ts:39-45 requires FLEX_ESCROW_ADDRESS + session key).

To convert HOLD to SHIPPED, a human must:

1. Fund a Solana Flex escrow and register the Ed25519 session key via the
   hosted PayAI approval URL (facilitator from declared config
   UNBROWSE_X402_FACILITATOR, default https://facilitator.payai.network).
2. Export FLEX_ESCROW_ADDRESS + the session key, set FLEX_SETTLEMENT_LIVE=1.
3. Run the retained no-mock echo falsifier against x402.payai.network and
   confirm a settled+retried success on BOTH MCP and CLI through the one
   shared settleViaFlex path.
4. If green: re-fire the loop; it then promotes truthfully.

Until step 1 is done, SHIPPED would be a painted-lamp false-green and is
deliberately withheld per the /falsifier-gated-build discipline.

## Non-goals honored

computeFlexSplits math unchanged. 6ef1fed9 gate semantics unchanged. Named
payment/auth suite not regressed. No per-domain heuristics. No hardcoded
facilitator literal. No on-chain Anchor internals, no facilitator-service
changes, no kuri-zig touched.
