/**
 * Tests for `unbrowse wallet` CLI subcommand.
 *
 * No mocks. We spawn `bun src/cli.ts wallet` as a child process and assert
 * on real stdout + exit code, toggling real env vars and writing real
 * files under a temp HOME so getWalletContext + the resolutionSource
 * mapping behave as they would in production.
 *
 * Per CLAUDE.md "Never mock in tests" — real CLI, real fs.
 */

import { test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const CLI = join(REPO_ROOT, "src/cli.ts");

let tmpHome: string;
const savedEnv = {
  HOME: process.env.HOME,
  LOBSTER_WALLET_ADDRESS: process.env.LOBSTER_WALLET_ADDRESS,
  AGENT_WALLET_ADDRESS: process.env.AGENT_WALLET_ADDRESS,
  UNBROWSE_API_KEY: process.env.UNBROWSE_API_KEY,
  UNBROWSE_BACKEND_URL: process.env.UNBROWSE_BACKEND_URL,
};

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "unbrowse-wallet-test-"));
  delete process.env.LOBSTER_WALLET_ADDRESS;
  delete process.env.AGENT_WALLET_ADDRESS;
});

afterEach(() => {
  if (tmpHome) {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {}
  }
  process.env.HOME = savedEnv.HOME;
  if (savedEnv.LOBSTER_WALLET_ADDRESS !== undefined) {
    process.env.LOBSTER_WALLET_ADDRESS = savedEnv.LOBSTER_WALLET_ADDRESS;
  } else {
    delete process.env.LOBSTER_WALLET_ADDRESS;
  }
  if (savedEnv.AGENT_WALLET_ADDRESS !== undefined) {
    process.env.AGENT_WALLET_ADDRESS = savedEnv.AGENT_WALLET_ADDRESS;
  } else {
    delete process.env.AGENT_WALLET_ADDRESS;
  }
});

function runCli(env: Record<string, string>): {
  stdout: string;
  stderr: string;
  status: number | null;
} {
  // Point at an unreachable host so fetchAgentProfile returns null fast
  // without depending on the real backend during unit tests.
  const r = spawnSync("bun", [CLI, "wallet"], {
    env: {
      ...process.env,
      ...env,
      HOME: tmpHome,
      UNBROWSE_BACKEND_URL: "http://127.0.0.1:1",
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

test("wallet: env LOBSTER_WALLET_ADDRESS surfaces as provider lobster.cash", () => {
  const addr = "(vault address withheld)";
  const r = runCli({ LOBSTER_WALLET_ADDRESS: addr });
  expect(r.stdout).toContain("provider:    lobster.cash");
  // Mask = first 6 + "..." + last 4.
  expect(r.stdout).toContain("Bpr49s...xBX1");
  expect(r.stdout).toContain("source:      env LOBSTER_WALLET_ADDRESS");
  expect(r.status).toBe(0);
});

test("wallet: AGENT_WALLET_ADDRESS uses the legacy generic env slot", () => {
  const addr = "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa44";
  const r = runCli({ AGENT_WALLET_ADDRESS: addr });
  expect(r.stdout).toContain("source:      env AGENT_WALLET_ADDRESS");
  expect(r.stdout).toContain("Aaaaaa...aa44");
  expect(r.status).toBe(0);
});

test("wallet: ~/.lobster/agents.json is the third resolution slot", () => {
  mkdirSync(join(tmpHome, ".lobster"), { recursive: true });
  // wallet.ts expects authorizedWallets.solana or walletAddress on the
  // active agent record (not snake_case at the agent level).
  const cfg = {
    activeAgentId: "agent-001",
    agents: {
      "agent-001": {
        authorizedWallets: {
          solana: "Cccccccccccccccccccccccccccccccccccccccccc44",
        },
      },
    },
  };
  writeFileSync(join(tmpHome, ".lobster", "agents.json"), JSON.stringify(cfg));
  const r = runCli({});
  expect(r.stdout).toContain("source:      ~/.lobster/agents.json");
  expect(r.stdout).toContain("Cccccc...cc44");
  expect(r.status).toBe(0);
});

test("wallet: unconfigured prints the lobster setup hint and exits 2", () => {
  // No env, no ~/.lobster/agents.json — exit 2 with setup nudge.
  const r = runCli({});
  expect(r.stdout).toContain("source:      unconfigured");
  expect(r.stdout).toContain("npx @crossmint/lobster-cli setup");
  expect(r.status).toBe(2);
});

test("wallet: never claims unbrowse signs, provisions, or broadcasts", () => {
  const r = runCli({
    LOBSTER_WALLET_ADDRESS: "(vault address withheld)",
  });
  expect(r.stdout).not.toMatch(/unbrowse (signs|broadcasts|provisions)/i);
});
