/**
 * Pure transforms that bake `UNBROWSE_API_KEY` into the install command
 * surfaces rendered by `<InstallInstructions />`. Lives in lib/ (not in the
 * component) so it's directly testable without a DOM.
 *
 * Command shapes we need to support:
 *   - `unbrowse setup`                         → env-var prefix
 *   - `npm install -g unbrowse && unbrowse setup` → env-var prefix on setup
 *   - legacy `claude mcp add unbrowse -- npx -y …` → `claude mcp add -e KEY=v unbrowse -- …`
 *
 * `injectKeyIntoCommandText` operates on the rendered terminal-line text
 * (including the `  $  ` prompt). `injectKeyIntoCopyText` operates on the
 * value that ships to the clipboard (no prompt prefix). They share the
 * same key parameter so callers pass the REAL key into copy and the MASKED
 * key into the on-screen rendering, surfacing the convenience without
 * leaking a full key into a screen-recording.
 */

const SETUP_CMD_RE = /(\$\s+)(?:(npm install -g unbrowse && )?(unbrowse setup\b))/;
const CLAUDE_MCP_ADD_RE = /claude mcp add unbrowse(?= )/;

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
  if (SETUP_CMD_RE.test(text)) {
    return text.replace(SETUP_CMD_RE, (_m: string, prompt: string, install: string | undefined, setup: string) =>
      `${prompt}${install ?? ""}UNBROWSE_API_KEY=${key} ${setup}`,
    );
  }
  if (CLAUDE_MCP_ADD_RE.test(text)) {
    return text.replace(
      CLAUDE_MCP_ADD_RE,
      `claude mcp add -e UNBROWSE_API_KEY=${key} unbrowse`,
    );
  }
  return text;
}

export function injectKeyIntoCopyText(text: string, key: string | null): string {
  if (!key) return text;
  if (text === "claude mcp add unbrowse -- npx -y unbrowse mcp") {
    return `claude mcp add -e UNBROWSE_API_KEY=${key} unbrowse -- npx -y unbrowse mcp`;
  }
  if (text === "unbrowse setup") {
    return `UNBROWSE_API_KEY=${key} unbrowse setup`;
  }
  if (text === "npm install -g unbrowse && unbrowse setup") {
    return `npm install -g unbrowse && UNBROWSE_API_KEY=${key} unbrowse setup`;
  }
  return text;
}
