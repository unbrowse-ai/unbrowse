/**
 * Broker-error extraction — backend-agnostic.
 *
 * This lived in `src/kuri/client.ts` as `getKuriErrorMessage`, which made the
 * server session registry import 2,543 lines of kuri to do something that has
 * nothing to do with kuri: pull a human message out of an unknown broker reply.
 * The shapes it understands (`.error`, `.message`, `.result.error`,
 * `.result.message`) are the shapes ANY of our brokers answer with — kuri,
 * obscura, or whatever replaces them.
 *
 * Moving it here is what makes `src/api/browse-session.ts` import no kuri at
 * all, which is a precondition for kuri becoming deletable rather than merely
 * unused.
 */

/**
 * The error message carried by a broker reply, or null when the value is a bare
 * string (the caller already has the message) or carries no error at all.
 */
export function extractBrokerErrorMessage(value: unknown): string | null {
  if (typeof value === "string") return null;
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (typeof record.message === "string") return record.message;
  if (record.result && typeof record.result === "object") {
    const nested = record.result as Record<string, unknown>;
    if (typeof nested.error === "string") return nested.error;
    if (typeof nested.message === "string") return nested.message;
  }
  return null;
}
