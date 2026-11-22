#!/usr/bin/env node
// `unbrowse`: the one command the package installs. It opens the window and runs the node and its programs, which come
// in the platform package beside this one (`@unbrowse/darwin-arm64`, `@unbrowse/linux-x64`, `@unbrowse/win32-x64`, …):
// on a Mac as Unbrowse.app, the window with the node and `unb` beside it in Contents/MacOS; elsewhere the same programs
// in `bin`. They are kept together because each looks for the next beside itself. The browser is an add-on the node
// fetches when a goal first needs it, or `unbrowse browser install` fetches now: no install downloads it.
//
//   unbrowse app                    open the window (it starts the node when none is running)
//   unbrowse start [--from <tag>]   run the node without the window; the tag says where the install came from
//   unbrowse browser install|status|remove|fetch on|off   the browser add-on: get it, see it, take it away, or let the node fetch it
//   unbrowse update [channel …]     check for a newer release now; the node restarts into it once idle
//   unbrowse restart                restart the running node, into the newest release here
//   unbrowse agent|vault|wallet|passkey|session|share|sign-in|telemetry|max-fetch|coin|bounty …   the node's own commands
//   unbrowse skill [dir]            put the agent skill in dir (default ~/.claude/skills/unbrowse); anything there that
//                                   isn't a copy we wrote, unchanged, is moved aside first (to unbrowse-kept beside
//                                   the skills folder), never deleted
//   unbrowse where                  where the programs are
//   unbrowse mcp [--agent <n|first>] the node's MCP server over stdio, for an agent's config: each request signed with
//                                   the token of the agent named (its grant, `unbrowse grant`), else UNBROWSE_AGENT_TOKEN,
//                                   else the node's first agent's grant; an older Unbrowse's flags are ignored
//   unbrowse <anything else>        unb: do, browse, search, call, logins, whoami, connect

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bridge } from "./mcp.js";
import { OLD_SKILL_FILES } from "./old-skills.js";

const here = dirname(fileURLToPath(import.meta.url));
const PROGRAMS = ["unbrowse-node", "unb", "agent-browser"];
const NODE_COMMANDS = new Set([
  "agent", "browser", "chain", "bounty", "coin", "domain", "earnings", "max-fetch", "money", "nodes", "onboard", "passkey", "reports", "session", "network", "restart", "share", "sign-in", "telemetry", "terms", "update",
  "vault", "wallet", "agent-user", "checkout", "confirm", "passphrase", "remote",
]);

/** A program's file name here: Windows' end in .exe. */
function exe(program: string, platform = process.platform): string {
  return platform === "win32" ? `${program}.exe` : program;
}

/** The platform package's name for this machine. */
export function platformPackage(platform = process.platform, arch = process.arch): string {
  return `@unbrowse/${platform}-${arch}`;
}

/** The platform package's folder, when it is installed for this machine. */
function platformDir(): string | undefined {
  try {
    return dirname(createRequire(import.meta.url).resolve(`${platformPackage()}/package.json`));
  } catch {
    return undefined;
  }
}

/** An app's version from its Info.plist (`CFBundleShortVersionString`), as numbers; empty when it has none. */
export function appVersion(app: string): number[] {
  try {
    const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
    const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/);
    return m ? (m[1].match(/\d+/g) ?? []).slice(0, 3).map(Number) : [];
  } catch {
    return [];
  }
}

/**
 * Of the apps that exist, the newest by version; the earlier one on a tie. An app the platform package brought can
 * be older than one the owner installed or updated in Applications, and running the older one's programs against the
 * newer running node fails (its node tries to start a second node on the same port).
 */
export function newestApp(places: string[]): string | undefined {
  const apps = places.filter((a) => existsSync(join(a, "Contents", "MacOS", "unbrowse-window")));
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  let best: string | undefined;
  for (const a of apps) if (best === undefined || cmp(appVersion(a), appVersion(best)) > 0) best = a;
  return best;
}

/**
 * The Team ID `app` is signed by, once its whole signature checks (`codesign --verify --deep --strict`): `undefined`
 * for an app unsigned, signed ad hoc, or whose signature doesn't check, and off a Mac. The system's own codesign.
 */
export function teamOf(app: string): string | undefined {
  if (process.platform !== "darwin") return undefined;
  if (spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "ignore" }).status !== 0) return undefined;
  const said = spawnSync("/usr/bin/codesign", ["-dv", app], { encoding: "utf8" }).stderr ?? "";
  const team = said.match(/^TeamIdentifier=(\S+)$/m)?.[1];
  return team && team !== "not" ? team : undefined;
}

/**
 * The Apple Team ID the release signed the Mac app with, as this package says: `unbrowseAppTeam` in its package.json,
 * written when the release packs it from the signing job's own identity (pack-platforms.sh, pack-sdks.sh). `undefined`
 * for a package with none (a build of one's own, or a release signed ad hoc) or with a value that isn't a Team ID.
 */
export function pinnedTeam(pkgJson = join(here, "..", "package.json")): string | undefined {
  try {
    const team = JSON.parse(readFileSync(pkgJson, "utf8")).unbrowseAppTeam;
    return typeof team === "string" && /^[A-Z0-9]{10}$/.test(team) ? team : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The app to run, of the one the platform package brought (`own`: trusted as the package is) and those installed
 * elsewhere: the newest of `own` and each installed one whose signature checks and is the vendor's team. The vendor's
 * team is the one this package pins (`pinned`), else `own`'s. One that isn't (unsigned, another team's, a signature that
 * doesn't check) never runs in its place, whatever version it says: a folder like ~/Applications is any of this user's
 * programs' to write, and any developer can sign an app called Unbrowse. Signed by somebody is not who made it: with
 * neither a pinned team nor a signed app from the package there is no team to hold them to, and none found elsewhere runs.
 */
export function trustedApp(
  own: string | undefined,
  installed: string[],
  pinned: string | undefined,
  team: (app: string) => string | undefined = teamOf,
): string | undefined {
  const vendor = pinned ?? (own === undefined ? undefined : team(own));
  const signed = vendor === undefined || newestApp(installed) === undefined ? [] : installed.filter((a) => team(a) === vendor);
  return newestApp([...(own === undefined ? [] : [own]), ...signed]);
}

/** The places an installed Unbrowse app is looked for, beside the platform package's own. */
function installedApps(): string[] {
  return ["/Applications/Unbrowse.app", join(homedir(), "Applications", "Unbrowse.app")];
}

/**
 * The app `UNBROWSE_APP` names, held to the same rule as one installed elsewhere (`trustedApp`): it runs when it is the
 * package's own app, or its signature checks and names the vendor's team (the pinned one, else the package app's).
 * An environment variable is inherited by everything started from the shell that set it, so naming an app is not
 * vouching for it. `undefined` when it isn't there or doesn't hold.
 */
export function namedApp(
  named: string,
  own: string | undefined,
  pinned: string | undefined,
  team: (app: string) => string | undefined = teamOf,
): string | undefined {
  const app = newestApp([named]);
  if (app === undefined) return undefined;
  if (own !== undefined && resolve(app) === resolve(own)) return app;
  const vendor = pinned ?? (own === undefined ? undefined : team(own));
  return vendor !== undefined && team(app) === vendor ? app : undefined;
}

/**
 * The variable that runs an app with its signature unchecked: a build of one's own, which no team signed. Its value
 * must be the app's absolute path, nothing else, and every run says on stderr that signature checks are off
 * (`uncheckedWarning`), so it can't be on without the owner seeing it.
 */
export const UNCHECKED_APP = "UNBROWSE_UNCHECKED_APP";

/**
 * The app `UNBROWSE_UNCHECKED_APP` names, run with no signature check, and what to say about it on every run; or, when
 * the value isn't an app's absolute path, no app and why it was ignored. Both `undefined` when it isn't set.
 */
export function uncheckedApp(env: NodeJS.ProcessEnv = process.env): { app?: string; said?: string } {
  const named = env[UNCHECKED_APP];
  if (!named) return {};
  const app = isAbsolute(named) ? newestApp([named]) : undefined;
  if (app === undefined) {
    return { said: `unbrowse: ${UNCHECKED_APP} is set to "${named}", which isn't the absolute path of an Unbrowse app; ignoring it.` };
  }
  return {
    app,
    said:
      `unbrowse: WARNING: signature checks are OFF. Running ${app} because ${UNCHECKED_APP} names it: nothing checked ` +
      `who built or signed it. Unset ${UNCHECKED_APP} unless you put it there for a build of your own.`,
  };
}

/** What to say on stderr on every run while `UNBROWSE_UNCHECKED_APP` is set; empty otherwise. */
export function uncheckedWarning(env: NodeJS.ProcessEnv = process.env): string {
  return uncheckedApp(env).said ?? "";
}

/**
 * The Unbrowse app, on a Mac: the one `UNBROWSE_UNCHECKED_APP` names, unchecked and said so; else the one
 * `UNBROWSE_APP` names when it holds to the vendor's team (`namedApp`), and none if it doesn't; else the one the
 * platform package brings, or a newer one installed in Applications signed by the vendor's team (`trustedApp`).
 * `undefined` when there is none.
 */
export function appBundle(): string | undefined {
  const unchecked = uncheckedApp().app;
  if (unchecked !== undefined) return unchecked;
  const env = process.env.UNBROWSE_APP;
  if (!env && process.platform !== "darwin") return undefined;
  const pkg = platformDir();
  const own = pkg === undefined ? undefined : newestApp([join(pkg, "Unbrowse.app")]);
  if (env) return namedApp(env, own, pinnedTeam());
  return trustedApp(own, installedApps(), pinnedTeam());
}

/**
 * Why an app that is there wasn't run, when none is: this package names no team to hold it to, or it isn't that team's.
 * Empty otherwise.
 */
export function passedOver(): string {
  if (uncheckedApp().app !== undefined || appBundle() !== undefined) return "";
  const env = process.env.UNBROWSE_APP;
  if (!env && process.platform !== "darwin") return "";
  const found = env ? newestApp([env]) : newestApp(installedApps());
  if (found === undefined) return "";
  const why = pinnedTeam() === undefined
    ? `this package names no signing team to check it against`
    : `it isn't signed by the team this package names`;
  return (
    ` ${found} is there, but ${why}, so it isn't run. For a build of your own that no team signed, ` +
    `${UNCHECKED_APP}=<its absolute path> runs it with signature checks off, and says so on every run.`
  );
}

/**
 * Where the programs are: `UNBROWSE_BIN`, else inside the Unbrowse app (the platform package's, else an installed one),
 * else the platform package's `bin`. `undefined` when none has them, and the programs are then looked up on PATH.
 */
export function binDir(): string | undefined {
  const env = process.env.UNBROWSE_BIN;
  if (env) return env;
  const app = appBundle();
  const pkg = platformDir();
  return [app && join(app, "Contents", "MacOS"), pkg && join(pkg, "bin")]
    .filter((d): d is string => !!d)
    .find((d) => existsSync(join(d, exe("unbrowse-node"))));
}

/** What to say when the programs aren't here. */
function missing(what: string): string {
  return (
    `${what} comes in ${platformPackage()}, which isn't installed for this machine. ` +
    "Reinstall unbrowse on a supported machine (macOS, Linux or Windows on x64 or arm64 as released), or set UNBROWSE_BIN." +
    passedOver()
  );
}

/** The skill the package carries, else the one in the repository this runs from. */
export function skillDir(): string | undefined {
  return [join(here, "..", "skill"), join(here, "..", "..", "..", "skills", "unbrowse")].find((d) =>
    existsSync(join(d, "SKILL.md")),
  );
}

/** Which program a command goes to, and with what. */
export function route(args: string[]): { program: string; args: string[] } {
  if (args[0] === "start") return { program: "unbrowse-node", args: args.slice(1) };
  if (NODE_COMMANDS.has(args[0])) return { program: "unbrowse-node", args };
  return { program: "unb", args };
}

/** What an install leaves beside the skill it wrote: each file's SHA-256, so a later install can tell its copy is untouched. */
const WRITTEN = ".unbrowse-installed.json";

/** Every file under `dir` but `WRITTEN`, by its path there, with its SHA-256. */
function hashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name !== WRITTEN || d !== dir) out[relative(dir, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

/**
 * Whether `to` holds nothing, or exactly the skill an install wrote there: a real folder (no link to the owner's own
 * copy), with the record that install left, every file it wrote unchanged and none added.
 */
export function onlyOursAt(to: string): boolean {
  if (!there(to)) return true;
  try {
    if (!lstatSync(to).isDirectory()) return false;
    const written = JSON.parse(readFileSync(join(to, WRITTEN), "utf8")) as Record<string, string>;
    const now = hashes(to);
    const names = Object.keys(written);
    return names.length === Object.keys(now).length && names.every((n) => now[n] === written[n]);
  } catch {
    return false;
  }
}

/** Whether anything is at `p`, a link to nothing included. */
function there(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `to` is a real folder holding an older Unbrowse's skill as it was published: SKILL.md and only files whose
 * SHA-256 is one of a published copy's (`OLD_SKILL_FILES`). The 12.x client and `npx skills add` left no record, so
 * this is how an install knows that copy was ours and isn't the owner's edit (R-I3).
 */
export function oldCopyAt(to: string): boolean {
  try {
    if (!lstatSync(to).isDirectory()) return false;
    const now = Object.entries(hashes(to)).map(([n, h]) => [n.split(sep).join("/"), h] as const);
    return now.some(([n]) => n === "SKILL.md") && now.every(([n, h]) => OLD_SKILL_FILES[n]?.includes(h) ?? false);
  } catch {
    return false;
  }
}

/**
 * Where a skill folder that isn't ours is kept: `unbrowse-kept` beside the skills folder (`~/.claude/unbrowse-kept` for
 * `~/.claude/skills/unbrowse`), not in it, so the agent doesn't load the old copy as a second skill (it would with
 * `<to>.before-unbrowse-<time>`, found in S8 with Claude Code 2.1.326).
 */
export function keptDir(to: string): string {
  return join(dirname(dirname(to)), "unbrowse-kept");
}

/**
 * Moves what is at `to` to `keptDir(to)/<name>.before-unbrowse-<local time>` (`-<n>` added if that is taken), the name
 * the Codex installer uses. A link is kept as a link to the same place, its target made absolute so the move can't break it.
 */
function moveAside(to: string): string {
  const d = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  const dir = keptDir(to);
  mkdirSync(dir, { recursive: true });
  const name = `${basename(to)}.before-unbrowse-${stamp}`;
  let kept = join(dir, name);
  for (let n = 1; there(kept); n++) kept = join(dir, `${name}-${n}`);
  if (lstatSync(to).isSymbolicLink()) {
    symlinkSync(resolve(dirname(to), readlinkSync(to)), kept);
    unlinkSync(to);
  } else renameSync(to, kept);
  return kept;
}

/**
 * Puts the skill in `to` and leaves the record of what it wrote. A copy we wrote there that nobody changed since (this
 * package's, by its record, or an older Unbrowse's, by its published hashes) is replaced whole, so no file an earlier
 * skill left reads as part of this one. Anything else (instructions the owner edited, their own skill of this name, a
 * link to their copy) is theirs: it is moved aside first, never deleted, and `kept` says where.
 */
function installSkill(to = join(homedir(), ".claude", "skills", "unbrowse")): { to: string; kept?: string } {
  const from = skillDir();
  if (!from) throw new Error("this package carries no skill");
  const kept = onlyOursAt(to) || oldCopyAt(to) ? undefined : moveAside(to);
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, { recursive: true });
  writeFileSync(join(to, WRITTEN), JSON.stringify(hashes(to), null, 2));
  return { to, kept };
}

/** What to say about an install of the skill. */
function saySkill({ to, kept }: { to: string; kept?: string }): string {
  return (kept ? `kept what was at ${to} as ${kept}, as it was; ` : "") + `the unbrowse skill is in ${to}`;
}

/** Opens the window, which starts the node itself when none is running. */
function openApp(): number {
  const app = appBundle();
  if (app) {
    makeRunnable(join(app, "Contents", "MacOS"), [...PROGRAMS, "unbrowse-window"]);
    const r = spawnSync("open", [app], { stdio: "inherit" });
    if (r.error) {
      console.error(`unbrowse: can't open ${app} (${r.error.message})`);
      return 1;
    }
    return r.status ?? 1;
  }
  const dir = binDir();
  const window = dir && join(dir, exe("unbrowse-window"));
  if (!dir || !window || !existsSync(window)) {
    console.error(`unbrowse: there's no Unbrowse app here. ${missing("The window")}`);
    return 1;
  }
  makeRunnable(dir, [...PROGRAMS, "unbrowse-window"]);
  // On its own: the window outlives this command, as an app opened from a launcher would.
  spawn(window, [], { detached: true, stdio: "ignore" }).unref();
  return 0;
}

/** A package manager may unpack the programs without their mode. */
function makeRunnable(dir: string, programs: string[]) {
  try {
    for (const p of programs) if (existsSync(join(dir, exe(p)))) chmodSync(join(dir, exe(p)), 0o755);
  } catch {
    // Read-only: they keep the mode they came with.
  }
}

function run(program: string, args: string[]): number {
  const dir = binDir();
  const path = dir ? join(dir, exe(program)) : program;
  if (dir) makeRunnable(dir, PROGRAMS);
  const r = spawnSync(path, args, { stdio: "inherit" });
  if (r.error) {
    console.error(`unbrowse: can't run ${program} (${r.error.message}). ${missing(program)}`);
    return 127;
  }
  return r.status ?? 1;
}

function main(args: string[]): number {
  switch (args[0]) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(
        "usage: unbrowse app | unbrowse start [--from <tag>] | unbrowse update [channel stable|canary|auto] | unbrowse restart\n" +
          "       unbrowse do <goal> [--url <page>] | unbrowse browse <command…> | unbrowse search [words]\n" +
          "       unbrowse call <id> [name=value …] | unbrowse logins | unbrowse whoami | unbrowse connect\n" +
          "       unbrowse mcp [--agent <n|first>] (the node's MCP server over stdio, for an agent's MCP config)\n" +
          "       unbrowse agent new | unbrowse vault … | unbrowse session … | unbrowse passkey … | unbrowse wallet … | unbrowse skill [dir] | unbrowse where\n" +
          "       unbrowse share used|all|off|status | unbrowse share route <id> on|off | unbrowse sign-in [--wallet <address>]\n" +
          "       unbrowse browser [status] | unbrowse browser install [--from <path>] | unbrowse browser remove [--chromium] | unbrowse browser fetch on|off\n" +
          "The node runs without a browser: search, call and whoami need none. Learning a page or browsing one needs it, and the\n" +
          "node fetches it then (unless `unbrowse browser fetch off`), or `unbrowse browser install` gets it now.",
      );
      return 0;
    case "where":
      console.log(binDir() ?? "on PATH");
      return 0;
    case "app":
      return openApp();
    case "skill":
      console.log(saySkill(installSkill(args[1] ? resolve(args[1]) : undefined)));
      return 0;
    case "postinstall":
      // A global install puts the skill where Claude Code reads skills, when Claude Code is here: an older Unbrowse's
      // copy there is replaced, anything else moved aside (`installSkill`). It never fails the install.
      if (process.env.npm_config_global === "true" && existsSync(join(homedir(), ".claude"))) {
        try {
          const done = installSkill();
          if (done.kept) console.error(`unbrowse: ${saySkill(done)}`);
        } catch (e) {
          console.error(`unbrowse: the skill wasn't put in ~/.claude/skills/unbrowse (${(e as Error).message}); \`unbrowse skill\` does it.`);
        }
      }
      return 0;
    default: {
      const { program, args: rest } = route(args);
      return run(program, rest);
    }
  }
}

// Run as the command (npm links it, so the path is followed), not when imported.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  // Every run, whatever the command: an unchecked app is never on quietly.
  const unchecked = uncheckedWarning();
  if (unchecked) console.error(unchecked);
  if (args[0] === "mcp" && (args.some((a) => a === "--agent" || a.startsWith("--agent=")) || !process.env.UNBROWSE_AGENT_TOKEN)) {
    // An agent named, not its token: `unb mcp --agent` reads the owner's grant for it as it starts. With neither, this
    // is an entry an older Unbrowse wrote (`npx -y unbrowse mcp`, `… mcp --account x`): unb ignores its flags and
    // speaks for the node's first agent, and never reads the hosted sign-in that entry was made for.
    process.exit(run("unb", args));
  } else if (args[0] === "mcp") {
    // Runs until the agent closes its end.
    bridge().then(
      () => process.exit(0),
      (e) => {
        console.error(`unbrowse mcp: ${(e as Error).message}`);
        process.exit(1);
      },
    );
  } else {
    process.exit(main(args));
  }
}
