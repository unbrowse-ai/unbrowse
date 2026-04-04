#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

type Mode = "collect" | "verify";

type IssueRecord = {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: Array<{ name: string }>;
};

type EvalCase = {
  id: string;
  intent: string;
  url: string;
  expected_fields: string[];
  params?: Record<string, unknown>;
};

type CommandResult = {
  command: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
};

type Options = {
  mode: Mode;
  repo: string;
  issues: number[];
  capabilities: string[];
  output?: string;
  evalIntent?: string;
  evalUrl?: string;
  evalParams?: string;
};

type CapabilityPreset = {
  keywords: string[];
  testCase: EvalCase;
};

const ROOT = process.cwd();
const FIXED_CODEX_REGRESSION_CASES_ABS_PATH = join(ROOT, "evals", "codex-cases.worktree-regression.json");

export const FIXED_CODEX_REGRESSION_CASES_PATH = "evals/codex-cases.worktree-regression.json";

const CAPABILITY_PRESETS: CapabilityPreset[] = [
  {
    keywords: ["github", "repo search", "repository search"],
    testCase: {
      id: "github-search-repositories",
      intent: "search repositories",
      url: "https://github.com/search?q=openai&type=repositories",
      expected_fields: ["full_name", "description", "stargazers_count"],
    },
  },
  {
    keywords: ["mdn", "docs search", "documentation search"],
    testCase: {
      id: "mdn-search-docs",
      intent: "search docs",
      url: "https://developer.mozilla.org/en-US/search?q=fetch",
      expected_fields: ["title", "url", "summary"],
    },
  },
  {
    keywords: ["npm", "node package", "package info"],
    testCase: {
      id: "npm-package-info",
      intent: "get package info",
      url: "https://www.npmjs.com/package/openai",
      expected_fields: ["name", "version", "description"],
    },
  },
  {
    keywords: ["pypi", "python package", "python packages"],
    testCase: {
      id: "pypi-package-info-openai",
      intent: "get package info",
      url: "https://pypi.org/project/openai/",
      expected_fields: ["name", "version", "summary"],
    },
  },
  {
    keywords: ["rubygems", "ruby gem", "gem info"],
    testCase: {
      id: "rubygems-package-info",
      intent: "get package info",
      url: "https://rubygems.org/gems/rails",
      expected_fields: ["name", "version", "description"],
    },
  },
  {
    keywords: ["pub.dev", "dart package", "flutter package"],
    testCase: {
      id: "pubdev-package-info",
      intent: "get package info",
      url: "https://pub.dev/packages/http",
      expected_fields: ["name", "version", "description"],
    },
  },
  {
    keywords: ["hacker news", "hn", "algolia hn"],
    testCase: {
      id: "hn-search-param-seeded",
      intent: "search hacker news",
      url: "https://hn.algolia.com/",
      params: { q: "openai" },
      expected_fields: ["title", "author", "url"],
    },
  },
];

let fixedCasesCache: EvalCase[] | null = null;

function parseArgs(argv: string[]): Options {
  const [modeRaw, ...rest] = argv;
  if (modeRaw !== "collect" && modeRaw !== "verify") {
    throw new Error("usage: issue-worktree-loop.ts <collect|verify> --repo owner/repo [--issue N ...] [--capability '...'] [--eval-intent ... --eval-url ... --eval-params '{...}']");
  }

  const options: Options = {
    mode: modeRaw,
    repo: "unbrowse-ai/unbrowse",
    issues: [],
    capabilities: [],
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--repo" && rest[i + 1]) options.repo = rest[++i];
    else if (arg === "--issue" && rest[i + 1]) options.issues.push(Number(rest[++i]));
    else if (arg === "--capability" && rest[i + 1]) options.capabilities.push(rest[++i]);
    else if (arg === "--output" && rest[i + 1]) options.output = rest[++i];
    else if (arg === "--eval-intent" && rest[i + 1]) options.evalIntent = rest[++i];
    else if (arg === "--eval-url" && rest[i + 1]) options.evalUrl = rest[++i];
    else if (arg === "--eval-params" && rest[i + 1]) options.evalParams = rest[++i];
  }

  return options;
}

function runText(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runJson<T>(command: string, args: string[]): T {
  return JSON.parse(runText(command, args)) as T;
}

function cloneCase(testCase: EvalCase): EvalCase {
  return JSON.parse(JSON.stringify(testCase)) as EvalCase;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "case";
}

function normalizeExtractedUrl(url: string): string {
  return url.replace(/[),.\]]+$/g, "");
}

function loadFixedCases(): EvalCase[] {
  if (fixedCasesCache) return fixedCasesCache.map(cloneCase);
  const raw = JSON.parse(readFileSync(FIXED_CODEX_REGRESSION_CASES_ABS_PATH, "utf-8")) as { cases?: EvalCase[] };
  fixedCasesCache = (raw.cases ?? []).map(cloneCase);
  return fixedCasesCache.map(cloneCase);
}

function sameCaseIdentity(left: EvalCase, right: EvalCase): boolean {
  return left.id === right.id || (left.intent === right.intent && left.url === right.url);
}

function mergeEvalCases(...groups: EvalCase[][]): EvalCase[] {
  const merged: EvalCase[] = [];
  for (const group of groups) {
    for (const testCase of group) {
      if (merged.some((existing) => sameCaseIdentity(existing, testCase))) continue;
      merged.push(cloneCase(testCase));
    }
  }
  return merged;
}

export function extractUrls(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s)>\]]+/g) ?? []).map(normalizeExtractedUrl))];
}

export function extractFileMentions(text: string): string[] {
  return [...new Set((text.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|zig|md|json|yml|yaml|sh)\b/g) ?? []))];
}

function testCaseFromUrl(url: string): EvalCase | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const path = parsed.pathname;
  const packageName = path.split("/").filter(Boolean).at(-1);

  if (host === "github.com" && path === "/search" && parsed.searchParams.get("type") === "repositories") {
    return {
      id: `github-search-repositories-${slugify(parsed.searchParams.get("q") || "search")}`,
      intent: "search repositories",
      url,
      expected_fields: ["full_name", "description", "stargazers_count"],
    };
  }

  if (host === "developer.mozilla.org" && path.endsWith("/search")) {
    return {
      id: `mdn-search-docs-${slugify(parsed.searchParams.get("q") || "search")}`,
      intent: "search docs",
      url,
      expected_fields: ["title", "url", "summary"],
    };
  }

  if (host === "www.npmjs.com" && path.startsWith("/package/") && packageName) {
    return {
      id: `npm-package-info-${slugify(packageName)}`,
      intent: "get package info",
      url,
      expected_fields: ["name", "version", "description"],
    };
  }

  if (host === "www.npmjs.com" && path === "/search") {
    return {
      id: `npm-search-packages-${slugify(parsed.searchParams.get("q") || "search")}`,
      intent: "search packages",
      url,
      expected_fields: ["name", "version", "description"],
    };
  }

  if (host === "pypi.org" && path.startsWith("/project/") && packageName) {
    return {
      id: `pypi-package-info-${slugify(packageName)}`,
      intent: "get package info",
      url,
      expected_fields: ["name", "version", "summary"],
    };
  }

  if (host === "rubygems.org" && path.startsWith("/gems/") && packageName) {
    return {
      id: `rubygems-package-info-${slugify(packageName)}`,
      intent: "get package info",
      url,
      expected_fields: ["name", "version", "description"],
    };
  }

  if (host === "pub.dev" && path.startsWith("/packages/") && packageName) {
    return {
      id: `pubdev-package-info-${slugify(packageName)}`,
      intent: "get package info",
      url,
      expected_fields: ["name", "version", "description"],
    };
  }

  if (host === "hn.algolia.com") {
    const q = parsed.searchParams.get("q") || "openai";
    return {
      id: `hn-search-param-seeded-${slugify(q)}`,
      intent: "search hacker news",
      url: "https://hn.algolia.com/",
      params: { q },
      expected_fields: ["title", "author", "url"],
    };
  }

  return null;
}

export function deriveIssueEvalCases(issues: Array<Pick<IssueRecord, "title" | "body">>): EvalCase[] {
  return mergeEvalCases(
    issues.flatMap((issue) => extractUrls(`${issue.title}\n${issue.body}`))
      .map(testCaseFromUrl)
      .filter((testCase): testCase is EvalCase => !!testCase),
  );
}

export function deriveCapabilityEvalCases(capabilities: string[]): EvalCase[] {
  const lowered = capabilities.map((capability) => capability.toLowerCase());
  return mergeEvalCases(
    CAPABILITY_PRESETS
      .filter((preset) => preset.keywords.some((keyword) => lowered.some((capability) => capability.includes(keyword))))
      .map((preset) => preset.testCase),
  );
}

export function inferSuggestedCommands(
  issues: Array<Pick<IssueRecord, "title" | "body">>,
  capabilities: string[] = [],
): string[] {
  const corpus = [
    ...issues.map((issue) => `${issue.title}\n${issue.body}`),
    ...capabilities,
  ].join("\n").toLowerCase();
  const commands = ["bun run test:issue-regressions", "bun run test"];

  if (/(linkedin|auth|cookie|csrf|browser|capture|har|voyager|kuri|login|pypi)/i.test(corpus)) {
    commands.push("bun test tests/cli-e2e.test.ts");
  }

  return [...new Set(commands)];
}

function artifactStamp(issues: number[], capabilities: string[]): string {
  if (issues.length > 0) return issues.join("-");
  if (capabilities.length > 0) return slugify(capabilities.join("-"));
  return "open";
}

function defaultOutputPath(mode: Mode, issues: number[], capabilities: string[]): string {
  return join(ROOT, ".planning", "issue-worktree", `${mode}-${artifactStamp(issues, capabilities)}.json`);
}

function ensureParent(pathname: string): void {
  const parent = dirname(pathname);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
}

function fetchIssues(repo: string, issues: number[]): IssueRecord[] {
  if (issues.length === 0) return [];
  return issues.map((issue) =>
    runJson<IssueRecord>("gh", [
      "issue",
      "view",
      String(issue),
      "--repo",
      repo,
      "--json",
      "number,title,body,url,state,labels",
    ]),
  );
}

function buildRegressionCaseSet(issues: Array<Pick<IssueRecord, "title" | "body">>, capabilities: string[]): EvalCase[] {
  return mergeEvalCases(
    loadFixedCases(),
    deriveIssueEvalCases(issues),
    deriveCapabilityEvalCases(capabilities),
  );
}

function writeDynamicRegressionCasesFile(issues: number[], capabilities: string[], cases: EvalCase[]): string {
  const output = join(ROOT, ".planning", "issue-worktree", `cases-${artifactStamp(issues, capabilities)}.json`);
  ensureParent(output);
  writeFileSync(output, `${JSON.stringify({ cases }, null, 2)}\n`);
  return output.replace(`${ROOT}/`, "");
}

function buildRegressionPlan(issues: IssueRecord[], capabilities: string[]) {
  const fixedCases = loadFixedCases();
  const mergedCases = buildRegressionCaseSet(issues, capabilities);
  const casesPath = mergedCases.length > fixedCases.length
    ? writeDynamicRegressionCasesFile(issues.map((issue) => issue.number), capabilities, mergedCases)
    : FIXED_CODEX_REGRESSION_CASES_PATH;
  const artifactPath = `.planning/issue-worktree/codex-phase-regression-${artifactStamp(issues.map((issue) => issue.number), capabilities)}.json`;

  return {
    cases: mergedCases,
    casesPath,
    command: [
      "bun",
      "evals/codex-autonomous-harness.ts",
      "--benchmark",
      `--cases ${JSON.stringify(casesPath)}`,
      `--out ${JSON.stringify(artifactPath)}`,
    ].join(" "),
  };
}

export function buildFixedCodexRegressionCommand(issues: number[]): string {
  const artifactPath = `.planning/issue-worktree/codex-phase-regression-${artifactStamp(issues, [])}.json`;
  return [
    "bun",
    "evals/codex-autonomous-harness.ts",
    "--benchmark",
    `--cases ${JSON.stringify(FIXED_CODEX_REGRESSION_CASES_PATH)}`,
    `--out ${JSON.stringify(artifactPath)}`,
  ].join(" ");
}

export function buildTargetedCodexEvalCommand(options: Pick<Options, "issues" | "capabilities" | "evalIntent" | "evalUrl" | "evalParams">): string | null {
  if (!options.evalIntent || !options.evalUrl) return null;

  const artifactPath = `.planning/issue-worktree/codex-targeted-eval-${artifactStamp(options.issues, options.capabilities)}.json`;
  const command = [
    "bun",
    "evals/codex-autonomous-harness.ts",
    "--benchmark",
    `--intent ${JSON.stringify(options.evalIntent)}`,
    `--url ${JSON.stringify(options.evalUrl)}`,
    `--out ${JSON.stringify(artifactPath)}`,
  ];

  if (options.evalParams) command.push(`--params ${JSON.stringify(options.evalParams)}`);
  return command.join(" ");
}

function runShell(command: string): CommandResult {
  const started = Date.now();
  try {
    execFileSync("/bin/zsh", ["-lc", command], {
      cwd: ROOT,
      stdio: "inherit",
    });
    return {
      command,
      ok: true,
      exitCode: 0,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const exitCode =
      error && typeof error === "object" && "status" in error && typeof error.status === "number"
        ? error.status
        : 1;
    return {
      command,
      ok: false,
      exitCode,
      durationMs: Date.now() - started,
    };
  }
}

function collect(options: Options): void {
  const issues = fetchIssues(options.repo, options.issues);
  const regressionPlan = buildRegressionPlan(issues, options.capabilities);
  const output = options.output ?? defaultOutputPath("collect", issues.map((issue) => issue.number), options.capabilities);
  const payload = {
    generated_at: new Date().toISOString(),
    cwd: ROOT,
    repo: options.repo,
    capabilities: options.capabilities,
    issues: issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      labels: issue.labels.map((label) => label.name),
      urls: extractUrls(issue.body),
      files: extractFileMentions(issue.body),
      body: issue.body,
    })),
    suggested_commands: inferSuggestedCommands(issues, options.capabilities),
    fixed_codex_regression_cases_path: FIXED_CODEX_REGRESSION_CASES_PATH,
    codex_regression_cases_path: regressionPlan.casesPath,
    codex_regression_cases: regressionPlan.cases,
    fixed_codex_regression_command: buildFixedCodexRegressionCommand(issues.map((issue) => issue.number)),
    codex_regression_command: regressionPlan.command,
  };

  ensureParent(output);
  writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(output);
}

function verify(options: Options): void {
  const issues = fetchIssues(options.repo, options.issues);
  const regressionPlan = buildRegressionPlan(issues, options.capabilities);
  const issueNumbers = issues.map((issue) => issue.number);
  const commands = [
    ...inferSuggestedCommands(issues, options.capabilities),
    regressionPlan.command,
  ];
  const targetedEvalCommand = buildTargetedCodexEvalCommand({
    issues: issueNumbers,
    capabilities: options.capabilities,
    evalIntent: options.evalIntent,
    evalUrl: options.evalUrl,
    evalParams: options.evalParams,
  });
  if (targetedEvalCommand) commands.push(targetedEvalCommand);

  const results = commands.map(runShell);
  const output = options.output ?? defaultOutputPath("verify", issueNumbers, options.capabilities);
  const payload = {
    generated_at: new Date().toISOString(),
    cwd: ROOT,
    repo: options.repo,
    capabilities: options.capabilities,
    issues: issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
    })),
    codex_regression_cases_path: regressionPlan.casesPath,
    results,
    ok: results.every((result) => result.ok),
  };

  ensureParent(output);
  writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(output);

  if (!payload.ok) process.exit(1);
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "collect") collect(options);
  else verify(options);
}
