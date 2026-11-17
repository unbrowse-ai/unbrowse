"""The order of a release's jobs (REL-02): a GitHub release says a version is out, so none is made before npm has the
release.

    python3 -m unittest discover -s .github/scripts/test -p 'test_*.py'
"""

import pathlib
import unittest

import yaml

RELEASE = pathlib.Path(__file__).resolve().parent.parent.parent / "workflows" / "release.yml"


def needs(jobs: dict, name: str) -> set[str]:
    """Every job `name` waits for, directly or through another."""
    direct = jobs[name].get("needs", [])
    direct = [direct] if isinstance(direct, str) else direct
    return set(direct).union(*(needs(jobs, n) for n in direct)) if direct else set()


class ReleaseOrder(unittest.TestCase):
    def setUp(self):
        self.jobs = yaml.safe_load(RELEASE.read_text())["jobs"]

    def test_no_github_release_before_npm_has_the_release(self):
        self.assertIn("npm", needs(self.jobs, "release"))
        self.assertNotIn("release", needs(self.jobs, "npm"))

    def test_only_the_last_job_makes_a_github_release(self):
        making = [name for name, job in self.jobs.items() if any("gh release create" in s.get("run", "") for s in job.get("steps", []))]
        self.assertEqual(making, ["release"])

    def test_every_job_builds_the_version_npm_can_still_take(self):
        self.assertEqual(self.jobs["version"]["outputs"]["version"], "${{ steps.free.outputs.version }}")
        ids = [s.get("id") for s in self.jobs["version"]["steps"]]
        self.assertLess(ids.index("next"), ids.index("free"))

    def test_every_published_file_is_checked_against_the_job_that_made_it(self):
        # The program archives and browser programs are recorded by `platforms`, which runs nothing from a package
        # registry and finishes before `sdks` runs third-party build code; every file `sdks` hands on is recorded there.
        platforms = self.jobs["platforms"]
        self.assertNotIn("sdks", needs(self.jobs, "platforms"))
        record = next(s for s in platforms["steps"] if s.get("id") == "programs")
        self.assertIn("record-files programs browser --key programs", record["run"])
        downloads = [s["with"].get("pattern") for s in platforms["steps"] if str(s.get("uses", "")).startswith("actions/download-artifact@")]
        self.assertEqual(downloads, ["programs-*", "browser-*"])
        self.assertIn("record-files dist --key files", next(s for s in self.jobs["sdks"]["steps"] if s.get("id") == "hashes")["run"])
        self.assertIn("record-files updates --key updates", next(s for s in self.jobs["pack-updates"]["steps"] if s.get("id") == "updates")["run"])

        def checks(job):
            steps = self.jobs[job]["steps"]
            publish = next(i for i, s in enumerate(steps) if "gh release create" in s.get("run", "") or "npm-publish.sh" in s.get("run", ""))
            return "\n".join(s.get("run", "") for s in steps[:publish])

        release = checks("release")
        self.assertIn('verify-files dist --expected "$FILES" --expected "$PROGRAMS"', release)
        env = next(s["env"] for s in self.jobs["release"]["steps"] if "verify-files" in s.get("run", ""))
        self.assertEqual(env["PROGRAMS"], "${{ needs.platforms.outputs.programs }}")
        self.assertEqual(env["FILES"], "${{ needs.sdks.outputs.files }}")
        npm = checks("npm")
        self.assertIn('verify-files dist --expected "$FILES"', npm)
        self.assertIn('verify-files updates --expected "$UPDATES"', npm)
        env = next(s["env"] for s in self.jobs["npm"]["steps"] if "verify-files" in s.get("run", ""))
        self.assertEqual(env["UPDATES"], "${{ needs.pack-updates.outputs.updates }}")

    def test_the_python_build_tools_install_only_from_hashes(self):
        # The wheels and sdist are built by `build` and the project's backend: installed from pinned hashes, with no
        # dependency resolved at install time and no isolated environment fetching a backend of its own.
        import re

        root = RELEASE.parents[2]
        pack = (root / ".github/scripts/pack-sdks.sh").read_text()
        installs = re.findall(r"(?m)^.*\bpip3?\s+install\b.*$", pack)
        self.assertEqual(len(installs), 1, installs)
        self.assertIn("--require-hashes", installs[0])
        self.assertIn("--no-deps", installs[0])
        self.assertIn(".github/scripts/requirements-release.txt", installs[0])
        builds = re.findall(r"python3 -m build\b.*", pack)
        self.assertTrue(builds and all("--no-isolation" in b for b in builds), builds)

        pinned = {}
        for entry in re.split(r"\n(?=\S)", (root / ".github/scripts/requirements-release.txt").read_text().strip()):
            if not entry.strip():
                continue
            name = re.match(r"([A-Za-z0-9_.-]+)==\S+", entry)
            self.assertIsNotNone(name, f"not pinned to one version: {entry}")
            self.assertRegex(entry, r"--hash=sha256:[0-9a-f]{64}", entry)
            pinned[name.group(1).lower().replace("_", "-")] = entry
        build_system = (root / "unbrowse-sdk/python/pyproject.toml").read_text().split("[build-system]", 1)[1].split("\n[", 1)[0]
        backend = re.findall(r'"([^"]+)"', re.search(r"(?m)^requires\s*=\s*\[(.*?)\]", build_system, re.S).group(1))
        self.assertTrue(backend)
        for requirement in [*backend, "build"]:
            self.assertIn(re.match(r"[A-Za-z0-9_.-]+", requirement).group(0).lower(), pinned)
        for step in self.jobs["sdks"]["steps"]:
            self.assertNotRegex(str(step.get("run", "")), r"\bpip3?\s+install\b", "the sdks job installs Python tools only through pack-sdks.sh")


if __name__ == "__main__":
    unittest.main()
