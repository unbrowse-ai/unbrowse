"""The gate bank's runner writes down what the client model and the judge model said, and decides nothing itself.

A stand-in `claude` (written per test) plays both models; no key, node or site is needed.
Run: python3 -m unittest discover -s test-banks/gate -p 'test_*.py' -v
"""
import json
import os
import pathlib
import re
import stat
import sys
import tempfile
import textwrap
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run_gate  # noqa: E402

FAKE = textwrap.dedent(r'''
    #!/usr/bin/env python3
    import json, os, sys
    args = sys.argv[1:]
    prompt = args[args.index("-p") + 1]
    is_client = "--mcp-config" in args
    with open(os.environ["FAKE_LOG"], "a") as f:
        f.write(json.dumps({"client": is_client, "prompt": prompt, "args": args}) + "\n")
    def say(ev):
        print(json.dumps(ev))
    if is_client:
        sc = json.loads(os.environ["FAKE_CLIENT"])
        if sc.get("tool_text") is not None:
            say({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1",
                 "name": "mcp__unbrowse__unbrowse_do", "input": {"url": "https://example.com"}}]}})
            say({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1",
                 "content": [{"type": "text", "text": sc["tool_text"]}]}]}})
        final = sc.get("final", "")
        if sc.get("answer") is not None:
            final += "\n```json\n" + json.dumps(sc["answer"]) + "\n```"
        if sc.get("sleep"):
            import time
            time.sleep(sc["sleep"])
        say({"type": "result", "result": final, "total_cost_usd": 0.01, "num_turns": 2})
    else:
        say({"type": "result", "result": os.environ["FAKE_JUDGE"], "total_cost_usd": 0.001})
''').lstrip()

TASK = {"id": "u6:t1", "source": "unbrowse6", "url": "https://example.com/", "task": "Find the code",
        "check": "regex:8507\\.60"}
ANSWERED = {"status": "answered", "answer": "HTS 8507.60", "items": [], "source_url": "https://example.com/"}


def judged(meets, finished=True):
    return "```json\n" + json.dumps({"meets_check": meets, "finished": finished, "why": "w"}) + "\n```"


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = pathlib.Path(self.tmp.name)
        self.claude = d / "claude"
        self.claude.write_text(FAKE)
        self.claude.chmod(self.claude.stat().st_mode | stat.S_IEXEC)
        self.bank = d / "bank.json"
        self.bank.write_text(json.dumps({"tasks": [TASK, dict(TASK, id="u6:t2")]}))
        self.out = d / "results.jsonl"
        self.log = d / "calls.jsonl"
        os.environ["FAKE_LOG"] = str(self.log)

    def tearDown(self):
        self.tmp.cleanup()

    def run_bank(self, client, judge_text=judged(True), ids="u6:t1", more=()):
        os.environ["FAKE_CLIENT"] = json.dumps(client)
        os.environ["FAKE_JUDGE"] = judge_text
        run_gate.main(["run", "--mcp", "mcp.json", "--out", str(self.out), "--claude", str(self.claude),
                       "--bank", str(self.bank), "--ids", ids, "--jobs", "1", "--timeout", "60", *more])
        return run_gate.load_results(str(self.out))

    def calls(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []



class Runner(Fixture):
    def test_an_answer_the_judge_finds_meets_its_check_is_right(self):
        res = self.run_bank({"tool_text": "rows", "answer": ANSWERED})
        self.assertEqual(res["u6:t1"]["outcome"], "right")
        judge = [c for c in self.calls() if not c["client"]]
        self.assertEqual(len(judge), 1)
        self.assertIn("regex:8507\\.60", judge[0]["prompt"])
        self.assertIn("HTS 8507.60", judge[0]["prompt"])
        self.assertNotIn("--mcp-config", judge[0]["args"])

    def test_the_judge_decides_not_a_script(self):
        # The answer would pass the check's regex; the judge says it does not meet it, and the judge's word stands.
        res = self.run_bank({"tool_text": "rows", "answer": ANSWERED}, judged(False))
        self.assertEqual(res["u6:t1"]["outcome"], "confidently_wrong")

    def test_a_wall_is_set_aside_and_never_judged(self):
        res = self.run_bank({"tool_text": "captcha", "answer": {"status": "gate", "gate": {"kind": "bot"}}})
        self.assertEqual(res["u6:t1"]["outcome"], "set_aside")
        self.assertEqual([c for c in self.calls() if not c["client"]], [])

    def test_an_honest_failure(self):
        res = self.run_bank({"tool_text": "500", "answer": {"status": "failed", "answer": ""}})
        self.assertEqual(res["u6:t1"]["outcome"], "honest_fail")

    def test_a_page_that_needed_clicks_the_agent_did_not_finish(self):
        res = self.run_bank({"tool_text": '{"how": "browse"}', "answer": ANSWERED}, judged(True, finished=False))
        self.assertEqual(res["u6:t1"]["outcome"], "unfinished")
        self.assertTrue(res["u6:t1"]["needed_hands"])

    def test_no_final_json_is_an_error(self):
        res = self.run_bank({"tool_text": "rows", "final": "I ran out of turns"})
        self.assertEqual(res["u6:t1"]["outcome"], "error")

    def test_a_judge_without_a_verdict_is_rerun_not_scored(self):
        res = self.run_bank({"tool_text": "rows", "answer": ANSWERED}, "I think it is fine")
        self.assertEqual(res["u6:t1"]["outcome"], "infra")

    def test_a_server_that_never_connected_is_rerun_not_scored(self):
        res = self.run_bank({"tool_text": None, "final": "The unbrowse tools are not available (failed to connect)."})
        self.assertEqual(res["u6:t1"]["outcome"], "infra")

    def test_a_rerun_skips_finished_tasks_and_retries_infra(self):
        self.run_bank({"tool_text": None, "final": "failed to connect"}, ids="u6:t1,u6:t2")
        before = len(self.calls())
        res = self.run_bank({"tool_text": "rows", "answer": ANSWERED}, ids="u6:t1,u6:t2")
        self.assertEqual({r["outcome"] for r in res.values()}, {"right"})
        self.run_bank({"tool_text": "rows", "answer": ANSWERED}, ids="u6:t1,u6:t2")
        self.assertEqual(len(self.calls()), before + 4)  # two clients and two judges, then nothing

    def test_keys_in_a_tool_reply_never_reach_the_results(self):
        self.run_bank({"tool_text": "token unb_abcdefghijklmnop here", "answer": ANSWERED})
        self.assertNotIn("unb_abcdefghijklmnop", self.out.read_text())

    def test_the_client_gets_only_the_nodes_tools(self):
        self.run_bank({"tool_text": "rows", "answer": ANSWERED})
        args = [c for c in self.calls() if c["client"]][0]["args"]
        self.assertEqual(args[args.index("--allowedTools") + 1], "mcp__unbrowse")
        self.assertIn("--strict-mcp-config", args)
        for tool in ("Bash", "WebFetch", "WebSearch", "Read", "Write"):
            self.assertIn(tool, args[args.index("--disallowedTools") + 1].split(","))


# A stand-in node: a process that holds `mb` MB, its pid in a file the way scratch-node.sh writes node.pid.
NODE = "import sys, time\nheld = bytearray(int(sys.argv[1]) << 20)\nfor i in range(0, len(held), 4096):\n    held[i] = 1\ntime.sleep(120)\n"


class TheNodesMemory(Fixture):
    """G09 (UNB-208): the bank records each task's peak node memory, and a node killed at the cap is a fail: memory."""

    def node(self, mb):
        import subprocess
        p = subprocess.Popen([sys.executable, "-c", NODE, str(mb)])
        self.addCleanup(lambda: (p.kill(), p.wait()))
        pid = pathlib.Path(self.tmp.name) / "node.pid"
        pid.write_text(f"{p.pid}\n")
        for _ in range(100):
            if (run_gate.rss_mb(p.pid) or 0) >= mb:
                break
            import time
            time.sleep(0.05)
        return p, pid

    def test_each_task_records_the_nodes_peak_memory(self):
        _, pid = self.node(64)
        res = self.run_bank({"tool_text": "rows", "answer": ANSWERED, "sleep": 1},
                            more=["--node-pid-file", str(pid), "--rss-every", "0.2"])
        self.assertEqual(res["u6:t1"]["outcome"], "right")
        self.assertGreaterEqual(res["u6:t1"]["node_peak_rss_mb"], 64)
        self.assertLess(res["u6:t1"]["node_peak_rss_mb"], run_gate.RSS_CAP_MB)

    def test_a_node_killed_at_the_cap_is_a_fail_for_memory_never_a_rerun(self):
        p, pid = self.node(96)
        res = self.run_bank({"tool_text": "rows", "answer": ANSWERED, "sleep": 2}, ids="u6:t1,u6:t2",
                            more=["--node-pid-file", str(pid), "--rss-every", "0.2", "--rss-cap-mb", "64"])
        self.assertIsNotNone(p.poll(), "the node over its cap was stopped")
        killed = [r for r in res.values() if r.get("fail_reason") == "memory"]
        self.assertEqual(len(killed), 1, res)
        self.assertEqual(killed[0]["outcome"], "error")
        self.assertGreaterEqual(killed[0]["node_peak_rss_mb"], 64)
        self.assertEqual([c for c in self.calls() if not c["client"]], [], "a memory kill goes to no judge")
        self.assertEqual(len(res), 1, "no task starts on a node that was stopped")

    def test_no_node_named_records_nothing(self):
        res = self.run_bank({"tool_text": "rows", "answer": ANSWERED})
        self.assertNotIn("node_peak_rss_mb", res["u6:t1"])


# The step in .github/workflows/gate-bank.yml that holds the credential runs each .args file with this, and nothing of
# this repository: perl reads the NUL-separated arguments and becomes the CLI, under an alarm.
RUN_ARGS = "$t=shift; $b=shift; local $/; open F, shift or die; @a=split /\\0/, <F>; alarm $t; exec $b, @a"


class TheCiSteps(Fixture):
    """prepare -> (the credential's step runs the clients) -> judges -> (it runs the judges) -> collect."""

    def run_folder(self, folder):
        import subprocess
        for f in sorted(pathlib.Path(folder).glob("*.args")):
            with open(f.with_suffix(".out"), "w") as out:
                subprocess.run(["perl", "-e", RUN_ARGS, "60", str(self.claude), str(f)], stdout=out,
                               stdin=subprocess.DEVNULL, check=False)

    def test_the_split_run_gives_what_the_one_process_run_gives(self):
        d = pathlib.Path(self.tmp.name) / "ci"
        os.environ["FAKE_CLIENT"] = json.dumps({"tool_text": "rows", "answer": ANSWERED})
        os.environ["FAKE_JUDGE"] = judged(False)
        run_gate.main(["prepare", "--dir", str(d), "--mcp", "m0.json", "--mcp", "m1.json", "--per", "1",
                       "--bank", str(self.bank), "--claude", str(self.claude)])
        self.assertEqual(sorted(p.name for p in d.iterdir()), ["round-0", "round-1"])
        args = (d / "round-1" / "000.args").read_bytes().split(b"\0")
        self.assertEqual(args[args.index(b"--mcp-config") + 1], b"m1.json")
        for r in ("round-0", "round-1"):
            self.run_folder(d / r)
        run_gate.main(["judges", "--dir", str(d), "--claude", str(self.claude)])
        self.assertEqual(len(list((d / "judge").glob("*.args"))), 2)
        self.run_folder(d / "judge")
        run_gate.main(["collect", "--dir", str(d), "--out", str(self.out), "--claude", str(self.claude)])
        res = run_gate.load_results(str(self.out))
        self.assertEqual({k: v["outcome"] for k, v in res.items()},
                         {"u6:t1": "confidently_wrong", "u6:t2": "confidently_wrong"})
        judge_prompts = [c["prompt"] for c in self.calls() if not c["client"]]
        self.assertTrue(all("regex:8507\\.60" in p for p in judge_prompts))

    def test_a_client_killed_by_its_alarm_is_an_error_not_a_pass(self):
        d = pathlib.Path(self.tmp.name) / "ci"
        run_gate.main(["prepare", "--dir", str(d), "--mcp", "m0.json", "--per", "5", "--bank", str(self.bank),
                       "--claude", str(self.claude)])
        (d / "round-0" / "000.out").write_text("")  # the alarm fired before the CLI said anything
        (d / "round-0" / "001.out").write_text("")
        run_gate.main(["judges", "--dir", str(d)])
        run_gate.main(["collect", "--dir", str(d), "--out", str(self.out)])
        res = run_gate.load_results(str(self.out))
        self.assertEqual({v["outcome"] for v in res.values()}, {"error"})
        self.assertTrue(all(v["timed_out"] for v in res.values()))


class TheBank(unittest.TestCase):
    def test_every_task_has_a_check_the_judge_is_told_in_words(self):
        tasks = json.loads((HERE / "bank.json").read_text())["tasks"]
        self.assertEqual(len(tasks), 91)
        for t in tasks:
            words = run_gate.describe_check(t["check"])
            self.assertFalse(words.startswith(t["check"].split(":")[0] + ":"), (t["id"], words))

    def test_the_slice_is_tasks_of_the_bank_with_a_reference_verdict_each(self):
        ids = {t["id"] for t in json.loads((HERE / "bank.json").read_text())["tasks"]}
        sl = json.loads((HERE / "slice.json").read_text())
        self.assertTrue(set(sl["ids"]) <= ids)
        self.assertEqual(set(sl["reference"]["verdicts"]), set(sl["ids"]))

    def test_the_slice_runs_the_criteria_sites(self):
        # Lewis, 18 Nov 2026: staging is fast, browserless and complete "on sites like lazada carousell and
        # ticketmaster". A pull request is checked on those three, by the judge reading the answer.
        sl = json.loads((HERE / "slice.json").read_text())
        tasks = {t["id"]: t for t in json.loads((HERE / "bank.json").read_text())["tasks"]}
        for site in ("lazada.sg", "carousell.sg", "ticketmaster.com"):
            tid = "criteria:" + site
            self.assertIn(tid, sl["ids"], site)
            self.assertIn(site, tasks[tid]["url"])
            self.assertTrue(tasks[tid]["check"].startswith("count>=5:"), tasks[tid]["check"])
            self.assertIn("link", tasks[tid]["check"])

    def test_each_check_agrees_with_what_a_person_found_on_the_site(self):
        # The checks are read literally here (the judge reads the same words): an answer a person found right on
        # the site meets its task's check, and the one they found wrong still misses it.
        def meets(rule, ans):
            texts = [ans.get("answer") or ""] + list(ans.get("items") or [])
            for alt in re.split(r"\|(?=(?:contains|regex|count>=\d+|items_match>=\d+):)", rule):
                kind, _, arg = alt.partition(":")
                n = int(kind.split(">=")[1]) if ">=" in kind else 0
                if kind == "regex" and any(re.search(arg, x) for x in texts):
                    return True
                if kind == "contains" and any(arg.lower() in x.lower() for x in texts):
                    return True
                if kind.startswith("items_match") and sum(bool(re.search(arg, x)) for x in ans["items"]) >= n:
                    return True
                if kind.startswith("count") and len(ans.get("items") or []) >= n:
                    return True
            return False

        checks = {t["id"]: t["check"] for t in json.loads((HERE / "bank.json").read_text())["tasks"]}
        audits = json.loads((HERE / "fixtures/hand-audits-2026-11-18.json").read_text())["audits"]
        for a in audits:
            with self.subTest(task=a["id"], audit=a["audit"]):
                self.assertEqual(meets(checks[a["id"]], a["answer"]), a["audit"] == "right", checks[a["id"]])


if __name__ == "__main__":
    unittest.main()
