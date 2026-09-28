"""LangChain tools for Unbrowse: read a page, find a site capability, run a web task."""

from __future__ import annotations

import json
from typing import Any, Literal

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool, BaseToolkit, ToolException
from pydantic import BaseModel, ConfigDict, Field, PrivateAttr, SecretStr

from langchain_unbrowse._client import UnbrowseClient, UnbrowseError

USER_AGENT = "langchain-unbrowse/0.1.0"


class _UnbrowseBase(BaseTool):
    """Shared settings: API key (or `UNBROWSE_API_KEY`), endpoint and timeout."""

    model_config = ConfigDict(arbitrary_types_allowed=True)

    api_key: SecretStr | None = Field(default=None, exclude=True)
    """Unbrowse API key. Defaults to the `UNBROWSE_API_KEY` environment variable."""
    url: str | None = None
    """MCP endpoint. Defaults to `UNBROWSE_MCP_URL` or https://unbrowse.ai/api/mcp."""
    timeout: float = 120
    """Seconds to wait for one call."""
    handle_tool_error: bool = True
    """Return Unbrowse errors to the model as the tool result instead of raising."""

    _client: UnbrowseClient | None = PrivateAttr(default=None)

    def _get_client(self) -> UnbrowseClient:
        if self._client is None:
            key = self.api_key.get_secret_value() if self.api_key else None
            try:
                self._client = UnbrowseClient(key, url=self.url, user_agent=USER_AGENT)
            except UnbrowseError as err:
                raise ToolException(str(err)) from None
        return self._client

    def _call(self, fn: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except UnbrowseError as err:
            raise ToolException(str(err)) from None


class UnbrowseScrapeInput(BaseModel):
    url: str = Field(description="The page to read, an http:// or https:// URL, e.g. https://docs.rs/serde")


class UnbrowseScrapeTool(_UnbrowseBase):
    """Read one web page as clean markdown with Unbrowse.

    Setup:
        ``pip install -U langchain-unbrowse`` and set ``UNBROWSE_API_KEY``
        (free key at https://unbrowse.ai/app).

    Instantiate:
        .. code-block:: python

            from langchain_unbrowse import UnbrowseScrapeTool

            tool = UnbrowseScrapeTool()

    Invoke:
        .. code-block:: python

            tool.invoke({"url": "https://example.com"})
    """

    name: str = "unbrowse_scrape"
    description: str = (
        "Read one web page and get its main content as clean markdown (no navigation, cookie banners or "
        "footers), with its title and final URL. Uses plain HTTP when possible and Unbrowse's cloud browser "
        "when the page needs JavaScript. Input: the page URL."
    )
    args_schema: type[BaseModel] = UnbrowseScrapeInput

    only_main_content: bool = True
    """Drop navigation, headers, footers and asides."""
    render: Literal["auto", "always", "never"] = "auto"
    """auto: HTTP first, browser if the page needs it."""
    max_chars: int | None = None
    """Cut the markdown to this many characters (None keeps it all)."""

    def _run(self, url: str, run_manager: CallbackManagerForToolRun | None = None) -> str:
        client = self._get_client()
        page = self._call(
            client.scrape,
            url,
            only_main_content=self.only_main_content,
            render=self.render,
            timeout=self.timeout,
        )
        return format_page(page, self.max_chars)


class UnbrowseDiscoverInput(BaseModel):
    query: str = Field(
        description="What you want to do or read, in plain words, e.g. 'search flights on google flights'"
    )


class UnbrowseDiscoverTool(_UnbrowseBase):
    """Find Unbrowse site capabilities (learned website APIs) that match a request.

    Returns capability ids, their inputs and health; pass an id to ``UnbrowseRunTool``.

    Instantiate:
        .. code-block:: python

            from langchain_unbrowse import UnbrowseDiscoverTool

            tool = UnbrowseDiscoverTool()
            tool.invoke({"query": "hacker news front page"})
    """

    name: str = "unbrowse_discover"
    description: str = (
        "Search Unbrowse for website capabilities (learned site APIs) that match a request. Returns capability "
        "ids with the inputs each needs and its recent health. Use before unbrowse_run to pick a capability. "
        "Input: what you want to do, in plain words."
    )
    args_schema: type[BaseModel] = UnbrowseDiscoverInput
    timeout: float = 60

    def _run(self, query: str, run_manager: CallbackManagerForToolRun | None = None) -> str:
        found = self._call(self._get_client().discover, query, timeout=self.timeout)
        return found if isinstance(found, str) else json.dumps(found, ensure_ascii=False)


class UnbrowseRunInput(BaseModel):
    task: str | None = Field(
        default=None,
        description="The web task in plain language, e.g. 'top 5 stories on news.ycombinator.com'. "
        "Give this or capability.",
    )
    capability: str | None = Field(default=None, description="A capability id returned by unbrowse_discover.")
    input: dict[str, Any] | None = Field(
        default=None, description="Inputs for the capability, keyed by the names unbrowse_discover lists."
    )


class UnbrowseRunTool(_UnbrowseBase):
    """Run a web task on Unbrowse, by plain-language task or by capability id.

    The result has ``status``: ``succeeded`` (with ``result``), ``input_required`` (the run names what is
    missing; call again with ``input``) or ``no_capability`` (nothing fits; try ``UnbrowseScrapeTool``).

    Instantiate:
        .. code-block:: python

            from langchain_unbrowse import UnbrowseRunTool

            tool = UnbrowseRunTool()
            tool.invoke({"task": "top 5 stories on news.ycombinator.com"})
    """

    name: str = "unbrowse_run"
    description: str = (
        "Run a web task on Unbrowse and get structured data back. Give either task (plain language) or "
        "capability (an id from unbrowse_discover) plus input. The JSON result has status: succeeded (see "
        "result), input_required (call again with the missing input), or no_capability (nothing fits; read "
        "the page with unbrowse_scrape instead)."
    )
    args_schema: type[BaseModel] = UnbrowseRunInput
    timeout: float = 240

    def _run(
        self,
        task: str | None = None,
        capability: str | None = None,
        input: dict[str, Any] | None = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        run = self._call(self._get_client().run, task, capability=capability, input=input, timeout=self.timeout)
        return json.dumps(run, ensure_ascii=False)


class UnbrowseToolkit(BaseToolkit):
    """The three Unbrowse tools (scrape, discover, run) sharing one API key.

    Instantiate:
        .. code-block:: python

            from langchain_unbrowse import UnbrowseToolkit

            tools = UnbrowseToolkit().get_tools()
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    api_key: SecretStr | None = Field(default=None, exclude=True)
    url: str | None = None

    def get_tools(self) -> list[BaseTool]:
        shared: dict[str, Any] = {"api_key": self.api_key, "url": self.url}
        return [UnbrowseScrapeTool(**shared), UnbrowseDiscoverTool(**shared), UnbrowseRunTool(**shared)]


def format_page(page: dict[str, Any], max_chars: int | None = None) -> str:
    """Markdown with a short header naming the page title and final URL."""
    markdown = str(page.get("markdown") or "")
    if max_chars is not None and len(markdown) > max_chars:
        markdown = markdown[:max_chars].rstrip() + "\n\n[truncated]"
    metadata = page.get("metadata") if isinstance(page.get("metadata"), dict) else {}
    title = str(metadata.get("title") or "").strip()
    source = str(page.get("finalUrl") or page.get("url") or "").strip()
    header = [line for line in (f"Title: {title}" if title else "", f"URL: {source}" if source else "") if line]
    return "\n".join(header) + ("\n\n" if header else "") + markdown
