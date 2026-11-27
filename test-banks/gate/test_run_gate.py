"""The gate bank's runner writes down what the client model and the judge model said, and decides nothing itself.

A stand-in `claude` (written per test) plays both models; no key, node or site is needed.
Run: python3 -m unittest discover -s test-banks/gate -p 'test_*.py' -v
"""
import contextlib
import io
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
        if "This warm task" in prompt and "warm_tool_text" in sc:
            sc["tool_text"] = sc["warm_tool_text"]
        limit = sc.get("rate_limited_first") or 0
        if limit:
            count = os.environ["FAKE_COUNT"]
            n = int(open(count).read()) if os.path.exists(count) else 0
            open(count, "w").write(str(n + 1))
            if n < limit:
                print("429 Too Many Requests: try again in 1s", file=sys.stderr)
                sys.exit(1)
        if sc.get("tool_text") is not None:
            say({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1",
                 "name": sc.get("tool", "mcp__unbrowse__unbrowse_do"), "input": {"url": "https://example.com"}}]}})
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

    def test_a_spent_credential_is_the_runs_infrastructure_not_the_sites_verdict(self):
        # 26 Nov 2026, run 45750120438: 1,970 tasks filed as "error" whose every ask was the same three words, and the
        # gate read them as sites the node had failed. The ask never reached a site.
        with self.assertRaises(SystemExit):
            self.run_bank({"tool_text": "rows", "final": "opencode: ChatGPT usage limit reached. Check ChatGPT Settings "
                                                            "→ Usage for details."})
        res = run_gate.load_results(str(self.out))["u6:t1"]
        self.assertEqual(res["outcome"], "infra")
        self.assertTrue(res["fail_reason"].startswith("credential: "), res["fail_reason"])

    def test_a_spent_credential_stops_the_run_instead_of_writing_a_thousand_errors(self):
        with self.assertRaisesRegex(SystemExit, "credential refused the ask"):
            self.run_bank({"tool_text": "rows", "final": "Credit balance is too low"}, ids="u6:t1,u6:t2")
        self.assertEqual(len([c for c in self.calls() if c["client"]]), 1, "the run went on behind a dead credential")

    def test_a_dead_key_is_the_runs_infrastructure_and_stops_it(self):
        # 26 Nov 2026, run 45834815854 (credits route, AGENT_AUTH=key): every client said the same sentence and died in
        # under a second — "opencode: Reconnect OpenCode Console to continue." — and the run filed twelve task errors.
        with self.assertRaisesRegex(SystemExit, "credential refused the ask"):
            self.run_bank({"tool_text": "rows", "final": "opencode: Reconnect OpenCode Console to continue."},
                          ids="u6:t1,u6:t2")
        res = run_gate.load_results(str(self.out))["u6:t1"]
        self.assertEqual(res["outcome"], "infra")
        self.assertTrue(res["fail_reason"].startswith("credential: "), res["fail_reason"])
        self.assertEqual(len([c for c in self.calls() if c["client"]]), 1, "the run went on behind a dead key")

    def test_a_gate_says_whether_the_client_took_a_check_through_the_node(self):
        asked = {"trace": [{"tool": "mcp__unbrowse__unbrowse_challenge", "result": '{"asks": true}'}],
                 "answer": {"status": "gate"}, "final_text": ""}
        self.assertEqual(run_gate.first_outcome(asked), "set_aside")
        self.assertTrue(asked["challenged"])
        gave_up = {"trace": [{"tool": "mcp__unbrowse__unbrowse_do", "result": '{"error":"blocked"}'}],
                   "answer": {"status": "gate"}, "final_text": ""}
        self.assertEqual(run_gate.first_outcome(gave_up), "set_aside", "a wall is never a pass, either way")
        self.assertFalse(gave_up["challenged"])

    def test_a_key_out_of_credits_is_the_runs_infrastructure_too(self):
        # 26 Nov 2026, the six-site OrcaRouter smoke: four tasks were filed `error` with
        # "You're out of credits — this request needs $0.16" behind them, and no page was ever opened.
        for said in ("opencode: You're out of credits — this request needs $0.16. Add credits to keep going",
                     # And the 1k run at 16:50: 3,841 tasks errored on "Insufficient balance. This request is
                     # pay-as-you-go ... OpenCode Go covers only requests to the OpenCode Go provider."
                     "opencode: Insufficient balance. This request is pay-as-you-go, billed to OpenCode Models credits."):
            with self.subTest(said=said[:40]):
                self.out.unlink(missing_ok=True)
                with self.assertRaisesRegex(SystemExit, "credential refused the ask"):
                    self.run_bank({"tool_text": "rows", "final": said})
                res = run_gate.load_results(str(self.out))["u6:t1"]
                self.assertEqual(res["outcome"], "infra")
                self.assertTrue(res["fail_reason"].startswith("credential: "), res["fail_reason"])

    def test_a_site_saying_401_is_still_the_sites_failure_not_the_credentials(self):
        # A page's words are in a tool reply; only a client that gave no answer at all is read for a refusal.
        res = self.run_bank({"tool_text": "401 Unauthorized", "final": "I ran out of turns"})
        self.assertEqual(res["u6:t1"]["outcome"], "error")

    def test_a_rate_limited_ask_is_waited_out_and_asked_again(self):
        # A per-minute window is the provider asking for time, not a verdict: the same ask comes back with an answer.
        os.environ.update(FAKE_COUNT=str(self.log.parent / "count"), GATE_RETRY_BASE_S="0")
        self.addCleanup(lambda: [os.environ.pop(k, None) for k in ("FAKE_COUNT", "GATE_RETRY_BASE_S")])
        res = self.run_bank({"tool_text": "rows", "answer": ANSWERED, "rate_limited_first": 1})
        self.assertEqual(res["u6:t1"]["outcome"], "right")
        self.assertEqual(len([c for c in self.calls() if c["client"]]), 2, "the limited ask was not asked again")

    def test_an_ask_still_rate_limited_after_every_wait_is_rerun_not_errored_or_stopped(self):
        # Waited out and still limited: `infra` (a rerun retries it), and the next task is still asked — one lane's
        # congestion is not the next lane's.
        os.environ.update(FAKE_COUNT=str(self.log.parent / "count"), GATE_RETRY_BASE_S="0", GATE_RETRY_TRIES="2")
        self.addCleanup(lambda: [os.environ.pop(k, None)
                                 for k in ("FAKE_COUNT", "GATE_RETRY_BASE_S", "GATE_RETRY_TRIES")])
        res = self.run_bank({"tool_text": "rows", "rate_limited_first": 99}, ids="u6:t1,u6:t2")
        self.assertEqual(res["u6:t1"]["outcome"], "infra")
        self.assertTrue(res["u6:t1"]["fail_reason"].startswith("rate_limited: "), res["u6:t1"]["fail_reason"])
        self.assertEqual(res["u6:t2"]["outcome"], "infra")
        self.assertEqual(len([c for c in self.calls() if c["client"]]), 4, "the waits or the second task did not run")

    def test_a_spent_usage_window_is_not_waited_for(self):
        # "usage limit reached" is not a rate limit: no wait brings the window back, so it is asked once.
        os.environ.update(FAKE_COUNT=str(self.log.parent / "count"), GATE_RETRY_BASE_S="0")
        self.addCleanup(lambda: [os.environ.pop(k, None) for k in ("FAKE_COUNT", "GATE_RETRY_BASE_S")])
        with self.assertRaises(SystemExit):
            self.run_bank({"tool_text": "rows", "final": "opencode: ChatGPT usage limit reached"})
        self.assertEqual(len([c for c in self.calls() if c["client"]]), 1)

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

    # Steve QA 2026-11-24, UNB-300: the nightly bank 45323992199 scored seven tasks right that never called the node:
    # its client had Bash and WebFetch, and the judge found their answers met the check.
    def test_an_answer_fetched_without_the_node_is_never_scored_right(self):
        for tool in ("Bash", "WebFetch"):
            with self.subTest(tool=tool):
                r = self.run_bank({"tool": tool, "tool_text": "HTS 8507.60", "answer": ANSWERED})["u6:t1"]
                self.assertEqual(r["outcome"], "infra")
                self.assertEqual(r["fail_reason"], f"off_node: {tool}")

    def test_an_answer_given_with_no_call_to_the_node_is_never_scored_right(self):
        r = self.run_bank({"tool_text": None, "answer": ANSWERED})["u6:t1"]
        self.assertEqual((r["outcome"], r["fail_reason"]), ("infra", "off_node: an answer with no call to the node"))

    # UNB-300, the QA runner's first local run (24 Nov 2026, Claude Code 2.1.331): the CLI loads an MCP server's tools
    # through its own ToolSearch before the first call, so every answer the node gave was set down as off_node.
    def test_loading_the_nodes_own_tools_is_not_answering_from_elsewhere(self):
        res = {"answer": ANSWERED, "final_text": "", "trace": [
            {"tool": "ToolSearch", "result": "mcp__unbrowse__unbrowse_do"},
            {"tool": "mcp__unbrowse__unbrowse_do", "result": "{\"how\": \"called\"}"}]}
        self.assertIsNone(run_gate.first_outcome(res), res.get("fail_reason"))
        res["trace"].append({"tool": "WebFetch", "result": "<html>"})
        self.assertEqual((run_gate.first_outcome(res), res["fail_reason"]), ("infra", "off_node: WebFetch"))

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
        bank = json.loads((HERE / "bank.json").read_text())
        tasks = bank["tasks"]
        self.assertEqual(len(tasks), bank["count"])
        for t in tasks:
            words = run_gate.describe_check(t["check"])
            self.assertFalse(words.startswith(t["check"].split(":")[0] + ":"), (t["id"], words))

    def test_the_slice_is_tasks_of_the_bank_with_a_reference_verdict_each(self):
        ids = {t["id"] for t in json.loads((HERE / "bank.json").read_text())["tasks"]}
        sl = json.loads((HERE / "slice.json").read_text())
        self.assertTrue(set(sl["ids"]) <= ids)
        self.assertEqual(set(sl["reference"]["verdicts"]), set(sl["ids"]))

    def test_the_booking_pair_starts_at_the_native_hotel_results(self):
        from urllib.parse import parse_qs, urlsplit

        tasks = {t["id"]: t for t in json.loads((HERE / "bank.json").read_text())["tasks"]}
        for suffix, city in (("", "Tokyo"), ("#warm", "Osaka")):
            task = tasks["phases:booking.com" + suffix]
            start = urlsplit(task["url"])
            self.assertEqual(start.path, "/searchresults.html")
            query = parse_qs(start.query)
            self.assertEqual(query.get("ss"), [city])
            self.assertEqual(query.get("nflt"), ["ht_id=204"])

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


class TheVerdictStep(unittest.TestCase):
    """The gate bank workflow's verdict step, run as written in .github/workflows/gate-bank.yml.

    Steve QA 2026-11-24, UNB-300: the nightly whole bank (run 45323992199) left 80 of 91 tasks not run, printed
    PROMOTION_REFUSED, and its job concluded success, because the step exited 0 for the whole bank. A refused verdict
    is a red job in either scope.
    """

    def step(self):
        import yaml
        wf = yaml.safe_load((HERE.parents[1] / ".github" / "workflows" / "gate-bank.yml").read_text())
        return next(s for s in wf["jobs"]["bank"]["steps"] if s.get("id") == "verdict")["run"]

    def run_step(self, scope, results=(), **more):
        import subprocess
        with tempfile.TemporaryDirectory() as tmp:
            gate = pathlib.Path(tmp) / "gate"
            (gate / "runs" / "round-0").mkdir(parents=True)
            if results:
                (gate / "results.jsonl").write_text("".join(json.dumps(r) + "\n" for r in results))
            env = {"PATH": os.environ["PATH"], "HOME": tmp, "SCOPE": scope, "GATE": str(gate),
                   "GITHUB_OUTPUT": str(pathlib.Path(tmp) / "out"), "GITHUB_STEP_SUMMARY": str(pathlib.Path(tmp) / "sum"),
                   **more}
            p = subprocess.run(["bash", "-e", "-c", self.step()], cwd=HERE.parents[1], env=env, capture_output=True,
                               text=True, timeout=120)
            return p.returncode, p.stdout + p.stderr, (pathlib.Path(tmp) / "sum").read_text()

    def test_a_whole_bank_that_left_its_tasks_unrun_is_a_red_job_not_a_green_one(self):
        code, said, summary = self.run_step("full")
        self.assertIn("PROMOTION_REFUSED", summary)
        self.assertNotEqual(code, 0, "a whole-bank run whose verdict refuses must not conclude success: " + said)
        self.assertIn("::error title=Gate bank (full) refused::PROMOTION_REFUSED", said)
        self.assertNotIn("GATE_OK", said)

    def test_a_slice_that_left_its_tasks_unrun_is_red_too(self):
        code, said, _ = self.run_step("slice")
        self.assertNotEqual(code, 0, said)

    def test_a_top1k_shard_that_ran_nothing_is_red(self):
        code, said, _ = self.run_step("top1k", SHARD="0/2", SITES="4")
        self.assertNotEqual(code, 0, said)
        self.assertIn("::error title=Gate bank (top1k) ran nothing::", said)

    def test_a_top1k_shard_reports_its_score_and_cost(self):
        row = {"id": "top1k:google.com", "phase": "cold", "outcome": "right", "tool_calls": 2, "wall_s": 90,
               "meta": {"total_cost_usd": 0.2}, "judge_meta": {"total_cost_usd": 0.02, "duration_ms": 9000}}
        code, said, summary = self.run_step("top1k", [row], SHARD="0/2", SITES="4")
        self.assertEqual(code, 0, said)
        self.assertIn("TOP1K_SHARD_OK shard=0/2", said)
        self.assertIn("tasks 4; run 1; not run 3", summary, "shard 0 of 2 of the first four sites is two sites, four tasks")
        self.assertIn("client: $0.20 over 1 run(s)", summary)
        self.assertIn("judge: $0.02 over 1 run(s)", summary)


class EveryShard(unittest.TestCase):
    """gate-bank.yml's job that scores every top1k shard together, run as written. The 20-site pilot (run 45550694686,
    25 Nov 2026) ran 40 tasks in its one shard and this job scored none: one artifact is unpacked straight into the
    download's folder, several each into a folder of its own name, and the step looked only inside named folders."""

    def run_step(self, layout):
        import subprocess
        import yaml
        wf = yaml.safe_load((HERE.parents[1] / ".github" / "workflows" / "gate-bank.yml").read_text())
        step = next(s for s in wf["jobs"]["top1k"]["steps"] if s.get("name") == "Every shard's score")["run"]
        row = lambda i: json.dumps({"id": i, "phase": "cold", "outcome": "right", "tool_calls": 1, "wall_s": 30,
                                    "meta": {"total_cost_usd": 0.1}}) + "\n"
        with tempfile.TemporaryDirectory() as tmp:
            shards = pathlib.Path(tmp) / "shards"
            for folder, ids in layout.items():
                (shards / folder).mkdir(parents=True, exist_ok=True)
                (shards / folder / "results.jsonl").write_text("".join(row(i) for i in ids))
            env = {"PATH": os.environ["PATH"], "HOME": tmp, "RUNNER_TEMP": tmp, "SITES": "2",
                   "GITHUB_ENV": str(pathlib.Path(tmp) / "env"), "GITHUB_STEP_SUMMARY": str(pathlib.Path(tmp) / "sum")}
            p = subprocess.run(["bash", "-e", "-c", step], cwd=HERE.parents[1], env=env, capture_output=True, text=True,
                               timeout=120)
            return p.returncode, p.stdout + p.stderr, (pathlib.Path(tmp) / "sum").read_text() if p.returncode == 0 else ""

    def test_one_shards_artifact_unpacked_straight_into_the_folder_is_scored(self):
        code, said, summary = self.run_step({".": ["top1k:google.com", "top1k:cloudflare.com"]})
        self.assertEqual(code, 0, said)
        self.assertIn("tasks 4; run 2; not run 2", summary)

    def test_several_shards_each_in_its_own_folder_are_scored_together(self):
        code, said, summary = self.run_step({"a-0of2": ["top1k:google.com"], "a-1of2": ["top1k:cloudflare.com"]})
        self.assertEqual(code, 0, said)
        self.assertIn("tasks 4; run 2; not run 2", summary)

    def test_no_shard_results_is_red(self):
        code, said, _ = self.run_step({})
        self.assertNotEqual(code, 0, said)

    def verdict(self, layout, floor=None):
        """The job's verdict step after its score step, as written: meta.json, then promotion_gate.py on the bench."""
        import subprocess
        import yaml
        wf = yaml.safe_load((HERE.parents[1] / ".github" / "workflows" / "gate-bank.yml").read_text())
        steps = {s.get("name"): s["run"] for s in wf["jobs"]["top1k"]["steps"] if s.get("name")}
        cases = top1k_cases()[:2]
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "top1k"
            out.mkdir()
            with open(out / "results.jsonl", "w") as f:
                for tid, o in layout.items():
                    for x in ([o] if isinstance(o, str) else o):
                        f.write(json.dumps({"id": tid, "outcome": x, "answer": {"status": "answered"}}) + "\n")
            env = {"PATH": os.environ["PATH"], "HOME": tmp, "RUNNER_TEMP": tmp, "tree": "t" * 40, "GITHUB_SHA": "c" * 40,
                   "GITHUB_RUN_ID": "7", "RUNNER_KIND": "blacksmith-6vcpu-macos-latest", "NODE_REF": "",
                   "SHARDS": json.dumps([{"i": 0, "n": 2, "label": "x"}]), "SITES": "",
                   "GITHUB_ENV": str(pathlib.Path(tmp) / "env"), "GITHUB_STEP_SUMMARY": str(pathlib.Path(tmp) / "sum")}
            run = steps["The gate's verdict on every shard"]
            if floor is not None:
                (pathlib.Path(tmp) / "floor.json").write_text(json.dumps(floor))
                run = run.replace("--top1k-only", f"--top1k-only --top1k-floor {tmp}/floor.json")
            p = subprocess.run(["bash", "-e", "-c", run], cwd=HERE.parents[1], env=env, capture_output=True, text=True,
                               timeout=120)
            meta = json.loads((out / "meta.json").read_text())
            return p.returncode, p.stdout + p.stderr, meta, (pathlib.Path(tmp) / "env").read_text()

    def test_the_verdict_holds_a_run_that_skipped_a_shard_not_measured_and_red(self):
        # The plant: a run whose shard 1 of 2 never ran, every task it did run right, against a floor it equals.
        ids = [i for c in top1k_cases() for i in ("top1k:" + c["site"], "top1k:" + c["site"] + "#warm")]
        floor = {"build": "v", "runner": "blacksmith-6vcpu-macos-latest", "right": 2, "answered": 2,
                 "confidently_wrong": 0, "verdicts": {i: "right" for i in ids}}
        code, said, meta, env = self.verdict({i: "right" for i in ids[:2]}, floor)
        self.assertNotEqual(code, 0, said)
        self.assertIn("NOT MEASURED: 1998 of 2000 tasks have no result", said)
        self.assertIn("::error title=Gate 1k refused::PROMOTION_REFUSED", said)
        self.assertNotIn("GATE_1K_OK", said)
        self.assertEqual((meta["runner"], meta["shards"], meta["ran"]), ("blacksmith-6vcpu-macos-latest", 2, [0]))
        self.assertIn("name=gate-1k-" + "t" * 40, env, "the refused run is still kept, for the record")

    def test_the_verdict_passes_every_task_measured_as_good_as_the_floor(self):
        ids = [i for c in top1k_cases() for i in ("top1k:" + c["site"], "top1k:" + c["site"] + "#warm")]
        floor = {"build": "v", "runner": "blacksmith-6vcpu-macos-latest", "right": 2000, "answered": 2000,
                 "confidently_wrong": 0, "verdicts": {i: "right" for i in ids}}
        code, said, _, _ = self.verdict({i: "right" for i in ids}, floor)
        self.assertEqual(code, 0, said)
        self.assertIn("GATE_1K_OK", said)


def call(tool, result, is_error=False):
    return {"tool": f"mcp__unbrowse__{tool}", "input": {}, "is_error": is_error, "result": result}


class JudgeEvidence(unittest.TestCase):
    def test_a_followup_using_the_same_read_action_keeps_the_earlier_record(self):
        trace = [call("unbrowse_browse", "earlier browser result " * 180) for _ in range(20)]
        read = call("unbrowse_browse", "leading page text " * 38 + "Actual departure 9:56 PM" + " later rows" * 205)
        read["input"] = {"do": ["eval", "document.body.innerText"]}
        followup = call("unbrowse_browse", "The flight is en route")
        followup["input"] = {"do": ["eval", "document.title"]}
        trace.extend([read, followup])

        evidence = run_gate.judge_evidence(trace)
        self.assertIn("Actual departure 9:56 PM", evidence)
        self.assertIn("The flight is en route", evidence)
        self.assertLessEqual(len(evidence), run_gate.JUDGE_TRACE_LIMIT)

    def test_browser_read_keeps_the_record_before_later_inspection(self):
        trace = [call("unbrowse_browse", "earlier browser result " * 180) for _ in range(20)]
        read = call("unbrowse_browse", "leading page text " * 75 + "Actual departure 9:56 PM" + " later rows" * 180)
        read["input"] = {"do": ["eval", "document.body.innerText"]}
        snapshot = call("unbrowse_browse", "later page snapshot " * 300)
        snapshot["input"] = {"do": ["snapshot"]}
        title = call("unbrowse_browse", "Page title")
        title["input"] = {"do": ["get", "title"]}
        close = call("unbrowse_browse", "Tab closed")
        close["input"] = {"do": ["close"]}
        trace.extend([read, snapshot, title, close])

        evidence = run_gate.judge_evidence(trace)
        self.assertIn("Actual departure 9:56 PM", evidence)
        self.assertIn("Page title", evidence)
        self.assertIn("Tab closed", evidence)
        self.assertLessEqual(len(evidence), run_gate.JUDGE_TRACE_LIMIT)

    def test_a_long_trace_keeps_the_middle_rows_of_the_final_site_read(self):
        rows = "Earlier service\n" * 240 + "26 November departure 9:45 PM, departure estimated\n" + "Later service\n" * 200
        read = call("unbrowse_do", json.dumps({"how":"learned", "result":{"ok":True,"data":{"text":rows}}}))
        trace = [call("unbrowse_do", "earlier page " * 500) for _ in range(16)]
        trace.extend([read, call("unbrowse_browse", "tab closed")])
        evidence = run_gate.judge_evidence(trace)
        self.assertIn("26 November departure 9:45 PM, departure estimated", evidence)
        self.assertIn("tab closed", evidence)
        self.assertLessEqual(len(evidence), run_gate.JUDGE_TRACE_LIMIT)

    def test_a_long_trace_keeps_the_browser_action_without_its_typed_input(self):
        # Staging recovery QA 45772995736: the judge could not identify the browser action in a long trace.
        trace = [{"tool": "mcp__unbrowse__unbrowse_do", "result": "page " * 1600} for _ in range(17)]
        trace.insert(8, {
            "tool": "mcp__unbrowse__unbrowse_browse",
            "input": {"do": ["fill", "@e35", "input value kept out of the judge prompt"]},
            "result": "✓ Done",
        })
        trace.append({"tool": "mcp__unbrowse__unbrowse_browse", "input": {"do": ["snapshot"]},
                      "result": "search results for restitution"})
        prompt = run_gate.judge_prompt(TASK, {"trace": trace, "answer": ANSWERED, "needed_hands": True})
        self.assertIn("(fill): ✓ Done", prompt)
        self.assertIn("(snapshot): search results for restitution", prompt)
        self.assertNotIn("input value kept out of the judge prompt", prompt)
        self.assertLess(len(prompt), 24000)

    def test_judge_sees_answer_records_late_in_a_tool_reply(self):
        # The last item used to fall outside the 1,500 characters passed to the judge.
        reply = json.dumps({"earlier_records": "first records " * 360, "last_item": "Hotel five"})
        events = [
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "1", "name": "mcp__unbrowse__unbrowse_call", "input": {}}
            ]}},
            {"type": "user", "message": {"content": [
                {"type": "tool_result", "tool_use_id": "1", "content": reply}
            ]}},
        ]
        trace, _, _ = run_gate.parse_stream(map(json.dumps, events))
        prompt = run_gate.judge_prompt(TASK, {"trace": trace, "answer": ANSWERED, "needed_hands": False})
        self.assertIn('"last_item": "Hotel five"', prompt)


class Phases(unittest.TestCase):
    """Cold, warm and authed (Lewis, 25 Nov 2026): a warm twin runs after its cold task on the node that learned it,
    is judged against the cold answer, and fails when anything but the learned route answered it."""

    def test_a_completed_cold_browser_read_is_closed_for_learning(self):
        self.assertIn('do: ["close"]', run_gate.COLD_RULES)
        self.assertIn("after you have collected the evidence", run_gate.COLD_RULES)
        self.assertNotIn('do: ["close"]', run_gate.WARM_RULES)

    def test_a_warm_ask_the_route_answered_is_not_browsed(self):
        said = '{"how":"called","route":{"id":"r1"},"result":{"ok":true,"browser":false,"data":[1]}}'
        self.assertEqual(run_gate.warm_browser([call("unbrowse_do", said)]), "")

    def test_a_warm_batch_is_scored_from_each_page_and_its_route(self):
        page = {"how": "called", "route_id": "r1", "ok": True, "browser": False}
        batch = {"how": "pages", "pages": [page]}
        replay = dict(call("unbrowse_do", json.dumps(batch)), tool="mcp__unbrowse__unbrowse_do")
        self.assertEqual(run_gate.warm_browser([replay]), "")
        self.assertEqual(run_gate.route_evidence([replay], cold=False), {"r1"})

        batch["pages"].append({"how": "learned", "route_id": "r2", "ok": True, "browser": True})
        learned = call("unbrowse_do", json.dumps(batch))
        self.assertIn("how=learned", run_gate.warm_browser([learned]))
        self.assertIn("browser: true", run_gate.warm_browser([learned]))

    def test_a_declined_batch_page_does_not_count_as_using_the_browser(self):
        batch = {"how": "pages", "pages": [
            {"how": "called", "route_id": "r1", "ok": True, "browser": False},
            {"how": "error", "outcome": "browser_declined", "ok": False},
        ]}
        replay = dict(call("unbrowse_do", json.dumps(batch)), tool="mcp__unbrowse__unbrowse_do")
        self.assertEqual(run_gate.warm_browser([replay]), "")
        self.assertEqual(run_gate.route_evidence([replay], cold=False), {"r1"})

        batch["pages"][1]["browser"] = True
        browsed = call("unbrowse_do", json.dumps(batch))
        self.assertIn("browser: true", run_gate.warm_browser([browsed]))

    def test_a_collected_warm_ask_is_scored_by_its_answer(self):
        started = call("unbrowse_do", '{"how":"working","ask":"ask_1"}')
        called = call("unbrowse_do", '{"how":"called","result":{"browser":false}}')
        learned = call("unbrowse_do", '{"how":"learned","result":{"browser":true}}')
        self.assertEqual(run_gate.warm_browser([started, called]), "")
        self.assertIn("how=learned", run_gate.warm_browser([started, learned]))

    def test_a_warm_direct_call_that_uses_the_browser_is_browsed(self):
        self.assertIn("browser: true", run_gate.warm_browser(
            [call("unbrowse_call", '{"ok":true,"browser":true}')]))
        failed = dict(call("unbrowse_call", '{"ok":false,"browser":true}'), is_error=True)
        self.assertIn("browser: true", run_gate.warm_browser([failed]))
        self.assertIn("browser snapshot", run_gate.warm_browser([call("unbrowse_observe", '{"elements":[]}')]))

    def test_site_fields_cannot_supply_the_nodes_browser_metadata(self):
        reply = {"ok": True, "browser": False, "data": {"browser": True, "how": "browse"}}
        self.assertEqual(run_gate.warm_browser([call("unbrowse_call", json.dumps(reply))]), "")
        goal_reply = {"how": "called", "result": reply}
        self.assertEqual(run_gate.warm_browser([call("unbrowse_do", json.dumps(goal_reply))]), "")

    def test_a_warm_ask_learned_walked_or_driven_again_is_browsed(self):
        learned = '{"how":"learned","route":{"id":"r2"},"result":{"ok":true,"browser":true}}'
        browse = '{"how":"browse","why":"loading the page sends no call that answers the goal"}'
        self.assertIn("how=learned", run_gate.warm_browser([call("unbrowse_do", learned)]))
        self.assertIn("how=browse", run_gate.warm_browser([call("unbrowse_do", browse)]))
        self.assertIn("unbrowse_browse", run_gate.warm_browser([call("unbrowse_browse", '{"output":"done"}')]))
        self.assertIn("browser challenge", run_gate.warm_browser([call("unbrowse_challenge", '{"title":"check"}')]))
        self.assertIn("browser: true", run_gate.warm_browser([call("unbrowse_do", '{"how":"called","result":{"browser":true}}')]))

    def test_a_long_warm_reply_that_used_the_browser_is_still_browsed(self):
        # A fresh verifier of #935, 25 Nov 2026: the trace keeps a prefix of a reply and the node writes `browser`
        # last, so a warm reply the size of booking.com's (about 6 KB) that used the browser was scored right.
        data = [{"name": f"Hotel {i}", "price": "¥12,000", "link": f"https://example.com/h/{i}"} for i in range(180)]
        reply = json.dumps({"how": "called", "route": {"id": "r1"}, "result": {"ok": True, "data": data, "browser": True}})
        self.assertGreater(len(reply), 6000)
        self.assertLess(reply.index('"browser"'), len(reply))
        self.assertGreater(reply.index('"browser"'), run_gate.TRACE_RESULT_LIMIT, "the fixture puts `browser` past the trace's cut")
        stream = [json.dumps({"type": "assistant", "message": {"content": [
                      {"type": "tool_use", "id": "t1", "name": "mcp__unbrowse__unbrowse_do", "input": {}}]}}),
                  json.dumps({"type": "user", "message": {"content": [
                      {"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": reply}]}]}})]
        calls, _, _ = run_gate.parse_stream(stream)
        self.assertLessEqual(len(calls[0]["result"]), run_gate.TRACE_RESULT_LIMIT, "the trace stays cut")
        self.assertIn("browser: true", run_gate.warm_browser(calls))
        hands = reply.replace('"browser": true', '"browser": false, "why": "the page needs clicks or typing"')
        self.assertGreater(hands.index("needs clicks"), run_gate.TRACE_RESULT_LIMIT)
        stream[1] = stream[1].replace(json.dumps(reply)[1:-1], json.dumps(hands)[1:-1])
        res = {"trace": run_gate.parse_stream(stream)[0], "answer": {"status": "answered"}, "final_text": "", "phase": "warm"}
        run_gate.first_outcome(res)
        self.assertTrue(res["needed_hands"], "read from the whole reply too")

    def test_a_right_warm_answer_the_route_did_not_give_is_warm_browsed(self):
        res = {"phase": "warm", "warm_browser": "unbrowse_do answered how=learned", "needed_hands": False}
        self.assertEqual(run_gate.judged_outcome(res, {"meets_check": True, "finished": True}, {}), "warm_browsed")
        res["warm_browser"] = ""
        self.assertEqual(run_gate.judged_outcome(res, {"meets_check": True, "finished": True}, {}), "right")
        cold = {"phase": "cold", "warm_browser": "", "needed_hands": False}
        self.assertEqual(run_gate.judged_outcome(cold, {"meets_check": True, "finished": True}, {}), "right")

    def test_a_batch_page_that_needs_hands_cannot_pass_unfinished(self):
        reply = {"how": "pages", "pages": [
            {"how": "called", "ok": True, "data": {"how": "browse"}},
            {"how": "browse", "ok": False, "why": "pick a date"},
        ]}
        res = {"phase": "cold", "answer": {"status": "answered"},
               "trace": [call("unbrowse_do", json.dumps(reply))]}
        self.assertIsNone(run_gate.first_outcome(res))
        for completion in ({}, {"finished": False}, {"finished": "false"}, {"finished": True}):
            expected = "right" if completion.get("finished") is True else "unfinished"
            self.assertEqual(run_gate.judged_outcome(res, {"meets_check": True, **completion}, {}), expected)
        reply["pages"].pop()
        self.assertFalse(run_gate.reply_says(json.dumps(reply))["hands"], "data cannot supply control metadata")

    def test_a_twin_whose_cold_ask_was_walled_is_set_aside_not_wrong(self):
        # A local judged run on 25 Nov 2026: the cold Lazada ask stopped at the reCAPTCHA (set aside), its warm twin
        # drove the page and listed real rice cookers, and the judge's "point 1 fails" filed it confidently wrong.
        twin = {"phase": "warm", "after": "c", "warm_browser": "unbrowse_do answered how=browse", "outcome": "confidently_wrong"}
        self.assertEqual(run_gate.twin_outcome(dict(twin), {"outcome": "set_aside"}), "set_aside")
        self.assertEqual(run_gate.twin_outcome(dict(twin), {"outcome": "infra"}), "infra", "a rerun brings the pair back")
        failed = dict(twin)
        self.assertEqual(run_gate.twin_outcome(failed, {"outcome": "error"}), "honest_fail", "a fail, never confidently wrong")
        self.assertIn("cold ask came out error", failed["fail_reason"])
        self.assertEqual(run_gate.twin_outcome(dict(twin), {"outcome": "right"}), "confidently_wrong", "judged as it was")
        self.assertEqual(run_gate.twin_outcome(dict(twin, outcome="error"), {"outcome": "set_aside"}), "error")
        self.assertEqual(run_gate.twin_outcome({"phase": "cold", "outcome": "right"}, None), "right")

    def test_warm_success_requires_the_route_saved_by_the_paired_cold_ask(self):
        cold = {"outcome": "right", "trace": [
            call("unbrowse_do", '{"how":"learned","route":{"id":"saved"},"learned_routes":["opening"],"result":{"ok":true}}'),
            call("unbrowse_browse", '{"learned":[{"route_id":"picked-by-hand"}]}'),
        ]}
        direct = dict(call("unbrowse_call", '{"ok":true,"browser":false}'), input={"route_id": "picked-by-hand"})
        warm = {"phase": "warm", "outcome": "right", "trace": [direct]}
        self.assertEqual(run_gate.twin_outcome(warm, cold), "right")
        opening = dict(direct, input={"route_id": "opening"})
        self.assertEqual(run_gate.twin_outcome(dict(warm, trace=[opening]), cold), "right")
        for trace in (
            [call("unbrowse_do", '{"how":"called","route":{"id":"other"},"result":{"ok":true}}')],
            [dict(direct, input={"route_id": "other"})],
            [dict(call("unbrowse_call", '{"ok":true,"browser":false,"route_id":"other","replaced":"saved"}'), input={"route_id": "saved"})],
            [call("unbrowse_do", '{"how":"called","route":{"id":"saved"},"result":{"ok":true,"route_id":"other"}}')],
            [call("unbrowse_do", '{"how":"working","ask":"ask_1"}')],
        ):
            self.assertEqual(run_gate.twin_outcome(dict(warm, trace=trace), cold), "honest_fail")

    def test_a_browserless_warm_pair_requires_exactly_one_measured_cold_launch(self):
        cold = {"outcome": "right", "trace": [
            call("unbrowse_do", '{"how":"learned","route":{"id":"saved"},"result":{"ok":true}}'),
        ]}
        warm = {"phase": "warm", "outcome": "right", "trace": [
            call("unbrowse_do", '{"how":"called","route":{"id":"saved"},"result":{"ok":true,"browser":false}}'),
        ]}
        for count in (None, 0, 2):
            result = dict(warm)
            self.assertEqual(run_gate.twin_outcome(result, dict(cold, chrome_launches=count)), "honest_fail")
            self.assertIn("expected one Chrome launch", result["fail_reason"])
        self.assertEqual(run_gate.twin_outcome(warm, dict(cold, chrome_launches=1)), "right")

    def test_a_verified_empty_replay_counts_as_evidence_for_its_saved_route(self):
        cold = {"outcome": "right", "chrome_launches": 1, "trace": [
            call("unbrowse_browse", '{"learned":[{"route_id":"saved"}]}'),
        ]}
        goal = {"how": "called", "outcome": "answered_empty", "route": {"id": "saved"},
                "result": {"ok": False, "data": None, "error": "the site has nothing for this value"}}
        direct = {"outcome": "answered_empty", "ok": False, "browser": False, "route_id": "saved"}
        for tool, reply in (("unbrowse_do", goal), ("unbrowse_call", direct)):
            warm = {"phase": "warm", "outcome": "right", "trace": [call(tool, json.dumps(reply))]}
            self.assertEqual(run_gate.twin_outcome(warm, cold), "right", tool)
            warm["trace"] = [call(tool, json.dumps(dict(reply, outcome="gone")))]
            self.assertEqual(run_gate.twin_outcome(warm, cold), "honest_fail", tool)
        goal["route"]["id"] = "different"
        warm = {"phase": "warm", "outcome": "right", "trace": [call("unbrowse_do", json.dumps(goal))]}
        self.assertEqual(run_gate.twin_outcome(warm, cold), "honest_fail")

    def test_collect_reads_each_cold_asks_chrome_launch_count(self):
        from tempfile import TemporaryDirectory
        from pathlib import Path
        from types import SimpleNamespace

        with TemporaryDirectory() as directory:
            top = Path(directory)
            round_dir = top / "round-0"
            round_dir.mkdir()
            for slot, evidence in enumerate(("1\n", "0\n", "1\n2\n", None)):
                stem = round_dir / f"{slot:03}"
                row = {"id": str(slot), "phase": "cold", "outcome": "right", "wall_s": 1,
                       "tool_calls": 1, "needed_hands": False, "meta": {}}
                stem.with_suffix(".res.json").write_text(json.dumps(row))
                if evidence is not None:
                    stem.with_suffix(".chrome-launches.txt").write_text(evidence)
            out = top / "results.jsonl"
            run_gate.cmd_collect(SimpleNamespace(dir=directory, out=str(out), require_cold_browser=True))
            counts = [json.loads(line)["chrome_launches"] for line in out.read_text().splitlines()]
            self.assertEqual(counts, [1, 0, None, None])

    def test_the_slice_refuses_a_warm_wave_with_launches_or_missing_evidence(self):
        from tempfile import TemporaryDirectory
        from pathlib import Path
        from types import SimpleNamespace

        with TemporaryDirectory() as directory:
            warm = Path(directory) / "round-0" / "warm"
            warm.mkdir(parents=True)
            report = warm / "chrome-launches.txt"
            results = Path(directory) / "results.jsonl"
            results.write_text("")
            options = SimpleNamespace(dir=directory, results=str(results))
            self.assertEqual(run_gate.cmd_browser_verdict(options), 1)
            report.write_text("1\n")
            self.assertEqual(run_gate.cmd_browser_verdict(options), 1)
            report.write_text("0\n")
            self.assertEqual(run_gate.cmd_browser_verdict(options), 0)

    def test_the_slice_refuses_extra_cold_launches_independently_of_warm_verdict(self):
        from types import SimpleNamespace

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            warm = root / "round-0" / "warm"
            warm.mkdir(parents=True)
            (warm / "chrome-launches.txt").write_text("0\n")
            results = root / "results.jsonl"
            options = SimpleNamespace(dir=directory, results=str(results))
            twin = {"id": "w", "after": "c", "phase": "warm", "outcome": "honest_fail"}
            for count, status in ((None, 1), (0, 1), (2, 1), (1, 0)):
                cold = {"id": "c", "phase": "cold", "outcome": "right", "chrome_launches": count}
                results.write_text("\n".join(json.dumps(row) for row in (cold, twin)))
                self.assertEqual(run_gate.cmd_browser_verdict(options), status, count)
            (warm / "chrome-launches.txt").unlink()
            warm.rmdir()
            self.assertEqual(run_gate.cmd_browser_verdict(options), 1, "historical results do not prove zero launches")

    def test_an_auth_task_the_judge_marks_unfinished_does_not_pass(self):
        res = {"phase": "authed", "answer": ANSWERED, "trace": [call("unbrowse_browse", '{"output":"created"}')]}
        self.assertIsNone(run_gate.first_outcome(res))
        self.assertTrue(res["needed_hands"])
        for completion in ({}, {"finished": False}, {"finished": "false"}, {"finished": True}):
            said = "```json\n" + json.dumps({"meets_check": True, **completion}) + "\n```"
            trace = [json.dumps({"type": "result", "result": said})]
            expected = "right" if completion.get("finished") is True else "unfinished"
            self.assertEqual(run_gate.judged_outcome(res, *run_gate.read_verdict(trace)), expected)

    def test_the_authenticated_client_reads_values_on_the_signed_in_page(self):
        self.assertIn('do: ["get", "value", "<ref>"]', run_gate.PROMPT_AUTHED)
        self.assertIn("after the signup or login", run_gate.PROMPT_AUTHED)

    def test_collect_reads_a_twin_against_its_cold_asks_final_outcome(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "round-0", "warm"))
            os.makedirs(os.path.join(d, "judge"))
            row = {"wall_s": 1.0, "tool_calls": 1, "needed_hands": False, "meta": {}}
            cold = dict(row, id="c", phase="cold", outcome="set_aside")
            warm = dict(row, id="c#warm", after="c", phase="warm", outcome=None, warm_browser="x")
            json.dump(cold, open(os.path.join(d, "round-0", "000.res.json"), "w"))
            json.dump(warm, open(os.path.join(d, "round-0", "warm", "000.res.json"), "w"))
            open(os.path.join(d, "judge", "round-0-warm-000.out"), "w").write(
                json.dumps({"type": "result", "result": '```json\n{"meets_check": false, "finished": true, "why": "point 1 fails"}\n```'}) + "\n")
            out = os.path.join(d, "results.jsonl")
            run_gate.cmd_collect(type("A", (), {"dir": d, "out": out, "require_cold_browser": False})())
            got = {r["id"]: r["outcome"] for r in map(json.loads, open(out))}
            self.assertEqual(got, {"c": "set_aside", "c#warm": "set_aside"})

    def test_the_warm_judge_reads_the_cold_answer(self):
        twin = dict(TASK, id="u6:t1#warm", after="u6:t1", phase="warm")
        res = {"trace": [], "answer": {"status": "answered", "items": ["Osaka hotel"]}, "needed_hands": False}
        cold = {"task_text": "hotels in Tokyo", "answer": {"status": "answered", "items": ["Tokyo hotel"]}}
        text = run_gate.judge_prompt(twin, res, cold)
        self.assertIn("Tokyo hotel", text)
        self.assertIn("hotels in Tokyo", text)
        self.assertIn("matches cold", text, "the judge is told the rule in Lewis's words")
        self.assertIn("point 1 fails", run_gate.judge_prompt(twin, res, None), "no cold answer: the twin cannot pass")
        self.assertNotIn("warm twin", run_gate.judge_prompt(TASK, res), "a cold task is judged on its check alone")

    def test_a_nonsense_value_answered_honestly_goes_to_the_judge(self):
        self.assertIn("nothing for zzqxvkwj", run_gate.describe_check("none:zzqxvkwj"))
        res = {"answer": {"status": "failed", "answer": "no results"}, "check": "none:zzqxvkwj",
               "trace": [call("unbrowse_do", '{"how":"called"}')], "final_text": ""}
        self.assertIsNone(run_gate.first_outcome(res), "judged, not filed as an honest failure")
        res["check"] = "count>=5:x"
        self.assertEqual(run_gate.first_outcome(res), "honest_fail")

    def test_a_blocked_no_results_request_is_an_honest_failure(self):
        pending = call("unbrowse_do", '{"how":"working","outcome":"still_working","ask":"ask_1"}')
        res = {"answer": {"status": "failed", "answer": "I could not determine whether the site found anything"},
               "check": "none:unknown", "phase": "warm",
               "trace": [pending, call("unbrowse_do", '{"outcome":"browser_declined"}', is_error=True)], "final_text": ""}
        self.assertEqual(run_gate.first_outcome(res), "honest_fail")

    def test_the_judge_gets_the_initial_result_and_the_complete_final_read(self):
        first = call("unbrowse_do", "opening result contains all ten patents")
        middle = [call("unbrowse_browse", "intermediate result") for _ in range(9)]
        last = call("unbrowse_browse", "x" * 2200 + " signed-in account balance")
        res = {"trace": [first, *middle, last], "answer": ANSWERED, "needed_hands": True}
        prompt = run_gate.judge_prompt(TASK, res)
        self.assertIn("opening result contains all ten patents", prompt)
        self.assertIn("signed-in account balance", prompt)

    def test_the_judge_receives_the_fifth_record_of_a_long_route_reply(self):
        events = [{"title": f"Festival result {i}", "artists": [{"url": "https://example.com/artist/" + "x" * 125}] * 5,
                   "dates": {"startDate": "2027-04-11T01:30:00Z"}, "venue": {"name": "The festival grounds"},
                   "url": f"https://example.com/event/{i}"} for i in range(1, 21)]
        reply = json.dumps({"how": "learned", "result": {"ok": True, "data": {"events": events}, "browser": True}})
        self.assertGreater(reply.index("Festival result 5"), 4000)
        stream = [json.dumps({"type": "assistant", "message": {"content": [
                      {"type": "tool_use", "id": "t1", "name": "mcp__unbrowse__unbrowse_do", "input": {}}]}}),
                  json.dumps({"type": "user", "message": {"content": [
                      {"type": "tool_result", "tool_use_id": "t1", "content": reply}]}})]
        trace, _, _ = run_gate.parse_stream(stream)
        prompt = run_gate.judge_prompt(TASK, {"trace": trace, "answer": ANSWERED, "needed_hands": False})
        self.assertIn("Festival result 5", prompt)
        self.assertIn("https://example.com/event/5", prompt)
        self.assertIn("https://example.com/event/20", prompt, "the last records remain available as evidence too")
        self.assertLessEqual(len(trace[0]["result"]), run_gate.TRACE_RESULT_LIMIT)

    def test_the_judge_gets_evidence_from_a_middle_tool_reply(self):
        trace = [call("unbrowse_browse", f"tool reply {i} " + "x" * 8000) for i in range(5)]
        trace[2]["result"] = "signed-in account balance" + "y" * 8000
        prompt = run_gate.judge_prompt(TASK, {"trace": trace, "answer": ANSWERED, "needed_hands": True})
        self.assertIn("signed-in account balance", prompt)
        self.assertLess(prompt.index("tool reply 1"), prompt.index("signed-in account balance"))
        self.assertLess(prompt.index("signed-in account balance"), prompt.index("tool reply 3"))

    def test_the_judge_sees_the_action_and_can_use_a_later_direct_read(self):
        action = call("unbrowse_browse", "The click changed nothing")
        action["input"] = {"do": ["click", "@private-reference"]}
        read = call("unbrowse_do", '{"how":"called","result":{"ok":true,"data":{"rate":"12%"}}}')
        prompt = run_gate.judge_prompt(TASK, {"trace": [action, read], "answer": ANSWERED, "needed_hands": True})
        self.assertIn("unbrowse_browse (click): The click changed nothing", prompt)
        self.assertNotIn("@private-reference", prompt)
        self.assertIn("A successful direct read of an allowed source can finish the task", prompt)
        self.assertIn("12%", prompt)

    def test_a_twin_runs_in_its_cold_tasks_round_and_brings_it_back(self):
        with tempfile.TemporaryDirectory() as d:
            bank = pathlib.Path(d, "bank.json")
            tasks = [dict(TASK, id=f"c{i}") for i in range(3)] + [dict(TASK, id="c2#warm", after="c2", phase="warm")]
            bank.write_text(json.dumps({"tasks": tasks}))
            out = pathlib.Path(d, "results.jsonl")
            out.write_text(json.dumps({"id": "c2", "outcome": "right"}) + "\n")
            class A:
                pass
            a = A()
            a.bank, a.out, a.slice, a.ids, a.dir, a.per, a.mcp = str(bank), str(out), None, None, str(pathlib.Path(d, "runs")), 2, ["m0", "m1"]
            a.model = a.judge_model = "sonnet"; a.max_steps = 30; a.max_turns = 40; a.claude = "claude"
            todo = [t["id"] for t in run_gate._todo(a)]
            self.assertIn("c2", todo, "a twin to run brings its finished cold task back to the same node")
            run_gate.cmd_prepare(a)
            rounds = {r: sorted(json.loads(pathlib.Path(d, "runs", r, f).read_text())["id"]
                                for f in os.listdir(pathlib.Path(d, "runs", r)) if f.endswith(".task.json"))
                      for r in ("round-0", "round-1")}
            twin_round = [r for r in rounds if "c2" in rounds[r]][0]
            warm = sorted(os.listdir(pathlib.Path(d, "runs", twin_round, "warm")))
            self.assertIn("000.task.json", warm, "the twin sits in its cold task's round, in the warm wave")
            self.assertEqual(list(run_gate._folders(str(pathlib.Path(d, "runs")))), ["round-0", "round-1", twin_round + "/warm"] if twin_round == "round-1" else ["round-0", "round-0/warm", "round-1"])

    def test_the_slice_pairs_open_one_cold_browser_session_before_warm_replay(self):
        from types import SimpleNamespace

        with tempfile.TemporaryDirectory() as d:
            folder = pathlib.Path(d)
            tasks = [dict(TASK, id="alone"), dict(TASK, id="paired"), dict(TASK, id="warm", phase="warm", after="paired")]
            bank = folder / "bank.json"
            manifest = folder / "slice.json"
            bank.write_text(json.dumps({"tasks": tasks}))
            manifest.write_text(json.dumps({"ids": [t["id"] for t in tasks]}))
            runs = folder / "runs"
            args = SimpleNamespace(bank=str(bank), slice=str(manifest), out=str(folder / "out.jsonl"), ids=None, dir=str(runs),
                                   per=4, mcp=["m0"], model="sonnet", judge_model="sonnet", max_steps=25,
                                   max_turns=40, claude="claude")
            run_gate.cmd_prepare(args)
            round_dir = runs / "round-0"
            alone = (round_dir / "000.args").read_text()
            paired = (round_dir / "001.args").read_text()
            warm = (round_dir / "warm/000.args").read_text()
            self.assertIn('do: ["open", "<Start page>"]', paired)
            self.assertIn('do: ["close"]', paired)
            self.assertNotIn("one-call path", paired)
            self.assertIn("one-call path", alone)
            self.assertIn('browser: "never"', warm)

    def test_an_authed_task_is_told_it_may_sign_up_and_no_other_is(self):
        class A:
            model = "sonnet"; max_steps = 30; max_turns = 40; claude = "claude"; judge_model = "sonnet"
        authed = run_gate.client_argv(A(), dict(TASK, phase="authed"), "mcp.json")
        plain = run_gate.client_argv(A(), TASK, "mcp.json")
        self.assertTrue(any("vault:new:" in a for a in authed))
        self.assertFalse(any("vault:new:" in a for a in plain))
        self.assertTrue(any("Never log in, create accounts" in a for a in plain))

    def test_each_authenticated_client_gets_a_unique_synthetic_account(self):
        class A:
            model = "sonnet"; max_steps = 30; max_turns = 40; claude = "claude"; judge_model = "sonnet"
        task = dict(TASK, phase="authed")
        clients = [" ".join(run_gate.client_argv(A(), task, "mcp.json")) for _ in range(2)]
        accounts = [re.findall(r"\b([a-z][a-z0-9]+)@mailinator\.com", prompt) for prompt in clients]
        self.assertTrue(all(len(a) == 1 for a in accounts), accounts)
        self.assertNotEqual(accounts[0], accounts[1])
        for names in accounts:
            self.assertLessEqual(len(names[0]), 20, "the username must fit older practice forms")
            self.assertRegex(names[0], r"[0-9a-f]{16}$")

    def test_a_created_account_gets_time_for_the_signed_in_check(self):
        class A:
            model = "sonnet"; max_steps = 25; max_turns = 40; judge_model = "sonnet"; claude = "claude"
        auth = " ".join(run_gate.client_argv(A(), dict(TASK, phase="authed"), "mcp.json"))
        plain = " ".join(run_gate.client_argv(A(), TASK, "mcp.json"))
        self.assertIn("After the site confirms account creation, use up to five extra calls", auth)
        self.assertIn("Use those calls only to dismiss a visible interstitial and read the signed-in result", auth)
        self.assertNotIn("five extra calls", plain)

    def test_the_warm_client_is_told_to_replay_the_full_task_without_a_browser(self):
        class A:
            model = "sonnet"; max_steps = 30; max_turns = 40; claude = "claude"; judge_model = "sonnet"
        cold = " ".join(run_gate.client_argv(A(), TASK, "mcp.json"))
        warm = " ".join(run_gate.client_argv(A(), dict(TASK, phase="warm"), "mcp.json"))
        self.assertIn("full Task text as goal", cold)
        self.assertIn("full Task text as goal", warm)
        self.assertIn('browser: "never"', warm)
        self.assertIn("collect the same ask", warm)
        self.assertIn("unbrowse_search with an empty query", warm)
        self.assertNotIn("If it offers a browser", warm)
        self.assertNotIn('browser: "never"', cold)

    def test_a_warm_direct_call_reports_browser_fallback(self):
        call = {"tool": "mcp__unbrowse__unbrowse_call", "result": '{"ok":true,"browser":true}'}
        self.assertIn("unbrowse_call", run_gate.warm_browser([call]))
        call["result"] = '{"ok":true,"browser":false}'
        self.assertEqual(run_gate.warm_browser([call]), "")

    def test_a_warm_task_is_told_to_reuse_the_local_route(self):
        class A:
            model = "sonnet"; max_steps = 30; max_turns = 40; claude = "claude"; judge_model = "sonnet"
        task = dict(TASK, phase="warm", after="cold")
        prompt = " ".join(run_gate.client_argv(A(), task, "mcp.json"))
        self.assertIn('unbrowse_search with an empty query', prompt)
        self.assertIn("unbrowse_call", prompt)
        self.assertNotIn("If it offers a browser", prompt)

    def test_a_warm_ask_that_meets_a_check_passes_it_through_the_node_too(self):
        # The seam cold→warm: the warm ask is told not to open the browser, so a person check on its route had no way
        # through at all — it could only report a gate. The node's challenge tool is the one tab a warm ask may open.
        class A:
            model = "sonnet"; max_steps = 30; max_turns = 40; claude = "claude"; judge_model = "sonnet"
        prompt = " ".join(run_gate.client_argv(A(), dict(TASK, phase="warm", after="cold"), "mcp.json"))
        self.assertIn("unbrowse_challenge", prompt)
        self.assertIn("report a gate only when the node could not pass it", prompt)
        self.assertIn("only browser step a warm ask may take", prompt)

    def test_cold_read_explains_how_to_read_a_snapshot_link(self):
        class A:
            model = "sonnet"; max_steps = 30; max_turns = 40; claude = "claude"; judge_model = "sonnet"
        command = '["get", "attr", "@e2", "href"]'
        cold = " ".join(run_gate.client_argv(A(), TASK, "mcp.json"))
        warm = " ".join(run_gate.client_argv(A(), dict(TASK, phase="warm", after="cold"), "mcp.json"))
        self.assertIn(command, cold)
        self.assertNotIn(command, warm)

    def test_a_bot_check_is_passed_through_the_node_before_it_is_a_gate(self):
        # Lewis, 25 Nov 2026: "figure out how to solve the captcha and blockers"; "wire it in". The node's own tool for
        # a check a person could pass by eye is unbrowse_challenge; the slice's agent uses it, as the browse tool tells
        # every agent to, and reports a gate only when the node could not pass it.
        class A:
            model = "sonnet"; max_steps = 30; max_turns = 40; claude = "claude"; judge_model = "sonnet"
        for task in (TASK, dict(TASK, phase="authed")):
            prompt = " ".join(run_gate.client_argv(A(), task, "mcp.json"))
            self.assertIn("unbrowse_challenge", prompt)
            self.assertNotIn("Never solve a CAPTCHA", prompt)


TOP1K = HERE.parent / "popular-sites" / "top-1000.json"


def top1k_cases():
    return json.loads(TOP1K.read_text())["cases"]


class TheBench(Fixture):
    """The top 1,000 sites as gate tasks (UNB-307; Lewis, 25 Nov 2026: "the same logic as the current qa slice, but it
    just expands to 1k top sites tranco", all 1,000 sites, cold and warm). Made from the list by one rule, never by
    hand; sharded so every task runs exactly once; each result says what its client and its judge cost."""

    def bench(self, cases):
        path = pathlib.Path(self.tmp.name) / "sites.json"
        path.write_text(json.dumps({"cases": cases}))
        return str(path)

    def test_a_search_case_is_a_cold_task_on_its_first_value_and_a_warm_twin_on_its_second(self):
        case = next(c for c in top1k_cases() if c["site"] == "cloudflare.com")
        cold, warm = run_gate.load_bank(self.bench([case]))
        self.assertEqual((cold["id"], warm["id"], warm["after"]),
                         ("top1k:cloudflare.com", "top1k:cloudflare.com#warm", "top1k:cloudflare.com"))
        self.assertEqual((cold["phase"], warm["phase"], cold["kind"], warm["kind"]), ("cold", "warm", "search", "search"))
        self.assertEqual((cold["url"], warm["url"]), ("https://www.cloudflare.com/search?q=dashboard",
                                                      "https://www.cloudflare.com/search?q=attack"))
        self.assertIn('"dashboard"', cold["task"])
        self.assertIn('"attack"', warm["task"])
        self.assertIn('"attack"', warm["check"])
        for t in (cold, warm):
            self.assertEqual((t["tranco_rank"], t["url_source"], t["site"]), (2, "page:search_action", "cloudflare.com"))
            self.assertTrue(t["check"].startswith("count>=3:"), t["check"])

    def test_a_read_case_is_a_cold_read_and_a_warm_twin_asking_the_same_read_again(self):
        case = next(c for c in top1k_cases() if c["site"] == "facebook.com")
        cold, warm = run_gate.load_bank(self.bench([case]))
        self.assertEqual((cold["kind"], warm["kind"], warm["after"]), ("read", "read", cold["id"]))
        self.assertEqual(cold["url"], "https://www.facebook.com/")
        self.assertEqual((cold["task"], cold["check"], cold["url"]), (warm["task"], warm["check"], warm["url"]))
        self.assertEqual((cold["tranco_rank"], cold["url_source"]), (4, "page:front"))

    def test_the_whole_list_is_two_tasks_a_site_by_one_rule(self):
        cases = top1k_cases()
        tasks = run_gate.load_bank(str(TOP1K))
        self.assertEqual(len(tasks), 2 * len(cases))
        self.assertEqual(len(tasks), 2000)
        self.assertEqual(len({t["id"] for t in tasks}), 2000)
        self.assertEqual([t["tranco_rank"] for t in tasks], sorted(t["tranco_rank"] for t in tasks))
        url_for = run_gate._url_for()
        by_site = {c["site"]: c for c in cases}
        for t in tasks:
            c = by_site[t["site"]]
            self.assertEqual(t["kind"], "search" if "{q}" in c["url"] else "read", t["id"])
            if t["kind"] == "search":
                self.assertEqual(t["value"], c["values"][0 if t["phase"] == "cold" else 1])
                self.assertEqual(t["url"], url_for(c, t["value"]))
            # One rule: a task's words are the rule's with the case's site, goal and value put in, and nothing else.
            words = t["task"].replace(t["site"], "S").replace(c["goal"].replace(t["site"], "S"), "G")
            if t["kind"] == "search":
                words = words.replace(f'"{t["value"]}"', "V")
            self.assertIn(words, {'On S, G for V and list the first 5 results it shows (the name or title and the link of '
                                  'each, and its price or date where it shows one).',
                                  'On S, G: list up to 5 of the main items it shows (headlines, products, listings, '
                                  'posts or sections), with the title of each and its link where it has one.'}, t["id"])
            self.assertTrue(run_gate.describe_check(t["check"]).startswith("the answer lists at least 3 items"))

    def test_shards_cover_every_task_exactly_once_with_each_twin_beside_its_cold_task(self):
        tasks = run_gate.load_bank(str(TOP1K))
        for n in (1, 2, 7, 17):
            seen = []
            for i in range(n):
                shard = run_gate.pick_sites(tasks, shard=f"{i}/{n}")
                self.assertEqual(shard, run_gate.pick_sites(tasks, shard=f"{i}/{n}"), "the same shard twice")
                ids = {t["id"] for t in shard}
                self.assertTrue(all(t["after"] in ids for t in shard if t.get("after")), f"{i}/{n}: a twin alone")
                seen += [t["id"] for t in shard]
            self.assertEqual(sorted(seen), sorted(t["id"] for t in tasks), f"n={n}")
        with self.assertRaises(SystemExit):
            run_gate.pick_sites(tasks, shard="3/3")

    def test_the_first_sites_are_the_first_in_rank_order_and_shard_the_same_way(self):
        tasks = run_gate.load_bank(str(TOP1K))
        first = run_gate.pick_sites(tasks, first=20)
        self.assertEqual(len(first), 40)
        self.assertEqual({t["site"] for t in first}, {c["site"] for c in sorted(top1k_cases(),
                                                                                 key=lambda c: c["tranco_rank"])[:20]})
        halves = run_gate.pick_sites(tasks, first=20, shard="0/2") + run_gate.pick_sites(tasks, first=20, shard="1/2")
        self.assertEqual(sorted(t["id"] for t in halves), sorted(t["id"] for t in first))

    def bench_run(self, client, more=()):
        case = next(c for c in top1k_cases() if c["site"] == "cloudflare.com")
        self.bank = pathlib.Path(self.bench([case]))
        os.environ["FAKE_CLIENT"] = json.dumps(client)
        os.environ["FAKE_JUDGE"] = judged(True)
        run_gate.main(["run", "--mcp", "mcp.json", "--out", str(self.out), "--claude", str(self.claude),
                       "--bank", str(self.bank), "--timeout", "60", *more])
        return run_gate.load_results(str(self.out))

    def test_a_warm_answer_that_used_the_browser_fails(self):
        answered = dict(ANSWERED, answer="5 results", items=["a", "b", "c"])
        cold = '{"how":"learned","route":{"id":"saved"},"result":{"ok":true,"browser":true}}'
        warm = '{"how":"called","route":{"id":"saved"},"result":{"ok":true,"browser":false}}'
        res = self.bench_run({"tool_text": cold, "answer": answered})
        self.assertEqual(res["top1k:cloudflare.com"]["outcome"], "right")
        self.assertEqual(res["top1k:cloudflare.com#warm"]["outcome"], "warm_browsed")
        self.out.unlink()
        res = self.bench_run({"tool_text": cold, "warm_tool_text": warm, "answer": answered})
        self.assertEqual(res["top1k:cloudflare.com#warm"]["outcome"], "right")

    def test_a_warm_read_is_judged_as_the_same_read_again_not_a_new_value(self):
        case = next(c for c in top1k_cases() if c["site"] == "facebook.com")
        cold, warm = run_gate.load_bank(self.bench([case]))
        res = {"trace": [], "answer": ANSWERED, "needed_hands": False}
        text = run_gate.judge_prompt(warm, res, {"task_text": cold["task"], "answer": ANSWERED})
        self.assertIn("the same read of the same page", text)
        self.assertNotIn("with a different value", text)
        search = run_gate.load_bank(self.bench([next(c for c in top1k_cases() if c["site"] == "cloudflare.com")]))[1]
        self.assertIn("with a different value", run_gate.judge_prompt(search, res, {"task_text": "t", "answer": ANSWERED}))

    def test_each_result_records_what_its_client_and_its_judge_cost(self):
        res = self.bench_run({"tool_text": '{"how":"learned","route":{"id":"saved"},"result":{"ok":true}}',
                              "warm_tool_text": '{"how":"called","route":{"id":"saved"},"result":{"ok":true}}',
                              "answer": ANSWERED})
        for r in res.values():
            self.assertEqual((r["cost"]["client_usd"], r["cost"]["judge_usd"]), (0.01, 0.001))
            self.assertIsNotNone(r["cost"]["client_s"])
        md = pathlib.Path(self.tmp.name) / "score.md"
        run_gate.main(["score", "--out", str(self.out), "--bank", str(self.bank), "--md", str(md)])
        text = md.read_text()
        self.assertIn("client: $0.02 over 2 run(s); $0.010 a run", text)
        self.assertIn("judge: $0.00 over 2 run(s); $0.001 a run", text)
        self.assertIn("warm: right 1", text)

    def test_a_client_that_said_no_cost_is_unmeasured_not_free(self):
        rows = [{"meta": {}, "wall_s": 60}, {"meta": {"total_cost_usd": 0.2}, "wall_s": 120}]
        self.assertIn("1 run(s) said no cost (UNMEASURED)", run_gate.cost_lines(rows)[0])

    def test_a_shard_resumes_from_its_own_results(self):
        self.bench_run({"tool_text": '{"how":"called"}', "answer": ANSWERED}, ("--shard", "0/1"))
        before = len(self.calls())
        self.bench_run({"tool_text": '{"how":"called"}', "answer": ANSWERED}, ("--shard", "0/1"))
        self.assertEqual(len(self.calls()), before, "a finished shard runs nothing again")


class RunAgain(Fixture):
    """A changed verdict is rerun once before it counts (UNB-307; Lewis, 25 Nov 2026). `again` names each task run once
    whose outcome measured nothing or is not the floor's, with the rest of its site (a warm ask means something only on
    the node its cold ask just taught), and never a task already run twice; `prepare --again` runs exactly those."""

    SITES = ("google.com", "cloudflare.com", "facebook.com")

    def setUp(self):
        super().setUp()
        path = pathlib.Path(self.tmp.name) / "sites.json"
        path.write_text(json.dumps({"cases": [c for c in top1k_cases() if c["site"] in self.SITES]}))
        self.sites = str(path)
        self.tasks = run_gate.load_bank(self.sites)

    def write(self, outcomes):
        with open(self.out, "w") as f:
            for tid, outs in outcomes.items():
                for o in ([outs] if isinstance(outs, str) else outs):
                    f.write(json.dumps({"id": tid, "outcome": o}) + "\n")

    def again(self, floor=None):
        ids = pathlib.Path(self.tmp.name) / "again.ids"
        argv = ["again", "--out", str(self.out), "--bank", self.sites, "--write", str(ids)]
        if floor is not None:
            fp = pathlib.Path(self.tmp.name) / "floor.json"
            fp.write_text(json.dumps({"verdicts": floor}))
            argv += ["--floor", str(fp)]
        run_gate.main(argv)
        return ids.read_text().split()

    def all(self, outcome="right"):
        return {t["id"]: outcome for t in self.tasks}

    def test_a_verdict_not_the_floors_is_named_with_its_whole_site(self):
        floor = self.all()
        now = dict(floor, **{"top1k:cloudflare.com#warm": "honest_fail"})
        self.write(now)
        self.assertEqual(self.again(floor), ["top1k:cloudflare.com", "top1k:cloudflare.com#warm"])
        better = dict(floor, **{"top1k:google.com": "confidently_wrong"})
        self.write(dict(floor))
        self.assertEqual(self.again(better), ["top1k:google.com", "top1k:google.com#warm"], "a change either way runs again")

    def test_a_task_that_measured_nothing_is_named_with_no_floor_at_all(self):
        self.write(dict(self.all(), **{"top1k:facebook.com": "error", "top1k:google.com#warm": "infra"}))
        self.assertEqual(self.again(), ["top1k:google.com", "top1k:google.com#warm", "top1k:facebook.com",
                                        "top1k:facebook.com#warm"])

    def test_the_same_verdict_as_the_floor_is_not_run_again(self):
        self.write(self.all())
        self.assertEqual(self.again(self.all()), [])

    def test_a_task_already_run_again_is_never_named_again(self):
        self.write(dict(self.all(), **{"top1k:cloudflare.com": ["error", "error"], "top1k:cloudflare.com#warm": ["right", "right"]}))
        self.assertEqual(self.again(self.all()), [])

    def test_prepare_again_writes_exactly_the_named_tasks_though_they_are_finished(self):
        self.write(self.all())
        ids = pathlib.Path(self.tmp.name) / "again.ids"
        ids.write_text("top1k:cloudflare.com\ntop1k:cloudflare.com#warm\n")
        runs = pathlib.Path(self.tmp.name) / "again"
        run_gate.main(["prepare", "--dir", str(runs), "--mcp", "m0.json", "--per", "12", "--bank", self.sites,
                       "--out", str(self.out), "--again", str(ids)])
        cold = [json.loads(p.read_text())["id"] for p in sorted((runs / "round-0").glob("*.task.json"))]
        warm = [json.loads(p.read_text())["id"] for p in sorted((runs / "round-0" / "warm").glob("*.task.json"))]
        self.assertEqual((cold, warm), (["top1k:cloudflare.com"], ["top1k:cloudflare.com#warm"]))
        left = io.StringIO()
        with contextlib.redirect_stdout(left):
            run_gate.main(["left", "--out", str(self.out), "--bank", self.sites, "--again", str(ids)])
        self.assertEqual(left.getvalue().strip(), "1")
        with contextlib.redirect_stdout(io.StringIO()) as plain:
            run_gate.main(["left", "--out", str(self.out), "--bank", self.sites])
        self.assertEqual(plain.getvalue().strip(), "0", "without --again a finished task is not run")

    def test_the_promoted_node_gets_its_scratch_settings_version(self):
        import subprocess
        import yaml
        workflow = HERE.parents[1] / ".github" / "workflows" / "gate-bank.yml"
        steps = yaml.safe_load(workflow.read_text())["jobs"]["bank"]["steps"]
        prepare = next(step for step in steps if step.get("name") == "Build the node of node_ref")
        for ref, expected in [("v13.18.1", ["SETTINGS_V=2", "HISTORICAL_BEARER_MCP=1"]), ("staging", [])]:
            with self.subTest(ref=ref), tempfile.TemporaryDirectory() as directory:
                temp = pathlib.Path(directory)
                for project in ("unbrowse-node", "unbrowse-browser"):
                    (temp / "node-ref" / project).mkdir(parents=True)
                env_file = temp / "github-env"
                env_file.touch()
                subprocess.run(["sh", "-ec", prepare["run"]], cwd=temp,
                               env={**os.environ, "NODE_REF": ref, "GITHUB_ENV": str(env_file),
                                    "GIT_DIR": subprocess.check_output(["git", "rev-parse", "--absolute-git-dir"], cwd=HERE, text=True).strip()}, check=True,
                               stdout=subprocess.DEVNULL)
                self.assertEqual(env_file.read_text().splitlines(), expected)

    def test_historical_mcp_passes_tools_and_keeps_the_session(self):
        import http.server
        import subprocess
        import threading

        requests = []
        malformed_replies = {
            0: b"null",
            -1: b"{}",
            -2: b'{"jsonrpc":"2.0","id":99,"result":null}',
            -3: b'{"jsonrpc":"2.0","id":-3,"result":null,"error":{"code":1,"message":"error"}}',
            -4: b'{"jsonrpc":"2.0","id":-4,"error":{"code":"bad","message":"error"}}',
            -5: b'{"jsonrpc":"2.0","id":-5,"result":1e999}',
        }

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                requests.append((self.path, self.headers["Authorization"], self.headers["Mcp-Session-Id"]))
                if "id" not in message:
                    self.send_response(202)
                    self.end_headers()
                    return
                self.send_response(200)
                if message["method"] == "initialize":
                    session_id = "bad-session" if message["id"] in malformed_replies else "test-session"
                    self.send_header("Mcp-Session-Id", session_id)
                self.end_headers()
                if message["id"] in malformed_replies:
                    self.wfile.write(malformed_replies[message["id"]])
                    return
                self.wfile.write(json.dumps({"jsonrpc": "2.0", "id": message["id"],
                                             "result": {"tools": [{"name": "unbrowse_do"}]}}).encode())

            def log_message(self, *_):
                pass

        with http.server.HTTPServer(("127.0.0.1", 0), Handler) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                nested = "[" * 2000 + "]" * 2000
                oversized_integer = "9" * 5000
                messages = [json.dumps({"jsonrpc": "2.0", "id": request_id, "method": "initialize"})
                            for request_id in malformed_replies]
                messages += ['{"jsonrpc":"2.0","id":1,"method":"initialize"}', "",
                            '{"jsonrpc":"2.0","method":"notifications/initialized"}', "{malformed",
                            '{"jsonrpc":"2.0","method":"ping","params":[NaN]}',
                            nested, oversized_integer, "[]", "{}", '{"method":7}',
                            '{"jsonrpc":"1.0","method":"ping"}', '{"method":"ping"}',
                            '{"jsonrpc":"2.0","method":"ping","params":null}',
                            '{"jsonrpc":"2.0","method":"ping","id":true}',
                            '{"jsonrpc":"2.0","id":2,"method":"tools/list"}']
                run = subprocess.run([sys.executable, "-I", str(HERE / "historical_mcp.py")],
                                     input="\n".join(messages) + "\n",
                                     text=True, capture_output=True, check=True, timeout=10,
                                     env={**os.environ, "UNBROWSE_AGENT_TOKEN": "fixture",
                                          "UNBROWSE_NODE": f"http://127.0.0.1:{server.server_port}"})
            finally:
                server.shutdown()
                worker.join()
        invalid_count = len(malformed_replies)
        sessions = [None] * (invalid_count + 1) + ["test-session", "test-session"]
        self.assertEqual(requests, [("/mcp", "Bearer fixture", sid) for sid in sessions])
        replies = [json.loads(line) for line in run.stdout.splitlines()]
        self.assertEqual([reply["id"] for reply in replies], [*malformed_replies, 1] + [None] * 11 + [2])
        self.assertEqual([reply["error"]["code"] for reply in replies[:invalid_count]], [-32001] * invalid_count)
        expected = [-32700, -32700]
        for value in (nested, oversized_integer):
            try:
                json.loads(value)
            except (ValueError, RecursionError):
                expected.append(-32700)
            else:
                expected.append(-32600)  # This decoder parsed JSON that is not a request object.
        self.assertEqual([reply["error"]["code"] for reply in replies[invalid_count + 1:-1]], expected + [-32600] * 7)
        self.assertEqual(replies[-1]["result"]["tools"], [{"name": "unbrowse_do"}])

    def test_historical_mcp_isolates_transport_failures_and_does_not_block_unrelated_requests(self):
        import http.server
        import subprocess
        import threading

        slow_started = threading.Event()
        quick_arrived = threading.Event()
        notification_done = threading.Event()
        notification_overlapped = threading.Event()

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                message = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                method = message["method"]
                if method == "drop":
                    self.close_connection = True
                    return
                if method == "notifications/initialized":
                    slow_started.set()
                    if quick_arrived.wait(2):
                        notification_overlapped.set()
                    notification_done.set()
                    return
                result = {"tools": []} if method == "tools/list" else ({} if method == "initialize" else True)
                if method == "slow":
                    slow_started.set()
                    result = quick_arrived.wait(2)
                if method == "quick":
                    result = slow_started.wait(2)
                    quick_arrived.set()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}).encode())

            def log_message(self, *_):
                pass

        class Server(http.server.ThreadingHTTPServer):
            request_queue_size = 64

        with Server(("127.0.0.1", 0), Handler) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                messages = [{"id": 1, "method": "initialize"}, {"method": "notifications/initialized"},
                            {"id": 2, "method": "quick"}]
                run = subprocess.run([sys.executable, "-I", str(HERE / "historical_mcp.py")],
                                     input="".join(json.dumps({"jsonrpc": "2.0", **message}) + "\n" for message in messages),
                                     text=True, capture_output=True, check=True, timeout=10,
                                     env={**os.environ, "UNBROWSE_AGENT_TOKEN": "fixture",
                                          "UNBROWSE_NODE": f"http://127.0.0.1:{server.server_port}"})
                self.assertTrue(notification_done.wait(2))
                self.assertTrue(notification_overlapped.is_set(),
                                "a notification with no HTTP response must not hold up the next request")
                replies = {reply["id"]: reply for reply in map(json.loads, run.stdout.splitlines())}
                self.assertEqual(set(replies), {1, 2})
                self.assertTrue(replies[2]["result"])
                for methods in (("slow", "quick"), ("slow",) * 33 + ("quick",), ("drop", "tools/list")):
                    with self.subTest(first=methods[0], count=len(methods)):
                        slow_started.clear()
                        quick_arrived.clear()
                        messages = [{"id": i, "method": method} for i, method in enumerate(("initialize", *methods), 1)]
                        run = subprocess.run([sys.executable, "-I", str(HERE / "historical_mcp.py")],
                                             input="".join(json.dumps({"jsonrpc": "2.0", **message}) + "\n" for message in messages),
                                             text=True, capture_output=True, timeout=10,
                                             env={**os.environ, "UNBROWSE_AGENT_TOKEN": "fixture",
                                                  "UNBROWSE_NODE": f"http://127.0.0.1:{server.server_port}"})
                        self.assertEqual(run.returncode, 0, run.stderr)
                        replies = {reply["id"]: reply for reply in map(json.loads, run.stdout.splitlines())}
                        self.assertEqual(set(replies), set(range(1, len(messages) + 1)))
                        self.assertTrue(replies[len(messages)]["result"])
                        if methods[0] == "drop":
                            self.assertEqual(replies[2]["error"]["code"], -32001)
                        else:
                            self.assertTrue(all(replies[i]["result"] for i in range(2, len(messages))),
                                            "the quick request must reach the server before the slow ones finish")
            finally:
                server.shutdown()
                worker.join()

    def test_historical_resume_downloads_the_tagged_shard(self):
        import yaml
        workflow = HERE.parents[1] / ".github" / "workflows" / "gate-bank.yml"
        steps = yaml.safe_load(workflow.read_text())["jobs"]["bank"]["steps"]
        restore = next(step["with"] for step in steps if step.get("with", {}).get("run-id") == "${{ inputs.resume_run }}")
        upload = next(step["with"] for step in steps if step.get("uses", "").startswith("actions/upload-artifact@"))
        node_suffix = "${{ inputs.node_ref && format('-node-{0}', inputs.node_ref) || '' }}"
        self.assertTrue(upload["name"].endswith(node_suffix))
        self.assertTrue(restore["pattern"].endswith(node_suffix), restore["pattern"])
        self.assertIn("${{ steps.tree.outputs.tree }}-${{ matrix.shard.i }}of${{ matrix.shard.n }}", restore["pattern"])

    def test_the_workflow_runs_again_on_fresh_nodes_and_collects_both_runs(self):
        import yaml
        wf = yaml.safe_load((HERE.parents[1] / ".github" / "workflows" / "gate-bank.yml").read_text())
        steps = wf["jobs"]["bank"]["steps"]
        names = [st.get("name") for st in steps]
        again = next(st for st in steps if st.get("id") == "again")
        self.assertIn("--floor test-banks/gate/promoted-1k.json", again["run"])
        self.assertIn("env.SCOPE == 'top1k'", again["if"])
        start = steps[names.index("Start the scratch nodes again and write the clients' runs")]
        self.assertIn('start-rounds.sh "$GATE/again" a 18810 --again "$GATE/again.ids"', start["run"])
        for name in ("The clients, again", "The judges, again"):
            st = steps[names.index(name)]
            self.assertIn("steps.again.outputs.n > 0", st["if"], name)
            self.assertTrue(st["env"]["RUNS"].endswith("/again"), name)
            first = steps[names.index(name.replace(", again", ""))]
            self.assertEqual(st["run"], first["run"], f"{name} runs as the first run does")
        # Writing the judges' runs holds no env: a step that names $CLAUDE_BIN with an env must carry the key
        # (test_agent_switch), and only the steps that exec the model may (test_workflow_security).
        write = steps[names.index("Write the judges' runs, again")]
        self.assertIn("steps.again.outputs.n > 0", write["if"])
        self.assertEqual(write["run"], steps[names.index("Write the judges' runs")]["run"].replace("$GATE/runs", "$GATE/again"))
        self.assertEqual(steps[names.index("The clients, again")]["env"]["NODES"], "a")
        collect = steps[names.index("Collect the verdicts of the run again")]
        self.assertIn('collect --dir "$GATE/again" --out "$GATE/results.jsonl"', collect["run"])
        self.assertLess(names.index("Collect the clients' and the judges' verdicts"), names.index("What to run again"))
        self.assertLess(names.index("Collect the verdicts of the run again"), names.index("The gate's verdict"))


class ATakenPort(unittest.TestCase):
    """A node already answering on the port the gate was handed does not stop the bank.

    The round starts its own scratch node on a port nothing answers on, and the client's file names that port.
    7788 stays the owner's: the search never hands it over, and never hands over the port whose devnet would be it.
    """

    def setUp(self):
        import subprocess
        self.subprocess = subprocess
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.gate = self.root / "gate"
        self.gate.mkdir()
        (self.root / "runner").mkdir()
        self.asked = self.root / "ports"
        self.stub = self.root / "scratch-node.sh"
        marker = self.root / "refused"
        self.stub.write_text(textwrap.dedent(f"""\
            #!/bin/sh
            set -eu
            dir=$1
            echo "$PORT" >> "{self.asked}"
            case "$PORT" in
              7788|7787) echo "scratch-node: 7788 is the owner's port" >&2; exit 1 ;;
            esac
            if [ "${{FATAL:-}}" = "$PORT" ]; then
              echo "scratch-node: no runtime to sign a page's calls in" >&2
              exit 1
            fi
            if [ "${{REFUSE_FIRST:-}}" = 1 ] && [ ! -f "{marker}" ]; then
              echo 1 > "{marker}"
              echo "scratch-node: a node already answers on port $PORT" >&2
              exit 1
            fi
            mkdir -p "$dir"
            echo unb_testtoken > "$dir/token"
        """))
        self.stub.chmod(0o755)
        self.servers = []

    def hold(self, port):
        import socket
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        class Health(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *_):
                pass

        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Health)
        except OSError:
            self.skipTest(f"port {port} was taken before the test could hold it")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.addCleanup(server.server_close)
        self.servers.append(server)
        # The search treats a port as taken once something accepts a connection.
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            pass

    def free_port(self, span):
        import socket
        for _ in range(40):
            probe = socket.socket()
            probe.bind(("127.0.0.1", 0))
            base = probe.getsockname()[1]
            probe.close()
            if base < 20000 or base + span >= 65533:
                continue
            if any(p in (7787, 7788) for p in range(base, base + span)):
                continue
            held = []
            try:
                for p in range(base, base + span):
                    sock = socket.socket()
                    sock.bind(("127.0.0.1", p))
                    held.append(sock)
            except OSError:
                for sock in held:
                    sock.close()
                continue
            for sock in held:
                sock.close()
            return base
        self.fail("no free ports")

    def start(self, port, **more):
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.root),
            "TMPDIR": str(self.root),
            "SCOPE": "slice",
            "GATE": str(self.gate),
            "RUNNER_TEMP": str(self.root / "runner"),
            "CLAUDE_BIN": "claude",
            "GITHUB_SHA": "abc",
            "GITHUB_WORKSPACE": str(HERE.parents[1]),
            "SCRATCH_NODE": str(self.stub),
        }
        env.update(more)
        return self.subprocess.run(
            ["sh", "test-banks/gate/start-rounds.sh", str(self.gate / "runs"), "n", str(port)],
            cwd=HERE.parents[1], env=env, capture_output=True, text=True, timeout=60)

    def asked_ports(self):
        if not self.asked.exists():
            return []
        return [int(line) for line in self.asked.read_text().split() if line.strip()]

    def mcp_port(self, round_n=0):
        mcp = json.loads((self.root / "runner" / f"n{round_n}" / "mcp.json").read_text())
        url = mcp["mcpServers"]["unbrowse"]["env"]["UNBROWSE_NODE"]
        self.assertEqual(mcp["mcpServers"]["unbrowse"]["env"]["UNBROWSE_AGENT_TOKEN"], "unb_testtoken")
        self.assertTrue(url.startswith("http://127.0.0.1:"), url)
        return int(url.rsplit(":", 1)[1])

    def test_a_free_port_is_the_one_the_round_starts_on(self):
        port = self.free_port(4)
        done = self.start(port)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.asked_ports()[0], port)
        self.assertEqual(self.mcp_port(), port)
        self.assertNotIn(7788, self.asked_ports())

    def test_the_mcp_server_is_the_unb_the_job_names(self):
        # node_ref builds the tag's node and this commit's unb: a tag older than `unb mcp` has no MCP server at all, and
        # the run then measures nothing (26 Nov 2026: 2,000 tasks off_node).
        port = self.free_port(4)
        done = self.start(port, SETTINGS_V="2", UNB_MCP="/tmp/bench/unb")
        self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
        mcp = json.loads((self.root / "runner" / "n0" / "mcp.json").read_text())
        self.assertEqual(mcp["mcpServers"]["unbrowse"]["command"], "/tmp/bench/unb")

    def test_the_historical_node_uses_its_bearer_mcp_adapter(self):
        port = self.free_port(4)
        done = self.start(port, SETTINGS_V="2", HISTORICAL_BEARER_MCP="1", UNB_MCP="/tmp/bench/unb")
        self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
        mcp = json.loads((self.root / "runner" / "n0" / "mcp.json").read_text())
        server = mcp["mcpServers"]["unbrowse"]
        self.assertEqual(pathlib.Path(server["command"]).name, "python3")
        self.assertEqual(server["args"], ["-I", str(HERE / "historical_mcp.py")])

    def test_a_port_a_node_already_answers_on_is_left_and_the_round_starts_beside_it(self):
        port = self.free_port(6)
        self.hold(port)
        done = self.start(port)
        self.assertEqual(done.returncode, 0, done.stderr + done.stdout)
        self.assertNotIn(port, self.asked_ports(), "the port a node already answers on is not started on")
        self.assertNotIn(7788, self.asked_ports())
        # Ten cold tasks at six a round is two nodes. Each client's file names the port that node was started on.
        ports = self.asked_ports()
        self.assertEqual([self.mcp_port(i) for i in range(len(ports))], ports)
        self.assertGreaterEqual(ports[0], port + 1)
        self.assertGreaterEqual(ports[-1], ports[0] + 2)
        self.assertIn(f"127.0.0.1:{ports[0]}", done.stdout)

    def test_a_port_taken_between_the_look_and_the_start_is_not_the_rounds(self):
        port = self.free_port(6)
        done = self.start(port, REFUSE_FIRST="1")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.asked_ports()[0], port, "the free port is asked, then refused")
        self.assertGreater(self.mcp_port(), port)
        self.assertNotEqual(self.mcp_port(), port)

    def test_the_next_round_keeps_clear_of_the_devnet_port(self):
        port = self.free_port(8)
        done = self.start(port, PER="1")
        self.assertEqual(done.returncode, 0, done.stderr)
        first, second = self.mcp_port(0), self.mcp_port(1)
        self.assertEqual(first, port)
        self.assertGreaterEqual(second, first + 2, "the next node does not take this one's devnet port")

    def test_the_owners_port_is_never_handed_to_the_scratch_node(self):
        done = self.start(7788)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn(7788, self.asked_ports())
        self.assertNotIn(7787, self.asked_ports())
        ports = self.asked_ports()
        self.assertEqual([self.mcp_port(i) for i in range(len(ports))], ports)
        self.assertGreater(ports[0], 7788)

    def test_a_run_looks_a_step_of_its_own_past_the_handed_port(self):
        port = self.free_port(8)
        done = self.start(port, GITHUB_RUN_ID="1")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.asked_ports()[0], port + 2)
        self.assertEqual(self.mcp_port(), port + 2)

    def test_a_failure_that_is_not_a_taken_port_still_stops_the_round(self):
        port = self.free_port(4)
        done = self.start(port, FATAL=str(port))
        self.assertNotEqual(done.returncode, 0, done.stdout)
        self.assertIn("no runtime", done.stderr)
        self.assertFalse((self.root / "runner" / "n0" / "mcp.json").exists())

    def test_the_slice_starts_through_the_same_script(self):
        text = (HERE.parents[1] / ".github" / "workflows" / "pr-agent-checks.yml").read_text()
        start = text.split("name: Start the scratch nodes and write the clients' runs", 1)[1]
        start = start.split("name: The clients", 1)[0]
        self.assertIn('start-rounds.sh "$GATE/runs" n 17810', start)
        self.assertIn("SCOPE: slice", start)
        self.assertNotIn("17810 + r", start)
        self.assertNotIn("none.jsonl", start)


if __name__ == "__main__":
    unittest.main()
