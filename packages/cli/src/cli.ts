#!/usr/bin/env node
// The Unbrowse CLI: a thin shell over the REST API (`/api/v1`) through the Unbrowse client.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as auth from "./auth.ts";
import { Unbrowse, mcpCommands } from "@unbrowse/sdk";
import type { Json, RunView } from "@unbrowse/sdk";

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";
export const DEFAULT_ORIGIN = "https://unbrowse.ai";

const HELP = `unbrowse ${VERSION} — call websites as APIs through the Unbrowse API

  login [--key ub_live_…]         Sign in in your browser (OAuth), or store an API key
  logout                          Forget the stored sign-in
  whoami                          Workspace and usage
  usage                           Verified calls this month and quota left

  discover <query>                Your capabilities first, then the public registry
  run <task…>                     Run a task and wait for a verified result
      [--capability ID] [--url URL] [--set key=value]… [--input JSON] [--unattended] [--no-wait]
  inspect <runId>                 A run's status, requirements and result
  resume <runId> key=value…       Answer open requirements on the same run
  cancel <runId>                  Stop a run; prints the effect receipt

  learn <a.har> <b.har>…          Compile two HAR recordings into a capability [--title T] [--goal G]
  learned [id]                    Your learned capabilities, or one with its harness and skill
  logins                          Saved logins as masked hints
  logins remove <origin>          Remove the saved login for a site

  registry [query]                Public compiled sites (no account)
  site <host>                     One site's tools (no account)
  install                         Add the Unbrowse MCP to Claude Code, Codex or any client

Options: --json (errors as JSON) · --base-url URL · --no-open
Env: UNBROWSE_API_KEY, UNBROWSE_BASE_URL (default ${DEFAULT_ORIGIN})
Exit: 0 ok · 1 error · 2 input required · 3 sign-in or login needed · 4 not verified`;

const BOOLEAN = new Set(["json", "help", "version", "no-open", "no-wait", "unattended"]);

export type Args = { _: string[]; flags: Record<string, string | boolean>; sets: Record<string, string> };

export function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, sets: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h") out.flags.help = true;
    else if (a === "-v") out.flags.version = true;
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const value: string | boolean = eq > 0 ? a.slice(eq + 1) : !BOOLEAN.has(key) && i + 1 < argv.length ? argv[++i]! : true;
      if (key === "set" && typeof value === "string" && value.includes("=")) out.sets[value.slice(0, value.indexOf("="))] = value.slice(value.indexOf("=") + 1);
      else out.flags[key] = value;
    } else out._.push(a);
  }
  return out;
}

type Io = { out: (s: string) => void; err: (s: string) => void; open: (url: string) => void };
const stdio: Io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`), open: openInBrowser };

class UsageError extends Error {}
const need = (v: string | undefined, usage: string) => {
  if (!v) throw new UsageError(`usage: unbrowse ${usage}`);
  return v;
};

export async function main(argv: string[], io: Io = stdio): Promise<number> {
  const args = parseArgs(argv);
  const [cmd, ...rest] = args._;
  if (args.flags.version) return io.out(VERSION), 0;
  if (!cmd || cmd === "help" || args.flags.help) return io.out(HELP), 0;

  const origin = String(args.flags["base-url"] ?? process.env.UNBROWSE_BASE_URL ?? auth.load().baseUrl ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
  const flag = (k: string) => (typeof args.flags[k] === "string" ? (args.flags[k] as string) : undefined);
  const print = (v: unknown) => io.out(JSON.stringify(v, null, 2));
  const client = async () => new Unbrowse({ apiKey: (await auth.currentToken(origin)) ?? "", baseUrl: origin });

  try {
    const ub = await client();
    switch (cmd) {
      case "login": {
        const key = flag("key");
        if (key) auth.save({ baseUrl: origin, apiKey: key });
        else await auth.oauthLogin(origin, { open: (u) => openLink(u, args, io), log: io.err });
        const me = await (await client()).me();
        io.err(`Signed in to ${origin} (workspace ${me.workspaceId}).`);
        return 0;
      }
      case "logout":
        auth.clear();
        io.err("Signed out.");
        return 0;
      case "whoami":
        print({ origin, auth: auth.describe(origin), ...(await ub.me()) });
        return 0;
      case "usage":
        print(await ub.usage());
        return 0;
      case "discover":
        print(await ub.discover(need(rest.join(" "), "discover <query>")));
        return 0;
      case "run": {
        const task = rest.join(" ");
        const capability = flag("capability");
        if (!task && !capability) throw new UsageError("usage: unbrowse run <task…> | --capability ID");
        const input = { ...(flag("input") ? JSON.parse(flag("input")!) : {}), ...mapValues(args.sets) };
        const view = await ub.run({
          ...(task ? { task } : {}),
          ...(capability ? { capability } : {}),
          ...(flag("url") ? { targetUrl: flag("url") } : {}),
          ...(Object.keys(input).length ? { input } : {}),
          ...(args.flags.unattended ? { interactionMode: "unattended" as const } : {}),
          idempotencyKey: flag("idempotency-key") ?? randomUUID(),
        });
        return settle(ub, view, args, io, print);
      }
      case "inspect":
        return settle(ub, await ub.inspect(need(rest[0], "inspect <runId>")), { ...args, flags: { ...args.flags, "no-wait": true } }, io, print);
      case "resume": {
        const runId = need(rest[0], "resume <runId> key=value…");
        const answers: Record<string, Json> = { ...mapValues(args.sets) };
        for (const pair of rest.slice(1)) {
          const k = pair.indexOf("=");
          if (k <= 0) throw new UsageError(`expected key=value, got "${pair}"`);
          answers[pair.slice(0, k)] = coerce(pair.slice(k + 1));
        }
        if (!Object.keys(answers).length) throw new UsageError("usage: unbrowse resume <runId> key=value…");
        return settle(ub, await ub.answer(runId, answers), args, io, print);
      }
      case "cancel":
        print(await ub.cancel(need(rest[0], "cancel <runId>")));
        return 0;
      case "learn": {
        need(rest[0], "learn <a.har> <b.har>…");
        const har = rest.map((f) => JSON.parse(readFileSync(f, "utf8")) as Json);
        print(await ub.learn({ har: har.length === 1 ? har[0]! : har, ...(flag("title") ? { title: flag("title") } : {}), ...(flag("goal") ? { goal: flag("goal") } : {}) }));
        return 0;
      }
      case "learned":
        print(await ub.learned(rest[0]));
        return 0;
      case "logins":
        if (rest[0] === "remove") print(await ub.logins.remove({ origin: need(rest[1], "logins remove <origin>") }));
        else print(await ub.logins.list());
        return 0;
      case "registry":
        print(await ub.sites(rest.join(" ")));
        return 0;
      case "site":
        print(await ub.site(need(rest[0], "site <host>")));
        return 0;
      case "install": {
        const c = mcpCommands(`${origin}/mcp`);
        io.out(`Claude Code:  ${c.claudeCode}\nCodex:        ${c.codex}\nOther clients:\n${c.json}`);
        return 0;
      }
      default:
        throw new UsageError(`unknown command "${cmd}". Run \`unbrowse help\`.`);
    }
  } catch (err) {
    if (err instanceof UsageError) return io.err(err.message), 1;
    if (err instanceof SyntaxError) return io.err(`invalid JSON: ${err.message}`), 1;
    const e = err as Error & { status?: number; body?: unknown };
    if (e.status === 422 && (e as { code?: string }).code === "invalid_answer") return io.err(e.message), 1;
    if (args.flags.json) print({ error: { status: e.status ?? null, message: e.message, details: e.body ?? null } });
    else io.err(e.status === 401 ? `Not signed in to ${origin}. Run \`unbrowse login\`, or set UNBROWSE_API_KEY.` : `error${e.status ? ` (HTTP ${e.status})` : ""}: ${e.message}`);
    return e.status === 401 ? 3 : 1;
  }
}

/** Wait for a run to settle, print it, and turn its status into an exit code. */
async function settle(ub: Unbrowse, view: RunView, args: Args, io: Io, print: (v: unknown) => void): Promise<number> {
  if (!args.flags["no-wait"] && (view.status === "accepted" || view.status === "working")) view = await ub.wait(view.runId, { timeoutMs: Number(args.flags.timeout ?? 600) * 1000 });
  print(view);
  if (view.signIn?.url) {
    io.err(`This site needs a login. Save it in Unbrowse (the CLI never sees it): ${view.signIn.url}`);
    openLink(view.signIn.url, args, io);
    return 3;
  }
  if (view.status === "input_required") {
    const fields = view.requirements.filter((r) => r.state === "open").map((r) => `${r.affectedAction}=…`);
    io.err(`Input required: unbrowse resume ${view.runId} ${fields.join(" ")}`);
    return 2;
  }
  if (view.status === "succeeded") return view.verified ? 0 : 4;
  if (view.status === "outcome_unknown") return io.err("Outcome unknown: a change may have happened. Inspect before retrying."), 4;
  if (view.status === "accepted" || view.status === "working") return io.err(`Still ${view.status}: unbrowse inspect ${view.runId}`), 0;
  return 1;
}

function mapValues(sets: Record<string, string>): Record<string, Json> {
  return Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, coerce(v)]));
}

function coerce(v: string): Json {
  if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(v) || /^[[{"]/.test(v)) {
    try {
      return JSON.parse(v) as Json;
    } catch {
      /* a plain string */
    }
  }
  return v;
}

function openLink(url: string, args: Args, io: Io) {
  if (!args.flags["no-open"]) io.open(url);
}

function openInBrowser(url: string) {
  if (process.env.UNBROWSE_NO_OPEN || !process.stderr.isTTY) return;
  const [cmd, argv] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd as string, argv as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

if (/(^|[\\/])(cli\.(ts|js)|unbrowse)$/.test(process.argv[1] ?? "")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
