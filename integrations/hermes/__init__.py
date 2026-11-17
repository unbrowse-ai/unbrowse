"""Unbrowse for Hermes Agent: every agent tool the Unbrowse node serves, as native Hermes tools in the ``unbrowse``
toolset, and the skill that says how to use them (``skill_view("unbrowse:unbrowse")``)."""

from __future__ import annotations

from pathlib import Path

from . import tools

TOOLSET = "unbrowse"

SKILL = Path(__file__).resolve().parent / "skills" / "unbrowse" / "SKILL.md"


def register(ctx) -> None:
    for schema, handler in tools.tools():
        ctx.register_tool(
            name=schema["name"],
            toolset=TOOLSET,
            schema=schema,
            handler=handler,
            check_fn=tools.available,
            requires_env=["UNBROWSE_AGENT_TOKEN"],
        )
    ctx.register_skill("unbrowse", SKILL)
