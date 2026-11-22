#!/usr/bin/env python3
"""Watch every workflow run one pushed commit started, to the end (AGENTS.md, "Push, then watch the run"; UNB-235).

    python3 .github/scripts/watch_runs.py [--sha <commit>] [--settle 90] [--artifacts /tmp] [--log-lines 60]

Lists every run on the commit (`gh run list --commit`): the push's, its pull request's, and any run another workflow
starts from them. Waits on each with `gh run watch --exit-status`, then lists again, so a run that starts later is
watched too; it stops once a listing taken `--settle` seconds after the last run ended shows nothing new. For every
run that did not end green it prints the failed jobs and steps and the end of `gh run view --log-failed`, and
downloads the run's artifacts (the MCP check's step report and a picture per step, the QA screenshots and report,
coverage files) to <artifacts>/run-<id>.

The last line, and the exit code:
  RUNS_GREEN sha=<sha> runs=<id>:<workflow>,...            0  every run succeeded or was skipped
  RUNS_RED sha=<sha> red=<id>:<workflow>:<conclusion>,...  1  a run failed, was cancelled, timed out or never started
  RUNS_NONE sha=<sha>                                      2  no run started on the commit within --settle seconds

A cancelled run is red: it was not watched to an answer. When a newer push cancelled it, watch that push's commit.

Prove a change with `python3 -I .github/scripts/test/test_watch_runs.py`.
"""
import argparse
import json
import pathlib
import subprocess
import sys
import time

GREEN = {"success", "skipped", "neutral"}
FIELDS = "databaseId,workflowName,status,conclusion,event,url"


def gh(args):
    done = subprocess.run(["gh", *args], capture_output=True, text=True)
    return done.returncode, done.stdout + done.stderr


def runs_on(sha, call):
    code, out = call(["run", "list", "--commit", sha, "--limit", "100", "--json", FIELDS])
    if code != 0:
        raise SystemExit(f"gh run list failed: {out.strip()}")
    return {run["databaseId"]: run for run in json.loads(out or "[]")}


def failed_steps(run_id, call):
    code, out = call(["run", "view", str(run_id), "--json", "jobs"])
    if code != 0:
        return [f"(could not read the jobs: {out.strip()})"]
    lines = []
    for job in json.loads(out).get("jobs", []):
        if job.get("conclusion") in GREEN or job.get("conclusion") is None:
            continue
        steps = [s["name"] for s in job.get("steps", []) if s.get("conclusion") not in GREEN | {None}]
        lines.append(f"{job['name']} ({job.get('conclusion')}): {', '.join(steps) or 'no step failed'}")
    return lines


def explain(run, call, artifacts, log_lines, out):
    run_id = run["databaseId"]
    print(f"--- {run['workflowName']} {run_id} {run.get('conclusion')} {run.get('url', '')}", file=out)
    for line in failed_steps(run_id, call):
        print(f"  failed: {line}", file=out)
    code, log = call(["run", "view", str(run_id), "--log-failed"])
    tail = log.strip().splitlines()[-log_lines:] if log.strip() else ["(no failed-step log)"]
    for line in tail:
        print(f"  | {line}", file=out)
    folder = pathlib.Path(artifacts) / f"run-{run_id}"
    code, got = call(["run", "download", str(run_id), "-D", str(folder)])
    print(f"  artifacts: {folder}" if code == 0 else f"  artifacts: none ({got.strip()[:120]})", file=out)


def watch(sha, settle=90, poll=15, artifacts="/tmp", log_lines=60, call=gh, sleep=time.sleep, clock=time.monotonic,
          out=sys.stdout):
    watched = {}
    quiet_since = clock()
    while True:
        new = [run for run_id, run in sorted(runs_on(sha, call).items()) if run_id not in watched]
        for run in new:
            call(["run", "watch", str(run["databaseId"]), "--exit-status", "--interval", "30"])
            watched[run["databaseId"]] = run
            print(f"ended: {run['workflowName']} {run['databaseId']}", file=out)
        if new:
            quiet_since = clock()
        elif clock() - quiet_since >= settle:
            break
        else:
            sleep(poll)
    if not watched:
        print(f"RUNS_NONE sha={sha}", file=out)
        return 2
    final = runs_on(sha, call)
    ended = [final.get(run_id, run) for run_id, run in sorted(watched.items())]
    red = [run for run in ended if run.get("status") != "completed" or run.get("conclusion") not in GREEN]
    for run in red:
        explain(run, call, artifacts, log_lines, out)
    if red:
        names = ",".join(f"{r['databaseId']}:{r['workflowName']}:{r.get('conclusion') or r.get('status')}" for r in red)
        print(f"RUNS_RED sha={sha} red={names}", file=out)
        return 1
    names = ",".join(f"{r['databaseId']}:{r['workflowName']}" for r in ended)
    print(f"RUNS_GREEN sha={sha} runs={names}", file=out)
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--sha", help="the pushed commit (default: HEAD)")
    parser.add_argument("--settle", type=int, default=90, help="seconds with no new run before it stops")
    parser.add_argument("--poll", type=int, default=15)
    parser.add_argument("--artifacts", default="/tmp")
    parser.add_argument("--log-lines", type=int, default=60)
    args = parser.parse_args()
    sha = args.sha or subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True,
                                     check=True).stdout.strip()
    sys.exit(watch(sha, args.settle, args.poll, args.artifacts, args.log_lines))


if __name__ == "__main__":
    main()
