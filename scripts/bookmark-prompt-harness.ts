#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";

type InventoryRow = {
  has_cookie?: boolean;
  fresh_cookie?: boolean;
  visit_count?: number;
  last_visit_unix?: number;
  bookmarked?: boolean;
  likely_logged_in_score?: number;
};

export type AuthInventoryEnvelope = {
  ok?: boolean;
  sources_scanned?: string[];
  locked_sources?: string[];
  inventory?: Record<string, InventoryRow>;
};

export type PromptCase = {
  id: string;
  source_host: string;
  url: string;
  lane: string;
  auth: "public" | "auth-likely";
  difficulty: "easy" | "medium" | "hard";
  strategy: string;
  intent: string;
  command: ["read", "resolve"];
  tree: {
    plan: string;
    build: string;
    test: string;
    judge: string;
  };
  acceptance: string[];
};

export type PromptCliPlan = {
  case_id: string;
  argv: string[];
  dry_run: true;
  expected_contract: "CapabilityResult";
};

const FALLBACK_HOSTS: Record<string, InventoryRow> = {
  "github.com": { visit_count: 100, likely_logged_in_score: 0.2 },
  "support.mozilla.org": { bookmarked: true, likely_logged_in_score: 0.1 },
  "transitive-bs.notion.site": { bookmarked: true, likely_logged_in_score: 0.1 },
  "bolt.new": { bookmarked: true, likely_logged_in_score: 0.1 },
};

function repoRoot(): string {
  return resolve(import.meta.dir, "..");
}

function harnessCliCommand(): string[] {
  const raw = process.env.UNBROWSE_HARNESS_BIN || process.env.UNBROWSE_BIN || "unbrowse";
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : ["unbrowse"];
}

function runHarnessCli(args: string[]) {
  const [cmd, ...prefix] = harnessCliCommand();
  return spawnSync(cmd!, [...prefix, ...args], {
    cwd: repoRoot(),
    env: { ...process.env, UNBROWSE_NO_SWEEP: "1" },
    encoding: "utf8",
  });
}

function normalizeHost(host: string): string {
  let out = host.trim().toLowerCase();
  if (out.startsWith("www.")) out = out.slice(4);
  if (out.includes("/")) out = out.split("/")[0] ?? "";
  return out.replace(/[^a-z0-9.-]/g, "");
}

function caseId(host: string): string {
  return host.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function classify(host: string): Pick<PromptCase, "lane" | "difficulty" | "strategy" | "intent"> {
  if (host === "github.com" || host.endsWith(".github.com")) {
    return {
      lane: "code-repository",
      difficulty: "medium",
      strategy: "structured-replay",
      intent: "resolve the repository or issue data an agent would need for a code-change task",
    };
  }
  if (host.includes("notion.site")) {
    return {
      lane: "workspace-research",
      difficulty: "hard",
      strategy: "auth-handoff",
      intent: "resolve the workspace page into structured notes without leaking the private page path",
    };
  }
  if (host.startsWith("docs.") || host.includes("support.") || host.includes("mozilla.org")) {
    return {
      lane: "documentation-help",
      difficulty: "easy",
      strategy: "page-fetch",
      intent: "find the relevant documentation answer and return attributed support snippets",
    };
  }
  if (["fal.ai", "openrouter.ai", "api.together.ai", "tokenfactory.nebius.com"].includes(host)) {
    return {
      lane: "ai-service-console",
      difficulty: "medium",
      strategy: "auth-handoff",
      intent: "resolve account or API console data using the safest authenticated route available",
    };
  }
  if (["x.com", "linkedin.com", "mail.google.com", "docs.google.com"].includes(host)) {
    return {
      lane: "auth-workflow",
      difficulty: "hard",
      strategy: "auth-handoff",
      intent: "resolve the authenticated workflow surface and report the next required user action if auth is needed",
    };
  }
  if (host.includes("polymarket") || host.includes("straitsx") || host.includes("whop")) {
    return {
      lane: "market-account",
      difficulty: "hard",
      strategy: "structured-replay",
      intent: "resolve market or account state with explicit provenance and no mutation",
    };
  }
  return {
    lane: "web-research",
    difficulty: "medium",
    strategy: "semantic-rank",
    intent: "resolve the most useful structured data for an agent research task",
  };
}

export function derivePromptCases(
  inventory: Record<string, InventoryRow>,
  limit = 12,
): PromptCase[] {
  const entries = Object.entries(inventory)
    .map(([host, row]) => [normalizeHost(host), row] as const)
    .filter(([host]) => host.length > 0 && !host.includes(".."))
    .sort((a, b) => {
      const scoreDelta = (b[1].likely_logged_in_score ?? 0) - (a[1].likely_logged_in_score ?? 0);
      if (scoreDelta !== 0) return scoreDelta;
      return (b[1].visit_count ?? 0) - (a[1].visit_count ?? 0);
    })
    .slice(0, limit);

  return entries.map(([host, row]) => {
    const classified = classify(host);
    const auth: PromptCase["auth"] =
      row.fresh_cookie || (row.likely_logged_in_score ?? 0) >= 0.6 ? "auth-likely" : "public";
    const url = `https://${host}`;
    return {
      id: `dia-${caseId(host)}`,
      source_host: host,
      url,
      auth,
      ...classified,
      intent: `${classified.intent} for ${host}`,
      command: ["read", "resolve"],
      tree: {
        plan: `Select the cheapest compatible primitive for ${host}.`,
        build: "Run read resolve through the bridge manifest and preserve the CapabilityResult shape.",
        test: "Assert host-only provenance, structured data or next_action, and no path/query leakage.",
        judge: "Accept only if the result is useful to an agent and failures name the fallback requirement.",
      },
      acceptance: [
        "case URL is origin-only",
        "no bookmark or history path is present in the case",
        "command uses canonical read resolve",
        "result must return data, requirements, or next_action in the capability envelope",
      ],
    };
  });
}

export function renderCorpus(cases: PromptCase[]): string {
  return `${cases.map((c) => `${c.intent}|${c.url}`).join("\n")}\n`;
}

export function buildCliPlan(cases: PromptCase[], cliCommand = harnessCliCommand()): PromptCliPlan[] {
  return cases.map((c) => ({
    case_id: c.id,
    argv: [...cliCommand, ...c.command, "--intent", c.intent, "--url", c.url, "--json"],
    dry_run: true,
    expected_contract: "CapabilityResult",
  }));
}

export function validatePromptCases(cases: PromptCase[]): string[] {
  const errors: string[] = [];
  for (const c of cases) {
    try {
      const u = new URL(c.url);
      if (u.pathname !== "/" || u.search || u.hash) {
        errors.push(`${c.id}: URL must be origin-only`);
      }
      if (u.hostname !== c.source_host) {
        errors.push(`${c.id}: source_host must match URL hostname`);
      }
    } catch {
      errors.push(`${c.id}: invalid URL`);
    }
    if (c.command[0] !== "read" || c.command[1] !== "resolve") {
      errors.push(`${c.id}: command must be read resolve`);
    }
    for (const text of [c.id, c.source_host, c.url, c.intent, ...c.acceptance]) {
      if (/[?#]/.test(text)) errors.push(`${c.id}: leaked query/hash syntax`);
    }
  }
  return errors;
}

export function validateCliPlan(plan: PromptCliPlan[]): string[] {
  const errors: string[] = [];
  for (const item of plan) {
    if (item.expected_contract !== "CapabilityResult") {
      errors.push(`${item.case_id}: expected_contract must be CapabilityResult`);
    }
    const readResolveIndex = item.argv.findIndex((arg, idx) => arg === "read" && item.argv[idx + 1] === "resolve");
    if (readResolveIndex < 1) {
      errors.push(`${item.case_id}: argv must invoke the installed CLI with read resolve`);
    }
    const urlIndex = item.argv.indexOf("--url");
    const intentIndex = item.argv.indexOf("--intent");
    if (urlIndex < 0 || intentIndex < 0) {
      errors.push(`${item.case_id}: argv must include --intent and --url`);
      continue;
    }
    try {
      const u = new URL(item.argv[urlIndex + 1] ?? "");
      if (u.pathname !== "/" || u.search || u.hash) {
        errors.push(`${item.case_id}: plan URL must be origin-only`);
      }
    } catch {
      errors.push(`${item.case_id}: plan URL is invalid`);
    }
    if (!item.argv.includes("--json")) {
      errors.push(`${item.case_id}: argv must include --json for machine-readable UX`);
    }
  }
  return errors;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

function loadInventoryFromCli(flags: Record<string, string | boolean>): AuthInventoryEnvelope {
  const limit = typeof flags.limit === "string" ? flags.limit : "40";
  const args = ["read", "auth-inventory", "--json", "--limit", limit];
  if (flags["dia-only"]) {
    args.push("--dia-only");
  }
  if (typeof flags["dia-profile"] === "string") {
    args.push("--dia-profile", flags["dia-profile"]);
  }
  const res = runHarnessCli(args);
  if (res.status !== 0) {
    throw new Error(`auth-inventory failed: ${res.stderr || res.stdout}`);
  }
  return JSON.parse(res.stdout) as AuthInventoryEnvelope;
}

function loadInventory(flags: Record<string, string | boolean>): AuthInventoryEnvelope {
  if (typeof flags["inventory-fixture"] === "string") {
    return JSON.parse(readFileSync(flags["inventory-fixture"], "utf8")) as AuthInventoryEnvelope;
  }
  return loadInventoryFromCli(flags);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const envelope = loadInventory(flags);
  const rawInventory =
    envelope.inventory && Object.keys(envelope.inventory).length > 0
      ? envelope.inventory
      : FALLBACK_HOSTS;
  const limit = typeof flags.limit === "string" ? Number.parseInt(flags.limit, 10) : 12;
  const cases = derivePromptCases(rawInventory, Number.isFinite(limit) ? limit : 12);
  const cliPlan = buildCliPlan(cases);
  const errors = validatePromptCases(cases);
  errors.push(...validateCliPlan(cliPlan));
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  const outPath = typeof flags.out === "string" ? flags.out : "harness/probes/bookmark-derived-corpus.txt";
  const casesPath =
    typeof flags.cases === "string" ? flags.cases : "harness/probes/bookmark-derived-cases.json";
  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(dirname(casesPath), { recursive: true });
  await Bun.write(outPath, renderCorpus(cases));
  await Bun.write(
    casesPath,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        sources_scanned: envelope.sources_scanned ?? [],
        locked_sources: envelope.locked_sources ?? [],
        cases,
        cli_plan: cliPlan,
      },
      null,
      2,
    )}\n`,
  );

  if (flags.selftest) {
    const contract = runHarnessCli(["contract", "surface"]);
    if (contract.status !== 0 || !contract.stdout.trim().startsWith("{")) {
      throw new Error("contract surface selftest failed");
    }
    const contractJson = JSON.parse(contract.stdout);
    if (!contractJson?.cli_bridge?.canonical_verbs?.includes("read")) {
      throw new Error("contract surface selftest did not expose canonical read verb");
    }
    const version = runHarnessCli(["read", "version", "--json"]);
    if (version.status !== 0 || !version.stdout.includes('"op_kind":"eval:version"')) {
      throw new Error("read version selftest failed");
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        case_count: cases.length,
        plan_count: cliPlan.length,
        out: outPath,
        cases: casesPath,
        sources_scanned: envelope.sources_scanned ?? [],
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
