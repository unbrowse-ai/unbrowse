/**
 * Workflow Learner — Analyzes recorded sessions to generate workflow skills.
 *
 * Detects:
 * - Multi-site vs single-site patterns (categorization)
 * - Decision points and conditional logic
 * - Variable extraction and data flow
 * - Repeated patterns that can be parameterized
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type {
  RecordedSession,
  RecordedEntry,
  WorkflowSkill,
  ApiPackageSkill,
  WorkflowStep,
  VariableExtraction,
  DomainAuth,
  WorkflowInput,
  WorkflowOutput,
  ApiEndpoint,
  SkillCategory,
  Skill,
} from "./workflow-types.js";

interface LearningResult {
  category: SkillCategory;
  skill: Skill;
  confidence: number;
  suggestions: string[];
}

export class WorkflowLearner {
  private skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || join(homedir(), ".openclaw", "skills");
    if (!existsSync(this.skillsDir)) {
      mkdirSync(this.skillsDir, { recursive: true });
    }
  }

  /** Analyze a recorded session and generate a skill */
  learnFromSession(session: RecordedSession): LearningResult {
    // Determine category based on domain count and patterns
    const category = this.categorize(session);

    if (category === "api-package") {
      return this.learnApiPackage(session);
    } else {
      return this.learnWorkflow(session);
    }
  }

  /** Categorize session as api-package or workflow */
  private categorize(session: RecordedSession): SkillCategory {
    const entries = session.entries ?? [];
    const domains = new Set(entries.map((e) => e.domain));
    const apiCalls = entries.filter((e) => e.type === "api-call");
    const navigations = entries.filter((e) => e.type === "navigation" || e.type === "page-load");
    const actions = entries.filter((e) => e.type === "action");

    // Single domain with mostly API calls = api-package
    if (domains.size === 1 && apiCalls.length > navigations.length * 2) {
      return "api-package";
    }

    // Multiple domains = workflow
    if (domains.size > 1) {
      return "workflow";
    }

    // Significant browser actions = workflow
    if (actions.length > 3) {
      return "workflow";
    }

    // Has decision annotations = workflow
    const hasDecisions = session.annotations.some((a) => a.type === "decision");
    if (hasDecisions) {
      return "workflow";
    }

    // Complex navigation pattern = workflow
    const navPattern = navigations.map((n) => n.url).join(" -> ");
    if (this.hasComplexNavigation(navigations)) {
      return "workflow";
    }

    // Default to api-package for simple sessions
    return "api-package";
  }

  /** Check if navigation pattern is complex */
  private hasComplexNavigation(navigations: RecordedEntry[]): boolean {
    if (navigations.length < 3) return false;

    // Check for back-and-forth navigation (could indicate decision points)
    const urls = navigations.map((n) => n.url);
    for (let i = 2; i < urls.length; i++) {
      if (urls[i] === urls[i - 2]) {
        return true; // Went back to a previous page
      }
    }

    // Check for many unique paths on same domain
    const paths = new Set(urls.map((u) => new URL(u).pathname));
    return paths.size > 5;
  }

  /** Learn an API package from a single-site session */
  private learnApiPackage(session: RecordedSession): LearningResult {
    const apiCalls = (session.entries ?? []).filter((e) => e.type === "api-call");
    if (apiCalls.length === 0) {
      // Fallback: treat as minimal workflow
      return this.learnWorkflow(session);
    }

    const domain = session.domains[0] || new URL(apiCalls[0].url).hostname;
    const baseUrl = this.detectBaseUrl(apiCalls);
    const auth = this.detectAuth(apiCalls, domain);
    const endpoints = this.extractEndpoints(apiCalls, baseUrl);
    const name = this.generateName(domain, "api");

    const skill: ApiPackageSkill = {
      name,
      version: "1.0.0",
      category: "api-package",
      description: `API client for ${domain}. Captured ${endpoints.length} endpoints.`,
      domain,
      baseUrl,
      auth,
      endpoints,
      metrics: {
        totalCalls: 0,
        successfulCalls: 0,
        successRate: 0,
        avgResponseTime: 0,
        totalEarnings: 0,
      },
    };

    const suggestions = this.generateApiSuggestions(skill, session);

    return {
      category: "api-package",
      skill,
      confidence: this.calculateConfidence(session, "api-package"),
      suggestions,
    };
  }

  /** Learn a workflow from a multi-site or complex session */
  private learnWorkflow(session: RecordedSession): LearningResult {
    const entries = session.entries ?? [];
    const domains = Array.from(new Set(entries.map((e) => e.domain)));
    const auth = domains.map((d) => this.detectAuthForDomain(entries, d));
    const steps = this.extractWorkflowSteps(session);
    const inputs = this.detectInputs(session, steps);
    const outputs = this.detectOutputs(session, steps);
    const triggers = this.generateTriggers(session);
    const name = this.generateName(domains[0], "workflow", session.detectedIntent);

    const skill: WorkflowSkill = {
      name,
      version: "1.0.0",
      category: "workflow",
      description: session.detectedIntent ||
        `Cross-site workflow involving ${domains.join(", ")}. ${steps.length} steps.`,
      triggers,
      domains,
      auth,
      inputs,
      outputs,
      steps,
      metrics: {
        totalExecutions: 0,
        successfulExecutions: 0,
        successRate: 0,
        avgExecutionTime: 0,
        failurePoints: [],
        totalEarnings: 0,
      },
    };

    const suggestions = this.generateWorkflowSuggestions(skill, session);

    return {
      category: "workflow",
      skill,
      confidence: this.calculateConfidence(session, "workflow"),
      suggestions,
    };
  }

  /** Detect base URL from API calls */
  private detectBaseUrl(entries: RecordedEntry[]): string {
    const urls = entries.map((e) => e.url);
    if (urls.length === 0) return "";

    // Find common prefix
    const parsed = urls.map((u) => new URL(u));
    const firstOrigin = `${parsed[0].protocol}//${parsed[0].host}`;

    // Check if all URLs share the same origin
    if (parsed.every((p) => `${p.protocol}//${p.host}` === firstOrigin)) {
      // Look for common path prefix
      const paths = parsed.map((p) => p.pathname);
      const commonPrefix = this.findCommonPrefix(paths);
      if (commonPrefix && commonPrefix !== "/") {
        return firstOrigin + commonPrefix;
      }
      return firstOrigin;
    }

    return firstOrigin;
  }

  /** Find common prefix in paths */
  private findCommonPrefix(paths: string[]): string {
    if (paths.length === 0) return "";
    if (paths.length === 1) return paths[0];

    const parts = paths.map((p) => p.split("/").filter(Boolean));
    const common: string[] = [];

    for (let i = 0; i < parts[0].length; i++) {
      const segment = parts[0][i];
      if (parts.every((p) => p[i] === segment)) {
        common.push(segment);
      } else {
        break;
      }
    }

    return common.length > 0 ? "/" + common.join("/") : "";
  }

  /** Detect auth method from API calls */
  private detectAuth(entries: RecordedEntry[], domain: string): DomainAuth {
    const headers: Record<string, string>[] = entries
      .filter((e) => e.headers)
      .map((e) => e.headers!);

    // Check for Bearer token
    for (const h of headers) {
      const authHeader = Object.entries(h).find(
        ([k]) => k.toLowerCase() === "authorization"
      );
      if (authHeader && authHeader[1].startsWith("Bearer ")) {
        return {
          domain,
          authType: "bearer",
          headerName: "Authorization",
          refreshable: false,
        };
      }
    }

    // Check for API key headers
    for (const h of headers) {
      const apiKey = Object.entries(h).find(
        ([k]) => k.toLowerCase().includes("api-key") || k.toLowerCase().includes("x-api")
      );
      if (apiKey) {
        return {
          domain,
          authType: "api-key",
          headerName: apiKey[0],
        };
      }
    }

    // Check for cookies
    const cookieEntry = entries.find((e) => e.cookies && Object.keys(e.cookies).length > 0);
    if (cookieEntry) {
      return {
        domain,
        authType: "cookie",
        cookieNames: Object.keys(cookieEntry.cookies!),
      };
    }

    return { domain, authType: "none" };
  }

  /** Detect auth for a specific domain */
  private detectAuthForDomain(entries: RecordedEntry[], domain: string): DomainAuth {
    const domainEntries = entries.filter((e) => e.domain === domain);
    return this.detectAuth(domainEntries, domain);
  }

  /** Extract unique endpoints from API calls */
  private extractEndpoints(entries: RecordedEntry[], baseUrl: string): ApiEndpoint[] {
    const endpointMap = new Map<string, ApiEndpoint>();

    for (const entry of entries) {
      if (entry.type !== "api-call" || !entry.method) continue;

      const url = new URL(entry.url);
      let path = url.pathname;

      // Remove base path if present
      const basePath = new URL(baseUrl).pathname;
      if (path.startsWith(basePath)) {
        path = path.slice(basePath.length) || "/";
      }

      // Parameterize path (detect IDs)
      const parameterizedPath = this.parameterizePath(path);
      const key = `${entry.method} ${parameterizedPath}`;

      if (!endpointMap.has(key)) {
        endpointMap.set(key, {
          method: entry.method,
          path: parameterizedPath,
          description: this.guessEndpointDescription(entry.method, parameterizedPath),
          verified: entry.responseStatus !== undefined && entry.responseStatus >= 200 && entry.responseStatus < 300,
          queryParams: this.extractQueryParams(url),
          requestSchema: entry.requestBody ? this.inferSchema(entry.requestBody) : undefined,
          responseSchema: entry.responseBody ? this.inferSchema(entry.responseBody) : undefined,
        });
      }
    }

    return Array.from(endpointMap.values());
  }

  /** Parameterize path segments that look like IDs */
  private parameterizePath(path: string): string {
    return path.split("/").map((segment) => {
      // UUID pattern
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
        return "{id}";
      }
      // Numeric ID
      if (/^\d+$/.test(segment) && segment.length > 1) {
        return "{id}";
      }
      // Alphanumeric ID (8+ chars, mixed case/numbers)
      if (/^[a-zA-Z0-9]{8,}$/.test(segment) && /\d/.test(segment) && /[a-zA-Z]/.test(segment)) {
        return "{id}";
      }
      return segment;
    }).join("/");
  }

  /** Extract query parameters from URL */
  private extractQueryParams(url: URL): ApiEndpoint["queryParams"] {
    const params: ApiEndpoint["queryParams"] = [];
    for (const [name, value] of url.searchParams) {
      params.push({
        name,
        type: this.inferType(value),
        description: "",
        required: false,
      });
    }
    return params.length > 0 ? params : undefined;
  }

  /** Infer type from value */
  private inferType(value: any): string {
    if (typeof value === "number") return "number";
    if (typeof value === "boolean") return "boolean";
    if (Array.isArray(value)) return "array";
    if (typeof value === "object" && value !== null) return "object";
    if (typeof value === "string") {
      if (/^\d+$/.test(value)) return "number";
      if (value === "true" || value === "false") return "boolean";
    }
    return "string";
  }

  /** Infer schema from object */
  private inferSchema(obj: any): Record<string, any> | undefined {
    if (obj === null || obj === undefined) return undefined;
    if (typeof obj !== "object") return { type: typeof obj };
    if (obj._truncated) return { type: "object", truncated: true };

    if (Array.isArray(obj) || obj._type === "array") {
      const sample = Array.isArray(obj) ? obj[0] : obj._sample?.[0];
      return {
        type: "array",
        items: sample ? this.inferSchema(sample) : { type: "unknown" },
      };
    }

    const properties: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key.startsWith("_")) continue;
      properties[key] = this.inferSchema(value);
    }
    return { type: "object", properties };
  }

  /** Guess endpoint description from method and path */
  private guessEndpointDescription(method: string, path: string): string {
    const lastSegment = path.split("/").filter(Boolean).pop() || "resource";
    const isParam = lastSegment.startsWith("{");
    const resource = isParam
      ? path.split("/").filter(Boolean).slice(-2, -1)[0] || "resource"
      : lastSegment;

    switch (method) {
      case "GET":
        return isParam ? `Get ${resource} by ID` : `List ${resource}`;
      case "POST":
        return `Create ${resource}`;
      case "PUT":
      case "PATCH":
        return `Update ${resource}`;
      case "DELETE":
        return `Delete ${resource}`;
      default:
        return `${method} ${resource}`;
    }
  }

  /** Extract workflow steps from session */
  private extractWorkflowSteps(session: RecordedSession): WorkflowStep[] {
    const steps: WorkflowStep[] = [];
    let stepId = 1;

    for (const entry of session.entries) {
      const step = this.entryToStep(entry, `step-${stepId}`);
      if (step) {
        steps.push(step);
        stepId++;
      }
    }

    // Detect data dependencies between steps
    this.detectDependencies(steps);

    // Identify decision points from annotations
    for (const annotation of session.annotations) {
      if (annotation.type === "decision" && steps[annotation.stepIndex]) {
        const step = steps[annotation.stepIndex];
        step.type = "decision";
        step.description = annotation.note;
      }
    }

    return steps;
  }

  /** Convert session entry to workflow step */
  private entryToStep(entry: RecordedEntry, id: string): WorkflowStep | null {
    switch (entry.type) {
      case "navigation":
      case "page-load":
        return {
          id,
          type: "navigate",
          target: entry.url,
          domain: entry.domain,
          description: `Navigate to ${new URL(entry.url).pathname}`,
        };

      case "api-call":
        return {
          id,
          type: "api-call",
          target: entry.url,
          method: entry.method,
          domain: entry.domain,
          description: `${entry.method} ${new URL(entry.url).pathname}`,
          extracts: this.detectExtractions(entry),
        };

      case "action":
        return {
          id,
          type: "action",
          target: entry.url,
          domain: entry.domain,
          description: `${entry.action?.type || "Action"} on page`,
          action: entry.action,
        };

      default:
        return null;
    }
  }

  /** Detect variables that could be extracted from a step */
  private detectExtractions(entry: RecordedEntry): VariableExtraction[] | undefined {
    if (!entry.responseBody || typeof entry.responseBody !== "object") return undefined;

    const extractions: VariableExtraction[] = [];

    // Look for common extractable patterns
    const body = entry.responseBody;
    const checkKeys = ["id", "token", "access_token", "refresh_token", "session", "user_id", "data"];

    for (const key of checkKeys) {
      if (body[key] !== undefined) {
        extractions.push({
          name: key,
          path: `$.${key}`,
          source: "json",
          required: key.includes("token") || key === "id",
        });
      }
    }

    return extractions.length > 0 ? extractions : undefined;
  }

  /** Detect data dependencies between steps */
  private detectDependencies(steps: WorkflowStep[]): void {
    const availableVars = new Map<string, string>(); // varName -> stepId

    for (const step of steps) {
      // Check if this step uses any previously extracted variables
      const deps: string[] = [];

      if (step.type === "api-call" && step.target) {
        // Check URL for variable patterns
        for (const [varName, sourceStep] of availableVars) {
          if (step.target.includes(`{${varName}}`) || step.target.includes(varName)) {
            deps.push(sourceStep);
          }
        }
      }

      if (deps.length > 0) {
        step.dependsOn = [...new Set(deps)];
      }

      // Register any variables this step extracts
      if (step.extracts) {
        for (const extraction of step.extracts) {
          availableVars.set(extraction.name, step.id);
        }
      }
    }
  }

  /** Detect input parameters for workflow */
  private detectInputs(session: RecordedSession, steps: WorkflowStep[]): WorkflowInput[] {
    const inputs: WorkflowInput[] = [];

    // Look for patterns that suggest user input
    for (const step of steps) {
      if (step.type === "action" && step.action?.type === "type" && step.action.value) {
        // This might be a form field
        const inputName = step.action.selector?.replace(/[^a-zA-Z]/g, "_") || `input_${inputs.length + 1}`;
        inputs.push({
          name: inputName,
          type: "string",
          description: `Input value for ${step.action.selector || "form field"}`,
          required: true,
        });
      }
    }

    // Look for path parameters in URLs
    const pathParams = new Set<string>();
    for (const step of steps) {
      if (step.target) {
        const matches = step.target.match(/\{([^}]+)\}/g);
        if (matches) {
          for (const match of matches) {
            pathParams.add(match.slice(1, -1));
          }
        }
      }
    }

    for (const param of pathParams) {
      if (!inputs.some((i) => i.name === param)) {
        inputs.push({
          name: param,
          type: "string",
          description: `Path parameter: ${param}`,
          required: true,
        });
      }
    }

    return inputs;
  }

  /** Detect outputs from workflow */
  private detectOutputs(session: RecordedSession, steps: WorkflowStep[]): WorkflowOutput[] {
    const outputs: WorkflowOutput[] = [];

    // Look at the last API call's response
    const apiSteps = steps.filter((s) => s.type === "api-call" && s.extracts);
    const lastApiStep = apiSteps[apiSteps.length - 1];

    if (lastApiStep?.extracts) {
      for (const extraction of lastApiStep.extracts) {
        outputs.push({
          name: extraction.name,
          type: "string",
          description: `Extracted from final API response`,
          fromStep: lastApiStep.id,
          path: extraction.path,
        });
      }
    }

    return outputs;
  }

  /** Generate trigger phrases for workflow */
  private generateTriggers(session: RecordedSession): string[] {
    const triggers: string[] = [];

    if (session.detectedIntent) {
      triggers.push(session.detectedIntent);
    }

    // Generate from domains
    for (const domain of session.domains) {
      const cleanDomain = domain.replace(/^(www|api|app)\./, "").split(".")[0];
      triggers.push(`use ${cleanDomain}`);
      triggers.push(`interact with ${cleanDomain}`);
    }

    // Generate from intent annotations
    for (const annotation of session.annotations) {
      if (annotation.type === "intent") {
        triggers.push(annotation.note.toLowerCase());
      }
    }

    return [...new Set(triggers)];
  }

  /** Generate name for skill */
  private generateName(domain: string, type: string, intent?: string): string {
    const cleanDomain = domain.replace(/^(www|api|app)\./, "").split(".")[0];

    if (intent) {
      const intentSlug = intent
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 30);
      return `${cleanDomain}-${intentSlug}`;
    }

    return `${cleanDomain}-${type}`;
  }

  /** Calculate confidence score */
  private calculateConfidence(session: RecordedSession, category: SkillCategory): number {
    let confidence = 0.5; // Base confidence
    const entries = session.entries ?? [];
    const annotations = session.annotations ?? [];

    // More entries = higher confidence
    confidence += Math.min(entries.length / 50, 0.2);

    // Annotations increase confidence
    confidence += Math.min(annotations.length / 10, 0.15);

    // Successful responses increase confidence
    const successfulCalls = entries.filter(
      (e) => e.responseStatus && e.responseStatus >= 200 && e.responseStatus < 300
    ).length;
    confidence += Math.min(entries.length > 0 ? successfulCalls / entries.length : 0, 0.15);

    return Math.min(confidence, 1);
  }

  /** Generate suggestions for API package */
  private generateApiSuggestions(skill: ApiPackageSkill, session: RecordedSession): string[] {
    const suggestions: string[] = [];

    if (skill.auth.authType === "none") {
      suggestions.push("No authentication detected. Consider re-recording with logged-in session.");
    }

    if (skill.endpoints.length < 3) {
      suggestions.push("Few endpoints captured. Browse more pages to discover additional APIs.");
    }

    const unverified = skill.endpoints.filter((e) => !e.verified).length;
    if (unverified > 0) {
      suggestions.push(`${unverified} endpoints not verified. Some may require specific conditions.`);
    }

    return suggestions;
  }

  /** Generate suggestions for workflow */
  private generateWorkflowSuggestions(skill: WorkflowSkill, session: RecordedSession): string[] {
    const suggestions: string[] = [];

    if (skill.inputs.length === 0) {
      suggestions.push("No inputs detected. Consider adding annotations to mark user input fields.");
    }

    if (skill.outputs.length === 0) {
      suggestions.push("No outputs detected. Mark important values in the final response.");
    }

    const noDecisions = skill.steps.filter((s) => s.type === "decision").length === 0;
    if (noDecisions && skill.steps.length > 5) {
      suggestions.push("No decision points found. Add 'decision' annotations to mark conditional logic.");
    }

    return suggestions;
  }

  /** Save learned skill to disk */
  saveSkill(result: LearningResult): string {
    const skillDir = join(this.skillsDir, result.skill.name);
    if (!existsSync(skillDir)) {
      mkdirSync(skillDir, { recursive: true });
    }

    // Save as YAML-like SKILL.md
    const skillMd = this.generateSkillMd(result);
    writeFileSync(join(skillDir, "SKILL.md"), skillMd, "utf-8");

    // Save full skill definition as JSON
    writeFileSync(
      join(skillDir, "skill.json"),
      JSON.stringify(result.skill, null, 2),
      "utf-8"
    );

    return skillDir;
  }

  /** Generate SKILL.md content */
  private generateSkillMd(result: LearningResult): string {
    const skill = result.skill;
    const isWorkflow = skill.category === "workflow";

    let md = `---
name: ${skill.name}
version: ${skill.version}
category: ${skill.category}
description: >-
  ${skill.description}
`;

    if (isWorkflow) {
      const wf = skill as WorkflowSkill;
      md += `domains: [${wf.domains.join(", ")}]
triggers:
${wf.triggers.map((t) => `  - "${t}"`).join("\n")}
`;
    } else {
      const api = skill as ApiPackageSkill;
      md += `domain: ${api.domain}
baseUrl: ${api.baseUrl}
authType: ${api.auth.authType}
`;
    }

    md += `---

# ${skill.name}

**Category:** ${skill.category}
**Confidence:** ${Math.round(result.confidence * 100)}%

`;

    if (isWorkflow) {
      const wf = skill as WorkflowSkill;
      md += `## Domains

${wf.domains.map((d) => `- ${d}`).join("\n")}

## Steps

${wf.steps.map((s, i) => `${i + 1}. **${s.type}**: ${s.description}`).join("\n")}

## Inputs

${wf.inputs.length > 0
        ? wf.inputs.map((i) => `- \`${i.name}\` (${i.type}${i.required ? ", required" : ""}): ${i.description}`).join("\n")
        : "No inputs detected."}

## Outputs

${wf.outputs.length > 0
        ? wf.outputs.map((o) => `- \`${o.name}\` (${o.type}): ${o.description}`).join("\n")
        : "No outputs detected."}
`;
    } else {
      const api = skill as ApiPackageSkill;
      md += `## Authentication

**Type:** ${api.auth.authType}
${api.auth.headerName ? `**Header:** ${api.auth.headerName}` : ""}
${api.auth.cookieNames ? `**Cookies:** ${api.auth.cookieNames.join(", ")}` : ""}

## Endpoints

${api.endpoints.map((e) => `- \`${e.method} ${e.path}\` — ${e.description}${e.verified ? " ✓" : ""}`).join("\n")}
`;
    }

    if (result.suggestions.length > 0) {
      md += `
## Suggestions

${result.suggestions.map((s) => `- ${s}`).join("\n")}
`;
    }

    return md;
  }
}

/** Singleton instance */
let learnerInstance: WorkflowLearner | null = null;

export function getWorkflowLearner(skillsDir?: string): WorkflowLearner {
  if (!learnerInstance) {
    learnerInstance = new WorkflowLearner(skillsDir);
  }
  return learnerInstance;
}
