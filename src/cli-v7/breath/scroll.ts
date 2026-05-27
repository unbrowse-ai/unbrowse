/**
 * `unbrowse breath scroll [selector] <dx,dy>` — page or element scroll.
 *
 * 1:1 mapping (kind-map.ts row "breath scroll"):
 *   CLI subcommand  : breath scroll
 *   MCP tool        : unbrowse_scroll
 *   Covenant kind   : actuate_scroll
 *   Verb            : breath
 *
 * NO value-bearing surface — `scroll` never touches src/values/, never POSTs
 * an audit body. It's a viewport gesture. CDP: Input.dispatchMouseEvent
 * with type='mouseWheel' at the chosen coordinate.
 *
 * Positional convention:
 *   - `scroll 0,500`         (one positional)  -> viewport scroll dx=0,dy=500
 *   - `scroll #main 0,200`   (two positionals) -> element-anchored scroll
 *   - `scroll 500`           (single integer)  -> dy=500, dx=0
 *
 * Exit codes:
 *   0   success
 *   64  EX_USAGE — bad <dx,dy> format
 *   65  EX_CDP   — CDP attach / dispatchMouseEvent failed
 *   1   generic failure
 */
import { attach, attachToTarget, call } from "../../cdp/index.js";

import type { ParsedV7Args } from "../args.js";
import { resolveSession } from "../_session.js";
import {
  EX_GENERIC,
  EX_USAGE,
  emit,
  emitErr,
  helpExit,
  type OutputOptions,
} from "../output.js";
import { lookupKindMap } from "../kind-map.js";

const EX_CDP = 65;

const SCROLL_AMOUNT_RE = /^-?\d+(,-?\d+)?$/;

function parseAmount(raw: string): { dx: number; dy: number } | null {
  if (!SCROLL_AMOUNT_RE.test(raw)) return null;
  const parts = raw.split(",");
  if (parts.length === 1) {
    const dy = Number(parts[0]);
    return Number.isFinite(dy) ? { dx: 0, dy } : null;
  }
  const dx = Number(parts[0]);
  const dy = Number(parts[1]);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  return { dx, dy };
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("breath", "scroll")!;

  if (parsed.wantsHelp) {
    helpExit(
      "breath scroll",
      {
        summary: "Scroll the viewport or an element by (dx, dy) pixels via wheel event.",
        usage: "unbrowse breath scroll [selector] <dx,dy> [--session <id>]",
        positional: [
          {
            name: "selector?",
            description: "Optional CSS selector to anchor the wheel event over its center.",
            required: false,
          },
          {
            name: "dx,dy",
            description: "Pixels. `500` = `0,500`. Signed integers permitted.",
            required: true,
          },
        ],
        flags: [
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "breath",
      },
      opts,
    );
  }

  // Disambiguate positional shape:
  //   1 positional -> [dx,dy]
  //   2 positionals -> [selector, dx,dy]
  // If 1 positional is supplied but doesn't match the amount regex, error.
  let selector: string | undefined;
  let amountRaw: string | undefined;
  if (parsed.positional.length === 0) {
    emit(
      {
        error: "missing_positional",
        subcommand: "breath scroll",
        required: ["dx,dy"],
        got: parsed.positional,
        covenant_kind: meta.covenant_kind,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  } else if (parsed.positional.length === 1) {
    amountRaw = parsed.positional[0];
  } else {
    selector = parsed.positional[0];
    amountRaw = parsed.positional[1];
  }

  const amount = parseAmount(amountRaw!);
  if (!amount) {
    emit(
      {
        ok: false,
        subcommand: "breath scroll",
        covenant_kind: meta.covenant_kind,
        error: "bad_amount_format",
        got: amountRaw,
        expected: "<dy> or <dx,dy>, signed integers",
      },
      opts,
    );
    process.exit(EX_USAGE);
  }

  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;

  let rec;
  try {
    rec = await resolveSession(sessionFlag);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }

  let conn;
  let targetSessionId: string;
  try {
    conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);
    targetSessionId = target.sessionId;
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  // ── Choose coordinate ─────────────────────────────────────────────────────
  // Selector path: DOM.getDocument → DOM.querySelector → DOM.getBoxModel
  //                center the wheel event over the element's bounding box.
  // No selector  : Runtime.evaluate window.innerWidth/Height/2.
  //                The wheel event lands at the viewport center.
  let x: number;
  let y: number;
  try {
    if (selector) {
      const doc = await call<Record<string, never>, { root: { nodeId: number } }>(
        conn,
        "DOM.getDocument",
        {},
        targetSessionId,
      );
      const node = await call<{ nodeId: number; selector: string }, { nodeId: number }>(
        conn,
        "DOM.querySelector",
        { nodeId: doc.root.nodeId, selector },
        targetSessionId,
      );
      if (!node.nodeId) throw new Error(`selector_not_found:${selector}`);
      const box = await call<
        { nodeId: number },
        { model: { content: number[]; width: number; height: number } }
      >(
        conn,
        "DOM.getBoxModel",
        { nodeId: node.nodeId },
        targetSessionId,
      );
      // CDP content quad: 8 numbers [x1,y1, x2,y2, x3,y3, x4,y4] (TL,TR,BR,BL).
      const q = box.model.content;
      x = (q[0] + q[2] + q[4] + q[6]) / 4;
      y = (q[1] + q[3] + q[5] + q[7]) / 4;
    } else {
      const result = await call<
        { expression: string; returnByValue: boolean },
        { result: { value?: { w: number; h: number } } }
      >(
        conn,
        "Runtime.evaluate",
        {
          expression: "({ w: window.innerWidth, h: window.innerHeight })",
          returnByValue: true,
        },
        targetSessionId,
      );
      const v = result.result.value ?? { w: 1024, h: 768 };
      x = v.w / 2;
      y = v.h / 2;
    }
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  // ── Dispatch the wheel event ──────────────────────────────────────────────
  try {
    await call(
      conn,
      "Input.dispatchMouseEvent",
      {
        type: "mouseWheel",
        x,
        y,
        deltaX: amount.dx,
        deltaY: amount.dy,
        button: "none",
      },
      targetSessionId,
    );
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  emit(
    {
      ok: true,
      subcommand: "breath scroll",
      covenant_kind: meta.covenant_kind,
      session_id: rec.sessionId,
      selector: selector ?? null,
      dx: amount.dx,
      dy: amount.dy,
      anchor: { x, y },
    },
    opts,
  );
  process.exit(0);
}
