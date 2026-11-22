"""qa_tools.py: QA's terminal runs only the product's listed commands, hands them nothing but the node's own settings,
scrubs keys from what comes back, and pictures and logs every call. No node: fake programs stand in."""
import json
import re
import os
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path

TMP = Path(tempfile.mkdtemp())
os.environ.update({"QA_SHOTS": str(TMP / "shots"), "QA_WORK": str(TMP / "work"), "QA_FIXTURES": str(TMP / "fixtures"),
                   "QA_PROGRAMS": str(TMP / "bin"), "UNBROWSE_HOME": str(TMP / "home"), "UNBROWSE_NODE": "http://127.0.0.1:7788",
                   "UNBROWSE_AGENT_TOKEN": "agent-token-abcdef123", "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat01-model-credential",
                   "QA_CHROME": str(TMP / "chrome")})  # fmt: skip
sys.path.insert(0, str(Path(__file__).resolve().parent))
import qa_tools  # noqa: E402

# A stand-in for unb and unbrowse-node: prints its words, its environment's names, and any token it was handed.
PROGRAM = """#!/bin/sh
echo "words: $*"
env | cut -d= -f1 | sort | tr '\\n' ' '
echo
echo "token: $UNBROWSE_AGENT_TOKEN"
[ "$1" = vault ] && [ "$2" = add ] && { read -r pw; echo "added, ${#pw} characters"; }
[ "$1" = fail ] && exit 3
exit 0
"""
CHROME = """#!/bin/sh
for a in "$@"; do case $a in --screenshot=*) printf '\\211PNG\\r\\n\\032\\nfake' > "${a#--screenshot=}" ;; esac; done
"""


def setUpModule():
    (TMP / "bin").mkdir()
    (TMP / "fixtures").mkdir()
    (TMP / "home").mkdir()
    (TMP / "fixtures/cookies.txt").write_text("x")
    (TMP / "home/owner.token").write_text("owner-token-zyxwvu987\n")
    for name, text in (("bin/unb", PROGRAM), ("bin/unbrowse-node", PROGRAM), ("chrome", CHROME)):
        path = TMP / name
        path.write_text(text)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)


def call(name, arguments):
    reply = qa_tools.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}})
    result = reply["result"]
    return result["isError"], result["content"][0]["text"]


class TerminalTest(unittest.TestCase):
    def setUp(self):
        os.environ["UNBROWSE_AGENT_TOKEN"] = "agent-token-abcdef123"  # test_mcp_check sets its own in the same process

    def test_a_listed_command_runs_with_only_the_nodes_settings(self):
        err, text = call("terminal", {"program": "unb", "args": ["whoami"]})
        self.assertFalse(err, text)
        self.assertIn("words: whoami", text)
        self.assertIn("[exit 0", text)
        for leaked in ("CLAUDE_CODE_OAUTH_TOKEN", "QA_CHROME", "GITHUB_TOKEN", "sk-ant-oat01"):
            self.assertNotIn(leaked, text)
        self.assertIn("UNBROWSE_NODE", text)
        # The token reaches the program (unb signs with it) but never comes back in the reply.
        self.assertIn("token: [redacted]", text)
        self.assertNotIn("agent-token-abcdef123", text)

    def test_every_call_is_pictured_and_logged(self):
        err, text = call("terminal", {"program": "unbrowse-node", "args": ["network"]})
        self.assertFalse(err, text)
        picture = text.rsplit("picture: ", 1)[1].strip()
        self.assertTrue(qa_tools.is_png(Path(picture)), picture)
        lines = [json.loads(line) for line in (TMP / "shots/steps/steps.jsonl").read_text().splitlines()]
        self.assertTrue(any(line["program"] == "unbrowse-node" and line["command"] == "network" and line["picture"] for line in lines))

    def test_commands_that_print_a_key_or_reach_outside_are_refused(self):
        refused = [
            ("unbrowse-node", ["agent", "token", "1"]),
            ("unbrowse-node", ["wallet", "export"]),
            ("unbrowse-node", ["vault", "rotate", "a", "b"]),
            ("unbrowse-node", ["session", "import", "x.com", "--from", "/etc/passwd"]),
            ("unbrowse-node", ["session", "import", "x.com"]),
            ("unb", ["grant"]),
            ("unb", ["connect"]),
            ("unb", ["mcp"]),
            ("unbrowse", ["skill", "/tmp/elsewhere"]),
            ("sh", ["-c", "id"]),
            ("unb", []),
            ("unb", "whoami"),
        ]
        for program, words in refused:
            err, text = call("terminal", {"program": program, "args": words})
            self.assertTrue(err, f"{program} {words} ran: {text}")
            self.assertIn("refused", text)

    def test_a_fixture_inside_the_folder_is_allowed(self):
        err, text = call("terminal", {"program": "unbrowse-node", "args": ["session", "import", "x.com", "--from", str(TMP / "fixtures/cookies.txt")]})
        self.assertFalse(err, text)
        err, text = call("terminal", {"program": "unbrowse-node", "args": ["session", "import", "x.com", "--from", str(TMP / "fixtures/../home/owner.token")]})
        self.assertTrue(err, text)

    def test_stdin_only_for_a_stored_password_and_never_echoed(self):
        err, text = call("terminal", {"program": "unbrowse-node", "args": ["vault", "add", "qa.example", "me", "--stored"], "stdin": "qa-secret-991"})
        self.assertFalse(err, text)
        self.assertIn("added, 13 characters", text)
        self.assertNotIn("qa-secret-991", text)
        err, text = call("terminal", {"program": "unb", "args": ["do", "x"], "stdin": "anything"})
        self.assertTrue(err, text)

    def test_the_owners_token_is_scrubbed_from_any_reply(self):
        self.assertEqual(qa_tools.scrub("a owner-token-zyxwvu987 b unb_abc.def sk-ant-x1"), "a [redacted] b [redacted] [redacted]")

    def test_the_server_answers_the_mcp_handshake_and_lists_both_tools(self):
        init = qa_tools.handle({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
        self.assertEqual(init["result"]["protocolVersion"], "2025-06-18")
        listed = qa_tools.handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual({t["name"] for t in listed["result"]["tools"]}, {"terminal", "window"})
        self.assertIsNone(qa_tools.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))

    def test_the_window_says_plainly_when_it_cannot_run(self):
        os.environ.pop("QA_WINDOW", None)
        err, text = call("window", {"action": "open"})
        self.assertTrue(err)
        self.assertIn("isn't built", text)
        err, text = call("window", {"action": "click", "text": "Vault"})
        self.assertTrue(err)
        self.assertIn("no window is open", text)


# A stand-in for the window: hidden, it stays up; with --nanoui-snapshot it draws a PNG unless its script clicks a text
# that isn't drawn ("Nope"). Every run's words go to a log.
WINDOW = """#!/bin/sh
echo "$HOME | $*" >> "$(dirname "$0")/window-runs.log"
gone="$(cat "$(dirname "$0")/gone" 2>/dev/null)"
if [ -n "$gone" ]; then
  for a in "$@"; do case $a in --nanoui-script=*"$gone;live:2;"*) echo "error: TextNotFound" >&2; exit 1 ;; esac; done
fi
for a in "$@"; do
  case $a in
    --nanoui-hidden) exec sleep 60 ;;
    --nanoui-script=*click:Nope*) echo "error: TextNotFound" >&2; exit 1 ;;
  esac
done
for a in "$@"; do
  case $a in --nanoui-snapshot=*) { printf '\\211PNG\\r\\n\\032\\n'; head -c 20000 /dev/zero; } > "${a#--nanoui-snapshot=}" ;; esac
done
"""


class Window(unittest.TestCase):
    """The window draws itself: no screen is read, no key reaches another app, on a person's own Mac or anywhere."""

    def setUp(self):
        path = TMP / "bin/unbrowse-window"
        path.write_text(WINDOW)
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        (TMP / "bin/window-runs.log").unlink(missing_ok=True)
        os.environ["QA_WINDOW"] = str(path)
        self.addCleanup(lambda: call("window", {"action": "close"}))

    def runs(self):
        return (TMP / "bin/window-runs.log").read_text().splitlines()

    def test_open_keeps_a_hidden_window_on_this_node_and_pictures_it(self):
        err, text = call("window", {"action": "open", "wait_s": 0.2, "wait": 0})
        self.assertFalse(err, text)
        self.assertTrue(qa_tools.window_alive())
        hidden, drawn = self.runs()[0], self.runs()[1]
        self.assertIn("--nanoui-hidden", hidden)
        self.assertIn("--nanoui-snapshot=", drawn)
        home = Path(drawn.split(" | ")[0])
        self.assertEqual((home / ".unbrowse").resolve(), (TMP / "home").resolve())
        self.assertTrue(qa_tools.is_png(Path(text.rsplit(": ", 1)[1])))

    def test_each_click_replays_the_steps_before_it_and_a_missing_text_is_an_error(self):
        call("window", {"action": "open", "wait_s": 0.2})
        err, text = call("window", {"action": "click", "text": "Vault", "wait_s": 0.1})
        self.assertFalse(err, text)
        self.assertIn("--nanoui-script=live:3;click:Vault;live:2", self.runs()[-1])
        err, text = call("window", {"action": "click", "text": "Nope", "wait_s": 0.1})
        self.assertTrue(err)
        self.assertIn("TextNotFound", text)
        call("window", {"action": "click", "text": "Add a card", "wait_s": 0.1})
        self.assertIn("--nanoui-script=live:3;click:Vault;live:2;click:Add a card;live:2", self.runs()[-1])
        call("window", {"action": "click", "text": "Money", "wait_s": 0.1})
        self.assertIn("--nanoui-script=live:3;click:Vault;live:2;click:Add a card;live:2;click:Money;live:2", self.runs()[-1])

    def test_a_walk_through_the_sidebar_is_not_walked_again_for_each_picture(self):
        walk = ["click:Skip for now", "live:2", "click:Live", "live:2", "click:Browser", "live:2", "click:Vault", "live:2",
                "click:Add a card", "live:2", "click:Money", "live:2", "click:Node", "live:2"]
        self.assertEqual(qa_tools.replay(walk), ["click:Skip for now", "live:2", "click:Vault", "live:2", "click:Add a card",
                                                 "live:2", "click:Node", "live:2"])
        self.assertEqual(qa_tools.replay([]), [])

    def test_a_picture_after_some_seconds_is_drawn_that_long_after_the_call(self):
        call("window", {"action": "open", "wait_s": 0.2})
        for name in ("Live", "Browser", "Money", "Settings", "Node"):
            call("window", {"action": "click", "text": name, "wait_s": 0.1})
        err, text = call("window", {"action": "shot", "after_s": 12, "name": "ask"})
        self.assertFalse(err, text)
        deadline = time.time() + 5
        while time.time() < deadline and "window-ask" not in self.runs()[-1]:
            time.sleep(0.05)
        drawn = self.runs()[-1]
        self.assertIn("--nanoui-wait=0 ", drawn)
        self.assertTrue(drawn.endswith("--nanoui-script=live:3;live:9"), drawn)

    def test_a_step_that_changed_the_node_is_not_done_again(self):
        call("window", {"action": "open", "wait_s": 0.2})
        gone = TMP / "bin/gone"  # after the first click, the terms are gone from where the window opens
        gone.write_text("click:Open my node")
        self.addCleanup(gone.unlink, missing_ok=True)
        self.assertFalse(call("window", {"action": "click", "text": "Open my node", "wait_s": 0.1})[0])
        err, text = call("window", {"action": "click", "text": "Vault", "wait_s": 0.1})
        self.assertFalse(err, text)
        self.assertIn("earlier steps changed the node", text)
        self.assertTrue(self.runs()[-1].endswith("--nanoui-script=live:3;click:Vault;live:2"), self.runs()[-1])
        err, text = call("window", {"action": "click", "text": "Money", "wait_s": 0.1})
        self.assertIn("--nanoui-script=live:3;click:Money;live:2", self.runs()[-1])
        call("window", {"action": "click", "text": "Add a card", "wait_s": 0.1})
        gone.write_text("click:Money")  # a picture now: the steps so far no longer apply, so the window as it opens
        err, text = call("window", {"action": "shot", "wait_s": 0.1})
        self.assertFalse(err, text)
        self.assertTrue(self.runs()[-1].endswith("--nanoui-script=live:3;live:2"), self.runs()[-1])

    def test_only_keys_and_one_line_texts_are_taken(self):
        call("window", {"action": "open", "wait_s": 0.2})
        for args in ({"action": "key", "keys": "cmd+q"}, {"action": "key", "keys": "ctrl+1"}, {"action": "key", "keys": "q"},
                     {"action": "click", "text": "Vault;key:escape"}, {"action": "type", "text": "a\nb"}, {"action": "click"}):
            with self.subTest(args=args):
                err, text = call("window", args)
                self.assertTrue(err)
                self.assertTrue(text.startswith("refused"), text)
        self.assertFalse(call("window", {"action": "key", "keys": "escape", "wait_s": 0.1})[0])

    def test_nothing_reads_the_screen_or_presses_keys_in_other_apps(self):
        source = (Path(qa_tools.__file__)).read_text()
        for tool in ("screencapture", "osascript", "xdotool", "System Events", "import -window"):
            with self.subTest(tool=tool):
                self.assertNotIn(tool, source)

    def test_the_workflows_picture_the_window_as_it_draws_itself(self):
        # #784 rewrote qa.yml from a copy older than #782 and brought back the window step that read the screen
        # (QA_OWNERS_SCREEN, --picture <pid>): its MCP check failed on the Vault click of staging QA 44912147606.
        root = Path(qa_tools.__file__).resolve().parents[2] / ".github" / "workflows"
        for name in ("qa.yml", "pr-agent-checks.yml"):
            text = (root / name).read_text()
            with self.subTest(workflow=name):
                for tool in ("screencapture", "osascript", "QA_OWNERS_SCREEN"):
                    self.assertNotIn(tool, text)
                calls = re.findall(r"qa_tools\.py --picture (\S+)", text)
                self.assertGreaterEqual(len(calls), 3, calls)
                for target in calls:
                    self.assertTrue(target.strip('"').endswith(".png"), target)

    def test_close_stops_the_window(self):
        call("window", {"action": "open", "wait_s": 0.2})
        self.assertEqual(call("window", {"action": "close"}), (False, "the window is closed"))
        self.assertFalse(qa_tools.window_alive())


class ChildEnvTest(unittest.TestCase):
    def test_the_terminal_is_told_where_the_browser_is_and_nothing_else_leaks(self):
        # Check 23: a build unpacked on another runner finds its browser only by UNBROWSE_BROWSER.
        qa_tools.ENV["UNBROWSE_BROWSER"] = "/runner/agent-browser"
        qa_tools.ENV["GITHUB_TOKEN"] = "ghs_not_for_the_agent"
        try:
            env = qa_tools.child_env()
        finally:
            qa_tools.ENV.pop("UNBROWSE_BROWSER"); qa_tools.ENV.pop("GITHUB_TOKEN")
        self.assertEqual(env["UNBROWSE_BROWSER"], "/runner/agent-browser")
        self.assertNotIn("GITHUB_TOKEN", env)


if __name__ == "__main__":
    unittest.main()
