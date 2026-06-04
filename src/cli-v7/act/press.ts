/**
 * `unbrowse act press <key>` — single key dispatch (down then up).
 *
 * 1:1 mapping (kind-map.ts row "act press"):
 *   CLI subcommand  : act press
 *   MCP tool        : unbrowse_press
 *   Op kind   : act:press
 *   Verb            : act
 *
 * NO value-bearing surface — `press` never touches src/values/, never POSTs
 * an audit body. It's a keystroke gesture. CDP: Input.dispatchKeyEvent x2
 * (keyDown then keyUp), composed.
 *
 * Exit codes:
 *   0   success
 *   64  EX_USAGE  — unknown key name (caller supplied a key we can't map)
 *   65  EX_CDP    — CDP attach / dispatchKeyEvent failed
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
import { emitBreathActStateless } from "../_act-audit.js";

const EX_CDP = 65;

/**
 * Minimum key-name → CDP descriptor map. CDP wants {key, code,
 * windowsVirtualKeyCode}. Single printable chars fall through to a
 * lower-cased "Key<UPPER>" + their char code.
 *
 * Extending this table is the right path; per-site shortcuts belong
 * in a recipe layer, not here.
 */
interface KeyDescriptor {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const KEY_TABLE: Record<string, KeyDescriptor> = {
  Enter:      { key: "Enter",      code: "Enter",      windowsVirtualKeyCode: 13, text: "\r" },
  Tab:        { key: "Tab",        code: "Tab",        windowsVirtualKeyCode: 9 },
  Escape:     { key: "Escape",     code: "Escape",     windowsVirtualKeyCode: 27 },
  Backspace:  { key: "Backspace",  code: "Backspace",  windowsVirtualKeyCode: 8 },
  Delete:     { key: "Delete",     code: "Delete",     windowsVirtualKeyCode: 46 },
  ArrowUp:    { key: "ArrowUp",    code: "ArrowUp",    windowsVirtualKeyCode: 38 },
  ArrowDown:  { key: "ArrowDown",  code: "ArrowDown",  windowsVirtualKeyCode: 40 },
  ArrowLeft:  { key: "ArrowLeft",  code: "ArrowLeft",  windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space:      { key: " ",          code: "Space",      windowsVirtualKeyCode: 32, text: " " },
};

function lookupKey(name: string): KeyDescriptor | undefined {
  return KEY_TABLE[name];
}

export async function handler(parsed: ParsedV7Args, opts: OutputOptions): Promise<void> {
  const meta = lookupKindMap("act", "press")!;

  if (parsed.wantsHelp) {
    helpExit(
      "act press",
      {
        summary: "Dispatch a single key (keyDown + keyUp) at the current focus.",
        usage: "unbrowse act press <key> [--session <id>]",
        positional: [
          {
            name: "key",
            description:
              "Key name. Supported: " + Object.keys(KEY_TABLE).join(", ") + ".",
            required: true,
          },
        ],
        flags: [
          { name: "--session", description: "Browse session id (default: most-recent).", value_expected: true },
        ],
        op_kind: meta.op_kind,
        mcp_tool: meta.mcp_tool,
        verb: "act",
      },
      opts,
    );
  }

  const keyName = parsed.positional[0];
  if (!keyName) {
    emit(
      {
        error: "missing_positional",
        subcommand: "act press",
        required: ["key"],
        got: parsed.positional,
        op_kind: meta.op_kind,
      },
      opts,
    );
    process.exit(EX_GENERIC);
  }

  const desc = lookupKey(keyName);
  if (!desc) {
    emit(
      {
        ok: false,
        subcommand: "act press",
        op_kind: meta.op_kind,
        error: "unknown key",
        key: keyName,
        valid_keys: Object.keys(KEY_TABLE),
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
  let currentUrl = "";
  try {
    conn = await attach(rec.chromeWsUrl);
    const target = await attachToTarget(conn, rec.targetId);
    targetSessionId = target.sessionId;
    try {
      const hist = await call<
        Record<string, never>,
        { currentIndex: number; entries: Array<{ url: string }> }
      >(conn, "Page.getNavigationHistory", {}, targetSessionId);
      currentUrl = hist.entries[hist.currentIndex]?.url ?? "";
    } catch {
      currentUrl = "";
    }
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  // Composed gesture: Input.dispatchKeyEvent keyDown + keyUp.
  // `text` is set for keys that produce a printable character (Enter -> \r,
  // Space -> " "); arrows/escape/tab leave it undefined so the renderer
  // dispatches a synthetic key event without an input.
  try {
    const baseParams: Record<string, unknown> = {
      key: desc.key,
      code: desc.code,
      windowsVirtualKeyCode: desc.windowsVirtualKeyCode,
    };
    if (desc.text !== undefined) baseParams.text = desc.text;

    await call(
      conn,
      "Input.dispatchKeyEvent",
      { type: "keyDown", ...baseParams },
      targetSessionId,
    );
    await call(
      conn,
      "Input.dispatchKeyEvent",
      { type: "keyUp", ...baseParams },
      targetSessionId,
    );
  } catch (err) {
    emitErr(err, opts);
    process.exit(EX_CDP);
  }

  // Day-6 Dominion: emit a sig-keyed act-act receipt for this
  // keypress. press has no selector (focus-bound); selectorHash is
  // absent. Binding-missing surfaces as a stderr warning, never
  // blocks the gesture (A5).
  const breathAudit = await emitBreathActStateless({
    sessionId: rec.sessionId,
    actType: "press",
    selector: null,
    currentUrl,
  });

  emit(
    {
      ok: true,
      subcommand: "act press",
      op_kind: meta.op_kind,
      session_id: rec.sessionId,
      key: desc.key,
      code: desc.code,
      audit: {
        ok: breathAudit.ok,
        idempotent: breathAudit.idempotent,
        binding_missing: breathAudit.bindingMissing,
        receipt_id: breathAudit.receiptId,
        cache_key: breathAudit.cacheKey,
        variant: "act-act",
        act_type: "press",
      },
    },
    opts,
  );
  process.exit(0);
}
