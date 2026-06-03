/**
 * surface-projector.test — the witness for the CLI-shape answer: the surface is a
 * context PROJECTION of the superpattern verb tree. Proves: the projection is
 * context-dependent (no-session vs session-open expose different verbs), minimal (only
 * holes+auth, no internal field), auth-aware (auth verb surfaces on demand), and
 * LOSSLESS in union (every command appears in some projection — nothing is permanently
 * hidden, just projected). This is "expose only the verbs we need each time", built on
 * the static superpattern model.
 */
import { describe, expect, it } from "bun:test";
import { projectSurface, projectedVerbs, projectedHoles } from "../src/superpattern/surface-projector.js";
import { knownCommands, verifySurface } from "../src/superpattern/cli-surface.js";

const cmds = (ctx: Parameters<typeof projectSurface>[0]) => projectSurface(ctx).map((s) => s.command);

describe("surface-projector — the dynamic surface over the superpattern tree", () => {
  it("no session: surfaces discovery + entry, NOT browse verbs", () => {
    const c = cmds({ sessionOpen: false });
    expect(c).toContain("search");
    expect(c).toContain("resolve");
    expect(c).toContain("go");      // entry
    expect(c).toContain("execute"); // replay a resolved endpoint
    expect(c).not.toContain("snap");
    expect(c).not.toContain("click");
    expect(c).not.toContain("submit");
  });

  it("session open: surfaces browse verbs, drops re-entry", () => {
    const c = cmds({ sessionOpen: true });
    expect(c).toContain("snap");
    expect(c).toContain("click");
    expect(c).toContain("submit");
    expect(c).toContain("type");   // a real browse verb in the model
    expect(c).toContain("search"); // discovery still available
    expect(c).not.toContain("go");  // already inside — no re-entry
  });

  it("auth required: the auth verb surfaces with its sealed domain hole, regardless of phase", () => {
    const surf = projectSurface({ sessionOpen: true, authRequired: true });
    const auth = surf.find((s) => s.command === "auth");
    expect(auth).toBeDefined();
    expect(auth!.auth).toBe("sealed");
    expect(auth!.holes).toContain("domain");
  });

  it("every projected entry exposes ONLY holes + auth + atom — no internal field leaks", () => {
    for (const ctx of [{}, { sessionOpen: true }, { authRequired: true }]) {
      for (const s of projectSurface(ctx)) {
        // a Surface carries exactly these keys — no route/logic/secret/url_template
        expect(Object.keys(s).sort()).toEqual(["auth", "command", "holes", "interrogative", "verb"]);
      }
    }
    // the model itself is superpattern-complete + minimal
    expect(verifySurface().ok).toBe(true);
  });

  it("verbs are the superpattern atoms (build/breath/eval), populated by the LLM via holes", () => {
    const verbs = projectedVerbs({ sessionOpen: false });
    expect(verbs.every((v) => ["build", "breath", "eval"].includes(v))).toBe(true);
    const holes = projectedHoles({ sessionOpen: false });
    expect(holes.search).toEqual(["intent"]);   // the LLM fills `intent`
    expect(holes.execute).toEqual(["endpoint", "params"]);
  });

  it("LOSSLESS: the union of all projections = the whole superpattern tree (nothing hidden forever)", () => {
    const union = new Set<string>();
    for (const ctx of [
      { sessionOpen: false }, { sessionOpen: true },
      { authRequired: true }, { sessionOpen: true, authRequired: true },
    ]) for (const c of cmds(ctx)) union.add(c);
    // every known command is reachable in some context — projection, not permanent hiding
    for (const command of knownCommands()) expect(union.has(command)).toBe(true);
  });
});
