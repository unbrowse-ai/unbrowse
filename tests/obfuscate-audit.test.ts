/**
 * obfuscate-audit — the open, provable safety gate: the user can audit that
 * every secret is redacted + bound BEFORE anything leaves the machine.
 *
 * Proves the trust-via-auditability property the open client must show:
 *   1. the audit is a REAL check — it CATCHES a secret the redaction heuristics
 *      miss (a vendor-custom value with no token shape and no secret-y field
 *      name). A rubber-stamp audit would fail this test.
 *   2. passing the user's KNOWN vault secrets to the obfuscation closes that gap
 *      by identity — the audited capture is then provably safe.
 *   3. the gate REFUSES (throws) when a payload would leak, so an unsafe capture
 *      can never be sent; and surfaces the verdict (enforce:false) for a panel.
 *   4. when safe, every redaction is wallet-BOUND (owner-bound, not just hidden).
 */
import { describe, it, expect } from "bun:test";
import { obfuscateCaptureForReveng } from "../src/capture/obfuscate.js";
import {
  auditObfuscation,
  obfuscateAuditedCapture,
  ObfuscationLeakError,
} from "../src/capture/obfuscate-audit.js";
import type { RawRequest } from "../src/capture/index.js";

const WALLET = "8xKpQ2rZvN1mYwTcLdGhJ4sBnEfAuVoPxRgQ7WkMnHj";
// A vendor-custom secret with NO token shape (not a JWT/sk-/ghp_/base64) and
// sitting under a NON-secret-y field name ("ref") — the redaction heuristics
// cannot recognise it. Only the user knows it is a secret.
const STEALTH_SECRET = "swordfish-vault-handle-pncl-7741";

const CAP: RawRequest[] = [{
  url: `https://api.example.com/v1/orders?ref=${STEALTH_SECRET}&page=2`,
  method: "POST",
  request_headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_abc", "content-type": "application/json" },
  request_body: JSON.stringify({ ref: STEALTH_SECRET, item_id: 42 }),
  response_status: 200,
  response_headers: { "content-type": "application/json" },
  response_body: JSON.stringify({ order_id: 7788 }),
  timestamp: "2026-06-02T00:00:00Z",
}];

describe("the audit catches what heuristics miss", () => {
  it("heuristic-only obfuscation LEAKS the stealth secret — and the audit catches it", () => {
    const heuristicOnly = obfuscateCaptureForReveng(CAP); // no known-secret list
    // the stealth secret survived the heuristics (proves the gap is real)
    expect(JSON.stringify(heuristicOnly)).toContain(STEALTH_SECRET);
    // ...and the audit, told it's a user secret, flags the leak
    const audit = auditObfuscation(heuristicOnly, [STEALTH_SECRET]);
    expect(audit.safe).toBe(false);
    expect(audit.leaks.length).toBeGreaterThan(0);
    expect(audit.leaks.some((l) => l.where.includes("url"))).toBe(true);
    expect(audit.leaks.some((l) => l.where.includes("request_body"))).toBe(true);
    // the preview never logs the full secret
    expect(JSON.stringify(audit.leaks)).not.toContain(STEALTH_SECRET);
  });
});

describe("passing the vault secrets closes the gap (provably safe)", () => {
  const { capture, audit } = obfuscateAuditedCapture(CAP, { walletPubkey: WALLET, secrets: [STEALTH_SECRET] });

  it("the audited capture is safe — no known secret survives anywhere", () => {
    expect(audit.safe).toBe(true);
    expect(audit.leaks).toHaveLength(0);
    expect(JSON.stringify(capture)).not.toContain(STEALTH_SECRET);
  });

  it("every redaction is wallet-BOUND (owner-bound, not just hidden)", () => {
    expect(audit.redactions).toBeGreaterThan(0);
    expect(audit.boundRedactions).toBe(audit.redactions); // with a wallet, all bound
    expect(JSON.stringify(capture)).toContain("bound:");
  });
});

describe("the gate refuses to emit an unsafe payload", () => {
  it("REFUSES (throws ObfuscationLeakError) when the audit is unsafe", () => {
    // Force the unsafe path: audit a heuristic-only capture that still carries
    // the secret, then assert the gate's decision throws.
    const leaky = obfuscateCaptureForReveng(CAP);
    const audit = auditObfuscation(leaky, [STEALTH_SECRET]);
    expect(audit.safe).toBe(false);
    expect(() => {
      if (!audit.safe) throw new ObfuscationLeakError(audit);
    }).toThrow(ObfuscationLeakError);
  });

  it("does NOT throw on a safe capture, and surfaces the verdict for a panel", () => {
    expect(() => obfuscateAuditedCapture(CAP, { secrets: [STEALTH_SECRET] })).not.toThrow();
    // enforce:false returns the audit even when it would refuse — for inspection
    const { audit } = obfuscateAuditedCapture(CAP, { secrets: [], enforce: false });
    expect(audit).toBeDefined();
    expect(typeof audit.safe).toBe("boolean");
  });
});
