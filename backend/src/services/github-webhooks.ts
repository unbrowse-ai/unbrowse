import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

type PullRequestLabel = { name?: string };

type GithubRepoRef = {
  full_name?: string;
  name?: string;
  owner?: { login?: string };
};

type GithubPullRequestPayload = {
  number: number;
  title: string;
  html_url: string;
};

type GithubCheckSuitePayload = {
  head_sha?: string;
  conclusion?: string | null;
  status?: string | null;
  pull_requests?: Array<{ number?: number }>;
};

type GithubWebhookPayload = {
  action?: string;
  repository?: GithubRepoRef;
  pull_request?: GithubPullRequestPayload;
  check_suite?: GithubCheckSuitePayload;
};

type GithubApiPullRequest = {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  labels: PullRequestLabel[];
  head: {
    sha: string;
    ref?: string;
    repo?: GithubRepoRef | null;
  };
  base: {
    ref?: string;
    repo?: GithubRepoRef | null;
  };
};

type NotifyEntry = {
  delivery_id: string;
  repo: string;
  pr_number: number;
  title: string;
  url: string;
  status: "failed";
  note: string;
  queued_at: string;
};

type DispatchSource = "pull_request" | "check_suite";

type PrDispatchPlan = {
  source: DispatchSource;
  repo: string;
  prNumber: number;
  headSha: string;
  title: string;
  url: string;
  trigger: string;
};

export type WebhookProcessResult = {
  ok: boolean;
  status: number;
  kind: "ping" | "ignored" | "duplicate" | "dispatched" | "failed";
  repo?: string;
  pr_number?: number;
  note: string;
};

const DELIVERY_TTL_SECONDS = 60 * 60 * 24 * 7;
const DIGEST_TTL_SECONDS = 60 * 60 * 24 * 7;
const DEFAULT_LABEL = "codex:auto-maintain";
const DEFAULT_WORKFLOW = "pr-agent.yml";
const DEFAULT_WORKFLOW_REF = "main";

function parseAllowedRepos(value: string | undefined): Set<string> | null {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? new Set(items) : null;
}

function labelName(env: Env): string {
  return env.GITHUB_PR_BOT_LABEL?.trim() || DEFAULT_LABEL;
}

function workflowFile(env: Env): string {
  return env.GITHUB_PR_AGENT_WORKFLOW?.trim() || DEFAULT_WORKFLOW;
}

function workflowRef(env: Env): string {
  return env.GITHUB_PR_AGENT_WORKFLOW_REF?.trim() || DEFAULT_WORKFLOW_REF;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const value = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(value)) return null;
    out[i / 2] = value;
  }
  return out;
}

export async function verifyGithubWebhookSignature(
  secret: string,
  payload: string,
  signatureHeader: string | undefined,
): Promise<boolean> {
  if (!secret || !signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = hexToBytes(signatureHeader.slice("sha256=".length));
  if (!provided) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
  return constantTimeEqual(expected, provided);
}

async function githubRest<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      "accept": "application/vnd.github+json",
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "unbrowse-github-webhook",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function fetchCurrentPr(repo: string, number: number, token: string): Promise<GithubApiPullRequest> {
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) throw new Error(`Invalid repo name: ${repo}`);
  return await githubRest<GithubApiPullRequest>(token, `/repos/${owner}/${repoName}/pulls/${number}`);
}

function shouldManagePr(pr: GithubApiPullRequest, env: Env): { manage: boolean; reason: string } {
  const managedLabel = labelName(env);
  const labels = pr.labels.map((label) => label.name).filter((value): value is string => Boolean(value));
  if (pr.state !== "open") return { manage: false, reason: "not open" };
  if (pr.draft) return { manage: false, reason: "draft PR" };
  if (!labels.includes(managedLabel)) return { manage: false, reason: `missing ${managedLabel}` };
  const headRepo = pr.head.repo?.full_name ?? null;
  const baseRepo = pr.base.repo?.full_name ?? null;
  if (!headRepo || headRepo !== baseRepo) return { manage: false, reason: "fork/external PR" };
  return { manage: true, reason: "managed" };
}

function dispatchKey(source: DispatchSource, repo: string, prNumber: number, sha: string): string {
  return `gh-dispatch:${source}:${repo}:${prNumber}:${sha}`;
}

async function wasDispatchSeen(env: Env, source: DispatchSource, repo: string, prNumber: number, sha: string): Promise<boolean> {
  return await statsKV(env).get(dispatchKey(source, repo, prNumber, sha)) != null;
}

async function markDispatchSeen(env: Env, plan: PrDispatchPlan): Promise<void> {
  await statsKV(env).put(
    dispatchKey(plan.source, plan.repo, plan.prNumber, plan.headSha),
    JSON.stringify({
      seen_at: new Date().toISOString(),
      trigger: plan.trigger,
    }),
  );
}

async function enqueueNotification(env: Env, entry: NotifyEntry): Promise<void> {
  await statsKV(env).put(`gh-notify:${entry.queued_at}:${entry.delivery_id}`, JSON.stringify(entry));
}

async function markDeliveryProcessed(env: Env, deliveryId: string, result: WebhookProcessResult): Promise<void> {
  await statsKV(env).put(
    `gh-delivery:${deliveryId}`,
    JSON.stringify({
      processed_at: new Date().toISOString(),
      kind: result.kind,
      status: result.status,
      note: result.note,
    }),
  );
}

async function isDuplicateDelivery(env: Env, deliveryId: string): Promise<boolean> {
  return await statsKV(env).get(`gh-delivery:${deliveryId}`) != null;
}

function buildDigestMessage(entries: NotifyEntry[]): string {
  const lines = ["unbrowse github pr-agent", `${entries.length} failed dispatches`, ""];
  for (const entry of [...entries].sort((a, b) => a.queued_at.localeCompare(b.queued_at)).slice(-20)) {
    lines.push(`#${entry.pr_number} FAIL ${entry.repo} ${entry.note}`);
  }
  if (entries.length > 20) lines.push(`... ${entries.length - 20} older items omitted`);
  return lines.join("\n").slice(0, 3900);
}

async function sendTelegramMessage(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN?.trim() || !env.TELEGRAM_CHAT_ID?.trim()) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.");
  }
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) {
    throw new Error(`Telegram send failed: ${response.status} ${await response.text()}`);
  }
}

async function dispatchPrAgentWorkflow(env: Env, token: string, plan: PrDispatchPlan): Promise<void> {
  const [owner, repoName] = plan.repo.split("/");
  const body = {
    ref: workflowRef(env),
    inputs: {
      repo: plan.repo,
      pr_number: String(plan.prNumber),
      head_sha: plan.headSha,
      trigger_source: plan.source,
      trigger_reason: plan.trigger,
    },
  };
  await githubRest(
    token,
    `/repos/${owner}/${repoName}/actions/workflows/${workflowFile(env)}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

async function planPullRequestDispatch(env: Env, repo: string, prNumber: number, trigger: string): Promise<PrDispatchPlan | null> {
  if (!env.GITHUB_PR_BOT_TOKEN?.trim()) throw new Error("Missing GITHUB_PR_BOT_TOKEN.");
  const currentPr = await fetchCurrentPr(repo, prNumber, env.GITHUB_PR_BOT_TOKEN);
  const management = shouldManagePr(currentPr, env);
  if (!management.manage) return null;
  return {
    source: "pull_request",
    repo,
    prNumber,
    headSha: currentPr.head.sha,
    title: currentPr.title,
    url: currentPr.html_url,
    trigger,
  };
}

async function planCheckSuiteDispatch(env: Env, repo: string, payload: GithubCheckSuitePayload, trigger: string): Promise<PrDispatchPlan | null> {
  if (!env.GITHUB_PR_BOT_TOKEN?.trim()) throw new Error("Missing GITHUB_PR_BOT_TOKEN.");
  const prNumber = payload.pull_requests?.[0]?.number;
  const headSha = payload.head_sha?.trim();
  const conclusion = payload.conclusion?.trim().toLowerCase();
  if (!prNumber || !headSha) return null;
  if (payload.status !== "completed") return null;
  if (!conclusion || !["failure", "timed_out", "cancelled", "startup_failure", "stale"].includes(conclusion)) return null;
  const currentPr = await fetchCurrentPr(repo, prNumber, env.GITHUB_PR_BOT_TOKEN);
  const management = shouldManagePr(currentPr, env);
  if (!management.manage) return null;
  if (currentPr.head.sha !== headSha) return null;
  return {
    source: "check_suite",
    repo,
    prNumber,
    headSha,
    title: currentPr.title,
    url: currentPr.html_url,
    trigger,
  };
}

function parseWebhookPlan(eventName: string, payload: GithubWebhookPayload): {
  repo?: string;
  prNumber?: number;
  source?: DispatchSource;
  trigger: string;
} {
  if (eventName === "pull_request") {
    return {
      repo: payload.repository?.full_name?.trim(),
      prNumber: payload.pull_request?.number,
      source: "pull_request",
      trigger: `pull_request:${payload.action ?? "unknown"}`,
    };
  }
  if (eventName === "check_suite") {
    return {
      repo: payload.repository?.full_name?.trim(),
      prNumber: payload.check_suite?.pull_requests?.[0]?.number,
      source: "check_suite",
      trigger: `check_suite:${payload.action ?? "unknown"}:${payload.check_suite?.conclusion ?? "unknown"}`,
    };
  }
  return { trigger: `ignored:${eventName}` };
}

export async function flushQueuedGithubNotifications(env: Env): Promise<{ sent: boolean; count: number }> {
  const deliveryEntries = await statsKV(env).listWithValues("gh-delivery:");
  const cutoff = Date.now() - DELIVERY_TTL_SECONDS * 1000;
  await Promise.all(deliveryEntries.map(async (entry) => {
    const parsed = JSON.parse(entry.value) as { processed_at?: string };
    const processedAt = parsed.processed_at ? Date.parse(parsed.processed_at) : Number.NaN;
    if (Number.isFinite(processedAt) && processedAt < cutoff) await statsKV(env).delete(entry.name);
  }));

  const notifyEntries = await statsKV(env).listWithValues("gh-notify:");
  const notifyCutoff = Date.now() - DIGEST_TTL_SECONDS * 1000;
  const entries: Array<{ name: string; value: string }> = [];
  for (const entry of notifyEntries) {
    const parsed = JSON.parse(entry.value) as NotifyEntry;
    const queuedAt = Date.parse(parsed.queued_at);
    if (Number.isFinite(queuedAt) && queuedAt < notifyCutoff) {
      await statsKV(env).delete(entry.name);
      continue;
    }
    entries.push(entry);
  }
  if (entries.length === 0) return { sent: false, count: 0 };

  const parsed = entries
    .map((entry) => ({ key: entry.name, value: JSON.parse(entry.value) as NotifyEntry }))
    .sort((a, b) => a.value.queued_at.localeCompare(b.value.queued_at));
  await sendTelegramMessage(env, buildDigestMessage(parsed.map((entry) => entry.value)));
  await Promise.all(parsed.map((entry) => statsKV(env).delete(entry.key)));
  return { sent: true, count: parsed.length };
}

export async function processGithubWebhook(
  env: Env,
  eventName: string,
  deliveryId: string,
  payloadText: string,
): Promise<WebhookProcessResult> {
  const payload = JSON.parse(payloadText) as GithubWebhookPayload;
  if (eventName === "ping") {
    const result = { ok: true, status: 200, kind: "ping" as const, note: "pong" };
    await markDeliveryProcessed(env, deliveryId, result);
    return result;
  }

  if (await isDuplicateDelivery(env, deliveryId)) {
    return { ok: true, status: 200, kind: "duplicate", note: "delivery already processed" };
  }

  if (eventName !== "pull_request" && eventName !== "check_suite") {
    const result = { ok: true, status: 202, kind: "ignored" as const, note: `ignored event ${eventName}` };
    await markDeliveryProcessed(env, deliveryId, result);
    return result;
  }

  const basePlan = parseWebhookPlan(eventName, payload);
  const repo = basePlan.repo;
  const prNumber = basePlan.prNumber;
  if (!repo) {
    return { ok: false, status: 400, kind: "failed", note: "payload missing repository.full_name" };
  }

  const allowedRepos = parseAllowedRepos(env.GITHUB_WEBHOOK_ALLOWED_REPOS);
  if (allowedRepos && !allowedRepos.has(repo)) {
    const result = {
      ok: true,
      status: 202,
      kind: "ignored" as const,
      repo,
      pr_number: prNumber,
      note: `repo ${repo} not in allowlist`,
    };
    await markDeliveryProcessed(env, deliveryId, result);
    return result;
  }

  try {
    let plan: PrDispatchPlan | null = null;
    if (eventName === "pull_request" && prNumber) {
      plan = await planPullRequestDispatch(env, repo, prNumber, basePlan.trigger);
    } else if (eventName === "check_suite") {
      plan = await planCheckSuiteDispatch(env, repo, payload.check_suite ?? {}, basePlan.trigger);
    }

    if (!plan) {
      const result = {
        ok: true,
        status: 202,
        kind: "ignored" as const,
        repo,
        pr_number: prNumber,
        note: "event did not produce an actionable managed PR",
      };
      await markDeliveryProcessed(env, deliveryId, result);
      return result;
    }

    if (await wasDispatchSeen(env, plan.source, plan.repo, plan.prNumber, plan.headSha)) {
      const result = {
        ok: true,
        status: 200,
        kind: "duplicate" as const,
        repo: plan.repo,
        pr_number: plan.prNumber,
        note: `dispatch already requested for ${plan.source} ${plan.headSha.slice(0, 7)}`,
      };
      await markDeliveryProcessed(env, deliveryId, result);
      return result;
    }

    await dispatchPrAgentWorkflow(env, env.GITHUB_PR_BOT_TOKEN!, plan);
    await markDispatchSeen(env, plan);
    const result = {
      ok: true,
      status: 202,
      kind: "dispatched" as const,
      repo: plan.repo,
      pr_number: plan.prNumber,
      note: `dispatched ${workflowFile(env)} for ${plan.source} ${plan.headSha.slice(0, 7)}`,
    };
    await markDeliveryProcessed(env, deliveryId, result);
    return result;
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
    if (prNumber) {
      await enqueueNotification(env, {
        delivery_id: deliveryId,
        repo,
        pr_number: prNumber,
        title: payload.pull_request?.title ?? `PR #${prNumber}`,
        url: payload.pull_request?.html_url ?? "",
        status: "failed",
        note,
        queued_at: new Date().toISOString(),
      });
    }
    const result = {
      ok: false,
      status: 500,
      kind: "failed" as const,
      repo,
      pr_number: prNumber,
      note,
    };
    await markDeliveryProcessed(env, deliveryId, result);
    return result;
  }
}
