# claim-loop-runs-while-off-the-peer-network

**Focus:** 8 Lifecycle Transitions. **Confidence:** high. **Status:** confirmed defect by code reading. The control flow is unconditional and needs no timing. Not run.

## Property

A node's claim, repricing and holding loop runs whenever the chain is up, Settlement is deployed and the identity is
unlocked, whether or not the owner keeps the node off the peer network (`peer_network: false`).

## Claimed guarantee

- `main.rs:1400-1401`: "The chain: start it, then claim what agents paid for, once a minute (FR-6b: claimed
  automatically, batched, always inside the payer's window)."
- The opt-out (commit 0516404d, "A node joins the peer network unless its owner keeps it off") is about joining the
  peer network. Nothing in it says an opted-out node stops claiming.

## Code path (`main.rs:1403-1455`)

```
match n.chain.start().await {
    Ok(d) => {
        ...
        while !n.unlocked() || !network_on() {      // :1416
            sleep(1 s)
        }
        ... advertise, peers::start ...
    }
    Err(e) => { ...; return; }
}
loop { claim_all; reprice; hold_tick; sleep(60 s) }  // :1438
```

The claim loop is reached only after the `while` exits. `network_on()` is `load_settings().peer_network`
(`main.rs:755-757`). For an owner who opted out, the `while` never exits, and the node never claims, reprices or holds
for the life of the process. Before 0516404d the same `while` waited on `terms_accepted()`, so the gating predates
the opt-out. The opt-out made it a setting owners use.

The only other claim path is the owner's `claim_now` command (`main.rs:697-699`).

## What is lost

- Own-entry calls still pay: `run_route` adds a line for a listed entry of the node's own (`api.rs:838-841`), whether
  or not the peer network is on. Those lines are never claimed automatically. Their window (epoch e and e+1,
  `LeanSettlement.sol:109-112,924-925`) closes, and the 55% contributor share, the 30% site escrow, the platform 5% and
  the burn are never moved.
- `covers()` counts those unclaimed lines against the deposit until their window passes (`chain.rs:1185-1211`), so
  calls may be refused for a deposit that is in fact free.
- Auto pricing and holding never run.

## Antithesis angle

A workload property, no fault needed. Put one caller node at `peer_network: false` (the driver's `save_settings` with
`peer_network` off, already in `parallel_driver_owner`), with an own listed route and an agent paying for it. Then
cross epochs (`singleton_driver_epoch`). Restarting the node while it is off (node termination) shows the boot path.
Turning `peer_network` back on mid-run lets the loop start, the recovery case.

## Instrumentation (none exists)

- SUT, **missing**: at the top of each claim-loop iteration, `Sometimes("claim pass ran with the peer network off")`
  with `!network_on()` as the condition. It is unreachable today, so it would surface as never satisfied.
- Workload, **missing** (`eventually_lines_settled` variant): for a node with `peer_network: false`, every passed line
  in a window that closed while the chain was up and Settlement deployed is claimed (`spentLine` true).
  `Always` at window close.

## Open questions

- Is it intended that an opted-out node never claims? The commit message and comments say nothing either way. If it
  is intended, the property becomes "an opted-out node's own-entry calls are refused or warned". `(needs human
  input)` is likely after code review, but it has not been asked yet.
