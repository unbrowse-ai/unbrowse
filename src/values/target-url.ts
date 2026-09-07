/**
 * target-url — validate the caller's `--url` ONCE, at the boundary.
 *
 * Principle: CLI arguments are not trusted input. They may come from a
 * hallucinating or prompt-injected agent, while the human/system defines the
 * bounded surface the agent may operate in. So the boundary rejects; internal
 * code then operates on a parsed, known-scheme URL.
 *
 * Measured on the CLI before this existed:
 *
 *   --url file:///etc/passwd   -> exit 0, success:true, source:direct-fetch,
 *                                 and the local file's CONTENTS in the payload
 *   --url javascript:alert(1)  -> hung until the 45s harness timeout (exit 124)
 *   --url ftp://x.com/a        -> hung until the 45s harness timeout (exit 124)
 *   --url not-a-url            -> exit 1, indistinguishable from a site failure
 *
 * The first is a local file read reachable from an agent-supplied string. The
 * middle two are unbounded recovery: an agent waits 45 seconds for a verdict
 * that is decidable in microseconds. The last denies a system any way to tell
 * "your input was malformed" from "the site was down" — different retries.
 *
 * The http/https restriction IS a hard allowlist, and deliberately so: it is a
 * true protocol constant plus a security boundary, which is the stated exception
 * to this repo's generalise-don't-enumerate rule. It is kept to exactly that —
 * no per-host, per-path, or per-vendor entries — so nothing else has to be added
 * here as new sites are supported.
 *
 * Pure: no I/O, no network, no clock. Exhaustively testable.
 */

/** Schemes the engine can actually fetch. Everything else is refused. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export type TargetUrlVerdict =
  | { ok: true; url: string; hostname: string }
  | { ok: false; code: TargetUrlError; message: string };

export type TargetUrlError =
  | "url_missing"
  | "url_unparseable"
  | "url_scheme_unsupported"
  | "url_host_missing";

/**
 * Validate a caller-supplied target URL.
 *
 * Returns a typed verdict rather than throwing, so the caller decides the exit
 * code and output shape. `code` is a stable snake_case token — the same contract
 * the orchestrator's other errors follow (auth_required, payment_required, …) —
 * so a system can route on it without parsing prose.
 */
export function validateTargetUrl(raw: unknown): TargetUrlVerdict {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, code: "url_missing", message: "a target URL is required" };
  }
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      code: "url_unparseable",
      message: `not a valid URL: ${trimmed} (did you mean https://${trimmed}?)`,
    };
  }
  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    return {
      ok: false,
      code: "url_scheme_unsupported",
      message:
        `unsupported scheme ${parsed.protocol}// — only http:// and https:// are fetched. ` +
        `Local and non-network schemes (file:, javascript:, data:, ftp:) are refused at the boundary.`,
    };
  }
  // `http:///path` parses, with an empty host. Fetching it is never meaningful.
  if (!parsed.hostname) {
    return { ok: false, code: "url_host_missing", message: `no host in URL: ${trimmed}` };
  }
  return { ok: true, url: parsed.toString(), hostname: parsed.hostname };
}
