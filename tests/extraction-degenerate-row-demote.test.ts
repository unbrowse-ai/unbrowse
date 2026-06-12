// W3-followup: extractor returned a 170-row "release history" table
// on https://pypi.org/project/anthropic/ where every row was a literal
// {description: "May 19, 2026", date: "May 19, 2026", info: "May 19, 2026"}
// triple — multiple keys, but every value identical per row, so the row
// carries no real information beyond a single date.
//
// Live source: .bench-gate/20260520T093742Z/009_anchor_https___pypi_org_project_anthropic_/execute.response.raw
//
// On the bench, the execute pipeline calls extractFromDOMWithHint with
// the captured selector. The selector replays into the dates rows;
// classifyRows skips because rows have no `name`+`description` package
// shape; the call falls through to extractFromDOM which then picks the
// dates as the best repeated-elements structure even though no row
// carries information beyond a single duplicated date string.
//
// Structural fix (NOT per-host): a repeated-elements array whose rows
// reduce to a SINGLE unique value per row (multiple keys, but all
// values stringify-identical inside the row) is degenerate. Demote it
// so any other structure (key-value fallback, json-ld, html_metadata
// fallback) wins. platform-faithful: shape-only, no domain or intent
// matching.
//
// Real-runtime: live extractFromDOM, no mocks.

import { describe, expect, test } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

function isDegenerateRowArray(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  if (data.length < 4) return false;
  return (data as unknown[]).every((row) => {
    if (row == null || typeof row !== "object" || Array.isArray(row)) return false;
    const values = Object.values(row as Record<string, unknown>).filter((v) => v != null && v !== "");
    if (values.length < 2) return false;
    const stringified = values.map((v) => String(v).trim());
    return stringified.every((s) => s === stringified[0]);
  });
}

describe("W3-followup: degenerate-row demotion (collapsed-values pattern)", () => {
  test("dates-only release table loses to metadata fallback (pypi reproducer)", () => {
    // Reproduce the pypi.org release-history shape from .bench-gate/20260520T093742Z/009.
    // Each row is a single date string repeated into three child spans;
    // extractCardFields then synthesises {date, info, description} keys
    // that all hold the same date string.
    const degenerateRows = Array.from({ length: 30 }, (_, i) => {
      const date = `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;
      return `<div class="release-entry">
        <p>${date}</p>
        <span class="release-date">${date}</span>
        <span class="release-info">${date}</span>
      </div>`;
    }).join("\n");

    // The page also carries metadata as a fallback path (og:title + og:description),
    // simulating what html_metadata_fallback returns on a sparse page.
    // We strip out h1/canonical so extractPackageDetailSpecial cannot fire.
    const html = `<!doctype html><html lang="en"><head>
      <title>anthropic · PyPI</title>
      <meta property="og:title" content="anthropic">
      <meta property="og:description" content="The official Python library for the anthropic API">
    </head><body>
      <main>
        <section class="release-timeline">${degenerateRows}</section>
      </main>
    </body></html>`;

    const result = extractFromDOM(html, "get pypi package info");

    // The degenerate-row array must NOT be the dominant output.
    if (isDegenerateRowArray(result.data)) {
      const preview = JSON.stringify(result.data).slice(0, 300);
      throw new Error(`degenerate dates array dominated extraction: ${preview}`);
    }
    expect(isDegenerateRowArray(result.data)).toBe(false);
  });

  test("dates rows alone, no metadata at all, still must not dominate", () => {
    // Even with NO competing extractor, an all-collapsed-values row array
    // should be demoted below html_metadata_fallback (the path that
    // would otherwise return null and let the caller route to handoff).
    // Either the metadata fallback wins, OR null is returned — never the
    // degenerate array as the top pick.
    const degenerateRows = Array.from({ length: 30 }, (_, i) => {
      const date = `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`;
      return `<div class="release-entry">
        <p>${date}</p>
        <span class="release-date">${date}</span>
        <span class="release-info">${date}</span>
      </div>`;
    }).join("\n");

    const html = `<!doctype html><html><body>
      <main>
        <section class="release-timeline">${degenerateRows}</section>
      </main>
    </body></html>`;

    const result = extractFromDOM(html, "get pypi package info");
    if (isDegenerateRowArray(result.data)) {
      const preview = JSON.stringify(result.data).slice(0, 300);
      throw new Error(`degenerate dates array dominated extraction with no competition: ${preview}`);
    }
    expect(isDegenerateRowArray(result.data)).toBe(false);
  });

  test("rich array with distinct values per row is NOT demoted (falsifier)", () => {
    // Falsifier: when the rows have distinct values per row, they carry
    // real information and must NOT be demoted by the new rule.
    const rows = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-05-${String(i + 1).padStart(2, "0")}`,
      version: `0.${100 + i}.0`,
      type: i % 2 === 0 ? "wheel" : "sdist",
    }));
    const rowsHtml = rows.map((r) => `<div class="release-entry">
      <p>${r.date}</p>
      <span class="release-date">${r.date}</span>
      <span class="release-info">${r.version} ${r.type}</span>
    </div>`).join("\n");

    const html = `<!doctype html><html><body>
      <main>
        <section class="release-timeline">${rowsHtml}</section>
      </main>
    </body></html>`;

    const result = extractFromDOM(html, "release history versions");
    const dataStr = JSON.stringify(result.data);
    // The distinct-values table must survive — at least one version string visible.
    expect(dataStr).toMatch(/0\.10[0-9]/);
  });
});
