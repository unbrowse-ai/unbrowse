#!/usr/bin/env bun
/**
 * Receptor — the sensory endpoint of the reflex arc.
 *
 * Listens for stimuli (GitHub PR events) relayed by the synapse (CF Worker)
 * and triggers the effector response (Claude agent spawn → test → review → merge).
 * Runs on the mini where Kuri (the motor system) lives.
 *
 * Reflex arc:
 *   stimulus (PR event) → synapse (CF Worker relay) → receptor (this) → effector (claude agent)
 *
 * Usage:
 *   GITHUB_WEBHOOK_SECRET=<secret> bun scripts/pr-receptor.ts
 *
 * Environment:
 *   GITHUB_WEBHOOK_SECRET  — shared secret with GitHub webhook config
 *   RECEPTOR_PORT          — listen port (default: 7890)
 *   REPO_DIR               — repo checkout path (default: cwd)
 *   CLAUDE_BIN             — claude binary path (default: "claude")
 *   SUPPRESS_EFFECTOR                — if "true", log stimulus but don't fire effector
 */

import { spawn } from "node:child_process";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.RECEPTOR_PORT ?? 7890);
const REPO_DIR = process.env.REPO_DIR ?? process.cwd();
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const SUPPRESS_EFFECTOR = process.env.SUPPRESS_EFFECTOR === "true";
const LOG_DIR = join(REPO_DIR, ".reflex-log");

if (!WEBHOOK_SECRET) {
  console.error("GITHUB_WEBHOOK_SECRET is required");
  process.exit(1);
}

mkdirSync(LOG_DIR, { recursive: true });

// Track in-flight runs to prevent duplicate spawns
const activeReflexes = new Map<number, { pid: number; startedAt: string }>();

async function verifySignature(payload: string, signature: string | null): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  const provided = hexToBytes(signature.slice("sha256=".length));
  if (!provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ provided[i];
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const v = parseInt(hex.slice(i, i + 2), 16);
    if (isNaN(v)) return null;
    out[i / 2] = v;
  }
  return out;
}

function buildPrompt(prNumber: number, branch: string, title: string, action: string): string {
  return `You are the Unbrowse PR test-and-merge agent.

## Context
- PR #${prNumber}: "${title}"
- Branch: ${branch}
- Action: ${action}
- Repo: ${REPO_DIR}

## Steps

1. Fetch and checkout the PR branch:
   git fetch origin ${branch} && git checkout FETCH_HEAD

2. Install dependencies:
   bun install

3. Kill any stale unbrowse/kuri processes:
   pkill -9 -f 'unbrowse|kuri' || true; sleep 2

4. Pack the skill package (smoke test):
   cd packages/skill && npm pack --dry-run

5. Run the product-success eval suite:
   bun run eval:codex:product-success

6. Read eval results:
   - evals/codex-harness-last-run.json
   - evals/codex-harness-last-run.review-queue.json

7. Review the PR diff:
   gh pr diff ${prNumber}

8. Make your decision:
   - If evals PASS and diff is clean:
     gh pr review ${prNumber} --approve --body "Evals passed on mini. <summary of results>"
     gh pr merge ${prNumber} --squash --auto
   - If evals FAIL:
     gh pr comment ${prNumber} --body "Evals failed on mini. <details>"
     Do NOT merge.
   - If diff has concerns (security, breaking changes, CLAUDE.md violations):
     gh pr comment ${prNumber} --body "Review concerns: <details>"
     Do NOT merge.

## Rules
- NEVER force merge
- NEVER skip evals
- ALWAYS comment your reasoning on the PR before any merge
- If the eval harness itself errors, comment that on the PR too
- After finishing, checkout main again: git checkout main`;
}

function fireEffector(prNumber: number, branch: string, title: string, action: string) {
  if (activeReflexes.has(prNumber)) {
    const existing = activeReflexes.get(prNumber)!;
    console.log(`[refractory] PR #${prNumber} already running (pid ${existing.pid}, started ${existing.startedAt})`);
    return;
  }

  const prompt = buildPrompt(prNumber, branch, title, action);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(LOG_DIR, `pr-${prNumber}-${timestamp}.log`);

  console.log(`[effector] PR #${prNumber} "${title}" → ${logFile}`);

  if (SUPPRESS_EFFECTOR) {
    console.log("[suppressed] would spawn claude with prompt:");
    console.log(prompt.slice(0, 200) + "...");
    return;
  }

  const child = spawn(CLAUDE_BIN, [
    "--print",
    "--prompt", prompt,
    "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep",
    "--max-turns", "30",
  ], {
    cwd: REPO_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "pr-webhook" },
    detached: false,
  });

  activeReflexes.set(prNumber, { pid: child.pid!, startedAt: new Date().toISOString() });

  const log = (prefix: string, data: Buffer) => {
    const line = `[${new Date().toISOString()}] ${prefix}: ${data.toString()}`;
    appendFileSync(logFile, line);
  };

  child.stdout?.on("data", (d) => log("stdout", d));
  child.stderr?.on("data", (d) => log("stderr", d));

  child.on("close", (code) => {
    activeReflexes.delete(prNumber);
    const msg = `[quiescent] PR #${prNumber} exited with code ${code}`;
    console.log(msg);
    appendFileSync(logFile, `\n${msg}\n`);
  });

  child.on("error", (err) => {
    activeReflexes.delete(prNumber);
    console.error(`[error] PR #${prNumber}:`, err.message);
    appendFileSync(logFile, `\n[error] ${err.message}\n`);
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    if (req.method === "GET" && new URL(req.url).pathname === "/health") {
      return Response.json({
        ok: true,
        active_reflexes: Object.fromEntries(activeReflexes),
        uptime: process.uptime(),
      });
    }

    if (req.method !== "POST" || !new URL(req.url).pathname.startsWith("/webhook")) {
      return new Response("not found", { status: 404 });
    }

    const body = await req.text();
    const sig = req.headers.get("x-hub-signature-256");
    const event = req.headers.get("x-github-event");

    if (!await verifySignature(body, sig)) {
      return Response.json({ error: "invalid signature" }, { status: 401 });
    }

    if (event === "ping") {
      return Response.json({ ok: true, note: "pong" });
    }

    if (event !== "pull_request") {
      return Response.json({ ok: true, note: `ignored event: ${event}` });
    }

    const payload = JSON.parse(body);
    const action = payload.action as string;

    // Only act on opened, synchronize (new push), or reopened
    if (!["opened", "synchronize", "reopened"].includes(action)) {
      return Response.json({ ok: true, note: `ignored action: ${action}` });
    }

    const pr = payload.pull_request;
    if (!pr) {
      return Response.json({ error: "no pull_request in payload" }, { status: 400 });
    }

    const prNumber = pr.number as number;
    const branch = pr.head.ref as string;
    const title = pr.title as string;
    const draft = pr.draft as boolean;

    if (draft) {
      return Response.json({ ok: true, note: "skipping draft PR" });
    }

    fireEffector(prNumber, branch, title, action);

    return Response.json({
      ok: true,
      pr_number: prNumber,
      branch,
      note: `effector fired for PR #${prNumber}`,
    });
  },
});

console.log(`[receptor] listening on :${PORT}`);
console.log(`[receptor] repo: ${REPO_DIR}`);
console.log(`[receptor] effector_suppressed: ${SUPPRESS_EFFECTOR}`);
console.log(`[receptor] health: http://localhost:${PORT}/health`);
console.log(`[receptor] webhook: http://localhost:${PORT}/webhook/github`);
