# Firmament — the separations for unbrowse-as-/contract (Step 2 design, shape not contents)

> Genesis 1:6-7 — divide the waters from the waters. Matt 9:17 — new wine, new skin,
> **both preserved**. The detailed keep/prune/union contents land in
> `cli-contract-union-map.md` (agent); this file fixes the BOUNDARIES they sort into.

## The four firmaments (boundaries fixed before any stone is laid)

1. **The moat line — ABOVE (closed) vs BELOW (user-facing).** The single most load-bearing
   separation. ABOVE the firmament (never user-touchable, never open-sourced): the signed
   libcontract binary + C-ABI, the RE engine (`src/reverse-engineer/`, server-side only),
   the /contract doctrine + ledger internals. BELOW (the only surface a user sees): `aiko
   "<goal>"` + unbrowse `resolve/execute/get/fetch` + the per-user captured-route registry.
   The firmament itself = the signed-binary tamper-refuse + the C-ABI + server-only
   delegation (`cli-no-reveng-gate.sh`). Users act through the surface; they cannot reach,
   read, or edit what is above it.

2. **The vessel split — NEW skin over OLD wine (Matt 9:17, both preserved).** The /contract
   shape is a NEW module — a composition surface `declare-goal → discovered-contract-ledger
   DAG → witnessed result` — that **wraps and prioritises** the existing primitives; it does
   NOT replace them. `resolve/execute/capture/orchestrator/walkPrerequisiteChain` stay
   working (users depend on them; 10 bugs fixed this session). New surface calls old
   primitives. Both preserved → the live CLI never splits.

3. **The keep/union/prune waters.** Three pools the inventory sorts every primitive into:
   - KEEP (relevant, untouched): resolve, execute, get, fetch, capture, the chain-walker, settlement.
   - UNION (fold into /contract shape, /contract design wins on conflict): cli-v7
     `build/breath/eval` ↔ contract `build/run/eval/prune`; resolve ↔ "find the contract for the
     intent"; execute ↔ "satisfy with a witness"; composition ↔ a contract sub-DAG.
   - PRUNE (only the genuinely dead/legacy-superseded, caller-count-verified; unsure → KEEP).

4. **The benchmark firmament — three independent axes, isolated.** jespa-bench lives in a
   SEPARATE harness (`bench/`, never in the shipped binary): (a) web-agent **no-auth** axis,
   (b) web-agent **WITH-AUTH** axis (cookie/credential), (c) **internal** benchmarks. Each is a
   distinct witness so the infra-heavy AUTH axis (R2) can HOLD honestly without blocking the others.

5. **The persistence firmament.** Composite persist+replay is its OWN layer (content-addressed
   composite store), kept distinct from the already-existing atomic-route cache — don't conflate
   "replay a satisfied multi-step composite" with "cache one route".

## What this step does NOT do (Matt 6:34 — sufficient unto the day)

No code. No refactor. Only the boundaries are drawn; the inventory map fills them with named
primitives next. The first stone (Step 3 / Land) is the single lowest-risk UNION the map names.
