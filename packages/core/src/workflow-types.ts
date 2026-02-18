/**
 * Workflow Types — Categorized skill types for API packages and multi-site workflows.
 *
 * Two categories:
 * - api-package: Single-site API capture (simple endpoint collection)
 * - workflow: Multi-site orchestration (cross-site sequences with decision points)
 */

/** Skill category discriminator */
export type SkillCategory = "api-package" | "workflow";

/** A single step in a workflow */
export interface WorkflowStep {
  /** Step identifier */
  id: string;
  /** Step type */
  type: "navigate" | "api-call" | "action" | "wait" | "extract" | "decision";
  /** Target URL or API endpoint */
  target: string;
  /** HTTP method for api-call steps */
  method?: string;
  /** Domain this step operates on */
  domain: string;
  /** Human description of what this step does */
  description: string;
  /** Variables extracted from this step's response */
  extracts?: VariableExtraction[];
  /** For decision steps: conditional branches */
  branches?: DecisionBranch[];
  /** For action steps: browser action details */
  action?: BrowserAction;
  /** Data dependencies from previous steps */
  dependsOn?: string[];
  /** Expected response schema for validation */
  expectedSchema?: Record<string, any>;
}

/** Variable extraction from a step's response */
export interface VariableExtraction {
  /** Variable name to use in subsequent steps */
  name: string;
  /** JSONPath or CSS selector to extract value */
  path: string;
  /** Type of extraction */
  source: "json" | "html" | "header" | "cookie" | "url";
  /** Whether this variable is required for workflow to continue */
  required?: boolean;
}

/** Conditional branch for decision steps */
export interface DecisionBranch {
  /** Condition expression (e.g., "status == 200", "response.items.length > 0") */
  condition: string;
  /** Step ID to jump to if condition matches */
  goto: string;
  /** Human description of this branch */
  label: string;
}

/** Browser action for action steps */
export interface BrowserAction {
  type: "click" | "type" | "scroll" | "select" | "submit" | "wait-for";
  /** CSS selector or element reference */
  selector?: string;
  /** Value to type or select */
  value?: string;
  /** Wait timeout in ms */
  timeout?: number;
}

/** Authentication requirement for a domain */
export interface DomainAuth {
  domain: string;
  authType: "bearer" | "cookie" | "api-key" | "oauth" | "session" | "none";
  /** Auth header name (e.g., "Authorization", "X-API-Key") */
  headerName?: string;
  /** Cookie names required for auth */
  cookieNames?: string[];
  /** Whether auth can be refreshed automatically */
  refreshable?: boolean;
  /** Refresh endpoint if known */
  refreshEndpoint?: string;
}

/** Complete workflow skill definition */
export interface WorkflowSkill {
  /** Skill metadata */
  name: string;
  version: string;
  category: SkillCategory;
  description: string;

  /** When this skill should be triggered */
  triggers: string[];

  /** Domains involved in this workflow */
  domains: string[];

  /** Auth requirements per domain */
  auth: DomainAuth[];

  /** Input parameters required to start the workflow */
  inputs: WorkflowInput[];

  /** Expected outputs from successful execution */
  outputs: WorkflowOutput[];

  /** Ordered workflow steps */
  steps: WorkflowStep[];

  /** Quality metrics */
  metrics: WorkflowMetrics;
}

/** Input parameter for workflow */
export interface WorkflowInput {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required: boolean;
  default?: any;
  validation?: string; // Regex or JSON schema
}

/** Output from workflow */
export interface WorkflowOutput {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  fromStep: string;
  path: string;
}

/** Quality and success metrics */
export interface WorkflowMetrics {
  /** Total executions */
  totalExecutions: number;
  /** Successful completions */
  successfulExecutions: number;
  /** Success rate (0-1) */
  successRate: number;
  /** Average execution time in ms */
  avgExecutionTime: number;
  /** Last successful execution timestamp */
  lastSuccess?: string;
  /** Common failure points */
  failurePoints: FailurePoint[];
  /** Creator earnings from this workflow */
  totalEarnings: number;
}

/** Failure point tracking */
export interface FailurePoint {
  stepId: string;
  errorType: string;
  count: number;
  lastOccurred: string;
}

/** Recorded session for learning workflows */
export interface RecordedSession {
  sessionId: string;
  startTime: string;
  endTime?: string;
  domains: string[];
  entries: RecordedEntry[];
  /** User annotations during recording */
  annotations: SessionAnnotation[];
  /** Auto-detected intent */
  detectedIntent?: string;
}

/** Single entry in a recorded session */
export interface RecordedEntry {
  timestamp: string;
  type: "navigation" | "api-call" | "action" | "page-load";
  domain: string;
  url: string;
  method?: string;
  /** Request payload */
  requestBody?: any;
  /** Response data (summarized) */
  responseBody?: any;
  responseStatus?: number;
  /** Browser action if type is "action" */
  action?: BrowserAction;
  /** Headers captured */
  headers?: Record<string, string>;
  /** Cookies at this point */
  cookies?: Record<string, string>;
  /** DOM snapshot reference */
  domSnapshot?: string;
}

/** User annotation during recording */
export interface SessionAnnotation {
  timestamp: string;
  stepIndex: number;
  note: string;
  type: "intent" | "decision" | "important" | "skip";
}

/** API Package skill (simpler, single-site) */
export interface ApiPackageSkill {
  name: string;
  version: string;
  category: "api-package";
  description: string;

  /** Single domain for this API */
  domain: string;
  baseUrl: string;

  /** Auth configuration */
  auth: DomainAuth;

  /** Available endpoints */
  endpoints: ApiEndpoint[];

  /** Quality metrics */
  metrics: ApiPackageMetrics;
}

/** Single API endpoint */
export interface ApiEndpoint {
  method: string;
  path: string;
  description: string;
  /** Whether endpoint was verified to work */
  verified: boolean;
  /** Request body schema */
  requestSchema?: Record<string, any>;
  /** Response schema */
  responseSchema?: Record<string, any>;
  /** Query parameters */
  queryParams?: ApiParam[];
  /** Path parameters */
  pathParams?: ApiParam[];
}

/** API parameter definition */
export interface ApiParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: any;
}

/** Metrics for API packages */
export interface ApiPackageMetrics {
  totalCalls: number;
  successfulCalls: number;
  successRate: number;
  avgResponseTime: number;
  lastUsed?: string;
  totalEarnings: number;
}

/** Union type for any skill */
export type Skill = ApiPackageSkill | WorkflowSkill;

/** Helper to determine if skill is a workflow */
export function isWorkflowSkill(skill: Skill): skill is WorkflowSkill {
  return skill.category === "workflow";
}

/** Helper to determine if skill is an API package */
export function isApiPackageSkill(skill: Skill): skill is ApiPackageSkill {
  return skill.category === "api-package";
}
