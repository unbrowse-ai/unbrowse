/**
 * W10-A — v7 CLI read-page eval handlers.
 *
 * Covers 4 v7 eval subcommands shipped real this wave:
 *   - eval markdown    -> observe_markdown / unbrowse_markdown
 *   - eval screenshot  -> observe_screenshot / unbrowse_screenshot
 *   - eval text        -> observe_text / unbrowse_text
 *   - eval cookies     -> observe_cookies / unbrowse_cookies  (CANARY GATE)
 *
 * Always-on slice: pure unit tests for redactCookies + htmlToMarkdown — no
 * CDP, no Chrome. Verifies the load-bearing secret-redaction invariant
 * regardless of W5 readiness.
 *
 * E2E slice (gated on UNBROWSE_W5W6_READY === '1'): runs the CLI against a
 * local Bun.serve test page that sets a magic cookie. Asserts:
 *   1. markdown — plain text, no `<` tags.
 *   2. screenshot — writes a valid PNG file (magic bytes).
 *   3. text — innerText returned for a known selector.
 *   4. CANARY — cookie value `UNB7-VALUE-DO-NOT-LEAK` MUST NOT appear in
 *      stdout, stderr, JSON envelope, or any other byte the handler emits.
 *
 * No mocks: hits real Chrome + real CLI. Per CLAUDE.md "Never mock in tests".
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { redactCookies } from "../src/cli-v7/eval/cookies.js";
import { htmlToMarkdown } from "../src/cli-v7/eval/markdown.js";

const W5W6_READY = process.env.UNBROWSE_W5W6_READY === "1";
const COOKIE_NAME = "unb7-cookie-canary";
const COOKIE_VALUE = "UNB7-VALUE-DO-NOT-LEAK";
const SESSIONS_DIR = join(homedir(), ".unbrowse", "sessions");
const SCREENSHOTS_DIR = join(homedir(), ".unbrowse", "screenshots");
const CLI_ENTRY = join(import.meta.dir, "..", "src", "cli-v7", "index.ts");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolveP) => {
    const child = spawn("bun", ["run", CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
  });
}

async function clearSessions(): Promise<void> {
  if (existsSync(SESSIONS_DIR)) {
    await rm(SESSIONS_DIR, { recursive: true, force: true });
  }
  await mkdir(SESSIONS_DIR, { recursive: true });
}

// ─── Always-on: pure-function unit tests ───────────────────────────────────

describe("v7-cli redactCookies (pure)", () => {
  it("strips `value` even when CDP returns it (load-bearing canary)", () => {
    const out = redactCookies([
      {
        name: "session",
        value: "SECRET-DO-NOT-LEAK",
        domain: "example.com",
        path: "/",
        expires: 1_700_000_000,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ]);
    expect(out).toHaveLength(1);
    const c = out[0];
    expect(c.name).toBe("session");
    expect(c.domain).toBe("example.com");
    expect(c.path).toBe("/");
    expect(c.expires).toBe(1_700_000_000);
    expect(c.httpOnly).toBe(true);
    expect(c.secure).toBe(true);
    expect(c.sameSite).toBe("Lax");
    // The single load-bearing assertion: no `value` key, no SECRET string.
    expect("value" in c).toBe(false);
    expect(JSON.stringify(c)).not.toContain("SECRET-DO-NOT-LEAK");
  });

  it("normalises missing fields without leaking value", () => {
    const out = redactCookies([
      { name: "x", value: "v1" }, // missing every field
    ]);
    expect(out[0].name).toBe("x");
    expect(out[0].domain).toBe("");
    expect(out[0].path).toBe("/");
    expect(out[0].expires).toBe(-1);
    expect(out[0].httpOnly).toBe(false);
    expect(out[0].secure).toBe(false);
    expect("value" in out[0]).toBe(false);
    expect(JSON.stringify(out[0])).not.toContain("v1");
  });

  it("drops invalid sameSite values defensively", () => {
    const out = redactCookies([
      { name: "x", value: "v", sameSite: "Bogus" },
    ]);
    expect(out[0].sameSite).toBeUndefined();
  });
});

describe("v7-cli htmlToMarkdown (pure)", () => {
  it("converts headings + paragraphs to markdown with no `<` tags", async () => {
    const md = await htmlToMarkdown(
      "<html><body><h1>Hello</h1><p>Some paragraph.</p></body></html>",
    );
    expect(md).toContain("Hello");
    expect(md).toContain("Some paragraph");
    expect(md).not.toContain("<h1>");
    expect(md).not.toContain("<p>");
  });

  it("strips script/style content before conversion", async () => {
    const md = await htmlToMarkdown(
      "<body><script>alert('NO');</script><style>.x{}</style><p>Visible</p></body>",
    );
    expect(md).toContain("Visible");
    expect(md).not.toContain("alert");
    expect(md).not.toContain(".x{}");
  });
});

// ─── E2E (gated on W5+W6 readiness) ────────────────────────────────────────

interface TestServer {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const html = `<!DOCTYPE html><html><head><title>W10A Test Page</title></head>
<body>
  <h1 id="hdr">W10A Heading</h1>
  <p class="copy">Lorem ipsum body paragraph.</p>
  <article>An article block.</article>
</body></html>`;
  const server = Bun.serve({
    port: 0,
    fetch(_req) {
      return new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          // The canary cookie — value must NEVER appear in CLI output.
          "set-cookie": `${COOKIE_NAME}=${COOKIE_VALUE}; Path=/; SameSite=Lax`,
        },
      });
    },
  });
  return {
    port: server.port!,
    url: `http://127.0.0.1:${server.port}/`,
    stop: async () => { server.stop(true); },
  };
}

describe.if(W5W6_READY)("v7-cli eval readpage (e2e — W5+W6 required)", () => {
  let server: TestServer;
  let sessionId: string;

  beforeAll(async () => {
    await clearSessions();
    server = await startTestServer();
    // Open a session against the test server (set-cookie lands during nav).
    const res = await runCli(["breath", "go", server.url, "--json"]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    sessionId = out.session_id as string;
    expect(typeof sessionId).toBe("string");
  }, 30_000);

  afterAll(async () => {
    if (sessionId) await runCli(["breath", "close", sessionId, "--json"]);
    await server?.stop();
  });

  it("1. eval markdown — returns plain text with no `<` tags", async () => {
    const res = await runCli(["eval", "markdown", "--json", "--session", sessionId]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(typeof out.markdown).toBe("string");
    expect(out.markdown).toContain("W10A Heading");
    expect(out.markdown).not.toContain("<h1>");
    expect(out.markdown).not.toContain("<p>");
  }, 30_000);

  it("2. eval screenshot — writes a PNG file with valid magic bytes", async () => {
    const res = await runCli(["eval", "screenshot", "--json", "--session", sessionId]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(typeof out.path).toBe("string");
    expect(out.path).toContain(SCREENSHOTS_DIR);
    expect(existsSync(out.path)).toBe(true);
    const bytes = readFileSync(out.path);
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4e);
    expect(bytes[3]).toBe(0x47);
    expect(bytes.length).toBeGreaterThan(100);
  }, 30_000);

  it("3. eval text — returns innerText for a known selector", async () => {
    const res = await runCli(["eval", "text", "#hdr", "--json", "--session", sessionId]);
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(out.found).toBe(true);
    expect(out.text).toContain("W10A Heading");
  }, 30_000);

  it("4. CANARY — eval cookies MUST NOT leak the cookie value anywhere", async () => {
    const res = await runCli(["eval", "cookies", "--json", "--session", sessionId]);
    expect(res.code).toBe(0);

    // Load-bearing assertions: the canary string appears NOWHERE.
    expect(res.stdout).not.toContain(COOKIE_VALUE);
    expect(res.stderr).not.toContain(COOKIE_VALUE);

    const out = JSON.parse(res.stdout);
    expect(out.ok).toBe(true);
    expect(Array.isArray(out.cookies)).toBe(true);
    // The cookie name should be present (we set it server-side); its value
    // must not be.
    const names = out.cookies.map((c: { name: string }) => c.name);
    expect(names).toContain(COOKIE_NAME);

    // Defensive deep sweep: stringify everything the handler returned and
    // assert the literal value is absent.
    expect(JSON.stringify(out)).not.toContain(COOKIE_VALUE);
    for (const c of out.cookies) {
      expect("value" in c).toBe(false);
    }

    // Also verify the `--no-json` pretty path doesn't leak.
    const pretty = await runCli([
      "eval", "cookies", "--no-json", "--session", sessionId,
    ]);
    expect(pretty.stdout).not.toContain(COOKIE_VALUE);
    expect(pretty.stderr).not.toContain(COOKIE_VALUE);
    expect(pretty.stdout).toContain(COOKIE_NAME);
  }, 30_000);
});
