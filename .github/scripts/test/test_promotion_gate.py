"""The promotion gate (UNB-208): staging reaches public only with every gated part's line coverage at 90% or more,
and a task bank that lost nothing the last promoted build had right, holds no confident wrong answer, and passes at
least as many tasks as the last promotion did.

Run: python3 -m unittest discover -s .github/scripts/test -p 'test_promotion_gate.py' -v
"""
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from contextlib import redirect_stdout

ROOT = pathlib.Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("promotion_gate", ROOT / ".github/scripts/promotion_gate.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)

FIXTURE = ROOT / "test-banks/gate/fixtures/staging-2026-11-17"


def part(covered, total, gated=True):
    return {"covered": covered, "total": total, "pct": round(100 * covered / total, 2), "gated": gated}


def all_parts_at(pct_covered):
    return {"parts": {name: part(pct_covered, 100) for name in gate.GATED_PARTS}}


def result(task_id, outcome, answer=None):
    return {"id": task_id, "outcome": outcome, "answer": answer or {"status": "answered", "answer": task_id}}


class CoverageGate(unittest.TestCase):
    def test_every_gated_part_at_90_passes(self):
        self.assertEqual(gate.check_coverage(all_parts_at(90)), [])

    def test_a_part_below_90_is_named_with_its_numbers(self):
        summary = all_parts_at(99)
        summary["parts"]["sdk:typescript"] = part(4702, 5562)
        problems = gate.check_coverage(summary)
        self.assertEqual(len(problems), 1)
        self.assertIn("sdk:typescript", problems[0])
        self.assertIn("84.54%", problems[0])
        self.assertIn("4702/5562", problems[0])

    def test_a_gated_part_that_was_not_measured_refuses(self):
        summary = all_parts_at(100)
        del summary["parts"]["rust:browser-cli"]
        problems = gate.check_coverage(summary)
        self.assertEqual(len(problems), 1)
        self.assertIn("rust:browser-cli", problems[0])
        self.assertIn("UNMEASURED", problems[0])

    def test_a_part_reported_apart_never_refuses(self):
        summary = all_parts_at(100)
        summary["parts"]["settlement"] = part(10, 100, gated=False)
        self.assertEqual(gate.check_coverage(summary), [])

    def test_90_is_not_rounded_up_from_89_995(self):
        summary = all_parts_at(100)
        summary["parts"]["sdk:python"] = {"covered": 17999, "total": 20000, "pct": 90.0, "gated": True}
        self.assertEqual(len(gate.check_coverage(summary)), 1)


class Exclusions(unittest.TestCase):
    # Lewis approved these on 18 Nov 2026 (programme 7f35ecb8): type-only TypeScript, generated SDK code and the
    # copied Uniswap v4 maths. Nothing else is left out.
    APPROVED = {
        "unbrowse-sdk/typescript/src/types.ts",
        "unbrowse-sdk/typescript/src/owner-types.ts",
        "unbrowse-sdk/typescript/src/generated.ts",
        "unbrowse-sdk/python/src/unbrowse/_generated.py",
        "unbrowse-settlement/src/lean/v4/*.sol",
    }

    def test_the_file_in_the_repository_holds_exactly_the_approved_rows(self):
        rows = gate.load_exclusions((ROOT / "docs/COVERAGE-EXCLUSIONS.md").read_text())
        self.assertEqual({glob for glob, _, _ in rows}, self.APPROVED)
        for glob, why, approval in rows:
            self.assertTrue(why, glob)
            self.assertIn("18 Nov 2026", approval, glob)

    def test_every_approved_row_matches_a_file_that_exists(self):
        tracked = [p.relative_to(ROOT).as_posix() for p in ROOT.glob("unbrowse-s*/**/*") if p.is_file()]
        # A folder the public tree leaves out (.github/public-tree-exclude) is checked in unbrowse-core, where it is.
        exclude = ROOT / ".github/public-tree-exclude"
        private = [l.strip() for l in exclude.read_text().splitlines() if l.strip() and not l.startswith("#")]
        for glob in self.APPROVED:
            if any(glob.startswith(d) and not (ROOT / d).is_dir() for d in private):
                continue
            self.assertTrue(any(gate.fnmatch.fnmatch(t, glob) for t in tracked), glob)

    def test_hand_written_code_named_generated_is_counted(self):
        # crates/learn/src/generated.rs verifies programs an agent writes; it is the engine's own code, not generated.
        rows = gate.load_exclusions((ROOT / "docs/COVERAGE-EXCLUSIONS.md").read_text())
        rel = "unbrowse-node/crates/learn/src/generated.rs"
        self.assertFalse(any(gate.fnmatch.fnmatch(rel, glob) for glob, _, _ in rows))

    def test_an_approved_row_is_applied(self):
        text = ("## Approved\n\n| Path (glob) | Why | Approved by Lewis (date, where) |\n|---|---|---|\n"
                "| `unbrowse-sdk/typescript/src/types.ts` | type-only | 18 Nov 2026, PR #1 |\n")
        self.assertEqual(gate.load_exclusions(text),
                         [("unbrowse-sdk/typescript/src/types.ts", "type-only", "18 Nov 2026, PR #1")])

    def test_a_row_without_an_approval_is_refused(self):
        text = ("## Approved\n\n| Path (glob) | Why | Approved by Lewis (date, where) |\n|---|---|---|\n"
                "| `unbrowse-node/app/**` | hard to test |  |\n")
        with self.assertRaises(ValueError):
            gate.load_exclusions(text)

    def test_excluded_lines_leave_the_count_and_are_listed(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = pathlib.Path(tmp) / "c.json"
            report.write_text(json.dumps({
                "total": {"lines": {"total": 30, "covered": 20}},
                f"{tmp}/unbrowse-sdk/typescript/src/a.ts": {"lines": {"total": 10, "covered": 10}},
                f"{tmp}/unbrowse-sdk/typescript/src/types.ts": {"lines": {"total": 20, "covered": 10}},
            }))
            summary = gate.summarise([("istanbul", "sdk:typescript", str(report))], tmp,
                                     [("unbrowse-sdk/typescript/src/types.ts", "type-only", "approved")])
        ts = summary["parts"]["sdk:typescript"]
        self.assertEqual((ts["covered"], ts["total"]), (10, 10))
        self.assertEqual(summary["excluded"][0]["lines"], 20)


class Readers(unittest.TestCase):
    def test_llvm_cov_export_is_split_by_crate_and_drops_vendor(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = pathlib.Path(tmp) / "n.json"
            files = [
                {"filename": f"{tmp}/unbrowse-node/app/src/main.rs", "summary": {"lines": {"count": 10, "covered": 7}}},
                {"filename": f"{tmp}/unbrowse-node/crates/learn/src/lib.rs",
                 "summary": {"lines": {"count": 10, "covered": 9}}},
                {"filename": f"{tmp}/unbrowse-node/vendor/boring/src/x.rs",
                 "summary": {"lines": {"count": 100, "covered": 0}}},
                {"filename": "/home/runner/.cargo/registry/src/serde/lib.rs",
                 "summary": {"lines": {"count": 50, "covered": 1}}},
            ]
            report.write_text(json.dumps({"data": [{"files": files}]}))
            summary = gate.summarise([("llvm", "rust:unbrowse-node", str(report))], tmp, [])
        node = summary["parts"]["rust:unbrowse-node"]
        self.assertEqual((node["covered"], node["total"]), (16, 20))
        self.assertEqual(node["sub"]["app"]["covered"], 7)
        self.assertEqual(node["sub"]["learn"]["total"], 10)

    def test_coverage_py_paths_relative_to_the_sdk(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = pathlib.Path(tmp) / "py.json"
            report.write_text(json.dumps({"files": {
                "src/unbrowse/client.py": {"summary": {"num_statements": 40, "covered_lines": 36}},
            }}))
            summary = gate.summarise([("coveragepy", "sdk:python", str(report))], tmp, [])
        self.assertEqual(summary["parts"]["sdk:python"]["covered"], 36)
        self.assertEqual(summary["files"]["unbrowse-sdk/python/src/unbrowse/client.py"], [40, 36])

    def test_lcov_counts_lines_hit(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = pathlib.Path(tmp) / "l.info"
            report.write_text("SF:src/Coin.sol\nDA:1,3\nDA:2,0\nDA:3,1\nend_of_record\n"
                              "SF:test/Coin.t.sol\nDA:1,1\nend_of_record\n")
            summary = gate.summarise([("lcov", "settlement", str(report))], tmp, [])
        s = summary["parts"]["settlement"]
        self.assertEqual((s["covered"], s["total"], s["gated"]), (2, 3, False))


def lcov(*files):
    """lcov text: files is (path, {line: hits})."""
    out = []
    for path, lines in files:
        out.append(f"SF:{path}")
        out += [f"DA:{n},{h}" for n, h in sorted(lines.items())]
        out.append("end_of_record")
    return "\n".join(out) + "\n"


def summary_of(files, commit="base"):
    """A coverage summary as `promotion_gate.py coverage` writes it, from {rel: (total, covered)}."""
    s = gate.summarise([], ".", [], commit=commit)
    s["files"] = {rel: list(tc) for rel, tc in files.items()}
    return gate.resummarise(s, [])


NODE_A = "unbrowse-node/app/src/a.rs"
NODE_B = "unbrowse-node/crates/learn/src/b.rs"
PY = "unbrowse-sdk/python/src/unbrowse/client.py"
EVERY_PART = {NODE_A: (100, 80), NODE_B: (100, 90), "unbrowse-node/crates/browser/src/c.rs": (10, 9),
              "unbrowse-browser/cli/src/d.rs": (10, 9), "unbrowse-sdk/typescript/src/e.ts": (10, 9), PY: (10, 9)}


class Diffs(unittest.TestCase):
    def test_the_lines_a_pr_adds_or_changes_are_the_new_sides_lines(self):
        text = (
            "diff --git a/unbrowse-node/app/src/a.rs b/unbrowse-node/app/src/a.rs\n"
            "--- a/unbrowse-node/app/src/a.rs\n+++ b/unbrowse-node/app/src/a.rs\n"
            "@@ -3 +3 @@ fn x()\n-old\n+new\n"
            "@@ -10,0 +11,2 @@\n+one\n+two\n"
            "@@ -20,2 +22,0 @@\n-gone\n-gone\n"
            "diff --git a/unbrowse-node/app/src/gone.rs b/unbrowse-node/app/src/gone.rs\n"
            "--- a/unbrowse-node/app/src/gone.rs\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n"
            "diff --git a/unbrowse-sdk/python/src/unbrowse/new.py b/unbrowse-sdk/python/src/unbrowse/new.py\n"
            "--- /dev/null\n+++ b/unbrowse-sdk/python/src/unbrowse/new.py\n@@ -0,0 +1,3 @@\n+a\n+b\n+c\n"
        )
        self.assertEqual(gate.parse_diff(text), {
            "unbrowse-node/app/src/a.rs": {3, 11, 12},
            "unbrowse-sdk/python/src/unbrowse/new.py": {1, 2, 3},
        })


class NewLines(unittest.TestCase):
    def measure(self, kind, part, report_text, changed, exclusions=()):
        with tempfile.TemporaryDirectory() as tmp:
            report = pathlib.Path(tmp) / "r"
            report.write_text(report_text.replace("ROOT", tmp))
            return gate.diff_coverage(changed, [(kind, part, str(report))], tmp, list(exclusions))

    def test_new_lines_are_counted_from_the_lines_the_report_can_cover(self):
        # Lines 3-7 changed; 4 is a comment (no DA line), 5 and 6 never ran.
        text = lcov((f"ROOT/{NODE_A}", {1: 1, 3: 2, 5: 0, 6: 0, 7: 1, 9: 0}))
        got = self.measure("lcov", "rust:unbrowse-node", text, {NODE_A: {3, 4, 5, 6, 7}})
        node = got["rust:unbrowse-node"]
        self.assertEqual((node["covered"], node["total"]), (2, 4))
        self.assertEqual(node["files"][NODE_A]["missed"], [5, 6])

    def test_a_file_the_pr_did_not_touch_adds_no_new_lines(self):
        text = lcov((f"ROOT/{NODE_A}", {1: 0}), (f"ROOT/{NODE_B}", {1: 1}))
        got = self.measure("lcov", "rust:unbrowse-node", text, {NODE_B: {1}})
        self.assertEqual((got["rust:unbrowse-node"]["covered"], got["rust:unbrowse-node"]["total"]), (1, 1))

    def test_an_excluded_file_is_left_out_of_the_new_lines_too(self):
        gen = "unbrowse-sdk/python/src/unbrowse/_generated.py"
        report = json.dumps({"files": {"src/unbrowse/_generated.py": {"executed_lines": [], "missing_lines": [1, 2]}}})
        got = self.measure("coveragepy", "sdk:python", report, {gen: {1, 2}}, [(gen, "generated", "18 Nov 2026")])
        self.assertNotIn("sdk:python", got)

    def test_coverage_py_lines_run_and_missed(self):
        report = json.dumps({"files": {"src/unbrowse/client.py": {"executed_lines": [1, 2, 4], "missing_lines": [3]}}})
        got = self.measure("coveragepy", "sdk:python", report, {PY: {2, 3}})
        self.assertEqual(got["sdk:python"]["files"][PY]["missed"], [3])
        self.assertEqual(got["sdk:python"]["covered"], 1)

    def test_istanbul_a_line_runs_when_any_statement_on_it_ran(self):
        ts = "unbrowse-sdk/typescript/src/e.ts"
        report = json.dumps({f"ROOT/{ts}": {
            "statementMap": {"0": {"start": {"line": 1}}, "1": {"start": {"line": 1}}, "2": {"start": {"line": 2}}},
            "s": {"0": 0, "1": 3, "2": 0}}})
        got = self.measure("istanbul", "sdk:typescript", report, {ts: {1, 2}})
        self.assertEqual(got["sdk:typescript"]["files"][ts]["missed"], [2])


class Ratchet(unittest.TestCase):
    """The per-PR check (UNB-208): no gated part falls below staging, and what a PR adds is 90% covered."""

    def run_ratchet(self, head, bases, new_lines, exclusions=()):
        return gate.ratchet(head, bases, new_lines, list(exclusions))

    def test_the_same_numbers_and_covered_new_lines_pass(self):
        base = summary_of(EVERY_PART)
        problems, _ = self.run_ratchet(summary_of(EVERY_PART, "head"), [base],
                                       {"rust:unbrowse-node": {"covered": 50, "total": 50, "files": {}}})
        self.assertEqual(problems, [])

    def test_a_gated_part_that_falls_is_refused_with_the_part_and_the_files_that_lost_lines(self):
        head = dict(EVERY_PART, **{NODE_B: (100, 80)})
        problems, _ = self.run_ratchet(summary_of(head, "head"), [summary_of(EVERY_PART)], {})
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("rust:unbrowse-node", problems[0])
        self.assertIn("85.00%", problems[0])
        self.assertIn("80.00%", problems[0])
        self.assertIn(NODE_B, problems[0])
        self.assertNotIn(NODE_A, problems[0])

    def test_a_fall_of_one_line_in_a_small_part_is_refused(self):
        head = dict(EVERY_PART, **{PY: (10, 8)})
        problems, _ = self.run_ratchet(summary_of(head, "head"), [summary_of(EVERY_PART)], {})
        self.assertTrue(any("sdk:python" in p and PY in p for p in problems), problems)

    def test_a_fall_under_a_twentieth_of_a_point_is_not_a_fall(self):
        # 9 lines in 20,000 is 0.045 points: within what timing-dependent tests moved staging's node and browser
        # core between runs on unchanged files (up to 14 and 4 lines, 18 Nov 2026).
        base = dict(EVERY_PART, **{NODE_A: (19800, 15000)})
        head = dict(EVERY_PART, **{NODE_A: (19800, 14991)})
        problems, _ = self.run_ratchet(summary_of(head, "head"), [summary_of(base)], {})
        self.assertEqual(problems, [])

    def test_a_fall_of_a_twentieth_of_a_point_is_refused(self):
        # The node part is NODE_A plus NODE_B (100 lines): 1090 of 2000 lines to 1089 is 0.05 points.
        base = dict(EVERY_PART, **{NODE_A: (1900, 1000)})
        head = dict(EVERY_PART, **{NODE_A: (1900, 999)})
        problems, _ = self.run_ratchet(summary_of(head, "head"), [summary_of(base)], {})
        self.assertTrue(any("rust:unbrowse-node" in p for p in problems), problems)

    def test_a_rise_passes(self):
        head = dict(EVERY_PART, **{NODE_A: (100, 95)})
        problems, _ = self.run_ratchet(summary_of(head, "head"), [summary_of(EVERY_PART)], {})
        self.assertEqual(problems, [])

    def test_new_lines_under_90_are_refused_with_the_part_and_the_file(self):
        new = {"sdk:python": {"covered": 88, "total": 99, "files": {PY: {"covered": 88, "total": 99, "missed": [7, 9]}}}}
        problems, _ = self.run_ratchet(summary_of(EVERY_PART, "head"), [summary_of(EVERY_PART)], new)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("sdk:python", problems[0])
        self.assertIn(PY, problems[0])
        self.assertIn("7", problems[0])

    def test_new_lines_at_exactly_90_pass_and_89_99_does_not(self):
        ok = {"sdk:python": {"covered": 90, "total": 100, "files": {}}}
        self.assertEqual(self.run_ratchet(summary_of(EVERY_PART, "h"), [summary_of(EVERY_PART)], ok)[0], [])
        short = {"sdk:python": {"covered": 8999, "total": 10000, "files": {}}}
        self.assertEqual(len(self.run_ratchet(summary_of(EVERY_PART, "h"), [summary_of(EVERY_PART)], short)[0]), 1)

    def test_a_part_this_pr_did_not_measure_is_a_finding_never_a_pass(self):
        head = {k: v for k, v in EVERY_PART.items() if not k.startswith("unbrowse-browser/cli/")}
        problems, lines = self.run_ratchet(summary_of(head, "head"), [summary_of(EVERY_PART)], {})
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("rust:browser-cli", problems[0])
        self.assertIn("UNMEASURED", problems[0])
        self.assertTrue(any("rust:browser-cli" in line and "UNMEASURED" in line for line in lines), lines)

    def test_no_summary_for_the_pr_refuses_every_gated_part(self):
        problems, _ = self.run_ratchet(None, [summary_of(EVERY_PART)], {})
        self.assertEqual(len(problems), len(gate.GATED_PARTS))

    def test_a_part_no_recent_staging_run_measured_is_a_finding(self):
        base = {k: v for k, v in EVERY_PART.items() if not k.startswith("unbrowse-sdk/typescript/")}
        problems, _ = self.run_ratchet(summary_of(EVERY_PART, "head"), [summary_of(base)], {})
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("sdk:typescript", problems[0])
        self.assertIn("UNMEASURED", problems[0])

    def test_no_staging_summary_at_all_refuses(self):
        problems, _ = self.run_ratchet(summary_of(EVERY_PART, "head"), [], {})
        self.assertEqual(len(problems), len(gate.GATED_PARTS))

    def test_a_staging_run_that_lost_a_part_is_passed_over_for_one_that_measured_it(self):
        # The newest staging run lost its TypeScript job; the one before measured it at 90%.
        newest = summary_of({k: v for k, v in EVERY_PART.items() if not k.startswith("unbrowse-sdk/typescript/")},
                            "newest")
        older = summary_of(EVERY_PART, "older")
        head = dict(EVERY_PART, **{"unbrowse-sdk/typescript/src/e.ts": (10, 8)})
        problems, lines = self.run_ratchet(summary_of(head, "head"), [newest, older], {})
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("sdk:typescript", problems[0])
        self.assertIn("older", problems[0])

    def test_a_part_is_compared_with_the_lowest_of_the_recent_staging_runs(self):
        # Chrome starts in about half of CI's browser runs (18 Nov 2026): the CLI reads 67.92% or 62.15% on the same
        # code. A pull request whose run missed Chrome is not refused for a staging run that had it.
        cli = "unbrowse-browser/cli/src/d.rs"
        high = summary_of(dict(EVERY_PART, **{cli: (70822, 48103)}), "chrome")
        low = summary_of(dict(EVERY_PART, **{cli: (70822, 44013)}), "nochrome")
        head = summary_of(dict(EVERY_PART, **{cli: (70822, 44013)}), "head")
        problems, lines = self.run_ratchet(head, [high, low], {})
        self.assertEqual(problems, [])
        self.assertTrue(any("rust:browser-cli" in line and "nochrome" in line for line in lines), lines)
        problems, _ = self.run_ratchet(summary_of(dict(EVERY_PART, **{cli: (70822, 43900)}), "head"), [high, low], {})
        self.assertTrue(any("rust:browser-cli" in p and "nochrome" in p for p in problems), problems)

    def test_staging_is_read_with_the_pr_s_exclusions(self):
        # Staging counted a fully run generated file; the PR leaves it out by an approved row. Not a fall.
        gen = "unbrowse-sdk/python/src/unbrowse/_generated.py"
        base = dict(EVERY_PART, **{gen: (1000, 1000)})
        rows = [(gen, "generated", "18 Nov 2026")]
        problems, _ = self.run_ratchet(summary_of(EVERY_PART, "head"), [summary_of(base)], {}, rows)
        self.assertEqual(problems, [])

    def test_no_diff_is_a_finding(self):
        problems, _ = self.run_ratchet(summary_of(EVERY_PART, "head"), [summary_of(EVERY_PART)], None)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("UNMEASURED", problems[0])

    def test_new_lines_in_a_part_with_no_line_report_are_a_finding(self):
        problems, lines = gate.ratchet(summary_of(EVERY_PART, "head"), [summary_of(EVERY_PART)], {}, [],
                                       unmeasured_new=["rust:browser-core"])
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("rust:browser-core", problems[0])
        self.assertIn("UNMEASURED", problems[0])

    def test_a_part_no_changed_file_reaches_is_as_staging_has_it(self):
        # coverage.yml left the browser's two parts out: no report of them, and nothing of them changed.
        head = {k: v for k, v in EVERY_PART.items() if not k.startswith(("unbrowse-node/crates/browser/", "unbrowse-browser/cli/"))}
        left_out = ["rust:browser-core", "rust:browser-cli"]
        problems, lines = gate.ratchet(summary_of(head, "head"), [summary_of(EVERY_PART)], {}, [], not_reached=left_out)
        self.assertEqual(problems, [])
        self.assertEqual(sum("not run (no changed file reaches it)" in line for line in lines), 2, lines)
        # Without the scope's word for it, the same run is refused, part by part.
        problems, _ = gate.ratchet(summary_of(head, "head"), [summary_of(EVERY_PART)], {}, [])
        self.assertEqual(len(problems), 2, problems)

    def test_a_part_left_out_that_the_diff_touches_is_refused(self):
        head = {k: v for k, v in EVERY_PART.items() if not k.startswith("unbrowse-node/crates/browser/")}
        problems, _ = gate.ratchet(summary_of(head, "head"), [summary_of(EVERY_PART)], {}, [],
                                   unmeasured_new=["rust:browser-core"], not_reached=["rust:browser-core"])
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("left out as not reached, though the diff touches it", problems[0])

    def test_a_part_named_not_reached_that_was_measured_is_still_compared(self):
        head = dict(EVERY_PART, **{NODE_B: (100, 80)})
        problems, _ = gate.ratchet(summary_of(head, "head"), [summary_of(EVERY_PART)], {}, [], not_reached=["rust:unbrowse-node"])
        self.assertEqual(len(problems), 1, problems)

    def test_a_part_reported_apart_never_refuses(self):
        base = dict(EVERY_PART, **{"unbrowse-settlement/src/Coin.sol": (100, 90)})
        head = dict(EVERY_PART, **{"unbrowse-settlement/src/Coin.sol": (100, 10)})
        problems, _ = self.run_ratchet(summary_of(head, "head"), [summary_of(base)], {})
        self.assertEqual(problems, [])

    # A coverage run in which no line ran (0/N) is a run that failed, not a measurement: the node read 0.00% with
    # RATCHET_OK on #690, #691, #692 and #708, and staging's 0.00% was taken as the floor (UNB-208 review, S1-2).
    NODE_ZERO = dict(EVERY_PART, **{NODE_A: (100, 0), NODE_B: (100, 0)})

    def test_a_part_with_no_line_run_on_the_pr_is_unmeasured_not_a_pass(self):
        problems, lines = self.run_ratchet(summary_of(self.NODE_ZERO, "head"), [summary_of(self.NODE_ZERO)], {})
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("rust:unbrowse-node", problems[0])
        self.assertIn("UNMEASURED on this pull request", problems[0])
        self.assertTrue(any("rust:unbrowse-node" in line and "UNMEASURED" in line for line in lines), lines)

    def test_a_staging_run_with_no_line_run_is_never_the_floor(self):
        # Staging's newest run of the node failed (0/200); the one before measured 85%. A PR at 80% fell from 85%.
        head = dict(EVERY_PART, **{NODE_B: (100, 80)})
        problems, _ = self.run_ratchet(summary_of(head, "head"),
                                       [summary_of(self.NODE_ZERO, "failed"), summary_of(EVERY_PART, "measured")], {})
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("rust:unbrowse-node", problems[0])
        self.assertIn("fell from 85.00%", problems[0])
        self.assertIn("measured", problems[0])

    def test_staging_with_no_line_run_in_any_recent_run_is_unmeasured(self):
        problems, _ = self.run_ratchet(summary_of(EVERY_PART, "head"), [summary_of(self.NODE_ZERO)], {})
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("rust:unbrowse-node", problems[0])
        self.assertIn("UNMEASURED on staging", problems[0])


class RatchetCommand(unittest.TestCase):
    def files(self, tmp, head_files, new_hits):
        tmp = pathlib.Path(tmp)
        (tmp / "head.json").write_text(json.dumps(summary_of(head_files, "head")))
        (tmp / "base.json").write_text(json.dumps(summary_of(EVERY_PART, "base")))
        (tmp / "pr.diff").write_text(f"--- a/{NODE_A}\n+++ b/{NODE_A}\n@@ -1 +1,2 @@\n-x\n+y\n+z\n")
        (tmp / "node.info").write_text(lcov((f"{tmp}/{NODE_A}", new_hits)))
        return ["ratchet", "--root", str(tmp), "--head", str(tmp / "head.json"), "--base", str(tmp / "missing.json"),
                "--base", str(tmp / "base.json"), "--diff", str(tmp / "pr.diff"),
                "--lcov", f"rust:unbrowse-node={tmp / 'node.info'}", "--md", str(tmp / "ratchet.md")]

    def run_main(self, argv):
        out = io.StringIO()
        with redirect_stdout(out):
            code = gate.main(argv)
        return code, out.getvalue()

    def test_a_pr_that_holds_the_line_prints_ratchet_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, text = self.run_main(self.files(tmp, EVERY_PART, {1: 1, 2: 1}))
            md = (pathlib.Path(tmp) / "ratchet.md").read_text()
        self.assertEqual(code, 0, text)
        self.assertEqual(text.rstrip().splitlines()[-1], "RATCHET_OK")
        self.assertIn("RATCHET_OK", md)

    def test_a_pr_touching_a_part_whose_line_report_is_missing_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            argv = self.files(tmp, EVERY_PART, {1: 1, 2: 1})
            argv[argv.index(f"rust:unbrowse-node={pathlib.Path(tmp) / 'node.info'}")] = "rust:unbrowse-node=/nowhere"
            code, text = self.run_main(argv)
        self.assertEqual(code, 1, text)
        self.assertIn("rust:unbrowse-node", text)
        self.assertIn("UNMEASURED", text)

    def test_a_pr_that_falls_exits_1_naming_the_part_and_the_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, text = self.run_main(self.files(tmp, dict(EVERY_PART, **{NODE_A: (100, 70)}), {1: 1, 2: 0}))
        self.assertEqual(code, 1, text)
        self.assertTrue(text.rstrip().splitlines()[-1].startswith("RATCHET_REFUSED: 2 rule(s) unmet"), text)
        self.assertIn(f"REFUSE coverage ratchet: rust:unbrowse-node", text)
        self.assertIn(NODE_A, text)


class Unmeasured(unittest.TestCase):
    """G06: a part that did not run is printed UNMEASURED and counted as a finding, never as a pass."""

    def test_the_coverage_table_says_unmeasured_for_a_part_that_did_not_run(self):
        md = gate.coverage_markdown(summary_of({k: v for k, v in EVERY_PART.items() if not k.startswith(
            "unbrowse-node/crates/browser/")}))
        row = next(line for line in md.splitlines() if line.startswith("| rust:browser-core "))
        self.assertIn("UNMEASURED", row)
        self.assertIn("refuses", row)

    def test_the_coverage_table_says_not_run_for_a_part_no_changed_file_reaches(self):
        md = gate.coverage_markdown(summary_of({k: v for k, v in EVERY_PART.items() if not k.startswith(
            "unbrowse-node/crates/browser/")}), ["rust:browser-core"])
        row = next(line for line in md.splitlines() if line.startswith("| rust:browser-core "))
        self.assertIn("not run", row)
        self.assertNotIn("UNMEASURED", row)

    def test_the_summary_lists_the_parts_that_did_not_run(self):
        s = summary_of({k: v for k, v in EVERY_PART.items() if not k.startswith("unbrowse-sdk/")})
        self.assertIn("sdk:python", s["unmeasured"])
        self.assertIn("sdk:typescript", s["unmeasured"])


class CoverageWorkflow(unittest.TestCase):
    """coverage.yml runs the ratchet on every pull request, as a check that can block the merge."""

    @classmethod
    def setUpClass(cls):
        import yaml
        cls.wf = yaml.safe_load((ROOT / ".github/workflows/coverage.yml").read_text())
        cls.jobs = cls.wf["jobs"]

    def test_the_ratchet_runs_after_the_report_even_when_a_part_failed(self):
        job = self.jobs["ratchet"]
        self.assertEqual(job["name"], "Coverage, ratchet")
        self.assertIn("report", job["needs"])
        self.assertIn("!cancelled()", job["if"])
        self.assertIn("pull_request", job["if"])
        self.assertNotIn("continue-on-error", job)
        run = "\n".join(str(s.get("run", "")) for s in job["steps"])
        self.assertIn("promotion_gate.py ratchet", run)
        self.assertNotIn("|| true", run)

    def test_the_ratchet_holds_no_secret_and_writes_nothing(self):
        job = self.jobs["ratchet"]
        self.assertNotIn("secrets.", str(job))
        self.assertTrue(all(v == "read" for v in job["permissions"].values()), job["permissions"])

    def test_every_rust_part_keeps_its_lines_for_the_ratchet(self):
        text = (ROOT / ".github/workflows/coverage.yml").read_text()
        for name in ("rust-node", "rust-browser-core", "rust-browser-cli"):
            self.assertIn(f'--lcov --output-path "$RUNNER_TEMP/cov/{name}.lcov"', text)

    def test_the_coverage_runs_read_the_exclusions_file(self):
        run = "\n".join(str(s.get("run", "")) for s in self.jobs["report"]["steps"])
        self.assertIn("--exclusions docs/COVERAGE-EXCLUSIONS.md", run)
        run = "\n".join(str(s.get("run", "")) for s in self.jobs["ratchet"]["steps"])
        self.assertIn("--exclusions docs/COVERAGE-EXCLUSIONS.md", run)


class TaskGate(unittest.TestCase):
    BANK = ["a", "b", "c"]
    BASELINE = {"build": "v13.18.1", "pass_count": 2, "verdicts": {"a": "right", "b": "right", "c": "honest_fail"}}

    def check(self, results, baseline=None, rereads=()):
        return gate.check_tasks(self.BANK, results, baseline or self.BASELINE, list(rereads))

    def test_same_or_better_passes(self):
        problems, stats = self.check([result("a", "right"), result("b", "right"), result("c", "right")])
        self.assertEqual(problems, [])
        self.assertEqual(stats["right"], 3)

    def test_a_task_right_on_the_last_promotion_and_wrong_now_refuses_as_changed(self):
        problems, _ = self.check([result("a", "right"), result("b", "honest_fail"), result("c", "right")])
        self.assertTrue(any("b" in p and "re-read" in p for p in problems), problems)

    def test_a_hand_re_read_that_finds_no_regression_clears_that_answer_only(self):
        changed = result("b", "honest_fail")
        reread = {"id": "b", "answer_sha": gate.answer_sha(changed), "finding": "not_a_regression"}
        problems, _ = self.check([result("a", "right"), changed, result("c", "right")], rereads=[reread])
        self.assertEqual(problems, [])
        other = result("b", "honest_fail", {"status": "failed", "answer": "another answer"})
        problems, _ = self.check([result("a", "right"), other, result("c", "right")], rereads=[reread])
        self.assertTrue(any("b" in p for p in problems), problems)

    def test_a_confident_wrong_answer_refuses_even_on_a_task_never_right(self):
        problems, stats = self.check([result("a", "right"), result("b", "right"), result("c", "confidently_wrong")])
        self.assertEqual(stats["confidently_wrong"], 1)
        self.assertTrue(any("confidently wrong" in p and "c" in p for p in problems), problems)

    def test_a_check_fault_found_by_hand_is_not_a_confident_wrong_answer_and_not_a_pass(self):
        wrong = result("c", "confidently_wrong")
        reread = {"id": "c", "answer_sha": gate.answer_sha(wrong), "finding": "check_fault"}
        problems, stats = self.check([result("a", "right"), result("b", "right"), wrong], rereads=[reread])
        self.assertEqual(problems, [])
        self.assertEqual((stats["confidently_wrong"], stats["right"]), (0, 2))

    def test_fewer_passes_than_the_floor_refuses(self):
        baseline = dict(self.BASELINE, verdicts={"a": "right", "b": "set_aside", "c": "honest_fail"}, pass_count=2)
        problems, _ = self.check([result("a", "right"), result("b", "set_aside"), result("c", "honest_fail")],
                                 baseline=baseline)
        self.assertTrue(any("floor" in p for p in problems), problems)

    def test_a_task_the_site_blocked_is_counted_apart_never_as_a_pass(self):
        # c was never right, so its block costs nothing against the baseline; it is still not a pass.
        problems, stats = self.check([result("a", "right"), result("b", "right"), result("c", "set_aside")])
        self.assertEqual((stats["right"], stats["set_aside"]), (2, 1))
        self.assertEqual(problems, [])

    # UNB-208 review, S1-4: only the floor caught these, and the floor misses them when another task rises.
    def test_a_task_right_on_the_last_promotion_and_set_aside_now_is_a_regression(self):
        problems, _ = self.check([result("a", "right"), result("b", "set_aside"), result("c", "right")])
        self.assertTrue(any("regressed" in p and "b" in p and "set aside" in p for p in problems), problems)

    def test_a_task_right_on_the_last_promotion_and_dropped_from_the_bank_is_a_regression(self):
        bank = ["a", "c"]
        problems, _ = gate.check_tasks(bank, [result("a", "right"), result("c", "right")], self.BASELINE, [])
        self.assertTrue(any("regressed" in p and "b" in p and "bank" in p for p in problems), problems)

    def test_a_slice_never_counts_the_tasks_outside_it_as_dropped(self):
        problems, _ = gate.check_tasks(["a"], [result("a", "right")], self.BASELINE, [], slice_mode=True)
        self.assertEqual(problems, [])

    def test_a_bank_that_did_not_finish_refuses(self):
        problems, _ = self.check([result("a", "right"), result("b", "right"), result("c", "infra")])
        self.assertTrue(any("not run" in p and "c" in p for p in problems), problems)

    def test_no_recorded_baseline_refuses(self):
        problems, _ = self.check([result(t, "right") for t in self.BANK],
                                 baseline={"build": None, "pass_count": None, "verdicts": {}})
        self.assertTrue(any("baseline" in p for p in problems), problems)

    def test_the_last_line_of_a_result_file_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "r.jsonl"
            path.write_text(json.dumps(result("a", "infra")) + "\n" + json.dumps(result("a", "right")) + "\n")
            self.assertEqual(gate.load_results(str(path))["a"]["outcome"], "right")


class TheBaselineDryRun(unittest.TestCase):
    """Staging e1bb35c6 as measured on 17 Nov 2026 (programme 887958 step 1): the gate refuses, naming every part."""

    def test_the_gate_refuses_staging_as_measured_on_17_november(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = gate.main([
                "check", "--coverage", str(FIXTURE / "coverage-summary.json"),
                "--bank", str(ROOT / "test-banks/gate/bank.json"),
                "--bank-results", str(FIXTURE / "results.jsonl"),
                "--baseline", str(ROOT / "test-banks/gate/promoted.json"),
                "--rereads", str(ROOT / "test-banks/gate/rereads.json"),
            ])
        text = out.getvalue()
        self.assertEqual(code, 1, text)
        for name in gate.GATED_PARTS:
            self.assertIn(name, text)
        self.assertIn("confidently wrong", text)
        self.assertIn("not run", text)
        self.assertIn("baseline", text)
        self.assertTrue(text.rstrip().splitlines()[-1].startswith("PROMOTION_REFUSED"), text)


class WaiverLines(unittest.TestCase):
    """promotion-gate.sh skips the one rule a release's waiver names, and only for that version (UNB-224: 13.1.0 was
    refused by a task bank the Deck runner could not pass, and by coverage before it)."""

    ROOT = pathlib.Path(__file__).resolve().parents[3]

    def run_gate(self, waivers, version):
        import os
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            (tmp / ".github/scripts").mkdir(parents=True)
            (tmp / "bin").mkdir()
            (tmp / "bin/gh").write_text("#!/bin/sh\nexit 0\n")
            (tmp / "bin/gh").chmod(0o755)
            (tmp / ".github/scripts/promotion_gate.py").write_text(
                "import sys\nopen(sys.argv[0] + '.args', 'w').write(' '.join(sys.argv[2:]))\n")
            if waivers is not None:
                (tmp / ".github/promotion-waivers").write_text(waivers)
            env = {"PATH": f"{tmp / 'bin'}:{os.environ['PATH']}", "GITHUB_REPOSITORY": "x/y"}
            if version:
                env["VERSION"] = version
            done = subprocess.run(["sh", str(self.ROOT / ".github/scripts/promotion-gate.sh"), "tree", str(tmp / "out")],
                                  cwd=tmp, env=env, capture_output=True, text=True)
            args = tmp / ".github/scripts/promotion_gate.py.args"
            return done, args.read_text() if args.exists() else None

    def test_a_coverage_waiver_leaves_the_task_bank(self):
        done, args = self.run_gate("13.1.0 coverage why\n", "13.1.0")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("--tasks-only", args)

    def test_a_bank_waiver_leaves_coverage(self):
        done, args = self.run_gate("13.1.0 bank why\n", "13.1.0")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("--coverage-only", args)
        self.assertNotIn("--tasks-only", args)

    def test_both_waived_has_nothing_to_measure(self):
        done, args = self.run_gate("13.1.0 coverage a\n13.1.0 bank b\n", "13.1.0")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIsNone(args)
        self.assertIn("PROMOTION_WAIVED", done.stdout)

    def test_another_version_or_none_is_still_gated_on_both(self):
        for version in ("13.1.1", "13.1.0-rc.2", ""):
            done, args = self.run_gate("13.1.0 coverage a\n13.1.0 bank b\n", version)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertNotIn("--tasks-only", args)
            self.assertNotIn("--coverage-only", args)


if __name__ == "__main__":
    unittest.main()
