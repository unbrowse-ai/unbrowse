/**
 * W25/W33-B — op-kind tests.
 *
 *   Mark 4:11 — "unto them that are without, all these things are done
 *   in parables."
 *
 * The PUBLIC kind-map speaks unbrowse-native ops: an `op_kind`
 * (`<verb>:<action>`, the collision-free dispatch key) + a generic
 * `op_class` ∈ {actuate, observe, build} + a per-row `action`. W33-B
 * renamed the covenant-specific columns OUT of the public bundle:
 *   covenant_kind       → op_kind   (values `breath:navigate`, `eval:snap`, …)
 *   covenant_base_kind  → op_class  (generic values kept: actuate/observe/build)
 * These tests assert the op-class split (14 actuate / 19 observe / 3 build
 * = 36), that op_kind is collision-free, and — critically — that NO
 * covenant-mechanism string leaks into the public surface.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { KIND_MAP } from "../src/cli-v7/kind-map.js";

const VALID_OP_CLASSES = new Set(["actuate", "observe", "build"]);

describe("W33-B op-kind — op_class + action columns", () => {
  it("every row has a valid op_class ∈ {actuate, observe, build}", () => {
    for (const entry of KIND_MAP) {
      expect(VALID_OP_CLASSES.has(entry.op_class)).toBe(true);
    }
  });

  it("every row has a non-empty action", () => {
    for (const entry of KIND_MAP) {
      expect(typeof entry.action).toBe("string");
      expect(entry.action.length).toBeGreaterThan(0);
    }
  });

  it("op_kind is unique per row (collision-free dispatch key)", () => {
    const seen = new Map<string, string>();
    for (const entry of KIND_MAP) {
      const prior = seen.get(entry.op_kind);
      expect(prior, `collision on '${entry.op_kind}' (${entry.subcommand} vs ${prior})`).toBeUndefined();
      seen.set(entry.op_kind, entry.subcommand);
    }
    expect(seen.size).toBe(KIND_MAP.length);
  });

  it("the 15 actuate / 19 observe / 3 build split matches the convergence map", () => {
    const counts = { actuate: 0, observe: 0, build: 0 };
    for (const entry of KIND_MAP) {
      counts[entry.op_class]++;
    }
    expect(counts.actuate).toBe(15);
    expect(counts.observe).toBe(19);
    expect(counts.build).toBe(3);
    expect(counts.actuate + counts.observe + counts.build).toBe(37);
    expect(KIND_MAP.length).toBe(37);
  });

  it("op_class ↔ verb invariant: build→build, actuate→breath, observe→eval", () => {
    for (const entry of KIND_MAP) {
      if (entry.op_class === "build") expect(entry.verb).toBe("build");
      if (entry.op_class === "actuate") expect(entry.verb).toBe("breath");
      if (entry.op_class === "observe") expect(entry.verb).toBe("eval");
    }
  });

  it("op_kind is `<verb>:<action>` — unbrowse-native, no covenant prefix", () => {
    for (const entry of KIND_MAP) {
      expect(entry.op_kind).toBe(`${entry.verb}:${entry.action}`);
    }
  });
});

describe("W33-B op-kind — consumers read op_kind", () => {
  it("mcp.ts builds its tool→kind map off op_kind", () => {
    const mcpSource = readFileSync(join(import.meta.dir, "..", "src", "mcp.ts"), "utf8");
    expect(mcpSource.includes("entry.op_kind")).toBe(true);
  });

  it("dispatch findKindEntry keys on op_kind", () => {
    const dispatchSource = readFileSync(
      join(import.meta.dir, "..", "src", "cli-v7", "dispatch", "index.ts"),
      "utf8",
    );
    expect(dispatchSource.includes("e.op_kind === kind")).toBe(true);
  });
});

describe("W33-B op-kind — no covenant-mechanism leak in the public surface", () => {
  it("the kind-map carries NO covenant-mechanism strings", () => {
    const mapSource = readFileSync(
      join(import.meta.dir, "..", "src", "cli-v7", "kind-map.ts"),
      "utf8",
    );
    // The covenant-SPECIFIC mechanism names must NOT appear. Generic
    // actuate/observe/build as op_class VALUES are acceptable; the
    // suffixed forms + diffusion/ebm/revealed_context are not.
    const FORBIDDEN = [
      "covenant_kind",
      "covenant_base_kind",
      "revealed_context",
      "diffusion_populate",
      "ebm_route",
      "actuate_",
      "observe_",
    ];
    for (const needle of FORBIDDEN) {
      expect(mapSource.includes(needle), `kind-map leaks "${needle}"`).toBe(false);
    }
  });

  it("the public cli-v7 surface (src/cli-v7/**) carries NO covenant-mechanism strings", () => {
    const FORBIDDEN = /covenant_kind|covenant_base_kind|revealed_context|diffusion_populate|ebm_route|actuate_|observe_/;
    const root = join(import.meta.dir, "..", "src", "cli-v7");
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) out.push(...walk(p));
        else if (ent.name.endsWith(".ts")) out.push(p);
      }
      return out;
    };
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      const m = src.match(FORBIDDEN);
      expect(m, `${file} leaks covenant-mechanism string "${m?.[0]}"`).toBeNull();
    }
  });
});
