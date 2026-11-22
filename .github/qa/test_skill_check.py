"""skill_check.py passes a sound skill and fails each fault it is there to catch."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from skill_check import main  # noqa: E402

GOOD = "---\nname: s\ndescription: Use websites through the node; say what you want with unbrowse_do and a url.\n---\n\nSee [the map](references/map.md) and `scripts/run`. Call unbrowse_do.\n"


class SkillCheckTest(unittest.TestCase):
    def run_on(self, text, tools=("unbrowse_do",)):
        tmp = Path(tempfile.mkdtemp())
        skill = tmp / "skills/s"
        (skill / "references").mkdir(parents=True)
        (skill / "scripts").mkdir()
        (skill / "references/map.md").write_text("")
        (skill / "scripts/run").write_text("")
        (skill / "SKILL.md").write_text(text)
        (tmp / "tools.json").write_text(json.dumps([{"name": t} for t in tools]))
        return main(["--skills", str(tmp / "skills"), "--tools", str(tmp / "tools.json"), "--out", str(tmp / "out")])

    def test_a_sound_skill_passes(self):
        self.assertEqual(self.run_on(GOOD), 0)

    def test_a_tool_the_node_no_longer_lists_fails(self):
        self.assertEqual(self.run_on(GOOD, tools=("unbrowse_walk",)), 1)

    def test_a_missing_file_fails(self):
        self.assertEqual(self.run_on(GOOD.replace("references/map.md", "references/gone.md")), 1)

    def test_a_name_unlike_the_folder_fails(self):
        self.assertEqual(self.run_on(GOOD.replace("name: s", "name: other")), 1)

    def test_a_description_too_short_to_choose_by_fails(self):
        self.assertEqual(self.run_on(GOOD.replace("Use websites through the node; say what you want with unbrowse_do and a url.", "Web.")), 1)


if __name__ == "__main__":
    unittest.main()
