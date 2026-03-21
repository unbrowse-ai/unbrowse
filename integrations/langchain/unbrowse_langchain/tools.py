"""LangChain tools that wrap the Unbrowse CLI."""

from __future__ import annotations

import json
import subprocess
from typing import Any, List, Optional, Type

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field


def _run_unbrowse(args: list[str], *, bin_path: str = "unbrowse", timeout: int = 120) -> str:
    """Shell out to the unbrowse CLI and return stdout."""
    try:
        result = subprocess.run(
            [bin_path, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        return json.dumps({"ok": False, "error": f"unbrowse binary not found at '{bin_path}'"})
    except subprocess.TimeoutExpired:
        return json.dumps({"ok": False, "error": f"Command timed out after {timeout}s"})

    if result.returncode != 0:
        return json.dumps({
            "ok": False,
            "error": result.stderr.strip() or result.stdout.strip() or f"exit code {result.returncode}",
        })
    return result.stdout.strip() or json.dumps({"ok": True})


# ---------------------------------------------------------------------------
# Pydantic arg schemas
# ---------------------------------------------------------------------------

class ResolveArgs(BaseModel):
    intent: str = Field(description="Plain-English description of what you want from the page")
    url: str = Field(description="Target website URL")
    path: Optional[str] = Field(default=None, description="Response path extraction hint")
    extract: Optional[str] = Field(default=None, description="Comma-separated fields or alias:path spec")
    limit: Optional[int] = Field(default=None, description="Max items to return (1-200)")
    pretty: Optional[bool] = Field(default=None, description="Pretty-print output")
    dry_run: Optional[bool] = Field(default=None, description="Preview without side effects")
    confirm_unsafe: Optional[bool] = Field(default=None, description="Allow non-GET execution")


class SearchArgs(BaseModel):
    intent: str = Field(description="Plain-English search intent for the skill marketplace")
    domain: Optional[str] = Field(default=None, description="Domain filter")


class ExecuteArgs(BaseModel):
    skill_id: str = Field(description="Skill ID to execute")
    endpoint_id: str = Field(description="Endpoint ID within the skill")
    path: Optional[str] = Field(default=None, description="Response path extraction hint")
    extract: Optional[str] = Field(default=None, description="Comma-separated fields or alias:path spec")
    limit: Optional[int] = Field(default=None, description="Max items to return (1-200)")
    pretty: Optional[bool] = Field(default=None, description="Pretty-print output")
    dry_run: Optional[bool] = Field(default=None, description="Preview without side effects")
    confirm_unsafe: Optional[bool] = Field(default=None, description="Allow non-GET execution")


class LoginArgs(BaseModel):
    url: str = Field(description="URL of the site to log in to")


class SkillArgs(BaseModel):
    skill_id: str = Field(description="Skill ID to inspect")


def _push_flag(args: list[str], name: str, value: Any) -> None:
    if value is None or value is False:
        return
    args.append(f"--{name}")
    if value is not True:
        args.append(str(value))


# ---------------------------------------------------------------------------
# Tool classes
# ---------------------------------------------------------------------------

class _UnbrowseBase(BaseTool):
    """Base for all unbrowse tools — holds shared config."""

    bin_path: str = "unbrowse"
    timeout: int = 120

    def _call_cli(self, args: list[str]) -> str:
        return _run_unbrowse(args, bin_path=self.bin_path, timeout=self.timeout)


class UnbrowseResolveTool(_UnbrowseBase):
    name: str = "unbrowse_resolve"
    description: str = (
        "Reverse-engineer a website into an API skill. Provide a URL and a plain-English "
        "intent describing what data you want. Returns structured API data."
    )
    args_schema: Type[BaseModel] = ResolveArgs

    def _run(self, intent: str, url: str, **kwargs: Any) -> str:
        args = ["resolve", "--intent", intent, "--url", url]
        _push_flag(args, "path", kwargs.get("path"))
        _push_flag(args, "extract", kwargs.get("extract"))
        _push_flag(args, "limit", kwargs.get("limit"))
        _push_flag(args, "pretty", kwargs.get("pretty"))
        _push_flag(args, "dry-run", kwargs.get("dry_run"))
        _push_flag(args, "confirm-unsafe", kwargs.get("confirm_unsafe"))
        return self._call_cli(args)


class UnbrowseSearchTool(_UnbrowseBase):
    name: str = "unbrowse_search"
    description: str = (
        "Search the Unbrowse skill marketplace for pre-built API skills. "
        "Provide a plain-English intent describing what you need."
    )
    args_schema: Type[BaseModel] = SearchArgs

    def _run(self, intent: str, **kwargs: Any) -> str:
        args = ["search", "--intent", intent]
        _push_flag(args, "domain", kwargs.get("domain"))
        return self._call_cli(args)


class UnbrowseExecuteTool(_UnbrowseBase):
    name: str = "unbrowse_execute"
    description: str = (
        "Execute a previously resolved or marketplace API skill endpoint. "
        "Requires a skill ID and endpoint ID."
    )
    args_schema: Type[BaseModel] = ExecuteArgs

    def _run(self, skill_id: str, endpoint_id: str, **kwargs: Any) -> str:
        args = ["execute", "--skill", skill_id, "--endpoint", endpoint_id]
        _push_flag(args, "path", kwargs.get("path"))
        _push_flag(args, "extract", kwargs.get("extract"))
        _push_flag(args, "limit", kwargs.get("limit"))
        _push_flag(args, "pretty", kwargs.get("pretty"))
        _push_flag(args, "dry-run", kwargs.get("dry_run"))
        _push_flag(args, "confirm-unsafe", kwargs.get("confirm_unsafe"))
        return self._call_cli(args)


class UnbrowseLoginTool(_UnbrowseBase):
    name: str = "unbrowse_login"
    description: str = "Log in to a website via the Unbrowse CLI so that authenticated skills can be used."
    args_schema: Type[BaseModel] = LoginArgs

    def _run(self, url: str, **kwargs: Any) -> str:
        return self._call_cli(["login", "--url", url])


class UnbrowseSkillsTool(_UnbrowseBase):
    name: str = "unbrowse_skills"
    description: str = "List all locally cached Unbrowse skills."

    def _run(self, **kwargs: Any) -> str:
        return self._call_cli(["skills"])


class UnbrowseSkillTool(_UnbrowseBase):
    name: str = "unbrowse_skill"
    description: str = "Inspect a specific Unbrowse skill by ID."
    args_schema: Type[BaseModel] = SkillArgs

    def _run(self, skill_id: str, **kwargs: Any) -> str:
        return self._call_cli(["skill", skill_id])


class UnbrowseHealthTool(_UnbrowseBase):
    name: str = "unbrowse_health"
    description: str = "Check the health of the Unbrowse CLI and its dependencies."

    def _run(self, **kwargs: Any) -> str:
        return self._call_cli(["health"])


def create_unbrowse_toolkit(
    *,
    bin_path: str = "unbrowse",
    timeout: int = 120,
) -> List[BaseTool]:
    """Create and return all Unbrowse tools as a list, ready for use with LangChain agents."""
    kwargs = {"bin_path": bin_path, "timeout": timeout}
    return [
        UnbrowseResolveTool(**kwargs),
        UnbrowseSearchTool(**kwargs),
        UnbrowseExecuteTool(**kwargs),
        UnbrowseLoginTool(**kwargs),
        UnbrowseSkillsTool(**kwargs),
        UnbrowseSkillTool(**kwargs),
        UnbrowseHealthTool(**kwargs),
    ]
