#!/usr/bin/env python3
"""Where each agent job of this run goes: one of Lewis's own runners when one is free, else a hosted machine (UNB-166):
Sengi for Linux, GitHub's macos-15 for macOS.

    place_jobs.py qa=mac check=mac slice=mac skills=linux

Each argument is `<job>=<pool>`, in the order the free slots are handed out. For each one this prints
`<job>=<runs-on JSON>` to $GITHUB_OUTPUT and a line of why to $GITHUB_STEP_SUMMARY.

A pool is a label set of self-hosted runners: `mac` is the repository variable MAC_RUNNER (unset: no Mac pool),
`linux` is LINUX_POOL (default `["self-hosted", "linux", "x64"]`). A job goes to its pool only while the pool has a
free runner nobody is waiting for; otherwise it goes to the pool's fallback, a hosted machine that starts at once.
One Mac runs one job at a time, so a run never queues three agent jobs behind each other on it, and a Mac that is
asleep or busy never holds a pull request up.

What "free" is read from:
  - RUNNER_READ_TOKEN set (a fine-grained token with the repository's Administration: read): the runners themselves,
    online and not busy. GitHub's own job token cannot list runners.
  - Always: the jobs already waiting for the pool's labels, and the ones running on it, in this repository's queued and
    in-progress runs. Waiting jobs take a slot before this run does.
  - Without the runner token, a pool's size is POOL_SLOTS_<POOL> (mac 1, linux 4). An online runner with nothing to do
    takes a waiting job within seconds, so a job that has waited 2 minutes while nothing runs on the pool says the pool
    is asleep or offline, and one waiting STALE_MINUTES (10) says it is not keeping up: nothing new goes there until
    that job starts. The one job sent to a pool that has just gone to sleep waits for it; the runs after it do not.

A fork's pull request is never placed on a pool (FORK=true). Anything this cannot read sends the job to its hosted fallback:
a wrong guess here costs money, never a hung check.

One exception, `mac-only`: the gate bank's slice (Lewis, 28 Nov 2026: "run slices only on my Mac"). It goes to
OWN_MAC (the workflows pass vars.MAC_RUNNER, `["self-hosted", "macOS", "ARM64", "lewis-mbp"]`) every time, free or
not, and waits for it: GitHub queues a job for a self-hosted runner until one takes it. From a hosted Mac (a data
centre's address) Ticketmaster and Carousell refuse the slice's tasks and its gate says PROMOTION_REFUSED (PR #945, run
46116646462); on lewis-mbp it passes (run 46117099629). It takes the Mac's free slot first, so no other agent job of
the run queues beside it there. With no OWN_MAC, one that is not self-hosted, or a fork's pull request, it is refused
(the place step fails, saying why): it never goes to a hosted machine.
"""

import concurrent.futures
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

FALLBACK = {"mac": "macos-15", "linux": "sengi-premium-2-ubuntu-2404"}
# A job that runs on Lewis's Mac and nowhere else, never a hosted fallback: the gate bank's slice (Lewis, 28 Nov 2026).
MAC_ONLY = "mac-only"
DEFAULT_SLOTS = {"mac": 1, "linux": 4}
MAX_RUNS_READ = 40
# Workflows that only ever run on hosted runners: skipping their `/jobs` queries cuts API calls per placement.
HOSTED_ONLY_WORKFLOWS = frozenset({
    ".github/workflows/pr-report.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/coverage.yml",
    ".github/workflows/pr-check.yml",
    ".github/workflows/promotion-gate.yml",
    ".github/workflows/opencode-approvals.yml",
    ".github/workflows/pr-signal.yml",
    ".github/workflows/pr-closed.yml",
    ".github/workflows/dashboard.yml",
    ".github/workflows/dashboard-post.yml",
    ".github/workflows/fresh-seeds.yml",
    ".github/workflows/main-source-guard.yml",
})


def _labels(spec):
    """A pool's label set from its variable: a JSON list, a JSON string, or empty for no pool."""
    if not spec or not spec.strip():
        return None
    value = json.loads(spec)
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list) or not value or not all(isinstance(v, str) for v in value):
        raise ValueError(f"not a runs-on label list: {spec!r}")
    return value


def _wants(job_labels, pool):
    """A job asked for this pool: it names every one of the pool's labels (GitHub compares labels without case)."""
    have = {label.lower() for label in job_labels or []}
    return {label.lower() for label in pool} <= have


def _runner_is_pool(runner_labels, pool):
    return _wants(runner_labels, pool)


def _age_minutes(stamp, now):
    if not stamp:
        return 0.0
    then = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    return (now - then).total_seconds() / 60


def _collect_active_jobs(get, repo, this_run):
    """Fetch jobs across queued and in-progress runs once, skipping hosted-only workflows, in parallel."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        pages = list(pool.map(
            lambda s: get(f"/repos/{repo}/actions/runs?status={s}&per_page=100").get("workflow_runs", []),
            ("queued", "in_progress"),
        ))
    run_ids, seen = [], set()
    for runs in pages:
        for run in runs:
            rid = run.get("id")
            if rid == this_run or rid in seen:
                continue
            if run.get("path") in HOSTED_ONLY_WORKFLOWS:
                continue
            seen.add(rid)
            run_ids.append(rid)
            if len(run_ids) >= MAX_RUNS_READ:
                break
        if len(run_ids) >= MAX_RUNS_READ:
            break
    if not run_ids:
        return []
    if len(run_ids) == 1:
        return get(f"/repos/{repo}/actions/runs/{run_ids[0]}/jobs?filter=latest&per_page=100").get("jobs", [])
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(10, len(run_ids))) as pool:
        batches = list(pool.map(
            lambda rid: get(f"/repos/{repo}/actions/runs/{rid}/jobs?filter=latest&per_page=100").get("jobs", []),
            run_ids,
        ))
    return [job for batch in batches for job in batch]


def pool_state(pool, get, repo, this_run, now, runner_token_get=None, slots=None, stale_minutes=10, idle_minutes=2,
               active_jobs=None, runners=None):
    """(free slots, why) for one pool's label set. `get(path)` reads the repository API with the job's token."""
    waiting, running, oldest_wait = 0, 0, 0.0
    jobs = _collect_active_jobs(get, repo, this_run) if active_jobs is None else active_jobs
    for job in jobs:
        if not _wants(job.get("labels"), pool):
            continue
        if job.get("status") == "queued":
            waiting += 1
            oldest_wait = max(oldest_wait, _age_minutes(job.get("created_at"), now))
        elif job.get("status") == "in_progress":
            running += 1
    if runner_token_get is not None or runners is not None:
        if runners is None:
            runners = runner_token_get(f"/repos/{repo}/actions/runners?per_page=100").get("runners", [])
        mine = [r for r in runners if _runner_is_pool([label["name"] for label in r.get("labels", [])], pool)]
        idle = sum(1 for r in mine if r.get("status") == "online" and not r.get("busy"))
        online = sum(1 for r in mine if r.get("status") == "online")
        free = max(0, idle - waiting)
        return free, f"{online} of {len(mine)} runners online, {idle} idle, {waiting} jobs already waiting"
    if waiting and not running and oldest_wait >= idle_minutes:
        return 0, f"a job has waited {oldest_wait:.0f} min for it with nothing running on it (asleep or offline)"
    if waiting and oldest_wait >= stale_minutes:
        return 0, f"a job has waited {oldest_wait:.0f} min for it (asleep, offline or full)"
    free = max(0, slots - running - waiting)
    return free, f"{slots} slots, {running} running, {waiting} waiting (no runner token: online not known)"


def place(requests, pools, states, fork):
    """[(job, kind)] -> {job: runs-on}, {job: why}. Free slots go to the jobs in the order asked."""
    free = {kind: state[0] for kind, state in states.items()}
    placed, why = {}, {}
    for job, kind in requests:
        if kind == MAC_ONLY:
            own = pools.get(MAC_ONLY)
            if fork:
                raise ValueError(f"{job} runs only on Lewis's Mac, and a fork's pull request never runs there")
            if not own or "self-hosted" not in {label.lower() for label in own}:
                raise ValueError(f"{job} runs only on Lewis's Mac (OWN_MAC, the self-hosted labels of vars.MAC_RUNNER), "
                                 f"and none is set here: {own!r}")
            mac = pools.get("mac")
            state = states.get("mac", (0, "not read"))[1]
            if mac and {label.lower() for label in mac} == {label.lower() for label in own} and free.get("mac", 0) > 0:
                free["mac"] -= 1
                placed[job], why[job] = own, f"only Lewis's Mac, never a hosted one (Lewis, 28 Nov 2026); free: {state}"
            else:
                placed[job], why[job] = own, f"only Lewis's Mac, never a hosted one (Lewis, 28 Nov 2026); it waits for it: {state}"
            continue
        if kind not in FALLBACK:
            raise ValueError(f"{job}: unknown pool {kind!r}")
        pool = pools.get(kind)
        if fork:
            placed[job], why[job] = FALLBACK[kind], "a fork's pull request never runs on a local runner"
        elif pool is None:
            placed[job], why[job] = FALLBACK[kind], f"no {kind} pool is set"
        elif free.get(kind, 0) > 0:
            free[kind] -= 1
            placed[job], why[job] = pool, f"a free {kind} runner: {states[kind][1]}"
        else:
            placed[job], why[job] = FALLBACK[kind], f"no free {kind} runner: {states[kind][1]}"
    return placed, why


def _http(token):
    def get(path):
        req = urllib.request.Request(
            "https://api.github.com" + path,
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "place-jobs"},
        )
        with urllib.request.urlopen(req, timeout=20) as reply:
            return json.load(reply)
    return get


def main(argv, env):
    requests = []
    for arg in argv:
        job, _, kind = arg.partition("=")
        if not job or not kind:
            raise SystemExit(f"usage: place_jobs.py <job>=<mac|mac-only|linux> ...  (got {arg!r})")
        requests.append((job, kind))
    fork = env.get("FORK", "false") == "true"
    pools, states = {}, {}
    # Read apart from the pools below: nothing that fails to read there may move a mac-only job off the Mac.
    try:
        own_mac = _labels(env.get("OWN_MAC", ""))
    except ValueError as error:
        own_mac = None
        print(f"::warning::OWN_MAC is not a runs-on label list ({error})")
    try:
        pools = {"mac": _labels(env.get("MAC_POOL", "")),
                 "linux": _labels(env.get("LINUX_POOL", '["self-hosted", "linux", "x64"]'))}
        repo, this_run = env["GITHUB_REPOSITORY"], int(env.get("GITHUB_RUN_ID", "0"))
        get = _http(env["GH_TOKEN"])
        runner_get = _http(env["RUNNER_READ_TOKEN"]) if env.get("RUNNER_READ_TOKEN") else None
        now = datetime.now(timezone.utc)
        kinds = sorted({"mac" if k == MAC_ONLY else k for _, k in requests})
        needed = [k for k in kinds if pools.get(k) is not None and not fork]
        active_jobs, runners_list = None, None
        if needed:
            if runner_get is not None:
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool_ex:
                    jobs_fut = pool_ex.submit(_collect_active_jobs, get, repo, this_run)
                    runners_fut = pool_ex.submit(lambda: runner_get(f"/repos/{repo}/actions/runners?per_page=100").get("runners", []))
                    active_jobs, runners_list = jobs_fut.result(), runners_fut.result()
            else:
                active_jobs = _collect_active_jobs(get, repo, this_run)
        for kind in kinds:
            if pools.get(kind) is None or fork:
                states[kind] = (0, "not read")
                continue
            slots = int(env.get(f"POOL_SLOTS_{kind.upper()}", DEFAULT_SLOTS[kind]))
            states[kind] = pool_state(pools[kind], get, repo, this_run, now, runner_get, slots,
                                      float(env.get("STALE_MINUTES", "10")),
                                      active_jobs=active_jobs, runners=runners_list)
    except Exception as error:  # noqa: BLE001: anything unread sends the job to its hosted fallback, said in the summary
        print(f"::warning::Could not read the local runners ({type(error).__name__}: {error}); every job goes to its hosted fallback")
        pools, states = {}, {}
    try:
        placed, why = place(requests, dict(pools, **{MAC_ONLY: own_mac}), states, fork)
    except ValueError as error:
        print(f"::error::{error}")
        raise SystemExit(1) from error
    out = env.get("GITHUB_OUTPUT")
    lines = [f"{job}={json.dumps(placed[job])}" for job, _ in requests]
    if out:
        with open(out, "a") as fh:
            fh.write("\n".join(lines) + "\n")
    summary = ["### Where the agent jobs run", "", "| job | runner | why |", "|---|---|---|"]
    summary += [f"| {job} | `{json.dumps(placed[job])}` | {why[job]} |" for job, _ in requests]
    if env.get("GITHUB_STEP_SUMMARY"):
        with open(env["GITHUB_STEP_SUMMARY"], "a") as fh:
            fh.write("\n".join(summary) + "\n")
    print("\n".join(lines))
    return placed


if __name__ == "__main__":
    main(sys.argv[1:], os.environ)
