import { describe, expect, it } from "bun:test";
import { egressChain } from "../src/execution/egress-chain.js";

describe("egress chain cancellation", () => {
  it("does not start or advance the ladder after caller cancellation", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new DOMException("cancelled", "AbortError"));
    await expect(egressChain(
      { url: "https://example.invalid", signal: ctrl.signal },
      { allowServer: true, allowClientProxy: true },
    )).rejects.toMatchObject({ name: "AbortError" });
  });
});
