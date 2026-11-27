#!/usr/bin/env python3
"""Which pull request a review is for, and whether it is asked for at all.

The review workflow starts on a credential-free signal (.github/workflows/opencode-review.yml), never on the pull
request itself: a workflow that holds a model credential takes no `pull_request` trigger in this repository. This
reads the pull request from GitHub and applies Claude Ship's rules for when a review runs:

  off     no automatic review; a person's dispatch still runs one
  manual  only a person's dispatch, or a pull request labelled `review`
  push    every push (the default); a pull request labelled `no-review` is left alone

A draft and a pull request from a fork get no automatic review, as in Claude Ship. A dispatch may review a draft (the
equivalent of commenting `@claude review`), never a fork.

    review_plan.py --repo o/r --mode push --run 12345
    review_plan.py --repo o/r --mode manual --pr 12 --dispatch
"""
import argparse
import json
import os
import subprocess
import sys


def gh(args):
    out = subprocess.run(["gh", *args], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:3])}: {out.stderr.strip()[:300]}")
    return out.stdout


def pull_for_run(run_id, repo, gh=gh):
    """The pull request a workflow run belongs to: named by the run, else found by its head commit."""
    # The REST run carries `pull_requests`; `gh run view --json` has no such field and refuses the whole ask.
    run = json.loads(gh(["api", f"repos/{repo}/actions/runs/{run_id}"]))
    if run.get("event") != "pull_request":
        return None, "the run is not a pull request's"
    named = run.get("pull_requests") or []
    if named:
        return named[0]["number"], None
    found = json.loads(gh(["api", f"repos/{repo}/commits/{run['head_sha']}/pulls"]))
    return (found[0]["number"], None) if found else (None, "no pull request names the run's commit")


def decide(pr, mode, dispatch, repo, gh=gh):
    """`act` and why, from the pull request as GitHub holds it now (the API's shape)."""
    head = (pr.get("head") or {}).get("sha")
    labels = {l["name"] for l in pr.get("labels") or []}
    owner, name = repo.split("/", 1)
    head_repo = ((pr.get("head") or {}).get("repo") or {}).get("full_name") or ""
    why = (
        "the pull request is closed" if pr.get("state") != "open" else
        "it comes from a fork" if head_repo.lower() != f"{owner}/{name}".lower() else
        "it is not into staging or main" if (pr.get("base") or {}).get("ref") not in ("staging", "main") else
        "it is labelled no-review" if "no-review" in labels else
        "the review setting is off" if mode == "off" and not dispatch else
        "the review setting is manual: dispatch it or add the `review` label"
        if mode == "manual" and not dispatch and "review" not in labels else
        "it is a draft" if pr.get("draft") and not dispatch else
        None
    )
    if why:
        return {"act": False, "why": why, "pr": pr["number"], "head": head}
    return {"act": True, "pr": pr["number"], "head": head, "branch": (pr.get("head") or {}).get("ref"),
            "base": (pr.get("base") or {}).get("ref"), "draft": bool(pr.get("draft")), "labels": sorted(labels)}


def already(pr_number, head, repo, gh=gh):
    """Whether a review already ran on this exact commit: a neutral `Code review` check run on the head."""
    runs = json.loads(gh(["api", f"repos/{repo}/commits/{head}/check-runs?per_page=100"])).get("check_runs") or []
    return any(r.get("name") == "Code review" and r.get("status") == "completed" for r in runs)


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--repo", required=True)
    p.add_argument("--mode", default="push", choices=["off", "manual", "push"])
    p.add_argument("--pr", type=int)
    p.add_argument("--run", type=int)
    p.add_argument("--dispatch", action="store_true")
    a = p.parse_args(argv)
    number, why = (a.pr, None) if a.pr else pull_for_run(a.run, a.repo)
    if not number:
        result = {"act": False, "why": why or "no pull request"}
    else:
        try:
            pr = json.loads(gh(["api", f"repos/{a.repo}/pulls/{number}"]))
            result = decide(pr, a.mode, a.dispatch, a.repo)
            if result["act"] and not a.dispatch and already(number, result["head"], a.repo):
                result = {"act": False, "why": "a review already ran on this commit", "pr": number, "head": result["head"]}
        except RuntimeError as e:
            result = {"act": False, "why": f"could not read the pull request: {e}"}
    print(f"REVIEW_PLAN {json.dumps(result)}")
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a") as f:
        f.write(f"act={'true' if result['act'] else 'false'}\n")
        for k in ("pr", "head", "branch", "base", "draft", "why"):
            if k in result:
                f.write(f"{k}={result[k]}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
