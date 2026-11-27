#!/usr/bin/env python3
"""A pull request's CI report: one comment, rewritten whole from every finished run on its head commit (and, once it
merged, on its merge commit on staging), with each check's verdict, what failed and where, and its pictures.

    pr_report.py --repo unbrowse-ai/unbrowse-core --run <workflow run id>    # the run that just finished (pr-report.yml)
    pr_report.py --repo unbrowse-ai/unbrowse-core --pr <number> [--dry]      # by hand; --dry prints it instead

Rewritten whole, never patched, so two runs finishing together can't drop each other's section: whichever writes
last wrote everything. What the runs left is read as data: their JSON and Markdown are parsed and quoted, never run;
a mention in them can't ping anyone; a picture is put to the pictures worker (unbrowse-ci-shots) only as bytes it checks.

SHOTS_URL and SHOTS_KEY (pr-report.yml: vars.CI_SHOTS_URL, secrets.CI_SHOTS_KEY) are where the pictures go; without
them the report links each run's artifacts instead.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import hmac
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import io
import zipfile

MARKER = "<!-- unbrowse-ci-report -->"
# The runs a pull request's commit has, in the order the report shows them.
ON_THE_PR = ["PR agent checks", "PR check (no credential)", "CI", "Coverage", "Promotion gate"]
# The runs its merge commit gets on staging.
AFTER_MERGE = ["QA", "Gate bank", "Bank"]
# Workflows that upload artifacts matching READ; others (CI, Coverage, Promotion gate) never do.
HAS_ARTIFACTS = frozenset({"PR agent checks", "PR check (no credential)", "QA", "Gate bank", "Bank"})
# The artifacts worth reading, by name or prefix; the rest (builds, node logs) are never downloaded.
READ = ("qa-report-", "qa-screenshots", "qa-mcp-check", "qa-skill-triggers", "gate-bank-slice", "gate-bank-full", "bank")
LIMIT = 62000  # GitHub's comment limit is 65 536 characters
# Cloudflare turns Python's own user agent away (403, before the worker sees it): every picture was refused so.
AGENT = "unbrowse-ci-report"


# ---------------------------------------------------------------------------------------------------------- GitHub
def gh(args: list[str]) -> str:
    out = subprocess.run(["gh", *args], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:3])}: {out.stderr.strip()[:300]}")
    return out.stdout


def api(path: str, **kw) -> object:
    args = ["api", path]
    for k, v in kw.items():
        args += ["-f" if isinstance(v, str) else "-F", f"{k}={v}"]
    return json.loads(gh(args) or "null")


def pull_of_run(repo: str, run_id: int) -> tuple[int | None, str]:
    """The pull request a finished run reports to: its own, or for a push to staging the one whose merge it is."""
    run = api(f"repos/{repo}/actions/runs/{run_id}")
    named = run.get("pull_requests") or []
    if named:
        return named[0]["number"], "its pull request"
    for pr in api(f"repos/{repo}/commits/{run['head_sha']}/pulls") or []:
        return pr["number"], "the pull request this commit is from"
    return None, "no pull request names the run's commit"


def latest_runs(repo: str, sha: str, names: list[str]) -> list[dict]:
    """The newest run of each named workflow on one commit."""
    runs = api(f"repos/{repo}/actions/runs?head_sha={sha}&per_page=100").get("workflow_runs") or []
    newest: dict[str, dict] = {}
    for r in runs:
        if r["name"] in names and (r["name"] not in newest or r["run_attempt"] > newest[r["name"]]["run_attempt"] or r["id"] > newest[r["name"]]["id"]):
            newest[r["name"]] = r
    return [newest[n] for n in names if n in newest]


def failed_jobs(repo: str, run_id: int) -> list[dict]:
    jobs = api(f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100").get("jobs") or []
    return [{"job": j["name"], "url": j["html_url"], "steps": [s["name"] for s in j.get("steps") or [] if s.get("conclusion") == "failure"]}
            for j in jobs if j.get("conclusion") == "failure"]


def fetch_zip(repo: str, artifact_id: int) -> bytes:
    """One artifact's zip, by its id."""
    out = subprocess.run(["gh", "api", f"repos/{repo}/actions/artifacts/{artifact_id}/zip"], capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(f"artifact {artifact_id}: {out.stderr.decode(errors='replace').strip()[:300]}")
    return out.stdout


def download(repo: str, run_id: int, into: pathlib.Path) -> list[str]:
    """The run's readable artifacts, each in a folder of its name. Of several with one name (a rerun leaves one per
    attempt) the newest is read. Returns the names of those it couldn't read. An entry that would land outside its
    folder is skipped: an artifact is data a run wrote."""
    arts = api(f"repos/{repo}/actions/runs/{run_id}/artifacts?per_page=100").get("artifacts") or []
    newest: dict[str, dict] = {}
    for a in arts:
        if a.get("expired") or not a["name"].startswith(READ):
            continue
        if a["name"] not in newest or (a.get("created_at") or "", a["id"]) > (newest[a["name"]].get("created_at") or "", newest[a["name"]]["id"]):
            newest[a["name"]] = a
    def _one(item: tuple[str, dict]) -> str | None:
        name, a = item
        dest = (into / name).resolve()
        try:
            with zipfile.ZipFile(io.BytesIO(fetch_zip(repo, a["id"]))) as z:
                for entry in z.infolist():
                    target = (dest / entry.filename).resolve()
                    if entry.is_dir() or not str(target).startswith(str(dest) + os.sep):
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(z.read(entry))
            return None
        except (RuntimeError, zipfile.BadZipFile, OSError):
            return name

    items = list(newest.items())
    if len(items) <= 1:
        skipped = [name for item in items if (name := _one(item)) is not None]
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(items))) as pool:
            skipped = [name for name in pool.map(_one, items) if name is not None]
    return skipped


def post(repo: str, pr: int, body: str) -> str:
    """The one report comment on the pull request, written over in place; made if there is none yet."""
    page = 1
    while True:
        comments = api(f"repos/{repo}/issues/{pr}/comments?per_page=100&page={page}") or []
        for c in comments:
            if MARKER in (c.get("body") or "") and (c.get("user") or {}).get("type") == "Bot":
                gh(["api", "-X", "PATCH", f"repos/{repo}/issues/comments/{c['id']}", "-f", f"body={body}"])
                return f"updated {c['html_url']}"
        if len(comments) < 100:
            break
        page += 1
    made = json.loads(gh(["api", "-X", "POST", f"repos/{repo}/issues/{pr}/comments", "-f", f"body={body}"]))
    return f"made {made['html_url']}"


# -------------------------------------------------------------------------------------------------------- pictures
class Pictures:
    """Puts a picture to the pictures worker once and names its address; None without the worker or on its refusal."""

    def __init__(self, base: str | None, key: str | None, run_key: str):
        self.base, self.key = (base or "").rstrip("/"), key
        # Keyed with the secret, so the address can't be worked out from the pull request's number.
        self.run = hmac.new(key.encode(), run_key.encode(), hashlib.sha256).hexdigest()[:32] if base and key else ""
        self.failed = 0
        self._lock = threading.Lock()
        self._cache: dict[str, str | None] = {}

    def prefetch(self, paths: list[pathlib.Path]) -> None:
        """Warm the upload cache concurrently for a batch of picture paths."""
        if not self.run:
            return
        unique = [p for p in dict.fromkeys(paths) if p and p.is_file()]
        if len(unique) <= 1:
            for p in unique:
                self(p)
            return
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, len(unique))) as pool:
            list(pool.map(self, unique))

    def __call__(self, path: pathlib.Path | None) -> str | None:
        if not self.run or not path or not path.is_file() or path.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp"):
            return None
        # Named by what it shows: a picture a later commit changed gets its own address, one it didn't is put once.
        data = path.read_bytes()
        name = hashlib.sha256(data).hexdigest()[:24] + (".jpg" if path.suffix.lower() == ".jpeg" else path.suffix.lower())
        with self._lock:
            if name in self._cache:
                return self._cache[name]
        url = f"{self.base}/s/{self.run}/{name}"
        try:
            urllib.request.urlopen(urllib.request.Request(url, method="HEAD", headers={"user-agent": AGENT}), timeout=15)
            with self._lock:
                self._cache[name] = url
            return url
        except urllib.error.HTTPError as e:
            if e.code != 404:
                with self._lock:
                    self.failed += 1
                return None
        except OSError:
            with self._lock:
                self.failed += 1
            return None
        kind = {".png": "image/png", ".webp": "image/webp"}.get(path.suffix.lower(), "image/jpeg")
        req = urllib.request.Request(url, data=data, method="PUT",
                                     headers={"authorization": f"Bearer {self.key}", "content-type": kind, "user-agent": AGENT})
        try:
            urllib.request.urlopen(req, timeout=30)
            with self._lock:
                self._cache[name] = url
            return url
        except OSError:
            with self._lock:
                self.failed += 1
            return None


# ------------------------------------------------------------------------------------------------------- the report
def quiet(text: object, n: int = 0) -> str:
    """Text from a run, safe in a table cell: one line, no table break, no tag, no mention that pings."""
    t = " ".join(str(text or "").split())
    t = t.replace("|", "\\|").replace("<", "&lt;").replace(">", "&gt;").replace("@", "&#64;")
    return (t[: n - 1] + "…") if n and len(t) > n else t


def quoted(md: str) -> str:
    """A Markdown file a run wrote, kept as Markdown but unable to ping, draw HTML or close the block it sits in."""
    return md.replace("@", "&#64;").replace("<", "&lt;").replace(">", "&gt;").strip()


def mark(ok: bool | None) -> str:
    return "✅" if ok else ("❌" if ok is False else "⏳")


def concluded(run: dict) -> bool | None:
    if run.get("status") != "completed":
        return None
    return run.get("conclusion") in ("success", "skipped", "neutral")


def picture_cell(url: str | None) -> str:
    return f'<a href="{url}"><img src="{url}" width="280"></a>' if url else ""


def read_json(p: pathlib.Path) -> object:
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return None


def qa_section(arts: pathlib.Path, picture) -> str:
    """Claude QA: each check, failures first, with what the agent wrote and its picture."""
    checks = []
    for v in sorted(arts.glob("qa-report-*/qa-verdict.json")):
        for c in (read_json(v) or {}).get("checks") or []:
            checks.append(dict(c, shard=v.parent.name))
    if not checks:
        return ""
    shots = arts / "qa-screenshots"
    by_n = {c.get("n"): c.get("shot") for c in ((read_json(shots / "shots.json") or {}).get("checks") or [])}

    def pic_path(c):
        name = by_n.get(c.get("n")) or pathlib.Path(str(c.get("shot") or "")).name
        for p in (shots / name if name else None, arts / c["shard"] / "shots" / name if name else None):
            if p and p.is_file():
                return p
        return None

    if hasattr(picture, "prefetch"):
        picture.prefetch([p for c in checks if (p := pic_path(c)) is not None])

    def pic(c):
        p = pic_path(c)
        return picture(p) if p else None

    bad = [c for c in checks if c.get("result") != "pass"]
    good = [c for c in checks if c.get("result") == "pass"]
    head = "| Check | Result | What the agent read | Picture |\n| --- | --- | --- | --- |\n"
    row = lambda c: f"| {quiet(c.get('n'))} | {mark(c.get('result') == 'pass') if c.get('result') in ('pass', 'fail') else quiet(c.get('result'))} {quiet(c.get('result'))} | {quiet(c.get('note'), 300)} | {picture_cell(pic(c))} |\n"
    out = f"**Claude QA: {len(good)} of {len(checks)} checks pass.**\n\n"
    if bad:
        out += head + "".join(row(c) for c in sorted(bad, key=lambda c: c.get("n") or 0)) + "\n"
    if good:
        out += f"<details><summary>{len(good)} passing</summary>\n\n" + head + "".join(row(c) for c in sorted(good, key=lambda c: c.get("n") or 0)) + "\n</details>\n"
    return out


def mcp_section(arts: pathlib.Path, picture) -> str:
    """The MCP check (no model): each step, failures first, with its picture."""
    report = read_json(arts / "qa-mcp-check" / "mcp-check.json")
    if not isinstance(report, dict) or not report.get("steps"):
        return ""
    steps = report["steps"]
    shots = arts / "qa-mcp-check" / "shots"
    if hasattr(picture, "prefetch"):
        picture.prefetch([shots / s["shot"] for s in steps if s.get("shot")])
    bad = [s for s in steps if not s.get("pass")]
    good = [s for s in steps if s.get("pass")]
    head = "| Part | Step | Result | Note | Picture |\n| --- | --- | --- | --- | --- |\n"

    def row(s):
        why = "; ".join(str(p) for p in s.get("problems") or [])
        pic = picture(shots / s["shot"]) if s.get("shot") else None
        return f"| {quiet(s.get('part'))} | {quiet(s.get('id'))} | {mark(bool(s.get('pass')))} | {quiet(why or s.get('note'), 260)} | {picture_cell(pic)} |\n"

    out = f"**MCP check: {len(good)} of {len(steps)} steps pass**, no model in the loop.\n\n"
    if bad:
        out += head + "".join(row(s) for s in bad) + "\n"
    if good:
        out += f"<details><summary>{len(good)} passing</summary>\n\n" + head + "".join(row(s) for s in good) + "\n</details>\n"
    return out


def md_section(arts: pathlib.Path, pattern: str, title: str, open_when: str | None = None) -> str:
    """A report a run wrote as Markdown, quoted under a fold; shown open when it holds `open_when` (its own word for a
    failure), so the reason a run is red is never folded away."""
    found = sorted(arts.glob(pattern))
    if not found:
        return ""
    body = "\n\n".join(quoted(p.read_text(errors="replace")) for p in found)
    if open_when and open_when in body:
        return f"{body}\n\n"
    return f"<details><summary>{title}</summary>\n\n{body}\n\n</details>\n"


def run_section(run: dict, failed: list[dict], arts: pathlib.Path, picture) -> str:
    ok = concluded(run)
    out = f"### {mark(ok)} {quiet(run['name'])} · [{quiet(run.get('conclusion') or run.get('status'))}]({run['html_url']})\n\n"
    for f in failed:
        steps = ", ".join(f"*{quiet(s)}*" for s in f["steps"]) or "no step failed (a job it needed did)"
        out += f"- ❌ **{quiet(f['job'])}**: {steps} · [log]({f['url']})\n"
    if failed:
        out += "\n"
    out += mcp_section(arts, picture)
    out += md_section(arts, "qa-mcp-check/attack/attack.md", "Attack bank", open_when="**FAILED:**")
    out += qa_section(arts, picture)
    out += md_section(arts, "qa-skill-triggers/skill-trigger.md", "Skill triggers")
    out += md_section(arts, "gate-bank-*/verdict.md", "The gate's verdict")
    out += md_section(arts, "gate-bank-*/score.md", "The gate, task by task")
    out += md_section(arts, "bank/*.md", "The bank")
    return out


def render(pr: dict, groups: list[tuple[str, str, list[dict]]], arts: dict[int, pathlib.Path], failed: dict[int, list], picture,
           note: str = "") -> str:
    """The whole comment. `groups`: (title, commit, runs). Pure: everything it says is in its arguments."""
    out = f"{MARKER}\n## CI report · `{pr['head'][:9]}`\n\n"
    out += "| Run | Commit | Result |\n| --- | --- | --- |\n"
    for title, sha, runs in groups:
        for r in runs:
            out += f"| [{quiet(r['name'])}]({r['html_url']}) | {title} `{sha[:9]}` | {mark(concluded(r))} {quiet(r.get('conclusion') or r.get('status'))} |\n"
    out += "\n"
    for title, sha, runs in groups:
        if not runs:
            continue
        out += f"## {title} `{sha[:9]}`\n\n"
        for r in runs:
            out += run_section(r, failed.get(r["id"], []), arts.get(r["id"], pathlib.Path("/nonexistent")), picture)
            out += "\n"
    tail = f"\n<sub>Rewritten after each run on this pull request's commits by `pr-report.yml`. Pictures are kept 14 days. {quiet(note)}</sub>\n"
    if len(out) + len(tail) > LIMIT:
        out = out[: LIMIT - len(tail) - 200] + "\n\n…cut: the report outgrew a comment. Each run's summary has the rest.\n"
    return out + tail


# ------------------------------------------------------------------------------------------------------------ main
def gather(repo: str, number: int, into: pathlib.Path, picture) -> str:
    pr = api(f"repos/{repo}/pulls/{number}")
    head = pr["head"]["sha"]
    groups = [("this pull request's", head, latest_runs(repo, head, ON_THE_PR))]
    if pr.get("merged_at") and pr.get("merge_commit_sha"):
        groups.append(("after the merge, on staging,", pr["merge_commit_sha"], latest_runs(repo, pr["merge_commit_sha"], AFTER_MERGE)))
    arts, failed, skipped = {}, {}, []
    completed = [r for _, _, runs in groups for r in runs if r.get("status") == "completed"]

    def _fetch_run(r: dict) -> tuple[int, list[dict], pathlib.Path | None, list[str]]:
        rid = r["id"]
        # Green, skipped, or neutral runs have no failed jobs to list.
        run_failed = [] if r.get("conclusion") in ("success", "skipped", "neutral") else failed_jobs(repo, rid)
        if r.get("name") in HAS_ARTIFACTS:
            dest = into / str(rid)
            run_skipped = download(repo, rid, dest)
            return rid, run_failed, dest, run_skipped
        return rid, run_failed, None, []

    if len(completed) <= 1:
        results = [_fetch_run(r) for r in completed]
    else:
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(6, len(completed))) as pool:
            results = list(pool.map(_fetch_run, completed))
    for rid, run_failed, dest, run_skipped in results:
        failed[rid] = run_failed
        if dest is not None:
            arts[rid] = dest
        skipped += run_skipped
    note = f"Not read: {', '.join(skipped)}." if skipped else ""
    body = render({"head": head}, groups, arts, failed, picture, note)
    if getattr(picture, "failed", 0):
        body = body.replace("</sub>", f" {picture.failed} picture(s) could not be put, so they are missing above.</sub>")
    return body


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    p.add_argument("--run", type=int)
    p.add_argument("--pr", type=int)
    p.add_argument("--dry", action="store_true", help="print the comment instead of posting it")
    a = p.parse_args(argv)
    number, why = (a.pr, "named") if a.pr else pull_of_run(a.repo, a.run)
    if not number:
        print(f"PR_REPORT_NONE {why}")
        return 0
    with tempfile.TemporaryDirectory() as d:
        picture = Pictures(os.environ.get("SHOTS_URL"), os.environ.get("SHOTS_KEY"), f"{a.repo}#{number}")
        body = gather(a.repo, number, pathlib.Path(d), picture)
    if a.dry:
        print(body)
        return 0
    print(f"PR_REPORT #{number}: {post(a.repo, number, body)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
