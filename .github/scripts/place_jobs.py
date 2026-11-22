#!/usr/bin/env python3
"""Where each agent job of this run goes: one of Lewis's own runners when one is free, else Blacksmith (UNB-166).

    place_jobs.py qa=mac check=mac slice=mac skills=linux

Each argument is `<job>=<pool>`, in the order the free slots are handed out. For each one this prints
`<job>=<runs-on JSON>` to $GITHUB_OUTPUT and a line of why to $GITHUB_STEP_SUMMARY.

A pool is a label set of self-hosted runners: `mac` is the repository variable MAC_RUNNER (unset: no Mac pool),
`linux` is LINUX_POOL (default `["self-hosted", "linux", "x64"]`). A job goes to its pool only while the pool has a
free runner nobody is waiting for; otherwise it goes to the pool's fallback, a Blacksmith machine that starts at once.
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

A fork's pull request is never placed on a pool (FORK=true). Anything this cannot read sends the job to Blacksmith:
a wrong guess here costs money, never a hung check.
"""

import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

FALLBACK = {"mac": "blacksmith-6vcpu-macos-latest", "linux": "blacksmith-2vcpu-ubuntu-2404"}
DEFAULT_SLOTS = {"mac": 1, "linux": 4}
MAX_RUNS_READ = 40


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


def pool_state(pool, get, repo, this_run, now, runner_token_get=None, slots=None, stale_minutes=10, idle_minutes=2):
    """(free slots, why) for one pool's label set. `get(path)` reads the repository API with the job's token."""
    waiting, running, oldest_wait = 0, 0, 0.0
    read = 0
    for status in ("queued", "in_progress"):
        runs = get(f"/repos/{repo}/actions/runs?status={status}&per_page=100").get("workflow_runs", [])
        for run in runs:
            if run.get("id") == this_run or read >= MAX_RUNS_READ:
                continue
            read += 1
            for job in get(f"/repos/{repo}/actions/runs/{run['id']}/jobs?filter=latest&per_page=100").get("jobs", []):
                if not _wants(job.get("labels"), pool):
                    continue
                if job.get("status") == "queued":
                    waiting += 1
                    oldest_wait = max(oldest_wait, _age_minutes(job.get("created_at"), now))
                elif job.get("status") == "in_progress":
                    running += 1
    if runner_token_get is not None:
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
            raise SystemExit(f"usage: place_jobs.py <job>=<mac|linux> ...  (got {arg!r})")
        requests.append((job, kind))
    fork = env.get("FORK", "false") == "true"
    pools, states = {}, {}
    try:
        pools = {"mac": _labels(env.get("MAC_POOL", "")),
                 "linux": _labels(env.get("LINUX_POOL", '["self-hosted", "linux", "x64"]'))}
        repo, this_run = env["GITHUB_REPOSITORY"], int(env.get("GITHUB_RUN_ID", "0"))
        get = _http(env["GH_TOKEN"])
        runner_get = _http(env["RUNNER_READ_TOKEN"]) if env.get("RUNNER_READ_TOKEN") else None
        now = datetime.now(timezone.utc)
        for kind in sorted({k for _, k in requests}):
            if pools.get(kind) is None or fork:
                states[kind] = (0, "not read")
                continue
            slots = int(env.get(f"POOL_SLOTS_{kind.upper()}", DEFAULT_SLOTS[kind]))
            states[kind] = pool_state(pools[kind], get, repo, this_run, now, runner_get, slots,
                                      float(env.get("STALE_MINUTES", "10")))
    except Exception as error:  # noqa: BLE001: anything unread sends the job to Blacksmith, said in the summary
        print(f"::warning::Could not read the local runners ({type(error).__name__}: {error}); every job goes to Blacksmith")
        pools, states = {}, {}
    placed, why = place(requests, pools, states, fork)
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
