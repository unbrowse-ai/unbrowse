# plan-thin-client.md — make the public client thin so there's no moat to scrub

## Why "force-push to clean up" can't come first (proven)
The transitive import closure starting from the public client entrypoints
(`src/sdk`, `src/client`, `src/cli`, `src/mcp`) pulls in the **entire engine** —
`reverse-engineer`, `graph`, `ranking`, `capture`, `execution`, `indexer`,
`marketplace`, `orchestrator`, `extraction`, `api` (10 engine dirs, 33 of ~43 total).
The client is **architecturally fused** to the engine: you cannot delete the moat and
keep a working client. So a scrub/force-push now either breaks the repo or reduces it
to docs+shims. **The cleanup is the LAST step, after the client is decoupled.**

## Goal (settle condition)
The public client is **thin**: its import closure contains **zero moat-engine modules**.
The intelligence (RE inference, indexing/admission, graph compilation, ranking) runs
**server-side** over a **ZK/obfuscated egress** — the server sees structure (methods,
URL shapes, param keys, schemas), never secret values, so "credentials never leave the
machine" holds. Once the closure is engine-free, the public repo carries no moat and the
cleanup is trivial + safe.

## The witness (pinned `check`)
```
bash scripts/thin-client-gate.sh
```
Computes the engine-module count in the client's transitive import closure. **RED while
> 0; GREEN at 0.** Today: 10. Each checkpoint that moves a module server-side and rewires
the client to the API drops the count. The number can't be faked — it's the real import graph.

## Hard constraints
- `capture` (CDP observe), `execution` (replay), `values`/`auth`/wallet **stay client** —
  they touch the live browser + local secrets. They are NOT moat (drive-a-browser /
  make-a-call / sign-with-my-key); they just must not appear in the *intelligence* closure.
- No raw secret bytes cross the wire — the client ZK/obfuscates capture **before** egress
  (`src/capture/obfuscate.ts`, `zk-bound-hole.ts` already exist). Every checkpoint ships a
  test proving zero secret values leave.
- The big local functions may remain as a **degraded offline fallback** (the ranking
  pattern) — but the client's *primary* path calls the server, and the fallback must not
  re-introduce an engine import into the thin closure (keep fallbacks behind a lazy import
  or move them out of the entrypoint closure).

## Template (proven by `ranking`)
`xServerFirst()` → `xRemote()` POSTs ZK/obfuscated input to `/v1/…` → server runs the
intelligence (private `backend/src/services/*`, a PORT not a `../src` import) → returns
result; local fallback on failure. Backend route mirrors `backend/src/routes/search.ts`.

## Checkpoints (each drops the engine-in-closure count)
- [x] **ranking** — DONE: server-first via `/v1/search/rank`; backend port is private.
- [ ] **① reverse-engineer → `/v1/reveng`** — client obfuscates capture locally
  (`obfuscateCaptureForReveng`) → POST → server runs `extractEndpoints`. The obfuscated
  `/reveng` route already exists; wire the client capture/index path to it server-first +
  no-secret-leak test. Remove RE from the client entrypoint closure.
- [ ] **② indexer → `/v1/index/admit`** — move admission/scoring server-side; the local
  queue + disk cache stay client but must not import the engine. Leans on ① and ③.
- [ ] **③ graph → `/v1/graph/compile`** — graph *learning* (edges/confidence/chain) is
  already server-side + client calls it; finish by moving the structural compile so the
  client no longer imports `src/graph` in its primary path (keep a thin DAG-walk client).
- [ ] **port-not-import** — for each, the backend service is a **private port** in
  `backend/src/services/`, NOT `import … from "../../../src/<engine>"` — else the code is
  still in the public bundle. (Audit: `backend/src/routes/reveng.ts` currently imports
  from `../src` — porting it is part of ①.)
- [ ] **settle** — `bash scripts/thin-client-gate.sh` → 0 engine modules in the client
  closure. THEN the cleanup is safe.

## Final step — the cleanup (only after the gate is GREEN)
With the client thin (closure engine-free), the public repo carries no moat. Then:
update `OPEN-SOURCE-NOTICE.md` to the thin-client reality, and either leave the thin
client fully open (it's auditable, no moat) or `git filter-repo` any now-orphaned engine
code out of history + force-push (innocuous message, verify clean). At that point the
scrub is trivial because nothing depends on what's removed.

## Sequencing
`reverse-engineer → indexer → graph` (RE first: its obfuscated route + client obfuscator
already exist, so it's the closest to done and the most security-sensitive — get it right
as the template for the ZK egress contract). Dev-only plan; never `docs/`.
