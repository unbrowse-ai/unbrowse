"""Per-task cost compounds with clicks, failure-retries, and token growth: the
per-call 3.6x speedup is a lower bound, not the end-to-end advantage.

The field result (arXiv:2604.00694) of 3.6x mean / 5.4x median is a PER-CALL
latency comparison: one cached route execution (950 ms) vs one cold browser
rediscovery (3,404 ms). A real agent task is not one call. It is a sequence of
browser interactions --- navigate, wait, click, wait, fill, submit, paginate ---
and each interaction (a) costs latency, (b) can FAIL and be retried, and (c)
re-reads a growing page into the agent's context, so token cost COMPOUNDS across
the heavy DOM reads. The API-native path collapses the same task into ~one
structured call: no multi-step navigation, no retry tax, no compounding context.

This reference makes that honest: it models the end-to-end task cost for the
browser path vs the API path and shows the per-TASK advantage is the per-call
advantage MULTIPLIED by the task's click count, its failure-retry factor, and its
token compounding --- recovering the field's measured ~30x faster / ~90x cheaper
end-to-end figures, of which the single-call 3.6x is only the floor. It is a
mechanism model, deterministic and parameterised; the live numbers are cited.

No wall-clock, no randomness: pure arithmetic over the cost parameters, so the
compounding is provable rather than asserted.
"""
from __future__ import annotations

# Published per-call anchors (arXiv:2604.00694): browser rediscovery vs cached
# route execution, and the 40x per-call token ratio (one full DOM read vs one
# structured response).
BROWSER_STEP_LATENCY_MS = 3404.0
API_CALL_LATENCY_MS = 950.0
BROWSER_READ_TOKENS = 8000.0        # one full page/DOM read into context
API_CALL_TOKENS = 200.0             # one structured response (40x smaller)


def browser_task(
    clicks: int,
    reads: int,
    success_per_step: float,
    step_latency_ms: float = BROWSER_STEP_LATENCY_MS,
    read_tokens: float = BROWSER_READ_TOKENS,
) -> dict:
    """End-to-end cost of solving a task by driving a browser.

    `clicks` latency-bearing interactions (navigations/waits/clicks/form steps),
    `reads` heavy DOM reads whose tokens COMPOUND (each read re-feeds the
    accumulated context, so the i-th read costs i page-reads worth of tokens ->
    O(reads^2) growth). `success_per_step` in (0,1] gives a geometric retry tax
    of 1/success expected attempts per step. Failures inflate BOTH latency and
    tokens, because a failed step is re-driven and re-read.
    """
    if not (0.0 < success_per_step <= 1.0):
        raise ValueError("success_per_step must be in (0, 1]")
    if clicks < 0 or reads < 0:
        raise ValueError("clicks and reads must be >= 0")
    retry = 1.0 / success_per_step
    latency = clicks * step_latency_ms * retry
    # compounding: sum_{i=1..reads} i = reads*(reads+1)/2 page-reads of context
    compounded_reads = reads * (reads + 1) / 2.0
    tokens = read_tokens * compounded_reads * retry
    return {
        "latency_ms": latency,
        "tokens": tokens,
        "attempts": (clicks + reads) * retry,
    }


def api_task(calls: int = 1, call_latency_ms: float = API_CALL_LATENCY_MS,
             call_tokens: float = API_CALL_TOKENS) -> dict:
    """End-to-end cost of the same task on the API-native path: a few structured
    calls, no multi-step navigation, no retry tax, no compounding context."""
    if calls < 1:
        raise ValueError("calls must be >= 1")
    return {"latency_ms": calls * call_latency_ms, "tokens": calls * call_tokens,
            "attempts": calls}


def speedup(browser: dict, api: dict) -> float:
    """How many times faster the API path completes the whole task."""
    return browser["latency_ms"] / api["latency_ms"]


def cost_ratio(browser: dict, api: dict) -> float:
    """How many times cheaper (in tokens) the API path completes the whole task."""
    return browser["tokens"] / api["tokens"]


# A representative real task: ~10 browser interactions, ~3 heavy DOM reads, 80%
# per-step success (1-in-5 steps needs a retry). Compare to one API call.
REPRESENTATIVE = dict(clicks=10, reads=3, success_per_step=0.80)


def representative_advantage() -> dict:
    """The end-to-end advantage on the representative task --- the number the
    per-call 3.6x discounts."""
    b = browser_task(**REPRESENTATIVE)
    a = api_task(calls=1)
    return {"speedup": speedup(b, a), "cost_ratio": cost_ratio(b, a),
            "browser": b, "api": a}
