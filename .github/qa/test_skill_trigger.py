"""skill_trigger.py scores from the session's own record: the first skill or web tool it reached for."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import skill_trigger  # noqa: E402

INIT = json.dumps({"type": "system", "subtype": "init", "tools": ["Skill", "WebFetch", "WebSearch"]})


def use(name, **given):
    return json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": name, "input": given}]}})


OURS = {"unbrowse", "unbrowse-map", "verify-unbrowse"}


class SkillTriggerTest(unittest.TestCase):
    def test_the_right_skill_first_passes(self):
        self.assertTrue(skill_trigger.judge({"id": "a", "wants": "unbrowse"}, [INIT, use("Skill", skill="unbrowse")], OURS)["pass"])

    def test_a_web_tool_before_the_skill_fails(self):
        self.assertFalse(skill_trigger.judge({"id": "a", "wants": "unbrowse"}, [INIT, use("WebFetch"), use("Skill", skill="unbrowse")], OURS)["pass"])

    def test_another_skill_fails_and_a_namespace_is_read(self):
        self.assertFalse(skill_trigger.judge({"id": "a", "wants": "unbrowse-map"}, [INIT, use("Skill", skill="unbrowse")], OURS)["pass"])
        self.assertTrue(skill_trigger.judge({"id": "a", "wants": "unbrowse-map"}, [INIT, use("Skill", skill="x:unbrowse-map")], OURS)["pass"])

    def test_a_near_miss_passes_only_clear_of_our_skills(self):
        self.assertTrue(skill_trigger.judge({"id": "n", "wants": "none"}, [INIT, use("WebSearch")], OURS)["pass"])
        self.assertTrue(skill_trigger.judge({"id": "n", "wants": "none"}, [INIT, use("Skill", skill="someone-elses")], OURS)["pass"])
        self.assertFalse(skill_trigger.judge({"id": "n", "wants": "none"}, [INIT, use("Skill", skill="unbrowse")], OURS)["pass"])

    def test_plan_then_score(self):
        tmp = Path(tempfile.mkdtemp())
        evals = tmp / "evals.json"
        evals.write_text(json.dumps({"trials": 2, "passes_at": 0.5, "tasks": [{"id": "q", "wants": "unbrowse", "prompt": "p"}, {"id": "n", "wants": "none", "prompt": "m"}]}))
        skills = tmp / "skills/unbrowse"
        skills.mkdir(parents=True)
        (skills / "SKILL.md").write_text("")
        out = tmp / "runs"
        self.assertEqual(skill_trigger.main(["--evals", str(evals), "--plan", str(out / "plan.jsonl")]), 0)
        lines = [json.loads(line) for line in (out / "plan.jsonl").read_text().splitlines()]
        self.assertEqual([x["record"] for x in lines], ["q.jsonl", "q.t2.jsonl", "n.jsonl", "n.t2.jsonl"])
        (out / "q.jsonl").write_text("\n".join([INIT, use("Skill", skill="unbrowse")]))
        (out / "q.t2.jsonl").write_text("\n".join([INIT, use("WebFetch")]))
        (out / "n.jsonl").write_text(INIT)
        (out / "n.t2.jsonl").write_text(INIT)
        self.assertEqual(skill_trigger.main(["--evals", str(evals), "--skills", str(tmp / "skills"), "--score", str(out)]), 0)
        result = json.loads((out / "skill-trigger.json").read_text())
        self.assertEqual(result["tasks"]["q"], {"trials": 2, "passed": 1, "pass_at_k": True, "pass_all_k": False})
        self.assertTrue(result["pass"])

    def test_a_session_without_the_skill_tool_says_nothing(self):
        tmp = Path(tempfile.mkdtemp())
        evals = tmp / "evals.json"
        evals.write_text(json.dumps({"passes_at": 0.5, "tasks": [{"id": "q", "wants": "unbrowse", "prompt": "p"}]}))
        (tmp / "q.jsonl").write_text(json.dumps({"type": "system", "subtype": "init", "tools": ["WebFetch"]}))
        self.assertEqual(skill_trigger.main(["--evals", str(evals), "--score", str(tmp)]), 1)

    def test_the_queries_name_no_skill(self):
        plan = json.loads(Path(__file__).with_name("skill-evals.json").read_text())
        names = {p.parent.name for p in (Path(__file__).resolve().parents[2] / "skills").glob("*/SKILL.md")}
        self.assertTrue(any(t["wants"] == "none" for t in plan["tasks"]), "near misses keep it honest")
        self.assertEqual({t["wants"] for t in plan["tasks"]} - {"none"}, names, "every shipped skill has a query")
        for task in plan["tasks"]:
            for name in names:
                self.assertNotIn(name, task["prompt"].lower().replace("unbrowse-core", ""))


if __name__ == "__main__":
    unittest.main()
