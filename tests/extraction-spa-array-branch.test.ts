// Regression test: the generic homogeneous-array primitive in extractSPAData
// surfaces every nested array of >=3 homogeneous-typed objects as its own
// candidate, regardless of which framework (Next.js / Apollo / Nuxt / plain
// JS) put it there. No framework registry — just structural shape.
//
// Selectors are paths relative to each detected SPA store's root (e.g.
// pageProps for __NEXT_DATA__, the apollo cache for __APOLLO_STATE__),
// not the HTML root, so the agent gets a path it can replay.

import { describe, it, expect } from "bun:test";
import { extractSPAData } from "../src/extraction/index.js";

const wrap = (state: unknown) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: state },
  })}</script></body></html>`;

describe("extractSPAData generic array-branch primitive", () => {
  it("surfaces a single homogeneous array branch as its own candidate", () => {
    const html = wrap({
      navigation: { logo: "x" },
      templates: [
        { name: "Next Starter", slug: "next-starter", category: "framework" },
        { name: "Astro Blog", slug: "astro-blog", category: "framework" },
        { name: "Sveltekit App", slug: "sveltekit-app", category: "framework" },
      ],
    });
    const out = extractSPAData(html);
    const branches = out.filter((r) => r.selector === "templates");
    expect(branches.length).toBeGreaterThan(0);
    expect(branches[0].element_count).toBe(3);
    expect(Array.isArray(branches[0].data)).toBe(true);
  });

  it("surfaces two distinct branches with different shapes from the same wrapper", () => {
    const html = wrap({
      categories: [
        { id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" },
      ],
      templates: [
        { name: "T1", framework: "next" },
        { name: "T2", framework: "astro" },
        { name: "T3", framework: "remix" },
      ],
    });
    const out = extractSPAData(html);
    const cat = out.find((r) => r.selector === "categories");
    const tpl = out.find((r) => r.selector === "templates");
    expect(cat?.element_count).toBe(3);
    expect(tpl?.element_count).toBe(3);
  });

  it("dedups branches with identical shape signature", () => {
    // Two arrays with the SAME object-key fingerprint should produce one
    // candidate (signature = count|sorted-keys) — prevents flooding the
    // scorer when the same cache slice appears under multiple paths.
    const items = [
      { id: 1, name: "x" }, { id: 2, name: "y" }, { id: 3, name: "z" },
    ];
    const html = wrap({ a: items, b: items });
    const out = extractSPAData(html);
    const branches = out.filter((r) => r.selector === "a" || r.selector === "b");
    expect(branches.length).toBe(1);
  });

  it("ignores array branches with fewer than 3 items", () => {
    const html = wrap({ posts: [{ title: "only one" }] });
    const out = extractSPAData(html);
    const tooSmall = out.find((r) => r.selector === "posts");
    expect(tooSmall).toBeUndefined();
  });

  it("ignores arrays with mixed primitive items (non-homogeneous)", () => {
    // 70% threshold: 2 objects + 2 strings = 50% objects → rejected
    const html = wrap({ mixed: [{ a: 1 }, "hello", { a: 2 }, "world"] });
    const out = extractSPAData(html);
    const mixed = out.find((r) => r.selector === "mixed");
    expect(mixed).toBeUndefined();
  });

  it("works on Apollo cache shape — entries under arbitrary path are surfaced", () => {
    // Apollo state is a flat dict { "TypeName:id": entity }. When some
    // entity has a nested array of refs, the primitive walks in and finds
    // that array. This must work without an Apollo-specific arm.
    const html = `<html><body><script>window.__APOLLO_STATE__=${JSON.stringify({
      "ROOT_QUERY": {
        recentPosts: [
          { __ref: "Post:1", title: "A", author: "alice" },
          { __ref: "Post:2", title: "B", author: "bob" },
          { __ref: "Post:3", title: "C", author: "carol" },
          { __ref: "Post:4", title: "D", author: "dave" },
        ],
      },
    })}</script></body></html>`;
    const out = extractSPAData(html);
    const branch = out.find((r) => r.selector?.endsWith("recentPosts"));
    expect(branch?.element_count).toBe(4);
  });

  it("does not descend past depth 6 (cycle/runaway guard)", () => {
    // Build a deeply-nested object with the array buried at depth 8.
    // The primitive should not surface it.
    let deep: Record<string, unknown> = {
      arr: [{ a: 1 }, { a: 2 }, { a: 3 }],
    };
    for (let i = 0; i < 8; i++) deep = { wrap: deep };
    const html = wrap(deep);
    const out = extractSPAData(html);
    const buried = out.find((r) => r.selector?.includes("arr"));
    expect(buried).toBeUndefined();
  });

  it("caps emissions at 12 branches per page", () => {
    const wrapped: Record<string, unknown> = {};
    // Generate 30 distinct homogeneous arrays under 30 distinct paths.
    for (let i = 0; i < 30; i++) {
      wrapped[`arr${i}`] = [
        { uniqueKey: `k${i}_a`, val: i },
        { uniqueKey: `k${i}_b`, val: i + 1 },
        { uniqueKey: `k${i}_c`, val: i + 2 },
      ];
    }
    const html = wrap(wrapped);
    const out = extractSPAData(html);
    const branches = out.filter((r) => r.selector?.startsWith("arr"));
    expect(branches.length).toBeLessThanOrEqual(12);
  });
});
