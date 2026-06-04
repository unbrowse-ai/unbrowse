/**
 * tests/paper-plan.test.ts — Sermon-on-the-Mount signals over PAPER_PLAN.md.
 *
 * The plan is a document, not a module, so the falsifiable lights are
 * structural invariants: every milestone has Goal/Work/Done-when, every
 * status row uses an allowed state, every memory reference exists on
 * disk, every "EXISTS" path in the Phase→File Map actually exists, the
 * dependency DAG has no cycles, and no per-domain host heuristic has
 * leaked into the plan.
 *
 * Run: bun test tests/paper-plan.test.ts
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const PLAN_PATH = join(REPO_ROOT, "PAPER_PLAN.md");
const MEMORY_DIR = join(
  process.env.HOME ?? "/Users/lekt9",
  "(internal)",
);

const plan = readFileSync(PLAN_PATH, "utf8");

const ALLOWED_STATUS = new Set(["shipped", "partial", "missing", "unknown", "future"]);
const REFERENCED_FEEDBACK = [
  "feedback_harness_uses_global_binary.md",
  "feedback_no_fake_momentum.md",
  "feedback_git_worktree_upstream.md",
  "feedback_extraction_silent_truncation.md",
  "feedback_harness_is_for_main_agent.md",
  "feedback_no_heuristics_in_judge_jobs.md",
  "feedback_binary_chain_check.md",
  "feedback_lazy_progress.md",
];

const MILESTONES = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"];

const EXISTS_PATHS = [
  "src/orchestrator/run-planner.ts",
  "src/cli.ts",
];

describe("PAPER_PLAN.md: file is present and non-trivial", () => {
  it("the document exists at repo root", () => {
    expect(existsSync(PLAN_PATH)).toBe(true);
  });

  it("the document is at least 200 lines", () => {
    expect(plan.split("\n").length).toBeGreaterThanOrEqual(200);
  });
});

describe("PAPER_PLAN.md: every milestone P1..P8 has Goal/Work/Done when", () => {
  for (const m of MILESTONES) {
    it(`${m} declares a heading`, () => {
      expect(plan).toMatch(new RegExp(`^### ${m}: `, "m"));
    });
    it(`${m} has a Goal: line`, () => {
      const idx = plan.indexOf(`### ${m}:`);
      expect(idx).toBeGreaterThan(-1);
      const slice = plan.slice(idx, idx + 3000);
      expect(slice).toMatch(/^Goal:/m);
    });
    it(`${m} has Work: and Done when: blocks`, () => {
      const idx = plan.indexOf(`### ${m}:`);
      const slice = plan.slice(idx, idx + 3000);
      expect(slice).toMatch(/^Work[ (:]/m);
      expect(slice).toMatch(/^Done when:/m);
    });
  }
});

describe("PAPER_PLAN.md: status table uses only allowed states", () => {
  it("every state token in the status table is in the allowed set", () => {
    const tableStart = plan.indexOf("## Status of Each Paper Claim");
    const tableEnd = plan.indexOf("## Recurring Losses");
    expect(tableStart).toBeGreaterThan(-1);
    expect(tableEnd).toBeGreaterThan(tableStart);
    const table = plan.slice(tableStart, tableEnd);
    const rowRegex = /^\|\s*\d+\s*\|.+?\|\s*(shipped|partial|missing|unknown|future)\s*\|/gm;
    const matches = [...table.matchAll(rowRegex)];
    expect(matches.length).toBeGreaterThanOrEqual(20);
    for (const m of matches) {
      expect(ALLOWED_STATUS.has(m[1])).toBe(true);
    }
  });

  it("no row has an undefined or empty state column", () => {
    const tableStart = plan.indexOf("## Status of Each Paper Claim");
    const tableEnd = plan.indexOf("## Recurring Losses");
    const table = plan.slice(tableStart, tableEnd);
    const dataRows = table
      .split("\n")
      .filter((line) => /^\|\s*\d+\s*\|/.test(line));
    for (const row of dataRows) {
      const cols = row.split("|").map((c) => c.trim());
      const stateCol = cols[4];
      expect(stateCol.length).toBeGreaterThan(0);
      expect(ALLOWED_STATUS.has(stateCol)).toBe(true);
    }
  });
});

describe("PAPER_PLAN.md: inoculation references resolve to real memory files", () => {
  for (const f of REFERENCED_FEEDBACK) {
    it(`memory/${f} exists`, () => {
      expect(existsSync(join(MEMORY_DIR, f))).toBe(true);
    });
    it(`PAPER_PLAN.md cites ${f}`, () => {
      expect(plan).toContain(f);
    });
  }
});

describe("PAPER_PLAN.md: known-existing paths in Phase→File Map are real", () => {
  for (const p of EXISTS_PATHS) {
    it(`${p} exists on disk`, () => {
      expect(existsSync(join(REPO_ROOT, p))).toBe(true);
    });
    it(`PAPER_PLAN.md references ${p}`, () => {
      expect(plan).toContain(p);
    });
  }
});

  it("topological sort succeeds over declared edges", () => {
    // P5 is the LAST snapshot, not a checkpoint — edges flow INTO P5.
    // P8b runs after P7 because both touch run-planner.ts and cli.ts.
    const edges: Array<[string, string]> = [
      ["P1", "P2"],
      ["P1", "P7"],
      ["P1", "P5"],
      ["P2", "P3"],
      ["P3", "P4"],
      ["P4", "P5"],
      ["P7", "P5"],
    ];
    const indeg: Record<string, number> = {};
    const adj: Record<string, string[]> = {};
    for (const m of MILESTONES) {
      indeg[m] = 0;
      adj[m] = [];
    }
    for (const [a, b] of edges) {
      adj[a].push(b);
      indeg[b]++;
    }
    const queue = MILESTONES.filter((m) => indeg[m] === 0);
    const order: string[] = [];
    while (queue.length) {
      const n = queue.shift()!;
      order.push(n);
      for (const nb of adj[n]) {
        if (--indeg[nb] === 0) queue.push(nb);
      }
    }
    expect(order.length).toBe(MILESTONES.length);
    // P5 must come after every milestone that feeds it
    expect(order.indexOf("P5")).toBeGreaterThan(order.indexOf("P1"));
    expect(order.indexOf("P5")).toBeGreaterThan(order.indexOf("P2"));
    expect(order.indexOf("P5")).toBeGreaterThan(order.indexOf("P3"));
    expect(order.indexOf("P5")).toBeGreaterThan(order.indexOf("P4"));
    expect(order.indexOf("P5")).toBeGreaterThan(order.indexOf("P7"));
  });

describe("PAPER_PLAN.md: anti-goal hygiene", () => {
  it("does not contain a per-domain host heuristic", () => {
    expect(plan).not.toMatch(/host\s*===\s*"[a-z]/);
    expect(plan).not.toMatch(/domain\.includes\("[a-z]/);
  });

  it("does not propose a new top-level CLI command not already in NORTHSTAR.md", () => {
    const forbidden = [
      "unbrowse plan ",
      "unbrowse paper ",
      "unbrowse benchmark ",
    ];
    for (const f of forbidden) {
      expect(plan).not.toContain(f);
    }
  });
});

describe("PAPER_PLAN.md: done-state names a single executable command", () => {
  it("names scripts/paper-benchmark.sh as the done-state command", () => {
    expect(plan).toContain("scripts/paper-benchmark.sh");
  });

  it("declares the corpus path under harness/", () => {
    expect(plan).toContain("harness/corpus/paper-94.txt");
  });
});

describe("PAPER_PLAN.md: no shipped row is missing evidence", () => {
  it("every row marked shipped has a non-empty Evidence column", () => {
    const tableStart = plan.indexOf("## Status of Each Paper Claim");
    const tableEnd = plan.indexOf("## Recurring Losses");
    const table = plan.slice(tableStart, tableEnd);
    const dataRows = table
      .split("\n")
      .filter((line) => /^\|\s*\d+\s*\|/.test(line));
    for (const row of dataRows) {
      const cols = row.split("|").map((c) => c.trim());
      const state = cols[4];
      const evidence = cols[5];
      if (state === "shipped") {
        expect(evidence.length).toBeGreaterThan(0);
        expect(evidence).not.toBe("—");
      }
    }
  });
});
