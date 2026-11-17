"""A scripted model in the OpenAI Agents SDK's model interface: the first turn calls unbrowse_do, the next answers from
what the node sent back. It stands in for a real model so the quickstart runs with no model API."""

import json
import sys

from agents import set_tracing_disabled
from agents.items import ModelResponse
from agents.models.interface import Model
from agents.usage import Usage
from openai.types.responses import ResponseFunctionToolCall, ResponseOutputMessage, ResponseOutputText

set_tracing_disabled(True)
GOAL = {"goal": "search Hacker News stories", "url": "https://hn.algolia.com/api/v1/search?query=rust"}


def summary(answer):
    if answer.get("error"):
        return f"Unbrowse said: {answer['error']}"
    hits = ((answer.get("result") or {}).get("data") or {}).get("hits") or []
    lines = [f"{i + 1}. {h.get('title')}" for i, h in enumerate(hits[:5])]
    return f"Top Hacker News stories about Rust (via unbrowse_do, how: {answer.get('how')}):\n" + "\n".join(lines)


class Scripted(Model):
    async def get_response(self, system_instructions, input, *args, **kwargs):
        results = [i for i in input if isinstance(i, dict) and i.get("type") == "function_call_output"] if isinstance(input, list) else []
        if not results:
            print(f"[stub model] calling unbrowse_do {json.dumps(GOAL)}", file=sys.stderr)
            out = [ResponseFunctionToolCall(type="function_call", call_id="c1", name="unbrowse_do", arguments=json.dumps(GOAL), status="completed")]
        else:
            text = results[-1]["output"]
            print(f"[stub model] the node answered {text[:300]}...", file=sys.stderr)
            out = [ResponseOutputMessage(id="m1", type="message", role="assistant", status="completed", content=[ResponseOutputText(type="output_text", text=summary(json.loads(text)), annotations=[])])]
        return ModelResponse(output=out, usage=Usage(), response_id=None)

    def stream_response(self, *args, **kwargs):
        raise NotImplementedError("the stub model doesn't stream")


model = Scripted()
