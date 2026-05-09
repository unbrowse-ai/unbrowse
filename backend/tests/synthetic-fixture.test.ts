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
