/**
 * Browser-Use TypeScript Port - Action Executor
 *
 * Executes browser actions using the ActionRegistry.
 * Provides a clean interface between the agent and the registry.
 */

import type { Page, BrowserContext, Locator } from "playwright";
import type { ActionModel, ActionResult } from "./types.js";
import type { DOMService } from "./dom-service.js";
import { ActionRegistry, ActionContext, defaultRegistry } from "./action-registry.js";
import { defaultActions } from "./default-actions.js";

// Initialize default registry with all built-in actions
defaultRegistry.registerAll(defaultActions);

/**
 * ActionExecutor - Executes actions using the registry
 */
export class ActionExecutor {
  private page: Page;
  private context: BrowserContext;
  private domService: DOMService | null = null;
  private registry: ActionRegistry;

  constructor(
    page: Page,
    context: BrowserContext,
    domService?: DOMService,
    registry?: ActionRegistry
  ) {
    this.page = page;
    this.context = context;
    this.domService = domService ?? null;
    this.registry = registry ?? defaultRegistry;
  }

  /**
   * Set the DOM service for stable element lookups
   */
  setDOMService(domService: DOMService) {
    this.domService = domService;
  }

  /**
   * Get the action registry
   */
  getRegistry(): ActionRegistry {
    return this.registry;
  }

  /**
   * Build the action context
   */
  private buildContext(): ActionContext {
    return {
      page: this.page,
      context: this.context,
      domService: this.domService,
      getElementByIndex: (index: number) => this.getElementByIndex(index),
    };
  }

  /**
   * Execute a single action and return the result
   */
  async execute(action: ActionModel): Promise<ActionResult> {
    // Extract action name and params from the ActionModel
    const actionName = Object.keys(action)[0];
    const params = (action as any)[actionName];

    // Special handling for "done" action (signals task completion)
    if (actionName === "done") {
      return {
        success: params.success,
        extractedContent: params.text,
        includeInMemory: true,
      };
    }

    // Execute via registry
    const ctx = this.buildContext();
    return this.registry.execute(actionName, params, ctx);
  }

  /**
   * Execute multiple actions in sequence
   */
  async executeAll(actions: ActionModel[]): Promise<ActionResult[]> {
    const results: ActionResult[] = [];

    for (const action of actions) {
      const result = await this.execute(action);
      results.push(result);

      // Stop on failure or done action
      if (!result.success || "done" in action) {
        break;
      }

      // Brief pause between actions
      await this.page.waitForTimeout(300);
    }

    return results;
  }

  /**
   * Get element locator by index using DOM service for stability
   */
  private async getElementByIndex(index: number): Promise<Locator | null> {
    try {
      // If we have DOM service, use its stable element lookup
      if (this.domService) {
        return await this.domService.getLocatorByIndex(index);
      }

      // Fallback: direct selector lookup
      const INTERACTIVE_SELECTORS = [
        "a[href]", "button", "input", "select", "textarea",
        "[role='button']", "[role='link']", "[role='checkbox']",
        "[role='radio']", "[role='tab']", "[role='menuitem']",
        "[role='option']", "[role='combobox']", "[role='textbox']",
        "[role='searchbox']", "[onclick]", "[tabindex]:not([tabindex='-1'])",
        "[contenteditable='true']", "summary", "details",
        "[aria-haspopup]", "[data-action]", "[data-click]",
      ].join(", ");

      const locator = this.page.locator(INTERACTIVE_SELECTORS).nth(index - 1);
      const count = await locator.count();
      if (count === 0) return null;
      return locator;
    } catch {
      return null;
    }
  }

  /**
   * Update the current page reference
   */
  setPage(page: Page) {
    this.page = page;
  }

  /**
   * Get current page
   */
  getPage(): Page {
    return this.page;
  }

  /**
   * List all available actions
   */
  listActions(): string[] {
    return this.registry.names();
  }

  /**
   * Check if an action is available
   */
  hasAction(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * Register a custom action
   */
  registerAction(config: Parameters<ActionRegistry["register"]>[0]): this {
    this.registry.register(config);
    return this;
  }
}

// Re-export registry utilities for easy access
export { ActionRegistry, defaultRegistry, ActionContext } from "./action-registry.js";
export { defaultActions } from "./default-actions.js";
