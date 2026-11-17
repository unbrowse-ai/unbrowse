"""Unbrowse as tools for agent frameworks, each the node's MCP tool of the same name with its description and input
schema:

- ``unbrowse.adapters.langchain.unbrowse_tools()``: LangChain ``StructuredTool``s (``pip install unbrowse[langchain]``);
- ``unbrowse.adapters.openai_agents.unbrowse_tools()``: OpenAI Agents ``FunctionTool``s
  (``pip install unbrowse[openai-agents]``).

A tool answers what the MCP server would: the node's JSON, as text, or ``{"error", "code"}`` when a call fails, so the
model reads what went wrong instead of the run crashing. Nothing here imports a framework until its module is."""

from ._core import DEFAULT_TOOLS, TOOLS, chosen, node_of, run_tool, tool_error

__all__ = ["DEFAULT_TOOLS", "TOOLS", "chosen", "node_of", "run_tool", "tool_error"]
