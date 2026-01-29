/**
 * Brain Index Client — Unified marketplace for abilities (skills, patterns, extensions, etc.)
 *
 * Extends the skill marketplace to support multiple ability types with
 * crowdsourced pricing and ranking by unique payers.
 *
 * Ability Types:
 *   - skill:      API skills (endpoints, auth, templates)
 *   - pattern:    Failure resolution patterns from unlearn
 *   - technique:  Reusable code snippets
 *   - extension:  Full clawdbot plugins
 *   - insight:    Successful approaches
 *   - agent:      High-fitness agent designs
 */

import { SkillIndexClient, type SkillPackage, type SkillSummary } from "./skill-index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type AbilityType = "skill" | "pattern" | "technique" | "extension" | "insight" | "agent";

export interface AbilitySummary extends SkillSummary {
  abilityType: AbilityType;
  priceCents: number;
  uniquePayers?: number;
  rankScore?: number;
}

export interface AbilityPackage {
  id: string;
  type: AbilityType;
  service: string;
  content: any; // Type-specific payload
  creatorWallet: string;
}

export interface PatternContent {
  errorPattern: string;
  resolution: string;
  tool?: string;
  context?: string;
  useCount: number;
}

export interface ExtensionContent {
  name: string;
  description: string;
  code: string;
  tools?: string[];
  hooks?: string[];
}

export interface TechniqueContent {
  name: string;
  description: string;
  code: string;
  language: string;
  tags: string[];
}

export interface InsightContent {
  tool: string;
  context: string;
  approach: string;
  result: string;
}

export interface AgentContent {
  name: string;
  systemPrompt: string;
  tools: string[];
  fitness: number;
  metadata?: Record<string, any>;
}

export interface PublishAbilityPayload {
  type: AbilityType;
  service: string; // Name/title
  content: PatternContent | ExtensionContent | TechniqueContent | InsightContent | AgentContent | any;
  creatorWallet: string;
  priceCents?: number; // Override default pricing
}

export interface LeaderboardEntry {
  id: string;
  service: string;
  slug: string;
  abilityType: AbilityType;
  downloadCount: number;
  uniquePayers: number;
  rankScore: number;
  reviewScore: number | null;
  priceCents: number;
  creatorWallet: string;
}

export interface LeaderboardResult {
  abilities: LeaderboardEntry[];
  total: number;
}

export interface SearchAbilityResult {
  skills: AbilitySummary[];
  total: number;
}

// ── Client ───────────────────────────────────────────────────────────────────

export class BrainIndexClient extends SkillIndexClient {
  /**
   * Search abilities by query with optional type filter.
   */
  async searchAbilities(
    query: string,
    opts?: { type?: AbilityType; tags?: string; limit?: number; offset?: number },
  ): Promise<SearchAbilityResult> {
    const url = new URL(`${this["indexUrl"]}/skills/search`);
    url.searchParams.set("q", query);
    if (opts?.type) url.searchParams.set("type", opts.type);
    if (opts?.tags) url.searchParams.set("tags", opts.tags);
    if (opts?.limit) url.searchParams.set("limit", String(opts.limit));
    if (opts?.offset) url.searchParams.set("offset", String(opts.offset));

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Search failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<SearchAbilityResult>;
  }

  /**
   * Get the leaderboard — top abilities ranked by unique payers.
   */
  async getLeaderboard(opts?: { type?: AbilityType; limit?: number }): Promise<LeaderboardResult> {
    const url = new URL(`${this["indexUrl"]}/abilities/leaderboard`);
    if (opts?.type) url.searchParams.set("type", opts.type);
    if (opts?.limit) url.searchParams.set("limit", String(opts.limit));

    const resp = await fetch(url.toString(), {
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Leaderboard failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<LeaderboardResult>;
  }

  /**
   * Publish an ability (pattern, extension, technique, insight, or agent).
   */
  async publishAbility(payload: PublishAbilityPayload): Promise<{ id: string; slug: string; version: number; reviewStatus: string }> {
    const body = {
      abilityType: payload.type,
      service: payload.service,
      content: payload.content,
      creatorWallet: payload.creatorWallet,
      priceCents: payload.priceCents,
      // Stub fields for compatibility with existing schema
      baseUrl: "",
      authMethodType: "none",
      endpoints: [],
      skillMd: "",
      apiTemplate: "",
    };

    const resp = await fetch(`${this["indexUrl"]}/skills/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Publish failed (${resp.status}): ${text}`);
    }

    return resp.json() as any;
  }

  /**
   * Download an ability by ID (x402 payment required for non-free abilities).
   */
  async downloadAbility(id: string): Promise<AbilityPackage | SkillPackage> {
    // Uses the parent download method — server returns the right format
    return this.download(id);
  }

  /**
   * Search for patterns that match a specific error.
   */
  async searchPatterns(errorPattern: string): Promise<AbilitySummary[]> {
    const result = await this.searchAbilities(errorPattern, { type: "pattern", limit: 10 });
    return result.skills;
  }

  /**
   * Search for extensions by capability.
   */
  async searchExtensions(capability: string): Promise<AbilitySummary[]> {
    const result = await this.searchAbilities(capability, { type: "extension", limit: 10 });
    return result.skills;
  }

  /**
   * Search for techniques by language/topic.
   */
  async searchTechniques(topic: string): Promise<AbilitySummary[]> {
    const result = await this.searchAbilities(topic, { type: "technique", limit: 10 });
    return result.skills;
  }
}
