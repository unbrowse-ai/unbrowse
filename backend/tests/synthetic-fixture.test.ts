/**
 * Plan-v15 Tier 3 storm test — synthetic CF/PX fixtures must match the
 * production extractor regexes. If these tests fail, the entire Tier 3
 * solver-retry plumbing in bench is dead because the synthetic bodies
 * never produce a bundle URL.
 *
 * Matt 7:24-25: build on rock — verify the fixture body literally matches
 * the regex used in production, not a regex written here.
 */
import { describe, it, expect } from "bun:test";
import { extractCfBundleUrl } from "../../src/execution/cf-challenge.js";
import { extractPxBundleUrl } from "../../src/execution/px-challenge.js";
import { syntheticRoutes } from "../src/routes/synthetic.js";

// Synthetic CF body — copied verbatim from backend/src/routes/synthetic.ts
const CF_SYNTHETIC_BODY = `<!doctype html><html><head><title>Just a moment...</title></head><body>
<script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/feedface00deadbeef/main.js"></script>
</body></html>`;

// Synthetic PX body — copied verbatim from backend/src/routes/synthetic.ts
const PX_SYNTHETIC_BODY = `<!doctype html><html><body>
<script src="/aaaaaaaa-bbbb-4cba-9bbb-eeeeeeeeeeee/aaaaaaaa-bbbb-4cba-9bbb-eeeeeeeeeeee/init.js"></script>
</body></html>`;

describe("synthetic CF fixture", () => {
  it("body contains CF bundle path with 18-char hex hash", () => {
    expect(CF_SYNTHETIC_BODY).toContain(
      "/cdn-cgi/challenge-platform/h/g/scripts/jsd/feedface00deadbeef/main.js",
    );
  });

  it("extractCfBundleUrl matches synthetic body and returns absolute URL", () => {
    const url = extractCfBundleUrl(CF_SYNTHETIC_BODY, "https://x.com/home");
    expect(url).not.toBeNull();
    expect(url).toBe(
      "https://x.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/feedface00deadbeef/main.js",
    );
  });
});

describe("synthetic PX fixture", () => {
  it("body contains PX bundle path /<uuid>/<uuid>/init.js", () => {
    expect(PX_SYNTHETIC_BODY).toContain(
      "/aaaaaaaa-bbbb-4cba-9bbb-eeeeeeeeeeee/aaaaaaaa-bbbb-4cba-9bbb-eeeeeeeeeeee/init.js",
    );
  });

  it("extractPxBundleUrl matches synthetic body and returns absolute URL", () => {
    const url = extractPxBundleUrl(PX_SYNTHETIC_BODY, "https://x.com/home");
    expect(url).not.toBeNull();
    expect(url).toBe(
      "https://x.com/aaaaaaaa-bbbb-4cba-9bbb-eeeeeeeeeeee/aaaaaaaa-bbbb-4cba-9bbb-eeeeeeeeeeee/init.js",
    );
  });
});

describe("synthetic Akamai fixture (Plan-v17 Tier 1)", () => {
  it("unarmed GET /_synthetic_akamai_challenge -> 403 with Akamai sensor reference", async () => {
    const res = await syntheticRoutes.fetch(
      new Request("http://localhost/_synthetic_akamai_challenge"),
    );
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain("<script src=\"/akam-");
  });

  it("armed GET /_synthetic_akamai_challenge with _abck=ok -> 200 JSON pass body", async () => {
    const res = await syntheticRoutes.fetch(
      new Request("http://localhost/_synthetic_akamai_challenge", {
        headers: { Cookie: "_abck=ok" },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string; items: string[] };
    expect(json.status).toBe("synthetic_akamai_pass");
    expect(Array.isArray(json.items)).toBe(true);
    expect(json.items.length).toBe(2);
  });
});
