#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type AgentOperation = "repair" | "merge";
type AgentOutcome = "patched" | "no_changes" | "blocked" | "merged";
type MergeMethod = "merge" | "squash" | "rebase";

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

type PullRequestMergeView = {
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  headRefOid: string;
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
  merge_recommended: boolean;
  outcome: "patched" | "no_changes" | "blocked";
};

type ExecutionResult = {
  summary: string;
  tests_run: string[];
  evals_run: string[];
  files_touched: string[];
  residual_risks: string[];
  merge_recommended?: boolean;
  outcome: AgentOutcome;
};

type CheckSummary = {
  hasExternalChecks: boolean;
  pending: string[];
  failing: string[];
  successful: string[];
};

type MergeReadiness = {
  ok: boolean;
  reason: string;
  successfulChecks: string[];
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
  operation: AgentOperation;
};

const MARKER = "<!-- unbrowse-pr-agent -->";
const AGENT_CHECK_NAMES = new Set(["PR Agent", "Review And Repair PR"]);
const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
const SAFE_MERGE_STATES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

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
    throw new Error("usage: pr-agent.ts --repo owner/repo --pr 123 [--operation repair|merge] [--trigger-source pull_request] [--trigger-reason pull_request:synchronize]");
  }
  const operation = (options.operation ?? "repair").trim().toLowerCase();
  if (operation !== "repair" && operation !== "merge") {
    throw new Error(`Unsupported operation: ${options.operation}`);
  }
  return {
    repo: options.repo,
    prNumber: Number(options.pr),
    operation: operation as AgentOperation,
    triggerSource: options["trigger-source"] ?? "pull_request",
    triggerReason: options["trigger-reason"] ?? "manual",
  };
}

function isAgentCheckName(name: string): boolean {
  return AGENT_CHECK_NAMES.has(name.trim());
}

export function summarizeCheckRuns(checkRuns: CheckRun[]): CheckSummary {
  const externalChecks = checkRuns.filter((check) => check.name.trim().length > 0 && !isAgentCheckName(check.name));
  const pending = externalChecks
    .filter((check) => check.status !== "completed")
    .map((check) => check.name);
  const failing = externalChecks
    .filter((check) => check.status === "completed" && check.conclusion != null && !SUCCESSFUL_CHECK_CONCLUSIONS.has(check.conclusion))
    .map((check) => check.name);
  const successful = externalChecks
    .filter((check) => check.status === "completed" && check.conclusion != null && SUCCESSFUL_CHECK_CONCLUSIONS.has(check.conclusion))
    .map((check) => check.name);

  return {
    hasExternalChecks: externalChecks.length > 0,
    pending,
    failing,
    successful,
  };
}

export function evaluateMergeReadiness(
  pr: PullRequestMergeView,
  expectedHeadSha: string,
  checkRuns: CheckRun[],
): MergeReadiness {
  if (pr.state !== "OPEN") return { ok: false, reason: `pr state ${pr.state.toLowerCase()}`, successfulChecks: [] };
  if (pr.isDraft) return { ok: false, reason: "draft pr", successfulChecks: [] };
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    return { ok: false, reason: "review requested changes", successfulChecks: [] };
  }
  if (pr.headRefOid !== expectedHeadSha) {
    return { ok: false, reason: "head sha changed", successfulChecks: [] };
  }

  const summary = summarizeCheckRuns(checkRuns);
  if (!summary.hasExternalChecks) return { ok: false, reason: "no external checks reported", successfulChecks: [] };
  if (summary.pending.length > 0) {
    return { ok: false, reason: `pending checks: ${summary.pending.join(", ")}`, successfulChecks: summary.successful };
  }
  if (summary.failing.length > 0) {
    return { ok: false, reason: `failing checks: ${summary.failing.join(", ")}`, successfulChecks: summary.successful };
  }

  const mergeState = pr.mergeStateStatus ?? "UNKNOWN";
  if (!SAFE_MERGE_STATES.has(mergeState)) {
    return { ok: false, reason: `merge state ${mergeState.toLowerCase()}`, successfulChecks: summary.successful };
  }

  return { ok: true, reason: "external checks green", successfulChecks: summary.successful };
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
      add("bun test tests/path-params.test.ts tests/utils.test.ts tests/pr-agent.test.ts");
    }
    if (check === "Quality Gate") add("bun test evals/quality-gate.test.ts");
    if (check === "Backend Tests") add("bun test backend/tests/");
    if (check === "Typecheck Backend") add("cd backend && ./node_modules/.bin/tsc --noEmit");
    if (check === "Package CLI") {
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
  if (touchesRuntime) commands.add("bun run eval:codex:product-success");
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

function splitRepo(repo: string): [string, string] {
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) throw new Error(`Invalid repo: ${repo}`);
  return [owner, repoName];
}

function fetchPullRequestMergeView(repo: string, prNumber: number): PullRequestMergeView {
  const [owner, repoName] = splitRepo(repo);
  const payload = runJson<{
    data?: {
      repository?: {
        pullRequest?: PullRequestMergeView | null;
      } | null;
    } | null;
  }>("gh", [
    "api",
    "graphql",
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${repoName}`,
    "-F",
    `number=${prNumber}`,
    "-f",
    `query=query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          state
          isDraft
          reviewDecision
          mergeStateStatus
          headRefOid
        }
      }
    }`,
  ]);
  const pullRequest = payload.data?.repository?.pullRequest;
  if (!pullRequest) throw new Error(`PR #${prNumber} not found in ${repo}`);
  return pullRequest;
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

  const lines = [
    `You are handling PR #${context.pr.number} in ${context.repo}.`,
    "",
    `Trigger: ${context.triggerSource} / ${context.triggerReason}`,
    `Operation: ${context.operation}`,
    `PR title: ${context.pr.title}`,
    `PR url: ${context.pr.html_url}`,
    `Base branch: ${context.pr.base.ref}`,
    `Head branch: ${context.pr.head.ref}`,
    `Head sha: ${context.pr.head.sha}`,
    `Mergeable state: ${context.pr.mergeable_state ?? "unknown"}`,
    "",
  ];

  if (context.operation === "repair") {
    lines.push(
      "Goals:",
      "1. Review the PR diff and comments.",
      "2. If the PR branch is behind or conflicted with base, merge the base branch into the PR branch and resolve conflicts carefully.",
      "3. Fix real issues you find or any failing checks relevant to this PR.",
      "4. Run the relevant tests and evals before finishing.",
      "5. Decide whether the PR should merge after your review. Set merge_recommended=true only if you believe it is ready.",
      "6. Do not commit or push; leave the worktree ready for the wrapper script to do that.",
      "",
      "Hard rules:",
      "- Keep changes minimal and reviewable.",
      "- Do not touch unrelated files.",
      "- Do not ignore failing tests/evals; either fix them or explicitly record the blocker.",
      "- Prefer repository commands over made-up checks.",
      "- If a check is already failing elsewhere in the repo unrelated to this PR, do not derail into unrelated cleanup.",
    );
  } else {
    lines.push(
      "Goals:",
      "1. Review the PR diff, comments, and check state.",
      "2. Decide whether this PR should merge right now.",
      "3. Do not change files, commit, or push in merge mode.",
      "",
      "Hard rules:",
      "- This is a merge judgment pass, not a repair pass.",
      "- Set merge_recommended=true only if the PR is genuinely ready to merge now.",
      "- If anything feels incomplete, risky, or underspecified, set merge_recommended=false and explain why.",
      "- Do not make code edits in merge mode.",
    );
  }

  lines.push(
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
  );

  return lines.join("\n");
}

function outputSchemaPath(dir: string): string {
  const schemaPath = join(dir, "pr-agent-output-schema.json");
  writeFileSync(schemaPath, JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["summary", "tests_run", "evals_run", "files_touched", "residual_risks", "merge_recommended", "outcome"],
    properties: {
      summary: { type: "string" },
      tests_run: { type: "array", items: { type: "string" } },
      evals_run: { type: "array", items: { type: "string" } },
      files_touched: { type: "array", items: { type: "string" } },
      residual_risks: { type: "array", items: { type: "string" } },
      merge_recommended: { type: "boolean" },
      outcome: { type: "string", enum: ["patched", "no_changes", "blocked"] },
    },
  }, null, 2));
  return schemaPath;
}

function runCodex(prompt: string, workdir: string, outputPath: string, schemaPath: string): void {
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("Missing OPENAI_API_KEY.");

  const codexHome = process.env.CODEX_HOME?.trim() || join(tmpdir(), "unbrowse-pr-agent-codex-home");
  mkdirSync(codexHome, { recursive: true });

  execFileSync(
    "codex",
    [
      "-a", "never",
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--ephemeral",
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
        CODEX_HOME: codexHome,
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

function mergeMethod(): MergeMethod {
  const configured = (process.env.GITHUB_PR_BOT_MERGE_METHOD ?? "squash").trim().toLowerCase();
  if (configured === "merge" || configured === "rebase") return configured;
  return "squash";
}

function commitAndPush(prNumber: number, headRef: string): string {
  runText("git", ["config", "user.name", "codex-pr-agent"]);
  runText("git", ["config", "user.email", "codex-pr-agent@users.noreply.github.com"]);
  runText("git", ["add", "-A"]);
  runText("git", ["commit", "-m", `fix: codex repair for pr #${prNumber}`]);
  runText("git", ["push", "origin", `HEAD:${headRef}`]);
  return currentHeadSha();
}

function mergePullRequest(repo: string, prNumber: number, headSha: string): void {
  runText("gh", [
    "api",
    `repos/${repo}/pulls/${prNumber}/merge`,
    "--method",
    "PUT",
    "-f",
    `sha=${headSha}`,
    "-f",
    `merge_method=${mergeMethod()}`,
  ]);
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

function buildComment(context: Context, result: ExecutionResult, pushedSha: string | null): string {
  const lines = [
    MARKER,
    "## PR Agent",
    "",
    `Trigger: \`${context.triggerSource}\` / \`${context.triggerReason}\``,
    `Operation: \`${context.operation}\``,
    `Outcome: \`${result.outcome}\``,
    `Merge recommended: \`${result.merge_recommended === true ? "yes" : "no"}\``,
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
  if (pushedSha) lines.push("", `Pushed: \`${pushedSha.slice(0, 7)}\``);
  return lines.join("\n");
}

function checkoutPrBranch(repo: string, pr: PullRequestDetails): void {
  if (pr.head.repo?.full_name !== repo || pr.base.repo?.full_name !== repo) {
    throw new Error("PR agent only supports internal PR branches.");
  }
  runText("git", ["fetch", "origin", pr.base.ref, pr.head.ref]);
  runText("git", ["checkout", "-B", pr.head.ref, `origin/${pr.head.ref}`]);
}

function buildContext(
  repo: string,
  prNumber: number,
  operation: AgentOperation,
  triggerSource: string,
  triggerReason: string,
): Context {
  const pr = fetchPullRequest(repo, prNumber);
  const issueComments = fetchIssueComments(repo, prNumber);
  const reviewComments = fetchReviewComments(repo, prNumber);
  const changedFiles = fetchChangedFiles(repo, prNumber);
  const failingChecks = fetchCheckRuns(repo, pr.head.sha)
    .filter((check) => !isAgentCheckName(check.name))
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
    operation,
  };
}

function maybeMerge(repo: string, prNumber: number, expectedHeadSha: string): ExecutionResult | null {
  const mergeView = fetchPullRequestMergeView(repo, prNumber);
  const checkRuns = fetchCheckRuns(repo, expectedHeadSha);
  const readiness = evaluateMergeReadiness(mergeView, expectedHeadSha, checkRuns);
  if (!readiness.ok) {
    return {
      summary: `Deterministic merge skipped: ${readiness.reason}.`,
      tests_run: readiness.successfulChecks,
      evals_run: [],
      files_touched: [],
      residual_risks: [readiness.reason],
      merge_recommended: false,
      outcome: "no_changes",
    };
  }

  mergePullRequest(repo, prNumber, expectedHeadSha);
  return {
    summary: `Merged PR after deterministic gate: ${readiness.reason}.`,
    tests_run: readiness.successfulChecks,
    evals_run: [],
    files_touched: [],
    residual_risks: [],
    merge_recommended: true,
    outcome: "merged",
  };
}

async function main(): Promise<void> {
  const { repo, prNumber, operation, triggerSource, triggerReason } = parseArgs(process.argv.slice(2));
  const context = buildContext(repo, prNumber, operation, triggerSource, triggerReason);

  try {
    if (operation === "merge") {
      checkoutPrBranch(repo, context.pr);

      const tempDir = mkdtempSync(join(tmpdir(), "unbrowse-pr-agent-"));
      const outputPath = join(tempDir, "pr-agent-output.json");
      const schemaPath = outputSchemaPath(tempDir);
      const prompt = buildPrompt(context);

      runCodex(prompt, process.cwd(), outputPath, schemaPath);

      if (!existsSync(outputPath)) throw new Error("Codex did not write an output artifact.");
      const result = JSON.parse(readFileSync(outputPath, "utf8")) as AgentResult;
      if (hasChanges()) throw new Error("merge operation must not modify the worktree");

      let finalResult: ExecutionResult = result;
      if (result.merge_recommended) {
        const mergeResult = maybeMerge(repo, prNumber, context.pr.head.sha);
        if (mergeResult) finalResult = mergeResult;
      }

      upsertComment(repo, prNumber, buildComment(context, finalResult, null));
      return;
    }

    checkoutPrBranch(repo, context.pr);

    const tempDir = mkdtempSync(join(tmpdir(), "unbrowse-pr-agent-"));
    const outputPath = join(tempDir, "pr-agent-output.json");
    const schemaPath = outputSchemaPath(tempDir);
    const prompt = buildPrompt(context);

    runCodex(prompt, process.cwd(), outputPath, schemaPath);

    if (!existsSync(outputPath)) throw new Error("Codex did not write an output artifact.");
    const result = JSON.parse(readFileSync(outputPath, "utf8")) as AgentResult;

    let pushedSha: string | null = null;
    let finalResult: ExecutionResult = result;

    if (result.outcome === "patched" && hasChanges()) {
      pushedSha = commitAndPush(prNumber, context.pr.head.ref);
    }

    if (!pushedSha && result.outcome !== "blocked" && result.merge_recommended) {
      const mergeResult = maybeMerge(repo, prNumber, context.pr.head.sha);
      if (mergeResult?.outcome === "merged") finalResult = mergeResult;
    }

    upsertComment(repo, prNumber, buildComment(context, finalResult, pushedSha));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    upsertComment(repo, prNumber, buildComment(context, {
      summary: `PR agent blocked before completion: ${message}.`,
      tests_run: [],
      evals_run: [],
      files_touched: [],
      residual_risks: [message],
      merge_recommended: false,
      outcome: "blocked",
    }, null));
    throw error;
  }
}

if (import.meta.main) {
  await main();
}
