import { describe, expect, test } from "bun:test";
import { buildCapturedParityBaselines } from "../src/execution/index.js";
import type { EndpointDescriptor } from "../src/types/skill.js";

describe("browser truth lifecycle evidence", () => {
  test("binds a learned endpoint to its actual captured browser response", () => {
    const endpoint = {
      endpoint_id: "orders", method: "GET",
      url_template: "https://shop.example/users/{user_id}/orders?limit={limit}",
    } as EndpointDescriptor;
    const baselines = buildCapturedParityBaselines([endpoint], [
      { url: "https://shop.example/users/42/orders?limit=10", method: "GET", response_body: JSON.stringify({ items: [{ id: 7 }] }) },
    ]);
    expect(baselines).toEqual({ orders: { items: [{ id: 7 }] } });
  });

  test("refuses an ambiguous baseline when one template matched multiple parameter values", () => {
    const endpoint = {
      endpoint_id: "search", method: "GET",
      url_template: "https://shop.example/search?q={q}",
    } as EndpointDescriptor;
    expect(buildCapturedParityBaselines([endpoint], [
      { url: "https://shop.example/search?q=alpha", method: "GET", response_body: "{\"id\":1}" },
      { url: "https://shop.example/search?q=beta", method: "GET", response_body: "{\"id\":2}" },
    ])).toEqual({});
  });

  test("does not invent evidence from unrelated capture metadata", () => {
    const endpoint = {
      endpoint_id: "orders", method: "GET",
      url_template: "https://shop.example/users/{user_id}/orders",
    } as EndpointDescriptor;
    expect(buildCapturedParityBaselines([endpoint], [
      { url: "https://shop.example/analytics", method: "POST", response_body: "{}" },
    ])).toEqual({});
  });
});
