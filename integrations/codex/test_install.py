"""install.sh against a scratch home: it never deletes a skill folder that was there, and it writes only a plain node
address into config.toml (external security review round 3, 2026-11-04). It replaces an older Unbrowse's
[mcp_servers.unbrowse] and keeps every other setting, and never touches one no Unbrowse install wrote (B4, UNB-158).
Python's standard library only.

    python3 -m unittest discover -s integrations/codex -p 'test_*.py'

UNBROWSE_TEST_AWKS (a list of awk programs, `:`-separated) runs every test once with each as `awk`: macOS's awk is
the one true awk (`original-awk` on Debian), Ubuntu's is mawk, busybox's is its own.
"""

import os
import pathlib
import shutil
import stat
import subprocess
import tempfile
import tomllib
import unittest

HERE = pathlib.Path(__file__).resolve().parent
INSTALL = HERE / "install.sh"


class Install(unittest.TestCase):
    awk = None  # a program to run as `awk`, set by load_tests for each of UNBROWSE_TEST_AWKS

    def setUp(self):
        self.home = pathlib.Path(tempfile.mkdtemp(prefix="codex-install-"))
        self.codex = self.home / ".codex"
        self.skills = self.home / ".agents" / "skills"
        self.bin = self.home / "bin"
        self.bin.mkdir()
        if self.awk:
            awk = self.awk.split()
            (self.bin / "awk").write_text(f'#!/bin/sh\nexec {" ".join(awk)} "$@"\n')
            (self.bin / "awk").chmod(0o755)

    def run_install(self, node=None, path=None):
        path = path or os.environ.get("PATH", "/usr/bin:/bin")
        env = {"HOME": str(self.home), "CODEX_HOME": str(self.codex), "PATH": f"{self.bin}:{path}"}
        if node is not None:
            env["UNBROWSE_NODE"] = node
        return subprocess.run(["sh", str(INSTALL)], env=env, capture_output=True, text=True)

    def config(self):
        return self.codex / "config.toml"

    def write_config(self, text):
        self.codex.mkdir(parents=True, exist_ok=True)
        self.config().write_text(text)

    def kept(self):
        return sorted(p for p in self.codex.iterdir() if p.name.startswith("config.toml.before-unbrowse-"))

    def assert_replaced(self, before, r):
        """The older table is gone, this node's is in its place, every other setting is as it was, and the file as it was is
        kept beside it for the owner only."""
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("replaced the older Unbrowse's [mcp_servers.unbrowse]", r.stdout)
        was, now = tomllib.loads(before), tomllib.loads(self.config().read_text())
        got = now["mcp_servers"].pop("unbrowse")
        self.assertEqual(got["command"], "unbrowse")
        self.assertEqual(got["args"], ["mcp", "--agent", "first"])
        self.assertEqual(got["env"], {"UNBROWSE_NODE": "http://127.0.0.1:7788"})
        self.assertEqual(set(got), {"command", "args", "env", "startup_timeout_sec", "tool_timeout_sec"}, "nothing of the old table is left")
        was["mcp_servers"].pop("unbrowse")
        self.assertEqual(was, now, "every other setting is as it was")
        [kept] = self.kept()
        self.assertEqual(kept.read_text(), before)
        self.assertEqual(stat.S_IMODE(kept.stat().st_mode), 0o600)
        # Run again: this node's table now, so nothing changes.
        after = self.config().read_text()
        r = self.run_install()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("already has this node's unbrowse MCP server", r.stdout)
        self.assertEqual(self.config().read_text(), after)
        self.assertEqual(len(self.kept()), 1)

    def assert_untouched(self, before, r, says):
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(says, r.stdout)
        self.assertEqual(self.config().read_text(), before, "byte for byte")
        self.assertEqual(self.kept(), [])

    # ---- B4: an older Unbrowse's table is replaced, the others kept ----

    OTHERS = 'model = "o3"\n\n[profiles.fast]\nmodel = "o4-mini"\n\n'
    GITHUB = '\n[mcp_servers.github]\ncommand = "gh-mcp"\nargs = ["serve"]\n\n[mcp_servers.github.env]\nGH_HOST = "github.com"\n'

    def test_the_12x_npx_entry_is_replaced_and_the_others_kept(self):
        before = (
            self.OTHERS
            + '[mcp_servers.unbrowse]\ncommand = "npx"\nargs = ["-y", "unbrowse", "mcp"]\n\n'
            + '[mcp_servers.unbrowse.env]\nUNBROWSE_SHARED_SIGNIN = "1"\nUNBROWSE_CONFIG_DIR = "/home/u/.config/unbrowse"\n'
            + self.GITHUB
        )
        self.write_config(before)
        self.assert_replaced(before, self.run_install())

    def test_the_12x_dist_cli_entry_with_an_account_is_replaced(self):
        before = '[mcp_servers.unbrowse]\ncommand = "node"\nargs = ["/usr/lib/node_modules/unbrowse/dist/cli.js", "mcp", "--account", "work"]\nenv = { XDG_CONFIG_HOME = "/home/u/.config" }\n' + self.GITHUB
        self.write_config(before)
        self.assert_replaced(before, self.run_install())

    def test_args_over_several_lines_are_read(self):
        before = self.OTHERS + '[mcp_servers.unbrowse]\ncommand = "npx"\nargs = [\n  "-y",\n  "unbrowse@12.5.0",\n  "mcp",\n]\nstartup_timeout_sec = 30\n' + self.GITHUB
        self.write_config(before)
        self.assert_replaced(before, self.run_install())

    def test_a_hosted_address_is_replaced_and_its_key_goes_with_it(self):
        before = (
            '[mcp_servers."unbrowse"]\nurl = "https://v3.unbrowse.ai/mcp?ref=abc"\n\n'
            + '[mcp_servers.unbrowse.http_headers]\nAuthorization = "Bearer ub_live_0000000000000000"\n'
            + self.GITHUB
        )
        self.write_config(before)
        self.assert_replaced(before, self.run_install())
        self.assertNotIn("ub_live", self.config().read_text())

    def test_without_a_toml_reader_whole_tables_are_still_swapped(self):
        before = self.OTHERS + '# my servers\n[mcp_servers.unbrowse]\ncommand = "npx"\nargs = ["-y", "unbrowse", "mcp"]\n' + self.GITHUB
        self.write_config(before)
        # A python3 that can't read TOML, as macOS's own (3.9) can't.
        (self.bin / "python3").write_text("#!/bin/sh\nexit 1\n")
        (self.bin / "python3").chmod(0o755)
        self.assert_replaced(before, self.run_install())

    def test_a_rewrite_that_would_change_another_setting_writes_nothing(self):
        # Valid TOML a line-reader takes wrong: an array whose lines start with "[". The check catches it.
        before = self.OTHERS + '[mcp_servers.unbrowse]\ncommand = "npx"\nargs = [\n["unbrowse@12.5.0"], "mcp",\n]\n' + self.GITHUB
        self.write_config(before)
        r = self.run_install()
        self.assertEqual(r.returncode, 1)
        self.assertIn("nothing written", r.stderr)
        self.assertEqual(self.config().read_text(), before)
        self.assertEqual(self.kept(), [])

    def test_an_entry_no_unbrowse_install_wrote_is_never_touched(self):
        for table in [
            '[mcp_servers.unbrowse]\ncommand = "my-unbrowse-fork"\nargs = ["serve"]\n',
            '[mcp_servers.unbrowse]\nurl = "https://proxy.example.com/unbrowse"\n',
            '[mcp_servers.unbrowse]\nurl = "https://unbrowse.ai.example.com/mcp"\n',
        ]:
            with self.subTest(table=table):
                before = self.OTHERS + table + self.GITHUB
                self.write_config(before)
                self.assert_untouched(before, self.run_install(), "that no Unbrowse install wrote; left as it is")

    def test_this_nodes_own_entry_is_left(self):
        for table in [
            '[mcp_servers.unbrowse]\ncommand = "/opt/homebrew/bin/unbrowse"\nargs = ["mcp", "--agent", "3"]\n',
            '[mcp_servers.unbrowse]\nurl = "http://127.0.0.1:7788/mcp"\nbearer_token_env_var = "UNBROWSE_AGENT_TOKEN"\n',
        ]:
            with self.subTest(table=table):
                before = table + self.GITHUB
                self.write_config(before)
                self.assert_untouched(before, self.run_install(), "already has this node's unbrowse MCP server")

    def test_a_server_written_inline_is_left_with_the_edit_to_make(self):
        before = '[mcp_servers]\nunbrowse = { command = "npx", args = ["-y", "unbrowse", "mcp"] }\n'
        self.write_config(before)
        r = self.run_install()
        self.assert_untouched(before, r, "in a form this installer doesn't rewrite")
        self.assertIn('args = ["mcp", "--agent", "first"]', r.stdout)

    def test_an_older_second_account_entry_is_named_not_removed(self):
        before = '[mcp_servers.unbrowse-work]\ncommand = "npx"\nargs = ["-y", "unbrowse", "mcp", "--account", "work"]\n' + self.GITHUB
        self.write_config(before)
        r = self.run_install()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("[mcp_servers.unbrowse-work] in", r.stdout)
        now = tomllib.loads(self.config().read_text())
        self.assertEqual(now["mcp_servers"]["unbrowse-work"], tomllib.loads(before)["mcp_servers"]["unbrowse-work"])
        self.assertEqual(now["mcp_servers"]["unbrowse"]["args"], ["mcp", "--agent", "first"], "and this node's is added")

    def test_a_skill_folder_already_there_is_kept_never_deleted(self):
        mine = self.skills / "unbrowse"
        mine.mkdir(parents=True)
        (mine / "SKILL.md").write_text("my own notes\n")
        (mine / "extra.txt").write_text("keep me\n")
        r = self.run_install()
        self.assertEqual(r.returncode, 0, r.stderr)
        kept_dir = self.skills.parent / "unbrowse-kept"
        kept = [p for p in kept_dir.iterdir() if p.name.startswith("unbrowse.before-unbrowse-")]
        self.assertEqual(len(kept), 1, list(kept_dir.iterdir()))
        self.assertEqual((kept[0] / "extra.txt").read_text(), "keep me\n")
        self.assertEqual([p.name for p in self.skills.iterdir() if ".before-unbrowse-" in p.name], [], "not in the skills folder, where Codex would load it")
        self.assertTrue((mine / "SKILL.md").read_text() != "my own notes\n", "the new copy is in place")
        # Run again: the copy is current, so nothing more is moved aside.
        r = self.run_install()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len([p for p in kept_dir.iterdir() if p.name.startswith("unbrowse.before-unbrowse-")]), 1)

    def test_a_relative_link_in_the_skills_folder_is_kept_pointing_at_the_same_place(self):
        mine = self.skills.parent / "my-checkout"
        mine.mkdir(parents=True)
        (mine / "SKILL.md").write_text("my checkout's skill\n")
        self.skills.mkdir(parents=True, exist_ok=True)
        os.symlink("../my-checkout", self.skills / "unbrowse")
        r = self.run_install()
        self.assertEqual(r.returncode, 0, r.stderr)
        [kept] = list((self.skills.parent / "unbrowse-kept").iterdir())
        self.assertTrue(kept.is_symlink())
        self.assertEqual((kept / "SKILL.md").read_text(), "my checkout's skill\n")
        self.assertEqual([p.name for p in mine.iterdir()], ["SKILL.md"])

    def test_only_a_plain_node_address_goes_into_config(self):
        for hostile in ['http://a"b', "http://a|b", "http://a&b", "http://a\\b", "http://ok\n[mcp_servers.evil]", "file:///etc", "http://", "javascript:x"]:
            with self.subTest(node=hostile):
                r = self.run_install(hostile)
                self.assertNotEqual(r.returncode, 0, f"{hostile!r} was taken")
                config = self.codex / "config.toml"
                self.assertFalse(config.exists() and "evil" in config.read_text())
        r = self.run_install("http://127.0.0.1:9000/")
        self.assertEqual(r.returncode, 0, r.stderr)
        config = (self.codex / "config.toml").read_text()
        self.assertIn('UNBROWSE_NODE = "http://127.0.0.1:9000"', config)

    def test_codex_starts_the_proving_bridge_never_hands_the_token_to_its_own_transport(self):
        r = self.run_install()
        self.assertEqual(r.returncode, 0, r.stderr)
        config = (self.codex / "config.toml").read_text()
        self.assertIn('command = "unbrowse"', config)
        self.assertIn('args = ["mcp", "--agent", "first"]', config)
        self.assertNotIn("UNBROWSE_AGENT_TOKEN", config, "the config names the agent, never its token")
        self.assertNotIn("bearer_token_env_var", config)
        self.assertNotIn("url =", config)


def load_tests(loader, tests, pattern):
    awks = [a for a in os.environ.get("UNBROWSE_TEST_AWKS", "").split(":") if a]
    if not awks:
        return tests
    suite = unittest.TestSuite()
    for awk in awks:
        if not shutil.which(awk.split()[0]):
            raise RuntimeError(f"UNBROWSE_TEST_AWKS names {awk!r}, which isn't here")
        case = type(f"Install_{awk.split()[0].replace('-', '_')}", (Install,), {"awk": awk})
        suite.addTests(loader.loadTestsFromTestCase(case))
    return suite


if __name__ == "__main__":
    unittest.main()
