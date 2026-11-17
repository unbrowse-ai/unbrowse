#!/usr/bin/env python3
"""Copies the unbrowse skill (skills/unbrowse/SKILL.md) into the plugins that can't link it.

Claude Code links skills/unbrowse. Codex skips symlinks when it installs a plugin, and OpenClaw and Hermes install a
plugin's folder alone, so each carries a copy. A copy is the root skill with its "## Connect (once)" section replaced
by the platform's own, the sections that don't apply to it dropped, and the platform's front matter added. Everything
else is the root skill's, word for word.

    python3 integrations/sync-skills.py           # write the copies
    python3 integrations/sync-skills.py --check   # write nothing; fail, naming each stale copy

unbrowse-sdk/codegen/generate.py writes the same copies with everything else the manifest and the skill imply (CI
runs its --check).

Run it after changing skills/unbrowse, and commit what it writes. Python 3.9+, nothing else.
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent / "skills" / "unbrowse" / "SKILL.md"

CODEX_CONNECT = """## Connect (once)

In Codex, the Unbrowse plugin (or `integrations/codex/install.sh`) adds the node's MCP server as `unbrowse`: the
`unbrowse mcp` command (`npm install -g unbrowse`), which reaches the node at `UNBROWSE_NODE` (default
`http://127.0.0.1:7788`). It reads your key's token from `UNBROWSE_AGENT_TOKEN` and signs each request with it, never
sending it, so the token must be set where Codex starts. `unbrowse agent token` prints the token of the key the node made on its
first run; the owner makes another with `unbrowse agent new <name>` or in the app (Money, Add agent):

```sh
export UNBROWSE_NODE=http://127.0.0.1:7788 UNBROWSE_AGENT_TOKEN="$(unbrowse agent token)"
```

`codex mcp list` (or `/mcp` in a session) shows the server. Use the `unbrowse_*` tools rather than `unb` in the shell:
Codex's default sandbox gives shell commands no network, and the tools are called by Codex itself.
"""

OPENCLAW_CONNECT = """## Connect (once)

The Unbrowse plugin gives you the node's tools (`unbrowse_do`, `unbrowse_browse`, `unbrowse_search`, `unbrowse_call`,
`unbrowse_logins`, `unbrowse_judge`, `unbrowse_report` and the rest). They reach the node with your key's token, from
the plugin's `agentToken` setting or `UNBROWSE_AGENT_TOKEN`. `unbrowse agent token` prints the token of the key the
node made on its first run; the owner makes another with `unbrowse agent new <name>` or in the app (Money, Add agent).
"""

HERMES_CONNECT = """## Connect (once)

The Unbrowse plugin gives you the node's tools in the `unbrowse` toolset (`unbrowse_do`, `unbrowse_browse`,
`unbrowse_search`, `unbrowse_call`, `unbrowse_logins`, `unbrowse_judge`, `unbrowse_report` and the rest). They reach
the node with your key's token, from `UNBROWSE_AGENT_TOKEN` in `~/.hermes/.env`. `unbrowse agent token` prints the
token of the key the node made on its first run; the owner makes another with `unbrowse agent new <name>` or in the
app (Money, Add agent).
"""

# No env the skill asks for: an add-on takes its own agent token from its plugin config (`agentToken`), never a token
# the whole process holds (32f47d9c).
OPENCLAW_META = """homepage: https://unbrowse.ai
"""

HERMES_META = """version: 0.1.0
author: Unbrowse
license: Apache-2.0
metadata:
  hermes:
    tags: [Web, Browser, API]
    requires_toolsets: [unbrowse]
"""

# Where each copy goes, the front matter it adds, its Connect section, and the root skill's sections it leaves out:
# OpenClaw and Hermes call the node through their own tools, so the install, shell and SDK sections aren't theirs.
TARGETS = [
    (HERE / "codex" / "plugins" / "unbrowse" / "skills" / "unbrowse" / "SKILL.md", "", CODEX_CONNECT, ()),
    (
        HERE / "openclaw" / "skills" / "unbrowse" / "SKILL.md",
        OPENCLAW_META,
        OPENCLAW_CONNECT,
        ("## Install (once)", "## CLI", "## TypeScript and Python"),
    ),
    (
        HERE / "hermes" / "skills" / "unbrowse" / "SKILL.md",
        HERMES_META,
        HERMES_CONNECT,
        ("## Install (once)", "## CLI", "## TypeScript and Python"),
    ),
]


def sections(body: str) -> list:
    """The body cut at each "## " heading: the text before the first, then one piece per section, heading first."""
    out, cur = [], []
    for line in body.splitlines(keepends=True):
        if line.startswith("## ") and cur:
            out.append("".join(cur))
            cur = []
        cur.append(line)
    if cur:
        out.append("".join(cur))
    return out


def copy_for(source: str, meta: str, connect: str, drop: tuple) -> str:
    if not source.startswith("---\n"):
        raise SystemExit(f"sync-skills: {SOURCE} has no front matter")
    end = source.index("\n---\n", 4)
    front, body = source[4 : end + 1], source[end + 5 :]
    pieces = sections(body)
    heads = [p.splitlines()[0].rstrip() for p in pieces]
    if "## Connect (once)" not in heads:
        raise SystemExit(f"sync-skills: no '## Connect (once)' section in {SOURCE}")
    for d in drop:
        if d not in heads:
            raise SystemExit(f"sync-skills: no '{d}' section in {SOURCE}; change TARGETS in {Path(__file__).name}")
    kept = []
    for head, piece in zip(heads, pieces):
        if head in drop:
            continue
        kept.append(connect + "\n" if head == "## Connect (once)" else piece)
    return f"---\n{front}{meta}---\n{''.join(kept)}"


def main(argv: list) -> int:
    check = "--check" in argv
    source = SOURCE.read_text(encoding="utf-8")
    stale = []
    for path, meta, connect, drop in TARGETS:
        want = copy_for(source, meta, connect, drop)
        have = path.read_text(encoding="utf-8") if path.exists() else None
        if have == want:
            continue
        rel = path.relative_to(HERE.parent)
        if check:
            stale.append(str(rel))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(want, encoding="utf-8")
            print(f"wrote {rel}")
    if stale:
        print("sync-skills: these copies of skills/unbrowse are stale; run python3 integrations/sync-skills.py:", file=sys.stderr)
        for s in stale:
            print(f"  {s}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
