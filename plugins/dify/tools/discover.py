from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from unbrowse_client import UnbrowseError, call_tool


class DiscoverTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        query = str(tool_parameters.get("query") or "").strip()
        if not query:
            raise ValueError("query is required")
        try:
            found = call_tool(self.runtime.credentials["unbrowse_api_key"], "unbrowse.discover", {"query": query}, timeout=60)
        except UnbrowseError as err:
            raise ValueError(str(err)) from None
        yield self.create_json_message(found if isinstance(found, (dict, list)) else {"result": found})
