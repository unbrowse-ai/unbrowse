/**
 * Witness for remote-triggered code execution on HTTP 426.
 *
 * `apiRequest` used to respond to a 426 by running
 *   execSync(process.env.UNBROWSE_UPDATE_COMMAND || "curl -fsSL …/install.sh | bash")
 * followed by `pkill -9 -f 'unbrowse|kuri'` — no prompt, no signature check, no
 * interactive guard. A server response therefore chose which shell command ran on
 * the user's machine. Anything able to answer for the API (a proxy, DNS, a
 * compromised or merely mistaken backend) had arbitrary local code execution, and
 * anything able to set an env var chose the payload. This was live, not
 * hypothetical: the backend returns 426 `client_verification_failed` for source
 * checkouts, and the path fired inside a test run on a developer machine.
 *
 * The fix does not remove auto-update; it removes the *assumption of consent*.
 * Installing software is the operator's call, so the default is to print the
 * command and refuse to run it, with UNBROWSE_AUTO_UPDATE=1 restoring the old
 * behaviour for anyone who genuinely wants it.
 *
 * SAFETY NOTE — the sentinel command deliberately exits non-zero. When the opt-in
 * path executes it, execSync throws, so control reaches the catch branch and
 * `pkill -9 -f 'unbrowse|kuri'` is never invoked. That pkill is a substring match
 * over every process on the box: run it for real here and it kills this test
 * runner, whose command line contains "unbrowse-dev". Creating the sentinel BEFORE
 * failing is what lets the opt-in case prove execution really happened without
 * ever reaching the process-killing line.
 *
 * Run: bun test tests/client-426-no-remote-exec.test.ts
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");

const SERVER_SUGGESTED_CMD = "curl -fsSL https://fixture.invalid/install.sh | bash";

const tempDirs: string[] = [];
function newTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// The fixture backend runs in its OWN process. It cannot live in the test process:
// the probes use spawnSync, which blocks this process's event loop, so an
// in-process Bun.serve never answers and every probe fails with "The operation was
// aborted" — a false green for the refusal test, since nothing ran because nothing
// was ever asked, not because anything refused.
let serverProc: ReturnType<typeof Bun.spawn> | null = null;
let baseUrl = "";

async function ensureServer(): Promise<string> {
  if (baseUrl) return baseUrl;
  const dir = newTemp("unb-426-srv-");
  const portFile = join(dir, "port");
  const srv = join(dir, "server.ts");
  writeFileSync(
    srv,
    [
      "import { writeFileSync } from 'node:fs';",
      "const s = Bun.serve({ port: 0, fetch() {",
      `  return new Response(JSON.stringify({ error: "client_update_required", update_command: ${JSON.stringify(SERVER_SUGGESTED_CMD)} }),`,
      "    { status: 426, headers: { 'content-type': 'application/json' } });",
      "} });",
      `writeFileSync(${JSON.stringify(portFile)}, String(s.port));`,
      "await new Promise(() => {});",
    ].join("\n"),
  );

  serverProc = Bun.spawn(["bun", "run", srv], { stdout: "ignore", stderr: "ignore" });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, "utf8").trim();
      if (port) {
        baseUrl = `http://127.0.0.1:${port}`;
        return baseUrl;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("fixture 426 server never reported a port");
}

afterAll(() => {
  serverProc?.kill();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Probe {
  threw: boolean;
  message: string;
}

/**
 * Drive a real exported client call against the 426 server in a subprocess, with
 * UNBROWSE_UPDATE_COMMAND wired to a sentinel-writing command. Returns the
 * outcome plus whether the sentinel was created — i.e. whether ANY command ran.
 */
function runProbe(optIn: boolean): { probe: Probe; executed: boolean } {
  const dir = newTemp("unb-426-");
  const sentinel = join(dir, "EXECUTED");
  const script = join(dir, "probe.ts");

  writeFileSync(
    script,
    [
      `import { listSkills } from ${JSON.stringify(join(REPO, "src/client/index.js"))};`,
      "let threw = false, message = '';",
      "try { await listSkills(); } catch (e) { threw = true; message = String((e as Error).message ?? e); }",
      "console.log(JSON.stringify({ threw, message }));",
    ].join("\n"),
  );

  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.UNBROWSE_BACKEND_URL = baseUrl;
  env.UNBROWSE_API_KEY = "fixture-key-not-real";
  // Creates the sentinel, then fails — see the SAFETY NOTE above.
  env.UNBROWSE_UPDATE_COMMAND = `touch ${JSON.stringify(sentinel)}; exit 1`;
  delete env.UNBROWSE_AUTO_UPDATE;
  if (optIn) env.UNBROWSE_AUTO_UPDATE = "1";

  const res = spawnSync("bun", ["run", script], { env, encoding: "utf8", timeout: 120_000 });
  const line = (res.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (!line) {
    throw new Error(`probe produced no JSON (status=${res.status}) stderr=${res.stderr?.slice(-2000)}`);
  }
  return { probe: JSON.parse(line) as Probe, executed: existsSync(sentinel) };
}

// Each probe spawns a subprocess that talks to the fixture server; that exceeds
// bun's 5s default hook timeout, so they are run lazily from inside tests that
// carry an explicit one, and memoized so each variant spawns exactly once.
const PROBE_TIMEOUT_MS = 60_000;
const cache = new Map<boolean, { probe: Probe; executed: boolean }>();
async function probeFor(optIn: boolean): Promise<{ probe: Probe; executed: boolean }> {
  await ensureServer();
  let hit = cache.get(optIn);
  if (!hit) {
    hit = runProbe(optIn);
    cache.set(optIn, hit);
  }
  return hit;
}

// ─── 1. Vacuity guard: the sentinel really can observe an execution ────────────

describe("the probe can observe a command actually running", () => {
  // Without this, "no command ran" below is unfalsifiable — it would also hold
  // if the probe never reached the 426 branch at all.
  test("with UNBROWSE_AUTO_UPDATE=1 the update command IS executed", async () => {
    expect((await probeFor(true)).executed).toBe(true);
  }, PROBE_TIMEOUT_MS);

  test("and a failed update still surfaces the manual instruction", async () => {
    const { probe } = await probeFor(true);
    expect(probe.threw).toBe(true);
    expect(probe.message).toContain(SERVER_SUGGESTED_CMD);
  }, PROBE_TIMEOUT_MS);
});

// ─── 2. The refusal: a server response cannot run anything by default ──────────

describe("a 426 response executes nothing without explicit consent", () => {
  test("no command runs when UNBROWSE_AUTO_UPDATE is unset", async () => {
    expect((await probeFor(false)).executed).toBe(false);
  }, PROBE_TIMEOUT_MS);

  test("the caller is told what to run instead of it being run for them", async () => {
    const { probe } = await probeFor(false);
    expect(probe.threw).toBe(true);
    expect(probe.message).toContain("Client update required");
    expect(probe.message).toContain(SERVER_SUGGESTED_CMD);
  }, PROBE_TIMEOUT_MS);

  test("UNBROWSE_UPDATE_COMMAND alone is not consent", async () => {
    // The command was set in every probe. Setting WHAT would run must never be
    // read as authorising THAT something runs — that conflation is the defect.
    expect((await probeFor(false)).executed).toBe(false);
  }, PROBE_TIMEOUT_MS);
});
