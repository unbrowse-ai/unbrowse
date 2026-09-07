// The SDK always-activates the auth-proxy bridge when spawning (same default as the
// CLI): UNBROWSE_KURI_PROXY=auto when unset. "auto" degrades safely to direct egress
// without creds (no forced-proxy ERR_TUNNEL), and an explicit value — including the
// "0" kill switch — is preserved.
import { describe, it, expect } from "bun:test";
import { applyBridgeDefault } from "../src/runtime.js";

describe("applyBridgeDefault — SDK spawn activates the bridge by default", () => {
  it("defaults UNBROWSE_KURI_PROXY=auto when unset", () => {
    expect(applyBridgeDefault({ PORT: "1" }).UNBROWSE_KURI_PROXY).toBe("auto");
  });

  it("defaults to auto when present-but-empty", () => {
    expect(applyBridgeDefault({ UNBROWSE_KURI_PROXY: "" }).UNBROWSE_KURI_PROXY).toBe("auto");
  });

  it("preserves the explicit kill switch (UNBROWSE_KURI_PROXY=0)", () => {
    expect(applyBridgeDefault({ UNBROWSE_KURI_PROXY: "0" }).UNBROWSE_KURI_PROXY).toBe("0");
  });

  it("preserves an explicit proxy URL", () => {
    expect(applyBridgeDefault({ UNBROWSE_KURI_PROXY: "http://proxy:8080" }).UNBROWSE_KURI_PROXY).toBe("http://proxy:8080");
  });

  it("does not mutate the caller's env object", () => {
    const input: Record<string, string> = { PORT: "1" };
    applyBridgeDefault(input);
    expect(input.UNBROWSE_KURI_PROXY).toBeUndefined();
  });
});
