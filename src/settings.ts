import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getRegistrableDomain } from "./domain.js";

type RawConfig = Record<string, unknown>;

export interface CapturePipelineSettings {
  auto_publish_checkpoints: boolean;
  publish_domain_blacklist: string[];
  publish_domain_promptlist: string[];
}

export interface CheckpointPublishDecision {
  publishQueued: boolean;
  mode: "auto" | "disabled" | "blacklisted" | "prompt";
  reason: string;
  matchedDomain?: string;
}

export interface ExplicitPublishDecision {
  allowed: boolean;
  mode: "allowed" | "blacklisted" | "prompt";
  reason: string;
  matchedDomain?: string;
}

const DEFAULT_CAPTURE_PIPELINE_SETTINGS: CapturePipelineSettings = {
  auto_publish_checkpoints: true,
  publish_domain_blacklist: [],
  publish_domain_promptlist: [],
};

function sanitizeProfileName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function getConfigDir(): string {
  if (process.env.UNBROWSE_CONFIG_DIR) return process.env.UNBROWSE_CONFIG_DIR;
  const profile = sanitizeProfileName(process.env.UNBROWSE_PROFILE ?? "");
  return profile
    ? join(homedir(), ".unbrowse", "profiles", profile)
    : join(homedir(), ".unbrowse");
}

export function getUnbrowseConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

function loadRawConfig(): RawConfig {
  try {
    const configPath = getUnbrowseConfigPath();
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
      if (parsed && typeof parsed === "object") return parsed as RawConfig;
    }
  } catch {
    // ignore broken local config and fall back to defaults
  }
  return {};
}

function saveRawConfig(config: RawConfig): void {
  const configDir = getConfigDir();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  writeFileSync(getUnbrowseConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function normalizeDomainRule(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (!normalized) return "";
  normalized = normalized.replace(/^\*\./, "");
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    try {
      normalized = new URL(normalized).hostname.toLowerCase();
    } catch {
      normalized = normalized.replace(/^https?:\/\//, "");
    }
  }
  normalized = normalized.split("/")[0] ?? normalized;
  normalized = normalized.replace(/:\d+$/, "");
  normalized = normalized.replace(/^www\./, "");
  return normalized;
}

function normalizeDomainList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const normalized = values
    .filter((value): value is string => typeof value === "string")
    .map(normalizeDomainRule)
    .filter(Boolean);
  return Array.from(new Set(normalized)).sort();
}

function matchesDomainRule(domain: string, rule: string): boolean {
  const host = normalizeDomainRule(domain);
  const target = normalizeDomainRule(rule);
  if (!host || !target) return false;
  if (host === target || host.endsWith(`.${target}`)) return true;
  try {
    return getRegistrableDomain(host) === target;
  } catch {
    return false;
  }
}

function firstMatchingRule(domain: string, rules: string[]): string | undefined {
  return rules.find((rule) => matchesDomainRule(domain, rule));
}

export function getCapturePipelineSettings(): CapturePipelineSettings {
  const raw = loadRawConfig();
  const capturePipeline = raw.capture_pipeline && typeof raw.capture_pipeline === "object"
    ? raw.capture_pipeline as Record<string, unknown>
    : {};

  return {
    auto_publish_checkpoints: capturePipeline.auto_publish_checkpoints !== false,
    publish_domain_blacklist: normalizeDomainList(capturePipeline.publish_domain_blacklist),
    publish_domain_promptlist: normalizeDomainList(capturePipeline.publish_domain_promptlist),
  };
}

export function updateCapturePipelineSettings(update: {
  auto_publish_checkpoints?: boolean;
  publish_domain_blacklist?: string[];
  publish_domain_promptlist?: string[];
  clear_publish_domain_blacklist?: boolean;
  clear_publish_domain_promptlist?: boolean;
}): CapturePipelineSettings {
  const raw = loadRawConfig();
  const existing = getCapturePipelineSettings();
  const next: CapturePipelineSettings = {
    auto_publish_checkpoints: typeof update.auto_publish_checkpoints === "boolean"
      ? update.auto_publish_checkpoints
      : existing.auto_publish_checkpoints,
    publish_domain_blacklist: update.clear_publish_domain_blacklist
      ? []
      : update.publish_domain_blacklist
        ? normalizeDomainList(update.publish_domain_blacklist)
        : existing.publish_domain_blacklist,
    publish_domain_promptlist: update.clear_publish_domain_promptlist
      ? []
      : update.publish_domain_promptlist
        ? normalizeDomainList(update.publish_domain_promptlist)
        : existing.publish_domain_promptlist,
  };

  saveRawConfig({
    ...raw,
    capture_pipeline: next,
  });

  return next;
}

// --- Browser attach opt-out (persisted) ---------------------------------
// Attach to a user-running Chrome (CDP on :9222) when one is found,
// instead of launching a managed clean Chrome. Pre-2026-05-18 this was
// default-ON ("North Star: catch every tab agents open through one
// pipeline"). Flipped to default-OFF after the bench-gate diagnosis
// showed kuri silently coupling to the user's visible browser whenever
// they had Chrome open with CDP — bypassing HEADLESS=true entirely
// (headless governs managed Chrome, not attached Chrome) and leaking
// gate-run state into the user's real browsing session.
//
// PERSISTED user setting (config.json browser.attach_existing_chrome),
// surfaced via unbrowse_settings. Default false (clean managed Chrome).
// Only an explicit true opts in. The env knob KURI_DISABLE_CDP_ATTACH
// (and KURI_CLEAN_ROOM / UNBROWSE_LOCAL_ONLY) still work as per-process
// overrides that win over the setting.
export function getBrowserAttachEnabled(): boolean {
  const raw = loadRawConfig();
  const browser = raw.browser && typeof raw.browser === "object"
    ? raw.browser as Record<string, unknown>
    : {};
  return browser.attach_existing_chrome === true;
}

export function setBrowserAttachEnabled(enabled: boolean): boolean {
  const raw = loadRawConfig();
  const browser = raw.browser && typeof raw.browser === "object"
    ? { ...(raw.browser as Record<string, unknown>) }
    : {};
  browser.attach_existing_chrome = enabled;
  saveRawConfig({ ...raw, browser });
  return enabled;
}

export function decideCheckpointPublish(domain: string): CheckpointPublishDecision {
  const settings = getCapturePipelineSettings();
  if (!settings.auto_publish_checkpoints) {
    return {
      publishQueued: false,
      mode: "disabled",
      reason: "Auto-publish after sync/close is disabled in local settings.",
    };
  }

  const blacklisted = firstMatchingRule(domain, settings.publish_domain_blacklist);
  if (blacklisted) {
    return {
      publishQueued: false,
      mode: "blacklisted",
      reason: `Auto-publish skipped because ${domain} matches blacklist entry ${blacklisted}.`,
      matchedDomain: blacklisted,
    };
  }

  const prompted = firstMatchingRule(domain, settings.publish_domain_promptlist);
  if (prompted) {
    return {
      publishQueued: false,
      mode: "prompt",
      reason: `Auto-publish paused because ${domain} matches prompt-list entry ${prompted}.`,
      matchedDomain: prompted,
    };
  }

  return {
    publishQueued: true,
    mode: "auto",
    reason: "Background publish is allowed for this checkpoint.",
  };
}

export function decideExplicitPublish(domain: string, confirmPublish: boolean): ExplicitPublishDecision {
  const settings = getCapturePipelineSettings();
  const blacklisted = firstMatchingRule(domain, settings.publish_domain_blacklist);
  if (blacklisted && !confirmPublish) {
    return {
      allowed: false,
      mode: "blacklisted",
      reason: `Explicit publish requires confirmation because ${domain} matches blacklist entry ${blacklisted}.`,
      matchedDomain: blacklisted,
    };
  }

  const prompted = firstMatchingRule(domain, settings.publish_domain_promptlist);
  if (prompted && !confirmPublish) {
    return {
      allowed: false,
      mode: "prompt",
      reason: `Explicit publish requires confirmation because ${domain} matches prompt-list entry ${prompted}.`,
      matchedDomain: prompted,
    };
  }

  return {
    allowed: true,
    mode: "allowed",
    reason: "Explicit publish allowed.",
  };
}
