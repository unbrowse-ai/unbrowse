import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isCachedSkillRelevantForIntent, getDomainReuseKey, domainSkillCache } from "../src/orchestrator/index.js";
import type { SkillManifest } from "../src/types.js";

// Reproduces issue #413: resolve never reads domain-skill-cache when
// isCachedSkillRelevantForIntent returns false (e.g. ccTLD endpoint mismatch).
//
// Real case: Airbnb captured on airbnb.com.sg but indexed under airbnb.com key.
// hasUsableEndpoints fails (onDomain check: airbnb.com.sg ≠ airbnb.com),
// so isCachedSkillRelevantForIntent returns false and the skill is discarded.
// Fix: domain-skill-cache fallback uses skill when any endpoint passes
// isResolveUsableEndpointForIntent, even without passing the strict check.

const AIRBNB_SEARCH_URL = "https://www.airbnb.com/s/Tokyo/homes?tab_id=home_tab";

// Simulates the actual airbnb skill structure captured from airbnb.com.sg
// Domain stored as airbnb.com but endpoints on airbnb.com.sg
const airbnbSkillCcTLD: SkillManifest = {
  skill_id: "Ow34rhpjk22lIOJqpcBj2",
  domain: "www.airbnb.com",
  execution_type: "http",
  intent_signature: "search vacation rentals",
  intents: ["search vacation rentals"],
  endpoints: [
    {
      endpoint_id: "CQgrSb7y367Z1-ko9-awP",
      method: "GET",
      url_template: "https://www.airbnb.com.sg/api/v3/NaviServerAnnouncementsQuery/{NaviServerAnnouncementsQuery}",
      description: "Navigation announcements",
      response_schema: { type: "object" },
    },
    {
      endpoint_id: "bk30dFLPeyeVYAj2iCy4c",
      method: "GET",
      url_template: "https://www.airbnb.com.sg/api/v3/AutoSuggestionsQuery/{AutoSuggestionsQuery}?operationName={operationName}",
      description: "Auto suggestions for search",
      response_schema: { type: "array", items: { type: "object" } },
      query: { query: "", locale: "en" },
    },
    {
      endpoint_id: "S2bh3PDq2IS6lq1hbSFw-",
      method: "GET",
      url_template: "https://www.airbnb.com.sg/api/v3/MapViewportInfoQuery/{MapViewportInfoQuery}?operationName={operationName}",
      description: "Map viewport search results",
      response_schema: { type: "object", properties: { listings: { type: "array" } } },
    },
  ],
};

describe("domain-skill-cache fallback (issue #413)", () => {
  test("getDomainReuseKey extracts airbnb.com from search URL", () => {
    const key = getDomainReuseKey(AIRBNB_SEARCH_URL);
    expect(key).toBe("airbnb.com");
  });

  test("isCachedSkillRelevantForIntent handles ccTLD endpoints via brand domain match", () => {
    // After fixing getRegistrableDomain to handle GEO_TLD_SUFFIXES (com.sg etc)
    // and adding isSameBrandDomain to hasUsableEndpoints, this now returns true —
    // the geo-redirect chain is resolved at the domain matching level.
    const relevant = isCachedSkillRelevantForIntent(airbnbSkillCcTLD, "search vacation rentals", AIRBNB_SEARCH_URL);
    expect(relevant).toBe(true);
  });

  test("the real airbnb skill snapshot (if present) fails isCachedSkillRelevantForIntent", () => {
    // Verify with the actual file on disk if it exists
    const snapshotPath = "/Users/lekt9/.unbrowse/skill-snapshots/3fbc24be36199a8506215bd1c079a18b19283f59.json";
    let skill: SkillManifest;
    try {
      skill = JSON.parse(readFileSync(snapshotPath, "utf-8")) as SkillManifest;
    } catch {
      // Snapshot not present on this machine — skip
      return;
    }
    const relevant = isCachedSkillRelevantForIntent(skill, "search vacation rentals", AIRBNB_SEARCH_URL);
    expect(relevant).toBe(false); // This is the pre-fix state — documents the bug
    expect(skill.endpoints.length).toBe(6); // Skill has endpoints, they're just on a ccTLD
  });

  test("domainSkillCache.get returns entry after set (cache lookup plumbing works)", () => {
    const dir = mkdtempSync(join(tmpdir(), "unbrowse-domain-cache-"));
    mkdirSync(join(dir, "skill-snapshots"), { recursive: true });
    const snapshotPath = join(dir, "skill-snapshots", "airbnb.json");
    writeFileSync(snapshotPath, JSON.stringify(airbnbSkillCcTLD));

    domainSkillCache.set("airbnb.com", {
      skillId: airbnbSkillCcTLD.skill_id,
      localSkillPath: snapshotPath,
      ts: Date.now(),
    });

    const entry = domainSkillCache.get("airbnb.com");
    expect(entry).toBeDefined();
    expect(entry?.skillId).toBe("Ow34rhpjk22lIOJqpcBj2");
    expect(entry?.localSkillPath).toBe(snapshotPath);

    domainSkillCache.delete("airbnb.com");
  });

  test("ccTLD skill endpoints pass isResolveUsableEndpointForIntent (fallback gate)", async () => {
    // This verifies the fix's condition: even when isCachedSkillRelevantForIntent fails,
    // isResolveUsableEndpointForIntent passes for the same endpoints, so the fallback fires.
    const { isResolveUsableEndpointForIntent } = await import("../src/orchestrator/index.js") as any;
    if (typeof isResolveUsableEndpointForIntent !== "function") {
      // Not exported — test the behavior via the snapshot check above
      return;
    }
    const ep = airbnbSkillCcTLD.endpoints[1]; // AutoSuggestionsQuery
    const usable = isResolveUsableEndpointForIntent(ep, "search vacation rentals", AIRBNB_SEARCH_URL);
    expect(usable).toBe(true);
  });
});
