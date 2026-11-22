"""The `unbrowse` command run in this process (test_cli.py runs it as a child, which the coverage of this suite doesn't
see): which app or program it finds and why, what it says when it finds none, the skill it installs and what it keeps
aside, and the exit codes it gives. Real folders and real scripts stand for the app and the programs; only what must not
happen here is held back: `execv` (it would replace this process) and the Mac's `codesign` (not on this machine)."""

import contextlib
import io
import json
import os
import runpy
import shutil
import stat
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

SRC = Path(__file__).resolve().parent.parent / "src"
OLD_SKILL = Path(__file__).resolve().parents[2] / "typescript" / "test" / "fixtures" / "skill-12.5.0"
sys.path.insert(0, str(SRC))

from unbrowse import cli  # noqa: E402

VENDOR, OTHER = "AAAAAAAAAA", "BBBBBBBBBB"
DARWIN = mock.patch.object(sys, "platform", "darwin")


def plist(version):
    return f"<plist><dict><key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>"


class Cli(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="unbrowse-cli-main-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        env = {k: v for k, v in os.environ.items() if not k.startswith("UNBROWSE_")}
        env.update(HOME=str(self.tmp / "home"), PATH=str(self.tmp / "empty-path"))
        (self.tmp / "home").mkdir()
        (self.tmp / "empty-path").mkdir()
        patched = mock.patch.dict(os.environ, env, clear=True)
        patched.start()
        self.addCleanup(patched.stop)

    # fixtures

    def app(self, name, version=None, programs=("unbrowse-window", "unbrowse-node", "unb")):
        a = self.tmp / name / "Unbrowse.app"
        macos = a / "Contents" / "MacOS"
        macos.mkdir(parents=True)
        for p in programs:
            (macos / p).write_text("#!/bin/sh\nexit 0\n")
            (macos / p).chmod(0o755)
        if version:
            (a / "Contents" / "Info.plist").write_text(plist(version))
        return a

    def package(self, with_app=True, team=VENDOR, with_skill=False):
        """A folder laid out as the wheel is: its own app, the team it pins, the skill, and `bin`."""
        pkg = self.tmp / "pkg" / "unbrowse"
        pkg.mkdir(parents=True)
        if with_app:
            own = pkg / "Unbrowse.app"
            (own / "Contents" / "MacOS").mkdir(parents=True)
            for p in ("unbrowse-window", "unbrowse-node", "unb"):
                (own / "Contents" / "MacOS" / p).write_text("#!/bin/sh\nexit 0\n")
                (own / "Contents" / "MacOS" / p).chmod(0o755)
            (own / "Contents" / "Info.plist").write_text(plist("1.0.0"))
        if team:
            (pkg / "app-team").write_text(team + "\n")
        if with_skill:
            (pkg / "skill").mkdir()
            (pkg / "skill" / "SKILL.md").write_text("---\nname: unbrowse\n---\nthe package's own words\n")
        patched = mock.patch.object(cli, "HERE", pkg)
        patched.start()
        self.addCleanup(patched.stop)
        return pkg

    def codesign(self, teams, unverified=()):
        """The Mac's codesign as it answers for each app: its team, or a signature that doesn't check."""
        def run(cmd, **kw):
            app = Path(cmd[-1])
            if cmd[1] == "--verify":
                return mock.Mock(returncode=1 if app in unverified or app not in teams else 0)
            return mock.Mock(stderr=f"Identifier=com.unbrowse\nTeamIdentifier={teams[app]}\n")
        patched = mock.patch("unbrowse.cli.subprocess.run", side_effect=run)
        patched.start()
        self.addCleanup(patched.stop)

    def main(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = cli.main(list(args))
        return code, out.getvalue(), err.getvalue()

    def script(self, path, body, mode=0o755):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(mode)
        return path

    # the team an app is signed by

    def test_off_a_mac_no_app_has_a_team_and_codesign_is_not_asked(self):
        with mock.patch("unbrowse.cli.subprocess.run") as run:
            self.assertIsNone(cli.team_of(self.app("any")))
        run.assert_not_called()

    def test_on_a_mac_an_app_whose_signature_checks_has_the_team_codesign_names(self):
        a = self.app("signed")
        self.codesign({a: VENDOR})
        with DARWIN:
            self.assertEqual(cli.team_of(a), VENDOR)

    def test_on_a_mac_an_app_whose_signature_does_not_check_has_no_team(self):
        a = self.app("tampered")
        self.codesign({a: VENDOR}, unverified=[a])
        with DARWIN:
            self.assertIsNone(cli.team_of(a))

    def test_on_a_mac_an_app_signed_ad_hoc_has_no_team(self):
        a = self.app("adhoc")
        for said in ("not set", "not"):
            with self.subTest(said):
                self.codesign({a: said})
                with DARWIN:
                    self.assertIsNone(cli.team_of(a))

    def test_on_a_mac_where_codesign_cannot_run_an_app_has_no_team(self):
        with DARWIN, mock.patch("unbrowse.cli.subprocess.run", side_effect=OSError("no codesign")):
            self.assertIsNone(cli.team_of(self.app("any")))

    # which apps may run

    def test_a_named_app_with_no_programs_in_it_is_never_run(self):
        own = self.app("own", "1.0.0")
        self.assertIsNone(cli.named_app(self.tmp / "nothing" / "Unbrowse.app", own, VENDOR, lambda a: VENDOR))

    def test_an_unchecked_app_named_by_its_absolute_path_runs_and_the_warning_says_so_and_where(self):
        a = self.app("mine", "2.0.0")
        app, said = cli.unchecked_app({"UNBROWSE_UNCHECKED_APP": str(a)})
        self.assertEqual(app, a)
        self.assertIn("signature checks are OFF", said)
        self.assertIn(str(a), said)

    def test_the_places_an_installed_app_is_looked_for_are_applications_and_the_homes(self):
        self.assertEqual(cli.installed_apps(), [Path("/Applications/Unbrowse.app"), self.tmp / "home" / "Applications" / "Unbrowse.app"])

    def test_the_unchecked_app_is_the_one_that_runs_over_every_other(self):
        a, named = self.app("mine", "0.1.0"), self.app("named", "9.0.0")
        os.environ["UNBROWSE_UNCHECKED_APP"] = str(a)
        os.environ["UNBROWSE_APP"] = str(named)
        self.assertEqual(cli.app_bundle(), a)

    def test_off_a_mac_no_app_runs_unless_one_is_named(self):
        self.package()
        self.assertIsNone(cli.app_bundle())

    def test_a_named_app_that_is_not_the_packages_own_and_has_no_team_to_be_held_to_does_not_run(self):
        self.package(team=None, with_app=False)
        os.environ["UNBROWSE_APP"] = str(self.app("named", "9.0.0"))
        self.assertIsNone(cli.app_bundle())

    def test_the_packages_own_app_runs_when_it_is_the_one_named(self):
        pkg = self.package()
        os.environ["UNBROWSE_APP"] = str(pkg / "Unbrowse.app")
        self.assertEqual(cli.app_bundle(), pkg / "Unbrowse.app")

    def test_on_a_mac_the_newer_installed_app_the_vendors_team_signed_runs_in_place_of_the_packages_own(self):
        pkg = self.package()
        mine, other = self.app("signed", "3.0.0"), self.app("foreign", "9.0.0")
        self.codesign({mine: VENDOR, other: OTHER})
        with DARWIN, mock.patch.object(cli, "installed_apps", return_value=[other, mine]):
            self.assertEqual(cli.app_bundle(), mine)
        with DARWIN, mock.patch.object(cli, "installed_apps", return_value=[other]):
            self.assertEqual(cli.app_bundle(), pkg / "Unbrowse.app", "another team's newer app never takes its place")

    # why an app that is there wasn't run

    def test_nothing_is_said_when_an_app_runs_or_when_none_was_asked_for_off_a_mac(self):
        pkg = self.package()
        self.assertEqual(cli.passed_over(), "")
        os.environ["UNBROWSE_APP"] = str(pkg / "Unbrowse.app")
        self.assertEqual(cli.passed_over(), "")

    def test_a_named_app_that_is_not_there_is_not_said_to_be_passed_over(self):
        self.package()
        os.environ["UNBROWSE_APP"] = str(self.tmp / "gone" / "Unbrowse.app")
        self.assertEqual(cli.passed_over(), "")

    def test_a_package_that_names_no_team_says_that_is_why_the_named_app_was_passed_over(self):
        self.package(team=None, with_app=False)
        named = self.app("named", "9.0.0")
        os.environ["UNBROWSE_APP"] = str(named)
        said = cli.passed_over()
        self.assertIn(f"{named} is there", said)
        self.assertIn("this package names no signing team to check it against", said)
        self.assertIn("UNBROWSE_UNCHECKED_APP=<its absolute path>", said)

    def test_a_package_that_names_a_team_says_the_named_app_is_not_that_teams(self):
        self.package()
        named = self.app("named", "9.0.0")
        os.environ["UNBROWSE_APP"] = str(named)
        self.assertIn("it isn't signed by the team this package names", cli.passed_over())

    def test_on_a_mac_with_no_app_of_the_packages_own_an_installed_app_of_another_team_is_said_to_be_passed_over(self):
        self.package(with_app=False)
        theirs = self.app("theirs", "9.0.0")
        self.codesign({theirs: OTHER})
        with DARWIN, mock.patch.object(cli, "installed_apps", return_value=[theirs]):
            self.assertIsNone(cli.app_bundle())
            said = cli.passed_over()
        self.assertIn(f"{theirs} is there", said)
        self.assertIn("it isn't signed by the team this package names", said)

    # where the programs are

    def test_the_programs_are_where_unbrowse_bin_says_even_when_they_are_not_there(self):
        os.environ["UNBROWSE_BIN"] = str(self.tmp / "nowhere")
        self.assertEqual(cli.bin_dir(), self.tmp / "nowhere")
        code, out, _ = self.main("where")
        self.assertEqual((code, out), (0, f"{self.tmp / 'nowhere'}\n"))

    def test_the_programs_are_inside_the_app_the_package_carries_on_a_mac_else_in_its_bin(self):
        pkg = self.package()
        with DARWIN:
            self.assertEqual(cli.bin_dir(), pkg / "Unbrowse.app" / "Contents" / "MacOS")
        self.assertIsNone(cli.bin_dir(), "off a Mac the app is not used, and bin has nothing yet")
        self.script(pkg / "bin" / "unbrowse-node", "exit 0\n")
        self.assertEqual(cli.bin_dir(), pkg / "bin")

    def test_with_no_programs_anywhere_where_says_they_are_on_the_path(self):
        self.package(with_app=False)
        self.assertEqual(self.main("where"), (0, "on PATH\n", ""))

    def test_on_windows_a_programs_file_name_ends_in_exe(self):
        self.assertEqual(cli.exe("unb"), "unb")
        with mock.patch.object(cli, "WINDOWS", True):
            self.assertEqual(cli.exe("unb"), "unb.exe")

    # the skill

    def test_the_skill_the_package_carries_is_found_before_the_one_in_the_repository(self):
        pkg = self.package(with_skill=True)
        self.assertEqual(cli.skill_dir(), pkg / "skill")

    def test_a_package_with_no_skill_falls_back_to_the_repositorys_and_finds_none_where_there_is_none(self):
        self.assertTrue((cli.skill_dir() / "SKILL.md").exists())
        with mock.patch.object(cli, "HERE", Path("/nonexistent-package")):
            self.assertIsNone(cli.skill_dir())
            with self.assertRaises(SystemExit) as e:
                cli.install_skill(str(self.tmp / "skills" / "unbrowse"))
        self.assertEqual(str(e.exception), "unbrowse: this package carries no skill")

    def test_the_skill_goes_to_the_claude_skills_folder_in_the_home_when_no_folder_is_named(self):
        code, out, err = self.main("skill")
        to = self.tmp / "home" / ".claude" / "skills" / "unbrowse"
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, f"the unbrowse skill is in {to}\n")
        self.assertTrue((to / "SKILL.md").read_text().startswith("---\nname: unbrowse\n"))

    def test_what_an_install_writes_it_records_by_each_files_hash_and_never_hashes_the_record(self):
        to = self.tmp / "skills" / "unbrowse"
        dest, kept = cli.install_skill(str(to))
        self.assertEqual((dest, kept), (to, None))
        record = json.loads((to / cli.WRITTEN).read_text())
        self.assertEqual(record, cli._hashes(to))
        self.assertIn("SKILL.md", record)
        self.assertNotIn(cli.WRITTEN, record)
        self.assertEqual(list(record), sorted(record))

    def test_only_a_folder_holding_nothing_but_what_an_install_wrote_is_ours(self):
        to = self.tmp / "skills" / "unbrowse"
        self.assertTrue(cli.only_ours_at(to), "nothing there")
        cli.install_skill(str(to))
        self.assertTrue(cli.only_ours_at(to))
        (to / "extra.md").write_text("mine")
        self.assertFalse(cli.only_ours_at(to), "a file added")
        (to / "extra.md").unlink()
        (to / "SKILL.md").write_text("edited")
        self.assertFalse(cli.only_ours_at(to), "a file changed")

    def test_a_skill_folder_with_no_record_or_a_broken_one_or_that_is_not_a_folder_is_not_ours(self):
        no_record = self.tmp / "no-record"
        no_record.mkdir()
        (no_record / "SKILL.md").write_text("a skill")
        self.assertFalse(cli.only_ours_at(no_record))
        (no_record / cli.WRITTEN).write_text("{not json")
        self.assertFalse(cli.only_ours_at(no_record))
        a_file = self.tmp / "a-file"
        a_file.write_text("x")
        self.assertFalse(cli.only_ours_at(a_file))
        link = self.tmp / "a-link"
        link.symlink_to(no_record, target_is_directory=True)
        self.assertFalse(cli.only_ours_at(link))

    def test_an_older_unbrowses_published_skill_is_known_by_its_hashes_and_nothing_else_is(self):
        old = self.tmp / "old"
        shutil.copytree(OLD_SKILL, old)
        self.assertTrue(cli.old_copy_at(old))
        (old / "notes.md").write_text("mine")
        self.assertFalse(cli.old_copy_at(old), "a file that was never published")
        (old / "notes.md").unlink()
        (old / "SKILL.md").unlink()
        self.assertFalse(cli.old_copy_at(old), "no SKILL.md")
        self.assertFalse(cli.old_copy_at(self.tmp / "nothing"), "nothing there")
        a_file = self.tmp / "a-file"
        a_file.write_text("x")
        self.assertFalse(cli.old_copy_at(a_file))
        link = self.tmp / "a-link"
        link.symlink_to(OLD_SKILL, target_is_directory=True)
        self.assertFalse(cli.old_copy_at(link), "a link is the owner's")

    def test_a_skill_folder_with_a_file_that_cannot_be_read_is_not_taken_for_a_published_copy(self):
        old = self.tmp / "old"
        shutil.copytree(OLD_SKILL, old)
        with mock.patch.object(Path, "read_bytes", side_effect=PermissionError("unreadable")):
            self.assertFalse(cli.old_copy_at(old))
        self.assertTrue(cli.old_copy_at(old))

    def test_a_copy_the_owner_edited_is_kept_beside_the_skills_folder_and_said_in_the_commands_words(self):
        to = self.tmp / "claude" / "skills" / "unbrowse"
        self.assertEqual(self.main("skill", str(to))[0], 0)
        (to / "SKILL.md").write_text("the owner's own words")
        code, out, err = self.main("skill", str(to))
        [kept] = (self.tmp / "claude" / "unbrowse-kept").iterdir()
        self.assertEqual((code, err), (0, ""))
        self.assertEqual(out, f"kept what was at {to} as {kept}, as it was; the unbrowse skill is in {to}\n")
        self.assertEqual((kept / "SKILL.md").read_text(), "the owner's own words")
        self.assertEqual(kept, cli.kept_dir(to) / kept.name)

    def test_two_copies_kept_in_the_same_second_are_both_kept(self):
        to = self.tmp / "claude" / "skills" / "unbrowse"
        with mock.patch.object(cli.time, "strftime", return_value="20260101000000"):
            for words in ("first edit", "second edit"):
                to.mkdir(parents=True, exist_ok=True)
                (to / "SKILL.md").write_text(words)
                cli.install_skill(str(to))
        kept = sorted((self.tmp / "claude" / "unbrowse-kept").iterdir())
        self.assertEqual([p.name for p in kept], ["unbrowse.before-unbrowse-20260101000000", "unbrowse.before-unbrowse-20260101000000-1"])
        self.assertEqual([(p / "SKILL.md").read_text() for p in kept], ["first edit", "second edit"])

    def test_a_link_to_the_owners_skill_is_kept_as_a_link_whose_target_is_made_absolute(self):
        mine = self.tmp / "my-checkout"
        mine.mkdir()
        (mine / "SKILL.md").write_text("my checkout's skill")
        to = self.tmp / "claude" / "skills" / "unbrowse"
        to.parent.mkdir(parents=True)
        to.symlink_to("../../my-checkout", target_is_directory=True)
        kept = cli._move_aside(to)
        self.assertFalse(os.path.lexists(to))
        self.assertTrue(kept.is_symlink())
        self.assertTrue(os.path.isabs(os.readlink(kept)))
        self.assertEqual((kept / "SKILL.md").read_text(), "my checkout's skill")

    # making the programs runnable

    def test_a_program_unpacked_without_its_mode_is_made_runnable_and_one_that_is_there_is_left(self):
        d = self.tmp / "bin"
        plain = self.script(d / "unb", "exit 0\n", mode=0o644)
        ready = self.script(d / "unbrowse-node", "exit 0\n", mode=0o750)
        cli.make_runnable(d, ("unb", "unbrowse-node", "agent-browser"))
        self.assertTrue(os.access(plain, os.X_OK))
        self.assertEqual(stat.S_IMODE(ready.stat().st_mode), 0o750)
        self.assertFalse((d / "agent-browser").exists(), "a program that is not there is not made up")

    def test_a_program_whose_mode_cannot_be_changed_is_left_as_it_is_without_a_crash(self):
        d = self.tmp / "bin"
        plain = self.script(d / "unb", "exit 0\n", mode=0o644)
        with mock.patch.object(Path, "chmod", side_effect=PermissionError("not yours")):
            cli.make_runnable(d, ("unb",))
        self.assertFalse(os.access(plain, os.X_OK))

    # opening the window

    def test_opening_the_app_hands_it_to_open_and_gives_back_the_exit_code_open_gave(self):
        a = self.app("mine", "2.0.0")
        for p in (a / "Contents" / "MacOS").iterdir():
            p.chmod(0o644)
        said = self.tmp / "said"
        bin_ = self.tmp / "fake-bin"
        self.script(bin_ / "open", f'echo "$@" > "{said}"\nexit 5\n')
        os.environ.update(UNBROWSE_UNCHECKED_APP=str(a), PATH=str(bin_))
        code, _, err = self.main("app")
        self.assertEqual(code, 5)
        self.assertEqual(said.read_text().strip(), str(a))
        self.assertIn("signature checks are OFF", err)
        self.assertTrue(all(os.access(p, os.X_OK) for p in (a / "Contents" / "MacOS").iterdir()), "the app's programs were made runnable first")

    def test_an_app_that_open_cannot_be_run_for_is_said_plainly_with_the_exit_code_1(self):
        a = self.app("mine", "2.0.0")
        os.environ["UNBROWSE_UNCHECKED_APP"] = str(a)
        code, _, err = self.main("app")
        self.assertEqual(code, 1)
        self.assertIn(f"unbrowse: can't open {a} (No such file or directory)", err)

    def test_without_an_app_the_window_beside_the_programs_starts_on_its_own_and_the_command_returns_0(self):
        said = self.tmp / "said"
        d = self.tmp / "bin"
        self.script(d / "unbrowse-window", f'echo "window $*" > "{said}"\n', mode=0o644)
        os.environ["UNBROWSE_BIN"] = str(d)
        self.assertEqual(self.main("app")[0], 0)
        end = time.monotonic() + 10
        while not said.exists() and time.monotonic() < end:
            time.sleep(0.02)
        self.assertEqual(said.read_text().strip(), "window")

    def test_a_window_that_cannot_be_started_is_said_plainly_with_the_exit_code_1(self):
        d = self.tmp / "bin"
        (d).mkdir()
        (d / "unbrowse-window").write_text("#!/nonexistent/interpreter\n")
        os.environ["UNBROWSE_BIN"] = str(d)
        code, _, err = self.main("app")
        self.assertEqual(code, 1)
        self.assertIn(f"unbrowse: can't open {d / 'unbrowse-window'} (", err)

    def test_with_no_window_anywhere_it_says_there_is_no_app_and_where_programs_come_from_with_the_exit_code_1(self):
        os.environ["UNBROWSE_BIN"] = str(self.tmp / "nowhere")
        code, out, err = self.main("app")
        self.assertEqual((code, out), (1, ""))
        self.assertIn("unbrowse: there's no Unbrowse app here.", err)
        self.assertIn("The window comes in the wheel for this machine, and this one is the client alone", err)
        self.assertIn("set UNBROWSE_BIN", err)

    # running a program

    def test_a_command_runs_the_program_it_is_routed_to_with_the_callers_arguments(self):
        d = self.tmp / "bin"
        unb = self.script(d / "unb", "exit 0\n", mode=0o644)
        os.environ["UNBROWSE_BIN"] = str(d)
        with mock.patch("unbrowse.cli.os.execv") as execv:
            self.assertEqual(self.main("do", "search", "--url", "https://x.test")[0], 0)
        execv.assert_called_once_with(str(unb), [str(unb), "do", "search", "--url", "https://x.test"])
        self.assertTrue(os.access(unb, os.X_OK), "made runnable first")

    def test_start_and_the_nodes_own_commands_run_unbrowse_node_the_rest_run_unb(self):
        d = self.tmp / "bin"
        for p in ("unbrowse-node", "unb"):
            self.script(d / p, "exit 0\n")
        os.environ["UNBROWSE_BIN"] = str(d)
        with mock.patch("unbrowse.cli.os.execv") as execv:
            self.main("start", "--quiet")
            self.main("vault", "list")
            self.main("whoami")
        self.assertEqual([c.args for c in execv.call_args_list], [
            (str(d / "unbrowse-node"), [str(d / "unbrowse-node"), "--quiet"]),
            (str(d / "unbrowse-node"), [str(d / "unbrowse-node"), "vault", "list"]),
            (str(d / "unb"), [str(d / "unb"), "whoami"]),
        ])

    def test_with_no_programs_folder_the_program_is_the_one_on_the_path_else_its_bare_name(self):
        path_dir = self.tmp / "on-path"
        found = self.script(path_dir / "unb", "exit 0\n")
        os.environ["PATH"] = str(path_dir)
        with mock.patch("unbrowse.cli.os.execv") as execv:
            self.main("whoami")
            self.main("start")
        self.assertEqual(execv.call_args_list[0].args, (str(found), [str(found), "whoami"]))
        self.assertEqual(execv.call_args_list[1].args, ("unbrowse-node", ["unbrowse-node"]), "found nowhere: its bare name, for the system to say")

    def test_a_program_that_is_not_there_is_said_plainly_with_the_exit_code_127(self):
        os.environ["UNBROWSE_BIN"] = str(self.tmp / "nowhere")
        code, out, err = self.main("whoami")
        self.assertEqual((code, out), (127, ""))
        self.assertIn("unbrowse: can't run unb (No such file or directory).", err)
        self.assertIn("unb comes in the wheel for this machine, and this one is the client alone", err)

    def test_on_windows_the_program_runs_as_a_child_and_its_exit_code_is_the_commands(self):
        d = self.tmp / "bin"
        said = self.tmp / "said"
        self.script(d / "unb.exe", f'echo "$@" > "{said}"\nexit 4\n', mode=0o644)
        os.environ["UNBROWSE_BIN"] = str(d)
        with mock.patch.object(cli, "WINDOWS", True):
            code = self.main("call", "hn-search", "q=tauri")[0]
        self.assertEqual(code, 4)
        self.assertEqual(said.read_text().strip(), "call hn-search q=tauri")

    # the command

    def test_with_no_words_or_asking_for_help_it_prints_the_usage_and_returns_0(self):
        for args in ((), ("help",), ("--help",), ("-h",)):
            with self.subTest(args):
                code, out, err = self.main(*args)
                self.assertEqual((code, err), (0, ""))
                self.assertEqual(out, cli.USAGE + "\n")
        self.assertIn("usage: unbrowse app | unbrowse start", cli.USAGE)

    def test_an_unchecked_app_is_warned_of_on_every_run_even_one_that_only_prints_the_usage(self):
        os.environ["UNBROWSE_UNCHECKED_APP"] = str(self.app("mine", "2.0.0"))
        code, out, err = self.main("help")
        self.assertEqual(code, 0)
        self.assertIn("signature checks are OFF", err)
        os.environ["UNBROWSE_UNCHECKED_APP"] = "Unbrowse.app"
        self.assertIn('which isn\'t the absolute path of an Unbrowse app; ignoring it.', self.main("help")[2])

    def test_the_commands_words_are_the_processs_own_when_none_are_passed(self):
        os.environ["UNBROWSE_BIN"] = str(self.tmp / "nowhere")
        with mock.patch.object(sys, "argv", ["unbrowse", "where"]), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(cli.main(), 0)
        self.assertEqual(out.getvalue(), f"{self.tmp / 'nowhere'}\n")

    def test_run_as_a_script_it_exits_with_the_commands_code(self):
        os.environ["UNBROWSE_BIN"] = str(self.tmp / "nowhere")
        with mock.patch.object(sys, "argv", ["unbrowse", "where"]), contextlib.redirect_stdout(io.StringIO()) as out:
            with self.assertRaises(SystemExit) as e:
                runpy.run_path(cli.__file__, run_name="__main__")
        self.assertEqual(e.exception.code, 0)
        self.assertEqual(out.getvalue(), f"{self.tmp / 'nowhere'}\n")
        os.environ["UNBROWSE_BIN"] = str(self.tmp / "nowhere")
        with mock.patch.object(sys, "argv", ["unbrowse", "whoami"]), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as e:
                runpy.run_path(cli.__file__, run_name="__main__")
        self.assertEqual(e.exception.code, 127)


if __name__ == "__main__":
    unittest.main()
