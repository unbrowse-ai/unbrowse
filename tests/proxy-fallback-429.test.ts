/**
 * Opt-in paid proxy fallback on HTTP 429 — Wave 2 failing-test specs.
 *
 * Source: meta-harness plan add-an-opt-in-paid-residential-proxy-fallback-fo.
 * All assertions fail today; Wave 3 lands the executeEndpoint branch that
 * emits the new decision_trace steps and dispatches via bun's per-request
 * proxy option to IProyal.
 *
 * Target choice: httpbin.org (we own the 429 deterministically, the
 * dispatcher assertion uses /ip to compare egress IP). NEVER mock fetch
 * — CLAUDE.md "tests must hit real endpoints, real files, real functions".
 *
 * Live-proxy mutation-test gate (per memory feedback_xfail_mutation_test):
 *   When un-skipped with IPROYAL creds set, the live test MUST fail under
 *   today's HEAD because executeEndpoint does not emit
 *   "429_proxy_fallback_attempted" yet. Skipping is honest absence of
 *   creds, not a painted lamp.
 */
import { describe, expect, it } from "bun:test";
import { executeEndpoint } from "../src/execution/index.js";
import type { SkillManifest, EndpointDescriptor } from "../src/types/skill.js";

const LIVE_PROXY =
  process.env.UNBROWSE_LIVE_PROXY_TEST === "1" &&
  Boolean(process.env.IPROYAL_USER) &&
  Boolean(process.env.IPROYAL_PASS);

function endpoint(url: string): EndpointDescriptor {
  return {
    endpoint_id: "ep-httpbin",
    method: "GET",
    url_template: url,
    description: "httpbin probe",
    idempotency: "safe",
    verification_status: "verified",
    reliability_score: 0.9,
  } as EndpointDescriptor;
}

function skill(domain: string): SkillManifest {
  return {
    skill_id: "skill-httpbin",
    version: "1.0.0",
    schema_version: "1",
    name: "httpbin probe",
    intent_signature: domain,
    domain,
    description: "httpbin proxy-fallback probe",
    owner_type: "marketplace",
    execution_type: "http",
    endpoints: [endpoint(`https://${domain}/status/429`)],
    lifecycle: "active",
    base_price_usd: 0,
  } as SkillManifest;
}

function traceSteps(res: { trace?: { decision_trace?: Array<{ step: string }> } }): string[] {
  return (res.trace?.decision_trace ?? []).map((s) => s.step);
}

describe("429 paid proxy fallback — consent gate (Wave 3 currently failing)", () => {
  it("emits 429_proxy_fallback_consent_missing + next_step on 429 with no opt-in", async () => {
    const s = skill("httpbin.org");
    const ep = endpoint("https://httpbin.org/status/429");
    const res = await executeEndpoint(s, ep, {}, undefined, {
      contextUrl: "https://httpbin.org/status/429",
    });
    const steps = traceSteps(res);
    expect(steps).toContain("429_proxy_fallback_consent_missing");
    const data = (res as { result?: { next_step?: { kind?: string } } }).result;
    expect(data?.next_step?.kind).toBe("paid_proxy_fallback_offer");
  });

  it("offers a concrete suggested_command in next_step (no one-word errors)", async () => {
    const s = skill("httpbin.org");
    const ep = endpoint("https://httpbin.org/status/429");
    const res = await executeEndpoint(s, ep, {}, undefined, {
      contextUrl: "https://httpbin.org/status/429",
    });
    const data = (res as {
      result?: { next_step?: { suggested_command?: string; estimated_cost_usd?: number } };
    }).result;
    expect(typeof data?.next_step?.suggested_command).toBe("string");
    expect(data?.next_step?.suggested_command).toMatch(/paid.proxy/i);
    expect(data?.next_step?.estimated_cost_usd).toBeCloseTo(0.01, 4);
  });
});

const live = LIVE_PROXY ? describe : describe.skip;
live("429 paid proxy fallback — live IProyal dispatch (mutation-test gate)", () => {
  it("attempts proxy retry on 429 when consent flag is set", async () => {
    const s = skill("httpbin.org");
    const ep = endpoint("https://httpbin.org/status/429");
    const res = await executeEndpoint(s, ep, {}, undefined, {
      contextUrl: "https://httpbin.org/status/429",
      paid_proxy_fallback: true,
    } as unknown as Parameters<typeof executeEndpoint>[4]);
    const steps = traceSteps(res);
    expect(steps).toContain("429_proxy_fallback_attempted");
    // httpbin 429 is unconditional so the retry stays 429 — that's still
    // an honest signal: the proxy was dispatched and we did not bill.
    expect(steps).toContain("429_proxy_fallback_no_unblock");
    expect(steps).not.toContain("429_proxy_fallback_billed");
  });

  it("egress IP changes when proxy is engaged on a non-429 target", async () => {
    const ipUrl = "https://httpbin.org/ip";
    const s = skill("httpbin.org");
    const ep = endpoint(ipUrl);

    const direct = await executeEndpoint(s, ep, {}, undefined, {
      contextUrl: ipUrl,
    });
    const directIp = ((direct as { result?: { origin?: string } }).result?.origin ?? "")
      .split(",")[0]
      .trim();

    const proxied = await executeEndpoint(s, ep, {}, undefined, {
      contextUrl: ipUrl,
      paid_proxy_fallback: true,
      __forceProxy: true,
    } as unknown as Parameters<typeof executeEndpoint>[4]);
    const proxiedIp = ((proxied as { result?: { origin?: string } }).result?.origin ?? "")
      .split(",")[0]
      .trim();

    expect(directIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(proxiedIp).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(proxiedIp).not.toBe(directIp);
    expect(traceSteps(proxied)).toContain("429_proxy_fallback_attempted");
    expect(traceSteps(proxied)).toContain("429_proxy_fallback_success");
    expect(traceSteps(proxied)).toContain("429_proxy_fallback_billed");
  });
});
