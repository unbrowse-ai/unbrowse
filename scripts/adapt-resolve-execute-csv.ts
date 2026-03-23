#!/usr/bin/env bun

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type DetailRow = {
  scenario_id: string;
  class: string;
  url: string;
  mutation_expected: string;
  resolve_exit_code: string;
  resolve_latency_sec: string;
  resolve_error: string;
  skill_id: string;
  endpoint_id: string;
  execute_attempted: string;
  execute_exit_code: string;
  execute_latency_sec: string;
  execute_error: string;
  chain_success: string;
  resolve_stdout_sample: string;
  execute_stdout_sample: string;
};

type SummaryRow = {
  total_scenarios: string;
  resolve_ok_count: string;
  resolve_ok_pct: string;
  execute_attempted_count: string;
  execute_attempted_pct: string;
  execute_ok_count: string;
  execute_ok_pct: string;
  chain_success_count: string;
  chain_success_pct: string;
};

type AdaptedCase = {
  id: string;
  intent: string;
  url: string;
  expected_fields: string[];
  validate: {
    min_rows: number;
    terminal_ok: ["pass"];
    retrieval: {
      max_rank: number;
      any_of: [{ endpoint_id: string }];
    };
    selection: {
      any_of: [{ endpoint_id: string }];
    };
  };
  source: {
    scenario_id: string;
    class: string;
    mutation_expected: boolean;
    observed_skill_id: string;
    observed_endpoint_id: string;
    resolve_latency_sec: number;
    execute_latency_sec: number;
    adapted_from: string;
  };
};

type KnownGap = {
  id: string;
  intent: string;
  url: string;
  expected_fields: string[];
  expected_terminal: ["fail", "blocked"];
  source: {
    scenario_id: string;
    class: string;
    mutation_expected: boolean;
    observed_skill_id: string;
    observed_endpoint_id: string;
    resolve_error: string;
    execute_error: string;
    adapted_from: string;
  };
};

type AdaptedCorpus = {
  meta: {
    name: string;
    description: string;
    generated_at: string;
    source: {
      details_path: string;
      summary_path: string;
    };
    source_summary: {
      total_scenarios: number;
      resolve_ok_count: number;
      resolve_ok_pct: number;
      execute_attempted_count: number;
      execute_attempted_pct: number;
      execute_ok_count: number;
      execute_ok_pct: number;
      chain_success_count: number;
      chain_success_pct: number;
    };
    adaptation_notes: string[];
    counts: {
      runnable_cases: number;
      known_gaps: number;
      total_rows: number;
    };
  };
  cases: AdaptedCase[];
  known_gaps: KnownGap[];
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const DEFAULT_DETAILS = join(ROOT, "evals", "resolve_execute_details.csv");
const DEFAULT_SUMMARY = join(ROOT, "evals", "resolve_execute_summary.csv");
const DEFAULT_OUT = join(ROOT, "evals", "codex-cases.resolve-execute-adapted.json");

const GENERIC_KEYS = new Set([
  "trace",
  "trace_id",
  "skill_id",
  "endpoint_id",
  "success",
  "status_code",
  "trace_version",
  "started_at",
  "completed_at",
  "result",
  "error",
  "doc",
]);

const KEY_PRIORITY = [
  "title",
  "name",
  "headline",
  "subject",
  "sender",
  "preview",
  "url",
  "link",
  "href",
  "web_url",
  "description",
  "summary",
  "image",
  "version",
  "author",
  "score",
  "permalink",
  "id",
  "uid",
  "type",
];

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    const next = text[index + 1];
    if (ch === "\"") {
      if (inQuotes && next === "\"") {
        field += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }
    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") index += 1;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [headerRow, ...bodyRows] = rows.filter((entry) => entry.length > 0 && !(entry.length === 1 && entry[0] === ""));
  const headers = headerRow ?? [];
  return bodyRows.map((cells) =>
    Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""])),
  );
}

function toNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function inferIntent(row: DetailRow): string {
  const host = hostname(row.url);
  if (row.mutation_expected === "yes") {
    if (host.includes("ryanair")) return "start booking flow";
    if (host.includes("trainline")) return "start ticket booking flow";
    if (host.includes("booking")) return "start hotel booking flow";
    if (host.includes("seetickets") || host.includes("axs")) return "start ticket purchase flow";
    if (host.includes("gymshark") || host.includes("bluebottlecoffee")) return "start purchase flow";
  }
  if (host.includes("irs") || host.includes("uscis") || host.includes("ssa")) return "get homepage links";
  if (host.includes("mychart")) return "get homepage cards";
  if (host.includes("instructure") || host.includes("blackboard")) return "get homepage resources";
  if (host.includes("aljazeera") || host.includes("npr") || host.includes("asahi") || host.includes("faz") || host.includes("globo")) {
    return "get homepage headlines";
  }
  if (host.includes("marketwatch")) return "get market news";
  if (host.includes("seetickets") || host.includes("dice")) return "get homepage events";
  if (host.includes("gymshark") || host.includes("bluebottlecoffee")) return "get homepage products";
  return "get homepage content";
}

function extractFieldCandidates(text: string): string[] {
  const found = new Set<string>();
  const regex = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g;
  for (const match of text.matchAll(regex)) {
    const key = match[1]!;
    if (GENERIC_KEYS.has(key)) continue;
    found.add(key);
  }
  const ordered = KEY_PRIORITY.filter((key) => found.has(key));
  const unknown = [...found].filter((key) => !KEY_PRIORITY.includes(key)).sort();
  return [...ordered, ...unknown];
}

function fallbackFields(row: DetailRow): string[] {
  const host = hostname(row.url);
  if (host.includes("mychart")) return ["title", "url", "image"];
  if (host.includes("blackboard")) return ["title", "url", "image"];
  if (host.includes("dice")) return ["id", "uid", "href"];
  if (host.includes("marketwatch")) return ["title", "url"];
  if (host.includes("seetickets")) return ["title", "url"];
  if (row.class === "legacy_cms" || row.class === "international_site" || row.class === "gov_portal") return ["title", "url"];
  if (row.class === "education_platform" || row.class === "healthcare_portal") return ["title", "url", "image"];
  return ["title", "url"];
}

function inferExpectedFields(row: DetailRow): string[] {
  const candidates = extractFieldCandidates(`${row.resolve_stdout_sample}\n${row.execute_stdout_sample}`);
  const preferred = candidates.slice(0, 4);
  return preferred.length > 0 ? preferred : fallbackFields(row);
}

function buildCaseId(row: DetailRow): string {
  return `${row.scenario_id.toLowerCase()}-${slugify(hostname(row.url))}`;
}

function adaptSuccessfulRow(row: DetailRow, detailsPath: string): AdaptedCase {
  return {
    id: buildCaseId(row),
    intent: inferIntent(row),
    url: row.url,
    expected_fields: inferExpectedFields(row),
    validate: {
      min_rows: 1,
      terminal_ok: ["pass"],
      retrieval: {
        max_rank: 5,
        any_of: [{ endpoint_id: row.endpoint_id }],
      },
      selection: {
        any_of: [{ endpoint_id: row.endpoint_id }],
      },
    },
    source: {
      scenario_id: row.scenario_id,
      class: row.class,
      mutation_expected: row.mutation_expected === "yes",
      observed_skill_id: row.skill_id,
      observed_endpoint_id: row.endpoint_id,
      resolve_latency_sec: toNumber(row.resolve_latency_sec),
      execute_latency_sec: toNumber(row.execute_latency_sec),
      adapted_from: detailsPath,
    },
  };
}

function adaptKnownGap(row: DetailRow, detailsPath: string): KnownGap {
  return {
    id: buildCaseId(row),
    intent: inferIntent(row),
    url: row.url,
    expected_fields: inferExpectedFields(row),
    expected_terminal: ["fail", "blocked"],
    source: {
      scenario_id: row.scenario_id,
      class: row.class,
      mutation_expected: row.mutation_expected === "yes",
      observed_skill_id: row.skill_id,
      observed_endpoint_id: row.endpoint_id,
      resolve_error: row.resolve_error,
      execute_error: row.execute_error,
      adapted_from: detailsPath,
    },
  };
}

export function adaptResolveExecuteCsv(detailsPath = DEFAULT_DETAILS, summaryPath = DEFAULT_SUMMARY): AdaptedCorpus {
  const generatedAt = new Date(Math.max(
    statSync(detailsPath).mtimeMs,
    statSync(summaryPath).mtimeMs,
  )).toISOString();
  const detailRows = parseCsv(readFileSync(detailsPath, "utf-8")) as DetailRow[];
  const summaryRows = parseCsv(readFileSync(summaryPath, "utf-8")) as SummaryRow[];
  const summary = summaryRows[0] ?? {
    total_scenarios: String(detailRows.length),
    resolve_ok_count: "0",
    resolve_ok_pct: "0",
    execute_attempted_count: "0",
    execute_attempted_pct: "0",
    execute_ok_count: "0",
    execute_ok_pct: "0",
    chain_success_count: "0",
    chain_success_pct: "0",
  };

  const successfulRows = detailRows.filter((row) => row.chain_success === "yes" && row.endpoint_id && row.endpoint_id !== "browser-capture");
  const knownGapRows = detailRows.filter((row) => !(row.chain_success === "yes" && row.endpoint_id && row.endpoint_id !== "browser-capture"));

  const cases = successfulRows.map((row) => adaptSuccessfulRow(row, detailsPath));
  const knownGaps = knownGapRows.map((row) => adaptKnownGap(row, detailsPath));

  return {
    meta: {
      name: "Resolve-Execute Adapted Corpus",
      description: "Adapted from historical resolve/execute telemetry. Uses observed endpoint_ids as retrieval/selection truth and infers intents/expected_fields heuristically from scenario class, host, and stdout samples.",
      generated_at: generatedAt,
      source: {
        details_path: detailsPath,
        summary_path: summaryPath,
      },
      source_summary: {
        total_scenarios: toNumber(summary.total_scenarios),
        resolve_ok_count: toNumber(summary.resolve_ok_count),
        resolve_ok_pct: toNumber(summary.resolve_ok_pct),
        execute_attempted_count: toNumber(summary.execute_attempted_count),
        execute_attempted_pct: toNumber(summary.execute_attempted_pct),
        execute_ok_count: toNumber(summary.execute_ok_count),
        execute_ok_pct: toNumber(summary.execute_ok_pct),
        chain_success_count: toNumber(summary.chain_success_count),
        chain_success_pct: toNumber(summary.chain_success_pct),
      },
      adaptation_notes: [
        "Successful rows become runnable harness cases with terminal_ok=pass.",
        "Retrieval and selection truth are adapted from observed endpoint_id values in the CSV, because shortlist URLs are not present in the source telemetry.",
        "Intent strings and expected_fields are inferred heuristically from host/class metadata and stdout samples; review before promoting to canonical eval:core.",
        "Rows that ended in browser-capture/no_endpoints or other chain failures are preserved under known_gaps instead of being silently dropped.",
      ],
      counts: {
        runnable_cases: cases.length,
        known_gaps: knownGaps.length,
        total_rows: detailRows.length,
      },
    },
    cases,
    known_gaps: knownGaps,
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function getArg(flag: string): string {
  const argv = process.argv.slice(typeof process.argv[1] === "string" && process.argv[1].startsWith("--") ? 1 : 2);
  return argv.find((_, index) => argv[index - 1] === `--${flag}`) ?? "";
}

function hasFlag(flag: string): boolean {
  const argv = process.argv.slice(typeof process.argv[1] === "string" && process.argv[1].startsWith("--") ? 1 : 2);
  return argv.includes(`--${flag}`);
}

if (import.meta.main) {
  const detailsPath = resolve(getArg("details") || DEFAULT_DETAILS);
  const summaryPath = resolve(getArg("summary") || DEFAULT_SUMMARY);
  const outPath = resolve(getArg("out") || DEFAULT_OUT);
  const corpus = adaptResolveExecuteCsv(detailsPath, summaryPath);
  const next = stableStringify(corpus);
  if (hasFlag("check")) {
    const current = readFileSync(outPath, "utf-8");
    if (current !== next) {
      console.error(`[adapt-resolve-execute-csv] out of date: ${outPath}`);
      process.exit(1);
    }
    console.log(`[adapt-resolve-execute-csv] up to date: ${outPath}`);
    process.exit(0);
  }
  writeFileSync(outPath, next, "utf-8");
  console.log(
    `[adapt-resolve-execute-csv] wrote ${outPath} ` +
    `(cases=${corpus.meta.counts.runnable_cases} known_gaps=${corpus.meta.counts.known_gaps})`,
  );
}
