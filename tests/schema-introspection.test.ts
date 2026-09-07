/**
 * `unbrowse schema` — the command surface, derived not restated.
 *
 * Without it an agent discovers commands only by reading --help prose. This
 * serves the same facts as data: subcommand → op_kind → op_class → mcp_tool.
 *
 * The load-bearing property is WHERE it comes from. It derives from
 * cli-v7/kind-map.ts, which is pure data and imports nothing — deliberately NOT
 * from the MCP tool array where the typed per-parameter schemas live, because
 * `src/mcp.ts` calls main() at module scope: importing it starts the stdio
 * server and writes a telemetry session file. A read-only introspection query
 * must not do that. (The obvious guard, `if (isMainModule(...)) main()`, would
 * break the packaged binary, which relies on that exact import side effect —
 * single-binary.ts:157, asserted by tests/skill-package-runtime.test.ts.)
 *
 * So this suite guards two things: that the map is a usable schema source, and
 * that lookup is unambiguous. Typed per-parameter contracts remain open work and
 * are deliberately not asserted here — a test for something not shipped would be
 * a fabricated green.
 */
import { describe, expect, test } from "bun:test";
import { KIND_MAP } from "../src/cli-v7/kind-map.js";

describe("the schema source is declarative and complete", () => {
  test("every entry carries the four fields the verb serves", () => {
    expect(KIND_MAP.length).toBeGreaterThan(0);
    for (const k of KIND_MAP) {
      expect(typeof k.subcommand).toBe("string");
      expect(k.subcommand.length).toBeGreaterThan(0);
      expect(typeof k.op_kind).toBe("string");
      expect(["actuate", "observe", "build"]).toContain(k.op_class);
      // mcp_tool is intentionally nullable — local-only flows have no tool.
      expect(k.mcp_tool === null || typeof k.mcp_tool === "string").toBe(true);
    }
  });

  test("subcommands are unique — lookup must never be a coin flip", () => {
    const subs = KIND_MAP.map((k) => k.subcommand);
    expect(new Set(subs).size).toBe(subs.length);
  });

  test("op_kind matches its verb and action, so dispatch cannot drift", () => {
    const mismatched = KIND_MAP
      .filter((k) => k.op_kind !== `${k.verb}:${k.action}`)
      .map((k) => k.subcommand);
    expect(mismatched).toEqual([]);
  });

  test("an ambiguous bare verb is REFUSED, not guessed", () => {
    // "skill" really does match two subcommands (build skill, eval skill). The
    // first version of the verb returned whichever came first, silently
    // answering a different question than the one asked. This asserts the
    // ambiguity exists AND that the set is enumerable, which is what lets the
    // CLI list candidates instead of picking one.
    const byLast = new Map<string, string[]>();
    for (const k of KIND_MAP) {
      const last = k.subcommand.split(" ").slice(-1)[0];
      byLast.set(last, [...(byLast.get(last) ?? []), k.subcommand]);
    }
    expect(byLast.get("skill")?.length).toBeGreaterThan(1);
    // and the unambiguous ones stay unambiguous
    for (const solo of ["resolve", "execute", "go"]) {
      expect({ solo, n: byLast.get(solo)?.length ?? 0 }).toEqual({ solo, n: 1 });
    }
  });

  test("the verbs an agent actually calls are present", () => {
    const subs = new Set(KIND_MAP.map((k) => k.subcommand));
    for (const s of ["eval resolve", "breath execute", "breath go"]) {
      expect({ s, present: subs.has(s) }).toEqual({ s, present: true });
    }
  });
});
