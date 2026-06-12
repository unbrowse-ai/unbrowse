/**
 * Marketplace contribution config (opt-out + review-gated).
 *
 * Lives at `~/.unbrowse/config.json`. Default is public-after-review
 * (`share_pointers: true`) — skills the calling agent reviews via
 * `unbrowse_review` publish to the marketplace and earn x402 rewards on
 * execution. Captures that are NEVER reviewed never reach the marketplace
 * (the review-gate, enforced in `processIndexJob`). Users opt out of
 * sharing entirely via `unbrowse mode private` or
 * `unbrowse_settings share_pointers=false` — that keeps every capture
 * local and forfeits rewards.
 *
 * Sensitive-domain captures (banking, healthcare, draft URLs) are
 * protected by two layers: (1) the review-gate — the agent decides
 * whether to review a captured skill, and (2) `publish_domain_blacklist`
 * / `publish_domain_promptlist` in capture-pipeline settings, which
 * block matching domains even after review.
 *
 * Existing users (config file exists but no `contribution` block) inherit
 * the new default and see a stderr notice for the next 5 invocations
 * explaining the opt-out command (counter decrements via
 * `decrementNoticeCounter`).
 *
 * Read-cached for the process lifetime. Tests reset via
 * `_clearContributionCacheForTests`. Path overridable via
 * `UNBROWSE_CONFIG_PATH` env var (used by tests for filesystem isolation).
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function configPath(): string {
  return process.env.UNBROWSE_CONFIG_PATH || path.join(os.homedir(), ".unbrowse", "config.json");
}

export interface ContributionConfig {
  contribution: {
    share_pointers: boolean;
    /**
     * When true, captures publish on close/sync without an explicit
     * `unbrowse_review` call — and WITHOUT a `reviewed_at` stamp, which is
     * reserved for actual reviews. Heuristic + LLM-augmented endpoint
     * descriptions are accepted as-is. Default true: optimizes for
     * marketplace flywheel volume. Flip false to force the agent to review
     * each skill before publish.
     */
    auto_review: boolean;
    /**
     * When true (the default — opt-out), the capture → reverse-engineer →
     * index → publish pipeline runs in the background, in parallel with
     * browsing: `sync` checkpoints return immediately instead of blocking on
     * the late-XHR content-ready wait, so browsing stays fast while indexing
     * happens passively. Flip false to run the pipeline inline (each sync
     * blocks until the page's endpoints are fully reverse-engineered).
     */
    passive_index: boolean;
    set_at?: string;
    set_via?: "setup-prompt" | "mode-command" | "default";
  };
  rev_share: {
    opted_in: boolean;
    wallet_address?: string;
  };
  notice_shown_count?: number;
}

const DEFAULT: ContributionConfig = {
  // You are opted in by default: skills publish publicly to the marketplace.
  // auto_review=true means captures publish on close/sync without an
  // explicit `unbrowse_review` call (and without a reviewed_at stamp —
  // that field records an actual review). To require the
  // agent to review each skill before publish, set auto_review=false. To
  // disable publish entirely (keep all captures local), call
  // `unbrowse_settings share_pointers=false` or run `unbrowse mode private`.
  contribution: { share_pointers: true, auto_review: true, passive_index: true, set_via: "default" },
  rev_share: { opted_in: false },
  notice_shown_count: 0,
};

function freshDefault(): ContributionConfig {
  return {
    contribution: { ...DEFAULT.contribution },
    rev_share: { ...DEFAULT.rev_share },
    notice_shown_count: 0,
  };
}

let cached: ContributionConfig | null = null;

/**
 * Read the contribution config. Returns DEFAULT (private) on missing/malformed
 * config or missing `contribution` block. Result is process-cached; call
 * `_clearContributionCacheForTests` to bust between test cases.
 *
 * Existing-user migration: when the config file exists with non-empty content
 * but lacks a `contribution` block, we treat that as an upgrade. The next 5
 * invocations get a stderr notice (counter = 5). Brand-new users (no config
 * file at all) skip the notice — they'll be prompted by `unbrowse setup`.
 */
export function getContributionConfig(): ContributionConfig {
  if (cached) return cached;
  const p = configPath();
  let fileExisted = false;
  let raw: Record<string, unknown> | null = null;
  try {
    const content = fs.readFileSync(p, "utf-8");
    fileExisted = true;
    if (content.trim().length > 0) {
      raw = JSON.parse(content) as Record<string, unknown>;
    }
  } catch {
    // missing or unreadable — treat as fresh install
  }

  if (!raw) {
    cached = freshDefault();
    return cached;
  }

  const contributionRaw = (raw.contribution as Record<string, unknown> | undefined) ?? null;
  const revShareRaw = (raw.rev_share as Record<string, unknown> | undefined) ?? null;
  const isExistingUserMigration = fileExisted && !contributionRaw;

  cached = {
    contribution: {
      share_pointers: !!(contributionRaw?.share_pointers ?? DEFAULT.contribution.share_pointers),
      auto_review:
        contributionRaw?.auto_review === undefined
          ? DEFAULT.contribution.auto_review
          : !!contributionRaw.auto_review,
      passive_index:
        contributionRaw?.passive_index === undefined
          ? DEFAULT.contribution.passive_index
          : !!contributionRaw.passive_index,
      set_via: (contributionRaw?.set_via as ContributionConfig["contribution"]["set_via"]) ?? DEFAULT.contribution.set_via,
      ...(contributionRaw?.set_at ? { set_at: String(contributionRaw.set_at) } : {}),
    },
    rev_share: {
      opted_in: !!(revShareRaw?.opted_in ?? DEFAULT.rev_share.opted_in),
      ...(revShareRaw?.wallet_address ? { wallet_address: String(revShareRaw.wallet_address) } : {}),
    },
    notice_shown_count:
      typeof raw.notice_shown_count === "number"
        ? raw.notice_shown_count
        : (isExistingUserMigration ? 5 : 0),
  };

  // Persist the migration so the counter survives process restarts.
  if (isExistingUserMigration) {
    try {
      const merged = { ...raw, ...cached };
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(merged, null, 2));
    } catch {
      // best-effort — if we can't write, the next invocation will re-trigger
      // migration (still 5 notices), which is acceptable.
    }
  }

  return cached;
}

/**
 * Update the contribution config (merge-style). Stamps `set_at` to now. Bumps
 * the cache so subsequent reads see the new value without disk re-read.
 *
 * Both nested objects accept partials — callers may pass
 * `{ contribution: { share_pointers: false } }` without naming every other
 * field. Missing fields fall back to the current (or default) value.
 */
export interface ContributionConfigUpdate {
  contribution?: Partial<ContributionConfig["contribution"]>;
  rev_share?: Partial<ContributionConfig["rev_share"]>;
  notice_shown_count?: number;
}

export function setContributionConfig(updates: ContributionConfigUpdate): void {
  const current = getContributionConfig();
  const next: ContributionConfig = {
    contribution: {
      ...current.contribution,
      ...(updates.contribution ?? {}),
      set_at: new Date().toISOString(),
    },
    rev_share: {
      ...current.rev_share,
      ...(updates.rev_share ?? {}),
    },
    notice_shown_count: updates.notice_shown_count ?? current.notice_shown_count ?? 0,
  };
  const p = configPath();
  // Preserve any unrelated keys that may already exist in the on-disk config.
  let existing: Record<string, unknown> = {};
  try {
    const content = fs.readFileSync(p, "utf-8");
    if (content.trim()) existing = JSON.parse(content) as Record<string, unknown>;
  } catch { /* fresh write */ }
  const merged = { ...existing, ...next };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(merged, null, 2));
  cached = next;
}

/**
 * Decrement the existing-user notice counter (clamped at 0). Returns the new
 * count. Called by the CLI right after printing the notice.
 */
export function decrementNoticeCounter(): number {
  const cfg = getContributionConfig();
  const next = Math.max(0, (cfg.notice_shown_count ?? 0) - 1);
  setContributionConfig({ notice_shown_count: next });
  return next;
}

/** Test-only: clear the in-process cache. */
export function _clearContributionCacheForTests(): void {
  cached = null;
}
