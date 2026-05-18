/**
 * Pure transforms that bake `UNBROWSE_API_KEY` into the install command
 * surfaces rendered by `<InstallInstructions />`. Lives in lib/ (not in the
 * component) so it's directly testable without a DOM.
 *
 * Three command shapes we need to support, one per tab:
 *   - `npx unbrowse setup --mcp`               → env-var prefix
 *   - `claude mcp add unbrowse -- npx -y …`    → `claude mcp add -e KEY=v unbrowse -- …`
 *   - `{ "unbrowse": { "command": "npx", … } }` → splice `"env"` into the JSON object
 *
 * `injectKeyIntoCommandText` operates on the rendered terminal-line text
 * (including the `  $  ` prompt). `injectKeyIntoCopyText` operates on the
 * value that ships to the clipboard (no prompt prefix). They share the
 * same key parameter so callers pass the REAL key into copy and the MASKED
 * key into the on-screen rendering, surfacing the convenience without
 * leaking a full key into a screen-recording.
 */

const SETUP_MCP_CMD_RE = /(\$\s+)(npx unbrowse setup --mcp\b)/;
const CLAUDE_MCP_ADD_RE = /claude mcp add unbrowse(?= )/;
const MCP_JSON_ARGS_RE = /("args":\s*\[[^\]]*\])/;

/**
 * Render a key as `uk_••••<last-4>` so a passing screen-recorder doesn't
 * pick up the full key when the user previews the install command. The
 * full key still ships in `injectKeyIntoCopyText` so the actual install
 * actually connects to the account.
 */
export function maskApiKey(key: string): string {
  const tail = key.length >= 4 ? key.slice(-4) : key;
  return `uk_••••${tail}`;
}

export function injectKeyIntoCommandText(text: string, key: string | null): string {
  if (!key) return text;
  if (SETUP_MCP_CMD_RE.test(text)) {
    return text.replace(SETUP_MCP_CMD_RE, `$1UNBROWSE_API_KEY=${key} $2`);
  }
  if (CLAUDE_MCP_ADD_RE.test(text)) {
    return text.replace(
      CLAUDE_MCP_ADD_RE,
      `claude mcp add -e UNBROWSE_API_KEY=${key} unbrowse`,
    );
  }
  if (text.includes(`"unbrowse":`) && text.includes(`"args"`)) {
    return text.replace(
      MCP_JSON_ARGS_RE,
      `$1, "env": { "UNBROWSE_API_KEY": "${key}" }`,
    );
  }
  return text;
}

export function injectKeyIntoCopyText(text: string, key: string | null): string {
  if (!key) return text;
  if (text === "claude mcp add unbrowse -- npx -y unbrowse mcp") {
    return `claude mcp add -e UNBROWSE_API_KEY=${key} unbrowse -- npx -y unbrowse mcp`;
  }
  if (text === "npx unbrowse setup --mcp") {
    return `UNBROWSE_API_KEY=${key} npx unbrowse setup --mcp`;
  }
  return text;
}
