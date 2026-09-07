import { describe, expect, test } from "bun:test";
import { markNewSnapElements, shapeSnapResult } from "../src/api/browse-snap-detail-levels.js";

// Child contract: mark-new-and-changed-interactive-elements-in-unb
// Best practice source_id: deepwiki:browser-use/browser-use (new-element
// `*[` indicator). markNewSnapElements prefixes `*` to the [eN] ref of any
// interactive element whose (role, name) identity was absent from the prior
// snapshot of the same browse session, so the agent sees the post-action
// delta without re-reading the whole accessibility tree.

const FIRST = [
  '[e0] WebArea "Checkout"',
  '  [e1] link "Home"',
  '  [e2] textbox "Email"',
  '  [e3] button "Continue"',
].join("\n");

// Same page after a click: a validation error + a new field appeared.
// Refs renumbered (e2 -> e3 etc.) — a ref-based diff would false-positive.
const SECOND = [
  '[e0] WebArea "Checkout"',
  '  [e1] link "Home"',
  '  [e2] alert "Email is required"',
  '  [e3] textbox "Email"',
  '  [e4] textbox "Phone"',
  '  [e5] button "Continue"',
].join("\n");

describe("markNewSnapElements — browser-use new-element delta marker", () => {
  test("first snapshot of a session marks nothing (no prior)", () => {
    const out = markNewSnapElements(FIRST, undefined);
    expect(out.first_snapshot, "first snap flagged").toBe(true);
    expect(out.new_element_count, "nothing counted as new on first snap").toBe(0);
    expect(out.snapshot, "first snapshot returned verbatim").toBe(FIRST);
    expect(out.snapshot.includes("*["), "no marker on first snap").toBe(false);
  });

  test("elements absent from the prior snapshot are marked with *", () => {
    const out = markNewSnapElements(SECOND, FIRST);
    expect(out.first_snapshot).toBe(false);
    // alert "Email is required" and textbox "Phone" are the two new ones
    expect(out.new_element_count, "exactly two new elements").toBe(2);
    expect(out.snapshot.includes('*[e2] alert "Email is required"'), "new alert marked").toBe(true);
    expect(out.snapshot.includes('*[e4] textbox "Phone"'), "new field marked").toBe(true);
  });

  test("elements present in both are NOT marked despite ref renumbering", () => {
    const out = markNewSnapElements(SECOND, FIRST);
    // "Email" textbox was e2 in FIRST, e3 in SECOND — same identity, not new.
    expect(out.snapshot.includes('  [e3] textbox "Email"'), "Email unmarked").toBe(true);
    expect(out.snapshot.includes('*[e3] textbox "Email"'), "Email NOT marked new").toBe(false);
    // "Continue" button renumbered e3 -> e5, still not new.
    expect(out.snapshot.includes('  [e5] button "Continue"'), "Continue unmarked").toBe(true);
    expect(out.snapshot.includes('*[e5]'), "Continue NOT marked new").toBe(false);
  });

  test("identical snapshot twice yields zero new elements", () => {
    const out = markNewSnapElements(FIRST, FIRST);
    expect(out.new_element_count, "no delta => zero").toBe(0);
    expect(out.snapshot, "unchanged snapshot returned verbatim").toBe(FIRST);
  });

  test("indentation is preserved when the marker is inserted", () => {
    const out = markNewSnapElements(SECOND, FIRST);
    // marker goes before [eN], the two-space indent stays to its left
    expect(out.snapshot.includes('  *[e4] textbox "Phone"'), "indent kept left of marker").toBe(true);
  });

  test("a marked snapshot still parses: shapeSnapResult counts every interactive element", () => {
    const marked = markNewSnapElements(SECOND, FIRST).snapshot;
    const shaped = shapeSnapResult({ snapshot: marked }, "minimal");
    const v = shaped.value as Record<string, unknown>;
    // SECOND has 6 [eN] elements; the * marker must not drop any from the count.
    expect(v.interactive_count, "marker does not break parseSnapshot count").toBe(6);
  });

  test("empty or non-string snapshot is a safe no-op", () => {
    const a = markNewSnapElements("", FIRST);
    expect(a.new_element_count).toBe(0);
    expect(a.first_snapshot).toBe(true);
    // @ts-expect-error — exercising the runtime guard against a non-string
    const b = markNewSnapElements(undefined, FIRST);
    expect(b.new_element_count).toBe(0);
  });
});
