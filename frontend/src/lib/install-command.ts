export const REPO_CLONE_URL = "https://github.com/unbrowse-ai/unbrowse.git";
export const INSTALL_SCRIPT_URL = "https://unbrowse.ai/install.sh";

export const INSTALL_CMD_OPENCLAW = "npx unbrowse-openclaw install --restart";
export const INSTALL_CMD_GENERIC = `curl -fsSL ${INSTALL_SCRIPT_URL} | bash`;
// `npx skills add unbrowse-ai/unbrowse` was retired with the v6.15.0 skill-path
// demolition (CLAUDE.md). The public repo no longer ships a SKILL.md; the
// shortcut button has been removed from the hero CTA. Integration surface is
// now @unbrowse/sdk + MCP via `npx unbrowse setup --mcp`. Do not reintroduce
// a skill-shortcut export here without restoring the SKILL.md publish loop.
export const INSTALL_CMD_NPM = "npm install -g unbrowse && unbrowse setup";
export const INSTALL_CMD_WINDOWS = `irm https://unbrowse.ai/install.ps1 | iex`;
export const VERIFY_CMD = "unbrowse health --pretty";
export const FIRST_TASK_CMD =
  'unbrowse resolve --intent "get trending searches" --url "https://google.com" --pretty';

export const UPGRADE_CMD_GENERIC = INSTALL_CMD_GENERIC;

export const MCP_CONFIG_PATH = "~/.config/unbrowse/mcp/unbrowse.json";

export const MCP_CONFIG_JSON = JSON.stringify({
  mcpServers: {
    unbrowse: {
      command: "unbrowse",
      args: ["mcp"],
    },
  },
}, null, 2);

// Canonical MCP install paths for layout.tsx SoftwareApplication JSON-LD and
// llms.txt / llms-full.txt. These previously emitted
// `git clone ${REPO_CLONE_URL} ~/unbrowse && ./setup --host <host>` against
// the public repo, but that repo no longer ships a `./setup` script
// (v6.15.0 demolition). The npx-based command is the one the install
// widget already advertises end-to-end, so collapse all hosts onto it
// rather than per-host clone trees. Keep distinct named exports so the
// existing layout/llms imports keep typechecking and any future
// host-specific divergence has a clean home.
export const INSTALL_CMD_MCP = "npx unbrowse setup --mcp";
export const UPGRADE_CMD_MCP = "npm install -g unbrowse@latest && unbrowse setup --mcp";
export const INSTALL_CMD_CODEX = "npx unbrowse setup --mcp";
export const UPGRADE_CMD_CODEX = "npm install -g unbrowse@latest && unbrowse setup --mcp";
export const INSTALL_CMD_CLAUDE = "claude mcp add unbrowse -- npx -y unbrowse mcp";
export const UPGRADE_CMD_CLAUDE = "npm install -g unbrowse@latest && unbrowse setup --mcp";
