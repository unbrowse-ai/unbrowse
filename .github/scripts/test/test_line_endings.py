"""Every tracked text file checks out with LF line endings, on Windows too (Windows 11, 22 Nov 2026, staging c772f210:
a checkout with core.autocrlf turned the agent API manifest, a shared route and the update manifests to CRLF, and eight
tests that compare those files byte for byte failed there). Vendored third-party trees keep their own bytes."""
import pathlib
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
VENDORED = ("unbrowse-settlement/lib/",)


class LineEndings(unittest.TestCase):
    def test_every_text_file_checks_out_with_lf(self):
        files = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout.split(b"\0")
        ours = [f for f in files if f and not f.decode().startswith(VENDORED)]
        said = subprocess.run(["git", "check-attr", "-z", "eol", "--stdin"], cwd=ROOT, input=b"\0".join(ours) + b"\0", capture_output=True, check=True).stdout.split(b"\0")
        eol = {said[i].decode(): said[i + 2].decode() for i in range(0, len(said) - 2, 3)}
        self.assertEqual(len(eol), len(ours))
        not_lf = sorted(f for f, v in eol.items() if v != "lf")
        self.assertEqual(not_lf[:10], [], f"{len(not_lf)} files check out with the machine's line endings")

    def test_the_files_the_windows_failures_compared_are_held_to_lf(self):
        for f in ("unbrowse-node/agent-api.json", ".github/scripts/updates.mjs"):
            out = subprocess.run(["git", "check-attr", "eol", "--", f], cwd=ROOT, capture_output=True, text=True, check=True).stdout
            self.assertTrue(out.strip().endswith("eol: lf"), out)


if __name__ == "__main__":
    unittest.main()
