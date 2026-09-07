/**
 * Gate: the TWO-CALL PATH packages/skill/SKILL.md documents actually runs.
 *
 *   1. `unbrowse resolve --intent "…" --url "<site>"`   -> ranked shortlist
 *   2. `unbrowse execute --skill <id> --endpoint <id> [-p k=v]`  -> replays it
 *
 * Four defects made that path undrivable, and each has its own test below:
 *
 *   D1  `resolve --url` gated the local route store on `--domain` alone, so a
 *       route this machine had captured was resolvable by `--domain` and
 *       INVISIBLE by `--url` — the spelling the docs actually tell you to use.
 *   D2  `execute --skill X --endpoint Y` could not reach the handler at all:
 *       both are value-flags in the v7 parser, and the handler read
 *       `positional[0]`, so the documented invocation always died
 *       `missing_positional` with `got: []`.
 *   D3  `--no-execute` was documented and unread. `resolve` never executes
 *       anything, so the flag disabled nothing; the claim was deleted from
 *       SKILL.md rather than faked, and this file pins the deletion.
 *   D4  `-p key=value` was documented and unread: `-p` became a bare boolean
 *       and `key=value` fell into the positional list, where nothing read it
 *       AND it shadowed the endpoint id.
 *
 * Plus D5: `--dry-run` was documented as the thing you do BEFORE a mutation
 * and fired the real request.
 *
 * ── Vacuity discipline (the point of this file) ──────────────────────────
 * "resolve exited 0" passes when resolve did nothing. So every assertion is
 * anchored to something that cannot be true unless the code ran:
 *
 *   - a PRECONDITION probe asserts the fixture route is in the route store at
 *     all (resolve by `--domain`, the spelling that already worked). If that
 *     probe is red, the store is empty and every later "found it" is
 *     meaningless — so it is asserted first, in the same file, per test.
 *   - the fixture ORIGIN records every request it serves. "The route was
 *     replayed" means the origin observed `GET /api/items`, never a `source:`
 *     label the CLI printed about itself.
 *   - the payload marker `TWO_CALL_ROW_1` lives ONLY in the JSON the learned
 *     path returns. `/` serves HTML without it, so a run that fetched the
 *     context URL instead of the learned route cannot pass.
 *   - `-p q=…` is asserted on the ORIGIN's observed query string, not on the
 *     CLI's echo of its own flags.
 *
 * Hermetic: a loopback fixture origin, a synthetic skill-cache dir, a
 * throwaway HOME, and UNBROWSE_API_URL pointed at a dead loopback port so no
 * backend is contacted and no real credential exists. `.invalid` (RFC 2606) is
 * used for the host that must never resolve. UNBROWSE_AUTO_UPDATE stays unset
 * (a 426 from a real backend used to trigger an installer).
 *
 * No `mock.module` anywhere: it is process-wide in bun and would corrupt
 * unrelated test files. Every probe is a real child process against the real
 * CLI entry, spawned ASYNC so the in-process fixture origin can answer it.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Marker present ONLY in the learned route's JSON payload. */
const MARKER = "TWO_CALL_ROW_1";
/** Path only the learned route knows. Never handed to the CLI as an argument. */
const LEARNED_PATH = "/api/items";
const SKILL_ID = "sk_two_call_fixture";
const ENDPOINT_ID = "list_items";
/** The CLI entry a user actually invokes: `unbrowse <command> …`. */
const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli.ts");
const REPO_ROOT = join(import.meta.dir, "..");

interface Origin {
  origin: string;
  seen: string[];
  stop(): void;
}

/** Loopback fixture site: HTML at `/`, the JSON payload at the learned path. */
function startOrigin(): Origin {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const u = new URL(req.url);
      seen.push(`${req.method} ${u.pathname}${u.search}`);
      if (u.pathname === LEARNED_PATH) {
        return new Response(
          JSON.stringify({
            items: [{ id: 1, title: MARKER, q: u.searchParams.get("q") }],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      // The context URL. Deliberately carries no marker: a run that fetched
      // this instead of the learned route cannot satisfy any assertion.
      return new Response(
        "<html><head><title>two-call fixture</title></head><body><p>listing is client-rendered</p></body></html>",
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    seen,
    stop: () => server.stop(true),
  };
}

let origin: Origin;
let home: string;
let skillCacheDir: string;

/** Requests the origin observed at the learned path, ignoring the context URL. */
function learnedHits(): string[] {
  return origin.seen.filter((s) => s.startsWith(`GET ${LEARNED_PATH}`));
}

function env(extra: Record<string, string> = {}): Record<string, string> {
  const e: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: home,
    UNBROWSE_SKILL_CACHE_DIR: skillCacheDir,
    UNBROWSE_CONFIG_DIR: join(home, ".unbrowse"),
    // Dead loopback port: any network rung fails instantly instead of
    // contacting a real backend. The local route store is the only path.
    UNBROWSE_API_URL: "http://127.0.0.1:1",
    UNBROWSE_BACKEND_URL: "http://127.0.0.1:1",
    UNBROWSE_LOCAL_ONLY: "1",
    UNBROWSE_NON_INTERACTIVE: "1",
    UNBROWSE_SKIP_TOS_CHECK: "1",
    UNBROWSE_SKIP_REHYDRATE: "1",
    UNBROWSE_SKIP_DAEMON_PROBE: "1",
    UNBROWSE_IMPORT_BROWSER_COOKIES: "0",
    UNBROWSE_NO_SWEEP: "1",
    // A 426 used to make the client run an installer; keep that path dead.
    UNBROWSE_UPDATE_COMMAND: "true",
    ...extra,
  };
  delete e.UNBROWSE_URL;
  delete e.UNBROWSE_AUTO_UPDATE;
  return e;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

/**
 * Drive the real CLI in its own process. ASYNC spawn on purpose: `spawnSync`
 * would block this process's event loop and the in-process fixture origin
 * would never answer, which fakes a green.
 */
async function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env: env(extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(9), 90_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    let json: Record<string, unknown> = {};
    for (const line of stdout.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        json = JSON.parse(t) as Record<string, unknown>;
      } catch { /* not the envelope line */ }
    }
    return { code, stdout, stderr, json };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * PRECONDITION. Asserts the route store is non-empty and holds THIS fixture
 * route, using `--domain` — the spelling that worked before any fix. Every
 * test calls it first, so no assertion below can pass against an empty store.
 */
async function assertRouteIsIndexed(): Promise<void> {
  const r = await cli(["resolve", "--intent", "list fixture items", "--domain", "127.0.0.1", "--json"]);
  const shortlist = r.json.shortlist as Array<Record<string, unknown>> | undefined;
  expect(Array.isArray(shortlist)).toBe(true);
  expect(shortlist!.length).toBeGreaterThan(0);
  expect(shortlist!.some((e) => e.skill_id === SKILL_ID && e.endpoint_id === ENDPOINT_ID)).toBe(true);
}

beforeAll(() => {
  origin = startOrigin();
  home = mkdtempSync(join(tmpdir(), "unbrowse-two-call-"));
  skillCacheDir = join(home, ".unbrowse", "skill-cache");
  mkdirSync(skillCacheDir, { recursive: true });
  // A synthetic locally-captured route: agent-owned, http, one safe GET.
  // Nothing here is customer data and no host outside loopback appears.
  writeFileSync(
    join(skillCacheDir, `${SKILL_ID}.json`),
    JSON.stringify({
      skill_id: SKILL_ID,
      version: "1.0.0",
      schema_version: "1",
      name: "two-call fixture",
      intent_signature: "list fixture items",
      domain: "127.0.0.1",
      description: "Two-call-path fixture — synthetic, loopback only.",
      owner_type: "agent",
      execution_type: "http",
      lifecycle: "active",
      score: 90,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      endpoints: [
        {
          endpoint_id: ENDPOINT_ID,
          method: "GET",
          url_template: `${origin.origin}${LEARNED_PATH}`,
          trigger_url: `${origin.origin}/`,
          description: "list fixture items",
          idempotency: "safe",
          verification_status: "verified",
          reliability_score: 0.95,
        },
      ],
    }),
  );
});

afterAll(() => {
  origin?.stop();
});

describe("D1 — resolve consults the local route store when scoped by --url", () => {
  it("finds the indexed route by --url alone (no --domain)", async () => {
    await assertRouteIsIndexed(); // vacuity guard: the store really holds it

    const r = await cli([
      "resolve",
      "--intent", "list fixture items",
      "--url", `${origin.origin}/`,
      "--json",
    ]);

    // The call reached the LOCAL resolution path, and did so because of --url.
    expect(r.json.tier).toBe("local_cache");
    expect(r.json.source).toBe("local_cache");
    expect(r.json.domain_source).toBe("url");
    expect(r.json.domain).toBe("127.0.0.1");
    expect(r.json.ctx_url).toBe(`${origin.origin}/`);

    // And it found the route — with the two ids call 2 needs.
    const shortlist = r.json.shortlist as Array<Record<string, unknown>>;
    expect(shortlist.length).toBeGreaterThan(0);
    const row = shortlist.find((e) => e.endpoint_id === ENDPOINT_ID)!;
    expect(row).toBeDefined();
    expect(row.skill_id).toBe(SKILL_ID);
    expect(row.url).toBe(`${origin.origin}${LEARNED_PATH}`);
    expect(r.code).toBe(0);
  }, 120_000);

  it("a --url on a domain with no indexed route does NOT report a local hit", async () => {
    // Negative control: the local branch must be selective, not always-true.
    // `.invalid` (RFC 2606) can never resolve, and the backend rung is a dead
    // loopback port, so this cannot reach any network either.
    const r = await cli([
      "resolve",
      "--intent", "list fixture items",
      "--url", "https://nothing-indexed.invalid/",
      "--json",
    ]);
    expect(r.json.tier).not.toBe("local_cache");
    expect((r.json.shortlist as unknown[] | undefined)?.length ?? 0).toBe(0);
  }, 120_000);
});

describe("D2 — execute --skill/--endpoint reaches the handler and replays from the route store", () => {
  it("replays the learned route; the ORIGIN observed the call", async () => {
    await assertRouteIsIndexed();
    const before = learnedHits().length;

    const r = await cli([
      "execute",
      "--skill", SKILL_ID,
      "--endpoint", ENDPOINT_ID,
      "--json",
    ]);

    // Reached the handler at all (the old failure was `missing_positional`).
    expect(r.json.error).toBeUndefined();
    expect(r.json.ok).toBe(true);
    expect(r.json.endpoint_id).toBe(ENDPOINT_ID);
    expect(r.json.skill_id).toBe(SKILL_ID);

    // The URL came from the ROUTE STORE, not from anything the caller passed:
    // the learned path was never an argument to this process.
    expect(r.json.endpoint_source).toBe("local_cache");
    expect(String(r.json.url)).toContain(LEARNED_PATH);

    // Ground truth: the origin served exactly one new learned-path request,
    // and the bytes that came back carry the payload-only marker.
    expect(learnedHits().length).toBe(before + 1);
    expect(String(r.json.response_body)).toContain(MARKER);
    expect(r.json.status).toBe(200);
    expect(r.code).toBe(0);
  }, 120_000);

  it("without --endpoint (and no positional) it refuses, naming the flag", async () => {
    const r = await cli(["execute", "--skill", SKILL_ID, "--json"]);
    expect(r.json.ok).toBeUndefined();
    expect(String(r.json.error)).toContain("endpoint");
    expect(r.code).not.toBe(0);
  }, 120_000);
});

describe("D4 — -p key=value reaches the wire", () => {
  it("the ORIGIN observes ?q=… , and -p is not mistaken for the endpoint id", async () => {
    await assertRouteIsIndexed();
    const before = learnedHits().length;

    const r = await cli([
      "execute",
      "--skill", SKILL_ID,
      "--endpoint", ENDPOINT_ID,
      "-p", "q=two-call-marker",
      "--json",
    ]);

    expect(r.json.ok).toBe(true);
    expect(r.json.endpoint_id).toBe(ENDPOINT_ID); // not "q=two-call-marker"
    expect(r.json.param_keys).toEqual(["q"]);

    // Ground truth on the SERVER side, not the CLI's echo of its own flags.
    const hits = learnedHits();
    expect(hits.length).toBe(before + 1);
    expect(hits[hits.length - 1]).toContain("q=two-call-marker");
    // …and the origin reflected it back into the payload it returned.
    expect(String(r.json.response_body)).toContain("two-call-marker");
    expect(r.code).toBe(0);
  }, 120_000);

  it("-p values are never taken as the endpoint id when it comes from a positional", async () => {
    await assertRouteIsIndexed();
    const r = await cli(["execute", "-p", "q=positional-probe", ENDPOINT_ID, "--skill", SKILL_ID, "--json"]);
    expect(r.json.endpoint_id).toBe(ENDPOINT_ID);
    expect(r.json.param_keys).toEqual(["q"]);
    expect(r.code).toBe(0);
  }, 120_000);
});

describe("D5 — --dry-run sends nothing", () => {
  it("prints the plan and the origin observes NO request", async () => {
    await assertRouteIsIndexed();
    const before = learnedHits().length;

    const r = await cli([
      "execute",
      "--skill", SKILL_ID,
      "--endpoint", ENDPOINT_ID,
      "-p", "q=dry-probe",
      "--dry-run",
      "--json",
    ]);

    expect(r.json.dry_run).toBe(true);
    expect(r.json.sent).toBe(false);
    // The plan is real: it names the learned URL and the -p param.
    expect(String(r.json.url)).toContain(LEARNED_PATH);
    expect(String(r.json.url)).toContain("q=dry-probe");
    // No response body exists, because nothing was sent.
    expect(r.json.response_body).toBeUndefined();
    // Ground truth: the origin count did not move.
    expect(learnedHits().length).toBe(before);
    expect(r.code).toBe(0);
  }, 120_000);
});

describe("D3 — the --no-execute claim is gone, and resolve never executes", () => {
  it("resolve does not call the endpoint, with or without --no-execute", async () => {
    await assertRouteIsIndexed();
    const before = learnedHits().length;

    const plain = await cli(["resolve", "--intent", "list fixture items", "--url", `${origin.origin}/`, "--json"]);
    const withFlag = await cli(["resolve", "--intent", "list fixture items", "--url", `${origin.origin}/`, "--no-execute", "--json"]);

    // Neither form executed anything — so a flag that suppresses execution
    // would be describing behaviour that does not exist.
    expect(learnedHits().length).toBe(before);
    expect(plain.json.response_body).toBeUndefined();
    expect(plain.json.result).toBeUndefined();
    // Same shortlist either way: the flag changes nothing it could claim to.
    expect(JSON.stringify(withFlag.json.shortlist)).toBe(JSON.stringify(plain.json.shortlist));
  }, 120_000);

  it("SKILL.md no longer documents --no-execute (or any other inert execute flag)", async () => {
    const md = await Bun.file(join(REPO_ROOT, "packages", "skill", "SKILL.md")).text();
    // A doc claim is only deleted if it is deleted everywhere.
    expect(md).not.toContain("--no-execute");
    // These are the projection/mutation flags the v7 `execute` path never
    // reads; documenting them is the same defect as documenting --no-execute.
    for (const inert of ["--extract", "--schema", "--confirm-unsafe", "--confirm-third-party-terms"]) {
      expect(md).not.toContain(inert);
    }
    // What IS documented has to be what the two-call path really takes.
    expect(md).toContain("unbrowse execute --skill <id> --endpoint <id> [-p key=val ...]");
    expect(md).toContain("--dry-run");
  });

  // A claim deleted in ONE copy is not deleted. The repo carries the same
  // sentence in two more places an agent actually reads — the root SKILL.md and
  // the CLI's own --help — and both still asserted that `resolve` auto-executes
  // and that --no-execute suppresses it. Both are false on the shipped path:
  // KIND_MAP routes the flat `resolve` token to `eval resolve`, which has no
  // execution path at all. Leaving them is how the fix above silently rots.
  it("the root SKILL.md carries no --no-execute claim either", async () => {
    const rootMd = await Bun.file(join(REPO_ROOT, "SKILL.md")).text();
    expect(rootMd).not.toContain("--no-execute");
    // ...and it must not have been "fixed" by deleting the two-call path.
    expect(rootMd).toContain("unbrowse execute --skill");
  });

  it("`unbrowse --help` does not advertise --no-execute or claim resolve executes", async () => {
    const src = await Bun.file(join(REPO_ROOT, "src", "cli.ts")).text();
    // Comments are allowed to discuss the removed flag — the help STRINGS are not.
    const helpStrings = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(helpStrings).not.toContain('desc: "Resolve only; return shortlist without auto-executing."');
    expect(helpStrings).not.toContain("executes top safe GET (default behavior)");
    expect(helpStrings).not.toContain("Auto-executes the top safe GET endpoint by default");
    // Deliberately NOT asserted here: that `unbrowse read resolve` or
    // `--force-capture` are absent. The three-verb comment at cli.ts:4119 says
    // the `read` alias was removed, but `unbrowse read resolve --intent x`
    // still exits 0 and does real work, and `--force-capture` is read at
    // cli.ts:938. Pinning them as dead would pin an inference this session did
    // not establish. Left as an open question rather than a false green.
  });
});
