/**
 * `unbrowse eval snap` — Accessibility.getFullAXTree of the current page.
 *
 * 1:1 mapping (kind-map.ts row "eval snap"):
 *   CLI subcommand  : eval snap
 *   MCP tool        : unbrowse_snap
 *   Op kind   : eval:snap
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
import { createHash } from "node:crypto";

import { attach, attachToTarget, call } from "../../cdp/index.js";
import type { AXNode } from "../../cdp/types.js";
import type { ParsedV7Args } from "../args.js";
import { resolveSession } from "../_session.js";
import { isObscuraSession, obscuraClient, isObscuraNull } from "../../obscura/live-page.js";
import {
  EX_GENERIC,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";
import { postStateless } from "../_stateless.js";
import { classifyAuthenticatedPage } from "../../auth/index.js";

/** sha256-hex of a string, sliced to 32 chars — the urlHash shape the
 *  backend's eval-read validator accepts. URL bytes stay in-process. */
function urlHash32(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

async function getCurrentUrlSafe(conn: Awaited<ReturnType<typeof attach>>, sessionId: string): Promise<string> {
  try {
    const r = await call<{ expression: string; returnByValue: boolean }, { result?: { value?: unknown } }>(
      conn,
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      sessionId,
    );
    return typeof r.result?.value === "string" ? r.result.value : "";
  } catch {
    return "";
  }
}

interface GetFullAXTreeResult {
  nodes: AXNode[];
}

const ACTIONABLE_AX_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "listbox", "menuitem",
  "option", "radio", "searchbox", "slider", "spinbutton", "switch",
  "tab", "textbox", "treeitem",
]);

/** Pure truth seam: a root title plus anonymous generic wrappers is not page
 * content. Callers must corroborate it through DOM or pixels before reporting
 * a successful snapshot. */
export function assessAxTree(nodes: AXNode[]): {
  usable: boolean;
  actionableCount: number;
  meaningfulNameCount: number;
} {
  let actionableCount = 0;
  let meaningfulNameCount = 0;
  for (const node of nodes) {
    if (node.ignored) continue;
    const role = String(node.role?.value ?? "").toLowerCase();
    const name = typeof node.name?.value === "string" ? node.name.value.trim() : "";
    if (ACTIONABLE_AX_ROLES.has(role)) actionableCount += 1;
    if (name && role !== "rootwebarea") meaningfulNameCount += 1;
  }
  return {
    usable: actionableCount > 0 || meaningfulNameCount > 0,
    actionableCount,
    meaningfulNameCount,
  };
}

export function adjudicateSnapContent(input: {
  axUsable: boolean;
  domText: string;
  screenshot: string | null;
}): { taskOk: boolean; source: "accessibility" | "dom_text" | "screenshot" | "none" } {
  if (input.axUsable) return { taskOk: true, source: "accessibility" };
  if (input.domText.trim()) return { taskOk: true, source: "dom_text" };
  if (input.screenshot) return { taskOk: true, source: "screenshot" };
  return { taskOk: false, source: "none" };
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
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "eval",
      },
      opts,
    );
  }

  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;

  try {
    const rec = await resolveSession(sessionFlag);

    // Chrome-free backend. obscura has no Accessibility.getFullAXTree; its
    // equivalent is `browser_interactive_elements`, which emits the actionable
    // elements as `ref=eN <role> "label"`. Those refs are obscura's OWN and its
    // click/fill resolve them directly (ObscuraHttpClient.targetArgs sends a
    // ref as `ref`, not as a CSS selector), so the snap -> fill/click loop holds
    // on this backend too. The AX-usability heuristics below are CDP-tree
    // specific, so this path emits the ref listing and returns.
    if (isObscuraSession(rec)) {
      const client = obscuraClient(rec);
      const listing = await client.interactiveElements();
      const url = await client.evaluate("location.href").catch(() => "");
      if (opts.json) {
        emit(
          {
            ok: true,
            subcommand: "eval snap",
            op_kind: meta.op_kind,
            session_id: rec.sessionId,
            backend: "obscura",
            url: isObscuraNull(url) ? "" : url.trim(),
            snapshot: listing,
            refs: (listing.match(/ref=e\d+/g) ?? []).length,
          },
          opts,
        );
      } else {
        process.stdout.write(listing + (listing.endsWith("\n") ? "" : "\n"));
      }
      process.exit(0);
    }

    const conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);
    const result = await call<Record<string, never>, GetFullAXTreeResult>(
      conn,
      "Accessibility.getFullAXTree",
      {},
      target.sessionId,
    );
    const nodes = result.nodes ?? [];
    const tree = formatAxTree(nodes);
    const axAssessment = assessAxTree(nodes);
    let domText = "";
    let screenshot: string | null = null;
    if (!axAssessment.usable) {
      try {
        const dom = await call<
          { expression: string; returnByValue: boolean },
          { result?: { value?: unknown } }
        >(
          conn,
          "Runtime.evaluate",
          {
            expression: "document.body?.innerText?.trim().slice(0, 20000) || ''",
            returnByValue: true,
          },
          target.sessionId,
        );
        domText = typeof dom.result?.value === "string" ? dom.result.value.trim() : "";
      } catch {
        domText = "";
      }
      try {
        const shot = await call<
          { format: "png"; captureBeyondViewport: boolean },
          { data?: unknown }
        >(
          conn,
          "Page.captureScreenshot",
          { format: "png", captureBeyondViewport: false },
          target.sessionId,
        );
        screenshot = typeof shot.data === "string" && shot.data.length > 0 ? shot.data : null;
      } catch {
        screenshot = null;
      }
    }
    // A2 — EVERY eval read emits a sig-keyed audit row (metadata-only
    // — never the tree bytes, never the URL). The post is best-effort:
    // failure surfaces in the JSON envelope as `audit_emit.ok=false`
    // but does NOT block the read output. The bytes travel to stdout
    // exactly as before (pointer-not-payload for the pointer-of-pointer;
    // the AX tree is the value the agent asked for).
    const currentUrl = await getCurrentUrlSafe(conn, target.sessionId);
    const authOutcome = classifyAuthenticatedPage({
      pageText: axAssessment.usable ? tree : domText,
      hadPresentedCredentials: false,
      currentUrl,
    });
    const post = await postStateless({
      namespace: "audit",
      route: "/v1/audit/eval-read",
      body: {
        sessionId: rec.sessionId,
        urlHash: urlHash32(currentUrl),
        readKind: "snap" as const,
        byteCount: tree.length,
      },
      signableFields: [
        "sessionId",
        "urlHash",
        "readKind",
        "byteCount",
        "selectorHash",
        "nonce",
      ],
    });
    const auditEmit = {
      ok: post.ok,
      cacheKey: post.cacheKey,
      receiptId: post.receiptId,
      httpStatus: post.httpStatus,
      bindingMissing: post.bindingMissing,
      errorHint: post.errorHint,
    };
    const contentOutcome = adjudicateSnapContent({
      axUsable: axAssessment.usable,
      domText,
      screenshot,
    });

    if (!contentOutcome.taskOk) {
      emit(
        {
          ok: false,
          operational_ok: true,
          task_ok: false,
          subcommand: "eval snap",
          op_kind: meta.op_kind,
          session_id: rec.sessionId,
          target_id: rec.targetId,
          error: "content_unavailable",
          reason: "accessibility tree was empty/generic and both DOM text and screenshot fallbacks were empty",
          ax_assessment: axAssessment,
          next_step: "retry after the SPA finishes rendering, or use `unbrowse screenshot --session <id>` to inspect the visible page",
          audit_emit: auditEmit,
        },
        opts,
      );
      process.exit(69);
    }

    if (opts.json) {
      emit(
        {
          ok: true,
          operational_ok: true,
          subcommand: "eval snap",
          op_kind: meta.op_kind,
          session_id: rec.sessionId,
          target_id: rec.targetId,
          tree,
          ax_assessment: axAssessment,
          fallback: axAssessment.usable ? null : {
            source: contentOutcome.source,
            dom_text: domText || null,
            screenshot,
          },
          auth_outcome: authOutcome,
          auth_ok: authOutcome === "authenticated" ? true
            : authOutcome === "auth_required" || authOutcome === "session_expired" ? false
            : null,
          auth_required: authOutcome === "auth_required",
          session_expired: authOutcome === "session_expired",
          audit_emit: auditEmit,
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
