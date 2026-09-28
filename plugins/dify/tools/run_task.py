import json
from collections.abc import Generator
from typing import Any

from dify_plugin import Tool
from dify_plugin.entities.tool import ToolInvokeMessage

from unbrowse_client import UnbrowseError, call_tool


def build_arguments(tool_parameters: dict[str, Any]) -> dict[str, Any]:
    task = str(tool_parameters.get("task") or "").strip()
    capability = str(tool_parameters.get("capability") or "").strip()
    if not task and not capability:
        raise ValueError("Give a task (plain language) or a capability id from Discover")
    arguments: dict[str, Any] = {}
    if task:
        arguments["task"] = task
    if capability:
        arguments["capability"] = capability
    raw_input = tool_parameters.get("input")
    if isinstance(raw_input, dict):
        arguments["input"] = raw_input
    elif isinstance(raw_input, str) and raw_input.strip():
        try:
            parsed = json.loads(raw_input)
        except json.JSONDecodeError:
            raise ValueError("input must be a JSON object, e.g. {\"query\": \"laptops\"}") from None
        if not isinstance(parsed, dict):
            raise ValueError("input must be a JSON object, e.g. {\"query\": \"laptops\"}")
        arguments["input"] = parsed
    return arguments


class RunTaskTool(Tool):
    def _invoke(self, tool_parameters: dict[str, Any]) -> Generator[ToolInvokeMessage, None, None]:
        arguments = build_arguments(tool_parameters)
        try:
            run = call_tool(self.runtime.credentials["unbrowse_api_key"], "unbrowse.run", arguments, timeout=240)
        except UnbrowseError as err:
            raise ValueError(str(err)) from None
        if not isinstance(run, dict):
            run = {"status": "succeeded", "result": run}
        yield self.create_json_message(run)
