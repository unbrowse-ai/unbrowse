/**
 * Browser-Use TypeScript Port - Action Registry
 *
 * Dynamic action registration system that allows plugins to register
 * custom actions without modifying core code.
 *
 * Features:
 * - Dynamic action registration with metadata
 * - Validation and schema support
 * - Action discovery and listing
 * - Middleware/hooks for action execution
 */

import type { Page, BrowserContext, Locator } from "playwright";
import type { ActionResult } from "./types.js";
import type { DOMService } from "./dom-service.js";

/**
 * Context passed to action handlers
 */
export interface ActionContext {
  page: Page;
  context: BrowserContext;
  domService: DOMService | null;
  getElementByIndex: (index: number) => Promise<Locator | null>;
}

/**
 * Action handler function type
 */
export type ActionHandler<T = any> = (
  params: T,
  ctx: ActionContext
) => Promise<ActionResult>;

/**
 * Action configuration/metadata
 */
export interface ActionConfig<T = any> {
  /** Unique action name (e.g., "navigate", "click") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Category for grouping (navigation, interaction, extraction, etc.) */
  category: "navigation" | "interaction" | "form" | "tab" | "extraction" | "javascript" | "file" | "completion" | "custom";
  /** Parameter schema for validation */
  schema?: {
    required?: string[];
    properties?: Record<string, {
      type: "string" | "number" | "boolean" | "object" | "array";
      description?: string;
      enum?: any[];
      default?: any;
    }>;
  };
  /** The action handler function */
  handler: ActionHandler<T>;
  /** Whether action should be retried on failure */
  retryable?: boolean;
  /** Max retries (default: 3) */
  maxRetries?: number;
  /** Whether to include result in agent memory */
  includeInMemory?: boolean;
  /** Actions that must run before this one */
  requires?: string[];
  /** Custom validation function */
  validate?: (params: T) => { valid: boolean; error?: string };
}

/**
 * Middleware function for action execution
 */
export type ActionMiddleware = (
  action: string,
  params: any,
  ctx: ActionContext,
  next: () => Promise<ActionResult>
) => Promise<ActionResult>;

/**
 * Action Registry - Central registry for all browser actions
 */
export class ActionRegistry {
  private actions = new Map<string, ActionConfig>();
  private middlewares: ActionMiddleware[] = [];
  private aliases = new Map<string, string>();

  /**
   * Register a new action
   */
  register<T>(config: ActionConfig<T>): this {
    if (this.actions.has(config.name)) {
      console.warn(`[action-registry] Overwriting existing action: ${config.name}`);
    }
    this.actions.set(config.name, config as ActionConfig);
    return this;
  }

  /**
   * Register multiple actions at once
   */
  registerAll(configs: ActionConfig[]): this {
    for (const config of configs) {
      this.register(config);
    }
    return this;
  }

  /**
   * Register an alias for an action
   */
  alias(aliasName: string, actionName: string): this {
    if (!this.actions.has(actionName)) {
      throw new Error(`Cannot create alias for non-existent action: ${actionName}`);
    }
    this.aliases.set(aliasName, actionName);
    return this;
  }

  /**
   * Add middleware for action execution
   */
  use(middleware: ActionMiddleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  /**
   * Get an action config by name
   */
  get(name: string): ActionConfig | undefined {
    // Check aliases first
    const resolvedName = this.aliases.get(name) || name;
    return this.actions.get(resolvedName);
  }

  /**
   * Check if an action exists
   */
  has(name: string): boolean {
    const resolvedName = this.aliases.get(name) || name;
    return this.actions.has(resolvedName);
  }

  /**
   * List all registered actions
   */
  list(): ActionConfig[] {
    return Array.from(this.actions.values());
  }

  /**
   * List actions by category
   */
  listByCategory(category: ActionConfig["category"]): ActionConfig[] {
    return this.list().filter(a => a.category === category);
  }

  /**
   * Get action names
   */
  names(): string[] {
    return Array.from(this.actions.keys());
  }

  /**
   * Execute an action by name
   */
  async execute(
    actionName: string,
    params: any,
    ctx: ActionContext
  ): Promise<ActionResult> {
    const resolvedName = this.aliases.get(actionName) || actionName;
    const config = this.actions.get(resolvedName);

    if (!config) {
      return {
        success: false,
        error: `Unknown action: ${actionName}`,
      };
    }

    // Validate parameters
    if (config.validate) {
      const validation = config.validate(params);
      if (!validation.valid) {
        return {
          success: false,
          error: `Validation failed for ${actionName}: ${validation.error}`,
        };
      }
    }

    // Schema-based validation
    if (config.schema?.required) {
      for (const required of config.schema.required) {
        if (params[required] === undefined) {
          return {
            success: false,
            error: `Missing required parameter: ${required}`,
          };
        }
      }
    }

    // Apply defaults from schema
    if (config.schema?.properties) {
      for (const [key, prop] of Object.entries(config.schema.properties)) {
        if (params[key] === undefined && prop.default !== undefined) {
          params[key] = prop.default;
        }
      }
    }

    // Build middleware chain
    const executeHandler = async (): Promise<ActionResult> => {
      return config.handler(params, ctx);
    };

    // Execute with retries if configured
    const executeWithRetry = async (): Promise<ActionResult> => {
      const maxRetries = config.retryable !== false ? (config.maxRetries ?? 3) : 1;
      let lastError: Error | null = null;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          const result = await executeHandler();

          // Set includeInMemory from config if not set by handler
          if (result.includeInMemory === undefined && config.includeInMemory) {
            result.includeInMemory = config.includeInMemory;
          }

          return result;
        } catch (err) {
          lastError = err as Error;

          // Don't retry certain errors
          const errorMsg = lastError.message.toLowerCase();
          if (
            errorMsg.includes("element not found") ||
            errorMsg.includes("detached") ||
            errorMsg.includes("navigation")
          ) {
            break;
          }

          if (attempt < maxRetries - 1) {
            const delay = Math.min(500 * Math.pow(2, attempt), 5000);
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }

      return {
        success: false,
        error: `Action ${actionName} failed: ${lastError?.message}`,
      };
    };

    // Apply middlewares (in reverse order so first added runs first)
    let chain = executeWithRetry;
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const middleware = this.middlewares[i];
      const next = chain;
      chain = () => middleware(actionName, params, ctx, next);
    }

    return chain();
  }

  /**
   * Generate prompt documentation for all actions
   */
  generatePromptDocs(): string {
    const categories = new Map<string, ActionConfig[]>();

    for (const action of this.actions.values()) {
      const cat = action.category.toUpperCase();
      if (!categories.has(cat)) {
        categories.set(cat, []);
      }
      categories.get(cat)!.push(action);
    }

    const lines: string[] = [];

    for (const [category, actions] of categories) {
      lines.push(`${category}:`);
      for (const action of actions) {
        const params = action.schema?.properties
          ? Object.entries(action.schema.properties)
              .map(([k, v]) => {
                const required = action.schema?.required?.includes(k) ? "" : "?";
                return `"${k}"${required}: ${v.type}`;
              })
              .join(", ")
          : "";
        lines.push(`- ${action.name}: {${params}} - ${action.description}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Clear all registered actions
   */
  clear(): void {
    this.actions.clear();
    this.aliases.clear();
    this.middlewares = [];
  }
}

/**
 * Default global registry instance
 */
export const defaultRegistry = new ActionRegistry();

/**
 * Helper to create action configs with type inference
 */
export function defineAction<T>(config: ActionConfig<T>): ActionConfig<T> {
  return config;
}

/**
 * Logging middleware - logs all action executions
 */
export const loggingMiddleware: ActionMiddleware = async (action, params, ctx, next) => {
  const start = Date.now();
  console.log(`[action] Executing: ${action}`, params);

  try {
    const result = await next();
    const duration = Date.now() - start;
    console.log(`[action] ${action}: ${result.success ? "✓" : "✗"} (${duration}ms)`);
    return result;
  } catch (err) {
    const duration = Date.now() - start;
    console.error(`[action] ${action}: ERROR (${duration}ms)`, err);
    throw err;
  }
};

/**
 * Timing middleware - adds execution time to results
 */
export const timingMiddleware: ActionMiddleware = async (action, params, ctx, next) => {
  const start = Date.now();
  const result = await next();
  result.extractedContent = `[${Date.now() - start}ms] ${result.extractedContent || ""}`;
  return result;
};
