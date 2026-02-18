import { describe, it, expect } from "bun:test";
import { selectEndpointGroupsForIntent } from "@getfoundry/unbrowse-core";

describe("selectEndpointGroupsForIntent", () => {
  it("prefers relevant endpoints and drops auth by default", () => {
    const groups: any[] = [
      { method: "GET", normalizedPath: "/markets", description: "List markets", category: "read", pathParams: [], queryParams: [], responseSummary: "", exampleCount: 1, dependencies: [], produces: [], consumes: [], methodName: "listMarkets" },
      { method: "POST", normalizedPath: "/orders", description: "Create order", category: "write", pathParams: [], queryParams: [], responseSummary: "", exampleCount: 1, dependencies: [], produces: [], consumes: [], methodName: "createOrder" },
      { method: "GET", normalizedPath: "/auth/session", description: "Get session", category: "auth", pathParams: [], queryParams: [], responseSummary: "", exampleCount: 1, dependencies: [], produces: [], consumes: [], methodName: "getSession" },
      { method: "GET", normalizedPath: "/feature_flags.json", description: "Flags", category: "other", pathParams: [], queryParams: [], responseSummary: "", exampleCount: 1, dependencies: [], produces: [], consumes: [], methodName: "getFeatureFlags" },
    ];

    const selected = selectEndpointGroupsForIntent(groups as any, "place an order", { limit: 2 });
    expect(selected.length).toBe(2);
    expect(selected.some((g) => g.normalizedPath === "/orders")).toBe(true);
    expect(selected.some((g) => g.category === "auth")).toBe(false);
  });

  it("includes auth endpoints when intent asks for login", () => {
    const groups: any[] = [
      { method: "GET", normalizedPath: "/auth/session", description: "Get session", category: "auth", pathParams: [], queryParams: [], responseSummary: "", exampleCount: 1, dependencies: [], produces: [], consumes: [], methodName: "getSession" },
      { method: "GET", normalizedPath: "/markets", description: "List markets", category: "read", pathParams: [], queryParams: [], responseSummary: "", exampleCount: 1, dependencies: [], produces: [], consumes: [], methodName: "listMarkets" },
    ];

    const selected = selectEndpointGroupsForIntent(groups as any, "login and fetch session", { limit: 2 });
    expect(selected.some((g) => g.category === "auth")).toBe(true);
  });
});
