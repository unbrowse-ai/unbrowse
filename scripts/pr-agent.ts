#!/usr/bin/env bun

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

type PullRequestDetails = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  draft: boolean;
  mergeable_state?: string | null;
  head: {
    ref: string;
    sha: string;
    repo?: { full_name?: string | null } | null;
  };
  base: {
    ref: string;
    repo?: { full_name?: string | null } | null;
  };
  labels: Array<{ name?: string }>;
};

type IssueComment = {
  id: number;
  user?: { login?: string };
  body?: string | null;
  created_at?: string;
};

type ReviewComment = {
  id: number;
  user?: { login?: string };
  path?: string;
  body?: string | null;
  line?: number | null;
  created_at?: string;
};

type ChangedFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
};

type CheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
};

type AgentResult = {
  summary: string;
  tests_run: string[];
  evals_run: string[];
  files_touched: string[];
  residual_risks: string[];
  outcome: "patched" | "no_changes" | "blocked";
};

type Context = {
  repo: string;
  pr: PullRequestDetails;
  failingChecks: string[];
  suggestedCommands: string[];
  suggestedEvalCommands: string[];
  issueComments: IssueComment[];
  reviewComments: ReviewComment[];
  changedFiles: ChangedFile[];
  triggerSource: string;
  triggerReason: string;
};

const MARKER = "<!-- unbrowse-pr-agent -->";

function runText(command: string, args: string[], cwd = process.cwd()): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runJson<T>(command: string, args: string[], cwd = process.cwd()): T {
  return JSON.parse(runText(command, args, cwd)) as T;
}

function parseArgs(argv: string[]) {
  const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = value;
    i += 1;
  }
  if (!options.repo || !options.pr) {
    throw new Error("usage: pr-agent.ts --repo owner/repo --pr 123 [--trigger-source pull_request] [--trigger-reason pull_request:synchronize]");
  }
  return {
    repo: options.repo,
    prNumber: Number(options.pr),
    triggerSource: options["trigger-source"] ?? "pull_request",
    triggerReason: options["trigger-reason"] ?? "manual",
  };
}

export function deriveSuggestedCommands(failingChecks: string[], changedFiles: string[]): string[] {
  const commands = new Set<string>();
  const add = (command: string) => commands.add(command);

  for (const check of failingChecks) {
    if (check === "Repo Sanity") {
      add("bun run check:skill-md");
      add("bun run check:skill-docs");
    }
    if (check === "Unit Tests") {
      add("bun run test:issue-regressions");
      add("bun test tests/path-params.test.ts tests/utils.test.ts");
    }
    if (check === "Quality Gate") add("bun test evals/quality-gate.test.ts");
    if (check === "Backend Tests") add("bun test backend/tests/");
    if (check === "Typecheck Backend") add("cd backend && ./node_modules/.bin/tsc --noEmit");
    if (check === "Package CLI") {
      add("bun scripts/sync-skill-md.ts --check");
      add("bun run check:skill-docs");
      add("npm pack --dry-run --workspace packages/skill");
    }
    if (check === "CLI E2E") {
      add("bun run cli -- setup --no-start");
      add("bun test tests/cli-e2e.test.ts");
    }
  }

  const touchesBackend = changedFiles.some((file) => file.startsWith("backend/"));
  const touchesRuntime = changedFiles.some((file) =>
    file.startsWith("src/execution/") ||
    file.startsWith("src/orchestrator/") ||
    file.startsWith("src/capture/") ||
    file.startsWith("src/reverse-engineer/") ||
    file === "src/cli.ts" ||
    file === "src/router.ts",
  );
  const touchesCli = changedFiles.some((file) =>
    file === "src/cli.ts" ||
    file.startsWith("src/runtime/") ||
    file.startsWith("packages/skill/"),
  );

  if (touchesBackend) {
    add("bun test backend/tests/");
    add("cd backend && ./node_modules/.bin/tsc --noEmit");
  }
  if (touchesRuntime) add("bun run test:issue-regressions");
  if (touchesCli) {
    add("bun run cli -- setup --no-start");
    add("bun test tests/cli-e2e.test.ts");
  }

  return [...commands];
}

export function deriveSuggestedEvalCommands(changedFiles: string[]): string[] {
  const commands = new Set<string>();
  const touchesRuntime = changedFiles.some((file) =>
    file.startsWith("src/execution/") ||
    file.startsWith("src/orchestrator/") ||
    file.startsWith("src/capture/") ||
    file.startsWith("src/reverse-engineer/") ||
    file === "src/cli.ts" ||
    file === "src/router.ts",
  );
  if (touchesRuntime) {
    commands.add("bun run eval:codex:product-success");
  }
  return [...commands];
}

function fetchPullRequest(repo: string, prNumber: number): PullRequestDetails {
  return runJson("gh", ["api", `repos/${repo}/pulls/${prNumber}`]);
}

function fetchIssueComments(repo: string, prNumber: number): IssueComment[] {
  return runJson("gh", ["api", `repos/${repo}/issues/${prNumber}/comments?per_page=100`]);
}

function fetchReviewComments(repo: string, prNumber: number): ReviewComment[] {
  return runJson("gh", ["api", `repos/${repo}/pulls/${prNumber}/comments?per_page=100`]);
}

function fetchChangedFiles(repo: string, prNumber: number): ChangedFile[] {
  return runJson("gh", ["api", `repos/${repo}/pulls/${prNumber}/files?per_page=100`]);
}

function fetchCheckRuns(repo: string, headSha: string): CheckRun[] {
  const payload = runJson<{ check_runs?: CheckRun[] }>("gh", [
    "api",
    `repos/${repo}/commits/${headSha}/check-runs`,
    "-H",
    "Accept: application/vnd.github+json",
  ]);
  return payload.check_runs ?? [];
}

function buildPrompt(context: Context): string {
  const changedFiles = context.changedFiles.map((file) => file.filename);
  const latestIssueComments = context.issueComments.slice(-5).map((comment) => ({
    user: comment.user?.login ?? "unknown",
    created_at: comment.created_at,
    body: comment.body ?? "",
  }));
  const latestReviewComments = context.reviewComments.slice(-15).map((comment) => ({
    user: comment.user?.login ?? "unknown",
    path: comment.path ?? "",
    line: comment.line ?? null,
    body: comment.body ?? "",
  }));

  return [
    `You are repairing PR #${context.pr.number} in ${context.repo}.`,
    "",
    "Goals:",
    "1. Review the PR diff and comments.",
    "2. If the PR branch is behind or conflicted with base, merge the base branch into the PR branch and resolve conflicts carefully.",
    "3. Fix real issues you find or any failing checks relevant to this PR.",
    "4. Run the relevant tests and evals before finishing.",
    "5. Do not commit or push; leave the worktree ready for the wrapper script to do that.",
    "",
    "Hard rules:",
    "- Keep changes minimal and reviewable.",
    "- Do not touch unrelated files.",
    "- Do not ignore failing tests/evals; either fix them or explicitly record the blocker.",
    "- Prefer repository commands over made-up checks.",
    "- If a check is already failing elsewhere in the repo unrelated to this PR, do not derail into unrelated cleanup.",
    "",
    `Trigger: ${context.triggerSource} / ${context.triggerReason}`,
    `PR title: ${context.pr.title}`,
    `PR url: ${context.pr.html_url}`,
    `Base branch: ${context.pr.base.ref}`,
    `Head branch: ${context.pr.head.ref}`,
    `Head sha: ${context.pr.head.sha}`,
    `Mergeable state: ${context.pr.mergeable_state ?? "unknown"}`,
    "",
    "Changed files:",
    ...changedFiles.map((file) => `- ${file}`),
    "",
    "Failing checks:",
    ...(context.failingChecks.length > 0 ? context.failingChecks.map((check) => `- ${check}`) : ["- none reported"]),
    "",
    "Suggested commands:",
    ...(context.suggestedCommands.length > 0 ? context.suggestedCommands.map((command) => `- ${command}`) : ["- none"]),
    "",
    "Suggested eval commands:",
    ...(context.suggestedEvalCommands.length > 0 ? context.suggestedEvalCommands.map((command) => `- ${command}`) : ["- none"]),
    "",
    "Recent PR comments:",
    JSON.stringify(latestIssueComments, null, 2),
    "",
    "Recent review comments:",
    JSON.stringify(latestReviewComments, null, 2),
    "",
    "Final response must satisfy the provided JSON schema.",
  ].join("\n");
}

function outputSchemaPath(dir: string): string {
  const schemaPath = join(dir, "pr-agent-output-schema.json");
  writeFileSync(schemaPath, JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["summary", "tests_run", "evals_run", "files_touched", "residual_risks", "outcome"],
    properties: {
      summary: { type: "string" },
      tests_run: { type: "array", items: { type: "string" } },
      evals_run: { type: "array", items: { type: "string" } },
      files_touched: { type: "array", items: { type: "string" } },
      residual_risks: { type: "array", items: { type: "string" } },
      outcome: { type: "string", enum: ["patched", "no_changes", "blocked"] },
    },
  }, null, 2));
  return schemaPath;
}

function runCodex(prompt: string, workdir: string, outputPath: string, schemaPath: string): void {
  execFileSync(
    "codex",
    [
      "-a", "never",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--color", "never",
      "-C", workdir,
      "--output-schema", schemaPath,
      "-o", outputPath,
      "-",
    ],
    {
      cwd: workdir,
      input: prompt,
      stdio: ["pipe", "inherit", "inherit"],
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_LOG: "error",
      },
    },
  );
}

function currentHeadSha(): string {
  return runText("git", ["rev-parse", "HEAD"]);
}

function hasChanges(): boolean {
  return runText("git", ["status", "--porcelain"]).trim().length > 0;
}

function commitAndPush(prNumber: number, headRef: string): string {
  runText("git", ["config", "user.name", "codex-pr-agent"]);
  runText("git", ["config", "user.email", "codex-pr-agent@users.noreply.github.com"]);
  runText("git", ["add", "-A"]);
  runText("git", ["commit", "-m", `fix: codex repair for pr #${prNumber}`]);
  runText("git", ["push", "origin", `HEAD:${headRef}`]);
  return currentHeadSha();
}

function upsertComment(repo: string, prNumber: number, body: string): void {
  const comments = fetchIssueComments(repo, prNumber);
  const existing = comments.find((comment) => comment.body?.includes(MARKER));
  if (existing) {
    runText("gh", ["api", `repos/${repo}/issues/comments/${existing.id}`, "--method", "PATCH", "-f", `body=${body}`]);
    return;
  }
  runText("gh", ["api", `repos/${repo}/issues/${prNumber}/comments`, "--method", "POST", "-f", `body=${body}`]);
}

function buildComment(context: Context, result: AgentResult, pushedSha: string | null): string {
  const lines = [
    MARKER,
    "## PR Agent",
    "",
    `Trigger: \`${context.triggerSource}\` / \`${context.triggerReason}\``,
    `Outcome: \`${result.outcome}\``,
    "",
    result.summary,
  ];

  if (result.tests_run.length > 0) {
    lines.push("", "Tests run:");
    lines.push(...result.tests_run.map((command) => `- \`${command}\``));
  }
  if (result.evals_run.length > 0) {
    lines.push("", "Evals run:");
    lines.push(...result.evals_run.map((command) => `- \`${command}\``));
  }
  if (result.files_touched.length > 0) {
    lines.push("", "Files touched:");
    lines.push(...result.files_touched.map((file) => `- \`${file}\``));
  }
  if (result.residual_risks.length > 0) {
    lines.push("", "Residual risks:");
    lines.push(...result.residual_risks.map((item) => `- ${item}`));
  }
  if (pushedSha) {
    lines.push("", `Pushed: \`${pushedSha.slice(0, 7)}\``);
  }
  return lines.join("\n");
}

function checkoutPrBranch(repo: string, pr: PullRequestDetails): void {
  if (pr.head.repo?.full_name !== repo || pr.base.repo?.full_name !== repo) {
    throw new Error("PR agent only supports internal PR branches.");
  }
  runText("git", ["fetch", "origin", pr.base.ref, pr.head.ref]);
  runText("git", ["checkout", "-B", pr.head.ref, `origin/${pr.head.ref}`]);
}

function buildContext(repo: string, prNumber: number, triggerSource: string, triggerReason: string): Context {
  const pr = fetchPullRequest(repo, prNumber);
  const issueComments = fetchIssueComments(repo, prNumber);
  const reviewComments = fetchReviewComments(repo, prNumber);
  const changedFiles = fetchChangedFiles(repo, prNumber);
  const failingChecks = fetchCheckRuns(repo, pr.head.sha)
    .filter((check) => check.conclusion != null && check.conclusion !== "success" && check.conclusion !== "skipped" && check.conclusion !== "neutral")
    .map((check) => check.name);

  return {
    repo,
    pr,
    failingChecks,
    suggestedCommands: deriveSuggestedCommands(failingChecks, changedFiles.map((file) => file.filename)),
    suggestedEvalCommands: deriveSuggestedEvalCommands(changedFiles.map((file) => file.filename)),
    issueComments,
    reviewComments,
    changedFiles,
    triggerSource,
    triggerReason,
  };
}

async function main(): Promise<void> {
  const { repo, prNumber, triggerSource, triggerReason } = parseArgs(process.argv.slice(2));
  const context = buildContext(repo, prNumber, triggerSource, triggerReason);
  checkoutPrBranch(repo, context.pr);

  const tempDir = mkdtempSync(join(tmpdir(), "unbrowse-pr-agent-"));
  const outputPath = join(tempDir, "pr-agent-output.json");
  const schemaPath = outputSchemaPath(tempDir);
  const prompt = buildPrompt(context);

  runCodex(prompt, process.cwd(), outputPath, schemaPath);

  if (!existsSync(outputPath)) {
    throw new Error("Codex did not write an output artifact.");
  }
  const result = JSON.parse(readFileSync(outputPath, "utf8")) as AgentResult;

  let pushedSha: string | null = null;
  if (result.outcome === "patched" && hasChanges()) {
    pushedSha = commitAndPush(prNumber, context.pr.head.ref);
  }

  upsertComment(repo, prNumber, buildComment(context, result, pushedSha));
}

if (import.meta.main) {
  await main();
}
