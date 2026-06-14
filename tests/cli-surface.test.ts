/**
 * cli-surface.test — the witness that the unbrowse CLI is shaped to the superpattern
 * atoms and exposes ONLY what a client needs (src/superpattern/cli-surface.ts):
 * every command maps to a verb (build/breath/eval) + interrogative, surfaces only
 * its holes + auth, and leaks no internal route/logic/secret. Secret-bearing
 * commands declare a wallet/sealed auth (composing with the ZK hole seal).
 */
import { describe, expect, it } from "bun:test";
import { surfaceFor, classify, verifySurface, knownCommands } from "../src/superpattern/cli-surface.js";

// The canonical top-level CLI commands (from `unbrowse --help`) — the surface the
// client sees. The manifest must classify every one (superpattern-complete).
const CANONICAL = [
  "account", "act", "annotate", "auth", "auth-inventory", "capture", "cleanup-stale", "click",
  "contract", "dashboard", "execute", "explain", "feedback", "fetch", "fill", "get", "go", "health", "index",
  "mcp", "mode", "note", "payment-provider", "press", "publish", "publish-bundle", "resolve",
  "create", "read", "review", "run", "screenshot", "scroll", "search", "select", "settings", "setup", "skill",
  "skills", "snap", "spec", "submit", "text", "type", "upgrade",
];

describe("CLI superpattern surface", () => {
  it("is superpattern-complete + minimal (every command an atom, no internal leak)", () => {
    const r = verifySurface(CANONICAL);
    expect(r.missing).toEqual([]);   // every CLI command is classified
    expect(r.errors).toEqual([]);    // valid verbs/interrogatives, no forbidden field
    expect(r.ok).toBe(true);
  });

  it("every command resolves to one of the three verbs", () => {
    for (const cmd of knownCommands()) {
      expect(["build", "breath", "eval"]).toContain(classify(cmd)!.verb);
    }
  });

  it("a surface exposes ONLY {command,verb,interrogative,holes,auth} — no route/logic/secret", () => {
    const s = surfaceFor("execute")!;
    expect(Object.keys(s).sort()).toEqual(["auth", "command", "holes", "interrogative", "verb"]);
    expect(JSON.stringify(s)).not.toContain("url_template");
  });

  it("secret-bearing commands bind their secret to the wallet (sealed/wallet auth)", () => {
    for (const cmd of ["auth", "execute", "fill", "get", "capture", "setup", "publish"]) {
      expect(["sealed", "wallet"]).toContain(surfaceFor(cmd)!.auth);
    }
  });

  it("read-only eval commands expose no auth secret", () => {
    for (const cmd of ["search", "resolve", "explain", "health", "skills"]) {
      expect(surfaceFor(cmd)!.auth).toBe("none");
    }
  });

  it("an unknown command exposes nothing", () => {
    expect(surfaceFor("rm-rf-the-moat")).toBeNull();
  });

  it("contract is the CLI bridge command and exposes only the bridge holes", () => {
    expect(surfaceFor("contract")).toMatchObject({
      verb: "breath",
      interrogative: "where",
      auth: "wallet",
      holes: ["intent", "wallet_proof", "approval", "local_capability_result", "typed_pointer"],
    });
  });

  it("canonical create/act/read commands are the only new root verbs", () => {
    expect(surfaceFor("create")).toMatchObject({ verb: "build", auth: "wallet" });
    expect(surfaceFor("act")).toMatchObject({ verb: "breath", auth: "sealed" });
    expect(surfaceFor("read")).toMatchObject({ verb: "eval", auth: "none" });
  });
});
