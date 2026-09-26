// Remote MCP install links and commands, OAuth first (no key in any of them). Pure: a URL in, strings out.

/** Cursor's install link: base64 of the server's config (docs: cursor.com/docs/context/mcp/install-links). */
export function cursorInstallLink(url: string): string {
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=unbrowse&config=${encodeURIComponent(btoa(JSON.stringify({ url })))}`;
}

/** VS Code's install link: the URL-encoded server config (docs: code.visualstudio.com/api/extension-guides/ai/mcp). */
export function vscodeInstallLink(url: string, insiders = false): string {
  return `${insiders ? "vscode-insiders" : "vscode"}:mcp/install?${encodeURIComponent(JSON.stringify({ name: "unbrowse", type: "http", url }))}`;
}

export function mcpCommands(url: string) {
  return {
    claudeCode: `claude mcp add --transport http unbrowse ${url}`,
    codex: `codex mcp add unbrowse --url ${url} && codex mcp login unbrowse`,
    json: JSON.stringify({ mcpServers: { unbrowse: { url } } }, null, 2),
  };
}
