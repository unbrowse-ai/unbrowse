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
  OWS_HOME: process.env.OWS_HOME,
  OWS_WALLET_ADDRESS: process.env.OWS_WALLET_ADDRESS,
  LOBSTER_WALLET_ADDRESS: process.env.LOBSTER_WALLET_ADDRESS,
  AGENT_WALLET_ADDRESS: process.env.AGENT_WALLET_ADDRESS,
  AGENT_WALLET_PROVIDER: process.env.AGENT_WALLET_PROVIDER,
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
  if (savedEnv.OWS_HOME !== undefined) {
    process.env.OWS_HOME = savedEnv.OWS_HOME;
  } else {
    delete process.env.OWS_HOME;
  }
  if (savedEnv.OWS_WALLET_ADDRESS !== undefined) {
    process.env.OWS_WALLET_ADDRESS = savedEnv.OWS_WALLET_ADDRESS;
  } else {
    delete process.env.OWS_WALLET_ADDRESS;
  }
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
  if (savedEnv.AGENT_WALLET_PROVIDER !== undefined) {
    process.env.AGENT_WALLET_PROVIDER = savedEnv.AGENT_WALLET_PROVIDER;
  } else {
    delete process.env.AGENT_WALLET_PROVIDER;
  }
});

function runCli(env: Record<string, string>): {
  stdout: string;
  stderr: string;
  output: string;
  status: number | null;
} {
  const childEnv = { ...process.env };
  for (const key of [
    "OWS_WALLET_ADDRESS",
    "LOBSTER_WALLET_ADDRESS",
    "AGENT_WALLET_ADDRESS",
    "AGENT_WALLET_PROVIDER",
    "UNBROWSE_API_KEY",
  ]) {
    delete childEnv[key];
  }
  Object.assign(childEnv, env, {
    HOME: tmpHome,
    OWS_HOME: join(tmpHome, ".ows"),
    UNBROWSE_BACKEND_URL: "http://127.0.0.1:1",
  });

  // Point at an unreachable host so fetchAgentProfile returns null fast
  // without depending on the real backend during unit tests.
  const r = spawnSync("bun", [CLI, "wallet"], {
    env: childEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { stdout, stderr, output: `${stdout}\n${stderr}`, status: r.status };
}

test("wallet: env LOBSTER_WALLET_ADDRESS surfaces as provider lobster.cash", () => {
  const addr = "Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1";
  const r = runCli({ LOBSTER_WALLET_ADDRESS: addr });
  expect(r.output).toContain("provider:    lobster.cash");
  // Mask = first 6 + "..." + last 4.
  expect(r.output).toContain("Bpr49s...xBX1");
  expect(r.output).toContain("source:      env LOBSTER_WALLET_ADDRESS");
  expect(r.status).toBe(0);
});

test("wallet: AGENT_WALLET_ADDRESS uses the legacy generic env slot", () => {
  const addr = "Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa44";
  const r = runCli({ AGENT_WALLET_ADDRESS: addr });
  expect(r.output).toContain("source:      env AGENT_WALLET_ADDRESS");
  expect(r.output).toContain("Aaaaaa...aa44");
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
  expect(r.output).toContain("source:      ~/.lobster/agents.json");
  expect(r.output).toContain("Cccccc...cc44");
  expect(r.status).toBe(0);
});

test("wallet: unconfigured prints the lobster setup hint and exits 2", () => {
  // No env, no ~/.lobster/agents.json — exit 2 with setup nudge.
  const r = runCli({});
  expect(r.output).toContain("source:      unconfigured");
  expect(r.output).toContain("npx @crossmint/lobster-cli setup");
  expect(r.status).toBe(2);
});

test("wallet: never claims unbrowse signs, provisions, or broadcasts", () => {
  const r = runCli({
    LOBSTER_WALLET_ADDRESS: "Bpr49sQXsxwNXNMRWS2v3tTBGWu2QgZtdA83BX77xBX1",
  });
  expect(r.stdout).not.toMatch(/unbrowse (signs|broadcasts|provisions)/i);
});
