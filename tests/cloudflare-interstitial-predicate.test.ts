import { describe, expect, test } from "bun:test";
import { INTERSTITIAL_PREDICATE } from "../src/kuri/client.js";

/**
 * The predicate ships to the browser as a source string, so the test evaluates
 * that exact string — there is no second copy of the rule to drift.
 *
 * Each case supplies the structural facts a real page would present:
 *   - `chlOpt`   — the options object the challenge runtime installs on window
 *   - `title`    — document.title
 *   - `selectors`— which of the challenge/error widgets are rendered in the page
 */
function runPredicate(page: {
  chlOpt?: unknown;
  title?: string;
  selectors?: readonly string[];
}): boolean {
  const rendered = page.selectors ?? [];
  const fakeWindow = { _cf_chl_opt: page.chlOpt };
  const fakeDocument = {
    title: page.title ?? "",
    querySelector(selector: string): object | null {
      // Mirror querySelector's comma-list semantics: match if ANY listed
      // selector is rendered on the page.
      const wanted = selector.split(",").map((s) => s.trim());
      return wanted.some((w) => rendered.includes(w)) ? {} : null;
    },
  };
  const fn = new Function("window", "document", `return ${INTERSTITIAL_PREDICATE};`);
  return fn(fakeWindow, fakeDocument) === true;
}

describe("the predicate must survive the kuri evaluate transport", () => {
  // The expression rides in a query string. A double quote and a newline are both
  // destroyed there, and the failure is silent: the mangled expression throws, so
  // evaluate() returns undefined, which a predicate reads as `false` — i.e. "no
  // challenge" on a page that is in fact challenged. Assert the shape directly so
  // a well-meaning reformat cannot reintroduce it.
  test("carries no double quote", () => {
    expect(INTERSTITIAL_PREDICATE.includes('"')).toBe(false);
  });

  test("carries no newline", () => {
    expect(/[\n\r]/.test(INTERSTITIAL_PREDICATE)).toBe(false);
  });

  test("carries no // line comment", () => {
    expect(INTERSTITIAL_PREDICATE.includes("//")).toBe(false);
  });

  test("is still valid JavaScript", () => {
    expect(() => new Function(`return ${INTERSTITIAL_PREDICATE};`)).not.toThrow();
  });
});

describe("Cloudflare interstitial predicate — the challenge must BE the document", () => {
  test("a served page that loads Cloudflare's JSD telemetry subresource is NOT an interstitial", () => {
    // This is x.com on every route: the page renders fine and carries
    // <script src="/cdn-cgi/challenge-platform/scripts/jsd/api.js">.
    // The old substring scan of documentElement.innerHTML matched
    // 'challenge-platform' here and burned the entire 30s clearance wait.
    expect(
      runPredicate({ title: "DAN KOE (@thedankoe) / X" }),
    ).toBe(false);
  });

  test("a real challenge page is detected via the runtime's options object", () => {
    expect(runPredicate({ chlOpt: { cvId: "3", cType: "managed" } })).toBe(true);
  });

  test("a real challenge page is detected via its own title", () => {
    expect(runPredicate({ title: "Just a moment..." })).toBe(true);
  });

  test("a Cloudflare block page is detected via its title", () => {
    expect(runPredicate({ title: "Attention Required! | Cloudflare" })).toBe(true);
  });

  test.each([
    "#challenge-running",
    "#challenge-form",
    "#challenge-error-title",
    ".cf-browser-verification",
    ".cf-error-details",
    "#cf-error-details",
  ])("a rendered %s widget is detected", (selector) => {
    expect(runPredicate({ selectors: [selector] })).toBe(true);
  });

  test("an ordinary page with neither widget, title, nor options object is not an interstitial", () => {
    expect(runPredicate({ title: "Example Domain" })).toBe(false);
  });

  test("an undefined _cf_chl_opt does not count as present", () => {
    expect(runPredicate({ chlOpt: undefined, title: "Some Site" })).toBe(false);
  });
});
