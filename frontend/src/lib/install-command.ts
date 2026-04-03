export const REPO_CLONE_URL = "https://github.com/unbrowse-ai/unbrowse.git";
export const INSTALL_SCRIPT_URL = "https://unbrowse.ai/install.sh";

export const INSTALL_CMD_GENERIC = `curl -fsSL ${INSTALL_SCRIPT_URL} | bash`;
export const INSTALL_CMD_SKILL = "npx skills add unbrowse-ai/unbrowse";
export const INSTALL_CMD_NPM = "npm install -g unbrowse && unbrowse setup";
export const VERIFY_CMD = "unbrowse health --pretty";
export const FIRST_TASK_CMD =
  'unbrowse resolve --intent "get trending searches" --url "https://google.com" --pretty';

export const UPGRADE_CMD_GENERIC = INSTALL_CMD_GENERIC;

export const INSTALL_CMD_MCP =
  `git clone --single-branch --depth 1 ${REPO_CLONE_URL} ~/unbrowse && cd ~/unbrowse && ./setup --host mcp`;

export const UPGRADE_CMD_MCP =
  "cd ~/unbrowse && git pull --ff-only && ./setup --host mcp";

export const MCP_CONFIG_PATH = "~/.config/unbrowse/mcp/unbrowse.json";

export const MCP_CONFIG_JSON = JSON.stringify({
  mcpServers: {
    unbrowse: {
      command: "unbrowse",
      args: ["mcp"],
    },
  },
}, null, 2);

export const INSTALL_CMD_CODEX =
  `git clone --single-branch --depth 1 ${REPO_CLONE_URL} ~/.codex/skills/unbrowse && cd ~/.codex/skills/unbrowse && ./setup --host codex`;

export const UPGRADE_CMD_CODEX =
  "cd ~/.codex/skills/unbrowse && git pull --ff-only && ./setup --host codex";

export const INSTALL_CMD_CLAUDE =
  `git clone --single-branch --depth 1 ${REPO_CLONE_URL} ~/.claude/skills/unbrowse && cd ~/.claude/skills/unbrowse && ./setup --host claude`;

export const UPGRADE_CMD_CLAUDE =
  "cd ~/.claude/skills/unbrowse && git pull --ff-only && ./setup --host claude";
