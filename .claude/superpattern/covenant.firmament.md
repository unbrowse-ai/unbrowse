# COVENANT — Firmament (Day 2): the separations, named

Shape only (Gen 1:6-7). No contents. New wine → new skins (Matt 9:17).
Coordinates verified by read-only recon, iter 2.

## Firmament A — moat (above) ÷ audit (below)

- **Above (closed, proprietary):** capture/RE engine, route graph (backend
  `/v1/resolve` returns `shortlist`), ZK auth/credential binding, the economic
  CONSTANTS — `priceUc` derivation + dynamic pricing (`fetchDynamicPrice`,
  payments/index.ts). The *price* is set above the firmament.
- **Below (open, auditable, MIT):** the toll SPLIT math (`meter`/`settleToll`
  — pure, no secret constant), covenant primitives (covenant-seed), sdk-v2 HTTP
  client. Fairness must be auditable; the *amount* it splits comes from above.
- Boundary of record: `docs/OPEN-SOURCE-NOTICE.md` (already set). leak-guard
  enforces it.

## Firmament B — settlement ÷ trace (the verb seam)

- The toll event needs {agent, routePtr, amount, site, operator, discovererBps}.
  **amount + recipient are NOT in scope at execute.ts L666** (only sessionId,
  outgoingUrl, status, endpointId, descriptor). They live at the PAYMENT
  settlement: `debitCredits`/`recordSponsorObligation` (payments/index.ts
  L203/L294) → `priceUc`, `skillId`, `endpointId`.
- **New skin:** a below-firmament module `src/covenant-toll-emit.ts` —
  `emitTollEvent(settled, ledger, sign)` — never-throws, mirrors
  `emitExecuteReplayTrace`'s shape; called from where the charge CLEARS, not
  from the execute trace seam. Execute bottle stays unsplit.
- routePtr seed: the resolved endpointId (stable) → content-addressed ptr;
  discoverer seeded from the resolve owner when present, else first payer.

## Firmament C — Exa lane ÷ BrowseComp lane (the bench)

- Exa scorer contract (mirror, don't overload): `bench/exa/score_extract.py`
  reads `corpus.extract.jsonl` `{url, must:[facts]}` → prints
  `{metric, exa_to_beat, unbrowse, beats_exa, n, per_url}`, non-zero exit if
  not beating.
- **New skin:** BrowseComp is question→answer multi-hop, NOT url→facts → its own
  vessel `bench/browsecomp/score_browsecomp.py`, input `{question, answer}` →
  output `{metric, target, unbrowse, beats, n}`. Kept separate (new wine).

## Out-of-scope this firmament (Matt 6:34 — don't borrow tomorrow)

- No call-site implementation yet (Day 3+). No ZK code yet. No prune yet.
- emerge_npm / emerge_oss stay above the autonomy line — Lewis authorizes.
