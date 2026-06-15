// src/runtime/principal-scope.ts
// Bind a cache/KV entry to the VERIFIED auth principal — the credential the request
// actually authenticated with — not a self-asserted client header.
//
// Why: caches that hold auth-derived data (resolved values, session yields like tokens
// or created-resource ids) must be partitioned per principal. A key of (domain,intent)
// alone, or a spoofable x-unbrowse-client-id with a global fallback, lets one caller's
// authenticated entry be replayed to another — a cross-tenant leak. principalScope() is
// the partition token: a short, stable, non-reversible digest of the credential.
//
// The scope is one-way (sha256) so the credential is never recoverable from a cache key
// on disk. An absent/empty credential maps to the shared "anon" scope (genuinely public,
// unauthenticated reads) — anon entries are only ever served to other anon callers.
import { createHash } from "node:crypto";

/** Stable per-credential partition token. Same credential → same scope; different
 *  credentials → different scopes; absent credential → the shared "anon" scope. */
export function principalScope(credential?: string | null): string {
  const c = (credential ?? "").trim();
  if (!c) return "anon";
  return "p" + createHash("sha256").update(c).digest("hex").slice(0, 16);
}

/** Fold a principal into an existing (resource) scope so a yield/cache namespace is
 *  partitioned by identity AND resource. Returns the original scope unchanged when no
 *  principal is supplied (backward-compatible: unbound callers behave exactly as before). */
export function bindPrincipalScope(
  scope: string | undefined,
  credential: string | undefined | null,
): string | undefined {
  if (credential === undefined) return scope; // not auth-bound (legacy/public path)
  const p = principalScope(credential);
  return scope ? `${p}/${scope}` : p;
}

/** The credential a data-bearing cache entry was DERIVED from — the target-site auth the
 *  agent presented. Returns a single stable string built from the auth headers (sorted, so
 *  header order can't fork the scope), or `undefined` when there are no auth headers (a
 *  genuinely public/unauthenticated fetch → the cache stays unbound, exactly as before).
 *  This is the principal that partitions resolution/yield caches: the same bytes that
 *  produced the cached value also gate who may read it back. */
export function credentialFromAuthHeaders(
  headers?: Record<string, string> | null,
): string | undefined {
  if (!headers) return undefined;
  const entries = Object.entries(headers)
    .filter(([k, v]) => typeof v === "string" && v.trim() !== "" && /authorization|cookie|api[-_]?key|token|x-.*-(key|token|auth)/i.test(k))
    .map(([k, v]) => `${k.toLowerCase()}=${v}`)
    .sort();
  return entries.length ? entries.join("\n") : undefined;
}
