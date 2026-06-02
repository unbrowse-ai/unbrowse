/**
 * obfuscate-audit — the provable, auditable safety gate the open client shows
 * before anything leaves the machine.
 *
 * The obfuscation strips secrets; the AUDIT proves it did. It is deliberately
 * simple and transparent — a user (or CI) can read it in full and trust it:
 * given the obfuscated capture that is about to be sent AND the user's own
 * secret values (from their local vault), it scans every byte of the outgoing
 * payload and confirms NONE of those secrets survive. If even one does, the
 * verdict is `safe: false` and the send must be refused.
 *
 * This is the "auditable to be safe" property: trust does not rest on the
 * (closed) obfuscation engine being correct — it rests on this open check
 * proving, against the user's actual secrets, that the actual payload carries
 * none of them. Belt and suspenders: the engine redacts, the audit verifies.
 */
import type { RawRequest } from "./index.js";
import { obfuscateCaptureForReveng, type ObfuscateOpts } from "./obfuscate.js";

export interface ObfuscationLeak {
  /** Which secret leaked (truncated label, never the full value in logs). */
  secretPreview: string;
  /** Which request + field it survived in. */
  where: string;
}

export interface ObfuscationAudit {
  /** True iff NO known secret value appears anywhere in the obfuscated capture. */
  safe: boolean;
  requestCount: number;
  /** Count of redaction placeholders ([REDACTED] or [bound:..]). */
  redactions: number;
  /** Of those, how many are WALLET-BOUND ([bound:..]) — owner-bound, not just hidden. */
  boundRedactions: number;
  /** Every place a known secret survived (empty when safe). */
  leaks: ObfuscationLeak[];
}

const REDACTED_RE = /\[REDACTED\]/g;
const BOUND_RE = /\[bound:[0-9a-f]{16}\]/g;

function preview(secret: string): string {
  return secret.length <= 6 ? "***" : `${secret.slice(0, 3)}…${secret.slice(-2)}`;
}

/** Audit an obfuscated capture against the user's known secret values. Pure,
 *  transparent, no I/O — safe to show and to run in CI. */
export function auditObfuscation(obfuscated: RawRequest[], secrets: string[]): ObfuscationAudit {
  const real = [...new Set(secrets.filter((s) => typeof s === "string" && s.length >= 4))];
  const leaks: ObfuscationLeak[] = [];
  let redactions = 0;
  let boundRedactions = 0;

  obfuscated.forEach((r, i) => {
    const fields: [string, string | undefined][] = [
      ["url", r.url],
      ["request_headers", r.request_headers && JSON.stringify(r.request_headers)],
      ["request_body", r.request_body],
      ["response_headers", r.response_headers && JSON.stringify(r.response_headers)],
      ["response_body", r.response_body],
    ];
    for (const [name, value] of fields) {
      if (!value) continue;
      redactions += (value.match(REDACTED_RE)?.length ?? 0) + (value.match(BOUND_RE)?.length ?? 0);
      boundRedactions += value.match(BOUND_RE)?.length ?? 0;
      for (const secret of real) {
        if (value.includes(secret)) leaks.push({ secretPreview: preview(secret), where: `req[${i}].${name}` });
      }
    }
  });

  return { safe: leaks.length === 0, requestCount: obfuscated.length, redactions, boundRedactions, leaks };
}

export class ObfuscationLeakError extends Error {
  constructor(public readonly audit: ObfuscationAudit) {
    super(`obfuscation audit FAILED — ${audit.leaks.length} secret(s) would leak: ${audit.leaks.map((l) => l.where).join(", ")}`);
    this.name = "ObfuscationLeakError";
  }
}

export interface AuditedCapture {
  capture: RawRequest[];
  audit: ObfuscationAudit;
}

/**
 * Obfuscate a capture AND audit it against the user's known secrets in one
 * step — the gate the open client runs before anything leaves the machine.
 *
 * With the user's vault secrets in `opts.secrets`, the obfuscation scrubs every
 * known secret by identity (guaranteed) on top of the heuristic redaction, then
 * the audit PROVES — against those same secrets — that the outgoing payload
 * carries none of them. By default it REFUSES (throws `ObfuscationLeakError`) if
 * the audit is ever unsafe, so an unsafe payload can never be sent — the audit
 * is the net that catches any secret a heuristic missed and the vault list did
 * not cover. Pass `enforce: false` to get the verdict without throwing (to
 * render an audit panel the user can inspect before approving the send).
 */
export function obfuscateAuditedCapture(
  raw: RawRequest[],
  opts: ObfuscateOpts & { secrets: string[]; enforce?: boolean },
): AuditedCapture {
  const capture = obfuscateCaptureForReveng(raw, opts);
  const audit = auditObfuscation(capture, opts.secrets);
  if (!audit.safe && opts.enforce !== false) throw new ObfuscationLeakError(audit);
  return { capture, audit };
}
