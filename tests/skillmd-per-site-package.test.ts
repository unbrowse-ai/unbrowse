import { describe, expect, test } from "bun:test";
import { renderSkillMd, credentialHoles } from "../src/skillmd.js";
import type { SkillManifest } from "../src/types/skill.js";

function authedSkill(): SkillManifest {
  return {
    skill_id: "sk_reddit",
    domain: "reddit.com",
    name: "Reddit",
    description: "Reddit read routes",
    version: "1.0.0",
    updated_at: "2026-06-04T00:00:00Z",
    intent_signature: "get hot posts from a subreddit",
    intents: ["get hot posts from a subreddit", "search reddit"],
    owner_wallet_address: "6KpxaoPoTDBAMxNNMPQvQEnTbErtjogL2unK8q3VKcdn",
    auth_profile_ref: "vault:reddit",
    endpoints: [{
      endpoint_id: "ep_hot",
      method: "GET",
      url_template: "https://www.reddit.com/r/{sub}/hot.json",
      headers_template: { "authorization": "{token}", "accept": "application/json" },
      auth_tokens: [{ name: "x-csrf-token" }],
      csrf_plan: { param_name: "x-modhash", source: "cookie", extractor_sequence: [] },
    }],
  } as unknown as SkillManifest;
}

function publicSkill(): SkillManifest {
  return {
    skill_id: "sk_usgs",
    domain: "earthquake.usgs.gov",
    name: "USGS Earthquakes",
    description: "USGS public earthquake feed",
    version: "1.0.0",
    updated_at: "2026-06-04T00:00:00Z",
    intent_signature: "list recent earthquakes",
    intents: ["list recent earthquakes"],
    endpoints: [{
      endpoint_id: "ep_feed",
      method: "GET",
      url_template: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson",
      headers_template: { "accept": "application/json" },
    }],
  } as unknown as SkillManifest;
}

describe("renderSkillMd — per-website agentskills package", () => {
  test("authed skill: origin install pointer, x402 reward, ZK credential holes", () => {
    const md = renderSkillMd(authedSkill());
    expect(md).toContain('origin: "unbrowse-ai/reddit.com"');
    expect(md).toContain("exposed: true");
    expect(md).toContain('x402_reward: "6KpxaoPoTDBAMxNNMPQvQEnTbErtjogL2unK8q3VKcdn"');
    expect(md).toContain("npx skills add unbrowse-ai/reddit.com");
    expect(md).toContain("## Credentials (ZK-filled holes)");
    expect(md).toContain("zero-knowledge");
    expect(md).toContain("`authorization`");      // secret header hole
    expect(md).toContain("`x-csrf-token`");        // auth_tokens hole
    expect(md).toContain("`session`");             // auth_profile_ref hole
    expect(md).not.toContain("`accept`");          // non-secret header is NOT a hole
    expect(md).toContain("## Rewards (x402)");
  });

  test("credentialHoles extracts only the secret/auth holes", () => {
    const holes = credentialHoles(authedSkill());
    const names = holes.map((h) => h.name.toLowerCase());
    expect(names).toContain("authorization");
    expect(names).toContain("x-csrf-token");
    expect(names).toContain("x-modhash");
    expect(names).toContain("session");
    expect(names).not.toContain("accept");
    expect(holes.every((h) => h.fill === "zk:private-key")).toBe(true);
  });

  test("public skill: no creds, no rewards section", () => {
    const md = renderSkillMd(publicSkill());
    expect(md).toContain("No credentials required");
    expect(md).not.toContain("## Rewards (x402)");
    expect(md).not.toContain("x402_reward:");
    expect(md).toContain("npx skills add unbrowse-ai/earthquake.usgs.gov");
  });
});
