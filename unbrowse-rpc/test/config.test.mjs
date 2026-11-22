// A gateway host answers from this Worker, not from the zone's catch-all route.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const configs = ["wrangler.jsonc", "wrangler.staging.jsonc"];
const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""));

// A zone's wildcard route (`*.zone/*`) answers before a custom domain does: seen 2026-11-18, rpc-staging.unbrowse.ai
// answered the catch-all's "Not found" until a route for the host itself was added.
test("every custom-domain host also has a zone route of its own, which beats the zone's catch-all", () => {
  for (const f of configs) {
    const routes = read(f).routes ?? [];
    const hosts = routes.filter((r) => r.custom_domain).map((r) => r.pattern);
    assert.ok(hosts.length, `${f} names no host`);
    for (const h of hosts) {
      const own = routes.find((r) => r.pattern === `${h}/*` && !r.custom_domain && (r.zone_name || r.zone_id));
      assert.ok(own, `${f}: ${h} has a custom domain but no zone route ${h}/*`);
    }
  }
});
