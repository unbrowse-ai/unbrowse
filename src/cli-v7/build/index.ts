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
import { handler as publishHandler } from "./publish.js";
import { handler as publishBundleHandler } from "./publish-bundle.js";
import { handler as indexHandler } from "./idx.js";
import { handler as annotateHandler } from "./annotate.js";
import { handler as reviewHandler } from "./review.js";
import { handler as cleanupStaleHandler } from "./cleanup-stale.js";
import { handler as setupHandler } from "./setup.js";
import { handler as registerHandler } from "./register.js";
import { handler as contributeHandler } from "./contribute.js";
import { handler as skillPackageHandler } from "./skill-package.js";

const TABLE: Record<string, VerbHandler> = {
  skill: skillHandler,
  template: templateHandler,
  "value-source": valueSourceHandler,
  publish: publishHandler,
  "publish-bundle": publishBundleHandler,
  index: indexHandler,
  annotate: annotateHandler,
  review: reviewHandler,
  "cleanup-stale": cleanupStaleHandler,
  setup: setupHandler,
  register: registerHandler,
  contribute: contributeHandler,
  "skill-package": skillPackageHandler,
};

export const router: VerbRouter = {
  verb: "build",
  help: (opts: OutputOptions) => routeSub({ verb: "build", sub: "", positional: [], flags: { help: true }, wantsHelp: true, wantsJson: opts.json ?? false } as ParsedV7Args, opts, TABLE, "build") as never,
  dispatch: (parsed: ParsedV7Args, opts: OutputOptions) => routeSub(parsed, opts, TABLE, "build"),
};
