import { describe, expect, it } from "bun:test";
import { isServerVersionMismatch } from "../src/runtime/local-server.js";

describe("local server version guard", () => {
  it("flags mismatched running and installed package versions", () => {
    expect(isServerVersionMismatch("2.10.2", "2.12.0")).toBe(true);
  });

  it("ignores matching package versions", () => {
    expect(isServerVersionMismatch("2.12.0", "2.12.0")).toBe(false);
  });

  it("ignores servers that do not report a package version", () => {
    expect(isServerVersionMismatch(undefined, "2.12.0")).toBe(false);
  });
});
