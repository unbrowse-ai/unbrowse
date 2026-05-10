import { Hono } from "hono";
import type { Env } from "../types.js";

const app = new Hono<{ Bindings: Env }>();

/**
 * Parse a Cookie header and return the value of `name` or null.
 *
 * Tradeoffs:
 *  - Case-sensitive on the cookie name. Real CF/PX always lowercase their
 *    cookie names in Set-Cookie, so a case-insensitive match would only
 *    serve to mask test corpora that don't reflect production.
 *  - Tokenizes on `;` so embedded `=` in cookie values can't masquerade as
 *    a separate cookie (defeats `something=cf_clearance=ok` smuggling).
 *  - Exact-match on value: `cf_clearance=okfoo` MUST NOT count as armed.
 *  - When a name appears twice, returns the FIRST occurrence (RFC 6265 §5.4
 *    leaves order to the UA; browsers send most-specific first).
 *  - Empty value (`_pxhd=`) returns "" — caller decides if that counts.
 *    Real PX/CF tokens are non-empty, so we treat "" as not-armed.
 */
function parseCookieValue(cookie: string, name: string): string | null {
  for (const raw of cookie.split(";")) {
    const trimmed = raw.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq);
    if (key === name) return trimmed.slice(eq + 1);
  }
  return null;
}

/**
 * Plan-v15 Tier 3: synthetic CF challenge fixture for CI bench.
 * Returns 403 with CF-shaped body when no cf_clearance cookie present;
 * 200 with success body when cookie is armed. Lets bench prove the
 * vendor_blocked_cf_solver_retry_success step actually fires end-to-end.
 */
app.get("/_synthetic_cf_challenge", (c) => {
  const cookie = c.req.header("cookie") || "";
  if (parseCookieValue(cookie, "cf_clearance") === "ok") {
    return c.json({ status: "synthetic_cf_pass", items: ["a", "b"] }, 200);
  }
  // CF-shaped 403 body with bundle path matching extractCfBundleUrl regex
  const body = `<!doctype html><html><head><title>Just a moment...</title></head><body>
<script src="/cdn-cgi/challenge-platform/h/g/scripts/jsd/feedface00deadbeef/main.js"></script>
</body></html>`;
  return c.text(body, 403);
});

/**
 * Plan-v15 Tier 3: synthetic PX challenge fixture.
 * Returns 403 with PX-shaped body when no _pxhd+_px3 cookies present;
 * 200 when both cookies armed.
 */
app.get("/_synthetic_px_challenge", (c) => {
  const cookie = c.req.header("cookie") || "";
  if (
    parseCookieValue(cookie, "_pxhd") === "ok" &&
    parseCookieValue(cookie, "_px3") === "ok"
  ) {
    return c.json({ status: "synthetic_px_pass", items: ["a", "b"] }, 200);
  }
  const body = `<!doctype html><html><body>
<script src="/aaaaaaaa-bbbb-4cba-9bbb-eeeeeeeeeeee/aaaaaaaa-bbbb-4cba-9bbb-eeeeeeeeeeee/init.js"></script>
</body></html>`;
  return c.text(body, 403);
});

/**
 * Plan-v17 Tier 1: synthetic Akamai challenge fixture.
 * Returns 403 with Akamai-shaped body when no _abck cookie present;
 * 200 when cookie armed.
 */
app.get("/_synthetic_akamai_challenge", (c) => {
  const cookie = c.req.header("cookie") || "";
  if (parseCookieValue(cookie, "_abck") === "ok") {
    return c.json({ status: "synthetic_akamai_pass", items: ["a", "b"] }, 200);
  }
  const body = `<!doctype html><html><body>
<script src="/akam-abc123def456.js"></script>
</body></html>`;
  return c.text(body, 403);
});

// Step 5 (Creatures) — mock Akamai sensor bundle so synthetic e2e round-trip is runnable.
// Returns >1024 bytes of inert JS to satisfy bundle-size gate; sandbox replay would emit _abck via
// a real bundle's CDP behavior, but for fixture-level testing the existence of the bundle is enough.
app.get("/akam-*", (c) => {
  const filler = "/* synthetic akamai sensor */ ".repeat(40); // ~1200 bytes
  const js = `${filler}\nvar _akamai_synthetic = true;\n`;
  return c.text(js, 200, { "content-type": "application/javascript" });
});

export { app as syntheticRoutes };
