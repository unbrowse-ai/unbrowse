/**
 * `breath fill` on an `@eN` snap ref — the "Node is not an Element" defect.
 *
 * ISSUE-2-session-and-refs.md §"Issue 3": `eval snap` prints
 *   [e40] textbox "Username or Email Address *"
 *   [e52] textbox "Password"
 * `act fill e40 …` succeeds and `act fill e52 …` dies with Chrome's
 * `{"error":"Node is not an Element","name":"Error"}` at exit 65, every time,
 * while `#password` works first try.
 *
 * THE MECHANISM (recorded, not assumed — see tests/fixtures/ax-login-form.json,
 * captured from headless Chromium 148 over a data: URL):
 *
 *   Chrome exposes a text input's VALUE as `StaticText` + `InlineTextBox`
 *   children of the input's inner-editor `generic`. Empty, the username input
 *   contributes 2 AX nodes; holding "someuser" it contributes 4. Those 2 extra
 *   nodes land INSIDE the username subtree, i.e. BEFORE the password subtree in
 *   DFS order, so every later ref slides by 2:
 *
 *     t0 (what snap printed):  [e8] textbox "Username…"   [e14] textbox "Password"
 *     t1 (after filling e8):   [e8] textbox "Username…"   [e16] textbox "Password"
 *                              …and e14 is now StaticText "Password" — the
 *                              <label>'s DOM #text node.
 *
 *   `breath fill` re-fetches getFullAXTree at fill time, so it resolves the
 *   stale e14 against t1, hands a #text backendNodeId to `DOM.focus`, and Chrome
 *   answers "Node is not an Element" (InspectorDOMAgent::AssertElement).
 *
 * Password inputs are NOT special in the a11y tree — Chrome exposes their value
 * the same way (as bullet StaticText). What is special is their POSITION: the
 * password is the field filled SECOND on a login form, so it is the first ref
 * read after an earlier fill already moved it. Any fill-then-fill pair has this
 * defect; the password is where it is always noticed because a login cannot
 * route around it. CSS selectors work because they do not index into a tree
 * that moves.
 *
 * No browser and no network here: the fixture is a recording.
 */
import { describe, expect, test } from "bun:test";

import {
  axNodeForRef,
  describeAxRefFailure,
  describeNonElementNode,
  looksLikeAxRef,
  numberAxTree,
  parseAxRef,
  resolveAxRefToFillable,
  resolveFillTarget,
  type SessionCall,
} from "../src/cdp/dom/ref.js";
import { formatAxTree } from "../src/cli-v7/eval/snap.js";
import type { AXNode } from "../src/cdp/types.js";

import fixture from "./fixtures/ax-login-form.json" with { type: "json" };

const T0 = fixture.t0 as unknown as AXNode[];
const T1 = fixture.t1 as unknown as AXNode[];

/** backendDOMNodeId of the two <input>s in the recording. Stable across t0/t1
 *  because a backendNodeId is an identity; a ref ordinal is not. */
const USERNAME_INPUT_BACKEND_ID = 2;
const PASSWORD_INPUT_BACKEND_ID = 3;
/** backendDOMNodeId of the <label>Password</label> DOM #text node — the thing
 *  the stale ref lands on and the thing Chrome refuses to focus. */
const PASSWORD_LABEL_TEXT_BACKEND_ID = 17;

describe("ref parsing", () => {
  test("accepts every form snap and the docs have printed", () => {
    for (const raw of ["e14", "@e14", "[e14]", "@[e14]", "E14", " e14 "]) {
      expect(parseAxRef(raw)).toBe(14);
      expect(looksLikeAxRef(raw)).toBe(true);
    }
  });

  test("a CSS selector is not a ref", () => {
    for (const css of ["#password", ".field input", "input[type=password]", "e", "#e14"]) {
      expect(parseAxRef(css)).toBeUndefined();
      expect(looksLikeAxRef(css)).toBe(false);
    }
  });
});

describe("numbering parity with what `eval snap` prints", () => {
  // If resolution numbered the tree differently from the formatter, every ref
  // would be wrong by a constant and this whole file would be testing fiction.
  test.each([["t0", T0], ["t1", T1]] as const)("%s: every printed [eN] resolves to that node", (_label, nodes) => {
    const printed = formatAxTree(nodes);
    const refs = [...printed.matchAll(/\[e(\d+)\] (\S+)(?: (".*"))?/g)];
    expect(refs.length).toBeGreaterThan(5);
    for (const [, idx, role, name] of refs) {
      const node = axNodeForRef(nodes, `e${idx}`);
      expect(node, `e${idx} printed but did not resolve`).toBeDefined();
      expect(node!.role?.value).toBe(role);
      if (name) expect(JSON.stringify(node!.name?.value ?? "")).toBe(name);
    }
  });

  test("numbering counts ignored nodes, so refs survive pruning", () => {
    const { byIndex, byId } = numberAxTree(T0);
    expect(byId.get(byIndex[1])!.ignored).toBe(true);
    expect(byId.get(byIndex[2])!.ignored).toBe(true);
    expect(formatAxTree(T0)).not.toContain("[e1]");
  });
});

describe("the recorded defect", () => {
  test("t0: snap prints the password textbox at e14", () => {
    expect(formatAxTree(T0)).toContain('[e14] textbox "Password"');
  });

  test("filling the username inserts 2 AX nodes AHEAD of the password", () => {
    expect(T1.length - T0.length).toBe(2);
    expect(formatAxTree(T1)).toContain('[e10] StaticText "someuser"');
    expect(formatAxTree(T1)).toContain('[e16] textbox "Password"');
  });

  test("so the ref snap handed out now points at a DOM #text node", () => {
    const landed = axNodeForRef(T1, "e14");
    expect(landed!.role?.value).toBe("StaticText");
    expect(landed!.name?.value).toBe("Password");
    expect(landed!.backendDOMNodeId).toBe(PASSWORD_LABEL_TEXT_BACKEND_ID);
    // ^ this backendNodeId is what used to reach DOM.focus, and a #text node
    //   is what Chrome answers "Node is not an Element" about.
  });
});

describe("resolveAxRefToFillable", () => {
  test("fresh ref resolves directly to the input", () => {
    const r = resolveAxRefToFillable(T0, "e14");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backendDOMNodeId).toBe(PASSWORD_INPUT_BACKEND_ID);
    expect(r.via).toBe("direct");
  });

  test("THE FIX — a slid ref that landed on the label's text recovers the input it names", () => {
    const r = resolveAxRefToFillable(T1, "e14");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backendDOMNodeId).toBe(PASSWORD_INPUT_BACKEND_ID);
    expect(r.backendDOMNodeId).not.toBe(PASSWORD_LABEL_TEXT_BACKEND_ID);
    expect(r.via).toBe("label");
    expect(r.landedOn).toEqual({ role: "StaticText", name: "Password" });
    // And it must be the PASSWORD input, not merely "an input": recovering the
    // username here would type the password into the wrong box, which is worse
    // than the exit 65 it replaces.
    expect(r.backendDOMNodeId).not.toBe(USERNAME_INPUT_BACKEND_ID);
  });

  test("a wrapper ref resolves down to the single control it holds", () => {
    // e12 in t1 is the password field's wrapper <div> (role generic, no name).
    const r = resolveAxRefToFillable(T1, "e12");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.via).toBe("descendant");
    expect(r.backendDOMNodeId).toBe(PASSWORD_INPUT_BACKEND_ID);
  });

  test("REFUSES rather than guesses when more than one input is in reach", () => {
    // e3 is the <form>: two textboxes below it. "Nearest input" would pick one.
    const r = resolveAxRefToFillable(T1, "e3");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ref_ambiguous");
    expect(r.candidates).toEqual(["Username or Email Address", "Password"]);
  });

  test("REFUSES text that names no nearby control", () => {
    // e19 in t1 is the submit button's StaticText "Sign In". Its own subtree
    // holds no control; the climb reaches the <form>, where two inputs compete.
    // Either way the answer must be a refusal — never "the closest input".
    const r = resolveAxRefToFillable(T1, "e19");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(["ref_ambiguous", "ref_not_fillable"]).toContain(r.reason);
  });

  test("REFUSES a lone control whose name does not match the text landed on", () => {
    // Exactly ONE input in reach, so a count-only check would accept it. The
    // name check is what refuses: "Sign In" does not label "Password". Without
    // it, "walk to the nearest input" silently types a password into whatever
    // control happens to be adjacent.
    const ax = (n: Partial<AXNode> & { nodeId: string }): AXNode =>
      ({ ignored: false, ...n }) as AXNode;
    const tree: AXNode[] = [
      ax({ nodeId: "f", role: { type: "role", value: "form" }, childIds: ["w"], backendDOMNodeId: 1 }),
      ax({ nodeId: "w", role: { type: "role", value: "generic" }, childIds: ["b", "pw"], backendDOMNodeId: 2 }),
      ax({ nodeId: "b", role: { type: "role", value: "button" }, name: { type: "computedString", value: "Sign In" }, childIds: ["bt"], backendDOMNodeId: 3 }),
      ax({ nodeId: "bt", role: { type: "internalRole", value: "StaticText" }, name: { type: "computedString", value: "Sign In" }, childIds: [], backendDOMNodeId: 4 }),
      ax({ nodeId: "pw", role: { type: "role", value: "textbox" }, name: { type: "computedString", value: "Password" }, childIds: [], backendDOMNodeId: 5 }),
    ];
    expect(axNodeForRef(tree, "e3")?.name?.value).toBe("Sign In");
    const r = resolveAxRefToFillable(tree, "e3");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ref_not_fillable");
  });

  test("a ref past the end of the tree is named, not silently undefined", () => {
    const r = resolveAxRefToFillable(T1, "e999");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("ref_out_of_range");
    expect(r.refCount).toBe(T1.length);
  });
});

describe("the error an operator actually reads", () => {
  const messages = [
    describeAxRefFailure("e52", { ok: false, reason: "ref_not_fillable", landedOn: { role: "StaticText", name: "Password" } }),
    describeAxRefFailure("e52", { ok: false, reason: "ref_out_of_range", refCount: 40 }),
    describeAxRefFailure("e52", { ok: false, reason: "ref_ambiguous", landedOn: { role: "form", name: "" }, candidates: ["a", "b"] }),
    describeNonElementNode("e52", 3, "#text"),
  ];

  test("names the ref", () => {
    for (const m of messages) expect(m).toContain("e52");
  });

  test("offers the CSS fallback the report had to discover by hand", () => {
    for (const m of messages) expect(m.toLowerCase()).toContain("css selector");
  });

  test("is never Chrome's opaque four-word verdict", () => {
    for (const m of messages) expect(m).not.toBe("Node is not an Element");
  });
});

// ── The CDP seam, mocked. No browser, no network. ────────────────────────────

interface Recorded {
  method: string;
  params: unknown;
}

/** A fake session-bound CDP call over the recorded tree. `describeNode` answers
 *  the real nodeType for each backendNodeId in the fixture, so "did we hand
 *  Chrome a #text?" is decidable without Chrome. */
function mockCdp(nodes: AXNode[], recorded: Recorded[]): SessionCall {
  const ELEMENT_BACKEND_IDS = new Set([1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15]);
  const TEXT_BACKEND_IDS = new Set([16, 17, 18, 19]);
  return (async (method: string, params: any) => {
    recorded.push({ method, params });
    if (method === "Accessibility.getFullAXTree") return { nodes };
    if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
    if (method === "DOM.querySelector") {
      return { nodeId: params.selector === "#password" ? 77 : 0 };
    }
    if (method === "DOM.describeNode") {
      if (params.nodeId === 77) return { node: { backendNodeId: PASSWORD_INPUT_BACKEND_ID } };
      const be = params.backendNodeId;
      if (TEXT_BACKEND_IDS.has(be)) return { node: { nodeType: 3, nodeName: "#text" } };
      if (ELEMENT_BACKEND_IDS.has(be)) return { node: { nodeType: 1, nodeName: "INPUT" } };
      return { node: { nodeType: 1, nodeName: "DIV" } };
    }
    throw new Error(`unexpected CDP method in mock: ${method}`);
  }) as SessionCall;
}

describe("resolveFillTarget (the seam breath fill calls)", () => {
  test("stale password ref no longer reaches Chrome as a #text node", async () => {
    const recorded: Recorded[] = [];
    const target = await resolveFillTarget(mockCdp(T1, recorded), "e14");
    expect(target.backendNodeId).toBe(PASSWORD_INPUT_BACKEND_ID);
    expect(target.via).toBe("label");
    // The falsifier for the whole change: no describeNode/focus was ever asked
    // about the label's #text node.
    const touched = recorded
      .filter((r) => r.method === "DOM.describeNode")
      .map((r) => (r.params as { backendNodeId?: number }).backendNodeId);
    expect(touched).not.toContain(PASSWORD_LABEL_TEXT_BACKEND_ID);
  });

  test("fresh ref still resolves directly", async () => {
    const target = await resolveFillTarget(mockCdp(T0, []), "e14");
    expect(target.backendNodeId).toBe(PASSWORD_INPUT_BACKEND_ID);
    expect(target.via).toBe("direct");
  });

  test("CSS selector path is unchanged and does not read the AX tree", async () => {
    const recorded: Recorded[] = [];
    const target = await resolveFillTarget(mockCdp(T1, recorded), "#password");
    expect(target.backendNodeId).toBe(PASSWORD_INPUT_BACKEND_ID);
    expect(target.via).toBe("css");
    expect(recorded.map((r) => r.method)).not.toContain("Accessibility.getFullAXTree");
  });

  test("a missing CSS selector still fails as selector_not_found", async () => {
    await expect(resolveFillTarget(mockCdp(T1, []), "#nope")).rejects.toThrow(/^selector_not_found:#nope$/);
  });

  test("an unrecoverable ref throws a message naming the ref, not Chrome's", async () => {
    let msg = "";
    try {
      await resolveFillTarget(mockCdp(T1, []), "e19");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain("e19");
    expect(msg.toLowerCase()).toContain("css selector");
    expect(msg).not.toBe("Node is not an Element");
  });

  test("backstop: a non-Element that slips through is named, not passed to focus", async () => {
    // Force the ladder to hand back a #text by resolving a ref directly onto
    // one — the guard, not the ladder, is what must catch this.
    const recorded: Recorded[] = [];
    const cdp = mockCdp(T1, recorded);
    const wrapped: SessionCall = (async (method: string, params: any) => {
      if (method === "Accessibility.getFullAXTree") {
        // Relabel the label's #text node as a textbox: a lying AX role.
        const lying = T1.map((n) =>
          n.backendDOMNodeId === PASSWORD_LABEL_TEXT_BACKEND_ID
            ? { ...n, role: { type: "role", value: "textbox" } }
            : n,
        );
        recorded.push({ method, params });
        return { nodes: lying };
      }
      return cdp(method, params);
    }) as SessionCall;
    await expect(resolveFillTarget(wrapped, "e14")).rejects.toThrow(/selector_not_an_element:e14/);
  });
});
