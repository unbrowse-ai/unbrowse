/**
 * `unbrowse eval` subcommand router.
 *
 * Son-verb — read-only queries / witness. Every primitive in this verb
 * is observation-shaped: it never mutates browser state. The fuzzy edge
 * is `runtime_evaluate` (callers can pass side-effecting expressions),
 * which is the caller's discipline to police.
 */
import type { ParsedV7Args } from "../args.js";
import { routeSub, type VerbRouter, type VerbHandler } from "../router.js";
import type { OutputOptions } from "../output.js";

import { handler as snapHandler } from "./snap.js";
import { handler as resolveHandler } from "./resolve.js";
import { handler as statusHandler } from "./status.js";
import { handler as versionHandler } from "./version.js";
import { handler as traceHandler } from "./trace.js";
import { handler as markdownHandler } from "./markdown.js";
import { handler as screenshotHandler } from "./screenshot.js";
import { handler as textHandler } from "./text.js";
import { handler as cookiesHandler } from "./cookies.js";
import { handler as statsHandler } from "./stats.js";
import { handler as skillsHandler } from "./skills.js";
import { handler as skillHandler } from "./skill.js";
import { handler as sessionsHandler } from "./sessions.js";
import { handler as earningsHandler } from "./earnings.js";
import { handler as settingsHandler } from "./settings.js";
import { handler as feedbackHandler } from "./feedback.js";
import { handler as reflectHandler } from "./reflect.js";
import { handler as authInventoryHandler } from "./auth-inventory.js";
import { handler as specHandler } from "./spec.js";
import { handler as explainHandler } from "./explain.js";
import { handler as searchHandler } from "./search.js";
import { handler as researchHandler } from "./research.js";
import { handler as extractHandler } from "./extract.js";
import { handler as inspectHandler } from "./inspect.js";
import { handler as accountHandler } from "./account.js";
import { handler as configHandler } from "./config.js";

const TABLE: Record<string, VerbHandler> = {
  snap: snapHandler,
  resolve: resolveHandler,
  status: statusHandler,
  version: versionHandler,
  trace: traceHandler,
  markdown: markdownHandler,
  screenshot: screenshotHandler,
  text: textHandler,
  cookies: cookiesHandler,
  stats: statsHandler,
  skills: skillsHandler,
  skill: skillHandler,
  sessions: sessionsHandler,
  earnings: earningsHandler,
  settings: settingsHandler,
  feedback: feedbackHandler,
  reflect: reflectHandler,
  "auth-inventory": authInventoryHandler,
  spec: specHandler,
  explain: explainHandler,
  search: searchHandler,
  research: researchHandler,
  extract: extractHandler,
  inspect: inspectHandler,
  account: accountHandler,
  config: configHandler,
};

export const router: VerbRouter = {
  verb: "eval",
  help: (opts: OutputOptions) => routeSub({ verb: "eval", sub: "", positional: [], flags: { help: true }, wantsHelp: true, wantsJson: opts.json ?? false } as ParsedV7Args, opts, TABLE, "eval") as never,
  dispatch: (parsed: ParsedV7Args, opts: OutputOptions) => routeSub(parsed, opts, TABLE, "eval"),
};
