import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const CORPUS = join(ROOT, "harness/probes/corpus-gate.txt");
const JUDGE = join(ROOT, "harness/probes/GATE_JUDGE.md");

// Lanes + counts are validated against the corpus's OWN declared header
// (`# Lanes: anchor (125) ...` / `# Total: 1025`) so this contract does not go
// stale every time the corpus is expanded (it grew 58 -> 1025 probes, 6 -> 7
// lanes, 3-col -> 6-col; the old hard-pinned counts broke it).
const LANES = ["anchor", "semantic-rank", "graphql", "ssr-list", "auth-gated", "auth-cookies", "hostile"] as const;

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

// Expected lanes + counts come from the corpus's own header so the contract
// follows the corpus instead of going stale on every expansion.
function declaredFromHeader(raw: string): { lanes: Record<string, number>; total: number } {
  const lines = raw.split("\n");
  const lanesLine = lines.find((l) => l.startsWith("# Lanes:")) ?? "";
  const lanes: Record<string, number> = {};
  for (const m of lanesLine.matchAll(/([a-z][a-z-]*)\s*\((\d+)\)/g)) lanes[m[1]] = Number(m[2]);
  const total = Number((lines.find((l) => l.startsWith("# Total:")) ?? "").match(/# Total:\s*(\d+)/)?.[1] ?? "0");
  return { lanes, total };
}

function parseCorpus(): { lane: string; intent: string; url: string }[] {
  const raw = readFileSync(CORPUS, "utf8");
  const rows: { lane: string; intent: string; url: string }[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // 6-col: lane | auth | difficulty | strategy | intent | contextUrl
    const parts = trimmed.split("|").map((p) => p.trim());
    if (parts.length !== 6) throw new Error(`malformed row: ${line}`);
    rows.push({ lane: parts[0], intent: parts[4], url: parts[5] });
  }
  return rows;
}

describe("corpus-gate.txt — release-gate bench corpus contract", () => {
  const declared = declaredFromHeader(readFileSync(CORPUS, "utf8"));

  it("exists at harness/probes/corpus-gate.txt", () => {
    expect(existsSync(CORPUS)).toBe(true);
  });

  it("parses to exactly the header-declared probe count", () => {
    expect(declared.total).toBeGreaterThan(0);
    expect(parseCorpus()).toHaveLength(declared.total);
  });

  it("only uses the declared lanes", () => {
    for (const row of parseCorpus()) {
      expect(LANES).toContain(row.lane as (typeof LANES)[number]);
    }
  });

  it("matches the header-declared per-lane counts", () => {
    const counts: Record<string, number> = {};
    for (const row of parseCorpus()) counts[row.lane] = (counts[row.lane] ?? 0) + 1;
    expect(counts).toEqual(declared.lanes);
  });

  it("has https URLs only (no http or ftp)", () => {
    for (const row of parseCorpus()) expect(row.url.startsWith("https://")).toBe(true);
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
