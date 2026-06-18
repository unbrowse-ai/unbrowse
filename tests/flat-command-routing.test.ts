// Witness: flat legacy commands route to their correct verb (build/breath/eval)
// instead of misrouting into the one-hole `breath get` fallback as an intent.
// Exit 0 ⇔ the KNOWN_COMMANDS-drift misroute is fixed. The map is DERIVED from
// KIND_MAP (single source of truth) so it cannot drift again.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { flatCommandVerb } from "../src/cli-v7/kind-map.js";

describe("flat-command routing — no misroute to the get fallback", () => {
  it("maps the confirmed-broken flat commands to their verb", () => {
    expect(flatCommandVerb("settings")).toBe("eval");
    expect(flatCommandVerb("fetch")).toBe("breath");
    expect(flatCommandVerb("search")).toBe("eval");
    expect(flatCommandVerb("skills")).toBe("eval");
    expect(flatCommandVerb("spec")).toBe("eval");
    expect(flatCommandVerb("explain")).toBe("eval");
    expect(flatCommandVerb("auth-inventory")).toBe("eval");
  });

  it("maps the other flat commands too (account/dashboard/upgrade)", () => {
    expect(flatCommandVerb("account")).toBe("eval");
    expect(flatCommandVerb("dashboard")).toBe("breath");
    expect(flatCommandVerb("upgrade")).toBe("breath");
  });

  it("returns null for a genuine natural-language intent (still routes to get)", () => {
    expect(flatCommandVerb("find cheap flights to tokyo")).toBeNull();
    expect(flatCommandVerb("what is the weather")).toBeNull();
    expect(flatCommandVerb("")).toBeNull();
  });

  it("does not hijack the verbs themselves or launchers", () => {
    // build/breath/eval are handled by the verb dispatch, not the flat map;
    // mcp/serve/help are launchers/handled separately.
    for (const v of ["build", "breath", "eval"]) expect(flatCommandVerb(v)).toBeNull();
  });

  it("regression guard: cli.ts dispatch USES flatCommandVerb before the get fallback", () => {
    const cli = readFileSync(join(import.meta.dir, "..", "src", "cli.ts"), "utf8");
    expect(cli.includes("flatCommandVerb")).toBe(true);
    // the usage must appear before the "breath", "get" one-hole fallback forward
    const useIdx = cli.indexOf("flatCommandVerb(");
    const fallbackIdx = cli.indexOf('"breath", "get"');
    expect(useIdx).toBeGreaterThan(0);
    expect(fallbackIdx).toBeGreaterThan(0);
    expect(useIdx).toBeLessThan(fallbackIdx);
  });
});
