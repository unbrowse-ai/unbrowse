/**
 * infer-write-method.test — agent-native verb inference (no --method needed).
 */
import { describe, expect, it } from "bun:test";
import { inferWriteMethod } from "../src/lib/infer-write-method.js";

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
