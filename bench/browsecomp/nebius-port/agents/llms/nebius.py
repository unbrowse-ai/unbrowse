"""Nebius TokenFactory (chat-completions) backend for search_evals.

The vendored OpenAI backend uses the Responses API (`client.responses.create`),
which Nebius does NOT implement. This backend speaks plain `chat.completions`
so the BrowseComp/Exa harness can run its answering agent on a Nebius-hosted
model (e.g. moonshotai/Kimi-K2.6). It mirrors the OpenAI/Anthropic backends:
same BaseLLM / BaseConversation contracts, same ResponseBlock/ToolCallBlock
shapes — only the wire protocol changes.

NOTE (methodology): a Nebius/Kimi run is a REAL, reproducible number, but it is
NOT Exa's published methodology (their answering agent + gpt-4.1 grader over the
Responses API). Label any such number "unbrowse-search + Kimi-agent", never a
clean "beat Exa".
"""

import os
from typing import Any, Self

import orjson
from openai import AsyncOpenAI
from pydantic import BaseModel
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential
import openai

from search_evals.agents.llms.base import DEFAULT_MAX_CONTEXT_TOKENS, BaseConversation, BaseLLM, LLMOutput
from search_evals.agents.tools import LLMProvider, ToolSet
from search_evals.agents.types import ResponseBlock, TextBlock, ToolCallBlock, ToolChoice, ToolResult

NEBIUS_BASE_URL = os.environ.get(
    "NEBIUS_BASE_URL", "https://api.tokenfactory.us-central1.nebius.com/v1"
)
# Kimi-K2.6 is a reasoning model: it spends tokens on internal reasoning before
# emitting content/tool_calls, so the completion budget must be generous or the
# message comes back with content=None (observed at max_tokens=4).
NEBIUS_MAX_TOKENS = int(os.environ.get("NEBIUS_MAX_TOKENS", "8192"))


def nebius_client() -> AsyncOpenAI:
    key = os.environ.get("NEBIUS_API_KEY")
    if not key:
        raise RuntimeError("NEBIUS_API_KEY not set — required for the Nebius backend")
    return AsyncOpenAI(api_key=key, base_url=NEBIUS_BASE_URL)


class NebiusMessage(BaseModel):
    role: str
    content: str | None = None
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None


class NebiusConversation(BaseConversation[NebiusMessage]):
    def _make_role_message(self, role: str, content: str) -> NebiusMessage:
        return NebiusMessage(role=role, content=content)

    def _get_assistant_text(self, message: NebiusMessage) -> str | None:
        if message.role == "assistant" and message.content:
            return message.content
        return None

    def _add_response_messages(self, blocks: list[ResponseBlock]) -> None:
        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        for block in blocks:
            match block:
                case TextBlock():
                    text_parts.append(block.text)
                case ToolCallBlock():
                    tool_calls.append(
                        {
                            "id": block.id,
                            "type": "function",
                            "function": {
                                "name": block.name,
                                "arguments": orjson.dumps(block.input).decode(),
                            },
                        }
                    )
        msg = NebiusMessage(
            role="assistant",
            content="\n".join(text_parts) if text_parts else None,
            tool_calls=tool_calls or None,
        )
        self.messages.append(msg)

    def add_tool_results(self, results: list[ToolResult]) -> Self:
        for r in results:
            self.messages.append(
                NebiusMessage(role="tool", tool_call_id=r.tool_call_id, content=r.output)
            )
        return self

    def to_api_format(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if self.system:
            out.append({"role": "system", "content": self.system})
        for msg in self.messages:
            out.append({k: v for k, v in msg.model_dump().items() if v is not None})
        return out


def _chat_tool_defs(toolset: ToolSet) -> list[dict[str, Any]]:
    """Transform the (flat, Responses-API) OpenAI tool schemas into the nested
    chat-completions function-tool shape."""
    defs: list[dict[str, Any]] = []
    for schema in toolset.get_defs(LLMProvider.OPENAI):
        defs.append(
            {
                "type": "function",
                "function": {
                    "name": schema["name"],
                    "description": schema["description"],
                    "parameters": schema["parameters"],
                },
            }
        )
    return defs


class NebiusLLM(BaseLLM):
    def __init__(self, model: str) -> None:
        # accept "nebius/<model>" or a bare model id
        if model.startswith("nebius/"):
            model = model[len("nebius/"):]
        self.model = model
        self.client = nebius_client()

    def create_conversation(self, max_context_tokens: int = DEFAULT_MAX_CONTEXT_TOKENS) -> NebiusConversation:
        return NebiusConversation(max_context_tokens=max_context_tokens)

    @staticmethod
    def _tool_choice(tc: ToolChoice) -> str:
        return {ToolChoice.AUTO: "auto", ToolChoice.NONE: "none", ToolChoice.REQUIRED: "required"}[tc]

    @retry(
        retry=retry_if_exception_type(openai.APITimeoutError),
        wait=wait_exponential(multiplier=1, max=120),
        stop=stop_after_attempt(4),
    )
    async def __call__(self, convo: NebiusConversation, toolset: ToolSet) -> LLMOutput:
        messages = convo.to_api_format()
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "max_tokens": NEBIUS_MAX_TOKENS,
        }
        if toolset.tool_choice == ToolChoice.NONE:
            messages.append(
                {
                    "role": "user",
                    "content": "You can no longer search. Output the final answer based only on the search results above, in the required Response Format.",
                }
            )
        else:
            kwargs["tools"] = _chat_tool_defs(toolset)
            kwargs["tool_choice"] = self._tool_choice(toolset.tool_choice)
        response = await self.client.chat.completions.create(**kwargs)
        return self._parse_response(response)

    def _parse_response(self, response: Any) -> LLMOutput:
        blocks: list[ResponseBlock] = []
        choice = response.choices[0] if response.choices else None
        msg = choice.message if choice else None
        if msg is not None:
            if msg.content:
                blocks.append(TextBlock(text=msg.content))
            for tc in (msg.tool_calls or []):
                try:
                    args = orjson.loads(tc.function.arguments or "{}")
                except Exception:
                    args = {}
                blocks.append(ToolCallBlock(id=tc.id, name=tc.function.name, input=args))
        input_tokens = response.usage.prompt_tokens if response.usage else 0
        return LLMOutput(blocks=blocks, input_tokens=input_tokens)
