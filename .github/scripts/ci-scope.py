#!/usr/bin/env python3
"""Which of CI's long jobs a change can reach, and which of them already passed on these very files (ci.yml and
coverage.yml, job `scope`).

Reads the changed paths, one per line, on stdin (a renamed file's old path is a changed path too) and writes one
`<job>=true|false` line per long job, for $GITHUB_OUTPUT, then the reason for each on stderr.

Two kinds of job. The settlement and window jobs read a closed set of folders, each named below with what reads it,
so they run when a file in that set changed. The Rust jobs (engine, node, elsewhere) read across the repository
(the node's tests read docs/, test-banks/, the SDKs, the plugins and the telemetry schema), so a path the table
doesn't name runs all three; only a path the table says they can't read leaves them out.

Every job runs for a change to .github/, an empty list or one that was cut short (`--complete false`), and anything
but a pull request: a push to a branch, a manual run (`--event`). The short jobs are not in the table: they always
run, since each takes under a minute.

A job that reads a closed set of files and nothing else (READS) has a second way out, on a push as on a pull request:
`--keys` prints one key per such job, the hash of git's own names for every file it reads, and the job records a pass
under that key when it ends well (an Actions cache entry `passed-<job>-<key>`). `--passed <folder>` then leaves out a
job whose key has a pass on record, since the same bytes give the same answer: the route-coin spec runs fixed seeds, and
the contracts' fuzz tests, which draw fresh ones, get them nightly (fresh-seeds.yml). GitHub keeps a pass a pull
request recorded to that pull request; only a push to staging records one every run can read.

Prove a change to the tables with `python3 -I .github/scripts/test/test_ci_scope.py`.
"""
import argparse
import hashlib
import pathlib
import subprocess
import sys

# Each long job, as ci.yml names its `if:` output.
JOBS = ("settlement", "spec", "engine", "node", "elsewhere", "window")
RUST = {"engine", "node", "elsewhere"}
# The contracts' tests (forge) and the Quint spec of them.
CONTRACTS = {"settlement", "spec"}
ALL = set(JOBS)

# First match wins, so a deeper prefix comes before the folder it sits in. A path no prefix matches reaches RUST.
TABLE = (
    # The workflows, their scripts and their pinned tools: what every job is.
    (".github/", ALL),
    # The node embeds these artifacts and the runtime manifest; the settlement job checks they are this build's.
    ("unbrowse-node/app/contracts/", {"settlement", "node", "elsewhere"}),
    # The window's icon is the app's (unbrowse-node/window/build.zig).
    ("unbrowse-node/app/icons/", {"node", "elsewhere", "window"}),
    # The window is a zig build of its own (build.zig reads src/ and the icons above): the window job tests it, the
    # builds elsewhere build it.
    ("unbrowse-node/window/", {"window", "elsewhere"}),
    # The browser engine the node links and the browser's CLI writes its capture log with: the engine job tests it.
    ("unbrowse-node/crates/browser/", RUST),
    ("unbrowse-node/", {"node", "elsewhere"}),
    # The node builds on the browser's engine, its tests drive the browser's CLI, and the CLI embeds the dashboard.
    ("unbrowse-browser/", RUST),
    # The contracts and their spec. Forge reads no file outside this folder (foundry.toml grants no fs_permissions),
    # and no Rust or zig reads it.
    ("unbrowse-settlement/", CONTRACTS),
    # The Antithesis harness reads the contracts' ABIs, and builds the node with features of its own.
    ("antithesis/", {"settlement"} | RUST),
    # The papers are checked by a short job; nothing long reads them.
    ("papers/", set()),
)


# Every file a job reads, for the jobs that read a closed set: the same files give the same key, whatever commit they
# are in. The workflow and this script are in each set, so a change to how the job runs, or to these tables, runs it
# again. Each path must reach its job in TABLE (test_ci_scope.py), or a pull request could leave out a job whose files
# it changed.
READS = {
    # `forge test` reads foundry.toml, src, test, script and lib; the checks after it read the artifacts the node
    # embeds and the Antithesis harness (ci.yml, job `settlement`).
    "settlement": ("unbrowse-settlement/foundry.toml", "unbrowse-settlement/src", "unbrowse-settlement/test",
                   "unbrowse-settlement/script", "unbrowse-settlement/lib", "unbrowse-node/app/contracts",
                   "antithesis/test", ".github/workflows/ci.yml", ".github/scripts/ci-scope.py"),
    # check.sh and traces.sh read spec/coins and write the trace fixtures the job then compares.
    "spec": ("unbrowse-settlement/spec", "unbrowse-settlement/test/coins/fixtures/quint",
             ".github/workflows/ci.yml", ".github/scripts/ci-scope.py"),
}


# Folders whose changes cannot affect the node binary, browser engine, CLI, window, skills, SDKs or QA harness.
# Only when EVERY changed path in a complete pull-request diff lives under one of these prefixes may PR QA skip.
QA_SKIP_PREFIXES = (
    "papers/",
    "unbrowse-settlement/",
    "docs/",
    "unbrowse-telemetry/",
    "unbrowse-rpc/",
    "unbrowse-dashboard/",
    "antithesis/",
)


def reaches(path):
    """The jobs a changed path can reach."""
    return next((jobs for prefix, jobs in TABLE if path.startswith(prefix)), RUST)


def qa_scope(paths, event):
    """(runs, reason) for whether pull-request QA (MCP check, Claude QA, skill triggers, gate slice) must run."""
    if event != "pull_request":
        return True, f"a {event} runs QA"
    if not paths:
        return True, "no full list of changed files, so QA runs"
    for path in paths:
        if not path.startswith(QA_SKIP_PREFIXES):
            return True, f"{path} can affect the node, browser, window, skills or QA harness"
    return False, f"all {len(paths)} changed file(s) are outside the node, browser, window, skills and QA harness"


def scope(paths, event, passed=None):
    """{job: (runs, reason)} for these changed paths under this event. `passed` is {job: where it passed} for the jobs
    whose files, as they are now, have a pass on record: such a job is left out under any event."""
    if event != "pull_request":
        out = {job: (True, f"a {event} runs every job") for job in JOBS}
    elif not paths:
        out = {job: (True, "no full list of changed files, so every job runs") for job in JOBS}
    else:
        reached = {job: [] for job in JOBS}
        for path in paths:
            for job in reaches(path):
                reached[job].append(path)
        out = {
            job: (True, f"{hits[0]} reaches it" + (f" (and {len(hits) - 1} more)" if len(hits) > 1 else ""))
            if hits else (False, "no changed file reaches it")
            for job, hits in reached.items()
        }
    for job, where in (passed or {}).items():
        if job in READS and out[job][0]:
            out[job] = (False, f"every file it reads already passed{f' ({where})' if where else ''}")
    return out


def key(job, root="."):
    """The key of a job in READS: the hash of git's listing (mode, blob hash, path) of every file it reads at HEAD.
    Raises when git can't list them or a path is gone, so a job is never left out on a key of nothing."""
    listed = subprocess.run(["git", "ls-tree", "-r", "HEAD", "--", *READS[job]], cwd=root, check=True,
                            stdout=subprocess.PIPE).stdout
    paths = [line.split(b"\t", 1)[1].decode() for line in listed.splitlines()]
    for read in READS[job]:
        if not any(p == read or p.startswith(read + "/") for p in paths):
            raise SystemExit(f"{job} reads {read}, which HEAD doesn't hold: fix READS")
    return hashlib.sha256(listed).hexdigest()


def passes(folder):
    """{job: where it passed} from a folder holding one `<job>/run` file per pass restored from the cache."""
    out = {}
    for job in READS:
        mark = pathlib.Path(folder) / job / "run"
        if mark.is_file():
            out[job] = mark.read_text(errors="replace").strip()[:200]
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--keys", action="store_true",
                        help="print `<job>-key=<hash>` for each job that reads a closed set of files, and stop")
    parser.add_argument("--qa", action="store_true",
                        help="print `qa=true|false` for whether pull-request QA jobs need to run")
    parser.add_argument("--event", help="github.event_name")
    parser.add_argument("--complete", choices=("true", "false"), default="true",
                        help="false when the list of changed files may have been cut short: every job runs")
    parser.add_argument("--passed", metavar="FOLDER",
                        help="the folder the passes on record were restored into: `<job>/run` says where a job passed")
    args = parser.parse_args(argv)
    if args.keys:
        for job in READS:
            print(f"{job}-key={key(job)}")
        return
    if not args.event:
        parser.error("--event is required")
    paths = [line.strip() for line in sys.stdin if line.strip()]
    if args.complete != "true":
        paths = []
    if args.qa:
        runs, why = qa_scope(paths, args.event)
        print(f"qa={'true' if runs else 'false'}")
        print(f"qa: {'runs' if runs else 'left out'}, {why}", file=sys.stderr)
        return
    for job, (runs, why) in scope(paths, args.event, passes(args.passed) if args.passed else None).items():
        print(f"{job}={'true' if runs else 'false'}")
        print(f"{job}: {'runs' if runs else 'left out'}, {why}", file=sys.stderr)


if __name__ == "__main__":
    main()
