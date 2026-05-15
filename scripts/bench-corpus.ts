#!/usr/bin/env bun
import fs from "node:fs";

const LANES = ["anchor", "semantic-rank", "graphql", "ssr-list", "auth-gated", "hostile"] as const;
const AUTHS = ["none", "optional", "required", "blocked"] as const;
const DIFFICULTIES = ["easy", "medium", "hard", "hostile"] as const;
const STRATEGIES = [
  "direct-api",
  "dom-artifact",
  "page-fetch",
  "structured-replay",
  "graphql",
  "ssr-list",
  "semantic-rank",
  "auth-handoff",
  "browser-block",
] as const;

type Probe = {
  line: number;
  raw: string;
  lane: string;
  auth?: string;
  difficulty?: string;
  strategy?: string;
  intent: string;
  url: string;
};

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

export function parseCorpus(raw: string): Probe[] {
  const probes: Probe[] = [];
  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const parts = line.split("|").map((part) => part.trim());
    if (parts.length >= 6) {
      probes.push({
        line: index + 1,
        raw: line,
        lane: parts[0]!,
        auth: parts[1],
        difficulty: parts[2],
        strategy: parts[3],
        intent: parts[4]!,
        url: parts.slice(5).join("|").trim(),
      });
      return;
    }
    if (parts.length >= 3) {
      probes.push({
        line: index + 1,
        raw: line,
        lane: parts[0]!,
        intent: parts[1]!,
        url: parts.slice(2).join("|").trim(),
      });
    }
  });
  return probes;
}

function validateProbe(probe: Probe): string[] {
  const errors: string[] = [];
  if (!LANES.includes(probe.lane as (typeof LANES)[number])) errors.push(`line ${probe.line}: invalid lane "${probe.lane}"`);
  if (probe.auth && !AUTHS.includes(probe.auth as (typeof AUTHS)[number])) errors.push(`line ${probe.line}: invalid auth "${probe.auth}"`);
  if (probe.difficulty && !DIFFICULTIES.includes(probe.difficulty as (typeof DIFFICULTIES)[number])) errors.push(`line ${probe.line}: invalid difficulty "${probe.difficulty}"`);
  if (probe.strategy && !STRATEGIES.includes(probe.strategy as (typeof STRATEGIES)[number])) errors.push(`line ${probe.line}: invalid strategy "${probe.strategy}"`);
  if (!probe.intent) errors.push(`line ${probe.line}: missing intent`);
  try {
    const parsed = new URL(probe.url);
    if (!/^https?:$/.test(parsed.protocol)) errors.push(`line ${probe.line}: url must be http(s)`);
  } catch {
    errors.push(`line ${probe.line}: invalid url "${probe.url}"`);
  }
  if (/\b(INDEX_|RETRIEVE_|PASS|FAIL)\b/.test(probe.raw)) {
    errors.push(`line ${probe.line}: corpus rows must not contain verdict words`);
  }
  return errors;
}

function validateCorpus(probes: Probe[]): string[] {
  const errors = probes.flatMap(validateProbe);
  const seen = new Map<string, number>();
  for (const probe of probes) {
    const key = `${probe.intent}\n${probe.url}`;
    const prior = seen.get(key);
    if (prior) errors.push(`line ${probe.line}: duplicate intent+url first seen on line ${prior}`);
    else seen.set(key, probe.line);
  }
  return errors;
}

function summarize(probes: Probe[]): Record<string, Record<string, number>> {
  const groups: Record<string, Record<string, number>> = {
    lane: {},
    auth: {},
    difficulty: {},
    strategy: {},
  };
  for (const probe of probes) {
    for (const [key, value] of Object.entries({
      lane: probe.lane,
      auth: probe.auth ?? "unspecified",
      difficulty: probe.difficulty ?? "unspecified",
      strategy: probe.strategy ?? "unspecified",
    })) {
      groups[key]![value] = (groups[key]![value] ?? 0) + 1;
    }
  }
  return groups;
}

function insertProbe(raw: string, row: string, lane: string): string {
  const lines = raw.endsWith("\n") ? raw.slice(0, -1).split(/\r?\n/) : raw.split(/\r?\n/);
  let insertAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${lane}\\s*\\|`).test(lines[i]!.trim())) insertAt = i + 1;
    else if (insertAt !== lines.length && /^[a-z-]+\s*\|/.test(lines[i]!.trim())) break;
  }
  lines.splice(insertAt, 0, row);
  return `${lines.join("\n")}\n`;
}

function usage(): never {
  console.error(`usage:
  bun scripts/bench-corpus.ts validate [--corpus harness/probes/corpus-gate.txt]
  bun scripts/bench-corpus.ts add --lane <lane> --auth <none|optional|required|blocked> --difficulty <easy|medium|hard|hostile> --strategy <strategy> --intent <text> --url <url> [--corpus path]`);
  process.exit(1);
}

const command = process.argv[2];
const flags = parseArgs(process.argv.slice(3));
const corpusPath = String(flags.corpus || "harness/probes/corpus-gate.txt");

if (!command || !["validate", "add"].includes(command)) usage();
const raw = fs.existsSync(corpusPath) ? fs.readFileSync(corpusPath, "utf8") : "";

if (command === "validate") {
  const probes = parseCorpus(raw);
  const errors = validateCorpus(probes);
  console.log(JSON.stringify({ ok: errors.length === 0, probes: probes.length, summary: summarize(probes), errors }, null, 2));
  process.exit(errors.length === 0 ? 0 : 2);
}

const lane = String(flags.lane || "");
const auth = String(flags.auth || "");
const difficulty = String(flags.difficulty || "");
const strategy = String(flags.strategy || "");
const intent = String(flags.intent || "");
const url = String(flags.url || "");
const candidate: Probe = {
  line: 0,
  raw: `${lane} | ${auth} | ${difficulty} | ${strategy} | ${intent} | ${url}`,
  lane,
  auth,
  difficulty,
  strategy,
  intent,
  url,
};
const existing = parseCorpus(raw);
const errors = [...validateProbe(candidate)];
if (existing.some((probe) => probe.intent === intent && probe.url === url)) {
  errors.push("duplicate intent+url already exists in corpus");
}
if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(2);
}
fs.writeFileSync(corpusPath, insertProbe(raw, candidate.raw, lane));
console.log(JSON.stringify({ ok: true, added: candidate.raw, corpus: corpusPath }, null, 2));
