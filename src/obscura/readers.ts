/**
 * Chrome-free eval READERS on obscura's CLI.
 *
 * unbrowse's stateless eval reads — `eval text` / `eval markdown` / `eval
 * cookies` / links / html — drive a live page over CDP today. They are
 * single-page reads, so the obscura CLI's `fetch --dump <kind>` covers them with
 * no Chrome and no CDP: obscura renders with its own V8, then dumps the rendered
 * text / markdown / links / cookie jar / html. This module is the thin, testable
 * bridge; the handlers select it via obscuraBackendSelected().
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  firstExisting,
  obscuraVendorCandidatePaths,
} from "./resolve-bin.js";

export type DumpKind = "text" | "markdown" | "links" | "cookies" | "html" | "original";

/** Locate the obscura CLI, or null if none installed. */
export function resolveObscuraCli(opts?: {
  execDir?: string;
  moduleDir?: string;
  env?: Record<string, string | undefined>;
}): string | null {
  const candidates = obscuraVendorCandidatePaths({
    bin: "obscura",
    execDir: opts?.execDir ?? dirname(process.execPath),
    moduleDir: opts?.moduleDir ?? import.meta.dirname,
    env: opts?.env,
  });
  return firstExisting(candidates.slice(0, -1), existsSync) ?? candidates[candidates.length - 1] ?? null;
}

export interface ObscuraDumpOptions {
  /** Extra wait after settle (obscura --wait, seconds). */
  waitSeconds?: number;
  /** Wait-until lifecycle level. */
  waitUntil?: "domcontentloaded" | "load" | "networkidle2" | "networkidle0";
  /** Turn on stealth TLS fingerprinting (requires a stealth binary). */
  stealth?: boolean;
  /** Overall spawn timeout (ms). */
  timeoutMs?: number;
  /** Explicit obscura CLI path (else resolved). */
  binPath?: string;
}

/** Build the obscura CLI argv for a dump — pure, so it is unit-testable. */
export function buildDumpArgs(url: string, kind: DumpKind, opts: ObscuraDumpOptions = {}): string[] {
  const args = ["fetch", url, "--dump", kind, "--quiet"];
  if (opts.waitUntil) args.push("--wait-until", opts.waitUntil);
  if (typeof opts.waitSeconds === "number") args.push("--wait", String(opts.waitSeconds));
  if (opts.stealth) args.push("--stealth");
  return args;
}

/** Render `url` with obscura and return the requested dump as text (no Chrome). */
export function obscuraDump(url: string, kind: DumpKind, opts: ObscuraDumpOptions = {}): Promise<string> {
  const bin = opts.binPath ?? resolveObscuraCli();
  if (!bin) {
    return Promise.reject(new Error("obscura CLI not found (set UNBROWSE_OBSCURA_BIN)"));
  }
  const args = buildDumpArgs(url, kind, opts);
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: opts.timeoutMs ?? 60000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

export interface ObscuraCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expires?: number | null;
}

/** Parse `--dump cookies` output (a JSON array) into a typed jar. Pure. */
export function parseCookieDump(stdout: string): ObscuraCookie[] {
  const t = stdout.trim();
  if (!t) return [];
  try {
    const arr = JSON.parse(t);
    return Array.isArray(arr) ? (arr as ObscuraCookie[]) : [];
  } catch {
    return [];
  }
}

export async function obscuraText(url: string, opts?: ObscuraDumpOptions): Promise<string> {
  return (await obscuraDump(url, "text", opts)).trimEnd();
}

export async function obscuraMarkdown(url: string, opts?: ObscuraDumpOptions): Promise<string> {
  return (await obscuraDump(url, "markdown", opts)).trimEnd();
}

/** The cookie jar the page holds after rendering, incl. HttpOnly session tokens. */
export async function obscuraCookies(url: string, opts?: ObscuraDumpOptions): Promise<ObscuraCookie[]> {
  return parseCookieDump(await obscuraDump(url, "cookies", opts));
}
