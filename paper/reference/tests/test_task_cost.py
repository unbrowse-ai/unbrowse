"""Each test proves one sentence about end-to-end task cost: the per-call 3.6x is
a floor, and the per-task advantage compounds with clicks, failures, and tokens."""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from bench.task_cost import (  # noqa: E402
    api_task,
    browser_task,
    cost_ratio,
    representative_advantage,
    speedup,
)


def test_per_call_floor_matches_the_published_numbers():
    # one click, one read, no failure == one cold browser call vs one API call:
    # the model reproduces the published per-call 3.58x latency and 40x tokens.
    b = browser_task(clicks=1, reads=1, success_per_step=1.0)
    a = api_task(calls=1)
    assert math.isclose(speedup(b, a), 3404.0 / 950.0, rel_tol=1e-9)   # ~3.58x
    assert math.isclose(cost_ratio(b, a), 40.0, rel_tol=1e-9)          # 8000/200


def test_tokens_compound_superlinearly_with_reads():
    # doubling the DOM reads MORE than doubles the tokens (O(reads^2) compounding),
    # because each read re-feeds the accumulated context.
    one = browser_task(clicks=0, reads=5, success_per_step=1.0)["tokens"]
    two = browser_task(clicks=0, reads=10, success_per_step=1.0)["tokens"]
    assert two > 2.0 * one


def test_failures_inflate_both_latency_and_tokens():
    # a lower per-step success rate (more retries) strictly raises both costs.
    reliable = browser_task(clicks=10, reads=3, success_per_step=1.0)
    flaky = browser_task(clicks=10, reads=3, success_per_step=0.5)
    assert flaky["latency_ms"] > reliable["latency_ms"]
    assert flaky["tokens"] > reliable["tokens"]


def test_api_path_is_step_invariant():
    # the API path does not grow with the browser task's clicks/reads — it is ~one
    # structured call regardless of how many steps the browser would have taken.
    a = api_task(calls=1)
    assert a["latency_ms"] == 950.0 and a["tokens"] == 200.0
    # a generous 3-call API task is still tiny next to a multi-step browser task.
    a3 = api_task(calls=3)
    big_browser = browser_task(clicks=10, reads=3, success_per_step=0.8)
    assert speedup(big_browser, a3) > 10.0


def test_per_task_advantage_exceeds_the_per_call_floor():
    # the headline: on a representative real task the end-to-end advantage compounds
    # WELL past the per-call 3.6x. The single-call figure is a floor, not the result.
    adv = representative_advantage()
    assert adv["speedup"] >= 30.0
    assert adv["cost_ratio"] >= 90.0
    # and it is strictly larger than the per-call floor it is so often quoted as.
    assert adv["speedup"] > 3.6
    assert adv["cost_ratio"] > 40.0


def test_speedup_scales_with_clicks_and_with_failure():
    # more clicks -> more end-to-end speedup; flakier steps -> more speedup, because
    # every wasted browser retry is cost the API path never pays.
    a = api_task(calls=1)
    few = speedup(browser_task(clicks=3, reads=1, success_per_step=0.9), a)
    many = speedup(browser_task(clicks=15, reads=1, success_per_step=0.9), a)
    assert many > few
    steady = speedup(browser_task(clicks=10, reads=1, success_per_step=1.0), a)
    flaky = speedup(browser_task(clicks=10, reads=1, success_per_step=0.6), a)
    assert flaky > steady
