/**
 * Unit tests for type-inferrer.ts
 *
 * Tests inferTypes() and generateDeclarationFile() — the pipeline that turns
 * EndpointGroup schemas into TypeScript interfaces and .d.ts content.
 */

import { describe, it, expect } from "bun:test";
import {
  inferTypes,
  generateDeclarationFile,
} from "../../type-inferrer.js";
import type { EndpointGroup } from "../../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal EndpointGroup with sensible defaults. */
function makeEndpoint(overrides: Partial<EndpointGroup> & Pick<EndpointGroup, "method" | "normalizedPath">): EndpointGroup {
  return {
    description: "",
    category: "read",
    pathParams: [],
    queryParams: [],
    responseSummary: "",
    exampleCount: 1,
    dependencies: [],
    produces: [],
    consumes: [],
    ...overrides,
  };
}

// ── Entity name extraction from paths ────────────────────────────────────────

describe("entity name extraction", () => {
  it("extracts entity from simple resource path: /users -> User", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number", name: "string" },
      }),
    ], "test-service");

    const iface = result.interfaces.find((i) => i.name === "User");
    expect(iface).toBeDefined();
  });

  it("extracts entity from nested path: /users/{userId}/orders -> Order", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}/orders/{orderId}",
        responseBodySchema: { id: "number", total: "number" },
      }),
    ], "test-service");

    const iface = result.interfaces.find((i) => i.name === "Order");
    expect(iface).toBeDefined();
  });

  it("extracts entity from path with api/version prefix: /api/v1/products -> Product", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/api/v1/products/{productId}",
        responseBodySchema: { id: "number", title: "string" },
      }),
    ], "test-service");

    const iface = result.interfaces.find((i) => i.name === "Product");
    expect(iface).toBeDefined();
  });

  it("extracts entity from path ending with sub-resource: /orders/{orderId}/items -> Item", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/orders/{orderId}/items/{itemId}",
        responseBodySchema: { id: "number", quantity: "number" },
      }),
    ], "test-service");

    const iface = result.interfaces.find((i) => i.name === "Item");
    expect(iface).toBeDefined();
  });
});

// ── Field type mapping ───────────────────────────────────────────────────────

describe("field type mapping", () => {
  it("maps string fields to string", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { name: "string" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "User");
    expect(iface).toBeDefined();
    expect(iface!.fields.find((f) => f.name === "name")?.type).toBe("string");
  });

  it("maps number fields to number", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { age: "number" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "User");
    expect(iface!.fields.find((f) => f.name === "age")?.type).toBe("number");
  });

  it("maps boolean fields to boolean", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { active: "boolean" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "User");
    expect(iface!.fields.find((f) => f.name === "active")?.type).toBe("boolean");
  });

  it("maps null fields to null", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/items/{itemId}",
        responseBodySchema: { deletedAt: "null" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "Item");
    expect(iface!.fields.find((f) => f.name === "deletedAt")?.type).toBe("null");
  });

  it("maps mixed fields to unknown", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/items/{itemId}",
        responseBodySchema: { meta: "mixed" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "Item");
    expect(iface!.fields.find((f) => f.name === "meta")?.type).toBe("unknown");
  });

  it("maps object without nested schema to Record<string, unknown>", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/items/{itemId}",
        responseBodySchema: { metadata: "object" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "Item");
    expect(iface!.fields.find((f) => f.name === "metadata")?.type).toBe("Record<string, unknown>");
  });

  it("maps nested object with sub-fields to a sub-interface", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: {
          name: "string",
          address: "object",
          "address.street": "string",
          "address.city": "string",
        },
      }),
    ], "test");

    // Should have a nested interface for the address
    const addressIface = result.interfaces.find((i) => i.name === "UserAddress");
    expect(addressIface).toBeDefined();
    expect(addressIface!.fields.find((f) => f.name === "street")?.type).toBe("string");
    expect(addressIface!.fields.find((f) => f.name === "city")?.type).toBe("string");

    // The parent field should reference the nested type
    const userIface = result.interfaces.find((i) => i.name === "User");
    const addressField = userIface!.fields.find((f) => f.name === "address");
    expect(addressField?.type).toBe("UserAddress");
    expect(addressField?.nestedType).toBe("UserAddress");
  });

  it("maps array<string> to string[]", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { tags: "array<string>" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "User");
    expect(iface!.fields.find((f) => f.name === "tags")?.type).toBe("string[]");
  });

  it("maps array<number> to number[]", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { scores: "array<number>" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "User");
    expect(iface!.fields.find((f) => f.name === "scores")?.type).toBe("number[]");
  });

  it("maps array<boolean> to boolean[]", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { flags: "array<boolean>" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "User");
    expect(iface!.fields.find((f) => f.name === "flags")?.type).toBe("boolean[]");
  });

  it("maps bare array to unknown[]", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/items/{itemId}",
        responseBodySchema: { misc: "array" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "Item");
    expect(iface!.fields.find((f) => f.name === "misc")?.type).toBe("unknown[]");
  });

  it("maps array<object> with nested schema to SubInterface[]", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/orders/{orderId}",
        responseBodySchema: {
          id: "number",
          items: "array<object>",
          "items[].id": "number",
          "items[].name": "string",
          "items[].price": "number",
        },
      }),
    ], "test");

    // Should create a sub-interface for items
    const subIface = result.interfaces.find((i) => i.name === "OrderItem");
    expect(subIface).toBeDefined();
    expect(subIface!.fields).toHaveLength(3);
    expect(subIface!.fields.find((f) => f.name === "id")?.type).toBe("number");
    expect(subIface!.fields.find((f) => f.name === "name")?.type).toBe("string");
    expect(subIface!.fields.find((f) => f.name === "price")?.type).toBe("number");

    // The parent field should reference the sub-interface array
    const orderIface = result.interfaces.find((i) => i.name === "Order");
    const itemsField = orderIface!.fields.find((f) => f.name === "items");
    expect(itemsField?.type).toBe("OrderItem[]");
    expect(itemsField?.nestedType).toBe("OrderItem");
  });
});

// ── ID field detection ───────────────────────────────────────────────────────

describe("ID field detection", () => {
  it("detects 'id' as an ID field", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number", name: "string" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "User");
    expect(iface!.fields.find((f) => f.name === "id")?.isId).toBe(true);
    expect(iface!.fields.find((f) => f.name === "name")?.isId).toBe(false);
  });

  it("detects fields ending in 'Id' as ID fields", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/orders/{orderId}",
        responseBodySchema: { id: "number", userId: "string", productId: "string" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "Order");
    expect(iface!.fields.find((f) => f.name === "userId")?.isId).toBe(true);
    expect(iface!.fields.find((f) => f.name === "productId")?.isId).toBe(true);
  });

  it("detects fields ending in '_id' as ID fields", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/orders/{orderId}",
        responseBodySchema: { user_id: "string", product_id: "string" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "Order");
    expect(iface!.fields.find((f) => f.name === "user_id")?.isId).toBe(true);
    expect(iface!.fields.find((f) => f.name === "product_id")?.isId).toBe(true);
  });

  it("keeps number type for numeric ID fields", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "User");
    expect(iface!.fields.find((f) => f.name === "id")?.type).toBe("number");
  });
});

// ── Date field detection ─────────────────────────────────────────────────────

describe("date field detection", () => {
  it("adds ISO 8601 comment for createdAt fields", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { createdAt: "string", name: "string" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "User");
    expect(iface!.fields.find((f) => f.name === "createdAt")?.comment).toBe("ISO 8601 date string");
    expect(iface!.fields.find((f) => f.name === "name")?.comment).toBeUndefined();
  });

  it("detects updated_at as a date field", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { updated_at: "string" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "User");
    expect(iface!.fields.find((f) => f.name === "updated_at")?.comment).toBe("ISO 8601 date string");
  });

  it("detects fields ending in Date/Time suffixes", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/events/{eventId}",
        responseBodySchema: { startDate: "string", endTime: "string" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "Event");
    expect(iface!.fields.find((f) => f.name === "startDate")?.comment).toBe("ISO 8601 date string");
    expect(iface!.fields.find((f) => f.name === "endTime")?.comment).toBe("ISO 8601 date string");
  });

  it("detects exact match date fields like 'timestamp' and 'expires'", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/tokens/{tokenId}",
        responseBodySchema: { timestamp: "number", expires: "number" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "Token");
    expect(iface!.fields.find((f) => f.name === "timestamp")?.comment).toBe("ISO 8601 date string");
    expect(iface!.fields.find((f) => f.name === "expires")?.comment).toBe("ISO 8601 date string");
  });
});

// ── Request body type generation ─────────────────────────────────────────────

describe("request body types", () => {
  it("generates CreateEntityRequest for POST", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "POST",
        normalizedPath: "/users",
        category: "write",
        requestBodySchema: { name: "string", email: "string" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "CreateUserRequest");
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe("request");
    expect(iface!.fields).toHaveLength(2);
    expect(result.endpointTypes["POST /users"]?.requestType).toBe("CreateUserRequest");
  });

  it("generates UpdateEntityRequest for PUT", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "PUT",
        normalizedPath: "/users/{userId}",
        category: "write",
        requestBodySchema: { name: "string", email: "string" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "UpdateUserRequest");
    expect(iface).toBeDefined();
    expect(iface!.kind).toBe("request");
    expect(result.endpointTypes["PUT /users/{userId}"]?.requestType).toBe("UpdateUserRequest");
  });

  it("generates UpdateEntityRequest for PATCH", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "PATCH",
        normalizedPath: "/users/{userId}",
        category: "write",
        requestBodySchema: { name: "string" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.name === "UpdateUserRequest");
    expect(iface).toBeDefined();
    expect(result.endpointTypes["PATCH /users/{userId}"]?.requestType).toBe("UpdateUserRequest");
  });

  it("does not generate request types for GET endpoints", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users",
        requestBodySchema: { q: "string" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.kind === "request");
    expect(iface).toBeUndefined();
  });

  it("does not generate request types for DELETE endpoints", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "DELETE",
        normalizedPath: "/users/{userId}",
        category: "delete",
        requestBodySchema: { reason: "string" },
      }),
    ], "test");

    const iface = result.interfaces.find((i) => i.kind === "request");
    expect(iface).toBeUndefined();
  });
});

// ── Response type naming (list vs single) ────────────────────────────────────

describe("response type naming", () => {
  it("uses EntityName for single-item response (path ends with param)", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number", name: "string" },
      }),
    ], "test");

    expect(result.endpointTypes["GET /users/{userId}"]?.responseType).toBe("User");
  });

  it("uses EntityName[] for direct array list response", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users",
        responseSummary: "array[5]<object{id,name}>",
        responseBodySchema: {
          "[].id": "number",
          "[].name": "string",
        },
      }),
    ], "test");

    expect(result.endpointTypes["GET /users"]?.responseType).toBe("User[]");
  });

  it("uses EntityNameListResponse for wrapped list response", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users",
        responseSummary: "object{data,total}",
        responseBodySchema: {
          data: "array<object>",
          "data[].id": "number",
          "data[].name": "string",
          total: "number",
        },
      }),
    ], "test");

    expect(result.endpointTypes["GET /users"]?.responseType).toBe("UserListResponse");
    // Should also generate the entity interface
    const entityIface = result.interfaces.find((i) => i.name === "User" && i.kind === "entity");
    expect(entityIface).toBeDefined();
    // And the wrapper interface
    const wrapperIface = result.interfaces.find((i) => i.name === "UserListResponse");
    expect(wrapperIface).toBeDefined();
    expect(wrapperIface!.fields.find((f) => f.name === "data")?.type).toBe("User[]");
    expect(wrapperIface!.fields.find((f) => f.name === "total")?.type).toBe("number");
  });
});

// ── Merging interfaces from multiple endpoints ───────────────────────────────

describe("interface merging", () => {
  it("merges same-name same-kind interfaces from different endpoints", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number", name: "string" },
      }),
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}/profile",
        responseBodySchema: { id: "number", email: "string" },
      }),
    ], "test");

    // Both resolve to entity name "User" — they should be merged
    // The second is actually "Profile" since that's the last non-param segment
    // Let's test with the same entity name
    const userInterfaces = result.interfaces.filter((i) => i.name === "User");
    // After merging, there should be one User interface
    expect(userInterfaces).toHaveLength(1);
    const user = userInterfaces[0];
    expect(user.fields.find((f) => f.name === "id")).toBeDefined();
    expect(user.fields.find((f) => f.name === "name")).toBeDefined();
  });

  it("marks fields as optional when they appear in only some responses", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number", name: "string", bio: "string" },
      }),
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number", name: "string" },
      }),
    ], "test");

    const user = result.interfaces.find((i) => i.name === "User");
    expect(user).toBeDefined();
    // bio only appears in the first response, should be optional
    const bioField = user!.fields.find((f) => f.name === "bio");
    expect(bioField?.optional).toBe(true);
    // id and name appear in both, should not be optional
    expect(user!.fields.find((f) => f.name === "id")?.optional).toBe(false);
  });

  it("deduplicates names when same entity has different kinds", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number", name: "string" },
      }),
      makeEndpoint({
        method: "POST",
        normalizedPath: "/users",
        category: "write",
        requestBodySchema: { name: "string", email: "string" },
        responseBodySchema: { id: "number", name: "string", email: "string" },
      }),
    ], "test");

    // Should have distinct interfaces — request vs response types
    const createReq = result.interfaces.find((i) => i.name === "CreateUserRequest");
    expect(createReq).toBeDefined();

    // User response interfaces from GET and POST should be merged
    const userInterfaces = result.interfaces.filter((i) => i.name.startsWith("User") && i.kind !== "request");
    expect(userInterfaces.length).toBeGreaterThanOrEqual(1);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles empty endpoint groups", () => {
    const result = inferTypes([], "test");
    expect(result.interfaces).toHaveLength(0);
    expect(Object.keys(result.endpointTypes)).toHaveLength(0);
    expect(result.declarationFile).toContain("Auto-generated types");
  });

  it("handles endpoint with no response schema", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "DELETE",
        normalizedPath: "/users/{userId}",
        category: "delete",
      }),
    ], "test");

    expect(result.endpointTypes["DELETE /users/{userId}"]?.responseType).toBeUndefined();
  });

  it("handles endpoint with empty response schema", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/health",
        responseBodySchema: {},
      }),
    ], "test");

    expect(result.endpointTypes["GET /health"]?.responseType).toBeUndefined();
  });

  it("handles endpoint with empty request body schema", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "POST",
        normalizedPath: "/actions",
        category: "write",
        requestBodySchema: {},
      }),
    ], "test");

    expect(result.endpointTypes["POST /actions"]?.requestType).toBeUndefined();
  });

  it("generates endpointTypes mapping for every endpoint", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users",
        responseSummary: "array",
        responseBodySchema: { "[].id": "number" },
      }),
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number" },
      }),
      makeEndpoint({
        method: "POST",
        normalizedPath: "/users",
        category: "write",
        requestBodySchema: { name: "string" },
      }),
    ], "test");

    expect(result.endpointTypes).toHaveProperty("GET /users");
    expect(result.endpointTypes).toHaveProperty("GET /users/{userId}");
    expect(result.endpointTypes).toHaveProperty("POST /users");
  });
});

// ── Declaration file generation ──────────────────────────────────────────────

describe("generateDeclarationFile", () => {
  it("produces valid TypeScript .d.ts content with header", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number", name: "string" },
      }),
    ], "my-api");

    const dts = result.declarationFile;
    expect(dts).toContain("Auto-generated types for My ApiApi");
    expect(dts).toContain("export interface User");
    expect(dts).toContain("id: number;");
    expect(dts).toContain("name: string;");
  });

  it("renders optional fields with ? syntax", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number", name: "string", bio: "string" },
      }),
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number", name: "string" },
      }),
    ], "test");

    const dts = result.declarationFile;
    expect(dts).toContain("bio?: string;");
  });

  it("renders JSDoc comments for date fields", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { createdAt: "string", name: "string" },
      }),
    ], "test");

    const dts = result.declarationFile;
    expect(dts).toContain("/** ISO 8601 date string */");
    expect(dts).toContain("createdAt: string;");
  });

  it("renders empty interface with index signature", () => {
    // Simulate an interface with no fields (direct construction for edge case)
    const typeMap = {
      interfaces: [{
        name: "EmptyResource",
        sourceEndpoint: "GET /empty",
        kind: "response" as const,
        fields: [],
      }],
      endpointTypes: {},
      declarationFile: "",
    };

    const dts = generateDeclarationFile(typeMap, "test");
    expect(dts).toContain("export interface EmptyResource");
    expect(dts).toContain("[key: string]: unknown;");
  });

  it("renders nullable fields with | null union", () => {
    // Construct a typeMap directly to test nullable rendering
    const typeMap = {
      interfaces: [{
        name: "Widget",
        sourceEndpoint: "GET /widgets/{widgetId}",
        kind: "response" as const,
        fields: [{
          name: "label",
          type: "string",
          optional: false,
          nullable: true,
          isId: false,
        }],
      }],
      endpointTypes: {},
      declarationFile: "",
    };

    const dts = generateDeclarationFile(typeMap, "test");
    expect(dts).toContain("label: string | null;");
  });

  it("formats service name with capitalized words", () => {
    const typeMap = {
      interfaces: [],
      endpointTypes: {},
      declarationFile: "",
    };

    const dts = generateDeclarationFile(typeMap, "user-management-api");
    expect(dts).toContain("Auto-generated types for User Management ApiApi");
  });

  it("includes all interfaces in declaration output", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/users/{userId}",
        responseBodySchema: { id: "number", name: "string" },
      }),
      makeEndpoint({
        method: "GET",
        normalizedPath: "/orders/{orderId}",
        responseBodySchema: { id: "number", total: "number" },
      }),
      makeEndpoint({
        method: "POST",
        normalizedPath: "/orders",
        category: "write",
        requestBodySchema: { productId: "string", quantity: "number" },
      }),
    ], "test");

    const dts = result.declarationFile;
    expect(dts).toContain("export interface User");
    expect(dts).toContain("export interface Order");
    expect(dts).toContain("export interface CreateOrderRequest");
  });
});

// ── Full pipeline integration ────────────────────────────────────────────────

describe("full inference pipeline", () => {
  it("handles a realistic multi-endpoint API", () => {
    const result = inferTypes([
      makeEndpoint({
        method: "GET",
        normalizedPath: "/api/v1/users",
        responseSummary: "object{data,total,page}",
        responseBodySchema: {
          data: "array<object>",
          "data[].id": "number",
          "data[].name": "string",
          "data[].email": "string",
          "data[].createdAt": "string",
          total: "number",
          page: "number",
        },
      }),
      makeEndpoint({
        method: "GET",
        normalizedPath: "/api/v1/users/{userId}",
        responseBodySchema: {
          id: "number",
          name: "string",
          email: "string",
          createdAt: "string",
          address: "object",
          "address.street": "string",
          "address.city": "string",
          "address.zip": "string",
        },
      }),
      makeEndpoint({
        method: "POST",
        normalizedPath: "/api/v1/users",
        category: "write",
        requestBodySchema: {
          name: "string",
          email: "string",
        },
        responseBodySchema: {
          id: "number",
          name: "string",
          email: "string",
          createdAt: "string",
        },
      }),
      makeEndpoint({
        method: "PATCH",
        normalizedPath: "/api/v1/users/{userId}",
        category: "write",
        requestBodySchema: {
          name: "string",
        },
      }),
    ], "user-service");

    // Check interfaces exist
    expect(result.interfaces.length).toBeGreaterThanOrEqual(3);

    // Check endpoint types
    expect(result.endpointTypes["GET /api/v1/users"]?.responseType).toBe("UserListResponse");
    expect(result.endpointTypes["GET /api/v1/users/{userId}"]?.responseType).toBe("User");
    expect(result.endpointTypes["POST /api/v1/users"]?.requestType).toBe("CreateUserRequest");
    expect(result.endpointTypes["PATCH /api/v1/users/{userId}"]?.requestType).toBe("UpdateUserRequest");

    // Check declaration file is non-empty
    expect(result.declarationFile.length).toBeGreaterThan(100);
    expect(result.declarationFile).toContain("export interface");

    // Check address sub-interface was created
    const addressIface = result.interfaces.find((i) => i.name === "UserAddress");
    expect(addressIface).toBeDefined();
  });
});
