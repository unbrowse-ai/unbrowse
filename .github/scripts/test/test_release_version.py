"""The version a release gets from the ref it was made for (release-version.sh): staging and release/X.Y make
prereleases of their own, and only a tag on main whose tree is its release branch's ships.

    python3 -m unittest discover -s .github/scripts/test -p 'test_*.py'
"""

import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent.parent / "release-version.sh"


class ReleaseVersion(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        env = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        self.env = {**os.environ, **env}
        self.git("init", "-q", "-b", "staging")
        self.commit("first")
        self.git("tag", "v13.18.1")

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.dir, env=self.env, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, name):
        pathlib.Path(self.dir, name).write_text(name)
        self.git("add", name)
        self.git("commit", "-q", "-m", name)
        return self.git("rev-parse", "HEAD")

    def remote(self, branch, rev="HEAD"):
        self.git("update-ref", f"refs/remotes/origin/{branch}", rev)

    def version(self, ref, run="7"):
        r = subprocess.run(["sh", str(SCRIPT), ref, run], cwd=self.dir, env=self.env, capture_output=True, text=True)
        return r.returncode, r.stdout.strip(), r.stderr

    def test_staging_is_one_minor_above_the_newest_release(self):
        self.assertEqual(self.version("refs/heads/staging"), (0, "13.19.0-staging.7", ""))
        self.remote("release/13.19")
        self.assertEqual(self.version("refs/heads/staging")[1], "13.20.0-staging.7")

    def test_a_release_branch_counts_its_patches_from_its_tags(self):
        self.remote("release/13.19")
        self.assertEqual(self.version("refs/heads/release/13.19")[1], "13.19.0-rc.7")
        self.git("tag", "v13.19.0")
        self.git("tag", "v13.19.1")
        self.git("tag", "v13.1.9")
        self.assertEqual(self.version("refs/heads/release/13.19")[1], "13.19.2-rc.7")

    def test_a_tag_ships_only_from_main_with_the_release_branchs_tree(self):
        self.remote("release/13.19")
        self.remote("main")
        self.assertEqual(self.version("refs/tags/v13.19.0"), (0, "13.19.0", ""))
        # The release branch moved on: main doesn't match what it tested.
        self.commit("fix")
        self.remote("release/13.19")
        self.git("checkout", "-q", "HEAD~1")
        code, _, err = self.version("refs/tags/v13.19.0")
        self.assertEqual(code, 1)
        self.assertIn("tree", err)

    def test_a_tag_off_main_or_without_its_branch_is_refused(self):
        self.remote("main")
        self.assertIn("no release/13.19", self.version("refs/tags/v13.19.0")[2])
        self.remote("release/13.19")
        self.commit("elsewhere")
        self.remote("release/13.19")
        self.assertIn("isn't on main", self.version("refs/tags/v13.19.0")[2])

    def test_no_other_ref_releases(self):
        for ref in ("refs/heads/main", "refs/heads/feat/x", "refs/heads/release/13", "refs/tags/v13.19.0-rc.1", "refs/tags/x"):
            self.assertEqual(self.version(ref)[0], 1, ref)
        self.assertEqual(self.version("refs/heads/staging", run="x")[0], 2)


if __name__ == "__main__":
    unittest.main()
