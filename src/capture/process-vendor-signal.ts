// Process-local antibot vendor signal (Day-6 W1, concern C).
//
// When the in-process API path hits its CLI timeout (38s default), the
// caller currently returns `{error:"cli_timeout"}` with no envelope —
// the agent has no way to know whether the timeout was a real product
// failure or an upstream antibot block that the agent could recover
// from by opening a browse session.
//
// Capture-side code that detects a vendor block (Cloudflare,
// PerimeterX, Datadome, Imperva, Akamai, etc.) calls
// `setLastVendorBlock(vendor, host)` on detection. The CLI's
// cli_timeout handler reads `getLastVendorBlock()` and, if a vendor
// was tagged within the timeout window, emits an envelope:
//   { status: "browse_session_open", browser_block_signals: ["vendor:cloudflare"],
//     next_step: "open_browse_session", suggested_commands: ["unbrowse go <url>"] }
// instead of the bare cli_timeout error.
//
// No vendor signal → no fabrication: the bare cli_timeout error
// stands. This is honest data, not a heuristic verdict.

type VendorBlock = {
  vendor: string;
  host: string;
  detected_at: number; // epoch ms
};

let _last: VendorBlock | null = null;

export function setLastVendorBlock(vendor: string, host: string): void {
  _last = { vendor, host, detected_at: Date.now() };
}

/** Return the last vendor block recorded in the current process IF
 *  it happened within `windowMs` ago (default 60s). Returns null
 *  otherwise so a stale signal from a prior probe doesn't leak into
 *  an unrelated cli_timeout. */
export function getLastVendorBlock(windowMs = 60_000): VendorBlock | null {
  if (!_last) return null;
  if (Date.now() - _last.detected_at >= windowMs) return null;
  return _last;
}

export function clearLastVendorBlock(): void {
  _last = null;
}
