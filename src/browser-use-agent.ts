/**
 * Browser-Use Agent Integration
 *
 * Uses our TypeScript port of browser-use to run an AI agent that browses autonomously,
 * while capturing network traffic for skill generation.
 */

import type { Browser, BrowserContext } from "playwright";
import { runBrowserUseAgent, createBrowserUseLLM, createOpenAILLM, CHROME_PATHS, type AgentResult } from "./browser-use/index.js";
import type { CapturedRequest } from "./browser-use/types.js";

export interface BrowserAgentOptions {
  task: string;
  startUrl?: string;
  maxSteps?: number;
  useVision?: boolean;
  sensitiveData?: Record<string, string>;
  onStep?: (step: number, action: string, result: string) => void;

  /** Browser-Use API key (for LLM and cloud browser sessions) */
  llmApiKey?: string;
  /** LLM provider: "browser-use" (default), "openai", "anthropic", or "openrouter" */
  llmProvider?: "browser-use" | "openai" | "anthropic" | "openrouter";
  /** Separate API key for LLM if different from llmApiKey */
  llmProviderApiKey?: string;
  /** Model name (default: bu-2-0 for browser-use) */
  llmModel?: string;

  /** Use real Chrome browser with user profile (preserves logins) */
  useChromeProfile?: boolean;
  /** Chrome executable path (default: macOS Chrome location) */
  chromeExecutablePath?: string;
  /** Chrome user data directory (default: macOS Chrome profile) */
  chromeUserDataDir?: string;

  /** Use existing Playwright browser instance instead of creating new one */
  existingBrowser?: Browser;
  /** Use existing Playwright context */
  existingContext?: BrowserContext;
}

export interface BrowserAgentResult {
  success: boolean;
  finalResult?: string;
  steps: Array<{
    step: number;
    action: string;
    result?: string;
  }>;
  capturedRequests: CapturedRequest[];
}

/**
 * Run a browser agent task with network capture
 */
export async function runBrowserAgent(
  options: BrowserAgentOptions
): Promise<BrowserAgentResult> {
  // Need either llmProviderApiKey or llmApiKey for LLM calls
  const llmProviderApiKey = options.llmProviderApiKey ?? options.llmApiKey;
  if (!llmProviderApiKey) {
    throw new Error("llmProviderApiKey or llmApiKey is required for LLM calls");
  }

  // Run the agent
  const result = await runBrowserUseAgent({
    task: options.task,
    startUrl: options.startUrl,
    maxSteps: options.maxSteps ?? 50,
    llmApiKey: options.llmApiKey,
    llmProvider: options.llmProvider ?? "browser-use",
    llmProviderApiKey,
    llmModel: options.llmModel ?? "bu-2-0",
    useChromeProfile: options.useChromeProfile,
    chromeExecutablePath: options.chromeExecutablePath,
    chromeUserDataDir: options.chromeUserDataDir,
    existingBrowser: options.existingBrowser,
    existingContext: options.existingContext,
    sensitiveData: options.sensitiveData,
    onStep: options.onStep,
  });

  // Convert to expected format
  const steps = result.history.history.map((h) => ({
    step: h.step,
    action: JSON.stringify(h.actions),
    result: h.results.map((r) => r.extractedContent || r.error).join("; "),
  }));

  return {
    success: result.success,
    finalResult: result.finalResult,
    steps,
    capturedRequests: result.capturedRequests,
  };
}

/**
 * Create an LLM for browser-use
 *
 * @deprecated Use runBrowserAgent with llmApiKey instead
 */
export async function createLLM(
  provider: "openai" | "anthropic" | "browser-use",
  options: { apiKey?: string; model?: string } = {}
): Promise<any> {
  if (provider === "browser-use") {
    if (!options.apiKey) {
      throw new Error("Browser-Use API key required");
    }
    return createBrowserUseLLM(options.apiKey, options.model ?? "bu-2-0");
  }

  if (provider === "openai") {
    if (!options.apiKey && !process.env.OPENAI_API_KEY) {
      throw new Error("OpenAI API key required");
    }
    return createOpenAILLM(
      options.apiKey ?? process.env.OPENAI_API_KEY!,
      options.model ?? "gpt-4o"
    );
  }

  if (provider === "anthropic") {
    throw new Error("Anthropic not yet supported in TypeScript port. Use browser-use or openai.");
  }

  throw new Error(`Unknown LLM provider: ${provider}`);
}

export { CHROME_PATHS };
