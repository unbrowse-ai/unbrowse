"""The pull-request slice exercises the phases Lewis asked for."""

import json
from pathlib import Path
import unittest
from urllib.parse import parse_qs, urlsplit


HERE = Path(__file__).resolve().parent


class SliceManifest(unittest.TestCase):
    def test_the_slice_selects_twenty_tasks_across_all_three_phases(self):
        manifest = json.loads((HERE / "slice.json").read_text())
        bank = json.loads((HERE / "bank.json").read_text())
        tasks = {task["id"]: task for task in bank["tasks"]}
        ids = set(manifest["ids"])
        self.assertEqual(len(manifest["ids"]), 20)
        self.assertEqual(len(ids), 20)
        self.assertEqual(ids, set(manifest["reference"]["verdicts"]))

        selected = [tasks[task_id] for task_id in manifest["ids"]]
        self.assertEqual({task.get("phase", "cold") for task in selected}, {"cold", "warm", "authed"})
        for suffix in ("", "#warm", "#none"):
            listing = tasks["criteria:carousell.sg" + suffix]
            self.assertEqual(parse_qs(urlsplit(listing["url"]).query).get("tab"), ["marketplace"])
        for task in selected:
            with self.subTest(task=task["id"]):
                self.assertNotIn("known", task)
                if task.get("phase") == "warm":
                    self.assertIn(task["after"], ids)
                    self.assertEqual(tasks[task["after"]].get("phase", "cold"), "cold")
