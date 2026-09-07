/**
 * GATE: a browser that never committed a page cannot be reported as success.
 *
 * Found by `tests/e2e/install-matrix.ts` on its first run. Against
 * `https://unresolvable.invalid/x` the CLI returned:
 *
 *   status: "ok"          trace.success: true      status_code: 200
 *   final_url: "chrome-error://chromewebdata/"
 *   capture.error: "fetch failed"          <- contradicts "ok" in the same payload
 *   page_text: "This site can't be reached … ERR_NAME_NOT_RESOLVED"
 *
 * DNS failed, Chrome rendered its own error page, and the browse-direct path
 * hoisted that error page as the answer. The gate it passed through checked page
 * length (>= 200 chars) and a challenge-keyword regex — Chrome's error text is
 * long enough and matches no keyword, so it sailed through.
 *
 * The missing question was never "is this text long enough" but "did a page load
 * at all", and the repo already had the recognizer for it.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { indexableReason } from "../src/capture/indexable.js";

describe("uncommitted-page recognition", () => {
  test("chrome's error pseudo-pages are recognised as never-committed", () => {
    for (const url of [
      "chrome-error://chromewebdata/",
      "about:blank",
      "data:text/html,<h1>x</h1>",
    ]) {
      expect(indexableReason(url), url).toBe("bad_scheme");
    }
  });

  test("a real committed page is NOT rejected — including reserved domains", () => {
    // The trap: `isIndexableUrl` also rejects example.com as a reserved domain,
    // but example.com is a real page that merely should not be INDEXED. Gating
    // success on that predicate would have broken every legitimate browse of it.
    expect(indexableReason("https://quotes.toscrape.com/")).toBe("ok");
    expect(indexableReason("https://example.com/x")).toBe("reserved_domain");
    expect(indexableReason("https://example.com/x")).not.toBe("bad_scheme");
  });
});

describe("the browse-direct success gate consults it", () => {
  const cli = readFileSync(join(import.meta.dirname, "..", "src", "cli.ts"), "utf8");

  test("browse-direct requires a committed page before claiming success", () => {
    // Structural pin: the repo's precedent for orchestrator-flag wiring
    // (see local-skills-only-skips-marketplace.test.ts). Cheap, and it fails
    // loudly if the guard is dropped in a refactor.
    expect(cli).toContain('indexableReason(browseFinalUrl) !== "bad_scheme"');
    const idx = cli.indexOf("const looksLikeRealContent");
    expect(idx).toBeGreaterThan(0);
    const gate = cli.slice(idx, idx + 400);
    expect(gate).toContain("committedRealPage");
  });

  test("it does NOT gate on isIndexableUrl (which would reject example.com)", () => {
    // Guards the specific wrong fix, not just the absence of the right one.
    const idx = cli.indexOf("const committedRealPage");
    const line = cli.slice(idx, cli.indexOf("\n", idx));
    expect(line).not.toContain("isIndexableUrl");
  });
});
