export const REPO_CLONE_URL = "https://github.com/unbrowse-ai/unbrowse.git";

export const INSTALL_CMD_GENERIC =
  `git clone --single-branch --depth 1 ${REPO_CLONE_URL} ~/unbrowse && cd ~/unbrowse && ./setup --host off`;

export const UPGRADE_CMD_GENERIC =
  "cd ~/unbrowse && git pull --ff-only && ./setup --host off";

export const INSTALL_CMD_CODEX =
  `git clone --single-branch --depth 1 ${REPO_CLONE_URL} ~/.codex/skills/unbrowse && cd ~/.codex/skills/unbrowse && ./setup --host codex`;

export const UPGRADE_CMD_CODEX =
  "cd ~/.codex/skills/unbrowse && git pull --ff-only && ./setup --host codex";

export const INSTALL_CMD_CLAUDE =
  `git clone --single-branch --depth 1 ${REPO_CLONE_URL} ~/.claude/skills/unbrowse && cd ~/.claude/skills/unbrowse && ./setup --host claude`;

export const UPGRADE_CMD_CLAUDE =
  "cd ~/.claude/skills/unbrowse && git pull --ff-only && ./setup --host claude";
