// Pin: when getPageHtml returns shell-only HTML, cacheBrowseRequests
// retries the live tab after a brief settle BEFORE falling through to
// the server-fetch path. PR #648 introduced the shell-only detector and
// routed straight to tryHttpFetch; on anti-bot-heavy hosts (stackoverflow)
// the server-fetch ALSO gets a challenge response, so the retry path
// preserves the live tab's authenticated state (CF clearance cookies
// tied to TLS fingerprint).
//
// Structural pins via source inspection: the runtime test would need to
// fake a getPageHtml that returns shell-then-real, which means wiring
// the whole cacheBrowseRequests dependency tree (kuri / capture / etc).
// The pin asserts the code shape is intact.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(import.meta.dir, "..", "src", "api", "browse-index.ts"),
  "utf8",
);

describe("getPageHtml retry on shell-only HTML", () => {
  test("retry block calls getPageHtml after a settle", () => {
    expect(SRC).toContain("await new Promise((r) => setTimeout(r, 1500));");
    expect(SRC).toContain("const retried = await getPageHtml();");
  });

  test("retry result must be HTML and not still shell-only", () => {
    expect(SRC).toMatch(
      /if \(retried && retried\.trimStart\(\)\.startsWith\("<"\) && !looksLikeShellOnly\(retried\)\)/,
    );
  });

  test("retry block updates dom_html_size on success", () => {
    expect(SRC).toContain("diagnostic.dom_html_size = retried.length;");
  });

  test("server-fetch fallback still runs when retry did not help", () => {
    // The second predicate must still gate on shell-only after the retry
    // attempt so a probe that stayed empty still routes to tryHttpFetch.
    expect(SRC).toContain(
      'log("browse-index", `getPageHtml still empty after retry',
    );
  });

  test("retry skipped when no getPageHtml callback was provided", () => {
    // The guard `if (getPageHtml && ...)` keeps callers that omitted the
    // callback (tests, headless paths) from null-deref.
    expect(SRC).toContain("if (getPageHtml && looksLikeShellOnly(html) && html) {");
  });
});
