#!/usr/bin/env python3
"""The skills this repository ships (skills/*/SKILL.md), checked without a model (UNB-235).

A skill is read by an agent that will act on every word of it, so what it names must exist:
- its frontmatter has the folder's `name` and a `description` an agent can choose it by (the description is what makes
  it trigger: 50 to 1024 characters);
- every file it links or names (`[x](references/a.md)`, `scripts/unbrowse-verify`) is there;
- every node tool it names (`unbrowse_do`, ...) is one the node lists now (`--tools`, the tools.json mcp_check.py
  writes from a running node). A renamed or removed tool leaves the skill teaching a call that fails.

    python3 .github/qa/skill_check.py [--skills skills] [--tools <out>/tools.json] --out <folder>

Writes <folder>/skill-check.json and skill-check.md. Exits 1 on any problem.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LINK = re.compile(r"\]\(([^)\s#]+)(?:#[^)]*)?\)")
NAMED_FILE = re.compile(r"`((?:scripts|references|assets)/[A-Za-z0-9_./-]+)`")
TOOL = re.compile(r"\bunbrowse_[a-z]+(?:_[a-z]+)*\b")


def frontmatter(text):
    if not text.startswith("---\n"):
        return {}
    head = text[4 : text.find("\n---", 4)]
    out = {}
    for line in head.splitlines():
        if ":" in line and not line.startswith(" "):
            key, value = line.split(":", 1)
            out[key.strip()] = value.strip().strip('"')
    return out


def check(skill_dir, tools):
    text = (skill_dir / "SKILL.md").read_text()
    meta = frontmatter(text)
    problems = []
    if meta.get("name") != skill_dir.name:
        problems.append(f"frontmatter name is {meta.get('name')!r}, the folder {skill_dir.name!r}")
    description = meta.get("description", "")
    if not 50 <= len(description) <= 1024:
        problems.append(f"description is {len(description)} characters: 50 to 1024 lets an agent choose by it")
    for target in sorted(set(LINK.findall(text)) | set(NAMED_FILE.findall(text))):
        if re.match(r"^[a-z]+:", target) or target.startswith("/"):
            continue
        if not (skill_dir / target).exists():
            problems.append(f"names {target}, which isn't there")
    named = sorted(set(TOOL.findall(text)))
    if tools is not None:
        for tool in named:
            if tool not in tools:
                problems.append(f"names {tool}, which the node doesn't list")
    return {"skill": skill_dir.name, "pass": not problems, "problems": problems, "tools_named": named}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--skills", type=Path, default=ROOT / "skills")
    parser.add_argument("--tools", type=Path, help="tools.json from mcp_check.py; without it tool names aren't checked")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    tools = {t["name"] for t in json.loads(args.tools.read_text())} if args.tools and args.tools.exists() else None
    results = [check(d, tools) for d in sorted(p.parent for p in args.skills.glob("*/SKILL.md"))]
    result = {"pass": bool(results) and all(r["pass"] for r in results), "tools_checked": tools is not None, "skills": results}
    lines = [f"**Skill check: {'pass' if result['pass'] else 'fail'}.** {sum(r['pass'] for r in results)} of {len(results)} skills sound"
             + ("" if tools is not None else " (tool names not checked: no tools.json)") + ".", "", "| Skill | Result | Node tools it names |", "| --- | --- | --- |"]  # fmt: skip
    for r in results:
        lines.append(f"| {r['skill']} | {'pass' if r['pass'] else '**fail**: ' + '; '.join(r['problems'])} | {', '.join(r['tools_named']) or 'none'} |")
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "skill-check.json").write_text(json.dumps(result, indent=2) + "\n")
    (args.out / "skill-check.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
