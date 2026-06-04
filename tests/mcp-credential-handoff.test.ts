/**
 * No-mock test for the MCP startup credential-handoff stderr message.
 *
 * Spawns the real `bun src/mcp.ts` binary against a temp HOME with no
 * config file and no UNBROWSE_API_KEY, sends one `initialize` JSON-RPC
 * message to keep the loop alive briefly, then reads the stderr buffer
 * and asserts the registration URL block is present.
 *
 * Why this matters: every new MCP user who installs unbrowse without
 * running `unbrowse register` first will see this stderr block. The
 * MCP-client agent reads server stderr and uses it to guide the human
 * through registration. Silently running without credentials is the
 * failure mode (resolve/execute/publish/earnings all fail with
 * unhelpful 401s once the user actually tries to do something).
 *
 * Per CLAUDE.md: no mocks. Real subprocess, real temp HOME, real
 * stderr inspection.
 */

import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const MCP_ENTRY = join(REPO_ROOT, "src/mcp.ts");

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "ubmcp-creds-"));
});

afterEach(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {}
});

interface BootResult {
  stderr: string;
  stdout: string;
  exitCode: number | null;
}

async function bootMcp(env: Record<string, string>): Promise<BootResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [MCP_ENTRY], {
      env: {
        // Minimal env so the bun runtime can find itself.
        PATH: process.env.PATH ?? "",
        HOME: tmpHome,
        // Force-empty the credential surfaces this test is exercising.
        UNBROWSE_API_KEY: "",
        // Disable telemetry upload so the test doesn't hit the network.
        UNBROWSE_TELEMETRY_ENABLED: "0",
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.on("error", reject);

    // Send one `initialize` then close stdin so the loop exits cleanly.
    // We poll stderr — once the boot block is present we kill and resolve.
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    }) + "\n";
    child.stdin.write(initialize);

    const deadline = Date.now() + 15_000;
    const poll = setInterval(() => {
      // Once the boot block has flushed OR we've exceeded the deadline,
      // kill the child and report what we saw.
      const sawBoot = /starting stateless stdio MCP/.test(stderr);
      if (sawBoot || Date.now() > deadline) {
        clearInterval(poll);
        try { child.stdin.end(); } catch {}
        try { child.kill("SIGTERM"); } catch {}
      }
    }, 100);

    child.on("close", (code) => {
      clearInterval(poll);
      resolve({ stderr, stdout, exitCode: code });
    });
  });
}

test("MCP boot stderr surfaces registration URL when no API key is configured", async () => {
  const result = await bootMcp({});
  // Sanity: boot actually happened.
  expect(result.stderr).toContain("starting stateless stdio MCP");
  // The credential handoff block.
  expect(result.stderr).toContain("no API key configured");
  expect(result.stderr).toMatch(/register:\s+https:\/\/unbrowse\.ai\/login\?cli=1/);
  expect(result.stderr).toContain("npx unbrowse register");
  expect(result.stderr).toContain("UNBROWSE_API_KEY=");
}, 30_000);

test("MCP boot stderr respects UNBROWSE_WEB_URL for self-hosted deploys", async () => {
  const result = await bootMcp({ UNBROWSE_WEB_URL: "https://staging.unbrowse.ai/" });
  expect(result.stderr).toContain("starting stateless stdio MCP");
  // Trailing slash should be stripped.
  expect(result.stderr).toMatch(/register:\s+https:\/\/staging\.unbrowse\.ai\/login\?cli=1/);
  expect(result.stderr).not.toMatch(/staging\.unbrowse\.ai\/\/login/);
}, 30_000);

test("MCP boot stderr does NOT surface the handoff when UNBROWSE_API_KEY is set", async () => {
  const result = await bootMcp({ UNBROWSE_API_KEY: "uk_test_dummy_key_for_boot_check_only" });
  expect(result.stderr).toContain("starting stateless stdio MCP");
  expect(result.stderr).not.toContain("no API key configured");
}, 30_000);
