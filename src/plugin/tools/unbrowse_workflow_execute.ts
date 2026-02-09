import type { ToolDeps } from "./deps.js";
import { WORKFLOW_EXECUTE_SCHEMA, join, existsSync, readFileSync } from "./shared.js";

export function makeUnbrowseWorkflowExecuteTool(deps: ToolDeps) {
  const { logger, defaultOutputDir } = deps;

  return {
name: "unbrowse_workflow_execute",
label: "Execute Workflow",
description:
"Execute a workflow or api-package skill. For workflows, runs the multi-step sequence " +
"with variable substitution and tracks success/failure. For api-packages, makes the API call. " +
"Success tracking enables earnings for skill creators (paid per successful execution).",
parameters: WORKFLOW_EXECUTE_SCHEMA,
async execute(_toolCallId: string, params: unknown) {
const p = params as {
  skillName: string;
  inputs?: Record<string, any>;
  endpoint?: string;
  body?: string;
};

const { getWorkflowExecutor } = await import("../../workflow-executor.js");
const { getSuccessTracker } = await import("../../success-tracker.js");
const { isWorkflowSkill } = await import("../../workflow-types.js");

const skillDir = join(defaultOutputDir, p.skillName);
const skillJsonPath = join(skillDir, "skill.json");

if (!existsSync(skillJsonPath)) {
  return { content: [{ type: "text", text: `Skill not found: ${p.skillName}` }] };
}

try {
  const skill = JSON.parse(readFileSync(skillJsonPath, "utf-8"));
  const executor = getWorkflowExecutor(defaultOutputDir);
  const tracker = getSuccessTracker();

  let result: any;

  if (isWorkflowSkill(skill)) {
    // Execute workflow
    const authTokens = new Map<string, Record<string, string>>();
    const cookies = new Map<string, Record<string, string>>();

    // Load auth for each domain
    for (const domain of skill.domains) {
      const authPath = join(skillDir, "auth.json");
      if (existsSync(authPath)) {
        try {
          const auth = JSON.parse(readFileSync(authPath, "utf-8"));
          if (auth.headers) authTokens.set(domain, auth.headers);
          if (auth.cookies) cookies.set(domain, auth.cookies);
        } catch { /* skip */ }
      }
    }

    result = await executor.executeWorkflow(
      skill,
      p.inputs || {},
      authTokens,
      cookies
    );
  } else {
    // Execute API call
    if (!p.endpoint) {
      return { content: [{ type: "text", text: "For api-package skills, provide an endpoint (e.g., 'GET /users')" }] };
    }

    const [method, path] = p.endpoint.split(" ");
    const authPath = join(skillDir, "auth.json");
    let authHeaders: Record<string, string> = {};
    let authCookies: Record<string, string> = {};

    if (existsSync(authPath)) {
      try {
        const auth = JSON.parse(readFileSync(authPath, "utf-8"));
        authHeaders = auth.headers || {};
        authCookies = auth.cookies || {};
      } catch { /* skip */ }
    }

    result = await executor.executeApiCall(
      skill,
      method,
      path,
      p.body ? JSON.parse(p.body) : undefined,
      authHeaders,
      authCookies
    );
  }

  // Track success/failure for quality metrics (earnings come from sales)
  const metrics = tracker.recordExecution(
    p.skillName,
    skill.category,
    result.success,
    result.duration,
    0, // priceUsdc
    undefined, // creatorWallet
    result.error,
    result.failedStep
  );

  const lines = [
    `Execution ${result.success ? "succeeded" : "failed"}: ${p.skillName}`,
    `Duration: ${result.duration}ms`,
    `Success rate: ${Math.round(metrics.newSuccessRate * 100)}% [${metrics.qualityTier}]`,
  ];

  if (result.error) {
    lines.push(`Error: ${result.error}`);
    if (result.failedStep) {
      lines.push(`Failed step: ${result.failedStep}`);
    }
  }

  if (Object.keys(result.outputs).length > 0) {
    lines.push("", "Outputs:");
    for (const [k, v] of Object.entries(result.outputs)) {
      const val = typeof v === "object" ? JSON.stringify(v).slice(0, 100) : String(v);
      lines.push(`  ${k}: ${val}`);
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
} catch (err) {
  return { content: [{ type: "text", text: `Execution failed: ${(err as Error).message}` }] };
}
},
};
}
