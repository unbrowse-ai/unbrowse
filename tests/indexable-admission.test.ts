// The structural admission gate for passive indexing — junk must be rejected by
// SHAPE (scheme/host/TLD), real externally-reachable endpoints admitted. Mirrors
// the real garbage found in the local capture queue (313 example.com, 41
// chromewebdata, 127.0.0.1:64322 ephemeral-port endpoints).
import { describe, it, expect } from "bun:test";
import { isIndexableUrl, isIndexableDomain, indexableReason } from "../src/capture/indexable.js";

describe("indexable admission — rejects non-replayable junk", () => {
  it("rejects loopback / localhost / ephemeral-port endpoints", () => {
    expect(isIndexableUrl("http://127.0.0.1:64322/search?q={q}")).toBe(false);
    expect(isIndexableUrl("http://localhost:3000/api")).toBe(false);
    expect(isIndexableUrl("https://api.localhost/v1")).toBe(false);
    expect(isIndexableUrl("http://0.0.0.0:8080/")).toBe(false);
    expect(indexableReason("http://127.0.0.1:64322/x")).toBe("loopback_or_local");
  });

  it("rejects private + link-local IPs", () => {
    expect(isIndexableUrl("http://10.0.0.5/x")).toBe(false);
    expect(isIndexableUrl("http://192.168.1.10/x")).toBe(false);
    expect(isIndexableUrl("http://172.16.4.2/x")).toBe(false);
    expect(isIndexableUrl("http://169.254.1.1/x")).toBe(false);
    expect(indexableReason("http://10.0.0.5/x")).toBe("private_ip");
  });

  it("rejects non-http schemes (error pages, data/blob/file/ws)", () => {
    expect(isIndexableUrl("chrome-error://chromewebdata/")).toBe(false);
    expect(isIndexableUrl("about:blank")).toBe(false);
    expect(isIndexableUrl("data:text/html,foo")).toBe(false);
    expect(isIndexableUrl("file:///etc/hosts")).toBe(false);
    expect(isIndexableUrl("ws://example.org/socket")).toBe(false);
    expect(indexableReason("chrome-error://chromewebdata/")).toBe("bad_scheme");
  });

  it("rejects RFC-2606/6761 reserved test domains + chromewebdata + .internal", () => {
    expect(isIndexableUrl("https://example.com/")).toBe(false);
    expect(isIndexableUrl("https://www.example.org/x")).toBe(false);
    expect(isIndexableUrl("https://foo.test/x")).toBe(false);
    expect(isIndexableUrl("https://thing.invalid/x")).toBe(false);
    expect(isIndexableUrl("https://svc.internal/x")).toBe(false);
    expect(isIndexableDomain("chromewebdata")).toBe(false);
    expect(isIndexableDomain("example.com")).toBe(false);
  });

  it("admits real externally-reachable endpoints", () => {
    expect(isIndexableUrl("https://old.reddit.com/r/webscraping.json")).toBe(true);
    expect(isIndexableUrl("https://hn.algolia.com/api/v1/search?query={q}")).toBe(true);
    expect(isIndexableUrl("https://www.carousell.sg/food/q/")).toBe(true);
    expect(isIndexableDomain("old.reddit.com")).toBe(true);
    expect(isIndexableDomain("news.ycombinator.com")).toBe(true);
    expect(indexableReason("https://old.reddit.com/r/x.json")).toBe("ok");
  });

  it("rejects garbage input without throwing", () => {
    expect(isIndexableUrl("")).toBe(false);
    expect(isIndexableUrl("not a url")).toBe(false);
    expect(isIndexableDomain("")).toBe(false);
  });
});
