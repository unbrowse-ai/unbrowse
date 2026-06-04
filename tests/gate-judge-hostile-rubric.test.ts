// FALSIFIER for the hostile-lane rubric clarification in GATE_JUDGE.md.
//
// Pre-fix: the rubric said "hostile-lane PASS → emit `suspicious: true`
// so the release comment surfaces it." This worked when our hostile-lane
// bypasses were rare and the bench was paranoid about false positives.
// platform is now reliable at evading anti-bot on Ticketmaster/Nike/
// Target/ESPN; flagging every clean hostile PASS as suspicious caused
// the 4 confident wins to count against us in `new_suspicious_hostile`.
//
// Post-fix: clean hostile PASS with concrete quotable data is just PASS.
// `suspicious: true` fires only when bypass is ambiguous — four
// enumerated trip-wires (partial data + challenge artefacts, masked
// fields, wrong-entity, mid-array truncation).
//
// Structural test: read GATE_JUDGE.md and verify the rubric carries
// the new semantics. The release-comment generator (bench-gate-compare)
// keys off these labels; if the rubric quietly reverts, hostile PASSes
// resume being yellow-flagged.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const judgeMd = readFileSync(
  join(import.meta.dir, "..", "harness", "probes", "GATE_JUDGE.md"),
  "utf8",
);

describe("GATE_JUDGE.md hostile-lane rubric (post-2026-05-19)", () => {
  test("rubric says clean hostile PASS is NOT suspicious", () => {
    // The exact phrasing changes are fine; the semantic must be: a
    // hostile-lane PASS with concrete data is not automatically
    // suspicious.
    const hostileBullet = extractBullet(judgeMd, "`hostile`");
    expect(hostileBullet).toBeTruthy();
    expect(hostileBullet.toLowerCase()).toMatch(
      /successful bypass|clean pass|suspicious:\s*false|reliable bypass/,
    );
    expect(hostileBullet.toLowerCase()).not.toMatch(
      /if somehow the response contains real data, emit `\*_pass` with\s*`suspicious: true`/,
    );
  });

  test("rubric enumerates the trip-wires for suspicious=true", () => {
    // The four ambiguous-bypass conditions; we don't pin the prose,
    // just the count (1./2./3./4. enumeration) and the keywords.
    const suspiciousSection = extractSection(judgeMd, "suspicious");
    expect(suspiciousSection.match(/\b1\.\s/)).toBeTruthy();
    expect(suspiciousSection.match(/\b2\.\s/)).toBeTruthy();
    expect(suspiciousSection.match(/\b3\.\s/)).toBeTruthy();
    expect(suspiciousSection.match(/\b4\.\s/)).toBeTruthy();
    // Mentions at least three of the four ambiguity kinds.
    const kinds = [/challenge|cloudflare|datadome|perimeterx|akamai/i, /mask|null|hidden|\*\*\*/i, /wrong-entity|a8|contexturl/i, /truncat|mid-array|mid-object/i];
    const hits = kinds.filter((k) => k.test(suspiciousSection)).length;
    expect(hits).toBeGreaterThanOrEqual(3);
  });

  test("rubric retains the `suspicious` boolean contract for the emit_verdict tool", () => {
    expect(judgeMd).toMatch(/"suspicious":\s*false/);
    expect(judgeMd).toMatch(/`suspicious`/);
  });
});

function extractBullet(src: string, anchor: string): string {
  // Find the bullet form, not the first inline mention.
  const start = src.indexOf(`- ${anchor}`);
  if (start === -1) return "";
  const tailStart = start + anchor.length + 2;
  const nextBullet = src.indexOf("\n- `", tailStart);
  const nextSection = src.indexOf("\n## ", tailStart);
  const stops = [nextBullet, nextSection].filter((i) => i > 0);
  const end = stops.length > 0 ? Math.min(...stops) : src.length;
  return src.slice(start, end);
}

function extractSection(src: string, _keyword: string): string {
  // The trip-wires live inside the hostile bullet body.
  return extractBullet(src, "`hostile`");
}
