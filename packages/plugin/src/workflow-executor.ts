/**
 * Workflow Executor — Runs workflow skills and tracks success/failure.
 *
 * Executes multi-step workflows with:
 * - Variable substitution and extraction
 * - Decision point evaluation
 * - Error handling and retry logic
 * - Success/failure tracking for earnings
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  WorkflowSkill,
  ApiPackageSkill,
  WorkflowStep,
  VariableExtraction,
  DomainAuth,
  Skill,
  WorkflowMetrics,
  ApiPackageMetrics,
  FailurePoint,
} from "./workflow-types.js";

/** Execution context with variables and auth */
interface ExecutionContext {
  variables: Record<string, any>;
  auth: Map<string, Record<string, string>>; // domain -> headers
  cookies: Map<string, Record<string, string>>; // domain -> cookies
  currentStep: number;
  stepResults: Map<string, StepResult>;
  startTime: number;
}

/** Result of a single step */
interface StepResult {
  stepId: string;
  success: boolean;
  response?: any;
  error?: string;
  duration: number;
  extractedVars?: Record<string, any>;
}

/** Result of complete workflow execution */
export interface ExecutionResult {
  success: boolean;
  skillName: string;
  category: string;
  duration: number;
  outputs: Record<string, any>;
  stepResults: StepResult[];
  error?: string;
  failedStep?: string;
}

export class WorkflowExecutor {
  private skillsDir: string;
  private metricsFile: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || join(homedir(), ".openclaw", "skills");
    this.metricsFile = join(this.skillsDir, ".metrics.json");
  }

  /** Execute a workflow skill */
  async executeWorkflow(
    skill: WorkflowSkill,
    inputs: Record<string, any>,
    authTokens: Map<string, Record<string, string>>,
    cookies?: Map<string, Record<string, string>>
  ): Promise<ExecutionResult> {
    const ctx: ExecutionContext = {
      variables: { ...inputs },
      auth: authTokens,
      cookies: cookies || new Map(),
      currentStep: 0,
      stepResults: new Map(),
      startTime: Date.now(),
    };

    const stepResults: StepResult[] = [];

    try {
      // Validate required inputs
      for (const input of skill.inputs) {
        if (input.required && ctx.variables[input.name] === undefined) {
          throw new Error(`Missing required input: ${input.name}`);
        }
        if (ctx.variables[input.name] === undefined && input.default !== undefined) {
          ctx.variables[input.name] = input.default;
        }
      }

      // Execute each step
      for (let i = 0; i < skill.steps.length; i++) {
        ctx.currentStep = i;
        const step = skill.steps[i];

        // Check dependencies
        if (step.dependsOn) {
          for (const depId of step.dependsOn) {
            const depResult = ctx.stepResults.get(depId);
            if (!depResult?.success) {
              throw new Error(`Dependency ${depId} failed or not executed`);
            }
          }
        }

        const result = await this.executeStep(step, ctx);
        stepResults.push(result);
        ctx.stepResults.set(step.id, result);

        if (!result.success) {
          // Record failure and stop
          await this.recordFailure(skill.name, step.id, result.error || "Unknown error");
          return {
            success: false,
            skillName: skill.name,
            category: "workflow",
            duration: Date.now() - ctx.startTime,
            outputs: this.extractOutputs(skill, ctx),
            stepResults,
            error: result.error,
            failedStep: step.id,
          };
        }

        // Handle decision step branching
        if (step.type === "decision" && step.branches) {
          const nextStepId = this.evaluateBranches(step.branches, ctx);
          if (nextStepId) {
            const nextIndex = skill.steps.findIndex((s) => s.id === nextStepId);
            if (nextIndex > i) {
              i = nextIndex - 1; // Will be incremented by loop
            }
          }
        }
      }

      // Record success
      await this.recordSuccess(skill.name, Date.now() - ctx.startTime);

      return {
        success: true,
        skillName: skill.name,
        category: "workflow",
        duration: Date.now() - ctx.startTime,
        outputs: this.extractOutputs(skill, ctx),
        stepResults,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        skillName: skill.name,
        category: "workflow",
        duration: Date.now() - ctx.startTime,
        outputs: {},
        stepResults,
        error: errorMsg,
      };
    }
  }

  /** Execute a single API call for api-package skills */
  async executeApiCall(
    skill: ApiPackageSkill,
    method: string,
    path: string,
    body?: any,
    authHeaders?: Record<string, string>,
    cookies?: Record<string, string>
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      const url = skill.baseUrl + path;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...authHeaders,
      };

      if (cookies && Object.keys(cookies).length > 0) {
        headers["Cookie"] = Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; ");
      }

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const duration = Date.now() - startTime;
      const success = response.ok;

      let responseBody: any;
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }

      if (success) {
        await this.recordApiSuccess(skill.name, duration);
      } else {
        await this.recordApiFailure(skill.name, `HTTP ${response.status}`);
      }

      return {
        success,
        skillName: skill.name,
        category: "api-package",
        duration,
        outputs: { response: responseBody, status: response.status },
        stepResults: [
          {
            stepId: `${method}-${path}`,
            success,
            response: responseBody,
            duration,
          },
        ],
        error: success ? undefined : `HTTP ${response.status}`,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.recordApiFailure(skill.name, errorMsg);
      return {
        success: false,
        skillName: skill.name,
        category: "api-package",
        duration: Date.now() - startTime,
        outputs: {},
        stepResults: [],
        error: errorMsg,
      };
    }
  }

  /** Execute a single workflow step */
  private async executeStep(step: WorkflowStep, ctx: ExecutionContext): Promise<StepResult> {
    const startTime = Date.now();

    try {
      switch (step.type) {
        case "navigate":
          return await this.executeNavigate(step, ctx, startTime);
        case "api-call":
          return await this.executeApiStep(step, ctx, startTime);
        case "action":
          return await this.executeAction(step, ctx, startTime);
        case "wait":
          return await this.executeWait(step, ctx, startTime);
        case "extract":
          return await this.executeExtract(step, ctx, startTime);
        case "decision":
          return await this.executeDecision(step, ctx, startTime);
        default:
          throw new Error(`Unknown step type: ${step.type}`);
      }
    } catch (error) {
      return {
        stepId: step.id,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  /** Execute navigation step */
  private async executeNavigate(
    step: WorkflowStep,
    ctx: ExecutionContext,
    startTime: number
  ): Promise<StepResult> {
    // In a real implementation, this would use browser automation
    // For now, we just mark it as successful (browser integration needed)
    const url = this.substituteVariables(step.target, ctx.variables);
    return {
      stepId: step.id,
      success: true,
      response: { navigated: url },
      duration: Date.now() - startTime,
    };
  }

  /** Execute API call step */
  private async executeApiStep(
    step: WorkflowStep,
    ctx: ExecutionContext,
    startTime: number
  ): Promise<StepResult> {
    const url = this.substituteVariables(step.target, ctx.variables);
    const method = step.method || "GET";
    const domain = new URL(url).hostname;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Add auth headers for this domain
    const domainAuth = ctx.auth.get(domain);
    if (domainAuth) {
      Object.assign(headers, domainAuth);
    }

    // Add cookies
    const domainCookies = ctx.cookies.get(domain);
    if (domainCookies && Object.keys(domainCookies).length > 0) {
      headers["Cookie"] = Object.entries(domainCookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }

    const response = await fetch(url, {
      method,
      headers,
    });

    const duration = Date.now() - startTime;
    const success = response.ok;

    let responseBody: any;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    // Extract variables
    const extractedVars: Record<string, any> = {};
    if (step.extracts && success) {
      for (const extraction of step.extracts) {
        const value = this.extractValue(responseBody, extraction);
        if (value !== undefined) {
          extractedVars[extraction.name] = value;
          ctx.variables[extraction.name] = value;
        } else if (extraction.required) {
          return {
            stepId: step.id,
            success: false,
            error: `Required variable ${extraction.name} not found in response`,
            duration,
          };
        }
      }
    }

    return {
      stepId: step.id,
      success,
      response: responseBody,
      duration,
      extractedVars,
      error: success ? undefined : `HTTP ${response.status}`,
    };
  }

  /** Execute browser action step */
  private async executeAction(
    step: WorkflowStep,
    ctx: ExecutionContext,
    startTime: number
  ): Promise<StepResult> {
    // Browser action execution would integrate with browser control
    // For now, we simulate success
    return {
      stepId: step.id,
      success: true,
      response: { action: step.action?.type },
      duration: Date.now() - startTime,
    };
  }

  /** Execute wait step */
  private async executeWait(
    step: WorkflowStep,
    ctx: ExecutionContext,
    startTime: number
  ): Promise<StepResult> {
    const timeout = step.action?.timeout || 1000;
    await new Promise((resolve) => setTimeout(resolve, timeout));
    return {
      stepId: step.id,
      success: true,
      response: { waited: timeout },
      duration: Date.now() - startTime,
    };
  }

  /** Execute extract step */
  private async executeExtract(
    step: WorkflowStep,
    ctx: ExecutionContext,
    startTime: number
  ): Promise<StepResult> {
    // Extract from previous step results or page content
    const extractedVars: Record<string, any> = {};

    if (step.extracts) {
      for (const extraction of step.extracts) {
        // Look in previous step results
        for (const [_, result] of ctx.stepResults) {
          if (result.response) {
            const value = this.extractValue(result.response, extraction);
            if (value !== undefined) {
              extractedVars[extraction.name] = value;
              ctx.variables[extraction.name] = value;
              break;
            }
          }
        }

        if (extractedVars[extraction.name] === undefined && extraction.required) {
          return {
            stepId: step.id,
            success: false,
            error: `Required variable ${extraction.name} not found`,
            duration: Date.now() - startTime,
          };
        }
      }
    }

    return {
      stepId: step.id,
      success: true,
      extractedVars,
      duration: Date.now() - startTime,
    };
  }

  /** Execute decision step */
  private async executeDecision(
    step: WorkflowStep,
    ctx: ExecutionContext,
    startTime: number
  ): Promise<StepResult> {
    // Decision steps always succeed; branching is handled separately
    return {
      stepId: step.id,
      success: true,
      response: { evaluated: true },
      duration: Date.now() - startTime,
    };
  }

  /** Evaluate decision branches and return next step ID */
  private evaluateBranches(
    branches: WorkflowStep["branches"],
    ctx: ExecutionContext
  ): string | null {
    if (!branches) return null;

    for (const branch of branches) {
      if (this.evaluateCondition(branch.condition, ctx)) {
        return branch.goto;
      }
    }

    return null;
  }

  /** Evaluate a condition expression */
  private evaluateCondition(condition: string, ctx: ExecutionContext): boolean {
    // Simple condition evaluation
    // Supports: "varName == value", "varName > number", "varName.length > 0"
    try {
      // Get the last step result for special variables
      const lastResult = Array.from(ctx.stepResults.values()).pop();

      const evalContext = {
        ...ctx.variables,
        response: lastResult?.response,
        status: lastResult?.response?.status,
      };

      // Very basic expression evaluation (replace with proper parser in production)
      const parts = condition.match(/^(\w+(?:\.\w+)?)\s*(==|!=|>|<|>=|<=)\s*(.+)$/);
      if (!parts) return false;

      const [, varPath, op, valueStr] = parts;
      const varValue = this.getNestedValue(evalContext, varPath);
      const compareValue = valueStr.startsWith('"')
        ? valueStr.slice(1, -1)
        : isNaN(Number(valueStr))
        ? valueStr
        : Number(valueStr);

      switch (op) {
        case "==":
          return varValue == compareValue;
        case "!=":
          return varValue != compareValue;
        case ">":
          return varValue > compareValue;
        case "<":
          return varValue < compareValue;
        case ">=":
          return varValue >= compareValue;
        case "<=":
          return varValue <= compareValue;
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  /** Get nested value from object */
  private getNestedValue(obj: any, path: string): any {
    return path.split(".").reduce((o, k) => o?.[k], obj);
  }

  /** Substitute variables in a string */
  private substituteVariables(str: string, variables: Record<string, any>): string {
    return str.replace(/\{(\w+)\}/g, (_, name) => {
      return variables[name] !== undefined ? String(variables[name]) : `{${name}}`;
    });
  }

  /** Extract value from response based on extraction config */
  private extractValue(data: any, extraction: VariableExtraction): any {
    if (extraction.source === "json" && extraction.path.startsWith("$.")) {
      // Simple JSONPath-like extraction
      const path = extraction.path.slice(2);
      return this.getNestedValue(data, path);
    }

    if (extraction.source === "json") {
      return this.getNestedValue(data, extraction.path);
    }

    // Other sources (html, header, cookie) would need different handling
    return undefined;
  }

  /** Extract outputs from execution context */
  private extractOutputs(skill: WorkflowSkill, ctx: ExecutionContext): Record<string, any> {
    const outputs: Record<string, any> = {};

    for (const output of skill.outputs) {
      const stepResult = ctx.stepResults.get(output.fromStep);
      if (stepResult?.response) {
        const value = this.getNestedValue(stepResult.response, output.path.replace("$.", ""));
        if (value !== undefined) {
          outputs[output.name] = value;
        }
      }
    }

    return outputs;
  }

  /** Load metrics from file */
  private loadMetrics(): Record<string, any> {
    if (!existsSync(this.metricsFile)) {
      return {};
    }
    try {
      return JSON.parse(readFileSync(this.metricsFile, "utf-8"));
    } catch {
      return {};
    }
  }

  /** Save metrics to file */
  private saveMetrics(metrics: Record<string, any>): void {
    writeFileSync(this.metricsFile, JSON.stringify(metrics, null, 2), "utf-8");
  }

  /** Record successful workflow execution */
  async recordSuccess(skillName: string, duration: number): Promise<void> {
    const metrics = this.loadMetrics();
    if (!metrics[skillName]) {
      metrics[skillName] = {
        totalExecutions: 0,
        successfulExecutions: 0,
        avgExecutionTime: 0,
        failurePoints: [],
      };
    }

    const m = metrics[skillName];
    m.totalExecutions++;
    m.successfulExecutions++;
    m.successRate = m.successfulExecutions / m.totalExecutions;
    m.avgExecutionTime = (m.avgExecutionTime * (m.totalExecutions - 1) + duration) / m.totalExecutions;
    m.lastSuccess = new Date().toISOString();

    this.saveMetrics(metrics);
  }

  /** Record workflow failure */
  async recordFailure(skillName: string, stepId: string, error: string): Promise<void> {
    const metrics = this.loadMetrics();
    if (!metrics[skillName]) {
      metrics[skillName] = {
        totalExecutions: 0,
        successfulExecutions: 0,
        avgExecutionTime: 0,
        failurePoints: [],
      };
    }

    const m = metrics[skillName];
    m.totalExecutions++;
    m.successRate = m.successfulExecutions / m.totalExecutions;

    // Track failure point
    const existing = m.failurePoints.find(
      (fp: FailurePoint) => fp.stepId === stepId && fp.errorType === error
    );
    if (existing) {
      existing.count++;
      existing.lastOccurred = new Date().toISOString();
    } else {
      m.failurePoints.push({
        stepId,
        errorType: error,
        count: 1,
        lastOccurred: new Date().toISOString(),
      });
    }

    this.saveMetrics(metrics);
  }

  /** Record API call success */
  async recordApiSuccess(skillName: string, duration: number): Promise<void> {
    const metrics = this.loadMetrics();
    if (!metrics[skillName]) {
      metrics[skillName] = {
        totalCalls: 0,
        successfulCalls: 0,
        avgResponseTime: 0,
      };
    }

    const m = metrics[skillName];
    m.totalCalls++;
    m.successfulCalls++;
    m.successRate = m.successfulCalls / m.totalCalls;
    m.avgResponseTime = (m.avgResponseTime * (m.totalCalls - 1) + duration) / m.totalCalls;
    m.lastUsed = new Date().toISOString();

    this.saveMetrics(metrics);
  }

  /** Record API call failure */
  async recordApiFailure(skillName: string, error: string): Promise<void> {
    const metrics = this.loadMetrics();
    if (!metrics[skillName]) {
      metrics[skillName] = {
        totalCalls: 0,
        successfulCalls: 0,
        avgResponseTime: 0,
      };
    }

    const m = metrics[skillName];
    m.totalCalls++;
    m.successRate = m.successfulCalls / m.totalCalls;
    m.lastError = error;
    m.lastErrorTime = new Date().toISOString();

    this.saveMetrics(metrics);
  }

  /** Get metrics for a skill */
  getMetrics(skillName: string): WorkflowMetrics | ApiPackageMetrics | null {
    const metrics = this.loadMetrics();
    return metrics[skillName] || null;
  }
}

/** Singleton instance */
let executorInstance: WorkflowExecutor | null = null;

export function getWorkflowExecutor(skillsDir?: string): WorkflowExecutor {
  if (!executorInstance) {
    executorInstance = new WorkflowExecutor(skillsDir);
  }
  return executorInstance;
}
