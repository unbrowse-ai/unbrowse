# Integration status (Step 7 verdict)

| Gap | Built+Tested | Documented | Live-wired | Needs human go |
|-----|:---:|:---:|:---:|---|
| G1/G2 energy (energyScore) | ✓ | ✓ | ✗ — discovery.ts still uses rrfFuse | no (behavior change → review) |
| G3 settle (settleOrEscalate) | ✓ | ✓ | ✗ — resolve returns flat shortlist | no (review) |
| G4 declare-on-resolve | ✗ | — | ✗ | no (small fire-and-forget) |
| G5 api-key→wallet ADMISSION | ✓ (audited admission-only) | ✓ | ✗ | — |
| G5 api-key→wallet SETTLEMENT | ✗ | ✓ (as next step) | ✗ | **YES — fund movement** |
| G6 docs (x402 API + energy) | — | ✓ leak-clean | n/a | no |

**Proven-in-isolation, NOT on the live path:** energyScore, settleOrEscalate, admitPayment.
The live wiring (route discovery.ts ranking through energy→settle; call admitPayment in the
execute lane) is a reviewed follow-up. The wallet-SETTLEMENT (sign+settle from a key-bound
wallet) is fund movement and is flagged for explicit authorization — never auto-shipped.
