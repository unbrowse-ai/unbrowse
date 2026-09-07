/**
 * Witnesses the on-domain web-answer selection (the web-fallback fabrication fix).
 *
 * The bug: when a specific site was requested but exa/DDG found NO on-domain hit, the resolver
 * presented a rich OFF-domain article as THE answer (exa_answer:true) — e.g. bmo.com →
 * docs.nex.ai. The fix: return null for a domain-anchored query with no on-domain hit, so the
 * caller emits exa_answer:false (honest: off-domain candidates only). The rich fallback survives
 * ONLY for generic (no-domain) intents.
 */
import { describe, it, expect } from "bun:test";
import { pickAnswerHit } from "../src/orchestrator/answer-hit.js";

const onDom = { url: "https://stripe.com/docs/api", highlights: ["short"] };
const offRich = { url: "https://medium.com/rest-api-design", highlights: ["x".repeat(200)] };
const offThin = { url: "https://example.org/foo", highlights: ["y"] };

describe("pickAnswerHit", () => {
  it("prefers an on-domain hit over a richer off-domain one", () => {
    expect(pickAnswerHit([offRich, onDom], "stripe.com")?.url).toBe(onDom.url);
  });

  it("returns null for a domain-anchored query with NO on-domain hit (no fabrication)", () => {
    // The fix: a rich off-domain article is NOT presented as the answer for a specific site.
    expect(pickAnswerHit([offRich, offThin], "stripe.com")).toBeNull();
  });

  it("matches brand-family domains (chimebank ↔ chime)", () => {
    const chime = { url: "https://chime.com/help", highlights: ["short"] };
    expect(pickAnswerHit([offRich, chime], "chimebank.com")?.url).toBe(chime.url);
  });

  it("keeps the rich fallback for a GENERIC intent (no domain anchor)", () => {
    expect(pickAnswerHit([offThin, offRich], null)?.url).toBe(offRich.url);
    expect(pickAnswerHit([offThin, offRich], "")?.url).toBe(offRich.url);
  });

  it("returns null when nothing qualifies", () => {
    expect(pickAnswerHit([], "stripe.com")).toBeNull();
    expect(pickAnswerHit([offThin], null)).toBeNull(); // no rich hit, generic intent
  });
});
