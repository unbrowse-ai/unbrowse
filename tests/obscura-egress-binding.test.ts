/**
 * GATE: a harvested session is only replayed from the IP that harvested it.
 *
 * Encodes a measured fact (bench/sites100/CHALLENGE-RATE-FINDINGS.md): a
 * Cloudflare cookie replayed from the capture IP is accepted; from a different
 * IP it is rejected and re-minted. The conservative half matters as much as the
 * strict half — an unresolved lookup must NOT invalidate a working session, or
 * every offline run breaks.
 */

import { test, expect, describe } from "bun:test";
import {
  compareEgress,
  egressAllowsReplay,
  egressBlockReason,
  resolveEgress,
  resetEgressCache,
  type EgressIdentity,
} from "../src/execution/egress-binding.js";

const at = (ip: string | null): EgressIdentity => ({ ip, observedAt: 1 });

describe("compareEgress", () => {
  test("same IP => match", () => {
    expect(compareEgress(at("1.2.3.4"), at("1.2.3.4"))).toBe("match");
  });
  test("different IP => mismatch", () => {
    expect(compareEgress(at("1.2.3.4"), at("5.6.7.8"))).toBe("mismatch");
  });
  test("IPv4 vs IPv6 is a mismatch (the case actually measured)", () => {
    expect(compareEgress(at("116.88.160.141"), at("2406:3003:2005:52d0::1"))).toBe("mismatch");
  });
  test("either side unknown => unknown, never mismatch", () => {
    expect(compareEgress(at(null), at("1.2.3.4"))).toBe("unknown");
    expect(compareEgress(at("1.2.3.4"), at(null))).toBe("unknown");
    expect(compareEgress(null, undefined)).toBe("unknown");
  });
});

describe("egressAllowsReplay", () => {
  test("blocks ONLY on a positive mismatch", () => {
    expect(egressAllowsReplay(at("1.2.3.4"), at("5.6.7.8"))).toBe(false);
    expect(egressAllowsReplay(at("1.2.3.4"), at("1.2.3.4"))).toBe(true);
  });
  test("an unresolved lookup still replays — offline runs must not break", () => {
    expect(egressAllowsReplay(at("1.2.3.4"), at(null))).toBe(true);
    expect(egressAllowsReplay(null, null)).toBe(true);
  });
});

describe("egressBlockReason", () => {
  test("null when replay is allowed", () => {
    expect(egressBlockReason(at("1.2.3.4"), at("1.2.3.4"))).toBeNull();
    expect(egressBlockReason(at("1.2.3.4"), at(null))).toBeNull();
  });
  test("names the failure and masks the addresses", () => {
    const why = egressBlockReason(at("116.88.160.141"), at("5.6.7.8"))!;
    expect(why).toContain("egress_mismatch");
    // the last octet must not be printed — enough to debug, not a full disclosure
    expect(why).toContain("116.88.160.x");
    expect(why).not.toContain("116.88.160.141");
    expect(why).toContain("5.6.7.x");
  });
});

describe("resolveEgress", () => {
  test("returns the address on success", async () => {
    resetEgressCache();
    const got = await resolveEgress({
      fetchImpl: (async () => ({ text: async () => "203.0.113.7\n" })) as unknown as typeof fetch,
      force: true,
    });
    expect(got.ip).toBe("203.0.113.7");
  });

  test("a captive-portal HTML body is REJECTED, not recorded as an IP", async () => {
    resetEgressCache();
    const got = await resolveEgress({
      fetchImpl: (async () => ({ text: async () => "<html>login required</html>" })) as unknown as typeof fetch,
      force: true,
    });
    expect(got.ip).toBeNull();
  });

  test("a network failure degrades to unknown, never throws", async () => {
    resetEgressCache();
    const got = await resolveEgress({
      fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
      force: true,
    });
    expect(got.ip).toBeNull();
    // and that unknown must not invalidate a session
    expect(egressAllowsReplay(at("1.2.3.4"), got)).toBe(true);
  });
});
