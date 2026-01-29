/**
 * Browser-Use TypeScript Port - Agent
 *
 * The main agent that orchestrates browser automation tasks.
 * Uses an LLM to decide actions based on the current browser state.
 *
 * Features:
 * - Intelligent page load waiting
 * - Smart memory management with importance scoring
 * - Telemetry with spans and metrics
 * - Variable auto-detection
 * - Error recovery with LLM retry parsing
 * - Request capture for skill generation
 */

import type { Page, BrowserContext, Browser } from "playwright";
import { chromium } from "playwright";
import { createStealthSession, stopStealthSession } from "../stealth-browser.js";
import type {
  AgentConfig,
  AgentHistory,
  AgentHistoryList,
  ActionResult,
  BrowserConfig,
  CapturedRequest,
} from "./types.js";

interface AgentOutput {
  thinking: string;
  evaluation_previous_goal: string;
  memory: string;
  next_goal: string;
  action: any[];
}
import { DOMService } from "./dom-service.js";
import { ActionExecutor } from "./actions.js";
import { buildSystemPrompt, buildUserMessage, parseAgentResponse } from "./prompts.js";
import { TelemetryService, defaultTelemetry } from "./telemetry.js";
import { MemoryManager } from "./memory-manager.js";
import { VariableDetector } from "./variable-detector.js";

// LLM retry config
const LLM_RETRY_CONFIG = {
  maxRetries: 2,
  retryDelayMs: 1000,
};

// Max requests to keep (memory management)
const MAX_CAPTURED_REQUESTS = 500;

export interface LLMProvider {
  chat(messages: Array<{ role: string; content: string }>): Promise<string>;
}

export interface AgentResult {
  success: boolean;
  finalResult?: string;
  history: AgentHistoryList;
  capturedRequests: CapturedRequest[];
  /** Detected variables from the session */
  detectedVariables?: Record<string, string>;
  /** Telemetry summary */
  telemetry?: {
    totalDuration: number;
    stepCount: number;
    actionCount: number;
    llmCalls: number;
    errors: number;
  };
}

/**
 * Lifecycle hooks for agent events
 */
export interface AgentHooks {
  /** Called before each step starts */
  onStepStart?: (step: number, maxSteps: number) => void | Promise<void>;

  /** Called after each step completes */
  onStepEnd?: (step: number, result: {
    actions: any[];
    results: ActionResult[];
    thinking: string;
    nextGoal: string;
  }) => void | Promise<void>;

  /** Called before each action is executed */
  onActionStart?: (action: any, step: number) => void | Promise<void>;

  /** Called after each action completes */
  onActionEnd?: (action: any, result: ActionResult, step: number) => void | Promise<void>;

  /** Called when task completes (success or failure) */
  onDone?: (result: AgentResult) => void | Promise<void>;

  /** Called when an error occurs */
  onError?: (error: Error, step: number) => void | Promise<void>;

  /** Called when a new request is captured */
  onRequestCaptured?: (request: CapturedRequest) => void | Promise<void>;

  /** Called when page URL changes */
  onNavigate?: (url: string, previousUrl: string) => void | Promise<void>;

  /** Called when variables are detected */
  onVariablesDetected?: (variables: Record<string, string>) => void | Promise<void>;
}

export class BrowserUseAgent {
  private config: AgentConfig;
  private browserConfig: BrowserConfig;
  private llm: LLMProvider;
  private hooks: AgentHooks;

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private cloudSessionId: string | null = null;

  private domService: DOMService | null = null;
  private actionExecutor: ActionExecutor | null = null;
  private telemetry: TelemetryService;
  private memoryManager: MemoryManager;
  private variableDetector: VariableDetector | null = null;

  private history: AgentHistory[] = [];
  private capturedRequests: CapturedRequest[] = [];

  private shouldStop = false;
  private injectedBrowser = false;
  private lastUrl: string = "";
  private startTime: number = 0;
  private llmCallCount: number = 0;
  private actionCount: number = 0;

  constructor(
    config: AgentConfig,
    llm: LLMProvider,
    browserConfig?: BrowserConfig,
    existingBrowser?: Browser,
    existingContext?: BrowserContext,
    hooks?: AgentHooks
  ) {
    this.config = {
      maxSteps: 50,
      maxActionsPerStep: 3,
      useVision: false,
      ...config,
    };
    this.browserConfig = browserConfig ?? {};
    this.llm = llm;
    this.hooks = hooks ?? {};

    // Initialize telemetry and memory manager
    this.telemetry = defaultTelemetry;
    this.memoryManager = new MemoryManager({
      maxDetailedEntries: 15,
      maxSummaries: 5,
      minImportanceToKeep: 70,
    });

    // Use existing browser if provided
    if (existingBrowser && existingContext) {
      this.browser = existingBrowser;
      this.context = existingContext;
      this.injectedBrowser = true;
    }
  }

  /**
   * Set lifecycle hooks after construction
   */
  setHooks(hooks: AgentHooks): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /**
   * Call a hook if defined, handling async and errors
   */
  private async callHook<K extends keyof AgentHooks>(
    name: K,
    ...args: Parameters<NonNullable<AgentHooks[K]>>
  ): Promise<void> {
    const hook = this.hooks[name];
    if (hook) {
      try {
        await (hook as Function)(...args);
      } catch (err) {
        this.telemetry.error(`Hook ${name} error`, err as Error);
      }
    }
  }

  /**
   * Run the agent to complete the task
   */
  async run(): Promise<AgentResult> {
    this.startTime = Date.now();
    const runSpanId = this.telemetry.startSpan("agent.run", {
      task: this.config.task.slice(0, 100),
      startUrl: this.config.startUrl,
      maxSteps: this.config.maxSteps,
    });

    try {
      await this.initialize();
      this.lastUrl = this.page?.url() || "";

      const maxSteps = this.config.maxSteps ?? 50;
      this.telemetry.setGauge("agent.max_steps", maxSteps);

      for (let step = 1; step <= maxSteps && !this.shouldStop; step++) {
        this.telemetry.info(`Step ${step}/${maxSteps}`);

        // Hook: step start
        await this.callHook("onStepStart", step, maxSteps);

        const stepSpanId = this.telemetry.startSpan("agent.step", { step, maxSteps });
        const stepStart = Date.now();

        const result = await this.executeStep(step, maxSteps);

        const stepDuration = Date.now() - stepStart;
        this.telemetry.recordStep(step, stepDuration, !result.done || result.success);
        this.telemetry.endSpan(stepSpanId, result.done && !result.success ? "error" : "ok");

        // Check if done action was called
        if (result.done) {
          const totalDuration = Date.now() - this.startTime;
          const agentResult = this.buildResult(result.success, result.finalResult, totalDuration);
          await this.callHook("onDone", agentResult);
          this.telemetry.endSpan(runSpanId, result.success ? "ok" : "error");
          return agentResult;
        }
      }

      // Max steps reached
      const totalDuration = Date.now() - this.startTime;
      const agentResult = this.buildResult(false, "Max steps reached without completing the task", totalDuration);
      await this.callHook("onDone", agentResult);
      this.telemetry.endSpan(runSpanId, "error");
      return agentResult;
    } catch (err) {
      this.telemetry.recordError("agent_error");
      this.telemetry.error("Agent run failed", err as Error);
      await this.callHook("onError", err as Error, this.history.length);
      this.telemetry.endSpan(runSpanId, "error", err as Error);
      throw err;
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Build the final result object
   */
  private buildResult(success: boolean, finalResult: string | undefined, totalDuration: number): AgentResult {
    return {
      success,
      finalResult,
      history: { history: this.history, success, finalResult },
      capturedRequests: this.capturedRequests,
      detectedVariables: this.variableDetector?.export(),
      telemetry: {
        totalDuration,
        stepCount: this.history.length,
        actionCount: this.actionCount,
        llmCalls: this.llmCallCount,
        errors: this.telemetry.getSummary().errors,
      },
    };
  }

  /**
   * Execute a single step
   */
  private async executeStep(
    step: number,
    maxSteps: number
  ): Promise<{ done: boolean; success: boolean; finalResult?: string }> {
    // Wait for page to be stable before getting state
    await this.waitForPageStable();

    // Get current browser state
    const browserState = await this.domService!.getBrowserState();
    const browserStateText = this.domService!.formatBrowserState(browserState);

    // Detect variables from current page
    if (this.variableDetector) {
      const detectedVars = await this.variableDetector.detect();
      if (detectedVars.length > 0) {
        const varsMap = this.variableDetector.export();
        this.telemetry.debug(`Detected ${detectedVars.length} variables`, { variables: Object.keys(varsMap) });
        await this.callHook("onVariablesDetected", varsMap);
      }
    }

    // Build history text using smart memory manager
    const historyText = this.memoryManager.formatForLLM();

    // Include detected variables in context
    const variablesContext = this.variableDetector
      ? `\n\n${this.variableDetector.formatForLLM()}`
      : "";

    // Build messages for LLM
    const systemPrompt = buildSystemPrompt({
      maxActionsPerStep: this.config.maxActionsPerStep,
      extendMessage: this.config.extendSystemMessage,
    });

    const userMessage = buildUserMessage(
      this.config.task,
      browserStateText + variablesContext,
      historyText,
      { current: step, max: maxSteps }
    );

    // Call LLM with retries and telemetry
    let response: string | null = null;
    let agentOutput: AgentOutput | null = null;

    for (let attempt = 0; attempt <= LLM_RETRY_CONFIG.maxRetries; attempt++) {
      try {
        const llmSpanId = this.telemetry.startSpan("llm.call", { attempt, step });
        const llmStart = Date.now();

        this.telemetry.debug(`Calling LLM${attempt > 0 ? ` (retry ${attempt})` : ""}...`);
        response = await this.llm.chat([
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ]);

        const llmDuration = Date.now() - llmStart;
        this.llmCallCount++;
        this.telemetry.recordLLMCall("browser-use", llmDuration, undefined, true);
        this.telemetry.endSpan(llmSpanId, "ok");

        agentOutput = parseAgentResponse(response);
        if (agentOutput) break;

        this.telemetry.warn("Failed to parse LLM response, retrying...");
      } catch (err) {
        this.telemetry.recordLLMCall("browser-use", 0, undefined, false);
        this.telemetry.error(`LLM call failed`, err as Error);
        if (attempt === LLM_RETRY_CONFIG.maxRetries) throw err;
      }

      if (attempt < LLM_RETRY_CONFIG.maxRetries) {
        await this.page!.waitForTimeout(LLM_RETRY_CONFIG.retryDelayMs);
      }
    }

    if (!agentOutput) {
      this.telemetry.error("Failed to get valid LLM response after retries");
      agentOutput = {
        thinking: "Failed to parse LLM response",
        evaluation_previous_goal: "Error",
        memory: "",
        next_goal: "Retry or report failure",
        action: [],
      };
    }

    this.telemetry.debug(`Thinking: ${agentOutput.thinking.slice(0, 100)}...`);
    this.telemetry.info(`Next goal: ${agentOutput.next_goal}`);

    // Execute actions
    const results: ActionResult[] = [];
    let isDone = false;
    let doneSuccess = false;
    let doneText = "";
    let urlBeforeActions = this.page!.url();

    for (const action of agentOutput.action) {
      // Check for done action
      if ("done" in action) {
        isDone = true;
        doneSuccess = action.done.success;
        doneText = action.done.text;
        results.push({
          success: true,
          extractedContent: action.done.text,
        });
        break;
      }

      // Hook: action start
      await this.callHook("onActionStart", action, step);

      const actionName = Object.keys(action)[0];
      const actionSpanId = this.telemetry.startSpan("action.execute", { action: actionName, step });
      const actionStart = Date.now();

      // Execute the action
      const result = await this.actionExecutor!.execute(action);
      results.push(result);
      this.actionCount++;

      const actionDuration = Date.now() - actionStart;
      this.telemetry.recordAction(actionName, actionDuration, result.success);
      this.telemetry.endSpan(actionSpanId, result.success ? "ok" : "error");

      // Hook: action end
      await this.callHook("onActionEnd", action, result, step);

      this.telemetry.info(`Action ${actionName}: ${result.success ? "✓" : "✗"} ${(result.extractedContent || result.error || "").slice(0, 100)}`);

      // If action failed, stop executing more actions
      if (!result.success) {
        this.telemetry.recordError("action_failed", actionName);
        break;
      }

      // Check if URL changed (navigation happened)
      const currentUrl = this.page!.url();
      if (currentUrl !== urlBeforeActions) {
        this.telemetry.info(`URL changed to ${currentUrl}`);
        this.telemetry.recordNavigation(currentUrl, actionDuration);

        // Hook: navigate
        await this.callHook("onNavigate", currentUrl, urlBeforeActions);

        await this.waitForPageStable();
        urlBeforeActions = currentUrl;

        // Clear DOM cache since page changed
        await this.domService!.clearCache();

        // Detect variables on new page
        if (this.variableDetector) {
          await this.variableDetector.detect();
        }

        // Stop further actions after navigation to reassess
        if (agentOutput.action.indexOf(action) < agentOutput.action.length - 1) {
          this.telemetry.debug("Stopping action chain after navigation");
          break;
        }
      }

      // Brief pause between actions
      await this.page!.waitForTimeout(300);
    }

    // Record history using smart memory manager
    const historyEntry: AgentHistory = {
      step,
      state: {
        thinking: agentOutput.thinking,
        evaluationPreviousGoal: agentOutput.evaluation_previous_goal,
        memory: agentOutput.memory,
        nextGoal: agentOutput.next_goal,
      },
      browserState: {
        ...browserState,
        // Don't store full element list in history to save memory
        interactiveElements: browserState.interactiveElements.slice(0, 10),
      },
      actions: agentOutput.action,
      results,
      timestamp: new Date(),
    };

    this.history.push(historyEntry);
    this.memoryManager.add(historyEntry);

    // Hook: step end
    await this.callHook("onStepEnd", step, {
      actions: agentOutput.action,
      results,
      thinking: agentOutput.thinking,
      nextGoal: agentOutput.next_goal,
    });

    // Trim captured requests (memory manager handles history)
    if (this.capturedRequests.length > MAX_CAPTURED_REQUESTS) {
      this.capturedRequests = this.capturedRequests.slice(-MAX_CAPTURED_REQUESTS);
    }

    return {
      done: isDone,
      success: doneSuccess,
      finalResult: doneText || undefined,
    };
  }

  /**
   * Wait for the page to be stable (network idle, no spinners)
   */
  private async waitForPageStable(): Promise<void> {
    try {
      // Wait for network to be mostly idle
      await Promise.race([
        this.page!.waitForLoadState("networkidle", { timeout: 5000 }),
        this.page!.waitForTimeout(5000),
      ]);
    } catch {
      // Timeout is okay, page might have long-polling
    }

    // Additional wait for dynamic content
    await this.page!.waitForTimeout(300);
  }

  /**
   * Check if we're in a headless environment (no display)
   */
  private isHeadlessEnvironment(): boolean {
    // Check for common headless indicators
    const noDisplay = !process.env.DISPLAY && process.platform === "linux";
    const isDocker = process.env.DOCKER === "true" ||
      require("fs").existsSync("/.dockerenv");
    const isCI = !!process.env.CI;
    return noDisplay || isDocker || isCI;
  }

  /**
   * Initialize browser and services
   */
  private async initialize() {
    const initSpanId = this.telemetry.startSpan("agent.initialize");

    // Launch or connect to browser
    if (!this.browser && !this.context) {
      const useCloud = this.browserConfig.forceCloud ||
        (this.isHeadlessEnvironment() && this.browserConfig.browserUseApiKey);

      if (useCloud && this.browserConfig.browserUseApiKey) {
        // Use cloud stealth browser
        await this.initializeCloudBrowser();
      } else {
        // Try local browser, fallback to cloud if it fails
        try {
          await this.initializeLocalBrowser();
        } catch (localError) {
          this.telemetry.warn(`Local browser failed: ${localError}`);

          // Fallback to cloud browser if API key available
          if (this.browserConfig.browserUseApiKey) {
            this.telemetry.info("Falling back to cloud browser...");
            await this.initializeCloudBrowser();
          } else {
            throw localError;
          }
        }
      }
    } else if (this.context && !this.page) {
      // Use injected browser
      this.page = this.context.pages()[0] || await this.context.newPage();
    }

    // Setup request capture for skill generation
    this.setupRequestCapture();

    // Initialize services
    this.domService = new DOMService(this.page!);
    this.actionExecutor = new ActionExecutor(this.page!, this.context!, this.domService);
    this.variableDetector = new VariableDetector(this.page!, {
      detectForms: true,
      detectCookies: true,
      detectStorage: false, // Disabled - triggers bot detection on delivery apps (Grab, Foodpanda, etc.)
      detectUrlParams: true,
      maskSensitive: true,
    });

    // Navigate to start URL if provided
    if (this.config.startUrl) {
      this.telemetry.info(`Navigating to ${this.config.startUrl}`);
      const navStart = Date.now();
      await this.page!.goto(this.config.startUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      this.telemetry.recordNavigation(this.config.startUrl, Date.now() - navStart);

      // Detect initial variables
      await this.variableDetector.detect();
    }

    this.telemetry.endSpan(initSpanId, "ok");
  }

  /**
   * Initialize local browser (Playwright)
   */
  private async initializeLocalBrowser() {
    this.telemetry.info("Launching local browser...");

    // Auto-detect headless mode for environments without display
    const headless = this.browserConfig.headless ?? this.isHeadlessEnvironment();

    if (this.browserConfig.userDataDir) {
      // Launch with persistent context (real Chrome profile)
      this.context = await chromium.launchPersistentContext(
        this.browserConfig.userDataDir,
        {
          headless,
          executablePath: this.browserConfig.executablePath,
          viewport: this.browserConfig.viewport ?? { width: 1280, height: 800 },
          args: [
            "--disable-blink-features=AutomationControlled",
            "--no-first-run",
            "--no-default-browser-check",
          ],
        }
      );
      this.page = this.context.pages()[0] || await this.context.newPage();
    } else {
      // Launch regular browser
      this.browser = await chromium.launch({
        headless,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });
      this.context = await this.browser.newContext({
        viewport: this.browserConfig.viewport ?? { width: 1280, height: 800 },
      });
      this.page = await this.context.newPage();
    }
  }

  /**
   * Initialize cloud browser via Browser-Use SDK (stealth browser)
   */
  private async initializeCloudBrowser() {
    if (!this.browserConfig.browserUseApiKey) {
      throw new Error("browserUseApiKey required for cloud browser");
    }

    this.telemetry.info("Creating cloud stealth browser session...");

    const session = await createStealthSession(this.browserConfig.browserUseApiKey, {
      timeout: 15,
      proxyCountryCode: this.browserConfig.proxyCountry,
    });

    this.cloudSessionId = session.id;
    this.telemetry.info(`Cloud session created: ${session.id}`);
    this.telemetry.info(`Live view URL: ${session.liveUrl}`);

    // Connect Playwright to the cloud browser via CDP
    this.browser = await chromium.connectOverCDP(session.cdpUrl);
    this.context = this.browser.contexts()[0] || await this.browser.newContext({
      viewport: this.browserConfig.viewport ?? { width: 1280, height: 800 },
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
  }

  /**
   * Setup network request capture for skill generation
   */
  private setupRequestCapture() {
    this.context!.on("response", async (response) => {
      try {
        const request = response.request();
        const resourceType = request.resourceType();

        // Only capture API calls (XHR/Fetch) for skill generation
        if (resourceType === "xhr" || resourceType === "fetch") {
          const requestHeaders: Record<string, string> = {};
          const responseHeaders: Record<string, string> = {};

          try {
            Object.assign(requestHeaders, await request.allHeaders());
          } catch { /* ignore */ }

          try {
            Object.assign(responseHeaders, await response.allHeaders());
          } catch { /* ignore */ }

          const capturedRequest: CapturedRequest = {
            method: request.method(),
            url: request.url(),
            status: response.status(),
            resourceType,
            headers: requestHeaders,
            postData: request.postData() ?? undefined,
            responseHeaders,
          };

          this.capturedRequests.push(capturedRequest);
          this.telemetry.incrementCounter("requests.captured", 1, { method: request.method() });

          // Hook: request captured
          this.callHook("onRequestCaptured", capturedRequest);
        }
      } catch { /* ignore capture errors */ }
    });
  }

  /**
   * Cleanup resources
   */
  private async cleanup() {
    const cleanupSpanId = this.telemetry.startSpan("agent.cleanup");

    if (!this.injectedBrowser) {
      try {
        if (this.context) await this.context.close();
        if (this.browser) await this.browser.close();
      } catch { /* ignore cleanup errors */ }

      // Stop cloud session if used
      if (this.cloudSessionId && this.browserConfig.browserUseApiKey) {
        try {
          await stopStealthSession(this.browserConfig.browserUseApiKey, this.cloudSessionId);
          this.telemetry.info(`Cloud session stopped: ${this.cloudSessionId}`);
        } catch { /* ignore cleanup errors */ }
      }
    }

    // Log final telemetry summary
    const summary = this.telemetry.getSummary();
    this.telemetry.info("Agent run complete", {
      totalSpans: summary.spans.total,
      errors: summary.errors,
      avgStepDuration: summary.metrics.stepStats?.avg,
      requestsCaptured: this.capturedRequests.length,
      variablesDetected: this.variableDetector ? Object.keys(this.variableDetector.export()).length : 0,
    });

    this.telemetry.endSpan(cleanupSpanId, "ok");
  }

  /**
   * Stop the agent
   */
  stop() {
    this.shouldStop = true;
    this.telemetry.info("Agent stop requested");
  }

  /**
   * Get current telemetry
   */
  getTelemetry(): TelemetryService {
    return this.telemetry;
  }

  /**
   * Get memory manager
   */
  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }

  /**
   * Get detected variables
   */
  getDetectedVariables(): Record<string, string> {
    return this.variableDetector?.export() ?? {};
  }
}
