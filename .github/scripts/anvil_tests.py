"""The node's tests that need Anvil, by their full names, for coverage.yml's node job (UNB-208).

They are `#[ignore = "needs Anvil"]` because a plain `cargo test` has no chain; the node coverage job installs Anvil
and runs exactly these with `-- --ignored --exact`. The other ignored tests (a live site, a real browser walk, DNS)
stay out.

Reads the ignored tests' list (`cargo test ... -- --ignored --list` output) on stdin, scans the sources under the given
roots for the functions marked `needs Anvil`, and prints the listed tests whose last name is one of them, one a line.
With `--run`, executes each listed test in its own isolated OS process in parallel against the already-built test
binary, appending each test's output atomically to `--log` so coverage profiles (`%p`) and `test result:` lines stay
intact.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import os
import re
import subprocess
import sys
import threading

MARK = re.compile(r'#\[ignore\s*=\s*"needs Anvil"\]')
FN = re.compile(r"\bfn\s+([A-Za-z0-9_]+)")


def anvil_fns(roots):
    """Names of the functions marked `needs Anvil` (the first `fn` after the mark)."""
    names = set()
    for root in roots:
        for d, _, files in os.walk(root):
            for f in files:
                if not f.endswith(".rs"):
                    continue
                with open(os.path.join(d, f), encoding="utf-8") as fh:
                    text = fh.read()
                for m in MARK.finditer(text):
                    fn = FN.search(text, m.end())
                    if fn:
                        names.add(fn.group(1))
    return names


def selected(listing, names):
    """The full test names in a libtest `--list` output whose last segment is in `names`, in order, once each."""
    out = []
    for line in listing.splitlines():
        if not line.endswith(": test"):
            continue
        full = line[: -len(": test")]
        if full.rsplit("::", 1)[-1] in names and full not in out:
            out.append(full)
    return out


def run_parallel(binary, tests, log_path, jobs=6):
    """Run each test in its own process against `binary`, appending un-interleaved output to `log_path`."""
    lock = threading.Lock()
    failed = []

    def run_one(test_name):
        done = subprocess.run(
            [binary, "--ignored", "--exact", test_name],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors="replace",
        )
        return test_name, done.returncode, done.stdout

    with ThreadPoolExecutor(max_workers=max(1, int(jobs))) as pool:
        futures = [pool.submit(run_one, name) for name in tests]
        for fut in as_completed(futures):
            name, code, output = fut.result()
            with lock:
                with open(log_path, "a", encoding="utf-8") as fh:
                    fh.write(output)
                    if output and not output.endswith("\n"):
                        fh.write("\n")
                if code != 0:
                    failed.append(name)
                    print(f"::warning::{name} (needs Anvil) failed under coverage: see the log artifact", flush=True)
    return failed


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if "--run" in argv:
        p = argparse.ArgumentParser()
        p.add_argument("--run", action="store_true")
        p.add_argument("--binary", required=True)
        p.add_argument("--tests", required=True)
        p.add_argument("--log", required=True)
        p.add_argument("--jobs", type=int, default=6)
        args = p.parse_args(argv)
        with open(args.tests, encoding="utf-8") as fh:
            tests = [line.strip() for line in fh if line.strip()]
        run_parallel(args.binary, tests, args.log, jobs=args.jobs)
        return 0
    roots = argv or ["app/src"]
    for t in selected(sys.stdin.read(), anvil_fns(roots)):
        print(t)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
