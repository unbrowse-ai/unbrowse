#!/usr/bin/env python3
"""Takes an SDK-polish draft's files into a checkout, as data (.github/workflows/sdk-polish.yml, `propose`).

The draft was written by a model in a job with no write token; this runs in the job that has one. So it copies only
regular files, only under the paths a draft may change (the hand-written SDK layers, their tests and READMEs, the
skill, and the plugins' tool lists), and nothing else: not the generator, not a workflow, not a script this job runs.
A link, or a path that climbs out, is refused. The draft's pull request text is kept apart, capped.

    python3 -I .github/scripts/sdk-polish-take.py <draft-dir> <checkout> --body <file> --github-output <file>

Writes `body=true` when the draft asked for a pull request (it wrote sdk-polish-pr.md), else `body=false`.
"""

import argparse
from pathlib import Path, PurePosixPath
import shutil
import sys

# Folders a draft may change, and single files. The generated files under them are rewritten by the generator after.
FOLDERS = (
    "unbrowse-sdk/typescript/src",
    "unbrowse-sdk/typescript/test",
    "unbrowse-sdk/python/src/unbrowse",
    "unbrowse-sdk/python/tests",
    "skills/unbrowse",
)
FILES = (
    "unbrowse-sdk/typescript/README.md",
    "unbrowse-sdk/python/README.md",
    "integrations/openclaw/openclaw.plugin.json",
    "integrations/hermes/plugin.yaml",
    "integrations/hermes/tools.py",
)
BODY = "sdk-polish-pr.md"
MAX_BODY = 60_000


def allowed(relative: PurePosixPath) -> bool:
    if relative.is_absolute() or ".." in relative.parts:
        return False
    text = relative.as_posix()
    return text in FILES or any(text.startswith(folder + "/") for folder in FOLDERS)


def take(draft: Path, checkout: Path) -> list[str]:
    """Copies the draft's allowed files into `checkout`; returns what it took. Refuses a link anywhere in the draft."""
    taken = []
    for path in sorted(draft.rglob("*")):
        if path.is_symlink():
            raise ValueError(f"{path.relative_to(draft)} is a link")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError(f"{path.relative_to(draft)} is not a regular file")
        relative = PurePosixPath(path.relative_to(draft).as_posix())
        if relative.as_posix() == BODY or not allowed(relative):
            continue
        # A folder or file of the checkout that is a link would carry the copy elsewhere.
        target = checkout
        for part in relative.parts:
            target = target / part
            if target.is_symlink():
                raise ValueError(f"{target.relative_to(checkout)} is a link in the checkout")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
        taken.append(relative.as_posix())
    return taken


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("draft", type=Path)
    parser.add_argument("checkout", type=Path)
    parser.add_argument("--body", type=Path, required=True)
    parser.add_argument("--github-output", type=Path, required=True)
    args = parser.parse_args()
    body = args.draft / BODY
    wants = body.is_file() and not body.is_symlink() and body.read_text(encoding="utf-8", errors="replace").strip() != ""
    try:
        taken = take(args.draft, args.checkout) if wants else []
    except (OSError, ValueError) as error:
        print(f"sdk-polish-take: {error}", file=sys.stderr)
        return 1
    if wants:
        text = body.read_text(encoding="utf-8", errors="replace")[:MAX_BODY]
        args.body.write_text(text + "\n\n---\nDrafted by Claude in the SDK polish workflow; a person reviews it before it merges.\n", encoding="utf-8")
    with args.github_output.open("a", encoding="utf-8") as output:
        output.write(f"body={'true' if wants else 'false'}\n")
    print(f"took {len(taken)} files" if wants else "the draft asked for no pull request")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
