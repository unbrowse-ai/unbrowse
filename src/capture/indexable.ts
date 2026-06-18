/**
 * indexable — the ONE structural admission gate for passive indexing.
 *
 * A captured endpoint is worth indexing only if it is an externally-reachable,
 * real HTTP(S) endpoint — something another agent could actually replay. This
 * recognizes junk by SHAPE, not by a per-site denylist (generalize-never-hard-
 * filter): non-http schemes (chrome-error / about / data / blob / file / ws),
 * loopback + private + link-local hosts (localhost, 127.x, 10.x, 192.168.x,
 * 172.16-31.x, 169.254.x, ::1), and RFC-2606/6761 reserved domains
 * (example.com/.org/.net, *.test/.example/.invalid/.localhost/.local, .internal,
 * chrome's `chromewebdata` error pseudo-host). Adding a new junk case needs zero
 * new entries as long as it has one of these shapes.
 *
 * Evidence that motivated this: the local capture queue had 313 example.com + 41
 * chromewebdata captures, and a skill snapshot held `http://127.0.0.1:64322/...`
 * ephemeral-port endpoints — all non-replayable garbage that reached skill
 * artifacts because admission only ran at publish time and missed these shapes.
 */

export type IndexableReason =
  | "ok"
  | "no_host"
  | "bad_scheme"
  | "loopback_or_local"
  | "private_ip"
  | "reserved_domain";

const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost", "local"]);
const RESERVED_HOSTS = new Set(["chromewebdata", "example.com", "example.org", "example.net"]);

/** Why a URL is (not) indexable. "ok" ⇒ admit. Everything else ⇒ reject. */
export function indexableReason(rawUrl: string): IndexableReason {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return "no_host";
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") return "bad_scheme";

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (!host) return "no_host";

  if (RESERVED_HOSTS.has(host)) return "reserved_domain";

  // Loopback / unspecified / IPv6 localhost
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1") {
    return "loopback_or_local";
  }
  if (/^127\.\d/.test(host)) return "loopback_or_local";

  // RFC-1918 private + link-local IPv4, and IPv6 ULA/link-local
  if (
    /^10\.\d/.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^f[cd][0-9a-f]{2}:/.test(host) ||
    /^fe80:/.test(host)
  ) {
    return "private_ip";
  }

  // Reserved / non-public TLDs + corp-internal suffix
  const tld = host.includes(".") ? host.slice(host.lastIndexOf(".") + 1) : host;
  if (RESERVED_TLDS.has(tld) || host.endsWith(".internal")) return "reserved_domain";
  if (host.endsWith(".example.com") || host.endsWith(".example.org") || host.endsWith(".example.net")) {
    return "reserved_domain";
  }

  return "ok";
}

/** True ⇒ this URL is an externally-reachable real endpoint worth indexing. */
export function isIndexableUrl(rawUrl: string): boolean {
  return indexableReason(rawUrl) === "ok";
}

/** Domain-level gate for the capture spool (keys captures by bare domain/host). */
export function isIndexableDomain(domain: string): boolean {
  if (!domain || typeof domain !== "string") return false;
  return isIndexableUrl(`https://${domain.trim()}/`);
}
