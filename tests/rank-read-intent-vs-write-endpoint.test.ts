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

  // Regression: bench-gate 010_anchor 2026-05-19. Intent "get dockerhub image
  // tags" → boilerplate stripper yields "dockerhub image tags", with no
  // read-verb left. Original demotion gated on isReadIntent never fired, so
  // a POST GraphQL "Creates post" mutation outranked GET reads.
  test("idempotency=unsafe is demoted when intent is not write-shaped (post-strip)", () => {
    const writeGql = ep({
      endpoint_id: "write_gql",
      url_template: "https://api.scout.docker.com/v1/graphql",
      method: "POST",
      idempotency: "unsafe",
      description: "Creates post with imagesummariesbydigest, extensions, and ids",
    });
    const readGql = ep({
      endpoint_id: "read_gql",
      url_template: "https://api.scout.docker.com/v1/graphql",
      method: "GET",
      description: "Returns resource details",
    });
    // Boilerplate-stripped intent — no read verb survives, mimicking the
    // queryIntent the orchestrator passes to rankEndpoints in production.
    const ranked = rankEndpoints(
      [writeGql, readGql],
      "dockerhub image tags",
      "docker.com",
      "https://hub.docker.com/r/library/nginx/tags",
    );
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].endpoint.endpoint_id).toBe("read_gql");
  });

  test("description-prefix mutation verb is demoted when intent is not write-shaped", () => {
    const createDesc = ep({
      endpoint_id: "create_desc",
      url_template: "https://api.example.com/v1/articles",
      method: "POST",
      description: "Creates article with title, body, and tags",
    });
    const readDesc = ep({
      endpoint_id: "read_desc",
      url_template: "https://api.example.com/v1/articles",
      method: "GET",
      description: "Returns article listings",
    });
    // Intent has no read or write verb — just the noun. New demotion must
    // still fire on the description prefix.
    const ranked = rankEndpoints(
      [createDesc, readDesc],
      "article listings",
      "example.com",
      "https://www.example.com/",
    );
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].endpoint.endpoint_id).toBe("read_desc");
  });
});
