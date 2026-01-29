/**
 * Browser-Use TypeScript Port - Memory Manager
 *
 * Intelligent memory management for agent history and context.
 * Replaces naive trimming with importance-based retention.
 *
 * Features:
 * - Importance scoring for history entries
 * - Semantic deduplication (hash-based)
 * - Intelligent pruning (keep high-value, compress old)
 * - Context summarization for old history
 * - Variable extraction and tracking
 */

import type { AgentHistory, BrowserState, ActionResult } from "./types.js";

/**
 * Memory entry with importance scoring
 */
export interface MemoryEntry {
  /** Original history entry */
  history: AgentHistory;
  /** Importance score (0-100) */
  importance: number;
  /** Content hash for deduplication */
  hash: string;
  /** Whether this entry contains extracted data */
  hasExtraction: boolean;
  /** Whether this entry had errors */
  hasError: boolean;
  /** Whether this navigated to a new URL */
  hadNavigation: boolean;
  /** Extracted variables/values */
  variables: Record<string, string>;
}

/**
 * Summarized history for old context
 */
export interface HistorySummary {
  /** Step range covered */
  stepRange: { from: number; to: number };
  /** Key actions taken */
  keyActions: string[];
  /** Important data extracted */
  extractedData: string[];
  /** Errors encountered */
  errors: string[];
  /** URLs visited */
  urlsVisited: string[];
  /** Variables discovered */
  variables: Record<string, string>;
}

/**
 * Memory manager configuration
 */
export interface MemoryConfig {
  /** Max detailed history entries to keep */
  maxDetailedEntries?: number;
  /** Max summarized groups to keep */
  maxSummaries?: number;
  /** Entries per summary group */
  summaryGroupSize?: number;
  /** Minimum importance score to always keep */
  minImportanceToKeep?: number;
  /** Enable deduplication */
  deduplicate?: boolean;
}

/**
 * Memory Manager - Smart history management
 */
export class MemoryManager {
  private entries: MemoryEntry[] = [];
  private summaries: HistorySummary[] = [];
  private variables = new Map<string, string>();
  private config: Required<MemoryConfig>;

  constructor(config: MemoryConfig = {}) {
    this.config = {
      maxDetailedEntries: config.maxDetailedEntries ?? 15,
      maxSummaries: config.maxSummaries ?? 5,
      summaryGroupSize: config.summaryGroupSize ?? 5,
      minImportanceToKeep: config.minImportanceToKeep ?? 70,
      deduplicate: config.deduplicate ?? true,
    };
  }

  /**
   * Add a history entry
   */
  add(history: AgentHistory): void {
    const entry = this.processEntry(history);

    // Check for duplicates
    if (this.config.deduplicate) {
      const existing = this.entries.find(e => e.hash === entry.hash);
      if (existing) {
        // Update existing entry if new one is more important
        if (entry.importance > existing.importance) {
          Object.assign(existing, entry);
        }
        return;
      }
    }

    this.entries.push(entry);

    // Extract and track variables
    for (const [key, value] of Object.entries(entry.variables)) {
      this.variables.set(key, value);
    }

    // Prune if needed
    this.prune();
  }

  /**
   * Process a history entry and calculate importance
   */
  private processEntry(history: AgentHistory): MemoryEntry {
    const hasExtraction = history.results.some(r =>
      r.includeInMemory && r.extractedContent && r.extractedContent.length > 50
    );
    const hasError = history.results.some(r => !r.success);
    const hadNavigation = this.detectNavigation(history);
    const variables = this.extractVariables(history);
    const importance = this.calculateImportance(history, hasExtraction, hasError, hadNavigation);
    const hash = this.hashEntry(history);

    return {
      history,
      importance,
      hash,
      hasExtraction,
      hasError,
      hadNavigation,
      variables,
    };
  }

  /**
   * Calculate importance score (0-100)
   */
  private calculateImportance(
    history: AgentHistory,
    hasExtraction: boolean,
    hasError: boolean,
    hadNavigation: boolean
  ): number {
    let score = 50; // Base score

    // Extraction is valuable
    if (hasExtraction) score += 25;

    // Errors are important to remember
    if (hasError) score += 15;

    // Navigation changes context
    if (hadNavigation) score += 10;

    // Recent entries are more important
    const recencyBonus = Math.max(0, 10 - (this.entries.length - history.step));
    score += recencyBonus;

    // Actions that change state are important
    const stateChangingActions = ["input_text", "click", "select_dropdown", "upload_file"];
    for (const action of history.actions) {
      const actionName = Object.keys(action)[0];
      if (stateChangingActions.includes(actionName)) {
        score += 5;
      }
    }

    // Memory field suggests important context
    if (history.state.memory && history.state.memory.length > 20) {
      score += 10;
    }

    // Done action is always important
    if (history.actions.some(a => "done" in a)) {
      score = 100;
    }

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Detect if navigation occurred
   */
  private detectNavigation(history: AgentHistory): boolean {
    return history.actions.some(a =>
      "navigate" in a || "search" in a || "go_back" in a
    );
  }

  /**
   * Extract variables from history
   */
  private extractVariables(history: AgentHistory): Record<string, string> {
    const variables: Record<string, string> = {};

    // Extract from action parameters
    for (const action of history.actions) {
      if ("input_text" in action) {
        const text = action.input_text.text;
        // Detect email patterns
        const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
          variables.email = emailMatch[0];
        }
        // Detect URL patterns
        const urlMatch = text.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
          variables.inputUrl = urlMatch[0];
        }
      }

      if ("navigate" in action) {
        variables.lastNavigatedUrl = action.navigate.url;
      }
    }

    // Extract from results
    for (const result of history.results) {
      if (result.extractedContent) {
        // Look for common patterns in extracted content
        const content = result.extractedContent;

        // Session IDs
        const sessionMatch = content.match(/session[_-]?id[:\s]*([a-zA-Z0-9_-]+)/i);
        if (sessionMatch) {
          variables.sessionId = sessionMatch[1];
        }

        // Auth tokens
        const tokenMatch = content.match(/token[:\s]*([a-zA-Z0-9._-]+)/i);
        if (tokenMatch && tokenMatch[1].length > 20) {
          variables.authToken = tokenMatch[1];
        }

        // User IDs
        const userIdMatch = content.match(/user[_-]?id[:\s]*([a-zA-Z0-9_-]+)/i);
        if (userIdMatch) {
          variables.userId = userIdMatch[1];
        }
      }
    }

    // Extract from browser state
    if (history.browserState) {
      variables.currentUrl = history.browserState.url;
      if (history.browserState.title) {
        variables.pageTitle = history.browserState.title;
      }
    }

    return variables;
  }

  /**
   * Create hash for deduplication
   */
  private hashEntry(history: AgentHistory): string {
    const actionStr = history.actions.map(a => JSON.stringify(a)).join("|");
    const resultStr = history.results.map(r => `${r.success}:${r.extractedContent?.slice(0, 50)}`).join("|");
    const combined = `${history.browserState?.url}:${actionStr}:${resultStr}`;

    // Simple hash function
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  /**
   * Prune old entries intelligently
   */
  private prune(): void {
    if (this.entries.length <= this.config.maxDetailedEntries) {
      return;
    }

    // Sort by importance (descending)
    const sorted = [...this.entries].sort((a, b) => b.importance - a.importance);

    // Always keep high-importance entries
    const keep: MemoryEntry[] = [];
    const candidates: MemoryEntry[] = [];

    for (const entry of sorted) {
      if (entry.importance >= this.config.minImportanceToKeep) {
        keep.push(entry);
      } else {
        candidates.push(entry);
      }
    }

    // Fill remaining slots with most important candidates
    const remainingSlots = this.config.maxDetailedEntries - keep.length;
    const toKeep = candidates.slice(0, Math.max(0, remainingSlots));
    const toSummarize = candidates.slice(Math.max(0, remainingSlots));

    // Create summary from pruned entries
    if (toSummarize.length >= this.config.summaryGroupSize) {
      const summary = this.createSummary(toSummarize);
      this.summaries.push(summary);

      // Limit summaries
      if (this.summaries.length > this.config.maxSummaries) {
        this.summaries.shift();
      }
    }

    // Update entries list (restore chronological order)
    this.entries = [...keep, ...toKeep].sort(
      (a, b) => a.history.step - b.history.step
    );
  }

  /**
   * Create summary from multiple entries
   */
  private createSummary(entries: MemoryEntry[]): HistorySummary {
    const steps = entries.map(e => e.history.step);
    const keyActions: string[] = [];
    const extractedData: string[] = [];
    const errors: string[] = [];
    const urlsVisited = new Set<string>();
    const variables: Record<string, string> = {};

    for (const entry of entries) {
      // Collect URLs
      if (entry.history.browserState?.url) {
        urlsVisited.add(entry.history.browserState.url);
      }

      // Collect key actions
      for (const action of entry.history.actions) {
        const actionName = Object.keys(action)[0];
        if (["navigate", "click", "input_text", "done"].includes(actionName)) {
          keyActions.push(`Step ${entry.history.step}: ${actionName}`);
        }
      }

      // Collect extractions
      for (const result of entry.history.results) {
        if (result.includeInMemory && result.extractedContent) {
          extractedData.push(result.extractedContent.slice(0, 100));
        }
        if (!result.success && result.error) {
          errors.push(`Step ${entry.history.step}: ${result.error}`);
        }
      }

      // Merge variables
      Object.assign(variables, entry.variables);
    }

    return {
      stepRange: { from: Math.min(...steps), to: Math.max(...steps) },
      keyActions: keyActions.slice(0, 10),
      extractedData: extractedData.slice(0, 5),
      errors: errors.slice(0, 5),
      urlsVisited: Array.from(urlsVisited),
      variables,
    };
  }

  /**
   * Get formatted history for LLM context
   */
  formatForLLM(): string {
    const lines: string[] = [];

    // Include summaries first
    if (this.summaries.length > 0) {
      lines.push("=== Previous History Summary ===");
      for (const summary of this.summaries) {
        lines.push(`Steps ${summary.stepRange.from}-${summary.stepRange.to}:`);
        if (summary.keyActions.length > 0) {
          lines.push(`  Actions: ${summary.keyActions.join(", ")}`);
        }
        if (summary.urlsVisited.length > 0) {
          lines.push(`  URLs: ${summary.urlsVisited.slice(0, 3).join(", ")}`);
        }
        if (summary.errors.length > 0) {
          lines.push(`  Errors: ${summary.errors.length} errors`);
        }
      }
      lines.push("");
    }

    // Include detailed recent history
    if (this.entries.length > 0) {
      lines.push("=== Recent History ===");
      for (const entry of this.entries.slice(-10)) {
        const h = entry.history;
        const actionResults = h.results
          .map((r, i) => {
            const actionName = Object.keys(h.actions[i] || {})[0] || "unknown";
            const status = r.success ? "✓" : "✗";
            const content = r.extractedContent || r.error || "";
            return `  ${status} ${actionName}: ${content.slice(0, 100)}`;
          })
          .join("\n");

        lines.push(`<step_${h.step}>`);
        lines.push(`Evaluation: ${h.state.evaluationPreviousGoal}`);
        lines.push(`Memory: ${h.state.memory}`);
        lines.push(`Next Goal: ${h.state.nextGoal}`);
        lines.push(`Actions:`);
        lines.push(actionResults);
        lines.push(`</step_${h.step}>`);
        lines.push("");
      }
    }

    // Include tracked variables
    if (this.variables.size > 0) {
      lines.push("=== Tracked Variables ===");
      for (const [key, value] of this.variables) {
        // Mask sensitive values
        const masked = this.maskSensitive(key, value);
        lines.push(`${key}: ${masked}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Mask sensitive variable values
   */
  private maskSensitive(key: string, value: string): string {
    const sensitiveKeys = ["password", "token", "secret", "key", "auth"];
    const isSensitive = sensitiveKeys.some(k => key.toLowerCase().includes(k));

    if (isSensitive && value.length > 4) {
      return value.slice(0, 2) + "***" + value.slice(-2);
    }
    return value;
  }

  /**
   * Get all tracked variables
   */
  getVariables(): Record<string, string> {
    return Object.fromEntries(this.variables);
  }

  /**
   * Set a variable manually
   */
  setVariable(key: string, value: string): void {
    this.variables.set(key, value);
  }

  /**
   * Get a specific variable
   */
  getVariable(key: string): string | undefined {
    return this.variables.get(key);
  }

  /**
   * Get recent history entries
   */
  getRecentHistory(count = 5): AgentHistory[] {
    return this.entries.slice(-count).map(e => e.history);
  }

  /**
   * Get all history
   */
  getAllHistory(): AgentHistory[] {
    return this.entries.map(e => e.history);
  }

  /**
   * Get memory stats
   */
  getStats(): {
    detailedEntries: number;
    summaries: number;
    variables: number;
    totalSteps: number;
    avgImportance: number;
  } {
    const totalImportance = this.entries.reduce((sum, e) => sum + e.importance, 0);
    const steps = this.entries.map(e => e.history.step);

    return {
      detailedEntries: this.entries.length,
      summaries: this.summaries.length,
      variables: this.variables.size,
      totalSteps: steps.length > 0 ? Math.max(...steps) : 0,
      avgImportance: this.entries.length > 0 ? totalImportance / this.entries.length : 0,
    };
  }

  /**
   * Clear all memory
   */
  clear(): void {
    this.entries = [];
    this.summaries = [];
    this.variables.clear();
  }
}

/**
 * Default memory manager instance
 */
export const defaultMemoryManager = new MemoryManager();
