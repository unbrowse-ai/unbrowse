/**
 * Local capability registry — stage C of organ ddff0c96.
 *
 * The thin client's job is to execute capability-bound steps the cloud
 * cannot run remotely. This module declares the universe of those
 * capabilities and the dispatcher interface that every local transport
 * (MCP, CLI, SDK) implements once.
 *
 * Per contract:50d0419e (pointers over payload): the cloud sends a
 * step-pointer naming the required capability + an opaque payload; the
 * local dispatcher invokes the matching capability with the payload and
 * returns the result. The cloud never receives raw credentials or
 * cookies — only the result of using them.
 *
 * The union is closed-set by design. A new capability surfaces as a new
 * union member here AND a new method on the dispatcher; cloud responses
 * naming a capability the local doesn't have surface a clean error
 * rather than silently degrading.
 */

/**
 * The full set of local-only capabilities unbrowse may need. Cloud
 * step responses name members of this union in `required_local_capabilities`.
 *
 * - `kuri`: spawn / drive the Kuri CDP broker binary (~/.unbrowse/bin/kuri).
 * - `cookies`: read Chrome/Firefox SQLite cookie stores for a domain.
 * - `vault`: read keychain / vault-stored credentials for a domain.
 * - `browser`: high-level browser-session ops (open/snap/click/eval/close)
 *              on a Kuri-managed tab. Composes `kuri` + `cookies`.
 * - `fs`: read or write a local file by absolute path. Used for
 *         capture artifacts the cloud needs to ingest.
 */
export type LocalCapability = "kuri" | "cookies" | "vault" | "browser" | "fs";

/** Catalogue of every member of the union — used for runtime
 *  introspection (`dispatcher.has(cap)`) and exhaustive switches. */
export const LOCAL_CAPABILITIES: readonly LocalCapability[] = [
  "kuri",
  "cookies",
  "vault",
  "browser",
  "fs",
] as const;

/**
 * The contract every local thin-client transport implements. A single
 * dispatcher serves both the MCP server and the CLI; the SDK builds
 * one too. The cloud thinks of the local as a uniform capability
 * surface — which transport drove the call is invisible above this
 * interface.
 *
 * `invoke` is intentionally untyped at the payload boundary because
 * the cloud carries the schema (every capability's payload shape is
 * declared cloud-side as part of the step plan). The thin client just
 * passes it through. Concrete dispatcher implementations narrow the
 * shape per-capability via runtime checks.
 */
export interface LocalCapabilityDispatcher {
  /** Returns true iff this dispatcher can serve the named capability. */
  has(capability: string): capability is LocalCapability;

  /** Run the capability with the cloud-supplied payload. The return
   *  value is round-tripped back to the cloud via /v1/contract/iterate's
   *  `local_result.body` field. Throws on capability failure; the thin
   *  client posts the error message back via `local_result.error`. */
  invoke(capability: string, payload: unknown): Promise<unknown>;
}

/**
 * Build a dispatcher from a map of capability handlers. Capabilities
 * not present in the map throw a clean error on invoke; capabilities
 * in the map are dispatched to their handler. The substrate principle:
 * the dispatcher never silently degrades — every cloud-named
 * capability either runs or surfaces a NotAvailable.
 *
 * Typical usage in the MCP server / CLI:
 *
 *   const dispatcher = createDispatcher({
 *     kuri:    async (p) => kuriClient.run(p),
 *     cookies: async (p) => cookieStore.readForDomain((p as any).domain),
 *     // …
 *   });
 *   const client = createThinClient({ dispatcher });
 */
export function createDispatcher(
  handlers: Partial<Record<LocalCapability, (payload: unknown) => Promise<unknown>>>,
): LocalCapabilityDispatcher {
  const has = (capability: string): capability is LocalCapability =>
    LOCAL_CAPABILITIES.includes(capability as LocalCapability) &&
    handlers[capability as LocalCapability] !== undefined;

  return {
    has,
    async invoke(capability: string, payload: unknown): Promise<unknown> {
      if (!LOCAL_CAPABILITIES.includes(capability as LocalCapability)) {
        throw new Error(
          `unknown local capability '${capability}' — not in LOCAL_CAPABILITIES (${LOCAL_CAPABILITIES.join(", ")}). Cloud-side step plan references a capability this client cannot serve.`,
        );
      }
      const handler = handlers[capability as LocalCapability];
      if (!handler) {
        throw new Error(
          `local capability '${capability}' is in the union but no handler registered for it on this transport. Wire it in the MCP/CLI/SDK bootstrap.`,
        );
      }
      return handler(payload);
    },
  };
}
