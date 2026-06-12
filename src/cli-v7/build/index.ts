/**
 * `unbrowse build` subcommand router.
 *
 * Father-verb — declares patterns (skills, templates, value-sources).
 * The build verb is purely declarative; it does NOT touch the runtime
 * browser. Real impl in W3.1+ (this scaffold is W3 stub-or-help only).
 */
import type { ParsedV7Args } from "../args.js";
import { routeSub, type VerbRouter, type VerbHandler } from "../router.js";
import type { OutputOptions } from "../output.js";

import { handler as skillHandler } from "./skill.js";
import { handler as templateHandler } from "./template.js";
import { handler as valueSourceHandler } from "./value-source.js";

const TABLE: Record<string, VerbHandler> = {
  skill: skillHandler,
  template: templateHandler,
  "value-source": valueSourceHandler,
};

export const router: VerbRouter = {
  verb: "build",
  help: (opts: OutputOptions) => routeSub({ verb: "build", sub: "", positional: [], flags: { help: true }, wantsHelp: true, wantsJson: opts.json ?? false } as ParsedV7Args, opts, TABLE, "build") as never,
  dispatch: (parsed: ParsedV7Args, opts: OutputOptions) => routeSub(parsed, opts, TABLE, "build"),
};
