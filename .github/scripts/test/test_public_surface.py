"""The public repository (unbrowse-ai/unbrowse) gets this tree, minus .github/public-tree-exclude, made by
.github/scripts/public_tree.py (public-sync.yml runs it on every push to staging). Nothing in it may name a client, a
person's home folder or the owner's Cloudflare account (23 Nov 2026: public main carried a client's worker name in
.deploy/soak.mjs, a client repo in AGENTS.md, /Users/<owner> and the account's workers.dev subdomain), the internal docs
stay out of it (Lewis, 27 Nov 2026: "scrub public repo on CI for unnecessary docs like REQUIREMENTS.md"), and no
public file links to one of them.

Runner labels (the Deck pool's and the Mac's) are not listed: workflows select runners by them, and renaming them means
registering the runners again."""
import importlib.util
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("public_tree", ROOT / ".github/scripts/public_tree.py")
public_tree = importlib.util.module_from_spec(spec)
spec.loader.exec_module(public_tree)


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def repo(top, files):
    top.mkdir(parents=True)
    git(top, "init", "-q")
    for name, text in files.items():
        (top / name).parent.mkdir(parents=True, exist_ok=True)
        (top / name).write_text(text)
    git(top, "add", "-A")
    return top


class PublicSurface(unittest.TestCase):
    def test_the_public_tree_names_no_client_home_folder_or_account_and_links_nowhere_it_leaves_out(self):
        found = public_tree.problems(ROOT)
        self.assertEqual(found, [], "\n" + "\n".join(found))

    def test_the_internal_ledgers_and_process_docs_stay_out(self):
        files = set(public_tree.public_files(ROOT))
        for name in ("docs/REQUIREMENTS.md", "docs/CI-AGENTS.md", "docs/spec-status/part-1.md",
                     "unbrowse-settlement/README.md", ".github/workflows/public-sync.yml"):
            self.assertNotIn(name, files)
        # What public CI reads stays: test_release_order.py, engine_is_general.rs, promotion_gate.py.
        for name in ("docs/OPERATIONS.md", "docs/GENERALITY.md", "docs/COVERAGE-EXCLUSIONS.md", "README.md"):
            self.assertIn(name, files)

    def test_a_link_to_a_path_left_out_is_refused_and_one_elsewhere_is_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            top = repo(pathlib.Path(tmp) / "core", {
                ".github/public-tree-exclude": "# a comment\ndocs/LEDGER.md\nprivate/\n",
                "docs/LEDGER.md": "rows",
                "docs/README.md": "[ledger](LEDGER.md#row) and [a\nfolder](../private/x.md) and "
                                  "[ok](GUIDE.md) and [site](https://example.com/LEDGER.md)\n[ref]: ./LEDGER.md\n",
                "docs/GUIDE.md": "plain `docs/LEDGER.md` mention is not a link",
                "private/x.md": "x",
            })
            self.assertEqual(public_tree.links_out(top, public_tree.public_files(top)), [
                "docs/README.md:1: links to docs/LEDGER.md, which the public tree leaves out",
                "docs/README.md:2: links to private/x.md, which the public tree leaves out",
                "docs/README.md:3: links to docs/LEDGER.md, which the public tree leaves out",
            ])

    def test_a_forbidden_name_is_found_wherever_it_sits(self):
        with tempfile.TemporaryDirectory() as tmp:
            top = repo(pathlib.Path(tmp) / "core", {
                ".github/public-tree-forbidden": "# names\nacme ?corp\ta client's name\n/home/someone\ta home folder\n",
                ".github/public-tree-exclude": ".github/public-tree-forbidden\n",
                ".deploy/soak.mjs": "const w = 'acmecorp-worker';\n",
                ".github/scripts/test/test_x.py": "HOME = '/home/someone/work'\n",
                "README.md": "nothing here\n",
            })
            found = public_tree.names_found(top, public_tree.public_files(top))
            self.assertEqual(found, [".deploy/soak.mjs:1: a client's name (acmecorp)",
                                     ".github/scripts/test/test_x.py:1: a home folder (/home/someone)"])
            self.assertEqual(public_tree.problems(top), found)

    def test_the_names_to_keep_out_are_never_in_the_public_tree_themselves(self):
        # 27 Nov 2026: the list sat in public_tree.py and its test, and a sync pull request published it.
        self.assertIn(".github/public-tree-forbidden", public_tree.excluded(ROOT))
        self.assertTrue(public_tree.forbidden(ROOT), "core holds the list, so the check reads names")
        for name in (".github/scripts/public_tree.py", ".github/scripts/test/test_public_surface.py"):
            text = (ROOT / name).read_text()
            for pattern in public_tree.forbidden(ROOT):
                self.assertIsNone(public_tree.re.search(pattern, text, public_tree.re.IGNORECASE), (name, pattern))
        with tempfile.TemporaryDirectory() as tmp:
            listed = repo(pathlib.Path(tmp) / "a", {".github/public-tree-forbidden": "x\ty\n"})
            self.assertIn("would go public", public_tree.list_kept_private(listed)[0])
            missing = repo(pathlib.Path(tmp) / "b", {"README.md": "x"})
            self.assertIn("no name was checked", public_tree.list_kept_private(missing)[0])
            public = repo(pathlib.Path(tmp) / "c", {".github/public-tree-exclude": ".github/public-tree-forbidden\n"})
            self.assertEqual(public_tree.list_kept_private(public), [])

    def test_a_sync_replaces_the_public_tree_keeps_what_public_owns_and_leaves_out_the_excluded(self):
        with tempfile.TemporaryDirectory() as tmp:
            core = repo(pathlib.Path(tmp) / "core", {
                ".github/public-tree-exclude": "docs/REQUIREMENTS.md\nunbrowse-settlement/\n",
                ".github/public-tree-keep": "CHANGELOG.md\n.github/promotion-waivers\n",
                "README.md": "new readme",
                "docs/REQUIREMENTS.md": "ledger",
                "unbrowse-settlement/src/Pool.sol": "contract",
                "CHANGELOG.md": "core's changelog, never public's",
            })
            (core / "bin").mkdir()
            (core / "bin/run").write_text("#!/bin/sh\n")
            (core / "bin/run").chmod(0o755)
            (core / "link").symlink_to("README.md")
            git(core, "add", "-A")
            public = repo(pathlib.Path(tmp) / "public", {
                "README.md": "old readme",
                "docs/REQUIREMENTS.md": "a ledger an earlier sync let through",
                "stale.yml": "a workflow core deleted",
                "CHANGELOG.md": "public's release notes",
                ".github/promotion-waivers": "13.1.0 coverage",
            })
            written, removed = public_tree.sync(core, public)
            self.assertEqual(sorted(removed), ["docs/REQUIREMENTS.md", "stale.yml"])
            self.assertEqual((public / "README.md").read_text(), "new readme")
            self.assertEqual((public / "CHANGELOG.md").read_text(), "public's release notes")
            self.assertEqual((public / ".github/promotion-waivers").read_text(), "13.1.0 coverage")
            self.assertFalse((public / "unbrowse-settlement").exists())
            self.assertTrue((public / "link").is_symlink())
            self.assertTrue((public / "bin/run").stat().st_mode & 0o100)
            staged = subprocess.run(["git", "ls-files"], cwd=public, capture_output=True, text=True, check=True).stdout
            self.assertEqual(sorted(staged.split()), sorted([
                ".github/promotion-waivers", ".github/public-tree-exclude", ".github/public-tree-keep", "CHANGELOG.md",
                "README.md", "bin/run", "link"]))

    def test_the_report_names_public_s_own_changes_a_sync_replaces_and_not_what_came_from_core(self):
        with tempfile.TemporaryDirectory() as tmp:
            ident = ["-c", "user.name=t", "-c", "user.email=t@t"]
            core = repo(pathlib.Path(tmp) / "core", {"a.md": "old a", "b.md": "old b", "c.md": "c"})
            git(core, *ident, "commit", "-q", "-m", "an earlier core")
            (core / "a.md").write_text("new a")
            (core / "b.md").write_text("new b")
            git(core, *ident, "commit", "-qam", "core moves on")
            # Public's a.md is core's earlier bytes, under a title that says nothing of a sync; b.md is public's own fix.
            public = repo(pathlib.Path(tmp) / "public", {"a.md": "old a", "b.md": "public's fix", "gone.md": "x"})
            git(public, *ident, "commit", "-q", "-m", "feat: Unbrowse 13 (#198)")
            (public / "b.md").write_text("public's fix, again")
            git(public, *ident, "commit", "-qam", "fix(qa): use the grant date (#230)")
            _, removed = public_tree.sync(core, public)
            body = public_tree.report(core, public, "abc123", removed)
            self.assertIn("- b.md: fix(qa): use the grant date (#230)", body)
            self.assertNotIn("- a.md", body)
            self.assertIn("- gone.md: feat: Unbrowse 13 (#198)", body)
            self.assertIn("- `gone.md`", body)
            self.assertIn("4 files change: 1 added, 2 changed, 1 removed.", body)

    def test_the_sync_refuses_and_copies_nothing_when_the_tree_has_a_problem(self):
        with tempfile.TemporaryDirectory() as tmp:
            core = repo(pathlib.Path(tmp) / "core", {
                ".github/public-tree-forbidden": "/home/someone\ta home folder\n",
                ".github/public-tree-exclude": ".github/public-tree-forbidden\n",
                "a.md": "see /home/someone/x",
            })
            public = repo(pathlib.Path(tmp) / "public", {"b.md": "kept"})
            old = public_tree.ROOT
            public_tree.ROOT = core
            try:
                self.assertEqual(public_tree.main(["sync", "--dest", str(public)]), 1)
            finally:
                public_tree.ROOT = old
            self.assertEqual((public / "b.md").read_text(), "kept")
            self.assertFalse((public / "a.md").exists())


if __name__ == "__main__":
    unittest.main()
