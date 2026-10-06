#!/usr/bin/env node
// The Unbrowse CLI: a thin shell over the REST API (`/api/v1`) through the Unbrowse client.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import * as auth from "./auth.ts";
import { Unbrowse } from "@unbrowse/sdk";
import type { IndexJob, Json, RunView } from "@unbrowse/sdk";

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
      [--events]                    include the run's event log
  scrape <url>                    Read one page as clean markdown on stdout (metadata on stderr)
      [--format markdown|html|text|links|raw,…] [--full] [--render auto|always|never] [--country XX] [--deadline MS]
  index <url>                     Teach Unbrowse a site: it explores it and compiles each flow into a tool
      [--focus TEXT] [--max N] [--no-wait]
  index status [jobId]            One index job, or all of yours
  inspect <runId>                 A run's status, requirements and result
  resume <runId> key=value…       Answer open requirements on the same run
  cancel <runId>                  Stop a run; prints the effect receipt

  cookies list                    Browsers and profiles found on this machine (--json for agents)
  cookies sync                    Send your browser cookies so runs act as your signed-in self
      [--browser NAME] [--profile NAME] [--domain d] [--all]
  cookies watch --domain a,b      Keep those sites' cookies in sync (re-upload on change) [--interval MIN] [--all-sites]
  cookies daemon start|status|stop
                                  The same as a background service (systemd / launchd) [--domain a,b | --all-sites] [--yes]

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

const BOOLEAN = new Set(["json", "help", "version", "no-open", "no-wait", "unattended", "from-here", "from-unbrowse", "all", "all-sites", "yes", "full", "events"]);
/** Commands that act for a workspace; the first one run with no sign-in starts the sign-in. */
const NEEDS_ACCOUNT = new Set(["whoami", "usage", "discover", "run", "scrape", "index", "inspect", "resume", "cancel", "learn", "learned", "logins", "call", "cookies"]);
const SCRAPE_FORMATS = ["markdown", "html", "text", "links", "raw"] as const;

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

type Io = {
  out: (s: string) => void;
  err: (s: string) => void;
  open: (url: string) => void;
  interactive?: boolean;
  /** A question at the terminal (only asked when interactive). */
  ask?: (q: string) => Promise<string>;
  /** Runs a service command (systemctl, launchctl). */
  exec?: (cmd: string[]) => { status: number | null; stdout: string; stderr: string };
  /** Where a user service would be written and what it would run (tests point these at a temp dir). */
  service?: { os?: NodeJS.Platform; home?: string; node?: string; cli?: string };
};
const stdio: Io = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
  open: openInBrowser,
  interactive: !!process.stdin.isTTY && !!process.stderr.isTTY && !process.env.CI,
  ask: async (q) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(q);
    } finally {
      rl.close();
    }
  },
  exec: (cmd) => {
    const r = spawnSync(cmd[0]!, cmd.slice(1), { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error?.message ?? "") };
  },
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

  // Continuous cookie sync (cookie-daemon.ts): the sites to keep in sync, a one-off check, and the user service.
  const cookieSync = async () => {
    const D = await import("./cookie-daemon.ts");
    const C = await import("./cookies.ts");
    const dir = D.configDir(auth.configPath());
    const saved = D.readJson<Partial<import("./cookie-daemon.ts").SyncConfig>>(D.configFile(dir), {});
    const config = (): import("./cookie-daemon.ts").SyncConfig => {
      const sites = args.flags["all-sites"] ? [D.ALL_SITES] : flag("domain") ?? flag("sites") ? D.parseSites(flag("domain") ?? flag("sites")) : (saved.sites ?? []);
      const interval = Number(flag("interval") ?? saved.intervalMin ?? D.DEFAULT_INTERVAL_MIN);
      if (!(interval >= 1)) throw new UsageError("--interval takes minutes (1 or more)");
      return { sites, intervalMin: interval, ...((flag("browser") ?? saved.browser) ? { browser: flag("browser") ?? saved.browser } : {}), ...((flag("profile") ?? saved.profile) ? { profile: flag("profile") ?? saved.profile } : {}), ...(origin !== DEFAULT_ORIGIN ? { baseUrl: origin } : {}) };
    };
    const deps = async (): Promise<import("./cookie-daemon.ts").SyncDeps> => {
      const ub = await client();
      return { findProfiles: C.findProfiles, readCookies: C.readCookies, upload: (cookies) => ub.importCookies(cookies), now: Date.now };
    };
    return { D, dir, saved, config, deps };
  };
  // How a config's sites read in a message: the explicit list, or a clear warning for "everything" (sites: ["*"]).
  const sitesLabel = (cfg: import("./cookie-daemon.ts").SyncConfig) => (cfg.sites.includes("*") ? "EVERY site you are signed into in that browser (including banking, email and payments)" : cfg.sites.join(", "));

  /** Install (or update) the cookie sync service after one sync that proves reading and uploading both work. */
  const installCookieDaemon = async (cfg: import("./cookie-daemon.ts").SyncConfig, confirmed: boolean): Promise<number> => {
    const { D, dir, deps } = await cookieSync();
    if (!cfg.sites.length) throw new UsageError("name the sites to keep in sync: unbrowse cookies daemon start --domain github.com,linkedin.com (or --all-sites for every site)");
    const node = io.service?.node ?? process.execPath;
    let cli = io.service?.cli ?? process.argv[1] ?? "";
    try {
      cli = realpathSync(cli);
    } catch {
      /* keep it as given */
    }
    if (!io.service?.cli && D.ephemeralCli(cli)) {
      io.err("This CLI runs from a temporary npx copy, which a background service cannot point at. Install it first: npm i -g unbrowse — then run this again.");
      return 1;
    }
    const plan = D.servicePlan({ os: io.service?.os, home: io.service?.home, node, cli, env: { ...(origin !== DEFAULT_ORIGIN ? { UNBROWSE_BASE_URL: origin } : {}), ...(process.env.UNBROWSE_CONFIG_DIR ? { UNBROWSE_CONFIG_DIR: process.env.UNBROWSE_CONFIG_DIR } : {}), ...(process.env.UNBROWSE_COOKIES_HOME ? { UNBROWSE_COOKIES_HOME: process.env.UNBROWSE_COOKIES_HOME } : {}) } });
    if (!plan) {
      io.err("No background service on this OS yet. Keep it running with: unbrowse cookies watch (e.g. from Task Scheduler at logon).");
      return 1;
    }
    if (!confirmed) {
      if (!io.interactive || !io.ask) {
        io.err(`Re-run with --yes to confirm: cookies for ${sitesLabel(cfg)} will be uploaded to ${origin} every ${cfg.intervalMin} min and sealed in your vault.`);
        return 1;
      }
      const scope = D.allSites(cfg) ? `EVERY site you are signed into in that browser — including banking, email, payments and government logins — will be uploaded to ${origin} and refreshed every ${cfg.intervalMin} min` : `cookies for ${cfg.sites.join(", ")} will be uploaded to ${origin} every ${cfg.intervalMin} min; only these sites leave this machine`;
      const ok = (await io.ask(`Keep your browser cookies in sync with Unbrowse? ${scope}. [y/N] `)).trim().toLowerCase();
      if (ok !== "y" && ok !== "yes") return io.err("Not installed."), 1;
    }
    // One sync first: a service that cannot read the browser or reach Unbrowse would only fail quietly.
    const state = D.readJson<import("./cookie-daemon.ts").SyncState>(D.stateFile(dir), { sites: {} });
    state.sites ??= {};
    const first = await D.syncOnce(await deps(), cfg, state);
    D.writeJson(D.stateFile(dir), state);
    io.err(D.describe(first));
    if (first.error) return 1;
    D.writeJson(D.configFile(dir), cfg);
    mkdirSync(dirname(plan.path), { recursive: true });
    writeFileSync(plan.path, plan.content, { mode: 0o644 });
    const exec = io.exec ?? (() => ({ status: 1, stdout: "", stderr: "no exec" }));
    for (const [i, cmd] of plan.enable.entries()) {
      const r = exec(cmd);
      // launchd: unloading a service that was not loaded fails, and that is fine.
      if (r.status !== 0 && !(plan.kind === "launchd" && i === 0)) {
        io.err(`Could not start the service (${cmd.join(" ")}): ${r.stderr.trim() || `exit ${r.status}`}. The unit is at ${plan.path}; run \`unbrowse cookies watch\` to sync in the foreground meanwhile.`);
        return 1;
      }
    }
    io.err(`Cookie sync is running in the background (${plan.kind}, every ${cfg.intervalMin} min): ${sitesLabel(cfg)}. Status: unbrowse cookies daemon status · log: ${plan.log} · stop: unbrowse cookies daemon stop`);
    return 0;
  };

  /** After a sign-in at a terminal: offer, once, to keep chosen sites' browser sign-ins in sync. Never by default. */
  const offerCookieSync = async () => {
    if (!io.interactive || !io.ask || args.flags.json) return;
    const { D, dir } = await cookieSync();
    if (existsSync(D.configFile(dir))) return;
    io.err("Optional: let runs act as you on sites you are signed into in your browser. Unbrowse keeps those sites' cookies in sync in the background (sealed in your vault; only the sites you name leave this machine).");
    const answer = (await io.ask("Sites to keep in sync (e.g. github.com, linkedin.com), or Enter to skip: ")).trim();
    const sites = D.parseSites(answer);
    if (!sites.length) return void io.err("Skipped. Later: unbrowse cookies daemon start --domain <sites>");
    await installCookieDaemon({ sites, intervalMin: D.DEFAULT_INTERVAL_MIN, ...(origin !== DEFAULT_ORIGIN ? { baseUrl: origin } : {}) }, true);
  };

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
    await offerCookieSync().catch((e: Error) => io.err(`Cookie sync not set up: ${e.message}`));
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
        await offerCookieSync().catch((e: Error) => io.err(`Cookie sync not set up: ${e.message}`));
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
      case "scrape": {
        const url = need(rest[0], "scrape <url> [--format markdown|html|text|links|raw,…]");
        const formats = (flag("format") ?? flag("formats") ?? "markdown").split(",").map((f) => f.trim()).filter(Boolean);
        const bad = formats.filter((f) => !(SCRAPE_FORMATS as readonly string[]).includes(f));
        if (bad.length || !formats.length) throw new UsageError(`--format takes ${SCRAPE_FORMATS.join(", ")} (comma-separated), not ${bad.join(", ") || "nothing"}`);
        const render = flag("render");
        if (render !== undefined && !["auto", "always", "never"].includes(render)) throw new UsageError("--render takes auto, always or never");
        const deadline = flag("deadline");
        if (deadline !== undefined && !(Number(deadline) > 0)) throw new UsageError("--deadline takes milliseconds, e.g. --deadline 60000");
        const page = await ub.scrape({
          url,
          formats: formats as (typeof SCRAPE_FORMATS)[number][],
          ...(args.flags.full ? { onlyMainContent: false } : {}),
          ...(render ? { render: render as "auto" | "always" | "never" } : {}),
          ...(flag("country") ? { country: flag("country") } : {}),
          ...(deadline ? { deadlineMs: Number(deadline) } : {}),
        });
        if (args.flags.json) return print(page), 0;
        // The page itself on stdout, so it pipes; what it is on stderr.
        const m = page.metadata ?? ({} as Record<string, unknown>);
        io.err([m.title ? String(m.title) : null, `${m.finalUrl ?? m.url ?? url}`, m.status !== undefined ? `HTTP ${m.status}` : null].filter(Boolean).join(" · "));
        for (const f of formats) {
          const v = page[f];
          if (v === undefined || v === null) continue;
          io.out(Array.isArray(v) ? v.join("\n") : typeof v === "string" ? v : JSON.stringify(v, null, 2));
        }
        return 0;
      }
      case "index": {
        if (rest[0] === "status") {
          print(rest[1] ? jobView(await ub.indexJob(rest[1]), args) : { jobs: (await ub.indexJobs()).jobs.map((j) => jobView(j, args)) });
          return 0;
        }
        const url = need(rest[0], "index <url> [--focus TEXT] [--max N] [--no-wait] | index status [jobId]");
        const max = flag("max");
        if (max !== undefined && !(Number(max) >= 1)) throw new UsageError("--max takes a number of tools (1 or more)");
        let job = await ub.index({ url, ...(flag("focus") ? { focus: flag("focus") } : {}), ...(max ? { maxCapabilities: Number(max) } : {}) });
        if (args.flags["no-wait"]) {
          print(jobView(job, args));
          return io.err(`Indexing ${job.host} (${job.id}). Follow it: unbrowse index status ${job.id}`), 0;
        }
        io.err(`Indexing ${job.host} (${job.id}): an agent explores the site and proves each tool. This takes minutes; Ctrl-C leaves it running (unbrowse index status ${job.id}).`);
        const deadline = Date.now() + Number(args.flags.timeout ?? 1800) * 1000;
        let shown = "";
        while ((job.status === "queued" || job.status === "running") && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, Number(process.env.UNBROWSE_POLL_MS ?? 5000)));
          job = await ub.indexJob(job.id);
          const line = `${job.status}${job.indexed ? ` · ${job.indexed} tool(s) proven` : ""}`;
          if (line !== shown) io.err((shown = line));
        }
        print(jobView(job, args));
        if (job.status === "queued" || job.status === "running") return io.err(`Still ${job.status}: unbrowse index status ${job.id}`), 0;
        if (job.status === "done" && (job.indexed ?? 0) > 0) return io.err(`Indexed ${job.host}: ${job.indexed} tool(s). See them: unbrowse site ${job.host} · run one: unbrowse run "<task>" --url ${job.url}`), 0;
        return io.err(`Not indexed${job.error ? `: ${job.error.code} — ${job.error.message}` : ""}. Read a page now instead: unbrowse scrape ${job.url}`), 1;
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
        if (sub === "watch") {
          // The daemon's loop (also usable in the foreground): the sites from --domain, else the saved config.
          const { D, dir, config, deps } = await cookieSync();
          const cfg = config();
          if (!cfg.sites.length) throw new UsageError("name the sites: unbrowse cookies watch --domain github.com,linkedin.com (or --all-sites; or run it in the background: unbrowse cookies daemon start)");
          const stop = new AbortController();
          for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => stop.abort());
          io.err(`Keeping ${cfg.sites.join(", ")} in sync every ${cfg.intervalMin} min. Ctrl-C stops.`);
          await D.watch({ deps, cfg, statePath: D.stateFile(dir), log: io.err, signal: stop.signal });
          return 0;
        }
        if (sub === "daemon") {
          const action = rest[1] ?? "status";
          const { D, dir, saved, config } = await cookieSync();
          const plan = D.servicePlan({ os: io.service?.os, home: io.service?.home, node: io.service?.node ?? process.execPath, cli: io.service?.cli ?? process.argv[1] ?? "" });
          const exec = io.exec ?? (() => ({ status: 1, stdout: "", stderr: "no exec" }));
          if (action === "start" || action === "install") return await installCookieDaemon(config(), !!args.flags.yes);
          if (action === "stop" || action === "uninstall") {
            if (plan) for (const cmd of plan.disable) exec(cmd);
            if (plan && existsSync(plan.path)) rmSync(plan.path, { force: true });
            rmSync(D.configFile(dir), { force: true });
            rmSync(D.stateFile(dir), { force: true });
            io.err("Cookie sync stopped and removed. Sessions already kept in Unbrowse stay until they expire; remove them in the console (Vault).");
            return 0;
          }
          if (action === "status") {
            const state = D.readJson<import("./cookie-daemon.ts").SyncState>(D.stateFile(dir), { sites: {} });
            const installed = !!plan && existsSync(plan.path);
            const active = installed && plan ? exec(plan.status).status === 0 : false;
            const out = {
              installed,
              running: active,
              service: plan?.kind ?? null,
              sites: saved.sites ?? [],
              intervalMin: saved.intervalMin ?? null,
              ...(saved.browser ? { browser: saved.browser } : {}),
              lastSync: state.lastOk ? new Date(state.lastOk).toISOString() : null,
              ...(state.lastError ? { lastError: state.lastError } : {}),
              uploaded: Object.fromEntries(Object.entries(state.sites ?? {}).map(([k, v]) => [k, { cookies: v.cookies, at: new Date(v.uploadedAt).toISOString() }])),
              ...(plan ? { log: plan.log } : {}),
            };
            const shownSites = D.allSites({ sites: out.sites }) ? `every site (${Object.keys(state.sites ?? {}).length} synced so far)` : out.sites.join(", ");
            if (args.flags.json) print(out);
            else io.err(installed ? `Cookie sync ${active ? "running" : "installed but not running"} (${plan!.kind}): ${shownSites} every ${out.intervalMin} min. Last sync: ${out.lastSync ?? "never"}${state.lastError ? ` — last error: ${state.lastError}` : ""}.` : "Cookie sync is not running. Start it: unbrowse cookies daemon start --domain github.com,linkedin.com");
            return installed && !active ? 1 : 0;
          }
          throw new UsageError("usage: unbrowse cookies daemon [start --domain a,b [--interval MIN] [--browser NAME] [--profile NAME] [--yes] | status | stop]");
        }
        if (sub !== "sync") throw new UsageError("usage: unbrowse cookies [list | sync | watch | daemon] [--browser NAME] [--profile NAME] [--domain d] [--all]");
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
        // A whole profile is thousands of cookies: upload in batches so no single request is huge.
        const { UPLOAD_BATCH } = await import("./cookie-daemon.ts");
        let synced = 0;
        const sites = new Set<string>();
        for (let i = 0; i < cookies.length; i += UPLOAD_BATCH) {
          const r = await ub.importCookies(cookies.slice(i, i + UPLOAD_BATCH));
          synced += r.cookies;
          for (const o of r.origins) sites.add(o.origin);
        }
        if (args.flags.json) print({ cookies: synced, sites: sites.size });
        else io.err(`Synced ${synced} cookies across ${sites.size} site(s) from ${chosen.map((p) => `${p.browser}:${p.profile}`).join(", ")}. Runs now act as your signed-in self on those sites.`);
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
  // The event log is long and rarely wanted (MCP leaves it out too); --events keeps it.
  if (args.flags.events) print(view);
  else {
    const { events: _events, ...shown } = view as RunView & { events?: unknown };
    void _events;
    print(shown);
  }
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
  if (view.error?.code === "no_capability") io.err(noCapabilityHint(view, args));
  else if (view.error) io.err(`${view.status}: ${view.error.code}${view.error.message ? ` — ${view.error.message}` : ""}`);
  return 1;
}

/**
 * What to do when no tool fits, as CLI commands. The server's message names REST routes and MCP tools
 * (unbrowse.browse.open) a CLI user cannot call; the CLI has scrape and index for the same steps.
 */
export function noCapabilityHint(view: RunView, args: Args): string {
  const result = (view.result ?? {}) as { next?: { url?: string }; suggestions?: { tools?: Array<{ capability?: string; title?: string }> } };
  const task = args._.slice(1).join(" ");
  const url = (typeof args.flags.url === "string" ? args.flags.url : undefined) ?? result.next?.url ?? task.match(/https?:\/\/\S+/)?.[0];
  const lines = ["No tool fits this task yet."];
  if (url) {
    lines.push(`  Read the page now:        unbrowse scrape ${url}`);
    lines.push(`  Teach Unbrowse the site:  unbrowse index ${url}   (minutes; then run the task again)`);
  } else {
    lines.push(`  Name the site:            unbrowse run ${JSON.stringify(task || "<task>")} --url https://…`);
    lines.push("  Read any page now:        unbrowse scrape https://…");
    lines.push("  Teach Unbrowse a site:    unbrowse index https://…");
  }
  const tools = (result.suggestions?.tools ?? []).filter((t) => t.capability).slice(0, 3);
  if (tools.length) lines.push(`  Or a near match:          ${tools.map((t) => `unbrowse run --capability ${t.capability}`).join("\n                            ")}`);
  return lines.join("\n");
}

/** An index job without its step trail (the trail is for the live page); --events keeps it. */
function jobView(job: IndexJob, args: Args): IndexJob {
  if (args.flags.events) return job;
  const { events: _events, ...rest } = job as IndexJob & { events?: unknown };
  void _events;
  return rest as IndexJob;
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
