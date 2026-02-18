import type { ToolDeps } from "./deps.js";
import { WORKFLOW_LEARN_SCHEMA } from "./shared.js";

export function makeUnbrowseWorkflowLearnTool(deps: ToolDeps) {
  const { logger, defaultOutputDir } = deps;

  return {
name: "unbrowse_workflow_learn",
label: "Learn Workflow",
description:
"Analyze a recorded session and generate a skill. Automatically categorizes as either " +
"'api-package' (single-site API collection) or 'workflow' (multi-site orchestration) " +
"based on the recorded patterns. Detects decision points, variable extraction, and data flow.",
parameters: WORKFLOW_LEARN_SCHEMA,
async execute(_toolCallId: string, params: unknown) {
const p = params as { sessionId: string; outputDir?: string };

const { getWorkflowRecorder } = await import("../../workflow-recorder.js");
const { getWorkflowLearner } = await import("../../workflow-learner.js");

const recorder = getWorkflowRecorder();
const learner = getWorkflowLearner(p.outputDir ?? defaultOutputDir);

const session = recorder.loadSession(p.sessionId);
if (!session) {
  return { content: [{ type: "text", text: `Session not found: ${p.sessionId}` }] };
}

try {
  const result = learner.learnFromSession(session);
  const skillDir = learner.saveSkill(result);

  const lines = [
    `Skill generated: ${result.skill.name}`,
    `Category: ${result.category}`,
    `Confidence: ${Math.round(result.confidence * 100)}%`,
    `Installed: ${skillDir}`,
  ];

  if (result.category === "workflow") {
    const wf = result.skill as any;
    lines.push(`Domains: ${wf.domains.join(", ")}`);
    lines.push(`Steps: ${wf.steps.length}`);
    lines.push(`Inputs: ${wf.inputs.length}`);
    lines.push(`Outputs: ${wf.outputs.length}`);
  } else {
    const api = result.skill as any;
    lines.push(`Domain: ${api.domain}`);
    lines.push(`Endpoints: ${api.endpoints.length}`);
    lines.push(`Auth: ${api.auth.authType}`);
  }

  if (result.suggestions.length > 0) {
    lines.push("", "Suggestions:");
    for (const s of result.suggestions) {
      lines.push(`  - ${s}`);
    }
  }

  logger.info(`[unbrowse] Workflow learned: ${result.skill.name} (${result.category})`);
  return { content: [{ type: "text", text: lines.join("\n") }] };
} catch (err) {
  return { content: [{ type: "text", text: `Learning failed: ${(err as Error).message}` }] };
}
},
};
}
