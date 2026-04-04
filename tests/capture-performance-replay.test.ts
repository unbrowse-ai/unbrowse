import { describe, expect, it } from "bun:test";
import { isReplayableApiUrl, mergePassiveCaptureData, selectPerformanceReplayCandidates } from "../src/capture/index.js";

describe("performance api replay selection", () => {
  it("keeps api-style preload urls even when page slug hints do not match", () => {
    const candidates = selectPerformanceReplayCandidates(
      [
        {
          name: "https://api.nusmods.com/v2/2025-2026/modules/ABM5001.json",
          initiatorType: "link",
        },
        {
          name: "https://api.nusmods.com/v2/2025-2026/semesters/2/venues.json",
          initiatorType: "xmlhttprequest",
        },
        {
          name: "https://nusmods.com/manifest.json",
          initiatorType: "link",
        },
        {
          name: "https://analytics.nusmods.com/piwik.php?action_name=NUSMods",
          initiatorType: "beacon",
        },
      ],
      {
        captureUrl: "https://nusmods.com/courses/ABM5001/leadership-in-biomedicine",
        intent: "browse nusmods.com",
      },
    );

    expect(candidates).toContain("https://api.nusmods.com/v2/2025-2026/modules/ABM5001.json");
    expect(candidates).toContain("https://api.nusmods.com/v2/2025-2026/semesters/2/venues.json");
    expect(candidates).not.toContain("https://nusmods.com/manifest.json");
    expect(candidates).not.toContain("https://analytics.nusmods.com/piwik.php?action_name=NUSMods");
  });

  it("recognizes api-ish urls without treating app manifests as replay targets", () => {
    expect(isReplayableApiUrl("https://api.nusmods.com/v2/2025-2026/modules/ABM5001.json")).toBe(true);
    expect(isReplayableApiUrl("https://www.linkedin.com/voyager/api/identity/profiles/me")).toBe(true);
    expect(isReplayableApiUrl("https://nusmods.com/manifest.json")).toBe(false);
    expect(isReplayableApiUrl("https://analytics.nusmods.com/piwik.php")).toBe(false);
  });

  it("synthesizes request stubs for replay candidates when no body was harvested", () => {
    const merged = mergePassiveCaptureData(
      [],
      [],
      [],
      new Map(),
      ["https://api.nusmods.com/v2/2025-2026/modules/ABM5001.json"],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.url).toBe("https://api.nusmods.com/v2/2025-2026/modules/ABM5001.json");
    expect(merged[0]?.method).toBe("GET");
    expect(merged[0]?.response_status).toBe(200);
  });
});
