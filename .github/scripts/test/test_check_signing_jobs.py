"""check_signing_jobs.py against the workflows as they are, and as they were before the external security review round 3,
2026-11-04, when the release key sat in a job that ran `npm ci` and `pip install` beside it.

    python3 -m unittest discover -s .github/scripts/test -p 'test_*.py'
"""

import pathlib
import shutil
import tempfile
import unittest

import check_signing_jobs

HERE = pathlib.Path(__file__).resolve().parent
WORKFLOWS = HERE.parent.parent / "workflows"


class SigningJobs(unittest.TestCase):
    def test_the_workflows_keep_the_keys_in_jobs_of_their_own(self):
        self.assertEqual(check_signing_jobs.problems(WORKFLOWS), [])

    def test_a_key_beside_an_install_or_in_another_workflow_is_caught(self):
        folder = pathlib.Path(tempfile.mkdtemp(prefix="signing-jobs-"))
        shutil.copy(HERE / "fixtures" / "release-before-round-3.yml", folder / "release.yml")
        shutil.copy(HERE / "fixtures" / "updates-before-round-3.yml", folder / "updates.yml")
        (folder / "other.yml").write_text(
            "on: push\njobs:\n  leak:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ${{ secrets.UNBROWSE_RELEASE_KEY }}\n"
        )
        found = "\n".join(check_signing_jobs.problems(folder))
        self.assertIn("release.yml: job sdks uses actions/setup-node", found)
        self.assertIn("release.yml: job sdks runs .github/scripts/pack-sdks.sh", found)
        self.assertIn("updates.yml: job updates installs something", found)
        self.assertIn("other.yml: job leak names a signing key", found)
        self.assertIn("other.yml: job leak reads a signing key outside the release environment", found)

    def test_a_key_handed_over_without_its_name_or_outside_a_step_is_caught(self):
        folder = pathlib.Path(tempfile.mkdtemp(prefix="signing-jobs-"))
        shutil.copy(WORKFLOWS / "release.yml", folder / "release.yml")
        cases = {
            "wide.yml": "on: push\nenv:\n  K: ${{ secrets.UNBROWSE_RELEASE_KEY }}\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: pip install x\n",
            "other.yaml": "on: push\njobs:\n  leak:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ${{ secrets.UNBROWSE_TARGETS_KEY }}\n",
            "all.yml": "on: push\njobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: npx evil\n        env:\n          S: ${{ toJSON(secrets) }}\n",
            "called.yml": "on: push\njobs:\n  a:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit\n",
        }
        for name, text in cases.items():
            (folder / name).write_text(text)
        found = "\n".join(check_signing_jobs.problems(folder))
        self.assertIn("wide.yml names a signing key in the workflow's env", found)
        self.assertIn("other.yaml: job leak names a signing key", found)
        self.assertIn("all.yml hands a job every secret", found)
        self.assertIn("called.yml hands a job every secret", found)

    def test_a_key_in_another_case_or_a_mac_signing_secret_is_held_to_the_same_rules(self):
        # GitHub reads secret names case-insensitively, and the Developer ID certificate signs what Macs run.
        folder = pathlib.Path(tempfile.mkdtemp(prefix="signing-jobs-"))
        shutil.copy(WORKFLOWS / "release.yml", folder / "release.yml")
        cases = {
            "lower.yml": "on: push\njobs:\n  leak:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo ${{ secrets.unbrowse_release_key }}\n",
            "mixed.yml": "on: push\njobs:\n  leak:\n    runs-on: ubuntu-24.04\n    environment: release\n    steps:\n      - run: npm ci\n        env:\n          K: ${{ secrets.Unbrowse_Targets_Key }}\n",
            "mac.yml": "on: push\njobs:\n  leak:\n    runs-on: macos-15\n    steps:\n      - run: echo ${{ secrets.macos_certificate }}\n",
        }
        for name, text in cases.items():
            (folder / name).write_text(text)
        # The Mac secrets back in the job that compiles, as before the build and the signing were split.
        release = (folder / "release.yml").read_text()
        built = release.replace(
            "      - name: Build the browser\n",
            "      - name: Build the browser\n        env:\n          P12: ${{ secrets.MACOS_CERTIFICATE }}\n",
            1,
        )
        # A secret under a new name in a release job, read outside the release environment.
        renamed = built.replace("    environment: release\n    steps:\n", "    steps:\n", 1).replace(
            "secrets.APPLE_APP_PASSWORD", "secrets.notary_login", 1
        )
        self.assertNotEqual(renamed, release)
        (folder / "release.yml").write_text(renamed)
        found = "\n".join(check_signing_jobs.problems(folder))
        self.assertIn("lower.yml: job leak names a signing key", found)
        self.assertIn("mixed.yml: job leak installs something beside a signing key", found)
        self.assertIn("mac.yml: job leak names a signing key", found)
        self.assertIn("mac.yml: job leak reads a signing key outside the release environment", found)
        self.assertIn("release.yml: job programs builds beside a signing key: cargo build", found)
        self.assertIn("release.yml: job programs reads a signing key outside the release environment", found)
        self.assertIn("release.yml: job mac-sign reads a signing key outside the release environment", found)

    def test_an_oidc_publish_job_without_a_ref_check_is_refused(self):
        # A job that can mint an OIDC token publishes as this workflow: it is held to the signing jobs' ref check
        # (an `if` naming the ref, or the version job's verdict on it), whether it asks for the token itself or
        # inherits it from the workflow's permissions.
        folder = pathlib.Path(tempfile.mkdtemp(prefix="signing-jobs-"))
        shutil.copy(WORKFLOWS / "release.yml", folder / "release.yml")
        cases = {
            "own.yml": "on: workflow_dispatch\npermissions: {}\njobs:\n  publish:\n    runs-on: ubuntu-24.04\n    environment: release\n    permissions:\n      id-token: write\n    steps:\n      - run: echo hi\n",
            "inherited.yml": "on: workflow_dispatch\npermissions:\n  id-token: write\njobs:\n  publish:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n",
            "everything.yml": "on: workflow_dispatch\npermissions: write-all\njobs:\n  publish:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n",
            "unrelated-if.yml": "on: workflow_dispatch\njobs:\n  publish:\n    if: inputs.go == true\n    runs-on: ubuntu-24.04\n    permissions:\n      id-token: write\n    steps:\n      - run: echo hi\n",
        }
        for name, text in cases.items():
            (folder / name).write_text(text)
        found = "\n".join(check_signing_jobs.problems(folder))
        for name in cases:
            self.assertIn(f"{name}: job publish can publish by OIDC with no ref check", found)
        # A job that asks for no token is not one, and a ref check clears the rest.
        (folder / "fine.yml").write_text(
            "on: workflow_dispatch\npermissions:\n  id-token: write\njobs:\n  quiet:\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: read\n    steps:\n      - run: echo hi\n"
            "  publish:\n    if: github.ref == 'refs/heads/main'\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hi\n"
        )
        self.assertNotIn("fine.yml", "\n".join(check_signing_jobs.problems(folder)))

    def test_the_release_workflows_oidc_jobs_each_carry_a_ref_check(self):
        import yaml

        release = yaml.safe_load((WORKFLOWS / "release.yml").read_text())
        oidc = [n for n, j in release["jobs"].items() if (j.get("permissions") or {}).get("id-token") == "write"]
        self.assertEqual(sorted(oidc), ["npm", "npm-next"])
        # npm-next is also reachable by hand (`next_to`), which skips the version job: the ref is named there.
        self.assertIn("github.ref == 'refs/heads/main'", release["jobs"]["npm-next"]["if"])
        # Taking the check out of the real workflow is refused.
        folder = pathlib.Path(tempfile.mkdtemp(prefix="signing-jobs-"))
        text = (WORKFLOWS / "release.yml").read_text()
        stripped = text.replace("github.ref == 'refs/heads/main' && ", "")
        self.assertNotEqual(stripped, text)
        (folder / "release.yml").write_text(stripped)
        found = "\n".join(check_signing_jobs.problems(folder))
        self.assertIn("release.yml: job npm-next can publish by OIDC with no ref check", found)


if __name__ == "__main__":
    unittest.main()
