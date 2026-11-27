"""Staging went red: the steps around the agent that tries to fix it (staging-autofix.yml). Two commands, neither holding
a model credential:

  plan   Reads the red run's failed jobs and steps, decides whether a fix is already in hand, and writes what the agent
         reads into a folder of the work tree: the failed log (the end of each failed step's), and the run's facts.
  guard  Reads what the agent changed and refuses a fix that loosens a check instead of fixing a cause: a file only a
         person may change (workflows, the agent guide, the ledger, the coverage exclusions, fixtures, generated files,
         the manifest), a check switched off, or a test that lost assertions.

Lewis, 23 November 2026: "can you make ci auto fix such bugs". The fixes it was asked after (#829, #832, #833, #837)
were each a red run on staging that a person read and fixed by hand.
"""
import argparse
import json
import os
import re
import subprocess
import sys

# What the fixer leaves to an author ("Generated files are never edited by hand"; "never change a fixture to pass";
# workflows, the guide and deploy settings, which a fix of a red run has no reason to touch).
PERSON_ONLY = [
    (re.compile(r"^\.github/"), "a workflow or CI script"),
    (re.compile(r"^(AGENTS|CLAUDE)\.md$"), "the agent guide"),
    (re.compile(r"^docs/(REQUIREMENTS|COVERAGE-EXCLUSIONS)\.md$"), "the requirements ledger or the coverage exclusions"),
    (re.compile(r"(^|/)(fixtures|testdata)/"), "a fixture"),
    (re.compile(r"(^|/)(wire\.zig|generated\.ts|_generated\.py|agent-api\.json)$"), "a generated file"),
    (re.compile(r"(^|/)Cargo\.lock$|(^|/)package-lock\.json$"), "a lockfile"),
    (re.compile(r"^\.deploy/"), "a deploy setting"),
]

# A line that switches a check off instead of passing it.
SWITCH_OFF = re.compile(r"#\[ignore|#\[allow\(|\.skip\(|@pytest\.mark\.skip|unittest\.skip|continue-on-error:\s*true|SkipZigTest")

# A line that asserts something in a test.
ASSERTS = re.compile(r"\bassert\w*!?\(|\bexpect\w*\(|self\.assert\w+\(|\bassert\b|\bpanic!\(|\bcheck\(|\.unwrap_err\(|std\.testing\.")

# The failed log the agent reads: the end of it, where the failure is.
LOG_LINES = 4000
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def gh(args):
    out = subprocess.run(["gh", *args], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:3])}: {out.stderr.strip()[:300]}")
    return out.stdout


def failures(jobs):
    """Each failed job's failed steps, as "Job :: Step"; a job that failed with no failed step is named alone."""
    out = []
    for job in jobs:
        if job.get("conclusion") != "failure":
            continue
        steps = [s["name"] for s in job.get("steps") or [] if s.get("conclusion") == "failure"]
        out.extend(f"{job['name']} :: {s}" for s in steps) if steps else out.append(job["name"])
    return out


def marker(signature):
    return f"<!-- autofix: {signature} -->"


def claimed(open_prs, signatures):
    """The signatures an open autofix pull request already works on (its body carries each one's marker)."""
    bodies = [pr.get("body") or "" for pr in open_prs]
    return [s for s in signatures if any(marker(s) in b for b in bodies)]


def plan(run_id, out_dir, repo, gh=gh):
    """What the agent is given, and whether it is asked at all: `act` false when nothing failed or every failure is in
    hand already."""
    run = json.loads(gh(["run", "view", str(run_id), "-R", repo, "--json", "workflowName,headSha,headBranch,event,url,jobs"]))
    sigs = [f"{run['workflowName']} / {f}" for f in failures(run.get("jobs") or [])]
    if not sigs:
        return {"act": False, "why": "no failed job"}
    prs = json.loads(gh(["pr", "list", "-R", repo, "--state", "open", "--label", "autofix", "--json", "number,body"]))
    taken = claimed(prs, sigs)
    left = [s for s in sigs if s not in taken]
    if not left:
        return {"act": False, "why": f"an open autofix pull request already works on: {'; '.join(taken)}"}
    os.makedirs(out_dir, exist_ok=True)
    log = ANSI.sub("", gh(["run", "view", str(run_id), "-R", repo, "--log-failed"]))
    lines = log.splitlines()
    with open(os.path.join(out_dir, "failed.log"), "w") as f:
        f.write("\n".join(lines[-LOG_LINES:]) + "\n")
    with open(os.path.join(out_dir, "run.md"), "w") as f:
        f.write(f"Run: {run['url']}\nCommit: {run['headSha']}\nFailed:\n" + "".join(f"- {s}\n" for s in left))
    return {"act": True, "signatures": left, "sha": run["headSha"], "url": run["url"], "branch": f"autofix/{run['headSha'][:9]}-{run_id}"}


def stopped(pr, repo, run_sha=None):
    """Why the fixer stays out: the only rules a failed run, a review or a person's ask are all held to."""
    owner, name = repo.split("/", 1)
    head_repo = f"{(pr.get('headRepositoryOwner') or {}).get('login', '')}/{(pr.get('headRepository') or {}).get('name', '')}"
    commits = pr.get("commits") or []
    by_fixer = [c for c in commits if "Autofix-Run:" in (c.get("messageBody") or "")]
    labels = {l.get("name") for l in pr.get("labels") or []}
    return (
        "the pull request isn't open" if pr.get("state") != "OPEN" else
        "a draft" if pr.get("isDraft") else
        "not into staging" if pr.get("baseRefName") != "staging" else
        "from another repository" if head_repo.lower() != f"{owner}/{name}".lower() else
        "labelled no-autofix" if labels & {"no-autofix", "no-steward"} else
        "a newer commit is on the branch" if run_sha and pr.get("headRefOid") != run_sha else
        "the last commit is the fixer's own: a person looks next" if commits and "Autofix-Run:" in (commits[-1].get("messageBody") or "") else
        f"the fixer has made {len(by_fixer)} commits here already" if len(by_fixer) >= 2 else
        None
    )


def plan_pr(run_id, pr_number, out_dir, repo, gh=gh):
    """A pull request's red run: whether the fixer may work on its branch, and what it reads. It may only on an open,
    ready pull request into staging from a branch of this repository, not labelled `no-autofix`, whose head is still the
    commit that failed, with fewer than two autofix commits and none on top; and only on what failed there and not on
    staging too (staging's own failures are staging's fixer's)."""
    run = json.loads(gh(["run", "view", str(run_id), "-R", repo, "--json", "workflowName,headSha,headBranch,event,url,jobs"]))
    fields = "number,state,isDraft,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,labels,commits"
    pr = json.loads(gh(["pr", "view", str(pr_number), "-R", repo, "--json", fields]))
    stop = stopped(pr, repo, run["headSha"])
    if stop:
        return {"act": False, "why": stop}
    mine = failures(run.get("jobs") or [])
    if not mine:
        return {"act": False, "why": "no failed job"}
    last = json.loads(gh(["run", "list", "-R", repo, "--workflow", run["workflowName"], "--branch", "staging", "--status", "completed", "-L", "1", "--json", "databaseId,conclusion"]))
    on_staging = []
    if last and last[0].get("conclusion") == "failure":
        on_staging = failures(json.loads(gh(["run", "view", str(last[0]["databaseId"]), "-R", repo, "--json", "jobs"])).get("jobs") or [])
    left = [f for f in mine if f not in on_staging]
    if not left:
        return {"act": False, "why": f"staging fails the same way: {'; '.join(mine)}"}
    os.makedirs(out_dir, exist_ok=True)
    log = ANSI.sub("", gh(["run", "view", str(run_id), "-R", repo, "--log-failed"]))
    with open(os.path.join(out_dir, "failed.log"), "w") as f:
        f.write("\n".join(log.splitlines()[-LOG_LINES:]) + "\n")
    with open(os.path.join(out_dir, "run.md"), "w") as f:
        f.write(f"Pull request: #{pr['number']}\nRun: {run['url']}\nCommit: {run['headSha']}\nFailed here and not on staging:\n" + "".join(f"- {run['workflowName']} / {x}\n" for x in left))
        if on_staging:
            f.write("Also failing on staging (not this pull request's to fix):\n" + "".join(f"- {x}\n" for x in on_staging if x in mine))
    return {"act": True, "signatures": [f"{run['workflowName']} / {x}" for x in left], "sha": run["headSha"], "url": run["url"], "branch": pr["headRefName"], "pr": pr["number"]}


def steer(pr_number, out_dir, repo, run_id=None, head=None, gh=gh):
    """PR Steward's ask: a failed run, a review's findings, or a person's dispatch. Held to the same rules as the
    fixer, and given the same context folder; a conflict with staging is reported, never merged."""
    fields = "number,state,isDraft,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,labels,commits,mergeable,title"
    pr = json.loads(gh(["pr", "view", str(pr_number), "-R", repo, "--json", fields]))
    reviewed = head
    if run_id:
        reviewed = json.loads(gh(["run", "view", str(run_id), "-R", repo, "--json", "headSha"]))["headSha"]
    # `stopped` refuses a commit that has moved on, so every ask below reads the branch as it stands.
    stop = stopped(pr, repo, reviewed or None)
    if stop:
        return {"act": False, "why": stop}
    if run_id:
        planned = plan_pr(run_id, pr_number, out_dir, repo, gh=gh)
        if not planned["act"]:
            return planned
    else:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, "run.md"), "w") as f:
            f.write(f"Pull request: #{pr['number']} — {pr.get('title') or ''}\nCommit: {pr['headRefOid']}\n")
            f.write("A person asked PR Steward to work on this pull request. Nothing failed: it is the request alone.\n")
        planned = {"act": True, "signatures": [], "url": "", "pr": pr["number"]}
    with open(os.path.join(out_dir, "run.md"), "a") as f:
        if pr.get("mergeable") == "CONFLICTING":
            f.write("\nThe branch conflicts with staging. A person merges it: do not merge or resolve it here.\n")
    planned.update({"sha": pr["headRefOid"], "branch": pr["headRefName"], "pr": pr["number"]})
    return planned


def changed(base, where="."):
    """The files the agent changed against `base` in the work tree `where`: each one's text at `base` (empty for a new
    file) and its diff with no context, leaving out the agent's own notes."""
    git = lambda *a: subprocess.run(["git", "-C", where, *a], capture_output=True, text=True)
    names = git("diff", "--name-only", base).stdout.split()
    untracked = git("ls-files", "--others", "--exclude-standard").stdout.split()
    out = {}
    for f in [n for n in names + untracked if not n.startswith(".autofix/")]:
        if f in untracked:
            try:
                with open(os.path.join(where, f), errors="replace") as fh:
                    text = fh.read()
            except OSError:
                text = ""
            out[f] = {"base": "", "diff": f"@@ -0,0 +1,{len(text.splitlines())} @@\n" + "".join(f"+{line}\n" for line in text.splitlines())}
            continue
        was = git("show", f"{base}:{f}")
        diff = git("diff", "-U0", base, "--", f).stdout
        out[f] = {"base": was.stdout if was.returncode == 0 else "", "diff": diff}
    return out


HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@")


def removed_lines(diff):
    """The lines a diff takes out, each with its number in the file it was taken from."""
    out, at = [], 0
    for line in diff.splitlines():
        m = HUNK.match(line)
        if m:
            at = int(m.group(1))
        elif line.startswith("-") and not line.startswith("---"):
            out.append((at, line[1:]))
            at += 1
    return out


def in_test(path, base, number):
    """Whether line `number` (from 1) of `path`, as it was, is test code: a test file, a Rust file's `#[cfg(test)]`
    module or `#[test]` function, or a Zig `test` block."""
    if re.search(r"(^|/)(tests/|test_[^/]*\.py$|[^/]*_test\.[a-z]+$|tests\.zig$)", path):
        return True
    lines = base.splitlines()[: max(number - 1, 0)]
    if path.endswith(".rs"):
        if any(re.match(r"\s*#\[cfg\(test\)\]", l) for l in lines):
            return True
        fns = [i for i, l in enumerate(lines) if re.match(r"\s*(pub(\(\w+\))?\s+)?(async\s+)?fn\s", l)]
        return bool(fns) and any(re.match(r"\s*#\[(tokio::)?test", l) for l in lines[max(fns[-1] - 3, 0) : fns[-1]])
    if path.endswith(".zig"):
        for l in reversed(lines):
            if re.match(r'test\s+"', l):
                return True
            if re.match(r"\S", l) and not l.startswith("//"):
                return False
    return False


def refusals(changes):
    """Why each file of a fix may not go in, by the rules above; none for a fix that may."""
    out = []
    for path, c in changes.items():
        for rule, what in PERSON_ONLY:
            if rule.search(path):
                out.append(f"{path}: {what} is changed only by a person")
                break
        diff = c["diff"]
        added = [l[1:] for l in diff.splitlines() if l.startswith("+") and not l.startswith("+++")]
        if any(SWITCH_OFF.search(l) for l in added):
            out.append(f"{path}: adds a line that switches a check off")
        taken = [t for n, t in removed_lines(diff) if ASSERTS.search(t) and in_test(path, c["base"], n)]
        if len(taken) > sum(bool(ASSERTS.search(l)) for l in added):
            out.append(f"{path}: takes assertions out of a test ({taken[0].strip()[:120]})")
    return out


def main(argv=None):
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    pl = sub.add_parser("plan")
    pl.add_argument("--run", required=True)
    pl.add_argument("--out", required=True)
    pl.add_argument("--repo", required=True)
    pl.add_argument("--pr", help="the pull request whose run failed; without it, staging's")
    gu = sub.add_parser("guard")
    gu.add_argument("--base", required=True)
    gu.add_argument("--dir", default=".", help="the work tree the agent changed")
    st = sub.add_parser("steer")
    st.add_argument("--pr", required=True)
    st.add_argument("--out", required=True)
    st.add_argument("--repo", required=True)
    st.add_argument("--run")
    st.add_argument("--head", help="the commit a review read, when a review is why the steward is asked")
    a = p.parse_args(argv)
    if a.cmd == "plan":
        try:
            r = plan_pr(a.run, a.pr, a.out, a.repo) if a.pr else plan(a.run, a.out, a.repo)
        except RuntimeError as e:
            r = {"act": False, "why": f"could not read the run: {e}"}
        print(f"AUTOFIX_PLAN {json.dumps(r)}")
        with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a") as f:
            f.write(f"act={'true' if r['act'] else 'false'}\n")
            for k in ("sha", "url", "branch", "pr"):
                if k in r:
                    f.write(f"{k}={r[k]}\n")
            f.write(f"signatures={json.dumps(r.get('signatures', []))}\n")
        return 0
    if a.cmd == "steer":
        try:
            r = steer(a.pr, a.out, a.repo, run_id=a.run, head=a.head)
        except RuntimeError as e:
            r = {"act": False, "why": f"could not read the pull request: {e}"}
        print(f"AUTOFIX_STEER {json.dumps(r)}")
        with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a") as f:
            f.write(f"act={'true' if r['act'] else 'false'}\n")
            for k in ("sha", "url", "branch", "pr", "why"):
                if k in r:
                    f.write(f"{k}={r[k]}\n")
        return 0
    diffs = changed(a.base, a.dir)
    if not diffs:
        print("AUTOFIX_GUARD nothing changed")
        with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a") as f:
            f.write("ok=false\n")
        return 0
    bad = refusals(diffs)
    for b in bad:
        print(f"AUTOFIX_REFUSED {b}")
    print(f"AUTOFIX_GUARD {'refused' if bad else 'ok'}: {len(diffs)} file(s): {', '.join(sorted(diffs))}")
    with open(os.environ.get("GITHUB_OUTPUT", os.devnull), "a") as f:
        f.write(f"ok={'false' if bad else 'true'}\n")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
