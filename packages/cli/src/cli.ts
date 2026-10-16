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
       [--device]                 On a remote/headless machine, show a code to approve on your phone
                                  (first use of any command below signs you in the same way)
  logout                          Forget the stored sign-in
  accounts                        Sign-ins saved on this machine, one per Unbrowse account (each has its own vault)
  accounts use <name>             Make one the default; any command takes --account NAME for just that run
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
                                  A page that says "sign in to view" (claude.ai, Notion, Google Docs…): sign in to it
                                  in your browser once, then: unbrowse cookies sync --domain <site>
  cookies watch --domain a,b      Keep those sites' cookies in sync (re-upload on change) [--interval MIN] [--all-sites]
  cookies daemon start|status|stop
                                  The same as a background service (systemd / launchd) [--domain a,b | --all-sites] [--yes]

  mcps                            MCP servers in this machine's agents (Claude Code, Cursor, Codex, VS Code, …)
  mcps import [name…]             Bring them into Unbrowse: remote ones by address, local ones as their hosted app
      [--dry-run] [--with-keys]     keys in those configs stay here unless --with-keys (asks first; --yes in scripts)

  learn <a.har> <b.har>…          Compile two HAR recordings into a capability [--title T] [--goal G]
  learned [id]                    Your learned capabilities, or one with its harness and skill
  logins                          Saved logins as masked hints
  logins remove <origin>          Remove the saved login for a site

  registry [query]                Public compiled sites (no account)
  site <host>                     One site's tools, each with its inputs, an example and how to call it (no account)
  openapi <host>                  The site's OpenAPI 3.1 document: one operation per tool (no account)
  call <host> <tool> [JSON]       Run one site tool with its inputs (or --set key=value…); prints the run
      [--deadline MS] [--select PATH,…] [--idempotency-key K] [--end-user ID]

  tools [query | name]            Every tool of the hosted MCP (cloud browser, map, replay, memory, your sites' tools…);
                                  one name prints its description and inputs (--json: every schema)
  tool <name> [JSON]              Call one, the same as an agent over MCP: unbrowse tool browse_open --url https://…
      [--key value]… [--set key=value]… [--input JSON]
                                    the unbrowse_ prefix is optional; every --flag the CLI does not use is an input
      [--from-here]                 run sends its site requests from this machine, like \`unbrowse run\`

  mcp                          Local stdio MCP server proxying the hosted one (tool names use _ not .)
      [--url URL] [--end-user ID]   for agent hosts that need stdio or strict tool names (Grok Build)
      [--from-here]                 unbrowse_run sends its site requests from this machine, like run (a Grok Bot's computer).
                                    It changes the IP only: it does not sign you in to a site (that is cookies sync)
  mcp add [claude] [codex]        Register that proxy with Claude Code / Codex: they use this CLI's sign-in (no second sign-in)
      [--name NAME] [--replace] [--dry-run]
                                  And back: no CLI sign-in, but Claude Code signed in to Unbrowse (plugin) → the CLI uses that

Options: --json (errors as JSON) · --base-url URL · --no-open · --account NAME
Env: UNBROWSE_API_KEY, UNBROWSE_ACCOUNT, UNBROWSE_BASE_URL (default ${DEFAULT_ORIGIN}), UNBROWSE_EGRESS=server, UNBROWSE_MCP_URL, UNBROWSE_END_USER
Exit: 0 ok · 1 error · 2 input required · 3 sign-in or login needed · 4 not verified`;

const BOOLEAN = new Set(["json", "help", "version", "no-open", "no-wait", "unattended", "from-here", "from-unbrowse", "all", "all-sites", "yes", "full", "events", "dry-run", "with-keys", "replace"]);
/** Commands that act for a workspace; the first one run with no sign-in starts the sign-in. */
const NEEDS_ACCOUNT = new Set(["whoami", "usage", "discover", "run", "scrape", "index", "inspect", "resume", "cancel", "learn", "learned", "logins", "call", "cookies", "tools", "tool"]);
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

  // Which saved sign-in this command uses: --account, UNBROWSE_ACCOUNT, `accounts use`, else the default one.
  if (args.flags.account === true) return io.err("usage: --account NAME"), 1;
  try {
    auth.selectAccount(typeof args.flags.account === "string" ? args.flags.account : undefined);
  } catch (e) {
    return io.err((e as Error).message), 1;
  }
  const named = auth.account() !== "default" ? auth.account() : undefined;
  const loginCmd = `unbrowse login${named ? ` --account ${named}` : ""}`;

  const origin = String(args.flags["base-url"] ?? process.env.UNBROWSE_BASE_URL ?? auth.load().baseUrl ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
  const flag = (k: string) => (typeof args.flags[k] === "string" ? (args.flags[k] as string) : undefined);
  const print = (v: unknown) => io.out(JSON.stringify(v, null, 2));
  const client = async () => new Unbrowse({ apiKey: (await auth.currentToken(origin)) ?? "", baseUrl: origin, client: `cli/${VERSION}` });

  if (cmd === "mcp" && rest[0] !== "add") {
    // stdout carries the protocol: nothing else may be printed there.
    const { serveStdio } = await import("./mcp-proxy.ts");
    const url = flag("url") ?? process.env.UNBROWSE_MCP_URL ?? `${origin}/api/mcp`;
    await serveStdio({
      url,
      token: () => auth.tokenFor(origin, url),
      version: VERSION,
      endUser: flag("end-user") ?? process.env.UNBROWSE_END_USER,
      // --from-here: unbrowse_run's site requests go from this machine (its IP), like `unbrowse run`.
      ...(args.flags["from-here"] || process.env.UNBROWSE_EGRESS === "client" ? { fromHere: client } : {}),
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
    const plan = D.servicePlan({ os: io.service?.os, home: io.service?.home, node, cli, account: named, env: { ...(origin !== DEFAULT_ORIGIN ? { UNBROWSE_BASE_URL: origin } : {}), ...(named ? { UNBROWSE_ACCOUNT: named } : {}), ...(process.env.UNBROWSE_CONFIG_DIR ? { UNBROWSE_CONFIG_DIR: process.env.UNBROWSE_CONFIG_DIR } : {}), ...(process.env.UNBROWSE_COOKIES_HOME ? { UNBROWSE_COOKIES_HOME: process.env.UNBROWSE_COOKIES_HOME } : {}) } });
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
      const message = `Not signed in to ${origin}${named ? ` as account "${named}"` : ""}. Run \`npx ${loginCmd}\` (opens your browser, nothing to paste), or set UNBROWSE_API_KEY (keys: ${origin}/app).`;
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
        // A browser + loopback redirect only works on the person's own machine. With --device, or anywhere there
        // is no interactive terminal (a remote agent's VM, CI, SSH), sign in with a code approved on another device.
        if (key) auth.save({ baseUrl: origin, apiKey: key });
        else if (args.flags.device || !io.interactive) await auth.deviceLogin(origin, { log: io.err });
        else await auth.oauthLogin(origin, { open: (u) => openLink(u, args, io), log: io.err });
        const me = await (await client()).me();
        io.err(`Signed in to ${origin}${named ? ` as account "${named}"` : ""} (workspace ${me.workspaceId}).`);
        await offerCookieSync().catch((e: Error) => io.err(`Cookie sync not set up: ${e.message}`));
        return 0;
      }
      case "accounts": {
        if (rest[0] === "use") {
          const name = auth.checkAccount(need(rest[1], "accounts use <name>"));
          auth.useAccount(name);
          const saved = auth.listAccounts().some((a) => a.name === name);
          io.err(`Commands now use account "${name}"${saved ? "" : ` (not signed in yet: unbrowse login${name === "default" ? "" : ` --account ${name}`})`}.${process.env.UNBROWSE_ACCOUNT ? ` UNBROWSE_ACCOUNT=${process.env.UNBROWSE_ACCOUNT} still wins while it is set.` : ""}`);
          return 0;
        }
        if (rest[0]) throw new UsageError("usage: unbrowse accounts [use <name>]");
        print({ current: auth.account(), accounts: auth.listAccounts() });
        return 0;
      }
      case "mcp": // `mcp add`; plain `mcp` (the proxy) returned above
        return await mcpAdd(rest.slice(1), args, io, origin, named);
      case "logout":
        auth.clear();
        io.err(named ? `Signed out of account "${named}".` : "Signed out.");
        return 0;
      case "whoami":
        print({ origin, account: auth.account(), auth: auth.describe(origin), ...(await ub.me()) });
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
        // A run that needs a kept sign-in, saved login or site key goes from Unbrowse: those never leave the vault.
        if (fromHere && view.egress?.mode === "server") io.err("Ran from Unbrowse, not this machine: this site uses your saved sign-in, which never leaves your vault.");
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
          const plan = D.servicePlan({ os: io.service?.os, home: io.service?.home, node: io.service?.node ?? process.execPath, cli: io.service?.cli ?? process.argv[1] ?? "", account: named });
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
      case "mcps":
        return await mcps(rest, args, io, origin, print, client, onboard);
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
      case "tools":
      case "tool":
        return await mcpTools(cmd, rest, args, io, origin, print, client);
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
    // A site behind a sign-in also answers 401 (login_required), but the person is signed in to Unbrowse: say what
    // the site needs (the server's message names the fix, e.g. `unbrowse cookies sync --domain <site>`), not "log in".
    const siteSignIn = e.status === 401 && siteLoginRequired(e.body);
    if (args.flags.json) print({ error: { status: e.status ?? null, message: e.message, details: e.body ?? null } });
    else if (siteSignIn) io.err(siteSignInHint(siteSignIn, e.message));
    else io.err(e.status === 401 ? `Not signed in to ${origin}${named ? ` as account "${named}"` : ""}. Run \`${loginCmd}\`, or set UNBROWSE_API_KEY.` : `error${e.status ? ` (HTTP ${e.status})` : ""}: ${e.message}`);
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
/**
 * `unbrowse mcp add [claude] [codex]`: registers `unbrowse mcp` (the stdio proxy) with the agent hosts on this
 * machine, so they run on the CLI's sign-in and nobody signs in twice. No token is written anywhere: the proxy
 * reads the CLI's own sign-in at each request. An existing server of that name is left alone unless --replace
 * (checked with `<host> mcp get` first: `codex mcp add` would silently overwrite it).
 */
async function mcpAdd(rest: string[], args: Args, io: Io, origin: string, account?: string): Promise<number> {
  const HOSTS = ["claude", "codex"] as const;
  const unknown = rest.filter((h) => !(HOSTS as readonly string[]).includes(h));
  if (unknown.length) throw new UsageError(`usage: unbrowse mcp add [claude] [codex] [--name NAME] [--replace] [--dry-run] (unknown: ${unknown.join(", ")})`);
  // One server per account (`unbrowse-work`), so a host can hold several side by side.
  const name = (typeof args.flags.name === "string" ? args.flags.name : "") || (account ? `unbrowse-${account}` : "unbrowse");
  const exec = io.exec ?? (() => ({ status: 1, stdout: "", stderr: "no exec" }));
  const dry = !!args.flags["dry-run"];
  const replace = !!args.flags.replace;
  // npm installs claude.cmd / codex.cmd on Windows, which Node only runs through a shell.
  const win = (io.service?.os ?? process.platform) === "win32";
  const shell = (cmd: string[]) => (win ? ["cmd", "/c", ...cmd] : cmd);
  const { ephemeralCli } = await import("./cookie-daemon.ts");
  let cli = io.service?.cli ?? process.argv[1] ?? "";
  try {
    cli = realpathSync(cli);
  } catch {
    /* keep it as given */
  }
  // A temporary npx copy disappears; the host then starts the published CLI the same way.
  const launch = [...(io.service?.cli || !ephemeralCli(cli) ? [io.service?.node ?? process.execPath, cli] : shell(["npx", "-y", "unbrowse"])), "mcp", ...(origin !== DEFAULT_ORIGIN ? ["--base-url", origin] : []), ...(account ? ["--account", account] : [])];
  // Hosts start servers with a reduced environment: pass on where the sign-in lives and the sharing switch.
  // Never UNBROWSE_API_KEY: that would write a secret into the host's config.
  const env = ["UNBROWSE_CONFIG_DIR", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR", "UNBROWSE_SHARED_SIGNIN"].flatMap((k) => (process.env[k] ? [`${k}=${process.env[k]}`] : []));
  const plans = {
    claude: { get: ["claude", "mcp", "get", name], remove: ["claude", "mcp", "remove", name, "--scope", "user"], add: ["claude", "mcp", "add", "--scope", "user", name, ...env.flatMap((e) => ["-e", e]), "--", ...launch] }, // -e is variadic: after the name
    codex: { get: ["codex", "mcp", "get", name], remove: ["codex", "mcp", "remove", name], add: ["codex", "mcp", "add", name, ...env.flatMap((e) => ["--env", e]), "--", ...launch] },
  };
  const wanted = rest.length ? (rest as (typeof HOSTS)[number][]) : HOSTS.filter((h) => dry || exec(shell([h, "--version"])).status === 0);
  if (!wanted.length) return io.err("No Claude Code or Codex found on PATH. Any MCP host can run the proxy itself: " + launch.join(" ")), 1;
  let failed = 0;
  for (const h of wanted) {
    const plan = plans[h];
    if (dry) {
      io.out([...(replace ? [plan.remove] : []), plan.add].map((c) => shell(c).join(" ")).join("\n"));
      continue;
    }
    if (exec(shell(plan.get)).status === 0) {
      if (!replace) {
        failed++;
        io.err(`✗ ${h}: a server named "${name}" already exists; left as it is. Re-run with --replace, or pick --name.`);
        continue;
      }
      const r = exec(shell(plan.remove));
      if (r.status !== 0) {
        failed++;
        io.err(`✗ ${h}: could not remove the existing "${name}": ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
        continue;
      }
    }
    const r = exec(shell(plan.add));
    if (r.status === 0) {
      io.err(`✓ ${h}: added "${name}" (stdio, on this CLI's sign-in)`);
      // The Claude Code plugin brings its own Unbrowse server: with both, every tool is listed twice.
      if (h === "claude" && exec(shell(["claude", "mcp", "get", "plugin:unbrowse:unbrowse"])).status === 0) io.err(`  Claude Code also has the Unbrowse plugin's server (plugin:unbrowse:unbrowse), so its tools now show twice. Keep one: disable that server in /mcp, or \`claude mcp remove ${name} --scope user\`.`);
    }
    else (failed++, io.err(`✗ ${h}: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`));
  }
  if (!dry) {
    const source = auth.signInSource(origin);
    if (source === "env") io.err("This CLI is signed in only through UNBROWSE_API_KEY, which the hosts do not get: run `unbrowse login` (or `unbrowse login --key`) so they have a sign-in.");
    else if (source === "shared") io.err("This CLI is using Claude Code's sign-in, which only Claude Code renews: run `unbrowse login` so the hosts keep working.");
    else if (!source) io.err("Not signed in yet: run `unbrowse login` once and the hosts use that sign-in.");
  }
  return failed ? 1 : 0;
}

/** `unbrowse mcps` and `unbrowse mcps import`: see agent-mcps.ts. Values of keys are never printed. */
async function mcps(rest: string[], args: Args, io: Io, origin: string, print: (v: unknown) => void, client: () => Promise<Unbrowse>, onboard: () => Promise<boolean>): Promise<number> {
  const A = await import("./agent-mcps.ts");
  const { servers, skipped } = A.scan();
  const tilde = (f: string) => f.replace(process.env.HOME ?? "\u0000", "~");
  if (rest[0] !== "import") {
    if (rest[0]) throw new UsageError("usage: unbrowse mcps [import [name…] [--dry-run] [--with-keys]]");
    if (args.flags.json) return print({ servers: servers.map(({ file, ...s }) => ({ ...s, file: tilde(file) })), skipped }), 0;
    if (!servers.length) return io.err(`No MCP servers found in this machine's agent configs.${skipped.length ? ` Unreadable: ${skipped.map((x) => tilde(x.file)).join(", ")}` : ""}`), 0;
    let last = "";
    for (const s of servers) {
      const where = `${s.host}  ${tilde(s.file)}`;
      if (where !== last) io.out(where), (last = where);
      const what = s.url ? `remote  ${s.url}` : `local   ${[s.command, ...(s.args ?? [])].join(" ").slice(0, 90)}`;
      const env = s.envNames.length > 3 ? [...s.envNames.slice(0, 3).map((e) => `env ${e}`), `+${s.envNames.length - 3} env`] : s.envNames.map((e) => `env ${e}`);
      const secrets = [...s.headerNames.map((h) => `header ${h}`), ...env];
      io.out(`  ${s.name.padEnd(22)} ${what}${secrets.length ? `   (${secrets.join(", ")})` : ""}${s.self ? "   (Unbrowse itself)" : ""}`);
    }
    io.err(`\n${A.unique(servers.filter((s) => !s.self)).length} to import: unbrowse mcps import --dry-run`);
    return 0;
  }
  if (!(await auth.currentToken(origin)) && !(await onboard())) return 3;
  const names = new Set(rest.slice(1));
  const pick = A.unique(servers.filter((s) => !s.self && (!names.size || names.has(s.name))));
  const missing = [...names].filter((n) => !servers.some((s) => s.name === n));
  if (missing.length) throw new UsageError(`no MCP server named ${missing.join(", ")} in this machine's agent configs (unbrowse mcps lists them)`);
  if (!pick.length) return io.err("Nothing to import."), 0;
  const dry = !!args.flags["dry-run"];
  const keyed = args.flags["with-keys"] ? pick.flatMap((f) => { const k = A.keyOf(f, A.rawEntry(f) ?? {}); return k ? [{ f, k }] : []; }) : [];
  if (keyed.length && !dry && !args.flags.yes) {
    const list = keyed.map((x) => `${x.f.name} (${x.k.header})`).join(", ");
    if (!io.interactive || !io.ask) throw new UsageError(`Re-run with --yes to confirm: the keys for ${list} will be sent to ${origin} and sealed in your vault.`);
    const ok = (await io.ask(`Send the keys for ${list} from your agent configs to Unbrowse (sealed in your vault)? [y/N] `)).trim().toLowerCase();
    if (ok !== "y" && ok !== "yes") return io.err("Nothing sent."), 1;
  }
  const ub = await client();
  const rows: import("@unbrowse/sdk").ImportOutcome[] = [];
  for (const { f, k } of keyed) {
    if (dry) { rows.push({ name: f.name, status: "planned", via: "url", note: `Would connect ${f.url} with the ${k.header} from its config.` }); continue; }
    try {
      const r = await ub.connectors.connect({ url: f.url!, name: f.name, ...(f.transport ? { transport: f.transport } : {}), header: k.header, key: k.key });
      rows.push({ name: f.name, status: r.status, app: r.app, tools: r.tools, url: r.url, via: "url", note: r.status === "connected" ? `Connected with its key: ${r.tools} tools.` : `Needs the person: ${r.url}` });
    } catch (e) {
      rows.push({ name: f.name, status: "failed", note: (e as Error).message.slice(0, 200) });
    }
  }
  const rest2 = pick.filter((f) => !keyed.some((x) => x.f === f));
  if (rest2.length) rows.push(...(await ub.connectors.import(rest2.map(A.toImport), { dryRun: dry })).results);
  if (args.flags.json) print({ results: rows });
  else {
    const mark: Record<string, string> = { connected: "✓", planned: "·", sign_in: "→", key: "→", already: "=", skipped: "-", local_only: "-", failed: "✗" };
    for (const r of rows) io.out(`${mark[r.status] ?? "?"} ${r.name.padEnd(22)} ${r.status.padEnd(10)} ${r.note}${r.url ? `\n    ${r.url}` : ""}`);
    const hasKeyRows = rows.some((r) => r.status === "key") && !args.flags["with-keys"] && pick.some((f) => f.headerNames.length);
    if (hasKeyRows) io.err("A key server can take the key from your agent config instead: unbrowse mcps import --with-keys");
    if (dry) io.err("Nothing was connected. Run without --dry-run to import.");
  }
  return rows.some((r) => r.status === "failed") ? 1 : 0;
}

/**
 * `unbrowse tools` and `unbrowse tool <name>` (mcp-tools.ts): the hosted MCP's tools through the same proxy
 * `unbrowse mcp` serves, so the CLI can do whatever an agent over MCP can and never drifts from it.
 */
async function mcpTools(cmd: string, rest: string[], args: Args, io: Io, origin: string, print: (v: unknown) => void, client: () => Promise<Unbrowse>): Promise<number> {
  const T = await import("./mcp-tools.ts");
  const { createProxy, localRun } = await import("./mcp-proxy.ts");
  const { UnbrowseMcp } = await import("@unbrowse/sdk");
  const url = process.env.UNBROWSE_MCP_URL ?? `${origin}/api/mcp`;
  const endUser = process.env.UNBROWSE_END_USER;
  const handle = createProxy(async () => new UnbrowseMcp({ url, apiKey: (await auth.tokenFor(origin, url)) ?? "", endUser, client: `cli/${VERSION}` }), VERSION, args.flags["from-here"] ? { runLocal: localRun(client) } : {});
  let id = 0;
  const rpc = async <R,>(method: string, params?: Record<string, unknown>): Promise<R> => {
    const res = (await handle({ jsonrpc: "2.0", id: ++id, method, ...(params ? { params } : {}) })) as { result?: R; error?: { message: string; data?: { code?: string } } };
    if (res.error) throw Object.assign(new Error(res.error.message), { status: res.error.data?.code === "unauthorized" || /unbrowse login/.test(res.error.message) ? 401 : undefined, code: res.error.data?.code });
    return res.result as R;
  };
  const { tools } = await rpc<{ tools: import("@unbrowse/sdk").McpTool[] }>("tools/list");

  if (cmd === "tools") {
    const query = rest.join(" ");
    const one = rest.length === 1 ? T.resolveTool(tools, rest[0]!) : undefined;
    if (one) {
      if (args.flags.json) return print(one), 0;
      io.out(`${one.name}\n\n${one.description ?? ""}\n\nInputs: ${JSON.stringify(one.inputSchema ?? {}, null, 2)}`);
      return io.err(`Call it: unbrowse tool ${T.shortName(one.name)} --key value…`), 0;
    }
    const shown = query ? T.filterTools(tools, query) : tools;
    if (args.flags.json) return print({ tools: shown }), 0;
    if (!shown.length) return io.err(`No tool matches "${query}". All of them: unbrowse tools`), 1;
    for (const t of shown) io.out(`${T.signature(t).padEnd(44)} ${T.summary(t.description)}`);
    io.err(`\n${shown.length} tool(s). One in full: unbrowse tools <name> · call one: unbrowse tool <name> --key value…`);
    return 0;
  }

  const typed = need(rest[0], "tool <name> [JSON] [--key value]… (list them: unbrowse tools)");
  const tool = T.resolveTool(tools, typed);
  if (!tool) {
    const words = typed.toLowerCase().split(/[._\s-]+/).filter((w) => w && w !== "unbrowse");
    const near = tools.filter((t) => words.some((w) => T.shortName(t.name).toLowerCase().includes(w))).slice(0, 5).map((t) => T.shortName(t.name));
    throw new UsageError(`no MCP tool named "${typed}".${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} List them: unbrowse tools`);
  }
  const input = T.toolInput(tool, rest[1] ? rest.slice(1).join(" ") : (typeof args.flags.input === "string" ? args.flags.input : undefined), args.flags, mapValues(args.sets), coerce);
  const result = await rpc<import("./mcp-tools.ts").ToolResult>("tools/call", { name: tool.name, arguments: input });
  const value = T.resultValue(result);
  const code = T.resultCode(result, value);
  if (code === 1) io.err(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  else if (typeof value === "string") io.out(value);
  else print(value);
  if (code === 2) {
    const runId = (value as { runId?: string }).runId;
    io.err(`Input required: ${runId ? `unbrowse resume ${runId} key=value…` : "answer it with unbrowse tool resume"}`);
  }
  return code;
}

/** A site's own sign-in wall (`login_required`), as opposed to this CLI not being signed in to Unbrowse. */
export function siteLoginRequired(body: unknown): { site?: string; next?: string[] } | undefined {
  const err = (body as { error?: { code?: string; details?: { site?: unknown; finalUrl?: unknown; next?: unknown } } } | undefined)?.error;
  if (err?.code !== "login_required") return undefined;
  const d = err.details ?? {};
  let site = typeof d.site === "string" ? d.site : undefined;
  if (!site && typeof d.finalUrl === "string") {
    try {
      site = new URL(d.finalUrl).hostname.replace(/^www\./, "");
    } catch {
      // no usable URL: the hint names no site
    }
  }
  const next = Array.isArray(d.next) ? d.next.filter((s): s is string => typeof s === "string") : undefined;
  return { site, next };
}

export function siteSignInHint(found: { site?: string; next?: string[] }, message: string): string {
  const site = found.site ?? "<site>";
  const lines = [message || `${site} shows a sign-in page.`];
  if (found.next?.length) lines.push(...found.next.map((s) => `  - ${s}`));
  else {
    lines.push(`  Use your own browser's sign-in:  unbrowse cookies sync --domain ${site}`);
    lines.push(`  Keep it fresh:                   unbrowse cookies daemon start --domain ${site}`);
  }
  lines.push("  (--from-here / --from-unbrowse change only where requests come from; neither signs you in.)");
  return lines.join("\n");
}

export function noCapabilityHint(view: RunView, args: Args): string {
  const result = (view.result ?? {}) as { next?: { url?: string }; suggestions?: { tools?: Array<{ capability?: string; title?: string }> } };
  const task = args._.slice(1).join(" ");
  const url = (typeof args.flags.url === "string" ? args.flags.url : undefined) ?? result.next?.url ?? task.match(/https?:\/\/\S+/)?.[0];
  const lines = ["No tool fits this task yet."];
  if (url) {
    lines.push(`  Read the page now:        unbrowse scrape ${url}`);
    lines.push(`  Teach Unbrowse the site:  unbrowse index ${url}   (minutes; then run the task again)`);
    lines.push(`  Do it in a cloud browser: unbrowse tool browse_open --url ${url}   (recorded, so it teaches the site too)`);
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
