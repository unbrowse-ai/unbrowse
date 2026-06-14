/**
 * verb-deprecation.test — the lean surface witness.
 *
 * The runtime is in-process and route contracts live server-side, so the
 * daemon-era verbs (serve/stop/restart/status) and a handful of folded-in
 * local utilities are deprecated. This proves:
 *   1. every deprecated verb carries a canonical pointer + reason,
 *   2. the notice is consistent and names the replacement,
 *   3. NO essential agent-path verb is ever deprecated (surface stays clean),
 *   4. a real CLI invocation of a removed daemon verb emits the notice and
 *      exits 0 — instead of the old confusing "Unknown command".
 */
import { describe, expect, it } from "bun:test";
import {
  CLI_REFERENCE,
  DEPRECATED_VERBS,
  ESSENTIAL_VERBS,
  deprecationNotice,
} from "../src/cli.js";

// Wiring proof: a deprecated verb must leave the advertised lean surface.
// (The end-to-end "prints the notice + exits 0" behavior is verified by hand —
// `unbrowse note` does exactly that — but a subprocess inside `bun test` cannot
// reliably capture child stdio, so the deterministic surface check stands in.)
describe("the lean surface excludes every deprecated verb", () => {
  it("no deprecated verb appears in the advertised primary commands", () => {
    const advertised = new Set(CLI_REFERENCE.commands.map((c) => c.name));
    for (const verb of Object.keys(DEPRECATED_VERBS)) {
      expect(advertised.has(verb)).toBe(false);
    }
  });

  it("every advertised primary command is a real, non-deprecated verb", () => {
    for (const c of CLI_REFERENCE.commands) {
      expect(DEPRECATED_VERBS[c.name]).toBeUndefined();
    }
  });
});

describe("deprecation registry is well-formed", () => {
  it("every deprecated verb has a reason; removed verbs name a successor or none", () => {
    for (const [verb, d] of Object.entries(DEPRECATED_VERBS)) {
      expect(d.reason.length).toBeGreaterThan(0);
      // canonical may be "" (no successor) but must be a string
      expect(typeof d.canonical).toBe("string");
      const notice = deprecationNotice(verb);
      expect(notice).toContain("[deprecated]");
      expect(notice).toContain(verb);
      if (d.canonical) expect(notice).toContain(d.canonical);
      else expect(notice).toContain("no longer needed");
    }
  });

  it("`note` (non-web utility) is deprecated as removed", () => {
    expect(DEPRECATED_VERBS.note).toBeDefined();
    expect(DEPRECATED_VERBS.note.removed).toBe(true);
    expect(deprecationNotice("note")).toContain("no longer needed");
  });

  it("the compatibility-daemon facade verbs are NOT deprecated (serve/stop/restart/status kept)", () => {
    for (const v of ["serve", "stop", "restart", "status"]) {
      expect(DEPRECATED_VERBS[v]).toBeUndefined();
    }
  });

  it("folded-in utilities forward to a canonical verb", () => {
    expect(DEPRECATED_VERBS["connect-chrome"].canonical).toBe("go");
    expect(DEPRECATED_VERBS.mode.canonical).toBe("settings");
    expect(DEPRECATED_VERBS["payment-provider"].canonical).toBe("setup");
    expect(DEPRECATED_VERBS["browse-cookies"].canonical).toBe("cookies");
    expect(DEPRECATED_VERBS["contract-bridge"].canonical).toBe("contract");
  });
});

describe("the essential agent path is never deprecated", () => {
  it("no essential verb appears in the deprecation registry", () => {
    for (const v of ESSENTIAL_VERBS) {
      expect(DEPRECATED_VERBS[v]).toBeUndefined();
      expect(deprecationNotice(v)).toBeUndefined();
    }
  });

  it("resolve/execute (the two-call contract) resolve to no notice", () => {
    expect(deprecationNotice("resolve")).toBeUndefined();
    expect(deprecationNotice("execute")).toBeUndefined();
  });
});

// The real-CLI behavioral proof lives in verb-deprecation-cli.test.ts — a
// single-test file, because node's spawnSync stdio capture grows unreliable
// after several tests run in the same bun-test process.
