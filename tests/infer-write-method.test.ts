/**
 * infer-write-method.test — agent-native verb inference (no --method needed).
 */
import { describe, expect, it } from "bun:test";
import { extractEmbeddedJsonBody, inferWriteMethod } from "../src/lib/infer-write-method.js";

describe("inferWriteMethod", () => {
  it("honours an explicit write method", () => {
    expect(inferWriteMethod("post", "anything", false)).toBe("POST");
    expect(inferWriteMethod("DELETE", "", false)).toBe("DELETE");
  });
  it("honours an explicit read method as a read (undefined)", () => {
    expect(inferWriteMethod("GET", "create a post", true)).toBeUndefined();
  });
  it("infers from intent verbs", () => {
    expect(inferWriteMethod(undefined, "create a new post titled hi", false)).toBe("POST");
    expect(inferWriteMethod(undefined, "delete the comment", false)).toBe("DELETE");
    expect(inferWriteMethod(undefined, "update the user's email", false)).toBe("PATCH");
    expect(inferWriteMethod(undefined, "replace the whole record", false)).toBe("PUT");
    expect(inferWriteMethod(undefined, "submit the registration form", false)).toBe("POST");
  });
  it("treats a present body as a create when intent is neutral", () => {
    expect(inferWriteMethod(undefined, "", true)).toBe("POST");
    expect(inferWriteMethod(undefined, "the record", true)).toBe("POST");
  });
  it("returns undefined (read) for a fetch intent with no body", () => {
    expect(inferWriteMethod(undefined, "get the latest posts", false)).toBeUndefined();
    expect(inferWriteMethod(undefined, "list all users", false)).toBeUndefined();
    expect(inferWriteMethod(undefined, "", false)).toBeUndefined();
  });
  it("delete intent beats a present body", () => {
    expect(inferWriteMethod(undefined, "remove the item", true)).toBe("DELETE");
  });
});

describe("extractEmbeddedJsonBody", () => {
  it("extracts a JSON object embedded in a natural-language write intent", () => {
    expect(extractEmbeddedJsonBody('create a new record by POSTing the JSON body {"name":"x","n":1}'))
      .toBe('{"name":"x","n":1}');
  });
  it("extracts an embedded JSON array", () => {
    expect(extractEmbeddedJsonBody('replace the list with [{"id":1}]')).toBe('[{"id":1}]');
  });
  it("returns undefined when no JSON object is present", () => {
    expect(extractEmbeddedJsonBody("create a post titled hello with body world")).toBeUndefined();
    expect(extractEmbeddedJsonBody("get the latest posts")).toBeUndefined();
    expect(extractEmbeddedJsonBody("")).toBeUndefined();
  });
  it("returns undefined for braces that are not valid JSON", () => {
    expect(extractEmbeddedJsonBody("update the {record} please")).toBeUndefined();
  });
  it("ignores a bare number/string in braces (not a request body)", () => {
    expect(extractEmbeddedJsonBody("post {42}")).toBeUndefined();
  });
});
