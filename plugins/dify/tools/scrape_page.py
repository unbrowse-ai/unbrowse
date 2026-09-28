from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from unbrowse_client import UnbrowseError, call_tool


class ScrapePageTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        url = str(tool_parameters.get("url") or "").strip()
        if not url.startswith(("http://", "https://")):
            raise ValueError("url must be an http:// or https:// address")
        arguments: dict[str, Any] = {"url": url, "formats": ["markdown", "links"]}
        only_main = tool_parameters.get("only_main_content")
        if only_main is not None:
            arguments["onlyMainContent"] = bool(only_main)
        render = tool_parameters.get("render")
        if render in ("auto", "always", "never"):
            arguments["render"] = render
        try:
            page = call_tool(self.runtime.credentials["unbrowse_api_key"], "unbrowse.scrape", arguments, timeout=120)
        except UnbrowseError as err:
            raise ValueError(str(err)) from None
        if not isinstance(page, dict):
            page = {"url": url, "markdown": str(page)}
        yield self.create_text_message(str(page.get("markdown") or ""))
        yield self.create_json_message(page)
