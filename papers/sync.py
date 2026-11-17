#!/usr/bin/env python3
"""Keep papers/ a byte-for-byte copy of unbrowse-papers' built files.

The papers are the design and live in lekt9/unbrowse-papers. This folder holds copies of their built output (numbers
filled in from protocol/params.toml), never hand edits. SOURCE.json names the papers commit the copies came from and
the sha256 of every copy.

    python3 -I papers/sync.py sync <papers checkout> [--ref origin/staging]
        copy every mapped file from <ref> into papers/ and rewrite SOURCE.json
    python3 -I papers/sync.py check
        every copy matches SOURCE.json (no hand edits, nothing missing); prints PAPERS_SYNC_PASSED
    python3 -I papers/sync.py check --upstream <papers checkout> [--ref origin/staging]
        also: SOURCE.json's commit is <ref>'s tip, so the copies are current; prints PAPERS_UPSTREAM_PASSED

CI runs `check` (the papers repository is private). Run `check --upstream` before a release and after any papers
merge; `sync` fixes what it reports.
"""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE / "SOURCE.json"
REPO = "lekt9/unbrowse-papers"

# copy in core papers/  <-  path in unbrowse-papers
FILES = {
    "abstract.md": "papers/build/abstract.md",
    "abstract.pdf": "papers/build/abstract.pdf",
    "whitepaper.md": "papers/build/whitepaper.md",
    "whitepaper.pdf": "papers/build/whitepaper.pdf",
    "economy.md": "papers/build/economy.md",
    "economy.pdf": "papers/build/economy.pdf",
    "selection.md": "papers/build/selection.md",
    "selection.pdf": "papers/build/selection.pdf",
    "protocol.md": "protocol/build/spec.md",
    "protocol.pdf": "protocol/build/spec.pdf",
    "params.toml": "protocol/params.toml",
    "mining-the-machine-web.pdf": "arxiv/main.pdf",
    "internal-apis-drift.pdf": "paper/internal-apis-maintenance.pdf",
}

# Kept here on purpose, not copied: the paper as published on arXiv (2604.00694). The papers repository holds a later
# draft (arxiv/internal-apis-v2), which is not what arXiv serves.
FROZEN = {"internal-apis-are-all-you-need.pdf": "arXiv:2604.00694 as published"}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git(checkout, *args):
    return subprocess.run(["git", "-C", str(checkout), *args], check=True, capture_output=True).stdout


def resolve(checkout, ref):
    return git(checkout, "rev-parse", ref).decode().strip()


def sync(checkout, ref):
    commit = resolve(checkout, ref)
    files = {}
    for copy, src in FILES.items():
        data = git(checkout, "show", f"{commit}:{src}")
        (HERE / copy).write_bytes(data)
        files[copy] = {"from": src, "sha256": sha256(data)}
    for copy in FROZEN:
        files[copy] = {"from": None, "frozen": FROZEN[copy], "sha256": sha256((HERE / copy).read_bytes())}
    SOURCE.write_text(json.dumps({"repo": REPO, "ref": ref, "commit": commit, "files": files}, indent=2) + "\n")
    print(f"synced {len(FILES)} files from {REPO} {ref} at {commit[:10]}")


def check(upstream=None, ref="origin/staging"):
    if not SOURCE.exists():
        sys.exit("papers/SOURCE.json missing: run `python3 -I papers/sync.py sync <papers checkout>`")
    source = json.loads(SOURCE.read_text())
    bad = []
    for copy in sorted(set(FILES) | set(FROZEN)):
        entry = source["files"].get(copy)
        path = HERE / copy
        if entry is None:
            bad.append(f"{copy}: not in SOURCE.json")
        elif not path.exists():
            bad.append(f"{copy}: missing")
        elif sha256(path.read_bytes()) != entry["sha256"]:
            bad.append(f"{copy}: edited by hand (differs from {REPO} {source['commit'][:10]}:{entry['from']})")
        elif copy in FILES and entry["from"] != FILES[copy]:
            bad.append(f"{copy}: SOURCE.json maps it from {entry['from']}, sync.py from {FILES[copy]}")
    for copy in source["files"]:
        if copy not in FILES and copy not in FROZEN:
            bad.append(f"{copy}: in SOURCE.json but not mapped in sync.py")
    for path in HERE.iterdir():
        if path.suffix in (".md", ".pdf", ".toml") and path.name not in FILES and path.name not in FROZEN \
                and path.name not in ("README.md",):
            bad.append(f"{path.name}: in papers/ but neither copied nor frozen")
    if bad:
        print("\n".join(bad))
        sys.exit(f"PAPERS_SYNC_FAILED ({len(bad)}): run `python3 -I papers/sync.py sync <papers checkout>`")
    print(f"PAPERS_SYNC_PASSED {len(source['files'])} files at {REPO} {source['commit'][:10]}")
    if upstream:
        tip = resolve(upstream, ref)
        if tip != source["commit"]:
            behind = git(upstream, "log", "--oneline", f"{source['commit']}..{tip}").decode().strip()
            print(behind)
            sys.exit(f"PAPERS_UPSTREAM_FAILED: copies are from {source['commit'][:10]}, {ref} is at {tip[:10]}")
        print(f"PAPERS_UPSTREAM_PASSED {ref} at {tip[:10]}")


def main(argv):
    if len(argv) < 1 or argv[0] not in ("sync", "check"):
        sys.exit(__doc__)
    ref = "origin/staging"
    if "--ref" in argv:
        ref = argv[argv.index("--ref") + 1]
    if argv[0] == "sync":
        if len(argv) < 2:
            sys.exit(__doc__)
        sync(Path(argv[1]), ref)
    else:
        upstream = Path(argv[argv.index("--upstream") + 1]) if "--upstream" in argv else None
        check(upstream, ref)


if __name__ == "__main__":
    main(sys.argv[1:])
