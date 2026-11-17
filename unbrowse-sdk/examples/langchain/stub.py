"""A scripted LangChain chat model: the first turn calls unbrowse_do, the next answers from what the node sent back. It
stands in for a real model so the quickstart runs with no model API."""

import json
import sys

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.outputs import ChatGeneration, ChatResult

GOAL = {"goal": "search Hacker News stories", "url": "https://hn.algolia.com/api/v1/search?query=rust"}


def summary(answer):
    if answer.get("error"):
        return f"Unbrowse said: {answer['error']}"
    hits = ((answer.get("result") or {}).get("data") or {}).get("hits") or []
    lines = [f"{i + 1}. {h.get('title')}" for i, h in enumerate(hits[:5])]
    return f"Top Hacker News stories about Rust (via unbrowse_do, how: {answer.get('how')}):\n" + "\n".join(lines)


class Scripted(BaseChatModel):
    @property
    def _llm_type(self):
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        results = [m for m in messages if m.type == "tool"]
        if not results:
            print(f"[stub model] calling unbrowse_do {json.dumps(GOAL)}", file=sys.stderr)
            message = AIMessage(content="", tool_calls=[{"id": "c1", "name": "unbrowse_do", "args": GOAL, "type": "tool_call"}])
        else:
            print(f"[stub model] the node answered {results[-1].content[:300]}...", file=sys.stderr)
            message = AIMessage(content=summary(json.loads(results[-1].content)))
        return ChatResult(generations=[ChatGeneration(message=message)])


model = Scripted()
