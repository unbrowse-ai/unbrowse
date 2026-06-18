import { describe, it, expect } from "bun:test";
import { shouldScrollStimulate } from "../src/capture/index.js";

// Phase-5 scroll stimulus is what makes a lazy listing XHR fire so the
// reverse-engineer can see it. It used to trigger only on a hard
// `search|explore|trending` URL allowlist + an enumerated entity-word list,
// which missed Carousell's `/food/q/` + "find good food". Now it rides the
// shared cardinality signal (CLAUDE.md "generalize — never a hard filter").
describe("shouldScrollStimulate — generalized off the cardinality signal", () => {
  it("fires for the witnessed Carousell case the old allowlist missed", () => {
    // Old behaviour: /food/q/ doesn't match search|explore, and "find good food"
    // isn't in the person|company|post word list → no scroll → listing XHR never fired.
    expect(shouldScrollStimulate("https://www.carousell.sg/food/q/", "find good food listings with titles and prices")).toBe(true);
  });
  it("fires on a list-like context URL even with a terse intent", () => {
    expect(shouldScrollStimulate("https://www.carousell.sg/categories/food-beverages-1011/", "get them")).toBe(true);
    expect(shouldScrollStimulate("https://x.com/search/shoes", "x")).toBe(true);
  });
  it("fires on a list-like intent even on a plain URL", () => {
    expect(shouldScrollStimulate("https://x.com/", "list all products")).toBe(true);
    expect(shouldScrollStimulate("https://x.com/", "browse listings")).toBe(true);
  });
  it("does NOT fire for a single-item detail intent on a detail URL", () => {
    expect(shouldScrollStimulate("https://www.carousell.sg/p/risoles-123/", "get the price of this product")).toBe(false);
    expect(shouldScrollStimulate("https://x.com/u/profile-1/", "open this page")).toBe(false);
  });
});
