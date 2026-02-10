/**
 * Capability Resolver — Determine how to achieve a task.
 *
 * Given a parsed intent, this figures out the best strategy:
 * 1. Use existing skill
 * 2. Capture the API
 * 3. Use desktop automation
 * 4. Fall back to browser agent
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { TaskIntent } from "./task-watcher.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ResolutionStrategy = "skill" | "capture" | "desktop" | "browser_agent";

export interface Resolution {
  strategy: ResolutionStrategy;
  confidence: number;
  skill?: SkillInfo;
  domain?: string;
  app?: string;
  reason: string;
}

export interface SkillInfo {
  name: string;
  path: string;
  endpoints: string[];
  hasAuth: boolean;
}

// ── Desktop app mappings ─────────────────────────────────────────────────────

const DESKTOP_APPS: Record<string, string[]> = {
  notes: ["Notes", "Apple Notes"],
  reminders: ["Reminders"],
  calendar: ["Calendar"],
  mail: ["Mail"],
  messages: ["Messages", "iMessage"],
  safari: ["Safari"],
  chrome: ["Google Chrome"],
  finder: ["Finder"],
  music: ["Music", "iTunes"],
  photos: ["Photos"],
  contacts: ["Contacts"],
  terminal: ["Terminal", "iTerm"],
  vscode: ["Visual Studio Code", "Code"],
  slack: ["Slack"],
  discord: ["Discord"],
  spotify: ["Spotify"],
  figma: ["Figma"],
  notion: ["Notion"],
  linear: ["Linear"],
};

// Domains where desktop app might be preferred
const DESKTOP_PREFERRED: string[] = ["notes", "reminders", "calendar", "mail", "finder", "photos"];

// ── Capability Resolver ──────────────────────────────────────────────────────

export class CapabilityResolver {
  private skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir || join(homedir(), ".openclaw", "skills");
  }

  /**
   * Resolve the best strategy for an intent.
   */
  async resolve(intent: TaskIntent): Promise<Resolution> {
    // 1. Check existing skills first (highest confidence)
    const skill = await this.findSkill(intent.domain);
    if (skill) {
      return {
        strategy: "skill",
        confidence: 0.9,
        skill,
        reason: `Found existing skill: ${skill.name}`,
      };
    }

    // 2. Check if desktop automation is preferred for this domain
    if (intent.domain && DESKTOP_PREFERRED.includes(intent.domain)) {
      const app = this.findDesktopApp(intent.domain);
      if (app) {
        return {
          strategy: "desktop",
          confidence: 0.8,
          app,
          reason: `Desktop app available: ${app}`,
        };
      }
    }

    // 3. Check if we can capture the API (domain identified)
    if (intent.domain) {
      const canCapture = await this.canCaptureApi(intent.domain);
      if (canCapture) {
        return {
          strategy: "capture",
          confidence: 0.7,
          domain: intent.domain,
          reason: `Can capture API for: ${intent.domain}`,
        };
      }
    }

    // 4. Check if desktop app exists (for non-preferred domains)
    if (intent.domain) {
      const app = this.findDesktopApp(intent.domain);
      if (app) {
        return {
          strategy: "desktop",
          confidence: 0.6,
          app,
          reason: `Desktop app fallback: ${app}`,
        };
      }
    }

    // 5. Fall back to browser agent
    return {
      strategy: "browser_agent",
      confidence: 0.5,
      domain: intent.domain || undefined,
      reason: "Using autonomous browser agent",
    };
  }

  /**
   * Find an existing skill for a domain.
   */
  async findSkill(domain: string | null): Promise<SkillInfo | null> {
    if (!domain || !existsSync(this.skillsDir)) return null;

    try {
      const entries = readdirSync(this.skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        // Check if directory name matches domain
        const nameMatch =
          entry.name.toLowerCase().includes(domain.toLowerCase()) ||
          domain.toLowerCase().includes(entry.name.toLowerCase());

        if (!nameMatch) continue;

        const skillDir = join(this.skillsDir, entry.name);
        const skillMd = join(skillDir, "SKILL.md");
        const authJson = join(skillDir, "auth.json");

        if (existsSync(skillMd)) {
          const content = readFileSync(skillMd, "utf-8");
          const endpoints = this.extractEndpoints(content);

          return {
            name: entry.name,
            path: skillDir,
            endpoints,
            hasAuth: existsSync(authJson),
          };
        }
      }
    } catch (err) {
      // Skills dir might not exist yet
    }

    return null;
  }

  /**
   * Extract endpoints from SKILL.md content.
   */
  private extractEndpoints(content: string): string[] {
    const endpoints: string[] = [];
    const regex = /^- `(GET|POST|PUT|DELETE|PATCH)\s+([^`]+)`/gm;
    let match;

    while ((match = regex.exec(content)) !== null) {
      endpoints.push(`${match[1]} ${match[2]}`);
    }

    return endpoints;
  }

  /**
   * Check if we can capture the API for a domain.
   */
  async canCaptureApi(domain: string): Promise<boolean> {
    // We can always attempt to capture
    // Could be smarter: check if domain is known to have API
    const knownApiDomains = [
      "twitter",
      "x",
      "linear",
      "github",
      "slack",
      "notion",
      "discord",
      "spotify",
      "youtube",
      "reddit",
      "stripe",
      "shopify",
      "airtable",
      "figma",
      "trello",
      "asana",
      "jira",
      "confluence",
      "intercom",
      "zendesk",
      "hubspot",
      "salesforce",
    ];

    return knownApiDomains.some(
      (d) => d.includes(domain.toLowerCase()) || domain.toLowerCase().includes(d),
    );
  }

  /**
   * Find desktop app for a domain.
   */
  findDesktopApp(domain: string): string | null {
    const lowerDomain = domain.toLowerCase();

    for (const [key, apps] of Object.entries(DESKTOP_APPS)) {
      if (key.includes(lowerDomain) || lowerDomain.includes(key)) {
        return apps[0]; // Return primary app name
      }
    }

    return null;
  }

  /**
   * List all available skills.
   */
  listSkills(): SkillInfo[] {
    const skills: SkillInfo[] = [];

    if (!existsSync(this.skillsDir)) return skills;

    try {
      const entries = readdirSync(this.skillsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = join(this.skillsDir, entry.name);
        const skillMd = join(skillDir, "SKILL.md");
        const authJson = join(skillDir, "auth.json");

        if (existsSync(skillMd)) {
          const content = readFileSync(skillMd, "utf-8");
          skills.push({
            name: entry.name,
            path: skillDir,
            endpoints: this.extractEndpoints(content),
            hasAuth: existsSync(authJson),
          });
        }
      }
    } catch (err) {
      // Ignore errors
    }

    return skills;
  }

  /**
   * Get resolution recommendation as context for agent.
   */
  getRecommendation(resolution: Resolution): string {
    switch (resolution.strategy) {
      case "skill":
        return `Use the existing **${resolution.skill!.name}** skill. ` +
          `Available endpoints: ${resolution.skill!.endpoints.slice(0, 3).join(", ")}` +
          (resolution.skill!.endpoints.length > 3 ? "..." : "");

      case "capture":
        return `Capture the ${resolution.domain} API using \`unbrowse_capture\`. ` +
          `This will record API calls and generate a reusable skill.`;

      case "desktop":
        return `Use desktop automation with \`unbrowse_desktop\` to control ${resolution.app}. ` +
          `This uses AppleScript to interact with the macOS app directly.`;

      case "browser_agent":
        return `Use autonomous browser agent with \`unbrowse_agent\` or \`unbrowse_browse\`. ` +
          `This will navigate and interact with web pages programmatically.`;
    }
  }
}

export const capabilityResolver = new CapabilityResolver();
