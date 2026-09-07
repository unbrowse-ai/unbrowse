/**
 * Auth injection for the obscura browser backend.
 *
 * unbrowse already rips authenticated cookies out of the user's OTHER real
 * browsers (Chrome/Chromium/Firefox, incl. Flatpak/Snap, os_crypt-decrypted) in
 * src/auth/browser-cookies.ts. Historically those cookies were pushed into a
 * live Chrome tab over CDP `Network.setCookie`. With Chrome gone, we instead
 * write them as an obscura cookie jar (`cookies.json` in a `--storage-dir`),
 * which obscura loads on startup and sends on every matching request.
 *
 * The single subtlety — proven by a live round-trip against obscura's own jar
 * writer — is that obscura's on-disk format is camelCase (`httpOnly`,
 * `sameSite`) and its SameSite is title-cased to exactly {Strict, None, Lax};
 * a snake_case key is silently dropped by the loader. This module is the one
 * place that mapping lives, so no caller can get it subtly wrong.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserCookie } from "./browser-cookies.js";

/** obscura's on-disk cookie shape (crates/obscura-net/src/cookies.rs serde). */
export interface ObscuraCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Strict" | "None" | "Lax";
  /** epoch SECONDS, or null for a session cookie. */
  expires: number | null;
}

/**
 * Normalize any SameSite spelling to obscura's set. obscura (RFC 6265bis)
 * accepts strict/none and falls everything else back to Lax; we mirror that and
 * also translate Chrome's `no_restriction`/`unspecified` decodings.
 */
export function normalizeSameSite(v: string | undefined | null): "Strict" | "None" | "Lax" {
  switch (String(v ?? "").trim().toLowerCase()) {
    case "strict":
      return "Strict";
    case "none":
    case "no_restriction":
      return "None";
    default:
      return "Lax";
  }
}

/**
 * Coerce an expiry into obscura's epoch-seconds|null. A non-positive expiry is a
 * session cookie (null). Values that are clearly milliseconds (> ~year 33658 in
 * seconds) are divided down, so a jar that stored ms survives the round-trip.
 */
export function normalizeExpires(expires: number | undefined | null): number | null {
  const n = Number(expires ?? 0);
  if (!Number.isFinite(n) || n <= 0) return null;
  const secs = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  return secs;
}

/** Map unbrowse's BrowserCookie[] to obscura's camelCase jar entries. */
export function toObscuraCookies(cookies: BrowserCookie[]): ObscuraCookie[] {
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path && c.path.length > 0 ? c.path : "/",
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    sameSite: normalizeSameSite(c.sameSite),
    expires: normalizeExpires(c.expires),
  }));
}

/** Serialize obscura cookies to the exact JSON text obscura's loader reads. */
export function serializeObscuraJar(cookies: BrowserCookie[]): string {
  return JSON.stringify(toObscuraCookies(cookies), null, 2);
}

/**
 * Write a `cookies.json` into `storageDir` (created if missing) and return the
 * paths. Pass `storageDir` to the sidecar as `--storage-dir` (or `--cookies
 * <file>`); obscura sends the jar on every matching request — auth injected,
 * no Chrome, no CDP.
 */
export function writeObscuraJar(
  storageDir: string,
  cookies: BrowserCookie[],
): { storageDir: string; cookiesFile: string; count: number } {
  mkdirSync(storageDir, { recursive: true });
  const cookiesFile = join(storageDir, "cookies.json");
  const obscuraCookies = toObscuraCookies(cookies);
  writeFileSync(cookiesFile, JSON.stringify(obscuraCookies, null, 2), { mode: 0o600 });
  return { storageDir, cookiesFile, count: obscuraCookies.length };
}
