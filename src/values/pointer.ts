/**
 * Pointer URI parsing. v7 only accepts four schemes; anything else routes
 * through `arg://__inline__` at the CLI/MCP boundary (see VALUE_STORE_ADAPTERS
 * §arg-semantics). This module does NOT synthesize the inline path — that
 * happens one layer up so the receipt body carries the explicit pointer the
 * caller passed.
 *
 * Mt 6:6 — "but thou, when thou prayest, enter into thy closet": the parser
 * is the doorway; the cleartext lives in the closet (the adapter), never in
 * the receipt body.
 */

import { AdapterError, type Pointer, type Scheme } from "./types.js";

const SCHEMES: readonly Scheme[] = ["op", "keychain", "bw", "arg"] as const;

function isScheme(value: string): value is Scheme {
  return (SCHEMES as readonly string[]).includes(value);
}

// `<scheme>://<rest>` — RFC-3986-flavoured but tight: scheme is lowercase
// alpha + digits + [+-.], rest is at least one char. Anchored.
const POINTER_RE = /^([a-z][a-z0-9+\-.]*):\/\/(.+)$/;

/**
 * Parse a pointer URI. Throws AdapterError on malformed input.
 *
 * Examples:
 *  - parse("op://Personal/Twitter/username")
 *  - parse("keychain://com.unbrowse.session/lewis@unbrowse.ai")
 *  - parse("bw://9b1f-uuid/password")
 *  - parse("arg://payload/headers/Authorization")
 */
export function parse(uri: string): Pointer {
  if (typeof uri !== "string" || uri.length === 0) {
    throw new AdapterError("invalid_pointer", "pointer must be a non-empty string");
  }
  const m = POINTER_RE.exec(uri);
  if (!m) {
    throw new AdapterError(
      "invalid_pointer",
      `pointer does not match <scheme>://<path>: ${uri}`,
    );
  }
  const scheme = m[1];
  const path = m[2];
  if (!isScheme(scheme)) {
    throw new AdapterError(
      "unknown_scheme",
      `unknown scheme '${scheme}'; v7.0 supports: ${SCHEMES.join(", ")}`,
    );
  }
  if (path.length === 0) {
    throw new AdapterError("invalid_pointer", `pointer has empty path: ${uri}`);
  }
  return { scheme, path, raw: uri };
}

/**
 * Cheap check used at the CLI/MCP boundary to decide whether a user-supplied
 * `value` string is a pointer or a cleartext literal that should be wrapped
 * in `arg://__inline__`. Does NOT throw.
 */
export function looksLikePointer(value: string): boolean {
  if (typeof value !== "string") return false;
  const m = POINTER_RE.exec(value);
  if (!m) return false;
  return isScheme(m[1]);
}
