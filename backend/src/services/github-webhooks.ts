import type { Env } from "../types.js";
import { statsKV } from "./kv.js";

type MergeableState =
  | "behind"
  | "blocked"
  | "clean"
  | "dirty"
  | "draft"
  | "has_hooks"
  | "unknown"
  | "unstable";

type PullRequestLabel = { name?: string };

type PullRequestSnapshot = {
  id: string;
  number: number;
  title: string;
  url: string;
  draft: boolean;
  state: "open" | "closed";
  labels: string[];
  headSha: string;
  headRepoFullName: string | null;
  baseRepoFullName: string | null;
  mergeableState: MergeableState | null;
  autoMergeEnabled: boolean;
};

type GithubRepoRef = {
  full_name?: string;
  name?: string;
  owner?: { login?: string };
};

type GithubPullRequestPayload = {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  labels?: PullRequestLabel[];
  head: {
    sha: string;
    repo?: GithubRepoRef | null;
  };
  base: {
    repo?: GithubRepoRef | null;
  };
};

type GithubWebhookPayload = {
  action?: string;
  repository?: GithubRepoRef;
  pull_request?: GithubPullRequestPayload;
};

type GithubApiPullRequest = {
  node_id: string;
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  draft: boolean;
  mergeable_state: string | null;
  labels: PullRequestLabel[];
  head: {
    sha: string;
    repo?: GithubRepoRef | null;
  };
  base: {
    repo?: GithubRepoRef | null;
  };
  auto_merge: unknown | null;
};

type NotifyEntry = {
  delivery_id: string;
  repo: string;
  pr_number: number;
  title: string;
  url: string;
  status: "needs-human" | "failed";
  note: string;
  queued_at: string;
};

export type WebhookProcessResult = {
  ok: boolean;
  status: number;
  kind:
    | "ping"
    | "ignored"
    | "duplicate"
    | "updated-branch"
    | "enabled-auto-merge"
    | "needs-human"
    | "failed";
  repo?: string;
  pr_number?: number;
  note: string;
};

const DELIVERY_TTL_SECONDS = 60 * 60 * 24 * 7;
const DIGEST_TTL_SECONDS = 60 * 60 * 24 * 7;
const CONFLICT_MARKER = "<!-- unbrowse-gh-webhook-conflict -->";
const DEFAULT_LABEL = "codex:auto-maintain";
const DEFAULT_MERGE_METHOD = "SQUASH";

function parseAllowedRepos(value: string | undefined): Set<string> | null {
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? new Set(items) : null;
}

function normalizeMergeableState(value: string | null | undefined): MergeableState | null {
  if (!value) return null;
  switch (value) {
    case "behind":
    case "blocked":
    case "clean":
    case "dirty":
    case "draft":
    case "has_hooks":
    case "unknown":
    case "unstable":
      return value;
    default:
      return "unknown";
  }
}

function labelName(env: Env): string {
  return env.GITHUB_PR_BOT_LABEL?.trim() || DEFAULT_LABEL;
}

function mergeMethod(env: Env): string {
  return env.GITHUB_PR_BOT_MERGE_METHOD?.trim().toUpperCase() || DEFAULT_MERGE_METHOD;
}

function shouldManagePr(pr: PullRequestSnapshot, env: Env): { manage: boolean; reason: string } {
  const managedLabel = labelName(env);
  if (pr.state !== "open") return { manage: false, reason: "not open" };
  if (pr.draft) return { manage: false, reason: "draft PR" };
  if (!pr.labels.includes(managedLabel)) return { manage: false, reason: `missing ${managedLabel}` };
  if (!pr.headRepoFullName || pr.headRepoFullName !== pr.baseRepoFullName) {
    return { manage: false, reason: "fork/external PR" };
  }
  return { manage: true, reason: "managed" };
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
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

async function githubRest<T>(
  token: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
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

async function githubGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "unbrowse-github-webhook",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (!response.ok || payload.errors?.length) {
    const detail = payload.errors?.map((item) => item.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`GraphQL failed: ${detail}`);
  }
  if (!payload.data) throw new Error("GraphQL returned no data.");
  return payload.data;
}

function snapshotFromApi(pr: GithubApiPullRequest): PullRequestSnapshot {
  return {
    id: pr.node_id,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    draft: pr.draft,
    state: pr.state,
    labels: pr.labels.map((label) => label.name).filter((value): value is string => Boolean(value)),
    headSha: pr.head.sha,
    headRepoFullName: pr.head.repo?.full_name ?? null,
    baseRepoFullName: pr.base.repo?.full_name ?? null,
    mergeableState: normalizeMergeableState(pr.mergeable_state),
    autoMergeEnabled: Boolean(pr.auto_merge),
  };
}

async function fetchCurrentPr(repo: string, number: number, token: string): Promise<GithubApiPullRequest> {
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) throw new Error(`Invalid repo name: ${repo}`);
  return await githubRest<GithubApiPullRequest>(token, `/repos/${owner}/${repoName}/pulls/${number}`);
}

async function enableAutoMerge(pr: PullRequestSnapshot, token: string, env: Env): Promise<void> {
  await githubGraphql(
    token,
    `
      mutation EnableAutoMerge($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId
          mergeMethod: $mergeMethod
        }) {
          pullRequest {
            number
          }
        }
      }
    `,
    {
      pullRequestId: pr.id,
      mergeMethod: mergeMethod(env),
    },
  );
}

async function updatePrBranch(pr: PullRequestSnapshot, token: string): Promise<void> {
  await githubGraphql(
    token,
    `
      mutation UpdatePullRequestBranch($pullRequestId: ID!, $headOid: GitObjectID!) {
        updatePullRequestBranch(input: {
          pullRequestId: $pullRequestId
          expectedHeadOid: $headOid
        }) {
          pullRequest {
            number
          }
        }
      }
    `,
    {
      pullRequestId: pr.id,
      headOid: pr.headSha,
    },
  );
}

async function upsertConflictComment(repo: string, prNumber: number, token: string, env: Env): Promise<void> {
  const [owner, repoName] = repo.split("/");
  const comments = await githubRest<Array<{ id: number; body?: string | null }>>(
    token,
    `/repos/${owner}/${repoName}/issues/${prNumber}/comments?per_page=100`,
  );
  const body = [
    CONFLICT_MARKER,
    "## PR Webhook Automation",
    "",
    "Webhook automation found a real merge conflict and stopped.",
    "",
    `Label: \`${labelName(env)}\``,
    "",
    "This service will update/auto-merge safe PRs, but it will not invent conflict resolutions.",
    "Add a repo-specific resolver if you want generated-file conflicts handled automatically.",
  ].join("\n");
  const existing = comments.find((comment) => comment.body?.includes(CONFLICT_MARKER));
  if (existing) {
    await githubRest(
      token,
      `/repos/${owner}/${repoName}/issues/comments/${existing.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ body }),
      },
    );
    return;
  }
  await githubRest(
    token,
    `/repos/${owner}/${repoName}/issues/${prNumber}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
  );
}

async function enqueueNotification(env: Env, entry: NotifyEntry): Promise<void> {
  const key = `gh-notify:${entry.queued_at}:${entry.delivery_id}`;
  await statsKV(env).put(key, JSON.stringify(entry));
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
  const existing = await statsKV(env).get(`gh-delivery:${deliveryId}`);
  return existing != null;
}

function buildDigestMessage(entries: NotifyEntry[]): string {
  const lines = [
    "unbrowse github webhook",
    `${entries.length} pending PR events`,
    "",
  ];

  const sorted = [...entries].sort((a, b) => a.queued_at.localeCompare(b.queued_at));
  for (const entry of sorted.slice(-20)) {
    const tag = entry.status === "needs-human" ? "HUMAN" : "FAIL";
    lines.push(`#${entry.pr_number} ${tag} ${entry.repo} ${entry.note}`);
  }

  if (sorted.length > 20) {
    lines.push(`... ${sorted.length - 20} older items omitted`);
  }

  return lines.join("\n").slice(0, 3900);
}

async function sendTelegramMessage(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN?.trim() || !env.TELEGRAM_CHAT_ID?.trim()) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID.");
  }
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
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

export async function flushQueuedGithubNotifications(env: Env): Promise<{ sent: boolean; count: number }> {
  const deliveryEntries = await statsKV(env).listWithValues("gh-delivery:");
  const cutoff = Date.now() - DELIVERY_TTL_SECONDS * 1000;
  await Promise.all(deliveryEntries.map(async (entry) => {
    const parsed = JSON.parse(entry.value) as { processed_at?: string };
    const processedAt = parsed.processed_at ? Date.parse(parsed.processed_at) : Number.NaN;
    if (Number.isFinite(processedAt) && processedAt < cutoff) {
      await statsKV(env).delete(entry.name);
    }
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
  if (entries.length === 0) {
    return { sent: false, count: 0 };
  }
  const parsed = entries
    .map((entry) => ({
      key: entry.name,
      value: JSON.parse(entry.value) as NotifyEntry,
    }))
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
    return {
      ok: true,
      status: 200,
      kind: "duplicate",
      note: "delivery already processed",
    };
  }

  if (eventName !== "pull_request") {
    const result = {
      ok: true,
      status: 202,
      kind: "ignored" as const,
      note: `ignored event ${eventName}`,
    };
    await markDeliveryProcessed(env, deliveryId, result);
    return result;
  }

  const repo = payload.repository?.full_name?.trim();
  const prNumber = payload.pull_request?.number;
  if (!repo || !prNumber) {
    return {
      ok: false,
      status: 400,
      kind: "failed",
      note: "pull_request payload missing repository or pull_request.number",
    };
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

  if (!env.GITHUB_PR_BOT_TOKEN?.trim()) {
    return {
      ok: false,
      status: 500,
      kind: "failed",
      repo,
      pr_number: prNumber,
      note: "Missing GITHUB_PR_BOT_TOKEN.",
    };
  }

  try {
    const currentPr = await fetchCurrentPr(repo, prNumber, env.GITHUB_PR_BOT_TOKEN);
    const snapshot = snapshotFromApi(currentPr);
    const management = shouldManagePr(snapshot, env);
    if (!management.manage) {
      const result = {
        ok: true,
        status: 202,
        kind: "ignored" as const,
        repo,
        pr_number: prNumber,
        note: management.reason,
      };
      await markDeliveryProcessed(env, deliveryId, result);
      return result;
    }

    if (snapshot.mergeableState === "dirty") {
      await upsertConflictComment(repo, prNumber, env.GITHUB_PR_BOT_TOKEN, env);
      const result = {
        ok: true,
        status: 202,
        kind: "needs-human" as const,
        repo,
        pr_number: prNumber,
        note: "merge conflict detected",
      };
      await enqueueNotification(env, {
        delivery_id: deliveryId,
        repo,
        pr_number: prNumber,
        title: snapshot.title,
        url: snapshot.url,
        status: "needs-human",
        note: result.note,
        queued_at: new Date().toISOString(),
      });
      await markDeliveryProcessed(env, deliveryId, result);
      return result;
    }

    if (snapshot.mergeableState === "behind") {
      await updatePrBranch(snapshot, env.GITHUB_PR_BOT_TOKEN);
      const result = {
        ok: true,
        status: 202,
        kind: "updated-branch" as const,
        repo,
        pr_number: prNumber,
        note: "requested branch update",
      };
      await markDeliveryProcessed(env, deliveryId, result);
      return result;
    }

    if (snapshot.autoMergeEnabled) {
      const result = {
        ok: true,
        status: 200,
        kind: "ignored" as const,
        repo,
        pr_number: prNumber,
        note: "auto-merge already enabled",
      };
      await markDeliveryProcessed(env, deliveryId, result);
      return result;
    }

    if (
      snapshot.mergeableState === "clean" ||
      snapshot.mergeableState === "blocked" ||
      snapshot.mergeableState === "has_hooks" ||
      snapshot.mergeableState === "unstable"
    ) {
      await enableAutoMerge(snapshot, env.GITHUB_PR_BOT_TOKEN, env);
      const result = {
        ok: true,
        status: 202,
        kind: "enabled-auto-merge" as const,
        repo,
        pr_number: prNumber,
        note: `enabled ${mergeMethod(env).toLowerCase()} auto-merge`,
      };
      await markDeliveryProcessed(env, deliveryId, result);
      return result;
    }

    const result = {
      ok: true,
      status: 202,
      kind: "ignored" as const,
      repo,
      pr_number: prNumber,
      note: `mergeable state ${snapshot.mergeableState ?? "pending"}`,
    };
    await markDeliveryProcessed(env, deliveryId, result);
    return result;
  } catch (error) {
    const note = error instanceof Error ? error.message : String(error);
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
