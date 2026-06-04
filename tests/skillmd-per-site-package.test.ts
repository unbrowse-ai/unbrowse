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
  test("authed skill: origin install pointer, x402 reward, credential holes (public-safe wording)", () => {
    const md = renderSkillMd(authedSkill());
    expect(md).toContain('origin: "unbrowse-ai/reddit.com"');
    expect(md).toContain("exposed: true");
    expect(md).toContain('x402_reward: "6KpxaoPoTDBAMxNNMPQvQEnTbErtjogL2unK8q3VKcdn"');
    expect(md).toContain("npx skills add unbrowse-ai/reddit.com");
    expect(md).toContain("## Credentials");
    expect(md).toContain("filled locally at call time");
    // Public artifact: the unreleased-IP / internal vocabulary must NOT appear.
    expect(md).not.toContain("zero-knowledge");
    expect(md).not.toContain("ZK-filled");
    expect(md).not.toContain("zk:private-key");
    expect(md).toContain("`authorization`");      // secret header hole
    expect(md).toContain("`x-csrf-token`");        // auth_tokens hole
    expect(md).toContain("`session`");             // auth_profile_ref hole
    expect(md).not.toContain("`accept`");          // non-secret header is NOT a hole
    expect(md).toContain("## Rewards (x402)");
    // Regression: requires/yields must render the param key, never "[object Object]".
    expect(md).not.toContain("[object Object]");
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

import { validateSkillPackage } from "../src/skillmd.js";

describe("validateSkillPackage — publish-time gate", () => {
  test("a rendered authed skill validates ok", () => {
    const v = validateSkillPackage(renderSkillMd(authedSkill()));
    expect(v.ok).toBe(true);
    expect(v.issues).toEqual([]);
  });
  test("a rendered public skill validates ok (x402 optional)", () => {
    const v = validateSkillPackage(renderSkillMd(publicSkill()));
    expect(v.ok).toBe(true);
  });
  test("missing frontmatter fails", () => {
    expect(validateSkillPackage("# just a heading\nno frontmatter").ok).toBe(false);
  });
  test("missing origin/install fails", () => {
    const md = '---\nname: "x"\ndescription: "y"\ndomain: "z.com"\nskill_id: "s"\nintent_signature: "i"\nendpoint_count: 1\n---\n# x\n## Credentials\n';
    const v = validateSkillPackage(md);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.includes("origin"))).toBe(true);
  });
  test("empty x402_reward fails", () => {
    const md = renderSkillMd(authedSkill()).replace(/x402_reward: "[^"]*"/, 'x402_reward: ""');
    expect(validateSkillPackage(md).ok).toBe(false);
  });
});

import { forbiddenPublicTerms } from "../src/skillmd.js";

describe("publish gate — moat / unreleased-IP leak protection", () => {
  test("rendered packages are leak-clean (no ZK/internal vocab)", () => {
    expect(forbiddenPublicTerms(renderSkillMd(authedSkill()))).toEqual([]);
    expect(forbiddenPublicTerms(renderSkillMd(publicSkill()))).toEqual([]);
  });
  test("forbiddenPublicTerms catches a ZK / vocab leak", () => {
    expect(forbiddenPublicTerms("filled via zero-knowledge proof").length).toBeGreaterThan(0);
    expect(forbiddenPublicTerms("the covenant superpattern").length).toBeGreaterThan(0);
    expect(forbiddenPublicTerms("plain installable skill")).toEqual([]);
  });
  test("validateSkillPackage rejects a leaky package", () => {
    const leaky = renderSkillMd(authedSkill()).replace("filled locally at call time", "filled via zero-knowledge proof");
    const v = validateSkillPackage(leaky);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.includes("forbidden public term"))).toBe(true);
  });
});

describe("renderSkillMd — requires/yields serialization", () => {
  test("path-param requires render the key, not [object Object]", () => {
    const skill = {
      skill_id: "sk_param", domain: "example.com", name: "Example",
      description: "x", version: "1.0.0", updated_at: "2026-06-04T00:00:00Z",
      intent_signature: "get thing", intents: ["get thing"],
      endpoints: [{
        endpoint_id: "ep1", method: "GET",
        url_template: "https://example.com/{id}/feed",
        semantic: { requires: [{ key: "id", required: false, source: "path_params" }] },
      }],
    } as unknown as SkillManifest;
    const md = renderSkillMd(skill);
    expect(md).toContain("**Requires**: `id`");
    expect(md).not.toContain("[object Object]");
  });
});
