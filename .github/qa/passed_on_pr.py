#!/usr/bin/env python3
"""Whether the commit a push put on staging already passed the agent checks on its pull request (UNB-166).

    passed_on_pr.py --repo <owner/name> --event <event> --ref <ref> --tree <tree sha>

pr-agent-checks.yml runs the MCP check, Claude QA and the gate bank's slice on a pull request's merge commit, and
qa.yml ran them again on the push that merged it: 18.5 macOS minutes and the model's use a push (the CI audit of 21 Nov
2026, U7). When the pushed commit's tree is the tree that merge commit had, the code, the workflows and the tests are
the same files, and the second run measures nothing the first did not. Measured on the 40 pushes to staging of 20 Nov
02:02Z to 21 Nov 10:32Z 2026: 8 had the tree of a successful pull request run; 12 came from a pull request with a
successful run at all, and 21 of the 34 that had any run were merged with staging unmoved since their last run began.

A hit needs all of:
  - the event is a push to staging (the nightly run and a run by hand always run everything);
  - an artifact named `gate-bank-slice-<tree>` that has not expired: the slice job of pr-agent-checks.yml keeps its
    results under the tree it ran on (`git rev-parse HEAD^{tree}` of the merge commit);
  - the run that made it is pr-agent-checks.yml, for a pull_request, from a branch of this repository, completed, and
    its conclusion is success: its last job is green only when every agent check ran and passed;
  - pr-check.yml's run on that same commit, for a pull_request, from a branch of this repository, completed with
    success: the MCP check runs there alone, on every pull request (pr-agent-checks.yml ran a second copy of it, with
    the same steps, until 22 Nov 2026).

A push of the same tree by qa.yml itself keeps an artifact of the same name; it is not a pull request's run and never
counts. Anything this cannot read (no token, the API down, an answer of another shape) is no hit: everything runs.

It trusts what a successful run of pr-agent-checks.yml on a branch of this repository says about itself, as the green
check on the pull request does. Whoever can push a branch here can push to staging.

Prints PASSED_ON_PR hit=<true|false> and why; writes `hit` and `run` to $GITHUB_OUTPUT and a line to the run's summary.
Always exits 0. Standard library only.
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

WORKFLOW = ".github/workflows/pr-agent-checks.yml"
MCP_CHECK = ".github/workflows/pr-check.yml"
STAGING = "refs/heads/staging"


def find(repo, event, ref, tree, get):
    """(run or None, why): the successful pull request run that tested `tree`. `get(path)` answers the API as JSON."""
    if event != "push" or ref != STAGING:
        return None, f"a {event} on {ref} always runs every check"
    if not re.fullmatch(r"[0-9a-f]{40}", tree or ""):
        return None, f"no tree to look for ({tree!r})"
    listed = get(f"/repos/{repo}/actions/artifacts?name=gate-bank-slice-{tree}&per_page=100")
    artifacts = (listed or {}).get("artifacts")
    if not isinstance(artifacts, list):
        return None, "the artifacts list could not be read"
    seen = []
    for artifact in artifacts:
        made_by = artifact.get("workflow_run") or {}
        run_id = made_by.get("id")
        if artifact.get("expired") or artifact.get("name") != f"gate-bank-slice-{tree}" or not isinstance(run_id, int):
            continue
        if made_by.get("head_repository_id") != made_by.get("repository_id"):
            seen.append(f"run {run_id}: from another repository")
            continue
        run = get(f"/repos/{repo}/actions/runs/{run_id}") or {}
        wrong = [
            why
            for ok, why in (
                (run.get("id") == run_id, "not the run asked for"),
                (run.get("path") == WORKFLOW, f"workflow {run.get('path')}"),
                (run.get("event") == "pull_request", f"event {run.get('event')}"),
                (run.get("status") == "completed", f"status {run.get('status')}"),
                (run.get("conclusion") == "success", f"conclusion {run.get('conclusion')}"),
                ((run.get("repository") or {}).get("full_name") == repo, "another repository's run"),
                ((run.get("head_repository") or {}).get("full_name") == repo, "a fork's pull request"),
            )
            if not ok
        ]
        if not wrong:
            mcp, why = mcp_check(repo, run, get)
            if mcp is not None:
                return run, f"tree {tree} passed PR agent checks in run {run_id} and the MCP check in run {mcp.get('id')}"
            seen.append(f"run {run_id}: {why}")
            continue
        seen.append(f"run {run_id}: {wrong[0]}")
    if not seen:
        return None, f"no pull request run kept results for tree {tree}"
    return None, f"no successful pull request run for tree {tree} (" + "; ".join(seen[:5]) + ")"


def mcp_check(repo, run, get):
    """(run or None, why): pr-check.yml's successful pull request run on the commit `run` (pr-agent-checks.yml's) ran on."""
    sha = run.get("head_sha") or ""
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        return None, "no commit to look up its MCP check by"
    listed = get(f"/repos/{repo}/actions/runs?head_sha={sha}&event=pull_request&per_page=100")
    runs = (listed or {}).get("workflow_runs")
    if not isinstance(runs, list):
        return None, "the MCP check's runs could not be read"
    for other in runs:
        if (other.get("path") == MCP_CHECK and other.get("event") == "pull_request" and other.get("head_sha") == sha
                and other.get("status") == "completed" and other.get("conclusion") == "success"
                and (other.get("repository") or {}).get("full_name") == repo
                and (other.get("head_repository") or {}).get("full_name") == repo):
            return other, ""
    return None, f"its MCP check (pr-check.yml) did not pass on commit {sha[:8]}"


def api(token, base="https://api.github.com"):
    def get(path):
        request = urllib.request.Request(base.rstrip("/") + path, headers={
            "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"})  # fmt: skip
        with urllib.request.urlopen(request, timeout=30) as answer:
            return json.loads(answer.read().decode("utf-8"))

    return get


def main(argv=None, get=None, env=None):
    env = os.environ if env is None else env
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--event", required=True)
    parser.add_argument("--ref", required=True)
    parser.add_argument("--tree", required=True)
    args = parser.parse_args(argv)
    run = None
    try:
        if get is None:
            token = env.get("GH_TOKEN") or ""
            if not token:
                raise RuntimeError("no GH_TOKEN to ask with")
            get = api(token, env.get("GITHUB_API_URL") or "https://api.github.com")
        run, why = find(args.repo, args.event, args.ref, args.tree, get)
    except (OSError, ValueError, RuntimeError, urllib.error.URLError, AttributeError, TypeError, KeyError) as error:
        run, why = None, f"could not ask GitHub ({type(error).__name__}: {str(error)[:200]}): every check runs"
        print(f"::warning::{why}")
    hit = run is not None
    url = str(run.get("html_url") or "") if hit else ""
    print(f"PASSED_ON_PR hit={'true' if hit else 'false'} {why}")
    if env.get("GITHUB_OUTPUT"):
        with open(env["GITHUB_OUTPUT"], "a") as out:
            out.write(f"hit={'true' if hit else 'false'}\nrun={url}\n")
    if env.get("GITHUB_STEP_SUMMARY"):
        with open(env["GITHUB_STEP_SUMMARY"], "a") as out:
            if hit:
                out.write(f"## Already passed on its pull request\n\nThis commit's tree `{args.tree}` passed PR agent checks in [run {run.get('id')}]({url}): the MCP check, "
                          "Claude QA and the gate bank's slice are not run again on this push. The nightly run runs them all.\n")  # fmt: skip
            else:
                out.write(f"## Not skipped\n\nEvery check runs: {why}.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
