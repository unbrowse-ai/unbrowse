# Release on boost

## The rule

A release is recommended when the dimensional-bench coverage rises by 10 percentage points or more above the last shipped release's coverage. The recommendation is surfaced, not enforced; the operator (or the agent) judges whether the boost is honest and ships when it is.

## How it composes

After every release-it run, `after:bump` writes the just-shipped coverage to `.release-coverage-baseline` (a single float between 0.0 and 1.0). Before the next release-it run, `scripts/check-release-on-boost.sh` reads the baseline plus the current `.bench-local/results.jsonl` and prints:

```
[release-boost] baseline=62.2% current=72.4% delta=+10.2pp recommend-release=yes
```

When delta is below 10 percentage points, the script prints `recommend-release=no`. The gate is evidence, not block: release-it continues regardless. The agent reading the line decides whether to proceed.

## Why 10 percentage points

Smaller boosts are noise; bigger boosts are the kind of capability change worth flipping a version number for. The threshold is named, not adjustable on a per-run basis — drift in the threshold would make the recommendation untrustworthy.

The threshold is a single line in `scripts/check-release-on-boost.sh` (the `>= 10.0` check). Changing it is a contract row and a PR.

## What this rules out

- Releases that don't move the bench measurably (avoids version inflation).
- Bench cherry-picking — `.bench-local/results.jsonl` IS the input; the baseline IS the input; both are visible.
- Auto-firing release-it — the recommendation is a line of stderr, not an exec call. The operator's verdict is still required.
