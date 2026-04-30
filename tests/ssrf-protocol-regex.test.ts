import { describe, expect, test } from "bun:test";

// Reproduce the SSRF protocol-check regression: parsed.protocol always carries
// a trailing colon (e.g. "https:"). The old guard used /^(https?)$/ which can
// never match, so every execute was rejected with "blocked unsafe protocol:
// https: (allowed: http, https)" — a self-contradicting error.
describe("SSRF protocol regex", () => {
  const guard = (url: string): string | null => {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) {
      return `blocked unsafe protocol: ${parsed.protocol} (allowed: http, https)`;
    }
    return null;
  };

  test("allows https:", () => {
    expect(guard("https://news.ycombinator.com/")).toBeNull();
  });

  test("allows http:", () => {
    expect(guard("http://example.com/")).toBeNull();
  });

  test("allows uppercase HTTPS:", () => {
    expect(guard("HTTPS://example.com/")).toBeNull();
  });

  test("blocks file:", () => {
    expect(guard("file:///etc/passwd")).toContain("blocked unsafe protocol");
  });

  test("blocks javascript:", () => {
    expect(guard("javascript:alert(1)")).toContain("blocked unsafe protocol");
  });

  test("blocks ftp:", () => {
    expect(guard("ftp://example.com/")).toContain("blocked unsafe protocol");
  });
});
