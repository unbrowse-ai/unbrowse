/**
 * Scrub adapter stderr before it touches the parent log surface.
 *
 * 1Password (`op`), Bitwarden (`bw`), and macOS `security` are all known to
 * echo cleartext fragments in certain stderr branches (verbose flags,
 * unexpected exit paths). Even with the standard read flags
 * (`op read --no-newline`, `security -w`, `bw get password`) the safe
 * default is: drain stderr fully, run it through this filter, then
 * surface only the sanitized lines.
 *
 * Adapter-specific known-leak patterns this filter strips:
 *  - `op`: lines containing `password:`, `value:`, or what looks like a JSON
 *    item payload (`{ "fields": [ ... ] }`).
 *  - `bw`: literal item JSON, `"login":{"password":` substrings.
 *  - `security`: hex dumps emitted under `-g` (we never pass `-g`; defense
 *    in depth).
 *
 * Mt 6:6 — "shut thy door": stderr never leaves this filter intact.
 */

import type { Readable } from "node:stream";
import { type Scheme } from "./types.js";

// Generic patterns that look like cleartext echoes — apply to ALL adapters.
const GENERIC_LEAK_PATTERNS: readonly RegExp[] = [
  // "password: hunter2" / "password = hunter2"
  /password\s*[:=]\s*\S+/gi,
  // "password is 'hunter2'" / "password is hunter2" / "password 'hunter2'"
  /password(?:\s+is)?\s+['"][^'"]*['"]/gi,
  /password\s+is\s+\S+/gi,
  // "value: ..."
  /value\s*[:=]\s*\S+/gi,
  // "secret: ..."
  /secret\s*[:=]\s*\S+/gi,
  // "token: eyJ..." or "token = ..."
  /token\s*[:=]\s*\S+/gi,
  // "0x" hex dumps of length >= 16 (security -g style)
  /0x[0-9a-fA-F]{16,}/g,
];

const ADAPTER_LEAK_PATTERNS: Record<Scheme, readonly RegExp[]> = {
  // 1Password op stderr emits item JSON on certain failures.
  op: [
    /"fields"\s*:\s*\[[^\]]*\]/gi,
    /"value"\s*:\s*"[^"]*"/gi,
  ],
  // Bitwarden echoes item JSON if a piped get-item fails partway.
  bw: [
    /"login"\s*:\s*\{[^}]*\}/gi,
    /"password"\s*:\s*"[^"]*"/gi,
  ],
  // macOS keychain — defense in depth even though we never pass -g.
  keychain: [
    /password\s+for\s+[^\s]+\s+is:\s*\S+/gi,
  ],
  // arg adapter never spawns; pattern set is empty.
  arg: [],
};

const REDACTED = "[REDACTED]";

function scrubLine(line: string, adapter: Scheme): string {
  let out = line;
  for (const pat of GENERIC_LEAK_PATTERNS) {
    out = out.replace(pat, (m) => {
      // Preserve the label up to ':' or '=' if present; for "password is X"
      // patterns, preserve "password is" and redact only the value.
      const sep = /[:=]/.exec(m);
      if (sep && sep.index !== undefined) {
        return m.slice(0, sep.index + 1) + " " + REDACTED;
      }
      const isMatch = /^(password|token|value|secret)(?:\s+is)?/i.exec(m);
      if (isMatch) {
        return isMatch[0] + " " + REDACTED;
      }
      return REDACTED;
    });
  }
  for (const pat of ADAPTER_LEAK_PATTERNS[adapter] ?? []) {
    out = out.replace(pat, REDACTED);
  }
  return out;
}

/**
 * Collect a stderr stream to a string with all suspected secret echoes
 * removed. Returns the sanitized text. NEVER returns raw stderr.
 */
export async function filterAdapterStderr(
  stream: Readable,
  adapter: Scheme,
): Promise<string> {
  const chunks: string[] = [];
  return new Promise<string>((resolve, reject) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      chunks.push(chunk);
    });
    stream.on("end", () => {
      const raw = chunks.join("");
      resolve(scrubStderrString(raw, adapter));
    });
    stream.on("error", (err) => {
      // Even on error, return what we have, scrubbed. Never propagate raw.
      const raw = chunks.join("");
      // Surface the error reason but DON'T include the partial raw, since
      // an mid-stream read may have captured a partial leak.
      reject(
        new Error(
          `stderr stream errored after ${raw.length} bytes (scrubbed and discarded): ${(err as Error).message}`,
        ),
      );
    });
  });
}

/**
 * Synchronous variant for callers that already have stderr as a string
 * (e.g. spawnSync). Same scrubbing rules.
 */
export function scrubStderrString(text: string, adapter: Scheme): string {
  if (typeof text !== "string" || text.length === 0) return "";
  // Apply per-line so a single matching line doesn't blank the whole stream.
  return text
    .split(/\r?\n/)
    .map((line) => scrubLine(line, adapter))
    .join("\n");
}
