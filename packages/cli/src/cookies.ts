// Read cookies from the browsers installed on this machine, for `unbrowse cookies`. Chromium-family cookie values
// are encrypted at rest (a key from the OS keychain, or a fixed key on Linux); Firefox stores them in the clear.
// Nothing here talks to the network — extraction and decryption are local; the CLI decides what to upload.
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readTable, type Row } from "./sqlite.ts";

export type Cookie = {
  domain: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds; 0 = session cookie. */
  expires: number;
};

export type Profile = { browser: string; profile: string; label: string; path: string; engine: "chromium" | "firefox" };

const HOME = homedir();
const OS = platform();

/** Where each browser keeps its profiles, per OS, and the keychain service its key lives under (Chromium). */
type BrowserDef = { name: string; engine: "chromium" | "firefox"; dirs: Partial<Record<NodeJS.Platform, string[]>>; keychain?: string };

const BROWSERS: BrowserDef[] = [
  chromium("Chrome", ["Google/Chrome", "google-chrome"], "Chrome"),
  chromium("Chromium", ["Chromium", "chromium"], "Chromium"),
  chromium("Arc", ["Arc/User Data", "Arc"], "Arc"),
  chromium("Brave", ["BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser"], "Brave"),
  chromium("Edge", ["Microsoft Edge", "microsoft-edge"], "Microsoft Edge"),
  chromium("Opera", ["com.operasoftware.Opera", "opera"], "Opera"),
  chromium("Vivaldi", ["Vivaldi", "vivaldi"], "Vivaldi"),
  firefox("Firefox", ["Firefox", "mozilla/firefox", ".mozilla/firefox"]),
  firefox("LibreWolf", ["LibreWolf", "librewolf", ".librewolf"]),
  firefox("Waterfox", ["Waterfox", "waterfox", ".waterfox"]),
];

function chromium(name: string, [mac, linux]: [string, string] | string[], keychain: string): BrowserDef {
  return {
    name,
    engine: "chromium",
    keychain: `${keychain} Safe Storage`,
    dirs: {
      darwin: [join(HOME, "Library/Application Support", mac!)],
      linux: [join(HOME, ".config", linux!), join(HOME, ".var/app", flatpakId(name), "config", linux!)],
      win32: [join(process.env.LOCALAPPDATA ?? join(HOME, "AppData/Local"), mac!.replace(/\//g, "\\"), "User Data")],
    },
  };
}

function firefox(name: string, [mac, linux, linuxHome]: string[]): BrowserDef {
  return {
    name,
    engine: "firefox",
    dirs: {
      darwin: [join(HOME, "Library/Application Support", mac!)],
      linux: [join(HOME, ".config", linux!), join(HOME, linuxHome ?? `.${name.toLowerCase()}`)],
      win32: [join(process.env.APPDATA ?? join(HOME, "AppData/Roaming"), mac!)],
    },
  };
}

function flatpakId(name: string): string {
  const ids: Record<string, string> = { Chrome: "com.google.Chrome", Chromium: "org.chromium.Chromium", Brave: "com.brave.Browser", Opera: "com.opera.Opera", Vivaldi: "com.vivaldi.Vivaldi" };
  return ids[name] ?? name;
}

/** Every browser profile found on this machine, each with a unique `profile` id (a second install of the same
 * browser — e.g. a Flatpak alongside the native one — is suffixed so it can be picked). */
export function findProfiles(): Profile[] {
  const raw: Profile[] = [];
  for (const def of BROWSERS) {
    for (const base of def.dirs[OS] ?? []) {
      if (!existsSync(base)) continue;
      raw.push(...(def.engine === "chromium" ? chromiumProfiles(def, base) : firefoxProfiles(def, base)));
    }
  }
  const seen = new Map<string, number>();
  return raw.map((p) => {
    const kbase = `${p.browser}:${p.profile}`;
    const n = seen.get(kbase) ?? 0;
    seen.set(kbase, n + 1);
    if (n === 0) return p;
    const tag = p.path.includes("/.var/app/") ? "flatpak" : p.path.includes("/snap/") ? "snap" : String(n + 1);
    const profile = `${p.profile}@${tag}`;
    return { ...p, profile, label: `${p.browser} · ${profile}` };
  });
}

function chromiumProfiles(def: BrowserDef, base: string): Profile[] {
  const out: Profile[] = [];
  let names: string[] = [];
  try {
    const local = JSON.parse(readFileSync(join(base, "Local State"), "utf8")) as { profile?: { info_cache?: Record<string, { name?: string }> } };
    names = Object.keys(local.profile?.info_cache ?? {});
  } catch {
    names = ["Default"];
  }
  if (!names.length) names = ["Default"];
  for (const dir of names) {
    const path = join(base, dir);
    if (existsSync(join(path, "Cookies")) || existsSync(join(path, "Network", "Cookies"))) {
      out.push({ browser: def.name, profile: dir, label: `${def.name} · ${dir}`, path, engine: "chromium" });
    }
  }
  return out;
}

function firefoxProfiles(def: BrowserDef, base: string): Profile[] {
  const out: Profile[] = [];
  let dirs: string[] = [];
  try {
    const ini = readFileSync(join(base, "profiles.ini"), "utf8");
    dirs = [...ini.matchAll(/^Path=(.+)$/gm)].map((m) => m[1]!.trim());
  } catch {
    dirs = safeReaddir(base).filter((d) => /\.default|\.dev-edition/.test(d));
  }
  for (const rel of dirs) {
    const path = join(base, rel);
    if (existsSync(join(path, "cookies.sqlite"))) out.push({ browser: def.name, profile: rel, label: `${def.name} · ${rel}`, path, engine: "firefox" });
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Read (and decrypt) the cookies of one profile, optionally only for a domain (matches the host and its subdomains). */
export function readCookies(profile: Profile, opts: { domain?: string } = {}): Cookie[] {
  return profile.engine === "chromium" ? chromiumCookies(profile, opts) : firefoxCookies(profile, opts);
}

/** Copy a possibly-locked DB to memory (the browser holds a lock; a plain read still works on a copy of the bytes). */
function loadDb(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function domainMatch(host: string, want?: string): boolean {
  if (!want) return true;
  const h = host.replace(/^\./, "").toLowerCase();
  const w = want.replace(/^\./, "").toLowerCase();
  return h === w || h.endsWith(`.${w}`);
}

function chromiumCookies(profile: Profile, opts: { domain?: string }): Cookie[] {
  const dbPath = existsSync(join(profile.path, "Network", "Cookies")) ? join(profile.path, "Network", "Cookies") : join(profile.path, "Cookies");
  const rows = readTable(loadDb(dbPath), "cookies");
  const decryptor = chromiumDecryptor(profile.browser);
  const out: Cookie[] = [];
  for (const r of rows) {
    const host = String(r.host_key ?? "");
    if (!domainMatch(host, opts.domain)) continue;
    const plain = String(r.value ?? "");
    const enc = r.encrypted_value as Uint8Array | null;
    const value = plain || (enc && enc.length ? decryptor(enc, host) : "");
    if (value === undefined || value === null) continue;
    out.push({
      domain: host,
      name: String(r.name ?? ""),
      value,
      path: String(r.path ?? "/"),
      secure: num(r.is_secure ?? r.secure) === 1,
      httpOnly: num(r.is_httponly ?? r.httponly) === 1,
      expires: chromeTimeToUnix(num(r.expires_utc)),
    });
  }
  return out;
}

function firefoxCookies(profile: Profile, opts: { domain?: string }): Cookie[] {
  const rows = readTable(loadDb(join(profile.path, "cookies.sqlite")), "moz_cookies");
  const out: Cookie[] = [];
  for (const r of rows) {
    const host = String(r.host ?? "");
    if (!domainMatch(host, opts.domain)) continue;
    out.push({
      domain: host,
      name: String(r.name ?? ""),
      value: String(r.value ?? ""),
      path: String(r.path ?? "/"),
      secure: num(r.isSecure) === 1,
      httpOnly: num(r.isHttpOnly) === 1,
      expires: num(r.expiry),
    });
  }
  return out;
}

function num(v: unknown): number {
  return typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : Number(v ?? 0);
}

/** Chrome stores expiry as microseconds since 1601-01-01; convert to Unix seconds (0 = session cookie). */
function chromeTimeToUnix(micros: number): number {
  if (!micros) return 0;
  return Math.floor(micros / 1_000_000 - 11_644_473_600);
}

// ── Chromium decryption ────────────────────────────────────────────────────────────────────────────

/** A function that decrypts one Chromium `encrypted_value` for a host, or "" when it cannot. */
function chromiumDecryptor(browser: string): (enc: Uint8Array, host: string) => string {
  if (OS === "win32") {
    const key = windowsKey(browser);
    return (enc, host) => (key ? decryptGcm(enc, key, host) : "");
  }
  const iterations = OS === "darwin" ? 1003 : 1;
  const cache = new Map<string, Buffer | null>();
  const keyFor = (version: string): Buffer | null => {
    if (!cache.has(version)) {
      const password = version === "v10" && OS === "linux" ? "peanuts" : chromiumPassword(browser);
      cache.set(version, password ? pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1") : null);
    }
    return cache.get(version) ?? null;
  };
  return (enc, host) => {
    const version = new TextDecoder().decode(enc.subarray(0, 3));
    const key = keyFor(version);
    if (!key) return "";
    return decryptCbc(enc.subarray(3), key, host);
  };
}

/** AES-128-CBC with a fixed all-spaces IV (Chromium on macOS/Linux). Strips the host-hash prefix newer Chrome adds. */
function decryptCbc(body: Uint8Array, key: Buffer, host: string): string {
  try {
    const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    d.setAutoPadding(false);
    let pt = Buffer.concat([d.update(body), d.final()]);
    const pad = pt[pt.length - 1] ?? 0;
    if (pad > 0 && pad <= 16) pt = pt.subarray(0, pt.length - pad);
    return stripHostHash(pt, host);
  } catch {
    return "";
  }
}

/** AES-256-GCM (Chromium on Windows, v10): 3-byte prefix, 12-byte nonce, ciphertext, 16-byte tag. */
function decryptGcm(enc: Uint8Array, key: Buffer, host: string): string {
  try {
    const nonce = enc.subarray(3, 15);
    const tag = enc.subarray(enc.length - 16);
    const body = enc.subarray(15, enc.length - 16);
    const d = createDecipheriv("aes-256-gcm", key, nonce);
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(body), d.final()]);
    return stripHostHash(pt, host);
  } catch {
    return "";
  }
}

/** Chrome ≥130 prepends the 32-byte SHA-256 of the cookie's host to the plaintext; drop it when present. */
function stripHostHash(pt: Buffer, host: string): string {
  if (pt.length >= 32) {
    const expected = createHash("sha256").update(host).digest();
    if (pt.subarray(0, 32).equals(expected)) return pt.subarray(32).toString("utf8");
  }
  return pt.toString("utf8");
}

/** The Safe Storage password: the OS keychain on macOS/Linux, else undefined (fixed keys handled by the caller). */
function chromiumPassword(browser: string): string | undefined {
  const service = `${keychainName(browser)} Safe Storage`;
  try {
    if (OS === "darwin") return execFileSync("security", ["find-generic-password", "-wa", keychainName(browser), "-s", service], { encoding: "utf8" }).trim();
    if (OS === "linux") {
      for (const attrs of [["application", browser.toLowerCase()], ["application", "chrome"], ["application", "chromium"]]) {
        try {
          const v = execFileSync("secret-tool", ["lookup", ...attrs], { encoding: "utf8" });
          if (v) return v;
        } catch {
          /* try the next attribute set */
        }
      }
    }
  } catch {
    /* no keychain entry; the caller falls back where it can */
  }
  return undefined;
}

function keychainName(browser: string): string {
  return browser === "Chrome" ? "Chrome" : browser === "Edge" ? "Microsoft Edge" : browser;
}

/** Windows: the AES key is DPAPI-wrapped in Local State; unwrapping needs a native call we do not ship. */
function windowsKey(_browser: string): Buffer | null {
  return null;
}
