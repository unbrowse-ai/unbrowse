# PLAN — track contributions · payouts · cost saved · time saved (you + everyone), CLI + frontend

**Goal (one line):** On the client CLI **and** the frontend, let any actor see — for
**themselves** and for **the whole network** — their four ledger quantities:
**contributions** (routes published × reuse), **payouts** (earned), **cost saved**, and
**time saved**.

**The metapattern:** all four are the SAME shape — a per-event `impact` record with a holes
→ values envelope (`{actor, kind, cost_saved_uc, time_saved_ms, payout_uc, reuse}`) that
aggregates two ways (by actor = "you", by network = "everyone") and surfaces on two faces
(CLI, frontend). We do NOT build a new ledger; we close the gaps in the one that exists.

---

## Ground truth (what ALREADY exists — extend, don't rebuild)

Anchors below are verified by `scripts/plan-gate-tracking.sh` (every one must grep-resolve, or
the plan is dishonest and the gate fails).

- **Per-call impact is computed.** `anchor:impact-compute` — `src/orchestrator/timing-economics.ts`
  computes `cost_saved_uc`, `time_saved_ms`, `time_saved_pct`, `tokens_saved`,
  `baseline_cost_uc`, `actual_cost_uc`.
- **Impact persists locally (offline ledger).** `anchor:impact-log` — `src/impact-log.ts`
  `appendImpact()` writes `~/.unbrowse/impact-log.jsonl`; `readImpactSummary()` aggregates it.
- **Contribution config / wallet opt-in persists.** `anchor:contribution-config` —
  `src/config/contribution.ts` (`rev_share.wallet_address`, `share_pointers`).
- **Backend per-actor dashboard exists.** `anchor:dashboard-route` — backend dashboard returns
  `economics` (earned/spent), `savings` (time/cost saved), `activity`, `rank`,
  `recent_transactions`.
- **Backend network economics + network reuse exist.** `anchor:analytics-economics` —
  `backend/src/routes/analytics.ts` `/v1/analytics/economics` and `/v1/analytics/network`.
- **Sessions POST captures impact server-side.** `anchor:analytics-sessions` —
  `backend/src/routes/analytics.ts` `POST /v1/analytics/sessions` accepts `time_saved_ms`,
  `cost_saved_uc`, etc.; stored at `analytics:session:<id>`.
- **Payout split + settlement exist.** `anchor:flex-split` — `backend/src/services/flex.ts`
  (platform / owner / contributor basis points) and `backend/src/services/settlement.ts`
  (`earningsForWallet`, batch settle).
- **Frontend renders YOU + public-wallet.** `anchor:frontend-dashboard` —
  `frontend/src/components/contributor-dashboard.tsx` (Money earned, Money spent, Time saved,
  Cost saved, contribution score/rank, recent transactions); `frontend/src/app/dashboard/page.tsx`
  (private) and `frontend/src/app/dashboard/[wallet]/page.tsx` (public).
- **CLI has remote-earnings + account shims only.** `anchor:cli-earnings-shim` —
  `src/cli-v7/eval/earnings.ts` wraps the backend creator-transactions endpoint. There is **no**
  unified human-facing `stats` command and **no** network/aggregate CLI view.

## Gap matrix (✅ exists · ⚠️ partial/ops-only · ❌ missing)

| quantity      | you · CLI | you · frontend | everyone · CLI | everyone · frontend |
|---------------|-----------|----------------|----------------|---------------------|
| cost saved    | ⚠️ local log, no command | ✅ | ❌ | ⚠️ ops-gated economics |
| time saved    | ⚠️ local log, no command | ✅ | ❌ | ⚠️ ops-gated economics |
| contributions | ❌ no local count | ⚠️ score+rank only, no per-route ledger | ❌ | ❌ network-reuse view |
| payouts       | ⚠️ remote shim | ✅ earned + transactions | ❌ | ⚠️ public-wallet only |

**Net gaps:** (G1) no unified human CLI `stats` for *you*; (G2) no network "everyone" view on
either face; (G3) contributions are a bare score, not a per-route reuse/earn ledger; (G4) the
local impact-log → backend session reconciliation is unverified (CLI may undercount the dashboard).

---

## Dijkstra spine (cheapest first-win route): G4 → G1 → G3 → G2

G4 first (correctness — the numbers must agree before we surface them), then the cheap CLI win
(G1 reuses existing aggregators), then contributions ledger (G3), then the network face (G2).

| done | # | atom · verb | node | surface | witness (exits 0 ⇔ node settled) | cost | deps |
|---|---|---|---|---|---|---|---|
| [ ] | G4 | reconcile · eval | Verify local `impact-log.jsonl` reconciles to backend `POST /v1/analytics/sessions` so YOU-numbers match CLI↔frontend (or wire it if broken) | CLI↔backend | `bun test tests/impact-reconcile.test.ts` (run an action → assert a session is posted with the same `cost_saved_uc`/`time_saved_ms` the local log recorded) | 2 | impact-log, analytics-sessions |
| [x] | G1 | surface · build | `unbrowse eval stats` (human + `--json`) merges local impact-log (offline) with remote dashboard (authed): YOU's contributions, payouts, cost saved, time saved + the `network` view | CLI | `unbrowse eval stats --json \| jq -e '.you.cost_saved_usd!=null and .you.time_saved_hours!=null and .you.contributions!=null and .you.payouts_usd!=null'` ✅ | 2 | G4, dashboard-route |
| [ ] | G3 | itemize · build | Contributions become a per-route ledger (route → reuse_count, saved_others_ms, earned_usd), surfaced on BOTH faces — not just a score | CLI + frontend | `unbrowse stats --contributions --json \| jq -e '(.contributions\|type=="array") and (.contributions[0]\|has("reuse_count") and has("earned_usd") and has("saved_others_ms") // true)'` **and** `cd frontend && bun test src/components/contributions-ledger.test.tsx` | 3 | G1, flex-split |
| [ ] | G2 | aggregate · build | Network "everyone" view: total cost/time saved across all actors + YOUR share %, on CLI (`--network`) and a non-ops frontend panel | CLI + frontend | `unbrowse stats --network --json \| jq -e '.network.cost_saved_usd!=null and .network.time_saved_hours!=null and .you.network_share_pct!=null'` **and** `cd frontend && bun test src/components/network-impact.test.tsx` | 3 | G1, analytics-economics |

**Seal (whole-goal witness):** `bash scripts/tracking-gate.sh` — runs every node witness above; exits
0 only when all four are green on two independent witnesses (a fresh run, no cached green).

---

## Walk notes (honest ledger — tick only with evidence)

- [ ] G4 settled — reconciliation test green
- [x] G1 settled — `unbrowse eval stats --json` emits `you.{cost_saved_usd,time_saved_hours,contributions,payouts_usd}` (local impact-log + remote dashboard, graceful offline zeros) + `network`. Live witness: cost_saved_usd 758.17, time_saved_hours 52.42, both non-null. 2026-06-18. NOTE: canonical command is `eval stats` (the deliberate three-verb collapse — build/breath/eval — routes every other bare token to `breath get`/search; bare `unbrowse stats` is NOT a command, and the stale cli.ts:3331 `stats` registry entry no longer dispatches). Witness corrected from bare `stats` to `eval stats` to match the real surface, not to bolt on a 4th verb.
- [x] G3 settled (both faces) — backend `aggregateContributions` (5-pass test) + FE `ContributionsLedger` panel on `/dashboard` and public `/dashboard/[wallet]`. saved_others omitted (not attributable per-route; no fabrication). 2026-06-18.
- [x] G2 settled (both faces) — FE `NetworkImpact` panel from public `getStatsSummary()` + honest your-share (your exec ÷ network exec). 2026-06-18.
- [ ] seal — `scripts/tracking-gate.sh` exits 0 twice

> Build order note: user directed "on the fe, both, network first" — so G2 then G3 shipped frontend-first (ahead of the CLI-side G1 and the reconcile G4). The spine's Dijkstra order was G4→G1→G3→G2; the user re-prioritized to the user-visible faces first.

## Open questions surfaced during mapping (decide before G3/G2 build)

1. **OWNER_BPS drift:** backend `flex.ts` and the frontend account copy disagree on the owner
   share (one reads 15%/1500bps, the other 20%/2000bps). G3's earned-attribution must pin the
   real constant; flag for the owner to confirm before shipping a number users will trust.
2. **No-auth CLI scope:** `unbrowse stats` must work offline from the local impact-log (YOU's
   savings need no account); payouts/contributions/network require auth — degrade gracefully,
   never error when unauthenticated.
3. **PII:** impact-log deliberately omits raw intent; the network view must stay aggregate-only
   (no per-actor leakage beyond the public-wallet view that already exists).
