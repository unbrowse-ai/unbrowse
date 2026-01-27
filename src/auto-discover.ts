/**
 * Auto-Discovery — Watches browser tool usage and generates skills on the fly.
 *
 * Hooks into `after_tool_call` on the browser tool. Each time the agent uses
 * the browser, we silently poll captured network requests. When we detect
 * enough API calls (5+) to a new domain, we auto-generate a skill without
 * the agent having to explicitly call unbrowse_learn.
 *
 * This is the "self-figuring-out" layer — the agent browses, and skills
 * materialize automatically in ~/.clawdbot/skills/.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { parseHar } from "./har-parser.js";
import { generateSkill } from "./skill-generator.js";
import { captureFromBrowser } from "./cdp-capture.js";
import type { ParsedRequest } from "./types.js";

/** Minimum API calls to a domain before auto-generating a skill. */
const MIN_REQUESTS_FOR_SKILL = 5;

/** Cooldown between discovery attempts (ms) — don't spam on every browser call. */
const DISCOVERY_COOLDOWN_MS = 30_000;

/**
 * Manages auto-discovery state and logic.
 *
 * Tracks which domains have already been learned, when the last
 * discovery attempt was, and what requests we've already seen.
 */
export class AutoDiscovery {
  /** Domains we've already generated skills for (don't regenerate). */
  private learnedDomains = new Set<string>();

  /** Timestamp of last discovery attempt. */
  private lastAttemptAt = 0;

  /** Request URLs we've already processed (dedup). */
  private seenUrls = new Set<string>();

  /** Output directory for skills. */
  private outputDir: string;

  /** Browser control port. */
  private port: number;

  /** Logger from plugin API. */
  private logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };

  constructor(opts: {
    outputDir?: string;
    port?: number;
    logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  }) {
    this.outputDir = opts.outputDir ?? join(homedir(), ".clawdbot", "skills");
    this.port = opts.port ?? 18791;
    this.logger = opts.logger;

    // Pre-populate learned domains from existing skills
    this.loadExistingSkills();
  }

  /** Scan existing skills directory to avoid regenerating. */
  private loadExistingSkills(): void {
    try {
      if (existsSync(this.outputDir)) {
        const entries = readdirSync(this.outputDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory() && existsSync(join(this.outputDir, entry.name, "SKILL.md"))) {
            this.learnedDomains.add(entry.name);
          }
        }
        if (this.learnedDomains.size > 0) {
          this.logger.info(`[unbrowse] Auto-discover: ${this.learnedDomains.size} existing skills loaded`);
        }
      }
    } catch {
      // Skills dir doesn't exist yet — that's fine
    }
  }

  /**
   * Called after each browser tool call. Checks for new API domains
   * and auto-generates skills when threshold is met.
   *
   * Returns skill names that were auto-generated (if any).
   */
  async onBrowserToolCall(): Promise<string[]> {
    const now = Date.now();
    if (now - this.lastAttemptAt < DISCOVERY_COOLDOWN_MS) {
      return []; // Cooldown — too recent
    }
    this.lastAttemptAt = now;

    try {
      const { har, cookies } = await captureFromBrowser(this.port);

      // Count API calls per domain (only new ones we haven't seen)
      const domainCounts: Record<string, ParsedRequest[]> = {};
      const apiData = parseHar(har);

      for (const req of apiData.requests) {
        if (this.seenUrls.has(req.url)) continue;
        this.seenUrls.add(req.url);

        const serviceName = this.domainToService(req.domain);
        if (this.learnedDomains.has(serviceName)) continue;

        if (!domainCounts[serviceName]) domainCounts[serviceName] = [];
        domainCounts[serviceName].push(req);
      }

      // Check which domains crossed the threshold
      const generated: string[] = [];

      for (const [serviceName, requests] of Object.entries(domainCounts)) {
        if (requests.length >= MIN_REQUESTS_FOR_SKILL) {
          this.logger.info(
            `[unbrowse] Auto-discover: ${serviceName} has ${requests.length} API calls — generating skill`,
          );

          try {
            // Re-parse with full data for this domain
            const result = await generateSkill(apiData, this.outputDir);
            this.learnedDomains.add(result.service);
            generated.push(result.service);

            this.logger.info(
              `[unbrowse] Auto-discover: skill "${result.service}" generated (${result.endpointCount} endpoints)`,
            );
          } catch (err) {
            this.logger.error(`[unbrowse] Auto-discover failed for ${serviceName}:`, err);
          }
        }
      }

      return generated;
    } catch {
      // Browser not running or no requests — silently ignore
      return [];
    }
  }

  /** Convert domain to service name (same logic as har-parser). */
  private domainToService(domain: string): string {
    return domain
      .replace(/^(www|api|v\d+|.*serv)\./, "")
      .replace(/\.(com|org|net|co|io|ai|app|sg|dev|xyz)\.?$/g, "")
      .replace(/\./g, "-")
      .toLowerCase() || "unknown-api";
  }

  /** Manually mark a domain as learned (prevent auto-generation). */
  markLearned(serviceName: string): void {
    this.learnedDomains.add(serviceName);
  }

  /** Get list of all learned domains. */
  getLearnedDomains(): string[] {
    return [...this.learnedDomains];
  }
}
