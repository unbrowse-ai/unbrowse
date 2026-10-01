// Continuous cookie sync, for `unbrowse cookies watch` and `unbrowse cookies daemon`: re-read the browser's cookies
// for the sites the person chose, upload a site's cookies when they changed (and at least once a day, so the kept
// session never ages out), and run as a user service (systemd on Linux, launchd on macOS) that survives logouts and
// reboots. Only the listed sites ever leave the machine. Pure decisions here; files, processes and the network are
// passed in, so the loop is testable without a browser or a server.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import type { Cookie, Profile } from "./cookies.ts";

/** What the daemon syncs: written by `cookies daemon start`, read by `cookies watch`. `sites: ["*"]` = every site in the profile. */
export type SyncConfig = { sites: string[]; browser?: string; profile?: string; intervalMin: number; baseUrl?: string };
/** What the last syncs did, for `cookies daemon status`. Never holds a cookie value: a hash per site. */
export type SyncState = { lastRun?: number; lastOk?: number; lastError?: string; failures?: number; sites: Record<string, { hash: string; uploadedAt: number; cookies: number }> };

/** `*` means every site in the profile (the person chose "everything"), including sites they sign into later. */
export const ALL_SITES = "*";
export const allSites = (cfg: Pick<SyncConfig, "sites">): boolean => cfg.sites.includes(ALL_SITES);
/** Cookies per upload request: a whole profile can be thousands, too many for one body. */
export const UPLOAD_BATCH = 500;

/** Second-level registries whose site names take three labels (bbc.co.uk, singpass.gov.sg, shop.com.sg). */
const TWO_LEVEL = /^(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$/;
/** The registrable site a cookie belongs to (accounts.google.com and .google.com → google.com), for grouping and change-detection. */
export function siteOf(domain: string): string {
  const labels = domain.replace(/^\./, "").toLowerCase().split(".");
  if (labels.length <= 2) return labels.join(".");
  const two = labels.slice(-2).join(".");
  return TWO_LEVEL.test(two) ? labels.slice(-3).join(".") : two;
}

export const DEFAULT_INTERVAL_MIN = 15;
/** A site whose cookies did not change is still re-uploaded after this long: the kept session's keep window resets. */
export const REFRESH_MS = 24 * 60 * 60_000;
export const SERVICE = "unbrowse-cookies";
export const LAUNCHD_LABEL = "ai.unbrowse.cookies";

export function configDir(cliConfigPath: string): string {
  return dirname(cliConfigPath);
}
export const configFile = (dir: string) => join(dir, "cookie-sync.json");
export const stateFile = (dir: string) => join(dir, "cookie-sync.state.json");

export function readJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

/** "github.com, https://www.linkedin.com/feed" → ["github.com", "linkedin.com"]: hosts, deduplicated, no scheme or www. */
export function parseSites(raw: string | undefined): string[] {
  const out = new Set<string>();
  for (const part of String(raw ?? "").split(/[\s,]+/)) {
    let h = part.trim().toLowerCase();
    if (!h) continue;
    if (h === ALL_SITES || h === "all") return [ALL_SITES];
    if (/^[a-z]+:\/\//.test(h)) {
      try {
        h = new URL(h).hostname;
      } catch {
        continue;
      }
    }
    h = h.replace(/\/.*$/, "").replace(/^www\./, "").replace(/^\./, "");
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) out.add(h);
  }
  return [...out];
}

/** The profile to read: the one named, else the browser's Default (or first) profile, else the first one found. */
export function pickProfile(profiles: Profile[], browser?: string, profile?: string): Profile | undefined {
  const b = browser?.toLowerCase();
  const matches = profiles.filter((p) => (!b || p.browser.toLowerCase() === b) && (!profile || p.profile === profile));
  return matches.find((p) => p.profile === "Default") ?? matches[0];
}

/** A stable fingerprint of a site's cookies (name, value, path, expiry): changes when any of them does. */
export function digest(cookies: Pick<Cookie, "domain" | "name" | "value" | "path" | "expires">[]): string {
  const rows = cookies.map((c) => `${c.domain}|${c.name}|${c.path}|${c.expires}|${c.value}`).sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 32);
}

export type SyncDeps = {
  findProfiles: () => Profile[];
  readCookies: (p: Profile, opts: { domain?: string }) => Cookie[];
  upload: (cookies: Cookie[]) => Promise<{ sites: number; cookies: number }>;
  now: () => number;
};

export type SyncResult = { uploaded: string[]; unchanged: string[]; empty: string[]; cookies: number; profile?: string; error?: string };

/**
 * One sync: read the cookies for each configured site (or, in `*` mode, every site in the profile) from the chosen
 * profile, and upload the sites whose cookies changed (or were last uploaded over REFRESH_MS ago). Uploads go in
 * batches of UPLOAD_BATCH so a whole-profile sync of thousands of cookies does not become one huge body. Expired and
 * undecryptable cookies are never sent.
 */
export async function syncOnce(deps: SyncDeps, cfg: SyncConfig, state: SyncState): Promise<SyncResult> {
  const now = deps.now();
  state.lastRun = now;
  const profile = pickProfile(deps.findProfiles(), cfg.browser, cfg.profile);
  if (!profile) {
    state.lastError = cfg.browser ? `no ${cfg.browser}${cfg.profile ? ` profile ${cfg.profile}` : ""} found on this machine` : "no browser found on this machine";
    state.failures = (state.failures ?? 0) + 1;
    return { uploaded: [], unchanged: [], empty: [], cookies: 0, error: state.lastError };
  }
  const res: SyncResult = { uploaded: [], unchanged: [], empty: [], cookies: 0, profile: `${profile.browser}:${profile.profile}` };
  const live = (cookies: Cookie[]) => cookies.filter((c) => c.value && (c.expires === 0 || c.expires * 1000 > now));

  // The cookies to consider, grouped by registrable site. Named mode reads each site; `*` reads the whole profile
  // and groups every cookie by its site, so new sites the person signs into are picked up on their own.
  const bySite = new Map<string, Cookie[]>();
  try {
    if (allSites(cfg)) {
      for (const c of live(deps.readCookies(profile, {}))) {
        const site = siteOf(c.domain);
        (bySite.get(site) ?? bySite.set(site, []).get(site)!).push(c);
      }
    } else {
      for (const site of cfg.sites) {
        const cookies = live(deps.readCookies(profile, { domain: site }));
        if (cookies.length) bySite.set(site, cookies);
        else res.empty.push(site);
      }
    }
  } catch (e) {
    state.lastError = `${res.profile}: could not read cookies (${(e as Error).message})`;
    state.failures = (state.failures ?? 0) + 1;
    return { ...res, error: state.lastError };
  }

  const batch: Cookie[] = [];
  const pending: Record<string, { hash: string; cookies: number }> = {};
  for (const [site, cookies] of bySite) {
    const hash = digest(cookies);
    const prev = state.sites[site];
    if (prev && prev.hash === hash && now - prev.uploadedAt < REFRESH_MS) {
      res.unchanged.push(site);
      continue;
    }
    batch.push(...cookies);
    pending[site] = { hash, cookies: cookies.length };
    res.uploaded.push(site);
  }
  if (batch.length) {
    try {
      for (let i = 0; i < batch.length; i += UPLOAD_BATCH) await deps.upload(batch.slice(i, i + UPLOAD_BATCH));
    } catch (e) {
      const err = e as Error & { status?: number };
      state.lastError = err.status === 401 ? "signed out of Unbrowse: run `unbrowse login`" : `upload failed: ${err.message}`;
      state.failures = (state.failures ?? 0) + 1;
      // Sites whose batch already landed are recorded, so a mid-way failure does not re-send them next time.
      res.cookies = batch.length;
      return { ...res, error: state.lastError };
    }
    for (const [site, p] of Object.entries(pending)) state.sites[site] = { ...p, uploadedAt: now };
    res.cookies = batch.length;
  }
  res.uploaded.sort();
  res.unchanged.sort();
  state.lastOk = now;
  delete state.lastError;
  state.failures = 0;
  return res;
}

/** How long to wait before the next sync: the interval, doubled per failure in a row (to an hour at most). */
export function nextDelayMs(cfg: SyncConfig, state: SyncState): number {
  const base = Math.max(1, cfg.intervalMin) * 60_000;
  const failures = state.failures ?? 0;
  return failures ? Math.min(60 * 60_000, base * 2 ** Math.min(failures, 6)) : base;
}

/** One line per sync, for the service log. Site names and counts only, never a value; a long list is summarised. */
export function describe(r: SyncResult): string {
  if (r.error) return `cookie sync failed: ${r.error}`;
  const list = (sites: string[]) => (sites.length > 8 ? `${sites.slice(0, 6).join(", ")} … (${sites.length} sites)` : sites.join(", "));
  const parts = [r.uploaded.length ? `uploaded ${list(r.uploaded)} (${r.cookies} cookies)` : "", r.unchanged.length ? `unchanged ${r.unchanged.length > 8 ? `${r.unchanged.length} sites` : r.unchanged.join(", ")}` : "", r.empty.length ? `not signed in: ${list(r.empty)}` : ""].filter(Boolean);
  return `cookie sync from ${r.profile}: ${parts.join("; ") || "nothing to do"}`;
}

/**
 * Runs syncs until `signal` aborts: one now, then one per interval (backing off on failures). Each sync gets a fresh
 * client (`deps()`), so a refreshed sign-in is picked up.
 */
export async function watch(opts: { deps: () => Promise<SyncDeps>; cfg: SyncConfig; statePath: string; log: (s: string) => void; signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }): Promise<void> {
  const sleep = opts.sleep ?? ((ms, signal) => new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  }));
  while (!opts.signal?.aborted) {
    const state = readJson<SyncState>(opts.statePath, { sites: {} });
    state.sites ??= {};
    let r: SyncResult;
    try {
      r = await syncOnce(await opts.deps(), opts.cfg, state);
    } catch (e) {
      state.lastError = (e as Error).message;
      state.failures = (state.failures ?? 0) + 1;
      r = { uploaded: [], unchanged: [], empty: [], cookies: 0, error: state.lastError };
    }
    writeJson(opts.statePath, state);
    opts.log(`${new Date().toISOString()} ${describe(r)}`);
    if (opts.signal?.aborted) break;
    await sleep(nextDelayMs(opts.cfg, state), opts.signal);
  }
}

export type ServicePlan = { kind: "systemd" | "launchd"; path: string; content: string; enable: string[][]; disable: string[][]; status: string[]; log: string };

/**
 * The user service that runs `cookies watch`: a systemd user unit on Linux, a LaunchAgent on macOS. `node` and
 * `cli` are absolute paths (the running Node and this CLI's entry script), so the service does not depend on PATH.
 * Windows has no service here: run `unbrowse cookies watch` from Task Scheduler instead.
 */
export function servicePlan(opts: { os?: NodeJS.Platform; home?: string; node: string; cli: string; env?: Record<string, string>; uid?: number }): ServicePlan | undefined {
  const os = opts.os ?? platform();
  const home = opts.home ?? homedir();
  const env = Object.entries(opts.env ?? {});
  if (os === "linux") {
    const path = join(home, ".config", "systemd", "user", `${SERVICE}.service`);
    const content = [
      "[Unit]",
      "Description=Unbrowse cookie sync: keeps your browser sign-ins for chosen sites in sync with Unbrowse",
      "After=network-online.target",
      "",
      "[Service]",
      `ExecStart=${quoteSystemd(opts.node)} ${quoteSystemd(opts.cli)} cookies watch`,
      ...env.map(([k, v]) => `Environment=${quoteSystemd(`${k}=${v}`)}`),
      "Restart=on-failure",
      "RestartSec=60",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n");
    return {
      kind: "systemd",
      path,
      content,
      enable: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", `${SERVICE}.service`]],
      disable: [["systemctl", "--user", "disable", "--now", `${SERVICE}.service`], ["systemctl", "--user", "daemon-reload"]],
      status: ["systemctl", "--user", "is-active", `${SERVICE}.service`],
      log: `journalctl --user -u ${SERVICE} -f`,
    };
  }
  if (os === "darwin") {
    const path = join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    const logPath = join(home, "Library", "Logs", `${SERVICE}.log`);
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(opts.node)}</string><string>${esc(opts.cli)}</string><string>cookies</string><string>watch</string></array>
${env.length ? `  <key>EnvironmentVariables</key>\n  <dict>${env.map(([k, v]) => `<key>${esc(k)}</key><string>${esc(v)}</string>`).join("")}</dict>\n` : ""}  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>${esc(logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(logPath)}</string>
</dict>
</plist>
`;
    const domain = `gui/${opts.uid ?? process.getuid?.() ?? 501}`;
    return {
      kind: "launchd",
      path,
      content,
      enable: [["launchctl", "bootout", domain, path], ["launchctl", "bootstrap", domain, path]],
      disable: [["launchctl", "bootout", domain, path]],
      status: ["launchctl", "print", `${domain}/${LAUNCHD_LABEL}`],
      log: `tail -f ${logPath}`,
    };
  }
  return undefined;
}

function quoteSystemd(s: string): string {
  return /[\s"\\]/.test(s) ? `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : s;
}

/** An entry script that will not exist later (an npx cache, a temp dir): a service must not point at it. */
export function ephemeralCli(cli: string): boolean {
  return /[\\/](_npx|\.npm[\\/]_npx|npx-[^\\/]+|tmp|Temp)[\\/]/i.test(cli);
}
