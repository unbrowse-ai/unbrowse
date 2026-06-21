/**
 * contract-native.test — the witness for "emergence down to the CLI binary":
 * the unbrowse runtime declares a /contract IN-PROCESS via the embedded, vendored
 * libcontract (bun:ffi over the 33 C-ABI symbols) — no subprocess, no cloud.
 * The id round-trips through the real ledger (the lib reads ~/.contracts).
 */
import { describe, expect, it } from "bun:test";
import { declareNative, getNative, nativeAvailable } from "../src/values/contract-native.js";

describe("contract embedded in the CLI binary (in-process)", () => {
  it("the vendored libcontract loads in-process", () => {
    expect(nativeAvailable()).toBe(true);
  });

  it("declares a /contract in-process and gets an 8-hex id back", () => {
    const id = declareNative(
      "witness: unbrowse CLI declares /contract via the embedded substrate",
      "test:in-process",
    );
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it("the declared row round-trips through the real ledger (pointer, not payload)", () => {
    const id = declareNative("witness: round-trip the embedded declare", "test:roundtrip");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const rows = getNative(id!);
    expect(rows && rows.includes(id!)).toBe(true);
  });
});
