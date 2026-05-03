import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
