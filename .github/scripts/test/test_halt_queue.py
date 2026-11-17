"""A halt is the brake, so it doesn't queue behind routine traffic (REL-04): every other change to the update metadata
still runs one at a time with the release.

    python3 -m unittest discover -s .github/scripts/test -p 'test_*.py'
"""

import pathlib
import re
import unittest

import yaml

WORKFLOWS = pathlib.Path(__file__).resolve().parent.parent.parent / "workflows"


def group(file: str, action: str = "") -> str:
    """The concurrency group of `file` for a run of `action`, reading the one expression the workflows use."""
    value = yaml.safe_load((WORKFLOWS / file).read_text())["concurrency"]["group"]
    choice = re.fullmatch(r"\$\{\{ inputs\.action == '(\w+)' && '([\w-]+)' \|\| '([\w-]+)' \}\}", value)
    if not choice:
        return value
    return choice[2] if action == choice[1] else choice[3]


class HaltQueue(unittest.TestCase):
    def test_a_halt_never_shares_a_queue_with_a_release(self):
        self.assertNotEqual(group("updates.yml", "halt"), group("release.yml"))

    def test_every_other_metadata_change_still_queues_with_the_release(self):
        for action in ("", "refresh", "promote", "share", "resume"):
            self.assertEqual(group("updates.yml", action), group("release.yml"), action)

    def test_a_running_halt_is_never_cancelled(self):
        self.assertIs(yaml.safe_load((WORKFLOWS / "updates.yml").read_text())["concurrency"]["cancel-in-progress"], False)


if __name__ == "__main__":
    unittest.main()
