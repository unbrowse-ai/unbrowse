/**
 * `@eN` accessibility-ref resolution — the seam between what `eval snap`
 * PRINTS and what `breath fill` / `breath click` can actually act on.
 *
 * ── Why this file exists ────────────────────────────────────────────────
 *
 * `eval snap` numbers the AX tree by DFS visit order and prints `[eN] role
 * "name"`. An `eN` ref is therefore an ORDINAL INTO A TREE, not an identity.
 * `breath fill` re-fetches `Accessibility.getFullAXTree` at fill time, so any
 * AX mutation between the snap and the fill slides every later ref.
 *
 * The mutation that bites on every login form in existence: Chrome exposes a
 * text input's VALUE as `StaticText` + `InlineTextBox` children of the input's
 * inner-editor `generic`. An empty `<input type=text>` contributes 2 AX nodes;
 * the same input holding "someuser" contributes 4. So:
 *
 *   snap        →  [e8] textbox "Username…"   [e14] textbox "Password"
 *   fill e8     →  ok. Tree gains 2 nodes INSIDE the username subtree.
 *   fill e14    →  e14 is now `StaticText "Password"` — the <label>'s DOM
 *                  #text node. `DOM.focus` on a #text answers
 *                  "Node is not an Element" and the fill dies at exit 65.
 *
 * Password inputs are NOT special in the a11y tree (Chrome exposes their value
 * the same way, as bullet StaticText). What is special is their POSITION: on a
 * login form the password is the field filled *second*, so it is the first ref
 * to be read after an earlier fill has already moved it. Any `fill`-then-`fill`
 * pair has the same defect; the password is simply where it is always noticed,
 * because a login cannot route around it.
 *
 * ── What this file refuses ──────────────────────────────────────────────
 *
 * Recovery is a BOUNDED, NAME-CHECKED walk, never a nearest-input grab. A ref
 * that slid onto a label's text is recovered to the control that label names —
 * and only when exactly one candidate exists within a few hops AND its
 * accessible name matches the text we landed on. Anything ambiguous is
 * REFUSED, loudly, naming the ref and the CSS fallback. Typing a password into
 * the username box because "there was an input nearby" is worse than exit 65.
 */

import type { AXNode, BackendNodeId } from "../types.js";

/** `e12`, `@e12`, `[e12]`, `@[e12]` — the forms `eval snap` output and the
 *  docs have both used. Case-insensitive. */
const AX_REF_RE = /^@?\[?e(\d+)\]?$/i;

/** How far up the AX tree a slid ref may be recovered. Three hops covers
 *  `StaticText -> LabelText -> field-wrapper`, which is the shape every form
 *  framework emits. Deeper reaches the <form> itself, where "the nearest
 *  input" stops meaning anything. */
const MAX_ANCESTOR_HOPS = 3;

/** AX roles a `fill` can legitimately target. Compared case-insensitively —
 *  CDP mixes `textbox` with `StaticText`. */
const FILLABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);

/** AX roles that carry text rather than being a control. Landing on one of
 *  these is the signature of a slid ref. */
const TEXTUAL_ROLES = new Set(["statictext", "inlinetextbox", "labeltext", "caption", "paragraph"]);

/** DOM.describeNode nodeType for an Element. Text is 3, Document is 9 — both
 *  are what Chrome rejects with "Node is not an Element". */
export const DOM_NODE_TYPE_ELEMENT = 1;

export interface AxRefResolutionOk {
  ok: true;
  backendDOMNodeId: BackendNodeId;
  node: AXNode;
  /** `direct` — the ref landed on the control itself.
   *  `descendant` — it landed on a wrapper that contains exactly one control.
   *  `label` — it landed on text that names exactly one nearby control. */
  via: "direct" | "descendant" | "label";
  /** Ancestor hops taken (0 for direct/descendant-of-self). */
  hops: number;
  /** What the ref literally pointed at, before recovery. */
  landedOn: { role: string; name: string };
}

export type AxRefFailureReason =
  | "not_a_ref"
  | "ref_out_of_range"
  | "ref_ambiguous"
  | "ref_not_fillable";

export interface AxRefResolutionErr {
  ok: false;
  reason: AxRefFailureReason;
  /** Present once the ref parsed and the tree was numbered. */
  landedOn?: { role: string; name: string };
  /** Total refs the current tree has, for `ref_out_of_range`. */
  refCount?: number;
  /** Accessible names of the competing controls, for `ref_ambiguous`. */
  candidates?: string[];
}

export type AxRefResolution = AxRefResolutionOk | AxRefResolutionErr;

function roleOf(node: AXNode | undefined): string {
  return node?.role?.value ?? "";
}

function nameOf(node: AXNode | undefined): string {
  const v = node?.name?.value;
  return typeof v === "string" ? v : "";
}

function isFillable(node: AXNode): boolean {
  return FILLABLE_ROLES.has(roleOf(node).toLowerCase()) && node.backendDOMNodeId !== undefined;
}

function isTextual(node: AXNode): boolean {
  return TEXTUAL_ROLES.has(roleOf(node).toLowerCase());
}

/** Normalise an accessible name for the label↔control match: collapse
 *  whitespace, drop a trailing required-marker `*`, lowercase. */
function normaliseName(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[*∗]\s*$/, "").trim().toLowerCase();
}

/** `e12` | `@e12` | `[e12]` -> 12. Anything else (a CSS selector) -> undefined. */
export function parseAxRef(raw: string): number | undefined {
  const m = raw.trim().match(AX_REF_RE);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** True when `raw` is shaped like an accessibility ref rather than a CSS
 *  selector. Kept separate from `parseAxRef` so callers can branch without
 *  caring about the index. */
export function looksLikeAxRef(raw: string): boolean {
  return parseAxRef(raw) !== undefined;
}

/**
 * THE numbering. `eval snap`'s `formatAxTree` assigns refs by first-visit DFS
 * order from every unreferenced root, counting ignored nodes but not printing
 * them. This reproduces that exactly; `tests/breath-fill-ax-ref.test.ts`
 * asserts the two agree against a recorded Chrome tree, so a change to either
 * cannot silently desynchronise display from resolution.
 *
 * Returns { order: nodeId -> ref index, byIndex: ref index -> nodeId }.
 */
export function numberAxTree(nodes: AXNode[]): {
  order: Map<string, number>;
  byIndex: string[];
  byId: Map<string, AXNode>;
  parentOf: Map<string, string>;
} {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);

  const referencedAsChild = new Set<string>();
  const parentOf = new Map<string, string>();
  for (const n of nodes) {
    for (const c of n.childIds ?? []) {
      referencedAsChild.add(c);
      if (!parentOf.has(c)) parentOf.set(c, n.nodeId);
    }
  }
  const roots = nodes.filter((n) => !referencedAsChild.has(n.nodeId));

  const order = new Map<string, number>();
  const byIndex: string[] = [];
  const walk = (id: string): void => {
    const n = byId.get(id);
    if (!n) return;
    if (!order.has(id)) {
      order.set(id, byIndex.length);
      byIndex.push(id);
    } else {
      // Already numbered — a second parent. Descending again would re-walk a
      // subtree that is already numbered; the numbers would not change, but
      // the recursion could not terminate on a cyclic childIds graph.
      return;
    }
    for (const c of n.childIds ?? []) walk(c);
  };
  for (const r of roots) walk(r.nodeId);

  return { order, byIndex, byId, parentOf };
}

/** Resolve `eN` to the AX node `eval snap` printed under that ref — with no
 *  recovery. This is the raw, honest answer to "what does this ref point at
 *  RIGHT NOW", and is what makes the slid-ref failure observable in a test. */
export function axNodeForRef(nodes: AXNode[], rawRef: string): AXNode | undefined {
  const wanted = parseAxRef(rawRef);
  if (wanted === undefined) return undefined;
  const { byIndex, byId } = numberAxTree(nodes);
  const id = byIndex[wanted];
  return id === undefined ? undefined : byId.get(id);
}

/** Every fillable control inside `rootId`'s subtree, in DFS order. */
function fillableDescendants(
  rootId: string,
  byId: Map<string, AXNode>,
  limit = 8,
): AXNode[] {
  const out: AXNode[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (out.length >= limit || seen.has(id)) return;
    seen.add(id);
    const n = byId.get(id);
    if (!n) return;
    if (isFillable(n)) out.push(n);
    for (const c of n.childIds ?? []) walk(c);
  };
  walk(rootId);
  return out;
}

/**
 * Resolve an `eN` ref to a backendDOMNodeId that `DOM.focus` will accept.
 *
 * The recovery ladder, in order, stopping at the first rung that answers:
 *   1. direct     — the ref is the control.
 *   2. descendant — the ref is a wrapper holding EXACTLY ONE control.
 *   3. label      — the ref is text, and within MAX_ANCESTOR_HOPS there is an
 *                   ancestor holding EXACTLY ONE control whose accessible name
 *                   matches that text.
 * More than one candidate at any rung is `ref_ambiguous` — refused, never
 * guessed. See the file header for why that refusal is load-bearing.
 */
export function resolveAxRefToFillable(nodes: AXNode[], rawRef: string): AxRefResolution {
  const wanted = parseAxRef(rawRef);
  if (wanted === undefined) return { ok: false, reason: "not_a_ref" };

  const { byIndex, byId, parentOf } = numberAxTree(nodes);
  const landedId = byIndex[wanted];
  if (landedId === undefined) {
    return { ok: false, reason: "ref_out_of_range", refCount: byIndex.length };
  }
  const landed = byId.get(landedId)!;
  const landedOn = { role: roleOf(landed), name: nameOf(landed) };

  // 1. direct
  if (isFillable(landed)) {
    return {
      ok: true,
      backendDOMNodeId: landed.backendDOMNodeId!,
      node: landed,
      via: "direct",
      hops: 0,
      landedOn,
    };
  }

  // 2. descendant — a wrapper/field div that contains exactly one control.
  const inSelf = fillableDescendants(landedId, byId);
  if (inSelf.length === 1) {
    return {
      ok: true,
      backendDOMNodeId: inSelf[0].backendDOMNodeId!,
      node: inSelf[0],
      via: "descendant",
      hops: 0,
      landedOn,
    };
  }
  if (inSelf.length > 1) {
    return { ok: false, reason: "ref_ambiguous", landedOn, candidates: inSelf.map(nameOf) };
  }

  // 3. label — only from a TEXT node, and only onto the control that text names.
  //    Without the name check this degenerates into "grab the nearest input",
  //    which on a login form types the password into the username box.
  if (!isTextual(landed)) {
    return { ok: false, reason: "ref_not_fillable", landedOn };
  }
  const landedText = normaliseName(nameOf(landed));
  let cursor: string | undefined = parentOf.get(landedId);
  for (let hops = 1; cursor !== undefined && hops <= MAX_ANCESTOR_HOPS; hops++) {
    const candidates = fillableDescendants(cursor, byId);
    if (candidates.length === 1) {
      const control = candidates[0];
      const controlName = normaliseName(nameOf(control));
      const named =
        landedText.length > 0 &&
        controlName.length > 0 &&
        (controlName === landedText ||
          controlName.includes(landedText) ||
          landedText.includes(controlName));
      if (!named) return { ok: false, reason: "ref_not_fillable", landedOn };
      return {
        ok: true,
        backendDOMNodeId: control.backendDOMNodeId!,
        node: control,
        via: "label",
        hops,
        landedOn,
      };
    }
    if (candidates.length > 1) {
      return { ok: false, reason: "ref_ambiguous", landedOn, candidates: candidates.map(nameOf) };
    }
    cursor = parentOf.get(cursor);
  }
  return { ok: false, reason: "ref_not_fillable", landedOn };
}

/**
 * The message a failed ref resolution dies with. It MUST name the ref and
 * offer the CSS fallback: the shipped failure was a bare
 * `{"error":"Node is not an Element"}` from Chrome, which names nothing an
 * operator can act on and does not say that `#password` would have worked.
 */
export function describeAxRefFailure(rawRef: string, res: AxRefResolutionErr): string {
  const landed = res.landedOn
    ? ` — it currently points at ${res.landedOn.role || "an unnamed node"}${res.landedOn.name ? ` ${JSON.stringify(res.landedOn.name)}` : ""}, which is not fillable`
    : "";
  const stale =
    " Refs are ordinals into the accessibility tree and shift when an earlier fill adds text to the page; re-run `unbrowse eval snap` for fresh refs, or pass a CSS selector (e.g. `#password`), which does not shift.";
  switch (res.reason) {
    case "not_a_ref":
      return `not_an_ax_ref:${rawRef}`;
    case "ref_out_of_range":
      return `ref_out_of_range:${rawRef} — the current accessibility tree has ${res.refCount ?? 0} refs (e0..e${Math.max(0, (res.refCount ?? 1) - 1)}).${stale}`;
    case "ref_ambiguous":
      return `ref_ambiguous:${rawRef}${landed}, and more than one input sits nearby (${(res.candidates ?? []).map((c) => JSON.stringify(c)).join(", ")}). Refusing to guess which one you meant.${stale}`;
    case "ref_not_fillable":
    default:
      return `ref_not_fillable:${rawRef}${landed}.${stale}`;
  }
}

/** The message for a backendNodeId that resolved to a non-Element DOM node —
 *  the raw shape of the shipped bug, kept as a backstop for the CSS path and
 *  for any ref the ladder above lets through. */
export function describeNonElementNode(selector: string, nodeType: number | undefined, nodeName?: string): string {
  return (
    `selector_not_an_element:${selector} — it resolved to a ${nodeName ?? `nodeType ${nodeType ?? "?"}`} DOM node, ` +
    "not an element, so Chrome refuses to focus it. " +
    "Pass a CSS selector for the input itself (e.g. `#password`), or re-run `unbrowse eval snap` for fresh refs."
  );
}

/** Minimal CDP shape this module needs: one already-session-bound call fn. */
export type SessionCall = <TParams, TResult>(method: string, params: TParams) => Promise<TResult>;

export interface FillTargetResolution {
  backendNodeId: BackendNodeId;
  /** `css` | `direct` | `descendant` | `label` — how the target was reached. */
  via: "css" | "direct" | "descendant" | "label";
  hops: number;
}

/**
 * Selector (CSS) OR `@eN` ref -> a backendNodeId that is guaranteed to be an
 * Element. Throws a NAMED error otherwise; never lets Chrome's opaque
 * "Node is not an Element" reach the operator.
 *
 * The Element assertion is a real `DOM.describeNode` round-trip rather than
 * trust in the AX role, because the AX role is exactly what was wrong: a
 * `StaticText` node reports a `backendDOMNodeId` that is a DOM #text.
 */
export async function resolveFillTarget(cdp: SessionCall, selector: string): Promise<FillTargetResolution> {
  let backendNodeId: BackendNodeId;
  let via: FillTargetResolution["via"];
  let hops = 0;

  if (looksLikeAxRef(selector)) {
    const ax = await cdp<Record<string, never>, { nodes?: AXNode[] }>("Accessibility.getFullAXTree", {});
    const res = resolveAxRefToFillable(ax.nodes ?? [], selector);
    if (!res.ok) throw new Error(describeAxRefFailure(selector, res));
    backendNodeId = res.backendDOMNodeId;
    via = res.via;
    hops = res.hops;
  } else {
    const doc = await cdp<Record<string, never>, { root: { nodeId: number } }>("DOM.getDocument", {});
    const node = await cdp<{ nodeId: number; selector: string }, { nodeId: number }>("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector,
    });
    if (!node.nodeId) throw new Error(`selector_not_found:${selector}`);
    const desc = await cdp<{ nodeId: number }, { node: { backendNodeId: number } }>("DOM.describeNode", {
      nodeId: node.nodeId,
    });
    backendNodeId = desc.node.backendNodeId;
    via = "css";
  }

  // Fail closed BEFORE DOM.focus. A non-Element here is the shipped bug; the
  // point of the check is that the operator gets a sentence naming the ref
  // instead of Chrome's four-word verdict.
  const shape = await cdp<{ backendNodeId: number }, { node: { nodeType?: number; nodeName?: string } }>(
    "DOM.describeNode",
    { backendNodeId },
  );
  const nodeType = shape.node?.nodeType;
  if (nodeType !== undefined && nodeType !== DOM_NODE_TYPE_ELEMENT) {
    throw new Error(describeNonElementNode(selector, nodeType, shape.node?.nodeName));
  }

  return { backendNodeId, via, hops };
}
