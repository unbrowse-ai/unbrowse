import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CORPUS = join(ROOT, "harness/probes/corpus-gate.txt");
const JUDGE = join(ROOT, "harness/probes/GATE_JUDGE.md");

const LANES = ["anchor", "semantic-rank", "graphql", "ssr-list", "auth-gated", "hostile"] as const;
const LANE_COUNTS: Record<(typeof LANES)[number], number> = {
  anchor: 11,
  "semantic-rank": 8,
  graphql: 6,
  "ssr-list": 10,
  "auth-gated": 8,
  hostile: 15,
};
const TOTAL_PROBES = 58;

const INDEX_VERDICTS = [
  "INDEX_PASS",
  "INDEX_FAIL_NO_ENDPOINTS",
  "INDEX_FAIL_WRONG_SHAPE",
  "INDEX_EXCLUDED_BLOCKED",
  "INDEX_EXCLUDED_AUTH",
];
const RETRIEVE_VERDICTS = [
  "RETRIEVE_PASS",
  "RETRIEVE_FAIL_WRONG_ENTITY",
  "RETRIEVE_FAIL_EMPTY",
  "RETRIEVE_FAIL_WRONG_SHAPE",
  "RETRIEVE_FAIL_ERROR_BODY",
  "RETRIEVE_EXCLUDED_BLOCKED",
  "RETRIEVE_EXCLUDED_AUTH",
];

function parseCorpus(): { lane: string; intent: string; url: string }[] {
  const raw = readFileSync(CORPUS, "utf8");
  const rows: { lane: string; intent: string; url: string }[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split("|").map((p) => p.trim());
    if (parts.length !== 3) throw new Error(`malformed row: ${line}`);
    rows.push({ lane: parts[0], intent: parts[1], url: parts[2] });
  }
  return rows;
}

describe("corpus-gate.txt — release-gate bench corpus contract", () => {
  it("exists at harness/probes/corpus-gate.txt", () => {
    expect(existsSync(CORPUS)).toBe(true);
  });

  it(`parses to exactly ${TOTAL_PROBES} probes`, () => {
    expect(parseCorpus()).toHaveLength(TOTAL_PROBES);
  });

  it("only uses the six declared lanes", () => {
    for (const row of parseCorpus()) {
      expect(LANES).toContain(row.lane as (typeof LANES)[number]);
    }
  });

  it("matches the declared per-lane counts", () => {
    const counts: Record<string, number> = {};
    for (const row of parseCorpus()) {
      counts[row.lane] = (counts[row.lane] ?? 0) + 1;
    }
    expect(counts).toEqual(LANE_COUNTS);
  });

  it("has https URLs only (no http or ftp)", () => {
    for (const row of parseCorpus()) {
      expect(row.url.startsWith("https://")).toBe(true);
    }
  });

  it("has non-empty intent and URL per row", () => {
    for (const row of parseCorpus()) {
      expect(row.intent.length).toBeGreaterThan(3);
      expect(row.url.length).toBeGreaterThan(10);
    }
  });
});

describe("GATE_JUDGE.md — judge rubric contract", () => {
  it("exists at harness/probes/GATE_JUDGE.md", () => {
    expect(existsSync(JUDGE)).toBe(true);
  });

  it("references every declared INDEX verdict token", () => {
    const text = readFileSync(JUDGE, "utf8");
    for (const v of INDEX_VERDICTS) {
      expect(text).toContain(v);
    }
  });

  it("references every declared RETRIEVE verdict token", () => {
    const text = readFileSync(JUDGE, "utf8");
    for (const v of RETRIEVE_VERDICTS) {
      expect(text).toContain(v);
    }
  });

  it("requires a quote for RETRIEVE_PASS", () => {
    const text = readFileSync(JUDGE, "utf8");
    expect(text).toMatch(/RETRIEVE_PASS[^\n]*(?:MUST|quote|Quote)/);
  });

  it("declares the emit_verdict tool shape", () => {
    const text = readFileSync(JUDGE, "utf8");
    expect(text).toContain("emit_verdict");
    expect(text).toContain("evidence_quote");
    expect(text).toContain("suspicious");
  });

  it("excludes EXCLUDED_* from coverage denominator", () => {
    const text = readFileSync(JUDGE, "utf8");
    expect(text).toMatch(/EXCLUDED_\*/);
    expect(text).toMatch(/denominator/);
  });
});
