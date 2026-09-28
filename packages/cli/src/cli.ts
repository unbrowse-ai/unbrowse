#!/usr/bin/env node
// The Unbrowse CLI: a thin shell over the REST API (`/api/v1`) through the Unbrowse client.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as auth from "./auth.ts";
import { Unbrowse } from "@unbrowse/sdk";
import type { Json, RunView } from "@unbrowse/sdk";

declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "dev";
export const DEFAULT_ORIGIN = "https://unbrowse.ai";

const HELP = `unbrowse ${VERSION} — call websites as APIs through the Unbrowse API

  login [--key ub_live_…]         Sign in in your browser (OAuth), or store an API key
                                  (first use of any command below signs you in the same way)
  logout                          Forget the stored sign-in
  whoami                          Workspace and usage
  usage                           Verified calls this month and quota left

  discover <query>                Your capabilities first, then the public registry
  run <task…>                     Run a task and wait for a verified result
      [--capability ID] [--url URL] [--set key=value]… [--input JSON] [--unattended] [--no-wait]
      [--from-unbrowse]             site requests go from this machine (your IP) by default; this sends them from Unbrowse
                                    (--no-wait always sends from Unbrowse: a run from your IP needs this process to finish)
  inspect <runId>                 A run's status, requirements and result
  resume <runId> key=value…       Answer open requirements on the same run
  cancel <runId>                  Stop a run; prints the effect receipt

  cookies list                    Browsers and profiles found on this machine (--json for agents)
  cookies sync                    Send your browser cookies so runs act as your signed-in self
      [--browser NAME] [--profile NAME] [--domain d] [--all]

  learn <a.har> <b.har>…          Compile two HAR recordings into a capability [--title T] [--goal G]
  learned [id]                    Your learned capabilities, or one with its harness and skill
  logins                          Saved logins as masked hints
  logins remove <origin>          Remove the saved login for a site

  registry [query]                Public compiled sites (no account)
  site <host>                     One site's tools, each with its inputs, an example and how to call it (no account)
  openapi <host>                  The site's OpenAPI 3.1 document: one operation per tool (no account)
  call <host> <tool> [JSON]       Run one site tool with its inputs (or --set key=value…); prints the run
      [--deadline MS] [--select PATH,…] [--idempotency-key K] [--end-user ID]

  mcp                             Local stdio MCP server proxying the hosted one (tool names use _ not .)
      [--url URL] [--end-user ID]   for agent hosts that need stdio or strict tool names (Grok Build)

Options: --json (errors as JSON) · --base-url URL · --no-open
Env: UNBROWSE_API_KEY, UNBROWSE_BASE_URL (default ${DEFAULT_ORIGIN}), UNBROWSE_EGRESS=server, UNBROWSE_MCP_URL, UNBROWSE_END_USER
Exit: 0 ok · 1 error · 2 input required · 3 sign-in or login needed · 4 not verified`;

const BOOLEAN = new Set(["json", "help", "version", "no-open", "no-wait", "unattended", "from-here", "from-unbrowse", "all", "yes"]);
/** Commands that act for a workspace; the first one run with no sign-in starts the sign-in. */
const NEEDS_ACCOUNT = new Set(["whoami", "usage", "discover", "run", "inspect", "resume", "cancel", "learn", "learned", "logins", "call", "cookies"]);

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

type Io = { out: (s: string) => void; err: (s: string) => void; open: (url: string) => void; interactive?: boolean };
const stdio: Io = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  open: openInBrowser,
  interactive: !!process.stdin.isTTY && !!process.stderr.isTTY && !process.env.CI,
};

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

  if (cmd === "mcp") {
    // stdout carries the protocol: nothing else may be printed there.
    const { serveStdio } = await import("./mcp-proxy.ts");
    await serveStdio({
      url: flag("url") ?? process.env.UNBROWSE_MCP_URL ?? `${origin}/api/mcp`,
      token: async () => (await auth.currentToken(origin)) ?? undefined,
      version: VERSION,
      endUser: flag("end-user") ?? process.env.UNBROWSE_END_USER,
    });
    return 0;
  }

  // First use: nobody is signed in yet. A person at a terminal signs in here and the command carries on;
  // a script (no TTY, --json) is told the two ways in instead of waiting on a browser.
  const onboard = async (): Promise<boolean> => {
    if (!io.interactive || args.flags.json) {
      const message = `Not signed in to ${origin}. Run \`npx unbrowse login\` (opens your browser, nothing to paste), or set UNBROWSE_API_KEY (keys: ${origin}/app).`;
      if (args.flags.json) print({ error: { status: 401, code: "not_signed_in", message, details: null } });
      else io.err(message);
      return false;
    }
    io.err(`Welcome to Unbrowse. Sign in once and every site is a command away.\nYour browser opens ${origin}; approve it and \`unbrowse ${cmd}\` carries on. (Scripts: set UNBROWSE_API_KEY instead.)`);
    await auth.oauthLogin(origin, { open: (u) => openLink(u, args, io), log: io.err });
    const me = await (await client()).me();
    io.err(`Signed in (workspace ${me.workspaceId}).`);
    return true;
  };

  try {
    if (NEEDS_ACCOUNT.has(cmd) && !(await auth.currentToken(origin)) && !(await onboard())) return 3;
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
        const request = {
          ...(task ? { task } : {}),
          ...(capability ? { capability } : {}),
          ...(flag("url") ? { targetUrl: flag("url") } : {}),
          ...(Object.keys(input).length ? { input } : {}),
          ...(args.flags.unattended ? { interactionMode: "unattended" as const } : {}),
          idempotencyKey: flag("idempotency-key") ?? randomUUID(),
        };
        // Client egress by default: this machine sends every site request from its own IP and each one is noted on
        // stderr; --from-unbrowse (or UNBROWSE_EGRESS=server) sends them from Unbrowse. --from-here is still accepted.
        // --no-wait returns at once, so nothing here would be left to send the requests: that run goes from Unbrowse.
        const fromHere = !args.flags["from-unbrowse"] && !args.flags["no-wait"] && process.env.UNBROWSE_EGRESS !== "server";
        const view = fromHere
          ? await ub.runOnClient(request, { onRequest: (r) => void io.err(`→ ${r.method} ${r.url}`) })
          : await ub.run(request);
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
      case "cookies": {
        const { findProfiles, readCookies } = await import("./cookies.ts");
        const sub = rest[0] ?? "sync";
        const profiles = findProfiles();
        if (sub === "list") {
          const rows = profiles.map((p) => ({ browser: p.browser, profile: p.profile, engine: p.engine, id: `${p.browser}:${p.profile}` }));
          if (args.flags.json) print({ profiles: rows });
          else if (!rows.length) io.err("No browsers found. Chrome, Chromium, Arc, Brave, Edge, Firefox and others are supported.");
          else for (const r of rows) io.out(`${r.id}  (${r.engine})`);
          return 0;
        }
        if (sub !== "sync") throw new UsageError("usage: unbrowse cookies [list | sync] [--browser NAME] [--profile NAME] [--domain d] [--all]");
        if (!profiles.length) { io.err("No browsers found to sync cookies from."); return 1; }
        const wantBrowser = flag("browser")?.toLowerCase();
        const wantProfile = flag("profile");
        let chosen = profiles.filter((p) => (!wantBrowser || p.browser.toLowerCase() === wantBrowser) && (!wantProfile || p.profile === wantProfile));
        // No browser named and several to choose from: the default profile of the first browser, unless --all.
        if (!args.flags.all && !wantBrowser && !wantProfile && chosen.length > 1) {
          const def = chosen.find((p) => p.profile === "Default") ?? chosen[0]!;
          chosen = [def];
          io.err(`Using ${def.browser}:${def.profile}. Pick another with --browser/--profile, all with --all, or list them: unbrowse cookies list`);
        }
        if (!chosen.length) { io.err(`No profile matched. List them with: unbrowse cookies list`); return 1; }
        const domain = flag("domain");
        const jar = new Map<string, { domain: string; name: string; value: string; path?: string; secure?: boolean; httpOnly?: boolean; expires?: number }>();
        let readErrors = 0, locked = 0;
        for (const p of chosen) {
          try {
            const cookies = readCookies(p, domain ? { domain } : {});
            const usable = cookies.filter((c) => c.value);
            locked += cookies.length - usable.length;
            for (const c of usable) jar.set(`${c.domain}|${c.name}|${c.path}`, c);
          } catch (e) {
            readErrors++;
            io.err(`${p.browser}:${p.profile}: could not read (${(e as Error).message}). Close the browser and retry.`);
          }
        }
        const cookies = [...jar.values()];
        if (locked) io.err(`${locked} cookie(s) could not be decrypted (a locked keyring or a sandboxed/flatpak browser).`);
        if (!cookies.length) { io.err(readErrors ? "No cookies read." : "No cookies to sync."); return readErrors ? 1 : 0; }
        const result = await ub.importCookies(cookies);
        if (args.flags.json) print(result);
        else io.err(`Synced ${result.cookies} cookies across ${result.sites} site(s) from ${chosen.map((p) => `${p.browser}:${p.profile}`).join(", ")}. Runs now act as your signed-in self on those sites.`);
        return 0;
      }
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
      case "openapi":
        print(await ub.openapi(need(rest[0], "openapi <host>")));
        return 0;
      case "call": {
        const usage = "call <host> <tool> [JSON] [--set key=value]…";
        const host = need(rest[0], usage);
        const tool = need(rest[1], usage);
        const input = { ...(rest[2] ? (JSON.parse(rest.slice(2).join(" ")) as Record<string, Json>) : {}), ...(flag("input") ? JSON.parse(flag("input")!) : {}), ...mapValues(args.sets) };
        const deadline = flag("deadline");
        if (deadline !== undefined && !(Number(deadline) > 0)) throw new UsageError("--deadline takes milliseconds, e.g. --deadline 90000");
        const run = await ub.callTool(host, tool, input, {
          ...(deadline ? { deadlineMs: Number(deadline) } : {}),
          ...(flag("select") ? { select: flag("select")!.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
          idempotencyKey: flag("idempotency-key") ?? randomUUID(),
          ...((flag("end-user") ?? process.env.UNBROWSE_END_USER) ? { endUser: (flag("end-user") ?? process.env.UNBROWSE_END_USER)! } : {}),
        });
        print(run);
        if (run.status === "input_required") {
          const fields = (run.requirements ?? []).filter((r) => r.state === "open").map((r) => `${r.affectedAction}=…`);
          return io.err(`Input required: unbrowse resume ${run.runId} ${fields.join(" ")}`), 2;
        }
        if (run.status === "succeeded") return 0;
        if (run.status === "outcome_unknown") return io.err("Outcome unknown: a change may have happened. Inspect before retrying."), 4;
        return io.err(`${run.status}${run.error ? `: ${run.error.code} — ${run.error.message}` : ""}`), 1;
      }
      default:
        throw new UsageError(`unknown command "${cmd}". Run \`unbrowse help\`.`);
    }
  } catch (err) {
    if (err instanceof UsageError) return io.err(err.message), 1;
    if (err instanceof SyntaxError) return io.err(`invalid JSON: ${err.message}`), 1;
    const e = err as Error & { status?: number; body?: unknown };
    if (e.status === 422 && (e as { code?: string }).code === "invalid_answer") return io.err(e.message), 1;
    // A network failure (no HTTP status) names the server it could not reach and why.
    if (e.status === undefined && /fetch failed|Unable to connect|ConnectionRefused|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(`${e.message} ${String((e as { cause?: unknown }).cause ?? "")}`)) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      e.message = `could not reach ${origin}${cause?.code ? ` (${cause.code})` : cause?.message ? ` (${cause.message})` : ""}. Check the connection, or --base-url / UNBROWSE_BASE_URL.`;
    }
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
