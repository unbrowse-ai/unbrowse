import { describe, expect, it } from "bun:test";
import { buildSkillOperationGraph } from "../src/graph/index.js";
import type { EndpointDescriptor } from "../src/types/index.js";
import { GraphSession } from "../src/graph/session.js";

/** Helper to create a minimal EndpointDescriptor for tests. */
function endpoint(
  endpoint_id: string,
  method: EndpointDescriptor["method"],
  url_template: string,
  opts?: {
    description?: string;
    example_fields?: string[];
    semantic?: EndpointDescriptor["semantic"];
    response_schema?: EndpointDescriptor["response_schema"];
  },
): EndpointDescriptor {
  return {
    endpoint_id,
    method,
    url_template,
    description: opts?.description ?? `${method} ${url_template}`,
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
    response_schema: opts?.response_schema ?? {
      type: "object",
      inferred_from_samples: 1,
      properties: Object.fromEntries(
        (opts?.example_fields ?? []).map((field) => [
          field.replace(/\[\].*$/, "").split(".").pop() ?? field,
          { type: "string", inferred_from_samples: 1 },
        ]),
      ),
    },
    semantic: opts?.semantic,
  };
}

describe("GraphSession", () => {
  describe("indexRequest", () => {
    it("matches a request URL to the correct operation", () => {
      const graph = buildSkillOperationGraph([
        endpoint("list_users", "GET", "https://api.example.com/users", {
          example_fields: ["id", "name", "email"],
        }),
        endpoint("get_user", "GET", "https://api.example.com/users/{user_id}", {
          example_fields: ["id", "name", "email"],
        }),
      ]);

      const session = new GraphSession(graph);

      const result = session.indexRequest({
        url: "https://api.example.com/users",
        method: "GET",
      });

      expect(result).not.toBeNull();
      expect(result!.operation_id).toBe("list_users");
    });

    it("returns null for unmatched URLs", () => {
      const graph = buildSkillOperationGraph([
        endpoint("list_users", "GET", "https://api.example.com/users", {
          example_fields: ["id", "name"],
        }),
      ]);

      const session = new GraphSession(graph);

      const result = session.indexRequest({
        url: "https://api.example.com/posts",
        method: "GET",
      });

      expect(result).toBeNull();
    });

    it("returns null when method does not match", () => {
      const graph = buildSkillOperationGraph([
        endpoint("create_user", "POST", "https://api.example.com/users", {
          example_fields: ["id"],
        }),
      ]);

      const session = new GraphSession(graph);

      const result = session.indexRequest({
        url: "https://api.example.com/users",
        method: "GET",
      });

      expect(result).toBeNull();
    });
  });

  describe("template URL matching with path parameters", () => {
    it("matches URLs with path parameters", () => {
      const graph = buildSkillOperationGraph([
        endpoint(
          "get_user_post",
          "GET",
          "https://api.example.com/users/{user_id}/posts/{post_id}",
          { example_fields: ["title", "body"] },
        ),
      ]);

      const session = new GraphSession(graph);

      const result = session.indexRequest({
        url: "https://api.example.com/users/123/posts/456",
        method: "GET",
      });

      expect(result).not.toBeNull();
      expect(result!.operation_id).toBe("get_user_post");
    });

    it("matches URLs with query strings", () => {
      const graph = buildSkillOperationGraph([
        endpoint("search_users", "GET", "https://api.example.com/users", {
          example_fields: ["id", "name"],
        }),
      ]);

      const session = new GraphSession(graph);

      const result = session.indexRequest({
        url: "https://api.example.com/users?q=test&page=1",
        method: "GET",
      });

      expect(result).not.toBeNull();
      expect(result!.operation_id).toBe("search_users");
    });

    it("does not match partial path segments", () => {
      const graph = buildSkillOperationGraph([
        endpoint("list_users", "GET", "https://api.example.com/users", {
          example_fields: ["id"],
        }),
      ]);

      const session = new GraphSession(graph);

      // /users-admin should NOT match /users
      const result = session.indexRequest({
        url: "https://api.example.com/users-admin",
        method: "GET",
      });

      expect(result).toBeNull();
    });
  });

  describe("known bindings extraction from JSON response bodies", () => {
    it("extracts binding values from JSON response bodies", () => {
      const graph = buildSkillOperationGraph([
        endpoint("get_user", "GET", "https://api.example.com/users/{user_id}", {
          example_fields: ["user_id", "name", "email"],
          semantic: {
            action_kind: "get",
            resource_kind: "user",
            confidence: 0.9,
            requires: [
              { key: "user_id", type: "string", required: true, source: "path_params" },
            ],
            provides: [
              { key: "user_id", type: "string" },
              { key: "name", type: "string" },
              { key: "email", type: "string" },
            ],
          },
        }),
      ]);

      const session = new GraphSession(graph);

      const result = session.indexRequest({
        url: "https://api.example.com/users/42",
        method: "GET",
        response_body: JSON.stringify({
          user_id: "42",
          name: "Alice",
          email: "alice@example.com",
        }),
      });

      expect(result).not.toBeNull();
      expect(result!.extracted_bindings).toEqual({
        user_id: "42",
        name: "Alice",
        email: "alice@example.com",
      });

      // Known bindings should now include extracted values
      const known = session.getKnownBindings();
      expect(known.user_id).toBe("42");
      expect(known.name).toBe("Alice");
      expect(known.email).toBe("alice@example.com");
    });

    it("handles non-JSON response bodies gracefully", () => {
      const graph = buildSkillOperationGraph([
        endpoint("get_page", "GET", "https://example.com/page", {
          example_fields: ["title"],
          semantic: {
            action_kind: "get",
            resource_kind: "page",
            confidence: 0.9,
            provides: [{ key: "title", type: "string" }],
          },
        }),
      ]);

      const session = new GraphSession(graph);

      const result = session.indexRequest({
        url: "https://example.com/page",
        method: "GET",
        response_body: "<html><body>Not JSON</body></html>",
      });

      expect(result).not.toBeNull();
      expect(result!.extracted_bindings).toEqual({});
    });

    it("extracts bindings from nested objects (one level deep)", () => {
      const graph = buildSkillOperationGraph([
        endpoint("get_profile", "GET", "https://api.example.com/profile", {
          example_fields: ["avatar_url"],
          semantic: {
            action_kind: "get",
            resource_kind: "profile",
            confidence: 0.9,
            provides: [{ key: "avatar_url", type: "string" }],
          },
        }),
      ]);

      const session = new GraphSession(graph);

      session.indexRequest({
        url: "https://api.example.com/profile",
        method: "GET",
        response_body: JSON.stringify({
          data: {
            avatar_url: "https://cdn.example.com/avatar.png",
          },
        }),
      });

      const known = session.getKnownBindings();
      expect(known.avatar_url).toBe("https://cdn.example.com/avatar.png");
    });
  });

  describe("getRunnableOperations", () => {
    it("returns ops whose bindings are all satisfied", () => {
      const graph = buildSkillOperationGraph([
        endpoint("list_users", "GET", "https://api.example.com/users", {
          example_fields: ["user_id", "name"],
          semantic: {
            action_kind: "list",
            resource_kind: "users",
            confidence: 0.9,
            provides: [{ key: "user_id", type: "string" }],
          },
        }),
        endpoint("get_user", "GET", "https://api.example.com/users/{user_id}", {
          example_fields: ["name", "email"],
          semantic: {
            action_kind: "get",
            resource_kind: "user",
            confidence: 0.9,
            requires: [
              { key: "user_id", type: "string", required: true, source: "path_params" },
            ],
            provides: [
              { key: "name", type: "string" },
              { key: "email", type: "string" },
            ],
          },
        }),
      ]);

      const session = new GraphSession(graph);

      // Before any indexing, only operations without required bindings are runnable
      const before = session.getRunnableOperations();
      const beforeIds = before.map((op) => op.operation_id);
      expect(beforeIds).toContain("list_users");
      // get_user requires user_id which is not yet known
      expect(beforeIds).not.toContain("get_user");

      // Index a response that provides user_id
      session.indexRequest({
        url: "https://api.example.com/users",
        method: "GET",
        response_body: JSON.stringify({
          user_id: "42",
          name: "Alice",
        }),
      });

      // Now get_user should be runnable
      const after = session.getRunnableOperations();
      const afterIds = after.map((op) => op.operation_id);
      expect(afterIds).toContain("get_user");
    });
  });

  describe("getSuggestedNext", () => {
    it("excludes already-executed operations", () => {
      const graph = buildSkillOperationGraph([
        endpoint("list_users", "GET", "https://api.example.com/users", {
          example_fields: ["user_id"],
          semantic: {
            action_kind: "list",
            resource_kind: "users",
            confidence: 0.9,
            provides: [{ key: "user_id", type: "string" }],
          },
        }),
        endpoint("get_user", "GET", "https://api.example.com/users/{user_id}", {
          example_fields: ["name"],
          semantic: {
            action_kind: "get",
            resource_kind: "user",
            confidence: 0.9,
            requires: [
              { key: "user_id", type: "string", required: true, source: "path_params" },
            ],
          },
        }),
      ]);

      const session = new GraphSession(graph);

      // Index list_users
      session.indexRequest({
        url: "https://api.example.com/users",
        method: "GET",
        response_body: JSON.stringify({ user_id: "1" }),
      });

      // Execute list_users
      session.recordExecution("list_users", true, ["user_id"]);

      const suggested = session.getSuggestedNext();
      const suggestedIds = suggested.map((op) => op.operation_id);

      // list_users should be excluded (already executed)
      expect(suggestedIds).not.toContain("list_users");
      // get_user should be suggested (user_id is now known, reachable via edge)
      expect(suggestedIds).toContain("get_user");
    });

    it("excludes already-observed operations", () => {
      const graph = buildSkillOperationGraph([
        endpoint("list_users", "GET", "https://api.example.com/users", {
          example_fields: ["user_id"],
          semantic: {
            action_kind: "list",
            resource_kind: "users",
            confidence: 0.9,
            provides: [{ key: "user_id", type: "string" }],
          },
        }),
      ]);

      const session = new GraphSession(graph);

      // Index (observe) list_users
      session.indexRequest({
        url: "https://api.example.com/users",
        method: "GET",
      });

      const suggested = session.getSuggestedNext();
      const suggestedIds = suggested.map((op) => op.operation_id);

      // list_users should be excluded (already observed)
      expect(suggestedIds).not.toContain("list_users");
    });
  });

  describe("session trace", () => {
    it("records execution order", () => {
      const graph = buildSkillOperationGraph([
        endpoint("op_a", "GET", "https://api.example.com/a", {
          example_fields: ["x"],
        }),
        endpoint("op_b", "POST", "https://api.example.com/b", {
          example_fields: ["y"],
        }),
      ]);

      const session = new GraphSession(graph);

      session.recordExecution("op_a", true);
      session.recordExecution("op_b", false);
      session.recordExecution("op_a", true);

      const trace = session.getTrace();
      expect(trace).toHaveLength(3);
      expect(trace[0]!.operationId).toBe("op_a");
      expect(trace[0]!.success).toBe(true);
      expect(trace[1]!.operationId).toBe("op_b");
      expect(trace[1]!.success).toBe(false);
      expect(trace[2]!.operationId).toBe("op_a");
      expect(trace[2]!.success).toBe(true);

      // Each entry should have a valid ISO timestamp
      for (const entry of trace) {
        expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
      }
    });
  });

  describe("toSnapshot", () => {
    it("produces a serializable snapshot of session state", () => {
      const graph = buildSkillOperationGraph([
        endpoint("list_items", "GET", "https://api.example.com/items", {
          example_fields: ["item_id", "name"],
          semantic: {
            action_kind: "list",
            resource_kind: "items",
            confidence: 0.9,
            provides: [
              { key: "item_id", type: "string" },
              { key: "name", type: "string" },
            ],
          },
        }),
      ]);

      const session = new GraphSession(graph);

      session.indexRequest({
        url: "https://api.example.com/items",
        method: "GET",
        response_body: JSON.stringify({ item_id: "abc", name: "Widget" }),
      });

      const snapshot = session.toSnapshot();
      expect(snapshot.observed_operations).toContain("list_items");
      expect(snapshot.known_bindings.item_id).toBe("abc");
      expect(snapshot.known_bindings.name).toBe("Widget");
      // suggested_next should be an array of strings
      expect(Array.isArray(snapshot.suggested_next)).toBe(true);
    });
  });
});
