# Clock-as-stdin — time becomes a platform event

**Status**: ⚠️ **SUPERSEDED by [`runpod-bound-contract-vm.md`](./runpod-bound-contract-vm.md).**

The cron-walker shape proposed below was an antipattern. A central
Cloudflare Triggers walker polling the ledger for due rows is literally
cron — a meta-service operating ON the DAG instead of a neuron IN it.
the platform's whole point is "no external operators above the graph";
this design violated that. Kept in the repo for provenance; do not
implement.

The canonical replacement: every contract that needs time-based firing
gets its own Runpod pod whose own `sleep()` IS the clock. See the
canonical doc.

---

## Why this exists

Today the orchestrator (Claude Code, Codex, the runtime that hosts the
contract platform) is *reactive*. Its input channels are:

- Human messages
- Tool results
- `Monitor` stdout (event-driven background tasks)
- System reminders

Time itself is NOT a channel. There's no "8am ticked" event piped into the
agent. That's why the agent can't proactively wish you good morning at 8am —
nothing wakes it.

The fix is to make wall-clock time a contract-shaped event. A contract that
declares `at:<RFC3339-timestamp>` as a synapse kind fires its posthook when
the platform's clock-tick walker observes `now() >= at:` for the first time.

## Reality parallel — circadian clock genes

In every mammalian cell, `PER` and `CRY` proteins oscillate on a ~24h cycle
driven by transcription/translation feedback loops. Downstream neurons fire
when this molecular oscillator hits a phase threshold. **Time becomes a
synaptic input.**

the platform mirrors that: instead of an external scheduler poking the
agent, the agent's own declared contracts say "fire me at this timestamp",
and a server-side walker (the platform's circadian gene) fires them.

## Public shape — no new caller verb

Consistent with the contract platform's "no caller-visible options" rule,
the `at:` form is just another synapse kind on the declared row, parsed by
the existing synapse extractor:

```bash
aiko "wish lewis good morning at:2026-05-26T08:00:00Z+0800 posthook:contract:lewis-wakeup-bot" --remote
```

The plan text is what the agent declares. The two synapses (`at:` and
`posthook:`) tell the platform WHEN and WHO to fire.

## Wire shape

`SynapseKind` gets one new variant:

```zig
.at,                          // at:<RFC3339-timestamp> — wall-clock threshold
```

Server-side ledger row:

```jsonc
{
  "event": "declared",
  "id": "abc12345",
  "plan": "wish lewis good morning",
  "action": "neuron",
  "synapses": [
    { "to": "2026-05-26T08:00:00+0800", "kind": "at" },
    { "to": "contract:lewis-wakeup-bot", "kind": "posthook" }
  ],
  "ts": "2026-05-25T20:00:00Z"
}
```

## Server-side clock-tick walker

A new cron-like Worker triggered by Cloudflare Triggers `*/5 * * * *` (every
5 minutes) does:

```ts
const due = await ledger.findAtSynapsesDueBefore(now());
for (const row of due) {
  if (alreadyFired(row.id)) continue;          // idempotency — at: fires once
  const posthook = row.synapses.find((s) => s.kind === "posthook");
  if (!posthook) continue;
  await firePosthook(row, posthook.to);
  await ledger.append({
    event: "iterated",
    id: row.id,
    wave: 1,
    action_result: "fired-by-clock",
    ts: now().toISOString(),
  });
}
```

Idempotency: an `at:` synapse fires exactly once. The walker checks for an
existing `iterated` row with `action_result="fired-by-clock"` before firing.

## Why every 5 minutes, not realtime

Cloudflare Workers don't have arbitrary-precision schedulers — the smallest
cron tick is 1 minute, the smallest Triggers interval that scales is 5
minutes. For wake-up reminders, 5-minute granularity is plenty (no human
notices the difference between 8:00 and 8:04 for a "good morning"). Sub-
minute-precision wake events would need a Durable Object timer, which is
more expensive; defer that until a use case demands it.

## Repeat semantics — recurring contracts

A contract can carry `at:` AND `repeat:<cron-expr>` together for recurring
wake events:

```bash
aiko "daily traction snapshot at:2026-05-26T09:00:00+0800 repeat:0 9 * * * posthook:contract:traction-snap" --remote
```

The walker fires the posthook every time the cron expression matches, with
its own idempotency window (the (`id`, `cron-tick-instant`) pair). Not in
v1 — file as a follow-up after `at:` ships and stabilizes.

## Token economics

Each clock-fire = one synthetic `iterated` row + one posthook HTTP request.
At 1000 active `at:` contracts firing simultaneously at 8am, that's 1000
HTTP requests over 5 minutes — well within CF Worker's free tier and
Solana mainnet's x402 settlement throughput.

## Privacy

`at:` synapses are visible to the calling pubkey only (same lineage
visibility rule from #796). The walker runs server-side with admin
credentials; it can read everything, but its outputs (the posthook fires)
go only to the destination declared on the row.

## Open questions for Lewis

1. **Granularity** — is 5-minute precision OK, or do we need <1-min? (If <1-min, switch from Triggers to Durable Object timers, ~30 extra LOC + per-DO billing.)
2. **Time zones** — `at:` is RFC3339 with explicit offset. Should the platform also accept named-tz timestamps like `at:2026-05-26T08:00:00 America/Los_Angeles`? (Adds tz database dependency; recommend stay strict ISO and let the client compute the offset.)
3. **Backoff on repeat** — if a recurring fire fails (posthook target returns 5xx), do we retry? Recommend: log + drop, surface as `action_result="posthook-failed"`. Retries belong in the posthook target itself, not the clock.
4. **Calendar shape** — should an `at:` row appear in a calendar view (`GET /v1/contract/calendar?from=…&to=…`)? Recommend yes, with same lineage visibility check.

## Estimated lift

- libcontract (Zig): ~30 LOC to add `.at` to the SynapseKind table + RFC3339 parsing
- backend (TS): ~60 LOC for the walker + idempotency check + the new ledger query
- Cloudflare Triggers wire: 1 line in `wrangler.toml`
- Tests: ~80 LOC (fire-once, no-fire-before-time, repeated-walker-call-doesnt-double-fire)

Total: ~170 LOC. One PR. Bench impact: zero (walker is async; doesn't sit on hot path).
