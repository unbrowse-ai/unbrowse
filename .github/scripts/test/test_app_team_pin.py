"""The Mac app's signing team travels from the signing job into the npm packages, so the CLI can hold an Unbrowse.app
installed outside the package to the vendor's team rather than to any team that signed it."""

import json
import pathlib
import shutil
import subprocess
import tarfile
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
SCRIPTS = ROOT / ".github" / "scripts"
VERSION = "9.9.9"


def mac_archives(programs: pathlib.Path, arch: str) -> None:
    """A stand-in for package-macos.sh's zip of the app and tarball of the programs alone."""
    stage = programs / f"stage-{arch}"
    macos = stage / "Unbrowse.app" / "Contents" / "MacOS"
    macos.mkdir(parents=True)
    for p in ("unbrowse-window", "unbrowse-node", "unb"):
        (macos / p).write_text("#!/bin/sh\n")
        (macos / p).chmod(0o755)
    subprocess.run(["zip", "-qr", str(programs / f"Unbrowse-{VERSION}-macos-{arch}.zip"), "Unbrowse.app"], cwd=stage, check=True)
    alone = stage / f"unbrowse-{VERSION}-macos-{arch}"
    alone.mkdir()
    (alone / "agent-browser").write_text("#!/bin/sh\n")
    with tarfile.open(programs / f"unbrowse-{VERSION}-macos-{arch}.tar.gz", "w:gz") as t:
        t.add(alone, arcname=alone.name)
    shutil.rmtree(stage)


def packed(out: pathlib.Path, platform: str) -> dict:
    with tarfile.open(out / f"unbrowse-{platform}-{VERSION}.tgz") as t:
        return json.load(t.extractfile("package/package.json"))


@unittest.skipUnless(shutil.which("npm") and shutil.which("zip") and shutil.which("sha256sum"), "needs npm, zip, sha256sum")
class AppTeamPin(unittest.TestCase):
    def pack(self, teams: dict[str, str]) -> tuple[subprocess.CompletedProcess, pathlib.Path]:
        tmp = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp)
        programs, out = tmp / "programs", tmp / "out"
        programs.mkdir()
        for arch in ("arm64", "x64"):
            mac_archives(programs, arch)
            if arch in teams:
                (programs / f"Unbrowse-{VERSION}-macos-{arch}.team").write_text(teams[arch] + "\n")
        run = subprocess.run(["sh", str(SCRIPTS / "pack-platforms.sh"), VERSION, str(programs), str(out)], cwd=ROOT, capture_output=True, text=True)
        return run, out

    def test_the_signing_jobs_team_is_pinned_in_the_mac_package(self):
        run, out = self.pack({"arm64": "ABCDE12345", "x64": "ABCDE12345"})
        self.assertEqual(run.returncode, 0, run.stderr + run.stdout)
        for platform in ("darwin-arm64", "darwin-x64"):
            self.assertEqual(packed(out, platform)["unbrowseAppTeam"], "ABCDE12345")

    def test_an_app_signed_ad_hoc_pins_no_team(self):
        run, out = self.pack({})
        self.assertEqual(run.returncode, 0, run.stderr + run.stdout)
        self.assertNotIn("unbrowseAppTeam", packed(out, "darwin-arm64"))

    def test_a_team_file_that_is_not_a_team_id_stops_the_pack(self):
        run, _ = self.pack({"arm64": 'X", "bin": {"x": "y'})
        self.assertNotEqual(run.returncode, 0)
        self.assertIn("is not a Team ID", run.stdout + run.stderr)

    def test_pack_sdks_pins_one_team_for_all_macs_or_stops(self):
        # pack-sdks.sh installs from npm, so this reads the rule it applies rather than running it.
        text = (SCRIPTS / "pack-sdks.sh").read_text()
        self.assertIn('npm pkg set "unbrowseAppTeam=$team"', text)
        self.assertIn("the Mac apps name two teams", text)
        self.assertIn("some name no team", text)
        # The wheels carry the same pin, for the Python CLI's own check.
        self.assertIn('printf \'%s\\n\' "$team" > "$py/src/unbrowse/app-team"', text)
        self.assertIn('"src/unbrowse/app-team"', (ROOT / "unbrowse-sdk" / "python" / "pyproject.toml").read_text())
        signing = (SCRIPTS / "package-macos.sh").read_text()
        self.assertIn('codesign -dv "$app"', signing)
        self.assertIn(".team", signing)


if __name__ == "__main__":
    unittest.main()
