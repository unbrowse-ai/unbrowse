/**
 * Task Watcher — Observe what the agent is trying to do.
 *
 * Watches hooks to:
 * 1. Parse user intent from prompts
 * 2. Detect tool failures that unbrowse can fix
 * 3. Track task context across turns
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface TaskIntent {
  domain: string | null; // e.g., "twitter", "linear", "notion"
  action: string | null; // e.g., "post", "create", "fetch"
  requirements: string[]; // e.g., ["auth", "api-access"]
  rawPrompt: string;
  confidence: number; // 0-1 how confident we are in the parse
}

export interface FailureInfo {
  toolName: string;
  error: string;
  errorType: "auth" | "rate_limit" | "not_found" | "blocked" | "unknown";
  canResolve: boolean;
  suggestedAction?: string;
}

// ── Domain patterns ──────────────────────────────────────────────────────────

const DOMAIN_PATTERNS: Record<string, RegExp[]> = {
  twitter: [/twitter/i, /tweet/i, /x\.com/i, /\bx\b/i, /@\w+/],
  linear: [/linear/i, /ticket/i, /issue/i, /backlog/i],
  notion: [/notion/i, /page/i, /database/i, /block/i],
  github: [/github/i, /repo/i, /pr\b/i, /pull request/i, /commit/i],
  slack: [/slack/i, /message/i, /channel/i, /dm\b/i],
  discord: [/discord/i, /server/i, /guild/i],
  gmail: [/gmail/i, /email/i, /mail/i, /inbox/i],
  calendar: [/calendar/i, /event/i, /meeting/i, /schedule/i],
  drive: [/drive/i, /docs/i, /sheets/i, /slides/i],
  spotify: [/spotify/i, /playlist/i, /song/i, /track/i],
  youtube: [/youtube/i, /video/i, /watch/i, /subscribe/i],
  linkedin: [/linkedin/i, /connection/i, /profile/i],
  reddit: [/reddit/i, /subreddit/i, /post/i, /comment/i],
  figma: [/figma/i, /design/i, /prototype/i],
  airtable: [/airtable/i, /base/i, /record/i],
  stripe: [/stripe/i, /payment/i, /invoice/i, /subscription/i],
  shopify: [/shopify/i, /store/i, /product/i, /order/i],
};

const ACTION_PATTERNS: Record<string, RegExp[]> = {
  create: [/create/i, /make/i, /add/i, /new/i, /write/i, /post/i, /send/i],
  read: [/get/i, /fetch/i, /read/i, /show/i, /list/i, /find/i, /search/i],
  update: [/update/i, /edit/i, /change/i, /modify/i, /set/i],
  delete: [/delete/i, /remove/i, /clear/i, /cancel/i],
  auth: [/login/i, /authenticate/i, /sign in/i, /connect/i],
};

// ── Task Watcher ─────────────────────────────────────────────────────────────

export class TaskWatcher {
  private currentIntent: TaskIntent | null = null;
  private failureHistory: FailureInfo[] = [];

  /**
   * Parse user intent from a prompt.
   */
  parseIntent(prompt: string): TaskIntent {
    const domain = this.extractDomain(prompt);
    const action = this.extractAction(prompt);
    const requirements = this.extractRequirements(prompt, domain);

    const intent: TaskIntent = {
      domain,
      action,
      requirements,
      rawPrompt: prompt,
      confidence: this.calculateConfidence(domain, action),
    };

    this.currentIntent = intent;
    return intent;
  }

  /**
   * Extract the target domain/service from prompt.
   */
  private extractDomain(prompt: string): string | null {
    for (const [domain, patterns] of Object.entries(DOMAIN_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(prompt)) {
          return domain;
        }
      }
    }

    // Try to extract URL domain
    const urlMatch = prompt.match(/https?:\/\/([^\/\s]+)/);
    if (urlMatch) {
      const hostname = urlMatch[1];
      // Clean up: remove www, get main domain
      return hostname.replace(/^www\./, "").split(".")[0];
    }

    return null;
  }

  /**
   * Extract the action type.
   */
  private extractAction(prompt: string): string | null {
    for (const [action, patterns] of Object.entries(ACTION_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(prompt)) {
          return action;
        }
      }
    }
    return null;
  }

  /**
   * Extract requirements (auth, specific access, etc.)
   */
  private extractRequirements(prompt: string, domain: string | null): string[] {
    const reqs: string[] = [];

    // Actions that typically require auth
    if (/post|send|create|delete|update|edit|write/i.test(prompt)) {
      reqs.push("auth");
    }

    // Private data access
    if (/private|my |personal|account/i.test(prompt)) {
      reqs.push("auth");
    }

    // Specific API access
    if (domain) {
      reqs.push("api-access");
    }

    return [...new Set(reqs)];
  }

  /**
   * Calculate confidence in our parse.
   */
  private calculateConfidence(domain: string | null, action: string | null): number {
    let confidence = 0.3; // Base

    if (domain) confidence += 0.35;
    if (action) confidence += 0.25;

    return Math.min(confidence, 1);
  }

  /**
   * Get current intent.
   */
  getCurrentIntent(): TaskIntent | null {
    return this.currentIntent;
  }

  /**
   * Detect failure from tool result.
   */
  detectFailure(toolName: string, result: unknown, error?: string): FailureInfo | null {
    // Explicit error
    if (error) {
      const info = this.classifyError(toolName, error);
      this.failureHistory.push(info);
      return info;
    }

    // Check for soft failures in result
    const softFailure = this.detectSoftFailure(toolName, result);
    if (softFailure) {
      this.failureHistory.push(softFailure);
      return softFailure;
    }

    return null;
  }

  /**
   * Classify an error string.
   */
  private classifyError(toolName: string, error: string): FailureInfo {
    const lowerError = error.toLowerCase();

    // OpenClaw browser tool errors (common, noisy). Recommend unbrowse_browse instead.
    // This improves "seamlessness" by steering agents away from brittle ref-based snapshots.
    if (toolName === "browser") {
      if (lowerError.includes("chrome extension relay is running") && lowerError.includes("no tab is connected")) {
        return {
          toolName,
          error,
          errorType: "blocked",
          canResolve: true,
          suggestedAction:
            "Avoid the built-in browser tool. Use unbrowse_browse (Playwright+CDP :18800). If you must use relay profile \"chrome\", click the OpenClaw Chrome extension icon on a tab to attach.",
        };
      }

      if (lowerError.includes("ref is required") || lowerError.includes("fields are required")) {
        return {
          toolName,
          error,
          errorType: "unknown",
          canResolve: true,
          suggestedAction:
            "Avoid the built-in browser tool snapshot/act path. Use unbrowse_browse actions by index (CDP-first) to reduce ref/fields errors.",
        };
      }

      if (lowerError.includes("refs=aria does not support selector/frame snapshots yet")) {
        return {
          toolName,
          error,
          errorType: "unknown",
          canResolve: true,
          suggestedAction:
            "Avoid refs=aria snapshots for now. Use unbrowse_browse (index-based actions) or rerun snapshot without aria refs.",
        };
      }
    }

    // Auth failures
    if (
      lowerError.includes("401") ||
      lowerError.includes("403") ||
      lowerError.includes("unauthorized") ||
      lowerError.includes("forbidden") ||
      lowerError.includes("auth") ||
      lowerError.includes("login required")
    ) {
      return {
        toolName,
        error,
        errorType: "auth",
        canResolve: true,
        suggestedAction: "Re-authenticate with the service",
      };
    }

    // Rate limits
    if (
      lowerError.includes("429") ||
      lowerError.includes("rate limit") ||
      lowerError.includes("too many requests")
    ) {
      return {
        toolName,
        error,
        errorType: "rate_limit",
        canResolve: true,
        suggestedAction: "Wait and retry with backoff",
      };
    }

    // Blocked/bot detection
    if (
      lowerError.includes("blocked") ||
      lowerError.includes("captcha") ||
      lowerError.includes("bot detection") ||
      lowerError.includes("access denied")
    ) {
      return {
        toolName,
        error,
        errorType: "blocked",
        canResolve: true,
        suggestedAction: "Use stealth browser mode",
      };
    }

    // Not found
    if (
      lowerError.includes("404") ||
      lowerError.includes("not found") ||
      lowerError.includes("tool not available")
    ) {
      return {
        toolName,
        error,
        errorType: "not_found",
        canResolve: true,
        suggestedAction: "Generate the missing tool or capture the API",
      };
    }

    // Unknown
    return {
      toolName,
      error,
      errorType: "unknown",
      canResolve: false,
    };
  }

  /**
   * Detect soft failures from result content.
   */
  private detectSoftFailure(toolName: string, result: unknown): FailureInfo | null {
    if (!result || typeof result !== "object") return null;

    const resultStr = JSON.stringify(result).toLowerCase();

    // Check for auth-related responses
    if (
      resultStr.includes('"status":401') ||
      resultStr.includes('"status":403') ||
      resultStr.includes("login") ||
      resultStr.includes("sign in")
    ) {
      return {
        toolName,
        error: "Auth required (detected in response)",
        errorType: "auth",
        canResolve: true,
        suggestedAction: "Re-authenticate with the service",
      };
    }

    // Rate limit indicators
    if (resultStr.includes("rate") && resultStr.includes("limit")) {
      return {
        toolName,
        error: "Rate limit detected in response",
        errorType: "rate_limit",
        canResolve: true,
        suggestedAction: "Wait and retry",
      };
    }

    return null;
  }

  /**
   * Check if we can help with a failure.
   */
  canWeHelp(failure: FailureInfo): boolean {
    return failure.canResolve;
  }

  /**
   * Get failure history.
   */
  getFailureHistory(): FailureInfo[] {
    return this.failureHistory;
  }

  /**
   * Clear failure history.
   */
  clearHistory(): void {
    this.failureHistory = [];
    this.currentIntent = null;
  }
}

export const taskWatcher = new TaskWatcher();
