"""ci-scope.py: which of CI's long jobs a pull request's changed files reach. A job is left out only where the table
says it can't read the change; everything else runs."""
import importlib.util
import io
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import yaml

SCRIPT = Path(__file__).parents[1] / "ci-scope.py"
spec = importlib.util.spec_from_file_location("ci_scope", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
CI = Path(__file__).parents[2] / "workflows/ci.yml"
COVERAGE = Path(__file__).parents[2] / "workflows/coverage.yml"


def runs(*paths, event="pull_request"):
    return {job for job, (run, _) in module.scope(list(paths), event).items() if run}


class ScopeTest(unittest.TestCase):
    def test_anything_but_a_pull_request_runs_every_job(self):
        for event in ("push", "workflow_dispatch", "schedule"):
            self.assertEqual(runs("papers/README.md", event=event), module.ALL, event)

    def test_no_list_of_changed_files_runs_every_job(self):
        self.assertEqual(runs(), module.ALL)

    def test_a_list_cut_short_runs_every_job(self):
        out = io.StringIO()
        with patch.object(sys, "stdin", io.StringIO("papers/README.md\n")), redirect_stdout(out), redirect_stderr(io.StringIO()):
            module.main(["--event", "pull_request", "--complete", "false"])
        self.assertEqual(set(out.getvalue().split()), {f"{job}=true" for job in module.JOBS})

    def test_a_change_to_the_workflows_runs_every_job(self):
        self.assertEqual(runs(".github/workflows/ci.yml"), module.ALL)
        self.assertEqual(runs(".github/scripts/ci-scope.py"), module.ALL)

    def test_a_path_the_table_does_not_name_runs_every_rust_job(self):
        # The node's tests read docs/ (engine_is_general.rs), test-banks/ (primitives.rs), the telemetry schema
        # (report.rs), and scan the SDKs and plugins (migrate.rs).
        for path in ("docs/GENERALITY.md", "test-banks/popular-sites/run_bank.py", "unbrowse-telemetry/schema.json",
                     "unbrowse-sdk/python/unbrowse/client.py", "integrations/openclaw/index.ts", "skills/unbrowse/SKILL.md",
                     "TERMS.md", "a-folder-made-tomorrow/x.rs"):
            self.assertEqual(runs(path), module.RUST, path)

    def test_the_node_alone_leaves_out_the_contracts_the_window_and_the_engine(self):
        self.assertEqual(runs("unbrowse-node/app/src/main.rs"), {"node", "elsewhere"})

    def test_the_contracts_alone_leave_out_the_rust_jobs(self):
        self.assertEqual(runs("unbrowse-settlement/src/LeanSettlement.sol"), {"settlement", "spec"})
        self.assertEqual(runs("unbrowse-settlement/spec/coins/coins.qnt"), {"settlement", "spec"})

    def test_what_the_node_embeds_from_the_contracts_runs_both(self):
        self.assertEqual(runs("unbrowse-node/app/contracts/runtime.json"), {"settlement", "node", "elsewhere"})
        self.assertIn("settlement", runs("antithesis/test/check_contract_reads.py"))
        self.assertTrue(module.RUST <= runs("antithesis/Dockerfile"))

    def test_the_window_and_its_icons(self):
        self.assertEqual(runs("unbrowse-node/window/src/main.zig"), {"window", "elsewhere"})
        self.assertEqual(runs("unbrowse-node/app/icons/icon.png"), {"window", "node", "elsewhere"})

    def test_the_browser_reaches_the_node(self):
        self.assertEqual(runs("unbrowse-node/crates/browser/src/lib.rs"), module.RUST)
        self.assertEqual(runs("unbrowse-browser/packages/dashboard/src/app.ts"), module.RUST)

    def test_the_papers_reach_no_long_job(self):
        self.assertEqual(runs("papers/params.toml"), set())

    def test_one_path_that_reaches_a_job_is_enough(self):
        self.assertEqual(runs("papers/params.toml", "unbrowse-settlement/src/Pool.sol", "unbrowse-node/app/src/a.rs"),
                         {"settlement", "spec", "node", "elsewhere"})

    def test_every_long_job_in_ci_yml_is_gated_with_a_fallback(self):
        jobs = yaml.safe_load(CI.read_text())["jobs"]
        outputs = jobs["scope"]["outputs"]
        self.assertEqual(set(outputs), set(module.JOBS) | {f"{job}-key" for job in module.READS})
        gated = {name: job for name, job in jobs.items() if "needs.scope" in str(job.get("if", ""))}
        self.assertEqual(set(gated), {"settlement", "coins-spec", "engine", "node", "lint", "elsewhere", "window"})
        # The node's lint runs exactly when its tests do (UNB-235: beside them, not before them).
        self.assertEqual(gated["lint"]["if"], gated["node"]["if"])
        for name, job in gated.items():
            self.assertEqual(job["needs"], "scope", name)
            # A scope job that failed runs the long job rather than leaving it out.
            self.assertIn("needs.scope.result != 'success'", job["if"], name)
            self.assertIn("!cancelled()", job["if"], name)
        self.assertIn("needs.scope.outputs.spec == 'true'", jobs["coins-spec"]["if"])
        self.assertIn("needs.scope.outputs.settlement == 'true'", jobs["settlement"]["if"])

    def test_every_part_of_coverage_yml_is_gated_with_a_fallback(self):
        jobs = yaml.safe_load(COVERAGE.read_text())["jobs"]
        self.assertTrue(set(jobs["scope"]["outputs"]) <= set(module.JOBS))
        gated = {name: job for name, job in jobs.items() if "needs.scope.outputs" in str(job.get("if", ""))}
        self.assertEqual({name: job["if"].split("needs.scope.outputs.")[1].split(" ")[0] for name, job in gated.items()},
                         {"rust-node": "node", "rust-browser": "engine", "settlement": "settlement", "window": "window",
                          "behaviour": "node"})
        for name, job in gated.items():
            self.assertIn("scope", job["needs"] if isinstance(job["needs"], list) else [job["needs"]], name)
            self.assertIn("needs.scope.result != 'success'", job["if"], name)
            self.assertIn("!cancelled()", job["if"], name)
        # The SDKs' parts are short and always measured; the report and the ratchet are told what was left out.
        for name in ("sdk-typescript", "sdk-python"):
            self.assertNotIn("needs", jobs[name], name)
        for name in ("report", "ratchet"):
            run = "\n".join(str(step.get("run", "")) for step in jobs[name]["steps"])
            self.assertIn("--not-reached rust:unbrowse-node", run, name)
            self.assertIn("--not-reached rust:browser-core --not-reached rust:browser-cli", run, name)

    def test_the_browser_tests_run_once_on_linux(self):
        # coverage.yml's browser jobs fail when a test fails, and ci.yml's engine job stands down for exactly the
        # events coverage.yml is triggered by.
        coverage = yaml.safe_load(COVERAGE.read_text())
        on = coverage[True]
        self.assertEqual(on["push"]["branches"], ["staging", "release/**"])
        self.assertEqual(on["pull_request"]["branches"], ["staging", "release/**", "main"])
        for step in coverage["jobs"]["rust-browser"]["steps"]:
            run = str(step.get("run", ""))
            if "cargo llvm-cov --locked" in run:
                self.assertIn('exit "$status"', run)
                self.assertNotIn("::warning::", run)
        engine = yaml.safe_load(CI.read_text())["jobs"]["engine"]["if"]
        self.assertIn("!((github.event_name == 'push' && github.ref != 'refs/heads/main') || "
                      "(github.event_name == 'pull_request' && (github.base_ref == 'staging' || github.base_ref == 'main' "
                      "|| startsWith(github.base_ref, 'release/'))))", engine)


class PassedTest(unittest.TestCase):
    """A job that reads a closed set of files is left out once those very files passed, on a push too."""

    def test_a_pass_on_record_leaves_the_job_out_under_any_event(self):
        for event in ("push", "pull_request"):
            got = module.scope([".github/workflows/ci.yml"], event, {"spec": "run 7"})
            self.assertEqual(got["spec"], (False, "every file it reads already passed (run 7)"), event)
            self.assertTrue(got["settlement"][0], event)
            self.assertTrue(all(got[job][0] for job in module.RUST), event)

    def test_a_pass_is_only_read_for_a_job_with_a_closed_set_of_files(self):
        got = module.scope([], "push", {"node": "run 7", "engine": "run 7"})
        self.assertTrue(got["node"][0] and got["engine"][0])

    def test_a_job_no_file_reaches_stays_left_out_for_that_reason(self):
        got = module.scope(["papers/params.toml"], "pull_request", {"spec": "run 7"})
        self.assertEqual(got["spec"], (False, "no changed file reaches it"))

    def test_passes_are_read_from_the_folder_the_cache_restored(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "spec").mkdir()
            (Path(tmp) / "spec/run").write_text("run 9 of abc\n")
            (Path(tmp) / "node").mkdir()
            (Path(tmp) / "node/run").write_text("not a job that can be left out\n")
            self.assertEqual(module.passes(tmp), {"spec": "run 9 of abc"})
            self.assertEqual(module.passes(Path(tmp) / "nowhere"), {})

    def test_every_file_a_job_reads_reaches_it(self):
        # Otherwise a pull request could change a file the job reads and the table would leave the job out.
        # A read under a top folder this checkout doesn't carry is a part the public copy leaves out (the contracts):
        # its jobs run only where the part is, and that repository's run checks it. It is named here, not passed.
        for job, reads in module.READS.items():
            for read in reads:
                if not (CI.parents[2] / Path(read).parts[0]).exists():
                    print(f"not checked here: {job} reads {read}, a part this repository doesn't carry", file=sys.stderr)
                    continue
                self.assertTrue((CI.parents[2] / read).exists(), f"{job} reads {read}, which isn't in the repository")
                path = read + "/any/file" if (CI.parents[2] / read).is_dir() else read
                self.assertIn(job, module.reaches(path), f"{path} doesn't reach {job}")

    def test_the_workflow_and_this_script_are_in_every_key(self):
        for job, reads in module.READS.items():
            self.assertIn(".github/workflows/ci.yml", reads, job)
            self.assertIn(".github/scripts/ci-scope.py", reads, job)

    def test_a_key_follows_the_files_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as tmp:
            git = lambda *a: subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *a], cwd=tmp,
                                            check=True, capture_output=True)
            git("init", "-q")
            for read in module.READS["spec"] + ("docs",):
                file = Path(tmp) / read / "f" if "." not in Path(read).name else Path(tmp) / read
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("one\n")
            git("add", "-A"); git("commit", "-qm", "one")
            first = module.key("spec", tmp)
            # A file the job doesn't read, in a new commit: the same key.
            (Path(tmp) / "docs/f").write_text("two\n")
            git("add", "-A"); git("commit", "-qm", "two")
            self.assertEqual(module.key("spec", tmp), first)
            # A file it reads: another key.
            (Path(tmp) / "unbrowse-settlement/spec/f").write_text("two\n")
            git("add", "-A"); git("commit", "-qm", "three")
            self.assertNotEqual(module.key("spec", tmp), first)
            # A read that is gone is an error, never a key of less.
            git("rm", "-rq", "unbrowse-settlement/test/coins/fixtures/quint"); git("commit", "-qm", "four")
            with self.assertRaises(SystemExit):
                module.key("spec", tmp)

    def test_ci_yml_records_a_pass_only_after_the_job_passed_and_reads_none_on_a_manual_run(self):
        jobs = yaml.safe_load(CI.read_text())["jobs"]
        restores = [s for s in jobs["scope"]["steps"] if "actions/cache/restore@" in str(s.get("uses", ""))]
        self.assertEqual({s["with"]["key"] for s in restores},
                         {"passed-settlement-${{ steps.keys.outputs.settlement-key }}", "passed-spec-${{ steps.keys.outputs.spec-key }}"})
        for step in restores:
            self.assertIn("github.event_name != 'workflow_dispatch'", step["if"])
        # The save is the job's last step, so GitHub skips it when any step before it failed; no `always()` on it.
        for name, key in (("settlement", "settlement"), ("coins-spec-all", "spec")):
            last = jobs[name]["steps"][-1]
            self.assertIn("actions/cache/save@", last["uses"], name)
            self.assertEqual(last["with"], {"path": f"passed/{key}", "key": f"passed-{key}-${{{{ needs.scope.outputs.{key}-key }}}}"}, name)
            self.assertNotIn("always()", str(last.get("if", "")), name)
            self.assertNotIn("failure()", str(last.get("if", "")), name)
        self.assertIn("needs.coins-spec.result == 'success'", jobs["coins-spec-all"]["steps"][-1]["if"])


if __name__ == "__main__":
    unittest.main()
