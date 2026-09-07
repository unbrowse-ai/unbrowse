/**
 * Shared fixture for the three "can this surface replay a LEARNED ROUTE?" gates
 * (tests/replay-surface-{skill,mcp,sdk}.test.ts).
 *
 * The product claim under test is "capture once, replay everywhere": a route
 * learned from real browsing is later executed as a DIRECT HTTP call instead of
 * re-driving a browser. A gate for that claim has to be able to distinguish
 * three outcomes that all look like "it worked" from the outside:
 *
 *   1. the learned route was replayed as a direct API call   <- the claim
 *   2. the surface fetched the URL the caller already handed it (direct-fetch /
 *      direct-document) and never consulted the route store  <- NOT the claim
 *   3. the surface drove a browser                           <- NOT the claim
 *
 * So the fixture origin serves TWO different paths:
 *
 *   GET /            -> a thin HTML page. This is the URL the caller passes as
 *                       context. Nothing structured lives here, and the direct
 *                       document reader rejects it as `too_small`, so a surface
 *                       that never reaches the route store cannot pass.
 *   GET /api/items   -> the JSON payload. This URL is ONLY discoverable from the
 *                       learned route, so observing a request for it is the
 *                       evidence that the route store was consulted and replayed.
 *
 * Every assertion is against what the origin actually observed plus the bytes
 * that came back — never against a `source:` label the surface reports about
 * itself.
 *
 * Hermetic by construction:
 *   - HOME is a fresh temp dir. Bun resolves `os.homedir()` once at process
 *     start, so a child process is the ONLY way to isolate the browser-profile
 *     readers in src/auth. Every surface driver here spawns.
 *   - UNBROWSE_LOCAL_ONLY=1 disables the marketplace round trip and live browser
 *     capture, so the ONLY route to the payload is the learned route.
 *   - UNBROWSE_UPDATE_COMMAND=true neutralises the self-update path in
 *     src/client/index.ts, which otherwise runs `curl … | bash` + `pkill -9`
 *     when the backend answers 426 (see the report accompanying these gates).
 *   - No third-party host is contacted and no real credential is used.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Marker string that only ever appears in the fixture origin's JSON payload. */
export const FIXTURE_MARKER = "FIXTURE_ROW_1";

/** Path only the learned route knows about. Never handed to any surface. */
export const LEARNED_PATH = "/api/items";

export interface FixtureOrigin {
  /** e.g. http://127.0.0.1:41234 */
  readonly origin: string;
  /** Every request the origin observed, as "GET /api/items". */
  readonly seen: string[];
  /** True once the origin served the learned route to a real HTTP request. */
  replayed(): boolean;
  stop(): void;
}

function rows(): unknown[] {
  // Big enough that the executor's "extraction_too_thin" guard accepts it as a
  // real payload rather than a page-metadata envelope.
  return Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    title: `FIXTURE_ROW_${i + 1}`,
    body: "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(3),
    author: `author-${i}`,
  }));
}

/** Start the two-path fixture site on an ephemeral loopback port. */
export function startFixtureOrigin(): FixtureOrigin {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(`${req.method} ${path}`);
      if (path === LEARNED_PATH) {
        return new Response(JSON.stringify({ items: rows() }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        "<html><head><title>Fixture site</title></head><body><h1>Fixture site</h1>" +
          "<p>The listing is rendered by a client-side call.</p></body></html>",
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    seen,
    replayed: () => seen.includes(`GET ${LEARNED_PATH}`),
    stop: () => server.stop(true),
  };
}

export interface HermeticHome {
  readonly home: string;
  readonly skillCacheDir: string;
  readonly snapshotDir: string;
}

/** A throwaway HOME with the two on-disk stores a learned route lives in. */
export function makeHermeticHome(tag: string): HermeticHome {
  const home = mkdtempSync(join(tmpdir(), `unbrowse-replay-${tag}-`));
  const skillCacheDir = join(home, ".unbrowse", "skill-cache");
  const snapshotDir = join(home, ".unbrowse", "skill-snapshots");
  mkdirSync(skillCacheDir, { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });
  return { home, skillCacheDir, snapshotDir };
}

/**
 * Write the learned route into BOTH on-disk stores a real capture leaves
 * behind: the skill-snapshot store the orchestrator's resolve ladder scans by
 * domain (`findBestLocalDomainSnapshot`) and the skill cache that
 * `/v1/skills/:id/execute` reads by id (`getRecentLocalSkill`).
 *
 * `owner_type: "agent"` is what a locally captured skill carries, and it is
 * load-bearing: `executeEndpoint` routes a MARKETPLACE-owned skill to the
 * remote backend instead of replaying it locally
 * (src/execution/index.ts:2987-2991).
 */
export function seedLearnedRoute(
  h: HermeticHome,
  origin: string,
  opts: { skillId: string; intent: string; endpointId?: string } ,
): { skillId: string; endpointId: string } {
  const endpointId = opts.endpointId ?? "list_items";
  const skill = {
    skill_id: opts.skillId,
    version: "1.0.0",
    schema_version: "1",
    name: "fixture site",
    intent_signature: opts.intent,
    domain: "127.0.0.1",
    description: "Learned route fixture — synthetic, no customer data.",
    owner_type: "agent",
    execution_type: "http",
    lifecycle: "active",
    score: 90,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    endpoints: [
      {
        endpoint_id: endpointId,
        method: "GET",
        url_template: `${origin}${LEARNED_PATH}`,
        trigger_url: `${origin}/`,
        description: opts.intent,
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 0.95,
      },
    ],
  };
  const json = JSON.stringify(skill);
  writeFileSync(join(h.snapshotDir, `${opts.skillId}.json`), json);
  writeFileSync(join(h.skillCacheDir, `${opts.skillId}.json`), json);
  return { skillId: opts.skillId, endpointId };
}

/**
 * Environment for a spawned surface. HOME must be set at SPAWN time: Bun
 * resolves `os.homedir()` once per process, so mutating process.env.HOME inside
 * a test does not move the browser-profile readers off the real machine.
 */
export function hermeticEnv(h: HermeticHome, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: h.home,
    UNBROWSE_SKILL_CACHE_DIR: h.skillCacheDir,
    UNBROWSE_SKILL_SNAPSHOT_DIR: h.snapshotDir,
    // No marketplace, no live browser capture: the learned route is the only path.
    UNBROWSE_LOCAL_ONLY: "1",
    // Neutralise the 426 self-update (`curl … | bash` + `pkill -9`).
    UNBROWSE_UPDATE_COMMAND: "true",
    UNBROWSE_NON_INTERACTIVE: "1",
    UNBROWSE_SKIP_TOS_CHECK: "1",
    UNBROWSE_SKIP_REHYDRATE: "1",
    UNBROWSE_SKIP_DAEMON_PROBE: "1",
    UNBROWSE_IMPORT_BROWSER_COOKIES: "0",
    // The fixture origin is loopback; the executor's SSRF guard exists for
    // production and has this documented test escape hatch.
    UNBROWSE_ALLOW_PRIVATE_IPS: "1",
    UNBROWSE_INLINE_INDEX: "1",
    UNBROWSE_NO_SWEEP: "1",
    ...extra,
  };
  // UNBROWSE_URL would redirect the CLI's api() at a foreign server.
  delete env.UNBROWSE_URL;
  return env;
}

export const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Spawn a surface, collect its output, never block the fixture origin's loop. */
export async function runSurface(
  argv: string[],
  env: Record<string, string>,
  timeoutMs = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(argv, { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(9), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
