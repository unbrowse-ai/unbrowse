import { afterEach, describe, expect, it } from "bun:test";
import { executeSkill } from "../src/execution/index.js";
import type { SkillManifest } from "../src/types/index.js";

function makeLinkedInSkill(): SkillManifest {
  const now = new Date().toISOString();
  return {
    skill_id: "linkedin-feed",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: now,
    updated_at: now,
    name: "linkedin-feed",
    intent_signature: "get feed posts",
    domain: "www.linkedin.com",
    description: "linkedin feed",
    owner_type: "agent",
    endpoints: [
      {
        endpoint_id: "feed",
        method: "GET",
        url_template: "https://www.linkedin.com/voyager/api/graphql?includeWebMetadata={includeWebMetadata}&variables=(start:{start},count:{count},sortOrder:{sortOrder})&queryId={queryId}",
        query: {
          includeWebMetadata: "true",
          variables: "(start:0,count:3,sortOrder:MEMBER_SETTING)",
          queryId: "voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475",
        },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 1,
      },
    ],
  };
}

function makeLegacyLinkedInSkill(): SkillManifest {
  const now = new Date().toISOString();
  return {
    skill_id: "linkedin-feed-legacy",
    version: "1.0.0",
    schema_version: "1",
    lifecycle: "active",
    execution_type: "http",
    created_at: now,
    updated_at: now,
    name: "linkedin-feed-legacy",
    intent_signature: "get feed posts",
    domain: "www.linkedin.com",
    description: "linkedin feed legacy",
    owner_type: "agent",
    endpoints: [
      {
        endpoint_id: "feed",
        method: "GET",
        url_template: "https://www.linkedin.com/voyager/api/graphql?includeWebMetadata=true&variables=(start:0,count:3,sortOrder:MEMBER_SETTING)&queryId=voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475",
        query: {
          includeWebMetadata: "true",
          variables: "(start:0,count:3,sortOrder:MEMBER_SETTING)",
          queryId: "voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475",
        },
        idempotency: "safe",
        verification_status: "verified",
        reliability_score: 1,
      },
    ],
  };
}

describe("execution query param overrides", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("applies nested voyager variables overrides instead of appending useless top-level params", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      return new Response(JSON.stringify({
        data: {
          data: {
            feedDashMainFeedByMainFeed: {
              "*elements": ["urn:li:fsd_update:(urn:li:activity:1,MAIN_FEED,DEBUG_REASON,DEFAULT,false)"],
            },
          },
        },
        included: [
          {
            entityUrn: "urn:li:fsd_update:(urn:li:activity:1,MAIN_FEED,DEBUG_REASON,DEFAULT,false)",
            commentary: { text: { text: "hello linkedin" } },
            actor: { "*profileUrn": "urn:li:fsd_profile:abc" },
            permalink: "/feed/update/urn:li:activity:1/",
          },
          {
            entityUrn: "urn:li:fsd_profile:abc",
            firstName: "Lewis",
            lastName: "Tham",
            publicIdentifier: "lew",
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const out = await executeSkill(makeLinkedInSkill(), { start: 3, count: 10 });
    const requestUrl = out.trace?.network_events?.[0]?.request.url ?? "";

    expect((out.trace?.success ?? false)).toBe(true);
    expect(requestUrl).toContain("includeWebMetadata=true");
    expect(decodeURIComponent(requestUrl)).toContain("variables=(start:3,count:10,sortOrder:MEMBER_SETTING)");
    expect(requestUrl).toContain("queryId=voyagerFeedDashMainFeed.923020905727c01516495a0ac90bb475");
    expect(requestUrl).not.toContain("&start=3");
    expect(requestUrl).not.toContain("&count=10");
  });

  it("retrofits nested voyager overrides onto old concrete skills", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        data: {
          data: {
            feedDashMainFeedByMainFeed: {
              "*elements": ["urn:li:fsd_update:(urn:li:activity:1,MAIN_FEED,DEBUG_REASON,DEFAULT,false)"],
            },
          },
        },
        included: [
          {
            entityUrn: "urn:li:fsd_update:(urn:li:activity:1,MAIN_FEED,DEBUG_REASON,DEFAULT,false)",
            commentary: { text: { text: "hello linkedin" } },
            actor: { "*profileUrn": "urn:li:fsd_profile:abc" },
            permalink: "/feed/update/urn:li:activity:1/",
          },
          {
            entityUrn: "urn:li:fsd_profile:abc",
            firstName: "Lewis",
            lastName: "Tham",
            publicIdentifier: "lew",
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const out = await executeSkill(makeLegacyLinkedInSkill(), { start: 20, count: 10 });
    const requestUrl = out.trace?.network_events?.[0]?.request.url ?? "";

    expect((out.trace?.success ?? false)).toBe(true);
    expect(decodeURIComponent(requestUrl)).toContain("variables=(start:20,count:10,sortOrder:MEMBER_SETTING)");
    expect(requestUrl).not.toContain("&start=20");
    expect(requestUrl).not.toContain("&count=10");
  });
});
