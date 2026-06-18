import { describe, it, expect } from "bun:test";
import {
  looksLikeSingleItemRoute,
  schemaLooksLikeSingleItem,
  isResolveUsableEndpointForIntent,
} from "../src/orchestrator/index.js";

// The witnessed Carousell hijack: a single schema.org Product detail route
// answering a list/search intent. Cardinality guard (Ezekiel 47:10).
const PRODUCT_SCHEMA = {
  type: "object",
  properties: {
    "@context": { type: "string" },
    "@type": { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    image: { type: "array", items: { type: "string" } }, // array of strings, not objects
    offers: { type: "object", properties: { price: { type: "string" } } },
  },
};

const productEndpoint = (url: string) => ({
  endpoint_id: "ep1",
  method: "GET",
  url_template: url,
  response_schema: PRODUCT_SCHEMA,
}) as any;

describe("schemaLooksLikeSingleItem", () => {
  it("schema.org Product (object, name+offers, no list container) → single item", () => {
    expect(schemaLooksLikeSingleItem(PRODUCT_SCHEMA)).toBe(true);
  });
  it("top-level array → collection, not single", () => {
    expect(schemaLooksLikeSingleItem({ type: "array", items: { type: "object" } })).toBe(false);
  });
  it("object with itemListElement → collection", () => {
    expect(schemaLooksLikeSingleItem({ type: "object", properties: { itemListElement: {} } })).toBe(false);
  });
  it("object with a top-level array-of-objects (results) → collection", () => {
    expect(
      schemaLooksLikeSingleItem({ type: "object", properties: { results: { type: "array", items: { type: "object" } } } }),
    ).toBe(false);
  });
  it("plain object without item signals → not a single item", () => {
    expect(schemaLooksLikeSingleItem({ type: "object", properties: { foo: { type: "string" } } })).toBe(false);
  });
  it("non-object input → false", () => {
    expect(schemaLooksLikeSingleItem(null)).toBe(false);
    expect(schemaLooksLikeSingleItem("nope")).toBe(false);
  });
});

describe("looksLikeSingleItemRoute — URL shape", () => {
  it("the Carousell product page is a single item", () => {
    expect(looksLikeSingleItemRoute(productEndpoint("https://www.carousell.sg/p/risoles-frozen-1385340565/"))).toBe(true);
  });
  it("/product/<id>, /item/<id>, /listing/<id> are single items", () => {
    expect(looksLikeSingleItemRoute(productEndpoint("https://x.com/product/abc-123/"))).toBe(true);
    expect(looksLikeSingleItemRoute(productEndpoint("https://x.com/item/99887/"))).toBe(true);
    expect(looksLikeSingleItemRoute(productEndpoint("https://x.com/listing/foo-456789"))).toBe(true);
  });
  it("trailing numeric-id slug or bare id → single item", () => {
    expect(looksLikeSingleItemRoute({ url_template: "https://x.com/widgets/blue-widget-123456" } as any)).toBe(true);
    expect(looksLikeSingleItemRoute({ url_template: "https://x.com/x/778899" } as any)).toBe(true);
  });
  it("listing/search paths are NOT single items (listing wins over trailing id)", () => {
    expect(looksLikeSingleItemRoute({ url_template: "https://www.carousell.sg/categories/food-beverages-1011/" } as any)).toBe(false);
    expect(looksLikeSingleItemRoute({ url_template: "https://www.carousell.sg/search/homemade%20food" } as any)).toBe(false);
    expect(looksLikeSingleItemRoute({ url_template: "https://www.carousell.sg/food/q/" } as any)).toBe(false);
    expect(looksLikeSingleItemRoute({ url_template: "https://x.com/browse?category=food" } as any)).toBe(false);
  });
  it("a parameterised list hole (no detail signal) is not a single item", () => {
    expect(looksLikeSingleItemRoute({ url_template: "https://x.com/{section}/" } as any)).toBe(false);
  });
  it("a parameterised detail route (/p/{id}/) is still a single item", () => {
    expect(looksLikeSingleItemRoute({ url_template: "https://x.com/p/{id}/" } as any)).toBe(true);
  });
});

describe("isResolveUsableEndpointForIntent — cardinality gate end-to-end", () => {
  const ctx = "https://www.carousell.sg/";
  const ep = productEndpoint("https://www.carousell.sg/p/risoles-frozen-1385340565/");

  it("rejects a single product route for a 'find' intent", () => {
    expect(isResolveUsableEndpointForIntent(ep, "find good food", ctx)).toBe(false);
  });
  it("rejects a single product route for a 'list' intent", () => {
    expect(isResolveUsableEndpointForIntent(ep, "list food items with titles and prices", ctx)).toBe(false);
  });
  it("keeps the single product route for a non-list intent (e.g. read this product)", () => {
    expect(isResolveUsableEndpointForIntent(ep, "get the price of this product", ctx)).toBe(true);
  });
  it("keeps a search/category endpoint for a list intent", () => {
    const searchEp = { endpoint_id: "ep2", method: "GET", url_template: "https://www.carousell.sg/search/{q}" } as any;
    expect(isResolveUsableEndpointForIntent(searchEp, "find good food", ctx)).toBe(true);
  });
});
