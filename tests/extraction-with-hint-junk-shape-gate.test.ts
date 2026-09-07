// Bench-gate regression: 009 pypi/anthropic returned 182 rows of
// {description,date,info} all-same-string per row — the classic
// degenerate-row pattern. The main extractFromDOM pre-score filter
// already demotes / drops this shape, but extractFromDOMWithHint
// bypassed those gates and returned the junk early when the captured
// selector replayed to that shape.
//
// Fix: extractFromDOMWithHint now applies the same junk-shape checks
// before accepting the hint-extracted result.
//
// Real-runtime: live extractFromDOMWithHint, no mocks.

import { describe, expect, test } from "bun:test";
import { extractFromDOMWithHint, extractFromDOM } from "../src/extraction/index.js";

describe("extractFromDOMWithHint: junk-shape gates apply to hint replay", () => {
  test("captured selector replaying to all-equal-rows falls through to fallback (pypi-shape)", () => {
    // Synthesise the pypi release-history shape: each <div class="release-entry">
    // has three children with the same date text. The "release-entries" CSS
    // selector hint would replay into 30 rows of {date,info,description}
    // all-equal — degenerate-row pattern.
    const releaseRows = Array.from({ length: 30 }, (_, i) => {
      const date = `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;
      return `<div class="release-entry">
        <p class="date">${date}</p>
        <span class="info">${date}</span>
        <span class="description">${date}</span>
      </div>`;
    }).join("\n");

    const html = `<!doctype html><html><head>
      <meta property="og:title" content="anthropic - PyPI">
      <meta property="og:description" content="The official Python library for the Anthropic API">
    </head><body>
      <main>
        <h1>anthropic</h1>
        <p class="package-description">Real package description body</p>
        <section class="release-timeline">${releaseRows}</section>
      </main>
    </body></html>`;

    const hintResult = extractFromDOMWithHint(html, "get pypi package info", { selector: ".release-entry" });

    // The hint selector matches the degenerate dates. Post-fix the gate
    // should reject + fall through to extractFromDOM which returns either
    // the real h1/p body OR the metadata-fallback. Either way the
    // returned data MUST NOT be the all-equal dates rows.
    const dataStr = JSON.stringify(hintResult.data);
    // The buggy behavior would surface the dates as the dominant output.
    const looksDegenerate = Array.isArray(hintResult.data) &&
      hintResult.data.length >= 4 &&
      (hintResult.data as Array<Record<string, unknown>>).every((row) => {
        if (!row || typeof row !== "object") return false;
        const vals = Object.values(row).filter((v) => v != null && v !== "");
        if (vals.length < 2) return false;
        const strs = vals.map(String);
        return strs.every((s) => s === strs[0]);
      });
    if (looksDegenerate) {
      throw new Error(`degenerate-row dates dominated hint extraction: ${dataStr.slice(0, 300)}`);
    }
  });

  test("falsifier: hint with REAL distinct-row data still passes through", () => {
    // When the selector replays to real distinct-value rows, the gate must
    // NOT regress them — they should be returned as-is.
    const html = `<!doctype html><html><body>
      <ul class="results">
        <li><h3>First</h3><p>Real description one</p></li>
        <li><h3>Second</h3><p>Different description two</p></li>
        <li><h3>Third</h3><p>Yet another description</p></li>
        <li><h3>Fourth</h3><p>One more for the road</p></li>
      </ul>
    </body></html>`;

    const r = extractFromDOMWithHint(html, "get list of results", { selector: ".results li" });
    const dataStr = JSON.stringify(r.data);
    // Must contain the real titles
    expect(dataStr).toMatch(/First|Second|Third|Fourth/);
  });
});
