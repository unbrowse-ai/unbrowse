"""The order of a release's jobs (REL-02): a GitHub release says a version is out, so none is made before npm has the
release.

    python3 -m unittest discover -s .github/scripts/test -p 'test_*.py'
"""

import pathlib
import shlex
import subprocess
import tempfile
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
        self.assertIn("needs.npm.result == 'success'", self.jobs["release"]["if"])
        self.assertNotIn("release", needs(self.jobs, "npm"))

    def test_only_the_last_job_makes_a_github_release(self):
        making = [name for name, job in self.jobs.items() if any("gh release create" in s.get("run", "") for s in job.get("steps", []))]
        self.assertEqual(making, ["release"])

    def test_every_job_builds_the_version_npm_can_still_take(self):
        self.assertEqual(self.jobs["version"]["outputs"]["version"], "${{ steps.free.outputs.version }}")
        ids = [s.get("id") for s in self.jobs["version"]["steps"]]
        self.assertLess(ids.index("next"), ids.index("free"))

    def test_only_the_public_release_repository_can_publish(self):
        public = "github.repository == 'unbrowse-ai/unbrowse' && toJSON(github.event.repository.private) == 'false'"
        for job in ("npm", "npm-next"):
            with self.subTest(job=job):
                self.assertIn(public, self.jobs[job]["if"])
                self.assertEqual(self.jobs[job]["environment"], "release")
        publish = (RELEASE.parents[2] / ".github/scripts/npm-publish.sh").read_text()
        self.assertIn('--provenance', publish)

    def test_private_and_dry_run_artifacts_get_the_same_checks_as_public_packages(self):
        checks = self.jobs["verify-packages"]
        self.assertEqual(checks["needs"], self.jobs["npm"]["needs"])
        self.assertEqual(checks["permissions"], {"contents": "read"})
        self.assertNotIn("environment", checks)
        self.assertIn("github.repository != 'unbrowse-ai/unbrowse'", checks["if"])
        self.assertIn("inputs.dry_run == true", checks["if"])
        self.assertEqual(checks["steps"], self.jobs["npm"]["steps"][:-2])
        self.assertNotIn("npm-publish.sh", "\n".join(s.get("run", "") for s in checks["steps"]))

    def test_the_runbook_dispatches_publication_in_the_public_repository(self):
        operations = (RELEASE.parents[2] / "docs/OPERATIONS.md").read_text()
        self.assertIn("gh workflow run release.yml --repo unbrowse-ai/unbrowse --ref release/X.Y", operations)
        self.assertNotIn("gh workflow run release.yml --repo unbrowse-ai/unbrowse-core --ref release/X.Y", operations)
        variable_commands = [line for line in operations.splitlines() if line.startswith("gh variable ")]
        self.assertEqual(len(variable_commands), 3)
        for command in variable_commands:
            words = shlex.split(command)
            self.assertEqual(words[words.index("--repo") + 1], "unbrowse-ai/unbrowse")

    def test_public_ci_dispatches_from_the_checked_branch_and_commit(self):
        dispatch = self.jobs["hand-over"]
        self.assertEqual(dispatch["permissions"], {"actions": "write"})
        self.assertNotIn("environment", dispatch)
        self.assertIn("github.event.workflow_run.event == 'push'", dispatch["if"])
        self.assertIn("github.event.workflow_run.head_repository.full_name == github.repository", dispatch["if"])
        self.assertIn("github.event.workflow_run.conclusion == 'success'", dispatch["if"])
        self.assertIn("github.repository != 'unbrowse-ai/unbrowse'", self.jobs["version"]["if"])
        step, = dispatch["steps"]
        self.assertEqual(step["env"]["SOURCE_REF"], "${{ github.event.workflow_run.head_branch }}")
        self.assertEqual(step["env"]["SOURCE_SHA"], "${{ github.event.workflow_run.head_sha }}")
        with tempfile.TemporaryDirectory() as folder:
            gh = pathlib.Path(folder) / "gh"
            gh.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            gh.chmod(0o700)
            commit = "a" * 40
            run = subprocess.run(["/bin/bash", "-e", "-c", step["run"]], text=True, capture_output=True, env={
                "PATH": folder + ":/usr/bin:/bin", "GITHUB_REPOSITORY": "unbrowse-ai/unbrowse",
                "SOURCE_REF": "staging", "SOURCE_SHA": commit,
            }, check=True)
        self.assertEqual(run.stdout.splitlines(), ["workflow", "run", "release.yml", "--repo", "unbrowse-ai/unbrowse",
                                                  "--ref", "staging", "-f", f"sha={commit}"])

    def test_release_refuses_to_attest_a_different_commit(self):
        steps = self.jobs["version"]["steps"]
        step = steps[0]
        self.assertEqual(step["name"], "The checked commit is still the branch tip")
        self.assertEqual(step["if"], "inputs.sha != ''")
        self.assertEqual(step["env"]["WANT"], "${{ inputs.sha }}")
        self.assertEqual(steps[1]["with"]["ref"], "${{ github.event.workflow_run.head_sha || github.sha }}")
        approved = "a" * 40
        for branch_tip, code in ((approved, 0), ("b" * 40, 1)):
            with self.subTest(branch_tip=branch_tip):
                result = subprocess.run(["/bin/bash", "-e", "-c", step["run"]], text=True, capture_output=True,
                                        env={"PATH": "/usr/bin:/bin", "GITHUB_SHA": branch_tip, "WANT": approved})
                self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        self.assertIn("branch moved after CI", result.stdout)

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
        self.assertIn('verify-files dist --expected "$FILES" --expected "$PROGRAMS" --expected "$INSTALLERS"', release)
        env = next(s["env"] for s in self.jobs["release"]["steps"] if "verify-files" in s.get("run", ""))
        self.assertEqual(env["PROGRAMS"], "${{ needs.platforms.outputs.programs }}")
        self.assertEqual(env["FILES"], "${{ needs.sdks.outputs.files }}")
        self.assertEqual(env["INSTALLERS"], "${{ needs.installers.outputs.installers }}")
        npm = checks("npm")
        self.assertIn('verify-files dist --expected "$FILES"', npm)
        self.assertIn('verify-files updates --expected "$UPDATES"', npm)
        env = next(s["env"] for s in self.jobs["npm"]["steps"] if "verify-files" in s.get("run", ""))
        self.assertEqual(env["UPDATES"], "${{ needs.pack-updates.outputs.updates }}")

    def test_one_release_carries_every_installer_and_waits_for_its_device_test(self):
        # One release is the whole download page (Lewis, 2026-11-23: two families of releases, an installer one and a
        # disk image one, and a site that pointed at an old one). The Windows setup and the Linux packages are packed
        # into the release beside the Mac disk image, from the archives the machines made, and npm publishes nothing
        # before all three installed on a fresh machine of their kind.
        installers = self.jobs["installers"]
        self.assertIn("platforms", needs(self.jobs, "installers"))
        packs = "\n".join(s.get("run", "") for s in installers["steps"])
        self.assertIn("package-windows-installer.sh", packs)
        self.assertIn("package-linux-deb.sh", packs)
        self.assertIn("record-files installers --key installers", next(s for s in installers["steps"] if s.get("id") == "files")["run"])
        self.assertEqual(self.jobs["installer-device-test"]["uses"], "./.github/workflows/installers-device-test.yml")
        self.assertIn("installers", needs(self.jobs, "installer-device-test"))
        for job in ("npm", "release"):
            self.assertIn("installer-device-test", needs(self.jobs, job), f"{job} publishes before the installers installed")
        self.assertIn("installers", needs(self.jobs, "release"))

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
