import type { ToolDeps } from "./deps.js";
import { TaskWatcher, CapabilityResolver, DesktopAutomation } from "./shared.js";

export function makeUnbrowseDoTool(deps: ToolDeps) {
  const { logger, defaultOutputDir, indexClient, skillIndexUrl } = deps;

  // Local instances (kept per tool creation like in the original implementation)
  const taskWatcher = new TaskWatcher();
  const capabilityResolver = new CapabilityResolver(defaultOutputDir);
  const desktopAuto = new DesktopAutomation(logger);

  function buildMarketplaceQuery(intent: any, rawTask: string): string {
    const domain = String(intent?.domain || "").trim();
    const action = String(intent?.action || "").trim();
    const task = String(rawTask || "").trim();
    const parts = [
      domain,
      action && action !== "auth" ? action : "",
      // Keep a small slice of the user task to help ranking.
      task.length > 80 ? task.slice(0, 80) : task,
    ].filter(Boolean);
    // Avoid ultra-long queries (some backends may have limits).
    return parts.join(" ").slice(0, 160);
  }

  return {
name: "unbrowse_do",
label: "Do Task",
description:
"Meta-tool: figure out how to accomplish a task. Analyzes intent, checks for existing skills, " +
"and can search/install marketplace skills before recommending reverse-engineering. " +
"Suggests the best approach (marketplace skill, local replay, browser agent, desktop automation, or API capture).",
parameters: {
type: "object" as const,
properties: {
  task: {
    type: "string" as const,
    description: "What you want to accomplish (e.g., 'post a tweet', 'create a Linear ticket')",
  },
  domain: {
    type: "string" as const,
    description: "The service/website this relates to (e.g., 'twitter', 'linear', 'notion')",
  },
},
required: ["task"],
},
async execute(_toolCallId: string, params: unknown) {
const p = params as { task: string; domain?: string };
const intent = taskWatcher.parseIntent(p.task);
if (p.domain) intent.domain = p.domain;

// 1) Search marketplace first (best case: avoid re-capture).
// Keep this best-effort and non-fatal (offline / no backend / no wallet).
if (typeof (indexClient as any)?.search === "function") {
  try {
    const q = buildMarketplaceQuery(intent, p.task);
    if (q) {
      const results = await (indexClient as any).search(q, { limit: 5 });
      const skills = Array.isArray(results?.skills) ? results.skills : [];
      if (skills.length > 0) {
        let out = `## Task Analysis\n\n`;
        out += `**Task**: ${p.task}\n`;
        out += `**Domain**: ${intent.domain || "unknown"}\n`;
        out += `**Action**: ${intent.action || "unknown"}\n\n`;

        out += `## 1) Marketplace Search (hit)\n\n`;
        out += `Found ${skills.length} candidate skill(s) on ${skillIndexUrl} for query: "${q}".\n\n`;
        out += `## 2) Install + Use Existing Skill\n\n`;
        out += `Pick one and install it:\n`;
        for (const s of skills.slice(0, 5)) {
          out += `- ${s.name} (id=${s.skillId})\n`;
        }
        out += `\nNext steps:\n`;
        out += `- Install: unbrowse_search { "install": "<skillId>" }\n`;
        out += `- Capture your auth: unbrowse_login (or unbrowse_auth if already logged in)\n`;
        out += `- Execute: unbrowse_replay (local) or executionMode="backend" if it’s a proxy-only skill\n`;

        return { content: [{ type: "text", text: out }] };
      }
    }
  } catch (err) {
    // Silent fallback to local resolution.
  }
}

// 2) Use existing local skills, else 3) reverse-engineer, else fallbacks.
const resolution = await capabilityResolver.resolve(intent);
const recommendation = capabilityResolver.getRecommendation(resolution);

let output = `## Task Analysis\n\n`;
output += `**Task**: ${p.task}\n`;
output += `**Domain**: ${intent.domain || "unknown"}\n`;
output += `**Action**: ${intent.action || "unknown"}\n`;
output += `**Confidence**: ${Math.round(intent.confidence * 100)}%\n\n`;

output += `## Recommended Approach: ${resolution.strategy}\n\n`;
output += recommendation + "\n\n";

// Include skill details if available
if (resolution.skill) {
  output += `### Available Skill: ${resolution.skill.name}\n`;
  output += `- **Path**: ${resolution.skill.path}\n`;
  output += `- **Auth**: ${resolution.skill.hasAuth ? "stored" : "none"}\n`;
  output += `- **Endpoints**:\n`;
  for (const ep of resolution.skill.endpoints.slice(0, 5)) {
    output += `  - ${ep}\n`;
  }
  if (resolution.skill.endpoints.length > 5) {
    output += `  - ...and ${resolution.skill.endpoints.length - 5} more\n`;
  }
}

// Provide next step instructions
output += `\n## Next Step\n\n`;
switch (resolution.strategy) {
  case "skill":
    output += `Use \`unbrowse_replay\` with skillName="${resolution.skill!.name}" to call the API.\n`;
    break;
  case "capture":
    output += `Reverse-engineer:\n`;
    output += `- Login: unbrowse_login (or unbrowse_browse)\n`;
    output += `- Capture: unbrowse_capture / learn-on-the-fly via unbrowse_browse\n`;
    output += `- Publish: unbrowse_publish (optional)\n`;
    output += `- Execute: unbrowse_replay\n`;
    break;
  case "desktop":
    output += `Use \`unbrowse_desktop\` with app="${resolution.app}" to control the desktop app.\n`;
    break;
  case "browser_agent":
    output += `Use \`unbrowse_browse\` to navigate and interact with the website (more reliable than the built-in browser tool).\n`;
    break;
}

return { content: [{ type: "text", text: output }] };
},
};
}
