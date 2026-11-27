#!/usr/bin/env python3
"""Checks the agent plugins in integrations/ and the marketplaces at the repository root, without installing anything.

- every JSON file parses: the marketplaces, each plugin's manifest and MCP config, the packages;
- every path a marketplace or manifest names exists, and is the plugin it should be;
- every symbolic link resolves, inside the repository;
- the tools each plugin declares up front, and the skill's copies, are what unbrowse-sdk/codegen/generate.py writes from
  unbrowse-node/agent-api.json and skills/unbrowse (its --check);
- every relative link in the integrations' READMEs points at a file that exists.

    python3 integrations/check.py

CI runs it. Python 3.9+, nothing else.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
SKIP = {"node_modules", "dist", "__pycache__", ".git"}

problems = []


def fail(msg: str) -> None:
    problems.append(msg)


def rel(p: Path) -> str:
    try:
        return str(p.relative_to(REPO))
    except ValueError:
        return str(p)


def walk(root: Path):
    for d, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if x not in SKIP]
        for name in files + [x for x in dirs if (Path(d) / x).is_symlink()]:
            yield Path(d) / name


def load_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"{rel(p)}: missing")
    except ValueError as e:
        fail(f"{rel(p)}: doesn't parse as JSON: {e}")
    return None


def must_exist(p: Path, what: str) -> bool:
    if not p.exists():
        fail(f"{what}: {rel(p)} doesn't exist")
        return False
    return True


def inside_repo(p: Path, what: str) -> Path:
    real = p.resolve()
    if REPO not in real.parents and real != REPO:
        fail(f"{what}: {rel(p)} points outside the repository")
    return real


# ---- every JSON file, every link ----

json_files = [REPO / ".claude-plugin" / "marketplace.json", REPO / ".agents" / "plugins" / "marketplace.json"]
for p in walk(HERE):
    if p.is_symlink():
        target = os.readlink(p)
        if not p.exists():
            fail(f"{rel(p)}: link to {target} doesn't resolve")
        else:
            inside_repo(p, f"link {rel(p)}")
    elif p.suffix == ".json":
        json_files.append(p)
for p in json_files:
    load_json(p)

# ---- the Claude Code marketplace and plugin ----

claude_market = load_json(REPO / ".claude-plugin" / "marketplace.json") or {}
for entry in claude_market.get("plugins", []):
    src = entry.get("source")
    if not isinstance(src, str) or not src.startswith("./"):
        fail(f".claude-plugin/marketplace.json: {entry.get('name')}'s source should be a ./ path, not {src!r}")
        continue
    plugin = REPO / src
    if not must_exist(plugin / ".claude-plugin" / "plugin.json", f"Claude Code plugin {entry.get('name')}"):
        continue
    manifest = load_json(plugin / ".claude-plugin" / "plugin.json") or {}
    if manifest.get("name") != entry.get("name"):
        fail(f"{src}: plugin.json names {manifest.get('name')!r}, the marketplace {entry.get('name')!r}")
    user_config = set((manifest.get("userConfig") or {}).keys())
    mcp_path = plugin / ".mcp.json"
    if must_exist(mcp_path, f"Claude Code plugin {entry.get('name')}'s MCP servers"):
        text = mcp_path.read_text(encoding="utf-8")
        for name in re.findall(r"\$\{user_config\.([A-Za-z0-9_]+)\}", text):
            if name not in user_config:
                fail(f"{rel(mcp_path)}: ${{user_config.{name}}} isn't in plugin.json's userConfig")
        servers = (load_json(mcp_path) or {}).get("mcpServers", {})
        for sname, server in servers.items():
            # The token goes through `unbrowse mcp`, which proves the node first; an HTTP entry hands it to the client.
            if server.get("command") != "unbrowse" or (server.get("args") or [None])[0] != "mcp" or "--agent" not in (server.get("args") or []) or "UNBROWSE_AGENT_TOKEN" in json.dumps(server) or "url" in server or "headers" in server:
                fail(f"{rel(mcp_path)}: server {sname} should start `unbrowse mcp`, never send the token itself")
    skills = plugin / "skills"
    if skills.is_dir():
        for skill in skills.iterdir():
            must_exist(skill / "SKILL.md", f"Claude Code plugin skill {skill.name}")

# ---- the Codex marketplace and plugin ----

codex_market = load_json(REPO / ".agents" / "plugins" / "marketplace.json") or {}
for entry in codex_market.get("plugins", []):
    src = (entry.get("source") or {}).get("path")
    if not isinstance(src, str) or not src.startswith("./"):
        fail(f".agents/plugins/marketplace.json: {entry.get('name')}'s source.path should be a ./ path, not {src!r}")
        continue
    plugin = REPO / src
    if not must_exist(plugin / ".codex-plugin" / "plugin.json", f"Codex plugin {entry.get('name')}"):
        continue
    manifest = load_json(plugin / ".codex-plugin" / "plugin.json") or {}
    if manifest.get("name") != entry.get("name"):
        fail(f"{src}: plugin.json names {manifest.get('name')!r}, the marketplace {entry.get('name')!r}")
    for key in ("skills", "mcpServers"):
        if key in manifest:
            must_exist(plugin / manifest[key], f"Codex plugin.json's {key}")
    for skill in (plugin / manifest.get("skills", "skills")).iterdir():
        if skill.is_symlink():
            fail(f"{rel(skill)}: Codex skips links when it installs a plugin; carry a copy (integrations/sync-skills.py)")
        must_exist(skill / "SKILL.md", f"Codex plugin skill {skill.name}")
    servers = (load_json(plugin / manifest.get("mcpServers", ".mcp.json")) or {}).get("mcpServers", {})
    for sname, server in servers.items():
        if (
            server.get("command") != "unbrowse"
            or (server.get("args") or [None])[0] != "mcp"
            or "--agent" not in (server.get("args") or [])
            or "UNBROWSE_AGENT_TOKEN" in json.dumps(server)
            or "url" in server
            or "bearer_token_env_var" in server
        ):
            fail(f"{src}: server {sname} should start `unbrowse mcp --agent <which>`, naming the agent, never carrying or sending its token")

# ---- the tools each plugin declares, against what the node serves ----

api = load_json(REPO / "unbrowse-node" / "agent-api.json") or {}
served = [p["tool"] for p in api.get("primitives", [])]
if not served:
    fail("unbrowse-node/agent-api.json lists no primitives")


openclaw = load_json(HERE / "openclaw" / "openclaw.plugin.json") or {}
for d in openclaw.get("skills", []):
    must_exist(HERE / "openclaw" / d, "openclaw.plugin.json's skills")
openclaw_pkg = load_json(HERE / "openclaw" / "package.json") or {}
for f in openclaw_pkg.get("files", []):
    if f != "dist":
        must_exist(HERE / "openclaw" / f, "openclaw/package.json's files")

# ---- the skill and its copies ----

for skill in [REPO / "skills" / "unbrowse" / "SKILL.md", *HERE.glob("*/skills/unbrowse/SKILL.md"), *HERE.glob("*/plugins/*/skills/unbrowse/SKILL.md")]:
    text = skill.read_text(encoding="utf-8") if skill.exists() else ""
    if not re.match(r"---\nname: unbrowse\ndescription: .{80,}\n", text):
        fail(f"{rel(skill)}: front matter should open with name: unbrowse and a description")
    # A bounty is released or a report declined only on the owner's yes (`autobounty::answer`): the skill must never tell
    # an agent its own word does it.
    bounties = text.split("**Bounties**", 1)[1].split("\n\n", 1)[0] if "**Bounties**" in text else ""
    if bounties and not ("your owner" in bounties and "their yes" in bounties):
        fail(f"{rel(skill)}: the Bounties paragraph must say a release or a decline waits on the owner's yes")
# The plugins' tool lists and the skill's copies are written by the generator, from agent-api.json and skills/unbrowse:
# the same check CI's SDK job runs.
r = subprocess.run([sys.executable, "-I", str(REPO / "unbrowse-sdk" / "codegen" / "generate.py"), "--check"], capture_output=True, text=True)
if r.returncode:
    fail(r.stderr.strip() or "generate.py --check failed")

# ---- links in the READMEs, and words that are no longer true ----

# Where an agent key is made: `unbrowse agent new <name>` on any install, or the window's Agents screen, whose Add agent
# shows once Settings has Show advanced screens on (window/src/screens/access.zig). Money has no Add agent of its own.
KEY_PLACE = "`unbrowse agent token` prints the first key's token; `unbrowse agent new <name>` makes another, as the app's Agents screen does (Add agent)"
STALE = {
    "Wallet, New agent key": f"there is no Wallet screen: {KEY_PLACE}",
    "Money, Add agent": f"Money has no Add agent: {KEY_PLACE}",
    "Money (Add agent": f"Money has no Add agent: {KEY_PLACE}",
    "window's New agent key": f"the window's button is Add agent, on Agents: {KEY_PLACE}",
    # unbrowse-core is private: its releases answer 404 to everyone outside the org. Releases are public on unbrowse-ai/unbrowse.
    "unbrowse-core/releases": "unbrowse-core is private, so outsiders get a 404: link https://github.com/unbrowse-ai/unbrowse/releases",
}
# The plugins only: the SDKs still accept pays_usd from older code, and ignore it with a warning.
STALE_HERE = {"pays_usd": "the node pays a route's fee itself; no tool takes pays_usd"}
for md in [*HERE.glob("**/*.md")]:
    if SKIP & set(md.relative_to(HERE).parts):
        continue
    text = md.read_text(encoding="utf-8")
    for target in re.findall(r"\]\(([^)\s]+)\)", text):
        if re.match(r"[a-z]+:", target) or target.startswith("#"):
            continue
        path = target.split("#", 1)[0]
        if path and not (md.parent / path).exists():
            fail(f"{rel(md)}: link to {target} doesn't resolve")
# What a developer reads on the way to a first call: the integrations, the SDKs, the README, the docs, the skill and the
# installers' notes.
WORDED = [HERE, REPO / "unbrowse-sdk", REPO / "docs", REPO / "skills", REPO / "README.md", REPO / ".github" / "scripts"]
for p in (q for root in WORDED for q in (walk(root) if root.is_dir() else [root])):
    # The tests name the stale words to check they're gone.
    if p.is_file() and p.suffix in {".md", ".json", ".ts", ".py", ".yaml", ".sh", ".toml"} and p.name != "check.py" and not {"test", "tests"} & set(p.parts):
        text = p.read_text(encoding="utf-8")
        stale = {**STALE, **STALE_HERE} if HERE in p.parents else STALE
        for words, why in stale.items():
            if words in text:
                fail(f"{rel(p)}: says {words!r}, which is no longer true: {why}")

if problems:
    print(f"integrations/check.py: {len(problems)} problem(s)", file=sys.stderr)
    for p in problems:
        print(f"  {p}", file=sys.stderr)
    sys.exit(1)
print(f"integrations: {len(json_files)} JSON files parse, the marketplaces' plugins and links resolve, and every plugin declares the node's {len(served)} tools")
