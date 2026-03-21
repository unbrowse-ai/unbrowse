"""Tests for unbrowse-langchain tools."""

from __future__ import annotations

import json
from unittest.mock import patch, MagicMock

import pytest

from unbrowse_langchain import (
    UnbrowseResolveTool,
    UnbrowseSearchTool,
    UnbrowseExecuteTool,
    UnbrowseLoginTool,
    UnbrowseSkillsTool,
    UnbrowseSkillTool,
    UnbrowseHealthTool,
    create_unbrowse_toolkit,
)


# ---------------------------------------------------------------------------
# Toolkit factory
# ---------------------------------------------------------------------------

def test_create_unbrowse_toolkit_returns_all_tools():
    tools = create_unbrowse_toolkit()
    assert len(tools) == 7
    names = {t.name for t in tools}
    assert names == {
        "unbrowse_resolve",
        "unbrowse_search",
        "unbrowse_execute",
        "unbrowse_login",
        "unbrowse_skills",
        "unbrowse_skill",
        "unbrowse_health",
    }


def test_create_unbrowse_toolkit_custom_bin():
    tools = create_unbrowse_toolkit(bin_path="/opt/bin/unbrowse", timeout=30)
    for t in tools:
        assert t.bin_path == "/opt/bin/unbrowse"
        assert t.timeout == 30


# ---------------------------------------------------------------------------
# Tool instantiation & metadata
# ---------------------------------------------------------------------------

def test_resolve_tool_has_args_schema():
    tool = UnbrowseResolveTool()
    schema = tool.args_schema.model_json_schema()
    assert "intent" in schema["properties"]
    assert "url" in schema["properties"]


def test_search_tool_has_args_schema():
    tool = UnbrowseSearchTool()
    schema = tool.args_schema.model_json_schema()
    assert "intent" in schema["properties"]


def test_execute_tool_has_args_schema():
    tool = UnbrowseExecuteTool()
    schema = tool.args_schema.model_json_schema()
    assert "skill_id" in schema["properties"]
    assert "endpoint_id" in schema["properties"]


# ---------------------------------------------------------------------------
# CLI arg building via mock subprocess
# ---------------------------------------------------------------------------

def _mock_run(args, **kwargs):
    m = MagicMock()
    m.returncode = 0
    m.stdout = json.dumps({"ok": True, "args": args})
    m.stderr = ""
    return m


@patch("unbrowse_langchain.tools.subprocess.run", side_effect=_mock_run)
def test_resolve_builds_correct_args(mock_sub):
    tool = UnbrowseResolveTool(bin_path="ub")
    result = tool.invoke({"intent": "get prices", "url": "https://example.com", "limit": 10})
    call_args = mock_sub.call_args[0][0]
    assert call_args == ["ub", "resolve", "--intent", "get prices", "--url", "https://example.com", "--limit", "10"]


@patch("unbrowse_langchain.tools.subprocess.run", side_effect=_mock_run)
def test_search_builds_correct_args(mock_sub):
    tool = UnbrowseSearchTool(bin_path="ub")
    tool.invoke({"intent": "weather api", "domain": "weather.com"})
    call_args = mock_sub.call_args[0][0]
    assert call_args == ["ub", "search", "--intent", "weather api", "--domain", "weather.com"]


@patch("unbrowse_langchain.tools.subprocess.run", side_effect=_mock_run)
def test_execute_builds_correct_args(mock_sub):
    tool = UnbrowseExecuteTool(bin_path="ub")
    tool.invoke({
        "skill_id": "s1",
        "endpoint_id": "e1",
        "url": "https://example.com/search?q=openai",
        "intent": "search packages",
        "pretty": True,
    })
    call_args = mock_sub.call_args[0][0]
    assert call_args == [
        "ub",
        "execute",
        "--skill",
        "s1",
        "--endpoint",
        "e1",
        "--url",
        "https://example.com/search?q=openai",
        "--intent",
        "search packages",
        "--pretty",
    ]


@patch("unbrowse_langchain.tools.subprocess.run", side_effect=_mock_run)
def test_login_builds_correct_args(mock_sub):
    tool = UnbrowseLoginTool(bin_path="ub")
    tool.invoke({"url": "https://app.example.com"})
    call_args = mock_sub.call_args[0][0]
    assert call_args == ["ub", "login", "--url", "https://app.example.com"]


@patch("unbrowse_langchain.tools.subprocess.run", side_effect=_mock_run)
def test_skill_builds_correct_args(mock_sub):
    tool = UnbrowseSkillTool(bin_path="ub")
    tool.invoke({"skill_id": "my-skill"})
    call_args = mock_sub.call_args[0][0]
    assert call_args == ["ub", "skill", "my-skill"]


@patch("unbrowse_langchain.tools.subprocess.run", side_effect=_mock_run)
def test_skills_no_args(mock_sub):
    tool = UnbrowseSkillsTool(bin_path="ub")
    tool.invoke({})
    call_args = mock_sub.call_args[0][0]
    assert call_args == ["ub", "skills"]


@patch("unbrowse_langchain.tools.subprocess.run", side_effect=_mock_run)
def test_health_no_args(mock_sub):
    tool = UnbrowseHealthTool(bin_path="ub")
    tool.invoke({})
    call_args = mock_sub.call_args[0][0]
    assert call_args == ["ub", "health"]


# ---------------------------------------------------------------------------
# Error handling
# ---------------------------------------------------------------------------

@patch("unbrowse_langchain.tools.subprocess.run", side_effect=FileNotFoundError)
def test_binary_not_found(mock_sub):
    tool = UnbrowseHealthTool(bin_path="/no/such/bin")
    result = tool.invoke({})
    parsed = json.loads(result)
    assert parsed["ok"] is False
    assert "not found" in parsed["error"]


@patch("unbrowse_langchain.tools.subprocess.run")
def test_nonzero_exit(mock_sub):
    m = MagicMock()
    m.returncode = 1
    m.stdout = ""
    m.stderr = "something went wrong"
    mock_sub.return_value = m
    tool = UnbrowseHealthTool()
    result = tool.invoke({})
    parsed = json.loads(result)
    assert parsed["ok"] is False
    assert "something went wrong" in parsed["error"]
