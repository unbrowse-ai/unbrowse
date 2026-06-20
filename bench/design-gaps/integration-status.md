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

## Update (amen: escape hatches removed, behavior committed)
- FLAG REMOVED: UNBROWSE_KEY_WALLET_SETTLE deleted (grep=0); the sponsor-escrow "wallet-settle"
  hack (which made the PLATFORM pay) deleted — no sendSponsorFlexPayment path for wallet-keys.
- G5 now REAL + flagless (custody-safe prepaid): wallet deposits via POST /v1/account/keys/:id/deposit
  (owner-auth + x402, signs once) → balance_uc; key spends balance per call (always-on debit); empty → 402.
  NOTE: deposited USDC is held in the platform treasury as the key's prepaid balance (custodial-prepaid
  model) — the platform never holds the user's wallet KEY, but it does custody the deposited balance.
- G1/G2/G3 now REAL: resolve shortlist is energy-ORDERED; no-quorum returns actionable escalate→browse.
- All on staging (1495 pass / 37 baseline). OPEN (user-gated): prod deploy + staging→main re-merge.
