/**
 * `unbrowse eval snap` — Accessibility.getFullAXTree of the current page.
 *
 * 1:1 mapping (kind-map.ts row "eval snap"):
 *   CLI subcommand  : eval snap
 *   MCP tool        : unbrowse_snap
 *   Covenant kind   : observe_snap
 *   Verb            : eval
 *
 * Loads the most-recent (or --session-named) session record from
 * ~/.unbrowse/sessions/, attaches to the Chrome at chromeWsUrl, fires
 * Accessibility.getFullAXTree on the persisted target session, and prints a
 * compact `[eN] role name` tree to stdout (so subsequent `breath click <ref>`
 * etc. have stable element refs — matching the v6 unbrowse_snap UX surface).
 *
 * No AX-tree formatter existed in src/ pre-W7 (the v6 path lives server-side
 * in `/v1/browse/snap`), so this file ships its own minimal renderer.
 */
import { attach, attachToTarget, call } from "../../cdp/index.js";
import type { AXNode } from "../../cdp/types.js";
import type { ParsedV7Args } from "../args.js";
import { resolveSession } from "../_session.js";
import {
  EX_GENERIC,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";

interface GetFullAXTreeResult {
  nodes: AXNode[];
}

/**
 * Compact `[eN] role name` rendering of an AX tree. Builds a parent->child
 * map from `childIds`, walks DFS from the first non-ignored root, and emits
 * one indented line per node. Ignored nodes are pruned from the output but
 * NOT from numbering — `[e0]` is always the root frame, regardless of how
 * many ignored nodes precede it, so refs stay stable across re-snaps of the
 * same page (mirroring the v6 `e0/e1/e2` UX contract).
 */
export function formatAxTree(nodes: AXNode[]): string {
  const byId = new Map<string, AXNode>();
  for (const n of nodes) byId.set(n.nodeId, n);

  // Find the root: a node nobody references in childIds.
  const referencedAsChild = new Set<string>();
  for (const n of nodes) {
    for (const c of n.childIds ?? []) referencedAsChild.add(c);
  }
  const roots = nodes.filter((n) => !referencedAsChild.has(n.nodeId));
  if (roots.length === 0) return "(empty ax tree)";

  // Number nodes in DFS visit order so refs are deterministic.
  const order = new Map<string, number>();
  const walk = (id: string): void => {
    const n = byId.get(id);
    if (!n) return;
    if (!order.has(id)) order.set(id, order.size);
    for (const c of n.childIds ?? []) walk(c);
  };
  for (const r of roots) walk(r.nodeId);

  const lines: string[] = [];
  const emitNode = (id: string, depth: number): void => {
    const n = byId.get(id);
    if (!n) return;
    if (!n.ignored) {
      const ref = `e${order.get(id) ?? "?"}`;
      const role = n.role?.value ?? "unknown";
      const name = typeof n.name?.value === "string" ? n.name.value : "";
      const namePart = name ? ` ${JSON.stringify(name)}` : "";
      lines.push(`${"  ".repeat(depth)}[${ref}] ${role}${namePart}`);
    }
    for (const c of n.childIds ?? []) emitNode(c, n.ignored ? depth : depth + 1);
  };
  for (const r of roots) emitNode(r.nodeId, 0);
  return lines.join("\n");
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("eval", "snap")!;

  if (parsed.wantsHelp) {
    helpExit(
      "eval snap",
      {
        summary: "Accessibility.getFullAXTree of the current page (the [e0] frame).",
        usage: "unbrowse eval snap [--session <id>]",
        flags: [
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;

  try {
    const rec = await resolveSession(sessionFlag);
    const conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);
    const result = await call<Record<string, never>, GetFullAXTreeResult>(
      conn,
      "Accessibility.getFullAXTree",
      {},
      target.sessionId,
    );
    const tree = formatAxTree(result.nodes ?? []);

    if (opts.json) {
      emit(
        {
          ok: true,
          subcommand: "eval snap",
          covenant_kind: meta.covenant_kind,
          session_id: rec.sessionId,
          target_id: rec.targetId,
          tree,
        },
        opts,
      );
    } else {
      process.stdout.write(tree + "\n");
    }
    // Do NOT call conn.close() — that kills Chrome via Browser.close.
    // Process exit drops the WS handle; Chrome stays alive for re-attach.
    process.exit(0);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }
}
