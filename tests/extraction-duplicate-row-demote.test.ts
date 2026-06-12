// W3-continuation: extractor returned 6× duplicate Follow-button CTAs on
// dev.to/anthropic and N× duplicate sidebar publisher chips on
// openlibrary.org/works/OL... pages. The structural pattern: a
// repeated-elements array of >=4 rows where the unique-row count divided
// by total rows is < 0.5 — more than half the rows are duplicates of
// each other, so the array is chrome (repeated nav button, repeated
// sidebar facet) not real content.
//
// Live sources (bench-gate run 20260520T093742Z):
// - 011_anchor_https___dev_to_anthropic_       — 6× identical {action:"Follow", ...}
// - 018_semantic-rank_https___openlibrary_org_works_OL_   — repeated publisher chip
//
// Structural fix (NOT per-host, NOT per-intent): a repeated-elements
// array whose distinct-row-stringify ratio drops below 0.5 is demoted.
// Real listings have varying content per row; chrome has repeated content.
//
// This sits BESIDE the existing scoreConfigShapeDemotion (-200, i18n/RSC
// bootstrap) and scoreDegenerateRowDemotion (-300, all-collapsed-values
// pypi pattern). It catches the symmetric case those two miss: rows with
// varying KEYS but uniform VALUES across rows.
//
// Real-runtime: live extractFromDOM, no mocks.

import { describe, expect, test } from "bun:test";
import { extractFromDOM } from "../src/extraction/index.js";

function isDuplicateRowArray(data: unknown): boolean {
  if (!Array.isArray(data)) return false;
  if (data.length < 4) return false;
  const rows = data as unknown[];
  const stringified = rows
    .filter((row) => row != null && typeof row === "object" && !Array.isArray(row))
    .map((row) => JSON.stringify(row));
  if (stringified.length < 4) return false;
  const unique = new Set(stringified);
  return unique.size / stringified.length < 0.5;
}

describe("W3-continuation: duplicate-row chrome demotion", () => {
  test("6x identical Follow CTA rows lose to og:title metadata (dev.to reproducer)", () => {
    // Reproduce dev.to/anthropic empty-profile shape: page renders 6
    // identical "Follow Alexey" call-to-action cards because the profile
    // has no posts. Extractor synthesises {title, action, url} keys but
    // every row has the exact same content.
    const followCtas = Array.from({ length: 6 }, () => `
      <article class="profile-cta">
        <h2>Want to connect with Alexey?</h2>
        <p>Create an account to follow your favorite communities and start taking part in conversations.</p>
        <a href="/enter">Follow Alexey</a>
      </article>`).join("\n");

    const html = `<!doctype html><html><head>
      <meta property="og:title" content="anthropic - DEV Community">
      <meta property="og:description" content="anthropic is an AI safety company.">
    </head><body><main>
      <section class="follow-prompts">${followCtas}</section>
    </main></body></html>`;

    const result = extractFromDOM(html, "get devto profile posts");

    if (isDuplicateRowArray(result.data)) {
      const preview = JSON.stringify(result.data).slice(0, 300);
      throw new Error(`duplicate follow-CTA rows dominated extraction: ${preview}`);
    }
    expect(isDuplicateRowArray(result.data)).toBe(false);
  });

  test("duplicate sidebar publisher chips lose to og metadata (openlibrary reproducer)", () => {
    // Reproduce openlibrary works sidebar where the publisher facet
    // repeats ~10 identical "{name: 'Penguin Random House'}" entries.
    const chips = Array.from({ length: 12 }, () => `
      <li class="sidebar-chip">
        <a href="/publishers/Penguin_Random_House">Penguin Random House</a>
        <span class="chip-meta">publisher</span>
      </li>`).join("\n");

    const html = `<!doctype html><html><head>
      <meta property="og:title" content="The Stand by Stephen King">
      <meta property="og:type" content="book">
      <meta property="og:description" content="A captivating post-apocalyptic horror novel by Stephen King.">
    </head><body><main>
      <aside class="sidebar"><ul class="publishers">${chips}</ul></aside>
    </main></body></html>`;

    const result = extractFromDOM(html, "get openlibrary book metadata");

    if (isDuplicateRowArray(result.data)) {
      const preview = JSON.stringify(result.data).slice(0, 300);
      throw new Error(`duplicate sidebar chips dominated extraction: ${preview}`);
    }
    expect(isDuplicateRowArray(result.data)).toBe(false);
  });

  test("falsifier: distinct rows with same shape are NOT demoted", () => {
    // The new rule must not punish real listings that happen to share
    // the same shape. 8 distinct posts in a feed, all with different
    // titles, must survive.
    const posts = Array.from({ length: 8 }, (_, i) => `
      <article class="post-card">
        <h2><a href="/post/${i}">Post number ${i}: a unique title about topic ${i}</a></h2>
        <p class="excerpt">This post discusses the ${i}th aspect of the matter at hand.</p>
        <span class="author">Author ${i}</span>
      </article>`).join("\n");

    const html = `<!doctype html><html><body>
      <main class="feed">${posts}</main>
    </body></html>`;

    const result = extractFromDOM(html, "get blog posts");
    const dataStr = JSON.stringify(result.data);
    expect(dataStr).toMatch(/Post number [0-9]/);
    expect(isDuplicateRowArray(result.data)).toBe(false);
  });
});
