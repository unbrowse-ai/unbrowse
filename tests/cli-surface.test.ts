/**
 * cli-surface.test — the witness that the unbrowse CLI is shaped to the superpattern
 * atoms and exposes ONLY what a client needs (src/superpattern/cli-surface.ts):
 * every command maps to a verb (build/breath/eval) + interrogative, surfaces only
 * its holes + auth, and leaks no internal route/logic/secret. Secret-bearing
 * commands declare a wallet/sealed auth (composing with the ZK hole seal).
 *
 * Post-collapse: SURFACE is keyed by the FULL subcommand "<verb> <cap>" (model A),
 * key-identical to src/cli-v7/kind-map.ts. The rejected create/act/read aliases
 * are gone; "eval" (JS) is now "breath run-js".
 */
import { describe, expect, it } from "bun:test";
import { surfaceFor, classify, verifySurface, knownCommands } from "../src/superpattern/cli-surface.js";

// A representative slice of the canonical full-subcommand surface — every one
// must classify (superpattern-complete). The full set is the kind-map universe.
const CANONICAL = [
  "build skill", "build publish", "build setup", "build index", "build annotate", "build cleanup-stale",
  "breath go", "breath execute", "breath fill", "breath fetch", "breath capture", "breath run-js",
  "breath auth", "breath mcp", "breath serve", "breath upgrade",
  "eval resolve", "eval search", "eval explain", "eval status", "eval snap", "eval skill", "eval skills",
];

describe("CLI superpattern surface", () => {
  it("is superpattern-complete + minimal (every command an atom, no internal leak)", () => {
    const r = verifySurface(CANONICAL);
    expect(r.missing).toEqual([]);   // every listed subcommand is classified
    expect(r.errors).toEqual([]);    // valid verbs/interrogatives, no forbidden field
    expect(r.ok).toBe(true);
  });

  it("every command resolves to one of the three verbs", () => {
    for (const cmd of knownCommands()) {
      expect(["build", "breath", "eval"]).toContain(classify(cmd)!.verb);
    }
  });

  it("the rejected create/act/read alias scheme is purged from the surface", () => {
    for (const cmd of knownCommands()) {
      expect(["create", "act", "read"]).not.toContain(cmd.split(" ")[0]);
    }
    expect(surfaceFor("read")).toBeNull();
    expect(surfaceFor("create")).toBeNull();
  });

  it("a surface exposes ONLY {command,verb,interrogative,holes,auth} — no route/logic/secret", () => {
    const s = surfaceFor("breath execute")!;
    expect(Object.keys(s).sort()).toEqual(["auth", "command", "holes", "interrogative", "verb"]);
    expect(JSON.stringify(s)).not.toContain("url_template");
  });

  it("secret-bearing commands bind their secret to the wallet (sealed/wallet auth)", () => {
    for (const cmd of ["breath auth", "breath execute", "breath fill", "breath get", "breath capture", "build setup", "build publish"]) {
      expect(["sealed", "wallet"]).toContain(surfaceFor(cmd)!.auth);
    }
  });

  it("read-only eval commands expose no auth secret", () => {
    for (const cmd of ["eval search", "eval resolve", "eval explain", "eval status", "eval skills"]) {
      expect(surfaceFor(cmd)!.auth).toBe("none");
    }
  });

  it("an unknown command exposes nothing", () => {
    expect(surfaceFor("rm-rf-the-moat")).toBeNull();
  });

  it("the same noun lives under two verbs (build skill publishes, eval skill reads)", () => {
    expect(surfaceFor("build skill")).toMatchObject({ verb: "build", auth: "wallet" });
    expect(surfaceFor("eval skill")).toMatchObject({ verb: "eval", auth: "none", holes: ["id"] });
  });
});
