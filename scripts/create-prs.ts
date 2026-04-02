/**
 * Create GitHub PRs for the 5 fix branches using the GitHub API.
 * Reads the GH_TOKEN from the gh CLI config or environment.
 */
import { execFileSync, execSync } from "child_process";

// Get token from gh CLI keyring
function getToken(): string {
  try {
    // Try env first
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
    // Try gh CLI
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    return out;
  } catch {
    throw new Error("No GitHub token found. Set GH_TOKEN or GITHUB_TOKEN env var.");
  }
}

async function createPR(token: string, opts: {
  head: string;
  title: string;
  body: string;
}): Promise<string> {
  const response = await fetch("https://api.github.com/repos/unbrowse-ai/unbrowse-dev/pulls", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title: opts.title,
      head: opts.head,
      base: "rach/restart-base",
      body: opts.body,
    }),
  });

  const data = await response.json() as any;
  if (!response.ok) {
    // Check if PR already exists
    if (data.errors?.some((e: any) => e.message?.includes("already exists"))) {
      console.log(`PR for ${opts.head} already exists, fetching URL...`);
      const listResp = await fetch(
        `https://api.github.com/repos/unbrowse-ai/unbrowse-dev/pulls?head=unbrowse-ai:${opts.head}&state=open`,
        { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github.v3+json" } }
      );
      const list = await listResp.json() as any[];
      if (list.length > 0) return list[0].html_url;
    }
    throw new Error(`Failed to create PR for ${opts.head}: ${JSON.stringify(data)}`);
  }

  return data.html_url;
}

const token = getToken();

const prs = [
  {
    head: "fix/99-cache-stats",
    title: "feat(#99): add cache hit/miss statistics for skill caching layer",
    body: `## Summary

- Adds \`src/cache-stats.ts\` with \`recordHit\`, \`recordMiss\`, \`recordEviction\`, \`getCacheStats\`, and \`resetCacheStats\` exports
- Tracks per-cache-name hit/miss/eviction counters with computed \`hitRate\`
- Adds \`tests/cache-stats.test.ts\` covering all counter operations and multi-cache isolation

## Test plan

- [x] \`bun test tests/cache-stats.test.ts\` — 6 tests pass

🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  },
  {
    head: "fix/101-schema-drift-deprecation",
    title: "feat(#101): mark critical drift as failed and include pending in scheduler",
    body: `## Summary

- Changes \`verifyEndpoint\` to set status \`"failed"\` (not \`"pending"\`) when critical schema drift is detected (removed/changed fields)
- Updates \`schedulePeriodicVerification\` to include \`isPending\` endpoints in the re-verification scheduler
- Adds \`tests/schema-drift-deprecation.test.ts\` covering drift detection, status mapping, and scheduler logic

## Test plan

- [x] \`bun test tests/schema-drift-deprecation.test.ts\` — all tests pass

🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  },
  {
    head: "fix/103-composite-search-scoring",
    title: "feat(#103): add composite search scoring combining vector, reliability, freshness, verification",
    body: `## Summary

- Adds \`backend/src/services/search.ts\` with \`computeCompositeSearchScore\` combining vector similarity (0.4), reliability (0.3), freshness (0.15), and verification status (0.15)
- Freshness decays with a 30-day half-life; verification maps verified→1.0, failed/disabled→0.0, other→0.5
- Adds \`backend/tests/composite-scoring.test.ts\` with 8 tests covering weight normalization, score clamping, and ranking properties

## Test plan

- [x] \`bun test backend/tests/composite-scoring.test.ts\` — 8 tests pass

🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  },
  {
    head: "fix/87-unsafe-action-scoring",
    title: "feat(#87): add unsafe action score gate to auto-execution",
    body: `## Summary

- Adds \`src/router.ts\` with \`computeUnsafeActionScore\` and \`UNSAFE_ACTION_BLOCK_THRESHOLD = 0.6\`
- Score factors: unsafe idempotency (+0.4), mutating method (+0.2), bundle-inferred (+0.2), no response schema (+0.1), failed verification (+0.1), low reliability (+0.1); reduced by trigger_url (-0.1) and verified status (-0.15)
- Updates \`src/orchestrator/index.ts\` \`canAutoExecuteEndpoint\` to block endpoints with score >= 0.6 unless \`options.confirm_unsafe\` is set
- Adds \`tests/unsafe-action-score.test.ts\` with 6 tests covering score thresholds, clamping, and bypass logic

## Test plan

- [x] \`bun test tests/unsafe-action-score.test.ts\` — 6 tests pass

🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  },
  {
    head: "fix/120-capture-prefetch",
    title: "feat(#120): add dependency prefetch for capture phase",
    body: `## Summary

- Adds \`src/capture/prefetch.ts\` with \`getRelatedOps\` that finds GET endpoints from a skill's \`operation_graph\` providing bindings needed by already-captured endpoints
- Skips POST/non-GET endpoints and already-captured paths; respects \`PREFETCH_MAX = 3\` limit
- Adds \`tests/capture-dependency-prefetch.test.ts\` covering related-op discovery, POST skipping, deduplication, empty graph, and PREFETCH_MAX

## Test plan

- [x] \`bun test tests/capture-dependency-prefetch.test.ts\` — 5 tests pass

🤖 Generated with [Claude Code](https://claude.com/claude-code)`,
  },
];

for (const pr of prs) {
  try {
    const url = await createPR(token, pr);
    console.log(`PR created: ${url}`);
  } catch (e: any) {
    console.error(`Failed for ${pr.head}: ${e.message}`);
  }
}
