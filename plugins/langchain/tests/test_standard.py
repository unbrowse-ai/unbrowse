"""LangChain standard tool tests (no network)."""

from __future__ import annotations

import pytest

pytest.importorskip("langchain_tests")

from langchain_tests.unit_tests import ToolsUnitTests
from langchain_unbrowse import (
    UnbrowseDiscoverTool,
    UnbrowseRunTool,
    UnbrowseScrapeTool,
)


class TestUnbrowseScrapeToolStandard(ToolsUnitTests):
    @property
    def tool_constructor(self) -> type[UnbrowseScrapeTool]:
        return UnbrowseScrapeTool

    @property
    def tool_constructor_params(self) -> dict:
        return {"api_key": "ub_test_key"}

    @property
    def tool_invoke_params_example(self) -> dict:
        return {"url": "https://example.com"}

    @property
    def init_from_env_params(self) -> tuple[dict, dict, dict]:
        return ({"UNBROWSE_API_KEY": "ub_env_key"}, {}, {})


class TestUnbrowseDiscoverToolStandard(ToolsUnitTests):
    @property
    def tool_constructor(self) -> type[UnbrowseDiscoverTool]:
        return UnbrowseDiscoverTool

    @property
    def tool_constructor_params(self) -> dict:
        return {"api_key": "ub_test_key"}

    @property
    def tool_invoke_params_example(self) -> dict:
        return {"query": "hacker news front page"}


class TestUnbrowseRunToolStandard(ToolsUnitTests):
    @property
    def tool_constructor(self) -> type[UnbrowseRunTool]:
        return UnbrowseRunTool

    @property
    def tool_constructor_params(self) -> dict:
        return {"api_key": "ub_test_key"}

    @property
    def tool_invoke_params_example(self) -> dict:
        return {"task": "top 5 stories on news.ycombinator.com", "capability": None, "input": None}
