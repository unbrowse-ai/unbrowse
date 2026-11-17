"""claude-credential.sh names the first credential that answers, not the first that is set."""

import os
import pathlib
import stat
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "claude-credential.sh"

# A stand-in for the CLI: a token starting "good" answers, any other refuses the way a spent weekly limit does.
FAKE = """#!/bin/sh
echo "$CLAUDE_CODE_OAUTH_TOKEN" >> "@ASKED@"
env >> "@SEEN@"
case "$CLAUDE_CODE_OAUTH_TOKEN" in
  good*) echo '{"is_error":false,"result":"ok"}' ;;
  *) echo '{"is_error":true,"api_error_status":429,"result":"You have hit your weekly limit"}' ;;
esac
"""


class ClaudeCredential(unittest.TestCase):
    def pick(self, names, **tokens):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            fake = tmp / "claude"
            out, asked, seen = tmp / "out", tmp / "asked", tmp / "seen"
            fake.write_text(FAKE.replace("@ASKED@", str(asked)).replace("@SEEN@", str(seen)))
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            out.touch()
            asked.touch()
            seen.touch()
            env = {"PATH": os.environ["PATH"], "CLAUDE_BIN": str(fake), "GITHUB_OUTPUT": str(out), **tokens}
            run = subprocess.run(["sh", str(SCRIPT), *names], env=env, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.seen = seen.read_text()
            self.err = run.stderr
            return out.read_text().strip(), asked.read_text().split(), run.stdout

    def test_the_first_that_answers_is_named(self):
        named, asked, _ = self.pick(["A", "B"], A="good-a", B="good-b")
        self.assertEqual(named, "name=A")
        self.assertEqual(asked, ["good-a"])

    def test_a_set_credential_that_refuses_is_passed_over(self):
        named, _, log = self.pick(["A", "B"], A="spent", B="good-b")
        self.assertEqual(named, "name=B")
        self.assertIn("::warning::Claude credential A refuses: You have hit your weekly limit", log)

    def test_an_unset_credential_is_skipped_unasked(self):
        named, asked, _ = self.pick(["A", "B"], B="good-b")
        self.assertEqual(named, "name=B")
        self.assertEqual(asked, ["good-b"])

    def test_when_none_answers_the_first_set_is_named_and_said(self):
        named, _, log = self.pick(["A", "B"], A="spent", B="spent-too")
        self.assertEqual(named, "name=A")
        self.assertIn("No Claude credential answers", log)

    def test_nothing_set_names_nothing(self):
        named, asked, _ = self.pick(["A", "B"])
        self.assertEqual((named, asked), ("", []))

    def test_an_api_key_runs_instead_and_no_token_is_asked(self):
        named, asked, _ = self.pick(["A"], A="good-a", ANTHROPIC_API_KEY="key")
        self.assertEqual((named, asked), ("", []))

    def test_a_token_never_reaches_the_log(self):
        _, _, log = self.pick(["A", "B"], A="spent-secret", B="good-secret")
        self.assertNotIn("secret", log)
        self.assertNotIn("secret", self.err)

    def test_the_cli_is_given_the_one_token_it_is_asked_with_and_nothing_else(self):
        self.pick(["A", "B"], A="spent-first", B="good-second", OTHER="unrelated-step-secret")
        asks = self.seen.split("PATH=")[1:]
        self.assertEqual(len(asks), 2)
        self.assertIn("CLAUDE_CODE_OAUTH_TOKEN=spent-first", asks[0])
        self.assertNotIn("good-second", asks[0])
        self.assertIn("CLAUDE_CODE_OAUTH_TOKEN=good-second", asks[1])
        self.assertNotIn("spent-first", asks[1])
        self.assertNotIn("unrelated-step-secret", self.seen)
        self.assertNotRegex(self.seen, r"(?m)^(A|B)=")


if __name__ == "__main__":
    unittest.main()
