// CDP_PRIMITIVES.md §L-DOM — DOM.getDocument / querySelector / outerHTML / boxModel

import type { BackendNodeId, BoxModel, DOMNode, FrameId, NodeId, RemoteObjectId, Target } from "../types.js";

/**
 * DOM.getDocument — first DOM read per session; hands out nodeIds for subsequent queries.
 */
export async function getDocument(
  _target: Target,
  _opts?: { depth?: number; pierce?: boolean },
): Promise<{ root: DOMNode }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * DOM.querySelector — `getElementByRef`-style single-element lookup.
 */
export async function querySelector(_target: Target, _nodeId: NodeId, _selector: string): Promise<{ nodeId: NodeId | 0 }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * DOM.querySelectorAll — multi-element selection (replaces Kuri's `domQuery(all:true)`).
 */
export async function querySelectorAll(_target: Target, _nodeId: NodeId, _selector: string): Promise<{ nodeIds: NodeId[] }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * DOM.getOuterHTML — replaces `domHtml` + `getPageHtml`. HTML body should land in value-store.
 */
export async function getOuterHTML(
  _target: Target,
  _ref: { nodeId?: NodeId; backendNodeId?: BackendNodeId; objectId?: RemoteObjectId },
): Promise<{ outerHTML: string }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * DOM.getAttributes — replaces Kuri `domAttributes`.
 */
export async function getAttributes(_target: Target, _nodeId: NodeId): Promise<{ attributes: Record<string, string> }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * DOM.describeNode — iframe-piercing / shadow-DOM bridging.
 */
export async function describeNode(
  _target: Target,
  _ref: { nodeId?: NodeId; backendNodeId?: BackendNodeId; objectId?: RemoteObjectId },
  _opts?: { depth?: number; pierce?: boolean },
): Promise<{ node: DOMNode; frameId?: FrameId; shadowRootType?: string }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * DOM.getBoxModel — compute coords for Input.dispatchMouseEvent (click-by-ref pipeline).
 */
export async function getBoxModel(_target: Target, _nodeId: NodeId): Promise<{ model: BoxModel }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * DOM.scrollIntoViewIfNeeded — replaces Kuri `scrollIntoView`.
 */
export async function scrollIntoViewIfNeeded(_target: Target, _nodeId: NodeId): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * DOM.focus — pre-input focus; deterministic vs relying on click coords.
 */
export async function focus(_target: Target, _nodeId: NodeId): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * DOM.setAttributeValue — programmatic form-fill bypassing React controlled-input traps.
 */
export async function setAttributeValue(_target: Target, _nodeId: NodeId, _name: string, _value: string): Promise<void> {
  throw new Error("not_implemented_yet: scaffold only");
}
