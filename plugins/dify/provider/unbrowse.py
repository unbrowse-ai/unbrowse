from typing import Any

from dify_plugin import ToolProvider
from dify_plugin.errors.tool import ToolProviderCredentialValidationError

from unbrowse_client import UnbrowseError, list_tools


class UnbrowseProvider(ToolProvider):
    def _validate_credentials(self, credentials: dict[str, Any]) -> None:
        try:
            tools = list_tools(str(credentials.get("unbrowse_api_key") or ""))
        except UnbrowseError as err:
            raise ToolProviderCredentialValidationError(str(err)) from None
        if not any(tool.get("name") == "unbrowse.scrape" for tool in tools):
            raise ToolProviderCredentialValidationError("This Unbrowse key cannot use unbrowse.scrape")
