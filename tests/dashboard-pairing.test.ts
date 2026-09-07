import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDashboardPairingUrl } from "../src/client/index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unbrowse-pair-"));
  process.env.UNBROWSE_CONFIG_DIR = dir;
});

afterEach(() => {
  delete process.env.UNBROWSE_CONFIG_DIR;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("dashboard pairing", () => {
  it("builds an account-panel open URL that pairs local runtime and lands on /account", () => {
    const url = buildDashboardPairingUrl({
      frontendUrl: "https://unbrowse.ai/",
      localBaseUrl: "http://localhost:6969/",
      pairToken: "pair-token",
      nextPath: "/account",
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://unbrowse.ai/login");
    expect(parsed.searchParams.get("local")).toBe("http://localhost:6969");
    expect(parsed.searchParams.get("pair")).toBe("pair-token");
    expect(parsed.searchParams.get("next")).toBe("/account");
  });

  it("rejects unsafe next paths when building the open URL", () => {
    const url = buildDashboardPairingUrl({
      frontendUrl: "https://unbrowse.ai",
      localBaseUrl: "http://127.0.0.1:6969",
      pairToken: "t",
      nextPath: "https://evil.example/phish",
    });
    expect(new URL(url).searchParams.get("next")).toBe("/dashboard");
  });

  it("tracks pending pairing tokens until consume", async () => {
    const {
      consumeDashboardPairingToken,
      createDashboardPairingToken,
      isDashboardPairingTokenPending,
      saveConfig,
    } = await import("../src/client/index.js");

    saveConfig({
      api_key: "ubr_cccccccccccccccccccccccccccccccccccccccccccccccc",
      agent_id: "cccccccccccccccccccccccccccccccc",
      agent_name: "pending@example.com",
      registered_at: "2026-05-03T00:00:00.000Z",
      tos_accepted_version: null,
      tos_accepted_at: null,
      email: "pending@example.com",
      user_id: "user-pending",
    });

    const pair = createDashboardPairingToken(60_000);
    expect(isDashboardPairingTokenPending(pair.token)).toBe(true);
    expect(consumeDashboardPairingToken(pair.token)?.config.email).toBe("pending@example.com");
    expect(isDashboardPairingTokenPending(pair.token)).toBe(false);
  });

  it("creates a one-shot token that returns the local CLI account", async () => {
    const {
      consumeDashboardPairingToken,
      createDashboardPairingToken,
      saveConfig,
    } = await import("../src/client/index.js");

    saveConfig({
      api_key: "ubr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent_name: "lewis@example.com",
      registered_at: "2026-05-03T00:00:00.000Z",
      tos_accepted_version: null,
      tos_accepted_at: null,
      email: "lewis@example.com",
      user_id: "user123",
    });

    const pair = createDashboardPairingToken(60_000);
    const consumed = consumeDashboardPairingToken(pair.token);

    expect(consumed?.config.api_key).toBe("ubr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(consumed?.config.agent_id).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(consumed?.config.email).toBe("lewis@example.com");
    expect(consumeDashboardPairingToken(pair.token)).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const {
      consumeDashboardPairingToken,
      createDashboardPairingToken,
      saveConfig,
    } = await import("../src/client/index.js");

    saveConfig({
      api_key: "ubr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      agent_id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      agent_name: "agent",
      registered_at: "2026-05-03T00:00:00.000Z",
      tos_accepted_version: null,
      tos_accepted_at: null,
    });

    const pair = createDashboardPairingToken(-1);
    expect(consumeDashboardPairingToken(pair.token)).toBeNull();
  });
});
