import { equal } from "node:assert/strict";
import { describe, it } from "node:test";

import { browserOpenedFromSource } from "./browser-opened.js";

describe("browserOpenedFromSource", () => {
  it("marks browser-opening sources as true", () => {
    for (const source of [
      "live-capture",
      "dom-fallback",
      "browser-action",
      "browse-session",
      "first-pass",
    ]) {
      equal(browserOpenedFromSource(source), true);
    }
  });

  it("marks cached and non-browser sources as false", () => {
    for (const source of ["marketplace", "route-cache", "direct-fetch"]) {
      equal(browserOpenedFromSource(source), false);
    }
  });
});
