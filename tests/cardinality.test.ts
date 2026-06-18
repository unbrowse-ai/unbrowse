import { describe, it, expect } from "bun:test";
import {
  isListLikeIntent,
  valueLooksLikeSingleItem,
  schemaLooksLikeSingleItem,
  resolutionCardinalityMatches,
  cardinalityMatches,
  routeLooksLikeSingleItem,
  urlPathLooksListLike,
} from "../src/values/cardinality.js";

const PRODUCT = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Frozen Risoles",
  description: "Anyone keen to try?",
  image: ["https://x/a.jpg", "https://x/b.jpg"],
  offers: { "@type": "Offer", price: "8", priceCurrency: "SGD" },
};

describe("isListLikeIntent", () => {
  it("matches collection verbs", () => {
    for (const i of ["find good food", "search carousell", "list food items", "browse listings", "show me the catalog"]) {
      expect(isListLikeIntent(i)).toBe(true);
    }
  });
  it("does not match a single-record intent", () => {
    expect(isListLikeIntent("get the price of this product")).toBe(false);
    expect(isListLikeIntent("what is the weather")).toBe(false);
  });
});

describe("valueLooksLikeSingleItem", () => {
  it("a schema.org Product is a single item", () => {
    expect(valueLooksLikeSingleItem(PRODUCT)).toBe(true);
  });
  it("an array is a list", () => {
    expect(valueLooksLikeSingleItem([PRODUCT, PRODUCT])).toBe(false);
  });
  it("a collection container is a list", () => {
    expect(valueLooksLikeSingleItem({ results: [PRODUCT] })).toBe(false);
    expect(valueLooksLikeSingleItem({ itemListElement: [PRODUCT] })).toBe(false);
    expect(valueLooksLikeSingleItem({ products: [PRODUCT] })).toBe(false);
  });
  it("an object with an array-of-objects property is a list", () => {
    expect(valueLooksLikeSingleItem({ foo: "x", listings: [{ a: 1 }] })).toBe(false);
  });
  it("a plain non-item object is not flagged (conservative)", () => {
    expect(valueLooksLikeSingleItem({ temperature: 20, city: "SG" })).toBe(false);
  });
  it("null / scalar → not a single item", () => {
    expect(valueLooksLikeSingleItem(null)).toBe(false);
    expect(valueLooksLikeSingleItem("x")).toBe(false);
  });
});

describe("schemaLooksLikeSingleItem (schema twin)", () => {
  it("Product schema is single", () => {
    expect(schemaLooksLikeSingleItem({ type: "object", properties: { "@type": {}, name: {}, offers: {} } })).toBe(true);
  });
  it("array schema / results container is a list", () => {
    expect(schemaLooksLikeSingleItem({ type: "array", items: { type: "object" } })).toBe(false);
    expect(schemaLooksLikeSingleItem({ type: "object", properties: { results: {} } })).toBe(false);
  });
});

describe("resolutionCardinalityMatches — the ledger-replay guard", () => {
  it("rejects a single product replayed for a list intent (the Carousell bug)", () => {
    expect(resolutionCardinalityMatches("find good food listings with titles and prices", PRODUCT)).toBe(false);
    expect(resolutionCardinalityMatches("list food items with titles and prices", PRODUCT)).toBe(false);
  });
  it("accepts a list value for a list intent", () => {
    expect(resolutionCardinalityMatches("find good food", { results: [PRODUCT, PRODUCT] })).toBe(true);
    expect(resolutionCardinalityMatches("find good food", [PRODUCT, PRODUCT])).toBe(true);
  });
  it("accepts a single product for a single-item intent", () => {
    expect(resolutionCardinalityMatches("get the price of this product", PRODUCT)).toBe(true);
  });
});

describe("cardinalityMatches — the common gate (value | schema | route)", () => {
  const productRoute = { url_template: "https://x.com/p/risoles-123/", response_schema: { type: "object", properties: { "@type": {}, name: {}, offers: {} } } };
  const listRoute = { url_template: "https://x.com/search/{q}" };

  it("value subject: list intent rejects a single item, accepts a collection", () => {
    expect(cardinalityMatches("find good food", { kind: "value", value: PRODUCT })).toBe(false);
    expect(cardinalityMatches("find good food", { kind: "value", value: { results: [PRODUCT, PRODUCT] } })).toBe(true);
  });
  it("schema subject: list intent rejects a single-item schema", () => {
    expect(cardinalityMatches("list products", { kind: "schema", schema: { type: "object", properties: { "@type": {}, name: {}, offers: {} } } })).toBe(false);
    expect(cardinalityMatches("list products", { kind: "schema", schema: { type: "array", items: { type: "object" } } })).toBe(true);
  });
  it("route subject: list intent rejects a single-item route, accepts a listing route", () => {
    expect(cardinalityMatches("find good food", { kind: "route", route: productRoute })).toBe(false);
    expect(cardinalityMatches("find good food", { kind: "route", route: listRoute })).toBe(true);
  });
  it("detail intent admits anything (any subject kind)", () => {
    expect(cardinalityMatches("get this product", { kind: "value", value: PRODUCT })).toBe(true);
    expect(cardinalityMatches("get this product", { kind: "route", route: productRoute })).toBe(true);
  });
  it("contextUrl path can imply a list intent even when intent text is terse", () => {
    // "get" alone is not list-like, but a /search/ context page is.
    expect(cardinalityMatches("get them", { kind: "value", value: PRODUCT }, { contextUrl: "https://x.com/search/food" })).toBe(false);
    expect(cardinalityMatches("get them", { kind: "value", value: PRODUCT }, { contextUrl: "https://x.com/p/item-1/" })).toBe(true);
  });
});

describe("routeLooksLikeSingleItem + urlPathLooksListLike", () => {
  it("detail routes are single items; listing routes are not", () => {
    expect(routeLooksLikeSingleItem({ url_template: "https://x.com/p/risoles-123/" })).toBe(true);
    expect(routeLooksLikeSingleItem({ url_template: "https://x.com/search/food" })).toBe(false);
    expect(routeLooksLikeSingleItem({ url_template: "https://www.carousell.sg/food/q/" })).toBe(false);
  });
  it("urlPathLooksListLike detects search/results/category paths", () => {
    expect(urlPathLooksListLike("https://x.com/search/food")).toBe(true);
    expect(urlPathLooksListLike("https://x.com/categories/food-1011/")).toBe(true);
    expect(urlPathLooksListLike("https://x.com/p/item-1/")).toBe(false);
    expect(urlPathLooksListLike(undefined)).toBe(false);
  });
});
