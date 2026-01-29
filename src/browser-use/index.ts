/**
 * Browser-Use TypeScript Port
 *
 * A TypeScript implementation of browser-use for autonomous browser automation.
 * Integrated into the unbrowse extension for skill generation.
 *
 * Usage:
 * ```typescript
 * import { runBrowserUseAgent, createBrowserUseLLM } from "./browser-use";
 *
 * const result = await runBrowserUseAgent({
 *   task: "Search for 'browser automation' on Google",
 *   startUrl: "https://google.com",
 *   llmApiKey: "bu_xxx",
 * });
 * ```
 */

import { BrowserUseAgent, type LLMProvider, type AgentResult, type AgentHooks } from "./agent.js";
import type { AgentConfig, BrowserConfig, CapturedRequest } from "./types.js";

export * from "./types.js";
export {
  BrowserUseAgent,
  AgentHooks,
  AgentResult,
  // LLMProvider from agent.ts is deprecated - use llm-provider.ts instead
} from "./agent.js";
export * from "./dom-service.js";
export * from "./action-registry.js";
export * from "./default-actions.js";
export * from "./actions.js";
export * from "./prompts.js";
export * from "./element-finder.js";
export * from "./markdown-extractor.js";
export * from "./structured-output.js";
export * from "./mouse.js";
export * from "./screenshot-service.js";
export * from "./llm-provider.js";
export * from "./cdp-service.js";
export * from "./telemetry.js";
export * from "./memory-manager.js";
export * from "./variable-detector.js";

/**
 * Options for running the browser-use agent
 */
export interface RunBrowserUseOptions {
  task: string;
  startUrl?: string;
  maxSteps?: number;
  maxActionsPerStep?: number;

  /** Browser-Use API key for their optimized model */
  llmApiKey?: string;
  /** Model to use (default: bu-2-0) */
  llmModel?: string;

  /** Use real Chrome profile with all logins preserved */
  useChromeProfile?: boolean;
  /** Chrome executable path */
  chromeExecutablePath?: string;
  /** Chrome user data directory */
  chromeUserDataDir?: string;

  /** Existing Playwright browser (for shared browser) */
  existingBrowser?: any;
  /** Existing Playwright context (for shared browser) */
  existingContext?: any;

  /** Sensitive data to mask (e.g., passwords) */
  sensitiveData?: Record<string, string>;
  /** Additional instructions for the agent */
  extendSystemMessage?: string;

  /** Callback for each step (deprecated, use hooks) */
  onStep?: (step: number, action: string, result: string) => void;

  /** Lifecycle hooks for agent events */
  hooks?: AgentHooks;

  /** Force cloud browser even if local is available */
  forceCloud?: boolean;
  /** Proxy country code for cloud browser (e.g., "US", "GB") */
  proxyCountry?: string;
}

/**
 * Create an LLM provider for browser-use
 */
export function createBrowserUseLLM(apiKey: string, model = "bu-2-0"): LLMProvider {
  return {
    async chat(messages: Array<{ role: string; content: string }>): Promise<string> {
      const response = await fetch("https://api.browser-use.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          temperature: 0,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Browser-Use API error: ${response.status} ${error}`);
      }

      const data = await response.json() as any;
      return data.choices?.[0]?.message?.content || "";
    },
  };
}

/**
 * Create an LLM provider using OpenAI-compatible API
 */
export function createOpenAILLM(apiKey: string, model = "gpt-4o", baseUrl = "https://api.openai.com/v1"): LLMProvider {
  return {
    async chat(messages: Array<{ role: string; content: string }>): Promise<string> {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
          temperature: 0,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${error}`);
      }

      const data = await response.json() as any;
      return data.choices?.[0]?.message?.content || "";
    },
  };
}

/**
 * Run the browser-use agent with simplified options
 */
export async function runBrowserUseAgent(options: RunBrowserUseOptions): Promise<AgentResult> {
  // Create LLM provider
  if (!options.llmApiKey) {
    throw new Error("llmApiKey is required (Browser-Use API key)");
  }

  const llm = createBrowserUseLLM(options.llmApiKey, options.llmModel);

  // Build config
  const agentConfig: AgentConfig = {
    task: options.task,
    startUrl: options.startUrl,
    maxSteps: options.maxSteps ?? 50,
    maxActionsPerStep: options.maxActionsPerStep ?? 3,
    sensitiveData: options.sensitiveData,
    extendSystemMessage: options.extendSystemMessage,
  };

  // Build browser config
  const browserConfig: BrowserConfig = {
    // Cloud browser config (uses same API key for LLM and browser)
    browserUseApiKey: options.llmApiKey,
    forceCloud: options.forceCloud,
    proxyCountry: options.proxyCountry,
  };

  if (options.useChromeProfile) {
    // Use real Chrome profile
    browserConfig.executablePath = options.chromeExecutablePath ??
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    browserConfig.userDataDir = options.chromeUserDataDir ??
      `${process.env.HOME}/Library/Application Support/Google/Chrome`;
  }

  // Create and run agent
  const agent = new BrowserUseAgent(
    agentConfig,
    llm,
    browserConfig,
    options.existingBrowser,
    options.existingContext,
    options.hooks
  );

  return await agent.run();
}

/**
 * Default Chrome paths for different platforms
 */
export const CHROME_PATHS = {
  macos: {
    executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    userDataDir: "~/Library/Application Support/Google/Chrome",
    profileDirectory: "Default",
  },
  windows: {
    executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    userDataDir: "%LOCALAPPDATA%\\Google\\Chrome\\User Data",
    profileDirectory: "Default",
  },
  linux: {
    executable: "/usr/bin/google-chrome",
    userDataDir: "~/.config/google-chrome",
    profileDirectory: "Default",
  },
};
