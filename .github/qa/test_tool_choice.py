import json
import tempfile
import unittest
from pathlib import Path

from costs import cost_of
from tool_choice import judge, main, reached_the_node, records, report, tools_called, verdict


def init(*tools):
    return json.dumps({"type": "system", "subtype": "init", "tools": list(tools)})


def called(*names):
    return json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "x"}] + [{"type": "tool_use", "name": n, "input": {}} for n in names]}})


NODE = "mcp__unbrowse__unbrowse_do"
WEB = {"id": "t", "wants": "unbrowse"}
CONTROL = {"id": "c", "wants": "none"}


class ToolChoice(unittest.TestCase):
    def test_the_first_web_tool_is_the_choice(self):
        self.assertTrue(judge(WEB, [called(NODE)])["pass"])
        self.assertTrue(judge(WEB, [called(NODE), called("WebFetch")])["pass"], "it went elsewhere only after the node")
        fetched = judge(WEB, [called("WebFetch"), called(NODE)])
        self.assertFalse(fetched["pass"], "the node as a fallback isn't the node chosen")
        self.assertEqual(fetched["first"], "WebFetch")

    def test_a_tool_that_isnt_the_web_doesnt_count(self):
        self.assertTrue(judge(WEB, [called("TodoWrite", NODE)])["pass"])

    def test_answering_from_memory_is_not_choosing_the_node(self):
        self.assertFalse(judge(WEB, [called()])["pass"])

    def test_a_task_with_no_website_stays_clear_of_the_node(self):
        self.assertTrue(judge(CONTROL, [called()])["pass"])
        self.assertTrue(judge(CONTROL, [called("WebSearch")])["pass"], "only the node is held to this")
        self.assertFalse(judge(CONTROL, [called(NODE)])["pass"])

    def test_a_line_that_isnt_json_is_passed_over(self):
        self.assertEqual(tools_called(["Warning: no stdin data", called(NODE), "[]"]), [NODE])

    def test_a_session_without_the_tools_says_nothing(self):
        self.assertFalse(reached_the_node([init("WebFetch", "WebSearch")]))
        self.assertFalse(reached_the_node([]))
        self.assertTrue(reached_the_node([init("WebFetch", NODE)]))

    def test_calling_the_node_on_everything_cant_pass(self):
        results = [judge(WEB, [called(NODE)]), judge(CONTROL, [called(NODE)])]
        self.assertFalse(verdict(results, 0.8)["pass"])

    def test_the_rate_decides_and_the_report_says_it(self):
        right, wrong = judge(WEB, [called(NODE)]), judge(WEB, [called("WebFetch")])
        self.assertTrue(verdict([right] * 4 + [wrong], 0.8)["pass"])
        result = verdict([right] * 3 + [wrong] * 2, 0.8)
        self.assertFalse(result["pass"])
        self.assertIn("3 of 5", report(result))

    def test_the_prompts_never_name_the_node(self):
        plan = json.loads(Path(__file__).with_name("tool-choice.json").read_text())
        self.assertTrue(any(t["wants"] == "none" for t in plan["tasks"]), "a control is what keeps the check honest")
        for task in plan["tasks"]:
            self.assertNotIn("unbrowse", task["prompt"].lower())
            self.assertIn(task["wants"], ("unbrowse", "none"))

    def test_trials_give_a_pass_rate_with_pass_at_k_and_pass_all_k(self):
        right, wrong = judge(WEB, [called(NODE)]), judge(WEB, [called("WebFetch")])
        result = verdict([right, wrong, right], 0.5)
        self.assertEqual(result["tasks"]["t"], {"trials": 3, "passed": 2, "pass_at_k": True, "pass_all_k": False})
        self.assertIn("| t | unbrowse | 2/3 | yes | no |", report(result))

    def test_records_are_found_in_trial_order(self):
        folder = Path(tempfile.mkdtemp())
        for name in ("a.jsonl", "a.t10.jsonl", "a.t2.jsonl", "ab.t2.jsonl"):
            (folder / name).write_text("")
        self.assertEqual([p.name for p in records(folder, "a")], ["a.jsonl", "a.t2.jsonl", "a.t10.jsonl"])
        self.assertEqual([p.name for p in records(folder, "a", 2)], ["a.jsonl", "a.t2.jsonl"])

    def test_scoring_reads_every_trial_and_what_it_cost(self):
        folder = Path(tempfile.mkdtemp())
        tasks = folder / "tasks.json"
        tasks.write_text(json.dumps({"passes_at": 0.5, "tasks": [{"id": "t", "wants": "unbrowse", "prompt": "p"}]}))
        result = json.dumps({"type": "result", "total_cost_usd": 0.25, "num_turns": 3, "duration_ms": 4000, "usage": {"input_tokens": 10, "output_tokens": 5}})
        (folder / "t.jsonl").write_text("\n".join([init(NODE), called(NODE), result]))
        (folder / "t.t2.jsonl").write_text("\n".join([init(NODE), called("WebFetch"), result]))
        self.assertEqual(main(["--mcp-config", "x", "--out", str(folder), "--tasks", str(tasks), "--score-only"]), 0)
        scored = json.loads((folder / "tool-choice.json").read_text())
        self.assertEqual(scored["tasks"]["t"]["passed"], 1)
        self.assertEqual(scored["cost"]["usd"], 0.5)
        self.assertEqual(scored["cost"]["input_tokens"], 20)

    def test_a_run_with_no_result_has_no_cost_and_an_action_file_is_read(self):
        self.assertIsNone(cost_of(called(NODE)))
        action = json.dumps([{"type": "system"}, {"type": "result", "total_cost_usd": 1.5, "num_turns": 40, "usage": {"output_tokens": 7}}])
        self.assertEqual(cost_of(action)["turns"], 40)
        self.assertEqual(cost_of(action)["output_tokens"], 7)


if __name__ == "__main__":
    unittest.main()
