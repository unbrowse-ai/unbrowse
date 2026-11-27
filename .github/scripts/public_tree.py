"""The public tree: what unbrowse-ai/unbrowse gets of this repository, and the one way it is made.

    python3 -I .github/scripts/public_tree.py check            what would go public, checked; exit 1 on a problem
    python3 -I .github/scripts/public_tree.py sync --dest DIR [--report FILE --source SHA]
                                                               make a checkout of the public repo hold that tree

The public tree is every file git tracks here, less the paths in `.github/public-tree-exclude` (the contracts' sources
since UNB-158; the internal ledgers and the agents' and CI's process docs since 27 Nov 2026). A sync leaves the public
repository's own files alone (`.github/public-tree-keep`) and replaces the rest. `public-sync.yml` runs it on every push
to staging and opens the pull request into the public staging.

Before anything is copied, the tree is checked: no file names a client, a person's home folder or the owner's account
(23 Nov 2026), and no file links to a path the tree leaves out (a link that would 404 in public)."""
import argparse
import os
import pathlib
import re
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXCLUDE = ".github/public-tree-exclude"
KEEP = ".github/public-tree-keep"

# What must not reach the public tree, one `pattern<TAB>why` a line, in a file the public tree itself leaves out: a list
# of names to keep private is private too (27 Nov 2026: this list, kept here, went public in a sync pull request).
FORBIDDEN_LIST = ".github/public-tree-forbidden"


def forbidden(root=ROOT):
    """{pattern: why} from FORBIDDEN_LIST; empty where the list is absent (the public tree, where core's check ran)."""
    return dict(line.split("\t", 1) for line in listed(root, FORBIDDEN_LIST))


# A Markdown link's target: [text](target) or [text]: target. Text may run over lines; the target may not.
LINK = re.compile(r"\]\(\s*<?([^)\s>]+)>?(?:\s+\"[^\"]*\")?\s*\)|^\s*\[[^\]]+\]:\s*(\S+)", re.MULTILINE)


def listed(root, name):
    """The paths a list file names, one a line, # for a comment, a folder ending in /."""
    path = root / name
    if not path.is_file():
        return []
    return [l.strip() for l in path.read_text(encoding="utf-8").splitlines() if l.strip() and not l.startswith("#")]


def excluded(root=ROOT):
    return listed(root, EXCLUDE)


def kept(root=ROOT):
    return listed(root, KEEP)


def under(name, paths):
    return any(name == p or (p.endswith("/") and name.startswith(p)) for p in paths)


def tracked(root):
    out = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True).stdout
    return [n for n in out.decode().split("\0") if n]


def public_files(root=ROOT):
    skip = excluded(root)
    return [n for n in tracked(root) if not under(n, skip)]


def text_of(path):
    if path.is_symlink() or not path.is_file():
        return None
    data = path.read_bytes()
    if b"\0" in data[:8192]:
        return None
    return data.decode("utf-8", errors="ignore")


def names_found(root, files):
    """Each line of the public tree that names something forbidden(), as `file:line: why (match)`."""
    rules = forbidden(root)
    if not rules:
        return []
    pattern = re.compile("|".join(f"({p})" for p in rules), re.IGNORECASE)
    found = []
    for name in files:
        text = text_of(root / name)
        if text is None:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            m = pattern.search(line)
            if m:
                why = next(w for p, w in rules.items() if re.search(p, m.group(0), re.IGNORECASE))
                found.append(f"{name}:{n}: {why} ({m.group(0)})")
    return found


def links_out(root, files):
    """Each link in a public Markdown file to a path the public tree leaves out, as `file:line: link to path`."""
    skip = excluded(root)
    found = []
    for name in files:
        if not name.endswith((".md", ".mdx")):
            continue
        text = text_of(root / name)
        if text is None:
            continue
        for m in LINK.finditer(text):
            target = (m.group(1) or m.group(2)).split("#", 1)[0]
            if not target or re.match(r"^[a-z][a-z0-9+.-]*:", target, re.IGNORECASE):
                continue
            to = os.path.normpath(os.path.join(os.path.dirname(name), target)).replace(os.sep, "/")
            if under(to, skip) or under(to + "/", skip):
                line = text.count("\n", 0, m.start()) + 1
                found.append(f"{name}:{line}: links to {to}, which the public tree leaves out")
    return found


def list_kept_private(root):
    """The forbidden list must itself stay out of the public tree; where it is named there and absent, this is that tree."""
    if (root / FORBIDDEN_LIST).is_file() and not under(FORBIDDEN_LIST, excluded(root)):
        return [f"{FORBIDDEN_LIST}: the names to keep private would go public; add it to {EXCLUDE}"]
    if not (root / FORBIDDEN_LIST).is_file() and not under(FORBIDDEN_LIST, excluded(root)):
        return [f"{FORBIDDEN_LIST} is missing, so no name was checked"]
    return []


def problems(root=ROOT):
    files = public_files(root)
    return list_kept_private(root) + names_found(root, files) + links_out(root, files)


def sync(src, dest):
    """Make the checkout at dest hold src's public tree, keeping dest's own files. Returns (written, removed)."""
    files = public_files(src)
    keep = kept(src)
    wanted = set(files)
    removed = []
    for name in tracked(dest):
        if name not in wanted and not under(name, keep):
            (dest / name).unlink()
            removed.append(name)
    for name in files:
        if under(name, keep):
            continue
        a, b = src / name, dest / name
        if b.is_symlink() or b.is_file():
            b.unlink()
        elif b.is_dir():
            shutil.rmtree(b)
        b.parent.mkdir(parents=True, exist_ok=True)
        if a.is_symlink():
            os.symlink(os.readlink(a), b)
        else:
            shutil.copy2(a, b)
    subprocess.run(["git", "add", "-A"], cwd=dest, check=True)
    return files, removed


def overwritten(src, dest, names):
    """Each of names whose content on the public branch core never held: a change made on the public repository, which
    the sync replaces. As `file: subject of the public commit that last changed it`. Read from the content, not from
    commit titles: a public file whose bytes core had at any commit came from core."""
    if not names:
        return []
    listed = subprocess.run(["git", "ls-tree", "-r", "HEAD", "--", *names], cwd=dest, capture_output=True, text=True,
                            check=True).stdout.splitlines()
    public = {line.split("\t", 1)[1]: line.split()[2] for line in listed}
    raw = subprocess.run(["git", "log", "--all", "--format=", "--raw", "--no-abbrev", "--no-renames", "--", *names],
                         cwd=src, capture_output=True, text=True, check=True).stdout.splitlines()
    held = {blob for line in raw if line.startswith(":") for blob in line.split()[2:4]}
    found = []
    for name in names:
        if name in public and public[name] not in held:
            subject = subprocess.run(["git", "log", "-1", "--no-merges", "--format=%s", "HEAD", "--", name], cwd=dest,
                                     capture_output=True, text=True, check=True).stdout.strip()
            found.append(f"{name}: {subject}")
    return found


def report(src, dest, source, removed):
    """The sync pull request's body: what it brings, what it removes, and public's own changes it replaces."""
    out = subprocess.run(["git", "diff", "--cached", "--name-status", "--no-renames"], cwd=dest, capture_output=True,
                         text=True, check=True).stdout.splitlines()
    changed = [line.split("\t", 1)[1] for line in out if line[:1] in "MD"]
    lines = [f"unbrowse-core staging `{source}`, as the public tree: every file core tracks less the paths in "
             "`.github/public-tree-exclude`, with public's own (`.github/public-tree-keep`) left as they are. Made by "
             "`public-sync.yml` with `.github/scripts/public_tree.py`; checked first for client, home-folder and "
             "account names and for links to a path left out.", "",
             f"{len(out)} files change: {sum(l[:1] == 'A' for l in out)} added, {sum(l[:1] == 'M' for l in out)} "
             f"changed, {sum(l[:1] == 'D' for l in out)} removed.", ""]
    mine = overwritten(src, dest, changed)
    lines += ["## Public's own changes this replaces", ""]
    lines += ([f"- {m}" for m in mine] + ["", "Each was made on the public repository and is not in core: bring it to "
              "core first, or let this replace it."]) if mine else ["None."]
    lines += ["", "## Removed", ""] + ([f"- `{r}`" for r in sorted(removed)] if removed else ["None."])
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    s = sub.add_parser("sync")
    s.add_argument("--dest", required=True, type=pathlib.Path)
    s.add_argument("--report", type=pathlib.Path, help="write the pull request's body here")
    s.add_argument("--source", default="HEAD", help="the core commit being synced, for the report")
    args = ap.parse_args(argv)
    found = problems(ROOT)
    for line in found:
        print(f"::error::{line}")
    if found:
        print(f"PUBLIC_TREE_REFUSED {len(found)} problems: nothing was copied")
        return 1
    if args.cmd == "check":
        print(f"PUBLIC_TREE_OK {len(public_files(ROOT))} files, {len(forbidden(ROOT))} names checked; leaves out "
              f"{', '.join(excluded(ROOT))}")
        return 0
    written, removed = sync(ROOT, args.dest.resolve())
    if args.report:
        args.report.write_text(report(ROOT, args.dest.resolve(), args.source, removed))
    for name in removed:
        print(f"removed {name}")
    print(f"PUBLIC_TREE_SYNCED {len(written)} files; {len(removed)} removed from the public tree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
