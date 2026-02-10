import type { ToolDeps } from "./deps.js";
import {
  existsSync,
  readFileSync,
  readdirSync,
  join,
  SKILLS_SCHEMA,
} from "./shared.js";

export function makeUnbrowseSkillsTool(deps: ToolDeps) {
  const { logger, defaultOutputDir, autoDiscoverEnabled } = deps;

  return {
name: "unbrowse_skills",
label: "List Internal APIs",
description:
  "List all captured internal API skills. Shows the site name, number of reverse-engineered " +
  "endpoints, and auth method (session cookies, tokens, etc.) for each.",
parameters: SKILLS_SCHEMA,
async execute() {
  const creatorWallet = deps.walletState?.creatorWallet;
  const solanaPrivateKey = deps.walletState?.solanaPrivateKey;
  const skills: string[] = [];

  try {
    if (existsSync(defaultOutputDir)) {
      const entries = readdirSync(defaultOutputDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillMd = join(defaultOutputDir, entry.name, "SKILL.md");
        const authJson = join(defaultOutputDir, entry.name, "auth.json");

        if (!existsSync(skillMd)) continue;

        let authMethod = "unknown";
        let endpointCount = 0;
        let baseUrl = "";

        if (existsSync(authJson)) {
          try {
            const auth = JSON.parse(readFileSync(authJson, "utf-8"));
            authMethod = auth.authMethod ?? "unknown";
            baseUrl = auth.baseUrl ?? "";
          } catch { /* skip */ }
        }

        // Count endpoints from SKILL.md
        const md = readFileSync(skillMd, "utf-8");
        const matches = md.match(/`(GET|POST|PUT|DELETE|PATCH)\s+[^`]+`/g);
        endpointCount = matches?.length ?? 0;

        skills.push(`  ${entry.name} — ${endpointCount} endpoints, ${authMethod}${baseUrl ? ` (${baseUrl})` : ""}`);
      }
    }
  } catch { /* dir doesn't exist */ }

  // Wallet funding prompt
  const walletNote = creatorWallet && !solanaPrivateKey
    ? `\n\nWallet: ${creatorWallet}\nSend USDC (Solana) to this address to discover and download skills from other agents.`
    : creatorWallet
      ? `\n\nWallet: ${creatorWallet} (ready for marketplace)`
      : "";

  if (skills.length === 0) {
    return { content: [{ type: "text", text: `No skills discovered yet. Use unbrowse_learn, unbrowse_capture, or browse APIs to auto-discover.${walletNote}` }] };
  }

  const autoLabel = autoDiscoverEnabled ? " (auto-discover ON)" : "";
  return {
    content: [{
      type: "text",
      text: `Discovered skills (${skills.length})${autoLabel}:\n${skills.join("\n")}${walletNote}`,
    }],
  };
},
};
}
