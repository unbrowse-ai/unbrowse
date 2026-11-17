import copy
import json
import unittest
from pathlib import Path

from validate import validate

HERE = Path(__file__).resolve().parent


class SafetyValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sites = json.loads((HERE / "sites.json").read_text())
        cls.scenarios = json.loads((HERE / "scenarios.json").read_text())

    def test_current_bank_valid(self):
        errors, _ = validate(self.sites, self.scenarios)
        self.assertEqual(errors, [])

    def test_action_cannot_lose_opt_in(self):
        scenarios = copy.deepcopy(self.scenarios)
        next(s for s in scenarios["scenarios"] if s["id"] == "action.checkout")["opt_in"] = False
        errors, _ = validate(self.sites, scenarios)
        self.assertTrue(any("opt-in" in e for e in errors))

    def test_action_cannot_lose_approval_input(self):
        scenarios = copy.deepcopy(self.scenarios)
        checkout = next(s for s in scenarios["scenarios"] if s["id"] == "action.checkout")
        checkout["requires"].remove("approved_action")
        errors, _ = validate(self.sites, scenarios)
        self.assertTrue(any("authorization inputs" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
