/**
 * Browser-Use TypeScript Port - LLM Provider
 *
 * Flexible LLM provider system with automatic fallback switching.
 * Handles rate limits, errors, and automatic provider switching.
 *
 * Features:
 * - Multiple provider support (OpenAI, Anthropic, Browser-Use, custom)
 * - Automatic fallback on rate limits (429) or server errors (500-504)
 * - One-shot fallback to prevent cascading failures
 * - Token/cost tracking
 * - Request/response logging
 */

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
}

export interface LLMProvider {
  /** Send messages and get a response */
  chat(messages: LLMMessage[]): Promise<string>;
  /** Get provider name */
  getName?(): string;
  /** Check if provider is available */
  isAvailable?(): Promise<boolean>;
}

/**
 * Error classification for retry/fallback decisions
 */
export enum LLMErrorType {
  RATE_LIMIT = "rate_limit",
  AUTH_ERROR = "auth_error",
  SERVER_ERROR = "server_error",
  TIMEOUT = "timeout",
  NETWORK = "network",
  INVALID_REQUEST = "invalid_request",
  UNKNOWN = "unknown",
}

/**
 * LLM error with classification
 */
export class LLMError extends Error {
  type: LLMErrorType;
  statusCode?: number;
  provider: string;
  retryable: boolean;

  constructor(
    message: string,
    type: LLMErrorType,
    provider: string,
    statusCode?: number
  ) {
    super(message);
    this.name = "LLMError";
    this.type = type;
    this.provider = provider;
    this.statusCode = statusCode;
    this.retryable = [
      LLMErrorType.RATE_LIMIT,
      LLMErrorType.SERVER_ERROR,
      LLMErrorType.TIMEOUT,
      LLMErrorType.NETWORK,
    ].includes(type);
  }

  static fromResponse(
    statusCode: number,
    message: string,
    provider: string
  ): LLMError {
    let type: LLMErrorType;

    if (statusCode === 429) {
      type = LLMErrorType.RATE_LIMIT;
    } else if (statusCode === 401 || statusCode === 403) {
      type = LLMErrorType.AUTH_ERROR;
    } else if (statusCode >= 500 && statusCode < 600) {
      type = LLMErrorType.SERVER_ERROR;
    } else if (statusCode === 400 || statusCode === 422) {
      type = LLMErrorType.INVALID_REQUEST;
    } else {
      type = LLMErrorType.UNKNOWN;
    }

    return new LLMError(message, type, provider, statusCode);
  }
}

/**
 * Configuration for creating an LLM provider
 */
export interface LLMProviderConfig {
  /** Provider type */
  type: "openai" | "anthropic" | "browser-use" | "custom";
  /** API key */
  apiKey: string;
  /** Model name */
  model: string;
  /** Base URL (for OpenAI-compatible APIs) */
  baseUrl?: string;
  /** Request timeout in ms */
  timeout?: number;
  /** Temperature (default: 0) */
  temperature?: number;
  /** Max tokens */
  maxTokens?: number;
}

/**
 * Create an LLM provider from config
 */
export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  switch (config.type) {
    case "openai":
      return new OpenAIProvider(config);
    case "anthropic":
      return new AnthropicProvider(config);
    case "browser-use":
      return new BrowserUseProvider(config);
    default:
      throw new Error(`Unknown provider type: ${config.type}`);
  }
}

/**
 * OpenAI-compatible provider
 */
export class OpenAIProvider implements LLMProvider {
  private config: LLMProviderConfig;
  private name: string;

  constructor(config: LLMProviderConfig) {
    this.config = config;
    this.name = `openai:${config.model}`;
  }

  getName(): string {
    return this.name;
  }

  async chat(messages: LLMMessage[]): Promise<string> {
    const baseUrl = this.config.baseUrl || "https://api.openai.com/v1";

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: this.config.temperature ?? 0,
        max_tokens: this.config.maxTokens,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw LLMError.fromResponse(response.status, error, this.name);
    }

    const data = (await response.json()) as any;
    return data.choices?.[0]?.message?.content || "";
  }
}

/**
 * Anthropic provider
 */
export class AnthropicProvider implements LLMProvider {
  private config: LLMProviderConfig;
  private name: string;

  constructor(config: LLMProviderConfig) {
    this.config = config;
    this.name = `anthropic:${config.model}`;
  }

  getName(): string {
    return this.name;
  }

  async chat(messages: LLMMessage[]): Promise<string> {
    const baseUrl = this.config.baseUrl || "https://api.anthropic.com/v1";

    // Extract system message
    const systemMessage = messages.find((m) => m.role === "system");
    const chatMessages = messages.filter((m) => m.role !== "system");

    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens || 4096,
        system: systemMessage?.content,
        messages: chatMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw LLMError.fromResponse(response.status, error, this.name);
    }

    const data = (await response.json()) as any;
    return data.content?.[0]?.text || "";
  }
}

/**
 * Browser-Use API provider
 */
export class BrowserUseProvider implements LLMProvider {
  private config: LLMProviderConfig;
  private name: string;

  constructor(config: LLMProviderConfig) {
    this.config = config;
    this.name = `browser-use:${config.model || "bu-2-0"}`;
  }

  getName(): string {
    return this.name;
  }

  async chat(messages: LLMMessage[]): Promise<string> {
    const response = await fetch(
      "https://api.browser-use.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model || "bu-2-0",
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          temperature: this.config.temperature ?? 0,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw LLMError.fromResponse(response.status, error, this.name);
    }

    const data = (await response.json()) as any;
    return data.choices?.[0]?.message?.content || "";
  }
}

/**
 * Fallback LLM provider configuration
 */
export interface FallbackLLMConfig {
  /** Primary provider */
  primary: LLMProvider | LLMProviderConfig;
  /** Fallback providers in order of preference */
  fallbacks?: Array<LLMProvider | LLMProviderConfig>;
  /** Max retries per provider before fallback */
  maxRetries?: number;
  /** Delay between retries in ms */
  retryDelayMs?: number;
  /** Whether to use one-shot fallback (only try fallback once) */
  oneShotFallback?: boolean;
  /** Callback when switching to fallback */
  onFallback?: (from: string, to: string, error: LLMError) => void;
}

/**
 * Fallback LLM Provider - Automatically switches between providers on errors
 */
export class FallbackLLMProvider implements LLMProvider {
  private providers: LLMProvider[];
  private currentIndex: number = 0;
  private config: Required<Omit<FallbackLLMConfig, "primary" | "fallbacks" | "onFallback">> & {
    onFallback?: FallbackLLMConfig["onFallback"];
  };
  private fallbackUsed: boolean = false;

  constructor(config: FallbackLLMConfig) {
    // Convert configs to providers
    const toProvider = (p: LLMProvider | LLMProviderConfig): LLMProvider => {
      if ("chat" in p) return p;
      return createLLMProvider(p);
    };

    this.providers = [
      toProvider(config.primary),
      ...(config.fallbacks?.map(toProvider) || []),
    ];

    this.config = {
      maxRetries: config.maxRetries ?? 2,
      retryDelayMs: config.retryDelayMs ?? 1000,
      oneShotFallback: config.oneShotFallback ?? true,
      onFallback: config.onFallback,
    };
  }

  getName(): string {
    const current = this.providers[this.currentIndex];
    return current.getName?.() || `provider-${this.currentIndex}`;
  }

  /**
   * Get current provider
   */
  getCurrentProvider(): LLMProvider {
    return this.providers[this.currentIndex];
  }

  /**
   * Check if we have fallback providers available
   */
  hasFallback(): boolean {
    if (this.config.oneShotFallback && this.fallbackUsed) {
      return false;
    }
    return this.currentIndex < this.providers.length - 1;
  }

  /**
   * Switch to next fallback provider
   */
  private switchToFallback(error: LLMError): boolean {
    if (!this.hasFallback()) {
      return false;
    }

    const fromName = this.getName();
    this.currentIndex++;
    this.fallbackUsed = true;
    const toName = this.getName();

    console.log(`[llm-provider] Switching from ${fromName} to ${toName}`);

    if (this.config.onFallback) {
      this.config.onFallback(fromName, toName, error);
    }

    return true;
  }

  /**
   * Reset to primary provider
   */
  reset(): void {
    this.currentIndex = 0;
    this.fallbackUsed = false;
  }

  async chat(messages: LLMMessage[]): Promise<string> {
    let lastError: LLMError | null = null;

    // Try current provider with retries
    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const provider = this.getCurrentProvider();
        return await provider.chat(messages);
      } catch (err) {
        lastError =
          err instanceof LLMError
            ? err
            : new LLMError(
                (err as Error).message,
                LLMErrorType.UNKNOWN,
                this.getName()
              );

        console.error(
          `[llm-provider] ${this.getName()} attempt ${attempt + 1} failed:`,
          lastError.message
        );

        // Check if we should fallback immediately (rate limit, server error)
        if (
          lastError.retryable &&
          (lastError.type === LLMErrorType.RATE_LIMIT ||
            lastError.type === LLMErrorType.SERVER_ERROR)
        ) {
          // Try fallback instead of retrying same provider
          if (this.switchToFallback(lastError)) {
            // Reset attempt counter for new provider
            attempt = -1;
            continue;
          }
        }

        // Wait before retry
        if (attempt < this.config.maxRetries - 1) {
          await new Promise((r) =>
            setTimeout(r, this.config.retryDelayMs * Math.pow(2, attempt))
          );
        }
      }
    }

    // All retries failed, try fallback
    if (lastError && this.switchToFallback(lastError)) {
      // Recursive call with new provider
      return this.chat(messages);
    }

    // No more options
    throw lastError || new Error("LLM request failed");
  }
}

/**
 * Helper to create a fallback-enabled LLM provider
 */
export function createFallbackLLM(
  primary: LLMProviderConfig,
  ...fallbacks: LLMProviderConfig[]
): FallbackLLMProvider {
  return new FallbackLLMProvider({
    primary,
    fallbacks,
  });
}

/**
 * Create a simple LLM provider (without fallback)
 */
export function createSimpleLLM(
  type: "openai" | "anthropic" | "browser-use",
  apiKey: string,
  model?: string
): LLMProvider {
  const defaults: Record<string, string> = {
    openai: "gpt-4o",
    anthropic: "claude-sonnet-4-20250514",
    "browser-use": "bu-2-0",
  };

  return createLLMProvider({
    type,
    apiKey,
    model: model || defaults[type],
  });
}
