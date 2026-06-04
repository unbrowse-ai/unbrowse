/**
 * Regression test for the resolve no_match next_step gap.
 *
 * When unbrowse_resolve falls through to `status: "no_match"` AND the probe
 * proved the URL is server-fetchable (HTTP 200, text/html, body large enough
 * to carry real content), the next_step must surface `unbrowse fetch` as the
 * cheap path BEFORE `unbrowse capture`.
 *
 * Previously the next_step pointed straight at `unbrowse capture`, which
 * always opens a Kuri browser tab. That violates the project north-star
 * invariant: "browser-open is failure mode, not feature" (CLAUDE.md). The
 * agent ended up in a 2+ second browser handoff on SSR docs pages (MDN,
 * developer.mozilla.org/...) where libcurl-impersonate would have returned
 * the same HTML in 200ms.
 *
 * The fix is a pure helper: given the probe evidence, decide whether to
 * lead with `unbrowse fetch` (HTML page that already returned 200) or with
 * `unbrowse capture` (probe failed or content-type unclear). The helper is
 * called from both no_match branches in the orchestrator (probe-winner-no-
 * exa AND budget-deadline-no-probe).
 */

import { describe, expect, it } from "bun:test";
import { buildNoMatchNextStep } from "../src/orchestrator/no-match-next-step.js";

const URL_MDN = "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array";
const INTENT = "read Array reference page contents";

describe("buildNoMatchNextStep", () => {
  it("recommends unbrowse fetch when probe shows 200 + text/html + large body", () => {
    const ns = buildNoMatchNextStep({
      contextUrl: URL_MDN,
      intent: INTENT,
      probeEvidence: { status: 200, content_type: "text/html", byte_length: 30323 },
    });
    expect(ns.recommended).toBe("fetch");
    expect(ns.commands.fetch).toBeDefined();
    expect(ns.commands.fetch).toContain(URL_MDN);
    expect(ns.commands.fetch!.startsWith("unbrowse fetch")).toBe(true);
    expect(ns.commands.capture).toBeDefined();
    expect(ns.commands.capture).toContain(URL_MDN);
    expect(ns.commands.capture).toContain(INTENT);
    expect(ns.reason).toContain("200");
    expect(ns.reason).toContain("html");
  });

  it("recommends unbrowse capture when probe is missing entirely (budget-deadline path)", () => {
    const ns = buildNoMatchNextStep({
      contextUrl: URL_MDN,
      intent: INTENT,
      probeEvidence: undefined,
    });
    expect(ns.recommended).toBe("capture");
    expect(ns.commands.capture).toBeDefined();
    expect(ns.commands.capture).toContain(URL_MDN);
    expect(ns.commands.fetch).toBeUndefined();
  });

  it("recommends unbrowse capture when probe returned an error status", () => {
    const ns = buildNoMatchNextStep({
      contextUrl: URL_MDN,
      intent: INTENT,
      probeEvidence: { status: 0, content_type: undefined, byte_length: undefined },
    });
    expect(ns.recommended).toBe("capture");
    expect(ns.commands.fetch).toBeUndefined();
  });

  it("recommends unbrowse capture when content-type is not html/json (binary, video)", () => {
    const ns = buildNoMatchNextStep({
      contextUrl: "https://example.com/video.mp4",
      intent: "download video",
      probeEvidence: { status: 200, content_type: "video/mp4", byte_length: 1_000_000 },
    });
    expect(ns.recommended).toBe("capture");
    expect(ns.commands.fetch).toBeUndefined();
  });

  it("recommends unbrowse fetch on JSON probe (api endpoint)", () => {
    const ns = buildNoMatchNextStep({
      contextUrl: "https://api.example.com/v1/users",
      intent: "list users",
      probeEvidence: { status: 200, content_type: "application/json", byte_length: 4096 },
    });
    expect(ns.recommended).toBe("fetch");
    expect(ns.commands.fetch).toBeDefined();
    expect(ns.commands.fetch!.startsWith("unbrowse fetch")).toBe(true);
  });

  it("escapes special characters in URL and intent (shell safety)", () => {
    const ns = buildNoMatchNextStep({
      contextUrl: "https://example.com/path with space?q=hello world",
      intent: 'find "items" $now',
      probeEvidence: { status: 200, content_type: "text/html", byte_length: 20000 },
    });
    // JSON.stringify guarantees safe quoting for shell
    expect(ns.commands.capture).toContain('"https://example.com/path with space?q=hello world"');
    expect(ns.commands.capture).toContain('"find \\"items\\" $now"');
  });
});
