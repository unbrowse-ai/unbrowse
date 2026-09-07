import { describe, expect, it } from "bun:test";
import { shortlistEntryMatchesDomain } from "../src/cli-v7/eval/resolve.js";

describe("URL-scoped resolve domain coherence (#135)", () => {
  it("accepts only host-coherent PyPI candidates", () => {
    expect(shortlistEntryMatchesDomain({ url: "https://pypi.org/pypi/flask/json" }, "pypi.org")).toBe(true);
    expect(shortlistEntryMatchesDomain({ metadata: { domain: "pypi.org" } }, "pypi.org")).toBe(true);
    expect(shortlistEntryMatchesDomain({ url_template: "https://registry.npmjs.org/flask" }, "pypi.org")).toBe(false);
    expect(shortlistEntryMatchesDomain({ metadata: { domain: "npmjs.com" } }, "pypi.org")).toBe(false);
  });

  it("fails closed when a scoped candidate carries no host evidence", () => {
    expect(shortlistEntryMatchesDomain({ id: 123, score: 0.9 }, "pypi.org")).toBe(false);
  });
});
