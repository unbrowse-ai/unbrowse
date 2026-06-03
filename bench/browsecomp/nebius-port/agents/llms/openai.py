from typing import Any, Literal, Self, cast

import openai
import orjson
from openai import AsyncOpenAI
from openai.types.responses import ResponseInputItemParam
from pydantic import BaseModel
from tenacity import retry, retry_if_exception_type, wait_exponential

from search_evals.agents.llms.base import DEFAULT_MAX_CONTEXT_TOKENS, BaseConversation, BaseLLM, LLMOutput
from search_evals.agents.tools import LLMProvider, ToolSet
from search_evals.agents.types import ResponseBlock, TextBlock, ToolCallBlock, ToolResult


class OpenAIMessage(BaseModel):
    role: str | None = None
    content: str | None = None
    type: Literal["function_call", "function_call_output"] | None = None
    call_id: str | None = None
    name: str | None = None
    arguments: str | None = None
    output: str | None = None


class OpenAIConversation(BaseConversation[OpenAIMessage]):
    def _make_role_message(self, role: str, content: str) -> OpenAIMessage:
        return OpenAIMessage(role=role, content=content)

    def _get_assistant_text(self, message: OpenAIMessage) -> str | None:
        if message.role == "assistant" and message.content:
            return message.content
        return None

    def _add_response_messages(self, blocks: list[ResponseBlock]) -> None:
        for block in blocks:
            match block:
                case TextBlock():
                    self.messages.append(OpenAIMessage(role="assistant", content=block.text))
                case ToolCallBlock():
                    self.messages.append(
                        OpenAIMessage(
                            type="function_call",
                            call_id=block.id,
                            name=block.name,
                            arguments=orjson.dumps(block.input).decode(),
                        )
                    )

    def add_tool_results(self, results: list[ToolResult]) -> Self:
        for r in results:
            self.messages.append(
                OpenAIMessage(
                    type="function_call_output",
                    call_id=r.tool_call_id,
                    output=r.output,
                )
            )
        return self

    def to_api_format(self) -> list[ResponseInputItemParam]:
        messages = [{k: v for k, v in msg.model_dump().items() if v is not None} for msg in self.messages]
        if self.system:
            messages.insert(0, {"role": "system", "content": self.system})
        return cast(list[ResponseInputItemParam], messages)


class OpenAILLM(BaseLLM):
    def __init__(self, model: str) -> None:
        self.client = AsyncOpenAI()
        self.reasoning_effort: str = "none"
        for effort in ("low", "medium", "high"):
            if model.endswith(f"-{effort}"):
                model = model.removesuffix(f"-{effort}")
                self.reasoning_effort = effort
                break
        self.model = model

    def create_conversation(self, max_context_tokens: int = DEFAULT_MAX_CONTEXT_TOKENS) -> OpenAIConversation:
        return OpenAIConversation(max_context_tokens=max_context_tokens)

    @retry(
        retry=retry_if_exception_type(openai.APITimeoutError),
        wait=wait_exponential(multiplier=1, max=300),
    )
    async def __call__(self, convo: OpenAIConversation, toolset: ToolSet) -> LLMOutput:
        kwargs = dict(  # type: ignore[call-overload]
            model=self.model,
            input=convo.to_api_format(),
            tools=toolset.get_defs(LLMProvider.OPENAI),
            tool_choice=toolset.tool_choice,
            prompt_cache_key="deep-research",
        )
        # Only reasoning models (an explicit -low/-medium/-high suffix sets a
        # non-"none" effort) accept the `reasoning` param; gpt-4.1 etc. reject it
        # with a 400 "Unsupported parameter: 'reasoning.effort'". Omit it for them.
        if self.reasoning_effort != "none":
            kwargs["reasoning"] = {"effort": self.reasoning_effort}
        response = await self.client.responses.create(**kwargs)
        return self._parse_response(response)

    def _parse_response(self, response: Any) -> LLMOutput:
        blocks: list[ResponseBlock] = []

        for output in response.output:
            match output.type:
                case "function_call":
                    blocks.append(
                        ToolCallBlock(
                            id=output.call_id,
                            name=output.name,
                            input=orjson.loads(output.arguments),
                        )
                    )
                case "message":
                    for content in output.content:
                        if content.type == "output_text" and content.text:
                            blocks.append(TextBlock(text=content.text))

        input_tokens = response.usage.input_tokens if response.usage else 0
        return LLMOutput(blocks=blocks, input_tokens=input_tokens)
