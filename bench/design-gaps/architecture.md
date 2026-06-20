# Design separations — the firmament (Step 2)

> Shape only, not contents. Divides the waters: public WHAT above, moat HOW below;
> resolution apart from settlement; two payment lanes into one boundary.

## The ideal (from /lewis-strategy + aiko contract substrate)
`energy = -score`; `attention = softmax(-energy/T)`; ties → canonical order. The scalar energy is a
**fusion of independent uncorrelated witnesses**, and selection only *settles* at a two-witness
quorum (else **escalate to parent**, bounded ~7 ticks). aiko logs this per call as an `iterated`
contract row `{energy_a, energy_b, agree, cohered, contract_ok}`, soft-gated (record, never block);
verdict source is chosen by call class (echo/retrieval → coverage; orthogonal → declared postcond).

## The firmament (interfaces — the new skins for the new wine)
```
ABOVE (public WHAT — documentable)
  intent ─► energy(intent, route) ─► softmax(-E/T) attention ─► ranked shortlist
                                              │
                                   settleOrEscalate (2-witness quorum, bounded-7 → fall to browse)
                                              │ settled
                                   x402 settlement ─► admitPayment( wallet  OR  api-key→wallet )
── firmament: the energy() · settleOrEscalate() · admitPayment() · declareResolution() interfaces ──
BELOW (moat HOW — never documented)
  evidence-routed fusion, rank.ts signals/weights, RRF internals, coherence bases, capture engine
```

## Separations (layers/modules — shape, not contents)
1. **`services/energy.ts` (NEW)** — `energyScore(intent, candidate, evidence) → {energy, witnesses:[a,b], agree}`.
   The unified PUBLIC surface ("energy"); wraps today's RRF+`rank.ts` as the *proxy* energy. Per the
   corpus: "the correct calling surface — a trained `E(intent,route)` can replace the proxy later
   without changing the interface." Internals (weights/signals) stay below the firmament = moat.
2. **`services/settle.ts` (NEW)** — `settleOrEscalate(candidates) → {settled|null, escalate}`. The
   apophenia/coherence gate RRF lacks: two-witness quorum + bounded loop → escalate (browse) instead
   of returning a non-covering top result. This is the abstention layer.
3. **`middleware/payment-admission.ts` (NEW; unifies sponsor.ts lanes)** — `admitPayment(c) →
   {admitted, payerWallet, lane}`. ONE boundary accepting wallet-signed x402 OR api-key (whose bound
   wallet via `setKeyFunding` pays). "api_key wraps wallet" makes both lanes resolve to *a wallet pays*.
4. **resolve path → `declareResolution()` hook** — append a `declared`/`iterated` contract-ledger row
   carrying the energy reading + verdict, so resolve is contract-DECLARED, not just contract-shaped.
5. **`docs/concepts/energy-ranking.md` (NEW)** — public explainer: energy-ordered contract resolution
   (the WHAT). Names energy/attention/settlement; never the signals or weights.
6. **`docs/api/x402.md` (NEW)** — x402 API reference: endpoints, the `accepts[]` `X402PaymentRequirementV2`
   envelope, and the dual wallet-OR-apikey payment flow.
7. **`paper/anchors.tsv` + gates** — every `[shipped]` doc claim → a code anchor (`paper-gate`); every
   doc passes `leak-guard` (no economic constant / capture-engine internal / operator surface).

## Boundary discipline (Matt 6:34 — no borrowed tomorrow)
- Do NOT retrain a real EBLLM cross-encoder now — only introduce the `energy()` interface over the
  proxy. The trained model is a later step behind the same interface.
- Do NOT rewrite RRF/`rank.ts` internals — wrap, don't replace.
- Do NOT touch settlement money-flags — `admitPayment` is admission/proof only.
