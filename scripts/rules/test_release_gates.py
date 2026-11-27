"""What the release gates must keep doing (UNB-208, ledger rows G13, G14 and G16), held by reading the workflows and
running the promotion gate's own script on made-up results. Standard library only; nothing is fetched.

G15 (a feature is done only when its gate ledger re-checks all met) is a rule for whoever reports work done, not
something the repository can see: it stays a person's check.
"""
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
GATE = ROOT / ".github" / "scripts" / "promotion_gate.py"
BANK = ROOT / "test-banks" / "gate"
HARD_SITES = ROOT / "test-banks" / "popular-sites" / "hard-sites.json"
PASSED_ON_PR = ROOT / ".github" / "qa" / "passed_on_pr.py"


def workflow(name):
    return (WORKFLOWS / name).read_text(encoding="utf-8")


def push_branches(text):
    """The branches a workflow's `on: push:` names, and whether the push trigger is narrowed by paths."""
    on = re.search(r"^on:\n((?:[ \t]+.*\n|\n)+)", text, re.M)
    assert on, "the workflow has an on: block"
    block = on.group(1)
    push = re.search(r"^  push:\n((?:    .*\n)*)", block, re.M)
    if not push:
        return [], False
    branches = re.search(r"branches:\s*\[([^\]]*)\]", push.group(1))
    names = [b.strip().strip("\"'") for b in branches.group(1).split(",")] if branches else []
    return names, bool(re.search(r"^\s+paths(?:-ignore)?:", push.group(1), re.M))


def slice_on_a_push_to_staging(workflows):
    """Why the task slice does not run on every push to staging, as sentences; none when it does. It runs there when
    gate-bank.yml takes the push itself, or when a workflow that takes every push to staging calls it for the slice in
    a job a push starts (qa.yml since #760: one run of the slice, in QA's report). What may skip that job on a push is
    held apart, by `what_skips_the_slice_on_a_push`."""
    branches, narrowed = push_branches(workflows["gate-bank.yml"])
    if "staging" in branches:
        return ["gate-bank.yml's push to staging is narrowed by paths"] if narrowed else []
    for name, text in sorted(workflows.items()):
        branches, narrowed = push_branches(text)
        if "staging" not in branches or narrowed:
            continue
        for job in re.split(r"(?m)^  (?=[A-Za-z_][\w-]*:\n)", text.split("\njobs:\n", 1)[-1]):
            if "uses: ./.github/workflows/gate-bank.yml" not in job or not re.search(r"(?m)^      scope: slice$", job):
                continue
            cond = re.search(r"(?m)^    if: (.*)$", job)
            if cond is None or re.match(r"(?:\$\{\{ *)?github\.event_name == 'push' \|\|", cond.group(1)) or cond.group(1).strip() == "github.event_name == 'push'":
                return []
    return ["gate-bank.yml takes no push to staging, and no workflow that takes every push to staging calls it for the slice in a job a push starts"]


def job_block(text, job):
    """One job's lines in a workflow, or '' when it has none."""
    found = re.search(rf"(?ms)^  {re.escape(job)}:\n(.*?)(?=^  [A-Za-z_][\w-]*:\n|\Z)", text.split("\njobs:\n", 1)[-1])
    return found.group(1) if found else ""


# The one condition that may keep the slice's build from a push: the lookup said this tree already passed.
ALREADY_PASSED = "(github.event_name != 'push' || needs.passed.outputs.hit != 'true')"


def what_skips_the_slice_on_a_push(qa):
    """Why a push to staging could miss the slice for a reason other than "this tree already passed the slice on its
    pull request", as sentences; none when that is the only way. The slice's job needs the build job and nothing else;
    the build job needs the lookup and nothing else, and its `if` ends with ALREADY_PASSED; the lookup runs
    passed_on_pr.py with the run's own event, ref and tree, and its job has no `if` and no needs."""
    problems = []
    bank, build, passed = job_block(qa, "bank"), job_block(qa, "build"), job_block(qa, "passed")
    # The slice's job may also need `place` (UNB-235: QA's one place job hands the slice its machine), which runs on
    # every event: no `if`, no needs.
    if re.findall(r"(?m)^    needs: (.*)$", bank) not in (["build"], ["[place, build]"]):
        problems.append("the slice's job needs more, or other, than the build job")
    elif "place" in re.findall(r"(?m)^    needs: (.*)$", bank)[0] and re.search(r"(?m)^    (?:if|needs): ", job_block(qa, "place")):
        problems.append("the place job the slice needs is itself conditional")
    if re.findall(r"(?m)^    needs: (.*)$", build) != ["passed"]:
        problems.append("the build job needs more, or other, than the lookup")
    cond = re.search(r"(?m)^    if: (.*)$", build)
    if cond is None or not cond.group(1).endswith(" && " + ALREADY_PASSED) or cond.group(1).count("needs.") != 1:
        problems.append("the build job's `if` reads something of another job's besides the lookup's hit")
    if re.search(r"(?m)^    (?:if|needs): ", passed):
        problems.append("the lookup job is itself conditional")
    if "outputs:\n      hit: ${{ steps.look.outputs.hit }}\n" not in passed:
        problems.append("the lookup's hit is not its look step's")
    look = re.search(r"(?ms)^      - name: [^\n]*\n        id: look\n(.*?)(?=^      - |\Z)", passed)
    wanted = ('python3 -I .github/qa/passed_on_pr.py --repo "$GITHUB_REPOSITORY" --event "$GITHUB_EVENT_NAME" --ref "$GITHUB_REF"', "--tree \"$(git rev-parse 'HEAD^{tree}')\"")
    if look is None or not all(w in look.group(1) for w in wanted):
        problems.append("the lookup does not run passed_on_pr.py on the run's own event, ref and tree")
    return problems


def passed_on_pr():
    spec = importlib.util.spec_from_file_location("passed_on_pr", PASSED_ON_PR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def gate(*args):
    r = subprocess.run([sys.executable, "-I", str(GATE), "check", *args], capture_output=True, text=True, timeout=60)
    return r.returncode, r.stdout


class EveryMergeIsMeasuredAgain(unittest.TestCase):
    """G13: a pull request merged by hand (past its checks) is measured again: every push to staging, whatever made
    it, runs coverage on staging's head, and the task slice too unless that very tree already passed the slice on its
    pull request (reworded 21 Nov 2026, UNB-166, Lewis: a push whose tree already passed is not run again; a merge
    past its checks has no such run, so it is still measured); and the release gate reads the numbers of the tree it
    ships and refuses without them."""

    def test_coverage_and_the_task_slice_run_on_every_push_to_staging(self):
        for name in ("coverage.yml", "promotion-gate.yml"):
            branches, narrowed = push_branches(workflow(name))
            self.assertIn("staging", branches, f"{name} runs on a push to staging")
            self.assertFalse(narrowed, f"{name}'s push to staging is not narrowed by paths: a merge touching any file is measured")
        self.assertEqual(slice_on_a_push_to_staging({n.name: n.read_text(encoding="utf-8") for n in WORKFLOWS.glob("*.yml")}), [])

    def test_the_one_push_that_skips_the_slice_is_a_tree_that_already_passed_it_on_its_pull_request(self):
        qa = workflow("qa.yml")
        self.assertEqual(what_skips_the_slice_on_a_push(qa), [])
        # Controls: each way the skip could widen is caught.
        self.assertTrue(what_skips_the_slice_on_a_push(qa.replace(" && " + ALREADY_PASSED, " && needs.passed.outputs.hit != 'true' && needs.passed.outputs.other != 'true'", 1)))
        self.assertTrue(what_skips_the_slice_on_a_push(qa.replace("    needs: passed\n", "    needs: [passed, skills]\n", 1)))
        self.assertTrue(what_skips_the_slice_on_a_push(qa.replace("    name: Gate bank\n    needs: [place, build]\n", "    name: Gate bank\n    needs: [place, build, skills]\n", 1)))
        self.assertTrue(what_skips_the_slice_on_a_push(qa.replace("  place:\n    name:", "  place:\n    if: false\n    name:", 1)))
        self.assertTrue(what_skips_the_slice_on_a_push(qa.replace("  passed:\n    name:", "  passed:\n    if: false\n    name:", 1)))
        self.assertTrue(what_skips_the_slice_on_a_push(qa.replace('--event "$GITHUB_EVENT_NAME"', "--event push", 1)))
        self.assertTrue(what_skips_the_slice_on_a_push(qa.replace("hit: ${{ steps.look.outputs.hit }}", "hit: 'true'", 1)))
        # And the lookup itself: a hit only for a successful pull request run of pr-agent-checks.yml, from this
        # repository, on this tree, whose commit also passed pr-check.yml (the MCP check runs only there since #828);
        # a merge past its checks (a failed, cancelled or unfinished run, or none) is no hit.
        pp = passed_on_pr()
        repo, tree, sha = "unbrowse-ai/unbrowse-core", "3219fc34c3190108030b7c024ea564b6c030b460", "9" * 40

        def answers(check=None, **changed):
            run = {"id": 7, "path": ".github/workflows/pr-agent-checks.yml", "event": "pull_request", "status": "completed", "conclusion": "success",
                   "head_sha": sha, "repository": {"full_name": repo}, "head_repository": {"full_name": repo}, **changed}  # fmt: skip
            mcp = {"id": 8, "path": ".github/workflows/pr-check.yml", "event": "pull_request", "status": "completed", "conclusion": "success",
                   "head_sha": sha, "repository": {"full_name": repo}, "head_repository": {"full_name": repo}, **(check or {})}  # fmt: skip
            listed = {"artifacts": [{"name": f"gate-bank-slice-{tree}", "expired": False, "workflow_run": {"id": 7, "repository_id": 1, "head_repository_id": 1}}]}

            def get(path):
                if "/actions/artifacts?" in path:
                    return listed
                if "/actions/runs?" in path:
                    return {"workflow_runs": [mcp] if f"head_sha={sha}" in path else []}
                return run

            return get

        def hit(get, event="push", ref="refs/heads/staging"):
            return pp.find(repo, event, ref, tree, get)[0] is not None

        self.assertTrue(hit(answers()))
        for merged_past_its_checks in ({"conclusion": "failure"}, {"conclusion": "cancelled"}, {"status": "in_progress", "conclusion": None}):
            self.assertFalse(hit(answers(**merged_past_its_checks)), merged_past_its_checks)
        self.assertFalse(hit(lambda path: {"artifacts": []}), "no pull request run on this tree")
        self.assertFalse(hit(answers(path=".github/workflows/qa.yml", event="push")), "the push's own run")
        self.assertFalse(hit(answers(head_repository={"full_name": "someone/unbrowse-core"})), "a fork")
        self.assertFalse(hit(answers(), event="schedule"), "the nightly run runs everything")
        self.assertFalse(hit(answers(), event="workflow_dispatch"), "a run by hand runs everything")
        for no_mcp_check in ({"conclusion": "failure"}, {"status": "in_progress", "conclusion": None}, {"head_sha": "8" * 40}):
            self.assertFalse(hit(answers(check=no_mcp_check)), f"the MCP check didn't pass on that commit: {no_mcp_check}")

    def test_the_task_slice_check_can_fail(self):
        # Positive and negative controls for the slice's half of the test above, on made-up workflows.
        own = "on:\n  push:\n    branches: [staging]\njobs:\n  bank:\n    runs-on: x\n"
        elsewhere = "on:\n  push:\n    branches: [\"release/**\"]\n  workflow_call:\njobs:\n  bank:\n    runs-on: x\n"
        call = "on:\n  push:\n    branches: [staging, main]\njobs:\n  bank:\n    if: github.event_name == 'push' || inputs.model\n    uses: ./.github/workflows/gate-bank.yml\n    with:\n      scope: slice\n"
        self.assertEqual(slice_on_a_push_to_staging({"gate-bank.yml": own}), [])
        self.assertEqual(slice_on_a_push_to_staging({"gate-bank.yml": elsewhere, "qa.yml": call}), [])
        self.assertTrue(slice_on_a_push_to_staging({"gate-bank.yml": elsewhere}))
        self.assertTrue(slice_on_a_push_to_staging({"gate-bank.yml": elsewhere, "qa.yml": call.replace("[staging, main]", "[main]")}))
        self.assertTrue(slice_on_a_push_to_staging({"gate-bank.yml": elsewhere, "qa.yml": call.replace("scope: slice", "scope: none")}))
        self.assertTrue(slice_on_a_push_to_staging({"gate-bank.yml": elsewhere, "qa.yml": call.replace("github.event_name == 'push' || inputs.model", "inputs.model")}))
        self.assertTrue(slice_on_a_push_to_staging({"gate-bank.yml": elsewhere, "qa.yml": call.replace("    branches: [staging, main]\n", "    branches: [staging, main]\n    paths: [src/**]\n")}))

    def test_the_coverage_of_staging_is_kept_by_its_tree_whatever_part_failed(self):
        cov = workflow("coverage.yml")
        report = cov[cov.index("\n  report:") : cov.index("\n  ratchet:")]
        # The pool's same-repository guard may open the `if` (UNB-166); the report still runs after a part's job fails.
        self.assertRegex(
            report,
            r"\n    if: \$\{\{ (?:\(github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name"
            r" == github\.repository\) && \()?!cancelled\(\)\)? \}\}",
            "the report runs after a part's job fails",
        )
        self.assertIn("name: coverage-summary-${{ steps.tree.outputs.tree }}", report)
        self.assertIn("retention-days: 90", report)

    def test_the_release_gate_reads_the_tree_it_ships_and_refuses_when_it_was_not_measured(self):
        sh = (ROOT / ".github" / "scripts" / "promotion-gate.sh").read_text(encoding="utf-8")
        self.assertIn('"coverage-summary-$tree"', sh)
        self.assertIn('--coverage "$dir/coverage-summary-$tree/coverage-summary.json"', sh)
        release = workflow("release.yml")
        self.assertIn("promotion-gate.sh", release, "release.yml runs the gate before a tag publishes")
        with tempfile.TemporaryDirectory() as d:
            rc, out = gate("--coverage-only", "--coverage", os.path.join(d, "missing.json"))
        self.assertEqual(rc, 1, out)
        self.assertIn("REFUSE code coverage: no summary at", out)
        self.assertIn("PROMOTION_REFUSED", out)


class EveryPullRequestIsJudgedOnTheBank(unittest.TestCase):
    """G14: a pull request into staging (the Deck-issue ones among them) is judged on real tasks against the best
    reference run: none that was right may stop being right, and no answer may be confidently wrong."""

    def setUp(self):
        self.slice = json.loads((BANK / "slice.json").read_text(encoding="utf-8"))
        self.bank = {t["id"] for t in json.loads((BANK / "bank.json").read_text(encoding="utf-8"))["tasks"]}

    def test_the_slice_is_tasks_of_the_bank_right_or_set_aside_on_its_reference_run(self):
        # A task the site blocked on the reference run (set_aside: a bot check no person or agent could pass) stays in
        # the slice: it runs on every pull request and refuses one that answers it confidently wrong, but it was never
        # right, so it can't be lost (Lewis, 19 Nov 2026: ticketmaster's Kasada wall). At least six must be right.
        ids = self.slice["ids"]
        self.assertGreaterEqual(len(ids), 6)
        self.assertLessEqual(set(ids), self.bank, "every slice task is a bank task")
        verdicts = self.slice["reference"]["verdicts"]
        self.assertEqual({i for i in ids if verdicts.get(i) not in ("right", "set_aside")}, set(), "each slice task is right or set aside on the reference")
        self.assertGreaterEqual(sum(1 for i in ids if verdicts.get(i) == "right"), 6, "the reference got at least six slice tasks right")

    def test_the_deck_runs_the_slice_on_every_pull_request_head_into_staging_and_says_so_on_it(self):
        sh = (BANK / "deck-slice.sh").read_text(encoding="utf-8")
        self.assertIn("CTX=unb-208/task-slice", sh)
        # The run takes only the slice's tasks, and the verdict is judged on the slice against its reference.
        self.assertRegex(sh, r"run_gate\.py[^\n]*(?:\\\n[^\n]*)*?--slice \"\$H/test-banks/gate/slice\.json\"")
        self.assertRegex(sh, r"promotion_gate\.py\" check --tasks-only[^\n]*\\\n\s+--slice \"\$G/slice\.json\"")
        self.assertRegex(sh, r"statuses/\$sha")

    def _judge(self, outcomes):
        with tempfile.TemporaryDirectory() as d:
            res = os.path.join(d, "results.jsonl")
            with open(res, "w") as f:
                for tid, out in outcomes.items():
                    f.write(json.dumps({"id": tid, "outcome": out, "answer": f"answer of {tid}"}) + "\n")
            empty = os.path.join(d, "promoted.json")
            with open(empty, "w") as f:
                json.dump({}, f)
            return gate("--tasks-only", "--bank", str(BANK / "bank.json"), "--bank-results", res, "--slice", str(BANK / "slice.json"),
                        "--baseline", empty, "--rereads", os.path.join(d, "none.json"))

    def test_the_slice_passes_a_pull_request_that_keeps_every_task_right(self):
        rc, out = self._judge({i: "right" for i in self.slice["ids"]})
        self.assertEqual(rc, 0, out)
        self.assertIn("PROMOTION_OK", out)

    def test_one_confidently_wrong_answer_refuses_the_pull_request(self):
        outcomes = {i: "right" for i in self.slice["ids"]}
        outcomes[self.slice["ids"][0]] = "confidently_wrong"
        rc, out = self._judge(outcomes)
        self.assertEqual(rc, 1, out)
        self.assertIn("confidently wrong (must be 0)", out)

    def _right_on_the_reference(self):
        verdicts = self.slice["reference"]["verdicts"]
        return [i for i in self.slice["ids"] if verdicts.get(i) == "right"]

    def _set_aside_on_the_reference(self):
        verdicts = self.slice["reference"]["verdicts"]
        return [i for i in self.slice["ids"] if verdicts.get(i) == "set_aside"]

    def test_a_task_right_on_the_reference_that_is_not_right_now_refuses_the_pull_request(self):
        outcomes = {i: "right" for i in self.slice["ids"]}
        outcomes[self._right_on_the_reference()[-1]] = "honest_fail"
        rc, out = self._judge(outcomes)
        self.assertEqual(rc, 1, out)
        self.assertIn("are not right now: changed", out)

    def test_a_task_set_aside_on_the_reference_is_not_lost_but_never_confidently_wrong(self):
        aside = self._set_aside_on_the_reference()
        if not aside:
            self.skipTest("no slice task is set aside on the reference")
        outcomes = {i: "right" for i in self.slice["ids"]}
        outcomes[aside[0]] = "honest_fail"
        rc, out = self._judge(outcomes)
        self.assertEqual(rc, 0, out)
        outcomes[aside[0]] = "confidently_wrong"
        rc, out = self._judge(outcomes)
        self.assertEqual(rc, 1, out)
        self.assertIn("confidently wrong (must be 0)", out)

    def test_a_slice_task_that_did_not_run_refuses_the_pull_request(self):
        outcomes = {i: "right" for i in self.slice["ids"][1:]}
        rc, out = self._judge(outcomes)
        self.assertEqual(rc, 1, out)
        self.assertIn("not run", out)


def ledger_problems(ledger):
    """What breaks the hard-site ledger's rule, as sentences; none when it holds."""
    problems, sites = [], ledger.get("sites", [])
    names = [s.get("site") for s in sites]
    if len(set(names)) != len(names):
        problems.append("a site is listed twice")
    pinned = [s["site"] for s in sites if s.get("pinned")]
    if len(pinned) != 1:
        problems.append(f"{len(pinned)} sites pinned as the next target; exactly one is")
    for s in sites:
        name = s.get("site")
        if s.get("status") not in ("open", "won"):
            problems.append(f"{name}: status is open or won")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(s.get("date", ""))):
            problems.append(f"{name}: no date it was seen")
        won = s.get("won")
        if s.get("status") == "won":
            if s.get("pinned"):
                problems.append(f"{name}: won, so another site is pinned")
            if not isinstance(won, dict) or won.get("browserless") is not True or not won.get("build") or not won.get("run") \
                    or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(won.get("date", ""))):
                problems.append(f"{name}: won only with a measured browserless pass (won: date, build, run, browserless true)")
        elif won is not None:
            problems.append(f"{name}: open, yet it names a win")
    return problems


class HardSites(unittest.TestCase):
    """G16: a ledger of the sites Unbrowse can't pass, one pinned as the next target, marked won only on a measured
    browserless pass."""

    def test_the_ledger_holds_its_rule(self):
        ledger = json.loads(HARD_SITES.read_text(encoding="utf-8"))
        self.assertGreater(len(ledger["sites"]), 10)
        self.assertEqual(ledger_problems(ledger), [])

    def test_the_rule_refuses_two_pins_a_pinned_win_and_a_win_with_no_measured_browserless_run(self):
        site = {"site": "a.example", "gate": "DataDome", "status": "open", "pinned": True, "date": "2026-11-19"}
        self.assertEqual(ledger_problems({"sites": [site]}), [])
        self.assertIn("2 sites pinned as the next target; exactly one is", ledger_problems({"sites": [site, {**site, "site": "b.example"}]}))
        won = {**site, "status": "won", "won": {"date": "2026-11-19", "build": "staging 0df04b63", "run": "gate-bank 1", "browserless": True}}
        self.assertIn("a.example: won, so another site is pinned", ledger_problems({"sites": [won]}))
        moved = [{**won, "pinned": False}, {**site, "site": "b.example"}]
        self.assertEqual(ledger_problems({"sites": moved}), [])
        for bad in ({"browserless": False}, {"run": ""}, {"date": "soon"}):
            broken = [{**moved[0], "won": {**moved[0]["won"], **bad}}, moved[1]]
            self.assertTrue(any("measured browserless pass" in p for p in ledger_problems({"sites": broken})), bad)
        self.assertIn("b.example: open, yet it names a win", ledger_problems({"sites": [moved[0], {**moved[1], "won": moved[0]["won"]}]}))


if __name__ == "__main__":
    unittest.main()
