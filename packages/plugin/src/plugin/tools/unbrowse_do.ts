import type { ToolDeps } from "./deps.js";
import { TaskWatcher, CapabilityResolver, DesktopAutomation } from "./shared.js";

export function makeUnbrowseDoTool(deps: ToolDeps) {
  const { logger, defaultOutputDir } = deps;

  // Local instances (kept per tool creation like in the original implementation)
  const taskWatcher = new TaskWatcher();
  const capabilityResolver = new CapabilityResolver(defaultOutputDir);
  const desktopAuto = new DesktopAutomation(logger);

  return {
name: "unbrowse_do",
label: "Do Task",
description:
"Meta-tool: figure out how to accomplish a task. Analyzes intent, checks for existing skills, " +
"suggests the best approach (API replay, browser agent, desktop automation, or API capture).",
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
    output += `Use \`unbrowse_capture\` with seedUrl for ${resolution.domain} to capture the API first.\n`;
    break;
  case "desktop":
    output += `Use \`unbrowse_desktop\` with app="${resolution.app}" to control the desktop app.\n`;
    break;
  case "browser_agent":
    output += `Use the \`browse\` tool to navigate and interact with the website.\n`;
    break;
}

return { content: [{ type: "text", text: output }] };
},
};
}
