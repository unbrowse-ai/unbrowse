# cap-is-checked-before-the-site-is-called

**Focus:** 6 Security Boundaries (agent cap), 9 Idempotency (writes the agent retries). **Confidence:** high. **Status:** confirmed by code reading (deterministic; no race needed).

## Property

A paid call the agent key's cap or the payer's deposit can't cover is refused before anything reaches the site or a body is fetched. A call that reached the site is never answered "this would pass the key's cap" (HTTP 402) afterwards.

## Claimed guarantee

- `chain.rs:1168-1169` "The cap and the deposit are enforced here, **before anything is signed** (FR-2)."
- protocol.md R1.22 (no line beyond the cap), R1.25 "A node treats any state-changing request as a write ... and holds it to the key's caps."
- `api.rs:743` "The fee goes on the agent's running voucher, within the key's cap and the deposit, only if the use passes."

## Code path

`api.rs:728-790` `call_entry` then `api.rs:799-853` `run_route`:

1. `:744-752` pre-check: `spent + listed.fee > cap` where `spent = agentOf(...).spentThisEpoch` (on-chain claimed only, `chain.rs:1093-1100`). **Local pending lines are not counted.**
2. `:754-755` deposit pre-check `covers` (this one does count local unclaimed lines, `chain.rs:1185-1212`).
3. `:757` `share::fetch` pays a body voucher, saves the body and the route (`share.rs:309-310`) and seeds it (`:319`).
4. `:826` the route runs against the site (`run::call_watched`): the side effect happens here.
5. `:846` `add_network_receipt` -> `push_receipt` (`chain.rs:1227-1234`), which adds local `pending` and refuses: `Err("this would pass the key's cap ...")`, mapped to 402 and returned with `?`. The site's answer is dropped.

The own-entry path has the same order: `run_route` reads `spent/cap/deposit` at `:808-814`, calls the site at `:826`, and only then `add_receipt` (`:840`) may refuse.

## Failure scenario (deterministic)

Cap 1.0, fee 0.4, claim loop every 60 s (`main.rs:1438-1453`). Within one minute, the agent calls entries A and B (pending 0.8, on-chain spent 0). A call to entry C passes the pre-check (0 + 0.4 <= 1), fetches C's body, runs it against the site, and is then refused by `push_receipt` (0 + 0.8 + 0.4 > 1). The agent gets 402. If C's route writes (an order, a post), the write landed; the agent was told it was refused and may retry once the claim loop lands, writing twice.

## Antithesis angle

Needs only a workload that calls paid entries faster than the claim loop settles them, near the cap. Faults widen the window: a partition from the chain delays the claim loop (no timeouts, `chain.rs:618-627`), so pending grows while `spent` stays put. A site fixture that records writes (`/_seen`, deployment-topology.md) shows the write happened.

## Instrumentation (all missing)

- Workload `Always("a call refused for the cap made no request to the site")`: correlate each 402 "pass the key's cap" reply with the fixture site's `/_seen` log for that request. Missing.
- SUT-side `Unreachable("push_receipt refused a passed line after the route ran")` at the `Err` branch reached from `api.rs:846` and `:840`. Missing.
- SUT-side `Always("call_entry's cap pre-check counts local pending lines")` is the fix's check, not an assertion; listed so the triage can see the gap.

## Open questions

- Should the refusal after the site call instead write the line anyway (the use happened) and let the contract refuse the claim? That changes the property from "refuse early" to "never drop a use the site saw".
