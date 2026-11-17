"""SDK polish (Argus M29): the model that drafts the change never holds a write token, and the job that holds one takes
the draft's files as data, from the paths a draft may change only.

    python3 -m unittest discover -s .github/scripts/test -p 'test_*.py'
"""

import importlib.util
import os
from pathlib import Path
import re
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = ROOT / ".github/workflows/sdk-polish.yml"
spec = importlib.util.spec_from_file_location("sdk_polish_take", ROOT / ".github/scripts/sdk-polish-take.py")
take = importlib.util.module_from_spec(spec)
spec.loader.exec_module(take)


def writes(job: dict) -> bool:
    permissions = job.get("permissions") or {}
    return permissions == "write-all" or any(str(v).lower() == "write" for v in permissions.values())


class SdkPolish(unittest.TestCase):
    def test_the_model_never_runs_where_a_write_token_is(self):
        jobs = yaml.safe_load(WORKFLOW.read_text())["jobs"]
        model_jobs = []
        for name, job in jobs.items():
            text = yaml.safe_dump(job)
            has_model = "anthropics/claude-code-action@" in text or re.search(r"secrets\.\w*(?:CLAUDE|ANTHROPIC)", text, re.I)
            if has_model:
                model_jobs.append(name)
                self.assertFalse(writes(job), f"{name}: the model's job can write")
                self.assertNotIn("id-token", job.get("permissions") or {}, f"{name}: the model's job can mint a token")
                action = next(s for s in job["steps"] if str(s.get("uses", "")).startswith("anthropics/claude-code-action@"))
                self.assertEqual(action["with"].get("github_token"), "${{ github.token }}", f"{name}: the action uses the job's read-only token")
                tools = re.search(r'--allowedTools "([^"]*)"', action["with"]["claude_args"]).group(1).split(",")
                self.assertEqual(sorted(tools), ["Edit", "Glob", "Grep", "Read", "Write"], f"{name}: the model has file tools only")
                after = job["steps"][job["steps"].index(action) + 1 :]
                self.assertIn("rm -rf .git", after[0].get("run", ""), f"{name}: nothing runs git in the tree the model wrote")
                self.assertTrue(all("git " not in str(s.get("run", "")) for s in after[1:]), name)
            elif writes(job) and name != "hand-over":
                self.assertNotRegex(text, r"secrets\.", f"{name}: the writing job holds a secret")
                for step in job["steps"]:
                    uses = str(step.get("uses", ""))
                    if uses:
                        self.assertTrue(uses.startswith(("actions/checkout@", "actions/setup-python@", "actions/download-artifact@")), f"{name}: {uses}")
                runs = "\n".join(str(s.get("run", "")) for s in job["steps"])
                self.assertIn("python3 -I .github/scripts/sdk-polish-take.py", runs)
                # Every program it runs is the checkout's own, never one under a path the draft may change.
                for program in re.findall(r"python3?\s+(?:-I\s+)?(\S+)", runs):
                    self.assertFalse(take.allowed(take.PurePosixPath(program)), f"{name} runs {program}, which a draft may change")
                self.assertNotIn("draft/", runs.replace('"$RUNNER_TEMP/draft"', ""), f"{name} runs something from the draft")
        self.assertEqual(model_jobs, ["polish"])
        self.assertEqual(jobs["propose"]["needs"], "polish")

    def test_a_draft_reaches_only_the_paths_it_may_change(self):
        with tempfile.TemporaryDirectory() as temp:
            draft, checkout = Path(temp) / "draft", Path(temp) / "checkout"
            files = {
                "sdk-polish-pr.md": "Adds unbrowse_judge to both clients.",
                "unbrowse-sdk/typescript/src/client.ts": "export const judge = 1;",
                "skills/unbrowse/SKILL.md": "# skill",
                "integrations/hermes/tools.py": "TOOL_NAMES = []",
                # A draft may not change what the writing job runs, or the workflows.
                "unbrowse-sdk/codegen/generate.py": "import os; os.system('push to staging')",
                ".github/workflows/sdk-polish.yml": "on: push",
                ".github/scripts/sdk-polish-take.py": "raise SystemExit",
                "integrations/sync-skills.py": "evil",
                "unbrowse-sdk/typescript/package.json": '{"scripts": {"prepare": "evil"}}',
            }
            for name, text in files.items():
                (draft / name).parent.mkdir(parents=True, exist_ok=True)
                (draft / name).write_text(text)
            checkout.mkdir()
            taken = take.take(draft, checkout)
            self.assertEqual(sorted(taken), ["integrations/hermes/tools.py", "skills/unbrowse/SKILL.md", "unbrowse-sdk/typescript/src/client.ts"])
            for name in ("unbrowse-sdk/codegen/generate.py", ".github/workflows/sdk-polish.yml", ".github/scripts/sdk-polish-take.py", "integrations/sync-skills.py", "unbrowse-sdk/typescript/package.json", "sdk-polish-pr.md"):
                self.assertFalse((checkout / name).exists(), name)

            # A link in the draft, or a folder of the checkout that is a link, carries nothing anywhere.
            os.symlink("/etc/passwd", draft / "skills/unbrowse/link.md")
            with self.assertRaisesRegex(ValueError, "is a link"):
                take.take(draft, checkout)
            os.unlink(draft / "skills/unbrowse/link.md")
            outside = Path(temp) / "outside"
            outside.mkdir()
            (checkout / "skills/unbrowse/SKILL.md").unlink()
            (checkout / "skills/unbrowse").rmdir()
            os.symlink(outside, checkout / "skills/unbrowse")
            with self.assertRaisesRegex(ValueError, "link in the checkout"):
                take.take(draft, checkout)
            self.assertEqual(list(outside.iterdir()), [])

    def test_paths_that_climb_out_are_not_allowed(self):
        for path in ("skills/unbrowse/../../.github/workflows/x.yml", "/skills/unbrowse/a", "skills/unbrowsex/a", "skills/unbrowse"):
            self.assertFalse(take.allowed(take.PurePosixPath(path)), path)


if __name__ == "__main__":
    unittest.main()
