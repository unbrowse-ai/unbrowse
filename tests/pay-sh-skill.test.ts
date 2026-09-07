/**
 * Witness C (offline, deterministic) — pay.sh SKILL-LAYER support.
 *
 * Proves the skill-layer pieces of pay.sh support without touching the network:
 *   - PayProviderDescriptor attaches to an EndpointDescriptor (type + runtime).
 *   - describePayProvider() renders a resolve-time label with price/protocol.
 *   - payProviderFromObservation() derives a descriptor from a 402 observation.
 *   - payShDiscover() is default-OFF and returns parsed candidates only when the
 *     UNBROWSE_PAY_DISCOVERY flag is set (with `pay` stubbed via a PATH shim).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EndpointDescriptor, PayProviderDescriptor } from "../src/types/skill.js";
import {
  describePayProvider,
  payProviderFromObservation,
  payDiscoveryEnabled,
  payShDiscover,
} from "../src/skill/pay-provider.js";

const ORIG_PATH = process.env.PATH;
let shimDir = "";

const CATALOG_JSON = JSON.stringify([
  {
    service: "agentmail/email",
    title: "AgentMail",
    url: "https://x402.api.agentmail.to",
    endpoints: [
      {
        method: "GET",
        url: "https://x402.api.agentmail.to/v0/domains",
        path: "v0/domains",
        description: "List sender domains",
        resource: "subpackage_domains",
        metered: true,
      },
    ],
  },
]);

/** Stub `pay skills search <q> --json` to emit fixed catalog JSON. */
function installSkillsShim(json: string): string {
  const dir = mkdtempSync(join(tmpdir(), "payskills-"));
  const script = `#!/bin/sh
case "$1" in
  --version) echo "pay 0.0.0-test"; exit 0 ;;
esac
# pay skills search <q> --json -> print the fixture.
if [ "$1" = "skills" ] && [ "$2" = "search" ]; then
  cat <<'JSON'
${json}
JSON
  exit 0
fi
exit 0
`;
  const p = join(dir, "pay");
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return dir;
}

afterEach(() => {
  process.env.PATH = ORIG_PATH;
  delete process.env.UNBROWSE_PAY_DISCOVERY;
  if (shimDir) {
    try { rmSync(shimDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    shimDir = "";
  }
});

describe("PayProviderDescriptor on EndpointDescriptor", () => {
  test("attaches and round-trips through a manifest endpoint", () => {
    const provider: PayProviderDescriptor = {
      subdomain: "agentmail/email",
      gateway_url: "https://x402.api.agentmail.to",
      price_usd: 0.01,
      protocol: "x402",
      source: "catalog",
    };
    const ep: EndpointDescriptor = {
      endpoint_id: "ep1",
      method: "GET",
      url_template: "https://x402.api.agentmail.to/v0/domains",
      idempotency: "safe",
      verification_status: "verified",
      reliability_score: 90,
      pay_provider: provider,
    };
    expect(ep.pay_provider?.subdomain).toBe("agentmail/email");
    expect(ep.pay_provider?.price_usd).toBe(0.01);
    expect(JSON.parse(JSON.stringify(ep)).pay_provider.protocol).toBe("x402");
  });
});

describe("describePayProvider", () => {
  test("renders price, protocol, and subdomain", () => {
    const label = describePayProvider({
      subdomain: "agentmail/email",
      price_usd: 0.01,
      protocol: "x402",
    });
    expect(label).toContain("pay.sh-gated");
    expect(label).toContain("x402");
    expect(label).toContain("$0.01");
    expect(label).toContain("agentmail/email");
    expect(label).toContain("UNBROWSE_WALLET_ADAPTER=pay");
  });
  test("degrades gracefully with no metadata", () => {
    expect(describePayProvider({})).toContain("pay.sh-gated");
  });
});

describe("payProviderFromObservation", () => {
  test("reduces a full URL to a gateway origin and keeps amount/protocol", () => {
    const p = payProviderFromObservation({
      url: "https://gw.example.com/api/v1/reports/usage?x=1",
      amountUsd: 0.01,
      protocol: "mpp",
    });
    expect(p.gateway_url).toBe("https://gw.example.com");
    expect(p.price_usd).toBe(0.01);
    expect(p.protocol).toBe("mpp");
    expect(p.source).toBe("observed");
  });
});

describe("payShDiscover — flagged, default-off", () => {
  test("returns [] when UNBROWSE_PAY_DISCOVERY is unset", async () => {
    expect(payDiscoveryEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    const out = await payShDiscover("email", { env: {} as NodeJS.ProcessEnv });
    expect(out).toEqual([]);
  });

  test("returns parsed catalog candidates when flag is on", async () => {
    shimDir = installSkillsShim(CATALOG_JSON);
    const env = { ...process.env, PATH: `${shimDir}:${ORIG_PATH}`, UNBROWSE_PAY_DISCOVERY: "1" } as NodeJS.ProcessEnv;
    const out = await payShDiscover("email", { env });
    expect(out.length).toBe(1);
    expect(out[0].method).toBe("GET");
    expect(out[0].url).toBe("https://x402.api.agentmail.to/v0/domains");
    expect(out[0].provider.subdomain).toBe("agentmail/email");
    expect(out[0].provider.source).toBe("catalog");
  });

  test("empty query short-circuits to []", async () => {
    const out = await payShDiscover("  ", { env: { UNBROWSE_PAY_DISCOVERY: "1" } as NodeJS.ProcessEnv });
    expect(out).toEqual([]);
  });
});
