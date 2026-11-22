#!/usr/bin/env python3
"""Reject mutable action references in workflows and composite actions."""

from pathlib import Path
import re
import subprocess
import sys
import tempfile
import atexit
import shutil

ROOT = Path(__file__).resolve().parents[2]
# GitHub runs only the workflows in the repository's own .github/workflows. unbrowse-browser/.github is upstream
# agent-browser's, kept byte for byte (unbrowse-browser/FORK.md: no upstream file is changed), and nothing runs it
# here: test_pinned_actions.py holds that no workflow or action of ours calls into it.
WORKFLOW_DIRS = (ROOT / ".github/workflows",)
PIN = re.compile(r"^[^\s@]+@[0-9a-fA-F]{40}\s+#\s+\S.*$")
UPSTREAM_REPOS = {}
atexit.register(lambda: [shutil.rmtree(path, ignore_errors=True) for path, _ in UPSTREAM_REPOS.values() if path])


def check(path: Path) -> list[str]:
    errors = []
    for line_number, line in enumerate(path.read_text().splitlines(), 1):
        match = re.match(r"^\s*(?:-\s*)?uses:\s*(.*?)\s*$", line)
        if not match:
            continue
        ref = match.group(1)
        if ref.startswith("./"):
            continue
        if not PIN.fullmatch(ref):
            errors.append(f"{path.resolve().relative_to(ROOT) if path.resolve().is_relative_to(ROOT) else path.name}:{line_number}: mutable or invalid uses: {ref}")
    return errors


def action_files() -> list[Path]:
    tracked = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT).decode().split("\0")
    # OpenZeppelin is vendored as part of the settlement source; its Actions are not this repository's composite actions.
    vendored = "unbrowse-settlement/lib/openzeppelin-contracts/"
    return sorted(ROOT / name for name in tracked if Path(name).name in {"action.yml", "action.yaml"} and not name.startswith(vendored))


def upstream_has_commit(repo: str, sha: str, subpath: str) -> tuple[bool, str]:
    """Fetch upstream branches and tags without blobs, then require commit ancestry from one of those refs."""
    if repo not in UPSTREAM_REPOS:
        temp = tempfile.mkdtemp(prefix="pinned-action-")
        subprocess.run(["git", "init", "--bare", "--quiet", temp], check=True, capture_output=True, text=True)
        fetched = subprocess.run(
            ["git", "--git-dir", temp, "fetch", "--quiet", "--filter=blob:none", f"https://github.com/{repo}.git",
             "+refs/heads/*:refs/remotes/upstream/*", "+refs/tags/*:refs/tags/*"],
            capture_output=True, text=True,
        )
        UPSTREAM_REPOS[repo] = (temp, fetched.stderr.strip() if fetched.returncode else "")
    temp, fetch_error = UPSTREAM_REPOS[repo]
    if not temp:
        return False, fetch_error or "could not fetch upstream branches and tags"
    if fetch_error:
        return False, fetch_error
    commit = subprocess.run(["git", "--git-dir", temp, "cat-file", "-e", f"{sha}^{{commit}}"], capture_output=True)
    if commit.returncode:
        return False, "SHA is not present in the upstream repository"
    refs = subprocess.run(
        ["git", "--git-dir", temp, "for-each-ref", "--format=%(refname)", "refs/remotes/upstream", "refs/tags"],
        check=True, capture_output=True, text=True,
    ).stdout.splitlines()
    reachable = any(subprocess.run(
        ["git", "--git-dir", temp, "merge-base", "--is-ancestor", sha, ref], capture_output=True
    ).returncode == 0 for ref in refs)
    if not reachable:
        return False, "SHA is not reachable from an upstream branch or tag"
    if subpath:
        action_files = [f"{subpath}/action.yml", f"{subpath}/action.yaml"]
        if not any(subprocess.run(["git", "--git-dir", temp, "cat-file", "-e", f"{sha}:{item}"], capture_output=True).returncode == 0 for item in action_files):
            return False, "sub-path has no action.yml or action.yaml at the pinned commit"
    return True, ""


def check_upstream(path: Path) -> list[str]:
    errors = []
    for line_number, line in enumerate(path.read_text().splitlines(), 1):
        match = re.match(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)", line)
        if not match or match.group(1).startswith("./"):
            continue
        repo_ref = match.group(1)
        ref = repo_ref.rsplit("@", 1)[-1] if "@" in repo_ref else ""
        parts = repo_ref.rsplit("@", 1)[0].split("/") if "@" in repo_ref else []
        if len(parts) < 2 or not re.fullmatch(r"[0-9a-fA-F]{40}", ref):
            errors.append(f"{path.relative_to(ROOT)}:{line_number}: cannot verify upstream action reference: {repo_ref}")
            continue
        repo = "/".join(parts[:2])
        subpath = "/".join(parts[2:])
        try:
            exists, reason = upstream_has_commit(repo, ref, subpath)
        except (OSError, subprocess.SubprocessError) as error:
            exists, reason = False, str(error)
        if not exists:
            errors.append(f"{path.relative_to(ROOT)}:{line_number}: {repo}@{ref} does not resolve upstream: {reason}")
    return errors


def main() -> int:
    verify_upstream = "--verify-upstream" in sys.argv[1:]
    files = [path for directory in WORKFLOW_DIRS for path in sorted(directory.glob("*.y*ml"))] + action_files()
    files = sorted(set(files))
    errors = [error for path in files for error in check(path)]
    if verify_upstream:
        errors.extend(error for path in files for error in check_upstream(path))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("All actions use immutable commit SHAs or local paths." + ("; upstream SHAs verified." if verify_upstream else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
