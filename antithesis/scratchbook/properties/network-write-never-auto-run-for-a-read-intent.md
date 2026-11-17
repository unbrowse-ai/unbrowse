---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
updated: 2026-10-30
focus: 11 (wildcard)
confidence: high
---

# A read-intended goal never autonomously pays for and runs a write route

## What led here

The node (branch `autonomous-fetch`, PR #53, worktree `.../autofetch`) now pays
route fees by itself up to `max_fetch_usdc`, with nothing for the owner to
approve (`store.rs:449-455`, `api.rs` `network_goal`). The whole point of the
feature is that `do_goal` will, with no human in the loop, fetch another
contributor's route, pay its fee, and **run it against the site under the
caller's own session** (`run_route` → `run::call_watched`, which attaches the
caller's jar cookies for the target host).

The one guard that is supposed to stop that from being a *write* — buying,
posting, cancelling, deleting on the user's account — when the user only asked
to *read* is the `reads_only` flag. There are **two different read-goal
classifiers** and the autonomous network path uses the weaker one.

## The two classifiers disagree

- `api.rs::read_only_goal(goal)` (autofetch `api.rs:538-549`, base
  `api.rs` same): true when the goal's words contain a READ verb and no WRITE
  verb. Used for the **local** candidate set: `reads_only(found, goal)` drops
  local write routes.
- `learn::read_goal(goal)` (`learn.rs:476-482`): true only when the goal's
  **first word** is one of a fixed list (`read list search find show view look
  get fetch inspect browse`, or `check` not followed by `out`).

The autonomous network path passes `learn::read_goal(goal)` as `reads_only`:

```
// api.rs network_goal:
match call_entry(node, a, &entry, body.inputs.clone(), url, learn::read_goal(goal)).await
// call_entry:
if reads_only && got.route.write { return CONFLICT }   // the only write gate
```

So for a goal that `read_only_goal` treats as read-only but `learn::read_goal`
does not, the **local** path refuses to run a write, while the **network** path
fetches, pays for, and runs it. Confirmed divergence (scratch repro
`scratchpad/wild/goals.py`, the exact Rust logic re-implemented):

| goal | `read_only_goal` | `learn::read_goal` |
|---|---|---|
| `search Hacker News stories` | true | true |
| `please search for red shoes` | true | **false** |
| `I want to see my orders` | true | **false** |
| `can you list my posts` | true | **false** |
| `check out my cart` | true | **false** |

Any read-intended phrasing whose first word is not in the fixed list
(`please …`, `I want to …`, `can you …`, a leading article) is `reads_only =
false` on the network path. A contributor's listing whose `terms.description`
word-set matches the goal (`network_goal` filters candidates by
`goal_words(desc) == goal_words(goal)`) and whose recipe target is a write
(e.g. `POST /cart/add`, `changes_state` true) is then **fetched, paid for with
the owner's money, and executed against the site with the caller's live
session** — all with no approval, for a goal the user meant as read-only.

## Why it matters

This is the exact failure the `reads_only`/#25 guard exists to prevent, on the
one path where the node spends money and mutates the user's account with no
human in the loop. A malicious or careless contributor only needs a listing
whose description echoes common read phrasings; the fee is bounded by
`max_fetch_usdc` but the *side effect on the site* (an order, a post, a cancel)
is not bounded by anything.

## Instrumentation (vs existing-assertions.md: none exist)

- `AlwaysOrUnreachable` at the `call_entry` write gate: when `run_route` runs a
  route with `route.write == true` and `paying.is_some()` (a network entry), the
  originating goal was **not** read-classified by *either* classifier. Message:
  "a network write route ran for a read-classified goal". Missing today.
- `Sometimes(a network write route was auto-run)` to confirm the workload
  reaches the autonomous-write path at all.

## Open Questions

- Is `learn::read_goal` (first-word-only) the intended gate for the autonomous
  network path, or should it be `read_only_goal` (whole-goal) as the local path
  uses? The two were written for different call sites and never reconciled.
- Does the description-word-match filter (`goal_words(desc)==goal_words(goal)`)
  meaningfully narrow the attack, or can a contributor always echo the goal?
  `(partial: filter requires exact word-set equality, but the attacker writes
  the description after seeing common goals)`
- Is PR #53 landing as-is? The gap lives on `autonomous-fetch`; confirm the
  classifier choice survives to main. `(needs human input)`
