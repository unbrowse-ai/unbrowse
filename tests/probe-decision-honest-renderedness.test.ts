// Truth-telling: decideFromProbe must not ASSERT "server-rendered" when
// its only evidence is byte_length. The probe is HEAD / GET-1byte — it
// never fetched the body, so it has zero evidence of server rendering.
// A JS-SPA shell (e.g. beatsaver.com/?q=camellia, 5514B React shell)
// trips the isHtml && bodyLarge branch and is labelled "server-rendered,
// fetch + extract", then server-fetch returns the shell {title,url} not
// the search results. The strategy choice (server-first, cheap) is
// defensible; the FALSE CLAIM in the reason string is not. Post-b622a279
// the drift path now honestly fails + emits re_capture_signal, so the
// only residual lie is this reason string the agent reads in
// decision_trace.
//
// Pure-function test over the exported decideFromProbe (the actual code
// path, no mocks) — same pattern as execution-drift-recapture-signal.

import { describe, test, expect } from "bun:test";
import { decideFromProbe } from "../src/execution/probe.ts";
import type { ProbeResult } from "../src/execution/probe.ts";

function htmlProbe(byte_length: number): ProbeResult {
  return {
    status: 200,
    content_type: "text/html; charset=utf-8",
    byte_length,
    ms: 50,
    method_used: "GET-1byte",
  };
}

describe("decideFromProbe renderedness honesty", () => {
  test("large HTML, no corroborating signal: server-first is fine but reason must NOT assert 'server-rendered'", () => {
    // beatsaver-shaped: 5514B text/html, no dom_extraction recipe, no
    // trigger_url. Probe never saw the body.
    const d = decideFromProbe({
      probe: htmlProbe(5514),
      has_trigger_url: false,
      intent_wants_dom: false,
      has_dom_extraction: false,
    });

    // Server-first is still the correct cheap default (genuine-SSR sites
    // are the majority; SPA recovery is handled by the post-drift
    // re_capture_signal path). We are not changing the strategy.
    expect(d.strategy).toBe("server");

    // The bug: the reason asserts "server-rendered" from byte_length
    // alone. The probe has zero rendering evidence. Remove the lie.
    expect(d.reason).not.toContain("server-rendered");

    // And state the honest basis instead (size threshold; renderedness
    // unverified from a range probe).
    expect(d.reason.toLowerCase()).toMatch(/unverified|renderedness/);
  });

  test("scoping guard: JSON probe is unchanged (genuinely declared signal)", () => {
    const d = decideFromProbe({
      probe: {
        status: 200,
        content_type: "application/json",
        byte_length: 9000,
        ms: 40,
        method_used: "HEAD",
      },
      has_trigger_url: false,
    });
    expect(d.strategy).toBe("server");
    expect(d.reason).toContain("direct fetchable");
  });

  test("scoping guard: small HTML SPA shell still routes to browser (unchanged)", () => {
    const d = decideFromProbe({
      probe: htmlProbe(800),
      has_trigger_url: false,
      has_dom_extraction: false,
    });
    expect(d.strategy).toBe("browser");
  });

  test("scoping guard: small HTML SPA shell with trigger_url still trigger-intercept (unchanged)", () => {
    const d = decideFromProbe({
      probe: htmlProbe(800),
      has_trigger_url: true,
      has_dom_extraction: false,
    });
    expect(d.strategy).toBe("trigger-intercept");
  });
});
