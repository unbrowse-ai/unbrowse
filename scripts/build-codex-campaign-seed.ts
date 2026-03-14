#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

type CaseEntry = Record<string, unknown>;

const ROOT = join(dirname(new URL(import.meta.url).pathname), "..");
const OUT_PATH = resolve(ROOT, "evals", "codex-cases.bulk-seed.json");
const INPUTS = [
  "evals/codex-cases.product-success.json",
  "evals/codex-cases.stress.json",
  "evals/codex-cases.public.json",
  "evals/codex-cases.public-expansion.json",
  "evals/codex-cases.auth-popular.json",
];

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
}

function loadCases(path: string): CaseEntry[] {
  const raw = JSON.parse(readFileSync(resolve(ROOT, path), "utf-8"));
  if (Array.isArray(raw)) return raw.filter((entry): entry is CaseEntry => !!entry && typeof entry === "object");
  if (raw && typeof raw === "object" && Array.isArray((raw as { cases?: unknown[] }).cases)) {
    return (raw as { cases: unknown[] }).cases.filter((entry): entry is CaseEntry => !!entry && typeof entry === "object");
  }
  return [];
}

function caseKey(entry: CaseEntry): string {
  return `${entry.intent ?? ""}::${entry.url ?? ""}`;
}

const merged: CaseEntry[] = [];
const seen = new Set<string>();
for (const input of INPUTS) {
  for (const entry of loadCases(input)) {
    const key = caseKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
}

writeFileSync(OUT_PATH, JSON.stringify({
  generated_at: new Date().toISOString(),
  sources: INPUTS,
  cases: merged,
}, null, 2));

console.log(`[build-codex-campaign-seed] wrote ${merged.length} cases -> ${OUT_PATH}`);
