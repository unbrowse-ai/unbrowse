"""Unbrowse tool spec: read a page, find a site capability, run a web task."""

from __future__ import annotations

import json
from typing import Any, Literal

from llama_index.core.tools.tool_spec.base import BaseToolSpec
from llama_index.tools.unbrowse._client import UnbrowseClient, UnbrowseError

USER_AGENT = "llama-index-tools-unbrowse/0.1.0"


class UnbrowseToolSpec(BaseToolSpec):
    """Unbrowse tools for LlamaIndex agents.

    Unbrowse (https://unbrowse.ai) is a hosted service that turns websites into APIs agents call.
    Get a free API key at https://unbrowse.ai/app and pass it or set ``UNBROWSE_API_KEY``.

    Example:
        .. code-block:: python

            from llama_index.tools.unbrowse import UnbrowseToolSpec

            tools = UnbrowseToolSpec().to_tool_list()

    """

    spec_functions = ["unbrowse_scrape", "unbrowse_discover", "unbrowse_run"]

    def __init__(
        self,
        api_key: str | None = None,
        *,
        url: str | None = None,
        only_main_content: bool = True,
        render: Literal["auto", "always", "never"] = "auto",
        max_chars: int | None = None,
        timeout: float | None = None,
        raise_errors: bool = False,
    ) -> None:
        """
        Create the tool spec.

        Args:
            api_key: Unbrowse API key. Defaults to the UNBROWSE_API_KEY environment variable.
            url: MCP endpoint. Defaults to UNBROWSE_MCP_URL or https://unbrowse.ai/api/mcp.
            only_main_content: Scrape drops navigation, headers and footers.
            render: Scrape rendering: auto (HTTP first, browser if needed), always or never.
            max_chars: Cut scraped markdown to this many characters (None keeps it all).
            timeout: Seconds per call (default: scrape 120, discover 60, run 240).
            raise_errors: Raise UnbrowseError instead of returning the error text to the agent.

        """
        self._client = UnbrowseClient(api_key, url=url, user_agent=USER_AGENT)
        self.only_main_content = only_main_content
        self.render = render
        self.max_chars = max_chars
        self.timeout = timeout
        self.raise_errors = raise_errors

    def _guard(self, fn: Any, *args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except UnbrowseError as err:
            if self.raise_errors:
                raise
            return f"Error: {err}"

    def unbrowse_scrape(self, url: str) -> str:
        """
        Read one web page and return its main content as clean markdown, with its title and final URL.

        Uses plain HTTP when possible and Unbrowse's cloud browser when the page needs JavaScript.

        Args:
            url: The page to read, an http:// or https:// URL, e.g. https://docs.rs/serde

        """

        def scrape() -> str:
            page = self._client.scrape(
                url,
                only_main_content=self.only_main_content,
                render=self.render,
                timeout=self.timeout or 120,
            )
            return format_page(page, self.max_chars)

        return self._guard(scrape)

    def unbrowse_discover(self, query: str) -> str:
        """
        Search Unbrowse for website capabilities (learned site APIs) that match a request.

        Returns JSON listing capability ids, the inputs each needs and their recent health.
        Use it to pick a capability for unbrowse_run.

        Args:
            query: What you want to do or read, in plain words, e.g. 'search flights on google flights'

        """

        def discover() -> str:
            found = self._client.discover(query, timeout=self.timeout or 60)
            return found if isinstance(found, str) else json.dumps(found, ensure_ascii=False)

        return self._guard(discover)

    def unbrowse_run(
        self,
        task: str | None = None,
        capability: str | None = None,
        input: dict[str, Any] | None = None,
    ) -> str:
        """
        Run a web task on Unbrowse and return structured JSON.

        Give either task (plain language) or capability (an id from unbrowse_discover) plus input.
        The result has status: succeeded (see result), input_required (call again with the missing
        input), or no_capability (nothing fits; read the page with unbrowse_scrape instead).

        Args:
            task: The web task in plain language, e.g. 'top 5 stories on news.ycombinator.com'
            capability: A capability id returned by unbrowse_discover
            input: Inputs for the capability, keyed by the names unbrowse_discover lists

        """

        def run() -> str:
            result = self._client.run(task, capability=capability, input=input, timeout=self.timeout or 240)
            return json.dumps(result, ensure_ascii=False)

        return self._guard(run)


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
