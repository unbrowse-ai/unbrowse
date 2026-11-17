---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
updated: 2026-10-30
external_references:
  - path: <checkout>/papers/protocol.md
    why: Numbered protocol requirements (R2, R3, R6, R7) read as claims to test.
  - path: <checkout>/papers/economy.md
    why: Fee rail, split, bond, withholding, vesting, burn, read as claims to test.
  - path: AGENTS.md, CLAUDE.md (repo root)
    why: Network rules ("one owner is one source", standing from the registry); fixes stated as properties.
  - path: <checkout>/autofetch (branch autonomous-fetch, PR #53)
    why: The no-approval spending path; read as a lead by the wildcard focus.
---

# Property relationships

Clusters share a code path or failure mechanism. "→" marks a suspected dominance: the left property's failure produces the right one's.

## 1. Withholding books USDC as UNB
- `settlement-unb-covers-every-bond` and `settlement-usdc-equals-its-liabilities` share one root cause (`LeanSettlement.sol:694-699`). One fix, either a real swap or keeping withheld USDC as USDC, closes both.

## 2. Who gets paid for serving
- `serving-share-pays-the-node-that-served` ← `holding-on-chain-converges-to-held-json`. Today holding is the only way to be paid, and holding drifts.
- `delisted-or-underpaid-body-never-released`, `a-server-never-releases-a-body-for-less-than-its-current-fee` and `auto-pricing-moves-the-fee-once-per-epoch` all depend on fee reads at serve time.

## 3. The cap and the line
- `no-passed-line-past-the-cap` → `one-unpayable-line-never-blocks-the-rest`. One poison line blocks the whole batch.
- `cap-is-checked-before-the-site-is-called` → `a-kept-body-was-paid-for`. The cap refusal is one of the three ways a body is kept unpaid.
- `receipt-ledger-never-shrinks` → `no-passed-line-past-the-cap` and `each-line-is-paid-at-most-once`. A wiped file restarts the indexes and drops pending lines from the cap count.
- `passed-lines-are-claimed-within-their-window` ← `background-pass-completes-after-chain-faults-stop`, `claim-loop-runs-while-off-the-peer-network` and `vesting-stays-withdrawable` (the other end of the money).

## 4. What a caller runs
- `network-write-never-auto-run-for-a-read-intent` and `a-state-change-is-never-classified-a-read-by-its-endpoint-name` together decide whether a write runs unasked. The second is the label the first relies on.
- `caller-runs-only-the-signed-body` ⊇ `served-body-matches-signed-content-id`. Merge these when writing the workload.
- `a-shared-body-never-reaches-a-host-off-its-site-nor-a-private-address`: what the signed body may do once it runs.
- `a-delisted-or-superseded-route-is-not-run-from-cache` and `lookup-keeps-newest-listing-version`: the kill switch and versioning.

## 5. Admission and discovery
- `admission-recovers-after-registry-stall`, `too-old-peer-never-counts` and `nodes-booting-together-find-each-other` → `checked-lookup-spans-two-identities`. Every admission defect weakens the checked signal.
- `listings-answering-survives-a-stuck-answer` and `listings-answer-fits-its-bound` → `checked-lookup-spans-two-identities`. A silent provider stops counting as a source.
- `two-distinct-identities-is-only-as-strong-as-registration-is-costly` bounds `checked-lookup-spans-two-identities` from above.
- `node-on-network-after-first-publish-fails` and `boot-failures-heal-without-restart` overlap (one-shot boot). Implement them as one eventually-check.

## 6. Chain writes from one owner key
- `owner-key-writes-never-share-a-nonce` → `one-erc8004-identity-per-owner`, `holding-on-chain-converges-to-held-json`, `auto-pricing-moves-the-fee-once-per-epoch` and `node-on-network-after-first-publish-fails`. A nonce collision is the shared trigger.
- `background-pass-completes-after-chain-faults-stop` → everything in cluster 3. Missing RPC timeouts are the shared trigger.

## Unattached
- `entry-dark-only-when-providers-served-nothing`, `light-mode-answers-no-queries-on-any-protocol`, `table-role-follows-reachability`, `kept-manifest-pair-never-lowers-min-version`, `body-voucher-releases-one-body`, `the-per-fetch-maximum-bounds-the-same-currency-the-fee-is-in`.
