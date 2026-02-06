/**
 * Unit tests for schema-inferrer.ts
 *
 * Tests inferSchema(), safeParseJson(), getTopLevelSchema(),
 * mergeSchemas(), and summary string formatting.
 */

import { describe, it, expect } from "bun:test";
import {
  inferSchema,
  safeParseJson,
  getTopLevelSchema,
  mergeSchemas,
} from "../../schema-inferrer.js";

// ── inferSchema ────────────────────────────────────────────────────────────

describe("inferSchema", () => {
  describe("objects", () => {
    it("infers fields from a flat object", () => {
      const result = inferSchema({ id: 1, name: "Alice", email: "a@b.com" });
      expect(result.isArray).toBe(false);
      expect(result.arrayLength).toBeUndefined();
      expect(result.fields["id"]).toBe("number");
      expect(result.fields["name"]).toBe("string");
      expect(result.fields["email"]).toBe("string");
    });

    it("infers boolean and null types", () => {
      const result = inferSchema({ active: true, deleted: false, meta: null });
      expect(result.fields["active"]).toBe("boolean");
      expect(result.fields["deleted"]).toBe("boolean");
      expect(result.fields["meta"]).toBe("null");
    });

    it("generates an object summary", () => {
      const result = inferSchema({ id: 1, name: "Alice" });
      expect(result.summary).toBe("object{id,name}");
    });

    it("handles empty object", () => {
      const result = inferSchema({});
      expect(result.isArray).toBe(false);
      expect(result.summary).toBe("object{}");
      expect(Object.keys(result.fields)).toHaveLength(0);
    });
  });

  describe("nested objects", () => {
    it("infers nested fields with dot notation", () => {
      const result = inferSchema({
        id: 1,
        user: { name: "Alice", email: "a@b.com" },
      });
      expect(result.fields["id"]).toBe("number");
      expect(result.fields["user"]).toBe("object");
      expect(result.fields["user.name"]).toBe("string");
      expect(result.fields["user.email"]).toBe("string");
    });

    it("limits depth of nested extraction", () => {
      // MAX_SCHEMA_DEPTH is 3 — deeply nested fields should be truncated
      const deepObj = { a: { b: { c: { d: { e: "deep" } } } } };
      const result = inferSchema(deepObj);
      expect(result.fields["a"]).toBe("object");
      expect(result.fields["a.b"]).toBe("object");
      expect(result.fields["a.b.c"]).toBe("object");
      // depth 3 → 4 is beyond MAX_SCHEMA_DEPTH, so d should not recurse
      expect(result.fields["a.b.c.d"]).toBe("object");
      expect(result.fields["a.b.c.d.e"]).toBeUndefined();
    });
  });

  describe("arrays", () => {
    it("infers array schema from the first element", () => {
      const result = inferSchema([
        { id: 1, title: "First" },
        { id: 2, title: "Second" },
      ]);
      expect(result.isArray).toBe(true);
      expect(result.arrayLength).toBe(2);
      // Fields come from the first element, prefixed with []
      expect(result.fields["[].id"]).toBe("number");
      expect(result.fields["[].title"]).toBe("string");
    });

    it("generates array summary", () => {
      const result = inferSchema([
        { id: 1, name: "A" },
        { id: 2, name: "B" },
        { id: 3, name: "C" },
      ]);
      expect(result.summary).toBe("array[3]<object{id,name}>");
    });

    it("handles empty array", () => {
      const result = inferSchema([]);
      expect(result.isArray).toBe(true);
      expect(result.arrayLength).toBe(0);
      expect(result.summary).toBe("array[0]");
      expect(Object.keys(result.fields)).toHaveLength(0);
    });

    it("handles array of primitives", () => {
      const result = inferSchema([1, 2, 3]);
      expect(result.isArray).toBe(true);
      expect(result.arrayLength).toBe(3);
      expect(result.summary).toBe("array[3]<number>");
    });
  });

  describe("null and empty data", () => {
    it("handles null input", () => {
      const result = inferSchema(null);
      expect(result.isArray).toBe(false);
      expect(result.summary).toBe("null");
      expect(Object.keys(result.fields)).toHaveLength(0);
    });

    it("handles undefined input", () => {
      const result = inferSchema(undefined);
      expect(result.isArray).toBe(false);
      expect(result.summary).toBe("null");
    });

    it("handles string input", () => {
      const result = inferSchema("hello");
      expect(result.isArray).toBe(false);
      expect(result.summary).toBe("string");
    });

    it("handles number input", () => {
      const result = inferSchema(42);
      expect(result.summary).toBe("number");
    });

    it("handles boolean input", () => {
      const result = inferSchema(true);
      expect(result.summary).toBe("boolean");
    });
  });

  describe("null values in objects", () => {
    it("marks null fields as null type", () => {
      const result = inferSchema({ id: 1, deletedAt: null, name: "Test" });
      expect(result.fields["id"]).toBe("number");
      expect(result.fields["deletedAt"]).toBe("null");
      expect(result.fields["name"]).toBe("string");
    });
  });

  describe("summary formatting", () => {
    it("prioritizes known fields like id, name, title, status", () => {
      const result = inferSchema({
        zzz: "last",
        name: "First",
        id: 1,
        status: "active",
      });
      // id and name and status are priority fields, should appear first
      expect(result.summary).toMatch(/^object\{id,name/);
      expect(result.summary).toContain("status");
    });

    it("truncates to MAX_SUMMARY_KEYS and shows overflow count", () => {
      const obj: Record<string, number> = {};
      for (let i = 0; i < 10; i++) {
        obj[`field${i}`] = i;
      }
      const result = inferSchema(obj);
      // MAX_SUMMARY_KEYS is 6, so 4 overflow
      expect(result.summary).toContain("+4");
    });

    it("does not add overflow suffix when fields fit", () => {
      const result = inferSchema({ a: 1, b: 2, c: 3 });
      expect(result.summary).not.toContain("+");
    });
  });
});

// ── safeParseJson ──────────────────────────────────────────────────────────

describe("safeParseJson", () => {
  it("parses valid JSON object", () => {
    const result = safeParseJson('{"id": 1, "name": "test"}');
    expect(result).toEqual({ id: 1, name: "test" });
  });

  it("parses valid JSON array", () => {
    const result = safeParseJson('[1, 2, 3]');
    expect(result).toEqual([1, 2, 3]);
  });

  it("parses JSON string literal", () => {
    const result = safeParseJson('"hello"');
    expect(result).toBe("hello");
  });

  it("parses JSON number", () => {
    const result = safeParseJson("42");
    expect(result).toBe(42);
  });

  it("parses JSON boolean", () => {
    const result = safeParseJson("true");
    expect(result).toBe(true);
  });

  it("parses JSON null", () => {
    const result = safeParseJson("null");
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(safeParseJson("not json at all")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(safeParseJson("{broken: json}")).toBeNull();
  });

  it("returns null for HTML content", () => {
    expect(safeParseJson("<!DOCTYPE html><html><body>Hi</body></html>")).toBeNull();
  });

  it("returns null for HTML starting with <html", () => {
    expect(safeParseJson("<html><body>Hi</body></html>")).toBeNull();
  });

  it("returns null for XML content", () => {
    expect(safeParseJson("<?xml version='1.0'?><root/>")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(safeParseJson(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(safeParseJson(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(safeParseJson("")).toBeNull();
  });
});

// ── getTopLevelSchema ──────────────────────────────────────────────────────

describe("getTopLevelSchema", () => {
  it("returns top-level fields of a flat object", () => {
    const result = getTopLevelSchema({ id: 1, name: "Alice", active: true });
    expect(result).not.toBeNull();
    expect(result!["id"]).toBe("number");
    expect(result!["name"]).toBe("string");
    expect(result!["active"]).toBe("boolean");
  });

  it("returns object type for nested objects", () => {
    const result = getTopLevelSchema({ id: 1, meta: { key: "val" } });
    expect(result).not.toBeNull();
    expect(result!["id"]).toBe("number");
    expect(result!["meta"]).toBe("object");
  });

  it("returns array type for array fields", () => {
    const result = getTopLevelSchema({ id: 1, tags: ["a", "b"] });
    expect(result).not.toBeNull();
    expect(result!["tags"]).toBe("array<string>");
  });

  it("returns fields of the first array element for arrays", () => {
    const result = getTopLevelSchema([
      { id: 1, name: "A" },
      { id: 2, name: "B" },
    ]);
    expect(result).not.toBeNull();
    expect(result!["id"]).toBe("number");
    expect(result!["name"]).toBe("string");
  });

  it("returns null for empty array", () => {
    expect(getTopLevelSchema([])).toBeNull();
  });

  it("returns null for null input", () => {
    expect(getTopLevelSchema(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(getTopLevelSchema(undefined)).toBeNull();
  });

  it("returns null for primitive values", () => {
    expect(getTopLevelSchema("hello")).toBeNull();
    expect(getTopLevelSchema(42)).toBeNull();
    expect(getTopLevelSchema(true)).toBeNull();
  });

  it("limits to MAX_FIELDS_PER_LEVEL entries", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      obj[`field${i}`] = i;
    }
    const result = getTopLevelSchema(obj);
    expect(result).not.toBeNull();
    // MAX_FIELDS_PER_LEVEL is 10
    expect(Object.keys(result!)).toHaveLength(10);
  });

  it("prioritizes known fields", () => {
    const obj: Record<string, unknown> = {
      zzz: "last",
      aaa: "first",
      id: 1,
      name: "Test",
      yyy: "also last",
    };
    const result = getTopLevelSchema(obj);
    expect(result).not.toBeNull();
    const keys = Object.keys(result!);
    // "id" and "name" should be present (they are priority)
    expect(keys).toContain("id");
    expect(keys).toContain("name");
  });
});

// ── mergeSchemas ───────────────────────────────────────────────────────────

describe("mergeSchemas", () => {
  it("merges compatible schemas with the same types", () => {
    const result = mergeSchemas([
      { id: "number", name: "string" },
      { id: "number", name: "string" },
    ]);
    expect(result).toEqual({ id: "number", name: "string" });
  });

  it("unions fields from different schemas", () => {
    const result = mergeSchemas([
      { id: "number", name: "string" },
      { id: "number", email: "string" },
    ]);
    expect(result).toEqual({ id: "number", name: "string", email: "string" });
  });

  it("marks conflicting types as mixed", () => {
    const result = mergeSchemas([
      { id: "number", value: "string" },
      { id: "number", value: "number" },
    ]);
    expect(result.id).toBe("number");
    expect(result.value).toBe("mixed");
  });

  it("handles an empty array of schemas", () => {
    const result = mergeSchemas([]);
    expect(result).toEqual({});
  });

  it("handles a single schema", () => {
    const result = mergeSchemas([{ id: "number", name: "string" }]);
    expect(result).toEqual({ id: "number", name: "string" });
  });

  it("merges three schemas with partial overlap", () => {
    const result = mergeSchemas([
      { a: "string" },
      { b: "number" },
      { a: "string", c: "boolean" },
    ]);
    expect(result).toEqual({ a: "string", b: "number", c: "boolean" });
  });

  it("marks multiple conflicting merges as mixed", () => {
    const result = mergeSchemas([
      { x: "string" },
      { x: "number" },
      { x: "boolean" },
    ]);
    // First merge: string vs number → mixed
    // Second merge: mixed vs boolean → still mixed (mixed !== boolean)
    expect(result.x).toBe("mixed");
  });
});
