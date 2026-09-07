import { describe, it, expect } from "bun:test";
import { deriveSearchRouteTemplates, fillSearchRoute } from "../src/execution/search-forms.js";
import { linksFormEntityCollection, entityPointerTemplate } from "../src/values/cardinality.js";

describe("linksFormEntityCollection — a listing page is a net of pointers", () => {
  it("a page with many same-template item links IS a collection", () => {
    const listing = Array.from({ length: 18 }, (_, i) => `/p/item-${1000 + i}/`);
    expect(linksFormEntityCollection(listing)).toBe(true);
  });
  it("fixed-category nav is NOT a collection", () => {
    expect(linksFormEntityCollection(["/store/apps", "/store/games", "/electronics", "/cars"])).toBe(false);
  });
  it("entityPointerTemplate masks ids, ignores fixed nav", () => {
    expect(entityPointerTemplate("/p/risoles-1385340565/")).toBe("p/{id}");
    expect(entityPointerTemplate("/store/apps")).toBeNull();
  });
});

// "Define the pipes all the way down": a JS-SPA search box isn't a <form>, but the
// site exposes its search route in its own links. A repeated sibling-link pattern
// with one varying segment IS the search pipe (the {query} hole). The page defines
// it; the agent fills the query + judges. Witnessed shape: Carousell's homepage.

describe("deriveSearchRouteTemplates — the page defines its own search pipe", () => {
  it("derives /{query}/q/ from Carousell-style trending links", () => {
    const html = `
      <a href="/jbl/q/">JBL</a>
      <a href="/garmin/q/">Garmin</a>
      <a href="/portable-aircon/q/">Aircon</a>
      <a href="/iphone-16-pro/q/">iPhone</a>
      <a href="/psyduck/q/">Psyduck</a>
      <a href="/about">About</a><a href="/help">Help</a>
    `;
    const tmpls = deriveSearchRouteTemplates(html);
    expect(tmpls.length).toBeGreaterThan(0);
    expect(tmpls[0].template).toBe("/{query}/q/");
    expect(tmpls[0].count).toBeGreaterThanOrEqual(4);
  });

  it("derives /search/{query} from a /search/ link family", () => {
    const html = ["bicycle", "shoes", "laptop", "camera", "guitar"]
      .map((q) => `<a href="/search/${q}">${q}</a>`).join("");
    const tmpls = deriveSearchRouteTemplates(html);
    expect(tmpls.some((t) => t.template === "/search/{query}")).toBe(true);
  });

  it("does NOT treat entity-detail links (/p/<id>) as a search route", () => {
    // /p/risoles-138534 etc. — the varying slot carries an id → not a query route.
    const html = Array.from({ length: 8 }, (_, i) => `<a href="/p/item-${1000 + i}/">x</a>`).join("");
    const tmpls = deriveSearchRouteTemplates(html);
    expect(tmpls.some((t) => t.template.includes("p/"))).toBe(false);
  });

  it("ignores fixed nav (too few distinct values to be a search route)", () => {
    const html = `<a href="/store/apps">a</a><a href="/store/games">g</a><a href="/store/books">b</a>`;
    expect(deriveSearchRouteTemplates(html)).toHaveLength(0);
  });

  it("fillSearchRoute fills the {query} hole against an origin", () => {
    expect(fillSearchRoute("https://www.carousell.sg/", "/{query}/q/", "food")).toBe("https://www.carousell.sg/food/q/");
    expect(fillSearchRoute("https://x.com", "/search/{query}", "blue shoes")).toBe("https://x.com/search/blue%20shoes");
  });
});
