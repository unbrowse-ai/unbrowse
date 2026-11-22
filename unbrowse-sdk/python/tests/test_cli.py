"""The `unbrowse` command: which program each command goes to, that it runs the programs it finds with the caller's
arguments and exit code, and that it puts the skill where it's asked."""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src"
# The 12.5.0 npm package's skill, as published (SKILL.md and references/tools.json).
OLD_SKILL = Path(__file__).resolve().parents[2] / "typescript" / "test" / "fixtures" / "skill-12.5.0"
sys.path.insert(0, str(SRC))

from unbrowse.cli import route  # noqa: E402


def unbrowse(*args, bin_dir=None):
    env = dict(os.environ, PYTHONPATH=str(SRC))
    if bin_dir:
        env["UNBROWSE_BIN"] = str(bin_dir)
    return subprocess.run([sys.executable, "-m", "unbrowse.cli", *args], env=env, capture_output=True, text=True)


class Cli(unittest.TestCase):
    def test_every_command_the_node_runs_is_reached_through_unbrowse(self):
        # The node's own source, read as the npm package's test reads it (unbrowse-sdk/typescript/test/cli.test.mjs): the
        # first words `unbrowse-node` runs a command for. A node command this package sent to unb would fail there as a
        # command unb doesn't have, so a command added to the node is added to NODE_COMMANDS in the same change.
        main = (Path(__file__).resolve().parents[3] / "unbrowse-node" / "app" / "src" / "main.rs").read_text(encoding="utf-8")
        start = main.index("\nfn main() {")
        body = main[start:main.index("\n}\n", start)]
        runs = sorted(set(re.findall(r'args\.get\(1\)\.map\(String::as_str\) == Some\("([a-z-]+)"\)', body)))
        self.assertGreater(len(runs), 20, runs)
        self.assertEqual([w for w in runs if route([w])[0] != "unbrowse-node"], [], "node commands `unbrowse` sends to unb")

    def test_start_and_the_nodes_commands_go_to_the_node_the_rest_to_unb(self):
        self.assertEqual(route(["start"]), ("unbrowse-node", []))
        self.assertEqual(route(["vault", "list"]), ("unbrowse-node", ["vault", "list"]))
        # Bounties and route coins are the owner's, signed by the node's key: `unbrowse bounty post shop.example 2000`.
        self.assertEqual(route(["bounty", "show", "7"]), ("unbrowse-node", ["bounty", "show", "7"]))
        self.assertEqual(route(["coin", "stake", "0xE", "60"]), ("unbrowse-node", ["coin", "stake", "0xE", "60"]))
        # Imports run on the node from a shell, with no window: passwords under vault, cookies under session, passkeys under passkey.
        self.assertEqual(route(["vault", "import", "export.csv"]), ("unbrowse-node", ["vault", "import", "export.csv"]))
        self.assertEqual(route(["session", "import", "github.com", "--from", "cookies.txt"]), ("unbrowse-node", ["session", "import", "github.com", "--from", "cookies.txt"]))
        self.assertEqual(route(["terms", "accept"]), ("unbrowse-node", ["terms", "accept"]))
        # The browser add-on is the node's to fetch and keep.
        self.assertEqual(route(["browser", "install"]), ("unbrowse-node", ["browser", "install"]))
        self.assertEqual(route(["browser", "status"]), ("unbrowse-node", ["browser", "status"]))
        self.assertEqual(route(["network", "off"]), ("unbrowse-node", ["network", "off"]))
        self.assertEqual(route(["share", "all"]), ("unbrowse-node", ["share", "all"]))
        self.assertEqual(route(["sign-in"]), ("unbrowse-node", ["sign-in"]))
        # The most the node pays to fetch one route is the owner's setting, shown or set on the node.
        self.assertEqual(route(["max-fetch"]), ("unbrowse-node", ["max-fetch"]))
        self.assertEqual(route(["max-fetch", "0.1"]), ("unbrowse-node", ["max-fetch", "0.1"]))
        self.assertEqual(route(["domain", "status", "shop.example"]), ("unbrowse-node", ["domain", "status", "shop.example"]))
        # The commands the node tells its owner to run.
        self.assertEqual(route(["update"]), ("unbrowse-node", ["update"]))
        self.assertEqual(route(["update", "channel", "canary"]), ("unbrowse-node", ["update", "channel", "canary"]))
        self.assertEqual(route(["restart"]), ("unbrowse-node", ["restart"]))
        # Which chain the node runs on, and deploying the shared contracts to it, are the node's.
        self.assertEqual(route(["chain", "arc-testnet"]), ("unbrowse-node", ["chain", "arc-testnet"]))
        self.assertEqual(route(["chain", "deploy"]), ("unbrowse-node", ["chain", "deploy"]))
        self.assertEqual(route(["passkey", "import", "bitwarden.json"]), ("unbrowse-node", ["passkey", "import", "bitwarden.json"]))
        self.assertEqual(route(["do", "search", "--url", "https://x.test"]), ("unb", ["do", "search", "--url", "https://x.test"]))

    def test_runs_the_program_it_finds_with_the_callers_arguments_and_exit_code(self):
        with tempfile.TemporaryDirectory() as d:
            said = Path(d) / "said"
            for p in ("unbrowse-node", "unb"):
                f = Path(d) / p
                f.write_text(f'#!/bin/sh\necho "{p} $*" > "{said}"\nexit 3\n')
                f.chmod(0o644)
            r = unbrowse("call", "hn-search", "q=tauri", bin_dir=d)
            self.assertEqual(r.returncode, 3, r.stderr)
            self.assertEqual(said.read_text().strip(), "unb call hn-search q=tauri")
            unbrowse("start", bin_dir=d)
            self.assertEqual(said.read_text().strip(), "unbrowse-node")

    def test_puts_the_skill_where_its_asked(self):
        with tempfile.TemporaryDirectory() as d:
            to = Path(d) / "skills" / "unbrowse"
            r = unbrowse("skill", str(to))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue((to / "SKILL.md").read_text().startswith("---\nname: unbrowse\n"))

    def test_replaces_an_earlier_skill_of_the_same_name_whole(self):
        with tempfile.TemporaryDirectory() as d:
            to = Path(d) / "skills" / "unbrowse"
            (to / "references").mkdir(parents=True)
            (to / "references" / "old.md").write_text("an earlier skill's page")
            self.assertEqual(unbrowse("skill", str(to)).returncode, 0)
            self.assertFalse((to / "references").exists())
            self.assertTrue((to / "SKILL.md").exists())

    def asides(self, to):
        self.assertEqual([p for p in to.parent.iterdir() if ".before-unbrowse-" in p.name], [], "nothing kept in the skills folder")
        where = to.parent.parent / "unbrowse-kept"
        return sorted(p for p in where.iterdir() if p.name.startswith(f"{to.name}.before-unbrowse-")) if where.exists() else []

    def new_skill(self, to):
        self.assertTrue((to / "SKILL.md").read_text().startswith("---\nname: unbrowse\n"))

    def test_its_own_unchanged_copy_is_replaced_and_an_edited_one_moved_aside(self):
        with tempfile.TemporaryDirectory() as d:
            to = Path(d) / "skills" / "unbrowse"
            self.assertEqual(unbrowse("skill", str(to)).returncode, 0)
            self.assertTrue((to / ".unbrowse-installed.json").exists(), "the record the npm install leaves too")
            self.assertEqual(unbrowse("skill", str(to)).returncode, 0)
            self.assertEqual(self.asides(to), [], "its own copy, untouched: replaced, nothing kept")
            (to / "SKILL.md").write_text("the owner's own words")
            r = unbrowse("skill", str(to))
            self.assertEqual(r.returncode, 0, r.stderr)
            [kept] = self.asides(to)
            self.assertRegex(kept.name, r"^unbrowse\.before-unbrowse-\d{14}$")
            self.assertIn(f"kept what was at {to} as {kept}, as it was", r.stdout)
            self.assertEqual((kept / "SKILL.md").read_text(), "the owner's own words")
            self.new_skill(to)

    def test_an_older_unbrowses_published_skill_is_replaced_and_an_edited_one_moved_aside(self):
        with tempfile.TemporaryDirectory() as d:
            to = Path(d) / "skills" / "unbrowse"
            shutil.copytree(OLD_SKILL, to)
            self.assertEqual(unbrowse("skill", str(to)).returncode, 0)
            self.new_skill(to)
            self.assertEqual(self.asides(to), [], "the 12.5.0 copy was ours: replaced, nothing kept")
            self.assertFalse((to / "references" / "tools.json").exists())
            shutil.rmtree(to)
            shutil.copytree(OLD_SKILL, to)
            with open(to / "SKILL.md", "a") as f:
                f.write("\nmy own rule\n")
            self.assertEqual(unbrowse("skill", str(to)).returncode, 0)
            [kept] = self.asides(to)
            self.assertTrue((kept / "SKILL.md").read_text().endswith("my own rule\n"))
            self.assertTrue((kept / "references" / "tools.json").exists())
            self.new_skill(to)

    def test_a_link_to_the_owners_skill_is_moved_aside_and_what_it_points_at_untouched(self):
        with tempfile.TemporaryDirectory() as d:
            mine = Path(d) / "my-checkout"
            mine.mkdir()
            (mine / "SKILL.md").write_text("my checkout's skill")
            to = Path(d) / "skills" / "unbrowse"
            to.parent.mkdir()
            to.symlink_to("../my-checkout", target_is_directory=True)
            self.assertEqual(unbrowse("skill", str(to)).returncode, 0)
            self.assertFalse(to.is_symlink())
            self.new_skill(to)
            [kept] = self.asides(to)
            self.assertTrue(kept.is_symlink())
            self.assertEqual((kept / "SKILL.md").read_text(), "my checkout's skill", "a relative link still points at it")
            self.assertEqual([p.name for p in mine.iterdir()], ["SKILL.md"])
            self.assertEqual((mine / "SKILL.md").read_text(), "my checkout's skill")

    def test_the_old_skill_hashes_are_the_npm_packages(self):
        from unbrowse._old_skills import OLD_SKILL_FILES

        ts = (Path(__file__).resolve().parents[2] / "typescript" / "src" / "old-skills.ts").read_text()
        table, name = {}, None
        for line in ts.splitlines():
            m = re.match(r'^  "([^"]+)": \[$', line)
            if m:
                name = m.group(1)
                table[name] = set()
            m = re.match(r'^    "([0-9a-f]{64})",$', line)
            if m:
                table[name].add(m.group(1))
        self.assertEqual({k: set(v) for k, v in OLD_SKILL_FILES.items()}, table)
        self.assertGreater(len(table["SKILL.md"]), 10)

    def test_the_programs_run_from_inside_the_app_the_package_brings(self):
        with tempfile.TemporaryDirectory() as d:
            app = Path(d) / "Unbrowse.app"
            macos = app / "Contents" / "MacOS"
            macos.mkdir(parents=True)
            said = Path(d) / "said"
            for p in ("unbrowse-window", "unbrowse-node", "unb"):
                f = macos / p
                f.write_text(f'#!/bin/sh\necho "{p} $*" > "{said}"\nexit 3\n')
                f.chmod(0o644)
            # A build of one's own, which no team signed: it runs only when named as unchecked, and that is said.
            env = dict(os.environ, PYTHONPATH=str(SRC), UNBROWSE_UNCHECKED_APP=str(app))
            env.pop("UNBROWSE_BIN", None)
            env.pop("UNBROWSE_APP", None)
            r = subprocess.run([sys.executable, "-m", "unbrowse.cli", "whoami"], env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 3, r.stderr)
            self.assertEqual(said.read_text().strip(), "unb whoami")
            self.assertIn("signature checks are OFF", r.stderr)

    def test_an_app_the_environment_names_never_runs_unless_the_vendors_team_signed_it(self):
        """Naming an app is not vouching for it: every program started from the shell inherits the variable."""
        with tempfile.TemporaryDirectory() as d:
            app = Path(d) / "Unbrowse.app"
            macos = app / "Contents" / "MacOS"
            macos.mkdir(parents=True)
            said = Path(d) / "said"
            for p in ("unbrowse-window", "unbrowse-node", "unb"):
                f = macos / p
                f.write_text(f'#!/bin/sh\necho "{p} $*" > "{said}"\nexit 3\n')
                f.chmod(0o755)
            env = dict(os.environ, PYTHONPATH=str(SRC), UNBROWSE_APP=str(app), PATH="/nonexistent")
            env.pop("UNBROWSE_BIN", None)
            env.pop("UNBROWSE_UNCHECKED_APP", None)
            r = subprocess.run([sys.executable, "-m", "unbrowse.cli", "whoami"], env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 127, r.stderr)
            self.assertFalse(said.exists())
            self.assertIn("so it isn't run", r.stderr)
            r = subprocess.run([sys.executable, "-m", "unbrowse.cli", "app"], env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 1, r.stderr)
            self.assertFalse(said.exists())

    def test_an_app_found_elsewhere_runs_only_when_the_vendors_team_signed_it(self):
        from unbrowse.cli import named_app, trusted_app
        with tempfile.TemporaryDirectory() as d:
            def app(name: str, version: str) -> Path:
                a = Path(d) / name / "Unbrowse.app"
                (a / "Contents" / "MacOS").mkdir(parents=True)
                (a / "Contents" / "MacOS" / "unbrowse-window").write_text("")
                (a / "Contents" / "Info.plist").write_text(
                    f"<plist><dict><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>")
                return a
            own, ours, theirs, bare = app("own", "1.0.0"), app("ours", "2.0.0"), app("theirs", "9.0.0"), app("bare", "9.9.0")
            teams = {own: "AAAAAAAAAA", ours: "AAAAAAAAAA", theirs: "BBBBBBBBBB"}
            team = teams.get
            # Newer and the vendor's: it runs. Newer still and another team's, or unsigned: never.
            self.assertEqual(trusted_app(own, [theirs, bare, ours], "AAAAAAAAAA", team), ours)
            self.assertEqual(trusted_app(own, [theirs, bare], "AAAAAAAAAA", team), own)
            # No pin: the package's own app says who the vendor is.
            self.assertEqual(trusted_app(own, [theirs, ours], None, team), ours)
            # Neither a pin nor a signed app of the package's: signed by somebody is not who made it.
            self.assertIsNone(trusted_app(None, [theirs, ours, bare], None, team))
            self.assertEqual(trusted_app(bare, [theirs, ours], None, team), bare)
            self.assertEqual(named_app(ours, own, "AAAAAAAAAA", team), ours)
            self.assertEqual(named_app(own, own, None, lambda a: None), own)
            self.assertIsNone(named_app(theirs, own, "AAAAAAAAAA", team))
            self.assertIsNone(named_app(bare, own, "AAAAAAAAAA", team))
            self.assertIsNone(named_app(ours, None, None, team))

    def test_the_pinned_team_is_a_team_id_or_nothing(self):
        from unbrowse.cli import pinned_team
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "app-team"
            self.assertIsNone(pinned_team(f))
            f.write_text("AB12CD34EF\n")
            self.assertEqual(pinned_team(f), "AB12CD34EF")
            for junk in ("", "not", "ab12cd34ef", "AB12CD34EF1", "AB12CD34E\nX"):
                f.write_text(junk)
                self.assertIsNone(pinned_team(f), junk)

    def test_an_unchecked_app_must_be_named_by_its_absolute_path(self):
        from unbrowse.cli import unchecked_app
        self.assertEqual(unchecked_app({}), (None, ""))
        app, said = unchecked_app({"UNBROWSE_UNCHECKED_APP": "Unbrowse.app"})
        self.assertIsNone(app)
        self.assertIn("ignoring it", said)
        app, said = unchecked_app({"UNBROWSE_UNCHECKED_APP": "1"})
        self.assertIsNone(app)

    def test_unbrowse_app_says_plainly_when_theres_no_app_to_open(self):
        env = dict(os.environ, PYTHONPATH=str(SRC), UNBROWSE_APP="/nonexistent/Unbrowse.app")
        r = subprocess.run([sys.executable, "-m", "unbrowse.cli", "app"], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        self.assertIn("no Unbrowse app here", r.stderr)

    def test_a_missing_program_is_said_plainly(self):
        r = unbrowse("whoami", bin_dir="/nonexistent/unbrowse-bin")
        self.assertEqual(r.returncode, 127)
        self.assertIn("can't run unb", r.stderr)

    def test_without_an_app_bundle_unbrowse_app_starts_the_window_beside_the_programs(self):
        """As on Linux and Windows: the window in `bin` runs on its own after the command returns."""
        with tempfile.TemporaryDirectory() as d:
            said = Path(d) / "said"
            window = Path(d) / "unbrowse-window"
            window.write_text(f'#!/bin/sh\necho "unbrowse-window $*" > "{said}"\n')
            window.chmod(0o644)
            env = dict(os.environ, PYTHONPATH=str(SRC), UNBROWSE_APP="/nonexistent/Unbrowse.app", UNBROWSE_BIN=d)
            r = subprocess.run([sys.executable, "-m", "unbrowse.cli", "app"], env=env, capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            for _ in range(50):
                if said.exists():
                    break
                time.sleep(0.05)
            self.assertEqual(said.read_text().strip(), "unbrowse-window")


if __name__ == "__main__":
    unittest.main()



class NewestApp(unittest.TestCase):
    def test_the_newest_app_wins(self):
        from unbrowse.cli import newest_app, app_version
        with tempfile.TemporaryDirectory() as d:
            def app(name, version=None):
                a = Path(d) / name / "Unbrowse.app"
                (a / "Contents" / "MacOS").mkdir(parents=True)
                (a / "Contents" / "MacOS" / "unbrowse-window").write_text("")
                if version:
                    (a / "Contents" / "Info.plist").write_text(
                        f"<plist><dict><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>")
                return a
            old, cur, none = app("old", "13.0.1"), app("cur", "13.9.0-dev"), app("none")
            self.assertEqual(app_version(cur), [13, 9, 0])
            self.assertEqual(app_version(none), [])
            self.assertEqual(newest_app([old, cur]), cur)
            self.assertEqual(newest_app([cur, old]), cur)
            self.assertEqual(newest_app([none, old]), old)
            self.assertEqual(newest_app([old, Path(d) / "no-such" / "Unbrowse.app"]), old)
            self.assertIsNone(newest_app([]))
