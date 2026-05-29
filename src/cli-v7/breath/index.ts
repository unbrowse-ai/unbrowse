/**
 * `unbrowse breath` subcommand router.
 *
 * Spirit-verb — runtime animation (side-effectful CDP calls). All
 * primitives in this verb dispatch through src/cdp/ (W1) for the
 * actual CDP method calls; this file is dispatch-table only.
 */
import type { ParsedV7Args } from "../args.js";
import { routeSub, type VerbRouter, type VerbHandler } from "../router.js";
import type { OutputOptions } from "../output.js";

import { handler as goHandler } from "./go.js";
import { handler as fillHandler } from "./fill.js";
import { handler as fillFormHandler } from "./fill-form.js";
import { handler as typeHandler } from "./type.js";
import { handler as clickHandler } from "./click.js";
import { handler as pressHandler } from "./press.js";
import { handler as selectHandler } from "./select.js";
import { handler as scrollHandler } from "./scroll.js";
import { handler as submitHandler } from "./submit.js";
import { handler as executeHandler } from "./execute.js";
import { handler as authCaptureHandler } from "./auth-capture.js";
import { handler as proxyRotateHandler } from "./proxy-rotate.js";
import { handler as closeHandler } from "./close.js";
import { handler as sessionParkHandler } from "./session-park.js";
import { handler as sessionRestoreHandler } from "./session-restore.js";

const TABLE: Record<string, VerbHandler> = {
  go: goHandler,
  fill: fillHandler,
  "fill-form": fillFormHandler,
  type: typeHandler,
  click: clickHandler,
  press: pressHandler,
  select: selectHandler,
  scroll: scrollHandler,
  submit: submitHandler,
  execute: executeHandler,
  "auth-capture": authCaptureHandler,
  "proxy-rotate": proxyRotateHandler,
  close: closeHandler,
  // v7.2.0-preview.0 (W23) — close-is-antipattern persistent sessions.
  "session-park": sessionParkHandler,
  "session-restore": sessionRestoreHandler,
};

export const router: VerbRouter = {
  verb: "breath",
  help: (opts: OutputOptions) => routeSub({ verb: "breath", sub: "", positional: [], flags: { help: true }, wantsHelp: true, wantsJson: opts.json ?? false } as ParsedV7Args, opts, TABLE, "breath") as never,
  dispatch: (parsed: ParsedV7Args, opts: OutputOptions) => routeSub(parsed, opts, TABLE, "breath"),
};
