// CDP_PRIMITIVES.md §L-DOM — Accessibility.enable + getFullAXTree / getPartialAXTree

import type { AXNode, BackendNodeId, FrameId, NodeId, RemoteObjectId, Target } from "../types.js";

/**
 * Accessibility.enable — arms AX tree generation. Required before getFullAXTree on most Chrome builds.
 */
export async function accessibilityEnable(_target: Target): Promise<{ enabled: true }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Accessibility.getFullAXTree — replaces Kuri `snapshot(filter)`. The [e0]-rooted tree
 * for click-by-ref. Tree should land in value-store; receipt carries sha256 + node_count.
 */
export async function getFullAXTree(
  _target: Target,
  _opts?: { maxDepth?: number; frameId?: FrameId },
): Promise<{ nodes: AXNode[] }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Accessibility.getPartialAXTree — scoped AX read after a UI mutation.
 */
export async function getPartialAXTree(
  _target: Target,
  _ref: { nodeId?: NodeId; backendNodeId?: BackendNodeId; objectId?: RemoteObjectId },
  _opts?: { fetchRelatives?: boolean },
): Promise<{ nodes: AXNode[] }> {
  throw new Error("not_implemented_yet: scaffold only");
}

/**
 * Accessibility.getRootAXNode — surface the root AX node when only sessionId is known.
 */
export async function getRootAXNode(_target: Target, _opts?: { frameId?: FrameId }): Promise<{ node: AXNode }> {
  throw new Error("not_implemented_yet: scaffold only");
}
