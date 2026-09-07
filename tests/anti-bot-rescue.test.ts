import { describe, expect, it } from "bun:test";
import {
  isDeepCaptureEnabled,
  isRescueableDirectDocumentReason,
  rescueBlockedPage,
  rescueBlockedPageFree,
  rescueBlockedPagePaid,
} from "../src/execution/anti-bot-rescue.js";

describe("anti-bot-rescue", () => {
  it("classifies challenge/interstitial/spa/thin as rescueable", () => {
    expect(isRescueableDirectDocumentReason("challenge_html")).toBe(true);
    expect(isRescueableDirectDocumentReason("interstitial_detected")).toBe(true);
    expect(isRescueableDirectDocumentReason("spa_hydration_required")).toBe(true);
    expect(isRescueableDirectDocumentReason("too_small")).toBe(true);
    expect(isRescueableDirectDocumentReason("intent_mismatch")).toBe(false);
    expect(isRescueableDirectDocumentReason("dead_or_parked")).toBe(false);
  });

  it("deep capture is default ON and opt-out with UNBROWSE_DEEP_CAPTURE=0", () => {
    expect(isDeepCaptureEnabled({})).toBe(true);
    expect(isDeepCaptureEnabled({ UNBROWSE_DEEP_CAPTURE: "1" })).toBe(true);
    expect(isDeepCaptureEnabled({ UNBROWSE_DEEP_CAPTURE: "true" })).toBe(true);
    expect(isDeepCaptureEnabled({ UNBROWSE_DEEP_CAPTURE: "0" })).toBe(false);
    expect(isDeepCaptureEnabled({ UNBROWSE_DEEP_CAPTURE: "false" })).toBe(false);
    expect(isDeepCaptureEnabled({ UNBROWSE_DEEP_CAPTURE: "off" })).toBe(false);
  });

  it("default Cloudflare wait is 30s and honors UNBROWSE_CF_WAIT_MS", async () => {
    const { defaultCloudflareWaitMs } = await import("../src/kuri/client.js");
    expect(defaultCloudflareWaitMs({})).toBe(30_000);
    expect(defaultCloudflareWaitMs({ UNBROWSE_CF_WAIT_MS: "45000" })).toBe(45_000);
    expect(defaultCloudflareWaitMs({ UNBROWSE_CF_WAIT_MS: "0" })).toBe(30_000);
  });

  it("honors UNBROWSE_ANTI_BOT_RESCUE=0 as disabled", async () => {
    const out = await rescueBlockedPage({
      url: "https://example.com/",
      env: { ...process.env, UNBROWSE_ANTI_BOT_RESCUE: "0" },
    });
    expect(out.reason).toBe("disabled");
    expect(out.html).toBeNull();
  });

  it("returns no_payment when free rungs fail and no paid egress is configured", async () => {
    const out = await rescueBlockedPage({
      url: "https://example.invalid/",
      timeoutMs: 2_000,
      env: {
        UNBROWSE_ANTI_BOT_RESCUE: "1",
        UNBROWSE_DIRECT_EGRESS: "1",
        UNBROWSE_CAPZY_KEY: "",
        // Force no wallet adapters if any are set in the parent env
        UNBROWSE_WALLET_ADAPTER: "none",
      },
    });
    // Either still_blocked or no_payment or unavailable — never a fake HTML body
    expect(out.html).toBeNull();
    expect(["still_blocked", "no_payment", "unavailable", "ok"]).toContain(out.reason);
  });

  it("free rescue never returns paid via tags", async () => {
    const out = await rescueBlockedPageFree({
      url: "https://example.invalid/",
      timeoutMs: 1_500,
      env: {
        UNBROWSE_ANTI_BOT_RESCUE: "1",
        UNBROWSE_DIRECT_EGRESS: "1",
        UNBROWSE_CAPZY_KEY: "should-not-be-used",
        UNBROWSE_WALLET_ADAPTER: "none",
      },
    });
    expect(out.html).toBeNull();
    expect(out.reason).toBe("still_blocked");
    expect(out.via).toBeNull();
  });

  it("paid rescue honors disabled gate", async () => {
    const out = await rescueBlockedPagePaid({
      url: "https://example.com/",
      env: { ...process.env, UNBROWSE_ANTI_BOT_RESCUE: "0" },
    });
    expect(out.reason).toBe("disabled");
    expect(out.html).toBeNull();
  });
});
