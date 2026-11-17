import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / "check-pinned-actions.py"
spec = importlib.util.spec_from_file_location("check_pinned_actions", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PinnedActionsTest(unittest.TestCase):
    def test_composite_action_files_are_checked(self):
        fixture = SCRIPT.parent / "test/fixtures/composite-action/action.yml"
        self.assertIn(fixture, module.action_files())
        self.assertFalse(any("unbrowse-settlement/lib/openzeppelin-contracts" in str(path) for path in module.action_files()))
        self.assertEqual(module.check(fixture), [])

    def test_a_pinned_sha_must_exist_upstream(self):
        from unittest.mock import patch

        fixture = SCRIPT.parent / "test/fixtures/composite-action/action.yml"
        with patch.object(module, "upstream_has_commit", return_value=(False, "missing upstream commit")):
            self.assertIn("does not resolve upstream", module.check_upstream(fixture)[0])

    def test_an_impostor_sha_from_a_fork_is_refused(self):
        from unittest.mock import patch

        fixture = SCRIPT.parent / "test/fixtures/composite-action/action.yml"
        with patch.object(module, "upstream_has_commit", return_value=(False, "SHA is not reachable from an upstream branch or tag")):
            self.assertIn("not reachable from an upstream branch or tag", module.check_upstream(fixture)[0])

    def test_full_sha_and_local_path_are_accepted(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "workflow.yml"
            path.write_text(
                "steps:\n"
                "  - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v4.0.0\n"
                "  - uses: ./.github/actions/local\n"
            )
            self.assertEqual(module.check(path), [])

    def test_mutable_tag_and_short_sha_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "workflow.yml"
            path.write_text(
                "steps:\n"
                "  - uses: actions/checkout@v4\n"
                "  - uses: owner/action@0123456789abcdef\n"
                "  - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567\n"
            )
            self.assertEqual(len(module.check(path)), 3)

    def test_every_repository_workflow_is_pinned(self):
        errors = [
            error
            for directory in module.WORKFLOW_DIRS
            for path in sorted(directory.glob("*.y*ml"))
            for error in module.check(path)
        ]
        self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
