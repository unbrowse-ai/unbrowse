import { describe, expect, it } from "bun:test";
import { normalizeLocalRuntimeOrigin } from "./local-runtime";

describe("normalizeLocalRuntimeOrigin", () => {
  it("accepts http/https origins and strips trailing slashes", () => {
    expect(normalizeLocalRuntimeOrigin("http://localhost:6969/")).toBe("http://localhost:6969");
    expect(normalizeLocalRuntimeOrigin("https://127.0.0.1:6969")).toBe("https://127.0.0.1:6969");
  });

  it("rejects empty and non-http schemes", () => {
    expect(normalizeLocalRuntimeOrigin("")).toBeNull();
    expect(normalizeLocalRuntimeOrigin("file:///tmp")).toBeNull();
    expect(normalizeLocalRuntimeOrigin("not a url")).toBeNull();
  });
});
