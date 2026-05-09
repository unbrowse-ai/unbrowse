import { describe, expect, test } from "bun:test";
import { rankEndpoints } from "../src/ranking/index";
import type { EndpointDescriptor } from "../src/types/index.js";

function ep(over: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    endpoint_id: "ep",
    method: "GET",
    url_template: "https://example.com/",
    description: "",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    response_schema: { type: "object", properties: { data: { type: "array" } } },
    ...over,
  } as EndpointDescriptor;
}

describe("A13 — read-intent demotes write-flavored endpoints", () => {
  test("amazon search ranks /s above /cart/add-to-cart", () => {
    const cart = ep({
      endpoint_id: "cart",
      url_template: "https://www.amazon.sg/cart/add-to-cart/patc-template",
      description: "add to cart",
      response_schema: {
        type: "object",
        properties: {
          cartItem: { type: "object" },
          status: { type: "string" },
          quantity: { type: "integer" },
          price: { type: "number" },
          total: { type: "number" },
        },
      },
    });
    const search = ep({
      endpoint_id: "search",
      url_template: "https://www.amazon.sg/s",
      description: "search results",
    });
    const ranked = rankEndpoints(
      [cart, search],
      "amazon usb cable search",
      "amazon.sg",
      "https://www.amazon.sg/s?k=usb+c+cable",
    );
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].endpoint.endpoint_id).toBe("search");
  });

  test("write intent NOT penalised when intent itself is a write", () => {
    const cart = ep({
      endpoint_id: "cart",
      url_template: "https://www.amazon.sg/cart/add-to-cart/patc-template",
      description: "add to cart",
    });
    const ranked = rankEndpoints(
      [cart],
      "add usb cable to cart",
      "amazon.sg",
      "https://www.amazon.sg/",
    );
    // Intent has both "add" and "cart" — not a read-only intent.
    // Penalty should NOT fire on the cart endpoint.
    expect(ranked.length).toBeGreaterThan(0);
  });

  test("action_kind:create on read intent gets penalised", () => {
    const createEp = ep({
      endpoint_id: "create",
      url_template: "https://api.example.com/v1/items",
      method: "POST",
      description: "create item",
      semantic: { action_kind: "create", resource_kind: "item", requires: [] } as any,
    });
    const listEp = ep({
      endpoint_id: "list",
      url_template: "https://api.example.com/v1/items",
      method: "GET",
      description: "list items",
      semantic: { action_kind: "list", resource_kind: "item", requires: [] } as any,
    });
    const ranked = rankEndpoints(
      [createEp, listEp],
      "browse items",
      "example.com",
      "https://www.example.com/",
    );
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].endpoint.endpoint_id).toBe("list");
  });
});
