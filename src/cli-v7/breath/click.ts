/**
 * `unbrowse breath click <selector>` —
 * compose DOM.querySelector + DOM.getBoxModel + Input.dispatchMouseEvent (×2).
 *
 * 1:1 mapping (kind-map.ts row "breath click"):
 *   CLI subcommand  : breath click
 *   MCP tool        : unbrowse_click
 *   Covenant kind   : actuate_click
 *   Verb            : breath
 *
 * No value-bearing: this handler NEVER touches src/values/. Stdout carries
 * only the pointer-shape (selector + session_id + composed mouse events).
 *
 * Composition:
 *   1. attach + attachToTarget to the existing browse session.
 *   2. DOM.getDocument -> DOM.querySelector(selector) to locate the node.
 *   3. DOM.getBoxModel to compute the center coordinate.
 *   4. Input.dispatchMouseEvent(mousePressed) + Input.dispatchMouseEvent(mouseReleased)
 *      at the computed center.
 *
 * Exit codes:
 *   0   success
 *   65  EX_DATAERR — selector_not_found / CDP error
 *   1   generic failure
 */
import { attach, attachToTarget, call } from "../../cdp/index.js";
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

const EX_CDP = 65;

type MouseButton = "left" | "right" | "middle";

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

function parseModifiers(raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0) return 0;
  let bits = 0;
  for (const token of raw.split(",")) {
    const k = token.trim().toLowerCase();
    if (k && MODIFIER_BITS[k] !== undefined) bits |= MODIFIER_BITS[k];
  }
  return bits;
}

function parseButton(raw: unknown): MouseButton {
  if (raw === "right" || raw === "middle" || raw === "left") return raw;
  return "left";
}

function parseClickCount(raw: unknown): number {
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n <= 3) return n;
  }
  return 1;
}

/**
 * BoxModel.content is a 8-number quad: [x0,y0,x1,y1,x2,y2,x3,y3]. Center is
 * the mean of the four corners. The CDP shape uses content[] for the inner
 * box; we use that rather than border so coordinates land inside the visible
 * element area.
 */
function centerOfQuad(quad: readonly number[]): { x: number; y: number } {
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  return { x, y };
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("breath", "click")!;

  if (parsed.wantsHelp) {
    helpExit(
      "breath click",
      {
        summary: "Compose Input.dispatchMouseEvent press+release on a selector.",
        usage: "unbrowse breath click <selector> [--session <id>] [--button left|right|middle] [--click-count 1|2|3] [--modifiers shift,alt,ctrl,meta]",
        positional: [
          { name: "selector", description: "CSS selector OR `[eN]` accessibility ref.", required: true },
        ],
        flags: [
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
          { name: "--button", description: "left | right | middle (default: left).", value_expected: true },
          { name: "--click-count", description: "1 for single, 2 for double, 3 for triple (default: 1).", value_expected: true },
          { name: "--modifiers", description: "Comma-separated: shift,alt,ctrl,meta.", value_expected: true },
        ],
        covenant_kind: meta.covenant_kind,
        mcp_tool: meta.mcp_tool,
        verb: "breath",
      },
      opts,
    );
  }

  const selector = parsed.positional[0];
  if (!selector) {
    emit(
      {
        error: "missing_positional",
        subcommand: "breath click",
        required: ["selector"],
        got: parsed.positional,
        covenant_kind: meta.covenant_kind,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  }

  const button: MouseButton = parseButton(parsed.flags.button);
  const clickCount = parseClickCount(parsed.flags["click-count"]);
  const modifiers = parseModifiers(parsed.flags.modifiers);
  const sessionFlag = typeof parsed.flags.session === "string" ? parsed.flags.session : undefined;

  let rec;
  try {
    rec = await resolveSession(sessionFlag);
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_GENERIC);
  }

  let x = 0;
  let y = 0;
  try {
    const conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);
    const targetSessionId = target.sessionId;

    // Locate the node via DOM.querySelector on the root document.
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
    if (!node.nodeId) {
      throw new Error(`selector_not_found:${selector}`);
    }

    // Compute the box-model center. CDP returns `model.content` as an 8-number
    // quad of the content rect; the geometric mean is the click target.
    const box = await call<
      { nodeId: number },
      { model: { content: number[]; width: number; height: number } }
    >(conn, "DOM.getBoxModel", { nodeId: node.nodeId }, targetSessionId);
    const center = centerOfQuad(box.model.content);
    x = center.x;
    y = center.y;

    // Composed click: press then release at the same coordinates. Each
    // dispatchMouseEvent is the CDP atomic primitive — the composition itself
    // is the click recipe (see src/cdp/input/mouse.ts `click`).
    await call(
      conn,
      "Input.dispatchMouseEvent",
      { type: "mousePressed", x, y, button, clickCount, modifiers },
      targetSessionId,
    );
    await call(
      conn,
      "Input.dispatchMouseEvent",
      { type: "mouseReleased", x, y, button, clickCount, modifiers },
      targetSessionId,
    );
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  emit(
    {
      ok: true,
      subcommand: "breath click",
      covenant_kind: meta.covenant_kind,
      session_id: rec.sessionId,
      selector,
      button,
      click_count: clickCount,
      modifiers,
      x,
      y,
    },
    opts,
  );
  process.exit(0);
}
