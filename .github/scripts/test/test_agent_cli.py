"""The one place CI asks a model: the switch, and the caps opencode has no flag for.

Every test stands a fake CLI in for the real one, so nothing here calls a model:
`AGENT_CLI=claude` must hand the argv through untouched, `AGENT_CLI=opencode` must build the same job
(`--format json`, the model, the prompt, the MCP servers, the permissions) and must enforce the turn and token
caps itself, because dropping them would loosen a check rather than swap a product.
"""
from __future__ import annotations

import base64
import importlib.util
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "agent_cli.py"


def fake(directory: pathlib.Path, name: str, body: str) -> pathlib.Path:
    path = directory / name
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


def run(env: dict, argv: list, cwd: pathlib.Path | None = None) -> subprocess.CompletedProcess:
    full = dict(os.environ, **env)
    full.pop("CLAUDE_BIN", None) if "CLAUDE_BIN" not in env else None
    return subprocess.run([sys.executable, str(SCRIPT), *argv], env=full, capture_output=True, text=True,
                          cwd=str(cwd) if cwd else None)


class ClaudeIsTheDefault(unittest.TestCase):
    def test_the_argv_is_handed_to_claude_untouched(self):
        """No AGENT_CLI: the pinned CLI is run with exactly what CI passed, so nothing changes until it is flipped."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            seen = d / "argv.txt"
            claude = fake(d, "claude", f'printf "%s\\n" "$@" > "{seen}"\nprintf \'{{"type":"result","result":"ok"}}\\n\'\n')
            got = run({"CLAUDE_BIN": str(claude)}, ["-p", "hello", "--output-format", "json", "--max-turns", "7"])
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertEqual(seen.read_text().strip().split("\n"), ["-p", "hello", "--output-format", "json", "--max-turns", "7"])
            self.assertIn('"result":"ok"', got.stdout)

    def test_no_cli_at_all_says_so_and_does_not_pretend(self):
        got = run({"CLAUDE_BIN": "/nonexistent/claude"}, ["-p", "x"])
        self.assertEqual(got.returncode, 127)
        self.assertIn("is not there", got.stderr)

    def _stand_in(self, d: pathlib.Path, name: str, body: str) -> pathlib.Path:
        return fake(d, name, body)

    def test_a_weekly_limit_falls_back_to_opencode(self):
        """The account refusing is not an answer: the captured sentence, is_error, no tokens spent. The same argv
        runs through opencode on AGENT_MODEL, and a bare Claude alias is not what opencode is given."""
        sentence = "You've hit your weekly limit · resets Nov 27 at 7am (Asia/Singapore)"
        for code in (1, 0):
            with self.subTest(exit=code):
                self._refuses_and_falls_back(sentence, code, as_json=True)
        self._refuses_and_falls_back("Your usage credits are exhausted", 1, as_json=True)

    def test_a_spent_credit_on_stderr_falls_back_to_opencode(self):
        """24 Nov 2026 the jobs died on this sentence with no JSON at all."""
        self._refuses_and_falls_back("Credit balance is too low", 1, as_json=False)

    def test_a_refusal_with_no_opencode_stands(self):
        """No fallback binary: the sentence is still the answer, and the log says the refusal stands."""
        sentence = "You've hit your weekly limit · resets Nov 27 at 7am (Asia/Singapore)"
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            said = d / "claude-out.json"
            said.write_text(json.dumps({
                "type": "result", "is_error": True, "result": sentence,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            }))
            self._stand_in(d, "claude", f'cat "{said}"\nexit 1\n')
            got = run(
                {"CLAUDE_BIN": str(d / "claude"), "PATH": "/usr/bin:/bin",
                 "AGENT_MODEL": "opencode-go/deepseek-v4-pro"},
                ["-p", "review it", "--output-format", "json"],
                cwd=d,
            )
            self.assertNotEqual(got.returncode, 0)
            self.assertIn("weekly limit", got.stdout)
            self.assertIn("no `opencode` on PATH", got.stderr)
            self.assertIn("Claude Code refused", got.stderr)

    def _refuses_and_falls_back(self, sentence: str, code: int, as_json: bool) -> None:
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            seen = d / "opencode-argv.json"
            if as_json:
                said = d / "claude-out.json"
                said.write_text(json.dumps({
                    "type": "result", "subtype": "success", "is_error": True, "result": sentence,
                    "total_cost_usd": 0, "num_turns": 1, "duration_ms": 362,
                    "usage": {"input_tokens": 0, "output_tokens": 0,
                              "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0},
                }))
                claude_body = f'cat "{said}"\nexit {code}\n'
            else:
                said = d / "claude-err.txt"
                said.write_text(sentence + "\n")
                claude_body = f'cat "{said}" >&2\nexit {code}\n'
            self._stand_in(d, "claude", claude_body)
            self._stand_in(d, "opencode",
                           f'python3 -c \'import json,sys; json.dump(sys.argv[1:], open("{seen}", "w"))\' "$@"\n'
                           'printf \'{"type":"text","part":{"text":"the route answered"}}\\n\'\n')
            got = run(
                {"CLAUDE_BIN": str(d / "claude"), "PATH": f"{d}:{os.environ['PATH']}",
                 "AGENT_MODEL": "opencode-go/deepseek-v4-pro"},
                ["-p", "review it", "--output-format", "json", "--model", "sonnet"],
                cwd=d,
            )
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertIn("the route answered", got.stdout)
            self.assertNotIn("weekly limit", got.stdout)
            self.assertNotIn("Credit balance", got.stdout)
            self.assertIn("Claude Code refused", got.stderr)
            self.assertIn("opencode runs opencode-go/deepseek-v4-pro", got.stderr)
            argv = json.loads(seen.read_text())
            self.assertIn("opencode-go/deepseek-v4-pro", argv)
            self.assertNotIn("sonnet", argv)

    def test_a_real_error_stays_claudes(self):
        """A failure that spent tokens, or that is not the account's sentence, is Claude's own answer."""
        cases = [
            {"type": "result", "is_error": True, "result": "found a bug",
             "usage": {"input_tokens": 40, "output_tokens": 12, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}},
            {"type": "result", "is_error": True, "result": "weekly limit reached after the review",
             "usage": {"input_tokens": 40, "output_tokens": 12, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}},
            {"type": "result", "is_error": True, "result": "the page returned 500",
             "usage": {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}},
        ]
        for payload in cases:
            with self.subTest(result=payload["result"]):
                with tempfile.TemporaryDirectory() as d:
                    d = pathlib.Path(d)
                    marker = d / "opencode-ran"
                    self._stand_in(d, "claude", f'printf \'%s\\n\' \'{json.dumps(payload)}\'\nexit 1\n')
                    self._stand_in(d, "opencode", f'touch "{marker}"\n')
                    got = run(
                        {"CLAUDE_BIN": str(d / "claude"), "PATH": f"{d}:{os.environ['PATH']}",
                         "AGENT_MODEL": "opencode-go/deepseek-v4-pro"},
                        ["-p", "review it", "--output-format", "json"],
                        cwd=d,
                    )
                    self.assertEqual(got.returncode, 1, got.stderr)
                    self.assertIn(payload["result"], got.stdout)
                    self.assertFalse(marker.exists(), "opencode ran for an answer that was Claude's")
                    self.assertNotIn("opencode runs", got.stderr)


class OpencodeCarriesTheSameJob(unittest.TestCase):
    def fake_opencode(self, d: pathlib.Path, events: list) -> pathlib.Path:
        """A stand-in that records its argv and answers with these NDJSON events."""
        argv = d / "argv.txt"
        lines = "\\n".join(json.dumps(e).replace('"', '\\"') for e in events)
        body = f'printf "%s\\n" "$@" > "{argv}"\nprintf "{lines}\\n"\n'
        return fake(d, "opencode", body)

    def test_the_job_is_rebuilt_with_the_mcp_servers_and_the_permissions(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [
                {"type": "text", "part": {"text": "no bugs found"}},
                {"type": "step_start"},
                {"type": "step_finish", "part": {"tokens": {"input": 100, "output": 20, "cache": {"read": 5, "write": 7}}}},
            ])
            mcp = d / "mcp.json"
            mcp.write_text(json.dumps({"mcpServers": {"unbrowse": {"command": "/x/unb", "args": ["mcp"], "env": {"K": "V"}}}}))
            got = run(
                {"AGENT_CLI": "opencode", "PATH": f"{d}:{os.environ['PATH']}", "GITHUB_WORKSPACE": str(d), "AGENT_MODEL": "opencode-go/deepseek-v4-pro"},
                ["-p", "review it", "--output-format", "json", "--strict-mcp-config", "--mcp-config", str(mcp),
                 "--tools", "Read,Grep", "--allowedTools", "Read,Grep", "--disallowedTools", "Bash,WebFetch",
                 "--max-turns", "40", "--max-budget-usd", "3", "--no-session-persistence", "--setting-sources", "project"],
                cwd=d,
            )
            self.assertEqual(got.returncode, 0, got.stderr)
            argv = (d / "argv.txt").read_text().split("\n")
            self.assertEqual(argv[:5], ["--standalone", "run", "--format", "json", "-m"])
            self.assertEqual(argv[5], "opencode-go/deepseek-v4-pro")
            self.assertIn("--archived", argv)
            self.assertIn("review it", argv)
            self.assertNotIn("--auto", argv, "a permission map is given, so nothing is auto-approved")
            result = json.loads(got.stdout.strip().splitlines()[-1])
            self.assertEqual((result["is_error"], result["result"]), (False, "no bugs found"))
            self.assertEqual(result["usage"]["input_tokens"], 100)
            self.assertEqual(result["usage"]["cache_creation_input_tokens"], 7)
            self.assertFalse((d / "opencode.json").exists(), "nothing of the run is written into the folder it runs in")

    def test_the_caps_are_enforced_here_because_opencode_has_no_flag_for_them(self):
        """`--max-budget-usd` becomes a cap on billed tokens: past it the child is stopped, and the answer says so."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            big = {"type": "step_finish", "part": {"tokens": {"input": 400_000, "output": 1_000, "cache": {"read": 0, "write": 0}}}}
            self.fake_opencode(d, [{"type": "text", "part": {"text": "working"}}, big])
            got = run({"AGENT_CLI": "opencode", "PATH": f"{d}:{os.environ['PATH']}", "GITHUB_WORKSPACE": str(d), "AGENT_MAX_TOKENS": "1000"},
                      ["-p", "x", "--output-format", "json", "--max-budget-usd", "3"], cwd=d)
            result = json.loads(got.stdout.strip().splitlines()[-1])
            self.assertTrue(result["is_error"])
            self.assertIn("token cap (1000 billed tokens)", result["result"])
            self.assertEqual(got.returncode, 1, "a capped run is not a success")

    def test_what_the_child_says_when_it_dies_is_kept(self):
        """A run that dies before it says anything in JSON — a missing provider, a flag it doesn't know — is exactly the
        run someone has to diagnose, so its own words go to the log and into the answer, never to /dev/null."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            path = d / "opencode"
            path.write_text("#!/bin/sh\necho 'provider opencode-go is not configured' >&2\nexit 3\n")
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
            got = run({"AGENT_CLI": "opencode", "PATH": f"{d}:{os.environ['PATH']}", "GITHUB_WORKSPACE": str(d)},
                      ["-p", "x", "--output-format", "json"], cwd=d)
            self.assertIn("provider opencode-go is not configured", got.stderr, "the child's stderr reaches the log")
            result = json.loads(got.stdout.strip().splitlines()[-1])
            self.assertTrue(result["is_error"])
            self.assertIn("provider opencode-go is not configured", " ".join(result["agent_cli"]["said"]))

    def test_a_flag_it_cannot_honour_is_refused_by_name(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "unused"}}])
            got = run({"AGENT_CLI": "opencode", "PATH": f"{d}:{os.environ['PATH']}"}, ["-p", "x", "--agents", "a.json"])
            self.assertNotEqual(got.returncode, 0)
            self.assertIn("--agents has no equivalent", got.stderr)


class OpencodeTwoIsTheCliCIInstalls(unittest.TestCase):
    """The switch targets opencode 2.x: its permission rule list, its tool names, its events. A fake CLI stands in,
    and the config it would read is kept before the wrapper takes it away, so the checks are read, not assumed."""

    def fake_opencode(self, d: pathlib.Path, events: list, exit_code: int = 0) -> pathlib.Path:
        argv, cwd, home, config = d / "argv.json", d / "cwd.txt", d / "home.txt", d / "config.json"
        lines = "\\n".join(json.dumps(e).replace('"', '\\"') for e in events)
        body = (f'python3 -c \'import json, sys; json.dump(sys.argv[1:], open("{argv}", "w"))\' "$@"\n'
                f'pwd > "{cwd}"\nprintf "%s" "$HOME" > "{home}"\n'
                f'printf "%s" "${{OPENCODE_DISABLE_PROJECT_CONFIG:-}}" > "{d / "project-config-disabled.txt"}"\n'
                f'cfg="${{OPENCODE_CONFIG:-opencode.json}}"; [ -f "$cfg" ] && cp "$cfg" "{config}"\n'
                f'printf "{lines}\\n"\nexit {exit_code}\n')
        return fake(d, "opencode", body)

    def argv(self, d: pathlib.Path) -> list:
        return json.loads((d / "argv.json").read_text())

    def env(self, d: pathlib.Path, **extra) -> dict:
        return {"AGENT_CLI": "opencode", "PATH": f"{d}:{os.environ['PATH']}", "GITHUB_WORKSPACE": str(d), **extra}

    def test_a_closed_allow_list_is_a_deny_all_with_the_named_tools_allowed(self):
        """Claude's --allowedTools is a closed set. opencode 2.x reads ordered rules, last match wins, and its base
        policy allows everything — so the closed set is a deny-all first, then the allows, or the check is loosened."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            got = run(self.env(d), ["-p", "x", "--output-format", "json",
                                    "--allowedTools", "Read,Write,mcp__unbrowse__unbrowse_do,mcp__qa",
                                    "--disallowedTools", "Bash,WebFetch,Read(/tmp/**)"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            cfg = json.loads((d / "config.json").read_text())
            rules = cfg["permissions"]
            self.assertEqual(rules[0], {"action": "*", "resource": "*", "effect": "deny"})
            self.assertIn({"action": "read", "resource": "*", "effect": "allow"}, rules)
            self.assertIn({"action": "edit", "resource": "*", "effect": "allow"}, rules, "write is the edit action in 2.x")
            self.assertIn({"action": "unbrowse_unbrowse_do", "resource": "*", "effect": "allow"}, rules)
            self.assertIn({"action": "qa_*", "resource": "*", "effect": "allow"}, rules, "a server prefix allows its tools")
            self.assertIn({"action": "shell", "resource": "*", "effect": "deny"}, rules, "bash is shell in 2.x")
            self.assertIn({"action": "read", "resource": "/tmp/*", "effect": "deny"}, rules)
            self.assertLess(rules.index({"action": "shell", "resource": "*", "effect": "deny"}), len(rules))
            self.assertNotIn("--auto", self.argv(d), "a restricted run is not auto-approved")

    def test_a_server_prefix_names_each_tool_the_server_lists(self):
        """`mcp__unbrowse` is every tool of that server to Claude. opencode 2.4.1 keeps a prefix as `unbrowse_*`,
        and the gate's clients on PR agent checks 45572219035 (25 Nov 2026) then saw no unbrowse tool once the
        closed set also denied the shell and the skill. That run's QA job named each tool and called the node.
        A server that answers tools/list is allowed by those exact names. A prefix with no server keeps the
        wildcard, and the log says it listed nothing."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            server = d / "mcp.py"
            server.write_text(
                "import json, sys\n"
                "for line in sys.stdin:\n"
                "    msg = json.loads(line)\n"
                "    if msg.get('id') == 2:\n"
                "        print(json.dumps({'jsonrpc':'2.0','id':2,'result':{'tools':["
                "{'name':'unbrowse_do'},{'name':'unbrowse_call'}]}}), flush=True)\n"
            )
            mcp = d / "mcp.json"
            mcp.write_text(json.dumps({"mcpServers": {"unbrowse": {"command": sys.executable, "args": [str(server)]}}}))
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            got = run(self.env(d), ["-p", "x", "--output-format", "json", "--mcp-config", str(mcp),
                                    "--allowedTools", "mcp__unbrowse,mcp__qa",
                                    "--disallowedTools", "Bash,Skill"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            rules = json.loads((d / "config.json").read_text())["permissions"]
            self.assertIn({"action": "unbrowse_unbrowse_do", "resource": "*", "effect": "allow"}, rules)
            self.assertIn({"action": "unbrowse_unbrowse_call", "resource": "*", "effect": "allow"}, rules)
            self.assertNotIn({"action": "unbrowse_*", "resource": "*", "effect": "allow"}, rules)
            self.assertIn({"action": "qa_*", "resource": "*", "effect": "allow"}, rules)
            self.assertIn("mcp__qa listed no tools", got.stderr)

    def test_the_skill_tool_speaks_the_readers_vocabulary(self):
        """skill_trigger.py reads the skill a session opened from Claude's Skill input (`skill`, `command` or
        `name`); opencode's tool is handed `{id: …}`. The stream is the readers' shape either way."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [
                {"type": "tool_use", "part": {"id": "c1", "tool": "skill", "state": {"status": "completed", "input": {"id": "test-skill"}, "output": "ok"}}},
                {"type": "text", "part": {"text": "done"}},
            ])
            got = run(self.env(d), ["-p", "x", "--output-format", "stream-json", "--allowedTools", "Skill"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            events = [json.loads(line) for line in got.stdout.splitlines()]
            use = next(b for e in events if e.get("type") == "assistant"
                       for b in e["message"]["content"] if b.get("type") == "tool_use")
            self.assertEqual(use["name"], "Skill")
            self.assertEqual(use["input"].get("skill"), "test-skill")

    def test_a_tool_that_shares_an_action_does_not_take_the_allowed_sibling_with_it(self):
        """2.x folds write/edit/patch into one `edit` action, and QA and the autofix allow Write while denying Edit
        (in Claude they are two tools). Denying the shared action wholesale would make the allow meaningless, so a
        sibling's allow governs it; a deny of a path still applies to that path."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            got = run(self.env(d), ["-p", "x", "--output-format", "json", "--allowedTools", "Read,Write",
                                    "--disallowedTools", "Edit,NotebookEdit,Write(/tmp/**)"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            rules = json.loads((d / "config.json").read_text())["permissions"]
            self.assertIn({"action": "edit", "resource": "*", "effect": "allow"}, rules)
            self.assertNotIn({"action": "edit", "resource": "*", "effect": "deny"}, rules,
                             "a sibling tool's allow governs the shared action")
            self.assertTrue(any(r == {"action": "edit", "resource": "/tmp/*", "effect": "deny"} for r in rules),
                            "a deny with a path still applies")

    def test_a_disallow_list_alone_denies_by_name_and_leaves_the_rest(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            got = run(self.env(d), ["-p", "x", "--output-format", "json", "--disallowedTools", "Bash,Task,Skill"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            rules = json.loads((d / "config.json").read_text())["permissions"]
            self.assertEqual(rules, [{"action": "shell", "resource": "*", "effect": "deny"},
                                     {"action": "subagent", "resource": "*", "effect": "deny"},
                                     {"action": "skill", "resource": "*", "effect": "deny"}])

    def test_the_mcp_servers_are_the_shape_opencode_2_reads(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            mcp = d / "mcp.json"
            mcp.write_text(json.dumps({"mcpServers": {"unbrowse": {"command": "/x/unb", "args": ["mcp"], "env": {"K": "V"}}}}))
            got = run(self.env(d), ["-p", "x", "--output-format", "json", "--mcp-config", str(mcp)], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            cfg = json.loads((d / "config.json").read_text())
            self.assertEqual(cfg["mcp"], {"servers": {"unbrowse": {"type": "local", "command": ["/x/unb", "mcp"],
                                                                   "environment": {"K": "V"}, "enabled": True}}})

    def test_the_stream_carries_the_tool_events_and_the_init_the_readers_need(self):
        """run_gate.py, tool_choice.py and skill_trigger.py read Claude-shaped events: assistant tool_use, user
        tool_result, and a system/init naming the tools in hand. The wrapper answers in that shape either way."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            server = d / "mini_mcp.py"
            server.write_text(
                "import json, sys\n"
                "for line in sys.stdin:\n"
                "    m = json.loads(line)\n"
                "    if m.get('id') == 1:\n"
                "        print(json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'mini', 'version': '0'}}}), flush=True)\n"
                "    elif m.get('id') == 2:\n"
                "        print(json.dumps({'jsonrpc': '2.0', 'id': 2, 'result': {'tools': [{'name': 'echo_answer', 'inputSchema': {'type': 'object'}}]}}), flush=True)\n")
            mcp = d / "mcp.json"
            mcp.write_text(json.dumps({"mcpServers": {"mini": {"command": sys.executable, "args": [str(server)]}}}))
            self.fake_opencode(d, [
                {"type": "step_start"},
                {"type": "tool_use", "part": {"id": "call_1", "tool": "mini_echo_answer",
                                              "state": {"status": "completed", "input": {"word": "banana"}, "output": "the answer is banana"}}},
                {"type": "text", "part": {"text": "the answer is banana"}},
                {"type": "step_finish", "part": {"tokens": {"input": 10, "output": 5}}},
            ])
            got = run(self.env(d), ["-p", "x", "--output-format", "stream-json", "--mcp-config", str(mcp),
                                    "--allowedTools", "mcp__mini"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            events = [json.loads(line) for line in got.stdout.splitlines()]
            init = next(e for e in events if e.get("type") == "system" and e.get("subtype") == "init")
            self.assertIn("mcp__mini__echo_answer", init["tools"], "the init names the server's real tools, queried from it")
            use = next(b for e in events if e.get("type") == "assistant"
                       for b in e["message"]["content"] if b.get("type") == "tool_use")
            self.assertEqual((use["id"], use["name"], use["input"]), ("call_1", "mcp__mini__echo_answer", {"word": "banana"}))
            res = next(b for e in events if e.get("type") == "user"
                       for b in e["message"]["content"] if b.get("type") == "tool_result")
            self.assertEqual((res["tool_use_id"], res["content"], res["is_error"]), ("call_1", "the answer is banana", False))
            self.assertEqual(events[-1]["type"], "result")

    def test_a_bare_model_alias_is_claude_vocabulary_and_becomes_the_switchs_model(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            got = run(self.env(d, AGENT_MODEL="opencode-go/deepseek-v4.1-flash"),
                      ["-p", "x", "--output-format", "json", "--model", "sonnet"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            argv = self.argv(d)
            self.assertEqual(argv[argv.index("-m") + 1], "opencode-go/deepseek-v4.1-flash")

    def test_a_model_with_a_provider_is_carried_untouched(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            got = run(self.env(d), ["-p", "x", "--output-format", "json", "--model", "opencode-go/kimi-k3"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            argv = self.argv(d)
            self.assertEqual(argv[argv.index("-m") + 1], "opencode-go/kimi-k3")

    def test_the_subscription_model_requests_ultrafast_with_high_reasoning(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            model = "openai/gpt-6.2-sol#ultrafast-high"
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            got = run(self.env(d, AGENT_MODEL=model), ["-p", "x", "--output-format", "json",
                                                      "--strict-mcp-config"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            argv = self.argv(d)
            self.assertEqual(argv[argv.index("-m") + 1], model)
            config = json.loads((d / "config.json").read_text())
            variants = config["providers"]["openai"]["models"]["gpt-6.2-sol"]["variants"]
            self.assertIn({"id": "ultrafast-high", "settings": {"reasoningEffort": "high"},
                           "body": {"service_tier": "ultrafast", "store": False}}, variants)

    def test_a_gated_router_model_is_declared_with_the_router_and_names_its_key(self):
        # OrcaRouter lists 229 models to a key and 213 to the world: its gated security models are not in the registry
        # opencode resolves a name against, so the run declares the router and the model. The config names the key's
        # variable, never the key.
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            got = run(self.env(d, AGENT_MODEL="orcarouter/orca/orcacyber-zero-1.5", ORCAROUTER_API_KEY="sk-orca-test"),
                      ["-p", "x", "--output-format", "json", "--strict-mcp-config"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertEqual(self.argv(d)[self.argv(d).index("-m") + 1], "orcarouter/orca/orcacyber-zero-1.5")
            routed = json.loads((d / "config.json").read_text())["providers"]["orcarouter"]
            self.assertEqual(routed["settings"]["baseURL"], "https://api.orcarouter.ai/v1")
            self.assertEqual(routed["settings"]["apiKey"], "{env:ORCAROUTER_API_KEY}")
            self.assertIn("orca/orcacyber-zero-1.5", routed["models"])
            self.assertNotIn("sk-orca-test", (d / "config.json").read_text(), "the config holds the key itself")

    def test_chatgpt_uses_only_a_current_plan_oauth_access_grant(self):
        def token(**overrides):
            now = int(time.time())
            claims = {"iss": "https://auth.openai.com", "aud": "https://api.openai.com/v1",
                      "scope": "chatgpt.tokens.use.direct", "iat": now, "exp": now + 3600}
            claims.update(overrides)
            payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
            return f"fixture.{payload}.signature"

        with tempfile.TemporaryDirectory() as directory:
            d = pathlib.Path(directory)
            fake(d, "opencode",
                 f'cp "$OPENCODE_CONFIG" "{d / "config.json"}"\n'
                 'printf "%s\\n" "$OPENAI_API_KEY" "$OPENCODE_API_KEY" "$OPENCODE_CHATGPT_ACCESS_TOKEN" > '
                 f'"{d / "keys.txt"}"\n'
                 "printf '%s\\n' '{\"type\":\"text\",\"part\":{\"text\":\"ok\"}}'\n")
            env = self.env(d, AGENT_AUTH="ChatGPT", AGENT_CLI="claude", AGENT_MODEL="opencode/wrong",
                           OPENCODE_CHATGPT_ACCESS_TOKEN="", OPENCODE_API_KEY="wrong", OPENAI_API_KEY="wrong")
            mcp_config = d / "mcp.json"
            mcp_config.write_text(json.dumps({"mcpServers": {"node": {"command": "unb", "args": ["mcp"]}}}))
            args = ["-p", "x", "--output-format", "json", "--strict-mcp-config", "--mcp-config", str(mcp_config)]
            for invalid in ("", "paid-api-key", token(scope="openid"), token(aud="https://unrelated.example"),
                            token(exp=int(time.time()) - 1), token(exp=int(time.time()) + 86400)):
                env["OPENCODE_CHATGPT_ACCESS_TOKEN"] = invalid
                refused = run(env, ["--check-subscription"], cwd=d)
                self.assertEqual(refused.returncode, 2)
                self.assertIn("expected a current OpenCode ChatGPT OAuth access token", refused.stderr)
            self.assertFalse((d / "config.json").exists())
            env["OPENCODE_CHATGPT_ACCESS_TOKEN"] = token()
            result = run(env, args, cwd=d)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((d / "keys.txt").read_text().splitlines(), [env["OPENCODE_CHATGPT_ACCESS_TOKEN"], "", ""])
            config = json.loads((d / "config.json").read_text())
            self.assertEqual(config["providers"]["openai"]["settings"]["baseURL"], "https://api.openai.com/v1")
            self.assertEqual(config["mcp"]["servers"]["node"]["command"],
                             ["/usr/bin/env", "-u", "OPENAI_API_KEY", "unb", "mcp"])
            self.assertEqual(json.loads(result.stdout)["agent_cli"]["model"], "openai/gpt-6.2-sol#ultrafast-high")

    def test_the_credential_endpoint_returns_an_access_grant_without_following_redirects(self):
        spec = importlib.util.spec_from_file_location("agent_cli", SCRIPT)
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        url = "https://credentials.example/v1/chatgpt-access"
        with patch.object(cli.http.client, "HTTPSConnection") as connect:
            connection = connect.return_value
            connection.getresponse.return_value = Mock(status=200, read=lambda _: b'{"access_token":"fixture"}')
            self.assertEqual(cli.fetch_subscription_access(url, "fixture-key"), "fixture")
            connection.request.assert_called_once_with("POST", "/v1/chatgpt-access",
                                                       headers={"Authorization": "Bearer fixture-key"})
            connection.getresponse.return_value = Mock(status=307)
            with self.assertRaisesRegex(cli.Refused, "HTTP 307"):
                cli.fetch_subscription_access(url, "fixture-key")
            self.assertEqual(connect.call_count, 2)
            with self.assertRaisesRegex(cli.Refused, "expected the HTTPS"):
                cli.fetch_subscription_access("http://credentials.example/v1/chatgpt-access", "fixture-key")
            self.assertEqual(connect.call_count, 2)

    def test_the_system_prompt_reaches_the_model(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            got = run(self.env(d), ["-p", "the task", "--output-format", "json", "--system-prompt", "the harness rules"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertIn("the harness rules\n\nthe task", self.argv(d))

    def test_an_error_event_the_child_answers_with_is_not_dropped(self):
        """opencode answers a refusal (a provider with no route, a bad credential) as a JSON error event. Dropping it
        is how a switch fails silently: the words reach the log and the answer."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "error", "error": {"type": "provider.auth", "message": "Invalid credential"}}], exit_code=1)
            got = run(self.env(d), ["-p", "x", "--output-format", "json"], cwd=d)
            self.assertEqual(got.returncode, 1)
            self.assertIn("Invalid credential", got.stderr)
            result = json.loads(got.stdout.strip().splitlines()[-1])
            self.assertTrue(result["is_error"])
            self.assertIn("Invalid credential", " ".join(result["agent_cli"]["said"]))

    def test_the_stop_reason_reaches_the_log_even_when_stdout_is_a_file(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            big = {"type": "step_finish", "part": {"tokens": {"input": 400_000, "output": 1_000}}}
            self.fake_opencode(d, [{"type": "text", "part": {"text": "working"}}, big])
            got = run(self.env(d, AGENT_MAX_TOKENS="1000"), ["-p", "x", "--output-format", "json", "--max-budget-usd", "3"], cwd=d)
            self.assertEqual(got.returncode, 1)
            self.assertIn("stopped at the token cap", got.stderr)

    def test_the_workspace_is_the_callers_directory(self):
        """The skill sessions cd into a project of their own before asking; the config and the child's cwd belong
        there, not in GITHUB_WORKSPACE, or the skills are not the ones the session reads."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            got = run(self.env(d), ["-p", "x", "--output-format", "json", "--allowedTools", "Skill"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertEqual(os.path.realpath((d / "cwd.txt").read_text().strip()), os.path.realpath(d))
            self.assertTrue((d / "config.json").exists(), "the child was handed the run's config")

    def test_strict_mcp_config_isolates_home_and_disables_project_config_discovery(self):
        """--strict-mcp-config means only the servers given: the global config's servers, skills and plugins must not
        leak in, so the child runs under a home of its own. Without the flag the caller's home is kept."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            env = dict(self.env(d), OPENCODE_DISABLE_PROJECT_CONFIG="0")
            got = run(env, ["-p", "x", "--output-format", "json", "--strict-mcp-config", "--setting-sources", "project"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            home = (d / "home.txt").read_text()
            self.assertNotEqual(home, os.environ["HOME"])
            self.assertFalse(pathlib.Path(home).exists(), "the scratch home is taken away again")
            disabled = d / "project-config-disabled.txt"
            self.assertEqual(disabled.read_text(), "1")
            got = run(env, ["-p", "x", "--output-format", "json"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertEqual((d / "home.txt").read_text(), os.environ["HOME"])
            self.assertEqual(disabled.read_text(), "0")

    def test_runs_side_by_side_on_a_cold_store_all_start(self):
        """opencode 2.4.1 sets up its data store on its first start; a second start on the same cold store meanwhile
        dies with "Standalone server exited before reporting readiness" (measured: four at once on a fresh home, three
        died; on the warm home all four ran). The skill trials run four at a time on a fresh runner, and three of their
        sixteen died that way in 3.7 s with no turn (QA 45316072080). The fake does what the real one did."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            home = d / "home"
            home.mkdir()
            fake(d, "opencode", (
                'store="$HOME/.local/share/opencode"\n'
                'if [ ! -f "$store/opencode.db" ]; then\n'
                '  mkdir -p "$store"\n'
                '  if ! mkdir "$store/.setting-up" 2>/dev/null; then\n'
                '    printf \'{"type":"error","error":{"message":"Standalone server exited before reporting readiness"}}\\n\'\n'
                '    exit 1\n'
                '  fi\n'
                '  sleep 1; : > "$store/opencode.db"; rmdir "$store/.setting-up"\n'
                'fi\n'
                'printf \'{"type":"text","part":{"text":"ok"}}\\n\'\n'))
            full = dict(os.environ, **self.env(d), HOME=str(home))
            full.pop("XDG_DATA_HOME", None)
            argv = [sys.executable, str(SCRIPT), "-p", "x", "--output-format", "json"]
            runs = [subprocess.Popen(argv, env=full, cwd=str(d), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     text=True) for _ in range(4)]
            answers = [(r.wait(timeout=60), *r.communicate()) for r in runs]
            for code, out, err in answers:
                self.assertEqual(code, 0, f"{out}\n{err}")
                self.assertEqual(json.loads(out.strip().splitlines()[-1])["result"], "ok")


    def test_runs_side_by_side_in_one_folder_each_get_their_own_servers(self):
        """The gate's slice runs three clients at once from one checkout, each with its own node's MCP server. A config
        written into that shared folder is another run's (or gone, once the run that wrote it ends): the gate's agents
        came up with no MCP tool at all and every task was set down as infrastructure (PR agent checks 45328727914,
        "No fetch/browser/MCP browsing tool is present in the tool set at all"). Each run carries its own config, and
        nothing of a run is written into the folder it shares."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            fake(d, "opencode", (
                'sleep 1\n'
                'cfg="${OPENCODE_CONFIG:-opencode.json}"\n'
                'seen=$(python3 -c \'import json,sys; print(",".join(sorted(json.load(open(sys.argv[1])).get("mcp",{}).get("servers",{}))))\' "$cfg" 2>/dev/null)\n'
                'printf \'{"type":"text","part":{"text":"%s"}}\\n\' "$seen"\n'))
            runs = []
            for name in ("first", "second", "third"):
                mcp = d / f"{name}.mcp.json"
                mcp.write_text(json.dumps({"mcpServers": {name: {"command": "/x/unb", "args": ["mcp"]}}}))
                full = dict(os.environ, **self.env(d))
                argv = [sys.executable, str(SCRIPT), "-p", "x", "--output-format", "json", "--strict-mcp-config", "--mcp-config", str(mcp)]
                runs.append((name, subprocess.Popen(argv, env=full, cwd=str(d), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)))
            for name, r in runs:
                out, err = r.communicate(timeout=60)
                self.assertEqual(r.returncode, 0, err)
                self.assertEqual(json.loads(out.strip().splitlines()[-1])["result"], name, f"the {name} run saw another's servers")
            self.assertFalse((d / "opencode.json").exists(), "nothing of a run is left in the shared folder")

    def test_each_run_asks_through_a_server_of_its_own(self):
        """opencode 2.x serves every run on the machine from one background service unless told otherwise, and a run
        then gets what that service holds. Each run asks through a private server (`--standalone`)."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            got = run(self.env(d), ["-p", "x", "--output-format", "json"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertIn("--standalone", self.argv(d))

    def test_a_closed_allow_list_closes_code_mode(self):
        """2.x's wildcard deny does not take the execute tool away: a session allowed only Skill still had Code Mode
        (measured on 2.4.1: it ran JS and called search()). A closed set names it, so the only tools are the named
        ones."""
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.fake_opencode(d, [{"type": "text", "part": {"text": "ok"}}])
            got = run(self.env(d), ["-p", "x", "--output-format", "json", "--allowedTools", "Skill"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            rules = json.loads((d / "config.json").read_text())["permissions"]
            self.assertIn({"action": "execute", "resource": "*", "effect": "deny"}, rules)

    def test_the_wrapper_is_not_the_claude_cli_it_should_exec(self):
        """The gate bank execs its CLAUDE_BIN for every run, and that may now be this wrapper. In claude mode it must
        fall back to the pinned CLI rather than exec itself forever."""
        got = run({"CLAUDE_BIN": str(SCRIPT)}, ["-p", "x", "--output-format", "json"])
        self.assertEqual(got.returncode, 127, got.stderr)
        self.assertIn("tools/claude-cli", got.stderr, "the pinned CLI is named, not the wrapper")
        self.assertNotIn("RecursionError", got.stderr)


class ClaudeNeverRunsThroughOpencode(unittest.TestCase):
    """UNB-248. On 23-24 Nov 2026 the Claude CI account was out of quota and QA ran under opencode on a flash model
    nobody chose for it, while the review workflows defaulted to Sonnet through opencode. Steve's rule: Claude models go
    through Claude Code only. A Claude model is refused before opencode starts; any fallback is said in the log and in
    the job summary."""

    def env(self, d: pathlib.Path, **extra) -> dict:
        return {"AGENT_CLI": "opencode", "PATH": f"{d}:{os.environ['PATH']}", "GITHUB_WORKSPACE": str(d),
                "AGENT_MODEL": "", "GITHUB_STEP_SUMMARY": str(d / "summary.md"), **extra}

    def opencode(self, d: pathlib.Path) -> None:
        fake(d, "opencode", f'printf "%s\\n" "$@" > "{d / "argv.txt"}"\nprintf \'{{"type":"text","part":{{"text":"ok"}}}}\\n\'\n')

    def model_run(self, d: pathlib.Path) -> str:
        argv = (d / "argv.txt").read_text().split("\n")
        return argv[argv.index("-m") + 1]

    def summary(self, d: pathlib.Path) -> str:
        return (d / "summary.md").read_text() if (d / "summary.md").exists() else ""

    def test_a_claude_model_asked_for_is_refused_and_opencode_never_starts(self):
        for model in ("anthropic/claude-sonnet-5-5", "opencode/claude-sonnet-5-5", "openrouter/anthropic/claude-x",
                      "opencode/opus-5-5"):
            with self.subTest(model=model), tempfile.TemporaryDirectory() as d:
                d = pathlib.Path(d)
                self.opencode(d)
                got = run(self.env(d), ["-p", "x", "--output-format", "json", "--model", model], cwd=d)
                self.assertEqual(got.returncode, 2, got.stderr)
                self.assertIn("::error::", got.stderr)
                self.assertIn("Claude Code only", got.stderr)
                self.assertFalse((d / "argv.txt").exists(), "opencode was started with a Claude model")

    def test_a_claude_model_in_the_switch_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.opencode(d)
            got = run(self.env(d, AGENT_MODEL="anthropic/claude-haiku-5-5"), ["-p", "x", "--model", "sonnet"], cwd=d)
            self.assertEqual(got.returncode, 2, got.stderr)
            self.assertIn("AGENT_MODEL", got.stderr)
            self.assertFalse((d / "argv.txt").exists())

    def test_no_switch_falls_back_to_a_model_that_is_not_flash_and_says_so(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.opencode(d)
            got = run(self.env(d), ["-p", "x", "--output-format", "json"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertEqual(self.model_run(d), "opencode-go/deepseek-v4-pro")
            self.assertNotIn("flash", self.model_run(d))
            self.assertIn("::warning::agent_cli: AGENT_MODEL is not set: fell back", got.stderr)
            self.assertIn("fell back to agent_cli.py's DEFAULT_MODEL opencode-go/deepseek-v4-pro", self.summary(d))
            result = json.loads(got.stdout.strip().splitlines()[-1])
            self.assertEqual(result["agent_cli"]["model"], "opencode-go/deepseek-v4-pro")
            self.assertTrue(result["agent_cli"]["fallback"], "the answer carries the fallback too")

    def test_a_claude_alias_swapped_for_the_switchs_model_is_said_in_the_log_and_the_summary(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.opencode(d)
            got = run(self.env(d, AGENT_MODEL="opencode-go/deepseek-v4-pro"), ["-p", "x", "--model", "sonnet"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertEqual(self.model_run(d), "opencode-go/deepseek-v4-pro")
            self.assertIn("--model sonnet is a Claude alias: opencode runs opencode-go/deepseek-v4-pro", got.stderr)
            self.assertIn("--model sonnet is a Claude alias", self.summary(d))

    def test_a_flash_model_is_named_as_one(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            self.opencode(d)
            got = run(self.env(d, AGENT_MODEL="opencode-go/deepseek-v4.1-flash"), ["-p", "x"], cwd=d)
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertIn("opencode-go/deepseek-v4.1-flash (AGENT_MODEL) is a flash model", self.summary(d))

    def test_the_model_a_workflow_runs_opencode_with_is_checked_the_same_way(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            got = run(self.env(d), ["--which-model", "opencode/claude-sonnet-5-5"])
            self.assertEqual(got.returncode, 2, got.stderr)
            self.assertEqual(got.stdout, "")
            got = run(self.env(d), ["--which-model", "opencode-go/deepseek-v4-pro"])
            self.assertEqual((got.returncode, got.stdout.strip()), (0, "opencode-go/deepseek-v4-pro"), got.stderr)
            got = run(self.env(d), ["--which-model", ""])
            self.assertEqual((got.returncode, got.stdout.strip()), (0, "opencode-go/deepseek-v4-pro"), got.stderr)
            self.assertIn("fell back", got.stderr)

    def test_no_workflow_runs_a_claude_model_through_opencode(self):
        """opencode-review.yml and opencode-steward.yml defaulted to opencode/claude-sonnet-5-5 (UNB-248)."""
        root = HERE.parent.parent / "workflows"
        for name in ("opencode-review.yml", "opencode-steward.yml"):
            text = (root / name).read_text()
            with self.subTest(workflow=name):
                found = re.search(r"\|\|\s*'[^']*(claude|sonnet|opus|haiku|anthropic)[^']*'", text.lower())
                self.assertIsNone(found, f"a Claude model as the default for an opencode run: {found and found[0]}")
                # The agent runs through agent_cli.py (Lewis, 25 Nov 2026: back on Claude Code), which refuses a Claude
                # model itself when the switch says opencode; a direct `opencode run` must check it first.
                self.assertTrue("agent_cli.py --which-model" in text or ("python3 -I .github/scripts/agent_cli.py" in text
                                and "opencode run" not in text), "the model is checked before opencode runs")


if __name__ == "__main__":
    unittest.main()
