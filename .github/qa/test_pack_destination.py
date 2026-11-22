"""Claude QA packs the npm package into a folder that exists (UNB-235).

`npm pack --pack-destination DIR` does not make DIR: it fails with ENOENT, exit 254, and Claude QA stopped at
"Pack the npm package" before the node started (staging run 44864979035). Every pack into a runner folder in the
QA workflows must come after the `mkdir -p` that makes that folder, in the same step.
"""
import re
import unittest
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parents[1] / "workflows"
PACK = re.compile(r'--pack-destination "([^"]+)"')


def unmade_destinations(text):
    """[(line number, destination)] for each pack whose folder no earlier `mkdir -p` in its step made."""
    problems, step = [], []
    for number, line in enumerate(text.splitlines(), 1):
        if re.match(r"^\s*- (name|uses|run):", line):
            step = []
        for destination in PACK.findall(line):
            made = any(re.search(r'mkdir -p "' + re.escape(destination) + r'(/|")', earlier) for earlier in step)
            if not made:
                problems.append((number, destination))
        step.append(line)
    return problems


class PackDestination(unittest.TestCase):
    def test_qa_workflows_make_the_folder_before_packing(self):
        for name in ("qa.yml", "pr-agent-checks.yml"):
            with self.subTest(workflow=name):
                self.assertEqual(unmade_destinations((WORKFLOWS / name).read_text()), [])

    def test_a_pack_before_its_mkdir_is_caught(self):
        step = (
            "      - name: Pack\n"
            "        run: |\n"
            '          npm pack --pack-destination "$RUNNER_TEMP/npm"\n'
            '          mkdir -p "$RUNNER_TEMP/npm/global"\n'
        )
        self.assertEqual(unmade_destinations(step), [(3, "$RUNNER_TEMP/npm")])

    def test_a_mkdir_in_another_step_does_not_count(self):
        steps = (
            "      - name: Make\n"
            '        run: mkdir -p "$RUNNER_TEMP/npm"\n'
            "      - name: Pack\n"
            '        run: npm pack --pack-destination "$RUNNER_TEMP/npm"\n'
        )
        self.assertEqual(unmade_destinations(steps), [(4, "$RUNNER_TEMP/npm")])


if __name__ == "__main__":
    unittest.main()
