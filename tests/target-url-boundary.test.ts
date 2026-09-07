/**
 * The boundary rejects, so the inside can trust.
 *
 * Measured on the CLI before this validator existed — all four are real outputs,
 * not hypotheticals:
 *
 *   --url file:///etc/passwd   exit 0, success:true, source:direct-fetch, and the
 *                              local file's CONTENTS in the payload
 *   --url javascript:alert(1)  hung until the 45s harness timeout (exit 124)
 *   --url ftp://x.com/a        hung until the 45s harness timeout (exit 124)
 *   --url not-a-url            exit 1 — indistinguishable from the site being down
 *
 * The first is a local file read reachable from an agent-supplied string, which
 * matters because CLI arguments are not trusted input: they can come from a
 * hallucinating or prompt-injected agent while the human defines the bounded
 * surface. The middle two are unbounded recovery — 45 seconds for a verdict that
 * is decidable immediately. The last leaves a system unable to distinguish a
 * malformed argument from a failed fetch, which are different retries.
 *
 * After: every one is exit 64 (EX_USAGE) with a typed code, in under a second.
 *
 * Both directions are asserted. A validator that rejects everything would pass a
 * reject-only suite while breaking the tool, so the accept cases carry equal
 * weight — including the ones that LOOK odd but are legitimate (userinfo, ports,
 * IDN, query strings, IPv6 literals).
 */
import { describe, expect, test } from "bun:test";
import { validateTargetUrl } from "../src/values/target-url.js";

describe("rejects — with a routable code, not prose", () => {
  const cases: Array<[string, unknown, string]> = [
    ["local file read", "file:///etc/passwd", "url_scheme_unsupported"],
    ["script scheme", "javascript:alert(1)", "url_scheme_unsupported"],
    ["data scheme", "data:text/html,<b>x", "url_scheme_unsupported"],
    ["ftp", "ftp://x.com/a", "url_scheme_unsupported"],
    ["not a url", "not-a-url", "url_unparseable"],
    ["scheme only", "http://", "url_unparseable"],
    ["empty", "", "url_missing"],
    ["whitespace", "   ", "url_missing"],
    ["undefined", undefined, "url_missing"],
    ["non-string", 42, "url_missing"],
  ];
  for (const [name, input, code] of cases) {
    test(`${name} -> ${code}`, () => {
      const v = validateTargetUrl(input);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.code).toBe(code as never);
        // Stable snake_case token, matching the orchestrator's other errors
        // (auth_required, payment_required, …) so a system can route on it.
        expect(v.code).toMatch(/^[a-z][a-z_]*$/);
        expect(v.message.length).toBeGreaterThan(0);
      }
    });
  }

  test("case and spacing cannot smuggle a scheme past the check", () => {
    for (const u of ["FILE:///etc/passwd", "  file:///etc/passwd  ", "JavaScript:alert(1)"]) {
      const v = validateTargetUrl(u);
      expect({ u, ok: v.ok }).toEqual({ u, ok: false });
    }
  });
});

describe("accepts — the validator must not break the tool", () => {
  const ok = [
    "https://example.com",
    "http://example.com/path?q=1#frag",
    "https://example.com:8443/x",
    "https://user:pass@example.com/x",   // userinfo is legitimate
    "https://127.0.0.1:3000/api",        // raw IP
    "https://[::1]:8080/x",              // IPv6 literal
    "https://münchen.example/x",         // IDN
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
  ];
  for (const u of ok) {
    test(u, () => {
      const v = validateTargetUrl(u);
      expect({ u, ok: v.ok }).toEqual({ u, ok: true });
      if (v.ok) expect(v.hostname.length).toBeGreaterThan(0);
    });
  }

  test("surrounding whitespace is trimmed, not rejected", () => {
    const v = validateTargetUrl("  https://example.com/x  ");
    expect(v.ok).toBe(true);
  });

  test("returns the normalised URL for downstream use", () => {
    const v = validateTargetUrl("https://example.com");
    expect(v.ok && v.url).toBe("https://example.com/");
  });
});
